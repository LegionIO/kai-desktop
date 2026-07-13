/**
 * Tests for marketplace-service.ts network guards (via __internal):
 *   - assertSecureMarketplaceUrl: catalog/tarball URLs must be https (http only
 *     for localhost incl. IPv6 [::1]). A plaintext URL lets a MITM swap the
 *     published integrity hashes AND the archive.
 *   - readCappedResponse: reads a fetch body into a Buffer, bounded by BOTH a
 *     byte cap AND an optional abort signal (racing each read) so a compromised
 *     host that trickles the body slowly under the cap can't hang the install.
 */
import { describe, it, expect, vi } from 'vitest';

// marketplace-service.ts imports `net` from electron at module load.
vi.mock('electron', () => ({ net: { fetch: vi.fn() } }));

import { __internal } from '../marketplace-service.js';

const { assertSecureMarketplaceUrl, readCappedResponse } = __internal;

describe('assertSecureMarketplaceUrl', () => {
  it('allows https', () => {
    expect(() => assertSecureMarketplaceUrl('https://plugins.example.com/catalog.json')).not.toThrow();
    expect(() => assertSecureMarketplaceUrl('HTTPS://EXAMPLE.COM/x')).not.toThrow(); // scheme canonicalized
  });

  it('allows http ONLY for localhost / 127.0.0.1 / [::1]', () => {
    expect(() => assertSecureMarketplaceUrl('http://localhost:8080/c.json')).not.toThrow();
    expect(() => assertSecureMarketplaceUrl('http://127.0.0.1/c.json')).not.toThrow();
    expect(() => assertSecureMarketplaceUrl('http://[::1]:9000/c.json')).not.toThrow(); // IPv6 loopback (the [::1] fix)
  });

  it('rejects plaintext http to a non-local host', () => {
    expect(() => assertSecureMarketplaceUrl('http://evil.example.com/c.json')).toThrow(/must be https/i);
    // userinfo must not smuggle a localhost past the host check
    expect(() => assertSecureMarketplaceUrl('http://localhost@evil.example.com/c.json')).toThrow(/must be https/i);
  });

  it('rejects non-http(s) schemes and malformed URLs', () => {
    expect(() => assertSecureMarketplaceUrl('file:///etc/passwd')).toThrow(/must be https/i);
    expect(() => assertSecureMarketplaceUrl('ftp://x/c.json')).toThrow(/must be https/i);
    expect(() => assertSecureMarketplaceUrl('not a url')).toThrow(/invalid marketplace url/i);
  });
});

describe('readCappedResponse', () => {
  const streamOf = (chunks: Uint8Array[]): Response =>
    ({
      body: new ReadableStream({
        start(controller) {
          for (const c of chunks) controller.enqueue(c);
          controller.close();
        },
      }),
    }) as unknown as Response;

  it('reads a complete body into a Buffer', async () => {
    const buf = await readCappedResponse(streamOf([new Uint8Array([1, 2]), new Uint8Array([3])]), 1000, 'p');
    expect([...buf]).toEqual([1, 2, 3]);
  });

  it('throws once the body exceeds the byte cap', async () => {
    const big = streamOf([new Uint8Array(60), new Uint8Array(60)]); // 120 bytes
    await expect(readCappedResponse(big, 100, 'p')).rejects.toThrow(/exceeded 100 bytes/);
  });

  it('aborts a trickling body when the signal fires mid-read (the DoS the fix closes)', async () => {
    let cancelled = false;
    const trickle = {
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array([1])); // one chunk, then hang
        },
        cancel() {
          cancelled = true;
        },
      }),
    } as unknown as Response;
    const ac = new AbortController();
    const p = readCappedResponse(trickle, 1_000_000, 'trickle-plugin', ac.signal);
    await new Promise((r) => setTimeout(r, 10));
    ac.abort();
    await expect(p).rejects.toThrow(/timed out or was aborted/i);
    await new Promise((r) => setTimeout(r, 0));
    expect(cancelled).toBe(true); // reader.cancel() fired
  });

  it('rejects immediately when handed an already-aborted signal', async () => {
    const ac = new AbortController();
    ac.abort();
    const never = { body: new ReadableStream({ start() {} }) } as unknown as Response;
    await expect(readCappedResponse(never, 1000, 'p', ac.signal)).rejects.toThrow(/timed out or was aborted/i);
  });
});
