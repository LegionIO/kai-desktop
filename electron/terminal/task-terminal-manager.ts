/**
 * TaskTerminalManager — manages PTY processes for task agent terminals.
 *
 * Spawns Claude Code, Codex, or Mastra CLI in a pseudo-terminal and
 * streams data to the renderer via IPC events.
 *
 * Adapted from Aperant's terminal manager pattern, simplified for Kai's
 * single-terminal-per-task model.
 */

import type { IpcMain } from 'electron';
import { BrowserWindow } from 'electron';
import { randomUUID } from 'crypto';
import { spawn, type ChildProcess } from 'child_process';

// node-pty is a native addon — imported dynamically to gracefully handle
// missing builds (e.g. in CI or unsupported platforms).
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
type IPty = import('@lydell/node-pty').IPty;

interface TaskTerminal {
  id: string;
  taskId: string;
  process: IPty;
  runtime: string;
}

interface NonInteractiveTerminal {
  id: string;
  taskId: string;
  process: ChildProcess;
  runtime: string;
}

export class TaskTerminalManager {
  private terminals = new Map<string, TaskTerminal>();
  private nonInteractiveProcs = new Map<string, NonInteractiveTerminal>();
  private outputHistory = new Map<string, string[]>();
  private readonly MAX_HISTORY_LINES = 500;

  async create(
    taskId: string,
    options: {
      runtime: string;
      cwd?: string;
      cols?: number;
      rows?: number;
    },
  ): Promise<string> {
    // Dynamic import so a missing native build doesn't crash the whole app
    const pty = await import('@lydell/node-pty');

    const sessionId = randomUUID();
    const shell = this.getShellCommand(options.runtime);

    const proc = pty.spawn(shell.command, shell.args, {
      name: 'xterm-256color',
      cols: options.cols ?? 80,
      rows: options.rows ?? 24,
      cwd: options.cwd ?? process.env.HOME ?? '/tmp',
      env: { ...process.env, TERM: 'xterm-256color' } as Record<string, string>,
    });

    proc.onData((data: string) => {
      this.appendHistory(sessionId, data);
      this.broadcast('tasks:terminal-data', { sessionId, data });
    });

    proc.onExit(({ exitCode }: { exitCode: number }) => {
      this.terminals.delete(sessionId);
      this.broadcast('tasks:terminal-exit', { sessionId, exitCode });
    });

    this.terminals.set(sessionId, {
      id: sessionId,
      taskId,
      process: proc,
      runtime: options.runtime,
    });

    return sessionId;
  }

  write(sessionId: string, data: string): void {
    this.terminals.get(sessionId)?.process.write(data);
  }

  resize(sessionId: string, cols: number, rows: number): void {
    this.terminals.get(sessionId)?.process.resize(cols, rows);
  }

