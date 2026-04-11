import type { IpcMain, IpcMainInvokeEvent, IpcMainEvent } from 'electron';

type HandlerFn = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;
type ListenerFn = (event: IpcMainEvent, ...args: unknown[]) => void;

/** Captured IPC handlers keyed by channel name (from ipcMain.handle). */
const handlers = new Map<string, HandlerFn>();

/** Captured IPC listeners keyed by channel name (from ipcMain.on). */
const listeners = new Map<string, ListenerFn>();

/** Channels that rely on Electron APIs unavailable in web mode. */
const UNSUPPORTED_CHANNELS = new Set([
  'dialog:open-file',
  'dialog:open-directory',
  'dialog:open-directory-files',
  'image:fetch',
  'image:save',
]);

/**
 * Monkey-patches `ipcMain.handle` and `ipcMain.on` so that every handler/listener
 * registered after this call is also stored in internal maps.
 * Must be called **before** any `registerXxxHandlers()` calls.
 */
export function installIpcCapture(ipcMain: IpcMain): void {
  const originalHandle = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (channel: string, listener: HandlerFn) => {
    handlers.set(channel, listener);
    return originalHandle(channel, listener);
  };

  const originalOn = ipcMain.on.bind(ipcMain);
  (ipcMain as unknown as { on: (channel: string, listener: (...args: unknown[]) => void) => Electron.IpcMain }).on = (channel: string, listener: (...args: unknown[]) => void) => {
    listeners.set(channel, listener as ListenerFn);
    return originalOn(channel, listener as Parameters<typeof originalOn>[1]);
  };
}

/**
 * Invoke a previously-captured IPC handler (from ipcMain.handle) from outside
 * the Electron IPC transport (i.e. from the WebSocket bridge).
 */
export async function invokeHandler(channel: string, ...args: unknown[]): Promise<unknown> {
  if (UNSUPPORTED_CHANNELS.has(channel)) {
    throw new Error(`Channel "${channel}" is not supported in web mode`);
  }

  const handler = handlers.get(channel);
  if (handler) {
    const fakeEvent = { sender: null } as unknown as IpcMainInvokeEvent;
    return handler(fakeEvent, ...args);
  }

  // Fall back to fire-and-forget listeners (ipcMain.on)
  const listener = listeners.get(channel);
  if (listener) {
    const fakeEvent = { sender: null } as unknown as IpcMainEvent;
    listener(fakeEvent, ...args);
    return undefined;
  }

  throw new Error(`No handler registered for channel "${channel}"`);
}
