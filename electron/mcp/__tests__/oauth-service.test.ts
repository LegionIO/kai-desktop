import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse, passthrough } from 'msw';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, webcrypto } from 'node:crypto';
import { httpMock } from '../../../vitest.setup.js';
import {
  fixtureEncryption,
  oauthCallback,
  oauthHandlers,
  oauthMetadata,
  oauthServer,
  oauthTokens,
} from '../../../test-utils/mcp-oauth.js';
import { McpCredentialStore } from '../credential-store.js';
import { McpOAuthService, mcpCredentialKey } from '../oauth-service.js';

let home: string, store: McpCredentialStore, service: McpOAuthService;
const authorized = vi.fn(async () => {});
beforeAll(() => httpMock.server.listen({ onUnhandledRequest: 'error' }));
afterAll(() => httpMock.server.close());
beforeEach(() => {
  Object.defineProperty(globalThis.crypto, 'subtle', { value: webcrypto.subtle, configurable: true });
  home = mkdtempSync(join(tmpdir(), 'kai-oauth-test-'));
  store = new McpCredentialStore(home, fixtureEncryption());
  service = new McpOAuthService(store, { onAuthorized: authorized, metadataUrl: 'https://kai.test/oauth/client.json' });
  service.configure([oauthServer]);
  authorized.mockClear();
  httpMock.use(...oauthHandlers());
});
afterEach(() => {
  service.dispose();
  httpMock.expectNoUnhandled();
  httpMock.server.resetHandlers();
  rmSync(home, { recursive: true, force: true });
});
async function signIn() {
  const flow = await service.login('fixture');
  await service.completeLogin(flow.loginId, oauthCallback(flow));
  return flow;
}
function expire() {
  vi.setSystemTime(Date.now() + 95_000);
}

