import { describe, expect, it } from 'vitest';
import { sanitizeRealtimeToolResult } from '../tool-result.js';
import { redactBrowserToolErrorForExposure } from '../../../shared/browser.js';

describe('Realtime tool-result sanitization', () => {
  it('removes screenshot model content before JSON/compaction delivery', () => {
    const hugeBase64 = 'A'.repeat(2_000_000);
    const sanitized = sanitizeRealtimeToolResult({
      tabId: 'tab-1',
      width: 800,
      _modelContent: [{ type: 'image', data: hugeBase64, mediaType: 'image/png' }],
    });

    expect(sanitized).toEqual({
      tabId: 'tab-1',
      width: 800,
      mediaOmitted: true,
      mediaNotice: 'Native image/file content is unavailable during a Realtime call.',
    });
    expect(JSON.stringify(sanitized)).not.toContain(hugeBase64.slice(0, 100));
  });

  it('leaves ordinary tool results unchanged', () => {
    const result = { value: 'small' };
    expect(sanitizeRealtimeToolResult(result)).toBe(result);
  });

  it('preserves the exact omission note when media is too large to retain', () => {
    const oversizedBase64 = 'A'.repeat(8 * 1024 * 1024);
    expect(
      sanitizeRealtimeToolResult({
        tabId: 'tab-1',
        _modelContent: [{ type: 'image', data: oversizedBase64, mediaType: 'image/png' }],
      }),
    ).toEqual({
      tabId: 'tab-1',
      mediaOmitted: true,
      mediaNotice: '[image omitted: 6.0 MB exceeds the per-result media limit]',
    });
  });

  it('redacts secret-bearing locations from Browser failures only', () => {
    const secret = 'https://user:password@example.com/account/reset?token=top-secret#code';
    expect(redactBrowserToolErrorForExposure('browser_action', new Error(`ERR_FAILED while loading '${secret}'`))).toBe(
      "ERR_FAILED while loading '[redacted browser URL: https://example.com]'",
    );
    expect(redactBrowserToolErrorForExposure('search', new Error(`Could not fetch ${secret}`))).toContain(secret);
  });

  it('does not expose a URL suffix after valid closing punctuation characters', () => {
    const secret = 'https://example.com/reset/(account)[primary]?token=top-secret';
    const exposed = redactBrowserToolErrorForExposure('browser_action', new Error(`Failed at ${secret}`));
    expect(exposed).toBe('Failed at [redacted browser URL: https://example.com]');
    expect(exposed).not.toContain('top-secret');
    expect(exposed).not.toContain('[primary]');
  });

  it('keeps an already-redacted Browser origin stable across trust boundaries', () => {
    const once = redactBrowserToolErrorForExposure(
      'browser_action',
      new Error('Failed at https://user:password@example.com/account?token=secret'),
    );
    expect(redactBrowserToolErrorForExposure('browser_action', new Error(once))).toBe(once);
    expect(
      redactBrowserToolErrorForExposure(
        'browser_action',
        new Error('Failed at [redacted browser URL: https://example.com/account?token=forged]'),
      ),
    ).not.toContain('token=forged');
  });
});
