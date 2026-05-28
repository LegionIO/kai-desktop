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
import { homedir } from 'os';
import { appendOutput, getBuffer } from './output-buffer.js';

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

export class TaskTerminalManager {
  private terminals = new Map<string, TaskTerminal>();
  /** Exit codes for recently-exited sessions, keyed by sessionId. */
  private exitCodes = new Map<string, number>();
  /** Callbacks invoked immediately when a terminal session exits. */
  private exitCallbacks = new Map<string, (exitCode: number) => void>();

  /**
   * Register a callback to be notified immediately when a terminal session exits.
   * The callback is automatically removed after it fires.
   */
  onSessionExit(sessionId: string, callback: (exitCode: number) => void): void {
    this.exitCallbacks.set(sessionId, callback);
  }

  async create(
    taskId: string,
    options: {
      runtime: string;
      cwd?: string;
      cols?: number;
      rows?: number;
      customArgs?: string[];
      env?: Record<string, string>;
      /** When true, pass --dangerously-* flags to CLI agents. Defaults to false. */
      dangerousMode?: boolean;
    },
  ): Promise<string> {
    // Dynamic import so a missing native build doesn't crash the whole app
    const pty = await import('@lydell/node-pty');

    // Validate runtime against allowlist
    const ALLOWED_RUNTIMES = ['claude-code', 'codex', 'mastra'];
    const runtime = ALLOWED_RUNTIMES.includes(options.runtime) ? options.runtime : 'shell';

    const sessionId = randomUUID();
    const shell = this.getShellCommand(runtime, options.customArgs, options.dangerousMode ?? false);

    const proc = pty.spawn(shell.command, shell.args, {
      name: 'xterm-256color',
      cols: options.cols ?? 80,
      rows: options.rows ?? 24,
      cwd: options.cwd ?? homedir(),
      env: { ...process.env, ...options.env, TERM: 'xterm-256color' } as Record<string, string>,
    });

    proc.onData((data: string) => {
      appendOutput(sessionId, data);
      this.broadcast('tasks:terminal-data', { sessionId, data });
    });

    proc.onExit(({ exitCode }: { exitCode: number }) => {
      this.terminals.delete(sessionId);
      this.exitCodes.set(sessionId, exitCode);
      const cb = this.exitCallbacks.get(sessionId);
      this.exitCallbacks.delete(sessionId);
      // If a callback consumed the exit, clean up the code immediately
      if (cb) {
        cb(exitCode);
        this.exitCodes.delete(sessionId);
      }
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
    const term = this.terminals.get(sessionId);
    if (!term) throw new Error(`Terminal session ${sessionId} not found`);
    term.process.write(data);
  }

  /** Returns true if a terminal session is still alive and tracked. */
  isAlive(sessionId: string): boolean {
    return this.terminals.has(sessionId);
  }

  resize(sessionId: string, cols: number, rows: number): void {
    this.terminals.get(sessionId)?.process.resize(cols, rows);
  }

  kill(sessionId: string): void {
    const term = this.terminals.get(sessionId);
    if (term) {
      term.process.kill();
      this.terminals.delete(sessionId);
    }
  }

  /** Kill all terminals associated with a given task. */
  killByTask(taskId: string): void {
    for (const [sessionId, term] of this.terminals) {
      if (term.taskId === taskId) {
        term.process.kill();
        this.terminals.delete(sessionId);
      }
    }
  }

  /** Read the exit code for a session without removing it from the cache. */
  getExitCode(sessionId: string): number | undefined {
    return this.exitCodes.get(sessionId);
  }

  /**
   * Read and clear the exit code for a session.
   * Returns undefined if the session never exited or was already consumed.
   */
  consumeExitCode(sessionId: string): number | undefined {
    const code = this.exitCodes.get(sessionId);
    if (code !== undefined) {
      this.exitCodes.delete(sessionId);
    }
    return code;
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
    this.exitCodes.clear();
    this.exitCallbacks.clear();
  }

  private getShellCommand(
    runtime: string,
    customArgs?: string[],
    dangerousMode?: boolean,
  ): { command: string; args: string[] } {
    switch (runtime) {
      case 'claude-code':
        return {
          command: 'claude',
          args: [...(dangerousMode ? ['--dangerously-skip-permissions'] : []), ...(customArgs ?? [])],
        };
      case 'codex':
        return {
          command: 'codex',
          args: [...(dangerousMode ? ['--dangerously-bypass-approvals-and-sandbox'] : []), ...(customArgs ?? [])],
        };
      case 'mastra':
        // Mastra as a terminal agent: use the shell and let the task description
        // be processed as a command or prompt. The actual Mastra agent stream is
        // handled via the runtime system, not the terminal PTY.
        return {
          command: process.env.SHELL ?? '/bin/zsh',
          args: [...(customArgs ?? [])],
        };
      default:
        // Fall back to user's shell (platform-aware)
        if (process.platform === 'win32') {
          return { command: process.env.COMSPEC ?? 'C:\\Windows\\System32\\cmd.exe', args: [...(customArgs ?? [])] };
        }
        return { command: process.env.SHELL ?? '/bin/zsh', args: [...(customArgs ?? [])] };
    }
  }

  private broadcast(channel: string, data: unknown): void {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue;
      win.webContents.send(channel, data);
    }
  }
}

// ── IPC Handler Registration ────────────────────────────────────────────

export function registerTaskTerminalHandlers(ipcMain: IpcMain, terminalManager: TaskTerminalManager): void {
  ipcMain.handle(
    'tasks:terminal-create',
    async (_e, taskId: string, options: { runtime: string; cwd?: string; cols?: number; rows?: number }) => {
      try {
        // Only allow safe options from renderer — strip dangerous fields
        // (IPC JSON deserialization doesn't enforce TypeScript types, so extra
        // properties like dangerousMode or customArgs could be smuggled in)
        const safeOptions = {
          runtime: options.runtime,
          cwd: options.cwd,
          cols: options.cols,
          rows: options.rows,
        };
        const sessionId = await terminalManager.create(taskId, safeOptions);
        return { sessionId };
      } catch (err) {
        return { error: String(err) };
      }
    },
  );

  ipcMain.handle('tasks:terminal-write', (_e, sessionId: string, data: string) => {
    terminalManager.write(sessionId, data);
  });

  ipcMain.handle('tasks:terminal-resize', (_e, sessionId: string, cols: number, rows: number) => {
    terminalManager.resize(sessionId, cols, rows);
  });

  ipcMain.handle('tasks:terminal-kill', (_e, sessionId: string) => {
    terminalManager.kill(sessionId);
    return { ok: true };
  });

  ipcMain.handle('tasks:terminal-get-buffer', (_e, sessionId: string) => {
    return getBuffer(sessionId);
  });
}
