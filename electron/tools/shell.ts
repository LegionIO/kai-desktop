import { z } from 'zod';
import type { AppConfig } from '../config/schema.js';
import type { ToolDefinition } from './types.js';
import { runCommandWithStreaming, resolveProcessStreamingConfig } from './process-runner.js';
import { runToolExecution } from './execution.js';

function buildWildcardRegex(pattern: string): RegExp {
  // Escape all regex metacharacters except `*`, which we map to `.*` below.
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('^' + escaped.replace(/\*/g, '.*') + '$');
}

/** Allow-pattern matching: anchored at the start of the command. */
function matchesAllowPattern(command: string, pattern: string): boolean {
  if (pattern === '*') return true;
  if (pattern.includes('*')) return buildWildcardRegex(pattern).test(command);
  return command.trimStart().startsWith(pattern);
}

/**
 * Deny-pattern matching: whitespace-normalized substring search anywhere in
 * the command. Deny semantics are intentionally broader than allow — a deny
 * of `rm -rf /` should still catch `sudo rm  -rf /` and `env X=1 rm -rf /`.
 * (This is best-effort; quoting/expansion can still evade textual matching.)
 */
function matchesDenyPattern(command: string, pattern: string): boolean {
  if (pattern === '*') return true;
  const normCommand = command.replace(/\s+/g, ' ');
  const normPattern = pattern.replace(/\s+/g, ' ');
  if (normPattern.includes('*')) return buildWildcardRegex(normPattern).test(normCommand);
  return normCommand.includes(normPattern);
}

export function isCommandAllowed(command: string, config: AppConfig): { allowed: boolean; reason?: string } {
  const shellConfig = config.tools.shell;
  if (!shellConfig.enabled) return { allowed: false, reason: 'Shell tool is disabled' };

  for (const pattern of shellConfig.denyPatterns) {
    if (matchesDenyPattern(command, pattern)) {
      return { allowed: false, reason: `Command matches deny pattern: ${pattern}` };
    }
  }

  if (shellConfig.allowPatterns.length > 0 && !shellConfig.allowPatterns.includes('*')) {
    const allowed = shellConfig.allowPatterns.some((p) => matchesAllowPattern(command, p));
    if (!allowed) return { allowed: false, reason: 'Command does not match any allow pattern' };
  }

  return { allowed: true };
}

export function createShellTool(getConfig: () => AppConfig): ToolDefinition {
  return {
    name: 'sh',
    description: 'Execute a shell command on the local machine. Returns stdout/stderr. Use for running programs, scripts, git commands, package managers, etc.',
    inputSchema: z.object({
      command: z.string().describe('The shell command to execute'),
      cwd: z.string().optional().describe('Working directory (defaults to home)'),
      timeout: z.number().optional().describe('Timeout in milliseconds'),
    }),
    execute: async (input, context) => runToolExecution({
      context,
      run: async () => {
        const { command, cwd, timeout } = input as { command: string; cwd?: string; timeout?: number };
        const config = getConfig();

        const check = isCommandAllowed(command, config);
        if (!check.allowed) {
          return { error: check.reason, command, isError: true };
        }

        const streaming = resolveProcessStreamingConfig(config);
        const result = await runCommandWithStreaming({
          command,
          cwd: cwd || context.cwd || process.env.HOME,
          timeoutMs: timeout || config.tools.shell.timeout,
          env: { ...process.env },
          context,
          streaming,
        });

        const payload: Record<string, unknown> = {
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
        };

        if (result.timedOut) payload.error = 'Command timed out';
        if (result.cancelled) payload.error = 'Command cancelled';
        if (result.truncated) {
          payload.truncated = true;
          payload.stdoutTruncated = result.stdoutTruncated;
          payload.stderrTruncated = result.stderrTruncated;
          payload.totalStdoutBytes = result.totalStdoutBytes;
          payload.totalStderrBytes = result.totalStderrBytes;
        }
        if (result.modelStream) {
          payload.modelStream = result.modelStream;
        }

        return payload;
      },
    }),
  };
}
