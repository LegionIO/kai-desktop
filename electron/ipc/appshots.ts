/**
 * Appshot IPC handlers (#81). Exposes the persisted-appshot store to the
 * renderer. Every id-keyed handler validates APPSHOT_ID_RE before the store
 * touches the filesystem; `update` validates its patch against a strict
 * allowlist. Mutations broadcast `appshots:changed` (mirrors conversations).
 */

import type { IpcMain } from 'electron';
import { z } from 'zod';
import { createAppshotStore, type AppshotRetentionConfig } from '../computer-use/appshot-store.js';
import { broadcastToAllWindows } from '../utils/window-send.js';
import { isValidAppshotId } from '../../shared/appshots.js';
import type { AppConfig } from '../config/schema.js';

// Only tags + pinned are mutable. Extra keys are stripped (not passed through),
// so a forged { imageRef, id, createdAt } can never overwrite stored fields.
const appshotUpdateSchema = z
  .object({
    tags: z.array(z.string().max(100)).max(50).optional(),
    pinned: z.boolean().optional(),
  })
  .strict();

function resolveRetention(config: AppConfig): AppshotRetentionConfig {
  const r = (config.appshots as { retention?: Partial<AppshotRetentionConfig> } | undefined)?.retention;
  return {
    maxCount: r?.maxCount ?? 200,
    maxAgeDays: r?.maxAgeDays ?? 30,
    maxTotalBytes: r?.maxTotalBytes ?? 524288000,
  };
}

export function registerAppshotHandlers(ipcMain: IpcMain, appHome: string, getConfig: () => AppConfig): void {
  const store = createAppshotStore(appHome);

  ipcMain.handle('appshots:list', () => store.list());

  ipcMain.handle('appshots:get', (_e, id: unknown) => {
    if (!isValidAppshotId(id)) return null;
    return store.get(id);
  });

  ipcMain.handle('appshots:get-image', (_e, id: unknown) => {
    if (!isValidAppshotId(id)) return null;
    return store.getImage(id);
  });

  ipcMain.handle('appshots:delete', (_e, id: unknown) => {
    if (!isValidAppshotId(id)) return { ok: false, error: 'invalid id' };
    const ok = store.delete(id);
    if (ok) broadcastToAllWindows('appshots:changed', undefined);
    return { ok };
  });

  ipcMain.handle('appshots:delete-all', () => {
    store.deleteAll();
    broadcastToAllWindows('appshots:changed', undefined);
    return { ok: true };
  });

  ipcMain.handle('appshots:update', (_e, id: unknown, patch: unknown) => {
    if (!isValidAppshotId(id)) return { ok: false, error: 'invalid id' };
    const parsed = appshotUpdateSchema.safeParse(patch);
    if (!parsed.success) {
      return { ok: false, error: `invalid patch: ${parsed.error.issues[0]?.message ?? 'validation failed'}` };
    }
    const updated = store.update(id, parsed.data);
    if (updated) broadcastToAllWindows('appshots:changed', undefined);
    return { ok: Boolean(updated), appshot: updated };
  });

  // Retention can be triggered manually (e.g. after a config change).
  ipcMain.handle('appshots:enforce-retention', () => {
    store.enforceRetention(resolveRetention(getConfig()));
    broadcastToAllWindows('appshots:changed', undefined);
    return { ok: true };
  });
}
