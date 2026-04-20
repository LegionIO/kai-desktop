import type { IpcMain } from 'electron';
import { BrowserWindow } from 'electron';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';

import type { WorkspaceTask, WorkspaceTaskStore } from '../../shared/workspace-types';

function hashProjectPath(projectPath: string): string {
  return createHash('md5').update(projectPath).digest('hex').slice(0, 16);
}

function getTaskStoreDir(appHome: string): string {
  return join(appHome, 'data', 'workspace-tasks');
}

function getTaskStorePath(appHome: string, projectPath: string): string {
  return join(getTaskStoreDir(appHome), `${hashProjectPath(projectPath)}.json`);
}

function readTaskStore(appHome: string, projectPath: string): WorkspaceTaskStore {
  const storePath = getTaskStorePath(appHome, projectPath);
  if (!existsSync(storePath)) {
    return { tasks: {}, version: 1, lastUpdated: new Date().toISOString() };
  }
  try {
    return JSON.parse(readFileSync(storePath, 'utf-8'));
  } catch {
    return { tasks: {}, version: 1, lastUpdated: new Date().toISOString() };
  }
}

function writeTaskStore(appHome: string, projectPath: string, store: WorkspaceTaskStore): void {
  const dir = getTaskStoreDir(appHome);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  store.lastUpdated = new Date().toISOString();
  writeFileSync(getTaskStorePath(appHome, projectPath), JSON.stringify(store, null, 2), 'utf-8');
}

function broadcastTaskChange(projectPath: string, store: WorkspaceTaskStore): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('workspace-tasks:changed', { projectPath, store });
  }
}

export function registerWorkspaceTaskHandlers(ipcMain: IpcMain, appHome: string): void {
  // List all tasks for a project
  ipcMain.handle('workspace-tasks:list', (_event, projectPath: string) => {
    const store = readTaskStore(appHome, projectPath);
    return Object.values(store.tasks);
  });

  // Get a single task
  ipcMain.handle('workspace-tasks:get', (_event, projectPath: string, taskId: string) => {
    const store = readTaskStore(appHome, projectPath);
    return store.tasks[taskId] ?? null;
  });

  // Upsert a task
  ipcMain.handle('workspace-tasks:put', (_event, projectPath: string, task: WorkspaceTask) => {
    const store = readTaskStore(appHome, projectPath);
    store.tasks[task.id] = task;
    writeTaskStore(appHome, projectPath, store);
    broadcastTaskChange(projectPath, store);
    return { ok: true };
  });

  // Delete a task
  ipcMain.handle('workspace-tasks:delete', (_event, projectPath: string, taskId: string) => {
    const store = readTaskStore(appHome, projectPath);
    delete store.tasks[taskId];
    writeTaskStore(appHome, projectPath, store);
    broadcastTaskChange(projectPath, store);
    return { ok: true };
  });
}
