import * as pty from '@lydell/node-pty';
import { ipcMain, type BrowserWindow } from 'electron';
import { getResolvedProcessEnv } from '../utils/shell-env.js';

interface PtySession {
  id: string;
  process: pty.IPty;
  cwd: string;
  /** Buffer of early output so late-attaching renderers can catch up. */
  outputBuffer: string[];
  /** Whether the shell has emitted its first prompt (ready for commands). */
  ready: boolean;
}

const sessions = new Map<string, PtySession>();

export function registerPtyHandlers(getWindow: () => BrowserWindow | null): void {
  // Create a new PTY
  ipcMain.handle('pty:create', async (_event, id: string, cwd: string, cols = 80, rows = 24) => {
    // Kill existing session with the same id if it exists
    const existing = sessions.get(id);
    if (existing) {
      try { existing.process.kill(); } catch { /* ignore */ }
      sessions.delete(id);
    }

    const shell = process.platform === 'win32'
      ? 'powershell.exe'
      : (process.env.SHELL || '/bin/zsh');

    const env = getResolvedProcessEnv();

    const ptyProcess = pty.spawn(shell, [], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env: env as Record<string, string>,
    });

    const session: PtySession = { id, process: ptyProcess, cwd, outputBuffer: [], ready: false };
    sessions.set(id, session);

    console.info(`[PTY] Created session ${id} (pid=${ptyProcess.pid}) in ${cwd}`);

    // Forward data from PTY to renderer and buffer it
    ptyProcess.onData((data) => {
      // Buffer output (cap at 500 chunks to avoid unbounded growth)
      if (session.outputBuffer.length < 500) {
        session.outputBuffer.push(data);
      }

      const win = getWindow();
      if (win && !win.isDestroyed()) {
        win.webContents.send('pty:data', id, data);
      }

      // Detect shell readiness: look for common prompt indicators
      // Covers standard shells ($, %, #, >) and oh-my-zsh (➜) / powerline prompts
      if (!session.ready) {
        const stripped = data.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, '').trimEnd();
        if (/[$%#>➜❯]\s*$/.test(stripped) || /\)\s*$/.test(stripped)) {
          session.ready = true;
          console.info(`[PTY] Session ${id} shell ready`);
          if (win && !win.isDestroyed()) {
            win.webContents.send('pty:ready', id);
          }
        }
      }
    });

    ptyProcess.onExit(({ exitCode }) => {
      const win = getWindow();
      if (win && !win.isDestroyed()) {
        win.webContents.send('pty:exit', id, exitCode);
      }
      sessions.delete(id);
    });

    return { id, pid: ptyProcess.pid };
  });

  // Write data to PTY (user input)
  ipcMain.handle('pty:write', async (_event, id: string, data: string) => {
    const session = sessions.get(id);
    if (session) {
      console.info(`[PTY] Writing to ${id}: ${JSON.stringify(data.slice(0, 80))}...`);
      session.process.write(data);
    } else {
      console.error(`[PTY] Write failed — no session for id: ${id}`);
    }
  });

  // Resize PTY
  ipcMain.handle('pty:resize', async (_event, id: string, cols: number, rows: number) => {
    const session = sessions.get(id);
    if (session) {
      try { session.process.resize(cols, rows); } catch { /* ignore invalid sizes */ }
    }
  });

  // Destroy PTY
  ipcMain.handle('pty:destroy', async (_event, id: string) => {
    const session = sessions.get(id);
    if (session) {
      try { session.process.kill(); } catch { /* ignore */ }
      sessions.delete(id);
    }
  });

  // Drain buffered output (for late-attaching renderers)
  ipcMain.handle('pty:drain', async (_event, id: string) => {
    const session = sessions.get(id);
    if (!session) return { data: '', ready: false };
    const data = session.outputBuffer.join('');
    return { data, ready: session.ready };
  });

  // List active PTY sessions
  ipcMain.handle('pty:list', async () => {
    return Array.from(sessions.entries()).map(([id, s]) => ({
      id,
      pid: s.process.pid,
      cwd: s.cwd,
    }));
  });
}

// Cleanup all PTYs on app quit
export function destroyAllPtys(): void {
  for (const [_id, session] of sessions) {
    try { session.process.kill(); } catch { /* ignore */ }
  }
  sessions.clear();
}
