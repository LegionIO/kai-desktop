import { homedir } from 'os';
import { resolve } from 'path';

/**
 * Expand a leading `~` / `~/…` to the user's real home directory.
 *
 * Config values (e.g. `skills.directory`) may be stored as `~/.kai/skills`, but
 * `fs`/`path` treat `~` as a LITERAL directory name — so `readdirSync('~/.kai/…')`
 * looks for a folder literally named "~", finds nothing, and the feature
 * silently no-ops. This bit users whose home path contains characters like `@`
 * (e.g. `/Users/first_last@corp.com/`), where a literal `~` was never resolved.
 *
 * `homedir()` returns the real absolute home (special characters and all), so
 * `resolve(homedir(), rest)` produces a correct absolute path regardless of the
 * username. Non-tilde paths are returned resolved-as-given (absolute-ized).
 *
 * - `~`            → homedir()
 * - `~/x/y`        → <home>/x/y
 * - `/abs/path`    → /abs/path (unchanged)
 * - `rel/path`     → resolved against cwd (path.resolve default)
 * - `~user/...`    → NOT expanded (we don't resolve other users' homes); left as-is
 */
export function expandTilde(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    return resolve(homedir(), p.slice(2));
  }
  return p;
}
