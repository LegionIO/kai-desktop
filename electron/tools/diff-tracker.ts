/**
 * Per-conversation file-edit diff tracker.
 *
 * Captures the on-disk original of a file the first time a mutating tool
 * touches it, then re-reads after each mutation and emits a unified diff.
 * Works outside git repos — all state is in-memory keyed by conversationId.
 *
 * Detection is hybrid:
 *   - `trackFileWrite`: snapshot-based, called around the Mastra workspace
 *     write/edit tools where we know the target path.
 *   - `beginShellSnapshot` / `finishShellSnapshot`: mtime scan of the
 *     file-access allowlist before/after a shell/CLI command. Capped by
 *     file count and wall-clock; if the cap trips or the scan finds nothing
 *     for a mutating-looking command, an AI fallback infers likely-changed
 *     paths from the command + stdout/stderr.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { BrowserWindow } from 'electron';
import { generateText } from 'ai';
import picomatch from 'picomatch';
import type { AppConfig } from '../config/schema.js';
import type { DiffEvent, DiffOp, DiffSource, FileDiff } from '../../shared/diff-types.js';
import { computeUnifiedDiff } from './lib/myers-diff.js';
import { createLanguageModelFromConfig } from '../agent/language-model.js';
import { resolveModelCatalog } from '../agent/model-catalog.js';

// ───────────────────────────────────────────────────────────────────────────
// Store
// ───────────────────────────────────────────────────────────────────────────

type TrackedFile = {
  original: string;
  current: string;
  created: boolean;
  deleted: boolean;
  ops: DiffOp[];
  lastSource: DiffSource;
};

type ConversationStore = Map<string, TrackedFile>;

const store = new Map<string, ConversationStore>();

function getConversationStore(conversationId: string): ConversationStore {
  let s = store.get(conversationId);
  if (!s) {
    s = new Map();
    store.set(conversationId, s);
  }
  return s;
}

// ───────────────────────────────────────────────────────────────────────────
// Config
// ───────────────────────────────────────────────────────────────────────────

export type DiffTrackingConfig = {
  enabled: boolean;
  snapshotFileLimit: number;
  snapshotTimeoutMs: number;
  aiFallback: boolean;
};

export function resolveDiffTrackingConfig(config: AppConfig): DiffTrackingConfig {
  const raw = config.tools.diffTracking;
  return {
    enabled: raw?.enabled ?? true,
    snapshotFileLimit: raw?.snapshotFileLimit ?? 2000,
    snapshotTimeoutMs: raw?.snapshotTimeoutMs ?? 200,
    aiFallback: raw?.aiFallback ?? true,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────────

const MAX_TRACKED_BYTES = 2 * 1024 * 1024;

function safeRead(absPath: string): { exists: boolean; content: string } {
  try {
    const st = statSync(absPath);
    if (!st.isFile() || st.size > MAX_TRACKED_BYTES) return { exists: st.isFile(), content: '' };
    return { exists: true, content: readFileSync(absPath, 'utf-8') };
  } catch {
    return { exists: false, content: '' };
  }
}

function hashContent(content: string): string {
  return createHash('sha1').update(content).digest('hex');
}

function broadcast(event: DiffEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('diffs:changed', event);
  }
}

function toFileDiff(conversationId: string, path: string, entry: TrackedFile): FileDiff {
  const { unified, additions, deletions } = computeUnifiedDiff(entry.original, entry.current, { path });
  return {
    conversationId,
    path,
    unifiedDiff: unified,
    additions,
    deletions,
    created: entry.created,
    deleted: entry.deleted,
    ops: entry.ops,
    source: entry.lastSource,
  };
}

/**
 * Record a mutation for `absPath`. Captures `original` on first sight and
 * refreshes `current` from disk. Returns the emitted event (or null if the
 * file is unreadable / unchanged).
 */
