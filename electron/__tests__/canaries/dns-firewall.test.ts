/**
 * HTTP egress firewall canary.
 *
 * This is the no-msw counterpart to `msw-coverage.test.ts`. It deliberately
 * does NOT call `httpMock.server.listen()` — so the only thing standing
 * between `fetch()` and the public internet is the firewall wrapper
 * installed in `vitest.setup.ts`.
 *
 * If this test passes, the firewall is doing its job: provider-bound
 * requests fail-closed with a recognizable error and never leave the
 * machine. If it fails, hermeticity is compromised and unrelated test
 * failures elsewhere in the suite could be hiding silent network leaks.
 *
 * Two layers covered:
 *   1. `globalThis.fetch` — the primary wrapper.
 *   2. Direct `undici` imports — the `vi.mock('undici', …)` guard, which
 *      catches `import { request, stream, Pool, Client } from 'undici'`
 *      escape routes that bypass the global.
 */

import { describe, it, expect } from 'vitest';

import { HTTP_FIREWALL_ERROR_CODE } from '../../../test-utils/blocked-hosts.js';

interface NodeNetError extends Error {
  code?: string;
}

/**
 * Each entry must produce a firewall-injected error with `code` set to
 * `HTTP_FIREWALL_ERROR_CODE` and a message that names the blocked host.
 */
const BLOCKED_PROBES = [
  {
    url: 'https://api.anthropic.com/v1/messages',
    hostFragment: 'api.anthropic.com',
  },
  {
    url: 'https://api.openai.com/v1/chat/completions',
    hostFragment: 'api.openai.com',
  },
  {
    url: 'https://bedrock-runtime.us-west-2.amazonaws.com/model/x/invoke',
    hostFragment: 'bedrock-runtime',
  },
  {
    url: 'https://bedrock-runtime.fips.us-east-1.amazonaws.com/model/x/invoke',
    hostFragment: 'bedrock-runtime.fips',
  },
  {
    url: 'https://example-resource.openai.azure.com/openai/deployments/x/chat/completions',
    hostFragment: 'openai.azure.com',
  },
  {
    url: 'https://generativelanguage.googleapis.com/v1/models/gemini-pro:generateContent',
    hostFragment: 'generativelanguage.googleapis.com',
  },
  {
    url: 'https://us-central1-aiplatform.googleapis.com/v1/projects/foo/locations/us-central1/publishers/google/models/gemini-pro:predict',
    hostFragment: 'aiplatform.googleapis.com',
  },
  {
    url: 'https://api.mistral.ai/v1/chat/completions',
    hostFragment: 'api.mistral.ai',
  },
  {
    url: 'https://api.cohere.ai/v1/chat',
    hostFragment: 'api.cohere.ai',
  },
  {
    url: 'https://api.cohere.com/v2/chat',
    hostFragment: 'api.cohere.com',
  },
] as const;

describe('http egress firewall (no msw)', () => {
  it('blocks unmocked fetch to known provider hostnames with a recognizable error', async () => {
    for (const { url, hostFragment } of BLOCKED_PROBES) {
      let caught: NodeNetError | null = null;
      try {
        await fetch(url, { method: 'POST' });
      } catch (e) {
        caught = e as NodeNetError;
      }
      expect(caught, `expected fetch(${url}) to be blocked by the firewall`).not.toBeNull();
      expect(caught?.code).toBe(HTTP_FIREWALL_ERROR_CODE);
      // The error message must point at the firewall, not be a generic
      // network failure — otherwise a real-world DNS outage could look the
      // same as a successful block.
      expect(caught?.message).toMatch(/HTTP egress firewall/);
      expect(caught?.message).toContain(hostFragment);
    }
  });
});

describe('http egress firewall (undici direct imports)', () => {
  it('blocks `undici.fetch` to known provider hostnames', async () => {
    const { fetch: undiciFetch } = await import('undici');
    let caught: NodeNetError | null = null;
    try {
      await undiciFetch('https://api.anthropic.com/v1/messages', { method: 'POST' });
    } catch (e) {
      caught = e as NodeNetError;
    }
    expect(caught?.code).toBe(HTTP_FIREWALL_ERROR_CODE);
    expect(caught?.message).toMatch(/HTTP egress firewall/);
  });

  it('blocks `undici.request` to known provider hostnames', async () => {
    const { request } = await import('undici');
    let caught: NodeNetError | null = null;
    try {
      await request('https://api.openai.com/v1/chat/completions', { method: 'POST' });
    } catch (e) {
      caught = e as NodeNetError;
    }
    expect(caught?.code).toBe(HTTP_FIREWALL_ERROR_CODE);
    expect(caught?.message).toMatch(/undici\.request/);
  });

  it('blocks `new Pool(...)` for provider origins', async () => {
    const { Pool } = await import('undici');
    let caught: NodeNetError | null = null;
    try {
      new Pool('https://api.anthropic.com');
    } catch (e) {
      caught = e as NodeNetError;
    }
    expect(caught?.code).toBe(HTTP_FIREWALL_ERROR_CODE);
    expect(caught?.message).toMatch(/undici\.Pool/);
  });

  it('blocks `new Client(...)` for provider origins', async () => {
    const { Client } = await import('undici');
    let caught: NodeNetError | null = null;
    try {
      new Client('https://api.openai.com');
    } catch (e) {
      caught = e as NodeNetError;
    }
    expect(caught?.code).toBe(HTTP_FIREWALL_ERROR_CODE);
    expect(caught?.message).toMatch(/undici\.Client/);
  });

  it('permits `undici.request` to non-blocked hosts (round-trips to wrapped fetch only via undici.fetch)', async () => {
    const { request } = await import('undici');
    // Loopback to a clearly non-existent local port — we just want to assert
    // the firewall does NOT throw before the request leaves; the request
    // itself will fail with a connection refused / ENOTFOUND.
    let firewallTripped = false;
    try {
      await request('http://127.0.0.1:1/non-existent', { method: 'GET' });
    } catch (e) {
      const msg = (e as Error).message ?? '';
      if (/HTTP egress firewall/.test(msg)) firewallTripped = true;
    }
    expect(firewallTripped, 'firewall should not trip on loopback').toBe(false);
  });
});
