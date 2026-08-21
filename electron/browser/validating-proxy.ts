import { randomBytes, timingSafeEqual } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import {
  Agent as HttpAgent,
  createServer,
  request as requestHttp,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { Agent as HttpsAgent, request as requestHttps } from 'node:https';
import { connect, isIP, type Socket } from 'node:net';
import { connect as connectTls } from 'node:tls';
import type { AuthInfo, Session } from 'electron';
import { isPrivateResolvedAddress } from './session.js';

type ResolvedEndpoint = { address: string; family: 4 | 6 };
type ProxyTarget = { hostname: string; endpoint?: ResolvedEndpoint };
type ProxiedConnection = { client: Socket; upstream: Socket };
type ProxyAuthority = { restrictPrivateNetwork: boolean; expiresAt: number };
type AuthenticatedProxyRequest = {
  authority: ProxyAuthority;
  upstreamAuthorization?: string;
  boundAuthentication?: BoundUpstreamAuthentication;
};
type BoundUpstreamAuthentication = {
  authority: ProxyAuthority;
  method: string;
  target: string;
  expiresAt: number;
  rounds: number;
  route: Extract<ProxyRoute, { kind: 'http' | 'https' }>;
  proxyTarget: ProxyTarget;
  socket: Socket;
  agent: HttpAgent;
  expiryTimer?: ReturnType<typeof setTimeout>;
};
type ProxyResolver = (url: string) => Promise<string>;
type ProxyRoute =
  | { kind: 'direct' }
  | { kind: 'http'; hostname: string; port: number }
  | { kind: 'https'; hostname: string; port: number }
  | { kind: 'socks4'; hostname: string; port: number }
  | { kind: 'socks5'; hostname: string; port: number };

const PROXY_AUTH_REALM = 'Kai Browser Network Guard';
const MAX_PROXY_TARGET_CHARS = 16 * 1_024;
const MAX_PROXY_ROUTE_LIST_CHARS = 16 * 1_024;
const MAX_PROXY_AUTHORITY_TOKENS = 4_096;
const PROXY_AUTHORITY_TTL_MS = 30_000;
const MAX_UPSTREAM_PROXY_RESPONSE_BYTES = 64 * 1_024;
const MAX_UPSTREAM_PROXY_ROUTES = 16;
const DEFAULT_PROXY_OPERATION_TIMEOUT_MS = 15_000;
const UPSTREAM_PROXY_AUTH_TIMEOUT_MS = 120_000;
const MAX_UPSTREAM_PROXY_AUTH_ROUNDS = 8;

export type BrowserValidatingProxyOptions = {
  operationTimeoutMs?: number;
  resolveHost?: (hostname: string) => Promise<ResolvedEndpoint[]>;
};

class UpstreamProxyAuthenticationError extends Error {
  constructor(
    readonly challenges: string[],
    readonly socket: Socket,
    readonly route: Extract<ProxyRoute, { kind: 'http' | 'https' }>,
    readonly target: ProxyTarget,
  ) {
    super('The upstream proxy requires authentication.');
    this.name = 'UpstreamProxyAuthenticationError';
  }
}

function normalizedHostname(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
}

function requestKey(scopeKey: string, requestId: number): string {
  return `${scopeKey}\u0000${requestId}`;
}

function parseConnectTarget(authority: string): { hostname: string; port: number } {
  if (!authority || authority.length > MAX_PROXY_TARGET_CHARS) throw new Error('Invalid proxy tunnel target.');
  const parsed = new URL(`http://${authority}`);
  if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error('Invalid proxy tunnel target.');
  }
  const port = parsed.port ? Number(parsed.port) : 443;
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) throw new Error('Invalid proxy tunnel port.');
  const hostname = normalizedHostname(parsed.hostname);
  if (!hostname) throw new Error('Invalid proxy tunnel hostname.');
  return { hostname, port };
}

function parseProxyEndpoint(value: string, defaultPort: number): { hostname: string; port: number } {
  if (!value || value.length > MAX_PROXY_TARGET_CHARS) throw new Error('Invalid upstream proxy endpoint.');
  const parsed = new URL(`http://${value}`);
  if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error('Invalid upstream proxy endpoint.');
  }
  const hostname = normalizedHostname(parsed.hostname);
  const port = parsed.port ? Number(parsed.port) : defaultPort;
  if (!hostname || !Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new Error('Invalid upstream proxy endpoint.');
  }
  return { hostname, port };
}

export function parseBrowserProxyRoutes(value: string): ProxyRoute[] {
  if (value.length > MAX_PROXY_ROUTE_LIST_CHARS) throw new Error('The system proxy route list is too large.');
  const routes: ProxyRoute[] = [];
  for (const rawEntry of value.split(';')) {
    if (routes.length >= MAX_UPSTREAM_PROXY_ROUTES) break;
    const entry = rawEntry.trim();
    if (!entry) continue;
    const separator = entry.indexOf(' ');
    const directive = (separator === -1 ? entry : entry.slice(0, separator)).toUpperCase();
    const target = separator === -1 ? '' : entry.slice(separator + 1).trim();
    if (directive === 'DIRECT') {
      routes.push({ kind: 'direct' });
      continue;
    }
    const kind =
      directive === 'PROXY' || directive === 'HTTP'
        ? 'http'
        : directive === 'HTTPS'
          ? 'https'
          : directive === 'SOCKS' || directive === 'SOCKS5'
            ? 'socks5'
            : directive === 'SOCKS4'
              ? 'socks4'
              : null;
    if (!kind || !target) continue;
    const endpoint = parseProxyEndpoint(target, kind === 'https' ? 443 : kind === 'http' ? 80 : 1080);
    routes.push({ kind, ...endpoint });
  }
  return routes;
}

function proxyRouteKey(route: Exclude<ProxyRoute, { kind: 'direct' }>): string {
  return `${route.kind}://${route.hostname}:${route.port}`;
}

function boundedProxyAuthorization(value: string | string[] | undefined): string | undefined {
  const candidate = Array.isArray(value) ? value[0] : value;
  if (!candidate || candidate.length > MAX_UPSTREAM_PROXY_RESPONSE_BYTES || /[\r\n]/.test(candidate)) return undefined;
  return candidate;
}

function proxyAuthenticationChallenges(value: string | string[] | undefined): string[] {
  const values = Array.isArray(value) ? value : value ? [value] : [];
  const challenges: string[] = [];
  let total = 0;
  for (const candidate of values) {
    if (!candidate || /[\r\n]/.test(candidate)) continue;
    total += candidate.length;
    if (total > MAX_UPSTREAM_PROXY_RESPONSE_BYTES) break;
    challenges.push(candidate);
  }
  return challenges;
}