function recordMutation(
  conversationId: string,
  absPath: string,
  meta: { toolName: string; toolCallId?: string; source: DiffSource },
  preRead?: { exists: boolean; content: string },
): DiffEvent | null {
  const conv = getConversationStore(conversationId);
  let entry = conv.get(absPath);

  if (!entry) {
    const before = preRead ?? { exists: false, content: '' };
    entry = {
      original: before.content,
      current: before.content,
      created: !before.exists,
      deleted: false,
      ops: [],
      lastSource: meta.source,
    };
    conv.set(absPath, entry);
  }

  const after = safeRead(absPath);
  entry.deleted = !after.exists;
  entry.current = after.content;
  entry.lastSource = meta.source;

  const { unified, additions, deletions } = computeUnifiedDiff(entry.original, entry.current, { path: absPath });

  // Skip no-op writes (e.g. edit tool that made no change).
  if (additions === 0 && deletions === 0 && !entry.created && !entry.deleted) {
    return null;
  }

  entry.ops.push({
    at: new Date().toISOString(),
    toolName: meta.toolName,
    toolCallId: meta.toolCallId,
    source: meta.source,
    additions,
    deletions,
  });

  const event: DiffEvent = {
    conversationId,
    path: absPath,
    unifiedDiff: unified,
    additions,
    deletions,
    source: meta.source,
    toolName: meta.toolName,
    toolCallId: meta.toolCallId,
    created: entry.created,
    deleted: entry.deleted,
  };
  broadcast(event);
  return event;
}

// ───────────────────────────────────────────────────────────────────────────
// File-tool hook (write / edit)
// ───────────────────────────────────────────────────────────────────────────

export type FileWriteHookHandle = {
  finish: () => DiffEvent | null;
};

/**
 * Call immediately BEFORE a file-write/edit tool runs. Reads the pre-image if
 * the file isn't yet tracked so `original` is accurate. Returns a handle whose
 * `finish()` must be called AFTER the write completes.
 */
