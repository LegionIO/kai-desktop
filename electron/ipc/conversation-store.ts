import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'fs';
import { join } from 'path';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { traceDiagnostic } from '../diagnostics/debug-trace.js';
import {
  computeMessageCount,
  messageContentSig,
  tokenProjectionSerializedLength,
  tokenProjectionByteCeiling,
} from '../agent/tokenization.js';

// ─────────────────────────────────────────────────────────────────────────────
// On-disk layout (per-conversation files + a lightweight index)
//
//   data/conversations/<id>.json   — full ConversationRecord (messages + tree)
//   data/index.json                — ConversationIndex (summaries + active id + settings)
//   data/conversations.json        — legacy monolith; renamed to .migrated on first load
//
// Rationale: the old monolith was parsed + rewritten in full on EVERY mutation
// (O(total history) per message). List reads now touch only the index; get/put/
// set-selection touch a single small file.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Persisted conversation-compaction record (single "latest valid"). Documents
 * that the messages whose ids are in `compactedMessageIds` were summarized into
 * `summaryText`. Non-destructive: the full messageTree is never mutated, so this
 * is metadata a later turn reuses when the ids still form a prefix of the active
 * branch (see agent.ts + compaction.ts isStrictPrefix).
 */
export type ConversationCompaction = {
  compactionId: string;
  summaryText: string;
  compactedMessageIds: string[];
  boundaryHeadId: string | null;
  createdAt: string;
  // Optional per-covered-id content signature (bounded hash) of the messages this
  // summary covered, as of when it was produced. Lets a LATER same-turn reactive
  // recovery that expands this record's synthetic summary re-verify the underlying ids
  // against fresh disk before persisting over them. Additive/optional — older records
  // and the renderer put-path simply omit it (composition then falls back to rejecting
  // an unverifiable expansion).
  coveredContentSig?: Record<string, string>;
  // Main-process MONOTONIC revision stamped when this record is written (put / stream-
  // persistence / /compact). Used INSTEAD of the renderer wall-clock `createdAt` to decide
  // which of two records is newer — a web client with a skewed clock could otherwise stamp
  // a genuinely-newer summary with an older createdAt and have it dropped by preservation.
  compactionRevision?: number;
} | null;

// Process-monotonic counter for compaction-record freshness. Stamped by every main-side
// writer of a NEW compaction record so preservation compares main-authoritative ordering
// instead of renderer wall-clock `createdAt` (which a clock-skewed web client can get
// wrong). Starts at the current epoch-ms so it stays roughly comparable to any legacy
// createdAt-derived ordering, and only ever increases within a process.
let compactionRevisionCounter = Date.now();
export function nextCompactionRevision(): number {
  compactionRevisionCounter = Math.max(compactionRevisionCounter + 1, Date.now());
  return compactionRevisionCounter;
}
// Advance the counter's floor past a revision observed on a STORED record. Guards against
// a process clock rollback / VM restore issuing a revision BELOW a persisted record's —
// which would make a genuinely-newer summary compare as older and get dropped. Called
// whenever a stored compaction record is read.
export function observeCompactionRevision(rev: number | undefined): void {
  if (typeof rev === 'number' && rev >= compactionRevisionCounter) compactionRevisionCounter = rev;
}

/** Full persisted conversation, including heavy message data. */
export type ConversationRecord = {
  id: string;
  title: string | null;
  fallbackTitle: string | null;
  messages: unknown[];
  messageTree?: unknown[];
  headId?: string | null;
  conversationCompaction: ConversationCompaction;
  lastContextUsage: unknown | null;
  createdAt: string;
  updatedAt: string;
  lastMessageAt: string | null;
  titleStatus: 'idle' | 'generating' | 'ready' | 'error';
  titleUpdatedAt: string | null;
  messageCount: number;
  userMessageCount: number;
  runStatus: 'idle' | 'running' | 'awaiting-approval' | 'error';
  hasUnread: boolean;
  lastAssistantUpdateAt: string | null;
  selectedModelKey: string | null;
  selectedProfileKey?: string | null;
  fallbackEnabled?: boolean;
  profilePrimaryModelKey?: string | null;
  currentWorkingDirectory?: string | null;
  workspaceId?: string;
  archived?: boolean;
  metadata?: Record<string, unknown>;
};

/** Lightweight per-conversation summary — everything the list view + singleton /
 *  metadata lookups need, but NOT `messages` / `messageTree`. */
export type ConversationIndexEntry = {
  id: string;
  title: string | null;
  fallbackTitle: string | null;
  createdAt: string;
  updatedAt: string;
  lastMessageAt: string | null;
  lastAssistantUpdateAt: string | null;
  titleStatus: ConversationRecord['titleStatus'];
  titleUpdatedAt: string | null;
  messageCount: number;
  userMessageCount: number;
  runStatus: ConversationRecord['runStatus'];
  hasUnread: boolean;
  selectedModelKey: string | null;
  selectedProfileKey?: string | null;
  fallbackEnabled?: boolean;
  profilePrimaryModelKey?: string | null;
  currentWorkingDirectory?: string | null;
  workspaceId?: string;
  archived?: boolean;
  /** Precomputed so `list` never has to scan message bodies. */
  hasToolCalls: boolean;
  /** Precomputed: any tool call to a `computer_use*` (autopilot) tool. */
  hasComputerUse: boolean;
  /** Precomputed: any image/file content part, or a tool result carrying
   *  native model content (`_modelContent`, e.g. fetched images). */
  hasMedia: boolean;
  metadata?: Record<string, unknown>;
};

export type ConversationIndex = {
  conversations: Record<string, ConversationIndexEntry>;
  activeConversationId: string | null;
  settings: Record<string, unknown>;
};

// ── paths ────────────────────────────────────────────────────────────────────

function conversationsDir(appHome: string): string {
  return join(appHome, 'data', 'conversations');
}
function conversationPath(appHome: string, id: string): string {
  return join(conversationsDir(appHome), `${sanitizeId(id)}.json`);
}
function indexPath(appHome: string): string {
  return join(appHome, 'data', 'index.json');
}
function monolithPath(appHome: string): string {
  return join(appHome, 'data', 'conversations.json');
}

/** Guard against path traversal via a malicious conversation id (web bridge is a
 *  trusted mirror, but ids flow in from IPC — keep filenames to a safe charset). */
function sanitizeId(id: string): string {
  if (typeof id !== 'string' || !/^[A-Za-z0-9._-]+$/.test(id)) {
    throw new Error(`Invalid conversation id: ${JSON.stringify(id)}`);
  }
  return id;
}

