import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import {
  discoverOAuthProtectedResourceMetadata,
  discoverAuthorizationServerMetadata,
  extractWWWAuthenticateParams,
  startAuthorization,
  exchangeAuthorization,
  refreshAuthorization,
  registerClient,
  type OAuthServerInfo,
} from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientInformationMixed, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { McpAuthReason, McpAuthStatus, McpLogin, McpLogout, McpServerConfig } from '../../shared/mcp.js';
import type { McpCredentialStore, McpCredentials } from './credential-store.js';

const LOGIN_TIMEOUT_MS = 5 * 60_000;
const AUTH_TIMEOUT_MS = 15_000;
type Challenge = ReturnType<typeof extractWWWAuthenticateParams>;
type ExtendedMetadata = NonNullable<OAuthServerInfo['authorizationServerMetadata']> & {
  revocation_endpoint?: string;
  revocation_endpoint_auth_methods_supported?: string[];
  authorization_response_iss_parameter_supported?: boolean;
};
type Attempt = McpLogin & {
  name: string;
  key: string;
  epoch: number;
  state: string;
  verifier: string;
  redirect: string;
  info: OAuthServerInfo;
  client: OAuthClientInformationMixed;
  resource: URL;
  server: Server;
  timer: NodeJS.Timeout;
  completing: boolean;
  abort: AbortController;
};

export class McpOAuthError extends Error {
  constructor(
    message: string,
    readonly reason?: McpAuthReason,
  ) {
    super(message);
    this.name = 'McpOAuthError';
  }
}
export function mcpCredentialKey(server: McpServerConfig): string {
  return createHash('sha256')
    .update(JSON.stringify([server.name, server.url, server.oauth ?? {}]))
    .digest('hex');
}
function secureUrl(value: string | URL): URL {
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.hash ||
    (url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
  ) {
    throw new McpOAuthError('OAuth endpoints must use HTTPS (HTTP is allowed only on loopback).');
  }
  return url;
}
function sameState(expected: string, actual: string | null): boolean {
  return (
    actual !== null &&
    Buffer.byteLength(actual) === Buffer.byteLength(expected) &&
    timingSafeEqual(Buffer.from(expected), Buffer.from(actual))
  );
}
function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'errorCode' in error ? String(error.errorCode) : undefined;
}

/** One backend-owned service shared by desktop, CLI, web and every agent runtime. */
export class McpOAuthService {
  private servers = new Map<string, McpServerConfig>();
  private states = new Map<string, Partial<McpAuthStatus>>();
  private challenges = new Map<string, Challenge>();
  private attempts = new Map<string, Attempt>();
  private starting = new Map<string, Promise<McpLogin>>();
  private preparing = new Map<string, AbortController>();
  private refreshing = new Map<string, { epoch: number; promise: Promise<OAuthTokens> }>();
  private epochs = new Map<string, number>();
  private readonly fetchFn: FetchLike;

  constructor(
    readonly store: McpCredentialStore,
    private readonly options: {
      fetch?: FetchLike;
      metadataUrl?: string;
      onChanged?: () => void;
      onAuthorized?: (name: string) => Promise<void>;
    } = {},
  ) {
    this.fetchFn = options.fetch ?? globalThis.fetch;
  }

  configure(servers: McpServerConfig[]): void {
    const next = new Map(servers.filter((s) => s.url && !s.command).map((s) => [s.name, structuredClone(s)]));
    for (const [name, previous] of this.servers) {
      const current = next.get(name);
      if (!current || mcpCredentialKey(previous) !== mcpCredentialKey(current) || current.enabled === false) {
        if (!current || mcpCredentialKey(previous) !== mcpCredentialKey(current))
          this.store.invalidate(mcpCredentialKey(previous));
        this.cancelLogin(name);
        this.epochs.set(name, (this.epochs.get(name) ?? 0) + 1);
        this.states.delete(name);
        this.challenges.delete(name);
      }
    }
    this.servers = next;
    this.store.prune(new Set([...next.values()].map(mcpCredentialKey)));
  }

