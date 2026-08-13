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
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// marketplace-service.ts imports `net` from electron at module load.
vi.mock('electron', () => ({ net: { fetch: vi.fn() } }));

import { net } from 'electron';
import { __internal, MarketplaceService } from '../marketplace-service.js';
import type { MarketplaceCatalogEntry } from '../marketplace-service.js';

const { assertSecureMarketplaceUrl, readCappedResponse } = __internal;
const mockFetch = vi.mocked(net.fetch);

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

describe('fetchCatalog reachability', () => {
  // Regression: a valid empty catalog ({ plugins: [] }) from a reachable endpoint
  // must be distinguishable from a fetch failure. wasLastFetchReachable() reports
  // the actual connectivity outcome, NOT catalog size.
  const jsonResponse = (body: unknown): Response =>
    ({ ok: true, status: 200, statusText: 'OK', json: async () => body }) as unknown as Response;

  function makeService() {
    const dir = mkdtempSync(join(tmpdir(), 'kai-mkt-'));
    const svc = new MarketplaceService(
      join(dir, 'plugins'),
      dir,
      () => ({}) as never,
      () => {},
      new Set(),
    );
    return { svc, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  }

  // Pre-seed a legacy flat catalog cache (data/marketplace.json) with NO
  // per-URL sidecar — the pre-upgrade on-disk state.
  function makeServiceWithLegacyCache(entries: MarketplaceCatalogEntry[]) {
    const dir = mkdtempSync(join(tmpdir(), 'kai-mkt-'));
    mkdirSync(join(dir, 'data'), { recursive: true });
    writeFileSync(join(dir, 'data', 'marketplace.json'), JSON.stringify(entries));
    const svc = new MarketplaceService(
      join(dir, 'plugins'),
      dir,
      () => ({}) as never,
      () => {},
      new Set(),
    );
    return { svc, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  }

  it('is null before any fetch', () => {
    const { svc, cleanup } = makeService();
    try {
      expect(svc.wasLastFetchReachable()).toBeNull();
    } finally {
      cleanup();
    }
  });

  it('reports reachable=true for a reachable endpoint that returns zero plugins', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ plugins: [] }));
    const { svc, cleanup } = makeService();
    try {
      const entries = await svc.fetchCatalog(['https://plugins.example.com/catalog.json']);
      expect(entries).toEqual([]);
      expect(svc.wasLastFetchReachable()).toBe(true); // valid empty catalog, NOT a failure
    } finally {
      cleanup();
    }
  });

  it('reports reachable=false when every configured URL fails', async () => {
    mockFetch.mockRejectedValueOnce(new Error('network down'));
    const { svc, cleanup } = makeService();
    try {
      const entries = await svc.fetchCatalog(['https://plugins.example.com/catalog.json']);
      expect(entries).toEqual([]);
      expect(svc.wasLastFetchReachable()).toBe(false);
    } finally {
      cleanup();
    }
  });

  it('reports reachable=true when at least one of several URLs succeeds', async () => {
    mockFetch.mockRejectedValueOnce(new Error('down')).mockResolvedValueOnce(jsonResponse({ plugins: [] }));
    const { svc, cleanup } = makeService();
    try {
      await svc.fetchCatalog(['https://a.example.com/catalog.json', 'https://b.example.com/catalog.json']);
      expect(svc.wasLastFetchReachable()).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('preserves the prior good catalog when a later fetch reaches no URL', async () => {
    // First fetch succeeds with a real catalog…
    mockFetch.mockResolvedValueOnce(jsonResponse({ plugins: [{ name: 'alpha', version: '1.0.0' }] }));
    const { svc, cleanup } = makeService();
    try {
      const first = await svc.fetchCatalog(['https://plugins.example.com/catalog.json']);
      expect(first.map((e) => e.name)).toEqual(['alpha']);

      // …then a later fetch to the SAME url reaches nothing. The empty result
      // must NOT clobber the cached catalog — the stale-but-usable list from a
      // still-configured URL is preserved.
      mockFetch.mockRejectedValueOnce(new Error('offline'));
      const second = await svc.fetchCatalog(['https://plugins.example.com/catalog.json']);
      expect(second.map((e) => e.name)).toEqual(['alpha']);
      expect(svc.wasLastFetchReachable()).toBe(false);
      expect(svc.getCachedCatalog()?.map((e) => e.name)).toEqual(['alpha']);
    } finally {
      cleanup();
    }
  });

  it('drops cached entries from a REMOVED url when a later fetch to a new url fails', async () => {
    // First fetch populates the cache from url A…
    mockFetch.mockResolvedValueOnce(jsonResponse({ plugins: [{ name: 'alpha', version: '1.0.0' }] }));
    const { svc, cleanup } = makeService();
    try {
      await svc.fetchCatalog(['https://old.example.com/catalog.json']);
      expect(svc.getCachedCatalog()?.map((e) => e.name)).toEqual(['alpha']);

      // …branding then swaps to url B, whose fetch fails. The preserved cache is
      // scoped to the CURRENT urls — 'alpha' came from the now-removed url A, so
      // it must NOT be resurrected (it could otherwise re-enter auto-install).
      mockFetch.mockRejectedValueOnce(new Error('offline'));
      const result = await svc.fetchCatalog(['https://new.example.com/catalog.json']);
      expect(result).toEqual([]);
      expect(svc.wasLastFetchReachable()).toBe(false);
      expect(svc.getCachedCatalog()).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it('treats a malformed catalog entry as unreachable (does not commit a partial catalog)', async () => {
    // Seed a good cache from a first fetch…
    mockFetch.mockResolvedValueOnce(jsonResponse({ plugins: [{ name: 'alpha', version: '1.0.0' }] }));
    const { svc, cleanup } = makeService();
    try {
      await svc.fetchCatalog(['https://plugins.example.com/catalog.json']);
      expect(svc.getCachedCatalog()?.map((e) => e.name)).toEqual(['alpha']);

      // …then a fetch whose catalog contains a malformed (null) entry: accessing
      // plugin.name throws mid-iteration. The URL is NOT marked succeeded, so the
      // prior cache for that URL is preserved rather than clobbered with a partial.
      mockFetch.mockResolvedValueOnce(jsonResponse({ plugins: [null, { name: 'beta', version: '2.0.0' }] }));
      const result = await svc.fetchCatalog(['https://plugins.example.com/catalog.json']);
      expect(svc.wasLastFetchReachable()).toBe(false);
      // Preserved the prior good catalog (same url → still in scope).
      expect(result.map((e) => e.name)).toEqual(['alpha']);
      expect(svc.getCachedCatalog()?.map((e) => e.name)).toEqual(['alpha']);
    } finally {
      cleanup();
    }
  });

  it('preserves a FAILED source when another configured source succeeds (partial outage)', async () => {
    // Seed both sources: url B (enterprise, listed first) → beta, url A (public) → alpha.
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ plugins: [{ name: 'beta', version: '1.0.0' }] }))
      .mockResolvedValueOnce(jsonResponse({ plugins: [{ name: 'alpha', version: '1.0.0' }] }));
    const urls = ['https://enterprise.example.com/catalog.json', 'https://public.example.com/catalog.json'];
    const { svc, cleanup } = makeService();
    try {
      const first = await svc.fetchCatalog(urls);
      expect(first.map((e) => e.name).sort()).toEqual(['alpha', 'beta']);

      // Now B (enterprise) is down but A (public) succeeds. B's cached 'beta'
      // (potentially a required plugin) must survive, and reachable stays true.
      mockFetch
        .mockRejectedValueOnce(new Error('enterprise offline'))
        .mockResolvedValueOnce(jsonResponse({ plugins: [{ name: 'alpha', version: '1.1.0' }] }));
      const second = await svc.fetchCatalog(urls);
      expect(svc.wasLastFetchReachable()).toBe(true);
      const byName = new Map(second.map((e) => [e.name, e]));
      expect(byName.get('beta')?.version).toBe('1.0.0'); // preserved from B's cache
      expect(byName.get('alpha')?.version).toBe('1.1.0'); // refreshed from A
      expect(
        svc
          .getCachedCatalog()
          ?.map((e) => e.name)
          .sort(),
      ).toEqual(['alpha', 'beta']);
    } finally {
      cleanup();
    }
  });

  it("recovers a failed source's entry that a higher-priority source had shadowed", async () => {
    // Both A (enterprise, first) and B (public) list `foo`. A wins the merge, so
    // the flattened cache only records A's `foo`. Per-URL snapshots must still
    // hold B's own `foo` so a partial outage can recover it.
    const urls = ['https://enterprise.example.com/catalog.json', 'https://public.example.com/catalog.json'];
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ plugins: [{ name: 'foo', version: 'A1' }] }))
      .mockResolvedValueOnce(jsonResponse({ plugins: [{ name: 'foo', version: 'B1' }] }));
    const { svc, cleanup } = makeService();
    try {
      const first = await svc.fetchCatalog(urls);
      expect(first.map((e) => e.name)).toEqual(['foo']);
      expect(first[0].version).toBe('A1'); // A won the collision

      // A succeeds but DROPS foo; B (which also had foo) is down. Without per-URL
      // snapshots foo would vanish (the merged cache only recorded A's foo). With
      // them, B's own foo@B1 is recovered.
      mockFetch
        .mockResolvedValueOnce(jsonResponse({ plugins: [] })) // A: foo gone
        .mockRejectedValueOnce(new Error('public offline')); // B down
      const second = await svc.fetchCatalog(urls);
      expect(svc.wasLastFetchReachable()).toBe(true);
      expect(second.find((e) => e.name === 'foo')?.version).toBe('B1');
    } finally {
      cleanup();
    }
  });

  it('seeds per-URL snapshots from a legacy flat cache so a first offline fetch after upgrade preserves it', async () => {
    // Pre-upgrade state: flat marketplace.json only, no sidecar.
    const url = 'https://plugins.example.com/catalog.json';
    const legacy = [{ name: 'alpha', version: '1.0.0', marketplaceUrl: url }] as unknown as MarketplaceCatalogEntry[];
    const { svc, cleanup } = makeServiceWithLegacyCache(legacy);
    try {
      // First fetch after upgrade is offline. Without seeding the sidecar from
      // the legacy flat cache, this would overwrite marketplace.json with [].
      mockFetch.mockRejectedValueOnce(new Error('offline'));
      const result = await svc.fetchCatalog([url]);
      expect(svc.wasLastFetchReachable()).toBe(false);
      expect(result.map((e) => e.name)).toEqual(['alpha']); // preserved from legacy cache
      expect(svc.getCachedCatalog()?.map((e) => e.name)).toEqual(['alpha']);
    } finally {
      cleanup();
    }
  });
});
