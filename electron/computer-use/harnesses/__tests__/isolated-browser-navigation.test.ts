/**
 * Tests for checkIsolatedBrowserNavigation (isolated-browser.ts) — the private-
 * network navigation guard for the computer-use browsing agent. A browsing agent
 * steered by untrusted page content / prompt injection must not be able to probe
 * internal services (loopback, RFC1918, link-local, localhost) unless the user
 * explicitly opted in. `electron` is mocked so the harness module can load.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('electron', () => ({
  BrowserWindow: class {},
  session: { fromPartition: () => ({ clearStorageData: () => Promise.resolve() }) },
}));

const { checkIsolatedBrowserNavigation } = await import('../isolated-browser.js');

describe('checkIsolatedBrowserNavigation (allowPrivate=false, default)', () => {
  it('allows a normal public https URL', () => {
    expect(checkIsolatedBrowserNavigation('https://example.com', false)).toEqual({
      ok: true,
      url: 'https://example.com',
    });
  });

  it('normalizes a bare host to https://', () => {
    const r = checkIsolatedBrowserNavigation('example.com/path', false);
    expect(r).toEqual({ ok: true, url: 'https://example.com/path' });
  });

  it('rejects an empty URL', () => {
    expect(checkIsolatedBrowserNavigation('   ', false).ok).toBe(false);
  });

  it('rejects loopback IPv4 literal', () => {
    expect(checkIsolatedBrowserNavigation('http://127.0.0.1:8080', false).ok).toBe(false);
    expect(checkIsolatedBrowserNavigation('127.0.0.1', false).ok).toBe(false);
  });

  it('rejects the localhost hostname family (not an IP literal)', () => {
    expect(checkIsolatedBrowserNavigation('http://localhost:3000', false).ok).toBe(false);
    expect(checkIsolatedBrowserNavigation('localhost', false).ok).toBe(false);
    expect(checkIsolatedBrowserNavigation('http://api.localhost', false).ok).toBe(false);
  });

  it('rejects RFC1918 private ranges', () => {
    expect(checkIsolatedBrowserNavigation('http://10.0.0.5', false).ok).toBe(false);
    expect(checkIsolatedBrowserNavigation('http://192.168.1.1', false).ok).toBe(false);
    expect(checkIsolatedBrowserNavigation('http://172.16.0.1', false).ok).toBe(false);
  });

  it('rejects link-local (169.254/16, cloud metadata)', () => {
    expect(checkIsolatedBrowserNavigation('http://169.254.169.254/latest/meta-data', false).ok).toBe(false);
  });

  it('rejects IPv6 loopback', () => {
    expect(checkIsolatedBrowserNavigation('http://[::1]:9000', false).ok).toBe(false);
  });
});

describe('checkIsolatedBrowserNavigation (allowPrivate=true, opted in)', () => {
  it('allows loopback + localhost when the user opted in', () => {
    expect(checkIsolatedBrowserNavigation('http://127.0.0.1:8080', true).ok).toBe(true);
    expect(checkIsolatedBrowserNavigation('http://localhost:3000', true).ok).toBe(true);
    expect(checkIsolatedBrowserNavigation('http://192.168.1.1', true).ok).toBe(true);
  });

  it('still allows public URLs when opted in', () => {
    expect(checkIsolatedBrowserNavigation('https://example.com', true).ok).toBe(true);
  });
});