function ensureDirs(appHome: string): void {
  const dir = conversationsDir(appHome);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/** Write a file atomically — see {@link atomicWriteFileSync} in utils. */

// ── index derivation ───────────────────────────────────────────────────────

function computeHasToolCalls(conv: ConversationRecord): boolean {
  return (
    Array.isArray(conv.messages) &&
    conv.messages.some((msg: unknown) => {
      const m = msg as Record<string, unknown>;
      return (
        Array.isArray(m.content) &&
        (m.content as Array<Record<string, unknown>>).some((part) => part?.type === 'tool-call')
      );
    })
  );
}

/** Any tool call whose target tool name begins with `computer_use` (the autopilot
 *  session/control/info tools). Best-effort — mirrors {@link computeHasToolCalls}. */
function computeHasComputerUse(conv: ConversationRecord): boolean {
  return (
    Array.isArray(conv.messages) &&
    conv.messages.some((msg: unknown) => {
      const m = msg as Record<string, unknown>;
      return (
        Array.isArray(m.content) &&
        (m.content as Array<Record<string, unknown>>).some((part) => {
          if (part?.type !== 'tool-call') return false;
          const name = (part.toolName ?? part.name) as unknown;
          return typeof name === 'string' && name.startsWith('computer_use');
        })
      );
    })
  );
}

/** Any image/file content part (user attachments or model output), or a tool
 *  result carrying native IMAGE/FILE model content (`_modelContent`, e.g. fetched images).
 *  Best-effort — mirrors {@link computeHasToolCalls}. */
function computeHasMedia(conv: ConversationRecord): boolean {
  // A _modelContent array can hold TEXT-only entries (e.g. truncation notes) — those are not
  // media, so require at least one image/file part rather than a merely non-empty array.
  const hasMediaPart = (arr: unknown): boolean =>
    Array.isArray(arr) &&
    arr.some((p) => {
      const t = (p as { type?: unknown } | null | undefined)?.type;
      return t === 'image' || t === 'file' || t === 'image-data' || t === 'file-data';
    });
  return (
    Array.isArray(conv.messages) &&
    conv.messages.some((msg: unknown) => {
      const m = msg as Record<string, unknown>;
      if (!Array.isArray(m.content)) return false;
      return (m.content as Array<Record<string, unknown>>).some((part) => {
        if (part?.type === 'image' || part?.type === 'file') return true;
        // A tool result's native model content lives at part.result._modelContent (the
        // persisted tool-result part is { type:'tool-result', result: {...} }). Check the
        // nested result first; keep the direct part._modelContent as a fallback. Count it
        // only when it actually carries an image/file part (not a text-only note array).
        const resultObj = (part as { result?: unknown })?.result;
        const nested = (resultObj as { _modelContent?: unknown } | null | undefined)?._modelContent;
        if (hasMediaPart(nested)) return true;
        return hasMediaPart((part as { _modelContent?: unknown })?._modelContent);
      });
    })
  );
}

/** Single source of truth for turning a full record into its index summary. */
export function toIndexEntry(conv: ConversationRecord): ConversationIndexEntry {
  return {
    id: conv.id,
    title: conv.title,
    fallbackTitle: conv.fallbackTitle,
    createdAt: conv.createdAt,
    updatedAt: conv.updatedAt,
    lastMessageAt: conv.lastMessageAt,
    lastAssistantUpdateAt: conv.lastAssistantUpdateAt,
    titleStatus: conv.titleStatus,
    titleUpdatedAt: conv.titleUpdatedAt,
    messageCount: conv.messageCount,
    userMessageCount: conv.userMessageCount,
    runStatus: conv.runStatus,
    hasUnread: conv.hasUnread,
    selectedModelKey: conv.selectedModelKey,
    selectedProfileKey: conv.selectedProfileKey,
    fallbackEnabled: conv.fallbackEnabled,
    profilePrimaryModelKey: conv.profilePrimaryModelKey,
    currentWorkingDirectory: conv.currentWorkingDirectory,
    workspaceId: conv.workspaceId,
    archived: conv.archived,
    hasToolCalls: computeHasToolCalls(conv),
    hasComputerUse: computeHasComputerUse(conv),
    hasMedia: computeHasMedia(conv),
    metadata: conv.metadata,
  };
}

// ── index read/write ─────────────────────────────────────────────────────────

const EMPTY_INDEX: ConversationIndex = { conversations: {}, activeConversationId: null, settings: {} };

export function readIndex(appHome: string): ConversationIndex {
  migrateMonolithIfNeeded(appHome);
  const p = indexPath(appHome);
  if (!existsSync(p)) {
    // No index but conversation files may exist (e.g. index write never landed
    // after a crash) — rebuild from the per-file records rather than hiding them.
    const rebuilt = rebuildIndexFromConversationFiles(appHome);
    return rebuilt ?? { ...EMPTY_INDEX, conversations: {}, settings: {} };
  }
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf-8')) as Partial<ConversationIndex>;
    return {
      conversations: parsed.conversations ?? {},
      activeConversationId: parsed.activeConversationId ?? null,
      settings: parsed.settings ?? {},
    };
  } catch {
    // Corrupt/truncated index — the per-file conversation records are the source
    // of truth, so rebuild the summaries from them instead of returning empty
    // (which would make every chat vanish from the list). activeConversationId +
    // settings are best-effort lost, but no message data is.
    const rebuilt = rebuildIndexFromConversationFiles(appHome);
    return rebuilt ?? { conversations: {}, activeConversationId: null, settings: {} };
  }
}

/** Reconstruct the index by scanning the per-conversation files and deriving each
 *  summary via toIndexEntry. Returns null if the conversations dir is absent (so
 *  callers can fall back to an empty index). Best-effort — corrupt individual
 *  files are skipped. Does NOT recover activeConversationId/settings (index-only
 *  state); those reset, but no message data is lost. */
function rebuildIndexFromConversationFiles(appHome: string): ConversationIndex | null {
  const dir = conversationsDir(appHome);
  if (!existsSync(dir)) return null;
  const index: ConversationIndex = { conversations: {}, activeConversationId: null, settings: {} };
  let recovered = 0;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    try {
      const conv = JSON.parse(readFileSync(join(dir, name), 'utf-8')) as ConversationRecord;
      if (conv && typeof conv.id === 'string') {
        index.conversations[conv.id] = toIndexEntry(conv);
        recovered += 1;
      }
    } catch {
      /* skip corrupt file */
    }
  }
  if (recovered === 0) return null;
  console.warn(`[conversation-store] rebuilt index from ${recovered} conversation file(s) (index was missing/corrupt)`);
  return index;
}

/** Bumped whenever {@link toIndexEntry} gains a precomputed field that existing
 *  index.json files won't have. {@link reindexIfStale} rebuilds once per bump. */
const INDEX_SCHEMA_VERSION = 2;

/** One-time backfill: if the stored index predates the current
 *  {@link INDEX_SCHEMA_VERSION}, rebuild every summary from the per-file records
 *  (so newly-added precomputed fields like `hasComputerUse`/`hasMedia` populate for
 *  existing chats) and stamp the version. Cheap no-op on every subsequent boot.
 *  Skipped while a monolith migration is pending (a write then would strand it). */
export function reindexIfStale(appHome: string): number {
  if (monolithMigrationPending(appHome)) return 0;
  const index = readIndex(appHome);
  const stored = typeof index.settings?.indexSchemaVersion === 'number' ? index.settings.indexSchemaVersion : 0;
  if (stored >= INDEX_SCHEMA_VERSION) return 0;

  const rebuilt = rebuildIndexFromConversationFiles(appHome);
  const conversations = rebuilt?.conversations ?? index.conversations;
  const count = Object.keys(conversations).length;
  writeIndex(appHome, {
    conversations,
    activeConversationId: index.activeConversationId,
    settings: { ...index.settings, indexSchemaVersion: INDEX_SCHEMA_VERSION },
  });
  console.info(`[conversation-store] reindexed ${count} conversation(s) to schema v${INDEX_SCHEMA_VERSION}`);
  return count;
}

