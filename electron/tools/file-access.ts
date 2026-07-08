import { realpathSync } from 'node:fs';
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
