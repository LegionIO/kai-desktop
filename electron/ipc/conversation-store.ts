import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'fs';
import { join } from 'path';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { traceDiagnostic } from '../diagnostics/debug-trace.js';
import {
  computeMessageCount,
  messageContentSig,
  tokenProjectionSerializedLength,
  tokenProjectionByteCeiling,
} from '../agent/tokenization.js';
import {
  offloadTreeDisplayMedia,
  collectReferencedMediaPaths,
  gcOrphanedMedia,
} from '../agent/offload-display-media.js';

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
  /** Durable copy of un-restorable inputs stashed by a /compact-busy rollback (the user's
   *  unsent text + attachments). Held in volatile renderer memory for fast in-session restore,
   *  but ALSO persisted here so a reload/close/crash doesn't silently lose the input. Restored
   *  when the user next opens the chat, then cleared. Small + rare; cleared on restore. */
  pendingDrafts?: Array<{ id: string; text: string; attachments: unknown[]; stashedAt: number }>;
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
  // DURABLE deletion tombstones — a bounded, most-recent-last ring of ids that have been
  // deleted. Survives process restart (unlike the in-memory recentlyDeletedConversations map),
  // so a stale client that reconnects after a backend restart or after the in-memory TTL expired
  // still cannot resurrect a deleted conversation via a create-shaped writeConversation. Bounded
  // (DURABLE_DELETED_MAX) so it never grows unboundedly; the oldest ids age out, which is safe
  // because a genuinely-stale persist for a long-ago-deleted id is not a realistic occurrence.
  deletedIds?: string[];
};

// ── paths ────────────────────────────────────────────────────────────────────

function conversationsDir(appHome: string): string {
  return join(appHome, 'data', 'conversations');
}
function conversationPath(appHome: string, id: string): string {
  return join(conversationsDir(appHome), `${sanitizeId(id)}.json`);
}
// A conversation id is a UUID (~36 chars); anything wildly longer is malformed/abusive. The
// delete/tombstone/index-ring structures are keyed by id, and delete is reachable from the web
// bridge — a near-4-MiB "id" would otherwise be stored in the durable deletedIds ring + index.json
// and forced through synchronous rewrites (memory/disk DoS, R178). Reject a non-string or over-long
// id at the delete chokepoint.
const MAX_CONVERSATION_ID_LENGTH = 256;
function isPlausibleConversationId(id: unknown): id is string {
  return typeof id === 'string' && id.length > 0 && id.length <= MAX_CONVERSATION_ID_LENGTH;
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
      deletedIds: Array.isArray(parsed.deletedIds)
        ? parsed.deletedIds.filter((x): x is string => typeof x === 'string')
        : [],
    };
  } catch {
    // Corrupt/truncated index — the per-file conversation records are the source
    // of truth, so rebuild the summaries from them instead of returning empty
    // (which would make every chat vanish from the list). activeConversationId +
    // settings are best-effort lost, but no message data is. PRESERVE the durable
    // deletedIds ring (R135 f-4): it can't be reconstructed from live files (the deleted
    // records are gone), so losing it would let a stale put RECREATE a deleted conversation.
    // Recover it leniently from the corrupt text (a trailing truncation usually leaves the
    // earlier deletedIds array intact) before rebuilding.
    const salvagedDeletedIds = salvageDeletedIdsFromCorruptIndex(p);
    const rebuilt = rebuildIndexFromConversationFiles(appHome);
    if (rebuilt) {
      if (salvagedDeletedIds.length > 0) rebuilt.deletedIds = salvagedDeletedIds;
      return rebuilt;
    }
    return {
      conversations: {},
      activeConversationId: null,
      settings: {},
      ...(salvagedDeletedIds.length > 0 ? { deletedIds: salvagedDeletedIds } : {}),
    };
  }
}

/** Best-effort recover the `deletedIds` array from a CORRUPT index file's raw text. A
 *  full JSON.parse already failed (truncation/corruption), but the deletedIds array — a
 *  flat list of string ids — usually sits intact earlier in the file. Extract it TOLERANTLY
 *  (R135 f-4 / R136 f-3): do NOT require a closing `]` (truncation INSIDE the array must still
 *  recover every complete id before the cut), and anchor on the TOP-LEVEL `deletedIds` key
 *  (`{"deletedIds"` or `,"deletedIds"` at the object root) so a nested conversation field named
 *  deletedIds can't shadow it. Returns [] when nothing recoverable. */
