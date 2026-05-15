import { app, nativeImage, type NativeImage } from 'electron';
import { existsSync } from 'fs';
import { join } from 'path';

const DOCK_SIZE = 128;
const ARTWORK_SCALE = 0.80;

export function resolveAppIconPath(iconPath?: string): string | null {
  const candidates = [
    iconPath,
    join(process.cwd(), 'build/icon.png'),
    join(app.getAppPath(), 'build/icon.png'),
    join(process.resourcesPath, 'build/icon.png'),
    join(process.resourcesPath, 'icon.png'),
  ];

  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    if (existsSync(candidate)) return candidate;
  }

  return null;
}

export function createPaddedDockIcon(iconPath?: string): NativeImage | null {
  const resolvedIconPath = resolveAppIconPath(iconPath);
  if (!resolvedIconPath) return null;

  const artworkSize = Math.round(DOCK_SIZE * ARTWORK_SCALE);
  const offset = Math.round((DOCK_SIZE - artworkSize) / 2);
  const artwork = nativeImage.createFromPath(resolvedIconPath).resize({ width: artworkSize, height: artworkSize });
  if (artwork.isEmpty()) return null;

  const canvas = Buffer.alloc(DOCK_SIZE * DOCK_SIZE * 4, 0);
  const pixels = artwork.toBitmap();
  for (let y = 0; y < artworkSize; y++) {
    pixels.copy(canvas, ((y + offset) * DOCK_SIZE + offset) * 4, y * artworkSize * 4, (y + 1) * artworkSize * 4);
  }

  return nativeImage.createFromBuffer(canvas, { width: DOCK_SIZE, height: DOCK_SIZE });
}

export function setPaddedMacDockIcon(iconPath?: string): boolean {
  const dock = process.platform === 'darwin' ? app.dock : undefined;
  if (!dock) return false;

  const icon = createPaddedDockIcon(iconPath);
  if (!icon) return false;

  dock.setIcon(icon);
  return true;
}

export function showMacDockWithPaddedIcon(iconPath?: string): void {
  const dock = process.platform === 'darwin' ? app.dock : undefined;
  if (!dock) return;

  const applyIcon = () => {
    setPaddedMacDockIcon(iconPath);
  };

  applyIcon();
  void dock.show().then(() => {
    applyIcon();
    setTimeout(applyIcon, 200);
  }).catch(() => {
    // Dock API may reject if macOS is in the middle of an activation-policy change.
  });
}
