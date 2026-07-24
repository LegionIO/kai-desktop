import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type * as TokModule from '../tokenization';

/**
 * Unit tests for the off-main-thread tokenizer CLIENT (the half that lives in
 * tokenization.ts and talks to electron/agent/tokenizer-worker.ts). We mock
 * `node:worker_threads` with a fake Worker we drive by hand, so the tests are
 * hermetic (no dependency on vitest's nested-worker support) and can exercise
 * every branch: the ready protocol, normal encode routing, encode timeout →
 * byte ceiling, a crash BEFORE ready → unavailable → synchronous fallback, a
 * crash AFTER ready → synchronous fallback + respawn, and the shared cache.
 *
 * The numeric-PARITY guarantee (worker count == synchronous count) is covered by
 * the worker-unavailable path here (which routes through the real synchronous
 * encoder) and by compaction.test.ts's shouldCompactAsync parity block.
 */

type FakeWorkerHandlers = Record<string, Array<(arg?: unknown) => void>>;

class FakeWorker {
  static instances: FakeWorker[] = [];
  static failConstruction = false;
  handlers: FakeWorkerHandlers = {};
  posted: Array<{ type: string; id: number; text: string; maxExactChars: number }> = [];
  terminated = false;

  constructor(public path: string) {
    if (FakeWorker.failConstruction) throw new Error('spawn failed');
    FakeWorker.instances.push(this);
  }
  on(event: string, cb: (arg?: unknown) => void): this {
    (this.handlers[event] ??= []).push(cb);
    return this;
  }
  removeAllListeners(): this {
    this.handlers = {};
    return this;
  }
  unref(): this {
    return this;
  }
  postMessage(msg: { type: string; id: number; text: string; maxExactChars: number }): void {
    this.posted.push(msg);
  }
  terminate(): Promise<number> {
    this.terminated = true;
    return Promise.resolve(0);
  }
  // Test drivers:
  emit(event: string, arg?: unknown): void {
    for (const cb of this.handlers[event] ?? []) cb(arg);
  }
  ready(): void {
    this.emit('message', { type: 'ready' });
  }
  result(id: number, count: number): void {
    this.emit('message', { type: 'result', id, count });
  }
  reportError(id: number, message: string): void {
    this.emit('message', { type: 'error', id, message });
  }
  crash(): void {
    this.emit('error', new Error('boom'));
    this.emit('exit', 1);
  }
}

vi.mock('node:worker_threads', () => ({ Worker: FakeWorker }));

// Import AFTER the mock is registered.
let tok: typeof TokModule;