describe('registration, discovery and local callback', () => {
  it('uses CIMD, PKCE S256 and resource indicators, and sends a matching verifier', async () => {
    let posted = new URLSearchParams();
    httpMock.use(
      http.post('https://auth.test/token', async ({ request }) => {
        posted = new URLSearchParams(await request.text());
        return HttpResponse.json(oauthTokens);
      }),
    );
    const flow = await service.login('fixture');
    const url = new URL(flow.authorizationUrl);
    expect(url.searchParams.get('client_id')).toBe('https://kai.test/oauth/client.json');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('resource')).toBe(oauthServer.url);
    expect(url.searchParams.get('scope')).toBe('read offline_access');
    expect(url.searchParams.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    await service.completeLogin(flow.loginId, oauthCallback(flow));
    expect(createHash('sha256').update(posted.get('code_verifier')!).digest('base64url')).toBe(
      url.searchParams.get('code_challenge'),
    );
    expect(posted.get('resource')).toBe(oauthServer.url);
    expect(service.status('fixture').state).toBe('authorized');
    expect(authorized).toHaveBeenCalledExactlyOnceWith('fixture');
    expect(JSON.stringify(service.status('fixture'))).not.toContain('fixture-secret');
    await expect(service.completeLogin(flow.loginId, oauthCallback(flow))).rejects.toThrow(
      'expired or was already completed',
    );
  });
  it('uses DCR when CIMD is unavailable and reuses the registered redirect port', async () => {
    httpMock.use(...oauthHandlers({ ...oauthMetadata, client_id_metadata_document_supported: false }));
    const first = await signIn();
    httpMock.expectHit('/register');
    await service.logout('fixture');
    const second = await service.login('fixture');
    expect(new URL(second.authorizationUrl).searchParams.get('client_id')).toBe('dcr-client');
    expect(new URL(second.authorizationUrl).searchParams.get('redirect_uri')).toBe(
      new URL(first.authorizationUrl).searchParams.get('redirect_uri'),
    );
  });
  it.each([false, true])('prefers pre-registered clients (confidential=%s)', async (confidential) => {
    service.configure([{ ...oauthServer, oauth: { clientId: 'registered' } }]);
    if (confidential) service.setClientSecret('fixture', 'private-client-secret');
    let authorization: string | null = null;
    httpMock.use(
      http.post('https://auth.test/token', ({ request }) => {
        authorization = request.headers.get('authorization');
        return HttpResponse.json(oauthTokens);
      }),
    );
    const flow = await signIn();
    expect(new URL(flow.authorizationUrl).searchParams.get('client_id')).toBe('registered');
    expect(authorization).toBe(
      confidential ? `Basic ${Buffer.from('registered:private-client-secret').toString('base64')}` : null,
    );
  });
  it('requires configuration when neither CIMD nor DCR is supported', async () => {
    httpMock.use(
      ...oauthHandlers({
        ...oauthMetadata,
        client_id_metadata_document_supported: false,
        registration_endpoint: undefined,
      }),
    );
    await expect(service.login('fixture')).rejects.toThrow('pre-registered');
    expect(service.status('fixture').reason).toBe('invalid-client');
  });
  it.each([
    ['wrong state', { state: 'wrong' }],
    ['wrong issuer', { iss: 'https://evil.test' }],
    ['missing issuer', { iss: null }],
  ])('rejects %s without consuming a valid attempt', async (_label, values) => {
    const flow = await service.login('fixture');
    await expect(service.completeLogin(flow.loginId, oauthCallback(flow, values))).rejects.toThrow();
    expect(store.get(mcpCredentialKey(oauthServer)).tokens).toBeUndefined();
    await service.completeLogin(flow.loginId, oauthCallback(flow));
    expect(service.status('fixture').state).toBe('authorized');
  });
  it('rejects duplicate state and non-loopback callback destinations', async () => {
    const flow = await service.login('fixture');
    await expect(service.completeLogin(flow.loginId, `${oauthCallback(flow)}&state=again`)).rejects.toThrow('Invalid');
    await expect(
      service.completeLogin(flow.loginId, oauthCallback(flow).replace('127.0.0.1', 'evil.test')),
    ).rejects.toThrow('Invalid');
  });
  it.each([
    { ...oauthMetadata, issuer: 'https://wrong.test' },
    { ...oauthMetadata, code_challenge_methods_supported: ['plain'] },
    { ...oauthMetadata, revocation_endpoint: 'http://unsafe.test/revoke' },
  ])('rejects insecure or mismatched authorization metadata %#', async (metadata) => {
    httpMock.use(...oauthHandlers(metadata));
    await expect(service.login('fixture')).rejects.toThrow();
  });
  it('supports OIDC discovery preserving issuer-response validation', async () => {
    httpMock.use(
      http.get(
        'https://auth.test/.well-known/oauth-authorization-server',
        () => new HttpResponse(null, { status: 404 }),
      ),
      http.get('https://auth.test/.well-known/openid-configuration', () =>
        HttpResponse.json({
          ...oauthMetadata,
          jwks_uri: 'https://auth.test/jwks',
          subject_types_supported: ['public'],
          id_token_signing_alg_values_supported: ['RS256'],
        }),
      ),
    );
    const flow = await service.login('fixture');
    await expect(service.completeLogin(flow.loginId, oauthCallback(flow, { iss: null }))).rejects.toThrow('issuer');
    await service.completeLogin(flow.loginId, oauthCallback(flow));
  });
  it('isolates credentials by configuration and invalidates a changed endpoint', async () => {
    const flow = await service.login('fixture');
    service.configure([{ ...oauthServer, url: 'https://other.test/mcp' }]);
    await expect(service.completeLogin(flow.loginId, oauthCallback(flow))).rejects.toThrow();
    expect(store.get(mcpCredentialKey(oauthServer))).toEqual({});
    expect(service.status('fixture').state).toBe('none');
  });
  it('cancels and expires login attempts without opening another browser', async () => {
    const first = await service.login('fixture');
    service.cancelLogin('fixture');
    await expect(service.completeLogin(first.loginId, oauthCallback(first))).rejects.toThrow();
    const second = await service.login('fixture');
    vi.setSystemTime(Date.now() + 300_001);
    await expect(service.completeLogin(second.loginId, oauthCallback(second))).rejects.toThrow('expired');
  });
});