  status(name: string): McpAuthStatus {
    const cfg = this.servers.get(name);
    const record = cfg ? this.store.get(mcpCredentialKey(cfg)) : {};
    return {
      name,
      state: record.tokens ? 'authorized' : 'none',
      storage: this.store.storage,
      hasClientSecret: Boolean(record.clientSecret),
      hasCredentials: Boolean(record.tokens),
      ...this.states.get(name),
    };
  }
  private change(name: string, state: Partial<McpAuthStatus>): void {
    this.states.set(name, state);
    this.options.onChanged?.();
  }
  private server(name: string, requireEnabled = true): McpServerConfig & { url: string } {
    const server = this.servers.get(name);
    if (!server?.url || (requireEnabled && server.enabled === false))
      throw new McpOAuthError('Save and enable this URL server before signing in.');
    secureUrl(server.url);
    return server as McpServerConfig & { url: string };
  }
  private assertCurrent(name: string, key: string, epoch: number): void {
    const cfg = this.servers.get(name);
    if (!cfg || cfg.enabled === false || mcpCredentialKey(cfg) !== key || (this.epochs.get(name) ?? 0) !== epoch) {
      throw new McpOAuthError('The MCP configuration or login changed. Start again.');
    }
  }
  private requireLogin(name: string, reason: McpAuthReason): McpOAuthError {
    const message =
      reason === 'insufficient-scope'
        ? 'Additional permissions required. Reconnect this MCP server.'
        : reason === 'invalid-client'
          ? 'OAuth client registration was rejected. Check the client settings and reconnect.'
          : reason === 'expired'
            ? 'Sign in again to reconnect this MCP server.'
            : 'Sign in to use this MCP server.';
    this.change(name, { state: 'required', reason, message });
    return new McpOAuthError(message, reason);
  }
  private authFetch(signal?: AbortSignal): FetchLike {
    return async (input, init) => {
      secureUrl(input);
      return this.fetchFn(input, {
        ...init,
        redirect: 'error',
        signal: AbortSignal.any([
          AbortSignal.timeout(AUTH_TIMEOUT_MS),
          ...(signal ? [signal] : []),
          ...(init?.signal ? [init.signal] : []),
        ]),
      });
    };
  }

  private async discover(cfg: McpServerConfig & { url: string }, signal?: AbortSignal): Promise<OAuthServerInfo> {
    const challenge = this.challenges.get(cfg.name);
    const fetchFn = this.authFetch(signal);
    let resourceMetadata;
    try {
      resourceMetadata = await discoverOAuthProtectedResourceMetadata(
        cfg.url,
        {
          resourceMetadataUrl: challenge?.resourceMetadataUrl,
        },
        fetchFn,
      );
    } catch (error) {
      // Only legacy servers with no PRM may fall back to origin discovery. A bad
      // advertised document or an outage must not silently select another issuer.
      if (
        challenge?.resourceMetadataUrl ||
        !(error instanceof Error) ||
        !error.message.includes('does not implement OAuth 2.0 Protected Resource Metadata')
      ) {
        throw new McpOAuthError('Could not discover MCP authorization metadata. Check the server and try again.');
      }
    }
    const issuer = resourceMetadata?.authorization_servers?.[0] ?? new URL('/', cfg.url).href.replace(/\/$/, '');
    secureUrl(issuer);
    let issuerResponseSupport: boolean | undefined;
    let revocationEndpoint: string | undefined;
    let revocationMethods: string[] | undefined;
    const metadata = (await discoverAuthorizationServerMetadata(issuer, {
      fetchFn: async (url, init) => {
        const response = await fetchFn(url, init);
        if (response.ok) {
          const document = await response
            .clone()
            .json()
            .catch(() => null);
          if (document?.issuer === issuer) {
            issuerResponseSupport = document.authorization_response_iss_parameter_supported === true;
            if (
              Array.isArray(document.revocation_endpoint_auth_methods_supported) &&
              document.revocation_endpoint_auth_methods_supported.every((method: unknown) => typeof method === 'string')
            )
              revocationMethods = document.revocation_endpoint_auth_methods_supported;
            revocationEndpoint =
              typeof document.revocation_endpoint === 'string' ? document.revocation_endpoint : undefined;
          }
        }
        return response;
      },
    })) as ExtendedMetadata | undefined;
    if (!metadata || metadata.issuer !== issuer)
      throw new McpOAuthError('Authorization server metadata has an invalid issuer.');
    if (!metadata.code_challenge_methods_supported?.includes('S256'))
      throw new McpOAuthError('The authorization server must support PKCE S256.');
    metadata.revocation_endpoint = revocationEndpoint;
    for (const url of [
      metadata.authorization_endpoint,
      metadata.token_endpoint,
      metadata.registration_endpoint,
      metadata.revocation_endpoint,
    ]) {
      if (url) secureUrl(url);
    }
    if (!metadata.token_endpoint) throw new McpOAuthError('The authorization server has no token endpoint.');
    metadata.authorization_response_iss_parameter_supported = issuerResponseSupport;
    metadata.revocation_endpoint = revocationEndpoint;
    metadata.revocation_endpoint_auth_methods_supported = revocationMethods;
    return { authorizationServerUrl: issuer, authorizationServerMetadata: metadata, resourceMetadata };
  }
  private resource(cfg: McpServerConfig & { url: string }, info: OAuthServerInfo): URL {
    const requested = new URL(cfg.url);
    const resource = new URL(info.resourceMetadata?.resource ?? cfg.url);
    if (
      resource.origin !== requested.origin ||
      resource.hash ||
      resource.username ||
      resource.password ||
      !(
        requested.pathname === resource.pathname ||
        requested.pathname.startsWith(resource.pathname.replace(/\/$/, '') + '/')
      )
    ) {
      throw new McpOAuthError('The advertised OAuth resource does not match this MCP server.');
    }
    return resource;
  }

