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
  startResolve!: () => void;
  startReject!: (e: Error) => void;
  private startPromise: Promise<void>;
  constructor() {
    this.startPromise = new Promise((res, rej) => {
      this.startResolve = res;
      this.startReject = rej;
    });
    built.push(this);
  }
  async start(): Promise<void> {
    return this.startPromise;
  }
  close(): void {
    this.closed = true;
  }
  get status() {
    return 'active';
  }
  updateTools() {}
  sendAudio() {}
}
vi.mock('../../realtime/realtime-session.js', () => ({
  // Must be constructable (`new RealtimeSession(...)`), so expose the class itself
  // rather than an arrow factory (arrows can't be used with `new`).
  RealtimeSession: FakeSession,
}));

const { registerRealtimeHandlers } = await import('../realtime.js');

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
  const h = await createIpcHarness({
    registerHandlers: (ipc) => {
      registerRealtimeHandlers(
        ipc as Parameters<typeof registerRealtimeHandlers>[0],
        () => makeConfig(false) as never,
        () => [],
        '/tmp/kai-test-home',
      );
    },
  });
  await h.invoke('realtime:end-session', {} as unknown);
}

afterEach(async () => {
  await forceEndAnySession();
  usageEvents.length = 0;
  built.length = 0;
});

describe('realtime IPC — start/end lifecycle + usage', () => {
  it('start then end records exactly one realtime usage event and closes the session', async () => {
    const h = await harnessWith();
    const startP = h.invoke('realtime:start-session', FAKE_EVENT, 'conv-A');
    // memoryContext disabled → start proceeds to build the session; resolve its
    // start() promise so the handler installs it.
    (await waitForSession(1)).startResolve();
    expect(await startP).toEqual({ ok: true });

    const status = await h.invoke<{ status: string }>('realtime:get-status', FAKE_EVENT);
    expect(status.status).toBe('active');

    expect(await h.invoke('realtime:end-session', FAKE_EVENT)).toEqual({ ok: true });
    expect(built[0].closed).toBe(true);
    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0]).toMatchObject({ modality: 'realtime', conversationId: 'conv-A' });

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

    // Ending the second records the second.
    await h.invoke('realtime:end-session', FAKE_EVENT);
    expect(usageEvents).toHaveLength(2);
    expect(usageEvents[1]).toMatchObject({ conversationId: 'conv-2' });
  });

  it('end-session with no active session records nothing and is a no-op', async () => {
    const h = await harnessWith();
    expect(await h.invoke('realtime:end-session', FAKE_EVENT)).toEqual({ ok: true });
    expect(usageEvents).toHaveLength(0);
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
});
