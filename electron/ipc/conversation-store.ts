import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'fs';
import { join } from 'path';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { traceDiagnostic } from '../diagnostics/debug-trace.js';
import { computeMessageCount, messageContentSig, tokenProjectionSerializedLength } from '../agent/tokenization.js';

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
} | null;

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
    return JSON.parse(readFileSync(p, 'utf-8')) as ConversationRecord;
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
 * Merge the content of two duplicate-id message snapshots without duplicating
 * parts. The finalizer/renderer race produces two OVERLAPPING snapshots of one
 * message; a blind concat would double text and repeat toolCallIds in the
 * model-facing content. Strategy:
 *  - Both arrays: union, keyed by a part identity (toolCallId when present, else a
 *    JSON of the part), preserving first-seen order — so a part appearing in both
 *    snapshots is kept once, and a part only in the second is appended.
 *  - One array, one scalar: keep the array (the richer snapshot).
 *  - Both scalar strings: keep the longer (the more complete snapshot); identical
 *    strings collapse to one.
 * Pure; exported for unit tests.
 */
export function mergeSnapshotContent(a: unknown, b: unknown): unknown {
  if (Array.isArray(a) && Array.isArray(b)) {
    const seen = new Set<string>();
    const out: unknown[] = [];
    for (const part of [...a, ...b]) {
      const key =
        part && typeof part === 'object' && typeof (part as { toolCallId?: unknown }).toolCallId === 'string'
          ? `tc:${(part as { toolCallId: string }).toolCallId}`
          : `j:${(() => {
              try {
                return JSON.stringify(part);
              } catch {
                return String(part);
              }
            })()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(part);
    }
    return out;
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
  const report: TreeSanitizeReport = { changed: false, dedupedIds: [], cycleBrokenIds: [], headRepointed: false };
  const input = Array.isArray(rawTree) ? (rawTree as TreeNodeLike[]) : [];

  // ── Pass 1: dedupe by id, merging content of repeated ids ──
  const order: string[] = [];
  const byId = new Map<string, TreeNodeLike>();
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
    if (!report.dedupedIds.includes(id)) report.dedupedIds.push(id);
    report.changed = true;
    existing.content = mergeSnapshotContent(existing.content, node.content);
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
        if (!report.cycleBrokenIds.includes(cur)) report.cycleBrokenIds.push(cur);
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
  const depthReachable = (leaf: string): number => {
    let d = 0;
    const seen = new Set<string>();
    let cur: string | null = leaf;
    while (cur !== null && !seen.has(cur)) {
      seen.add(cur);
      d++;
      const node = byId.get(cur);
      cur = node && typeof node.parentId === 'string' ? node.parentId : null;
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

  return { tree, headId: head, report };
}

/**
 * Apply {@link sanitizeMessageTree} to a full record, keeping `messageTree`,
 * `headId`, `messages` (active branch) and counts consistent. Returns the SAME
 * object when nothing changed (no allocation churn on the hot write path).
 */
export function sanitizeConversationTree(conv: ConversationRecord): ConversationRecord {
  const rawTree = Array.isArray(conv.messageTree) ? conv.messageTree : null;
  if (!rawTree || rawTree.length === 0) return conv;
  // Distinguish an OMITTED head (undefined — legacy/plugin records where
  // ensureConversationTree treats the final node as the active head) from a
  // DELIBERATE null head (an intentional rewind → empty active branch). Passing
  // `undefined ?? null` would collapse both to null; then a structural repair on
  // the same write would rebuild `messages` from a null head and HIDE all history.
  // So when the head is omitted, resolve it to the last-node fallback first; only
  // an explicit null is treated as the intentional empty-branch state.
  const headInput =
    conv.headId === undefined
      ? ((rawTree[rawTree.length - 1] as { id?: unknown })?.id as string | undefined) ?? null
      : conv.headId;
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
    const n = node as TreeNodeLike & { tokenCount?: unknown; tokenCountSig?: unknown };
    if (n.id !== undefined && !activeIds.has(n.id as string)) continue; // skip inactive branches
    const projection = { role: n.role, content: n.content };
    const sig = messageContentSig(projection);
    const valid = typeof n.tokenCount === 'number' && typeof n.tokenCountSig === 'number' && n.tokenCountSig === sig;
    if (valid) continue;
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
    // Over budget (or no encoding) → cheap over-biased estimate, no tiktoken.
    // length/3 matches estimateSerializedTokens' MIN_CHARS_PER_TOKEN bias.
    n.tokenCount = Math.ceil(serializedLen / 3);
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
      const repaired = id ? (byId.get(id) as (TreeNodeLike & { tokenCount?: unknown; tokenCountSig?: unknown }) | undefined) : undefined;
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
  const sanitized = sanitizeConversationTree(conv);
  atomicWriteFileSync(conversationPath(appHome, sanitized.id), JSON.stringify(sanitized, null, 2));
  const index = readIndex(appHome);
  index.conversations[sanitized.id] = toIndexEntry(sanitized);
  writeIndex(appHome, index);
  return sanitized;
}

export function deleteConversation(appHome: string, id: string): void {
  // Migrate first (and refuse if migration is pending) so a subsequent
  // readIndex() can't recreate the file we delete or strand old chats.
  assertMigratedBeforeWrite(appHome);
  try {
    const p = conversationPath(appHome, id);
    if (existsSync(p)) rmSync(p);
  } catch {
    /* ignore */
  }
  const index = readIndex(appHome);
  if (index.conversations[id]) {
    delete index.conversations[id];
    if (index.activeConversationId === id) index.activeConversationId = null;
    writeIndex(appHome, index);
  }
}

export function clearAllConversations(appHome: string): void {
  // Migrate first (refuse if pending) so the monolith can't be re-split after clear.
  assertMigratedBeforeWrite(appHome);
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
  writeIndex(appHome, { conversations: {}, activeConversationId: null, settings: readIndex(appHome).settings });
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