  /**
   * Spawn a non-interactive CLI process (no PTY). Uses `-p` mode for Claude
   * and `--full-auto` for Codex. Output is streamed to renderer and buffered
   * for post-execution assessment.
   */
  async createNonInteractive(
    taskId: string,
    options: {
      runtime: 'claude-code' | 'codex';
      cwd: string;
      prompt: string;
      env?: Record<string, string>;
      onComplete?: (result: { exitCode: number; output: string; sessionId: string }) => void;
    },
  ): Promise<string> {
    const sessionId = randomUUID();
    const { command, args } = this.getNonInteractiveCommand(options.runtime, options.prompt);

    const proc = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, FORCE_COLOR: '0', ...(options.env ?? {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let outputBuffer = '';
    const MAX_BUFFER = 8000;
    const isClaude = options.runtime === 'claude-code';
    let lineBuffer = ''; // Buffer partial lines for stream-json parsing

    proc.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      outputBuffer += text;
      if (outputBuffer.length > MAX_BUFFER * 2) {
        outputBuffer = outputBuffer.slice(-MAX_BUFFER);
      }

      if (isClaude) {
        // Parse stream-json: accumulate lines, parse complete JSON objects
        lineBuffer += text;
        const lines = lineBuffer.split('\n');
        lineBuffer = lines.pop() ?? ''; // Keep incomplete last line in buffer

        for (const line of lines) {
          const formatted = formatStreamJsonLine(line);
          if (formatted) {
            this.appendHistory(sessionId, formatted);
            this.broadcast('tasks:terminal-data', { sessionId, data: formatted });
          }
        }
      } else {
        this.appendHistory(sessionId, text);
        this.broadcast('tasks:terminal-data', { sessionId, data: text });
      }
    });

    proc.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      outputBuffer += text;
      if (outputBuffer.length > MAX_BUFFER * 2) {
        outputBuffer = outputBuffer.slice(-MAX_BUFFER);
      }
      // stderr — show dimmed
      const dimmed = `\x1b[90m${text}\x1b[0m`;
      this.appendHistory(sessionId, dimmed);
      this.broadcast('tasks:terminal-data', { sessionId, data: dimmed });
    });

    proc.on('close', (exitCode: number | null) => {
      // Flush remaining line buffer
      if (isClaude && lineBuffer.trim()) {
        const formatted = formatStreamJsonLine(lineBuffer);
        if (formatted) {
          this.appendHistory(sessionId, formatted);
          this.broadcast('tasks:terminal-data', { sessionId, data: formatted });
        }
      }
      this.nonInteractiveProcs.delete(sessionId);
      const finalOutput = outputBuffer.slice(-MAX_BUFFER);
      this.broadcast('tasks:terminal-exit', { sessionId, exitCode: exitCode ?? 1 });
      options.onComplete?.({ exitCode: exitCode ?? 1, output: finalOutput, sessionId });
    });

    this.nonInteractiveProcs.set(sessionId, {
      id: sessionId,
      taskId,
      process: proc,
      runtime: options.runtime,
    });

    return sessionId;
  }

  kill(sessionId: string): void {
    const term = this.terminals.get(sessionId);
    if (term) {
      term.process.kill();
      this.terminals.delete(sessionId);
    }
    const niTerm = this.nonInteractiveProcs.get(sessionId);
    if (niTerm) {
      niTerm.process.kill();
      this.nonInteractiveProcs.delete(sessionId);
    }
    this.outputHistory.delete(sessionId);
  }

  /** Kill all terminals associated with a given task. */
  killByTask(taskId: string): void {
    for (const [sessionId, term] of this.terminals) {
      if (term.taskId === taskId) {
        term.process.kill();
        this.terminals.delete(sessionId);
      }
    }
    for (const [sessionId, term] of this.nonInteractiveProcs) {
      if (term.taskId === taskId) {
        term.process.kill();
        this.nonInteractiveProcs.delete(sessionId);
      }
    }
  }

  /** Clean up all terminals (app shutdown). */
  dispose(): void {
    for (const [, term] of this.terminals) {
      try {
        term.process.kill();
      } catch {
        // ignore
      }
    }
    this.terminals.clear();
    for (const [, term] of this.nonInteractiveProcs) {
      try {
        term.process.kill();
      } catch {
        // ignore
      }
    }
    this.nonInteractiveProcs.clear();
    this.outputHistory.clear();
  }

  /** Get buffered output history for replay on remount. */
  getOutputHistory(sessionId: string): string[] {
    return this.outputHistory.get(sessionId) ?? [];
  }

  /** Append output data to the per-session history ring buffer. */
  private appendHistory(sessionId: string, data: string): void {
    let lines = this.outputHistory.get(sessionId);
    if (!lines) {
      lines = [];
      this.outputHistory.set(sessionId, lines);
    }
    lines.push(data);
    if (lines.length > this.MAX_HISTORY_LINES) {
      lines.splice(0, lines.length - this.MAX_HISTORY_LINES);
    }
  }

  private getNonInteractiveCommand(runtime: string, prompt: string): { command: string; args: string[] } {
    if (runtime === 'claude-code') {
      return {
        command: 'claude',
        args: [
          '-p',
          '--verbose',
          '--output-format', 'stream-json',
          '--permission-mode', 'bypassPermissions',
          prompt,
        ],
      };
    }
    // codex
    return {
      command: 'codex',
      args: ['exec', '--full-auto', '--json', prompt],
    };
  }

  private getShellCommand(runtime: string): { command: string; args: string[] } {
    switch (runtime) {
      case 'claude-code':
        return { command: 'claude', args: ['--permission-mode', 'bypassPermissions'] };
      case 'codex':
        return { command: 'codex', args: [] };
      case 'mastra':
        return { command: 'npx', args: ['mastra', 'dev'] };
      default:
        // Fall back to user's shell
        return { command: process.env.SHELL ?? '/bin/zsh', args: [] };
    }
  }

  private broadcast(channel: string, data: unknown): void {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(channel, data);
    }
  }
}

// ── Stream-JSON Formatter ──────────────────────────────────────────────
// Converts Claude CLI `--output-format stream-json` lines into human-readable
// ANSI-colored text for xterm.js display. Matches fusion-app's TerminalOutput.

