/**
 * Tests for TaskTerminalManager's exit-code lifecycle — the part that was a
 * genuine unbounded main-process leak. `exitCodes` is only cleared by a
 * pre-registered callback, consumeExitCode, or app-shutdown dispose(); renderer-
 * created sessions (tasks:terminal-create) register NO callback and are not
 * reconciled, so their exit codes would otherwise persist forever. The fix:
 *   1. bounded insertion-order eviction (MAX_EXIT_CODES) so the map can't grow
 *      without limit,
 *   2. onSessionExit replays an already-recorded exit (fixes the create()→exit→
 *      late-register race that previously dropped the exit entirely),
 *   3. a callback waiting at exit time consumes the code directly (never cached),
 *      and a throwing callback still broadcasts + cleans up.
 *
 * We mock @lydell/node-pty with a fake whose onExit callback the test fires on
 * demand, so the real create()/onExit path runs without a native PTY.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Controllable fake PTY. Each spawn() captures its onExit/onData callbacks so a
// test can drive the exit synchronously.
type ExitCb = (e: { exitCode: number }) => void;
const spawned: Array<{ fireExit: (code: number) => void; killed: boolean }> = [];

vi.mock('@lydell/node-pty', () => ({
  spawn: vi.fn(() => {
    let exitCb: ExitCb | null = null;
    const rec = {
      killed: false,
      fireExit: (code: number) => exitCb?.({ exitCode: code }),
    };
    spawned.push(rec);
    return {
      onData: (_cb: (d: string) => void) => {},
      onExit: (cb: ExitCb) => {
        exitCb = cb;
      },
      write: () => {},
      resize: () => {},
      kill: () => {
        rec.killed = true;
      },
    };
  }),
}));

// broadcastToAllWindows touches Electron BrowserWindow — stub it.
vi.mock('../../utils/window-send.js', () => ({ broadcastToAllWindows: vi.fn() }));
// output-buffer appends to module-global maps + disk; stub the append we hit.
vi.mock('../output-buffer.js', () => ({ appendOutput: vi.fn(), getBuffer: vi.fn(() => '') }));

const { TaskTerminalManager, __internal } = await import('../task-terminal-manager.js');

beforeEach(() => {
  spawned.length = 0;
});

async function spawnSession(mgr: InstanceType<typeof TaskTerminalManager>): Promise<{
  sessionId: string;
  fireExit: (code: number) => void;
}> {
  const before = spawned.length;
  const sessionId = await mgr.create('task-1', { runtime: 'shell' });
  const rec = spawned[before];
  return { sessionId, fireExit: rec.fireExit };
}

describe('TaskTerminalManager exit-code lifecycle', () => {
  it('caches an exit code when no callback is waiting, and consumeExitCode reads+clears it', async () => {
    const mgr = new TaskTerminalManager();
    const { sessionId, fireExit } = await spawnSession(mgr);
    fireExit(7);
    expect(mgr.getExitCode(sessionId)).toBe(7); // recorded, not yet consumed
    expect(mgr.consumeExitCode(sessionId)).toBe(7);
    expect(mgr.getExitCode(sessionId)).toBeUndefined(); // cleared on consume
    expect(mgr.consumeExitCode(sessionId)).toBeUndefined(); // second consume is empty
  });

  it('onSessionExit registered BEFORE exit fires the callback and does NOT cache the code', async () => {
    const mgr = new TaskTerminalManager();
    const { sessionId, fireExit } = await spawnSession(mgr);
    const seen: number[] = [];
    mgr.onSessionExit(sessionId, (c) => seen.push(c));
    fireExit(0);
    expect(seen).toEqual([0]);
    // A waiting callback consumes the exit directly — nothing left to leak.
    expect(mgr.getExitCode(sessionId)).toBeUndefined();
  });

  it('onSessionExit registered AFTER a fast exit replays the recorded code immediately (race fix)', async () => {
    const mgr = new TaskTerminalManager();
    const { sessionId, fireExit } = await spawnSession(mgr);
    // PTY exits BEFORE the caller gets to register (the create()→exit→register race).
    fireExit(3);
    const seen: number[] = [];
    mgr.onSessionExit(sessionId, (c) => seen.push(c));
    // The late registration must not drop the exit — it replays synchronously.
    expect(seen).toEqual([3]);
    // And it's consumed, not left cached.
    expect(mgr.getExitCode(sessionId)).toBeUndefined();
  });

  it('a throwing exit callback still cleans up (no stranded exitCallbacks entry)', async () => {
    const mgr = new TaskTerminalManager();
    const { sessionId, fireExit } = await spawnSession(mgr);
    mgr.onSessionExit(sessionId, () => {
      throw new Error('boom');
    });
    // The onExit closure invokes the callback in a try/finally; the throw
    // propagates out of the PTY event but the manager state is already cleaned.
    expect(() => fireExit(1)).toThrow('boom');
    // Callback was removed before firing, so a second exit can't re-invoke it,
    // and nothing is stranded in the exit-code cache for this consumed exit.
    expect(mgr.getExitCode(sessionId)).toBeUndefined();
  });

  it('bounds exitCodes: creating many orphaned (uncallbacked) exits never exceeds the cap', async () => {
    const mgr = new TaskTerminalManager();
    const CAP = 256;
    const ids: string[] = [];
    // Spawn cap+50 sessions and exit each with NO callback (the renderer-created
    // leak vector) — the map must evict oldest and stay bounded.
    for (let i = 0; i < CAP + 50; i++) {
      const { sessionId, fireExit } = await spawnSession(mgr);
      ids.push(sessionId);
      fireExit(i % 3);
    }
    // Count how many recorded codes remain by probing every id.
    const remaining = ids.filter((id) => mgr.getExitCode(id) !== undefined).length;
    expect(remaining).toBeLessThanOrEqual(CAP);
    // The oldest entries were evicted; the newest cap-worth survive.
    expect(mgr.getExitCode(ids[ids.length - 1])).toBeDefined();
    expect(mgr.getExitCode(ids[0])).toBeUndefined();
  });

  it('dispose() clears all cached exit codes', async () => {
    const mgr = new TaskTerminalManager();
    const { sessionId, fireExit } = await spawnSession(mgr);
    fireExit(2);
    expect(mgr.getExitCode(sessionId)).toBe(2);
    mgr.dispose();
    expect(mgr.getExitCode(sessionId)).toBeUndefined();
  });
});

describe('sanitizeDimension (renderer-supplied cols/rows → node-pty-safe)', () => {
  // node-pty's spawn/resize THROW on cols/rows that are <= 0, NaN, Infinity, or
  // non-integer, and the resize IPC is fire-and-forget (unhandled rejection +
  // dropped resize). sanitizeDimension clamps to a positive integer first.
  const { sanitizeDimension } = __internal;

  it('passes through a normal positive integer', () => {
    expect(sanitizeDimension(80, 80)).toBe(80);
    expect(sanitizeDimension(200, 24)).toBe(200);
  });

  it('floors a fractional value (node-pty native cast dislikes non-integers)', () => {
    expect(sanitizeDimension(80.9, 80)).toBe(80);
    expect(sanitizeDimension(1.5, 24)).toBe(1);
  });

  it('falls back for the values node-pty rejects: <=0, NaN, Infinity', () => {
    for (const bad of [0, -1, -999, NaN, Infinity, -Infinity]) {
      expect(sanitizeDimension(bad, 80), String(bad)).toBe(80);
    }
  });

  it('falls back for non-number junk (IPC JSON can carry anything)', () => {
    for (const bad of [undefined, null, 'abc', {}, [], 'NaN']) {
      expect(sanitizeDimension(bad, 24), JSON.stringify(bad)).toBe(24);
    }
  });

  it('coerces a numeric string to its integer value', () => {
    expect(sanitizeDimension('120', 80)).toBe(120);
  });

  it('caps an absurdly large value at 9999', () => {
    expect(sanitizeDimension(1e9, 80)).toBe(9999);
    expect(sanitizeDimension(10000, 24)).toBe(9999);
    expect(sanitizeDimension(9999, 24)).toBe(9999);
  });
});
