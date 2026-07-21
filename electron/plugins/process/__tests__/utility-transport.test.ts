/**
 * Unit test — UtilityTransport callback release protocol.
 *
 * Long-running plugins that churn tool/listener registrations must not retain
 * callbacks forever. The host posts `release-callback` once every host-side stub
 * for a callback id is GC'd; the utility then drops the id from its function
 * table. This test drives that message directly and verifies the callback is no
 * longer invokable (the transport replies "Unknown plugin callback").
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('electron', () => ({}));

const { UtilityTransport } = await import('../utility-transport.js');

type Listener = (event: { data: Record<string, unknown> }) => void;

/** Minimal ParentPort double: captures posted messages and lets the test inject
 *  inbound 'message' events. */
function makePort() {
  let listener: Listener | null = null;
  const posted: Array<Record<string, unknown>> = [];
  const port = {
    on: (_event: string, cb: Listener) => {
      listener = cb;
    },
    postMessage: (msg: Record<string, unknown>) => {
      posted.push(msg);
    },
  };
  return {
    port,
    posted,
    emit: (data: Record<string, unknown>) => listener?.({ data }),
  };
}

describe('UtilityTransport callback release', () => {
  it('drops a released callback so it can no longer be invoked', async () => {
    const { port, posted, emit } = makePort();
    const transport = new UtilityTransport(port as never);

    const fn = vi.fn(() => 'result');
    const id = transport.registerFunction(fn);

    // Invoking the callback works before release.
    emit({ type: 'callback', id: 1, callbackId: id, args: [] });
    await Promise.resolve();
    await Promise.resolve();
    expect(fn).toHaveBeenCalledTimes(1);
    const okReply = posted.find((m) => m.type === 'callback-result' && m.id === 1);
    expect(okReply?.ok).toBe(true);

    // Host GC'd all stubs → release-callback. The utility drops it.
    emit({ type: 'release-callback', callbackId: id });

    // A later invocation for the same id now fails as unknown (not re-invoked).
    emit({ type: 'callback', id: 2, callbackId: id, args: [] });
    await Promise.resolve();
    await Promise.resolve();
    expect(fn).toHaveBeenCalledTimes(1); // NOT called again
    const failReply = posted.find((m) => m.type === 'callback-result' && m.id === 2);
    expect(failReply?.ok).toBe(false);
  });

  it('assigns a fresh id per registration (no fn-identity dedup)', () => {
    const { port } = makePort();
    const transport = new UtilityTransport(port as never);
    const fn = () => 1;
    // Same fn object registered twice → two distinct ids. Unique-per-occurrence
    // ids are what make releases race-free (a release targets one occurrence).
    const id1 = transport.registerFunction(fn);
    const id2 = transport.registerFunction(fn);
    expect(id2).not.toBe(id1);
    // Releasing one leaves the other invokable.
    transport.releaseFunction(id1);
    const id3 = transport.registerFunction(fn);
    expect(id3).not.toBe(id2);
  });

  it('release of an unknown id is a no-op', () => {
    const { port } = makePort();
    const transport = new UtilityTransport(port as never);
    expect(() => transport.releaseFunction('nope')).not.toThrow();
    expect(() => transport.releaseFunction('')).not.toThrow();
  });

  it('rolls back callback ids registered before an encode failure (no leak)', () => {
    const { port, emit, posted } = makePort();
    const transport = new UtilityTransport(port as never);
    const fn = vi.fn(() => 'live');

    // First, a clean encode to learn which id the next callback would get, then
    // confirm THAT id is invokable — establishing the id→fn mapping works.
    const ok = transport.encode({ cb: fn }) as { cb: { id: string } };
    const liveId = ok.cb.id;
    emit({ type: 'callback', id: 1, callbackId: liveId, args: [] });

    // Now an encode that registers a NEW callback then throws on a later symbol.
    const doomed = vi.fn();
    expect(() => transport.encode({ cb: doomed, bad: Symbol('x') })).toThrow();

    // The doomed callback's id was rolled back: driving a callback for the id
    // that WOULD have been next (liveId's successor) finds nothing.
    const rolledBackId = `u${Number(liveId.slice(1)) + 1}`;
    emit({ type: 'callback', id: 2, callbackId: rolledBackId, args: [] });
    const reply = posted.find((m) => m.type === 'callback-result' && m.id === 2);
    expect(reply?.ok).toBe(false); // unknown callback → not retained
    expect(doomed).not.toHaveBeenCalled();
  });

  it('reconcile-callbacks sweeps orphaned pre-watermark ids the host does not hold', async () => {
    const { port, emit, posted } = makePort();
    const transport = new UtilityTransport(port as never);
    const held = vi.fn(() => 'held');
    const orphan = vi.fn(() => 'orphan');
    const heldId = transport.registerFunction(held); // u1
    const orphanId = transport.registerFunction(orphan); // u2
    const future = transport.registerFunction(() => 0); // u3 (created after watermark)

    // Host reconciles: it holds heldId, watermark = 2 (has seen u1 & u2). orphanId
    // (u2, ≤ watermark, not held) → swept. future (u3, > watermark) → kept.
    emit({ type: 'reconcile-callbacks', heldIds: [heldId], upToSeq: 2 });

    emit({ type: 'callback', id: 1, callbackId: heldId, args: [] });
    emit({ type: 'callback', id: 2, callbackId: orphanId, args: [] });
    emit({ type: 'callback', id: 3, callbackId: future, args: [] });
    await Promise.resolve();
    await Promise.resolve();

    const reply = (n: number) => posted.find((m) => m.type === 'callback-result' && m.id === n);
    expect(reply(1)?.ok).toBe(true); // held — kept
    expect(reply(2)?.ok).toBe(false); // orphan — swept
    expect(reply(3)?.ok).toBe(true); // post-watermark — kept (host may not have seen it)
    expect(orphan).not.toHaveBeenCalled();
  });
});