describe('refresh and recovery', () => {
  it('serializes concurrent refresh and persists rotated tokens across restart', async () => {
    await signIn();
    expire();
    let refreshes = 0;
    httpMock.use(
      http.post('https://auth.test/token', async ({ request }) => {
        const body = new URLSearchParams(await request.text());
        expect(body.get('refresh_token')).toBe(oauthTokens.refresh_token);
        refreshes++;
        return HttpResponse.json({ ...oauthTokens, access_token: 'rotated-access', refresh_token: 'rotated-refresh' });
      }),
    );
    const fetch = service.authenticatedFetch(oauthServer);
    await Promise.all(Array.from({ length: 8 }, () => fetch(oauthServer.url!)));
    expect(refreshes).toBe(1);
    expect(
      new McpCredentialStore(home, fixtureEncryption()).get(mcpCredentialKey(oauthServer)).tokens?.refresh_token,
    ).toBe('rotated-refresh');
  });
  it('retains the previous refresh token when the provider omits it', async () => {
    await signIn();
    expire();
    httpMock.use(
      http.post('https://auth.test/token', () =>
        HttpResponse.json({ access_token: 'new', token_type: 'Bearer', expires_in: 100 }),
      ),
    );
    await service.authenticatedFetch(oauthServer)(oauthServer.url!);
    expect(store.get(mcpCredentialKey(oauthServer)).tokens?.refresh_token).toBe(oauthTokens.refresh_token);
  });
  it('retries a rejected request only once and requires reconnect after a second 401', async () => {
    await signIn();
    let calls = 0,
      refreshes = 0;
    httpMock.use(
      http.all(oauthServer.url!, () => {
        calls++;
        return new HttpResponse(null, { status: 401 });
      }),
      http.post('https://auth.test/token', () => {
        refreshes++;
        return HttpResponse.json(oauthTokens);
      }),
    );
    await expect(
      service.authenticatedFetch(oauthServer)(oauthServer.url!, { method: 'POST', body: 'tool-call' }),
    ).rejects.toThrow('Sign in again');
    expect(calls).toBe(2);
    expect(refreshes).toBe(1);
    expect(service.status('fixture').reason).toBe('expired');
  });
  it('never replays an ambiguous network failure', async () => {
    await signIn();
    let calls = 0;
    httpMock.use(
      http.all(oauthServer.url!, () => {
        calls++;
        return HttpResponse.error();
      }),
    );
    await expect(
      service.authenticatedFetch(oauthServer)(oauthServer.url!, { method: 'POST', body: 'tool-call' }),
    ).rejects.toThrow();
    expect(calls).toBe(1);
    expect(service.status('fixture').state).toBe('authorized');
  });
  it('keeps credentials and authentication status on transient refresh failures', async () => {
    await signIn();
    expire();
    httpMock.use(
      http.post('https://auth.test/token', () =>
        HttpResponse.json({ error: 'server_error', error_description: 'sensitive' }, { status: 503 }),
      ),
    );
    await expect(service.authenticatedFetch(oauthServer)(oauthServer.url!)).rejects.toThrow('temporarily unavailable');
    expect(store.get(mcpCredentialKey(oauthServer)).tokens).toEqual(oauthTokens);
    expect(service.status('fixture').state).toBe('authorized');
  });
  it('invalid_grant clears revoked tokens and requests sign-in again', async () => {
    await signIn();
    expire();
    httpMock.use(
      http.post('https://auth.test/token', () => HttpResponse.json({ error: 'invalid_grant' }, { status: 400 })),
    );
    await expect(service.authenticatedFetch(oauthServer)(oauthServer.url!)).rejects.toThrow('Sign in again');
    expect(store.get(mcpCredentialKey(oauthServer)).tokens).toBeUndefined();
    expect(service.status('fixture').reason).toBe('expired');
  });
  it('requests additional scopes through reconnect without automatic retry', async () => {
    await signIn();
    let calls = 0;
    httpMock.use(
      http.all(oauthServer.url!, () => {
        calls++;
        return new HttpResponse(null, {
          status: 403,
          headers: { 'WWW-Authenticate': 'Bearer error="insufficient_scope", scope="read write"' },
        });
      }),
    );
    await expect(service.authenticatedFetch(oauthServer)(oauthServer.url!)).rejects.toThrow('Additional permissions');
    expect(calls).toBe(1);
    const flow = await service.login('fixture');
    expect(new URL(flow.authorizationUrl).searchParams.get('scope')).toContain('write');
  });
  it('preserves ordinary 403 as a permission error', async () => {
    await signIn();
    httpMock.use(http.all(oauthServer.url!, () => new HttpResponse(null, { status: 403 })));
    expect((await service.authenticatedFetch(oauthServer)(oauthServer.url!)).status).toBe(403);
    expect(service.status('fixture').state).toBe('authorized');
  });
  it('tests unsaved servers without borrowing saved credentials or starting login', async () => {
    await signIn();
    let auth: string | null = null;
    httpMock.use(
      http.all(oauthServer.url!, ({ request }) => {
        auth = request.headers.get('authorization');
        return new HttpResponse(null, { status: 401 });
      }),
    );
    await expect(
      service.authenticatedFetch({ ...oauthServer, oauth: { clientId: 'different' } })(oauthServer.url!),
    ).rejects.toThrow('Save this MCP server');
    expect(auth).toBeNull();
    expect(service.status('fixture').state).toBe('authorized');
  });
  it('refuses cross-origin requests even before sending credentials', async () => {
    await signIn();
    await expect(service.authenticatedFetch(oauthServer)('https://evil.test/mcp')).rejects.toThrow('another origin');
  });
  it('clears local tokens and distinguishes revocation outcomes', async () => {
    await signIn();
    expect(await service.logout('fixture')).toEqual({ localCleared: true, revocation: 'confirmed' });
    expect(store.get(mcpCredentialKey(oauthServer)).tokens).toBeUndefined();
    await signIn();
    httpMock.use(http.post('https://auth.test/revoke', () => new HttpResponse(null, { status: 503 })));
    expect(await service.logout('fixture')).toEqual({ localCleared: true, revocation: 'failed' });
  });
});