export function writeIndex(appHome: string, index: ConversationIndex): void {
  ensureDirs(appHome);
  atomicWriteFileSync(indexPath(appHome), JSON.stringify(index, null, 2));
}

// ── conversation read/write ───────────────────────────────────────────────────

export function readConversation(appHome: string, id: string): ConversationRecord | null {
  migrateMonolithIfNeeded(appHome);
  let p: string;
  try {
    p = conversationPath(appHome, id);
  } catch {
    return null;
  }
  if (!existsSync(p)) return null;
  try {
    const rec = JSON.parse(readFileSync(p, 'utf-8')) as ConversationRecord;
    // Advance the revision floor past any stored compaction revision so a clock rollback /
    // VM restore can't later issue a lower revision than what's already on disk.
    observeCompactionRevision((rec?.conversationCompaction as { compactionRevision?: number } | null)?.compactionRevision);
    return rec;
  } catch {
    return null;
  }
}

/** Full read of every conversation. Rare (plugin API, clear, usage aggregation) —
 *  callers that only need summaries should use `readIndex` instead. */
export function readAllConversations(appHome: string): ConversationRecord[] {
  migrateMonolithIfNeeded(appHome);
  const dir = conversationsDir(appHome);
  if (!existsSync(dir)) return [];
  const out: ConversationRecord[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    try {
      out.push(JSON.parse(readFileSync(join(dir, name), 'utf-8')) as ConversationRecord);
    } catch {
      /* skip corrupt file */
    }
  }
  return out;
}

type TreeNodeLike = {
  id?: unknown;
  role?: unknown;
  parentId?: unknown;
  content?: unknown;
  /** Explicit orphan-repair hint stamped by the renderer for a background-seeded
   *  reply that was created with parentId:null (see reconnectActiveBranchRoot).
   *  Pass 5 honors this LITERALLY — it never guesses an orphan from tree shape —
   *  and clears it once the edge is restored. */
  reconnectTo?: unknown;
};

/** Result of a tree-integrity repair, for optional diagnostics by the caller. */
export type TreeSanitizeReport = {
  changed: boolean;
  /** ids that appeared more than once and were merged into a single node. */
  dedupedIds: string[];
  /** ids whose parentId formed a cycle and was detached. */
  cycleBrokenIds: string[];
  /** true if headId was unreachable and had to be repointed. */
  headRepointed: boolean;
  /** id of an assistant-rooted active branch that was reconnected to prior history
   *  (the mid-turn-inject orphan-root repair), or null if none. */
  orphanBranchReconnected?: string | null;
};

/**
 * Enforce the message-tree invariants that the branch walker
 * (`getConversationBranch`) depends on, at the single write chokepoint so NO
 * path can persist a corrupt tree:
 *
 *   1. No duplicate node ids. A repeated id (produced by a read-modify-write
 *      race between two finalizes + the renderer `put` merge — see the mid-turn
 *      inject corruption) is merged into ONE node: later occurrences' content is
 *      concatenated onto the first.
 *   2. No parent cycles. A back-edge (e.g. assistant.parentId=inject AND
 *      inject.parentId=assistant) is DETACHED by making the node that closes the
 *      loop a root. Without this, the branch walker's cycle-guard silently
 *      truncates the active branch and orphans real history.
 *   3. headId reachable. If the recorded head can't be reached (or is gone),
 *      repoint to the deepest node on the longest resolvable chain.
 *
 * Pure and cheap (linear passes); returns the possibly-repaired tree plus a
 * report. Exported for unit tests and reuse by a recovery pass.
 */
/**
 * Merge the content of two duplicate-id message snapshots without losing updates
 * or duplicating parts. The finalizer/renderer race yields two OVERLAPPING
 * snapshots of ONE streamed reply — typically the final is a positional GROWTH of
 * the partial (same parts in order, the last text run extended, maybe extra
 * trailing parts). Strategy:
 *  - If one array is a positional PREFIX-GROWTH of the other (each position equal,
 *    or a text run that only grew, with the longer array possibly having extra
 *    trailing parts), return the LONGER/FULLER array wholesale. This is the common
 *    case and never drops or duplicates a legitimate segment.
 *  - Otherwise the snapshots diverged structurally: union by identity —
 *    `tc:<toolCallId>` for tool parts (keeping the MORE COMPLETE one: has a
 *    `result`, else longer), else exact JSON — preserving first-seen order. NB we
 *    do NOT collapse an arbitrary text that merely starts-with another (that would
 *    drop a legitimate distinct segment like "Checking" vs a later "Checking done").
 *  - One array, one scalar: keep the array (richer). Both scalars: keep the longer.
 * Pure; exported for unit tests.
 */
export function mergeSnapshotContent(a: unknown, b: unknown): unknown {
  if (Array.isArray(a) && Array.isArray(b)) {
    const partText = (p: unknown): string | null =>
      p &&
      typeof p === 'object' &&
      (p as { type?: unknown }).type === 'text' &&
      typeof (p as { text?: unknown }).text === 'string'
        ? (p as { text: string }).text
        : null;
    const toolId = (p: unknown): string | null =>
      p && typeof p === 'object' && typeof (p as { toolCallId?: unknown }).toolCallId === 'string'
        ? (p as { toolCallId: string }).toolCallId
        : null;
    const hasResult = (p: unknown): boolean =>
      !!(p && typeof p === 'object' && (p as { result?: unknown }).result !== undefined);
    const jstr = (p: unknown): string => {
      try {
        return JSON.stringify(p) ?? '';
      } catch {
        return String(p);
      }
    };
    // Is `shorter` a positional prefix-growth of `longer`? Each shared position must
    // be identical OR a monotonic growth: a text run that only grew, or the SAME
    // tool part (same toolCallId) that gained a result / longer args. Extra trailing
    // parts in `longer` are allowed (streamed later).
    const isPrefixGrowth = (shorter: unknown[], longer: unknown[]): boolean => {
      if (shorter.length > longer.length) return false;
      for (let i = 0; i < shorter.length; i++) {
        const s = shorter[i];
        const l = longer[i];
        if (jstr(s) === jstr(l)) continue;
        const st = partText(s);
        const lt = partText(l);
        if (st !== null && lt !== null && lt.startsWith(st)) continue; // text run grew
        const stc = toolId(s);
        const ltc = toolId(l);
        // Same tool position that gained a result / more args ⇒ monotonic growth.
        if (stc !== null && stc === ltc && !(hasResult(s) && !hasResult(l)) && jstr(l).length >= jstr(s).length)
          continue;
        return false; // positional mismatch → not a clean growth
      }
      return true;
    };
    if (isPrefixGrowth(a, b)) return b;
    if (isPrefixGrowth(b, a)) return a;

    // Diverged → union by identity, keeping the completer tool snapshot. No cross
    // text prefix-collapsing (would drop legitimate distinct segments).
    const fuller = (x: unknown, y: unknown): unknown => {
      if (hasResult(x) !== hasResult(y)) return hasResult(x) ? x : y;
      return jstr(y).length > jstr(x).length ? y : x;
    };
    const order: string[] = [];
    const byKey = new Map<string, unknown>();
    for (const part of [...a, ...b]) {
      const tc = toolId(part);
      const key = tc !== null ? `tc:${tc}` : `j:${jstr(part)}`;
      const existing = byKey.get(key);
      if (existing === undefined) {
        byKey.set(key, part);
        order.push(key);
      } else if (tc !== null) {
        byKey.set(key, fuller(existing, part));
      }
    }
    return order.map((k) => byKey.get(k));
  }
  if (Array.isArray(a)) return a;
  if (Array.isArray(b)) return b;
  if (typeof a === 'string' && typeof b === 'string') return b.length > a.length ? b : a;
  return a ?? b;
}

