import express, { type Request, type Response, type NextFunction } from 'express';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { TLSSocket } from 'node:tls';
import { randomUUID } from 'node:crypto';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { SharingCredentials } from './credentials.js';
import { KaiOAuthProvider } from './oauth.js';
import type { KaiMcpService, McpPrincipal } from './service.js';

const ROUTES = new Set([
  '/mcp',
  '/mcp/consent',
  '/authorize',
  '/token',
  '/register',
  '/revoke',
  '/.well-known/oauth-authorization-server',
  '/.well-known/oauth-protected-resource/mcp',
  '/.well-known/oauth-protected-resource',
]);
type RemoteSession = {
  principal: McpPrincipal;
  transport: StreamableHTTPServerTransport;
  server: Server;
  touchedAt: number;
};

export class RemoteMcpEndpoint {
  readonly provider: KaiOAuthProvider;
  private readonly browserSessions = new WeakMap<IncomingMessage, string>();
  private readonly sessions = new Map<string, RemoteSession>();
  private router?: ReturnType<typeof express>;
  private routerUrl = '';
  private readonly rates = new Map<string, { at: number; count: number }>();
  constructor(
    private readonly service: KaiMcpService,
    private readonly credentials: SharingCredentials,
  ) {
    this.provider = new KaiOAuthProvider(credentials, (req) => this.browserSessions.get(req));
  }
  handle(req: IncomingMessage, res: ServerResponse, browserSession?: string): boolean {
    const path = (req.url ?? '/').split('?')[0];
    if (!ROUTES.has(path)) return false;
    if (!this.service.enabled() || !this.credentials.remoteReady()) {
      res.writeHead(404);
      res.end('Kai remote MCP sharing is disabled.');
      return true;
    }
    if (!(req.socket as TLSSocket).encrypted) {
      res.writeHead(403);
      res.end('Kai MCP requires HTTPS.');
      return true;
    }
    const origin = req.headers.origin;
    if (origin && origin !== new URL(this.credentials.publicUrl()).origin) {
      res.writeHead(403);
      res.end('Untrusted MCP request origin.');
      return true;
    }
    const key = req.socket.remoteAddress ?? 'unknown';
    const now = Date.now();
    for (const [address, rate] of this.rates) if (now - rate.at >= 60_000) this.rates.delete(address);
    const rate = this.rates.get(key) ?? { at: now, count: 0 };
    if (++rate.count > 300 || (!this.rates.has(key) && this.rates.size >= 1000)) {
      res.writeHead(429, { 'Retry-After': '60' });
      res.end('MCP request rate limit reached.');
      return true;
    }
    this.rates.set(key, rate);
    if (browserSession) this.browserSessions.set(req, browserSession);
    if (!this.router || this.routerUrl !== this.credentials.publicUrl()) this.buildRouter();
    this.router!(req, res);
    return true;
  }
  private buildRouter(): void {
    const url = new URL(this.credentials.publicUrl());
    this.routerUrl = url.href;
    const app = express();
    app.disable('x-powered-by');
    app.set('trust proxy', false);
    app.use(express.urlencoded({ extended: false, limit: '16kb' }));
    app.use(express.json({ limit: '4mb' }));
    app.use((_req, res, next) => {
      res.setHeader('Cache-Control', 'no-store');
      next();
    });
    app.get('/mcp/consent', (req, res) => this.provider.consent(req, res));
    app.post('/mcp/consent', (req, res) => this.provider.completeConsent(req, res));
    app.use(
      mcpAuthRouter({
        provider: this.provider,
        issuerUrl: new URL(url.origin),
        resourceServerUrl: url,
        scopesSupported: ['kai:tools'],
        resourceName: 'Kai shared tools',
        clientRegistrationOptions: { rateLimit: { windowMs: 60_000, max: 10 } },
      }),
    );
    app.all('/mcp', (req, res) => {
      void this.mcp(req, res).catch(() => {
        if (!res.headersSent) res.status(500).json({ error: 'MCP request failed.' });
      });
    });
    app.use((_error: unknown, _req: Request, res: Response, _next: NextFunction) => {
      if (!res.headersSent) res.status(400).json({ error: 'Invalid MCP request.' });
    });
    this.router = app;
  }
  private async mcp(req: Request, res: Response): Promise<void> {
    const bearer = /^Bearer ([A-Za-z0-9_-]+)$/i.exec(req.get('Authorization') ?? '')?.[1];
    const principal = bearer ? this.credentials.verify(bearer, 'remote') : null;
    if (!principal || !this.service.enabled()) {
      res.setHeader(
        'WWW-Authenticate',
        `Bearer resource_metadata="${new URL('/.well-known/oauth-protected-resource/mcp', this.credentials.publicUrl()).href}"`,
      );
      res.status(401).json({ error: 'A valid Kai MCP credential is required.' });
      return;
    }
    const sessionId = req.get('Mcp-Session-Id');
    if (sessionId) {
      const session = this.sessions.get(sessionId);
      if (
        !session ||
        session.principal.clientId !== principal.clientId ||
        session.principal.credentialHash !== principal.credentialHash
      ) {
        res.status(404).json({ error: 'MCP session not found. Reconnect after refreshing credentials.' });
        return;
      }
      session.touchedAt = Date.now();
      await session.transport.handleRequest(req, res, req.body);
      return;
    }
    if (req.method !== 'POST' || !isInitializeRequest(req.body)) {
      res.status(400).json({ error: 'Initialize an MCP session first.' });
      return;
    }
    if (this.sessions.size >= 100) {
      res.status(429).json({ error: 'Kai MCP session limit reached.' });
      return;
    }
    const id = randomUUID();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => id });
    const server = await this.service.connect(principal, transport, id);
    this.sessions.set(id, { principal, server, transport, touchedAt: Date.now() });
    const previousClose = server.onclose;
    server.onclose = () => {
      previousClose?.();
      this.sessions.delete(id);
    };
    try {
      await transport.handleRequest(req, res, req.body);
    } catch {
      this.sessions.delete(id);
      await server.close();
      throw new Error('MCP initialization failed.');
    }
  }
  sweep(): void {
    for (const [id, session] of this.sessions) {
      if (
        !this.service.enabled() ||
        !this.credentials.active(session.principal) ||
        Date.now() - session.touchedAt > 60 * 60_000
      ) {
        this.sessions.delete(id);
        void session.server.close();
      }
    }
  }
  async close(): Promise<void> {
    this.provider.clear();
    await Promise.allSettled([...this.sessions.values()].map((session) => session.server.close()));
    this.sessions.clear();
    this.router = undefined;
  }
}
