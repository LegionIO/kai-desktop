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

let _claudeCliAvailable: boolean | null = null;
let _codexCliAvailable: boolean | null = null;

/**
 * Returns `true` when the `claude` CLI binary is found on PATH.
 * This is required for the Claude Agent SDK to function.
 */
export async function detectClaudeAgentSdk(): Promise<boolean> {
  if (_claudeCliAvailable !== null) return _claudeCliAvailable;
  _claudeCliAvailable = isCliAvailable('claude');
  return _claudeCliAvailable;
}

/**
 * Returns `true` when the `codex` CLI binary is found on PATH.
 * This is required for the Codex SDK to function.
 */
export async function detectCodexSdk(): Promise<boolean> {
  if (_codexCliAvailable !== null) return _codexCliAvailable;
  _codexCliAvailable = isCliAvailable('codex');
  return _codexCliAvailable;
}

/**
 * Resets the cached detection results.  Useful if the user installs a
 * CLI binary while Kai is already running.
 */
export function resetDetectionCache(): void {
  _claudeCliAvailable = null;
  _codexCliAvailable = null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Check whether a CLI binary is available on PATH using `which` (macOS/Linux).
 * Returns `true` if found, `false` otherwise.
 */
function isCliAvailable(binaryName: string): boolean {
  try {
    execSync(`which ${binaryName}`, { stdio: 'pipe', timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}
