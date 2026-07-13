/**
 * Tests for tool-approval.ts registration + broadcast (electron/ipc/tool-approval.ts).
 * A bug here either hangs a tool call (its approval promise never settles) or
 * mis-resolves an approval. Security-relevant: the duplicate-toolCallId path must
 * fail CLOSED (deny the orphaned prior waiter), and an abort must dismiss the
 * pending promise rather than leave it dangling. electron + web-clients mocked.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const sent: Array<{ channel: string; event: unknown }> = [];
const webSent: Array<{ channel: string; event: unknown }> = [];
vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => [
      { webContents: { send: (channel: string, event: unknown) => sent.push({ channel, event }) } },
    ],
  },
}));
vi.mock('../../web-server/web-clients.js', () => ({
  broadcastToWebClients: (channel: string, event: unknown) => webSent.push({ channel, event }),
}));

import {
  pendingToolApprovals,
  registerPendingApproval,
  setServerPersistTagger,
  broadcastStreamEventRaw,
} from '../tool-approval.js';

beforeEach(() => {
  pendingToolApprovals.clear();
  sent.length = 0;
  webSent.length = 0;
  setServerPersistTagger(null as never); // reset any tagger from a prior test
});

describe('registerPendingApproval', () => {
  it('resolves with the value the map entry is resolved with (approve)', async () => {
    const p = registerPendingApproval('call-1');
    expect(pendingToolApprovals.has('call-1')).toBe(true);
    pendingToolApprovals.get('call-1')!.resolve(true);
    await expect(p).resolves.toBe(true);
  });

  it('resolves false on deny and "dismiss" on dismiss', async () => {
    const deny = registerPendingApproval('c-deny');
    pendingToolApprovals.get('c-deny')!.resolve(false);
    await expect(deny).resolves.toBe(false);

    const dismiss = registerPendingApproval('c-dismiss');
    pendingToolApprovals.get('c-dismiss')!.resolve('dismiss');
    await expect(dismiss).resolves.toBe('dismiss');
  });

  it('fail-closed: a duplicate toolCallId resolves the prior waiter FALSE before replacing', async () => {
    const first = registerPendingApproval('dup');
    const second = registerPendingApproval('dup'); // must settle `first` as denied
    await expect(first).resolves.toBe(false);
    // The map now holds the SECOND waiter.
    expect(pendingToolApprovals.has('dup')).toBe(true);
    pendingToolApprovals.get('dup')!.resolve(true);
    await expect(second).resolves.toBe(true);
  });

  it('an already-aborted signal resolves "dismiss" immediately (no hang)', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const p = registerPendingApproval('c-preaborted', ctrl.signal);
    await expect(p).resolves.toBe('dismiss');
    expect(pendingToolApprovals.has('c-preaborted')).toBe(false); // cleaned up
  });

  it('a later abort resolves "dismiss" and removes the map entry', async () => {
    const ctrl = new AbortController();
    const p = registerPendingApproval('c-laterabort', ctrl.signal);
    expect(pendingToolApprovals.has('c-laterabort')).toBe(true);
    ctrl.abort();
    await expect(p).resolves.toBe('dismiss');
    expect(pendingToolApprovals.has('c-laterabort')).toBe(false);
  });

  it('with no abort signal, the entry stays pending until resolved', () => {
    registerPendingApproval('c-pending');
    expect(pendingToolApprovals.has('c-pending')).toBe(true);
  });

  it('removes the abort listener when resolved via approve/deny (no leak on the normal path)', async () => {
    // The leak fix: resolving through the map entry (user approve/reject) must
    // remove the {once} abort listener that was attached to the (turn-scoped,
    // reused-per-tool-call) signal — otherwise one listener accumulates per
    // approved tool call until the signal aborts.
    const ctrl = new AbortController();
    const removeSpy = vi.spyOn(ctrl.signal, 'removeEventListener');
    const p = registerPendingApproval('c-leak', ctrl.signal);
    pendingToolApprovals.get('c-leak')!.resolve(true); // normal approve — abort never fires
    await expect(p).resolves.toBe(true);
    expect(removeSpy).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(pendingToolApprovals.has('c-leak')).toBe(false);
    // A subsequent abort must NOT re-resolve or throw (listener already removed + settled).
    expect(() => ctrl.abort()).not.toThrow();
  });

  it('duplicate-eviction with an abort signal removes the prior waiter listener too', async () => {
    const ctrl = new AbortController();
    const removeSpy = vi.spyOn(ctrl.signal, 'removeEventListener');
    const first = registerPendingApproval('dup2', ctrl.signal);
    registerPendingApproval('dup2'); // evicts `first` (fail-closed deny)
    await expect(first).resolves.toBe(false);
    expect(removeSpy).toHaveBeenCalledWith('abort', expect.any(Function));
  });
});

describe('broadcastStreamEventRaw + setServerPersistTagger', () => {
  const event = { type: 'text', data: 'hi' } as never;

  it('sends the raw event to windows + web clients when no tagger is installed', () => {
    broadcastStreamEventRaw(event);
    expect(sent).toEqual([{ channel: 'agent:stream-event', event }]);
    expect(webSent).toEqual([{ channel: 'agent:stream-event', event }]);
  });

  it('applies the server-persist tagger to the event before sending', () => {
    setServerPersistTagger((e) => ({ ...(e as object), serverPersisted: true }) as never);
    broadcastStreamEventRaw(event);
    expect(sent[0].event).toMatchObject({ type: 'text', serverPersisted: true });
    expect(webSent[0].event).toMatchObject({ serverPersisted: true });
  });
});