export function sanitizeMessageTree(
  rawTree: unknown[],
  headId: string | null | undefined,
): { tree: TreeNodeLike[]; headId: string | null; report: TreeSanitizeReport } {
  const report: TreeSanitizeReport = {
    changed: false,
    dedupedIds: [],
    cycleBrokenIds: [],
    headRepointed: false,
    orphanBranchReconnected: null,
  };
  // O(1) membership for report de-duplication — a growing-array `.includes()` per
  // repeated id would be O(n²) for a tree of two full duplicate snapshots.
  const dedupedIdSet = new Set<string>();
  const cycleBrokenIdSet = new Set<string>();
  const input = Array.isArray(rawTree) ? (rawTree as TreeNodeLike[]) : [];

  // ── Pass 1: dedupe by id, merging content of repeated ids ──
  const order: string[] = [];
  const byId = new Map<string, TreeNodeLike>();
  // Candidate parents recorded when duplicate snapshots of one id disagree on
  // parentId — used below to pick a parent that keeps the node connected.
  const altParents = new Map<string, Set<string>>();
  for (const node of input) {
    if (!node || typeof node !== 'object') {
      report.changed = true; // dropping a malformed entry IS a repair — persist it
      continue;
    }
    const id = typeof node.id === 'string' && node.id.length > 0 ? node.id : null;
    if (!id) {
      // Drop id-less nodes (they can't be linked and break the branch walk). This
      // is a structural repair, so mark changed — otherwise sanitizeConversationTree
      // could return the ORIGINAL tree (still containing the bad node) and the write
      // chokepoint wouldn't enforce its invariant.
      report.changed = true;
      continue;
    }
    const existing = byId.get(id);
    if (!existing) {
      byId.set(id, { ...node, id });
      order.push(id);
      continue;
    }
    // Duplicate id: the motivating finalizer/renderer race produces two OVERLAPPING
    // SNAPSHOTS of the same message, usually with the same parts. Blindly
    // concatenating would double text and repeat toolCallIds in the model-facing
    // message, so MERGE by union instead: keep every distinct part, de-duplicating
    // array parts by toolCallId (or structural identity) and not repeating an
    // identical text/string.
    if (!dedupedIdSet.has(id)) {
      dedupedIdSet.add(id);
      report.dedupedIds.push(id);
    }
    report.changed = true;
    existing.content = mergeSnapshotContent(existing.content, node.content);
    // Snapshots may DISAGREE on parentId (the inject-corruption shape: one points
    // to the injected user, another to prior history). Keeping the first blindly
    // can leave the node rooted by cycle-repair and disconnect earlier history.
    // Record the alternate so a reachable/non-cyclic parent can be chosen below.
    const existingParent = typeof existing.parentId === 'string' ? existing.parentId : null;
    const nodeParent = typeof node.parentId === 'string' ? node.parentId : null;
    if (nodeParent !== null && nodeParent !== existingParent) {
      let alts = altParents.get(id);
      if (!alts) {
        alts = new Set<string>();
        altParents.set(id, alts);
      }
      if (existingParent !== null) alts.add(existingParent);
      alts.add(nodeParent);
    }
    // Content may have changed → any cached count is stale; drop count+sig so the
    // backfill recomputes (a stale low count could slip under the compaction gate).
    delete (existing as { tokenCount?: unknown }).tokenCount;
    delete (existing as { tokenCountSig?: unknown }).tokenCountSig;
  }

  const ids = new Set(order);

  // ── Pass 2: normalize parents (self-parent, dangling → null) ──
  for (const id of order) {
    const node = byId.get(id)!;
    const orig = typeof node.parentId === 'string' ? node.parentId : null;
    let parent = orig;
    if (parent === id) parent = null; // self-parent → root
    if (parent !== null && !ids.has(parent)) parent = null; // dangling → root
    if (parent !== orig) {
      node.parentId = parent;
      report.changed = true;
    }
  }

  // ── Pass 2.5: for a merged node whose snapshots disagreed on parent, prefer a
  // parent that does NOT loop back to the node (keeps it connected to earlier
  // history). Without this, cycle-repair would root the node on its bad first
  // parent and disconnect the active branch from all prior messages. ──
  const leadsBackTo = (start: string, target: string): boolean => {
    const seen = new Set<string>();
    let cur: string | null = start;
    while (cur !== null && !seen.has(cur)) {
      if (cur === target) return true;
      seen.add(cur);
      const node = byId.get(cur);
      cur = node && typeof node.parentId === 'string' ? node.parentId : null;
    }
    return false;
  };
  for (const [id, alts] of altParents) {
    const node = byId.get(id);
    if (!node) continue;
    const cur = typeof node.parentId === 'string' ? node.parentId : null;
    // Intervene when the current parent is unusable — a cycle back to this node OR
    // null because Pass 2 normalized away a dangling/self first parent — AND a
    // recorded alternate is a valid, in-tree, acyclic ancestor. Without the null
    // case, a node whose first snapshot had a bad parent (normalized to null) would
    // stay detached even though a later snapshot named a valid ancestor.
    const currentUnusable = cur === null || leadsBackTo(cur, id);
    if (!currentUnusable) continue;
    for (const alt of alts) {
      if (alt === id || alt === cur || !ids.has(alt)) continue;
      if (!leadsBackTo(alt, id)) {
        node.parentId = alt; // an acyclic alternate keeps history connected
        report.changed = true;
        break;
      }
    }
  }

  // ── Pass 3: break parent cycles — LINEAR via DFS color-marking ──
  // 0 = unvisited, 1 = on the current chain (gray), 2 = proven acyclic (black).
  // Following parent edges from each node, a gray node hit again is a back-edge →
  // detach it. Black nodes are already known cycle-free, so we stop early instead
  // of re-walking to the root from every node (the previous O(n²) behavior).
  const color = new Map<string, 0 | 1 | 2>();
  for (const id of order) color.set(id, 0);
  for (const startId of order) {
    if (color.get(startId) !== 0) continue;
    const chain: string[] = [];
    let cur: string | null = startId;
    while (cur !== null) {
      const c = color.get(cur);
      if (c === 2) break; // reached a proven-acyclic node — rest of chain is fine
      if (c === 1) {
        // Back-edge: `cur` closes a cycle. Detach it so the chain terminates.
        const node = byId.get(cur)!;
        node.parentId = null;
        if (!cycleBrokenIdSet.has(cur)) {
          cycleBrokenIdSet.add(cur);
          report.cycleBrokenIds.push(cur);
        }
        report.changed = true;
        break;
      }
      color.set(cur, 1); // gray
      chain.push(cur);
      const node = byId.get(cur);
      cur = node && typeof node.parentId === 'string' ? node.parentId : null;
    }
    // Everything we just walked is now proven acyclic → mark black.
    for (const id of chain) color.set(id, 2);
  }

  const tree = order.map((id) => byId.get(id)!);

  // ── Pass 4: repoint headId ONLY when it is a non-null id that's unreachable ──
  // A DELIBERATELY null head is valid state (conversations:rewind rewinds through
  // the first user turn → null head = empty active branch, tree kept as shelved
  // history). We must NOT treat that as corruption and restore the old branch.
  // Only a non-null head whose id is absent from the tree is genuinely lost.
  const headWasNull = headId === null || headId === undefined;
  let head = typeof headId === 'string' && ids.has(headId) ? headId : null;
  // Depth (distance to root, counting the node itself) MEMOIZED across nodes: many
  // regeneration leaves share a long parent prefix, so walking each leaf's full
  // chain independently would be O(n²) and could freeze a large-conversation write.
  // Cycles are already broken in Pass 3; the on-stack guard is defensive.
  const depthCache = new Map<string, number>();
  const depthReachable = (leaf: string): number => {
    const stack: string[] = [];
    const onStack = new Set<string>();
    let cur: string | null = leaf;
    let base = 0;
    while (cur !== null) {
      const cached = depthCache.get(cur);
      if (cached !== undefined) {
        base = cached;
        break;
      }
      if (onStack.has(cur)) break; // defensive: unexpected residual cycle
      onStack.add(cur);
      stack.push(cur);
      const node = byId.get(cur);
      cur = node && typeof node.parentId === 'string' ? node.parentId : null;
    }
    // Backfill depths for every node on the walked path (deepest-first).
    let d = base;
    for (let i = stack.length - 1; i >= 0; i--) {
      d += 1;
      depthCache.set(stack[i], d);
    }
    return d;
  };
  if (head === null && !headWasNull && order.length > 0) {
    const parentSet = new Set<string>();
    for (const id of order) {
      const p = byId.get(id)!.parentId;
      if (typeof p === 'string') parentSet.add(p);
    }
    const leaves = order.filter((id) => !parentSet.has(id));
    const candidates = leaves.length > 0 ? leaves : order;
    let best = candidates[0];
    let bestDepth = -1;
    for (const id of candidates) {
      const d = depthReachable(id);
      if (d > bestDepth) {
        bestDepth = d;
        best = id;
      }
    }
    head = best;
    report.headRepointed = true;
    report.changed = true;
  }

  // ── Pass 5: honor an EXPLICIT orphan-reconnect hint (mid-turn-inject repair) ──
  // A background-seeded renderer accumulator (an automation/serverPersisted stream
  // into a non-active conversation) starts with headId:null, so its first assistant
  // node — and anything parented on it, e.g. a mid-turn inject — can be persisted
  // with parentId:null: a detached root that severs prior history (the GUI shows an
  // "empty/cleared" thread). The RENDERER, which alone knows this provenance and the
  // authoritative on-disk head, stamps that node with `reconnectTo: <diskHeadId>`.
  //
  // This pass reconnects LITERALLY from that hint — it never guesses an orphan from
  // tree shape (an assistant-rooted tree can be legitimate: a rewound conversation
  // that gets a realtime greeting, an assistant-first imported/plugin tree, etc.).
  // Because every persist funnels through writeConversation → here, honoring the
  // hint closes the renderer per-site gaps (CWD-change, supersede) and the
  // cross-process `conversations:put` union-merge in one airtight place.
  //
  // A node is reconnected only when it is STILL detached (parentId null) and the
  // hint names a real in-tree node from which the hinted node is NOT already
  // reachable (LIVE cycle guard — re-checked against current parentIds so two
  // reciprocal hints a→b / b→a in the same tree can't both apply and forge a cycle
  // that runs after Pass 3). The hint is cleared on EVERY node that carries the
  // property (string or not) so a malformed hint can't linger on disk.
  {
    let anyHint = false;
    for (const id of order) {
      if ('reconnectTo' in byId.get(id)!) {
        anyHint = true;
        break;
      }
    }
    if (anyHint) {
      // Is `target` reachable by walking UP from `from` via current parentIds? Used
      // as the cycle guard: reparenting `from`→`target` cycles iff `from` is on
      // `target`'s ancestor chain. Reflects mutations already applied this pass.
      const reachesUpward = (from: string, target: string): boolean => {
        let cur: string | null = target;
        const seenLocal = new Set<string>();
        while (cur !== null && !seenLocal.has(cur)) {
          if (cur === from) return true;
          seenLocal.add(cur);
          const p: unknown = byId.get(cur)?.parentId;
          cur = typeof p === 'string' ? p : null;
        }
        return false;
      };
      for (const id of order) {
        const node = byId.get(id)!;
        if (!('reconnectTo' in node)) continue;
        const targetRaw = node.reconnectTo;
        const target = typeof targetRaw === 'string' && targetRaw.length > 0 ? targetRaw : null;
        // Only act on a node that is STILL a detached root; one already parented (the
        // edge was restored by the renderer or the union-merge) just gets its hint
        // cleared. Skip a self-hint, a hint to a missing id, or one that would cycle
        // (target already reaches this node by walking up).
        if (
          node.parentId == null &&
          target !== null &&
          target !== id &&
          ids.has(target) &&
          !reachesUpward(id, target)
        ) {
          node.parentId = target;
          report.orphanBranchReconnected = id;
          report.changed = true;
        }
        // Always clear the hint — string or malformed — so nothing lingers on disk.
        delete (node as { reconnectTo?: unknown }).reconnectTo;
        report.changed = true;
      }
    }
  }

  return { tree, headId: head, report };
}

