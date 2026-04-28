/**
 * SDK availability detection.
 *
 * Uses dynamic `import()` to probe whether optional SDK packages are
 * installed.  Results are cached for the lifetime of the process.
 */

let _claudeAgentSdkAvailable: boolean | null = null;
let _codexSdkAvailable: boolean | null = null;

/**
 * Returns `true` when `@anthropic-ai/claude-agent-sdk` can be loaded.
 */
export async function detectClaudeAgentSdk(): Promise<boolean> {
  if (_claudeAgentSdkAvailable !== null) return _claudeAgentSdkAvailable;
  try {
    // @ts-expect-error — optional dependency, may not be installed
    await import('@anthropic-ai/claude-agent-sdk');
    _claudeAgentSdkAvailable = true;
  } catch {
    _claudeAgentSdkAvailable = false;
  }
  return _claudeAgentSdkAvailable;
}

/**
 * Returns `true` when `@openai/codex-sdk` can be loaded.
 */
export async function detectCodexSdk(): Promise<boolean> {
  if (_codexSdkAvailable !== null) return _codexSdkAvailable;
  try {
    // @ts-expect-error — optional dependency, may not be installed
    await import('@openai/codex-sdk');
    _codexSdkAvailable = true;
  } catch {
    _codexSdkAvailable = false;
  }
  return _codexSdkAvailable;
}

/**
 * Resets the cached detection results.  Useful after installing a new
 * dependency at runtime (e.g. from the settings UI).
 */
export function resetDetectionCache(): void {
  _claudeAgentSdkAvailable = null;
  _codexSdkAvailable = null;
}