function salvageDeletedIdsFromCorruptIndex(indexFilePath: string): string[] {
  try {
    const raw = readFileSync(indexFilePath, 'utf-8');
    // Locate the TOP-LEVEL (object depth 1) "deletedIds" key by a string-aware brace-depth
    // walk, so a NESTED conversation field of the same name can't shadow it (R136 f-3). Track
    // depth outside of JSON strings; record the index of a `"deletedIds"` seen at depth 1.
    let depth = 0;
    let inStr = false;
    let esc = false;
    let keyStart = -1;
    for (let i = 0; i < raw.length; i++) {
      const ch = raw[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') {
        // A key/string starts here. At depth 1, record it ONLY if it is exactly "deletedIds"
        // AND is used as a KEY (followed by `:`), so a depth-1 VALUE string "deletedIds" (e.g.
        // "activeConversationId":"deletedIds") can't overwrite the real key location (R137 f-6).
        if (depth === 1 && raw.startsWith('"deletedIds"', i)) {
          let k = i + '"deletedIds"'.length;
          while (k < raw.length && /\s/.test(raw[k])) k++;
          if (raw[k] === ':') keyStart = i;
        }
        inStr = true;
        continue;
      }
      if (ch === '{' || ch === '[') depth++;
      else if (ch === '}' || ch === ']') depth--;
    }
    if (keyStart === -1) return [];
    // Verify the value is actually an ARRAY: after the key + `:` + whitespace the next char must
    // be `[`. Otherwise (`"deletedIds":null`, a number, a truncation right after the key) do NOT
    // grab a later unrelated `[` (e.g. settings.pendingConversationIds) and mis-salvage its ids
    // as deleted (R137 f-6). The key literal is 12 chars ("deletedIds" + the 2 quotes).
    let j = keyStart + '"deletedIds"'.length;
    while (j < raw.length && /\s/.test(raw[j])) j++;
    if (raw[j] !== ':') return [];
    j++;
    while (j < raw.length && /\s/.test(raw[j])) j++;
    if (raw[j] !== '[') return []; // value isn't an array → nothing to salvage from this key
    const openBracket = j;
    // Slice to the array's close `]` if present, else to EOF — a truncation mid-array still
    // yields the complete quoted ids that precede the cut (no closing `]` required).
    const closeBracket = raw.indexOf(']', openBracket);
    const end = closeBracket === -1 ? raw.length : closeBracket;
    const segment = raw.slice(openBracket + 1, end);
    const ids = segment.match(/"((?:[^"\\]|\\.)*)"/g);
    if (!ids) return [];
    return ids.map((s) => s.slice(1, -1)).filter((s) => s.length > 0);
  } catch {
    return [];
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
    // Preserve the durable deletion tombstones across a schema reindex — dropping them would
    // remove resurrection protection for every deleted conversation (a stale client could then
    // recreate one). rebuildIndexFromConversationFiles never carries them (it scans data files),
    // so take them from the prior index.
    deletedIds: Array.isArray(index.deletedIds) ? [...index.deletedIds] : [],
  });
  console.info(`[conversation-store] reindexed ${count} conversation(s) to schema v${INDEX_SCHEMA_VERSION}`);
  return count;
}

export function writeIndex(appHome: string, index: ConversationIndex): void {
  ensureDirs(appHome);
  atomicWriteFileSync(indexPath(appHome), JSON.stringify(index, null, 2));
}

/** Startup reconciliation for the delete/clear durable-write-failure gap (R165 f-2). A best-effort
 *  index write that FAILED after a conversation's file was already removed leaves a GHOST index
 *  entry (file gone) with NO durable deleted-id — the in-memory tombstone + ghost flag that guarded
 *  it are process-local and vanish on restart, so the deleted chat would REAPPEAR in the list AND be
 *  resurrectable by a stale writer. Run ONCE at backend startup: scan every indexed id, and for each
 *  whose record FILE is definitively gone (ENOENT), drop the entry AND push its id into the DURABLE
 *  deletedIds ring so it survives as a tombstone. Fail-OPEN per entry (only a definite ENOENT drops
 *  it — a transient stat error keeps it) so a readable chat is never lost. Returns the number
 *  reconciled. Cheap enough for startup (one O(N) statSync pass; startup already does a full sweep). */
export function reconcileGhostIndexEntries(appHome: string): number {
  if (monolithMigrationPending(appHome)) return 0;
  let index: ConversationIndex;
  try {
    index = readIndex(appHome);
  } catch {
    return 0; // a corrupt index is handled by readIndex's own rebuild path
  }
  const ghostIds: string[] = [];
  for (const id of Object.keys(index.conversations)) {
    let missing = false;
    try {
      statSync(conversationPath(appHome, id));
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') missing = true;
      // any other stat error → keep the entry (fail open)
    }
    if (missing) ghostIds.push(id);
  }
  // FORWARD reconcile (R170 f-8): a writeConversation whose index maintenance failed AFTER the file
  // committed (R169 f-2) leaves a record FILE on disk with NO index entry — it's broadcast live but
  // vanishes from the list after restart (readIndex only rebuilds a CORRUPT/missing index, not a
  // parseable-but-incomplete one). Scan the conversations dir and re-add any present file whose id is
  // absent from the index — UNLESS it's durably deleted (a tombstoned record whose file rm failed
  // must NOT be resurrected into the catalog).
  const orphanFileIds: string[] = [];
  try {
    const dir = conversationsDir(appHome);
    if (existsSync(dir)) {
      for (const name of readdirSync(dir)) {
        if (!name.endsWith('.json')) continue;
        const id = name.slice(0, -'.json'.length);
        if (!index.conversations[id] && !isDurablyDeleted(index, id) && !isRecentlyDeleted(id)) {
          orphanFileIds.push(id);
        }
      }
    }
  } catch {
    /* dir scan best-effort */
  }
  if (ghostIds.length === 0 && orphanFileIds.length === 0) return 0;
  for (const id of ghostIds) {
    delete index.conversations[id];
    if (index.activeConversationId === id) index.activeConversationId = null;
    pushDurableDeletedId(index, id); // durable tombstone so a stale writer can't resurrect it
  }
  for (const id of orphanFileIds) {
    try {
      const rec = readConversation(appHome, id);
      if (rec) index.conversations[id] = toIndexEntry(rec);
    } catch {
      /* unreadable — skip (a later read handles it) */
    }
  }
  try {
    writeIndex(appHome, index);
  } catch (err) {
    // If even this reconcile write fails, set an IN-MEMORY tombstone for each ghost (R166 f-2) so the
    // tombstone-authoritative writeConversation guard still BLOCKS a stale client from resurrecting it
    // THIS session (the disk index still contains the ghost, so the flag alone — which only gates the
    // list-filter — is not enough). Also keep the ghost flag set so the list-filter hides them. A
    // later successful write reconciles durably.
    for (const id of ghostIds) tombstoneConversation(id);
    console.error('[conversation-store] reconcileGhostIndexEntries: index write failed', err);
    markIndexMayHaveGhosts();
    return 0;
  }
  console.info(
    `[conversation-store] reconciled ${ghostIds.length} ghost + ${orphanFileIds.length} orphan-file index entr(y|ies) at startup`,
  );
  return ghostIds.length + orphanFileIds.length;
}

