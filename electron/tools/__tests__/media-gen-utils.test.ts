/**
 * Tests for media-gen-utils.ts pure helpers. A bug in resolveMediaGenEndpoint
 * silently points media generation at the wrong host/path; saveMediaToFile's
 * safeExt guard prevents a config-derived extension from escaping the media dir;
 * filePathToUrl maps a saved path to the renderer media protocol; streamToBuffer
 * enforces the size cap against a runaway provider body.
 *
 * electron is mocked because withBrandUserAgent (via user-agent.ts) reads app.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';

vi.mock('electron', () => ({ app: { getVersion: () => '9.9.9', getLocale: () => 'en-US' } }));

import {
  resolveMediaGenEndpoint,
  saveMediaToFile,
  filePathToUrl,
  streamToBuffer,
  type MediaGenProviderConfig,
} from '../media-gen-utils.js';

describe('resolveMediaGenEndpoint', () => {
  it('routes openai to api.openai.com/v1 with a Bearer header', () => {
    const cfg = { provider: 'openai', openai: { apiKey: 'sk-x' } } as unknown as MediaGenProviderConfig;
    const r = resolveMediaGenEndpoint(cfg, '/images/generations');
    expect(r.url).toBe('https://api.openai.com/v1/images/generations');
    expect(r.headers.authorization).toBe('Bearer sk-x');
  });

  it('throws when the openai key is missing', () => {
    const cfg = { provider: 'openai' } as unknown as MediaGenProviderConfig;
    expect(() => resolveMediaGenEndpoint(cfg, '/x')).toThrow(/OpenAI API key/);
  });

  it('routes azure deployment-style with deployment name + api-version, stripping trailing slashes', () => {
    const cfg = {
      provider: 'azure',
      azure: {
        endpoint: 'https://foo.openai.azure.com//',
        apiKey: 'k',
        deploymentName: 'dall-e-3',
        apiVersion: '2024-02-01',
      },
    } as unknown as MediaGenProviderConfig;
    const r = resolveMediaGenEndpoint(cfg, '/images/generations', 'deployment');
    expect(r.url).toBe(
      'https://foo.openai.azure.com/openai/deployments/dall-e-3/images/generations?api-version=2024-02-01',
    );
    expect(r.headers.authorization).toBe('Bearer k');
  });

  it('falls back to config.model for the deployment name and a default api-version', () => {
    const cfg = {
      provider: 'azure',
      model: 'gpt-image-1',
      azure: { endpoint: 'https://foo.openai.azure.com', apiKey: 'k' },
    } as unknown as MediaGenProviderConfig;
    const r = resolveMediaGenEndpoint(cfg, '/images/generations', 'deployment');
    expect(r.url).toContain('/openai/deployments/gpt-image-1/images/generations?api-version=2024-02-01');
  });

  it('routes azure v1-style: rewrites .openai.azure.com → .cognitiveservices.azure.com and uses api-key header', () => {
    const cfg = {
      provider: 'azure',
      azure: { endpoint: 'https://foo.openai.azure.com', apiKey: 'k' },
    } as unknown as MediaGenProviderConfig;
    const r = resolveMediaGenEndpoint(cfg, '/audio/speech', 'v1');
    expect(r.url).toBe('https://foo.cognitiveservices.azure.com/openai/v1/audio/speech');
    expect(r.headers['api-key']).toBe('k');
    expect(r.headers.authorization).toBeUndefined();
  });

  it('throws when the azure endpoint or deployment is missing', () => {
    expect(() => resolveMediaGenEndpoint({ provider: 'azure' } as never, '/x')).toThrow(/Azure endpoint/);
    expect(() =>
      resolveMediaGenEndpoint({ provider: 'azure', azure: { endpoint: 'https://a.openai.azure.com' } } as never, '/x'),
    ).toThrow(/deployment name/);
  });

  it('routes custom to baseUrl+path with an optional Bearer, stripping trailing slashes', () => {
    const withKey = resolveMediaGenEndpoint(
      { provider: 'custom', custom: { baseUrl: 'https://media.local//', apiKey: 'ck' } } as never,
      '/gen',
    );
    expect(withKey.url).toBe('https://media.local/gen');
    // NOTE: the custom path sets `Authorization` directly (capitalized), unlike
    // openai/azure which pass it through withBrandUserAgent (lowercased). Both
    // are valid — HTTP header names are case-insensitive.
    expect(withKey.headers.Authorization).toBe('Bearer ck');
    const noKey = resolveMediaGenEndpoint(
      { provider: 'custom', custom: { baseUrl: 'https://media.local' } } as never,
      '/gen',
    );
    expect(noKey.headers.Authorization).toBeUndefined();
  });

  it('throws for a custom provider with no baseUrl and an unknown provider', () => {
    expect(() => resolveMediaGenEndpoint({ provider: 'custom' } as never, '/x')).toThrow(/Custom base URL/);
    expect(() => resolveMediaGenEndpoint({ provider: 'bogus' } as never, '/x')).toThrow(
      /Unknown media generation provider/,
    );
  });

  it('defaults an absent provider to azure', () => {
    expect(() => resolveMediaGenEndpoint({} as never, '/x')).toThrow(/Azure endpoint/); // azure path → missing endpoint
  });
});

describe('saveMediaToFile', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'kai-mediagen-'));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it('writes under appHome/media/<type> with a timestamp-uuid.<ext> name', () => {
    const p = saveMediaToFile(Buffer.from('img'), 'images', 'png', home);
    expect(p.startsWith(join(home, 'media', 'images'))).toBe(true);
    expect(p).toMatch(/\/\d+-[0-9a-f]{8}\.png$/);
    expect(readFileSync(p, 'utf-8')).toBe('img');
  });

  it('sanitizes a path-escaping extension to "bin"', () => {
    const p = saveMediaToFile(Buffer.from('x'), 'videos', '../../evil', home);
    // The malicious ext cannot escape the media dir; it collapses to .bin.
    expect(dirname(p)).toBe(join(home, 'media', 'videos'));
    expect(p.endsWith('.bin')).toBe(true);
    expect(p).not.toContain('..');
  });

  it('lowercases and accepts a short alphanumeric extension', () => {
    const p = saveMediaToFile(Buffer.from('a'), 'audio', 'MP3', home);
    expect(p.endsWith('.mp3')).toBe(true);
  });

  it('rejects an over-long extension → bin', () => {
    const p = saveMediaToFile(Buffer.from('a'), 'images', 'superlongext', home);
    expect(p.endsWith('.bin')).toBe(true);
  });
});

describe('filePathToUrl', () => {
  it('maps a path under /media/ to the media protocol URL', () => {
    const url = filePathToUrl('/Users/me/.kai/media/images/123-abcd.png');
    expect(url).toMatch(/:\/\/images\/123-abcd\.png$/);
  });

  it('falls back to the full path when no /media/ marker is present', () => {
    const url = filePathToUrl('/tmp/orphan.png');
    expect(url).toContain('/tmp/orphan.png');
  });
});

describe('streamToBuffer', () => {
  const streamOf = (chunks: Uint8Array[]): ReadableStream =>
    new ReadableStream({
      start(controller) {
        for (const c of chunks) controller.enqueue(c);
        controller.close();
      },
    });

  it('concatenates all chunks into a single buffer', async () => {
    const buf = await streamToBuffer(streamOf([new Uint8Array([1, 2]), new Uint8Array([3])]), { maxBytes: 1000 });
    expect([...buf]).toEqual([1, 2, 3]);
  });

  it('throws once the cumulative size exceeds the cap', async () => {
    const big = streamOf([new Uint8Array(60), new Uint8Array(60)]); // 120 bytes
    await expect(streamToBuffer(big, { maxBytes: 100 })).rejects.toThrow(/size limit/);
  });

  it('returns an empty buffer for an empty stream', async () => {
    const buf = await streamToBuffer(streamOf([]), { maxBytes: 100 });
    expect(buf.length).toBe(0);
  });

  it('defaults to the MAX_MEDIA_BYTES cap when called with just a stream (no opts)', async () => {
    const buf = await streamToBuffer(streamOf([new Uint8Array([9])]));
    expect([...buf]).toEqual([9]);
  });

  it('aborts a trickling stream when the signal fires mid-read (the DoS the fix closes)', async () => {
    // A stream that yields one chunk then never produces another must be
    // interruptible: streamToBuffer races each read against the abort signal and
    // cancels the reader on abort.
    let cancelled = false;
    const trickle = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([1])); // one chunk, then hang
      },
      cancel() {
        cancelled = true;
      },
    });
    const ac = new AbortController();
    const p = streamToBuffer(trickle, { signal: ac.signal });
    await new Promise((r) => setTimeout(r, 10)); // let the first read land
    ac.abort(); // next read() never resolves — only the abort race unblocks it
    await expect(p).rejects.toThrow(/aborted/i);
    await new Promise((r) => setTimeout(r, 0)); // best-effort cancel is a microtask
    expect(cancelled).toBe(true);
  });

  it('rejects immediately when handed an already-aborted signal', async () => {
    const ac = new AbortController();
    ac.abort();
    const never = new ReadableStream({ start() {} }); // never enqueues/closes
    await expect(streamToBuffer(never, { signal: ac.signal })).rejects.toThrow(/aborted/i);
  });
});
