import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'fs';
import { join } from 'path';

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

/** Write a file atomically: write to a sibling temp file, then rename into place.
 *  rename(2) is atomic on the same filesystem, so a crash mid-write can never
 *  leave a torn/truncated destination — readers see either the old file or the
 *  fully-written new one. */
function atomicWriteFileSync(destPath: string, data: string): void {
  const tmp = `${destPath}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(tmp, data, 'utf-8');
    renameSync(tmp, destPath);
  } catch (err) {
    try {
      if (existsSync(tmp)) rmSync(tmp, { force: true });
    } catch {
      /* ignore cleanup failure */
    }
    throw err;
  }
}

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

/** Write one conversation file and update its index entry (single-file cost). */
export function writeConversation(appHome: string, conv: ConversationRecord): void {
  // Migrate BEFORE touching per-file state, and refuse to write if a legacy
  // monolith is still un-migrated — a partial index would strand old chats.
  assertMigratedBeforeWrite(appHome);
  ensureDirs(appHome);
  atomicWriteFileSync(conversationPath(appHome, conv.id), JSON.stringify(conv, null, 2));
  const index = readIndex(appHome);
  index.conversations[conv.id] = toIndexEntry(conv);
  writeIndex(appHome, index);
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