// ── conversation read/write ───────────────────────────────────────────────────

export function readConversation(appHome: string, id: string): ConversationRecord | null {
  return readConversationImpl(appHome, id, false);
}

/** R269: like readConversation but DISTINGUISHES a genuinely-absent conversation (returns null) from a
 *  read/parse FAILURE (THROWS). readConversation collapses both to null, which is ambiguous for callers that
 *  must not treat a transient failure as "absent" (e.g. the replaceById upsert deciding append-vs-retain — a
 *  null-as-absent there collision-renames an existing node into a duplicate). Absent → null; failure → throw. */
export function readConversationStrict(appHome: string, id: string): ConversationRecord | null {
  return readConversationImpl(appHome, id, true);
}

function readConversationImpl(appHome: string, id: string, strict: boolean): ConversationRecord | null {
  migrateMonolithIfNeeded(appHome);
  let p: string;
  try {
    p = conversationPath(appHome, id);
  } catch (err) {
    if (strict) throw err;
    return null;
  }
  // R270: strict mode must NOT use existsSync as the absence test — existsSync returns false for BOTH a
  // genuinely-missing file (ENOENT) AND a permission/I-O failure to stat it (EACCES/EIO/ELOOP/...), which would
  // make a transient failure look like absence and drop the caller's sole recovery copy. So in strict mode read
  // DIRECTLY and classify by the error's code: ENOENT → genuine absence (null); any other error → THROW (retain).
  let raw: string;
  try {
    raw = readFileSync(p, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return null; // genuinely absent (both modes)
    if (strict) throw err; // R270: a stat/read failure that is NOT ENOENT is a transient error, not absence
    return null; // non-strict: fail-open as before
  }
  try {
    const rec = JSON.parse(raw) as ConversationRecord;
    // Advance the revision floor past any stored compaction revision so a clock rollback /
    // VM restore can't later issue a lower revision than what's already on disk.
    observeCompactionRevision(
      (rec?.conversationCompaction as { compactionRevision?: number } | null)?.compactionRevision,
    );
    return rec;
  } catch (err) {
    if (strict) throw err; // R269: a parse failure is NOT absence — let the caller retain+retry
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
export function sanitizeConversationTree(
  conv: ConversationRecord,
  priorTree?: unknown[] | null,
  appHome?: string,
): ConversationRecord {
  let rawTree = Array.isArray(conv.messageTree) ? conv.messageTree : null;
  if (!rawTree || rawTree.length === 0) {
    // Legacy `messages`-only record (no messageTree — the monolith migration doesn't
    // synthesize one). Structural sanitize has nothing to do, but its media STILL
    // needs offloading, else exactly these legacy records keep their base64 and OOM
    // startup. Offload the linear mirror in place before returning.
    if (appHome && Array.isArray(conv.messages)) {
      const msgOffload = offloadTreeDisplayMedia(conv.messages, appHome);
      if (msgOffload.rewritten > 0) return { ...conv, messages: msgOffload.tree as unknown[] };
    }
    return conv;
  }
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
  const { tree: sanitizedTree, headId, report } = sanitizeMessageTree(rawTree, headInput);
  // Offload inline base64 DISPLAY media (user attachments) to disk-backed
  // kai-media:// URLs — AFTER sanitizeMessageTree has dropped malformed/duplicate/
  // id-less nodes, so a node that won't be persisted never materializes an orphan
  // media file (which deletion GC could then never reclaim). Runs BEFORE the token
  // backfill so counts reflect the tiny URL content, not the base64. This is the
  // single low-level write chokepoint (conversations:put AND the main-owned
  // stream-persistence path both funnel through writeConversation → here). Model-
  // visible `_modelContent` is never touched. No-op (original reference) when there
  // is nothing to offload. appHome is optional so structural-only test callers skip
  // media offload entirely.
  let tree = sanitizedTree;
  let mediaOffloaded = false;
  if (appHome) {
    const offloaded = offloadTreeDisplayMedia(sanitizedTree, appHome);
    if (offloaded.rewritten > 0) {
      tree = offloaded.tree as typeof sanitizedTree;
      mediaOffloaded = true;
    }
    // Offload the linear `messages` mirror INDEPENDENTLY: the backfill-only path
    // below maps it from `conv.messages` (not re-derived from the tree), so a tree
    // that was already URL-ized could still carry a stale base64 mirror. Content-
    // addressed → identical bytes resolve to the same URL on both arrays.
    if (Array.isArray(conv.messages)) {
      const msgOffload = offloadTreeDisplayMedia(conv.messages, appHome);
      if (msgOffload.rewritten > 0) {
        conv = { ...conv, messages: msgOffload.tree as unknown[] };
        mediaOffloaded = true;
      }
    }
  }

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

  if (!report.changed && backfilled === 0) {
    // Nothing structural changed and no count was (re)computed. But if media offload
    // rewrote the tree and/or messages mirror (files already written to disk), we
    // must persist the URL-ized versions — returning the original `conv` would drop
    // them, re-persisting base64 AND orphaning the just-written media file.
    if (mediaOffloaded) {
      return { ...conv, messageTree: tree as unknown[] };
    }
    return conv;
  }

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
// Set true when a durable index write FAILS after files were already removed (delete/clear), which
// can leave GHOST index entries whose record file is gone (R163 f-2). conversations:list consults
// this to decide whether to pay the per-entry missing-file statSync filter — so the steady-state
// (no failure) list path stays O(N) with NO per-entry stat, and the O(N) filter only runs while a
// known ghost window is open. Cleared by the next SUCCESSFUL index write (writeConversation or a
// delete/clear whose write landed), which reconciles the on-disk index.
let indexMayHaveGhosts = false;
export function markIndexMayHaveGhosts(): void {
  indexMayHaveGhosts = true;
}
export function clearIndexGhostFlag(): void {
  indexMayHaveGhosts = false;
}
export function getIndexMayHaveGhosts(): boolean {
  return indexMayHaveGhosts;
}
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

// Bound on the DURABLE deleted-id ring persisted in the index. Larger than the in-memory cap
// because it is the long-lived resurrection defense (survives restart / TTL expiry); a few
// thousand ids is a trivial index-size cost. Oldest ids age out first (drop-front).
const DURABLE_DELETED_MAX = 10_000;
// Append an id to the index's durable deleted-id ring (dedup + drop-oldest). Mutates the passed
// index in place; the caller is responsible for writeIndex. Idempotent for an id already present
// (re-inserts at the back so it ages out last).
function pushDurableDeletedId(index: ConversationIndex, id: string): void {
  const list = Array.isArray(index.deletedIds) ? index.deletedIds : [];
  const existing = list.indexOf(id);
  if (existing !== -1) list.splice(existing, 1);
  list.push(id);
  while (list.length > DURABLE_DELETED_MAX) list.shift();
  index.deletedIds = list;
}
// True iff the id is in the index's durable deleted ring — a restart/TTL-surviving tombstone.
function isDurablyDeleted(index: ConversationIndex, id: string): boolean {
  return Array.isArray(index.deletedIds) && index.deletedIds.includes(id);
}
// True iff the conversation has an INDEX entry (exists on disk per the index), independent of
// whether its record file can currently be READ. Lets a caller distinguish "genuinely absent /
// first turn" from "exists but readConversation failed transiently (EMFILE/truncated JSON)" —
// the latter must NOT be treated as recordless for a fail-closed security decision (R135 f-3).
export function conversationExistsInIndex(appHome: string, id: string): boolean {
  return Boolean(readIndex(appHome).conversations[id]);
}
// Lightweight "is the record FILE on disk" probe for LIST filtering (R162 f-2). A failed durable
// index write during delete/clear can leave a GHOST index entry whose file is already gone;
// conversations:list would otherwise surface it. statSync (NOT the heavier conversationExistenceState,
// which also reads the file) with fail-OPEN semantics: only a definite ENOENT drops the entry; any
// other stat error (EACCES/EMFILE) keeps it, so a transiently-unreadable real chat is never hidden.
export function conversationFileExists(appHome: string, id: string): boolean {
  try {
    statSync(conversationPath(appHome, id));
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return false;
    return true; // fail open: don't hide a real chat on a non-ENOENT stat error
  }
}
// TRI-STATE existence for a fail-closed decision (R136 f-2 / R137 f-2): 'exists' | 'absent' |
// 'unknown'. A plain boolean fails OPEN when the record can't be read (EMFILE/EACCES/truncated
// JSON) — the caller would treat an existing plan-first chat as recordless and run mutating
// tools. Probe the record FILE with statSync (NOT existsSync, which returns false for EACCES
// instead of throwing → would mis-classify an unsearchable dir as 'absent', R137 f-2): ENOENT →
// 'absent'; any other stat error → 'unknown'; file present + reads OK → 'exists'; present but
// UNREADABLE → 'unknown' (caller fails closed to plan-first).
export function conversationExistenceState(appHome: string, id: string): 'exists' | 'absent' | 'unknown' {
  try {
    statSync(conversationPath(appHome, id));
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return 'absent';
    return 'unknown'; // EACCES / EMFILE / any other stat failure → can't rule out an existing record
  }
  try {
    return readConversation(appHome, id) != null ? 'exists' : 'unknown';
  } catch {
    return 'unknown';
  }
}
// (was: an index-only existence probe that could fail open on an index read failure)
// Public tombstone check: is this id currently blocked from a create-shaped write (recently
// deleted in-memory, OR durably deleted and absent from the index)? Callers that BROADCAST a write
// (conversations:put) use this to avoid emitting a phantom upsert / false success for a write that
// writeConversation will silently suppress. Returns false for an id still present in the index (a
// normal update, or a legitimate recreate before the tombstone was set).
export function isWriteTombstoned(appHome: string, id: string): boolean {
  // The in-memory tombstone is AUTHORITATIVE on its own (R162 f-1): a recently-deleted id is
  // tombstoned even if the index still LISTS it. The delete removes the file + sets the in-memory
  // tombstone BEFORE the durable index update, and that index update is best-effort (can fail after
  // the file is gone — R161 f-1); requiring the index entry to be ABSENT would let a failed
  // index-write re-expose a just-deleted id to resurrection. A legitimate recreate uses a fresh id,
  // so an in-memory-tombstoned id being written is always a stale in-flight persist.
  if (isRecentlyDeleted(id)) return true;
  const idx = readIndex(appHome);
  return !idx.conversations[id] && isDurablyDeleted(idx, id);
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
  // Resurrection guard runs BEFORE media offload (which writes files to disk):
  // a stale in-flight persist to a DELETED conversation must be suppressed without
  // materializing its attachment media under the app home (orphaned files + a
  // privacy leak for a just-deleted sensitive chat). The structural sanitize is
  // idempotent and side-effect-free, so the suppressed path still runs it (without
  // appHome → no media offload) to return a coherent record. Only the media-writing
  // offload is gated. `conv.id` is the sanitized id (sanitize never rewrites ids),
  // so checking it here is equivalent to the prior post-sanitize check.
  //
  // Two tombstone sources: the in-memory TTL map (fast path, covers the common
  // mid-flight delete) AND the DURABLE index ring (survives restart / TTL expiry).
  // The in-memory tombstone is AUTHORITATIVE ON ITS OWN — suppress even if the index
  // still LISTS the id (R162 f-1): the delete sets the in-memory tombstone BEFORE its
  // best-effort (can-fail) index update, so requiring index-absence would let a failed
  // delete index-write resurrect the just-deleted conversation. A legitimate recreate
  // uses a fresh id, so an in-memory-tombstoned id being written is always stale. The
  // durable-ring branch keeps requiring index-absence (a durably-deleted id back in the
  // index was legitimately recreated later).
  const isTombstoned =
    isRecentlyDeleted(conv.id) ||
    (() => {
      try {
        const idx = readIndex(appHome);
        return !idx.conversations[conv.id] && isDurablyDeleted(idx, conv.id);
      } catch {
        return false; // index read blip → don't suppress a legitimate write
      }
    })();
  if (isTombstoned) {
    markWriteSuppressed(conv.id);
    return sanitizeConversationTree(conv, priorTree); // structural only, no media writes
  }
  const sanitized = sanitizeConversationTree(conv, priorTree, appHome);
  atomicWriteFileSync(conversationPath(appHome, sanitized.id), JSON.stringify(sanitized, null, 2));
  // The conversation FILE is now committed — the write SUCCEEDED from the caller's perspective. The
  // index is a DERIVED, rebuildable cache (rebuildIndexFromConversationFiles scans the files), so a
  // throw during index maintenance must NOT propagate out of writeConversation (R169 f-2): letting it
  // throw made the stream-persistence caller treat a COMMITTED response as failed, retain its
  // accumulator, and DOUBLE-PERSIST it under a collision id on the next finalize. Swallow + log; the
  // index self-heals on the next corrupt/missing read or the startup ghost reconcile.
  try {
    const index = readIndex(appHome);
    index.conversations[sanitized.id] = toIndexEntry(sanitized);
    writeIndex(appHome, index);
  } catch (err) {
    console.error('[conversation-store] writeConversation: index maintenance failed after file commit', err);
  }
  lastWriteSuppressed.delete(sanitized.id);
  // Reclaim media a REWRITE dropped: if the prior on-disk tree referenced media the
  // newly-committed tree no longer does (e.g. dropConversationMessages during an
  // automation rollback removed the last reference), that file would otherwise never
  // enter deletion GC (which only sees the CURRENT record). Diff prior→new refs and
  // GC the dropped ones. gcMediaAfterDelete scans surviving conversations — including
  // this just-written record — so a ref still present anywhere is correctly retained.
  if (appHome) {
    try {
      const priorRefs = collectReferencedMediaPaths(priorTree);
      if (priorRefs.size > 0) {
        const newRefs = collectReferencedMediaPaths(sanitized.messageTree);
        collectReferencedMediaPaths(sanitized.messages, newRefs);
        const dropped = new Set<string>();
        for (const r of priorRefs) if (!newRefs.has(r)) dropped.add(r);
        if (dropped.size > 0) gcMediaAfterDelete(appHome, dropped);
      }
    } catch {
      /* best-effort rewrite GC — never fails a committed write */
    }
  }
  return sanitized;
}

// Records whether the MOST RECENT writeConversation for an id SUPPRESSED the write (tombstoned).
// Lets a caller learn suppression WITHOUT a second (throwable) isWriteTombstoned lookup after the
// write — the R147-f-1 fix's post-write re-lookup could throw AFTER the write already committed,
// and defaulting that to the PERMANENT conversation-deleted signal left a ghost running turn
// (R148). Bounded at ADD time (not only on consume) so a non-consuming caller — e.g. the plugin
// upsert, which reads suppression via isWriteTombstoned, not consumeWriteWasSuppressed — can't
// grow it without bound via repeated stale writes after a clear (R149).
const lastWriteSuppressed = new Set<string>();
const MAX_WRITE_SUPPRESSED = 500;
function markWriteSuppressed(id: string): void {
  // Re-insert at the back (delete → add) so recency reflects usefulness, then evict oldest.
  lastWriteSuppressed.delete(id);
  lastWriteSuppressed.add(id);
  while (lastWriteSuppressed.size > MAX_WRITE_SUPPRESSED) {
    const oldest = lastWriteSuppressed.values().next().value;
    if (oldest === undefined) break;
    lastWriteSuppressed.delete(oldest);
  }
}
/** True iff the most recent {@link writeConversation} for `id` suppressed the write (tombstoned).
 *  Consumes the flag (one-shot) so a stale later read can't misreport. Never throws. */
export function consumeWriteWasSuppressed(id: string): boolean {
  return lastWriteSuppressed.delete(id);
}

/** Delete a single conversation. Returns true iff the data file is GONE (removed now, or
 *  already absent) and the index entry was dropped — mirrors {@link deleteConversations}'
 *  preserve-on-rm-failure semantics so a failed rm keeps the conversation intact (and the
 *  caller can avoid cancelling/broadcasting for a delete that didn't happen). */
/**
 * Reclaim media files that were referenced ONLY by now-deleted conversations.
 * `removedRefs` is the union of media paths across the deleted conversations'
 * trees (collected BEFORE their files were removed). Scans every SURVIVING
 * conversation file to build the still-referenced set, then unlinks any removed
 * ref no survivor references.
 *
 * DEFERRED off the delete's critical path (setImmediate): the survivor scan is
 * O(store size) — readFile + JSON.parse over every conversation — so running it
 * synchronously would stall the main thread (and delay the delete's IPC return +
 * broadcast) on a large/legacy store. The delete has already committed (file gone,
 * index updated) by the time this runs; a crash before it merely leaves reclaimable
 * media that the next delete's sweep collects. Best-effort + throw-safe throughout.
 * The scan reads WHOLE strings deeply, so a kai-media:// URL embedded in markdown
 * text (not just a display part) is correctly counted as a surviving reference and
 * never wrongly deleted. Skips entirely when nothing was referenced.
 */
function gcMediaAfterDelete(appHome: string, removedRefs: Set<string>): void {
  if (removedRefs.size === 0) return;
  setImmediate(() => {
    try {
      const surviving = new Set<string>();
      const dir = conversationsDir(appHome);
      if (existsSync(dir)) {
        for (const name of readdirSync(dir)) {
          if (!name.endsWith('.json')) continue;
          try {
            const conv = JSON.parse(readFileSync(join(dir, name), 'utf-8')) as ConversationRecord;
            collectReferencedMediaPaths(conv?.messageTree, surviving);
            collectReferencedMediaPaths(conv?.messages, surviving);
          } catch {
            // A corrupt/unreadable survivor: FAIL SAFE — abort the whole GC for this
            // batch rather than risk unlinking media a survivor we couldn't parse still
            // uses. Nothing is deleted; a later delete re-attempts the sweep.
            return;
          }
        }
      }
      gcOrphanedMedia(appHome, removedRefs, surviving);
    } catch {
      /* GC is best-effort cleanup — never surface a failure */
    }
  });
}

export function deleteConversation(appHome: string, id: string): boolean {
  // Reject a malformed / abusively-long id before it enters the tombstone + durable deletedId ring
  // + index (R178): treat it as a benign no-op (nothing to delete).
  if (!isPlausibleConversationId(id)) return false;
  // Migrate first (and refuse if migration is pending) so a subsequent
  // readIndex() can't recreate the file we delete or strand old chats.
  assertMigratedBeforeWrite(appHome);
  // Collect the media this conversation references BEFORE removing its file, so the
  // post-delete GC can reclaim any file no surviving conversation still uses.
  let removedRefs = new Set<string>();
  try {
    const existing = readConversation(appHome, id);
    collectReferencedMediaPaths(existing?.messageTree, removedRefs);
    collectReferencedMediaPaths(existing?.messages, removedRefs);
  } catch {
    removedRefs = new Set<string>(); // unreadable → nothing to GC
  }
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
  // (Deleting an already-absent id is a benign idempotent success — returns true.)
  // The in-memory tombstone is set BEFORE the index read/write below so that even if the durable
  // index update THROWS (readIndex/writeIndex EMFILE/EACCES), this session is still protected from
  // resurrection AND the caller still learns the file is GONE (R161 f-1): the index update is a
  // best-effort DURABILITY step, not a precondition for the delete having happened. Letting an
  // index-write throw propagate here would (a) skip the caller's stream/tool teardown + broadcast
  // and (b) leave the stale index entry able to resurrect the conversation on the NEXT persist —
  // strictly worse than swallowing and returning the truth: the record file is gone.
  tombstoneConversation(id);
  try {
    const index = readIndex(appHome);
    if (index.conversations[id]) {
      delete index.conversations[id];
      if (index.activeConversationId === id) index.activeConversationId = null;
    }
    // ALWAYS record the DURABLE tombstone once the file is gone — even if the index entry was
    // already absent (a rebuilt/corrupt index). Otherwise a restart drops the in-memory tombstone
    // and a stale client could resurrect the just-deleted conversation.
    pushDurableDeletedId(index, id);
    writeIndex(appHome, index);
    // NOTE: do NOT clearIndexGhostFlag() here (R164 f-3). A single delete's writeIndex persists the
    // index it just read MINUS this one id — it does NOT reconcile UNRELATED ghosts left by a prior
    // failed bulk clear, so clearing the flag would stop the list-filter while those ghosts remain.
    // Only clearAllConversations (which rebuilds the index from `preserved`) reconciles fully. An
    // over-set flag is safe (just an O(N) list filter); an under-set one re-exposes ghosts.
  } catch (err) {
    // Durable index update failed AFTER the file was removed. The in-memory tombstone (above) still
    // guards this session (the write-path resurrection guard is tombstone-authoritative — R162 f-1);
    // the caller must still tear down streams + broadcast the delete. A later successful index write
    // (or the salvage-on-corrupt-index path) re-drops the durable id. Log so a systematic durable
    // failure is visible rather than silently swallowed (R162).
    console.error('[conversation-store] deleteConversation: durable index write failed', err);
    markIndexMayHaveGhosts();
  }
  // Reclaim media referenced only by this now-deleted conversation (after the file
  // is gone, so this conversation's own refs don't count as "surviving").
  gcMediaAfterDelete(appHome, removedRefs);
  return true;
}

/** Batch delete: removes each conversation file and its index entry with a SINGLE
 *  index write at the end (vs. one per id via {@link deleteConversation}). Returns
 *  every id whose data file was confirmed GONE (including an orphan record with no
 *  index entry) — the caller uses this to drive stream/session teardown + broadcasts. */
export function deleteConversations(appHome: string, ids: string[]): string[] {
  assertMigratedBeforeWrite(appHome);
  const index = readIndex(appHome);
  const removed: string[] = [];
  const removedRefs = new Set<string>();
  for (const id of ids) {
    // Skip a malformed / abusively-long id before it touches the tombstone/index structures (R178).
    if (!isPlausibleConversationId(id)) continue;
    // Collect this record's media refs BEFORE removing its file (union across the batch).
    try {
      const existing = readConversation(appHome, id);
      collectReferencedMediaPaths(existing?.messageTree, removedRefs);
      collectReferencedMediaPaths(existing?.messages, removedRefs);
    } catch {
      /* unreadable → nothing to add */
    }
    // Only drop the index entry once the data file is GONE (removed now, or already
    // absent). If rmSync FAILS, the file remains on disk; dropping the index entry anyway
    // would orphan that data AND make the conversation invisible — so keep the entry and
    // skip this id (the caller can retry).
    let fileGone = false;
    let fileExisted = false;
    try {
      const p = conversationPath(appHome, id);
      if (existsSync(p)) {
        fileExisted = true;
        rmSync(p);
      }
      fileGone = true;
    } catch {
      fileGone = false; // removal failed — retain the index entry
    }
    if (!fileGone) continue;
    const hadEntry = Boolean(index.conversations[id]);
    if (hadEntry) {
      delete index.conversations[id];
      if (index.activeConversationId === id) index.activeConversationId = null;
    }
    // A genuine no-op (no file ever existed AND no index entry) is skipped — nothing was deleted,
    // so no teardown/tombstone. Otherwise (a real record removed, OR an orphan file/index entry):
    if (!fileExisted && !hadEntry) continue;
    // Tombstone once the file is gone — in-memory fast path + DURABLE index ring — even if the
    // index entry was already absent (rebuilt/corrupt index), so a restart can't resurrect it.
    tombstoneConversation(id);
    pushDurableDeletedId(index, id);
    // Return EVERY id whose record was actually removed (had a file and/or an index entry) — the
    // caller drives stream/automation/compaction cancellation, deletion broadcasts, and session
    // cleanup off this list. An orphan record (file but no index entry) still had those side
    // effects and must get the same teardown.
    removed.push(id);
  }
  if (removed.length > 0) {
    // Durable index write is best-effort: every removed id ALREADY has its file gone + an in-memory
    // tombstone (set in the loop), so a writeIndex throw here must NOT prevent the caller from
    // tearing down streams/tools + broadcasting the deletes for ids we've committed to (R161 f-1).
    // Swallow and return `removed`; the stale index entries are re-dropped by a later successful
    // write or the salvage-on-corrupt-index path, and this session is resurrection-guarded.
    try {
      writeIndex(appHome, index);
      // NOTE: do NOT clearIndexGhostFlag() here (R164 f-3) — a batch delete's writeIndex removes only
      // THIS batch's entries, not unrelated ghosts from a prior failed clear. Only clearAllConversations
      // reconciles fully. Over-set is safe; under-set re-exposes ghosts.
    } catch (err) {
      // durable persist failed after removal — in-memory tombstones (set per id in the loop) still
      // guard this session via the tombstone-authoritative write-path guard (R162 f-1). Log so a
      // systematic durable failure is visible rather than silently swallowed (R162).
      console.error('[conversation-store] deleteConversations: durable index write failed', err);
      markIndexMayHaveGhosts();
    }
  }
  // Reclaim media referenced only by the now-deleted batch (after files are gone).
  gcMediaAfterDelete(appHome, removedRefs);
  return removed;
}

/** Wipe all conversations. Returns `{ cleared, fullyCleared }`: `cleared` is the ids actually
 *  removed (the UNION of indexed ids and on-disk record files, INCLUDING an orphan record whose file
 *  exists but has no index entry) so the caller can cancel streams + broadcast a delete for each;
 *  `fullyCleared` is false if ANY record file survived (an rm failure — indexed OR orphan), so the
 *  caller must NOT broadcast a full reset (that would drop clients' accumulators for a still-live
 *  surviving run). */
export function conversationIdsForClear(appHome: string): string[] {
  // Migrate first (refuse if pending) so the monolith can't be re-split after clear.
  assertMigratedBeforeWrite(appHome);
  const priorIndex = readIndex(appHome);
  const dir = conversationsDir(appHome);
  // UNION of indexed ids and on-disk record files — an orphan file (no index entry) must be
  // tombstoned + torn down too, else a stale client / live stream can resurrect it.
  const candidateIds = new Set<string>(Object.keys(priorIndex.conversations));
  if (existsSync(dir)) {
    for (const name of readdirSync(dir)) {
      if (name.endsWith('.json')) candidateIds.add(name.slice(0, -'.json'.length));
    }
  }
  return [...candidateIds];
}

export function clearAllConversations(
  appHome: string,
  ids: Iterable<string> = conversationIdsForClear(appHome),
): { cleared: string[]; fullyCleared: boolean } {
  // Migrate first (refuse if pending) so the monolith can't be re-split after clear.
  assertMigratedBeforeWrite(appHome);
  const priorIndex = readIndex(appHome);
  const candidateIds = new Set(ids);
  // Remove each record file. A FAILED rm must NOT be treated as cleared — tombstoning/returning it
  // (and dropping the index entry) would leave the record on disk yet invisible + stop its stream,
  // stranding it. So preserve failures (per-file, like deleteConversations): only ids whose file is
  // confirmed GONE (removed now, or already absent = an index-only entry) are actually cleared.
  const cleared: string[] = [];
  const preserved: Record<string, ConversationIndexEntry> = {};
  const removedRefs = new Set<string>();
  let anySurvived = false;
  for (const id of candidateIds) {
    // Collect this record's media refs BEFORE removing its file.
    try {
      const existing = readConversation(appHome, id);
      collectReferencedMediaPaths(existing?.messageTree, removedRefs);
      collectReferencedMediaPaths(existing?.messages, removedRefs);
    } catch {
      /* unreadable → nothing to add */
    }
    let fileGone = false;
    try {
      const p = conversationPath(appHome, id);
      if (existsSync(p)) rmSync(p);
      fileGone = true;
    } catch {
      fileGone = false; // rm failed — retain this record
    }
    if (fileGone) {
      // Tombstone only once the file is actually gone so a stale in-flight persist can't resurrect.
      tombstoneConversation(id);
      cleared.push(id);
    } else {
      anySurvived = true; // a file (indexed OR orphan) survived — NOT a full clear
      if (priorIndex.conversations[id]) preserved[id] = priorIndex.conversations[id];
    }
  }
  // Carry the durable deleted-id ring forward (preserving prior tombstones) and add every id we
  // actually cleared, so a stale client can't resurrect a wiped conversation after restart/TTL.
  const nextIndex: ConversationIndex = {
    conversations: preserved,
    activeConversationId:
      priorIndex.activeConversationId && preserved[priorIndex.activeConversationId]
        ? priorIndex.activeConversationId
        : null,
    settings: priorIndex.settings,
    deletedIds: Array.isArray(priorIndex.deletedIds) ? [...priorIndex.deletedIds] : [],
  };
  for (const id of cleared) pushDurableDeletedId(nextIndex, id);
  // Durable index write is best-effort for RESURRECTION (every cleared id has its file gone + an
  // in-memory tombstone, and the write path's guard is tombstone-authoritative — R161 f-1 / R162
  // f-1), so a writeIndex throw must NOT block the caller's teardown/broadcast. BUT a failed write
  // leaves the OLD index (all entries) on disk while the files are gone: after reload those become
  // GHOST entries (conversations:list reads the index), and reporting fullyCleared:true would have
  // the caller broadcast a full reset it can't actually back with disk state (R162 f-2). So on a
  // write failure, report fullyCleared:false (the durable catalog was NOT fully cleared) and log it —
  // a systematic durability failure must be visible, not silently swallowed. conversations:list also
  // filters missing-file entries as defense-in-depth so any surviving ghost never reaches a client.
  let durablyPersisted = true;
  try {
    writeIndex(appHome, nextIndex);
    clearIndexGhostFlag(); // full index rewrite (only surviving entries) reconciles any ghosts
  } catch (err) {
    durablyPersisted = false;
    console.error('[conversation-store] clearAllConversations: durable index write failed', err);
    markIndexMayHaveGhosts();
  }
  // Reclaim media referenced only by cleared conversations. After the clear, only
  // PRESERVED (rm-failed) record files remain on disk, so gcMediaAfterDelete's
  // survivor scan correctly retains just their media and removes the rest.
  gcMediaAfterDelete(appHome, removedRefs);
  return { cleared, fullyCleared: !anySurvived && durablyPersisted };
}

// ── active id + settings ───────────────────────────────────────────────────────

export type ActiveConversationState = {
  activeConversationId: string | null;
  /** Process-local monotonic selection revision. Unlike the id, this detects
   * A→B→A changes while an asynchronous navigation is in flight. */
  activeConversationRevision: number;
};

const activeConversationRevisions = new Map<string, number>();

export function getActiveConversationId(appHome: string): string | null {
  const index = readIndex(appHome);
  const activeId = index.activeConversationId;
  // Older builds allowed callers to persist arbitrary ids. Treat an active id
  // without an indexed conversation as empty so restart cannot restore a
  // deleted chat into Browser ownership or any other conversation-scoped UI.
  return activeId && index.conversations[activeId] ? activeId : null;
}

export function getActiveConversationState(appHome: string): ActiveConversationState {
  return {
    activeConversationId: getActiveConversationId(appHome),
    activeConversationRevision: activeConversationRevisions.get(appHome) ?? 0,
  };
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

export function setActiveConversationId(appHome: string, id: string | null): number {
  // Guard: writing the index before a pending migration would strand the monolith.
  assertMigratedBeforeWrite(appHome);
  const index = readIndex(appHome);
  index.activeConversationId = id;
  writeIndex(appHome, index);
  const revision = (activeConversationRevisions.get(appHome) ?? 0) + 1;
  activeConversationRevisions.set(appHome, revision);
  return revision;
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

// Test-only: clear the module-level in-memory delete tombstone map + suppression flags so a fixed
// conversation id deleted in one test can't leak a tombstone into the next (production never reuses
// ids — they're UUIDs — so this is purely a test-isolation concern). Without this, the
// tombstone-authoritative resurrection guard (R162 f-1) would suppress a later legitimate write to a
// reused id.
export function __resetDeleteTombstonesForTests(): void {
  recentlyDeletedConversations.clear();
  lastWriteSuppressed.clear();
  lastTombstoneSweep = 0;
}

/** Test-only: reset process-local active-selection revisions. */
export function __resetActiveConversationRevisionsForTests(): void {
  activeConversationRevisions.clear();
}
