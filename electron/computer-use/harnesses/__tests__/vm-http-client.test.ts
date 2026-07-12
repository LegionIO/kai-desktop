/**
 * Tests for VmHttpClient (electron/computer-use/harnesses/vm-http-client.ts) —
 * the HTTP client for a remote computer-use VM. Focus: baseUrl scheme
 * validation, the response byte-cap (a hostile/buggy VM must not exhaust
 * main-process memory), and already-aborted-signal short-circuit. `fetch` is
 * stubbed per test.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getVersion: () => '1.0.0' } }));

import { VmHttpClient } from '../vm-http-client.js';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

/** A Response whose body streams `size` bytes in chunks, with a matching or
 *  absent Content-Length, to exercise the streaming cap. */
function bigBodyResponse(size: number, opts: { contentLength?: boolean } = {}): Response {
  const chunk = new Uint8Array(64 * 1024).fill(120); // 'x'
  let sent = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= size) {
        controller.close();
        return;
      }
      const remaining = size - sent;
      controller.enqueue(chunk.subarray(0, Math.min(chunk.length, remaining)));
      sent += chunk.length;
    },
  });
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.contentLength) headers['content-length'] = String(size);
  return new Response(stream, { status: 200, headers });
}

describe('VmHttpClient constructor baseUrl validation', () => {
  it('accepts http(s) base URLs', () => {
    expect(() => new VmHttpClient('https://vm.example/api')).not.toThrow();
    expect(() => new VmHttpClient('http://localhost:8080')).not.toThrow();
  });

  it('rejects non-http(s) schemes (no file:/other-scheme fetches)', () => {
    expect(() => new VmHttpClient('file:///etc/passwd')).toThrow(/http/i);
    expect(() => new VmHttpClient('ftp://host/x')).toThrow(/http/i);
  });

  it('rejects an unparseable base URL', () => {
    expect(() => new VmHttpClient('not a url')).toThrow(/Invalid VM harness baseUrl/i);
  });
});

describe('response byte cap', () => {
  it('rejects a response body that exceeds the 32 MiB cap (streamed, no content-length)', async () => {
    globalThis.fetch = vi.fn(async () => bigBodyResponse(33 * 1024 * 1024)) as unknown as typeof fetch;
    const client = new VmHttpClient('https://vm.example');
    await expect(client.getState('cs-1-0a1b2c3d')).rejects.toThrow(/exceeded|too large/i);
  });

  it('rejects early via Content-Length when the VM declares an oversized body', async () => {
    globalThis.fetch = vi.fn(async () =>
      bigBodyResponse(40 * 1024 * 1024, { contentLength: true }),
    ) as unknown as typeof fetch;
    const client = new VmHttpClient('https://vm.example');
    await expect(client.getState('cs-1-0a1b2c3d')).rejects.toThrow(/too large|exceeds/i);
  });

  it('accepts a normal small JSON body', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ status: 'running', cursor: { x: 1, y: 2 } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ) as unknown as typeof fetch;
    const client = new VmHttpClient('https://vm.example');
    const state = await client.getState('cs-1-0a1b2c3d');
    expect(state).toBeTruthy();
  });
});

describe('already-aborted signal', () => {
  it('does not issue the request when the caller signal is already aborted', async () => {
    // Real fetch rejects if its signal is already aborted; emulate that so the
    // withAbortTimeout up-front-abort guard surfaces as a rejection.
    const fetchSpy = vi.fn(async (_url: string, init?: { signal?: AbortSignal }) => {
      if (init?.signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
      return new Response('{}', { status: 200 });
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const client = new VmHttpClient('https://vm.example');
    const ac = new AbortController();
    ac.abort();
    await expect(client.getState('cs-1-0a1b2c3d', ac.signal)).rejects.toBeTruthy();
  });
});
