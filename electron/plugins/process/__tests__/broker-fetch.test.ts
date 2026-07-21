import { describe, expect, it, vi } from 'vitest';
import { createBrokerFetch, type BrokerFetchRequest } from '../broker-fetch.js';
import type { UtilityTransport } from '../utility-transport.js';

describe('SEA broker fetch adapter', () => {
  it('preserves request bodies and streams response bytes as a real Response', async () => {
    const requestChunks: string[] = [];
    const streamCall = vi.fn((_method: string, args: unknown[]) => {
      const request = args[0] as BrokerFetchRequest;
      return (async function* () {
        if (request.body) {
          for await (const chunk of request.body()) requestChunks.push(new TextDecoder().decode(chunk));
        }
        yield {
          kind: 'metadata',
          status: 201,
          statusText: 'Created',
          headers: [['content-type', 'text/plain']],
          url: 'https://example.test/final',
          redirected: true,
          responseType: 'basic',
          hasBody: true,
        };
        yield new TextEncoder().encode('hello ');
        yield new TextEncoder().encode('world');
      })();
    });
    const fetch = createBrokerFetch({ streamCall } as unknown as UtilityTransport);

    const response = await fetch('https://example.test/start', {
      method: 'POST',
      headers: { 'x-fixture': 'yes' },
      body: 'request-body',
    });

    expect(streamCall).toHaveBeenCalledWith('__fetch', [expect.objectContaining({ method: 'POST' })]);
    expect(requestChunks).toEqual(['request-body']);
    expect(response.status).toBe(201);
    expect(response.url).toBe('https://example.test/final');
    expect(response.redirected).toBe(true);
    await expect(response.text()).resolves.toBe('hello world');
  });

  it('preserves an abort reason while response headers are pending', async () => {
    let finish!: (result: IteratorResult<unknown>) => void;
    const streamCall = vi.fn(() => ({
      next: () => new Promise<IteratorResult<unknown>>((resolve) => (finish = resolve)),
      return: async () => {
        const result = { done: true, value: undefined } as IteratorResult<unknown>;
        finish(result);
        return result;
      },
      throw: async (error: unknown) => Promise.reject(error),
      [Symbol.asyncIterator]() {
        return this;
      },
    }));
    const fetch = createBrokerFetch({ streamCall } as unknown as UtilityTransport);
    const controller = new AbortController();
    const pending = fetch('https://example.test/wait', { signal: controller.signal });

    controller.abort('fixture-abort');

    await expect(pending).rejects.toBe('fixture-abort');
  });

  it('errors an already-returned response body when its request is aborted', async () => {
    let finish!: (result: IteratorResult<unknown>) => void;
    let invocation = 0;
    const streamCall = vi.fn(() => ({
      next: () => {
        invocation += 1;
        if (invocation === 1) {
          return Promise.resolve({
            done: false,
            value: {
              kind: 'metadata',
              status: 200,
              statusText: 'OK',
              headers: [],
              url: 'https://example.test/wait',
              redirected: false,
              responseType: 'basic',
              hasBody: true,
            },
          });
        }
        return new Promise<IteratorResult<unknown>>((resolve) => (finish = resolve));
      },
      return: async () => {
        const result = { done: true, value: undefined } as IteratorResult<unknown>;
        finish?.(result);
        return result;
      },
      throw: async (error: unknown) => Promise.reject(error),
      [Symbol.asyncIterator]() {
        return this;
      },
    }));
    const fetch = createBrokerFetch({ streamCall } as unknown as UtilityTransport);
    const controller = new AbortController();
    const response = await fetch('https://example.test/wait', { signal: controller.signal });
    const body = response.text();

    controller.abort('body-abort');

    await expect(body).rejects.toBe('body-abort');
  });
});
