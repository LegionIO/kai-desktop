import { createServer } from 'node:http';

/** Local controlled OAuth/MCP server; no external accounts or network access. */
export async function startMcpOAuthFixture(options: { dynamicRegistration?: boolean; refreshTokens?: boolean } = {}) {
  let origin = '',
    version = 0,
    refreshes = 0,
    registrations = 0;
  const clients = new Map<string, string[]>();
  const behavior = { rejectAccess: false, rejectRefresh: false };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', origin);
    const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === '/.well-known/oauth-protected-resource/mcp')
      return json({ resource: `${origin}/mcp`, authorization_servers: [origin], scopes_supported: ['read'] });
    if (url.pathname === '/.well-known/oauth-authorization-server')
      return json({
        issuer: origin,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        revocation_endpoint: `${origin}/revoke`,
        response_types_supported: ['code'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
        client_id_metadata_document_supported: !options.dynamicRegistration,
        ...(options.dynamicRegistration ? { registration_endpoint: `${origin}/register` } : {}),
        authorization_response_iss_parameter_supported: true,
      });
    if (url.pathname === '/register' && options.dynamicRegistration) {
      let body = '';
      for await (const chunk of req) body += chunk;
      const metadata = JSON.parse(body);
      const clientId = `fixture-client-${++registrations}`;
      clients.set(clientId, metadata.redirect_uris);
      return json({ ...metadata, client_id: clientId }, 201);
    }
    if (url.pathname === '/revoke') {
      res.writeHead(200).end();
      return;
    }
    if (url.pathname === '/authorize') {
      if (options.dynamicRegistration && !clients.has(url.searchParams.get('client_id')!))
        return json({ error: 'invalid_client' }, 400);
      if (
        options.dynamicRegistration &&
        !clients.get(url.searchParams.get('client_id')!)!.includes(url.searchParams.get('redirect_uri')!)
      )
        return json({ error: 'invalid_request' }, 400);
      const callback = new URL(url.searchParams.get('redirect_uri')!);
      callback.searchParams.set('state', url.searchParams.get('state')!);
      callback.searchParams.set('code', 'controlled-code');
      callback.searchParams.set('iss', origin);
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(
        `<title>Controlled OAuth sign-in</title><h1>Controlled sign-in</h1><a href="${callback.href.replaceAll('&', '&amp;').replaceAll('"', '&quot;')}">Authorize fixture</a>`,
      );
      return;
    }
    if (url.pathname === '/token') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const params = new URLSearchParams(body);
      if (options.dynamicRegistration && !clients.has(params.get('client_id')!))
        return json({ error: 'invalid_client' }, 400);
      if (params.get('grant_type') === 'refresh_token') {
        refreshes++;
        if (behavior.rejectRefresh) return json({ error: 'invalid_grant' }, 400);
      }
      behavior.rejectAccess = false;
      version++;
      return json({
        access_token: `fixture-access-${version}`,
        ...(options.refreshTokens === false ? {} : { refresh_token: `fixture-refresh-${version}` }),
        token_type: 'Bearer',
        expires_in: 3600,
        scope: 'read',
      });
    }
    if (url.pathname === '/mcp') {
      if (behavior.rejectAccess || req.headers.authorization !== `Bearer fixture-access-${version}` || version === 0) {
        return json({}, 401, {
          'WWW-Authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
        });
      }
      if (req.method !== 'POST') {
        res.writeHead(405).end();
        return;
      }
      let body = '';
      for await (const chunk of req) body += chunk;
      const message = JSON.parse(body);
      if (message.id === undefined) {
        res.writeHead(202).end();
        return;
      }
      const result =
        message.method === 'initialize'
          ? {
              protocolVersion: message.params.protocolVersion,
              capabilities: { tools: {} },
              serverInfo: { name: 'controlled-oauth', version: '1.0.0' },
            }
          : message.method === 'tools/list'
            ? { tools: [{ name: 'echo', description: 'Controlled echo tool', inputSchema: { type: 'object' } }] }
            : { content: [{ type: 'text', text: 'controlled result' }] };
      return json({ jsonrpc: '2.0', id: message.id, result });
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return {
    origin,
    behavior,
    refreshes: () => refreshes,
    registrations: () => registrations,
    loseRegistrations: () => clients.clear(),
    callback(authorizationUrl: string) {
      const auth = new URL(authorizationUrl),
        callback = new URL(auth.searchParams.get('redirect_uri')!);
      callback.searchParams.set('state', auth.searchParams.get('state')!);
      callback.searchParams.set('code', 'controlled-code');
      callback.searchParams.set('iss', origin);
      return callback.href;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
