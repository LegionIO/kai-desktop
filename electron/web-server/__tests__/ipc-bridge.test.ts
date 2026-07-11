/**
 * Tests for the web→IPC bridge dispatch (ipc-bridge.ts). Covers the contract
 * the WebSocket handler relies on: capture of ipcMain.handle/on, invocation of
 * captured handlers/listeners, unsupported-channel rejection, and the
 * no-handler error path.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { IpcMain } from 'electron';
import { installIpcCapture, invokeHandler } from '../ipc-bridge.js';

/** Minimal fake ipcMain that records handle/on registrations, matching the
 *  shape installIpcCapture monkey-patches. */
function makeFakeIpcMain() {
  const handled = new Map<string, (...a: unknown[]) => unknown>();
  const listened = new Map<string, (...a: unknown[]) => void>();
  const ipc = {
    handle(channel: string, fn: (...a: unknown[]) => unknown) {
      handled.set(channel, fn);
      return ipc;
    },
    on(channel: string, fn: (...a: unknown[]) => void) {
      listened.set(channel, fn);
      return ipc;
    },
  } as unknown as IpcMain;
  return { ipc, handled, listened };
}

describe('ipc-bridge invokeHandler', () => {
  let ipc: IpcMain;

  beforeEach(() => {
    ({ ipc } = makeFakeIpcMain());
    installIpcCapture(ipc);
  });

  it('invokes a captured ipcMain.handle handler with args and returns its result', async () => {
    ipc.handle('math:add', (_e, a: number, b: number) => a + b);
    const result = await invokeHandler('math:add', 2, 3);
    expect(result).toBe(5);
  });

  it('passes a fake event (sender null) as the first handler arg', async () => {
    let sawEvent: unknown;
    ipc.handle('probe:event', (e) => {
      sawEvent = e;
      return 'ok';
    });
    await invokeHandler('probe:event');
    expect(sawEvent).toEqual({ sender: null });
  });

  it('rejects an explicitly unsupported channel', async () => {
    await expect(invokeHandler('dialog:open-file')).rejects.toThrow(/not supported in web mode/);
    await expect(invokeHandler('image:fetch')).rejects.toThrow(/not supported in web mode/);
  });

  it('rejects an unknown channel with a clear error', async () => {
    await expect(invokeHandler('does:not-exist')).rejects.toThrow(/No handler registered/);
  });

  it('falls back to a captured ipcMain.on listener (fire-and-forget, returns undefined)', async () => {
    let received: unknown;
    ipc.on('fire:forget', (_e, payload: unknown) => {
      received = payload;
    });
    const result = await invokeHandler('fire:forget', { x: 1 });
    expect(result).toBeUndefined();
    expect(received).toEqual({ x: 1 });
  });

  it('propagates a handler rejection to the caller', async () => {
    ipc.handle('boom', () => {
      throw new Error('handler failed');
    });
    await expect(invokeHandler('boom')).rejects.toThrow('handler failed');
  });
});
