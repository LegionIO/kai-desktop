import { nativeImage, type NativeImage } from 'electron';
import { existsSync } from 'fs';

const DOCK_SIZE = 128;
const ARTWORK_SCALE = 0.80;

export function createPaddedDockIcon(iconPath: string): NativeImage | null {
  if (!existsSync(iconPath)) return null;

  const artworkSize = Math.round(DOCK_SIZE * ARTWORK_SCALE);
  const offset = Math.round((DOCK_SIZE - artworkSize) / 2);
  const artwork = nativeImage.createFromPath(iconPath).resize({ width: artworkSize, height: artworkSize });
  if (artwork.isEmpty()) return null;

  const canvas = Buffer.alloc(DOCK_SIZE * DOCK_SIZE * 4, 0);
  const pixels = artwork.toBitmap();
  for (let y = 0; y < artworkSize; y++) {
    pixels.copy(canvas, ((y + offset) * DOCK_SIZE + offset) * 4, y * artworkSize * 4, (y + 1) * artworkSize * 4);
  }

  return nativeImage.createFromBuffer(canvas, { width: DOCK_SIZE, height: DOCK_SIZE });
}
