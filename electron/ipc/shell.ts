import { shell, type IpcMain } from 'electron';
import { extname } from 'path';

// Extensions the OS would EXECUTE (rather than open in a viewer) when handed to
// shell.openPath. shell:open-path exists so the user can open a file a tool
// produced/referenced (e.g. a generated image or doc) — it must not become a
// way to LAUNCH a planted binary/script with one click. Reveal-only would be
// safest, but we still want documents to open, so we block the executable
// classes and let everything else open normally.
const EXECUTABLE_EXTS = new Set([
  // macOS
  '.app',
  '.command',
  '.tool',
  '.workflow',
  // Windows
  '.exe',
  '.bat',
  '.cmd',
  '.com',
  '.msi',
  '.scr',
  '.ps1',
  '.vbs',
  '.vbe',
  '.js',
  '.jse',
  '.wsf',
  '.wsh',
  '.lnk',
  '.reg',
  '.hta',
  // Cross-platform scripts / shells
  '.sh',
  '.bash',
  '.zsh',
  '.fish',
  '.pl',
  '.py',
  '.rb',
  '.php',
  '.jar',
  '.desktop', // Linux .desktop launchers can run arbitrary Exec=
]);

export function registerShellHandlers(ipcMain: IpcMain): void {
  ipcMain.handle('shell:open-path', async (_event, filePath: string) => {
    const path = String(filePath ?? '');
    // Refuse to hand an executable/script to the OS default handler — opening
    // one launches code. The user reaches this via a UI "open" affordance on a
    // tool-produced file; a tool could plant a malicious binary and label it a
    // document. Documents/media still open normally.
    if (EXECUTABLE_EXTS.has(extname(path).toLowerCase())) {
      return { ok: false, error: 'Refusing to open an executable/script file.' };
    }
    try {
      const errorMessage = await shell.openPath(path);
      // shell.openPath returns empty string on success, error message on failure
      if (errorMessage) return { ok: false, error: errorMessage };
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : 'Failed to open path.',
      };
    }
  });
}
