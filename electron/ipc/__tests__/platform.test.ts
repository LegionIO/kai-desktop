/**
 * Tests for the ui:set-dock-badge IPC handler (electron/ipc/platform.ts) — the
 * boundary that receives the dock-badge payload from the (untrusted) renderer.
 * It must clamp count to a non-negative finite int and coerce an unknown style
 * to 'dot' before forwarding to setDockBadge. `electron` + the badge setter are
 * mocked; a tiny ipcMain stub captures the handler.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const setDockBadgeMock = vi.fn();
vi.mock('../../platform/dock-badge.js', () => ({
  setDockBadge: (...args: unknown[]) => setDockBadgeMock(...args),
}));
vi.mock('../../platform/capabilities.js', () => ({
  getPlatformCapabilities: () => ({}),
}));

import { registerPlatformHandlers } from '../platform.js';

type Handler = (event: unknown, payload: unknown) => void;

function collectHandlers() {
  const handlers = new Map<string, Handler>();
  const ipcMain = { handle: (ch: string, fn: Handler) => handlers.set(ch, fn) };
  registerPlatformHandlers(ipcMain as never, () => null);
  return handlers;
}

describe('ui:set-dock-badge payload validation', () => {
  let badge: Handler;
  beforeEach(() => {
    setDockBadgeMock.mockReset();
    badge = collectHandlers().get('ui:set-dock-badge')!;
    expect(badge).toBeTypeOf('function');
  });

  const forwarded = () => setDockBadgeMock.mock.calls[0][1] as { count: number; hasText: boolean; style: string };

  it('forwards a valid payload unchanged', () => {
    badge({}, { count: 3, hasText: true, style: 'full' });
    expect(forwarded()).toEqual({ count: 3, hasText: true, style: 'full' });
  });

  it('clamps a negative count to 0', () => {
    badge({}, { count: -5, hasText: false, style: 'dot' });
    expect(forwarded().count).toBe(0);
  });

  it('truncates a fractional count', () => {
    badge({}, { count: 4.9, hasText: false, style: 'dot' });
    expect(forwarded().count).toBe(4);
  });

  it('defaults a non-finite / missing count to 0', () => {
    badge({}, { count: Number.POSITIVE_INFINITY });
    expect(forwarded().count).toBe(0);
    setDockBadgeMock.mockReset();
    badge({}, {});
    expect(forwarded().count).toBe(0);
  });

  it('coerces an unknown style to dot', () => {
    badge({}, { count: 1, style: 'evil-injection' });
    expect(forwarded().style).toBe('dot');
  });

  it('coerces a missing style to dot', () => {
    badge({}, { count: 1 });
    expect(forwarded().style).toBe('dot');
  });

  it('accepts each known style', () => {
    for (const s of ['dot', 'truncate', 'full']) {
      setDockBadgeMock.mockReset();
      badge({}, { count: 1, style: s });
      expect(forwarded().style).toBe(s);
    }
  });

  it('coerces hasText to a boolean', () => {
    badge({}, { count: 0, hasText: 'yes' as unknown });
    expect(forwarded().hasText).toBe(true);
  });
});
