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

  it('falls back to the synchronous count when the worker crashes BEFORE ready', async () => {
    const messages = [
      { role: 'user', content: 'The quick brown fox jumps over the lazy dog.' },
      { role: 'assistant', content: 'A pangram containing every letter.' },
    ];
    const tokenization = tok.resolveConversationTokenization('gpt-5');
    const promise = tok.countBranchTokensCachedAsync(messages, tokenization, 'm1');
    const w = FakeWorker.instances[0];
    await flush();
    w.crash(); // error + exit before ever posting 'ready'

    const asyncCount = await promise;
    // Same as the pure synchronous encoder.
    tok.__clearExactTokenCacheForTests();
    const syncCount = tok.countBranchTokensCached(messages, tokenization, 'm1');
    expect(asyncCount).toBe(syncCount);
    expect(asyncCount).toBeGreaterThan(0);

    // A crash before ready marks the worker unavailable → the next call uses the
    // synchronous path directly (no respawn).
    const before = FakeWorker.instances.length;
    tok.__clearExactTokenCacheForTests();
    const next = await tok.countBranchTokensCachedAsync(messages, tokenization, 'm1');
    expect(next).toBe(syncCount);
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

  it('uses the synchronous path when worker construction throws', async () => {
    FakeWorker.failConstruction = true;
    tok.__setTokenizerWorkerPathForTests('/fake/tokenizer-worker.js'); // reset unavailable flag
    const messages = [{ role: 'user', content: 'no worker for you' }];
    const tokenization = tok.resolveConversationTokenization('gpt-5');
    const asyncCount = await tok.countBranchTokensCachedAsync(messages, tokenization, 'm1');
    tok.__clearExactTokenCacheForTests();
    const syncCount = tok.countBranchTokensCached(messages, tokenization, 'm1');
    expect(asyncCount).toBe(syncCount);
    expect(FakeWorker.instances).toHaveLength(0);
  });

  it('returns null for a model with no encoding', async () => {
    const tokenization = { ...tok.resolveConversationTokenization('gpt-5'), encoding: null };
    const count = await tok.countBranchTokensCachedAsync([{ role: 'user', content: 'x' }], tokenization, 'm1');
    expect(count).toBeNull();
  });

  it('encodeCappedWithAsync matches the sync encode when the worker is unavailable', async () => {
    FakeWorker.failConstruction = true;
    tok.__setTokenizerWorkerPathForTests('/fake/tokenizer-worker.js');
    const tokenization = tok.resolveConversationTokenization('gpt-5');
    const text = tok.serializeForTokenCounting([{ role: 'user', content: 'budget-fit prefix text' }]);
    const asyncTokens = await tok.encodeCappedWithAsync(text, tokenization);
    const syncTokens = tok.encodeCappedWith(text, tokenization.encoding!);
    expect(asyncTokens).toBe(syncTokens);
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
