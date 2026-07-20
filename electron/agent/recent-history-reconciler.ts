import type { MastraDBMessage } from '@mastra/core/agent';
import type { InputProcessor } from '@mastra/core/processors';

const TIMESTAMP_MATCH_WINDOW_MS = 5 * 60 * 1000;
const VOLATILE_PART_KEYS = new Set([
  'createdAt',
  'providerMetadata',
  'metadata',
  'startedAt',
  'finishedAt',
  'durationMs',
  'argsText',
  'liveOutput',
]);

type Match = {
  rememberedIndex: number;
  inputIndex: number;
  stableAlias: boolean;
  timestampClose: boolean;
  fingerprint: string;
};

function canonicalValue(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== 'object') return value;

  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    if (VOLATILE_PART_KEYS.has(key)) continue;
    const child = (value as Record<string, unknown>)[key];
    if (child !== undefined) result[key] = canonicalValue(child);
  }
  return result;
}

function canonicalPart(part: unknown): unknown | null {
  if (!part || typeof part !== 'object') return canonicalValue(part);
  const record = part as Record<string, unknown>;
  if (record.type === 'step-start') return null;
  if (record.type === 'text') {
    return { type: 'text', text: typeof record.text === 'string' ? record.text.replace(/\r\n/g, '\n') : '' };
  }
  return canonicalValue(record);
}

/** A content-only identity. Message ids, timestamps, and provider bookkeeping
 * are intentionally excluded; tool call ids and meaningful attachment/tool
 * payloads remain part of the identity. */
export function recentHistoryFingerprint(message: MastraDBMessage): string {
  const parts = message.content.parts.map(canonicalPart).filter((part) => part !== null);
  return JSON.stringify({ role: message.role, parts });
}

function collectStableAliases(value: unknown, aliases: Set<string>, parentKey = ''): void {
  if (Array.isArray(value)) {
    for (const child of value) collectStableAliases(child, aliases, parentKey);
    return;
  }
  if (!value || typeof value !== 'object') return;

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (
      typeof child === 'string' &&
      child.length > 0 &&
      (key === 'toolCallId' || key === 'itemId' || key === 'kaiMessageId' || key === 'responseMessageId')
    ) {
      aliases.add(`${key}:${child}`);
    }
    collectStableAliases(child, aliases, key || parentKey);
  }
}

function stableAliases(message: MastraDBMessage): Set<string> {
  const aliases = new Set<string>();
  collectStableAliases(message.content, aliases);
  return aliases;
}

function aliasesIntersect(left: Set<string>, right: Set<string>): boolean {
  for (const alias of left) {
    if (right.has(alias)) return true;
  }
  return false;
}

function timestampsClose(left: MastraDBMessage, right: MastraDBMessage): boolean {
  const leftMs = left.createdAt instanceof Date ? left.createdAt.getTime() : Date.parse(String(left.createdAt));
  const rightMs = right.createdAt instanceof Date ? right.createdAt.getTime() : Date.parse(String(right.createdAt));
  return Number.isFinite(leftMs) && Number.isFinite(rightMs) && Math.abs(leftMs - rightMs) <= TIMESTAMP_MATCH_WINDOW_MS;
}

/**
 * Find a maximum monotonic overlap between remembered and caller-supplied
 * messages. Monotonic alignment matters: repeated replies such as "OK" are
 * counted rather than globally collapsed, and any excess remembered copy is
 * retained.
 */
function alignMessages(remembered: MastraDBMessage[], input: MastraDBMessage[]): Match[] {
  const rememberedFingerprints = remembered.map(recentHistoryFingerprint);
  const inputFingerprints = input.map(recentHistoryFingerprint);
  const rememberedAliases = remembered.map(stableAliases);
  const inputAliases = input.map(stableAliases);
  const rows = remembered.length + 1;
  const cols = input.length + 1;
  const lengths = Array.from({ length: rows }, () => new Uint16Array(cols));

  const equivalent = (ri: number, ii: number): boolean =>
    remembered[ri].role === input[ii].role &&
    (rememberedFingerprints[ri] === inputFingerprints[ii] || aliasesIntersect(rememberedAliases[ri], inputAliases[ii]));

  for (let ri = 1; ri < rows; ri += 1) {
    for (let ii = 1; ii < cols; ii += 1) {
      lengths[ri][ii] = equivalent(ri - 1, ii - 1)
        ? lengths[ri - 1][ii - 1] + 1
        : Math.max(lengths[ri - 1][ii], lengths[ri][ii - 1]);
    }
  }

  const matches: Match[] = [];
  let ri = remembered.length;
  let ii = input.length;
  while (ri > 0 && ii > 0) {
    if (equivalent(ri - 1, ii - 1)) {
      const stableAlias = aliasesIntersect(rememberedAliases[ri - 1], inputAliases[ii - 1]);
      matches.push({
        rememberedIndex: ri - 1,
        inputIndex: ii - 1,
        stableAlias,
        timestampClose: timestampsClose(remembered[ri - 1], input[ii - 1]),
        fingerprint: rememberedFingerprints[ri - 1],
      });
      ri -= 1;
      ii -= 1;
    } else if (lengths[ri - 1][ii] >= lengths[ri][ii - 1]) {
      ri -= 1;
    } else {
      ii -= 1;
    }
  }
  return matches.reverse();
}

/**
 * Returns only remembered ids that are confirmed copies of the supplied Kai
 * branch. A single content-only coincidence is retained unless its timestamp
 * or a stable provider/tool alias corroborates it. Longer ordered overlaps are
 * accepted when at least one pair is corroborated, or when multiple distinct
 * messages establish the sequence. This preserves genuinely memory-only turns
 * while repairing legacy threads whose assistant ids differed across stores.
 */
export function findDuplicateRememberedMessageIds(remembered: MastraDBMessage[], input: MastraDBMessage[]): string[] {
  if (remembered.length === 0 || input.length === 0) return [];
  const matches = alignMessages(remembered, input);
  const distinctFingerprints = new Set(matches.map((match) => match.fingerprint)).size;
  const sequenceConfirmed =
    matches.length >= 2 &&
    (matches.some((match) => match.stableAlias || match.timestampClose) || distinctFingerprints >= 2);

  return matches
    .filter((match) => sequenceConfirmed || match.stableAlias || match.timestampClose)
    .map((match) => remembered[match.rememberedIndex].id);
}

export function createRecentHistoryReconciler(): InputProcessor {
  return {
    id: 'kai-recent-history-reconciler',
    name: 'Kai recent-history reconciler',
    processInput: ({ messageList }) => {
      const duplicateIds = findDuplicateRememberedMessageIds(
        messageList.get.remembered.db(),
        messageList.get.input.db(),
      );
      if (duplicateIds.length > 0) {
        messageList.removeByIds(duplicateIds);
        console.info(`[Memory] Reconciled ${duplicateIds.length} duplicated recent message(s) against Kai branch`);
      }
      return messageList;
    },
  };
}