async function flush(): Promise<void> {
  // Let queued microtasks + the fake worker's synchronous emits settle.
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(async () => {
  vi.useFakeTimers();
  FakeWorker.instances = [];
  FakeWorker.failConstruction = false;
  tok = await import('../tokenization');
  tok.__clearExactTokenCacheForTests();
  // Point at a dummy path (the mock ignores it) and reset lazy state.
  tok.__setTokenizerWorkerPathForTests('/fake/tokenizer-worker.js');
});

afterEach(() => {
  tok.terminateTokenizerWorker();
  tok.__setTokenizerWorkerPathForTests(null);
  vi.useRealTimers();
});

describe('tokenizer worker client', () => {
  it('spawns once, waits for ready, and returns the worker count', async () => {
    const messages = [{ role: 'user', content: 'hello world' }];
    const tokenization = tok.resolveConversationTokenization('gpt-5');

    const promise = tok.countBranchTokensCachedAsync(messages, tokenization, 'm1');
    // One worker spawned; the encode was posted (postMessage is safe pre-ready).
    expect(FakeWorker.instances).toHaveLength(1);
    const w = FakeWorker.instances[0];
    await flush();
    expect(w.posted).toHaveLength(1);
    const posted = w.posted[0];

    w.ready();
    w.result(posted.id, 4242);
    expect(await promise).toBe(4242);
  });

  it('reuses the same worker across encodes', async () => {
    const tokenization = tok.resolveConversationTokenization('gpt-5');
    const p1 = tok.countBranchTokensCachedAsync([{ role: 'user', content: 'a' }], tokenization, 'm1');
    const w = FakeWorker.instances[0];
    await flush();
    w.ready();
    w.result(w.posted[0].id, 10);
    expect(await p1).toBe(10);

    const p2 = tok.countBranchTokensCachedAsync([{ role: 'user', content: 'b' }], tokenization, 'm2');
    await flush();
    expect(FakeWorker.instances).toHaveLength(1); // no respawn
    w.result(w.posted[1].id, 20);
    expect(await p2).toBe(20);
  });

  it('serves a repeat call from the shared exact-count cache (no second post)', async () => {
    const messages = [{ role: 'user', content: 'cache me' }];
    const tokenization = tok.resolveConversationTokenization('gpt-5');
    const p1 = tok.countBranchTokensCachedAsync(messages, tokenization, 'm1');
    const w = FakeWorker.instances[0];
    await flush();
    w.ready();
    w.result(w.posted[0].id, 99);
    expect(await p1).toBe(99);

    const p2 = tok.countBranchTokensCachedAsync(messages, tokenization, 'm1');
    expect(await p2).toBe(99);
    expect(w.posted).toHaveLength(1); // cache hit → no new encode
  });

  it('byte-ceilings when a live worker encode times out', async () => {
    const messages = [{ role: 'user', content: 'slow one' }];
    const tokenization = tok.resolveConversationTokenization('gpt-5');
    const promise = tok.countBranchTokensCachedAsync(messages, tokenization, 'm1');
    const w = FakeWorker.instances[0];
    await flush();
    w.ready(); // worker is alive & ready, but never answers the encode
    vi.advanceTimersByTime(20_000); // trip the encode timeout
    const expected = Buffer.byteLength(tok.serializeForTokenCounting(messages), 'utf8');
    expect(await promise).toBe(expected);
  });

  it('force-terminates a stuck worker on timeout and respawns on the next encode', async () => {
    const tokenization = tok.resolveConversationTokenization('gpt-5');
    const p1 = tok.countBranchTokensCachedAsync([{ role: 'user', content: 'stuck' }], tokenization, 'm1');
    const w1 = FakeWorker.instances[0];
    await flush();
    w1.ready();
    vi.advanceTimersByTime(20_000); // timeout → terminate the stuck worker
    await p1;
    expect(w1.terminated).toBe(true);

    // Next encode must spawn a FRESH worker (the stuck one was dropped) rather
    // than queue behind the wedged one for another full timeout.
    const p2 = tok.countBranchTokensCachedAsync([{ role: 'user', content: 'fresh' }], tokenization, 'm2');
    expect(FakeWorker.instances.length).toBe(2);
    const w2 = FakeWorker.instances[1];
    await flush();
    w2.ready();
    w2.result(w2.posted[0].id, 33);
    expect(await p2).toBe(33);
  });

  it('byte-ceilings (never sync-encodes on main) when the worker crashes BEFORE ready', async () => {
    const messages = [
      { role: 'user', content: 'The quick brown fox jumps over the lazy dog.' },
      { role: 'assistant', content: 'A pangram containing every letter.' },
    ];
    const tokenization = tok.resolveConversationTokenization('gpt-5');
    const promise = tok.countBranchTokensCachedAsync(messages, tokenization, 'm1');
    const w = FakeWorker.instances[0];
    await flush();
    w.crash(); // error + exit before ever posting 'ready'

    // Even a pre-ready load failure must NOT sync-encode a whole branch on main
    // (a missing packaged entry / tiktoken load failure doesn't make a
    // multi-megabyte branch safe to encode) → byte ceiling.
    const ceiling = Buffer.byteLength(tok.serializeForTokenCounting(messages), 'utf8');
    expect(await promise).toBe(ceiling);

    // A crash before ready marks the worker unavailable → the next call also
    // byte-ceilings and does NOT respawn.
    const before = FakeWorker.instances.length;
    tok.__clearExactTokenCacheForTests();
    const next = await tok.countBranchTokensCachedAsync(messages, tokenization, 'm1');
    expect(next).toBe(ceiling);
    expect(FakeWorker.instances.length).toBe(before); // no new worker spawned
  });

  it('byte-ceilings and RESPAWNS when a ready worker crashes mid-encode', async () => {
    const messages = [{ role: 'user', content: 'work then die' }];
    const tokenization = tok.resolveConversationTokenization('gpt-5');
    const promise = tok.countBranchTokensCachedAsync(messages, tokenization, 'm1');
    const w = FakeWorker.instances[0];
    await flush();
    w.ready();
    w.crash(); // crash mid-encode, but it HAD become ready → possible input OOM

    // A ready-worker crash may be input-correlated → byte ceiling, never re-run
    // the whole-branch encode synchronously on main.
    expect(await promise).toBe(Buffer.byteLength(tok.serializeForTokenCounting(messages), 'utf8'));

    // Ready-then-crash does NOT mark unavailable → next encode respawns.
    tok.__clearExactTokenCacheForTests();
    const p2 = tok.countBranchTokensCachedAsync([{ role: 'user', content: 'again' }], tokenization, 'm2');
    expect(FakeWorker.instances.length).toBe(2); // respawned
    const w2 = FakeWorker.instances[1];
    await flush();
    w2.ready();
    w2.result(w2.posted[0].id, 55);
    expect(await p2).toBe(55);
  });

  it('byte-ceilings (no whole-branch sync encode) when worker construction throws', async () => {
    FakeWorker.failConstruction = true;
    tok.__setTokenizerWorkerPathForTests('/fake/tokenizer-worker.js'); // reset unavailable flag
    const messages = [{ role: 'user', content: 'no worker for you' }];
    const tokenization = tok.resolveConversationTokenization('gpt-5');
    const asyncCount = await tok.countBranchTokensCachedAsync(messages, tokenization, 'm1');
    expect(asyncCount).toBe(Buffer.byteLength(tok.serializeForTokenCounting(messages), 'utf8'));
    expect(FakeWorker.instances).toHaveLength(0);
  });

  it('returns null for a model with no encoding', async () => {
    const tokenization = { ...tok.resolveConversationTokenization('gpt-5'), encoding: null };
    const count = await tok.countBranchTokensCachedAsync([{ role: 'user', content: 'x' }], tokenization, 'm1');
    expect(count).toBeNull();
  });

  it('encodeCappedWithAsync byte-ceilings when the worker is unavailable', async () => {
    FakeWorker.failConstruction = true;
    tok.__setTokenizerWorkerPathForTests('/fake/tokenizer-worker.js');
    const tokenization = tok.resolveConversationTokenization('gpt-5');
    const text = tok.serializeForTokenCounting([{ role: 'user', content: 'budget-fit prefix text' }]);
    const asyncTokens = await tok.encodeCappedWithAsync(text, tokenization);
    expect(asyncTokens).toBe(Buffer.byteLength(text, 'utf8'));
  });

  it('on abort with no other live request, frees the worker (terminate + respawn)', async () => {
    const messages = [{ role: 'user', content: 'superseded turn' }];
    const tokenization = tok.resolveConversationTokenization('gpt-5');
    const controller = new AbortController();
    const promise = tok.countBranchTokensCachedAsync(messages, tokenization, 'm1', controller.signal);
    const w = FakeWorker.instances[0];
    await flush();
    w.ready(); // worker is alive & mid-encode
    controller.abort(); // turn cancelled/superseded during the encode

    // Caller settles immediately via the byte ceiling (doesn't wait for the job).
    expect(await promise).toBe(Buffer.byteLength(tok.serializeForTokenCounting(messages), 'utf8'));
    // No OTHER live request depends on the worker → free the stale job now so a
    // replacement turn doesn't queue behind a possibly-huge encode.
    expect(w.terminated).toBe(true);

    // The next encode spawns a fresh worker.
    const p2 = tok.countBranchTokensCachedAsync([{ role: 'user', content: 'next' }], tokenization, 'm2');
    expect(FakeWorker.instances.length).toBe(2);
    const w2 = FakeWorker.instances[1];
    await flush();
    w2.ready();
    w2.result(w2.posted[0].id, 77);
    expect(await p2).toBe(77);
  });

  it('aborting one request does NOT disturb or kill the worker while another is live', async () => {
    const tokenization = tok.resolveConversationTokenization('gpt-5');
    const cA = new AbortController();
    const msgsA = [{ role: 'user', content: 'conversation A' }];
    const msgsB = [{ role: 'user', content: 'conversation B' }];
    const pA = tok.countBranchTokensCachedAsync(msgsA, tokenization, 'a1', cA.signal);
    const pB = tok.countBranchTokensCachedAsync(msgsB, tokenization, 'b1');
    const w = FakeWorker.instances[0];
    await flush();
    w.ready();
    const postedA = w.posted[0];
    const postedB = w.posted[1];

    cA.abort(); // cancel A — but B is still live, so the worker MUST NOT be killed
    expect(await pA).toBe(Buffer.byteLength(tok.serializeForTokenCounting(msgsA), 'utf8'));
    expect(w.terminated).toBe(false);
    w.result(postedB.id, 123);
    // A late result for the aborted A is harmless (idempotent settle; entry dropped).
    w.result(postedA.id, 999);
    expect(await pB).toBe(123);
  });

  it('keeps the watchdog armed for a detached job while another request is live', async () => {
    const tokenization = tok.resolveConversationTokenization('gpt-5');
    const cA = new AbortController();
    const pA = tok.countBranchTokensCachedAsync([{ role: 'user', content: 'A wedged' }], tokenization, 'a1', cA.signal);
    const pB = tok.countBranchTokensCachedAsync([{ role: 'user', content: 'B live' }], tokenization, 'b1');
    const w = FakeWorker.instances[0];
    await flush();
    w.ready();
    cA.abort(); // A detaches; B still live → worker not killed yet
    await pA;
    expect(w.terminated).toBe(false);

    // If the worker is genuinely stuck (never answers B either), the detached
    // job's watchdog still force-terminates it when the timeout elapses.
    vi.advanceTimersByTime(20_000);
    expect(w.terminated).toBe(true);
    // B settled via ceiling when the stuck worker was force-terminated.
    expect(await pB).toBe(
      Buffer.byteLength(tok.serializeForTokenCounting([{ role: 'user', content: 'B live' }]), 'utf8'),
    );
  });

  it('byte-ceilings immediately (no worker spawned/posted) when already aborted', async () => {
    const messages = [{ role: 'user', content: 'already gone' }];
    const tokenization = tok.resolveConversationTokenization('gpt-5');
    const controller = new AbortController();
    controller.abort();
    const count = await tok.countBranchTokensCachedAsync(messages, tokenization, 'm1', controller.signal);
    expect(count).toBe(Buffer.byteLength(tok.serializeForTokenCounting(messages), 'utf8'));
    // Nothing was submitted to the sole worker (no wasted spawn / 15s timer).
    expect(FakeWorker.instances).toHaveLength(0);
  });

  it('does NOT cache a byte-ceiling fallback (unchanged branch re-reaches the worker)', async () => {
    const messages = [{ role: 'user', content: 'cache discipline' }];
    const tokenization = tok.resolveConversationTokenization('gpt-5');

    // First call aborts → byte-ceiling fallback, which must NOT be cached. With
    // no other live request, the worker is freed (terminated) on abort.
    const c1 = new AbortController();
    const p1 = tok.countBranchTokensCachedAsync(messages, tokenization, 'm1', c1.signal);
    const w1 = FakeWorker.instances[0];
    await flush();
    w1.ready();
    c1.abort();
    const ceiling = Buffer.byteLength(tok.serializeForTokenCounting(messages), 'utf8');
    expect(await p1).toBe(ceiling);

    // Second call for the SAME branch must reach a worker again (not serve the
    // stale ceiling from cache) and get the exact count.
    const p2 = tok.countBranchTokensCachedAsync(messages, tokenization, 'm1');
    const w2 = FakeWorker.instances[FakeWorker.instances.length - 1];
    await flush();
    w2.ready();
    const lastPost = w2.posted[w2.posted.length - 1];
    expect(lastPost).toBeDefined();
    w2.result(lastPost.id, 5);
    expect(await p2).toBe(5);
    expect(5).not.toBe(ceiling);
  });
});

describe('tokenizer worker build wiring', () => {
  it('is registered as a rollup input so `pnpm build` emits out/main/tokenizer-worker.js', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { join, dirname } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const configPath = join(here, '../../../electron.vite.config.ts');
    const config = readFileSync(configPath, 'utf8');
    expect(config).toContain("'tokenizer-worker': resolve(__dirname, 'electron/agent/tokenizer-worker.ts')");
  });
});