function parseHttpHeaderBlock(value: Buffer): { startLine: string; headers: Map<string, string[]> } {
  const lines = value.toString('latin1').split('\r\n');
  const startLine = lines.shift() ?? '';
  const headers = new Map<string, string[]>();
  for (const line of lines) {
    if (!line) break;
    const separator = line.indexOf(':');
    if (separator <= 0) throw new Error('The proxy returned malformed HTTP headers.');
    const name = line.slice(0, separator).trim().toLowerCase();
    const headerValue = line.slice(separator + 1).trim();
    if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(name) || /[\r\n]/.test(headerValue)) {
      throw new Error('The proxy returned malformed HTTP headers.');
    }
    const existing = headers.get(name) ?? [];
    existing.push(headerValue);
    headers.set(name, existing);
  }
  return { startLine, headers };
}

function headerRequestsConnectionClose(headers: Map<string, string[]>): boolean {
  return [...(headers.get('connection') ?? []), ...(headers.get('proxy-connection') ?? [])].some((value) =>
    value
      .split(',')
      .map((entry) => entry.trim().toLowerCase())
      .includes('close'),
  );
}

function serializedHeaderLines(headers: IncomingMessage['headers']): string {
  return Object.entries(headers)
    .flatMap(([name, value]) =>
      Array.isArray(value) ? value.map((item) => `${name}: ${item}`) : value === undefined ? [] : [`${name}: ${value}`],
    )
    .join('\r\n');
}

async function readSocketHeaderBlock(socket: Socket): Promise<Buffer> {
  return await new Promise<Buffer>((resolve, reject) => {
    let buffered = Buffer.alloc(0);
    const cleanup = (): void => {
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('close', onClose);
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onClose = (): void => {
      cleanup();
      reject(new Error('The proxy connection closed during its HTTP handshake.'));
    };
    const onData = (chunk: Buffer): void => {
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.length > MAX_UPSTREAM_PROXY_RESPONSE_BYTES) {
        cleanup();
        reject(new Error('The proxy returned oversized HTTP headers.'));
        return;
      }
      const boundary = buffered.indexOf('\r\n\r\n');
      if (boundary === -1) return;
      cleanup();
      const end = boundary + 4;
      const remainder = buffered.subarray(end);
      if (remainder.length > 0) socket.unshift(remainder);
      resolve(buffered.subarray(0, end));
    };
    socket.on('data', onData);
    socket.once('error', onError);
    socket.once('close', onClose);
  });
}

