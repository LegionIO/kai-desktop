import { randomBytes, createHash } from 'node:crypto';
import type { Request, Response } from 'express';
import type { OAuthServerProvider, AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type {
  OAuthClientInformationFull,
  OAuthTokens,
  OAuthTokenRevocationRequest,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import {
  InvalidClientMetadataError,
  InvalidGrantError,
  InvalidRequestError,
  InvalidTokenError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { redirectUriMatches } from '@modelcontextprotocol/sdk/server/auth/handlers/authorize.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { hash } from '../plugin-bridge/files.js';
import type { SharingCredentials } from './credentials.js';

type PendingConsent = {
  client: OAuthClientInformationFull;
  params: AuthorizationParams;
  expiresAt: number;
  browser?: string;
  csrf: string;
  epoch: string;
};
type Code = {
  clientId: string;
  challenge: string;
  redirectUri: string;
  resource: string;
  expiresAt: number;
  epoch: string;
};
function nonce(): string {
  return randomBytes(32).toString('base64url');
}
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
export function safeMcpLoginReturn(value: unknown): string {
  return typeof value === 'string' && /^\/mcp\/consent\?request=[A-Za-z0-9_-]{43}$/.test(value) ? value : '/';
}
export function validateRedirect(uri: string): boolean {
  try {
    const url = new URL(uri);
    return (
      !url.username &&
      !url.password &&
      !url.hash &&
      (url.protocol === 'https:' ||
        (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))
    );
  } catch {
    return false;
  }
}

export class KaiOAuthProvider implements OAuthServerProvider {
  // Validate PKCE ourselves so code consumption and verifier validation happen
  // in one synchronous operation; an invalid exchange consumes the code too.
  readonly skipLocalPkceValidation = true;
  private readonly pending = new Map<string, PendingConsent>();
  private readonly codes = new Map<string, Code>();
  constructor(
    readonly credentials: SharingCredentials,
    private readonly browserSession: (req: Request) => string | undefined,
  ) {}
  get clientsStore() {
    return {
      getClient: (id: string) => this.credentials.getRegistration(id),
      registerClient: (client: Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'>) => {
        if (
          !client.redirect_uris.length ||
          client.redirect_uris.length > 10 ||
          client.redirect_uris.some((uri) => !validateRedirect(uri))
        )
          throw new InvalidClientMetadataError(
            'Redirects must use HTTPS or a loopback HTTP address, with no credentials or fragment.',
          );
        if (client.grant_types?.some((type) => !['authorization_code', 'refresh_token'].includes(type)))
          throw new InvalidClientMetadataError('Only authorization_code and refresh_token grants are supported.');
        if (
          client.token_endpoint_auth_method &&
          !['none', 'client_secret_basic', 'client_secret_post'].includes(client.token_endpoint_auth_method)
        )
          throw new InvalidClientMetadataError('Unsupported token endpoint authentication method.');
        if (client.client_name && client.client_name.length > 100)
          throw new InvalidClientMetadataError('Client name is too long.');
        return this.credentials.register(client);
      },
    };
  }
  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    this.prune();
    if (!this.credentials.remoteReady()) throw new InvalidRequestError('Remote sharing is disabled.');
    if (this.pending.size + this.codes.size >= 200)
      throw new InvalidRequestError('Too many pending authorization requests.');
    const resource = this.resource(params.resource);
    if (!/^[A-Za-z0-9_-]{43}$/.test(params.codeChallenge))
      throw new InvalidRequestError('A valid S256 PKCE challenge is required.');
    if (params.scopes?.some((scope) => scope !== 'kai:tools')) throw new InvalidRequestError('Unsupported MCP scope.');
    if (
      !validateRedirect(params.redirectUri) ||
      !client.redirect_uris.some((uri) => redirectUriMatches(params.redirectUri, uri))
    )
      throw new InvalidRequestError('Unregistered redirect URI.');
    const id = nonce();
    this.pending.set(id, {
      client,
      params: { ...params, resource: new URL(resource) },
      csrf: nonce(),
      expiresAt: Date.now() + 10 * 60_000,
      epoch: this.credentials.epoch(),
    });
    res.redirect(303, `/mcp/consent?request=${id}`);
  }
  consent(req: Request, res: Response): void {
    this.prune();
    const id = typeof req.query.request === 'string' ? req.query.request : '';
    const pending = this.pending.get(id);
    if (!pending || pending.epoch !== this.credentials.epoch() || !this.credentials.remoteReady()) {
      res.status(400).send('This connector request expired. Start connecting again.');
      return;
    }
    const browser = this.browserSession(req);
    if (!browser) {
      res.redirect(303, `/login?returnTo=${encodeURIComponent(`/mcp/consent?request=${id}`)}`);
      return;
    }
    if (pending.browser && pending.browser !== browser) {
      res.status(403).send('Open this request in the browser where you started sign-in.');
      return;
    }
    pending.browser = browser;
    const name = escapeHtml(pending.client.client_name ?? 'MCP client');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader(
      'Content-Security-Policy',
      `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' ${new URL(pending.params.redirectUri).origin}; frame-ancestors 'none'; base-uri 'none'`,
    );
    // Chromium can send Origin:null for a form under no-referrer. Preserve the
    // same-origin POST's Origin while withholding the consent URL on the
    // registered client's redirect. The POST still requires session + CSRF.
    res.setHeader('Referrer-Policy', 'same-origin');
    res
      .type('html')
      .send(
        `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect to Kai</title><style>body{font:16px system-ui;margin:10vh auto;padding:24px;max-width:560px;color:#18202b;background:#f7f8fa}h1{font-size:24px}p{line-height:1.6}button{font:inherit;padding:10px 18px;margin-right:10px;border:1px solid #bcc4ce;border-radius:8px;cursor:pointer}button[value=allow]{background:#18202b;color:white}small{overflow-wrap:anywhere}</style><h1>Allow ${name} to use Kai?</h1><p>This client can use the tools selected in Share Kai with your existing signed-in accounts. It cannot change Kai settings or export additional tools.</p><p>You can revoke this client in Settings → Plugin Bridge.</p><p><small>Return address: ${escapeHtml(pending.params.redirectUri)}</small></p><form method="post" action="/mcp/consent?request=${id}"><input type="hidden" name="csrf" value="${pending.csrf}"><button name="decision" value="allow">Allow connection</button><button name="decision" value="deny">Cancel</button></form></html>`,
      );
  }
  completeConsent(req: Request, res: Response): void {
    const id = typeof req.query.request === 'string' ? req.query.request : '';
    const pending = this.pending.get(id);
    const browser = this.browserSession(req);
    if (
      !pending ||
      pending.expiresAt <= Date.now() ||
      pending.epoch !== this.credentials.epoch() ||
      !browser ||
      pending.browser !== browser ||
      req.body?.csrf !== pending.csrf ||
      !this.credentials.remoteReady()
    ) {
      res.status(403).send('Consent is missing or expired. Start connecting again.');
      return;
    }
    const origin = req.get('Origin');
    if (origin && origin !== new URL(this.credentials.publicUrl()).origin) {
      res.status(403).send('Invalid consent origin.');
      return;
    }
    this.pending.delete(id);
    const redirect = new URL(pending.params.redirectUri);
    if (pending.params.state) redirect.searchParams.set('state', pending.params.state);
    if (req.body.decision !== 'allow') redirect.searchParams.set('error', 'access_denied');
    else {
      const code = nonce();
      this.codes.set(hash(code), {
        clientId: pending.client.client_id,
        challenge: pending.params.codeChallenge,
        redirectUri: pending.params.redirectUri,
        resource: this.resource(pending.params.resource),
        expiresAt: Date.now() + 60_000,
        epoch: pending.epoch,
      });
      this.credentials.createClient(
        pending.client.client_name ?? 'OAuth client',
        'oauth',
        null,
        pending.client.client_id,
      );
      redirect.searchParams.set('code', code);
    }
    res.setHeader('Cache-Control', 'no-store');
    res.redirect(303, redirect.href);
  }
  async challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string): Promise<string> {
    const value = this.codes.get(hash(code));
    if (!value || value.clientId !== client.client_id || value.expiresAt <= Date.now())
      throw new InvalidGrantError('Invalid authorization code.');
    return value.challenge;
  }
  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    code: string,
    verifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    const value = this.codes.get(hash(code));
    this.codes.delete(hash(code));
    if (
      !value ||
      value.clientId !== client.client_id ||
      value.expiresAt <= Date.now() ||
      value.epoch !== this.credentials.epoch() ||
      !verifier ||
      !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) ||
      createHash('sha256').update(verifier).digest('base64url') !== value.challenge ||
      redirectUri !== value.redirectUri ||
      this.resource(resource) !== value.resource ||
      !this.credentials.remoteReady()
    )
      throw new InvalidGrantError('Invalid authorization code, redirect, resource or PKCE verifier.');
    return this.tokens(client.client_id, value.resource);
  }
  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    if (scopes?.some((scope) => scope !== 'kai:tools'))
      throw new InvalidGrantError('Scope expansion is not permitted.');
    const audience = this.resource(resource);
    try {
      this.credentials.consumeRefresh(refreshToken, client.client_id, audience);
    } catch {
      throw new InvalidGrantError('Invalid refresh token.');
    }
    return this.tokens(client.client_id, audience);
  }
  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const principal = this.credentials.verify(token, 'remote');
    if (!principal) throw new InvalidTokenError('Invalid or expired Kai MCP token.');
    return {
      token,
      clientId: principal.clientId,
      scopes: ['kai:tools'],
      expiresAt: Math.floor(principal.expiresAt / 1000),
      resource: new URL(this.credentials.publicUrl()),
    };
  }
  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    this.credentials.revokeToken(client.client_id, request.token);
    this.clearClient(client.client_id);
  }
  clearClient(id: string): void {
    for (const [key, value] of this.pending) if (value.client.client_id === id) this.pending.delete(key);
    for (const [key, value] of this.codes) if (value.clientId === id) this.codes.delete(key);
  }
  clear(): void {
    this.pending.clear();
    this.codes.clear();
  }
  private tokens(clientId: string, resource: string): OAuthTokens {
    return {
      token_type: 'Bearer',
      access_token: this.credentials.issue(clientId, 'access', Date.now() + 3_600_000, resource),
      expires_in: 3600,
      refresh_token: this.credentials.issue(clientId, 'refresh', Date.now() + 30 * 86_400_000, resource),
      scope: 'kai:tools',
    };
  }
  private resource(resource?: URL): string {
    const expected = this.credentials.publicUrl();
    if (resource && resource.href !== expected) throw new InvalidRequestError('Wrong MCP resource.');
    return expected;
  }
  private prune(): void {
    for (const [key, value] of this.pending) if (value.expiresAt <= Date.now()) this.pending.delete(key);
    for (const [key, value] of this.codes) if (value.expiresAt <= Date.now()) this.codes.delete(key);
  }
}
