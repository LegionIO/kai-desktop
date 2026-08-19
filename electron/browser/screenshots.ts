export const MAX_BROWSER_SCREENSHOT_PIXELS = 16_000_000;
export const MAX_BROWSER_SCREENSHOT_DIMENSION = 16_384;
export const MAX_BROWSER_SCREENSHOT_TILE_HEIGHT = 4_096;
export const MAX_BROWSER_SCREENSHOT_ENCODED_BYTES = 24 * 1024 * 1024;
// `_modelContent` drops any single image above 5 MiB. Leave a small margin for
// base64-size estimation so a screenshot that fits here is guaranteed to
// survive the shared model-content sanitizer.
export const MAX_BROWSER_MODEL_SCREENSHOT_BYTES = 5 * 1024 * 1024 - 64 * 1024;

export type BrowserScreenshotTile = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type BrowserModelScreenshot = {
  data: Buffer;
  mimeType: 'image/png' | 'image/jpeg';
  width: number;
  height: number;
};

export type BrowserModelScreenshotEncoder = (
  input: Buffer,
  options: { width: number; height: number; quality: number },
) => Promise<BrowserModelScreenshot>;

const encodeBrowserScreenshotJpeg: BrowserModelScreenshotEncoder = async (input, options) => {
  const sharp = (await import('sharp')).default;
  const { data, info } = await sharp(input, { limitInputPixels: MAX_BROWSER_SCREENSHOT_PIXELS })
    .flatten({ background: '#ffffff' })
    .resize({
      width: options.width,
      height: options.height,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .jpeg({ quality: options.quality, mozjpeg: true })
    .toBuffer({ resolveWithObject: true });
  return { data, mimeType: 'image/jpeg', width: info.width, height: info.height };
};

/** Preserve the original PNG for file retention/export while fitting the
 * model-visible copy below the shared 5 MiB media ceiling. Oversized images are
 * flattened and encoded as JPEG, then proportionally reduced until bounded. */
export async function fitBrowserScreenshotForModel(
  png: Buffer,
  width: number,
  height: number,
  maxBytes = MAX_BROWSER_MODEL_SCREENSHOT_BYTES,
  encode: BrowserModelScreenshotEncoder = encodeBrowserScreenshotJpeg,
  abortSignal?: AbortSignal,
): Promise<BrowserModelScreenshot> {
  const assertActive = (): void => {
    if (abortSignal?.aborted) throw new Error('Browser screenshot processing was cancelled.');
  };
  assertActive();
  const size = validateScreenshotSize(width, height);
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) throw new Error('Model screenshot byte limit must be positive.');
  if (png.byteLength <= maxBytes) {
    return { data: png, mimeType: 'image/png', width: size.width, height: size.height };
  }

  let targetWidth = size.width;
  let targetHeight = size.height;
  let quality = 82;
  for (let attempt = 0; attempt < 12; attempt++) {
    assertActive();
    const encoded = await encode(png, { width: targetWidth, height: targetHeight, quality });
    assertActive();
    if (encoded.data.byteLength <= maxBytes) return encoded;

    const ratio = Math.min(0.9, Math.sqrt(maxBytes / encoded.data.byteLength) * 0.9);
    const nextWidth = Math.max(1, Math.floor(encoded.width * ratio));
    const nextHeight = Math.max(1, Math.floor(encoded.height * ratio));
    targetWidth = nextWidth === targetWidth && targetWidth > 1 ? targetWidth - 1 : nextWidth;
    targetHeight = nextHeight === targetHeight && targetHeight > 1 ? targetHeight - 1 : nextHeight;
    quality = Math.max(45, quality - 4);
  }
  throw new Error('Browser screenshot could not be compressed below the model media limit.');
}

export function validateScreenshotSize(width: number, height: number): { width: number; height: number } {
  if (!Number.isFinite(width) || !Number.isFinite(height)) {
    throw new Error('The page did not report a finite capturable size.');
  }
  const normalized = { width: Math.ceil(width), height: Math.ceil(height) };
  if (normalized.width <= 0 || normalized.height <= 0) throw new Error('The page did not report a capturable size.');
  if (
    normalized.width > MAX_BROWSER_SCREENSHOT_DIMENSION ||
    normalized.height > MAX_BROWSER_SCREENSHOT_DIMENSION ||
    normalized.width * normalized.height > MAX_BROWSER_SCREENSHOT_PIXELS
  ) {
    throw new Error(
      `Complete-page capture exceeds the safe ${MAX_BROWSER_SCREENSHOT_DIMENSION}px / ${MAX_BROWSER_SCREENSHOT_PIXELS.toLocaleString()} pixel limit.`,
    );
  }
  return normalized;
}

export function browserScreenshotTiles(width: number, height: number): BrowserScreenshotTile[] {
  const size = validateScreenshotSize(width, height);
  const tiles: BrowserScreenshotTile[] = [];
  for (let y = 0; y < size.height; y += MAX_BROWSER_SCREENSHOT_TILE_HEIGHT) {
    tiles.push({
      x: 0,
      y,
      width: size.width,
      height: Math.min(MAX_BROWSER_SCREENSHOT_TILE_HEIGHT, size.height - y),
    });
  }
  return tiles;
}

export function validateScreenshotEncodedBytes(bytes: number): void {
  if (!Number.isFinite(bytes) || bytes < 0 || bytes > MAX_BROWSER_SCREENSHOT_ENCODED_BYTES) {
    throw new Error(
      `Browser screenshot exceeds the safe ${Math.floor(MAX_BROWSER_SCREENSHOT_ENCODED_BYTES / 1024 / 1024)} MiB encoded-image limit.`,
    );
  }
}

export function elementCaptureRect(
  rect: { x: number; y: number; width: number; height: number },
  documentSize: { width: number; height: number },
): BrowserScreenshotTile {
  const values = [rect.x, rect.y, rect.width, rect.height, documentSize.width, documentSize.height];
  if (!values.every(Number.isFinite)) {
    throw new Error('The page did not report finite element screenshot bounds.');
  }
  if (rect.width <= 0 || rect.height <= 0 || documentSize.width <= 0 || documentSize.height <= 0) {
    throw new Error('The selected element has no capturable document intersection.');
  }

  // CDP clips are document-relative. Intersect both edges before rounding so
  // an element transformed partly outside the document cannot retain its full
  // width/height after the origin is clamped to zero (or past the far edge).
  const x = Math.max(0, Math.floor(rect.x));
  const y = Math.max(0, Math.floor(rect.y));
  const right = Math.min(Math.ceil(documentSize.width), Math.ceil(rect.x + rect.width));
  const bottom = Math.min(Math.ceil(documentSize.height), Math.ceil(rect.y + rect.height));
  if (right <= x || bottom <= y) {
    throw new Error('The selected element has no capturable document intersection.');
  }
  const size = validateScreenshotSize(right - x, bottom - y);
  return { x, y, width: size.width, height: size.height };
}