  login(name: string): Promise<McpLogin> {
    const current = [...this.attempts.values()].find((a) => a.name === name);
    if (current)
      return Promise.resolve({
        loginId: current.loginId,
        authorizationUrl: current.authorizationUrl,
        expiresAt: current.expiresAt,
      });
    const starting = this.starting.get(name);
    if (starting) return starting;
    const promise = this.startLogin(name).finally(() => {
      if (this.starting.get(name) === promise) this.starting.delete(name);
    });
    this.starting.set(name, promise);
    return promise;
  }
  authorizationUrl(loginId: string): string {
    const attempt = this.attempts.get(loginId);
    if (!attempt || Date.now() >= attempt.expiresAt) throw new McpOAuthError('This login has expired.');
    return attempt.authorizationUrl;
  }
  private async startLogin(name: string): Promise<McpLogin> {
    const cfg = this.server(name);
    const key = mcpCredentialKey(cfg),
      epoch = (this.epochs.get(name) ?? 0) + 1;
    // Explicit login supersedes requests and refreshes from the previous session.
    this.epochs.set(name, epoch);
    const abort = new AbortController();
    this.preparing.set(name, abort);
    let listener: Server | undefined;
    this.change(name, { state: 'authenticating', message: 'Preparing sign-in…' });
    try {
      const info = await this.discover(cfg, abort.signal);
      const resource = this.resource(cfg, info);
      this.assertCurrent(name, key, epoch);
      let old = this.store.get(key);
      if (old.discovery && old.discovery.authorizationServerUrl !== info.authorizationServerUrl) {
        // A changed issuer must never inherit tokens, registration, or a client
        // secret. Keep this invalidation durable even during a keychain outage.
        this.store.invalidate(key);
        old = {};
      }
      const metadata = info.authorizationServerMetadata! as ExtendedMetadata;
      // Registration is issuer-specific, even when the MCP URL is unchanged.
      let client = old.discovery?.authorizationServerUrl === info.authorizationServerUrl ? old.client : undefined;
      const host = cfg.oauth?.callbackHost ?? '127.0.0.1';
      const loginId = randomBytes(24).toString('hex');
      listener = createServer((request, response) => {
        const attempt = this.attempts.get(loginId);
        response.setHeader('Content-Type', 'text/plain; charset=utf-8');
        response.setHeader('Cache-Control', 'no-store');
        response.setHeader('Referrer-Policy', 'no-referrer');
        if (!attempt || request.method !== 'GET' || request.headers.host !== new URL(attempt.redirect).host) {
          response.writeHead(400).end('Invalid OAuth callback.');
          return;
        }
        let callback: URL;
        try {
          callback = new URL(request.url ?? '/', attempt.redirect);
        } catch {
          response.writeHead(400).end('Invalid callback.');
          return;
        }
        void this.completeLogin(loginId, callback.href).then(
          () => {
            response.end('Signed in to Kai. You can close this tab.');
          },
          () => {
            response.writeHead(400).end('Sign-in could not complete. Return to Kai and try again.');
          },
        );
      });
      await new Promise<void>((resolve, reject) => {
        listener!.once('error', reject);
        const priorPort =
          old.redirectUri && client && 'redirect_uris' in client && !cfg.oauth?.clientId
            ? Number(new URL(old.redirectUri).port)
            : 0;
        listener!.listen(cfg.oauth?.callbackPort ?? priorPort, host === 'localhost' ? 'localhost' : '127.0.0.1', () =>
          resolve(),
        );
      });
      const address = listener.address();
      if (!address || typeof address === 'string') throw new McpOAuthError('Could not open the local OAuth callback.');
      const redirect = `http://${host}:${address.port}/callback`;
      const requestedScopes = cfg.oauth?.scopes ?? info.resourceMetadata?.scopes_supported ?? [];
      const scopes = new Set([
        ...requestedScopes,
        ...(this.challenges.get(name)?.scope?.split(/\s+/) ?? []),
        ...(old.tokens?.scope?.split(/\s+/) ?? []),
      ]);
      if (metadata.scopes_supported?.includes('offline_access')) scopes.add('offline_access');
      const scope = [...scopes].filter(Boolean).join(' ') || undefined;
      if (cfg.oauth?.clientId) {
        client = { client_id: cfg.oauth.clientId, ...(old.clientSecret ? { client_secret: old.clientSecret } : {}) };
      } else if (!client) {
        const metadataUrl = cfg.oauth?.clientMetadataUrl ?? this.options.metadataUrl ?? __BRAND_MCP_CLIENT_METADATA_URL;
        if (metadata.client_id_metadata_document_supported && metadataUrl) {
          const url = secureUrl(metadataUrl);
          if (url.protocol !== 'https:' || url.pathname === '/')
            throw new McpOAuthError('Client metadata must have an HTTPS document URL.');
          client = { client_id: url.href };
        } else if (metadata.registration_endpoint) {
          client = await registerClient(info.authorizationServerUrl, {
            metadata,
            scope,
            fetchFn: this.authFetch(abort.signal),
            clientMetadata: {
              client_name: __BRAND_PRODUCT_NAME,
              application_type: 'native',
              redirect_uris: [redirect],
              grant_types: ['authorization_code', 'refresh_token'],
              response_types: ['code'],
              token_endpoint_auth_method: 'none',
            } as Parameters<typeof registerClient>[1]['clientMetadata'],
          });
        } else
          throw new McpOAuthError(
            'This server requires a pre-registered OAuth client ID. Add it in MCP settings.',
            'invalid-client',
          );
      }
      const state = randomBytes(32).toString('base64url');
      const started = await startAuthorization(info.authorizationServerUrl, {
        metadata,
        clientInformation: client,
        redirectUrl: redirect,
        scope,
        state,
        resource,
      });
      if (this.challenges.get(name)?.error === 'insufficient_scope')
        started.authorizationUrl.searchParams.set('prompt', 'consent');
      this.assertCurrent(name, key, epoch);
      const expiresAt = Date.now() + LOGIN_TIMEOUT_MS;
      const timer = setTimeout(() => this.cancelLogin(name), LOGIN_TIMEOUT_MS);
      timer.unref();
      this.attempts.set(loginId, {
        loginId,
        name,
        key,
        epoch,
        state,
        verifier: started.codeVerifier,
        redirect,
        info,
        client,
        resource,
        server: listener,
        timer,
        abort,
        completing: false,
        authorizationUrl: started.authorizationUrl.href,
        expiresAt,
      });
      this.store.set(key, {
        ...old,
        client,
        discovery: info,
        redirectUri: redirect,
        ...(old.discovery?.authorizationServerUrl !== info.authorizationServerUrl
          ? { tokens: undefined, expiresAt: undefined }
          : {}),
      });
      this.change(name, { state: 'authenticating', message: 'Complete sign-in in your browser.' });
      return { loginId, authorizationUrl: started.authorizationUrl.href, expiresAt };
    } catch (error) {
      listener?.close();
      abort.abort();
      const safe =
        error instanceof McpOAuthError
          ? error
          : new McpOAuthError('Could not start OAuth sign-in. Check the server, callback port, and client settings.');
      if ((this.epochs.get(name) ?? 0) === epoch)
        this.change(name, { state: 'required', reason: safe.reason ?? 'sign-in', message: safe.message });
      throw safe;
    } finally {
      if (this.preparing.get(name) === abort) this.preparing.delete(name);
    }
  }