/**
 * Apply {@link sanitizeMessageTree} to a full record, keeping `messageTree`,
 * `headId`, `messages` (active branch) and counts consistent. Returns the SAME
 * object when nothing changed (no allocation churn on the hot write path).
 */
export function sanitizeConversationTree(conv: ConversationRecord, priorTree?: unknown[] | null): ConversationRecord {
  const rawTree = Array.isArray(conv.messageTree) ? conv.messageTree : null;
  if (!rawTree || rawTree.length === 0) return conv;
  // Cached counts from the PREVIOUSLY-persisted tree, keyed by id, each carrying the
  // content signature the count was computed against. The backfill reuses one of
  // these (instead of re-encoding) when the incoming node's current content matches
  // the prior signature — so a renderer that keeps re-sending a count-less tree
  // doesn't force a tiktoken sweep on every debounced put.
  const priorCounts = new Map<string, { tokenCount: number; tokenCountSig: number }>();
  if (Array.isArray(priorTree)) {
    for (const pn of priorTree as Array<{ id?: unknown; tokenCount?: unknown; tokenCountSig?: unknown }>) {
      if (typeof pn?.id === 'string' && typeof pn.tokenCount === 'number' && typeof pn.tokenCountSig === 'number') {
        priorCounts.set(pn.id, { tokenCount: pn.tokenCount, tokenCountSig: pn.tokenCountSig });
      }
    }
  }
  // Distinguish an OMITTED head (undefined — legacy/plugin records where
  // ensureConversationTree treats the final node as the active head) from a
  // DELIBERATE null head (an intentional rewind → empty active branch). Passing
  // `undefined ?? null` would collapse both to null; then a structural repair on
  // the same write would rebuild `messages` from a null head and HIDE all history.
  // So when the head is omitted, resolve it to the last VALID-id node (scanning
  // from the end — the very last entry may itself be an id-less/malformed node that
  // sanitize will drop; using its missing id would yield a null head that the
  // sanitizer then treats as an intentional rewind and hides all earlier history).
  // Only an explicit null is treated as the intentional empty-branch state.
  let headInput: string | null | undefined = conv.headId;
  if (conv.headId === undefined) {
    headInput = null;
    for (let i = rawTree.length - 1; i >= 0; i--) {
      const id = (rawTree[i] as { id?: unknown })?.id;
      if (typeof id === 'string' && id.length > 0) {
        headInput = id;
        break;
      }
    }
  }
  const { tree, headId, report } = sanitizeMessageTree(rawTree, headInput);

  // Backfill/refresh per-message tokenCount. A count is refreshed when it's MISSING
  // or its stored signature no longer matches the node's current content (a same-id
  // rewrite). Two bounds keep the FIRST write of a large/legacy chat from freezing
  // the main thread on a synchronous tiktoken sweep of the whole tree:
  //   • only ACTIVE-BRANCH nodes are considered (inactive/shelved branches don't
  //     affect the compaction gate, so they don't need counts);
  //   • an AGGREGATE exact-encode budget — once the chars exactly-encoded this write
  //     exceed BACKFILL_EXACT_CHAR_BUDGET, remaining nodes get the cheap over-biased
  //     ESTIMATE (no tiktoken) as their count. The gate only needs a safe
  //     over-estimate, and shouldCompact's own exact path still runs when it trips.
  // Idempotent: a node whose (count,sig) already matches is skipped, so repeated
  // debounced puts don't re-encode.
  const BACKFILL_EXACT_CHAR_BUDGET = 1_500_000; // ~ one bounded encode worth per write
  const activeIds = new Set<string>();
  {
    const byIdForBranch = new Map(tree.map((n) => [n.id as string, n] as const));
    const seen = new Set<string>();
    let cur: string | null = headId;
    while (cur !== null && !seen.has(cur)) {
      seen.add(cur);
      activeIds.add(cur);
      const node = byIdForBranch.get(cur);
      cur = node && typeof node.parentId === 'string' ? node.parentId : null;
    }
  }
  let backfilled = 0;
  let exactCharsUsed = 0;
  for (const node of tree) {
    const n = node as TreeNodeLike & {
      tokenCount?: unknown;
      tokenCountSig?: unknown;
      tool_calls?: unknown;
      tool_call_id?: unknown;
    };
    if (n.id !== undefined && !activeIds.has(n.id as string)) continue; // skip inactive branches
    // Include model-bearing top-level tool fields so large tool args are counted.
    const projection = { role: n.role, content: n.content, tool_calls: n.tool_calls, tool_call_id: n.tool_call_id };
    const sig = messageContentSig(projection);
    const valid = typeof n.tokenCount === 'number' && typeof n.tokenCountSig === 'number' && n.tokenCountSig === sig;
    if (valid) continue;
    // Reuse the PRIOR on-disk count when this node's content is unchanged (its
    // signature matches what the prior count was computed against) — no re-encode.
    // This is what makes repeated debounced puts of a count-less renderer tree cheap.
    if (typeof n.id === 'string') {
      const prior = priorCounts.get(n.id);
      if (prior && prior.tokenCountSig === sig) {
        n.tokenCount = prior.tokenCount;
        n.tokenCountSig = sig;
        backfilled++;
        continue;
      }
    }
    const serializedLen = tokenProjectionSerializedLength(projection);
    if (exactCharsUsed + serializedLen <= BACKFILL_EXACT_CHAR_BUDGET) {
      // Within budget → exact count.
      const { count } = computeMessageCount(projection);
      if (typeof count === 'number') {
        n.tokenCount = count;
        n.tokenCountSig = sig;
        exactCharsUsed += serializedLen;
        backfilled++;
        continue;
      }
    }
    // Over budget (or no encoding) → skip tiktoken and persist a TRUE UPPER BOUND
    // (UTF-8 byte length). Unlike length/3 this never under-counts token-dense
    // content (CJK/Unicode) in the over-budget tail, so it can't slip under the
    // compaction gate; the gate stays safe (over-estimate → maybe run exact check).
    n.tokenCount = tokenProjectionByteCeiling(projection);
    n.tokenCountSig = sig;
    backfilled++;
  }

  if (!report.changed && backfilled === 0) return conv;

  if (report.changed) {
    // A repair means an upstream write produced a corrupt tree (dup id / parent
    // cycle / unreachable head) — the exact mid-turn-inject failure that orphaned
    // history. Trace it (metadata only) so a recurrence is visible in diagnostics.
    traceDiagnostic({
      scope: 'agent',
      event: 'conversation.tree-repaired',
      level: 'warn',
      conversationId: conv.id,
      fields: {
        dedupedCount: report.dedupedIds.length,
        cycleBrokenCount: report.cycleBrokenIds.length,
        headRepointed: report.headRepointed,
        dedupedIds: report.dedupedIds,
        cycleBrokenIds: report.cycleBrokenIds,
        orphanBranchReconnected: report.orphanBranchReconnected ?? null,
      },
    });
  }

  const byId = new Map(tree.map((n) => [n.id as string, n] as const));

  // Backfill-only path (no structural repair): the caller set headId / messages /
  // counts deliberately (e.g. reconcileConversationActivity derives messageCount
  // from `messages`, and a stale-write guard compares those counts). We must NOT
  // override them — only swap in the tree with backfilled counts, and mirror those
  // counts onto the existing `messages` nodes by id so both views agree without
  // changing the branch shape / lengths the caller chose.
  if (!report.changed) {
    const prevMessages = Array.isArray(conv.messages) ? (conv.messages as TreeNodeLike[]) : [];
    const messages = prevMessages.map((m) => {
      const id = typeof m?.id === 'string' ? m.id : null;
      const repaired = id
        ? (byId.get(id) as (TreeNodeLike & { tokenCount?: unknown; tokenCountSig?: unknown }) | undefined)
        : undefined;
      // Carry the backfilled count + signature onto the message-branch copy so the
      // active-branch view agrees with the tree.
      return repaired && typeof repaired.tokenCount === 'number'
        ? { ...m, tokenCount: repaired.tokenCount, tokenCountSig: repaired.tokenCountSig }
        : m;
    });
    return { ...conv, messageTree: tree as unknown[], messages: messages as unknown[] };
  }

  // Structural repair path: head/branch/counts may all have changed, so rebuild
  // them from the repaired tree + repaired head.
  const branch: TreeNodeLike[] = [];
  const seen = new Set<string>();
  let cur: string | null = headId;
  while (cur !== null && !seen.has(cur)) {
    seen.add(cur);
    const node = byId.get(cur);
    if (!node) break;
    branch.push(node);
    cur = typeof node.parentId === 'string' ? node.parentId : null;
  }
  branch.reverse();

  return {
    ...conv,
    messageTree: tree as unknown[],
    headId,
    messages: branch as unknown[],
    messageCount: branch.length,
    userMessageCount: branch.filter((n) => n.role === 'user').length,
  };
}

