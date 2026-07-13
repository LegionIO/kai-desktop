import { z } from 'zod';
import { parse as shellParse } from 'shell-quote';
import type { AppConfig } from '../config/schema.js';
import type { ToolDefinition } from './types.js';
import type { PluginCliToolContribution } from '../plugins/types.js';
import { runCommandWithStreaming, resolveProcessStreamingConfig } from './process-runner.js';
import { runToolExecution } from './execution.js';
import { isCommandAllowed, scrubShellEnv } from './shell.js';
import { beginShellSnapshot } from './diff-tracker.js';
import { binaryExistsInResolvedPath } from '../utils/shell-env.js';

export function binaryExists(name: string): boolean {
  return binaryExistsInResolvedPath(name);
}

type CliToolSpec = {
  name: string;
  binary: string;
  extraBinaries?: string[];
  description: string;
  prefix?: string;
};

/**
 * Tokenize a CLI-tool command into an argv the tool can run with shell:false,
 * enforcing the two security invariants: (1) NO shell control operators
 * (;, &&, ||, |, >, <, &, $(…), <(…), backtick-less-only, etc.) so the validated
 * binary can't be chained into a second command, and (2) argv[0] must be one of
 * the binaries allowed for this tool. shell-quote returns plain words as strings,
 * unquoted globs as {op:'glob'}, and every control operator as an {op} object —
 * so anything that isn't a string, an allowed glob, or a trailing #comment is a
 * rejected operator. Returns { argv } on success or { error } on rejection.
 */
export function parseAndValidateCliCommand(
  command: string,
  allBinaries: string[],
): { argv: string[]; error?: undefined } | { argv?: undefined; error: string } {
  const rawTokens = shellParse(command, process.env as Record<string, string>);
  const argv: string[] = [];
  for (const t of rawTokens) {
    if (typeof t === 'string') {
      argv.push(t);
    } else if ('op' in t && t.op === 'glob' && 'pattern' in t) {
      argv.push(t.pattern as string);
    } else if ('comment' in t) {
      break; // ignore trailing # comment
    } else {
      return { error: 'Shell control operators (;, &&, ||, |, >, <, etc.) are not allowed in CLI tool commands' };
    }
  }
  if (argv.length === 0 || !allBinaries.includes(argv[0])) {
    return { error: `Command must start with one of: ${allBinaries.join(', ')}` };
  }
  return { argv };
}

function createCliTool(spec: CliToolSpec, getConfig: () => AppConfig): ToolDefinition {
  return {
    name: spec.name,
    description: spec.description,
    inputSchema: z.object({
      command: z
        .string()
        .describe(`The full ${spec.binary} command to execute (e.g. "${spec.prefix ?? spec.binary} --help")`),
      cwd: z.string().optional().describe('Working directory (defaults to home)'),
      timeout: z.number().optional().describe('Timeout in milliseconds'),
    }),
    source: 'cli',
    execute: async (input, context) =>
      runToolExecution({
        context,
        run: async () => {
          const { command, cwd, timeout } = input as { command: string; cwd?: string; timeout?: number };
          const config = getConfig();

          // Tokenize + validate: reject shell control operators and enforce that
          // the command starts with a binary allowed for this tool. (Globs pass
          // through as literal strings; the command later runs with shell:false.)
          const allBinaries = [spec.binary, ...(spec.extraBinaries ?? [])];
          const parsed = parseAndValidateCliCommand(command, allBinaries);
          if (parsed.error) {
            return { error: parsed.error, command, isError: true };
          }
          const { argv } = parsed;

          // Apply shell allow/deny guardrails (operates on the original string for deny-pattern matching)
          const check = isCommandAllowed(command, config);
          if (!check.allowed) {
            return { error: check.reason, command, isError: true };
          }

          const streaming = resolveProcessStreamingConfig(config);
          const effectiveCwd = cwd || context.cwd || process.env.HOME;
          const diffSnap = await beginShellSnapshot(
            context.conversationId,
            { toolName: spec.name, toolCallId: context.toolCallId, command, cwd: effectiveCwd },
            config,
          );
          // Finalize the snapshot even if the outer runToolExecution abort race
          // returns before this promise settles — a cancelled CLI command can
          // still have mutated files, and they must stay tracked/revertable.
          let diffEvents: Awaited<ReturnType<typeof diffSnap.finish>> = [];
          let diffFinalized = false;
          const finalizeDiff = async (stdout: string, stderr: string): Promise<void> => {
            if (diffFinalized) return;
            diffFinalized = true;
            try {
              diffEvents = await diffSnap.finish({ stdout, stderr });
            } catch {
              /* ignore */
            }
          };
          try {
            const result = await runCommandWithStreaming({
              command,
              argv,
              cwd: effectiveCwd,
              timeoutMs: timeout || config.tools.shell.timeout,
              // Scrub Kai's own secrets from the spawned binary's env (same as the
              // `sh` tool) — the CLI binary shouldn't inherit our API keys.
              env: scrubShellEnv(process.env),
              context,
              streaming,
            });

            await finalizeDiff(result.stdout, result.stderr);

            const payload: Record<string, unknown> = {
              exitCode: result.exitCode,
              stdout: result.stdout,
              stderr: result.stderr,
            };
            if (diffSnap.enabled && (diffEvents.length > 0 || diffSnap.snapshotSkipped)) {
              payload._diffTracking = { diffs: diffEvents, snapshotSkipped: diffSnap.snapshotSkipped };
            }

            if (result.timedOut) payload.error = 'Command timed out';
            if (result.cancelled) payload.error = 'Command cancelled';
            if (result.truncated) {
              payload.truncated = true;
              payload.stdoutTruncated = result.stdoutTruncated;
              payload.stderrTruncated = result.stderrTruncated;
            }
            if (result.modelStream) payload.modelStream = result.modelStream;

            return payload;
          } finally {
            // If the command was abandoned (abort race) without a resolved
            // result, still finalize so mutations are captured.
            await finalizeDiff('', '');
          }
        },
      }),
  };
}

export function buildCliTools(
  getConfig: () => AppConfig,
  pluginContributions: PluginCliToolContribution[] = [],
): ToolDefinition[] {
  const config = getConfig();
  const specs = config.cliTools ?? [];
  const tools: ToolDefinition[] = [];

  // Built-in / user-configured CLI tools
  for (const spec of specs) {
    if (spec.enabled === false) continue;
    if (binaryExists(spec.binary)) {
      tools.push(createCliTool(spec, getConfig));
    }
  }

  // Plugin-contributed CLI tools (merged, no duplicates with built-ins)
  const builtinNames = new Set(tools.map((t) => t.name));
  for (const contrib of pluginContributions) {
    if (builtinNames.has(contrib.name)) continue; // don't override built-ins
    if (binaryExists(contrib.binary)) {
      tools.push(createCliTool(contrib, getConfig));
    }
  }

  return tools;
}