const ANSI = {
  reset: '\x1b[0m',
  dim: '\x1b[90m',
  white: '\x1b[37m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  blue: '\x1b[34m',
  bold: '\x1b[1m',
};

function formatStreamJsonLine(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  if (!trimmed.startsWith('{')) {
    // Non-JSON line — pass through
    return trimmed + '\r\n';
  }

  try {
    const obj = JSON.parse(trimmed) as Record<string, unknown>;
    return formatJsonObject(obj);
  } catch {
    // Invalid JSON — pass through
    return trimmed + '\r\n';
  }
}

function formatJsonObject(obj: Record<string, unknown>): string | null {
  const type = obj.type as string | undefined;

  // ── System events ─────────────────────────────────
  if (type === 'system') {
    const subtype = obj.subtype as string | undefined;

    if (subtype === 'init') {
      const model = obj.model as string | undefined;
      const version = obj.claude_code_version as string | undefined;
      const tools = obj.tools as string[] | undefined;
      return `${ANSI.dim}• Session initialized — model: ${model ?? 'unknown'}, v${version ?? '?'}, tools: ${tools?.length ?? 0}${ANSI.reset}\r\n`;
    }

    if (subtype === 'hook_started' || subtype === 'hook_response') {
      return null; // Skip hook noise
    }

    return `${ANSI.dim}• [${subtype ?? 'system'}]${ANSI.reset}\r\n`;
  }

  // ── Assistant message ─────────────────────────────
  if (type === 'assistant') {
    const message = obj.message as Record<string, unknown> | undefined;
    if (!message) return null;

    const content = message.content;
    if (!Array.isArray(content)) return null;

    const parts: string[] = [];

    for (const block of content) {
      const b = block as Record<string, unknown>;
      if (b.type === 'text' && b.text) {
        parts.push(`${ANSI.white}${b.text as string}${ANSI.reset}`);
      } else if (b.type === 'tool_use') {
        const name = b.name as string;
        const input = b.input as Record<string, unknown> | undefined;
        const summary = input
          ? Object.entries(input)
              .slice(0, 3)
              .map(([k, v]) => `${k}=${JSON.stringify(v).slice(0, 80)}`)
              .join(', ')
          : '';
        parts.push(`\r\n${ANSI.cyan}${ANSI.bold}› ${name}${ANSI.reset}${ANSI.dim}(${summary})${ANSI.reset}`);
      }
    }

    return parts.length > 0 ? parts.join('\r\n') + '\r\n' : null;
  }

  // ── Content block start (tool use) ────────────────
  if (type === 'content_block_start') {
    const block = obj.content_block as Record<string, unknown> | undefined;
    if (block?.type === 'tool_use') {
      return `\r\n${ANSI.cyan}${ANSI.bold}› ${block.name as string}${ANSI.reset}\r\n`;
    }
    return null;
  }

  // ── Content block delta (streaming text) ──────────
  if (type === 'content_block_delta') {
    const delta = obj.delta as Record<string, unknown> | undefined;
    if (delta?.type === 'text_delta' && delta.text) {
      const text = (delta.text as string).replace(/\n/g, '\r\n');
      return `${ANSI.white}${text}${ANSI.reset}`;
    }
    return null; // Skip input_json_delta
  }

  // ── Tool result ───────────────────────────────────
  if (type === 'tool_result') {
    const content = obj.content as string | undefined;
    if (!content) return null;
    const preview = content.length > 500 ? content.slice(0, 500) + '...' : content;
    const lines = preview.replace(/\n/g, '\r\n');
    return `${ANSI.green}${lines}${ANSI.reset}\r\n`;
  }

  // ── Final result ──────────────────────────────────
  if (type === 'result') {
    const result = obj.result as string | undefined;
    const cost = obj.cost_usd as number | undefined;
    const duration = obj.duration_ms as number | undefined;
    const meta: string[] = [];
    if (cost != null) meta.push(`$${cost.toFixed(4)}`);
    if (duration != null) meta.push(`${(duration / 1000).toFixed(1)}s`);
    const metaStr = meta.length > 0 ? ` ${ANSI.dim}(${meta.join(', ')})${ANSI.reset}` : '';
    const text = result ? result.replace(/\n/g, '\r\n') : 'Execution complete';
    return `\r\n${ANSI.green}${ANSI.bold}${text}${ANSI.reset}${metaStr}\r\n`;
  }

  // ── Message start/stop, content_block_stop — skip ─
  if (type === 'message_start' || type === 'message_delta' || type === 'message_stop' || type === 'content_block_stop') {
    return null;
  }

  // ── Unknown — skip ────────────────────────────────
  return null;
}

// ── IPC Handler Registration ────────────────────────────────────────────

export function registerTaskTerminalHandlers(
  ipcMain: IpcMain,
  terminalManager: TaskTerminalManager,
): void {
  ipcMain.handle(
    'tasks:terminal-create',
    async (
      _e,
      taskId: string,
      options: { runtime: string; cwd?: string; cols?: number; rows?: number },
    ) => {
      try {
        const sessionId = await terminalManager.create(taskId, options);
        return { sessionId };
      } catch (err) {
        return { error: String(err) };
      }
    },
  );

  ipcMain.handle('tasks:terminal-write', (_e, sessionId: string, data: string) => {
    terminalManager.write(sessionId, data);
  });

  ipcMain.handle(
    'tasks:terminal-resize',
    (_e, sessionId: string, cols: number, rows: number) => {
      terminalManager.resize(sessionId, cols, rows);
    },
  );

  ipcMain.handle('tasks:terminal-kill', (_e, sessionId: string) => {
    terminalManager.kill(sessionId);
    return { ok: true };
  });

  ipcMain.handle('tasks:terminal-history', (_e, sessionId: string) => {
    return terminalManager.getOutputHistory(sessionId);
  });
}