it('does not send a request after cancellation while waiting for refresh', async () => {
  await signIn();
  expire();
  let started!: () => void,
    release!: () => void,
    calls = 0;
  const began = new Promise<void>((done) => {
    started = done;
  });
  const gate = new Promise<void>((done) => {
    release = done;
  });
  httpMock.use(
    http.post('https://auth.test/token', async () => {
      started();
      await gate;
      return HttpResponse.json(oauthTokens);
    }),
    http.all(oauthServer.url!, () => {
      calls++;
      return new HttpResponse('ok');
    }),
  );
  const abort = new AbortController();
  const pending = service.authenticatedFetch(oauthServer)(oauthServer.url!, { signal: abort.signal });
  const rejected = expect(pending).rejects.toThrow();
  await began;
  abort.abort();
  release();
  await rejected;
  expect(calls).toBe(0);
});
it('does not restore credentials from a refresh that finishes after sign-out', async () => {
  await signIn();
  expire();
  let started!: () => void, release!: () => void;
  const began = new Promise<void>((done) => {
    started = done;
  });
  const gate = new Promise<void>((done) => {
    release = done;
  });
  httpMock.use(
    http.post('https://auth.test/token', async () => {
      started();
      await gate;
      return HttpResponse.json(oauthTokens);
    }),
  );
  const pending = service.authenticatedFetch(oauthServer)(oauthServer.url!);
  const rejected = expect(pending).rejects.toThrow();
  await began;
  await service.logout('fixture');
  release();
  await rejected;
  expect(store.get(mcpCredentialKey(oauthServer)).tokens).toBeUndefined();
  expect(service.status('fixture').state).toBe('required');
});
it('cancels preparation without publishing stale state after a config change', async () => {
  let started!: () => void, release!: () => void;
  const began = new Promise<void>((done) => {
    started = done;
  });
  const gate = new Promise<void>((done) => {
    release = done;
  });
  httpMock.use(
    http.get('https://auth.test/.well-known/oauth-authorization-server', async () => {
      started();
      await gate;
      return HttpResponse.json(oauthMetadata);
    }),
  );
  const login = service.login('fixture');
  const rejected = expect(login).rejects.toThrow();
  await began;
  service.configure([]);
  release();
  await rejected;
  expect(service.status('fixture').state).toBe('none');
});
it('uses an explicit callback port for a pre-registered client', async () => {
  const first = await service.login('fixture');
  const port = Number(new URL(new URL(first.authorizationUrl).searchParams.get('redirect_uri')!).port);
  service.cancelLogin('fixture');
  service.configure([{ ...oauthServer, oauth: { clientId: 'fixed', callbackPort: port } }]);
  const second = await service.login('fixture');
  expect(new URL(second.authorizationUrl).searchParams.get('redirect_uri')).toBe(`http://127.0.0.1:${port}/callback`);
});
it('retains legacy origin discovery only when protected-resource metadata is absent', async () => {
  httpMock.use(
    http.get(
      'https://mcp.test/.well-known/oauth-protected-resource/mcp',
      () => new HttpResponse(null, { status: 404 }),
    ),
    http.get('https://mcp.test/.well-known/oauth-protected-resource', () => new HttpResponse(null, { status: 404 })),
    http.get('https://mcp.test/.well-known/oauth-authorization-server', () =>
      HttpResponse.json({ ...oauthMetadata, issuer: 'https://mcp.test' }),
    ),
  );
  const flow = await service.login('fixture');
  await service.completeLogin(flow.loginId, oauthCallback(flow, { iss: 'https://mcp.test' }));
  expect(service.status('fixture').state).toBe('authorized');
});

it('accepts a real loopback HTTP callback and closes the local listener', async () => {
  httpMock.use(http.get(/^http:\/\/127\.0\.0\.1:\d+\/callback/, () => passthrough()));
  const flow = await service.login('fixture');
  const callback = oauthCallback(flow);
  const response = await fetch(callback);
  expect(response.status).toBe(200);
  expect(await response.text()).toBe('Signed in to Kai. You can close this tab.');
  expect(service.status('fixture').state).toBe('authorized');
  await expect(fetch(callback)).rejects.toThrow();
});
