import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { bridgeFixture } from '../../../test-utils/plugin-bridge.js';
import { localHttpsFixture } from '../../../test-utils/local-tls.js';
import { KaiMcpService } from '../service.js';
import { RemoteMcpEndpoint } from '../remote.js';
import { safeMcpLoginReturn, validateRedirect } from '../oauth.js';
import type { OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';

describe('remote MCP OAuth and static credentials on the existing listener', () => {
  let f: ReturnType<typeof bridgeFixture>,
    service: KaiMcpService,
    endpoint: RemoteMcpEndpoint,
    https: Awaited<ReturnType<typeof localHttpsFixture>>;
  const cookie = 'fixture=approved',
    verifier = 'v'.repeat(43),
    redirectUri = 'http://127.0.0.1:4567/callback';
  beforeEach(async () => {
    f = bridgeFixture();
    f.enableSharing(true);
    const tools = [
      {
        name: 'fixture_tool',
        source: 'plugin' as const,
        sourceId: 'fixture',
        description: 'fixture',
        inputSchema: z.object({}),
        execute: async () => ({ ok: true }),
      },
    ];
    service = new KaiMcpService(
      f.store,
      () => f.config,
      () => tools,
      () => true,
      (p) => f.credentials.active(p),
    );
    service.select(['plugin:fixture'], []);
    endpoint = new RemoteMcpEndpoint(service, f.credentials);
    f.credentials.onRevoked = () => {
      service.changed();
      endpoint.sweep();
    };
    https = await localHttpsFixture((req, res) => {
      if (!endpoint.handle(req, res, req.headers.cookie === cookie ? 'fixture-browser-session' : undefined)) {
        res.writeHead(404);
        res.end('Not a connector route.');
      }
    });
    f.config.mcpExport.remote.publicUrl = `${https.origin}/mcp`;
  });
  afterEach(async () => {
    await endpoint.close();
    await service.stop();
    await https.close();
    f.cleanup();
  });
  const json = (value: unknown) => ({
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(value),
  });
  const form = (value: Record<string, string>) => ({
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(value).toString(),
  });
  async function begin() {
    const registered = await https.request(
      '/register',
      json({
        client_name: 'Fixture client',
        redirect_uris: [redirectUri],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
      }),
    );
    expect(registered.status).toBe(201);
    const client = JSON.parse(registered.body) as { client_id: string };
    const auth = new URLSearchParams({
      client_id: client.client_id,
      response_type: 'code',
      redirect_uri: redirectUri,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
      resource: f.config.mcpExport.remote.publicUrl,
      scope: 'kai:tools',
      state: 'fixture-state',
    });
    const response = await https.request(`/authorize?${auth}`);
    expect(response.status).toBe(303);
    return { client, consent: response.headers.location! };
  }
  async function approve() {
    const { client, consent } = await begin();
    const screen = await https.request(consent, { headers: { Cookie: cookie } });
    expect(screen.status).toBe(200);
    expect(screen.headers['referrer-policy']).toBe('same-origin');
    expect(screen.headers['content-security-policy']).toContain(`form-action 'self' ${new URL(redirectUri).origin}`);
    const csrf = /name="csrf" value="([^"]+)"/.exec(screen.body)![1];
    const decision = form({ csrf, decision: 'allow' });
    decision.headers = { ...decision.headers, Cookie: cookie } as typeof decision.headers;
    const approved = await https.request(consent, decision);
    expect(approved.status).toBe(303);
    const callback = new URL(approved.headers.location!);
    expect(callback.searchParams.get('state')).toBe('fixture-state');
    return { client, code: callback.searchParams.get('code')! };
  }
  async function tokens() {
    const { client, code } = await approve();
    const response = await https.request(
      '/token',
      form({
        grant_type: 'authorization_code',
        client_id: client.client_id,
        code,
        code_verifier: verifier,
        redirect_uri: redirectUri,
        resource: f.config.mcpExport.remote.publicUrl,
      }),
    );
    expect(response.status).toBe(200);
    return { client, code, tokens: JSON.parse(response.body) as OAuthTokens };
  }
  it('publishes canonical metadata independently of request Host and rejects anonymous MCP', async () => {
    const metadata = await https.request('/.well-known/oauth-protected-resource/mcp', {
      headers: { Host: 'untrusted.example' },
    });
    expect(metadata.status).toBe(200);
    expect(JSON.parse(metadata.body).resource).toBe(`${https.origin}/mcp`);
    const auth = await https.request('/.well-known/oauth-authorization-server');
    expect(JSON.parse(auth.body).authorization_endpoint).toBe(`${https.origin}/authorize`);
    const denied = await https.request('/mcp', json({}));
    expect(denied.status).toBe(401);
    expect(denied.headers['www-authenticate']).toContain(`${https.origin}/.well-known/oauth-protected-resource/mcp`);
  });
  it('requires Web UI sign-in, CSRF and connector consent', async () => {
    const { consent } = await begin();
    const signIn = await https.request(consent);
    expect(signIn.status).toBe(303);
    expect(signIn.headers.location).toContain('/login?returnTo=');
    expect(
      (
        await https.request(consent, {
          ...form({ decision: 'allow', csrf: 'wrong' }),
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
        })
      ).status,
    ).toBe(403);
    expect(safeMcpLoginReturn('//evil.example')).toBe('/');
    expect(validateRedirect('https://site.test/#fragment')).toBe(false);
    expect(validateRedirect('http://evil.example/callback')).toBe(false);
  });
  it('exchanges single-use codes with PKCE, rotates refresh tokens and revokes grants', async () => {
    const result = await tokens();
    expect(result.tokens.expires_in).toBe(3600);
    expect(f.credentials.verify(result.tokens.access_token, 'remote')).toBeTruthy();
    const replay = await https.request(
      '/token',
      form({
        grant_type: 'authorization_code',
        client_id: result.client.client_id,
        code: result.code,
        code_verifier: verifier,
        redirect_uri: redirectUri,
      }),
    );
    expect(replay.status).toBe(400);
    const refresh = form({
      grant_type: 'refresh_token',
      client_id: result.client.client_id,
      refresh_token: result.tokens.refresh_token!,
      resource: f.config.mcpExport.remote.publicUrl,
    });
    const renewed = await https.request('/token', refresh);
    expect(renewed.status).toBe(200);
    expect(JSON.parse(renewed.body).refresh_token).not.toBe(result.tokens.refresh_token);
    expect((await https.request('/token', refresh)).status).toBe(400);
    expect(
      (
        await https.request(
          '/revoke',
          form({ client_id: result.client.client_id, token: JSON.parse(renewed.body).access_token }),
        )
      ).status,
    ).toBe(200);
    expect(f.credentials.verify(result.tokens.access_token, 'remote')).toBeNull();
  });
  it('rejects wrong PKCE, audience, redirects and replayed authorization codes', async () => {
    const { client, code } = await approve();
    const exchange = {
      grant_type: 'authorization_code',
      client_id: client.client_id,
      code,
      code_verifier: 'w'.repeat(43),
      redirect_uri: redirectUri,
      resource: f.config.mcpExport.remote.publicUrl,
    };
    expect((await https.request('/token', form(exchange))).status).toBe(400);
    exchange.code_verifier = verifier;
    expect((await https.request('/token', form(exchange))).status).toBe(400);
    const other = await approve();
    expect(
      (
        await https.request(
          '/token',
          form({
            ...exchange,
            client_id: other.client.client_id,
            code: other.code,
            resource: 'https://other.test/mcp',
          }),
        )
      ).status,
    ).toBe(400);
    const bad = await https.request(
      '/register',
      json({
        client_name: 'bad',
        redirect_uris: ['https://user:secret@site.test/callback'],
        token_endpoint_auth_method: 'none',
      }),
    );
    expect(bad.status).toBe(400);
  });
  it('supports named expiring static tokens and MCP sessions, with no administrative routes', async () => {
    const { client, token } = f.credentials.createStatic('Local test only');
    expect(Date.parse(client.expiresAt!) - Date.now()).toBe(30 * 86_400_000);
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${token}`,
    };
    const initialized = await https.request('/mcp', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'fixture', version: '1' } },
      }),
    });
    expect(initialized.status).toBe(200);
    expect(initialized.body).toContain('kai-mcp');
    const session = initialized.headers['mcp-session-id'] as string;
    expect(session).toBeTruthy();
    const list = await https.request('/mcp', {
      method: 'POST',
      headers: { ...headers, 'Mcp-Session-Id': session, 'MCP-Protocol-Version': '2025-03-26' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    });
    expect(list.status).toBe(200);
    expect(list.body).toContain('fixture_tool');
    expect((await https.request('/api/config', { headers })).status).toBe(404);
    f.credentials.revoke(client.id);
    expect((await https.request('/mcp', { headers })).status).toBe(401);
  });
  it('invalidates remote tokens and pending codes on password changes or sharing disable', async () => {
    const { tokens: issued } = await tokens();
    const pending = await approve();
    f.config.webServer.auth.password = 'rotated-fixture-password';
    expect(f.credentials.verify(issued.access_token, 'remote')).toBeNull();
    expect(
      (
        await https.request(
          '/token',
          form({
            grant_type: 'authorization_code',
            client_id: pending.client.client_id,
            code: pending.code,
            code_verifier: verifier,
            redirect_uri: redirectUri,
          }),
        )
      ).status,
    ).toBe(400);
    f.config.mcpExport.remote.enabled = false;
    expect((await https.request('/mcp')).status).toBe(404);
    expect((await https.request('/register', json({}))).status).toBe(404);
  });
  it('does not let MCP credentials become local or Web UI approval credentials', async () => {
    const { token } = f.credentials.createStatic('Only MCP');
    expect(f.credentials.verify(token, 'local')).toBeNull();
    const local = f.localClient();
    expect(f.credentials.verify(local.token, 'remote')).toBeNull();
    expect(
      (
        await https.request('/mcp', {
          headers: { Authorization: `Bearer ${token}`, Origin: 'https://untrusted.example' },
        })
      ).status,
    ).toBe(403);
    expect(
      (await https.request('/mcp', { headers: { Authorization: `Bearer ${token}`, Origin: 'null' } })).status,
    ).toBe(403);
  });
});
