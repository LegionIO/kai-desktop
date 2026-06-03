/**
 * Runtime CLI availability detection.
 *
 * Both `@anthropic-ai/claude-agent-sdk` and `@openai/codex-sdk` are bundled
 * as regular dependencies in Kai.  However, they each depend on an external
 * CLI binary to function:
 *
 *   - Claude Agent SDK requires the **Claude Code CLI** (`claude`)
 *   - Codex SDK requires the **Codex CLI** (`codex`)
 *
 * If the CLI binary is not found on the user's PATH, the runtime is reported
 * as "inactive" rather than "not installed".
 *
 * Successful results are cached for the lifetime of the process. Misses are
 * rechecked because Kai resolves the user's shell PATH asynchronously during
 * startup, and users may install a CLI while Kai is running.
 */

import { resolveBinaryPathSync } from '../../utils/shell-env.js';

let _claudeCliPath: string | false | null = null;
let _codexCliPath: string | false | null = null;
let _piCliPath: string | false | null = null;

/**
 * Returns `true` when the `claude` CLI binary is found on PATH.
 * This is required for the Claude Agent SDK to function.
 */
export async function detectClaudeAgentSdk(): Promise<boolean> {
  if (typeof _claudeCliPath === 'string') return true;
  _claudeCliPath = resolveCliPath('claude');
  return _claudeCliPath !== false;
}

/**
 * Returns the absolute path to the `claude` CLI binary if found on PATH,
 * or `undefined` if not found.  Used to pass `pathToClaudeCodeExecutable`
 * to the SDK when its bundled binary is missing.
 */
export async function resolveClaudeCliPath(): Promise<string | undefined> {
  if (typeof _claudeCliPath !== 'string') {
    _claudeCliPath = resolveCliPath('claude');
  }
  return _claudeCliPath || undefined;
}

/**
 * Returns `true` when the `codex` CLI binary is found on PATH.
 * This is required for the Codex SDK to function.
 */
export async function detectCodexSdk(): Promise<boolean> {
  if (typeof _codexCliPath === 'string') return true;
  _codexCliPath = resolveCliPath('codex');
  return _codexCliPath !== false;
}

/**
 * Returns `true` when the `pi` CLI binary is found on PATH.
 * This is required for the pi coding-agent runtime to function.
 */
export async function detectPiCli(): Promise<boolean> {
  if (typeof _piCliPath === 'string') return true;
  _piCliPath = resolveCliPath('pi');
  return _piCliPath !== false;
}

/**
 * Returns the absolute path to the `pi` CLI binary if found on PATH,
 * or `undefined` if not found.  The pi runtime spawns this path directly.
 */
export async function resolvePiCliPath(): Promise<string | undefined> {
  if (typeof _piCliPath !== 'string') {
    _piCliPath = resolveCliPath('pi');
  }
  return _piCliPath || undefined;
}

/**
 * Resets the cached detection results.  Useful if the user installs a
 * CLI binary while Kai is already running.
 */
export function resetDetectionCache(): void {
  _claudeCliPath = null;
  _codexCliPath = null;
  _piCliPath = null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the absolute path to a CLI binary on Kai's normalized PATH.
 * Returns the trimmed path string if found, or `false` if not found.
 */
function resolveCliPath(binaryName: string): string | false {
  const resolved = resolveBinaryPathSync(binaryName);
  return resolved || false;
}
