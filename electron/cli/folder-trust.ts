import { realpathSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { homedir, userInfo } from 'os';
import { dirname, join, isAbsolute } from 'path';
import { getAppHome } from '../local-bridge/paths.js';
import { atomicWriteFileSync } from '../utils/atomic-write.js';

/**
 * CLI folder-trust store.
 *
 * When `kai` launches interactively in a directory, the agent can run tools
 * (shell, file edits) scoped to that directory — so a user shouldn't be dropped
 * into a fully-capable session in an UNFAMILIAR folder without an explicit "do
 * you trust this folder?" acknowledgement (à la VS Code workspace trust).
 *
 * This module is the pure, storage-backed core of that: it records the set of
 * folders the user has trusted and answers "is this folder trusted?". The prompt
 * UI + enforcement policy (block vs. restricted mode) live in the CLI entry.
 *
 * Paths are canonicalized with realpath before compare/store so a symlink can't
 * masquerade as a trusted target and a trailing-slash / `.` variant can't slip
 * past. The user's HOME is implicitly trusted (it's the default landing dir; a
 * fresh `kai` with no args shouldn't nag).
 */

const STORE_FILE = 'trusted-folders.json';

interface TrustStore {
  version: 1;
  /** realpath-resolved absolute directory paths the user has trusted. */
  folders: string[];
}

function storePath(): string {
  return join(getAppHome(), STORE_FILE);
}

/**
 * Canonicalize a directory path for trust comparison: resolve symlinks + `..`
 * and strip a trailing separator. Returns null if the path can't be resolved
 * (doesn't exist) — an unresolvable path is never considered trusted.
 */
export function canonicalizeDir(dir: string): string | null {
  try {
    // realpathSync resolves symlinks AND normalizes; a nonexistent dir throws.
    const resolved = realpathSync(dir);
    // Strip a trailing separator (realpath doesn't add one, but be defensive
    // about a root like "/"): keep "/" itself intact, trim otherwise.
    return resolved.length > 1 ? resolved.replace(/[/\\]+$/, '') : resolved;
  } catch {
    return null;
  }
}

/** The user's home directory, canonicalized — implicitly trusted.
 *  Uses userInfo().homedir (the OS passwd entry), NOT homedir(), because
 *  homedir() honors $HOME on POSIX — so `HOME=<untrusted dir> kai` would
 *  otherwise make that dir implicitly trusted and skip the trust prompt.
 *  Falls back to homedir() only if userInfo() throws (rare/edge platforms). */
function canonicalHome(): string | null {
  let home: string;
  try {
    home = userInfo().homedir || homedir();
  } catch {
    home = homedir();
  }
  return home ? canonicalizeDir(home) : null;
}

function loadStore(): TrustStore {
  const path = storePath();
  if (!existsSync(path)) return { version: 1, folders: [] };
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
    if (
      raw &&
      typeof raw === 'object' &&
      (raw as TrustStore).version === 1 &&
      Array.isArray((raw as TrustStore).folders)
    ) {
      // Keep only absolute-path strings, dedupe, and cap the count — a tampered
      // or malformed store must not inject a bogus/relative trusted entry or
      // grow unbounded. (The store lives in ~/.kai, so this is defense-in-depth.)
      const seen = new Set<string>();
      const folders: string[] = [];
      for (const f of (raw as TrustStore).folders) {
        if (typeof f !== 'string' || !isAbsolute(f) || seen.has(f)) continue;
        seen.add(f);
        folders.push(f);
        if (folders.length >= 1000) break;
      }
      return { version: 1, folders };
    }
  } catch {
    // Corrupt/unreadable store → treat as empty (fail closed: nothing trusted).
  }
  return { version: 1, folders: [] };
}

/**
 * Is `dir` trusted? True when it canonicalizes to HOME (implicit) or to a path
 * in the store. A dir that can't be resolved (deleted) is NOT trusted.
 */
export function isFolderTrusted(dir: string): boolean {
  const canon = canonicalizeDir(dir);
  if (!canon) return false;
  if (canon === canonicalHome()) return true;
  return loadStore().folders.includes(canon);
}

/**
 * Record `dir` as trusted (idempotent). Returns the canonical path stored, or
 * null if the path couldn't be resolved (nothing recorded). HOME is implicitly
 * trusted and never written to the store.
 */
export function trustFolder(dir: string): string | null {
  const canon = canonicalizeDir(dir);
  if (!canon) return null;
  if (canon === canonicalHome()) return canon; // implicit — don't persist
  const store = loadStore();
  if (!store.folders.includes(canon)) {
    store.folders.push(canon);
    const path = storePath();
    mkdirSync(dirname(path), { recursive: true });
    atomicWriteFileSync(path, JSON.stringify(store, null, 2));
  }
  return canon;
}

/**
 * Pure gate state for a startup directory: 'trusted' when it needs no prompt
 * (already trusted or HOME), else 'prompt'. Kept separate from the readline UI
 * so it's testable.
 */
export function trustGateState(dir: string): 'trusted' | 'prompt' {
  return isFolderTrusted(dir) ? 'trusted' : 'prompt';
}

/**
 * Interactive folder-trust gate for the CLI REPL. If `dir` is already trusted
 * (or is HOME), returns true immediately. Otherwise prompts on the TTY:
 *   [t] trust this folder   [Enter/n] don't (exit)
 * On "trust" the folder is persisted and true is returned; otherwise false
 * (the caller blocks — the conservative v1: the agent can run tools scoped to
 * the cwd, so we don't start a capable session in an unfamiliar folder).
 *
 * `readLine` is injectable for tests; it defaults to a one-shot readline
 * question on stdin/stdout.
 */
export async function confirmFolderTrust(
  dir: string,
  readLine: (question: string) => Promise<string> = defaultReadLine,
): Promise<boolean> {
  if (trustGateState(dir) === 'trusted') return true;
  const canon = canonicalizeDir(dir) ?? dir;
  const answer = (
    await readLine(
      `\nKai can run commands and edit files in this folder:\n  ${canon}\n` +
        `Do you trust the authors of the files here? [t = trust, Enter = no] `,
    )
  )
    .trim()
    .toLowerCase();
  if (answer === 't' || answer === 'trust' || answer === 'y' || answer === 'yes') {
    trustFolder(dir);
    return true;
  }
  return false;
}

function defaultReadLine(question: string): Promise<string> {
  return new Promise((resolve) => {
    // Lazy import so the pure helpers don't pull readline in test/other contexts.
    void import('readline').then(({ createInterface }) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      rl.question(question, (ans) => {
        rl.close();
        resolve(ans);
      });
    });
  });
}

/** Exposed for unit tests only. */
export const __internal = { storePath, loadStore, canonicalHome };
