export const MAX_BROWSER_SCREENSHOT_PIXELS = 16_000_000;
export const MAX_BROWSER_SCREENSHOT_DIMENSION = 16_384;
export const MAX_BROWSER_SCREENSHOT_TILE_HEIGHT = 4_096;
export const MAX_BROWSER_SCREENSHOT_ENCODED_BYTES = 24 * 1024 * 1024;
/** A menu preview is presentation-only and may be preempted after Electron has
 * already accepted its uncancellable native capture. Bound that one possible
 * overlap independently from a real screenshot's larger allocation budget. */
export const MAX_BROWSER_MENU_PREVIEW_NATIVE_PIXELS = 4_000_000;
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

export type BrowserScreenshotLayoutMetrics = {
  cssContentSize?: { width: number; height: number };
  contentSize?: { width: number; height: number };
  cssVisualViewport?: {
    pageX: number;
    pageY: number;
    clientWidth: number;
    clientHeight: number;
  };
};

export type BrowserScreenshotCaptureGeometry = {
  width: number;
  height: number;
  /** CDP Page.captureScreenshot clip scale that produces CSS-pixel output. */
  scale: number;
};

export type BrowserScreenshotViewportGeometry = BrowserScreenshotCaptureGeometry & {
  x: number;
  y: number;
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

/** Validate the physical-pixel allocation Electron may make for capturePage().
 * WebContentsView bounds are DIP while NativeImage dimensions follow display
 * scale, so the pre-allocation check must include the largest display scale. */
export function validateMenuPreviewNativeSize(
  width: number,
  height: number,
  displayScaleFactor = 1,
): { width: number; height: number } {
  if (!Number.isFinite(displayScaleFactor) || displayScaleFactor <= 0) {
    throw new Error('The display did not report a valid Browser menu preview scale.');
  }
  const physical = validateScreenshotSize(width * displayScaleFactor, height * displayScaleFactor);
  if (physical.width * physical.height > MAX_BROWSER_MENU_PREVIEW_NATIVE_PIXELS) {
    throw new Error(
      `Browser menu preview exceeds the safe ${MAX_BROWSER_MENU_PREVIEW_NATIVE_PIXELS.toLocaleString()} physical-pixel limit.`,
    );
  }
  return physical;
}

/**
 * Page.getLayoutMetrics reports modern CSS dimensions alongside deprecated
 * device-pixel dimensions. Page.captureScreenshot applies the target's device
 * scale to a clip unless its scale is compensated. Derive a conservative
 * inverse scale so a Retina renderer cannot allocate or return more pixels
 * than validateScreenshotSize approved, and so tiled images retain CSS-sized
 * offsets/canvases.
 */
function browserScreenshotDeviceScale(
  css: { width: number; height: number },
  device: { width: number; height: number },
): number {
  const ratios = [device.width / css.width, device.height / css.height];
  if (ratios.some((ratio) => !Number.isFinite(ratio) || ratio <= 0)) {
    throw new Error('The page did not report a valid screenshot device scale.');
  }
  // CDP accepts one clip scale for both axes. Derive the single least-squares
  // device scale and require both reported dimensions to fit it within one
  // independently rounded device pixel. Choosing either axis's raw ratio can
  // otherwise make tiled captures a pixel short/wide and leave seams (or make
  // Sharp reject a composite) on fractional-scale displays.
  const denominator = css.width * css.width + css.height * css.height;
  const deviceScaleFactor = (device.width * css.width + device.height * css.height) / denominator;
  if (
    !Number.isFinite(deviceScaleFactor) ||
    deviceScaleFactor <= 0 ||
    Math.abs(device.width - css.width * deviceScaleFactor) > 1 ||
    Math.abs(device.height - css.height * deviceScaleFactor) > 1
  ) {
    throw new Error('The page reported inconsistent horizontal and vertical screenshot device scales.');
  }
  return 1 / deviceScaleFactor;
}

export function browserScreenshotCaptureGeometry(
  metrics: BrowserScreenshotLayoutMetrics,
): BrowserScreenshotCaptureGeometry {
  const css = metrics.cssContentSize;
  const device = metrics.contentSize;
  if (!css || !device) {
    throw new Error('The page did not report both CSS and device screenshot dimensions.');
  }
  const size = validateScreenshotSize(css.width, css.height);
  return { ...size, scale: browserScreenshotDeviceScale(css, device) };
}

/** capturePage can stop resolving while a BrowserWindow is minimized. Derive
 * a bounded current-viewport CDP clip so hidden/headless captures do not depend
 * on the native view being painted or presented. */
export function browserScreenshotViewportGeometry(
  metrics: BrowserScreenshotLayoutMetrics,
): BrowserScreenshotViewportGeometry {
  const viewport = metrics.cssVisualViewport;
  const cssContent = metrics.cssContentSize;
  const deviceContent = metrics.contentSize;
  if (!viewport || !cssContent || !deviceContent) {
    throw new Error('The page did not report CSS viewport and device screenshot dimensions.');
  }
  const values = [viewport.pageX, viewport.pageY, viewport.clientWidth, viewport.clientHeight];
  if (!values.every(Number.isFinite) || viewport.pageX < 0 || viewport.pageY < 0) {
    throw new Error('The page did not report finite viewport screenshot bounds.');
  }
  const size = validateScreenshotSize(viewport.clientWidth, viewport.clientHeight);
  return {
    x: Math.floor(viewport.pageX),
    y: Math.floor(viewport.pageY),
    ...size,
    scale: browserScreenshotDeviceScale(cssContent, deviceContent),
  };
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
