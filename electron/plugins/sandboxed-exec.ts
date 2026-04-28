/**
 * Sandboxed Execution Engine
 *
 * Provides scoped filesystem access, whitelisted command execution, and tool
 * detection for the plugin system. All spawns use shell:false to prevent
 * injection. Arguments are validated against a 4-layer security model:
 *
 *   1. SYSTEM_ALLOWED_BINARIES — compile-time whitelist of 10 binaries
 *   2. Plugin execScope.binaries — plugin-declared subset
 *   3. Plugin execScope.argPatterns — per-binary regex restrictions
 *   4. BLOCKED_ARG_PATTERNS — runtime metacharacter rejection
 *
 * @source Plan: docs/plans/native-plugin-auto-install.md — Phase 2
 */

import { spawn, execSync } from 'child_process';
import { resolve, normalize, join, dirname } from 'path';
import { homedir } from 'os';
import { existsSync, realpathSync } from 'fs';
import type {
  AllowedBinary,
  ScopedDirectory,
  ExecRequest,
  ExecResult,
  ExecScopeDeclaration,
  FsScopeDeclaration,
  ToolDetectionResult,
  AuditEntry,
} from './types.js';

// ─── Constants ──────────────────────────────────────────────────────────────

/** The complete set of binaries any plugin may ever execute. */
export const SYSTEM_ALLOWED_BINARIES = new Set<AllowedBinary>([
  'claude', 'codex', 'node', 'npm', 'pip', 'pip3',
  'python', 'python3', 'git', 'bash',
]);

/** Maximum stdout/stderr captured per command (1 MB). */
const MAX_OUTPUT_BYTES = 1_048_576;

/** Maximum execution timeout (5 minutes). */
const MAX_TIMEOUT_MS = 300_000;

/** Default execution timeout (60 seconds). */
const DEFAULT_TIMEOUT_MS = 60_000;

