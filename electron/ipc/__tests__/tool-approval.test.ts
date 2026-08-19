/**
 * Tests for tool-approval.ts registration + broadcast (electron/ipc/tool-approval.ts).
 * A bug here either hangs a tool call (its approval promise never settles) or
 * mis-resolves an approval. Security-relevant: the duplicate-toolCallId path must
 * fail CLOSED (deny the orphaned prior waiter), and an abort must dismiss the
 * pending promise rather than leave it dangling. electron + web-clients mocked.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const sent: Array<{ channel: string; event: unknown }> = [];
const sentWindowIds: number[] = [];
const webSent: Array<{ channel: string; event: unknown }> = [];
const makeWindow = (id: number) => ({
  isDestroyed: () => false,
  webContents: {
    id,
    isDestroyed: () => false,
    send: (channel: string, event: unknown) => {
      sentWindowIds.push(id);
      sent.push({ channel, event });
    },
  },
});
const primaryWindow = makeWindow(1);
const browserWindows = [primaryWindow];
vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => browserWindows,
  },
}));
vi.mock('../../web-server/web-clients.js', () => ({
  broadcastToWebClients: (channel: string, event: unknown) => webSent.push({ channel, event }),
}));

import {
  pendingToolApprovals,
  dismissPendingNativeBrowserApprovalsForOwner,
  registerPendingApproval,
  setServerPersistTagger,
  setToolApprovalOwnerResolver,
  setRawApprovalWindowOpener,
  setRawApprovalWindowCloser,
  setPrimaryApprovalWindowResolver,
  authorizePendingApprovalWindow,
  broadcastStreamEventRaw,
  getRecordedApprovalAuthority,
} from '../tool-approval.js';

beforeEach(() => {
  pendingToolApprovals.clear();
  sent.length = 0;
  sentWindowIds.length = 0;
  webSent.length = 0;
  browserWindows.splice(0, browserWindows.length, primaryWindow);
  setServerPersistTagger(null as never); // reset any tagger from a prior test
  setToolApprovalOwnerResolver(null);
  setRawApprovalWindowOpener(null);
  setRawApprovalWindowCloser(null);
  setPrimaryApprovalWindowResolver(() => primaryWindow as never);
});

describe('registerPendingApproval', () => {
  it('durably records a browser-owned approval authority that OUTLIVES abort deletion (R174)', async () => {
    setToolApprovalOwnerResolver((conversationId, browserOwnerId) => ({ conversationId, streamToken: browserOwnerId }));
    const ctrl = new AbortController();
    const p = registerPendingApproval('browser-ask', ctrl.signal, 'native-browser', {
      conversationId: 'chat-1',
      browserOwnerId: 'run-1',
    });
    // Abort deletes the pending entry, but the durable authority record must remain so the
    // pendingless raced-answer recovery path can still enforce browser authority.
    ctrl.abort();
    await p;
    expect(pendingToolApprovals.has('browser-ask')).toBe(false);
    expect(getRecordedApprovalAuthority('browser-ask')).toMatchObject({
      authority: 'native-browser',
      streamOwner: { conversationId: 'chat-1', streamToken: 'run-1' },
    });
    // A plain any-renderer approval with no owner records NOTHING (nothing to enforce post-deletion).
    const p2 = registerPendingApproval('plain-ask');
    pendingToolApprovals.get('plain-ask')!.resolve(true);
    await p2;
    expect(getRecordedApprovalAuthority('plain-ask')).toBeUndefined();
    setToolApprovalOwnerResolver(null);
  });

  it('resolves with the value the map entry is resolved with (approve)', async () => {
    const p = registerPendingApproval('call-1');
    expect(pendingToolApprovals.has('call-1')).toBe(true);
    pendingToolApprovals.get('call-1')!.resolve(true);
    await expect(p).resolves.toBe(true);
  });

  it('records native Browser authority on Browser-only approvals', () => {
    registerPendingApproval('browser-call', undefined, 'native-browser');
    expect(pendingToolApprovals.get('browser-call')?.authority).toBe('native-browser');
  });

  it('retains exact Browser input only while the approval is pending', async () => {
    const pending = registerPendingApproval('browser-private', undefined, 'native-browser', {
      privateDetails: { browserInput: { script: 'document.title' } },
    });
    expect(pendingToolApprovals.get('browser-private')?.privateDetails).toEqual({
      browserInput: { script: 'document.title' },
    });
    pendingToolApprovals.get('browser-private')!.resolve(false);
    await expect(pending).resolves.toBe(false);
    expect(pendingToolApprovals.has('browser-private')).toBe(false);
  });

  it('binds ownership only when the active-stream resolver accepts the conversation and run id', () => {
    setToolApprovalOwnerResolver((conversationId, browserOwnerId) =>
      conversationId === 'chat-1' && browserOwnerId === 'run-1'
        ? { conversationId, streamToken: browserOwnerId }
        : undefined,
    );

    registerPendingApproval('owned', undefined, 'any-renderer', {
      conversationId: 'chat-1',
      browserOwnerId: 'run-1',
    });
    expect(() =>
      registerPendingApproval('realtime', undefined, 'native-browser', {
        conversationId: 'chat-1',
        browserOwnerId: 'realtime-owner',
      }),
    ).toThrow(/no longer authorized/);

    expect(pendingToolApprovals.get('owned')?.streamOwner).toEqual({
      conversationId: 'chat-1',
      streamToken: 'run-1',
    });
    expect(pendingToolApprovals.has('realtime')).toBe(false);
  });

  it.each(['text', 'Realtime'])('rejects a late %s Browser approval after its owner is revoked', async (modality) => {
    let authorized = true;
    setToolApprovalOwnerResolver((conversationId, browserOwnerId) =>
      authorized
        ? {
            conversationId,
            streamToken: browserOwnerId,
            ...(modality === 'Realtime' ? { isCurrent: () => authorized } : {}),
          }
        : undefined,
    );
    const live = registerPendingApproval(`${modality}-live`, undefined, 'native-browser', {
      conversationId: 'chat-1',
      browserOwnerId: 'run-1',
    });
    pendingToolApprovals.get(`${modality}-live`)!.resolve(false);
    await expect(live).resolves.toBe(false);

    authorized = false;
    expect(() =>
      registerPendingApproval(`${modality}-late`, undefined, 'native-browser', {
        conversationId: 'chat-1',
        browserOwnerId: 'run-1',
      }),
    ).toThrow(/no longer authorized/);
    expect(pendingToolApprovals.has(`${modality}-late`)).toBe(false);
  });

  it('grants a one-shot dedicated-window capability only after registration', () => {
    expect(authorizePendingApprovalWindow('missing', 44)).toBe(false);
    registerPendingApproval('windowed');
    expect(authorizePendingApprovalWindow('windowed', 44)).toBe(true);
    expect(pendingToolApprovals.get('windowed')?.approvalWindowWebContentsId).toBe(44);
    expect(authorizePendingApprovalWindow('windowed', 0)).toBe(false);
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

  it('rejects an already-aborted signal synchronously before registering approval UI', () => {
    const ctrl = new AbortController();
    ctrl.abort();
    expect(() => registerPendingApproval('c-preaborted', ctrl.signal)).toThrow(/canceled before.*registered/);
    expect(pendingToolApprovals.has('c-preaborted')).toBe(false);
  });

  it('a later abort resolves "dismiss" and removes the map entry', async () => {
    const ctrl = new AbortController();
    const closeWindow = vi.fn();
    setRawApprovalWindowCloser(closeWindow);
    const p = registerPendingApproval('c-laterabort', ctrl.signal);
    expect(pendingToolApprovals.has('c-laterabort')).toBe(true);
    ctrl.abort();
    await expect(p).resolves.toBe('dismiss');
    expect(pendingToolApprovals.has('c-laterabort')).toBe(false);
    expect(closeWindow).toHaveBeenCalledWith('c-laterabort');
  });

  it('closes a raw approval pop-out on duplicate eviction', async () => {
    const closeWindow = vi.fn();
    setRawApprovalWindowCloser(closeWindow);
    const first = registerPendingApproval('window-duplicate');
    authorizePendingApprovalWindow('window-duplicate', 44);

    const second = registerPendingApproval('window-duplicate');

    await expect(first).resolves.toBe(false);
    expect(closeWindow).toHaveBeenCalledWith('window-duplicate');
    pendingToolApprovals.get('window-duplicate')!.resolve(false);
    await expect(second).resolves.toBe(false);
  });

  it('with no abort signal, the entry stays pending until resolved', () => {
    registerPendingApproval('c-pending');
    expect(pendingToolApprovals.has('c-pending')).toBe(true);
  });

  it('onSettle delivers the CATEGORICAL source: abort distinct from reject/dismiss/answered (R94)', async () => {
    // The SDK ask_user handler routes recovery ONLY on a genuine abort — it must be
    // able to tell abort ('dismiss' VALUE) apart from a real user reject/dismiss.
    const abortCtrl = new AbortController();
    let abortSource: string | undefined;
    const pAbort = registerPendingApproval('c-src-abort', abortCtrl.signal, undefined, undefined, {
      onSettle: (s) => {
        abortSource = s;
      },
    });
    abortCtrl.abort();
    await pAbort;
    expect(abortSource).toBe('abort');

    let rejectSource: string | undefined;
    const pReject = registerPendingApproval('c-src-reject', undefined, undefined, undefined, {
      onSettle: (s) => {
        rejectSource = s;
      },
    });
    pendingToolApprovals.get('c-src-reject')!.resolve(false, 'reject');
    await pReject;
    expect(rejectSource).toBe('reject');

    let dismissSource: string | undefined;
    const pDismiss = registerPendingApproval('c-src-dismiss', undefined, undefined, undefined, {
      onSettle: (s) => {
        dismissSource = s;
      },
    });
    pendingToolApprovals.get('c-src-dismiss')!.resolve('dismiss', 'dismiss');
    await pDismiss;
    expect(dismissSource).toBe('dismiss');

    let answeredSource: string | undefined;
    const pAns = registerPendingApproval('c-src-answered', undefined, undefined, undefined, {
      onSettle: (s) => {
        answeredSource = s;
      },
    });
    pendingToolApprovals.get('c-src-answered')!.resolve(true, 'answered');
    await pAns;
    expect(answeredSource).toBe('answered');
  });

  it('onSettle that throws does not break the settle path (R94)', async () => {
    const p = registerPendingApproval('c-src-throw', undefined, undefined, undefined, {
      onSettle: () => {
        throw new Error('observer boom');
      },
    });
    pendingToolApprovals.get('c-src-throw')!.resolve(true, 'answered');
    await expect(p).resolves.toBe(true);
  });

  it('dismisses only native Browser approvals owned by the revoked assistant run', async () => {
    setToolApprovalOwnerResolver((conversationId, browserOwnerId) => ({
      conversationId,
      streamToken: browserOwnerId,
    }));
    const native = registerPendingApproval('native-owned', undefined, 'native-browser', {
      conversationId: 'chat-1',
      browserOwnerId: 'run-1',
    });
    const generic = registerPendingApproval('generic-owned', undefined, 'any-renderer', {
      conversationId: 'chat-1',
      browserOwnerId: 'run-1',
    });
    const other = registerPendingApproval('native-other', undefined, 'native-browser', {
      conversationId: 'chat-1',
      browserOwnerId: 'run-2',
    });

    dismissPendingNativeBrowserApprovalsForOwner('chat-1', 'run-1');

    await expect(native).resolves.toBe('dismiss');
    expect(pendingToolApprovals.has('generic-owned')).toBe(true);
    expect(pendingToolApprovals.has('native-other')).toBe(true);
    pendingToolApprovals.get('generic-owned')!.resolve(false);
    pendingToolApprovals.get('native-other')!.resolve(false);
    await expect(generic).resolves.toBe(false);
    await expect(other).resolves.toBe(false);
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

  it('continues fan-out to healthy windows + web clients when one window send throws (R106)', () => {
    // Insert a throwing window BEFORE the healthy one; a raw loop would abort here and
    // the healthy window + web clients would miss the event.
    const throwingWindow = {
      isDestroyed: () => false,
      webContents: {
        id: 999,
        isDestroyed: () => false,
        send: () => {
          throw new Error('window navigating');
        },
      },
    };
    browserWindows.unshift(throwingWindow as never);
    try {
      broadcastStreamEventRaw(event);
      // The healthy window still received it, and web-client fan-out still ran.
      expect(sent).toEqual([{ channel: 'agent:stream-event', event }]);
      expect(webSent).toEqual([{ channel: 'agent:stream-event', event }]);
    } finally {
      browserWindows.shift(); // restore the single-window default for later tests
    }
  });

  it('keeps native Browser approval cards off unsupported web clients', () => {
    const browserApproval = {
      type: 'tool-approval-required',
      conversationId: 'chat-1',
      toolCallId: 'browser-call',
      toolName: 'browser_evaluate',
      args: { approvalKind: 'browser-control', script: '[redacted browser script: 42 characters]' },
    } as never;

    broadcastStreamEventRaw(browserApproval);

    expect(sent).toHaveLength(1);
    expect(webSent).toEqual([]);
  });

  it('sends native Browser approvals only to the primary renderer and exact approval pop-out', () => {
    const approvalWindow = makeWindow(91);
    const unrelatedWindow = makeWindow(52);
    browserWindows.push(approvalWindow, unrelatedWindow);
    registerPendingApproval('restricted-browser-call', undefined, 'native-browser');
    setRawApprovalWindowOpener((event) => {
      authorizePendingApprovalWindow(event.toolCallId ?? '', approvalWindow.webContents.id);
    });
    const approval = {
      type: 'tool-approval-required',
      conversationId: 'chat-1',
      toolCallId: 'restricted-browser-call',
      toolName: 'browser_action',
      args: { approvalKind: 'browser-control', selector: '[redacted browser selector: 12 characters]' },
    } as never;

    broadcastStreamEventRaw(approval);

    expect(sentWindowIds).toEqual([primaryWindow.webContents.id, approvalWindow.webContents.id]);
    expect(sentWindowIds).not.toContain(unrelatedWindow.webContents.id);
    expect(webSent).toEqual([]);
  });

  it('opens the raw approval pop-out after registration and suppresses generic owned cards on web', () => {
    const approvalWindow = makeWindow(91);
    const unrelatedWindow = makeWindow(52);
    browserWindows.push(approvalWindow, unrelatedWindow);
    setToolApprovalOwnerResolver((conversationId, browserOwnerId) => ({
      conversationId,
      streamToken: browserOwnerId,
    }));
    registerPendingApproval('owned-question', undefined, 'any-renderer', {
      conversationId: 'chat-1',
      browserOwnerId: 'run-1',
    });
    const opener = vi.fn((event: { toolCallId?: string }) => {
      expect(pendingToolApprovals.has(event.toolCallId ?? '')).toBe(true);
      authorizePendingApprovalWindow(event.toolCallId ?? '', 91);
    });
    setRawApprovalWindowOpener(opener as never);
    const approval = {
      type: 'tool-approval-required',
      conversationId: 'chat-1',
      toolCallId: 'owned-question',
      toolName: 'ask_user',
      args: { questions: [] },
    } as never;

    broadcastStreamEventRaw(approval);

    expect(opener).toHaveBeenCalledWith(approval);
    expect(pendingToolApprovals.get('owned-question')?.approvalWindowWebContentsId).toBe(91);
    expect(sentWindowIds).toEqual([primaryWindow.webContents.id, approvalWindow.webContents.id]);
    expect(sentWindowIds).not.toContain(unrelatedWindow.webContents.id);
    expect(webSent).toEqual([]);
  });
});
