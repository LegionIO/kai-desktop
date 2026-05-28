/**
 * Step-limit detection helper for the streaming/generate path in
 * mastra-agent.ts.
 *
 * Lives in its own module (no other imports) so it can be unit-tested without
 * pulling the rest of the agent graph — which depends on Vite-injected
 * `__BRAND_*` defines and other Electron-main-only modules — into the test
 * environment.
 */

/**
 * Detect whether a generate/stream run terminated because it hit the
 * configured maxSteps cap.
 *
 * The AI SDK / Mastra (currently `ai@^6.0.158` / `@mastra/core@^1.25.0`) does
 * not emit a dedicated `'max-steps'` finishReason. Instead, the stream
 * terminates with the last step's finishReason — typically `'tool-calls'`
 * (the model was still calling tools), `'length'` (token cap inside the last
 * step), or `'stop'` (the last step happened to finish cleanly on the cap).
 *
 * We treat the cap as hit when we've already emitted at least `maxSteps`
 * step-progress events AND the terminal finishReason is one of those values.
 */
export function didHitStepLimit(args: {
  currentStepCount: number;
  maxStepsLimit: number;
  terminalFinishReason: string | undefined;
}): boolean {
  const { currentStepCount, maxStepsLimit, terminalFinishReason } = args;
  if (currentStepCount < maxStepsLimit) return false;
  return terminalFinishReason === 'tool-calls'
    || terminalFinishReason === 'length'
    || terminalFinishReason === 'stop';
}
