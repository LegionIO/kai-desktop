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

  it('drain-ping is echoed as drain-pong over the same channel', () => {
    const { port, emit, posted } = makePort();
    const transport = new UtilityTransport(port as never);
    void transport;
    emit({ type: 'drain-ping', token: 42 });
    const pong = posted.find((m) => m.type === 'drain-pong');
    expect(pong?.token).toBe(42);
  });

  it('reconcile-callbacks sweeps unadopted ids the host does not hold, keeps held + adopted', async () => {
    const { port, emit, posted } = makePort();
    const transport = new UtilityTransport(port as never);
    const held = vi.fn(() => 'held');
    const adopted = vi.fn(() => 'adopted');
    const orphan = vi.fn(() => 'orphan');
    const heldId = transport.registerFunction(held);
    const adoptedId = transport.registerFunction(adopted);
    const orphanId = transport.registerFunction(orphan);

    // Host adopted adoptedId (took ownership); reconcile lists only heldId as held.
    emit({ type: 'callback-adopted', ids: [adoptedId] });
    // Establish the drain barrier FIRST (snapshots the creation watermark at the
    // current sequence), then the post-barrier sweep drops unadopted, not-held
    // ids created at/before the watermark.
    emit({ type: 'drain-ping', token: 1 });
    emit({ type: 'reconcile-callbacks', heldIds: [heldId] });

    emit({ type: 'callback', id: 1, callbackId: heldId, args: [] });
    emit({ type: 'callback', id: 2, callbackId: adoptedId, args: [] });
    emit({ type: 'callback', id: 3, callbackId: orphanId, args: [] });
    await Promise.resolve();
    await Promise.resolve();

    const reply = (n: number) => posted.find((m) => m.type === 'callback-result' && m.id === n);
    expect(reply(1)?.ok).toBe(true); // held → kept
    expect(reply(2)?.ok).toBe(true); // adopted (host owns) → kept
    expect(reply(3)?.ok).toBe(false); // unadopted + not held → swept
    expect(orphan).not.toHaveBeenCalled();
  });

  it('reconcile preserves a callback registered AFTER the drain-pong (post-watermark)', async () => {
    const { port, emit, posted } = makePort();
    const transport = new UtilityTransport(port as never);
    transport.registerFunction(() => 0); // u1, pre-barrier
    // Barrier snapshots watermark = 1.
    emit({ type: 'drain-ping', token: 1 });
    // Plugin registers a NEW callback after the pong but before reconcile lands.
    const late = vi.fn(() => 'late');
    const lateId = transport.registerFunction(late); // u2, post-watermark
    // Reconcile holds nothing — but must NOT sweep lateId (host hasn't seen it).
    emit({ type: 'reconcile-callbacks', heldIds: [] });

    emit({ type: 'callback', id: 5, callbackId: lateId, args: [] });
    await Promise.resolve();
    await Promise.resolve();
    const reply = posted.find((m) => m.type === 'callback-result' && m.id === 5);
    expect(reply?.ok).toBe(true); // preserved
    expect(late).toHaveBeenCalledTimes(1);
  });

  it('a settled request reclaims its unadopted callback ids (host never took them)', async () => {
    const { port, emit, posted } = makePort();
    const transport = new UtilityTransport(port as never);
    const cb = vi.fn();
    const p = transport.asyncCall('m', [cb]);
    const invoke = posted.find((m) => m.type === 'invoke') as { id: number; args: unknown } | undefined;
    expect(invoke).toBeTruthy();
    const cbId = findCallbackId(invoke!.args);
    expect(cbId).toMatch(/^u\d+$/);
    // Host replies WITHOUT adopting the callback → on settle it's reclaimed.
    emit({ type: 'invoke-result', id: invoke!.id, ok: true, value: null });
    await p;
    emit({ type: 'callback', id: 99, callbackId: cbId, args: [] });
    await Promise.resolve();
    await Promise.resolve();
    const reply = posted.find((m) => m.type === 'callback-result' && m.id === 99);
    expect(reply?.ok).toBe(false);
    expect(cb).not.toHaveBeenCalled();
  });

  it('a settled request does NOT reclaim an adopted callback id', async () => {
    const { port, emit, posted } = makePort();
    const transport = new UtilityTransport(port as never);
    const cb = vi.fn(() => 'ok');
    const p = transport.asyncCall('m', [cb]);
    const invoke = posted.find((m) => m.type === 'invoke') as { id: number; args: unknown } | undefined;
    const cbId = findCallbackId(invoke!.args);
    expect(cbId).toMatch(/^u\d+$/);
    // Host adopts the callback (IPC), THEN replies — settle must not reclaim it.
    emit({ type: 'callback-adopted', ids: [cbId] });
    emit({ type: 'invoke-result', id: invoke!.id, ok: true, value: null });
    await p;
    emit({ type: 'callback', id: 7, callbackId: cbId, args: [] });
    await Promise.resolve();
    await Promise.resolve();
    const reply = posted.find((m) => m.type === 'callback-result' && m.id === 7);
    expect(reply?.ok).toBe(true); // still invokable — host owns it
    expect(cb).toHaveBeenCalledTimes(1);
  });
});

/** Recursively find the first wire function-marker id (`u<seq>`) in an encoded value. */
function findCallbackId(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  for (const v of Object.values(value as Record<string, unknown>)) {
    if (typeof v === 'string' && /^u\d+$/.test(v)) return v;
    const nested = findCallbackId(v);
    if (nested) return nested;
  }
  return '';
}