  async completeLogin(loginId: string, callbackUrl: string): Promise<void> {
    const attempt = this.attempts.get(loginId);
    if (!attempt || attempt.completing || Date.now() >= attempt.expiresAt)
      throw new McpOAuthError('This login has expired or was already completed.');
    const callback = new URL(callbackUrl);
    const expected = new URL(attempt.redirect);
    if (
      callback.origin !== expected.origin ||
      callback.pathname !== expected.pathname ||
      callback.hash ||
      callback.username ||
      callback.password ||
      ['state', 'code', 'iss', 'error'].some((key) => callback.searchParams.getAll(key).length > 1) ||
      !sameState(attempt.state, callback.searchParams.get('state'))
    )
      throw new McpOAuthError('Invalid OAuth callback or state.');
    const metadata = attempt.info.authorizationServerMetadata! as ExtendedMetadata;
    const issuer = callback.searchParams.get('iss');
    if (
      (issuer !== null && issuer !== metadata.issuer) ||
      (metadata.authorization_response_iss_parameter_supported === true && issuer === null)
    ) {
      throw new McpOAuthError('The OAuth callback issuer does not match the authorization server.');
    }
    if (callback.searchParams.has('error')) {
      this.cancelLogin(attempt.name);
      throw new McpOAuthError('Authorization was declined. You can sign in again.');
    }
    const code = callback.searchParams.get('code');
    if (!code) throw new McpOAuthError('The OAuth callback has no authorization code.');
    this.assertCurrent(attempt.name, attempt.key, attempt.epoch);
    attempt.completing = true;
    try {
      const tokens = await exchangeAuthorization(attempt.info.authorizationServerUrl, {
        metadata,
        clientInformation: attempt.client,
        authorizationCode: code,
        codeVerifier: attempt.verifier,
        redirectUri: attempt.redirect,
        resource: attempt.resource,
        fetchFn: this.authFetch(attempt.abort.signal),
      });
      this.assertCurrent(attempt.name, attempt.key, attempt.epoch);
      this.saveTokens(attempt.key, tokens);
      this.finishAttempt(attempt);
      this.change(attempt.name, { state: 'authorized' });
      await this.options.onAuthorized?.(attempt.name);
    } catch (error) {
      this.finishAttempt(attempt);
      if ((this.epochs.get(attempt.name) ?? 0) === attempt.epoch && this.status(attempt.name).state !== 'authorized')
        this.requireLogin(attempt.name, 'sign-in');
      throw error instanceof McpOAuthError
        ? error
        : new McpOAuthError('Could not finish sign-in or reconnect. Try reconnecting the server.');
    }
  }
  private finishAttempt(attempt: Attempt): void {
    clearTimeout(attempt.timer);
    this.attempts.delete(attempt.loginId);
    attempt.server.close();
  }
  cancelLogin(name: string): void {
    this.epochs.set(name, (this.epochs.get(name) ?? 0) + 1);
    this.preparing.get(name)?.abort();
    this.preparing.delete(name);
    this.starting.delete(name);
    for (const attempt of this.attempts.values())
      if (attempt.name === name) {
        attempt.abort.abort();
        this.finishAttempt(attempt);
      }
    if (this.states.get(name)?.state === 'authenticating') this.requireLogin(name, 'sign-in');
  }
  dispose(): void {
    for (const name of this.servers.keys()) this.cancelLogin(name);
  }
  private saveTokens(key: string, tokens: OAuthTokens): void {
    if (tokens.token_type.toLowerCase() !== 'bearer')
      throw new McpOAuthError('The server returned an unsupported OAuth token type.');
    const issuedAt = Date.now();
    this.store.set(key, {
      ...this.store.get(key),
      tokens,
      issuedAt,
      expiresAt: tokens.expires_in === undefined ? undefined : issuedAt + Math.max(0, tokens.expires_in) * 1000,
    });
  }

