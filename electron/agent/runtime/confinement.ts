/**
 * Blast-radius containment for spawned autonomous-agent children (issue #67,
 * part of the #66 epic).
 *
 * All three autonomous runtimes (pi via child_process, Claude/Codex via their
 * SDKs) otherwise inherit the FULL parent `process.env` — exposing AWS_*,
 * GH_TOKEN, npm tokens, and every unused provider key to an unsupervised
 * bash-running agent. `buildAgentChildEnv` produces a fail-closed ALLOWLIST
 * env instead: only process essentials + non-secret tooling identity + the one
 * provider key the selected model needs (+ an explicit user passthrough) reach
 * the child. An allowlist (not a denylist) fails closed against unknown secrets
 * sitting in a developer's login shell.
 *
 * Pure + cross-platform. Never mutates `process.env`.
 */

import { getResolvedProcessEnv } from '../../utils/shell-env.js';
import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, parse as parsePath, resolve as resolvePath, sep } from 'node:path';

/**
 * Non-secret environment variables the child legitimately needs to run:
 * process essentials, locale, terminal, and non-secret git/tooling identity.
 * Windows equivalents included so the allowlist works cross-platform.
 */
const BASE_ALLOWLIST: readonly string[] = [
  // POSIX process essentials
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'TEMP',
  'TMP',
  // locale / terminal
  'LANG',
  'LANGUAGE',
  'TERM',
  'TZ',
  'COLORTERM',
  // Windows equivalents
  'Path',
  'SystemRoot',
  'windir',
  'ComSpec',
  'PATHEXT',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'ProgramData',
  'ProgramFiles',
  'ProgramFiles(x86)',
  'CommonProgramFiles',
  'HOMEDRIVE',
  'HOMEPATH',
  'USERNAME',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
  // non-secret git / tooling identity (names, not credentials)
  'GIT_AUTHOR_NAME',
  'GIT_AUTHOR_EMAIL',
  'GIT_COMMITTER_NAME',
  'GIT_COMMITTER_EMAIL',
  'GIT_SSH',
  'GIT_SSH_COMMAND',
  // git-over-SSH with no token: the agent uses the parent's ssh-agent socket,
  // not an exported credential.
  'SSH_AUTH_SOCK',
];

/** LC_* locale vars (variable suffix) are allowlisted by prefix. */
function isLocaleVar(key: string): boolean {
  return key.startsWith('LC_');
}

export type BuildAgentChildEnvOptions = {
  /** Parent environment to derive from. Defaults to the resolved process env
   *  (PATH normalized via the login-shell resolution). Never mutated. */
  parentEnv?: NodeJS.ProcessEnv;
  /** Provider of the selected model (e.g. 'anthropic', 'openai', 'amazon-bedrock'). */
  modelProvider?: string;
  /** The single provider credential the selected model needs, injected LAST so
   *  it always wins. e.g. `{ ANTHROPIC_API_KEY: '...' }`. */
  modelEnv?: Record<string, string | undefined>;
  /** True when the Bedrock model config carries explicit access keys (so the
   *  ambient AWS_* chain is NOT needed and should stay stripped). */
  hasExplicitAwsKeys?: boolean;
  /** User-named env vars to re-add to the allowlist (the passthrough opt-in). */
  passthrough?: readonly string[];
};

/**
 * Build a fail-closed allowlist environment for a spawned agent child.
 *
 * Only allowlisted vars from the parent env survive, plus:
 *  - the conditional AWS chain (only when the model is Bedrock AND there are no
 *    explicit AWS keys — Bedrock relies on the ambient chain; stripping it
 *    unconditionally would break Bedrock);
 *  - any user `passthrough` names present in the parent;
 *  - `modelEnv` (the selected provider key), injected last so it always wins.
 */
export function buildAgentChildEnv(options: BuildAgentChildEnvOptions = {}): NodeJS.ProcessEnv {
  const { modelProvider, modelEnv, hasExplicitAwsKeys, passthrough } = options;
  const parent = getResolvedProcessEnv(options.parentEnv ?? process.env);

  const allow = new Set<string>(BASE_ALLOWLIST);
  for (const name of passthrough ?? []) {
    if (name) allow.add(name);
  }

  // Bedrock without explicit keys relies on the ambient AWS credential chain
  // (AWS_PROFILE / AWS_REGION / SSO / instance role). Only then do we let the
  // AWS_* family through; otherwise it stays stripped (fail-closed).
  const allowAws = modelProvider === 'amazon-bedrock' && !hasExplicitAwsKeys;

  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(parent)) {
    if (value === undefined) continue;
    if (allow.has(key) || isLocaleVar(key) || (allowAws && key.startsWith('AWS_'))) {
      out[key] = value;
    }
  }

  // Inject the selected provider key LAST so it always wins over anything the
  // allowlist happened to carry.
  if (modelEnv) {
    for (const [key, value] of Object.entries(modelEnv)) {
      if (typeof value === 'string') out[key] = value;
    }
  }

  return out;
}