async function withOperationTimeout<T>(operation: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function endpointAuthority(endpoint: ResolvedEndpoint, port: number): string {
  return `${endpoint.family === 6 ? `[${endpoint.address}]` : endpoint.address}:${port}`;
}

function proxyTargetAuthority(target: ProxyTarget, port: number): string {
  if (target.endpoint) return endpointAuthority(target.endpoint, port);
  return `${target.hostname.includes(':') ? `[${target.hostname}]` : target.hostname}:${port}`;
}

function safeStringEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function ipv6AddressBytes(address: string): Buffer {
  const sections = address.toLowerCase().split('::');
  if (sections.length > 2) return Buffer.alloc(0);
  const parseSide = (value: string): number[] => {
    if (!value) return [];
    const groups: number[] = [];
    for (const part of value.split(':')) {
      if (part.includes('.')) {
        const ipv4 = part.split('.').map((entry) => Number(entry));
        if (ipv4.length !== 4 || ipv4.some((entry) => !Number.isInteger(entry) || entry < 0 || entry > 255)) {
          return [];
        }
        groups.push((ipv4[0]! << 8) | ipv4[1]!, (ipv4[2]! << 8) | ipv4[3]!);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/.test(part)) return [];
      groups.push(Number.parseInt(part, 16));
    }
    return groups;
  };
  const left = parseSide(sections[0] ?? '');
  const right = parseSide(sections[1] ?? '');
  const omitted = sections.length === 2 ? 8 - left.length - right.length : 0;
  const groups = sections.length === 2 ? [...left, ...new Array(Math.max(0, omitted)).fill(0), ...right] : left;
  if (groups.length !== 8) return Buffer.alloc(0);
  return Buffer.from(groups.flatMap((value) => [(value >> 8) & 0xff, value & 0xff]));
}

async function readSocketBytes(socket: Socket, length: number): Promise<Buffer> {
  return await new Promise<Buffer>((resolve, reject) => {
    let buffered = Buffer.alloc(0);
    const cleanup = (): void => {
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('close', onClose);
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onClose = (): void => {
      cleanup();
      reject(new Error('The upstream proxy closed the connection.'));
    };
    const onData = (chunk: Buffer): void => {
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.length < length) return;
      cleanup();
      const remainder = buffered.subarray(length);
      if (remainder.length > 0) socket.unshift(remainder);
      resolve(buffered.subarray(0, length));
    };
    socket.on('data', onData);
    socket.once('error', onError);
    socket.once('close', onClose);
  });
}

function stripProxyHeaders(headers: IncomingMessage['headers']): Record<string, string | string[] | undefined> {
  const forwarded = { ...headers };
  delete forwarded['proxy-authorization'];
  delete forwarded['proxy-connection'];
  return forwarded;
}

/** Bind Node's HTTP parser to the socket Kai already opened and validated.
 * `agent: false` silently ignores a request-level createConnection callback and
 * opens a second DNS-resolved socket, defeating both endpoint pinning and
 * connection-bound proxy authentication. This agent can never create a
 * fallback connection: a dead pinned socket fails closed. */
function pinnedHttpAgent(route: ProxyRoute, socket: Socket): HttpAgent {
  const agent: HttpAgent =
    route.kind === 'https'
      ? new HttpsAgent({ keepAlive: true, maxSockets: 1 })
      : new HttpAgent({ keepAlive: true, maxSockets: 1 });
  agent.createConnection = (() => socket) as typeof agent.createConnection;
  return agent;
}

/**
 * Process-local HTTP CONNECT proxy used by Browser sessions. It is not a
 * content proxy or MITM: Chromium retains the original URL, TLS SNI,
 * certificates, cookies, storage, and Chrome user agent. The proxy only owns
 * DNS resolution and the TCP connect, which makes the validated IP the actual
 * connection destination and closes the DNS-rebinding gap left by webRequest.
 */
export class BrowserValidatingProxy {
  private readonly username = `kai-${randomBytes(12).toString('hex')}`;
  private readonly configuredSessions = new WeakMap<Session, Promise<void>>();
  private readonly restrictedRequests = new Map<string, string>();
  private readonly restrictedHostCounts = new Map<string, number>();
  private readonly authorities = new Map<string, ProxyAuthority>();
  private readonly connectionsByHost = new Map<string, Set<ProxiedConnection>>();
  private readonly pendingSocketsByHost = new Map<string, Set<Socket>>();
  private readonly boundUpstreamAuthentication = new WeakMap<Socket, BoundUpstreamAuthentication>();
  private readonly clientSockets = new Set<Socket>();
  private readonly operationTimeoutMs: number;
  private readonly resolveHost: (hostname: string) => Promise<ResolvedEndpoint[]>;
  private server: Server | null = null;
  private startPromise: Promise<number> | null = null;
  private port: number | null = null;
  private closed = false;

  constructor(
    private readonly resolveUpstreamProxy?: ProxyResolver,
    options: BrowserValidatingProxyOptions = {},
  ) {
    const timeout = options.operationTimeoutMs ?? DEFAULT_PROXY_OPERATION_TIMEOUT_MS;
    if (!Number.isInteger(timeout) || timeout < 25 || timeout > 120_000) {
      throw new Error('Invalid Browser proxy operation timeout.');
    }
    this.operationTimeoutMs = timeout;
    this.resolveHost =
      options.resolveHost ??
      (async (hostname) =>
        (await lookup(hostname, { all: true, verbatim: true })).map((entry) => ({
          address: entry.address,
          family: entry.family as 4 | 6,
        })));
  }

  configureSession(session: Session): Promise<void> {
    const existing = this.configuredSessions.get(session);
    if (existing) return existing;
    const configured = this.start().then(async (port) => {
      if (this.closed) throw new Error('The Browser validating proxy is closed.');
      await session.setProxy({
        mode: 'fixed_servers',
        proxyRules: `http://127.0.0.1:${port}`,
        // Chromium otherwise bypasses proxies for loopback/private literal
        // targets before Kai can apply the assistant policy.
        proxyBypassRules: '<-loopback>',
      });
      await session.closeAllConnections();
    });
    this.configuredSessions.set(session, configured);
    // Cache only a successful configuration (or its in-flight attempt). A
    // transient listener/session failure must not poison this profile forever;
    // later callers retry while concurrent callers still share one attempt.
    void configured.catch(() => {
      if (this.configuredSessions.get(session) === configured) {
        this.configuredSessions.delete(session);
      }
    });
    return configured;
  }

  isAuthenticationChallenge(authInfo: AuthInfo): boolean {
    return (
      authInfo.isProxy &&
      normalizedHostname(authInfo.host) === '127.0.0.1' &&
      this.port !== null &&
      authInfo.port === this.port &&
      authInfo.realm === PROXY_AUTH_REALM
    );
  }

  credentials(restrictPrivateNetwork = false): { username: string; password: string } {
    const currentTime = Date.now();
    for (const [token, authority] of this.authorities) {
      if (authority.expiresAt <= currentTime) this.authorities.delete(token);
    }
    while (this.authorities.size >= MAX_PROXY_AUTHORITY_TOKENS) {
      const oldest = this.authorities.keys().next().value as string | undefined;
      if (!oldest) break;
      this.authorities.delete(oldest);
    }
    const password = randomBytes(32).toString('base64url');
    this.authorities.set(password, {
      restrictPrivateNetwork,
      expiresAt: currentTime + PROXY_AUTHORITY_TTL_MS,
    });
    return { username: this.username, password };
  }

  restrictRequest(scopeKey: string, requestId: number, rawUrl: string): void {
    const key = requestKey(scopeKey, requestId);
    let hostname: string;
    try {
      hostname = normalizedHostname(new URL(rawUrl).hostname);
    } catch {
      throw new Error('The Browser validating proxy received an invalid request URL.');
    }
    const prior = this.restrictedRequests.get(key);
    if (prior === hostname) return;
    if (prior) this.releaseRestrictedHost(prior);
    this.restrictedRequests.set(key, hostname);
    const priorHostCount = this.restrictedHostCounts.get(hostname) ?? 0;
    this.restrictedHostCounts.set(hostname, priorHostCount + 1);
    // A pooled tunnel may have been opened by an unrestricted user tab before
    // this exact assistant request existed. Close every same-host tunnel before
    // Chromium is admitted so the next connection must authenticate with exact
    // user/assistant authority and pass the pinned lookup.
    if (priorHostCount === 0) this.closeHostConnections(hostname);
  }

  releaseRequest(scopeKey: string, requestId: number): void {
    const key = requestKey(scopeKey, requestId);
    const hostname = this.restrictedRequests.get(key);
    if (!hostname) return;
    this.restrictedRequests.delete(key);
    this.releaseRestrictedHost(hostname);
  }

  releaseScope(scopeKey: string): void {
    const prefix = `${scopeKey}\u0000`;
    for (const [key, hostname] of [...this.restrictedRequests]) {
      if (!key.startsWith(prefix)) continue;
      this.restrictedRequests.delete(key);
      this.releaseRestrictedHost(hostname);
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const connections of this.connectionsByHost.values()) {
      for (const connection of connections) {
        connection.client.destroy();
        connection.upstream.destroy();
      }
    }
    this.connectionsByHost.clear();
    for (const sockets of this.pendingSocketsByHost.values()) {
      for (const socket of sockets) socket.destroy();
    }
    this.pendingSocketsByHost.clear();
    this.authorities.clear();
    this.restrictedRequests.clear();
    this.restrictedHostCounts.clear();
    for (const socket of this.clientSockets) socket.destroy();
    this.clientSockets.clear();
    // `listen()` completes asynchronously. Wait for its callback to observe
    // `closed` and retract the listener before deciding whether a server still
    // needs to be closed here.
    await this.startPromise?.catch(() => undefined);
    const server = this.server;
    this.server = null;
    if (!server?.listening) return;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  private closeHostConnections(hostname: string): void {
    const normalized = normalizedHostname(hostname);
    const connections = this.connectionsByHost.get(normalized);
    for (const connection of connections ?? []) {
      connection.client.destroy();
      connection.upstream.destroy();
    }
    this.connectionsByHost.delete(normalized);
    for (const socket of this.pendingSocketsByHost.get(normalized) ?? []) socket.destroy();
    this.pendingSocketsByHost.delete(normalized);
  }

  private releaseRestrictedHost(hostname: string): void {
    const normalized = normalizedHostname(hostname);
    const remaining = (this.restrictedHostCounts.get(normalized) ?? 1) - 1;
    if (remaining > 0) this.restrictedHostCounts.set(normalized, remaining);
    else this.restrictedHostCounts.delete(normalized);
  }

  private releaseBoundUpstreamAuthentication(
    client: Socket,
    expected?: BoundUpstreamAuthentication,
    destroyTransport = true,
  ): void {
    const current = this.boundUpstreamAuthentication.get(client);
    if (!current || (expected && current !== expected)) return;
    this.boundUpstreamAuthentication.delete(client);
    if (current.expiryTimer) clearTimeout(current.expiryTimer);
    current.expiryTimer = undefined;
    if (destroyTransport) current.agent.destroy();
  }

  private rememberBoundUpstreamAuthentication(
    client: Socket,
    authentication: Omit<BoundUpstreamAuthentication, 'expiryTimer'>,
  ): BoundUpstreamAuthentication {
    const prior = this.boundUpstreamAuthentication.get(client);
    if (prior) {
      const sameTransport = prior.agent === authentication.agent && prior.socket === authentication.socket;
      this.releaseBoundUpstreamAuthentication(client, prior, !sameTransport);
    }
    const bound: BoundUpstreamAuthentication = { ...authentication };
    bound.expiryTimer = setTimeout(
      () => this.releaseBoundUpstreamAuthentication(client, bound),
      Math.max(1, bound.expiresAt - Date.now()),
    );
    bound.expiryTimer.unref?.();
    this.boundUpstreamAuthentication.set(client, bound);
    const release = (): void => this.releaseBoundUpstreamAuthentication(client, bound);
    bound.socket.once('close', release);
    client.once('close', release);
    return bound;
  }

  private restrictAuthorityForHost(authority: ProxyAuthority, hostname: string): ProxyAuthority {
    if (authority.restrictPrivateNetwork || (this.restrictedHostCounts.get(normalizedHostname(hostname)) ?? 0) > 0) {
      return authority.restrictPrivateNetwork ? authority : { ...authority, restrictPrivateNetwork: true };
    }
    return authority;
  }

  private authenticate(request: IncomingMessage, hostname: string): AuthenticatedProxyRequest | null {
    const bound = this.boundUpstreamAuthentication.get(request.socket);
    if (bound) {
      if (
        bound.expiresAt <= Date.now() ||
        bound.method !== request.method ||
        bound.target !== request.url ||
        bound.socket.destroyed ||
        !bound.socket.writable
      ) {
        this.releaseBoundUpstreamAuthentication(request.socket, bound);
        return null;
      }
      const upstreamAuthorization = boundedProxyAuthorization(request.headers['proxy-authorization']);
      if (!upstreamAuthorization) {
        this.releaseBoundUpstreamAuthentication(request.socket, bound);
        return null;
      }
      return {
        authority: this.restrictAuthorityForHost(bound.authority, hostname),
        upstreamAuthorization,
        boundAuthentication: bound,
      };
    }
    const provided = request.headers['proxy-authorization'];
    if (typeof provided !== 'string' || !provided.startsWith('Basic ') || provided.length > 1_024) return null;
    let decoded: string;
    try {
      decoded = Buffer.from(provided.slice('Basic '.length), 'base64').toString('utf8');
    } catch {
      return null;
    }
    const separator = decoded.indexOf(':');
    if (separator <= 0 || !safeStringEqual(decoded.slice(0, separator), this.username)) return null;
    const token = decoded.slice(separator + 1);
    const authority = this.authorities.get(token);
    if (!authority) return null;
    // Every credential is one connection/request authority. Consuming it keeps
    // Chromium's proxy-auth cache from turning one trusted user navigation into
    // ambient authority for a later assistant request in the same profile.
    this.authorities.delete(token);
    if (authority.expiresAt <= Date.now()) return null;
    return { authority: this.restrictAuthorityForHost(authority, hostname) };
  }

  private rejectAuthentication(socketOrResponse: Socket | ServerResponse): void {
    if ('writeHead' in socketOrResponse) {
      socketOrResponse.writeHead(407, { 'Proxy-Authenticate': `Basic realm="${PROXY_AUTH_REALM}"` });
      socketOrResponse.end();
      return;
    }
    socketOrResponse.end(
      `HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="${PROXY_AUTH_REALM}"\r\nConnection: close\r\n\r\n`,
    );
  }

  private async resolveEndpoints(hostname: string, restrictPrivateNetwork: boolean): Promise<ResolvedEndpoint[]> {
    const normalized = normalizedHostname(hostname);
    const literalFamily = isIP(normalized);
    const endpoints: ResolvedEndpoint[] = literalFamily
      ? [{ address: normalized, family: literalFamily as 4 | 6 }]
      : await withOperationTimeout(
          this.resolveHost(normalized),
          this.operationTimeoutMs,
          'Browser proxy DNS resolution timed out.',
        );
    if (endpoints.length === 0) throw new Error('DNS resolution returned no destination.');
    const restricted = restrictPrivateNetwork || (this.restrictedHostCounts.get(normalizedHostname(hostname)) ?? 0) > 0;
    if (restricted && endpoints.some((endpoint) => isPrivateResolvedAddress(endpoint.address))) {
      throw new Error('Private-network destination blocked by the Browser validating proxy.');
    }
    const permitted = restricted
      ? endpoints.filter((endpoint) => !isPrivateResolvedAddress(endpoint.address))
      : endpoints;
    const unique = [
      ...new Map(
        permitted
          .filter(
            (endpoint) =>
              (endpoint.family === 4 || endpoint.family === 6) && isIP(endpoint.address) === endpoint.family,
          )
          .map((endpoint) => [`${endpoint.family}:${endpoint.address}`, endpoint]),
      ).values(),
    ];
    // Prefer IPv4 for broad enterprise/VPN reachability, but retain every
    // validated answer and retry it before falling through to another PAC route.
    const ordered = [
      ...unique.filter((endpoint) => endpoint.family === 4),
      ...unique.filter((endpoint) => endpoint.family === 6),
    ];
    if (ordered.length === 0) throw new Error('DNS resolution returned no permitted destination.');
    return ordered;
  }

  private trackConnection(hostname: string, client: Socket, upstream: Socket): void {
    const normalized = normalizedHostname(hostname);
    this.releasePendingSocket(normalized, upstream);
    const connection = { client, upstream };
    const connections = this.connectionsByHost.get(normalized) ?? new Set<ProxiedConnection>();
    connections.add(connection);
    this.connectionsByHost.set(normalized, connections);
    const release = (): void => {
      connections.delete(connection);
      if (connections.size === 0 && this.connectionsByHost.get(normalized) === connections) {
        this.connectionsByHost.delete(normalized);
      }
    };
    client.once('close', release);
    upstream.once('close', release);
  }

  private trackPendingSocket(hostname: string, socket: Socket): void {
    const normalized = normalizedHostname(hostname);
    const sockets = this.pendingSocketsByHost.get(normalized) ?? new Set<Socket>();
    sockets.add(socket);
    this.pendingSocketsByHost.set(normalized, sockets);
    socket.once('close', () => this.releasePendingSocket(normalized, socket));
  }

  private releasePendingSocket(hostname: string, socket: Socket): void {
    const normalized = normalizedHostname(hostname);
    const sockets = this.pendingSocketsByHost.get(normalized);
    if (!sockets?.delete(socket)) return;
    if (sockets.size === 0) this.pendingSocketsByHost.delete(normalized);
  }

  private async proxyRoutes(url: string): Promise<ProxyRoute[]> {
    if (!this.resolveUpstreamProxy) return [{ kind: 'direct' }];
    const resolved = await withOperationTimeout(
      this.resolveUpstreamProxy(url),
      this.operationTimeoutMs,
      'System proxy resolution timed out.',
    );
    const routes = parseBrowserProxyRoutes(resolved);
    if (routes.length === 0) {
      throw new Error('The system proxy resolver returned no supported route.');
    }
    // A resolver session must never point back at this process-local proxy. That
    // would recurse indefinitely if a caller accidentally reused the Browser
    // data session instead of the dedicated system/PAC resolver session.
    for (const route of routes) {
      if (
        route.kind !== 'direct' &&
        normalizedHostname(route.hostname) === '127.0.0.1' &&
        this.port !== null &&
        route.port === this.port
      ) {
        throw new Error('The system proxy resolver returned the Browser validating proxy itself.');
      }
    }
    return routes;
  }

  private async openProxySocket(
    route: Exclude<ProxyRoute, { kind: 'direct' }>,
    targetHostname: string,
    client: Socket,
  ): Promise<Socket> {
    const socket =
      route.kind === 'https'
        ? connectTls({
            host: route.hostname,
            port: route.port,
            servername: isIP(route.hostname) ? undefined : route.hostname,
          })
        : connect({ host: route.hostname, port: route.port });
    this.trackPendingSocket(targetHostname, socket);
    const connected = new Promise<Socket>((resolve, reject) => {
      const connectedEvent = route.kind === 'https' ? 'secureConnect' : 'connect';
      const onError = (error: Error): void => {
        socket.off(connectedEvent, onConnected);
        reject(error);
      };
      const onConnected = (): void => {
        socket.off('error', onError);
        resolve(socket);
      };
      socket.once('error', onError);
      socket.once(connectedEvent, onConnected);
    });
    const onClientClosed = (): void => {
      socket.destroy();
    };
    client.once('close', onClientClosed);
    socket.once('close', () => client.off('close', onClientClosed));
    if (client.destroyed) onClientClosed();
    try {
      return await withOperationTimeout(
        connected,
        this.operationTimeoutMs,
        `Connection to upstream proxy ${proxyRouteKey(route)} timed out.`,
      );
    } catch (error) {
      socket.destroy();
      throw error;
    }
  }

  private async openDirectSocket(
    endpoint: ResolvedEndpoint,
    port: number,
    targetHostname: string,
    client: Socket,
  ): Promise<Socket> {
    const socket = connect({ host: endpoint.address, family: endpoint.family, port });
    this.trackPendingSocket(targetHostname, socket);
    const connected = new Promise<Socket>((resolve, reject) => {
      const onError = (error: Error): void => {
        socket.off('connect', onConnected);
        reject(error);
      };
      const onConnected = (): void => {
        socket.off('error', onError);
        resolve(socket);
      };
      socket.once('error', onError);
      socket.once('connect', onConnected);
    });
    const onClientClosed = (): void => {
      socket.destroy();
    };
    client.once('close', onClientClosed);
    socket.once('close', () => client.off('close', onClientClosed));
    if (client.destroyed) onClientClosed();
    try {
      return await withOperationTimeout(
        connected,
        this.operationTimeoutMs,
        `Connection to ${endpointAuthority(endpoint, port)} timed out.`,
      );
    } catch (error) {
      socket.destroy();
      throw error;
    }
  }

  private async openHttpProxyTunnel(
    route: Extract<ProxyRoute, { kind: 'http' | 'https' }>,
    target: ProxyTarget,
    port: number,
    client: Socket,
    upstreamAuthorization?: string,
    reusableSocket?: Socket,
  ): Promise<Socket> {
    const socket =
      reusableSocket && !reusableSocket.destroyed && reusableSocket.writable
        ? reusableSocket
        : await this.openProxySocket(route, target.hostname, client);
    const authority = proxyTargetAuthority(target, port);
    const authorizationHeader = upstreamAuthorization ? `Proxy-Authorization: ${upstreamAuthorization}\r\n` : '';
    socket.write(
      `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${authorizationHeader}Proxy-Connection: keep-alive\r\nConnection: keep-alive\r\n\r\n`,
    );
    try {
      const response = await withOperationTimeout(
        readSocketHeaderBlock(socket),
        this.operationTimeoutMs,
        `Upstream proxy ${proxyRouteKey(route)} CONNECT handshake timed out.`,
      );
      const { startLine, headers } = parseHttpHeaderBlock(response);
      if (/^HTTP\/1\.[01] 2\d\d(?:\s|$)/.test(startLine)) return socket;
      if (/^HTTP\/1\.[01] 407(?:\s|$)/.test(startLine)) {
        const challenges = proxyAuthenticationChallenges(headers.get('proxy-authenticate'));
        if (challenges.length === 0) {
          throw new Error('The upstream proxy returned an invalid authentication challenge.');
        }
        if (headerRequestsConnectionClose(headers)) socket.destroy();
        throw new UpstreamProxyAuthenticationError(challenges, socket, route, target);
      }
      throw new Error('The upstream proxy rejected the target connection.');
    } catch (error) {
      if (error instanceof UpstreamProxyAuthenticationError) throw error;
      socket.destroy();
      throw error;
    }
  }

  private async openSocksTunnel(
    route: Extract<ProxyRoute, { kind: 'socks4' | 'socks5' }>,
    target: ProxyTarget,
    port: number,
    client: Socket,
  ): Promise<Socket> {
    const socket = await this.openProxySocket(route, target.hostname, client);
    try {
      return await withOperationTimeout(
        (async () => {
          if (route.kind === 'socks4') {
            let request: Buffer;
            if (target.endpoint) {
              if (target.endpoint.family !== 4) {
                throw new Error('SOCKS4 cannot connect to an IPv6-only destination.');
              }
              const address = Buffer.from(target.endpoint.address.split('.').map((part) => Number(part)));
              if (address.length !== 4) throw new Error('The pinned SOCKS4 destination is invalid.');
              request = Buffer.from([0x04, 0x01, (port >> 8) & 0xff, port & 0xff, ...address, 0x00]);
            } else {
              const hostname = Buffer.from(target.hostname, 'utf8');
              if (hostname.length === 0 || hostname.length > 255 || hostname.includes(0)) {
                throw new Error('The SOCKS4 proxy hostname is invalid.');
              }
              // SOCKS4a delegates DNS to the configured enterprise proxy. This
              // is allowed only for an unrestricted target; restricted callers
              // always provide a locally validated endpoint above.
              request = Buffer.from([
                0x04,
                0x01,
                (port >> 8) & 0xff,
                port & 0xff,
                0x00,
                0x00,
                0x00,
                0x01,
                0x00,
                ...hostname,
                0x00,
              ]);
            }
            socket.write(request);
            const response = await readSocketBytes(socket, 8);
            if (response[1] !== 0x5a) throw new Error('The SOCKS4 proxy rejected the target connection.');
            return socket;
          }

          socket.write(Buffer.from([0x05, 0x01, 0x00]));
          const greeting = await readSocketBytes(socket, 2);
          if (greeting[0] !== 0x05 || greeting[1] !== 0x00) {
            throw new Error('The SOCKS5 proxy requires unsupported authentication.');
          }
          let addressType: 0x01 | 0x03 | 0x04;
          let address: Buffer;
          if (target.endpoint) {
            addressType = target.endpoint.family === 4 ? 0x01 : 0x04;
            address =
              target.endpoint.family === 4
                ? Buffer.from(target.endpoint.address.split('.').map((part) => Number(part)))
                : ipv6AddressBytes(target.endpoint.address);
            // Reject malformed literals rather than allowing a proxy-side
            // hostname re-resolve that would defeat connection-time validation.
            if (
              (target.endpoint.family === 4 && address.length !== 4) ||
              (target.endpoint.family === 6 && address.length !== 16)
            ) {
              throw new Error('The pinned SOCKS destination is invalid.');
            }
          } else {
            addressType = 0x03;
            address = Buffer.from(target.hostname, 'utf8');
            if (address.length === 0 || address.length > 255 || address.includes(0)) {
              throw new Error('The SOCKS5 proxy hostname is invalid.');
            }
          }
          socket.write(
            Buffer.from([
              0x05,
              0x01,
              0x00,
              addressType,
              ...(addressType === 0x03 ? [address.length] : []),
              ...address,
              (port >> 8) & 0xff,
              port & 0xff,
            ]),
          );
          const response = await readSocketBytes(socket, 4);
          if (response[0] !== 0x05 || response[1] !== 0x00) {
            throw new Error('The SOCKS5 proxy rejected the target connection.');
          }
          const addressLength =
            response[3] === 0x01
              ? 4
              : response[3] === 0x04
                ? 16
                : response[3] === 0x03
                  ? (await readSocketBytes(socket, 1))[0]
                  : 0;
          if (!addressLength) throw new Error('The SOCKS5 proxy returned an invalid address.');
          await readSocketBytes(socket, addressLength + 2);
          return socket;
        })(),
        this.operationTimeoutMs,
        `SOCKS proxy ${proxyRouteKey(route)} handshake timed out.`,
      );
    } catch (error) {
      socket.destroy();
      throw error;
    }
  }

  private async openTargetSocket(
    route: ProxyRoute,
    target: ProxyTarget,
    port: number,
    client: Socket,
  ): Promise<Socket> {
    if (route.kind === 'direct') {
      if (!target.endpoint) throw new Error('Direct Browser connections require a resolved destination.');
      return await this.openDirectSocket(target.endpoint, port, target.hostname, client);
    }
    if (route.kind === 'http' || route.kind === 'https') {
      return await this.openHttpProxyTunnel(route, target, port, client);
    }
    return await this.openSocksTunnel(route, target, port, client);
  }

  private async openFirstTargetSocket(
    routes: ProxyRoute[],
    hostname: string,
    port: number,
    authority: ProxyAuthority,
    client: Socket,
  ): Promise<{ route: ProxyRoute; socket: Socket; target: ProxyTarget }> {
    const failures: unknown[] = [];
    let pinnedTargets: ProxyTarget[] | undefined;
    for (const route of routes) {
      const requiresPinnedTarget =
        route.kind === 'direct' ||
        authority.restrictPrivateNetwork ||
        (this.restrictedHostCounts.get(normalizedHostname(hostname)) ?? 0) > 0;
      const targets = requiresPinnedTarget
        ? (pinnedTargets ??= (await this.resolveEndpoints(hostname, authority.restrictPrivateNetwork)).map(
            (endpoint) => ({ hostname, endpoint }),
          ))
        : [{ hostname }];
      for (const target of targets) {
        try {
          return { route, socket: await this.openTargetSocket(route, target, port, client), target };
        } catch (error) {
          if (error instanceof UpstreamProxyAuthenticationError) throw error;
          failures.push(error);
        }
      }
    }
    throw new AggregateError(failures, 'Every system proxy route failed to connect.');
  }

  private async openFirstHttpTransport(
    routes: ProxyRoute[],
    hostname: string,
    port: number,
    authority: ProxyAuthority,
    client: Socket,
  ): Promise<{ route: ProxyRoute; socket: Socket; target: ProxyTarget; agent: HttpAgent }> {
    const failures: unknown[] = [];
    let pinnedTargets: ProxyTarget[] | undefined;
    for (const route of routes) {
      const requiresPinnedTarget =
        route.kind === 'direct' ||
        authority.restrictPrivateNetwork ||
        (this.restrictedHostCounts.get(normalizedHostname(hostname)) ?? 0) > 0;
      const targets = requiresPinnedTarget
        ? (pinnedTargets ??= (await this.resolveEndpoints(hostname, authority.restrictPrivateNetwork)).map(
            (endpoint) => ({ hostname, endpoint }),
          ))
        : [{ hostname }];
      for (const target of targets) {
        try {
          const socket =
            route.kind === 'direct'
              ? await this.openTargetSocket(route, target, port, client)
              : route.kind === 'socks4' || route.kind === 'socks5'
                ? await this.openSocksTunnel(route, target, port, client)
                : await this.openProxySocket(route, hostname, client);
          return { route, socket, target, agent: pinnedHttpAgent(route, socket) };
        } catch (error) {
          failures.push(error);
        }
      }
    }
    throw new AggregateError(failures, 'Every system proxy route failed to connect.');
  }

  private writeUpstreamAuthenticationChallenge(client: Socket, challenges: string[]): void {
    const challengeHeaders = challenges.map((challenge) => `Proxy-Authenticate: ${challenge}\r\n`).join('');
    client.write(
      `HTTP/1.1 407 Proxy Authentication Required\r\n${challengeHeaders}Proxy-Agent: Kai\r\nConnection: keep-alive\r\nContent-Length: 0\r\n\r\n`,
    );
  }

  private async readUpstreamAuthenticationRetry(
    client: Socket,
    expectedMethod: string,
    expectedTarget: string,
    timeoutMs: number,
  ): Promise<{ authorization: string; headers: Map<string, string[]> }> {
    const block = await withOperationTimeout(
      readSocketHeaderBlock(client),
      timeoutMs,
      'Timed out waiting for upstream proxy authentication.',
    );
    const { startLine, headers } = parseHttpHeaderBlock(block);
    const match = /^(\S+)\s+(\S+)\s+HTTP\/1\.[01]$/.exec(startLine);
    if (!match || match[1] !== expectedMethod || match[2] !== expectedTarget) {
      throw new Error('The Browser proxy request changed during upstream authentication.');
    }
    const authorization = boundedProxyAuthorization(headers.get('proxy-authorization'));
    if (!authorization) throw new Error('The upstream proxy authentication response was invalid.');
    return { authorization, headers };
  }

  private async openConnectTarget(
    routes: ProxyRoute[],
    hostname: string,
    port: number,
    authority: ProxyAuthority,
    client: Socket,
    requestMethod: string,
    requestTarget: string,
  ): Promise<{ socket: Socket; authenticationRetried: boolean; retryHeaders?: Map<string, string[]> }> {
    let authenticationRetried = false;
    try {
      const opened = await this.openFirstTargetSocket(routes, hostname, port, authority, client);
      return { socket: opened.socket, authenticationRetried };
    } catch (error) {
      if (!(error instanceof UpstreamProxyAuthenticationError)) throw error;
      const deadline = Date.now() + UPSTREAM_PROXY_AUTH_TIMEOUT_MS;
      let challenge = error;
      let retryHeaders: Map<string, string[]> | undefined;
      for (let round = 1; round <= MAX_UPSTREAM_PROXY_AUTH_ROUNDS; round++) {
        authenticationRetried = true;
        this.writeUpstreamAuthenticationChallenge(client, challenge.challenges);
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          challenge.socket.destroy();
          throw new Error('Upstream proxy authentication timed out.');
        }
        let retry: { authorization: string; headers: Map<string, string[]> };
        try {
          retry = await this.readUpstreamAuthenticationRetry(client, requestMethod, requestTarget, remaining);
        } catch (retryError) {
          challenge.socket.destroy();
          throw retryError;
        }
        retryHeaders = retry.headers;
        try {
          const socket = await this.openHttpProxyTunnel(
            challenge.route,
            challenge.target,
            port,
            client,
            retry.authorization,
            challenge.socket,
          );
          return { socket, authenticationRetried, retryHeaders };
        } catch (retryError) {
          if (!(retryError instanceof UpstreamProxyAuthenticationError)) throw retryError;
          challenge = retryError;
        }
      }
      challenge.socket.destroy();
      throw new Error('The upstream proxy authentication round limit was exceeded.');
    }
  }

  private async handleConnect(request: IncomingMessage, client: Socket, head: Buffer): Promise<void> {
    const { hostname, port } = parseConnectTarget(request.url ?? '');
    const authenticated = this.authenticate(request, hostname);
    if (!authenticated) {
      this.rejectAuthentication(client);
      return;
    }
    const routes = await this.proxyRoutes(`https://${hostname.includes(':') ? `[${hostname}]` : hostname}:${port}/`);
    const opened = await this.openConnectTarget(
      routes,
      hostname,
      port,
      authenticated.authority,
      client,
      request.method ?? 'CONNECT',
      request.url ?? '',
    );
    const upstream = opened.socket;
    this.trackConnection(hostname, client, upstream);
    client.write('HTTP/1.1 200 Connection Established\r\nProxy-Agent: Kai\r\n\r\n');
    if (!opened.authenticationRetried && head.length > 0) upstream.write(head);
    client.pipe(upstream);
    upstream.pipe(client);
    upstream.once('error', () => client.destroy());
    client.once('error', () => upstream.destroy());
  }

  private async handleHttp(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!request.url || request.url.length > MAX_PROXY_TARGET_CHARS) throw new Error('Invalid proxy request target.');
    const target = new URL(request.url);
    if (target.protocol !== 'http:') throw new Error('TLS proxy requests must use CONNECT.');
    const authenticated = this.authenticate(request, target.hostname);
    if (!authenticated) {
      this.rejectAuthentication(response);
      return;
    }
    const routes = authenticated.boundAuthentication
      ? [authenticated.boundAuthentication.route]
      : await this.proxyRoutes(target.href);
    const targetPort = target.port ? Number(target.port) : 80;
    // NTLM, Negotiate, and other connection-bound proxy authentication must
    // continue on the exact upstream socket that issued the challenge. The
    // local Chromium connection is already bound to the exact method/target in
    // authenticate(), so reusing this transport cannot authorize another URL.
    const transport = authenticated.boundAuthentication
      ? {
          route: authenticated.boundAuthentication.route,
          socket: authenticated.boundAuthentication.socket,
          target: authenticated.boundAuthentication.proxyTarget,
          agent: authenticated.boundAuthentication.agent,
        }
      : await this.openFirstHttpTransport(routes, target.hostname, targetPort, authenticated.authority, request.socket);
    const { route, socket, target: proxyTarget, agent } = transport;
    this.trackConnection(target.hostname, request.socket, socket);
    const headers = stripProxyHeaders(request.headers);
    headers.host = target.host;
    if ((route.kind === 'http' || route.kind === 'https') && authenticated.upstreamAuthorization) {
      headers['proxy-authorization'] = authenticated.upstreamAuthorization;
    }
    const forwardedTarget = new URL(target.href);
    if (proxyTarget.endpoint) {
      forwardedTarget.hostname =
        proxyTarget.endpoint.family === 6 ? `[${proxyTarget.endpoint.address}]` : proxyTarget.endpoint.address;
    }
    const requestOptions =
      route.kind === 'direct'
        ? {
            agent,
            headers,
            host: proxyTarget.endpoint!.address,
            method: request.method,
            path: `${target.pathname}${target.search}`,
            port: targetPort,
          }
        : route.kind === 'http' || route.kind === 'https'
          ? {
              agent,
              headers,
              host: route.hostname,
              method: request.method,
              path: forwardedTarget.href,
              port: route.port,
            }
          : {
              agent,
              headers,
              host: proxyTarget.endpoint?.address ?? proxyTarget.hostname,
              method: request.method,
              path: `${target.pathname}${target.search}`,
              port: targetPort,
            };
    const upstream = (route.kind === 'https' ? requestHttps : requestHttp)(requestOptions);
    let responseTimer: ReturnType<typeof setTimeout> | undefined;
    let receivedResponse = false;
    const clearResponseTimer = (): void => {
      if (responseTimer) clearTimeout(responseTimer);
      responseTimer = undefined;
    };
    upstream.once('finish', () => {
      if (receivedResponse) return;
      responseTimer = setTimeout(
        () => upstream.destroy(new Error('The upstream HTTP response handshake timed out.')),
        this.operationTimeoutMs,
      );
      responseTimer.unref?.();
    });
    upstream.once('response', (upstreamResponse) => {
      receivedResponse = true;
      clearResponseTimer();
      const observeResponseFailure = (releaseTransport: () => void): void => {
        let failed = false;
        const fail = (): void => {
          if (failed) return;
          failed = true;
          releaseTransport();
          // IncomingMessage does not forward source errors through pipe(). A
          // reset after headers would otherwise be an uncaught main-process
          // error and leave Chromium waiting on a response body that can never
          // finish. Close an already-started response (including a relayed 407)
          // so connection-bound authentication cannot continue on a dead socket.
          if (!response.headersSent && !response.destroyed) {
            response.writeHead(502);
            response.end();
          } else if (!response.destroyed) {
            response.destroy();
          }
          // ServerResponse may already have detached from a completed relayed
          // 407, making destroy() a no-op. Close the exact Chromium connection
          // as well so it cannot retry connection-bound credentials after the
          // challenged upstream transport has become unusable.
          request.socket.destroy();
        };
        upstreamResponse.once('error', fail);
        upstreamResponse.once('aborted', fail);
        upstreamResponse.once('close', () => {
          if (!upstreamResponse.complete) fail();
        });
      };
      if (upstreamResponse.statusCode === 407 && (route.kind === 'http' || route.kind === 'https')) {
        const challenges = proxyAuthenticationChallenges(upstreamResponse.headers['proxy-authenticate']);
        const prior = authenticated.boundAuthentication;
        const rounds = (prior?.rounds ?? 0) + 1;
        const expiresAt = prior?.expiresAt ?? Date.now() + UPSTREAM_PROXY_AUTH_TIMEOUT_MS;
        if (challenges.length === 0 || rounds > MAX_UPSTREAM_PROXY_AUTH_ROUNDS || expiresAt <= Date.now()) {
          const releaseTransport = prior
            ? () => this.releaseBoundUpstreamAuthentication(request.socket, prior)
            : () => agent.destroy();
          observeResponseFailure(releaseTransport);
          upstreamResponse.resume();
          releaseTransport();
          response.writeHead(502);
          response.end();
          return;
        }
        const bound = this.rememberBoundUpstreamAuthentication(request.socket, {
          authority: authenticated.authority,
          method: request.method ?? 'GET',
          target: request.url!,
          expiresAt,
          rounds,
          route,
          proxyTarget,
          socket,
          agent,
        });
        observeResponseFailure(() => this.releaseBoundUpstreamAuthentication(request.socket, bound));
        upstreamResponse.resume();
        response.writeHead(407, {
          'Proxy-Authenticate': challenges,
          Connection: 'keep-alive',
          'Content-Length': '0',
        });
        response.end();
        return;
      }
      if (authenticated.boundAuthentication) {
        this.releaseBoundUpstreamAuthentication(request.socket, authenticated.boundAuthentication, false);
      }
      let transportReleased = false;
      const releaseTransport = (): void => {
        if (transportReleased) return;
        transportReleased = true;
        agent.destroy();
      };
      observeResponseFailure(releaseTransport);
      upstreamResponse.once('end', releaseTransport);
      upstreamResponse.once('close', releaseTransport);
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.statusMessage, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    });
    upstream.once('error', () => {
      clearResponseTimer();
      if (authenticated.boundAuthentication) {
        this.releaseBoundUpstreamAuthentication(request.socket, authenticated.boundAuthentication);
      } else {
        agent.destroy();
      }
      if (!response.headersSent) response.writeHead(502);
      response.end();
    });
    request.pipe(upstream);
  }

  private async handleUpgrade(request: IncomingMessage, client: Socket, head: Buffer): Promise<void> {
    if (!request.url || request.url.length > MAX_PROXY_TARGET_CHARS) throw new Error('Invalid proxy upgrade target.');
    const target = new URL(request.url);
    if (target.protocol !== 'ws:' && target.protocol !== 'http:') {
      throw new Error('Secure WebSocket proxy requests must use CONNECT.');
    }
    const authenticated = this.authenticate(request, target.hostname);
    if (!authenticated) {
      this.rejectAuthentication(client);
      return;
    }
    const targetPort = target.port ? Number(target.port) : 80;
    const routes = await this.proxyRoutes(target.href.replace(/^ws:/, 'http:'));
    const opened = await this.openConnectTarget(
      routes,
      target.hostname,
      targetPort,
      authenticated.authority,
      client,
      request.method ?? 'GET',
      request.url,
    );
    const upstream = opened.socket;
    this.trackConnection(target.hostname, client, upstream);
    const retryHeaderRecord = opened.retryHeaders
      ? (Object.fromEntries(
          [...opened.retryHeaders].map(([name, values]) => [name, values.length === 1 ? values[0] : values]),
        ) as IncomingMessage['headers'])
      : undefined;
    const headers = stripProxyHeaders(retryHeaderRecord ?? request.headers);
    headers.host = target.host;
    const serializedHeaders = serializedHeaderLines(headers);
    upstream.write(
      `${request.method ?? 'GET'} ${target.pathname}${target.search} HTTP/1.1\r\n${serializedHeaders}\r\n\r\n`,
    );
    if (!opened.authenticationRetried && head.length > 0) upstream.write(head);
    client.pipe(upstream);
    upstream.pipe(client);
    upstream.once('error', () => client.destroy());
    client.once('error', () => upstream.destroy());
  }

  private start(): Promise<number> {
    if (this.closed) return Promise.reject(new Error('The Browser validating proxy is closed.'));
    if (this.port !== null) return Promise.resolve(this.port);
    if (this.startPromise) return this.startPromise;
    const server = createServer((request, response) => {
      void this.handleHttp(request, response).catch(() => {
        if (!response.headersSent) response.writeHead(502);
        response.end();
      });
    });
    this.server = server;
    const pending = new Promise<number>((resolve, reject) => {
      server.on('connection', (socket) => {
        this.clientSockets.add(socket);
        socket.once('close', () => this.clientSockets.delete(socket));
      });
      server.on('connect', (request, socket, head) => {
        void this.handleConnect(request, socket as Socket, head).catch(() => socket.destroy());
      });
      server.on('upgrade', (request, socket, head) => {
        void this.handleUpgrade(request, socket as Socket, head).catch(() => socket.destroy());
      });
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        if (this.closed) {
          server.close(() => reject(new Error('The Browser validating proxy closed during startup.')));
          return;
        }
        const address = server.address();
        if (!address || typeof address === 'string') {
          reject(new Error('The Browser validating proxy did not bind a TCP port.'));
          return;
        }
        this.port = address.port;
        resolve(address.port);
      });
    });
    let starting!: Promise<number>;
    starting = pending.catch(async (error: unknown) => {
      if (this.startPromise === starting) {
        this.port = null;
        if (this.server === server) this.server = null;
        // A malformed address or a shutdown race can reject after listen()
        // acquired a port. Retract it before allowing the serialized retry.
        if (server.listening) {
          await new Promise<void>((resolve) => server.close(() => resolve()));
        }
        if (this.startPromise === starting) this.startPromise = null;
      }
      throw error;
    });
    this.startPromise = starting;
    return starting;
  }
}
