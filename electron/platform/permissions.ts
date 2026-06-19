import { getPlatformAdapter } from './index.js';
import type { PlatformPermissions, PlatformPermissionSection } from './types.js';

export async function checkPlatformPermissions(): Promise<PlatformPermissions> {
  const adapter = await getPlatformAdapter();
  return adapter.checkPermissions();
}

export async function openPlatformPermissionSettings(section: PlatformPermissionSection): Promise<void> {
  const adapter = await getPlatformAdapter();
  return adapter.openPermissionSettings(section);
}
