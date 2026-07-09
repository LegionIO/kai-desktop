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

/** Full persisted conversation, including heavy message data. */
export type ConversationRecord = {
  id: string;
  title: string | null;
  fallbackTitle: string | null;
  messages: unknown[];
  messageTree?: unknown[];
  headId?: string | null;
  conversationCompaction: unknown | null;
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
    hasToolCalls: computeHasToolCalls(conv),
    metadata: conv.metadata,
  };
}

// ── index read/write ─────────────────────────────────────────────────────────

const EMPTY_INDEX: ConversationIndex = { conversations: {}, activeConversationId: null, settings: {} };

export function readIndex(appHome: string): ConversationIndex {
  migrateMonolithIfNeeded(appHome);
  const p = indexPath(appHome);
  if (!existsSync(p)) return { ...EMPTY_INDEX, conversations: {}, settings: {} };
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf-8')) as Partial<ConversationIndex>;
    return {
      conversations: parsed.conversations ?? {},
      activeConversationId: parsed.activeConversationId ?? null,
      settings: parsed.settings ?? {},
    };
  } catch {
    return { conversations: {}, activeConversationId: null, settings: {} };
  }
}

export function writeIndex(appHome: string, index: ConversationIndex): void {
  ensureDirs(appHome);
  writeFileSync(indexPath(appHome), JSON.stringify(index, null, 2), 'utf-8');
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
  ensureDirs(appHome);
  writeFileSync(conversationPath(appHome, conv.id), JSON.stringify(conv, null, 2), 'utf-8');
  const index = readIndex(appHome);
  index.conversations[conv.id] = toIndexEntry(conv);
  writeIndex(appHome, index);
}

export function deleteConversation(appHome: string, id: string): void {
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

export function setActiveConversationId(appHome: string, id: string | null): void {
  const index = readIndex(appHome);
  index.activeConversationId = id;
  writeIndex(appHome, index);
}

// ── migration ────────────────────────────────────────────────────────────────

let migrationChecked = false;

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
    ensureDirs(appHome);
    const index: ConversationIndex = {
      conversations: {},
      activeConversationId: parsed.activeConversationId ?? null,
      settings: parsed.settings ?? {},
    };
    for (const [id, conv] of Object.entries(conversations)) {
      try {
        writeFileSync(conversationPath(appHome, id), JSON.stringify(conv, null, 2), 'utf-8');
        index.conversations[id] = toIndexEntry(conv);
      } catch (err) {
        console.error(`[conversation-store] migration: failed to write conversation ${id}:`, err);
      }
    }
    writeIndex(appHome, index);
    // Keep the monolith as a safety copy — never delete migrated data.
    renameSync(mono, `${mono}.migrated`);
    console.info(
      `[conversation-store] migrated ${Object.keys(index.conversations).length} conversations to per-file storage`,
    );
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
