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
 * Results are cached for the lifetime of the process (reset via
 * `resetDetectionCache()` if the user installs a CLI while Kai is running).
 */

import { execSync } from 'child_process';

let _claudeCliPath: string | false | null = null;
let _codexCliPath: string | false | null = null;

/**
 * Returns `true` when the `claude` CLI binary is found on PATH.
 * This is required for the Claude Agent SDK to function.
 */
export async function detectClaudeAgentSdk(): Promise<boolean> {
  if (_claudeCliPath !== null) return _claudeCliPath !== false;
  _claudeCliPath = resolveCliPath('claude');
  return _claudeCliPath !== false;
}

/**
 * Returns the absolute path to the `claude` CLI binary if found on PATH,
 * or `undefined` if not found.  Used to pass `pathToClaudeCodeExecutable`
 * to the SDK when its bundled binary is missing.
 */
export async function resolveClaudeCliPath(): Promise<string | undefined> {
  if (_claudeCliPath === null) {
    _claudeCliPath = resolveCliPath('claude');
  }
  return _claudeCliPath || undefined;
}

/**
 * Returns `true` when the `codex` CLI binary is found on PATH.
 * This is required for the Codex SDK to function.
 */
export async function detectCodexSdk(): Promise<boolean> {
  if (_codexCliPath !== null) return _codexCliPath !== false;
  _codexCliPath = resolveCliPath('codex');
  return _codexCliPath !== false;
}

/**
 * Resets the cached detection results.  Useful if the user installs a
 * CLI binary while Kai is already running.
 */
export function resetDetectionCache(): void {
  _claudeCliPath = null;
  _codexCliPath = null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the absolute path to a CLI binary on PATH using `which` (macOS/Linux).
 * Returns the trimmed path string if found, or `false` if not found.
 */
function resolveCliPath(binaryName: string): string | false {
  try {
    const result = execSync(`which ${binaryName}`, { stdio: 'pipe', timeout: 5_000 });
    const resolved = result.toString().trim();
    return resolved || false;
  } catch {
    return false;
  }
}
