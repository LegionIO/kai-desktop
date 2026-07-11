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
