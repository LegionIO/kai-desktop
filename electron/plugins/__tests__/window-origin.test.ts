import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PluginInstance } from '../types.js';

const mocks = vi.hoisted(() => ({ createWindow: vi.fn(), openBrowser: vi.fn() }));
vi.mock('electron', () => ({
  app: { getVersion: () => '1.0.0' },
  BrowserWindow: class {
    constructor(options: unknown) {
      return mocks.createWindow(options);
    }
  },
}));
vi.mock('../browser-window/index.js', () => ({ openPluginBrowserWindow: mocks.openBrowser }));

import { createPluginAPI } from '../plugin-api.js';

function pluginAPI(name: string, displayName: string) {
  const instance = {
    manifest: { name, displayName, permissions: ['auth:window', 'browser:window'] },
    dir: `/plugins/${name}`,
  } as PluginInstance;
  return createPluginAPI(instance, {} as Parameters<typeof createPluginAPI>[1]);
}

function authWindow() {
  let title = '';
  let visible = false;
  const contents = Object.assign(new EventEmitter(), {
    loadURL: vi.fn(async () => {}),
    isDestroyed: () => false,
    setUserAgent: vi.fn(),
  });
  const win = Object.assign(new EventEmitter(), {
    webContents: contents,
    setTitle: vi.fn((value: string) => {
      title = value;
    }),
    getTitle: () => title,
    isDestroyed: () => false,
    isVisible: () => visible,
    show: vi.fn(() => {
      visible = true;
    }),
    focus: vi.fn(),
    close: vi.fn(() => {
      win.emit('closed');
    }),
    loadURL: contents.loadURL,
  });
  return win;
}

beforeEach(() => {
  vi.useFakeTimers();
  mocks.createWindow.mockReset();
  mocks.openBrowser.mockReset();
});
afterEach(() => vi.useRealTimers());

describe('plugin browser window origin', () => {
  it('keeps simultaneous login windows attributable when the provider changes their titles', async () => {
    const pim = authWindow();
    const skynet = authWindow();
    mocks.createWindow.mockReturnValueOnce(pim).mockReturnValueOnce(skynet);
    const options = { url: 'https://login.microsoftonline.com/', title: 'Azure Sign In', showOnCreate: false };
    const pendingPim = pluginAPI('pim', 'PIM').auth.openAuthWindow(options);
    const pendingSkynet = pluginAPI('skynet', 'Skynet').auth.openAuthWindow(options);

    expect(pim.getTitle()).toBe('PIM (pim) — Azure Sign In');
    expect(skynet.getTitle()).toBe('Skynet (skynet) — Azure Sign In');
    for (const win of [pim, skynet]) {
      const event = { preventDefault: vi.fn() };
      win.emit('page-title-updated', event, 'Sign in to your account', true);
      expect(event.preventDefault).toHaveBeenCalledOnce();
      expect(win.setTitle).toHaveBeenCalledOnce();
      win.close();
    }
    expect(await pendingPim).toEqual({ success: false, error: 'Auth window closed' });
    expect(await pendingSkynet).toEqual({ success: false, error: 'Auth window closed' });
  });

  it('labels a hidden auth window before it is revealed and preserves callback completion', async () => {
    const win = authWindow();
    mocks.createWindow.mockReturnValue(win);
    const pending = pluginAPI('msgraph', 'Microsoft Graph').auth.openAuthWindow({
      url: 'https://login.microsoftonline.com/',
      callbackMatch: 'https://callback.example/',
      extractParams: ['code'],
      showOnCreate: false,
      showAfterMs: 1000,
    });
    expect(win.getTitle()).toBe('Microsoft Graph (msgraph) — Sign In');
    expect(win.show).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(win.show).toHaveBeenCalledOnce();
    expect(win.getTitle()).toBe('Microsoft Graph (msgraph) — Sign In');

    win.webContents.emit('will-redirect', {}, 'https://callback.example/?code=fixture-code');
    expect(await pending).toEqual({ success: true, params: { code: 'fixture-code' } });
    await vi.advanceTimersByTimeAsync(2000);
    expect(win.close).toHaveBeenCalledOnce();
  });

  it('passes the owning plugin identity to browser chrome independently of browser options', () => {
    const options = {
      url: 'https://login.microsoftonline.com/',
      title: 'Azure Sign In',
      origin: { name: 'someone-else', displayName: 'Someone else' },
    };
    pluginAPI('pim', 'PIM').browser.open(options);
    expect(mocks.openBrowser).toHaveBeenCalledWith(options, { name: 'pim', displayName: 'PIM' });
  });
});
