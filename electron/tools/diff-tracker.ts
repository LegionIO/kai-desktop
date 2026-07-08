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
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { BrowserWindow } from 'electron';
import { broadcastToWebClients } from '../web-server/web-clients.js';
import { generateText } from 'ai';
import picomatch from 'picomatch';
import type { AppConfig } from '../config/schema.js';
import type { DiffEvent, DiffOp, DiffSource, FileDiff } from '../../shared/diff-types.js';
import { computeUnifiedDiff, type UnifiedHunk } from './lib/myers-diff.js';
import { createLanguageModelFromConfig } from '../agent/language-model.js';
import { resolveModelCatalog } from '../agent/model-catalog.js';
import { isPathAllowed, isPathDenied } from './file-access.js';

// ───────────────────────────────────────────────────────────────────────────
// Store
// ───────────────────────────────────────────────────────────────────────────

/** Main-process-internal op record. `contentAfter`/`existsAfter` never cross IPC. */
type InternalOp = {
  at: string;
  toolName: string;
  toolCallId?: string;
  source: DiffSource;
  additions: number;
  deletions: number;
  /** Full file content after this op — only when under the snapshot cap. */
  contentAfter?: string;
  /** Whether the file existed on disk after this op (distinguishes delete from empty file). */
  existsAfter: boolean;
};

type TrackedFile = {
  original: string;
  /** Whether `original` is the true on-disk pre-image (vs. a synthesized empty placeholder). */
  originalCaptured: boolean;
  current: string;
  created: boolean;
  deleted: boolean;
  ops: InternalOp[];
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
    aiFallback: raw?.aiFallback ?? false,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────────

const MAX_TRACKED_BYTES = 2 * 1024 * 1024;
const MAX_SNAPSHOT_PRECONTENT_BYTES = 32 * 1024 * 1024;
const OP_SNAPSHOT_MAX_BYTES = 256 * 1024;
const OP_SNAPSHOT_MAX_COUNT = 50;

function safeRead(absPath: string): { exists: boolean; content: string; captured: boolean } {
  try {
    const st = statSync(absPath);
    if (!st.isFile()) return { exists: false, content: '', captured: true };
    if (st.size > MAX_TRACKED_BYTES) return { exists: true, content: '', captured: false };
    const buf = readFileSync(absPath);
    // Binary heuristic: NUL byte in the first 8 KiB. Tracking/reverting via a
    // UTF-8 round-trip would corrupt these, so mark non-revertable.
    const probe = buf.subarray(0, Math.min(buf.length, 8192));
    if (probe.includes(0)) return { exists: true, content: '', captured: false };
    return { exists: true, content: buf.toString('utf-8'), captured: true };
  } catch {
    return { exists: false, content: '', captured: true };
  }
}

function hashContent(content: string): string {
  return createHash('sha1').update(content).digest('hex');
}

function broadcast(event: DiffEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('diffs:changed', event);
  }
  // Mirror to authenticated web clients so the web Changes panel gets live updates.
  broadcastToWebClients('diffs:changed', event);
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
    ops: entry.ops.map(
      (op): DiffOp => ({
        at: op.at,
        toolName: op.toolName,
        toolCallId: op.toolCallId,
        source: op.source,
        additions: op.additions,
        deletions: op.deletions,
        snapshotAvailable: op.contentAfter !== undefined,
      }),
    ),
    source: entry.lastSource,
    // Revert needs BOTH the original pre-image captured AND a current on-disk
    // state we can verify: if the file now holds binary/oversized content
    // (captured:false), revertDiff refuses (hasDrifted treats uncaptured as
    // drift), so advertising revertable:true would be misleading. A deleted
    // file has no current content to read and is safely restorable.
    revertable: entry.originalCaptured && (entry.deleted || safeRead(path).captured),
  };
}

