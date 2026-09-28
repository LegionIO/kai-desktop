/**
 * The app-wide `login` listener fires for every auth challenge in the process,
 * including utility-process requests (plugin hosts), where Electron passes a
 * null webContents despite its typing. The handler must ignore those instead of
 * throwing an uncaught TypeError into the main process.
 */
import { describe, expect, it, vi } from 'vitest';

const electronMocks = vi.hoisted(() => ({ appOn: vi.fn() }));

vi.mock('electron', () => ({
  app: { on: electronMocks.appOn },
  BrowserWindow: { fromWebContents: vi.fn(() => null) },
  clipboard: {},
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  Menu: vi.fn(),
  MenuItem: vi.fn(),
  session: { fromPartition: vi.fn() },
  shell: {},
}));

vi.mock('../lifecycle.js', () => ({
  assertPluginBrowserPartitionAvailable: vi.fn(),
  beginPluginBrowserPartitionOperation: vi.fn(),
  initializePluginBrowserPartitionLifecycle: vi.fn(),
  trackPluginBrowserWindow: vi.fn(),
}));

import { initPluginBrowser } from '../index.js';

type LoginListener = (
  event: { preventDefault: () => void },
  webContents: { id: number } | null,
  details: unknown,
  authInfo: { host: string; realm: string; isProxy: boolean },
  callback: (username?: string, password?: string) => void,
) => void;

function loginListener(): LoginListener {
  initPluginBrowser({} as never, '/tmp/kai-plugin-browser-login-test');
  const listener = electronMocks.appOn.mock.calls.find(([event]) => event === 'login')?.[1] as LoginListener;
  expect(listener).toBeTypeOf('function');
  return listener;
}

describe('plugin browser login handler', () => {
  it('ignores a utility-process auth challenge that has no webContents', () => {
    const listener = loginListener();
    const event = { preventDefault: vi.fn() };
    const callback = vi.fn();

    expect(() =>
      listener(
        event,
        null,
        { url: 'https://example.com' },
        { host: 'example.com', realm: 'r', isProxy: false },
        callback,
      ),
    ).not.toThrow();
    // Not ours: leave the challenge for other listeners / Electron's default.
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(callback).not.toHaveBeenCalled();
  });

  it('still ignores webContents that are not plugin browser guests', () => {
    const listener = loginListener();
    const event = { preventDefault: vi.fn() };

    listener(event, { id: 999 }, {}, { host: 'example.com', realm: 'r', isProxy: false }, vi.fn());

    expect(event.preventDefault).not.toHaveBeenCalled();
  });
});