/**
 * Recently-deleted conversation ids with the wall-clock time of deletion. A persist can
 * read a conversation, another client can DELETE it, and then the stale write recreates it
 * ("resurrection") — writeConversation would treat the now-absent id as a fresh creation.
 * A short-lived tombstone lets writeConversation SKIP a write that would resurrect a
 * just-deleted conversation. TTL bounds the set AND allows the (never-actually-happening)
 * case of an id being legitimately reused later. Ids are unique per creation, so a genuine
 * NEW conversation is never tombstoned.
 */
const recentlyDeletedConversations = new Map<string, number>();
// 10 minutes: comfortably outlasts any single in-flight persist/turn (a stream that was mid
// -flight at delete time, or a slow write) so a late persist can't resurrect a deleted
// conversation after the tombstone expired.
const DELETED_TOMBSTONE_TTL_MS = 600_000;
// Hard cap on the tombstone map. Map preserves insertion order, so evicting the FRONT drops
// the OLDEST tombstone — an O(1) bound that holds even when a bulk-delete of thousands of
// chats within the TTL means NOTHING is expiry-eligible. (5000 tombstones ≈ minutes of the
// most aggressive bulk delete; older ones are the least likely to still have an in-flight
// persist racing them.) Throttle the expiry sweep so it isn't O(n) on EVERY insert.
const DELETED_TOMBSTONE_MAX = 5000;
let lastTombstoneSweep = 0;
function tombstoneConversation(id: string): void {
  const now = Date.now();
  recentlyDeletedConversations.delete(id); // re-insert at the back so ordering reflects recency
  recentlyDeletedConversations.set(id, now);
  // O(1) hard cap: drop the oldest (front) entries. Bounds memory + keeps the map small
  // during a bulk delete without an O(n) scan per insert.
  while (recentlyDeletedConversations.size > DELETED_TOMBSTONE_MAX) {
    const oldest = recentlyDeletedConversations.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    recentlyDeletedConversations.delete(oldest);
  }
  // Expiry sweep at most once per minute (not per insert) — a full O(n) scan on every insert
  // is quadratic under a bulk delete. Between sweeps, isRecentlyDeleted still lazily drops an
  // expired entry it reads, and the hard cap bounds growth.
  if (now - lastTombstoneSweep > 60_000) {
    lastTombstoneSweep = now;
    for (const [k, t] of recentlyDeletedConversations) {
      if (now - t > DELETED_TOMBSTONE_TTL_MS) recentlyDeletedConversations.delete(k);
    }
  }
}
export function isRecentlyDeleted(id: string): boolean {
  const t = recentlyDeletedConversations.get(id);
  if (t === undefined) return false;
  if (Date.now() - t > DELETED_TOMBSTONE_TTL_MS) {
    recentlyDeletedConversations.delete(id);
    return false;
  }
  return true;
}