/** Patterns that indicate shell metacharacters — always blocked in args. */
const BLOCKED_ARG_PATTERNS = [
  /;/,             // command chaining
  /\|/,            // piping
  /`/,             // backtick execution
  /\$\(/,          // subshell
  /\$\{/,          // variable expansion
  /\.\.\//,        // path traversal
  />\s*/,          // output redirection
  /<\s*/,          // input redirection
  /&/,             // background execution
];

/** Environment variables safe for plugins to read. */
export const SAFE_ENV_VARS = new Set([
  'PATH', 'HOME', 'SHELL', 'USER', 'LANG', 'TERM',
  'TMPDIR', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME',
]);

// ─── Scope Resolution ───────────────────────────────────────────────────────

/**
 * Resolve a ScopedDirectory token to an absolute path.
 */
export function resolveScopeDirectory(scope: ScopedDirectory, pluginDir: string): string {
  const home = homedir();
  switch (scope) {
    case 'claude-home': return join(home, '.claude');
    case 'codex-home':  return join(home, '.codex');
    case 'plugin-own':  return pluginDir;
    case 'kai-home':    return join(home, '.kai');
    case 'otc-repo':    return join(home, 'Documents', 'kai', 'otc-awesome-llm');
    default:            throw new Error(`Unknown scope: ${scope}`);
  }
}

/**
 * Check if a path is within one of the declared scoped directories.
 * Resolves symlinks and normalizes before comparison.
 */
export function isPathWithinScope(
  targetPath: string,
  directories: ScopedDirectory[],
  pluginDir: string,
): boolean {
  let resolvedTarget: string;
  try {
    // If the path exists, resolve symlinks. Otherwise just normalize.
    resolvedTarget = existsSync(targetPath)
      ? realpathSync(targetPath)
      : normalize(resolve(targetPath));
  } catch {
    resolvedTarget = normalize(resolve(targetPath));
  }

  for (const scope of directories) {
    const scopeRoot = resolveScopeDirectory(scope, pluginDir);
    let resolvedRoot: string;
    try {
      resolvedRoot = existsSync(scopeRoot)
        ? realpathSync(scopeRoot)
        : normalize(resolve(scopeRoot));
    } catch {
      resolvedRoot = normalize(resolve(scopeRoot));
    }

    if (resolvedTarget === resolvedRoot || resolvedTarget.startsWith(resolvedRoot + '/')) {
      return true;
    }
  }

  return false;
}

// ─── Argument Validation ────────────────────────────────────────────────────

/**
 * Validate arguments against the 4-layer security model.
 * Returns null if valid, or an error message string if blocked.
 */
export function validateExecArgs(
  binary: AllowedBinary,
  args: string[],
  execScope: ExecScopeDeclaration,
): string | null {
  // Layer 1: System whitelist
  if (!SYSTEM_ALLOWED_BINARIES.has(binary)) {
    return `Binary "${binary}" is not in the system whitelist`;
  }

  // Layer 2: Plugin-declared subset
  if (!execScope.binaries.includes(binary)) {
    return `Binary "${binary}" is not declared in plugin execScope.binaries`;
  }

  // Layer 3: Arg pattern matching (if patterns are declared for this binary)
  if (execScope.argPatterns && execScope.argPatterns[binary]) {
    const patterns = execScope.argPatterns[binary];
    const fullArgs = args.join(' ');

    // At least one pattern must match the full arg string
    const matched = patterns.some((pattern) => {
      try {
        return new RegExp(pattern).test(fullArgs);
      } catch {
        return false;
      }
    });

    if (!matched) {
      return `Arguments "${fullArgs}" do not match any allowed pattern for "${binary}"`;
    }
  }

  // Layer 4: Blocked metacharacters in individual args
  for (const arg of args) {
    for (const pattern of BLOCKED_ARG_PATTERNS) {
      if (pattern.test(arg)) {
        return `Argument "${arg}" contains blocked metacharacter pattern: ${pattern.source}`;
      }
    }
  }

  return null;
}

// ─── Command Execution ──────────────────────────────────────────────────────

/**
 * Execute a whitelisted command with full validation and output capping.
 */
export async function executeCommand(
  request: ExecRequest,
  execScope: ExecScopeDeclaration,
  pluginName: string,
  auditLog: (entry: AuditEntry) => void,
): Promise<ExecResult> {
  const { binary, args, cwd, env, stdin } = request;
  const timeoutMs = Math.min(request.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);

  // Validate arguments
  const validationError = validateExecArgs(binary, args, execScope);
  if (validationError) {
    auditLog({
      timestamp: new Date().toISOString(),
      pluginName,
      action: 'exec:run',
      target: binary,
      args,
      exitCode: -1,
      durationMs: 0,
      approved: false,
    });

    return {
      exitCode: -1,
      stdout: '',
      stderr: `Validation error: ${validationError}`,
      command: `${binary} ${args.join(' ')}`,
      durationMs: 0,
      truncated: false,
    };
  }

  // Resolve binary path
  const binaryPath = await findBinary(binary);
  if (!binaryPath) {
    return {
      exitCode: -1,
      stdout: '',
      stderr: `Binary "${binary}" not found in PATH`,
      command: `${binary} ${args.join(' ')}`,
      durationMs: 0,
      truncated: false,
    };
  }

  return new Promise<ExecResult>((resolvePromise) => {
    const startTime = Date.now();
    let stdout = '';
    let stderr = '';
    let truncated = false;
    let settled = false;

    const proc = spawn(binaryPath, args, {
      shell: false,
      cwd: cwd ?? undefined,
      env: env ? { ...process.env, ...env } : undefined,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: timeoutMs,
    });

    // Write stdin if provided
    if (stdin && proc.stdin) {
      proc.stdin.write(stdin);
      proc.stdin.end();
    } else if (proc.stdin) {
      proc.stdin.end();
    }

    proc.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < MAX_OUTPUT_BYTES) {
        stdout += chunk.toString();
      } else {
        truncated = true;
      }
    });

    proc.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < MAX_OUTPUT_BYTES) {
        stderr += chunk.toString();
      } else {
        truncated = true;
      }
    });

    const settle = (exitCode: number) => {
      if (settled) return;
      settled = true;
      const durationMs = Date.now() - startTime;

      auditLog({
        timestamp: new Date().toISOString(),
        pluginName,
        action: 'exec:run',
        target: binary,
        args,
        exitCode,
        durationMs,
        approved: true,
      });

      resolvePromise({
        exitCode,
        stdout: stdout.slice(0, MAX_OUTPUT_BYTES),
        stderr: stderr.slice(0, MAX_OUTPUT_BYTES),
        command: `${binary} ${args.join(' ')}`,
        durationMs,
        truncated,
      });
    };

    proc.on('close', (code) => settle(code ?? -1));
    proc.on('error', (err) => {
      stderr += `\nProcess error: ${err.message}`;
      settle(-1);
    });
  });
}

// ─── Binary Detection ───────────────────────────────────────────────────────

/**
 * Find the path to a binary using `which`.
 * Returns null if not found.
 */
export async function findBinary(name: string): Promise<string | null> {
  try {
    const result = execSync(`which ${name}`, { encoding: 'utf-8', timeout: 5000 }).trim();
    return result || null;
  } catch {
    return null;
  }
}

/**
 * Detect whether a tool is installed and get its version.
 */
export async function detectTool(binary: AllowedBinary): Promise<ToolDetectionResult> {
  const path = await findBinary(binary);
  if (!path) {
    return { name: binary, installed: false };
  }

  try {
    const version = execSync(`${path} --version`, {
      encoding: 'utf-8',
      timeout: 10_000,
    }).trim().split('\n')[0];
    return { name: binary, installed: true, path, version };
  } catch (err) {
    return { name: binary, installed: true, path, error: String(err) };
  }
}
