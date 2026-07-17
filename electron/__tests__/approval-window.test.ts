import { describe, it, expect, beforeEach, vi } from 'vitest';

// Minimal electron mock: a fake BrowserWindow that records construction and
// destroy, plus screen + ipcMain stubs the module touches.
type FakeWin = {
  destroyed: boolean;
  listeners: Record<string, () => void>;
  isDestroyed: () => boolean;
  destroy: () => void;
  on: (ev: string, cb: () => void) => void;
  once: (ev: string, cb: () => void) => void;
  show: () => void;
  showInactive: () => void;
  isVisible: () => boolean;
  setAlwaysOnTop: () => void;
  setVisibleOnAllWorkspaces: () => void;
  webContents: { send: () => void; isDestroyed: () => boolean };
};

const constructed: FakeWin[] = [];

vi.mock('electron', () => {
  class BrowserWindow {
    destroyed = false;
    listeners: Record<string, () => void> = {};
    webContents = { send: vi.fn(), isDestroyed: () => this.destroyed };
    constructor() {
      constructed.push(this as unknown as FakeWin);
    }
    isDestroyed() {
      return this.destroyed;
    }
    destroy() {
      this.destroyed = true;
      this.listeners['closed']?.();
    }
    on(ev: string, cb: () => void) {
      this.listeners[ev] = cb;
    }
    once(ev: string, cb: () => void) {
      this.listeners[ev] = cb;
    }
    show() {}
    showInactive() {}
    loadFile() {
      return Promise.resolve();
    }
    loadURL() {
      return Promise.resolve();
    }
    isVisible() {
      return true;
    }
    setAlwaysOnTop() {}
    setVisibleOnAllWorkspaces() {}
  }
  return {
    app: { isActive: () => false, hide: vi.fn() },
    BrowserWindow,
    ipcMain: { on: vi.fn() },
    screen: {
      getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1440, height: 900 } }),
    },
  };
});
vi.mock('../utils/user-agent.js', () => ({ applyBrandUserAgent: () => {} }));
vi.mock('../utils/dock-icon.js', () => ({ showMacDockWithPaddedIcon: () => {} }));

import {
  openApprovalWindow,
  closeApprovalWindow,
  hasApprovalWindow,
  closeAllApprovalWindows,
} from '../approval-window.js';

const req = (id: string) => ({ approvalId: id, conversationId: 'c1', toolName: 'sh', args: {} });

beforeEach(() => {
  constructed.length = 0;
  closeAllApprovalWindows();
});

describe('approval-window dedup + lifecycle', () => {
  it('opens one window per approvalId and reuses it on a repeat open', () => {
    openApprovalWindow(req('a'));
    openApprovalWindow(req('a')); // same id — must reuse, not construct a 2nd
    expect(constructed).toHaveLength(1);
    expect(hasApprovalWindow('a')).toBe(true);
  });

  it('opens distinct windows for distinct ids', () => {
    openApprovalWindow(req('a'));
    openApprovalWindow(req('b'));
    expect(constructed).toHaveLength(2);
    expect(hasApprovalWindow('a')).toBe(true);
    expect(hasApprovalWindow('b')).toBe(true);
  });

  it('close destroys the window and is idempotent', () => {
    openApprovalWindow(req('a'));
    closeApprovalWindow('a');
    expect(hasApprovalWindow('a')).toBe(false);
    expect(constructed[0].destroyed).toBe(true);
    // Second close is a no-op (no throw).
    expect(() => closeApprovalWindow('a')).not.toThrow();
  });

  it('closeAll destroys every window', () => {
    openApprovalWindow(req('a'));
    openApprovalWindow(req('b'));
    closeAllApprovalWindows();
    expect(hasApprovalWindow('a')).toBe(false);
    expect(hasApprovalWindow('b')).toBe(false);
    expect(constructed.every((w) => w.destroyed)).toBe(true);
  });
});