/**
 * Write one conversation file and update its index entry (single-file cost).
 * Returns the record actually written — which may be a SANITIZED/backfilled copy
 * (dedup, cycle-break, head repoint, tokenCount backfill) differing from the
 * argument. Callers that broadcast or return the record to the renderer should
 * use THIS return value, not the input, so clients never see a tree that
 * disagrees with disk/index.
 */
export function writeConversation(appHome: string, conv: ConversationRecord): ConversationRecord {
  // Migrate BEFORE touching per-file state, and refuse to write if a legacy
  // monolith is still un-migrated — a partial index would strand old chats.
  assertMigratedBeforeWrite(appHome);
  ensureDirs(appHome);
  // Read the prior on-disk record so the backfill can REUSE its cached token counts
  // (by id + matching content signature) instead of re-encoding on every debounced
  // put — the renderer keeps sending a count-less tree, so without this the write
  // path would re-run tiktoken each time.
  let priorTree: unknown[] | null = null;
  try {
    const prior = readConversation(appHome, conv.id);
    priorTree = prior && Array.isArray(prior.messageTree) ? prior.messageTree : null;
  } catch {
    /* best-effort — fall back to fresh backfill */
  }
  const sanitized = sanitizeConversationTree(conv, priorTree);
  // Resurrection guard: if this id was RECENTLY DELETED and is not currently in the index,
  // a stale in-flight persist is trying to recreate it. SKIP the write (return the record
  // to the caller unchanged) rather than resurrect a deleted conversation with stale
  // messages + run state. A conversation still present in the index (a normal update, or a
  // legitimate recreate before the tombstone was set) writes normally.
  if (isRecentlyDeleted(sanitized.id)) {
    const idx = readIndex(appHome);
    if (!idx.conversations[sanitized.id]) return sanitized;
  }
  atomicWriteFileSync(conversationPath(appHome, sanitized.id), JSON.stringify(sanitized, null, 2));
  const index = readIndex(appHome);
  index.conversations[sanitized.id] = toIndexEntry(sanitized);
  writeIndex(appHome, index);
  return sanitized;
}

/** Delete a single conversation. Returns true iff the data file is GONE (removed now, or
 *  already absent) and the index entry was dropped — mirrors {@link deleteConversations}'
 *  preserve-on-rm-failure semantics so a failed rm keeps the conversation intact (and the
 *  caller can avoid cancelling/broadcasting for a delete that didn't happen). */
export function deleteConversation(appHome: string, id: string): boolean {
  // Migrate first (and refuse if migration is pending) so a subsequent
  // readIndex() can't recreate the file we delete or strand old chats.
  assertMigratedBeforeWrite(appHome);
  let fileGone = false;
  try {
    const p = conversationPath(appHome, id);
    if (existsSync(p)) rmSync(p);
    fileGone = true;
  } catch {
    fileGone = false; // removal failed — retain the conversation (index entry + file)
  }
  if (!fileGone) return false;
  // Tombstone only once the file is actually gone, so a stale in-flight persist can't
  // resurrect the just-deleted conversation (writeConversation checks isRecentlyDeleted).
  tombstoneConversation(id);
  const index = readIndex(appHome);
  if (index.conversations[id]) {
    delete index.conversations[id];
    if (index.activeConversationId === id) index.activeConversationId = null;
    writeIndex(appHome, index);
  }
  return true;
}

/** Batch delete: removes each conversation file and its index entry with a SINGLE
 *  index write at the end (vs. one per id via {@link deleteConversation}). Returns
 *  the ids that had an index entry removed. */