/** True when the tracked file is back to its original state (nothing to show/revert). */
function isBackToOriginal(entry: TrackedFile): boolean {
  if (!entry.originalCaptured) return false;
  if (entry.created) return entry.deleted; // created then deleted → net zero
  return !entry.deleted && entry.current === entry.original;
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
  preRead?: { exists: boolean; content: string; captured?: boolean },
): DiffEvent | null {
  const conv = getConversationStore(conversationId);
  let entry = conv.get(absPath);

  if (!entry) {
    const before = preRead ?? { exists: false, content: '', captured: true };
    entry = {
      original: before.content,
      originalCaptured: before.captured ?? true,
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

  // If the file is back to its original state, drop the entry entirely so it
  // stops appearing as a pending change in list_file_changes / the Changes
  // panel — and broadcast a clear event so an open panel refreshes immediately.
  if (isBackToOriginal(entry)) {
    conv.delete(absPath);
    broadcast({
      conversationId,
      path: absPath,
      unifiedDiff: '',
      additions: 0,
      deletions: 0,
      source: meta.source,
      toolName: meta.toolName,
      created: false,
      deleted: false,
    });
    return null;
  }

  // Skip no-op writes (e.g. edit tool that made no change) that didn't reach original.
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
    existsAfter: after.exists,
    ...(after.captured &&
    after.exists &&
    after.content.length <= OP_SNAPSHOT_MAX_BYTES &&
    entry.ops.length < OP_SNAPSHOT_MAX_COUNT
      ? { contentAfter: after.content }
      : {}),
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
  const existing = conv.get(absPath);
  let preRead: { exists: boolean; content: string; captured?: boolean } | undefined;
  if (!existing) {
    preRead = safeRead(absPath);
  } else {
    // Already tracked: check whether the file changed on disk since we last
    // recorded it (an external/user edit between two agent edits). If so, the
    // stored `original` no longer represents a safe revert target — reverting
    // would erase the user's intervening edit — so mark it non-revertable.
    const onDisk = safeRead(absPath);
    if (!onDisk.captured || onDisk.content !== existing.current) {
      existing.originalCaptured = false;
    }
  }

  return {
    finish: () => recordMutation(conversationId, absPath, { ...meta, source: 'file-tool' }, preRead),
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Shell / CLI hook (mtime snapshot + AI fallback)
// ───────────────────────────────────────────────────────────────────────────

type SnapshotEntry = { mtimeMs: number; size: number; hash?: string; preContent?: string };

export type ShellSnapshotHandle = {
  /** True only when diff tracking actually ran for this command. */
  enabled: boolean;
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
  config: AppConfig,
): Promise<void> {
  if (budget.filesLeft <= 0 || Date.now() > budget.deadline) return;
  let entries: Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (err) {
    // An allowPaths entry can be an exact FILE path; readdir fails ENOTDIR.
    // Track it directly instead of silently dropping it.
    if ((err as NodeJS.ErrnoException)?.code === 'ENOTDIR') {
      try {
        const st = await stat(root);
        if (st.isFile() && isPathAllowed(root, config).allowed) {
          out.set(root, { mtimeMs: st.mtimeMs, size: st.size });
          budget.filesLeft--;
        }
      } catch {
        /* ignore */
      }
    }
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
      // Only prune a directory if it's explicitly DENIED. We must not prune on
      // a failed allow-match, because a file glob like `**/*.ts` won't match
      // intermediate directory paths — pruning here would skip allowed files
      // below. File-level filtering below enforces the allowlist per file.
      if (isPathDenied(full, config)) continue;
      await walk(full, budget, out, config);
    } else if (e.isFile()) {
      if (!isPathAllowed(full, config).allowed) continue;
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
  // Skip entirely when tracking is off, there's no conversation, or file access
  // is disabled (every path would be rejected, so the walk just burns the
  // timeout producing nothing).
  if (!dt.enabled || !conversationId || !config.tools.fileAccess.enabled) {
    return { enabled: false, snapshotSkipped: false, finish: async () => [] };
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
    await walk(r, budget, pre, config);
    if (budget.filesLeft <= 0 || Date.now() > budget.deadline) break;
  }
  const snapshotSkipped = budget.filesLeft <= 0 || Date.now() > budget.deadline;

  // Cache content + hash for whatever subset we DID capture — even a partial
  // pre-scan is worth comparing post-exec. Bounded by the same wall-clock
  // deadline plus an aggregate byte cap so a large tree can't stall the main
  // process reading gigabytes; entries past the cap fall back to mtime-only
  // detection with `captured:false` (revert disabled).
  const readDeadline = Date.now() + dt.snapshotTimeoutMs;
  let bytesRead = 0;
  for (const [p, entry] of pre) {
    if (Date.now() > readDeadline || bytesRead > MAX_SNAPSHOT_PRECONTENT_BYTES) break;
    if (entry.size <= MAX_TRACKED_BYTES) {
      const r = safeRead(p);
      if (r.exists && r.captured) {
        entry.hash = hashContent(r.content);
        entry.preContent = r.content;
        bytesRead += r.content.length;
      }
    }
  }

  const conv = getConversationStore(conversationId);

  const finish = async (result: { stdout?: string; stderr?: string }): Promise<DiffEvent[]> => {
    const events: DiffEvent[] = [];

    {
      const postBudget = { filesLeft: dt.snapshotFileLimit, deadline: Date.now() + dt.snapshotTimeoutMs };
      const post = new Map<string, SnapshotEntry>();
      for (const r of roots) {
        await walk(r, postBudget, post, config);
        if (postBudget.filesLeft <= 0 || Date.now() > postBudget.deadline) break;
      }

      for (const [p, after] of post) {
        const before = pre.get(p);
        if (!before) {
          // With a partial pre-scan we can't distinguish "created" from
          // "outside the captured window", so only report creations when the
          // pre-scan completed.
          if (snapshotSkipped) continue;
          const ev = recordMutation(
            conversationId,
            p,
            { ...meta, source: 'shell-snapshot' },
            conv.has(p) ? undefined : { exists: false, content: '', captured: true },
          );
          if (ev) events.push(ev);
          continue;
        }
        const mtimeChanged = after.mtimeMs !== before.mtimeMs || after.size !== before.size;
        const hashChanged =
          before.hash != null &&
          (() => {
            const r = safeRead(p);
            return r.exists && hashContent(r.content) !== before.hash;
          })();
        if (!mtimeChanged && !hashChanged) continue;
        // External-edit drift: if a tracked file's pre-command content differs
        // from what we last recorded, a user/external process edited it between
        // agent ops — mark it non-revertable so revert can't erase that edit.
        const trackedEntry = conv.get(p);
        if (trackedEntry && before.preContent != null && before.preContent !== trackedEntry.current) {
          trackedEntry.originalCaptured = false;
        }
        const preRead = conv.has(p)
          ? undefined
          : before.preContent != null
            ? { exists: true, content: before.preContent, captured: true }
            : { exists: true, content: '', captured: false };
        const ev = recordMutation(conversationId, p, { ...meta, source: 'shell-snapshot' }, preRead);
        if (ev) events.push(ev);
      }
      for (const [p, before] of pre) {
        if (!post.has(p) && existsSync(p) === false) {
          const trackedEntry = conv.get(p);
          if (trackedEntry && before.preContent != null && before.preContent !== trackedEntry.current) {
            trackedEntry.originalCaptured = false;
          }
          const preRead = conv.has(p)
            ? undefined
            : before.preContent != null
              ? { exists: true, content: before.preContent, captured: true }
              : { exists: true, content: '', captured: false };
          const ev = recordMutation(conversationId, p, { ...meta, source: 'shell-snapshot' }, preRead);
          if (ev) events.push(ev);
        }
      }
    }

    const looksMutating = MUTATING_CMD_RE.test(meta.command);
    if (dt.aiFallback && looksMutating && events.length === 0) {
      const inferred = await inferChangedPaths(
        meta.command,
        result.stdout ?? '',
        result.stderr ?? '',
        meta.cwd,
        config,
      );
      for (const p of inferred) {
        const abs = isAbsolute(p) ? p : resolve(meta.cwd ?? homedir(), p);
        if (!isPathAllowed(abs, config).allowed) continue;
        // No pre-image is available on the AI-inferred path; treat as
        // unknown-original so the diff shows current content and Revert is
        // disabled rather than truncating the file.
        const preRead = conv.has(abs) ? undefined : { exists: false, content: '', captured: false };
        const ev = recordMutation(conversationId, abs, { ...meta, source: 'shell-ai' }, preRead);
        if (ev) events.push(ev);
      }
    }

    return events;
  };

  return { enabled: true, snapshotSkipped, finish };
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

export function revertDiff(
  conversationId: string,
  path: string,
  opts?: { force?: boolean },
): { success: boolean; error?: string } {
  const conv = store.get(conversationId);
  const entry = conv?.get(path);
  if (!conv || !entry) return { success: false, error: 'No tracked diff for path' };
  if (!entry.originalCaptured) {
    return { success: false, error: 'Original content was not captured for this file; revert would truncate it.' };
  }
  if (!opts?.force && hasDrifted(path, entry)) {
    return {
      success: false,
      error: 'File changed on disk since it was last tracked (external/user edit); revert refused to avoid data loss.',
    };
  }
  try {
    restoreFile(path, entry.original, entry.created);
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

/** Restore every tracked file in a conversation to its captured original. */
export function revertAllDiffs(conversationId: string): { success: boolean; reverted: number; skipped: string[] } {
  const conv = store.get(conversationId);
  if (!conv) return { success: true, reverted: 0, skipped: [] };
  let reverted = 0;
  const skipped: string[] = [];
  for (const path of Array.from(conv.keys())) {
    const r = revertDiff(conversationId, path);
    if (r.success) reverted++;
    else skipped.push(path);
  }
  return { success: skipped.length === 0, reverted, skipped };
}

/**
 * Reverse a single hunk against the file's CURRENT on-disk content. The hunk
 * index refers to `listDiffsForConversation`/`getDiff` hunk ordering. Fails
 * (rather than corrupts) if the file has drifted so the hunk no longer applies.
 */
export function revertHunk(
  conversationId: string,
  path: string,
  hunkIndex: number,
): { success: boolean; error?: string } {
  const conv = store.get(conversationId);
  const entry = conv?.get(path);
  if (!conv || !entry) return { success: false, error: 'No tracked diff for path' };
  if (!entry.originalCaptured) {
    return { success: false, error: 'Original content was not captured; cannot compute hunks safely.' };
  }
  if (hasDrifted(path, entry)) {
    return {
      success: false,
      error: 'File changed on disk since it was last tracked (external/user edit); hunk revert refused.',
    };
  }
  const { hunks } = computeUnifiedDiff(entry.original, entry.current, { path });
  const hunk = hunks[hunkIndex];
  if (!hunk) return { success: false, error: `Hunk ${hunkIndex} out of range (0..${hunks.length - 1}).` };

  const current = safeRead(path);
  if (!current.captured) return { success: false, error: 'Current file is binary/oversized; cannot patch a hunk.' };

  const applied = reverseApplyHunk(current.content, hunk);
  if (applied === null) {
    return { success: false, error: 'Hunk no longer matches current file content (file has drifted).' };
  }
  try {
    // If this hunk revert lands the file back on its original pre-image AND the
    // file was newly created by the tracked edits, the correct restoration is to
    // DELETE it (its pre-edit state was "absent"), not to leave an empty file.
    // Mirror restoreFile so this matches revertAll's created-file handling.
    const fullyRestored = entry.created && applied === entry.original;
    restoreFile(path, applied, fullyRestored);
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
  const ev = recordMutation(conversationId, path, { toolName: 'revert-hunk', source: entry.lastSource }, undefined);
  if (!ev) {
    // Fully reverted back to original — recordMutation returns null on no-op.
    broadcast({
      conversationId,
      path,
      unifiedDiff: '',
      additions: 0,
      deletions: 0,
      source: entry.lastSource,
      toolName: 'revert-hunk',
      created: false,
      deleted: false,
    });
  }
  return { success: true };
}

/**
 * Roll a file back to the state it was in immediately AFTER op `opIndex`
 * (i.e. undo every op after it). Requires per-op snapshots, which are only
 * kept for small files. `opIndex = -1` reverts to the original pre-image.
 */
export function revertToOp(
  conversationId: string,
  path: string,
  opIndex: number,
  opts?: { force?: boolean },
): { success: boolean; error?: string } {
  const conv = store.get(conversationId);
  const entry = conv?.get(path);
  if (!conv || !entry) return { success: false, error: 'No tracked diff for path' };
  if (!opts?.force && hasDrifted(path, entry)) {
    return {
      success: false,
      error: 'File changed on disk since it was last tracked (external/user edit); revert refused to avoid data loss.',
    };
  }

  let targetContent: string;
  let targetExists: boolean;
  if (opIndex < 0) {
    if (!entry.originalCaptured) return { success: false, error: 'Original content was not captured.' };
    targetContent = entry.original;
    // The pre-edit state existed on disk unless the first op created the file.
    targetExists = !entry.created;
  } else {
    const op = entry.ops[opIndex];
    if (!op) return { success: false, error: `Op ${opIndex} out of range (0..${entry.ops.length - 1}).` };
    if (op.existsAfter && op.contentAfter === undefined) {
      return { success: false, error: `No content snapshot for op ${opIndex} (file too large or too many ops).` };
    }
    targetExists = op.existsAfter;
    targetContent = op.contentAfter ?? '';
  }

  try {
    restoreFile(path, targetContent, !targetExists);
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
  if (opIndex < 0) {
    conv.delete(path);
    broadcast({
      conversationId,
      path,
      unifiedDiff: '',
      additions: 0,
      deletions: 0,
      source: entry.lastSource,
      toolName: 'revert-to-op',
      created: false,
      deleted: false,
    });
  } else {
    entry.ops = entry.ops.slice(0, opIndex + 1);
    recordMutation(conversationId, path, { toolName: 'revert-to-op', source: entry.lastSource }, undefined);
  }
  return { success: true };
}

/** Plain unified-diff text for the agent-facing tool. */
export function getDiffText(conversationId: string, path: string): string | null {
  const entry = store.get(conversationId)?.get(path);
  if (!entry) return null;
  return computeUnifiedDiff(entry.original, entry.current, { path }).unified;
}

function restoreFile(path: string, content: string, shouldDelete: boolean): void {
  if (shouldDelete) {
    if (existsSync(path)) unlinkSync(path);
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf-8');
}

/**
 * True when the on-disk file no longer matches the tracked `current` state,
 * i.e. it was edited outside the tracker (user or another process) since we
 * last recorded it. Reverting over drift would silently destroy that work.
 * Uncaptured (binary/oversized) current state can't be compared → treat as
 * drifted (safe default).
 */
function hasDrifted(path: string, entry: TrackedFile): boolean {
  const disk = safeRead(path);
  if (entry.deleted) return disk.exists; // we think it's gone but it's back
  if (!disk.exists) return true; // we think it's present but it's gone
  if (!disk.captured) return true; // can't verify → refuse
  return disk.content !== entry.current;
}

/**
 * Reverse-apply a unified hunk against `content`: replace the hunk's post-image
 * (add+context) block with its pre-image (del+context). Returns null if the
 * post-image block is missing OR matches in more than one place (ambiguous
 * after drift) — the caller then refuses rather than patching the wrong block.
 */
function reverseApplyHunk(content: string, hunk: UnifiedHunk): string | null {
  const lines = content.length === 0 ? [] : content.split('\n');
  const hadTrailingNewline = content.endsWith('\n');
  if (hadTrailingNewline) lines.pop();

  const postImage: string[] = [];
  const preImage: string[] = [];
  for (const l of hunk.lines) {
    if (l.type === 'context') {
      postImage.push(l.text);
      preImage.push(l.text);
    } else if (l.type === 'add') {
      postImage.push(l.text);
    } else {
      preImage.push(l.text);
    }
  }
  // Deletion-only hunk (no post-image lines): the reverse is a pure insertion
  // of the pre-image at the hunk's recorded position. There's no block to
  // locate for a drift check here, so this relies on the caller's whole-file
  // hasDrifted() guard (revertHunk recomputes hunks from tracked `current`).
  if (postImage.length === 0) {
    const insertAt = Math.max(0, Math.min(lines.length, hunk.bStart - 1));
    const next = [...lines.slice(0, insertAt), ...preImage, ...lines.slice(insertAt)];
    // Preserve the current file's trailing-newline state; don't force a newline
    // just because the current content is empty (would corrupt a file whose
    // original had no final newline).
    return next.length === 0 ? '' : next.join('\n') + (hadTrailingNewline ? '\n' : '');
  }

  const matchesAt = (start: number): boolean => postImage.every((t, i) => lines[start + i] === t);

  // Prefer the recorded offset; only fall back to scanning if it doesn't match,
  // and require a UNIQUE match so we never patch a wrong identical-looking block.
  const guess = Math.max(0, hunk.bStart - 1);
  let at = -1;
  if (matchesAt(guess)) {
    at = guess;
  } else {
    let matchCount = 0;
    for (let i = 0; i + postImage.length <= lines.length; i++) {
      if (matchesAt(i)) {
        matchCount++;
        if (matchCount > 1) return null; // ambiguous → refuse
        at = i;
      }
    }
    if (matchCount !== 1) return null;
  }

  const next = [...lines.slice(0, at), ...preImage, ...lines.slice(at + postImage.length)];
  return next.length === 0 ? '' : next.join('\n') + (hadTrailingNewline ? '\n' : '');
}

export function clearConversationDiffs(conversationId: string): void {
  store.delete(conversationId);
}

export function clearAllDiffs(): void {
  store.clear();
}