  private refresh(name: string, rejectedToken?: string): Promise<OAuthTokens> {
    const cfg = this.server(name),
      key = mcpCredentialKey(cfg),
      epoch = this.epochs.get(name) ?? 0;
    const pending = this.refreshing.get(key);
    if (pending?.epoch === epoch) return pending.promise;
    const old = this.store.get(key);
    if (rejectedToken && old.tokens && old.tokens.access_token !== rejectedToken) return Promise.resolve(old.tokens);
    if (!old.tokens?.refresh_token || !old.client || !old.discovery)
      return Promise.reject(this.requireLogin(name, 'expired'));
    const run = (async () => {
      try {
        const tokens = await refreshAuthorization(old.discovery!.authorizationServerUrl, {
          metadata: old.discovery!.authorizationServerMetadata,
          clientInformation: old.client!,
          refreshToken: old.tokens!.refresh_token!,
          resource: this.resource(cfg, old.discovery!),
          fetchFn: this.authFetch(),
        });
        this.assertCurrent(name, key, epoch);
        this.saveTokens(key, tokens);
        this.change(name, { state: 'authorized' });
        return tokens;
      } catch (error) {
        this.assertCurrent(name, key, epoch);
        const code = errorCode(error);
        if (['invalid_grant', 'invalid_client', 'unauthorized_client'].includes(code ?? '')) {
          const current = this.store.get(key);
          this.store.invalidate(key);
          this.store.set(key, {
            ...current,
            tokens: undefined,
            expiresAt: undefined,
            ...(code !== 'invalid_grant' && !cfg.oauth?.clientId ? { client: undefined, discovery: undefined } : {}),
          });
          throw this.requireLogin(name, code === 'invalid_grant' ? 'expired' : 'invalid-client');
        }
        throw error instanceof McpOAuthError
          ? error
          : new McpOAuthError('OAuth refresh is temporarily unavailable. Try again; your credentials were kept.');
      }
    })().finally(() => {
      if (this.refreshing.get(key)?.promise === run) this.refreshing.delete(key);
    });
    this.refreshing.set(key, { epoch, promise: run });
    return run;
  }

