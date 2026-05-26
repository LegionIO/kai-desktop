/**
 * Synchronous in-memory IPC harness for unit-testing IPC handlers without
 * spinning up Electron's real IPC system.
 *
 * Tests register handlers through a fake `ipcMain` exposed to a `registerHandlers`
 * callback, then drive the renderer side via `harness.invoke()` and `harness.send()`.
 * Messages sent from main to renderer are captured into `capturedMainToRenderer`
 * so tests can assert on push events.
 *
 * Intentionally does not import from `electron` — Electron's real IPC is not
 * available in vitest.
 */

export type IpcInvokeHandler = (...args: unknown[]) => unknown | Promise<unknown>;
export type IpcListener = (...args: unknown[]) => void;

/** Fake `ipcMain` replacement passed to `registerHandlers`. */
export interface FakeIpcMain {
  /** Register a handler for `harness.invoke(channel, ...)`. */
  handle(channel: string, handler: IpcInvokeHandler): void;
  /** Remove a previously registered invoke handler. */
  removeHandler(channel: string): void;
  /** Subscribe to events sent via `harness.send(channel, ...)`. */
  on(channel: string, listener: IpcListener): void;
  /** Subscribe once. */
  once(channel: string, listener: IpcListener): void;
  /** Remove an event listener. */
  off(channel: string, listener: IpcListener): void;
}

export interface IpcHarness {
  /** Invoke a registered handler. Returns its resolved value (or rejects). */
  invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T>;
  /** Dispatch an event to all listeners registered on the fake ipcMain. */
  send(channel: string, ...args: unknown[]): void;
  /** Subscribe a renderer-side listener for messages from main. */
  on(channel: string, listener: IpcListener): void;
  /** Remove a renderer-side listener. */
  off(channel: string, listener: IpcListener): void;
  /**
   * Send a message from "main" to "renderer". The harness records the call
   * into `capturedMainToRenderer` and notifies every renderer-side listener.
   */
  emitToRenderer(channel: string, ...args: unknown[]): void;
  /** Push events recorded by `emitToRenderer`. */
  capturedMainToRenderer: Array<{ channel: string; args: unknown[] }>;
  /** Clear handlers, listeners, and captured events. */
  reset(): void;
}

export interface CreateIpcHarnessOptions {
  /** Register IPC handlers via this fake `ipcMain` replacement. */
  registerHandlers?: (ipcMain: FakeIpcMain) => void | Promise<void>;
}

export async function createIpcHarness(opts: CreateIpcHarnessOptions = {}): Promise<IpcHarness> {
  const invokeHandlers = new Map<string, IpcInvokeHandler>();
  const mainListeners = new Map<string, Set<IpcListener>>();
  const rendererListeners = new Map<string, Set<IpcListener>>();
  const capturedMainToRenderer: Array<{ channel: string; args: unknown[] }> = [];

  const fakeIpcMain: FakeIpcMain = {
    handle(channel, handler) {
      invokeHandlers.set(channel, handler);
    },
    removeHandler(channel) {
      invokeHandlers.delete(channel);
    },
    on(channel, listener) {
      let set = mainListeners.get(channel);
      if (!set) {
        set = new Set();
        mainListeners.set(channel, set);
      }
      set.add(listener);
    },
    once(channel, listener) {
      const wrapper: IpcListener = (...args) => {
        fakeIpcMain.off(channel, wrapper);
        listener(...args);
      };
      fakeIpcMain.on(channel, wrapper);
    },
    off(channel, listener) {
      mainListeners.get(channel)?.delete(listener);
    },
  };

  if (opts.registerHandlers) {
    await opts.registerHandlers(fakeIpcMain);
  }

  const harness: IpcHarness = {
    capturedMainToRenderer,
    async invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T> {
      const handler = invokeHandlers.get(channel);
      if (!handler) {
        throw new Error(`No IPC handler registered for channel: ${channel}`);
      }
      return (await handler(...args)) as T;
    },
    send(channel, ...args) {
      const listeners = mainListeners.get(channel);
      if (!listeners) return;
      for (const listener of [...listeners]) {
        listener(...args);
      }
    },
    on(channel, listener) {
      let set = rendererListeners.get(channel);
      if (!set) {
        set = new Set();
        rendererListeners.set(channel, set);
      }
      set.add(listener);
    },
    off(channel, listener) {
      rendererListeners.get(channel)?.delete(listener);
    },
    emitToRenderer(channel, ...args) {
      capturedMainToRenderer.push({ channel, args });
      const listeners = rendererListeners.get(channel);
      if (!listeners) return;
      for (const listener of [...listeners]) {
        listener(...args);
      }
    },
    reset() {
      invokeHandlers.clear();
      mainListeners.clear();
      rendererListeners.clear();
      capturedMainToRenderer.length = 0;
    },
  };

  return harness;
}
