import { createCipheriv, createDecipheriv } from 'node:crypto';
import { http, HttpResponse } from 'msw';
import type { McpEncryption } from '../electron/mcp/credential-store.js';
import type { McpLogin, McpServerConfig } from '../shared/mcp.js';

export const oauthServer: McpServerConfig = { name: 'fixture', url: 'https://mcp.test/mcp', enabled: true };
export const oauthMetadata = {
  issuer: 'https://auth.test',
  authorization_endpoint: 'https://auth.test/authorize',
  token_endpoint: 'https://auth.test/token',
  registration_endpoint: 'https://auth.test/register',
  response_types_supported: ['code'],
  grant_types_supported: ['authorization_code', 'refresh_token'],
  code_challenge_methods_supported: ['S256'],
  token_endpoint_auth_methods_supported: ['none', 'client_secret_basic'],
  client_id_metadata_document_supported: true,
  authorization_response_iss_parameter_supported: true,
  revocation_endpoint: 'https://auth.test/revoke',
  scopes_supported: ['read', 'write', 'offline_access'],
};
export const oauthTokens = {
  access_token: 'access-fixture-secret',
  refresh_token: 'refresh-fixture-secret',
  token_type: 'Bearer',
  expires_in: 100,
  scope: 'read',
};
export function oauthHandlers(metadata: Record<string, unknown> = oauthMetadata, clientId = 'dcr-client') {
  return [
    http.get('https://mcp.test/.well-known/oauth-protected-resource/mcp', () =>
      HttpResponse.json({
        resource: oauthServer.url,
        authorization_servers: ['https://auth.test'],
        scopes_supported: ['read'],
      }),
    ),
    http.get('https://auth.test/.well-known/oauth-authorization-server', () => HttpResponse.json(metadata)),
    http.post('https://auth.test/register', async ({ request }) =>
      HttpResponse.json({ ...((await request.json()) as object), client_id: clientId }),
    ),
    http.post('https://auth.test/token', () => HttpResponse.json(oauthTokens)),
    http.post('https://auth.test/revoke', () => new HttpResponse(null, { status: 200 })),
    http.all('https://mcp.test/mcp', () => new HttpResponse('ok')),
  ];
}

export function oauthDeferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
export function oauthCallback(flow: McpLogin, values: Record<string, string | null> = {}) {
  const auth = new URL(flow.authorizationUrl);
  const callback = new URL(auth.searchParams.get('redirect_uri')!);
  for (const [key, value] of Object.entries({
    state: auth.searchParams.get('state'),
    code: 'fixture-code',
    iss: oauthMetadata.issuer,
    ...values,
  })) {
    if (value !== null) callback.searchParams.set(key, value);
  }
  return callback.href;
}

/** Actual authenticated encryption with a fixed test key; never used by the app. */
export function fixtureEncryption(): McpEncryption {
  const key = Buffer.alloc(32, 42),
    iv = Buffer.alloc(12, 7);
  return {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'test-keychain',
    encryptString: (value) => {
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return Buffer.concat([cipher.getAuthTag(), encrypted]);
    },
    decryptString: (value) => {
      const decipher = createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(value.subarray(0, 16));
      return Buffer.concat([decipher.update(value.subarray(16)), decipher.final()]).toString('utf8');
    },
  };
}