  /** Only a definite 401 is replayed, once. Streams/timeouts are never replayed. */
  authenticatedFetch(server: McpServerConfig): FetchLike {
    const configured = this.servers.get(server.name);
    const saved = configured && mcpCredentialKey(configured) === mcpCredentialKey(server);
    return async (input, init) => {
      init?.signal?.throwIfAborted();
      const epoch = this.epochs.get(server.name) ?? 0;
      const target = new URL(input);
      if (!server.url || target.origin !== new URL(server.url).origin)
        throw new McpOAuthError('Refusing to send MCP credentials to another origin.');
      let token: string | undefined;
      if (saved) {
        this.assertCurrent(server.name, mcpCredentialKey(server), epoch);
        const status = this.status(server.name);
        if (status.state === 'authenticating')
          throw new McpOAuthError('Complete sign-in before using this MCP server.');
        if (status.state === 'required') throw this.requireLogin(server.name, status.reason ?? 'sign-in');
        const record = this.store.get(mcpCredentialKey(server));
        token = record.tokens?.access_token;
        const leeway = Math.min(60_000, Math.max(0, (record.expiresAt ?? 0) - (record.issuedAt ?? 0)) / 10);
        if (token && record.expiresAt !== undefined && Date.now() >= record.expiresAt - leeway)
          token = (await this.refresh(server.name)).access_token;
      }
      const send = (accessToken?: string) => {
        init?.signal?.throwIfAborted();
        if (saved) this.assertCurrent(server.name, mcpCredentialKey(server), epoch);
        const headers = new Headers(init?.headers);
        if (accessToken) {
          secureUrl(target);
          headers.set('Authorization', `Bearer ${accessToken}`);
        }
        return this.fetchFn(input, { ...init, headers, redirect: 'error' });
      };
      let response = await send(token);
      if (saved) this.assertCurrent(server.name, mcpCredentialKey(server), epoch);
      if (response.status === 401 || response.status === 403) {
        const challenge = extractWWWAuthenticateParams(response);
        if (saved) this.challenges.set(server.name, challenge);
        if (response.status === 403 && challenge.error !== 'insufficient_scope') return response;
        if (challenge.error === 'insufficient_scope') {
          await response.body?.cancel();
          if (!saved)
            throw new McpOAuthError('Authentication required. Save this MCP server, then select Sign in.', 'sign-in');
          throw this.requireLogin(server.name, 'insufficient-scope');
        }
        if (response.status === 401 && token && saved) {
          await response.body?.cancel();
          const refreshed = await this.refresh(server.name, token);
          init?.signal?.throwIfAborted();
          response = await send(refreshed.access_token);
          this.assertCurrent(server.name, mcpCredentialKey(server), epoch);
          if (response.status !== 401 && response.status !== 403) return response;
          const nextChallenge = extractWWWAuthenticateParams(response);
          this.challenges.set(server.name, nextChallenge);
          if (response.status === 403 && nextChallenge.error !== 'insufficient_scope') return response;
        }
        await response.body?.cancel();
        if (!saved)
          throw new McpOAuthError('Authentication required. Save this MCP server, then select Sign in.', 'sign-in');
        throw this.requireLogin(
          server.name,
          this.challenges.get(server.name)?.error === 'insufficient_scope'
            ? 'insufficient-scope'
            : token
              ? 'expired'
              : 'sign-in',
        );
      }
      return response;
    };
  }

