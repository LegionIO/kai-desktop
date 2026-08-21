import { describe, expect, it, vi } from 'vitest';
import {
  browserScreenshotCaptureGeometry,
  browserScreenshotTiles,
  browserScreenshotViewportGeometry,
  elementCaptureRect,
  fitBrowserScreenshotForModel,
  MAX_BROWSER_MENU_PREVIEW_NATIVE_PIXELS,
  MAX_BROWSER_SCREENSHOT_ENCODED_BYTES,
  MAX_BROWSER_SCREENSHOT_TILE_HEIGHT,
  validateMenuPreviewNativeSize,
  validateScreenshotEncodedBytes,
  validateScreenshotSize,
} from '../screenshots.js';

describe('browser screenshot bounds', () => {
  it('rounds safe complete-page dimensions and rejects pathological pages', () => {
    expect(validateScreenshotSize(100.2, 200.1)).toEqual({ width: 101, height: 201 });
    expect(() => validateScreenshotSize(0, 100)).toThrow(/capturable/);
    expect(() => validateScreenshotSize(Number.NaN, 100)).toThrow(/finite capturable/);
    expect(() => validateScreenshotSize(100, Number.POSITIVE_INFINITY)).toThrow(/finite capturable/);
    expect(() => validateScreenshotSize(20_000, 100)).toThrow(/safe/);
    expect(() => validateScreenshotSize(12_000, 12_000)).toThrow(/safe/);
  });

  it('independently caps a preemptible native menu-preview allocation at display scale', () => {
    expect(validateMenuPreviewNativeSize(1_000, 1_000, 2)).toEqual({ width: 2_000, height: 2_000 });
    expect(2_000 * 2_000).toBe(MAX_BROWSER_MENU_PREVIEW_NATIVE_PIXELS);
    expect(() => validateMenuPreviewNativeSize(1_001, 1_000, 2)).toThrow(/menu preview.*physical-pixel limit/i);
    expect(() => validateMenuPreviewNativeSize(100, 100, 0)).toThrow(/valid .*scale/i);
  });

  it('intersects element captures with every document edge', () => {
    expect(elementCaptureRect({ x: -10, y: -8, width: 40.2, height: 20.2 }, { width: 25, height: 10 })).toEqual({
      x: 0,
      y: 0,
      width: 25,
      height: 10,
    });
    expect(elementCaptureRect({ x: 90, y: 95, width: 40.2, height: 20.2 }, { width: 100, height: 100 })).toEqual({
      x: 90,
      y: 95,
      width: 10,
      height: 5,
    });
  });

  it('rejects non-finite and empty element intersections', () => {
    expect(() => elementCaptureRect({ x: 101, y: 20, width: 10, height: 10 }, { width: 100, height: 100 })).toThrow(
      /no capturable document intersection/i,
    );
    expect(() =>
      elementCaptureRect({ x: Number.NaN, y: 0, width: 10, height: 10 }, { width: 100, height: 100 }),
    ).toThrow(/finite element screenshot bounds/i);
  });

  it('tiles long pages into bounded CDP captures', () => {
    expect(browserScreenshotTiles(1_000, MAX_BROWSER_SCREENSHOT_TILE_HEIGHT * 2 + 10)).toEqual([
      { x: 0, y: 0, width: 1_000, height: MAX_BROWSER_SCREENSHOT_TILE_HEIGHT },
      {
        x: 0,
        y: MAX_BROWSER_SCREENSHOT_TILE_HEIGHT,
        width: 1_000,
        height: MAX_BROWSER_SCREENSHOT_TILE_HEIGHT,
      },
      { x: 0, y: MAX_BROWSER_SCREENSHOT_TILE_HEIGHT * 2, width: 1_000, height: 10 },
    ]);
  });

  it('compensates CDP clips for Retina device scale before capture allocation', () => {
    expect(
      browserScreenshotCaptureGeometry({
        cssContentSize: { width: 4_000, height: 2_000 },
        contentSize: { width: 8_000, height: 4_000 },
      }),
    ).toEqual({ width: 4_000, height: 2_000, scale: 0.5 });

    expect(
      browserScreenshotCaptureGeometry({
        cssContentSize: { width: 100, height: 100 },
        contentSize: { width: 150, height: 151 },
      }).scale,
    ).toBeCloseTo(1 / 1.505);

    expect(
      browserScreenshotCaptureGeometry({
        cssContentSize: { width: 2_000, height: 1_000 },
        contentSize: { width: 1_000, height: 500 },
      }),
    ).toEqual({ width: 2_000, height: 1_000, scale: 2 });
  });

  it('fails closed when CDP omits dimensions needed to bound device-scaled output', () => {
    expect(() => browserScreenshotCaptureGeometry({ cssContentSize: { width: 100, height: 100 } })).toThrow(
      /both CSS and device/i,
    );
    expect(() =>
      browserScreenshotCaptureGeometry({
        cssContentSize: { width: 100, height: 100 },
        contentSize: { width: Number.NaN, height: 100 },
      }),
    ).toThrow(/device scale/i);
    expect(() =>
      browserScreenshotCaptureGeometry({
        cssContentSize: { width: 4_000, height: 2_000 },
        contentSize: { width: 6_000, height: 4_000 },
      }),
    ).toThrow(/inconsistent horizontal and vertical/i);
  });

  it('derives a bounded scrolled viewport clip for hidden CDP capture', () => {
    expect(
      browserScreenshotViewportGeometry({
        cssContentSize: { width: 4_000, height: 8_000 },
        contentSize: { width: 8_000, height: 16_000 },
        cssVisualViewport: { pageX: 10.9, pageY: 200.4, clientWidth: 1_280, clientHeight: 800 },
      }),
    ).toEqual({ x: 10, y: 200, width: 1_280, height: 800, scale: 0.5 });
  });

  it('fails closed on missing, negative, or oversized viewport geometry', () => {
    expect(() =>
      browserScreenshotViewportGeometry({
        cssContentSize: { width: 100, height: 100 },
        contentSize: { width: 100, height: 100 },
      }),
    ).toThrow(/CSS viewport and device/i);
    expect(() =>
      browserScreenshotViewportGeometry({
        cssContentSize: { width: 100, height: 100 },
        contentSize: { width: 100, height: 100 },
        cssVisualViewport: { pageX: -1, pageY: 0, clientWidth: 100, clientHeight: 100 },
      }),
    ).toThrow(/finite viewport/i);
    expect(() =>
      browserScreenshotViewportGeometry({
        cssContentSize: { width: 20_000, height: 20_000 },
        contentSize: { width: 20_000, height: 20_000 },
        cssVisualViewport: { pageX: 0, pageY: 0, clientWidth: 20_000, clientHeight: 20_000 },
      }),
    ).toThrow(/safe/i);
  });

  it('bounds encoded PNG memory independently of page dimensions', () => {
    expect(() => validateScreenshotEncodedBytes(MAX_BROWSER_SCREENSHOT_ENCODED_BYTES)).not.toThrow();
    expect(() => validateScreenshotEncodedBytes(MAX_BROWSER_SCREENSHOT_ENCODED_BYTES + 1)).toThrow(/encoded-image/);
  });

  it('keeps small PNGs intact and proportionally fits oversized model copies', async () => {
    const small = Buffer.from('small');
    await expect(fitBrowserScreenshotForModel(small, 20, 20, 100)).resolves.toEqual({
      data: small,
      mimeType: 'image/png',
      width: 20,
      height: 20,
    });

    const encode = async (_input: Buffer, options: { width: number; height: number; quality: number }) => ({
      data: Buffer.alloc(options.width * options.height),
      mimeType: 'image/jpeg' as const,
      width: options.width,
      height: options.height,
    });
    const fitted = await fitBrowserScreenshotForModel(Buffer.alloc(101), 20, 20, 100, encode);
    expect(fitted.mimeType).toBe('image/jpeg');
    expect(fitted.data.byteLength).toBeLessThanOrEqual(100);
    expect(fitted.width).toBeLessThan(20);
    expect(fitted.height).toBeLessThan(20);
  });

  it('stops model-image retries when the assistant turn is cancelled', async () => {
    const controller = new AbortController();
    const encode = vi.fn(async () => {
      controller.abort();
      return {
        data: Buffer.alloc(101),
        mimeType: 'image/jpeg' as const,
        width: 20,
        height: 20,
      };
    });

    await expect(
      fitBrowserScreenshotForModel(Buffer.alloc(101), 20, 20, 100, encode, controller.signal),
    ).rejects.toThrow(/cancelled/);
    expect(encode).toHaveBeenCalledOnce();
  });
});
