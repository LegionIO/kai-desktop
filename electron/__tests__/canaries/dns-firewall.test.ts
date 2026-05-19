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
 */

import { describe, it, expect } from 'vitest';

import { HTTP_FIREWALL_ERROR_CODE } from '../../../vitest.setup.js';

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
    url: 'https://example-resource.openai.azure.com/openai/deployments/x/chat/completions',
    hostFragment: 'openai.azure.com',
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