  setClientSecret(name: string, secret: string | null): void {
    const cfg = this.server(name);
    if (!cfg.oauth?.clientId) throw new McpOAuthError('Configure a client ID before setting a client secret.');
    this.cancelLogin(name);
    const key = mcpCredentialKey(cfg);
    this.store.invalidate(key);
    this.store.set(key, { clientSecret: secret || undefined });
    this.requireLogin(name, 'sign-in');
  }
  async logout(name: string): Promise<McpLogout> {
    const cfg = this.server(name, false),
      key = mcpCredentialKey(cfg),
      record: McpCredentials = this.store.get(key);
    this.cancelLogin(name);
    this.store.invalidate(key);
    this.store.set(key, { ...record, tokens: undefined, expiresAt: undefined });
    this.requireLogin(name, 'sign-in');
    const endpoint = (record.discovery?.authorizationServerMetadata as ExtendedMetadata | undefined)
      ?.revocation_endpoint;
    if (!endpoint || !record.tokens || !record.client) return { localCleared: true, revocation: 'unsupported' };
    try {
      const params = new URLSearchParams({
        token: record.tokens.refresh_token ?? record.tokens.access_token,
        token_type_hint: record.tokens.refresh_token ? 'refresh_token' : 'access_token',
        client_id: record.client.client_id,
      });
      const headers = new Headers({ 'Content-Type': 'application/x-www-form-urlencoded' });
      if (record.client.client_secret) {
        const methods = (record.discovery?.authorizationServerMetadata as ExtendedMetadata)
          ?.revocation_endpoint_auth_methods_supported ?? ['client_secret_basic'];
        if (methods.includes('client_secret_basic')) {
          const encode = (value: string) => new URLSearchParams({ v: value }).toString().slice(2);
          headers.set(
            'Authorization',
            `Basic ${Buffer.from(`${encode(record.client.client_id)}:${encode(record.client.client_secret)}`).toString('base64')}`,
          );
          params.delete('client_id');
        } else if (methods.includes('client_secret_post')) params.set('client_secret', record.client.client_secret);
        else return { localCleared: true, revocation: 'failed' };
      }
      const response = await this.authFetch()(endpoint, { method: 'POST', body: params, headers });
      await response.body?.cancel();
      return { localCleared: true, revocation: response.ok ? 'confirmed' : 'failed' };
    } catch {
      return { localCleared: true, revocation: 'failed' };
    }
  }
}
