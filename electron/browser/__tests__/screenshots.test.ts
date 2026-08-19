import { describe, expect, it, vi } from 'vitest';
import {
  browserScreenshotTiles,
  elementCaptureRect,
  fitBrowserScreenshotForModel,
  MAX_BROWSER_SCREENSHOT_ENCODED_BYTES,
  MAX_BROWSER_SCREENSHOT_TILE_HEIGHT,
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
