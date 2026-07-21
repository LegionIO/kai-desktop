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

  it('re-registers a fresh id after release (dedup entry also cleared)', () => {
    const { port } = makePort();
    const transport = new UtilityTransport(port as never);
    const fn = () => 1;
    const id1 = transport.registerFunction(fn);
    transport.releaseFunction(id1);
    // Same fn object, but the fn→id dedup entry was cleared, so it re-registers.
    const id2 = transport.registerFunction(fn);
    expect(id2).not.toBe(id1);
  });

  it('release of an unknown id is a no-op', () => {
    const { port } = makePort();
    const transport = new UtilityTransport(port as never);
    expect(() => transport.releaseFunction('nope')).not.toThrow();
    expect(() => transport.releaseFunction('')).not.toThrow();
  });
});
