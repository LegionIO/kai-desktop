import { describe, it, expect } from 'vitest';
import { isUrlAllowed, isPrivateAddress, readCappedText, readCappedArrayBuffer } from '../ssrf-guard.js';

describe('ssrf-guard isPrivateAddress', () => {
  it('flags loopback / private / link-local / ULA', () => {
    expect(isPrivateAddress('127.0.0.1', 4)).toBe(true);
    expect(isPrivateAddress('10.1.2.3', 4)).toBe(true);
    expect(isPrivateAddress('172.16.5.5', 4)).toBe(true);
    expect(isPrivateAddress('192.168.0.1', 4)).toBe(true);
    expect(isPrivateAddress('169.254.169.254', 4)).toBe(true); // cloud metadata
    expect(isPrivateAddress('::1', 6)).toBe(true);
    expect(isPrivateAddress('fe80::1', 6)).toBe(true);
    expect(isPrivateAddress('fc00::1', 6)).toBe(true);
  });

  it('allows public addresses', () => {
    expect(isPrivateAddress('8.8.8.8', 4)).toBe(false);
    expect(isPrivateAddress('1.1.1.1', 4)).toBe(false);
    expect(isPrivateAddress('2606:4700:4700::1111', 6)).toBe(false);
  });
});

describe('ssrf-guard isUrlAllowed', () => {
  it('rejects non-http(s) schemes unless in extraProtocols', () => {
    expect(isUrlAllowed('file:///etc/passwd', false).ok).toBe(false);
    expect(isUrlAllowed('ftp://x/y', false).ok).toBe(false);
    expect(isUrlAllowed('mymedia://images/a.png', false).ok).toBe(false);
    expect(isUrlAllowed('mymedia://images/a.png', false, ['mymedia']).ok).toBe(true);
  });

  it('rejects IP-literal private hosts on http(s), allows public', () => {
    expect(isUrlAllowed('http://169.254.169.254/latest/meta-data/', false).ok).toBe(false);
    expect(isUrlAllowed('http://127.0.0.1:8080/', false).ok).toBe(false);
    expect(isUrlAllowed('http://[::1]/', false).ok).toBe(false);
    expect(isUrlAllowed('http://10.0.0.5/x', false).ok).toBe(false);
    expect(isUrlAllowed('https://example.com/a.png', false).ok).toBe(true);
    expect(isUrlAllowed('https://8.8.8.8/', false).ok).toBe(true);
  });

  it('allowPrivate=true skips the IP-literal check (but still enforces scheme)', () => {
    expect(isUrlAllowed('http://127.0.0.1/', true).ok).toBe(true);
    expect(isUrlAllowed('file:///x', true).ok).toBe(false);
  });

  it('rejects an unparseable URL', () => {
    expect(isUrlAllowed('not a url', false).ok).toBe(false);
  });
});

describe('ssrf-guard readCappedArrayBuffer / readCappedText', () => {
  // Minimal Response-like object streaming the given chunks, with an optional
  // content-length header for the pre-read declared-size check.
  const resp = (chunks: Uint8Array[], contentLength?: number): Response =>
    ({
      headers: { get: (k: string) => (k === 'content-length' && contentLength != null ? String(contentLength) : null) },
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          for (const c of chunks) controller.enqueue(c);
          controller.close();
        },
      }),
    }) as unknown as Response;

  const enc = (s: string) => new TextEncoder().encode(s);

  it('reads a full body under the cap as text', async () => {
    const out = await readCappedText(resp([enc('hello '), enc('world')]), 1000);
    expect(out).toBe('hello world');
  });

  it('rejects up front when Content-Length declares a size over the cap', async () => {
    await expect(readCappedArrayBuffer(resp([enc('x')], 9999), 100)).rejects.toThrow(/Content-Length 9999 exceeds 100/);
  });

  it('rejects mid-stream when the streamed body exceeds the cap (no declared length)', async () => {
    // 120 bytes across two chunks, cap 100 — the running total trips at chunk 2.
    const big = resp([new Uint8Array(60), new Uint8Array(60)]);
    await expect(readCappedText(big, 100)).rejects.toThrow(/exceeded 100 bytes/);
  });

  it('decodes multi-byte UTF-8 that spans the byte count correctly', async () => {
    const out = await readCappedText(resp([enc('café — ✓')]), 1000);
    expect(out).toBe('café — ✓');
  });
});
