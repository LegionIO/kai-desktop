import type { IpcMain } from 'electron';
import { BrowserWindow } from 'electron';
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, readdirSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import type { TaskFile, KaiTaskOrder } from '../../shared/task-types.js';

// ── Helpers ──────────────────────────────────────────────────────────────

function getTasksDir(appHome: string): string {
  const dir = join(appHome, 'data', 'tasks');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function broadcastTaskChange(appHome: string): void {
  try {
    const tasks = listAllTasks(appHome);
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('tasks:changed', tasks);
    }
  } catch (err) {
    console.error('[tasks] Failed to broadcast task change:', err);
  }
}

function listAllTasks(appHome: string): TaskFile[] {
  const dir = getTasksDir(appHome);
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return [];
  }
  return files
    .filter((f) => f.endsWith('.json') && f !== 'order.json')
    .map((f) => {
      try {
        const raw = readFileSync(join(dir, f), 'utf-8');
        const parsed = JSON.parse(raw) as TaskFile;
        // Validate essential fields — skip corrupt entries
        if (!parsed.id || !parsed.title || !parsed.status) return null;
        return parsed;
      } catch {
        console.warn(`[tasks] Skipping corrupt task file: ${f}`);
        return null;
      }
    })
    .filter((t): t is TaskFile => t !== null)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

// ── Registration ─────────────────────────────────────────────────────────

export function registerTaskHandlers(ipcMain: IpcMain, appHome: string): void {
  // ── CRUD ────────────────────────────────────────────────────────────

  ipcMain.handle('tasks:list', () => {
    return listAllTasks(appHome);
  });

  ipcMain.handle('tasks:get', (_e, id: string) => {
    const filePath = join(getTasksDir(appHome), `${id}.json`);
    if (!existsSync(filePath)) return null;
    try {
      return JSON.parse(readFileSync(filePath, 'utf-8')) as TaskFile;
    } catch {
      return null;
    }
  });

  ipcMain.handle(
    'tasks:create',
    (_e, taskData: Omit<TaskFile, 'id' | 'createdAt' | 'updatedAt'>) => {
      try {
        const id = randomUUID();
        const now = new Date().toISOString();
        const task: TaskFile = { ...taskData, id, createdAt: now, updatedAt: now };
        writeFileSync(
          join(getTasksDir(appHome), `${id}.json`),
          JSON.stringify(task, null, 2),
          'utf-8',
        );
        broadcastTaskChange(appHome);
        return task;
      } catch (err) {
        console.error('[tasks] Failed to create task:', err);
        return { error: String(err) };
      }
    },
  );

  ipcMain.handle('tasks:update', (_e, id: string, updates: Partial<TaskFile>) => {
    const filePath = join(getTasksDir(appHome), `${id}.json`);
    if (!existsSync(filePath)) {
      return { error: `Task ${id} not found` };
    }
    try {
      const existing = JSON.parse(readFileSync(filePath, 'utf-8')) as TaskFile;
      const updated: TaskFile = {
        ...existing,
        ...updates,
        id, // prevent ID mutation
        updatedAt: new Date().toISOString(),
      };
      writeFileSync(filePath, JSON.stringify(updated, null, 2), 'utf-8');
      broadcastTaskChange(appHome);
      return updated;
    } catch {
      return { error: `Failed to update task ${id}` };
    }
  });

  ipcMain.handle('tasks:delete', (_e, id: string) => {
    try {
      const filePath = join(getTasksDir(appHome), `${id}.json`);
      if (existsSync(filePath)) {
        unlinkSync(filePath);
      }
      broadcastTaskChange(appHome);
      return { ok: true };
    } catch (err) {
      console.error(`[tasks] Failed to delete task ${id}:`, err);
      return { error: String(err) };
    }
  });

  // ── Column ordering ────────────────────────────────────────────────

  ipcMain.handle('tasks:get-order', () => {
    const filePath = join(getTasksDir(appHome), 'order.json');
    if (!existsSync(filePath)) return null;
    try {
      return JSON.parse(readFileSync(filePath, 'utf-8')) as KaiTaskOrder;
    } catch {
      return null;
    }
  });

  ipcMain.handle('tasks:save-order', (_e, order: KaiTaskOrder) => {
    try {
      writeFileSync(
        join(getTasksDir(appHome), 'order.json'),
        JSON.stringify(order, null, 2),
        'utf-8',
      );
      return { ok: true };
    } catch (err) {
      console.error('[tasks] Failed to save order:', err);
      return { error: String(err) };
    }
  });
}
