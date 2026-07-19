import { realpathSync, existsSync, statSync, readdirSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import picomatch from 'picomatch';
import type { AppConfig } from '../config/schema.js';

/**
 * Best-effort canonical path. Walks up to the nearest existing ancestor,
 * resolves symlinks there, and reattaches the not-yet-created tail. This
 * catches writes like `~/link/new/dir/file` where `~/link → /etc`.
 */
function resolveRealpath(p: string): string {
  let head = p;
  const tail: string[] = [];
  for (;;) {
    try {
      const real = realpathSync.native(head);
      return tail.length > 0 ? join(real, ...tail.reverse()) : real;
    } catch {
      const parent = dirname(head);
      if (parent === head) return p;
      tail.push(basename(head));
      head = parent;
    }
  }
}

function expandConfigPath(entry: string): string {
  const t = entry.trim();
  if (t === '~') return homedir();
  if (t.startsWith('~/')) return resolve(homedir(), t.slice(2));
  return isAbsolute(t) ? resolve(t) : resolve(homedir(), t);
}

function isWithin(target: string, root: string): boolean {
  const r = resolve(root);
  const t = resolve(target);
  return t === r || t.startsWith(r.endsWith(sep) ? r : r + sep);
}

function matchesEntry(absTarget: string, entry: string): boolean {
  if (entry === '*') return true;
  const scan = picomatch.scan(entry);
  if (scan.isGlob) {
    const base = scan.base ? expandConfigPath(scan.base) : homedir();
    const realBase = resolveRealpath(base);
    const glob = scan.glob || '**';
    const suffix = scan.base ? `/${glob}` : `/**/${glob}`;
    const withSuffix = (b: string): string => (b === '/' ? suffix : b + suffix);
    const patterns = realBase === base ? [withSuffix(base)] : [withSuffix(base), withSuffix(realBase)];
    return picomatch(patterns, { dot: true })(absTarget);
  }
  const root = expandConfigPath(entry);
  const realRoot = resolveRealpath(root);
  return isWithin(absTarget, root) || (realRoot !== root && isWithin(absTarget, realRoot));
}

/** True when the path matches a deny rule (used to prune walks without an allow-match). */
export function isPathDenied(absTarget: string, config: AppConfig): boolean {
  const fa = config.tools.fileAccess;
  const real = resolveRealpath(absTarget);
  const targets = real === absTarget ? [absTarget] : [absTarget, real];
  for (const t of targets) {
    for (const entry of fa.denyPaths) {
      if (entry && matchesEntry(t, entry)) return true;
    }
  }
  return false;
}

export function isPathAllowed(absTarget: string, config: AppConfig): { allowed: boolean; reason?: string } {
  const fa = config.tools.fileAccess;
  if (!fa.enabled) return { allowed: false, reason: 'File access is disabled' };

  // Evaluate both the lexical path and its realpath so a symlink inside an
  // allowed root can't reach outside it, and a deny on a symlinked directory
  // still applies to its lexical name.
  const real = resolveRealpath(absTarget);
  const targets = real === absTarget ? [absTarget] : [absTarget, real];

  for (const t of targets) {
    for (const entry of fa.denyPaths) {
      if (entry && matchesEntry(t, entry)) {
        return { allowed: false, reason: `Path is denied by rule: ${entry}` };
      }
    }
  }

  if (fa.allowPaths.length > 0 && !fa.allowPaths.includes('*')) {
    for (const t of targets) {
      const ok = fa.allowPaths.some((e) => e && matchesEntry(t, e));
      if (!ok) {
        return {
          allowed: false,
          reason: `Path is outside allowed roots: ${fa.allowPaths.join(', ')}`,
        };
      }
    }
  }

  return { allowed: true };
}

/**
 * Drop lines from Mastra's `mastra_workspace_grep` string output whose file
 * path fails {@link isPathAllowed}. Match/context lines are formatted as
 * `path:line:col: text` or `path:line- text`; `--` separates context groups.
 * The summary header is recomputed from the surviving lines so the output
 * reveals nothing about whether denied files matched.
 *
 * Known limitation: Mastra's grep applies its global match/token caps before
 * this filter runs and exposes no exclude hook, so a large denied subtree can
 * crowd out allowed results. Fixing that requires upstream changes; the
 * settings UI copy scopes the guarantee accordingly.
 */
export function filterGrepOutput(output: string, config: AppConfig): string {
  const fa = config.tools.fileAccess;
  if (fa.denyPaths.length === 0 && (fa.allowPaths.length === 0 || fa.allowPaths.includes('*'))) {
    return output;
  }

  const GREP_LINE = /^(.+?):(\d+)([:-])/;
  const lines = output.split('\n');
  const hasHeader = lines.length >= 2 && lines[1] === '---';
  // Error strings ("Error: Invalid regex...") have no summary/--- header.
  if (!hasHeader) return output;
  const originalSummary = lines[0];
  const body = lines.slice(2);

  const files = new Set<string>();
  let matches = 0;
  let dropped = 0;
  let groupHasKept = false;
  const kept: string[] = [];
  for (const line of body) {
    if (line === '--') {
      if (groupHasKept) kept.push(line);
      groupHasKept = false;
      continue;
    }
    const m = GREP_LINE.exec(line);
    if (!m) {
      if (/^\[.*output truncated/i.test(line)) continue;
      kept.push(line);
      continue;
    }
    if (!isPathAllowed(m[1], config).allowed) {
      dropped += 1;
      continue;
    }
    if (m[3] === ':') {
      matches += 1;
      files.add(m[1]);
    }
    groupHasKept = true;
    kept.push(line);
  }

  // Truncation markers derived from the pre-filter output are only safe to
  // surface when nothing was filtered — otherwise they leak that denied
  // files contributed matches.
  const truncSummary = dropped === 0 ? /\(truncated[^)]*\)/.exec(originalSummary)?.[0] : undefined;
  const truncTrailer = dropped === 0 ? body.find((l) => /^\[.*output truncated/i.test(l)) : undefined;
  const summary =
    `${matches} match${matches === 1 ? '' : 'es'} across ${files.size} file${files.size === 1 ? '' : 's'}` +
    (truncSummary ? ` ${truncSummary}` : '');
  return [summary, '---', ...kept, ...(truncTrailer ? [truncTrailer] : [])].join('\n');
}

/** Result of previewing a File Access path entry in Settings. */
export type PathEntryPreview = {
  /** The entry after ~/relative/symlink expansion (what the matcher sees). */
  normalized: string;
  exists: boolean;
  isDirectory: boolean;
  /** Files on disk under `normalized` that this entry matches (capped). */
  matchCount: number;
  /** True if the walk hit the cap (so matchCount is a floor, shown as "N+"). */
  capped: boolean;
  /** Whether a representative path under the entry would pass the allow rules. */
  allowed: boolean;
  /** Whether the entry (or its target) is knocked out by a deny rule. */
  denied: boolean;
};

/** Bound the preview walk so opening Tool Settings can never freeze the main
 *  thread: stop after this many filesystem entries visited OR this many ms. */
const PREVIEW_WALK_CAP = 20000;
const PREVIEW_WALK_MS = 400;

/**
 * Preview a single File Access allow/deny entry for the Settings UI: expand it,
 * check existence, count how many on-disk files it matches (bounded walk), and
 * report the allow/deny outcome. Read-only + best-effort — never throws.
 */
export function previewPathEntry(entry: string, config: AppConfig): PathEntryPreview {
  const trimmed = (entry ?? '').trim();
  const base: PathEntryPreview = {
    normalized: '',
    exists: false,
    isDirectory: false,
    matchCount: 0,
    capped: false,
    allowed: false,
    denied: false,
  };
  if (!trimmed) return base;

  // Wildcard / everything.
  if (trimmed === '*') {
    return { ...base, normalized: '*', allowed: true };
  }

  // Determine the on-disk root to walk: for a glob, the base dir; else the path.
  let root: string;
  try {
    const scan = picomatch.scan(trimmed);
    root = scan.isGlob ? (scan.base ? expandConfigPath(scan.base) : homedir()) : expandConfigPath(trimmed);
  } catch {
    root = expandConfigPath(trimmed);
  }
  const normalized = root;

  let exists = false;
  let isDirectory = false;
  try {
    if (existsSync(root)) {
      exists = true;
      isDirectory = statSync(root).isDirectory();
    }
  } catch {
    /* best-effort */
  }

  // Count matching files under root, BOUNDED by entries VISITED + a wall-clock
  // budget (not match count — a sparse glob like **/.env or a deny entry whose
  // matches are excluded would otherwise walk the whole home tree synchronously
  // on the main thread and freeze the app when Settings opens). Also capture a
  // representative MATCHED path so the allow/deny status reflects an actual match
  // (evaluating only the glob's base dir gives the wrong result for /dir/*).
  let matchCount = 0;
  let capped = false;
  let visited = 0;
  const startedAt = Date.now();
  let sampleMatch: string | null = null;
  const budgetHit = (): boolean => visited >= PREVIEW_WALK_CAP || Date.now() - startedAt > PREVIEW_WALK_MS;
  const consider = (abs: string): void => {
    visited += 1;
    try {
      if (matchesEntry(abs, trimmed)) {
        if (!isPathDenied(abs, config)) matchCount += 1;
        if (sampleMatch === null) sampleMatch = abs;
      }
    } catch {
      /* skip unreadable */
    }
  };
  const walk = (dir: string, depth: number): void => {
    if (budgetHit() || depth > 40) {
      if (budgetHit()) capped = true;
      return;
    }
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true }) as unknown as Dirent[];
    } catch {
      return;
    }
    for (const e of entries) {
      if (budgetHit()) {
        capped = true;
        return;
      }
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (!e.name.startsWith('.')) walk(full, depth + 1);
      } else {
        consider(full);
      }
    }
  };
  try {
    if (exists && isDirectory) walk(root, 0);
    else if (exists) consider(root);
  } catch {
    /* best-effort */
  }

  // Allow/deny outcome: prefer a real matched file (correct for globs like
  // /dir/* or **/.env); fall back to the root when nothing matched.
  const repr = sampleMatch ?? root;
  let allowed = false;
  let denied = false;
  try {
    denied = isPathDenied(repr, config);
    allowed = isPathAllowed(repr, config).allowed;
  } catch {
    /* best-effort */
  }

  return { normalized, exists, isDirectory, matchCount, capped, allowed, denied };
}