export function deleteConversations(appHome: string, ids: string[]): string[] {
  assertMigratedBeforeWrite(appHome);
  const index = readIndex(appHome);
  const removed: string[] = [];
  for (const id of ids) {
    // Only drop the index entry once the data file is GONE (removed now, or already
    // absent). If rmSync FAILS, the file remains on disk; dropping the index entry anyway
    // would orphan that data AND make the conversation invisible — so keep the entry and
    // skip this id (the caller can retry).
    let fileGone = false;
    try {
      const p = conversationPath(appHome, id);
      if (existsSync(p)) rmSync(p);
      fileGone = true;
    } catch {
      fileGone = false; // removal failed — retain the index entry
    }
    if (fileGone && index.conversations[id]) {
      delete index.conversations[id];
      if (index.activeConversationId === id) index.activeConversationId = null;
      // Tombstone so a stale in-flight persist can't resurrect this just-deleted id.
      tombstoneConversation(id);
      removed.push(id);
    }
  }
  if (removed.length > 0) writeIndex(appHome, index);
  return removed;
}

export function clearAllConversations(appHome: string): void {
  // Migrate first (refuse if pending) so the monolith can't be re-split after clear.
  assertMigratedBeforeWrite(appHome);
  // Tombstone every id being cleared so a stale in-flight persist (a running stream, or a
  // trusted client that read a record before the clear) can't resurrect a wiped conversation.
  const priorIndex = readIndex(appHome);
  for (const id of Object.keys(priorIndex.conversations)) tombstoneConversation(id);
  const dir = conversationsDir(appHome);
  if (existsSync(dir)) {
    for (const name of readdirSync(dir)) {
      if (name.endsWith('.json')) {
        try {
          rmSync(join(dir, name));
        } catch {
          /* ignore */
        }
      }
    }
  }
  writeIndex(appHome, { conversations: {}, activeConversationId: null, settings: priorIndex.settings });
}

// ── active id + settings ───────────────────────────────────────────────────────

export function getActiveConversationId(appHome: string): string | null {
  return readIndex(appHome).activeConversationId;
}

/**
 * Reset any conversation stuck in `running`/`awaiting-approval` to `idle` at
 * backend startup. If the singleton backend died mid-run (crash/quit) while a
 * server-persisted CLI turn or automation was in flight, its in-memory run
 * state is gone but the on-disk runStatus is stale. The next leader has no
 * active stream for these, so a fresh backend must sweep them idle — otherwise
 * the GUI/CLI show a permanently-spinning conversation that also blocks new
 * submits (the busy-check refuses to write into a `running` conversation).
 * Rebuilds the index entries from the per-file records so counts stay accurate.
 */
export function resetStaleRunStatus(appHome: string): number {
  const index = readIndex(appHome);
  if (monolithMigrationPending(appHome)) return 0;
  let reset = 0;
  for (const id of Object.keys(index.conversations)) {
    const entry = index.conversations[id];
    if (entry.runStatus !== 'running' && entry.runStatus !== 'awaiting-approval') continue;
    const conv = readConversation(appHome, id);
    if (!conv) continue;
    conv.runStatus = 'idle';
    writeConversation(appHome, conv);
    reset += 1;
  }
  if (reset > 0) console.info(`[conversation-store] reset ${reset} stale running conversation(s) to idle at startup`);
  return reset;
}

export function setActiveConversationId(appHome: string, id: string | null): void {
  // Guard: writing the index before a pending migration would strand the monolith.
  assertMigratedBeforeWrite(appHome);
  const index = readIndex(appHome);
  index.activeConversationId = id;
  writeIndex(appHome, index);
}

// ── migration ────────────────────────────────────────────────────────────────

let migrationChecked = false;

/** True when a legacy monolith still exists AND no index has been written — i.e.
 *  migration has not (yet) succeeded. A per-file WRITE while this holds would
 *  create a partial index.json that permanently strands the un-migrated
 *  conversations (future reads skip migration once index.json exists). */
function monolithMigrationPending(appHome: string): boolean {
  return existsSync(monolithPath(appHome)) && !existsSync(indexPath(appHome));
}

/** Run migration, then refuse to proceed with a mutation if a legacy monolith is
 *  still un-migrated (migration failed). Called at the top of every write path. */
function assertMigratedBeforeWrite(appHome: string): void {
  migrateMonolithIfNeeded(appHome);
  if (monolithMigrationPending(appHome)) {
    throw new Error(
      '[conversation-store] refusing to write: legacy conversations.json migration is pending/failed — ' +
        'writing now would strand un-migrated conversations. Resolve the monolith first.',
    );
  }
}

/** Split the legacy monolith into per-conversation files + an index on first
 *  load. Idempotent (guarded by index.json existence + an in-process flag).
 *  Fail-safe: on any error, leaves the monolith untouched and logs. */
export function migrateMonolithIfNeeded(appHome: string): void {
  if (migrationChecked) return;
  migrationChecked = true;
  try {
    const mono = monolithPath(appHome);
    // Already migrated (index exists) or nothing to migrate (no monolith).
    if (existsSync(indexPath(appHome))) return;
    if (!existsSync(mono)) return;

    const parsed = JSON.parse(readFileSync(mono, 'utf-8')) as {
      conversations?: Record<string, ConversationRecord>;
      activeConversationId?: string | null;
      settings?: Record<string, unknown>;
    };
    const conversations = parsed.conversations ?? {};
    const index: ConversationIndex = {
      conversations: {},
      activeConversationId: parsed.activeConversationId ?? null,
      settings: parsed.settings ?? {},
    };
    // Write every conversation into a TEMP dir first. Only if ALL succeed do we
    // move them into place, write the index, and rename the monolith. A single
    // per-record failure aborts the whole migration with the monolith intact —
    // a partial migration that silently drops conversations is worse than none.
    const finalDir = conversationsDir(appHome);
    const stagingDir = `${finalDir}.migrating-${Date.now()}`;
    mkdirSync(stagingDir, { recursive: true });
    try {
      for (const [id, conv] of Object.entries(conversations)) {
        // sanitizeId throws on a bad id — treat as a failed migration, not a drop.
        writeFileSync(join(stagingDir, `${sanitizeId(id)}.json`), JSON.stringify(conv, null, 2), 'utf-8');
        index.conversations[id] = toIndexEntry(conv);
      }
      // All records staged successfully — commit atomically-ish: move files into
      // the real dir, write the index, then rename the monolith last.
      mkdirSync(finalDir, { recursive: true });
      for (const name of readdirSync(stagingDir)) {
        renameSync(join(stagingDir, name), join(finalDir, name));
      }
      rmSync(stagingDir, { recursive: true, force: true });
      writeIndex(appHome, index);
      // Keep the monolith as a safety copy — never delete migrated data.
      renameSync(mono, `${mono}.migrated`);
      console.info(
        `[conversation-store] migrated ${Object.keys(index.conversations).length} conversations to per-file storage`,
      );
    } catch (recordErr) {
      // Abort: discard the partial staging dir, leave the monolith untouched.
      try {
        rmSync(stagingDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
      throw recordErr;
    }
  } catch (err) {
    // Leave the monolith in place; a later read falls back to empty rather than
    // corrupting data. Reset the flag so a transient error can be retried.
    migrationChecked = false;
    console.error('[conversation-store] migration failed; leaving monolith in place:', err);
  }
}

/** Test-only: reset the in-process migration guard. */
export function __resetMigrationGuardForTests(): void {
  migrationChecked = false;
}
