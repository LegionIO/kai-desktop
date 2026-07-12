/**
 * Tests for the cross-platform dock/taskbar badge (electron/platform/dock-badge.ts).
 * Verifies the per-OS dispatch (macOS app.dock.setBadge / Windows
 * setOverlayIcon / Linux app.setBadgeCount), the macOS badge-text logic
 * (count wins, else a dot for a text badge, else cleared), and that failures
 * never throw. `electron` is mocked; `process.platform` is swapped per test.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const dock = { setBadge: vi.fn() };
const appMock = { dock, setBadgeCount: vi.fn() };
const nativeImageMock = {
  createFromDataURL: vi.fn(() => ({ isEmpty: () => false })),
};
vi.mock('electron', () => ({
  app: appMock,
  BrowserWindow: class {},
  nativeImage: nativeImageMock,
}));

const { setDockBadge, clearDockBadge } = await import('../dock-badge.js');

const realPlatform = process.platform;
function setPlatform(p: NodeJS.Platform) {
  Object.defineProperty(process, 'platform', { value: p, configurable: true });
}
beforeEach(() => vi.clearAllMocks());
afterEach(() => Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true }));

describe('setDockBadge — macOS', () => {
  beforeEach(() => setPlatform('darwin'));

  it('shows a numeric count', () => {
    setDockBadge(null, { count: 3, hasText: false, style: 'dot' });
    expect(dock.setBadge).toHaveBeenCalledWith('3');
  });
  it('caps the count at 99+', () => {
    setDockBadge(null, { count: 250, hasText: false, style: 'dot' });
    expect(dock.setBadge).toHaveBeenCalledWith('99+');
  });
  it('shows a dot for a text-only badge', () => {
    setDockBadge(null, { count: 0, hasText: true, style: 'dot' });
    expect(dock.setBadge).toHaveBeenCalledWith('●');
  });
  it('clears when there is nothing to show', () => {
    setDockBadge(null, { count: 0, hasText: false, style: 'dot' });
    expect(dock.setBadge).toHaveBeenCalledWith('');
  });
  it('count wins over a text badge', () => {
    setDockBadge(null, { count: 5, hasText: true, style: 'dot' });
    expect(dock.setBadge).toHaveBeenCalledWith('5');
  });
});

describe('setDockBadge — Windows', () => {
  beforeEach(() => setPlatform('win32'));

  it('sets a taskbar overlay icon for a count', () => {
    const win = { isDestroyed: () => false, setOverlayIcon: vi.fn() };
    setDockBadge(win as never, { count: 2, hasText: false, style: 'dot' });
    expect(win.setOverlayIcon).toHaveBeenCalledTimes(1);
    expect(win.setOverlayIcon.mock.calls[0][1]).toMatch(/2 notifications/);
  });
  it('clears the overlay (null image) when empty', () => {
    const win = { isDestroyed: () => false, setOverlayIcon: vi.fn() };
    setDockBadge(win as never, { count: 0, hasText: false, style: 'dot' });
    expect(win.setOverlayIcon).toHaveBeenCalledWith(null, '');
  });
  it('is a no-op when the window is destroyed', () => {
    const win = { isDestroyed: () => true, setOverlayIcon: vi.fn() };
    setDockBadge(win as never, { count: 2, hasText: false, style: 'dot' });
    expect(win.setOverlayIcon).not.toHaveBeenCalled();
  });
});

describe('setDockBadge — Linux', () => {
  beforeEach(() => setPlatform('linux'));

  it('sets the Unity launcher count', () => {
    setDockBadge(null, { count: 4, hasText: false, style: 'dot' });
    expect(appMock.setBadgeCount).toHaveBeenCalledWith(4);
  });
  it('maps a text-only badge to a presence count of 1', () => {
    setDockBadge(null, { count: 0, hasText: true, style: 'dot' });
    expect(appMock.setBadgeCount).toHaveBeenCalledWith(1);
  });
  it('clears with 0', () => {
    clearDockBadge(null);
    expect(appMock.setBadgeCount).toHaveBeenCalledWith(0);
  });
});

describe('setDockBadge — robustness', () => {
  it('never throws if the platform API throws', () => {
    setPlatform('darwin');
    dock.setBadge.mockImplementationOnce(() => {
      throw new Error('boom');
    });
    expect(() => setDockBadge(null, { count: 1, hasText: false, style: 'dot' })).not.toThrow();
  });
});