export function trackFileWrite(
  conversationId: string | undefined,
  absPath: string,
  meta: { toolName: string; toolCallId?: string },
  config: AppConfig,
): FileWriteHookHandle {
  const dt = resolveDiffTrackingConfig(config);
  if (!dt.enabled || !conversationId || !absPath) {
    return { finish: () => null };
  }

  const conv = getConversationStore(conversationId);
  const preRead = conv.has(absPath) ? undefined : safeRead(absPath);

  return {
    finish: () => recordMutation(conversationId, absPath, { ...meta, source: 'file-tool' }, preRead),
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Shell / CLI hook (mtime snapshot + AI fallback)
// ───────────────────────────────────────────────────────────────────────────

type SnapshotEntry = { mtimeMs: number; size: number; hash?: string };

export type ShellSnapshotHandle = {
  snapshotSkipped: boolean;
  finish: (result: { stdout?: string; stderr?: string }) => Promise<DiffEvent[]>;
};

const SKIP_DIRS = new Set(['.git', 'node_modules', '.venv', '__pycache__', '.next', 'dist', 'build', '.cache']);

const MUTATING_CMD_RE =
  /(^|[\s;|&])(sed\s+-i|perl\s+-i|tee\b|mv\b|cp\b|rm\b|rsync\b|install\b|touch\b|mkdir\b|truncate\b|ln\b|patch\b|dd\b)|>>?|\bnpx\b|\byarn\b|\bpnpm\b|\bnpm\b|\bpip\b|\bmake\b/;

function expandAllowRoot(entry: string): string | null {
  const t = entry.trim();
  if (!t || t === '*') return null;
  const scan = picomatch.scan(t);
  const base = scan.isGlob ? scan.base : t;
  if (!base) return null;
  if (base === '~') return homedir();
  if (base.startsWith('~/')) return resolve(homedir(), base.slice(2));
  return isAbsolute(base) ? resolve(base) : resolve(homedir(), base);
}

async function walk(
  root: string,
  budget: { filesLeft: number; deadline: number },
  out: Map<string, SnapshotEntry>,
): Promise<void> {
  if (budget.filesLeft <= 0 || Date.now() > budget.deadline) return;
  let entries: Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (budget.filesLeft <= 0 || Date.now() > budget.deadline) return;
    if (e.name.startsWith('.') && e.name !== '.env') {
      if (SKIP_DIRS.has(e.name)) continue;
    }
    if (SKIP_DIRS.has(e.name)) continue;
    const full = join(root, e.name);
    if (e.isDirectory()) {
      await walk(full, budget, out);
    } else if (e.isFile()) {
      try {
        const st = await stat(full);
        out.set(full, { mtimeMs: st.mtimeMs, size: st.size });
        budget.filesLeft--;
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * Call immediately BEFORE a shell/CLI command runs. Captures a lightweight
 * mtime snapshot of the file-access allowlist (bounded by config limits).
 */
export async function beginShellSnapshot(
  conversationId: string | undefined,
  meta: { toolName: string; toolCallId?: string; command: string; cwd?: string },
  config: AppConfig,
): Promise<ShellSnapshotHandle> {
  const dt = resolveDiffTrackingConfig(config);
  if (!dt.enabled || !conversationId) {
    return { snapshotSkipped: true, finish: async () => [] };
  }

  const roots = new Set<string>();
  if (meta.cwd) roots.add(resolve(meta.cwd));
  for (const entry of config.tools.fileAccess.allowPaths) {
    const r = expandAllowRoot(entry);
    if (r) roots.add(r);
  }

  const budget = { filesLeft: dt.snapshotFileLimit, deadline: Date.now() + dt.snapshotTimeoutMs };
  const pre = new Map<string, SnapshotEntry>();
  for (const r of roots) {
    await walk(r, budget, pre);
    if (budget.filesLeft <= 0 || Date.now() > budget.deadline) break;
  }
  const snapshotSkipped = budget.filesLeft <= 0 || Date.now() > budget.deadline;

  // For files under the cap, cache content hashes so post-exec we can detect
  // real content changes even when mtime is unreliable (e.g. some FUSE mounts).
  // We only hash when the pre-scan completed within budget; hashing every file
  // when we already blew the cap would compound the cost.
  if (!snapshotSkipped) {
    for (const [p, entry] of pre) {
      if (entry.size <= MAX_TRACKED_BYTES) {
        const r = safeRead(p);
        if (r.exists) entry.hash = hashContent(r.content);
      }
    }
  }

  const conv = getConversationStore(conversationId);

  const finish = async (result: { stdout?: string; stderr?: string }): Promise<DiffEvent[]> => {
    const events: DiffEvent[] = [];

    if (!snapshotSkipped) {
      const postBudget = { filesLeft: dt.snapshotFileLimit, deadline: Date.now() + dt.snapshotTimeoutMs };
      const post = new Map<string, SnapshotEntry>();
      for (const r of roots) {
        await walk(r, postBudget, post);
        if (postBudget.filesLeft <= 0 || Date.now() > postBudget.deadline) break;
      }

      for (const [p, after] of post) {
        const before = pre.get(p);
        if (!before) {
          // Created — original is empty.
          const ev = recordMutation(
            conversationId,
            p,
            { ...meta, source: 'shell-snapshot' },
            conv.has(p) ? undefined : { exists: false, content: '' },
          );
          if (ev) events.push(ev);
          continue;
        }
        const mtimeChanged = after.mtimeMs !== before.mtimeMs || after.size !== before.size;
        const hashChanged = before.hash != null && (() => {
          const r = safeRead(p);
          return r.exists && hashContent(r.content) !== before.hash;
        })();
        if (!mtimeChanged && !hashChanged) continue;
        // Modified — if not yet tracked we lost the true pre-image; fall back
        // to marking created=false with an empty original so the diff shows
        // the whole current file. (Pre-image capture for every scanned file
        // is too expensive; hash-mismatch is the best we can do here.)
        const preRead = conv.has(p) ? undefined : { exists: true, content: '' };
        const ev = recordMutation(conversationId, p, { ...meta, source: 'shell-snapshot' }, preRead);
        if (ev) events.push(ev);
      }
      for (const [p] of pre) {
        if (!post.has(p) && existsSync(p) === false) {
          const preRead = conv.has(p) ? undefined : { exists: true, content: '' };
          const ev = recordMutation(conversationId, p, { ...meta, source: 'shell-snapshot' }, preRead);
          if (ev) events.push(ev);
        }
      }
    }

    const looksMutating = MUTATING_CMD_RE.test(meta.command);
    if (dt.aiFallback && (snapshotSkipped || (events.length === 0 && looksMutating))) {
      const inferred = await inferChangedPaths(meta.command, result.stdout ?? '', result.stderr ?? '', meta.cwd, config);
      for (const p of inferred) {
        const abs = isAbsolute(p) ? p : resolve(meta.cwd ?? homedir(), p);
        const preRead = conv.has(abs) ? undefined : safeRead(abs);
        const ev = recordMutation(conversationId, abs, { ...meta, source: 'shell-ai' }, preRead);
        if (ev) events.push(ev);
      }
    }

    return events;
  };

  return { snapshotSkipped, finish };
}

// ───────────────────────────────────────────────────────────────────────────
// AI fallback
// ───────────────────────────────────────────────────────────────────────────

const AI_INFER_SYSTEM = [
  'You are a build-system analyst. Given a shell command and its stdout/stderr,',
  'return a JSON array of absolute file paths that the command most likely CREATED,',
  'MODIFIED, or DELETED on disk. Return [] if the command was read-only.',
  'Resolve relative paths against the provided cwd. Respond with ONLY the JSON array.',
].join(' ');

async function inferChangedPaths(
  command: string,
  stdout: string,
  stderr: string,
  cwd: string | undefined,
  config: AppConfig,
): Promise<string[]> {
  try {
    const { defaultEntry } = resolveModelCatalog(config);
    if (!defaultEntry) return [];
    const model = await createLanguageModelFromConfig(defaultEntry.modelConfig);
    const prompt = [
      `cwd: ${cwd ?? homedir()}`,
      `command: ${command}`,
      'stdout:',
      stdout.slice(0, 4000),
      'stderr:',
      stderr.slice(0, 2000),
    ].join('\n');
    const { text } = await generateText({ model, system: AI_INFER_SYSTEM, prompt });
    const start = text.indexOf('[');
    const end = text.lastIndexOf(']');
    if (start < 0 || end <= start) return [];
    const parsed = JSON.parse(text.slice(start, end + 1));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((p): p is string => typeof p === 'string' && p.length > 0).slice(0, 50);
  } catch (error) {
    console.warn('[DiffTracker] AI path inference failed:', error);
    return [];
  }
}

// ───────────────────────────────────────────────────────────────────────────
// IPC surface
// ───────────────────────────────────────────────────────────────────────────

export function listDiffsForConversation(conversationId: string): FileDiff[] {
  const conv = store.get(conversationId);
  if (!conv) return [];
  return Array.from(conv.entries()).map(([path, entry]) => toFileDiff(conversationId, path, entry));
}

export function getDiff(conversationId: string, path: string): FileDiff | null {
  const entry = store.get(conversationId)?.get(path);
  if (!entry) return null;
  return toFileDiff(conversationId, path, entry);
}

export function revertDiff(conversationId: string, path: string): { success: boolean; error?: string } {
  const conv = store.get(conversationId);
  const entry = conv?.get(path);
  if (!conv || !entry) return { success: false, error: 'No tracked diff for path' };
  try {
    writeFileSync(path, entry.original, 'utf-8');
    conv.delete(path);
    broadcast({
      conversationId,
      path,
      unifiedDiff: '',
      additions: 0,
      deletions: 0,
      source: entry.lastSource,
      toolName: 'revert',
      created: false,
      deleted: false,
    });
    return { success: true };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function clearConversationDiffs(conversationId: string): void {
  store.delete(conversationId);
}