/* ── Confined working directory (issue #68) ────────────────────────────── */

/** Top-level entries whose presence marks a dir as credential-bearing — an
 *  autonomous agent must not be rooted where it can read these. */
const CREDENTIAL_MARKERS: readonly string[] = ['.aws', '.ssh', '.npmrc', '.git-credentials', '.kube', '.docker'];

export type ConfinedCwdResult = {
  /** Canonical (realpath'd) working directory to use, or null when refused. */
  cwd: string | null;
  /** True when the requested path was clamped/validated under confinement. */
  confined: boolean;
  /** True when the requested path resolved outside the workspace root. */
  escaped: boolean;
  /** True when the cwd is too dangerous to spawn in (home/root/cred-bearing). */
  refused: boolean;
  /** Human-readable reason when refused. */
  reason?: string;
};

/** True when `p` is a filesystem root ('/' or a Windows drive root like 'C:\'). */
function isFilesystemRoot(p: string): boolean {
  const parsed = parsePath(p);
  return parsed.root === p || parsed.dir === p;
}

/**
 * Resolve + validate a requested agent working directory (issue #68).
 *
 * Canonicalizes via realpath, then refuses to spawn in high-blast-radius
 * locations: the user's home dir, a filesystem/drive root, or any directory
 * whose top level holds live credential files (.aws/.ssh/.npmrc/…). A normal
 * repo/workspace dir proceeds. Pure aside from the realpath/existence probes;
 * never mutates anything.
 *
 * `confinement` is optional so callers can gate the clamp behavior; when a
 * `workspaceRoot` is provided and the requested path escapes it, `escaped` is
 * reported (the caller decides whether to clamp or refuse).
 */
export function resolveConfinedCwd(
  requested: string | null | undefined,
  opts: { workspaceRoot?: string | null; homeDir?: string } = {},
): ConfinedCwdResult {
  const home = opts.homeDir ?? homedir();
  const raw = requested?.trim();

  if (!raw) {
    return { cwd: null, confined: false, escaped: false, refused: true, reason: 'No working directory specified.' };
  }

  // Expand ~ then make absolute.
  let abs: string;
  if (raw === '~') abs = home;
  else if (raw.startsWith('~/')) abs = resolvePath(home, raw.slice(2));
  else if (isAbsolute(raw)) abs = raw;
  else abs = resolvePath(home, raw);

  // Canonicalize through symlinks so a symlinked workspace can't alias a
  // refused location (and vice-versa). Fall back to the resolved path when it
  // doesn't exist yet.
  let real: string;
  try {
    real = realpathSync(abs);
  } catch {
    real = abs;
  }

  const canonicalHome = (() => {
    try {
      return realpathSync(home);
    } catch {
      return home;
    }
  })();

  if (real === canonicalHome) {
    return {
      cwd: null,
      confined: false,
      escaped: false,
      refused: true,
      reason:
        'Refusing to run an agent rooted at your home directory (too broad a blast radius). Point it at a project/workspace directory.',
    };
  }

  if (isFilesystemRoot(real)) {
    return {
      cwd: null,
      confined: false,
      escaped: false,
      refused: true,
      reason: `Refusing to run an agent at the filesystem root (${real}).`,
    };
  }

  // Refuse a dir that directly holds credential files.
  for (const marker of CREDENTIAL_MARKERS) {
    if (existsSync(resolvePath(real, marker))) {
      return {
        cwd: null,
        confined: false,
        escaped: false,
        refused: true,
        reason: `Refusing to run an agent in a directory that holds credential files (found ${marker} in ${real}).`,
      };
    }
  }

  // Optional workspace clamp: report escape when the requested path resolved
  // outside a provided workspace root.
  const workspaceRoot = opts.workspaceRoot?.trim();
  if (workspaceRoot) {
    let canonicalRoot: string;
    try {
      canonicalRoot = realpathSync(workspaceRoot);
    } catch {
      canonicalRoot = resolvePath(workspaceRoot);
    }
    const withinRoot = real === canonicalRoot || real.startsWith(canonicalRoot + sep);
    return { cwd: real, confined: true, escaped: !withinRoot, refused: false };
  }

  return { cwd: real, confined: false, escaped: false, refused: false };
}
