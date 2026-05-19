/**
 * Shared type for the macOS `LocalMacosHelper` invocation surface.
 *
 * Production code wires this to a real implementation that spawns the
 * compiled Swift helper binary (or `xcrun swift` as a fallback) via
 * `execFile` from `node:child_process`. Tests substitute an in-memory stub
 * via `test-utils/swift-helper-stub.ts`.
 *
 * The runner accepts a subcommand (`permissions`, `displays`, …) plus optional
 * positional args and returns a parsed JSON response. Errors are returned via
 * the `error` field on `HelperRunnerResult`; the runner itself does not throw
 * for non-zero exit codes.
 */

export interface HelperRunnerResult {
  ok: boolean;
  /** Parsed JSON payload returned by the helper. */
  data?: unknown;
  /** Human-readable error message when the helper failed to run. */
  error?: string;
}

export type HelperRunner = (subcommand: string, args?: string[]) => Promise<HelperRunnerResult>;
