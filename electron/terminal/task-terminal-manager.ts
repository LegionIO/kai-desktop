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
  }

  private getShellCommand(runtime: string): { command: string; args: string[] } {
    switch (runtime) {
      case 'claude-code':
        return { command: 'claude', args: [] };
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
}
