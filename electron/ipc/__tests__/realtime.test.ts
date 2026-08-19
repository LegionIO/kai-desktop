/**
 * Tests for electron/ipc/realtime.ts session lifecycle + usage accounting.
 *
 * The start/end handlers manage a single module-global activeSession plus a
 * monotonic startGeneration guard (so a hangup or a newer start during the async
 * "ringing"/memory-context phase supersedes an in-flight start). Codex review
 * surfaced three accounting/cleanup fixes locked here:
 *   - end-session records usage then closes even if recordUsageEvent throws
 *     (usage failure must not leak the session / block hangup cleanup);
 *   - start-while-active records the prior call's usage before tearing it down
 *     (no dropped duration when switching calls);
 *   - timing/attribution globals are set at INSTALL time so a superseded start
 *     leaves no stale globals and the duration reflects connected time.
 *
 * RealtimeSession + buildRealtimeMemoryContext + recordUsageEvent are mocked so
 * the race sequences run deterministically with no WS/engine.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createIpcHarness } from '../../../test-utils/ipc-harness.js';

const FAKE_EVENT = {} as unknown;

// ── Mocks ──────────────────────────────────────────────────────────────────
const usageEvents: Array<{ modality: string; conversationId?: string; durationSec?: number }> = [];
let recordUsageThrows = false;
const cleanupAssistantTabs = vi.hoisted(() => vi.fn());
const beginAssistantRun = vi.hoisted(() => vi.fn());
const cancelAssistantContinuations = vi.hoisted(() => vi.fn(async () => undefined));
const waitForAssistantTabCleanup = vi.hoisted(() => vi.fn(async (): Promise<void> => undefined));
const hasPendingAssistantContinuationForConversation = vi.hoisted(() =>
  vi.fn<(conversationId: string) => boolean>(() => false),
);
const browserManager = vi.hoisted(() => ({
  authorityAvailable: true,
  authorityGeneration: 1,
  beginAssistantRun,
  cancelAssistantContinuations,
  cleanupAssistantTabs,
  waitForAssistantTabCleanup,
  hasPendingAssistantContinuationForConversation,
  getHostRendererAuthorityGeneration: vi.fn(() => 1),
  isHostRendererAuthorityCurrent: vi.fn((generation: number) => generation === 1),
}));

vi.mock('../../browser/service.js', () => ({
  getExistingBrowserManager: () => browserManager,
}));

vi.mock('../usage.js', () => ({
  recordUsageEvent: vi.fn((e: { modality: string; conversationId?: string; durationSec?: number }) => {
    if (recordUsageThrows) throw new Error('disk full');
    usageEvents.push(e);
  }),
}));

// Controllable memory-context builder: resolve/settle on demand to drive the
// "superseded during memory build" race.
let memoryContextGate: Promise<string> | null = null;
vi.mock('../../realtime/realtime-context.js', () => ({
  buildRealtimeMemoryContext: vi.fn(async () => (memoryContextGate ? memoryContextGate : '')),
}));

// Fake RealtimeSession recording construction + close calls.
const built: FakeSession[] = [];
class FakeSession {
  closed = false;
  readonly browserOwnerId: string;
  readonly initialTools: unknown[];
  readonly toolUpdates: unknown[][] = [];
  readonly audioFrames: string[] = [];
  startCalls = 0;
  startResolve!: () => void;
  startReject!: (e: Error) => void;
  private startPromise: Promise<void>;
  constructor(
    _getConfig?: unknown,
    tools: unknown[] = [],
    private readonly onTerminal?: () => void,
  ) {
    this.browserOwnerId = `realtime-run-${built.length + 1}`;
    this.initialTools = tools;
    this.startPromise = new Promise((res, rej) => {
      this.startResolve = res;
      this.startReject = rej;
    });
    void this.startPromise.catch(() => undefined);
    built.push(this);
  }
  async start(): Promise<void> {
    this.startCalls++;
    return this.startPromise;
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.onTerminal?.();
    this.startReject(new Error('closed before start completed'));
  }
  get status() {
    return this.closed ? 'disconnected' : 'connected';
  }
  remoteTerminate(): void {
    this.closed = true;
    this.onTerminal?.();
  }
  updateTools(tools: unknown[]) {
    this.toolUpdates.push(tools);
  }
  sendAudio(frame: string) {
    this.audioFrames.push(frame);
  }
}
vi.mock('../../realtime/realtime-session.js', () => ({
  // Must be constructable (`new RealtimeSession(...)`), so expose the class itself
  // rather than an arrow factory (arrows can't be used with `new`).
  RealtimeSession: FakeSession,
}));

const {
  registerRealtimeHandlers,
  isRealtimeConversationBrowserAuthorized,
  isRealtimeConversationTurnActive,
  resolveRealtimeBrowserApprovalOwner,
  revokeRealtimeBrowserTools,
  stopRealtimeSessionForConversation,
  updateActiveRealtimeSessionTools,
} = await import('../realtime.js');
const {
  mayBroadcastApprovalToWebClients,
  pendingToolApprovals,
  registerPendingApproval,
  setToolApprovalOwnerResolver,
} = await import('../tool-approval.js');

/** Wait for the Nth (1-based) FakeSession to be constructed by the handler. */
async function waitForSession(n: number): Promise<FakeSession> {
  for (let i = 0; i < 100 && built.length < n; i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
  if (built.length < n) throw new Error(`session #${n} never constructed (have ${built.length})`);
  return built[n - 1];
}

function makeConfig(memoryEnabled = false) {
  return {
    realtime: { memoryContext: { enabled: memoryEnabled } },
  } as unknown as Parameters<typeof registerRealtimeHandlers>[1] extends () => infer C ? C : never;
}

async function harnessWith() {
  return createIpcHarness({
    registerHandlers: (ipc) => {
      registerRealtimeHandlers(
        ipc as Parameters<typeof registerRealtimeHandlers>[0],
        () => makeConfig(false) as never,
        () => [],
        '/tmp/kai-test-home',
      );
    },
  });
}

beforeEach(() => {
  usageEvents.length = 0;
  built.length = 0;
  recordUsageThrows = false;
  memoryContextGate = null;
  cleanupAssistantTabs.mockReset().mockResolvedValue(undefined);
  beginAssistantRun.mockReset();
  cancelAssistantContinuations.mockReset().mockResolvedValue(undefined);
  waitForAssistantTabCleanup.mockReset().mockResolvedValue(undefined);
  hasPendingAssistantContinuationForConversation.mockReset().mockReturnValue(false);
  pendingToolApprovals.clear();
  setToolApprovalOwnerResolver(null);
  browserManager.authorityAvailable = true;
  browserManager.authorityGeneration = 1;
  browserManager.getHostRendererAuthorityGeneration.mockImplementation(() => browserManager.authorityGeneration);
  browserManager.isHostRendererAuthorityCurrent.mockImplementation(
    (generation: number) => browserManager.authorityAvailable && generation === browserManager.authorityGeneration,
  );
});

/**
 * The realtime handlers hold module-global session state that persists across
 * tests. Each test registers its own harness (fresh handlers closed over the
 * SAME module globals), so we must tear down any active session between tests —
 * otherwise a leftover activeSession makes the next start's teardown path run
 * against stale state. We reach the end-session handler through a throwaway
 * harness registered on demand.
 */
async function forceEndAnySession(): Promise<void> {
  const primarySender = { mainFrame: {} };
  const h = await createIpcHarness({
    registerHandlers: (ipc) => {
      registerRealtimeHandlers(
        ipc as Parameters<typeof registerRealtimeHandlers>[0],
        () => makeConfig(false) as never,
        () => [],
        '/tmp/kai-test-home',
        () => ({ isDestroyed: () => false, webContents: primarySender }) as never,
      );
    },
  });
  await h.invoke('realtime:end-session', { sender: primarySender, senderFrame: primarySender.mainFrame });
}

afterEach(async () => {
  await forceEndAnySession();
  pendingToolApprovals.clear();
  setToolApprovalOwnerResolver(null);
  usageEvents.length = 0;
  built.length = 0;
});

describe('realtime IPC — start/end lifecycle + usage', () => {
  it('rejects Realtime startup while a text turn owns the conversation', async () => {
    const h = await createIpcHarness({
      registerHandlers: (ipc) => {
        registerRealtimeHandlers(
          ipc as Parameters<typeof registerRealtimeHandlers>[0],
          () => makeConfig(false) as never,
          () => [],
          '/tmp/kai-test-home',
          () => null,
          (conversationId) => conversationId === 'conv-text-active',
        );
      },
    });

    await expect(h.invoke('realtime:start-session', FAKE_EVENT, 'conv-text-active')).resolves.toEqual({
      error: 'A text response is already running for this conversation.',
    });
    expect(built).toHaveLength(0);
    expect(isRealtimeConversationTurnActive('conv-text-active')).toBe(false);
  });

  it('rejects remote Realtime takeover while a native Browser continuation is retained', async () => {
    const primarySender = { id: 1, mainFrame: {} };
    hasPendingAssistantContinuationForConversation.mockImplementation(
      (conversationId: string) => conversationId === 'conv-retained-browser',
    );
    const h = await createIpcHarness({
      registerHandlers: (ipc) => {
        registerRealtimeHandlers(
          ipc as Parameters<typeof registerRealtimeHandlers>[0],
          () => makeConfig(false) as never,
          () => [],
          '/tmp/kai-test-home',
          () => ({ isDestroyed: () => false, webContents: primarySender }) as never,
        );
      },
    });

    await expect(
      h.invoke('realtime:start-session', { __kaiWebBridge: true, sender: null }, 'conv-retained-browser'),
    ).resolves.toEqual({
      error: 'Only the current primary renderer can replace a retained Browser continuation.',
    });
    expect(built).toHaveLength(0);
    expect(isRealtimeConversationTurnActive('conv-retained-browser')).toBe(false);
    expect(cancelAssistantContinuations).not.toHaveBeenCalled();
  });

  it('start then end records exactly one realtime usage event and closes the session', async () => {
    const h = await harnessWith();
    const startP = h.invoke('realtime:start-session', FAKE_EVENT, 'conv-A');
    // memoryContext disabled → start proceeds to build the session; resolve its
    // start() promise so the handler installs it.
    (await waitForSession(1)).startResolve();
    expect(await startP).toEqual({ ok: true });

    const status = await h.invoke<{ status: string }>('realtime:get-status', FAKE_EVENT);
    expect(status.status).toBe('connected');

    expect(await h.invoke('realtime:end-session', FAKE_EVENT)).toEqual({ ok: true });
    expect(built[0].closed).toBe(true);
    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0]).toMatchObject({ modality: 'realtime', conversationId: 'conv-A' });
    expect(cleanupAssistantTabs).toHaveBeenCalledWith('conv-A', built[0].browserOwnerId);

    // After end, status is idle.
    const after = await h.invoke<{ status: string }>('realtime:get-status', FAKE_EVENT);
    expect(after.status).toBe('idle');
  });

  it('end-session still closes the session when recordUsageEvent throws (no leak)', async () => {
    const h = await harnessWith();
    const startP = h.invoke('realtime:start-session', FAKE_EVENT, 'conv-B');
    (await waitForSession(1)).startResolve();
    await startP;

    recordUsageThrows = true;
    // Must not reject, and must still close the session despite the usage throw.
    expect(await h.invoke('realtime:end-session', FAKE_EVENT)).toEqual({ ok: true });
    expect(built[0].closed).toBe(true);
    // (built[0] is safe to read directly now — the session was already constructed.)
    // Session cleared → next end is a no-op, status idle.
    expect((await h.invoke<{ status: string }>('realtime:get-status', FAKE_EVENT)).status).toBe('idle');
  });

  it('start-while-active records the prior call usage before replacing it', async () => {
    const h = await harnessWith();
    const p1 = h.invoke('realtime:start-session', FAKE_EVENT, 'conv-1');
    (await waitForSession(1)).startResolve();
    await p1;

    // Second start supersedes the first: the prior active session must be
    // recorded + closed, not silently dropped.
    const p2 = h.invoke('realtime:start-session', FAKE_EVENT, 'conv-2');
    (await waitForSession(2)).startResolve();
    await p2;

    expect(built[0].closed).toBe(true); // prior session torn down
    expect(usageEvents).toHaveLength(1); // and its usage recorded
    expect(usageEvents[0]).toMatchObject({ conversationId: 'conv-1' });
    expect(cleanupAssistantTabs).toHaveBeenCalledWith('conv-1', built[0].browserOwnerId);

    // Ending the second records the second.
    await h.invoke('realtime:end-session', FAKE_EVENT);
    expect(usageEvents).toHaveLength(2);
    expect(usageEvents[1]).toMatchObject({ conversationId: 'conv-2' });
    expect(cleanupAssistantTabs).toHaveBeenCalledWith('conv-2', built[1].browserOwnerId);
  });

  it('waits for a replaced Realtime Browser run to drain before admitting its successor', async () => {
    const browserTool = { name: 'browser_tabs', source: 'browser' };
    const primarySender = { id: 1, mainFrame: {} };
    const primaryEvent = { sender: primarySender, senderFrame: primarySender.mainFrame };
    const h = await createIpcHarness({
      registerHandlers: (ipc) => {
        registerRealtimeHandlers(
          ipc as Parameters<typeof registerRealtimeHandlers>[0],
          () => makeConfig(false) as never,
          () => [browserTool] as never,
          '/tmp/kai-test-home',
          () => ({ isDestroyed: () => false, webContents: primarySender }) as never,
        );
      },
    });
    const firstStart = h.invoke('realtime:start-session', primaryEvent, 'conv-replace-browser');
    const first = await waitForSession(1);
    first.startResolve();
    expect(await firstStart).toEqual({ ok: true });

    let releaseCleanup!: () => void;
    let predecessorDrained = false;
    cleanupAssistantTabs.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseCleanup = () => {
            predecessorDrained = true;
            resolve();
          };
        }),
    );
    beginAssistantRun.mockClear();
    beginAssistantRun.mockImplementation(() => {
      if (!predecessorDrained) throw new Error('predecessor Browser run is still draining');
    });

    const replacementStart = h.invoke('realtime:start-session', primaryEvent, 'conv-replace-browser');
    const replacement = await waitForSession(2);
    await vi.waitFor(() =>
      expect(cleanupAssistantTabs).toHaveBeenCalledWith('conv-replace-browser', first.browserOwnerId),
    );
    expect(first.closed).toBe(true);
    expect(replacement.startCalls).toBe(0);
    expect(beginAssistantRun).not.toHaveBeenCalled();

    releaseCleanup();
    await vi.waitFor(() =>
      expect(beginAssistantRun).toHaveBeenCalledWith('conv-replace-browser', replacement.browserOwnerId, 'realtime'),
    );
    replacement.startResolve();
    expect(await replacementStart).toEqual({ ok: true });
    await h.invoke('realtime:end-session', primaryEvent);
  });

  it('waits for a text-run Browser cleanup before admitting Realtime', async () => {
    const browserTool = { name: 'browser_tabs', source: 'browser' };
    const primarySender = { id: 1, mainFrame: {} };
    const primaryEvent = { sender: primarySender, senderFrame: primarySender.mainFrame };
    hasPendingAssistantContinuationForConversation.mockImplementation(
      (conversationId: string) => conversationId === 'conv-text-cleanup',
    );
    let releaseTextCleanup!: () => void;
    waitForAssistantTabCleanup.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseTextCleanup = resolve;
        }),
    );
    const h = await createIpcHarness({
      registerHandlers: (ipc) => {
        registerRealtimeHandlers(
          ipc as Parameters<typeof registerRealtimeHandlers>[0],
          () => makeConfig(false) as never,
          () => [browserTool] as never,
          '/tmp/kai-test-home',
          () => ({ isDestroyed: () => false, webContents: primarySender }) as never,
        );
      },
    });

    const start = h.invoke('realtime:start-session', primaryEvent, 'conv-text-cleanup');
    const session = await waitForSession(1);
    await vi.waitFor(() => expect(waitForAssistantTabCleanup).toHaveBeenCalledWith('conv-text-cleanup'));
    expect(cancelAssistantContinuations).toHaveBeenCalledWith('conv-text-cleanup');
    expect(beginAssistantRun).not.toHaveBeenCalled();
    expect(session.startCalls).toBe(0);

    releaseTextCleanup();
    await vi.waitFor(() =>
      expect(beginAssistantRun).toHaveBeenCalledWith('conv-text-cleanup', session.browserOwnerId, 'realtime'),
    );
    session.startResolve();
    expect(await start).toEqual({ ok: true });
    await h.invoke('realtime:end-session', primaryEvent);
  });

  it('end-session with no active session records nothing and is a no-op', async () => {
    const h = await harnessWith();
    expect(await h.invoke('realtime:end-session', FAKE_EVENT)).toEqual({ ok: true });
    expect(usageEvents).toHaveLength(0);
  });

  it('filters native browser tools from web-originated sessions and hot updates', async () => {
    const browserTool = { name: 'browser_tabs', source: 'browser' };
    const safeTool = { name: 'search', source: 'builtin' };
    const harness = await createIpcHarness({
      registerHandlers: (ipc) => {
        registerRealtimeHandlers(
          ipc as Parameters<typeof registerRealtimeHandlers>[0],
          () => makeConfig(false) as never,
          () => [browserTool, safeTool] as never,
          '/tmp/kai-test-home',
        );
      },
    });

    const start = harness.invoke('realtime:start-session', { __kaiWebBridge: true, sender: null }, 'conv-web');
    const session = await waitForSession(1);
    session.startResolve();
    await start;

    expect(session.initialTools).toEqual([safeTool]);
    expect(cancelAssistantContinuations).not.toHaveBeenCalled();
    expect(session.toolUpdates).toEqual([]);
    updateActiveRealtimeSessionTools([browserTool, safeTool] as never);
    expect(session.toolUpdates.at(-1)).toEqual([safeTool]);
    await harness.invoke('realtime:end-session', FAKE_EVENT);
  });

  it('does not register Browser ownership when a primary Realtime session has no Browser tool', async () => {
    const browserTool = { name: 'browser_tabs', source: 'browser' };
    const safeTool = { name: 'search', source: 'builtin' };
    const primarySender = { id: 1, mainFrame: {} };
    const primaryEvent = { sender: primarySender, senderFrame: primarySender.mainFrame };
    const secondaryEvent = { sender: { id: 2 }, senderFrame: {} };
    const harness = await createIpcHarness({
      registerHandlers: (ipc) => {
        registerRealtimeHandlers(
          ipc as Parameters<typeof registerRealtimeHandlers>[0],
          () => makeConfig(false) as never,
          () => [safeTool] as never,
          '/tmp/kai-test-home',
          () => ({ isDestroyed: () => false, webContents: primarySender }) as never,
        );
      },
    });

    const start = harness.invoke('realtime:start-session', primaryEvent, 'conv-no-browser-tool');
    const session = await waitForSession(1);
    session.startResolve();
    await expect(start).resolves.toEqual({ ok: true });

    expect(session.initialTools).toEqual([safeTool]);
    expect(beginAssistantRun).not.toHaveBeenCalled();
    updateActiveRealtimeSessionTools([browserTool, safeTool] as never);
    expect(session.toolUpdates.at(-1)).toEqual([safeTool]);
    await expect(harness.invoke('realtime:end-session', secondaryEvent)).resolves.toEqual({ ok: true });
  });

  it('exposes browser tools only to the primary Electron renderer', async () => {
    const browserTool = { name: 'browser_tabs', source: 'browser' };
    const safeTool = { name: 'search', source: 'builtin' };
    const primarySender = { id: 1, mainFrame: {} };
    const primaryEvent = { sender: primarySender, senderFrame: primarySender.mainFrame };
    const harness = await createIpcHarness({
      registerHandlers: (ipc) => {
        registerRealtimeHandlers(
          ipc as Parameters<typeof registerRealtimeHandlers>[0],
          () => makeConfig(false) as never,
          () => [browserTool, safeTool] as never,
          '/tmp/kai-test-home',
          () => ({ isDestroyed: () => false, webContents: primarySender }) as never,
        );
      },
    });

    const primaryStart = harness.invoke('realtime:start-session', primaryEvent, 'conv-primary');
    (await waitForSession(1)).startResolve();
    await primaryStart;
    expect(built[0].initialTools).toEqual([browserTool, safeTool]);
    expect(built[0].toolUpdates).toEqual([]);
    expect(cancelAssistantContinuations).toHaveBeenCalledWith('conv-primary');
    expect(beginAssistantRun).toHaveBeenCalledWith('conv-primary', built[0].browserOwnerId, 'realtime');
    await harness.invoke('realtime:end-session', primaryEvent);

    const subframeStart = harness.invoke(
      'realtime:start-session',
      { sender: primarySender, senderFrame: {} },
      'conv-primary-subframe',
    );
    (await waitForSession(2)).startResolve();
    await subframeStart;
    expect(built[1].initialTools).toEqual([safeTool]);
    expect(cancelAssistantContinuations).not.toHaveBeenCalledWith('conv-primary-subframe');
    await harness.invoke('realtime:end-session', FAKE_EVENT);

    const secondaryStart = harness.invoke('realtime:start-session', { sender: { id: 2 } }, 'conv-secondary');
    (await waitForSession(3)).startResolve();
    await secondaryStart;
    expect(built[2].initialTools).toEqual([safeTool]);
    expect(cancelAssistantContinuations).not.toHaveBeenCalledWith('conv-secondary');
    await harness.invoke('realtime:end-session', FAKE_EVENT);
  });

  it('rejects Browser-authorized Realtime startup while another assistant modality owns the conversation', async () => {
    beginAssistantRun.mockImplementationOnce(() => {
      throw new Error("Another assistant modality is already using this conversation's Browser tabs.");
    });
    const browserTool = { name: 'browser_tabs', source: 'browser' };
    const primarySender = { id: 1, mainFrame: {} };
    const primaryEvent = { sender: primarySender, senderFrame: primarySender.mainFrame };
    const harness = await createIpcHarness({
      registerHandlers: (ipc) => {
        registerRealtimeHandlers(
          ipc as Parameters<typeof registerRealtimeHandlers>[0],
          () => makeConfig(false) as never,
          () => [browserTool] as never,
          '/tmp/kai-test-home',
          () => ({ isDestroyed: () => false, webContents: primarySender }) as never,
        );
      },
    });

    const result = await harness.invoke<{ error?: string }>('realtime:start-session', primaryEvent, 'conv-busy');

    expect(result.error).toMatch(/another assistant modality/i);
    expect(built).toHaveLength(1);
    expect(built[0].startCalls).toBe(0);
    expect(built[0].closed).toBe(true);
    expect(beginAssistantRun).toHaveBeenCalledWith('conv-busy', built[0].browserOwnerId, 'realtime');
  });

  it('rejects secondary start and end calls while a Browser-authorized session is active', async () => {
    const browserTool = { name: 'browser_tabs', source: 'browser' };
    const primarySender = { id: 1, mainFrame: {} };
    const primaryEvent = { sender: primarySender, senderFrame: primarySender.mainFrame };
    const secondaryEvent = { sender: { id: 2 }, senderFrame: {} };
    const harness = await createIpcHarness({
      registerHandlers: (ipc) => {
        registerRealtimeHandlers(
          ipc as Parameters<typeof registerRealtimeHandlers>[0],
          () => makeConfig(false) as never,
          () => [browserTool] as never,
          '/tmp/kai-test-home',
          () => ({ isDestroyed: () => false, webContents: primarySender }) as never,
        );
      },
    });

    const start = harness.invoke('realtime:start-session', primaryEvent, 'conv-browser-active');
    expect(isRealtimeConversationTurnActive('conv-browser-active')).toBe(true);
    expect(isRealtimeConversationBrowserAuthorized('conv-browser-active')).toBe(true);
    const session = await waitForSession(1);
    session.startResolve();
    expect(await start).toEqual({ ok: true });
    expect(isRealtimeConversationTurnActive('conv-browser-active')).toBe(true);
    expect(isRealtimeConversationBrowserAuthorized('conv-browser-active')).toBe(true);

    await expect(
      harness.invoke<{ error?: string }>('realtime:start-session', secondaryEvent, 'conv-secondary'),
    ).resolves.toEqual({
      error: 'Only the current primary renderer can replace a Browser-authorized realtime session.',
    });
    await expect(harness.invoke<{ error?: string }>('realtime:end-session', secondaryEvent)).resolves.toEqual({
      error: 'Only the current primary renderer can end a Browser-authorized realtime session.',
    });
    expect(built).toHaveLength(1);
    expect(session.closed).toBe(false);
    expect((await harness.invoke<{ status: string }>('realtime:get-status', secondaryEvent)).status).toBe('connected');

    expect(await harness.invoke('realtime:end-session', primaryEvent)).toEqual({ ok: true });
    expect(session.closed).toBe(true);
    expect(isRealtimeConversationTurnActive('conv-browser-active')).toBe(false);
    expect(isRealtimeConversationBrowserAuthorized('conv-browser-active')).toBe(false);
  });

  it('rejects secondary start and end calls while a Browser-authorized start is pending', async () => {
    const browserTool = { name: 'browser_tabs', source: 'browser' };
    const primarySender = { id: 1, mainFrame: {} };
    const primaryEvent = { sender: primarySender, senderFrame: primarySender.mainFrame };
    const secondaryEvent = { sender: { id: 2 }, senderFrame: {} };
    const harness = await createIpcHarness({
      registerHandlers: (ipc) => {
        registerRealtimeHandlers(
          ipc as Parameters<typeof registerRealtimeHandlers>[0],
          () => makeConfig(false) as never,
          () => [browserTool] as never,
          '/tmp/kai-test-home',
          () => ({ isDestroyed: () => false, webContents: primarySender }) as never,
        );
      },
    });

    const start = harness.invoke('realtime:start-session', primaryEvent, 'conv-browser-pending');
    const session = await waitForSession(1);
    await vi.waitFor(() =>
      expect(beginAssistantRun).toHaveBeenCalledWith('conv-browser-pending', session.browserOwnerId, 'realtime'),
    );

    expect(
      await harness.invoke<{ error?: string }>('realtime:start-session', secondaryEvent, 'conv-secondary'),
    ).toEqual({ error: 'Only the current primary renderer can replace a Browser-authorized realtime session.' });
    expect(await harness.invoke<{ error?: string }>('realtime:end-session', secondaryEvent)).toEqual({
      error: 'Only the current primary renderer can end a Browser-authorized realtime session.',
    });
    expect(built).toHaveLength(1);
    expect(session.closed).toBe(false);

    session.startResolve();
    expect(await start).toEqual({ ok: true });
    expect(await harness.invoke('realtime:end-session', primaryEvent)).toEqual({ ok: true });
  });

  it('reserves primary authority while a Browser-origin start is building memory context', async () => {
    const browserTool = { name: 'browser_tabs', source: 'browser' };
    const primarySender = { id: 1, mainFrame: {} };
    const primaryEvent = { sender: primarySender, senderFrame: primarySender.mainFrame };
    const secondaryFrame = {};
    const secondaryEvent = {
      sender: { id: 2, mainFrame: secondaryFrame },
      senderFrame: secondaryFrame,
    };
    let releaseMemory!: (value: string) => void;
    memoryContextGate = new Promise<string>((resolve) => {
      releaseMemory = resolve;
    });
    const harness = await createIpcHarness({
      registerHandlers: (ipc) => {
        registerRealtimeHandlers(
          ipc as Parameters<typeof registerRealtimeHandlers>[0],
          () => makeConfig(true) as never,
          () => [browserTool] as never,
          '/tmp/kai-test-home',
          () => ({ isDestroyed: () => false, webContents: primarySender }) as never,
        );
      },
    });

    const start = harness.invoke('realtime:start-session', primaryEvent, 'conv-memory-pending');
    await Promise.resolve();
    expect(built).toHaveLength(0);
    expect(
      await harness.invoke<{ error?: string }>('realtime:start-session', secondaryEvent, 'conv-secondary'),
    ).toEqual({ error: 'Only the current primary renderer can replace a Browser-authorized realtime session.' });
    expect(await harness.invoke<{ error?: string }>('realtime:end-session', secondaryEvent)).toEqual({
      error: 'Only the current primary renderer can end a Browser-authorized realtime session.',
    });

    releaseMemory('context');
    const session = await waitForSession(1);
    session.startResolve();
    expect(await start).toEqual({ ok: true });
    expect(await harness.invoke('realtime:end-session', primaryEvent)).toEqual({ ok: true });
  });

  it('does not acquire Browser tools that appear after start admission', async () => {
    const browserTool = { name: 'browser_tabs', source: 'browser' };
    const safeTool = { name: 'search', source: 'builtin' };
    let availableTools = [safeTool];
    const primarySender = { id: 1, mainFrame: {} };
    const primaryEvent = { sender: primarySender, senderFrame: primarySender.mainFrame };
    const secondaryEvent = { sender: { id: 2 }, senderFrame: {} };
    let releaseMemory!: (value: string) => void;
    memoryContextGate = new Promise<string>((resolve) => {
      releaseMemory = resolve;
    });
    const harness = await createIpcHarness({
      registerHandlers: (ipc) => {
        registerRealtimeHandlers(
          ipc as Parameters<typeof registerRealtimeHandlers>[0],
          () => makeConfig(true) as never,
          () => availableTools as never,
          '/tmp/kai-test-home',
          () => ({ isDestroyed: () => false, webContents: primarySender }) as never,
        );
      },
    });

    const start = harness.invoke('realtime:start-session', primaryEvent, 'conv-late-browser-tools');
    await Promise.resolve();
    availableTools = [safeTool, browserTool];
    releaseMemory('context');
    const session = await waitForSession(1);

    expect(session.initialTools).toEqual([safeTool]);
    expect(beginAssistantRun).not.toHaveBeenCalled();
    session.startResolve();
    expect(await start).toEqual({ ok: true });
    expect(await harness.invoke('realtime:end-session', secondaryEvent)).toEqual({ ok: true });
  });

  it('accepts audio only from the initiating primary renderer while Browser tools are authorized', async () => {
    const browserTool = { name: 'browser_tabs', source: 'browser' };
    const primarySender = { id: 1, mainFrame: {} };
    const harness = await createIpcHarness({
      registerHandlers: (ipc) => {
        registerRealtimeHandlers(
          ipc as Parameters<typeof registerRealtimeHandlers>[0],
          () => makeConfig(false) as never,
          () => [browserTool] as never,
          '/tmp/kai-test-home',
          () => ({ isDestroyed: () => false, webContents: primarySender }) as never,
        );
      },
    });
    const primaryEvent = { sender: primarySender, senderFrame: primarySender.mainFrame };
    const start = harness.invoke('realtime:start-session', primaryEvent, 'conv-primary-audio');
    const session = await waitForSession(1);
    session.startResolve();
    await start;

    harness.send('realtime:send-audio', { sender: null, __kaiWebBridge: true }, 'web-frame');
    harness.send('realtime:send-audio', { sender: { id: 2 }, senderFrame: {} }, 'secondary-frame');
    expect(session.audioFrames).toEqual([]);

    harness.send('realtime:send-audio', primaryEvent, 'primary-frame');
    expect(session.audioFrames).toEqual(['primary-frame']);
    await harness.invoke('realtime:end-session', primaryEvent);
  });

  it('revokes browser tools from a pending primary start without allowing hot-update restoration', async () => {
    const browserTool = { name: 'browser_tabs', source: 'browser' };
    const safeTool = { name: 'search', source: 'builtin' };
    const primarySender = { id: 1, mainFrame: {} };
    const harness = await createIpcHarness({
      registerHandlers: (ipc) => {
        registerRealtimeHandlers(
          ipc as Parameters<typeof registerRealtimeHandlers>[0],
          () => makeConfig(false) as never,
          () => [browserTool, safeTool] as never,
          '/tmp/kai-test-home',
          () => ({ isDestroyed: () => false, webContents: primarySender }) as never,
        );
      },
    });

    const primaryEvent = { sender: primarySender, senderFrame: primarySender.mainFrame };
    const start = harness.invoke('realtime:start-session', primaryEvent, 'conv-revoked');
    const session = await waitForSession(1);
    expect(session.initialTools).toEqual([browserTool, safeTool]);

    revokeRealtimeBrowserTools([browserTool, safeTool] as never);
    expect(session.toolUpdates.at(-1)).toEqual([safeTool]);
    session.startResolve();
    expect(await start).toEqual({ ok: true });

    updateActiveRealtimeSessionTools([browserTool, safeTool] as never);
    expect(session.toolUpdates.at(-1)).toEqual([safeTool]);
    await harness.invoke('realtime:end-session', primaryEvent);
  });

  it('does not restore Browser tools to an already-active call after revocation', async () => {
    const browserTool = { name: 'browser_tabs', source: 'browser' };
    const safeTool = { name: 'search', source: 'builtin' };
    const primarySender = { id: 1, mainFrame: {} };
    const harness = await createIpcHarness({
      registerHandlers: (ipc) => {
        registerRealtimeHandlers(
          ipc as Parameters<typeof registerRealtimeHandlers>[0],
          () => makeConfig(false) as never,
          () => [browserTool, safeTool] as never,
          '/tmp/kai-test-home',
          () => ({ isDestroyed: () => false, webContents: primarySender }) as never,
        );
      },
    });
    const primaryEvent = { sender: primarySender, senderFrame: primarySender.mainFrame };
    const start = harness.invoke('realtime:start-session', primaryEvent, 'conv-active-revoked');
    const session = await waitForSession(1);
    session.startResolve();
    expect(await start).toEqual({ ok: true });

    revokeRealtimeBrowserTools([browserTool, safeTool] as never);
    updateActiveRealtimeSessionTools([browserTool, safeTool] as never);

    expect(session.toolUpdates.at(-1)).toEqual([safeTool]);
    const secondaryFrame = {};
    const secondaryEvent = {
      sender: { id: 2, mainFrame: secondaryFrame },
      senderFrame: secondaryFrame,
    };
    expect(await harness.invoke<{ error?: string }>('realtime:end-session', secondaryEvent)).toEqual({
      error: 'Only the current primary renderer can end a Browser-authorized realtime session.',
    });
    harness.send('realtime:send-audio', secondaryEvent, 'secondary-after-revocation');
    expect(session.audioFrames).toEqual([]);
    await harness.invoke('realtime:end-session', primaryEvent);
  });

  it('owns Realtime approvals and dismisses only Browser prompts when Browser authority is revoked', async () => {
    const browserTool = { name: 'browser_tabs', source: 'browser' };
    const safeTool = { name: 'mcp_servers', source: 'builtin' };
    const primarySender = { id: 1, mainFrame: {} };
    const primaryEvent = { sender: primarySender, senderFrame: primarySender.mainFrame };
    const harness = await createIpcHarness({
      registerHandlers: (ipc) => {
        registerRealtimeHandlers(
          ipc as Parameters<typeof registerRealtimeHandlers>[0],
          () => makeConfig(false) as never,
          () => [browserTool, safeTool] as never,
          '/tmp/kai-test-home',
          () => ({ isDestroyed: () => false, webContents: primarySender }) as never,
        );
      },
    });
    setToolApprovalOwnerResolver((conversationId, browserOwnerId, authority) => {
      const isCurrent = resolveRealtimeBrowserApprovalOwner(conversationId, browserOwnerId, authority);
      return isCurrent ? { conversationId, streamToken: browserOwnerId, isCurrent } : undefined;
    });
    const start = harness.invoke('realtime:start-session', primaryEvent, 'conv-realtime-approval');
    const session = await waitForSession(1);
    session.startResolve();
    expect(await start).toEqual({ ok: true });

    const nativeDecision = registerPendingApproval('realtime-browser-approval', undefined, 'native-browser', {
      conversationId: 'conv-realtime-approval',
      browserOwnerId: session.browserOwnerId,
    });
    const genericDecision = registerPendingApproval('realtime-generic-approval', undefined, 'any-renderer', {
      conversationId: 'conv-realtime-approval',
      browserOwnerId: session.browserOwnerId,
    });
    const genericOwner = pendingToolApprovals.get('realtime-generic-approval')?.streamOwner;
    expect(genericOwner?.isCurrent?.()).toBe(true);
    expect(
      mayBroadcastApprovalToWebClients({
        type: 'tool-approval-required',
        conversationId: 'conv-realtime-approval',
        toolCallId: 'realtime-generic-approval',
        toolName: 'mcp_servers',
      } as never),
    ).toBe(false);

    revokeRealtimeBrowserTools([browserTool, safeTool] as never);

    await expect(nativeDecision).resolves.toBe('dismiss');
    expect(() =>
      registerPendingApproval('realtime-browser-approval-late', undefined, 'native-browser', {
        conversationId: 'conv-realtime-approval',
        browserOwnerId: session.browserOwnerId,
      }),
    ).toThrow(/no longer authorized/);
    expect(pendingToolApprovals.has('realtime-browser-approval-late')).toBe(false);
    expect(pendingToolApprovals.has('realtime-generic-approval')).toBe(true);
    expect(genericOwner?.isCurrent?.()).toBe(true);
    pendingToolApprovals.get('realtime-generic-approval')!.resolve(false);
    await expect(genericDecision).resolves.toBe(false);
    await harness.invoke('realtime:end-session', primaryEvent);
    expect(genericOwner?.isCurrent?.()).toBe(false);
  });

  it('revalidates the initiating primary renderer before installing browser tools', async () => {
    const browserTool = { name: 'browser_tabs', source: 'browser' };
    const safeTool = { name: 'search', source: 'builtin' };
    const primarySender = { id: 1, mainFrame: {} };
    let destroyed = false;
    const harness = await createIpcHarness({
      registerHandlers: (ipc) => {
        registerRealtimeHandlers(
          ipc as Parameters<typeof registerRealtimeHandlers>[0],
          () => makeConfig(false) as never,
          () => [browserTool, safeTool] as never,
          '/tmp/kai-test-home',
          () => ({ isDestroyed: () => destroyed, webContents: primarySender }) as never,
        );
      },
    });

    const start = harness.invoke(
      'realtime:start-session',
      { sender: primarySender, senderFrame: primarySender.mainFrame },
      'conv-renderer-gone',
    );
    const session = await waitForSession(1);
    destroyed = true;
    session.startResolve();
    expect(await start).toEqual({ ok: true });
    expect(session.toolUpdates.at(-1)).toEqual([safeTool]);

    updateActiveRealtimeSessionTools([browserTool, safeTool] as never);
    expect(session.toolUpdates.at(-1)).toEqual([safeTool]);
    await harness.invoke('realtime:end-session', FAKE_EVENT);
  });

  it('revokes a pending browser run when the host renderer generation changes during connect', async () => {
    const browserTool = { name: 'browser_tabs', source: 'browser' };
    const safeTool = { name: 'search', source: 'builtin' };
    const primarySender = { id: 1, mainFrame: {} };
    const harness = await createIpcHarness({
      registerHandlers: (ipc) => {
        registerRealtimeHandlers(
          ipc as Parameters<typeof registerRealtimeHandlers>[0],
          () => makeConfig(false) as never,
          () => [browserTool, safeTool] as never,
          '/tmp/kai-test-home',
          () => ({ isDestroyed: () => false, webContents: primarySender }) as never,
        );
      },
    });

    const start = harness.invoke(
      'realtime:start-session',
      { sender: primarySender, senderFrame: primarySender.mainFrame },
      'conv-generation-change',
    );
    const session = await waitForSession(1);
    await vi.waitFor(() =>
      expect(beginAssistantRun).toHaveBeenCalledWith('conv-generation-change', session.browserOwnerId, 'realtime'),
    );
    browserManager.authorityGeneration++;
    session.startResolve();

    expect(await start).toEqual({ ok: true });
    expect(session.toolUpdates.at(-1)).toEqual([safeTool]);
    expect(cleanupAssistantTabs).toHaveBeenCalledWith('conv-generation-change', session.browserOwnerId);
    await harness.invoke('realtime:end-session', FAKE_EVENT);
  });

  it('reclaims assistant tabs and usage when the provider terminates the call', async () => {
    const h = await harnessWith();
    const start = h.invoke('realtime:start-session', FAKE_EVENT, 'conv-remote');
    const session = await waitForSession(1);
    session.startResolve();
    await start;

    session.remoteTerminate();

    expect((await h.invoke<{ status: string }>('realtime:get-status', FAKE_EVENT)).status).toBe('idle');
    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0]).toMatchObject({ conversationId: 'conv-remote' });
    expect(cleanupAssistantTabs).toHaveBeenCalledWith('conv-remote', session.browserOwnerId);
  });

  it('stops an active call when its conversation is deleted', async () => {
    const h = await harnessWith();
    const start = h.invoke('realtime:start-session', FAKE_EVENT, 'conv-delete');
    const session = await waitForSession(1);
    session.startResolve();
    await start;

    stopRealtimeSessionForConversation('conv-delete');

    expect(session.closed).toBe(true);
    expect((await h.invoke<{ status: string }>('realtime:get-status', FAKE_EVENT)).status).toBe('idle');
    expect(cleanupAssistantTabs).toHaveBeenCalledWith('conv-delete', session.browserOwnerId);
  });

  it('a start superseded during memory-context build aborts and never records usage', async () => {
    // This harness enables memoryContext so the start awaits the (gated) builder,
    // giving us a window to fire end-session mid-build.
    const h = await createIpcHarness({
      registerHandlers: (ipc) => {
        registerRealtimeHandlers(
          ipc as Parameters<typeof registerRealtimeHandlers>[0],
          () => ({ realtime: { memoryContext: { enabled: true } } }) as never,
          () => [],
          '/tmp/kai-test-home',
        );
      },
    });

    let releaseMemory!: (s: string) => void;
    memoryContextGate = new Promise<string>((res) => {
      releaseMemory = res;
    });

    const startP = h.invoke<{ ok?: boolean; error?: string }>('realtime:start-session', FAKE_EVENT, 'conv-super');
    // While the start is parked awaiting memory context, the user hangs up.
    await h.invoke('realtime:end-session', FAKE_EVENT);
    // Now let the memory build finish — the start must detect it's stale and abort.
    releaseMemory('some context');
    const result = await startP;

    expect(result.error).toMatch(/superseded/i);
    // The superseded start never built/installed a session (aborted before
    // constructing one), so no usage is recorded and no session leaks.
    expect(usageEvents).toHaveLength(0);
    expect(built).toHaveLength(0);
  });

  it('does not reconnect a stale session after browser continuation cleanup drains', async () => {
    let releaseBrowserDrain!: () => void;
    cancelAssistantContinuations.mockImplementationOnce(
      () =>
        new Promise<undefined>((resolve) => {
          releaseBrowserDrain = () => resolve(undefined);
        }),
    );
    const primarySender = { mainFrame: {} };
    const primaryEvent = { sender: primarySender, senderFrame: primarySender.mainFrame } as unknown;
    const h = await createIpcHarness({
      registerHandlers: (ipc) => {
        registerRealtimeHandlers(
          ipc as Parameters<typeof registerRealtimeHandlers>[0],
          () => makeConfig(false) as never,
          () => [{ name: 'browser_tabs', source: 'browser' }] as never,
          '/tmp/kai-test-home',
          () => ({ isDestroyed: () => false, webContents: primarySender }) as never,
        );
      },
    });
    const start = h.invoke<{ error?: string }>('realtime:start-session', primaryEvent, 'conv-browser-drain');
    const session = await waitForSession(1);
    await vi.waitFor(() => expect(cancelAssistantContinuations).toHaveBeenCalledWith('conv-browser-drain'));

    await h.invoke('realtime:end-session', primaryEvent);
    releaseBrowserDrain();

    expect((await start).error).toMatch(/superseded/i);
    expect(session.startCalls).toBe(0);
    expect(beginAssistantRun).not.toHaveBeenCalledWith('conv-browser-drain', session.browserOwnerId, 'realtime');
  });

  it('does not register a browser run when renderer authority changes during continuation cleanup', async () => {
    let releaseBrowserDrain!: () => void;
    cancelAssistantContinuations.mockImplementationOnce(
      () =>
        new Promise<undefined>((resolve) => {
          releaseBrowserDrain = () => resolve(undefined);
        }),
    );
    const browserTool = { name: 'browser_tabs', source: 'browser' };
    const safeTool = { name: 'search', source: 'builtin' };
    const primarySender = { mainFrame: {} };
    const h = await createIpcHarness({
      registerHandlers: (ipc) => {
        registerRealtimeHandlers(
          ipc as Parameters<typeof registerRealtimeHandlers>[0],
          () => makeConfig(false) as never,
          () => [browserTool, safeTool] as never,
          '/tmp/kai-test-home',
          () => ({ isDestroyed: () => false, webContents: primarySender }) as never,
        );
      },
    });
    const start = h.invoke(
      'realtime:start-session',
      { sender: primarySender, senderFrame: primarySender.mainFrame },
      'conv-authority-drain',
    );
    const session = await waitForSession(1);
    await vi.waitFor(() => expect(cancelAssistantContinuations).toHaveBeenCalledWith('conv-authority-drain'));

    browserManager.authorityGeneration++;
    releaseBrowserDrain();
    await vi.waitFor(() => expect(session.startCalls).toBe(1));
    session.startResolve();

    expect(await start).toEqual({ ok: true });
    expect(beginAssistantRun).not.toHaveBeenCalledWith('conv-authority-drain', session.browserOwnerId, 'realtime');
    expect(session.toolUpdates.at(-1)).toEqual([safeTool]);
    await h.invoke('realtime:end-session', FAKE_EVENT);
  });

  it('a deleted conversation cannot finish a pending Realtime start', async () => {
    const h = await createIpcHarness({
      registerHandlers: (ipc) => {
        registerRealtimeHandlers(
          ipc as Parameters<typeof registerRealtimeHandlers>[0],
          () => ({ realtime: { memoryContext: { enabled: true } } }) as never,
          () => [],
          '/tmp/kai-test-home',
        );
      },
    });
    let releaseMemory!: (s: string) => void;
    memoryContextGate = new Promise<string>((resolve) => {
      releaseMemory = resolve;
    });

    const start = h.invoke<{ error?: string }>('realtime:start-session', FAKE_EVENT, 'conv-deleted-pending');
    stopRealtimeSessionForConversation('conv-deleted-pending');
    releaseMemory('context');

    expect((await start).error).toMatch(/superseded/i);
    expect(built).toHaveLength(0);
  });

  it('deletion immediately closes a socket that is still connecting', async () => {
    const h = await harnessWith();
    const start = h.invoke<{ error?: string }>('realtime:start-session', FAKE_EVENT, 'conv-connecting');
    const session = await waitForSession(1);

    stopRealtimeSessionForConversation('conv-connecting');

    expect(session.closed).toBe(true);
    expect((await start).error).toMatch(/superseded/i);
    expect((await h.invoke<{ status: string }>('realtime:get-status', FAKE_EVENT)).status).toBe('idle');
  });

  it('hangup immediately closes a socket that is still connecting', async () => {
    const h = await harnessWith();
    const start = h.invoke<{ error?: string }>('realtime:start-session', FAKE_EVENT, 'conv-hangup-connecting');
    const session = await waitForSession(1);

    await h.invoke('realtime:end-session', FAKE_EVENT);

    expect(session.closed).toBe(true);
    expect((await start).error).toMatch(/superseded/i);
    expect((await h.invoke<{ status: string }>('realtime:get-status', FAKE_EVENT)).status).toBe('idle');
  });
});
