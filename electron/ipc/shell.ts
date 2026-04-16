import { shell, type IpcMain } from 'electron';

export function registerShellHandlers(ipcMain: IpcMain): void {
  ipcMain.handle('shell:open-path', async (_event, filePath: string) => {
    try {
      const errorMessage = await shell.openPath(String(filePath ?? ''));
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
