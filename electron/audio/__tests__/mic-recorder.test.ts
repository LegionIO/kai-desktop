/**
 * Tests for mic-recorder.ts deviceId validators (via __internal). A renderer-
 * supplied deviceId / deviceIds is JSON.stringify'd into a `window._mic.*(...)`
 * expression executed via executeJavaScript in the hidden mic window. IPC JSON
 * does not enforce the declared `string` / `string[]` types, so the stt handlers
 * (start-recording, start-monitor, live-mic-start) reject a non-string id up
 * front — matching the guard streaming-stt.ts already had. JSON.stringify alone
 * prevents a JS breakout; this is contract enforcement + defense-in-depth.
 */
import { describe, it, expect, vi } from 'vitest';

// mic-recorder.ts imports electron + ../ipc/usage.js at module load.
vi.mock('electron', () => ({ BrowserWindow: class {}, app: { getPath: () => '/tmp' } }));
vi.mock('../../ipc/usage.js', () => ({ recordUsageEvent: vi.fn() }));
vi.mock('../../utils/user-agent.js', () => ({ applyBrandUserAgent: vi.fn() }));

import { __internal } from '../mic-recorder.js';

const { isValidDeviceId, isValidDeviceIdList } = __internal;

describe('isValidDeviceId', () => {
  it('accepts a string or null/undefined (default device)', () => {
    expect(isValidDeviceId('abc123')).toBe(true);
    expect(isValidDeviceId('')).toBe(true);
    expect(isValidDeviceId(null)).toBe(true);
    expect(isValidDeviceId(undefined)).toBe(true);
  });

  it('rejects non-string junk that IPC JSON could smuggle in', () => {
    for (const bad of [42, true, {}, [], { toString: () => 'x' }, ['a']]) {
      expect(isValidDeviceId(bad), JSON.stringify(bad)).toBe(false);
    }
  });
});

describe('isValidDeviceIdList', () => {
  it('accepts an all-string array or null/undefined', () => {
    expect(isValidDeviceIdList(['a', 'b'])).toBe(true);
    expect(isValidDeviceIdList([])).toBe(true);
    expect(isValidDeviceIdList(null)).toBe(true);
    expect(isValidDeviceIdList(undefined)).toBe(true);
  });

  it('rejects a non-array, or an array with any non-string element', () => {
    expect(isValidDeviceIdList('a')).toBe(false); // string is not an array here
    expect(isValidDeviceIdList(42)).toBe(false);
    expect(isValidDeviceIdList({})).toBe(false);
    expect(isValidDeviceIdList(['a', 1])).toBe(false);
    expect(isValidDeviceIdList(['a', null])).toBe(false);
    expect(isValidDeviceIdList([{}])).toBe(false);
  });
});
