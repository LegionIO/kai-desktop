import { createServer, request as requestHttp } from 'node:http';
import {
  createConnection,
  createServer as createNetServer,
  type AddressInfo,
  type Server as NetServer,
  type Socket,
} from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserValidatingProxy, parseBrowserProxyRoutes } from '../validating-proxy.js';

type RunningServer = ReturnType<typeof createServer>;

async function listen(server: RunningServer | NetServer): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return (server.address() as AddressInfo).port;
}

async function closeServer(server: RunningServer): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

async function closeNetServer(server: NetServer): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

async function readHeaderBlock(socket: Socket): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
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
      reject(new Error('Socket closed before an HTTP header block arrived.'));
    };
    const onData = (chunk: Buffer): void => {
      buffered = Buffer.concat([buffered, chunk]);
      const boundary = buffered.indexOf('\r\n\r\n');
      if (boundary === -1) return;
      cleanup();
      const end = boundary + 4;
      if (buffered.length > end) socket.unshift(buffered.subarray(end));
      resolve(buffered.subarray(0, end).toString('latin1'));
    };
    socket.on('data', onData);
    socket.once('error', onError);
    socket.once('close', onClose);
  });
}

async function connectSocket(port: number): Promise<Socket> {
  return await new Promise<Socket>((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.once('connect', () => resolve(socket));
    socket.once('error', reject);
  });
}

async function configureProxy(proxy: BrowserValidatingProxy): Promise<number> {
  let proxyRules = '';
  await proxy.configureSession({
    setProxy: vi.fn(async (config: { proxyRules: string }) => {
      proxyRules = config.proxyRules;
    }),
    closeAllConnections: vi.fn(async () => undefined),
  } as never);
  return Number(new URL(proxyRules).port);
}

function authorization(proxy: BrowserValidatingProxy, restrictPrivateNetwork = false): string {
  const credentials = proxy.credentials(restrictPrivateNetwork);
  return `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64')}`;
}

async function requestThroughProxy(
  proxyPort: number,
  targetUrl: string,
  proxyAuthorization?: string,
): Promise<{ status: number; body: string }> {
  return await new Promise((resolve, reject) => {
    const request = requestHttp({
      host: '127.0.0.1',
      port: proxyPort,
      method: 'GET',
      path: targetUrl,
      headers: proxyAuthorization ? { 'Proxy-Authorization': proxyAuthorization } : undefined,
    });
    request.once('response', (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.once('end', () =>
        resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }),
      );
    });
    request.once('error', reject);
    request.end();
  });
}

describe('Browser validating proxy', () => {
  const proxies: BrowserValidatingProxy[] = [];
  const servers: RunningServer[] = [];
  const netServers: NetServer[] = [];
  const sockets: Socket[] = [];

  afterEach(async () => {
    await Promise.allSettled(proxies.splice(0).map((proxy) => proxy.close()));
    await Promise.allSettled(servers.splice(0).map(closeServer));
    for (const socket of sockets.splice(0)) socket.destroy();
    await Promise.allSettled(netServers.splice(0).map(closeNetServer));
  });

  it('parses Chromium system and PAC proxy route lists without inventing a direct fallback', () => {
    expect(parseBrowserProxyRoutes('PROXY proxy.example:8080; SOCKS5 socks.example:1081; DIRECT')).toEqual([
      { kind: 'http', hostname: 'proxy.example', port: 8080 },
      { kind: 'socks5', hostname: 'socks.example', port: 1081 },
      { kind: 'direct' },
    ]);
    expect(parseBrowserProxyRoutes('UNSUPPORTED ignored.example:1')).toEqual([]);
    expect(() => parseBrowserProxyRoutes(`PROXY ${'a'.repeat(20_000)}`)).toThrow(/too large/i);
    expect(() => parseBrowserProxyRoutes('PROXY user:secret@proxy.example:8080')).toThrow(/invalid/i);
  });

  it('configures an authenticated non-bypassing Browser session', async () => {
    const proxy = new BrowserValidatingProxy();
    proxies.push(proxy);
    const setProxy = vi.fn(async () => undefined);
    const closeAllConnections = vi.fn(async () => undefined);
    const session = { setProxy, closeAllConnections } as never;

    await proxy.configureSession(session);
    await proxy.configureSession(session);

    expect(setProxy).toHaveBeenCalledOnce();
    expect(setProxy).toHaveBeenCalledWith({
      mode: 'fixed_servers',
      proxyRules: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/),
      proxyBypassRules: '<-loopback>',
    });
    expect(closeAllConnections).toHaveBeenCalledOnce();
  });

  it('uses a process-local realm to separate Kai credentials from upstream proxy authentication', async () => {
    const first = new BrowserValidatingProxy();
    const second = new BrowserValidatingProxy();
    proxies.push(first, second);
    await first.configureSession({
      setProxy: vi.fn(async () => undefined),
      closeAllConnections: vi.fn(async () => undefined),
    } as never);
    const realm = Reflect.get(first, 'authenticationRealm') as string;
    const secondRealm = Reflect.get(second, 'authenticationRealm') as string;
    const port = Reflect.get(first, 'port') as number;
    const endpoint = {
      isProxy: true,
      host: '127.0.0.1',
      port,
      scheme: 'basic',
    };

    expect(realm).toMatch(/^Kai Browser Network Guard [0-9a-f]{32}$/);
    expect(secondRealm).not.toBe(realm);
    expect(first.isAuthenticationChallenge({ ...endpoint, realm } as never)).toBe(true);
    expect(first.isUpstreamAuthenticationChallenge({ ...endpoint, realm } as never)).toBe(false);
    expect(first.isAuthenticationChallenge({ ...endpoint, realm: 'Kai Browser Network Guard' } as never)).toBe(false);
    expect(first.isUpstreamAuthenticationChallenge({ ...endpoint, realm: 'Enterprise Proxy' } as never)).toBe(true);
  });

  it('shares a failing session setup and retries it instead of caching the rejection', async () => {
    const proxy = new BrowserValidatingProxy();
    proxies.push(proxy);
    const start = vi
      .spyOn(proxy as unknown as { start(): Promise<number> }, 'start')
      .mockRejectedValueOnce(new Error('transient listener failure'))
      .mockResolvedValue(43123);
    const setProxy = vi.fn(async () => undefined);
    const closeAllConnections = vi.fn(async () => undefined);
    const session = { setProxy, closeAllConnections } as never;

    const first = proxy.configureSession(session);
    const concurrent = proxy.configureSession(session);
    expect(concurrent).toBe(first);
    await expect(Promise.all([first, concurrent])).rejects.toThrow('transient listener failure');
    expect(start).toHaveBeenCalledOnce();
    expect(setProxy).not.toHaveBeenCalled();

    await expect(proxy.configureSession(session)).resolves.toBeUndefined();
    expect(start).toHaveBeenCalledTimes(2);
    expect(setProxy).toHaveBeenCalledWith({
      mode: 'fixed_servers',
      proxyRules: 'http://127.0.0.1:43123',
      proxyBypassRules: '<-loopback>',
    });
    expect(closeAllConnections).toHaveBeenCalledOnce();
  });

  it('invalidates configured sessions after a runtime listener error and safely starts a replacement', async () => {
    const proxy = new BrowserValidatingProxy();
    proxies.push(proxy);
    const setProxy = vi.fn(async () => undefined);
    const closeAllConnections = vi.fn(async () => undefined);
    const targetSession = { setProxy, closeAllConnections } as never;

    await proxy.configureSession(targetSession);
    const failedServer = Reflect.get(proxy, 'server') as RunningServer;

    expect(() => failedServer.emit('error', new Error('runtime listener failure'))).not.toThrow();
    expect(Reflect.get(proxy, 'server')).toBeNull();
    expect(Reflect.get(proxy, 'port')).toBeNull();
    expect(Reflect.get(proxy, 'listenerGeneration')).toBe(1);
    // The permanent listener must consume delayed errors from the retired
    // server without invalidating a replacement or crashing the process.
    expect(() => failedServer.emit('error', new Error('late retired-listener failure'))).not.toThrow();

    await proxy.configureSession(targetSession);
    const replacementServer = Reflect.get(proxy, 'server') as RunningServer;
    const replacementPort = Reflect.get(proxy, 'port') as number;
    expect(replacementServer).not.toBe(failedServer);
    expect(replacementPort).toBeGreaterThan(0);
    expect(setProxy).toHaveBeenCalledTimes(2);
    expect(closeAllConnections).toHaveBeenCalledTimes(2);

    expect(() => failedServer.emit('error', new Error('stale listener failure'))).not.toThrow();
    expect(Reflect.get(proxy, 'server')).toBe(replacementServer);
    expect(Reflect.get(proxy, 'port')).toBe(replacementPort);
  });

  it.each(['setProxy', 'closeAllConnections'] as const)(
    'bounds a stalled session %s call, releases the shared setup, and allows retry',
    async (stalledOperation) => {
      vi.useFakeTimers();
      try {
        const proxy = new BrowserValidatingProxy(undefined, { operationTimeoutMs: 25 });
        proxies.push(proxy);
        vi.spyOn(proxy as unknown as { start(): Promise<number> }, 'start').mockResolvedValue(43123);
        const stalled = new Promise<void>(() => undefined);
        const setProxy =
          stalledOperation === 'setProxy'
            ? vi.fn().mockReturnValueOnce(stalled).mockResolvedValue(undefined)
            : vi.fn(async () => undefined);
        const closeAllConnections =
          stalledOperation === 'closeAllConnections'
            ? vi.fn().mockReturnValueOnce(stalled).mockResolvedValue(undefined)
            : vi.fn(async () => undefined);
        const session = { setProxy, closeAllConnections } as never;

        const first = proxy.configureSession(session);
        const concurrent = proxy.configureSession(session);
        expect(concurrent).toBe(first);
        const timedOut = expect(Promise.all([first, concurrent])).rejects.toThrow(/timed out/i);
        await vi.advanceTimersByTimeAsync(25);
        await timedOut;

        await expect(proxy.configureSession(session)).resolves.toBeUndefined();
        expect(setProxy).toHaveBeenCalledTimes(2);
        expect(closeAllConnections).toHaveBeenCalledTimes(stalledOperation === 'setProxy' ? 1 : 2);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it('closes a listener whose startup races proxy shutdown', async () => {
    const proxy = new BrowserValidatingProxy();
    proxies.push(proxy);
    const configured = proxy.configureSession({
      setProxy: vi.fn(async () => undefined),
      closeAllConnections: vi.fn(async () => undefined),
    } as never);

    await proxy.close();

    await expect(configured).rejects.toThrow(/closed during startup|closed/i);
    expect(Reflect.get(proxy, 'server')).toBeNull();
  });

  it('requires the random proxy credential and pins unrestricted connections to the resolved endpoint', async () => {
    const target = createServer((_request, response) => response.end('loopback-user-page'));
    servers.push(target);
    const targetPort = await listen(target);
    const proxy = new BrowserValidatingProxy();
    proxies.push(proxy);
    let proxyRules = '';
    await proxy.configureSession({
      setProxy: vi.fn(async (config: { proxyRules: string }) => {
        proxyRules = config.proxyRules;
      }),
      closeAllConnections: vi.fn(async () => undefined),
    } as never);
    const proxyPort = Number(new URL(proxyRules).port);
    const targetUrl = `http://127.0.0.1:${targetPort}/account`;

    await expect(requestThroughProxy(proxyPort, targetUrl)).resolves.toMatchObject({ status: 407 });
    await expect(requestThroughProxy(proxyPort, targetUrl, authorization(proxy))).resolves.toEqual({
      status: 200,
      body: 'loopback-user-page',
    });
  });

  it('blocks the exact private connection while an AI request is restricted and releases it at terminal state', async () => {
    const target = createServer((_request, response) => response.end('private-service'));
    servers.push(target);
    const targetPort = await listen(target);
    const proxy = new BrowserValidatingProxy();
    proxies.push(proxy);
    let proxyRules = '';
    await proxy.configureSession({
      setProxy: vi.fn(async (config: { proxyRules: string }) => {
        proxyRules = config.proxyRules;
      }),
      closeAllConnections: vi.fn(async () => undefined),
    } as never);
    const proxyPort = Number(new URL(proxyRules).port);
    const targetUrl = `http://127.0.0.1:${targetPort}/internal`;

    proxy.restrictRequest('global', 42, targetUrl);
    await expect(requestThroughProxy(proxyPort, targetUrl, authorization(proxy, true))).resolves.toMatchObject({
      status: 502,
    });
    // A global Browser profile can have an unrelated user tab loading another
    // private hostname concurrently. Restriction is scoped to the exact AI
    // request hostname rather than turning the shared profile into a global
    // private-network deny.
    await expect(
      requestThroughProxy(proxyPort, `http://localhost:${targetPort}/user-tab`, authorization(proxy)),
    ).resolves.toEqual({ status: 200, body: 'private-service' });

    proxy.releaseRequest('global', 42);
    await expect(requestThroughProxy(proxyPort, targetUrl, authorization(proxy))).resolves.toEqual({
      status: 200,
      body: 'private-service',
    });
  });

  it('permits an authenticated split-DNS HTTPS hostname to use its pinned private endpoint', async () => {
    const target = createNetServer((socket) => sockets.push(socket));
    netServers.push(target);
    const targetPort = await listen(target);
    const resolveHost = vi.fn(async (hostname: string) => {
      expect(hostname).toBe('secure.uhc.com');
      return [{ address: '127.0.0.1', family: 4 as const }];
    });
    const proxy = new BrowserValidatingProxy(undefined, { resolveHost });
    proxies.push(proxy);
    const proxyPort = await configureProxy(proxy);
    const client = await connectSocket(proxyPort);
    sockets.push(client);
    proxy.restrictRequest('global', 43, 'https://secure.uhc.com/account');

    client.write(
      `CONNECT secure.uhc.com:${targetPort} HTTP/1.1\r\nHost: secure.uhc.com:${targetPort}\r\nProxy-Authorization: ${authorization(proxy, true)}\r\n\r\n`,
    );

    await expect(readHeaderBlock(client)).resolves.toMatch(/^HTTP\/1\.1 200 Connection Established/);
    expect(resolveHost).toHaveBeenCalledOnce();
    proxy.releaseRequest('global', 43);
  });

  it('blocks localhost subdomains even when DNS resolves them to a reachable endpoint', async () => {
    const resolveHost = vi.fn(async (hostname: string) => {
      expect(hostname).toBe('api.localhost');
      return [{ address: '127.0.0.1', family: 4 as const }];
    });
    const proxy = new BrowserValidatingProxy(undefined, { resolveHost });
    proxies.push(proxy);
    const resolveEndpoints = Reflect.get(proxy, 'resolveEndpoints') as (
      hostname: string,
      restrictPrivateNetwork: boolean,
    ) => Promise<unknown>;

    await expect(resolveEndpoints.call(proxy, 'api.localhost', true)).rejects.toThrow(/private-network destination/i);
    expect(resolveHost).toHaveBeenCalledOnce();
  });

  it('keeps every same-host connection restricted until all assistant requests release', async () => {
    const target = createServer((_request, response) => response.end('trusted-user-page'));
    servers.push(target);
    const targetPort = await listen(target);
    const proxy = new BrowserValidatingProxy();
    proxies.push(proxy);
    let proxyRules = '';
    await proxy.configureSession({
      setProxy: vi.fn(async (config: { proxyRules: string }) => {
        proxyRules = config.proxyRules;
      }),
      closeAllConnections: vi.fn(async () => undefined),
    } as never);
    const proxyPort = Number(new URL(proxyRules).port);
    const targetUrl = `http://127.0.0.1:${targetPort}/same-host`;
    const credentialIssuedBeforeRestriction = authorization(proxy, false);
    const closeHostConnections = vi.spyOn(
      proxy as unknown as { closeHostConnections(hostname: string): void },
      'closeHostConnections',
    );

    proxy.restrictRequest('global', 1, targetUrl);
    proxy.restrictRequest('global', 2, targetUrl);
    expect(closeHostConnections).toHaveBeenCalledOnce();
    expect(closeHostConnections).toHaveBeenCalledWith('127.0.0.1');
    await expect(requestThroughProxy(proxyPort, targetUrl, authorization(proxy, true))).resolves.toMatchObject({
      status: 502,
    });
    await expect(requestThroughProxy(proxyPort, targetUrl, credentialIssuedBeforeRestriction)).resolves.toMatchObject({
      status: 502,
    });
    await expect(requestThroughProxy(proxyPort, targetUrl, authorization(proxy, false))).resolves.toMatchObject({
      status: 502,
    });

    proxy.releaseRequest('global', 1);
    await expect(requestThroughProxy(proxyPort, targetUrl, authorization(proxy, false))).resolves.toMatchObject({
      status: 502,
    });

    proxy.releaseRequest('global', 2);
    await expect(requestThroughProxy(proxyPort, targetUrl, authorization(proxy, false))).resolves.toEqual({
      status: 200,
      body: 'trusted-user-page',
    });
  });

  it('tries every validated DNS endpoint before failing a direct route', async () => {
    const target = createServer((_request, response) => response.end('second-address'));
    servers.push(target);
    const targetPort = await listen(target);
    const resolveHost = vi.fn(async () => [
      { address: '192.0.2.1', family: 4 as const },
      { address: '127.0.0.1', family: 4 as const },
    ]);
    const proxy = new BrowserValidatingProxy(undefined, { resolveHost, operationTimeoutMs: 50 });
    proxies.push(proxy);
    const proxyPort = await configureProxy(proxy);

    await expect(
      requestThroughProxy(proxyPort, `http://multi-address.test:${targetPort}/fallback`, authorization(proxy)),
    ).resolves.toEqual({ status: 200, body: 'second-address' });
    expect(resolveHost).toHaveBeenCalledOnce();
    expect(resolveHost).toHaveBeenCalledWith('multi-address.test');
  });

  it('chains through the system or PAC-selected upstream proxy instead of opening a direct target socket', async () => {
    let directTargetRequests = 0;
    const target = createServer((_request, response) => {
      directTargetRequests++;
      response.end('direct-target');
    });
    servers.push(target);
    const targetPort = await listen(target);
    let upstreamTarget = '';
    const upstreamProxy = createServer((request, response) => {
      upstreamTarget = request.url ?? '';
      response.end('system-proxy');
    });
    servers.push(upstreamProxy);
    const upstreamPort = await listen(upstreamProxy);
    const resolveProxy = vi.fn(async () => `PROXY 127.0.0.1:${upstreamPort}; DIRECT`);
    const proxy = new BrowserValidatingProxy(resolveProxy);
    proxies.push(proxy);
    let proxyRules = '';
    await proxy.configureSession({
      setProxy: vi.fn(async (config: { proxyRules: string }) => {
        proxyRules = config.proxyRules;
      }),
      closeAllConnections: vi.fn(async () => undefined),
    } as never);
    const proxyPort = Number(new URL(proxyRules).port);
    const targetUrl = `http://127.0.0.1:${targetPort}/through-pac`;

    await expect(requestThroughProxy(proxyPort, targetUrl, authorization(proxy))).resolves.toEqual({
      status: 200,
      body: 'system-proxy',
    });
    expect(resolveProxy).toHaveBeenCalledWith(targetUrl);
    expect(upstreamTarget).toBe(targetUrl);
    expect(directTargetRequests).toBe(0);
  });

  it('delegates unrestricted HTTP target DNS to the selected upstream proxy', async () => {
    let upstreamTarget = '';
    let upstreamHost = '';
    const upstreamProxy = createServer((request, response) => {
      upstreamTarget = request.url ?? '';
      upstreamHost = request.headers.host ?? '';
      response.end('proxy-only-dns');
    });
    servers.push(upstreamProxy);
    const upstreamPort = await listen(upstreamProxy);
    const resolveHost = vi.fn(async () => {
      throw new Error('The proxy-only target must not be resolved locally.');
    });
    const proxy = new BrowserValidatingProxy(async () => `PROXY 127.0.0.1:${upstreamPort}`, { resolveHost });
    proxies.push(proxy);
    const proxyPort = await configureProxy(proxy);
    const targetUrl = 'http://proxy-only.internal/path?from=kai';

    await expect(requestThroughProxy(proxyPort, targetUrl, authorization(proxy))).resolves.toEqual({
      status: 200,
      body: 'proxy-only-dns',
    });
    expect(resolveHost).not.toHaveBeenCalled();
    expect(upstreamTarget).toBe(targetUrl);
    expect(upstreamHost).toBe('proxy-only.internal');
  });

  it('delegates unrestricted CONNECT target DNS to the selected upstream proxy', async () => {
    let upstreamRequest = '';
    const upstreamProxy = createNetServer((socket) => {
      sockets.push(socket);
      void readHeaderBlock(socket).then((request) => {
        upstreamRequest = request;
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      });
    });
    netServers.push(upstreamProxy);
    const upstreamPort = await listen(upstreamProxy);
    const resolveHost = vi.fn(async () => {
      throw new Error('The proxy-only target must not be resolved locally.');
    });
    const proxy = new BrowserValidatingProxy(async () => `PROXY 127.0.0.1:${upstreamPort}`, { resolveHost });
    proxies.push(proxy);
    const proxyPort = await configureProxy(proxy);
    const client = await connectSocket(proxyPort);
    sockets.push(client);
    const target = 'proxy-only.internal:443';

    client.write(
      `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\nProxy-Authorization: ${authorization(proxy)}\r\n\r\n`,
    );
    await expect(readHeaderBlock(client)).resolves.toMatch(/^HTTP\/1\.1 200 Connection Established/);
    expect(resolveHost).not.toHaveBeenCalled();
    expect(upstreamRequest).toContain(`CONNECT ${target} HTTP/1.1`);
    expect(upstreamRequest).toContain(`Host: ${target}`);
  });

  it('locally validates and pins restricted HTTP targets sent through an upstream proxy', async () => {
    let upstreamTarget = '';
    let upstreamHost = '';
    const upstreamProxy = createServer((request, response) => {
      upstreamTarget = request.url ?? '';
      upstreamHost = request.headers.host ?? '';
      response.end('restricted-proxy-target');
    });
    servers.push(upstreamProxy);
    const upstreamPort = await listen(upstreamProxy);
    const resolveHost = vi.fn(async () => [{ address: '93.184.216.34', family: 4 as const }]);
    const proxy = new BrowserValidatingProxy(async () => `PROXY 127.0.0.1:${upstreamPort}`, { resolveHost });
    proxies.push(proxy);
    const proxyPort = await configureProxy(proxy);
    const targetUrl = 'http://restricted.example/path';
    const credentialIssuedBeforeRestriction = authorization(proxy, false);
    proxy.restrictRequest('global', 9, targetUrl);

    await expect(requestThroughProxy(proxyPort, targetUrl, credentialIssuedBeforeRestriction)).resolves.toEqual({
      status: 200,
      body: 'restricted-proxy-target',
    });
    expect(resolveHost).toHaveBeenCalledWith('restricted.example');
    expect(upstreamTarget).toBe('http://93.184.216.34/path');
    expect(upstreamHost).toBe('restricted.example');
  });

  it('falls back through PAC routes when an earlier proxy cannot connect', async () => {
    const unavailableProxy = createServer();
    const unavailablePort = await listen(unavailableProxy);
    await closeServer(unavailableProxy);
    const target = createServer((_request, response) => response.end('pac-direct-fallback'));
    servers.push(target);
    const targetPort = await listen(target);
    const proxy = new BrowserValidatingProxy(async () => `PROXY 127.0.0.1:${unavailablePort}; DIRECT`);
    proxies.push(proxy);
    const proxyPort = await configureProxy(proxy);

    await expect(
      requestThroughProxy(proxyPort, `http://127.0.0.1:${targetPort}/fallback`, authorization(proxy)),
    ).resolves.toEqual({ status: 200, body: 'pac-direct-fallback' });
  });

  it('bounds stalled proxy resolution and SOCKS handshakes and releases pending sockets', async () => {
    const stalledResolverProxy = new BrowserValidatingProxy(async () => await new Promise<string>(() => undefined), {
      operationTimeoutMs: 25,
    });
    proxies.push(stalledResolverProxy);
    const resolverPort = await configureProxy(stalledResolverProxy);
    await expect(
      requestThroughProxy(resolverPort, 'http://127.0.0.1:9/stalled-pac', authorization(stalledResolverProxy)),
    ).resolves.toMatchObject({ status: 502 });

    const stalledSocks = createNetServer((socket) => sockets.push(socket));
    netServers.push(stalledSocks);
    const socksPort = await listen(stalledSocks);
    const socksProxy = new BrowserValidatingProxy(async () => `SOCKS5 127.0.0.1:${socksPort}`, {
      operationTimeoutMs: 25,
    });
    proxies.push(socksProxy);
    const localPort = await configureProxy(socksProxy);
    await expect(
      requestThroughProxy(localPort, 'http://127.0.0.1:9/stalled-socks', authorization(socksProxy)),
    ).resolves.toMatchObject({ status: 502 });
    await vi.waitFor(() => expect(Reflect.get(socksProxy, 'pendingSocketsByHost').size).toBe(0));
  });

  it('bounds a stalled upstream CONNECT handshake and releases its socket', async () => {
    const stalledUpstream = createNetServer((socket) => sockets.push(socket));
    netServers.push(stalledUpstream);
    const upstreamPort = await listen(stalledUpstream);
    const proxy = new BrowserValidatingProxy(async () => `PROXY 127.0.0.1:${upstreamPort}`, {
      operationTimeoutMs: 25,
    });
    proxies.push(proxy);
    const proxyPort = await configureProxy(proxy);
    const client = await connectSocket(proxyPort);
    sockets.push(client);
    const target = '127.0.0.1:443';

    client.write(
      `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\nProxy-Authorization: ${authorization(proxy)}\r\n\r\n`,
    );
    await expect(readHeaderBlock(client)).rejects.toThrow(/closed/i);
    await vi.waitFor(() => expect(Reflect.get(proxy, 'pendingSocketsByHost').size).toBe(0));
  });

  it('relays upstream HTTP proxy authentication without exposing the Kai credential', async () => {
    const observedAuthorizations: Array<string | undefined> = [];
    const upstreamProxy = createServer((request, response) => {
      observedAuthorizations.push(request.headers['proxy-authorization']);
      if (request.headers['proxy-authorization'] !== 'Basic upstream-secret') {
        response.writeHead(407, {
          'Proxy-Authenticate': 'Basic realm="Enterprise Proxy"',
          Connection: 'keep-alive',
          'Content-Length': '0',
        });
        response.end();
        return;
      }
      response.writeHead(200, { 'Content-Length': '0' });
      response.end();
    });
    servers.push(upstreamProxy);
    const upstreamPort = await listen(upstreamProxy);
    const proxy = new BrowserValidatingProxy(async () => `PROXY 127.0.0.1:${upstreamPort}`);
    proxies.push(proxy);
    const proxyPort = await configureProxy(proxy);
    const client = await connectSocket(proxyPort);
    sockets.push(client);
    const target = 'http://127.0.0.1:9/authenticated';

    client.write(
      `GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:9\r\nConnection: keep-alive\r\nProxy-Authorization: ${authorization(proxy)}\r\n\r\n`,
    );
    await expect(readHeaderBlock(client)).resolves.toContain('Proxy-Authenticate: Basic realm="Enterprise Proxy"');
    client.write(
      `GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:9\r\nConnection: close\r\nProxy-Authorization: Basic upstream-secret\r\n\r\n`,
    );
    await expect(readHeaderBlock(client)).resolves.toMatch(/^HTTP\/1\.1 200/);

    expect(observedAuthorizations).toEqual([undefined, 'Basic upstream-secret']);
  });

  it('keeps multi-round HTTP proxy authentication on the connection that issued the challenge', async () => {
    const upstreamRequests: string[] = [];
    let upstreamConnections = 0;
    let upstreamSocket: Socket | undefined;
    const upstreamProxy = createNetServer((socket) => {
      upstreamConnections++;
      upstreamSocket = socket;
      sockets.push(socket);
      let buffered = Buffer.alloc(0);
      socket.on('data', (chunk: Buffer) => {
        buffered = Buffer.concat([buffered, chunk]);
        while (true) {
          const boundary = buffered.indexOf('\r\n\r\n');
          if (boundary === -1) return;
          const end = boundary + 4;
          const request = buffered.subarray(0, end).toString('latin1');
          buffered = buffered.subarray(end);
          upstreamRequests.push(request);
          if (upstreamRequests.length === 1) {
            socket.write(
              'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Negotiate challenge-one\r\nConnection: keep-alive\r\nContent-Length: 0\r\n\r\n',
            );
          } else if (upstreamRequests.length === 2) {
            socket.write(
              'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Negotiate challenge-two\r\nConnection: keep-alive\r\nContent-Length: 0\r\n\r\n',
            );
          } else {
            socket.write('HTTP/1.1 200 OK\r\nConnection: keep-alive\r\nContent-Length: 0\r\n\r\n');
          }
        }
      });
    });
    netServers.push(upstreamProxy);
    const upstreamPort = await listen(upstreamProxy);
    const proxy = new BrowserValidatingProxy(async () => `PROXY 127.0.0.1:${upstreamPort}`);
    proxies.push(proxy);
    const proxyPort = await configureProxy(proxy);
    const client = await connectSocket(proxyPort);
    sockets.push(client);
    const target = 'http://connection-auth.example/resource';

    client.write(
      `GET ${target} HTTP/1.1\r\nHost: connection-auth.example\r\nConnection: keep-alive\r\nProxy-Authorization: ${authorization(proxy)}\r\n\r\n`,
    );
    await expect(readHeaderBlock(client)).resolves.toContain('Proxy-Authenticate: Negotiate challenge-one');
    client.write(
      `GET ${target} HTTP/1.1\r\nHost: connection-auth.example\r\nConnection: keep-alive\r\nProxy-Authorization: Negotiate response-one\r\n\r\n`,
    );
    await expect(readHeaderBlock(client)).resolves.toContain('Proxy-Authenticate: Negotiate challenge-two');
    client.write(
      `GET ${target} HTTP/1.1\r\nHost: connection-auth.example\r\nConnection: keep-alive\r\nProxy-Authorization: Negotiate response-two\r\n\r\n`,
    );
    await expect(readHeaderBlock(client)).resolves.toMatch(/^HTTP\/1\.1 200/);
    await vi.waitFor(() => expect(upstreamSocket?.destroyed).toBe(true));

    expect(upstreamConnections).toBe(1);
    expect(upstreamRequests).toHaveLength(3);
    expect(upstreamRequests[0]).not.toMatch(/proxy-authorization:/i);
    expect(upstreamRequests[1]).toMatch(/proxy-authorization: Negotiate response-one/i);
    expect(upstreamRequests[2]).toMatch(/proxy-authorization: Negotiate response-two/i);
  });

  it.each([
    ['ordinary response', 'HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\npartial'],
    [
      'authentication challenge',
      'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Negotiate challenge\r\nConnection: keep-alive\r\nContent-Length: 100\r\n\r\npartial',
    ],
  ] as const)(
    'closes Chromium and releases transport when an upstream %s aborts after headers',
    async (_label, reply) => {
      let upstreamSocket: Socket | undefined;
      const upstreamProxy = createNetServer((socket) => {
        upstreamSocket = socket;
        sockets.push(socket);
        socket.once('data', () => {
          socket.write(reply, () => socket.destroy());
        });
      });
      netServers.push(upstreamProxy);
      const upstreamPort = await listen(upstreamProxy);
      const proxy = new BrowserValidatingProxy(async () => `PROXY 127.0.0.1:${upstreamPort}`);
      proxies.push(proxy);
      const proxyPort = await configureProxy(proxy);
      const client = await connectSocket(proxyPort);
      sockets.push(client);
      const closed = new Promise<void>((resolve) => client.once('close', () => resolve()));
      const target = 'http://aborted-upstream.example/resource';

      client.write(
        `GET ${target} HTTP/1.1\r\nHost: aborted-upstream.example\r\nConnection: keep-alive\r\nProxy-Authorization: ${authorization(proxy)}\r\n\r\n`,
      );
      await expect(readHeaderBlock(client)).resolves.toMatch(/^HTTP\/1\.1 (?:200|407)/);
      await expect(closed).resolves.toBeUndefined();
      await vi.waitFor(() => expect(upstreamSocket?.destroyed).toBe(true));
      expect((Reflect.get(proxy, 'boundUpstreamAuthentication') as WeakMap<Socket, unknown>).has(client)).toBe(false);
    },
  );

  it('expires a connection-bound HTTP proxy challenge without opening a fallback connection', async () => {
    let upstreamConnections = 0;
    let upstreamSocket: Socket | undefined;
    const upstreamProxy = createNetServer((socket) => {
      upstreamConnections++;
      upstreamSocket = socket;
      sockets.push(socket);
      socket.once('data', () => {
        socket.write(
          'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Negotiate challenge\r\nConnection: keep-alive\r\nContent-Length: 0\r\n\r\n',
        );
      });
    });
    netServers.push(upstreamProxy);
    const upstreamPort = await listen(upstreamProxy);
    const proxy = new BrowserValidatingProxy(async () => `PROXY 127.0.0.1:${upstreamPort}`);
    proxies.push(proxy);
    const proxyPort = await configureProxy(proxy);
    const client = await connectSocket(proxyPort);
    sockets.push(client);
    const target = 'http://connection-auth.example/resource';

    client.write(
      `GET ${target} HTTP/1.1\r\nHost: connection-auth.example\r\nConnection: keep-alive\r\nProxy-Authorization: ${authorization(proxy)}\r\n\r\n`,
    );
    await expect(readHeaderBlock(client)).resolves.toContain('Proxy-Authenticate: Negotiate challenge');

    const serverClient = [...(Reflect.get(proxy, 'clientSockets') as Set<Socket>)][0]!;
    const bound = (Reflect.get(proxy, 'boundUpstreamAuthentication') as WeakMap<Socket, { expiresAt: number }>).get(
      serverClient,
    );
    expect(bound).toBeDefined();
    bound!.expiresAt = Date.now() - 1;
    client.write(
      `GET ${target} HTTP/1.1\r\nHost: connection-auth.example\r\nConnection: keep-alive\r\nProxy-Authorization: Negotiate late-response\r\n\r\n`,
    );

    const rejection = await readHeaderBlock(client);
    expect(rejection).toContain('407 Proxy Authentication Required');
    expect(rejection).toContain('Kai Browser Network Guard');
    await vi.waitFor(() => expect(upstreamSocket?.destroyed).toBe(true));
    expect(upstreamConnections).toBe(1);
  });

  it('relays multi-round opaque upstream authentication on one CONNECT socket', async () => {
    const upstreamRequests: string[] = [];
    let upstreamConnections = 0;
    const upstreamProxy = createNetServer((socket) => {
      upstreamConnections++;
      sockets.push(socket);
      let buffered = Buffer.alloc(0);
      socket.on('data', (chunk: Buffer) => {
        buffered = Buffer.concat([buffered, chunk]);
        while (true) {
          const boundary = buffered.indexOf('\r\n\r\n');
          if (boundary === -1) return;
          const end = boundary + 4;
          const request = buffered.subarray(0, end).toString('latin1');
          buffered = buffered.subarray(end);
          upstreamRequests.push(request);
          if (upstreamRequests.length === 1) {
            socket.write(
              'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Negotiate challenge-one\r\nConnection: keep-alive\r\nContent-Length: 0\r\n\r\n',
            );
          } else if (upstreamRequests.length === 2) {
            socket.write(
              'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Negotiate challenge-two\r\nConnection: keep-alive\r\nContent-Length: 0\r\n\r\n',
            );
          } else {
            socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          }
        }
      });
    });
    netServers.push(upstreamProxy);
    const upstreamPort = await listen(upstreamProxy);
    const proxy = new BrowserValidatingProxy(async () => `PROXY 127.0.0.1:${upstreamPort}`);
    proxies.push(proxy);
    const proxyPort = await configureProxy(proxy);
    const client = await connectSocket(proxyPort);
    sockets.push(client);
    const target = '127.0.0.1:443';

    client.write(
      `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\nProxy-Authorization: ${authorization(proxy)}\r\n\r\n`,
    );
    await expect(readHeaderBlock(client)).resolves.toContain('Proxy-Authenticate: Negotiate challenge-one');
    client.write(
      `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\nProxy-Authorization: Negotiate response-one\r\n\r\n`,
    );
    await expect(readHeaderBlock(client)).resolves.toContain('Proxy-Authenticate: Negotiate challenge-two');
    client.write(
      `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\nProxy-Authorization: Negotiate response-two\r\n\r\n`,
    );
    await expect(readHeaderBlock(client)).resolves.toMatch(/^HTTP\/1\.1 200 Connection Established/);

    expect(upstreamConnections).toBe(1);
    expect(upstreamRequests).toHaveLength(3);
    expect(upstreamRequests[1]).toContain('Proxy-Authorization: Negotiate response-one');
    expect(upstreamRequests[2]).toContain('Proxy-Authorization: Negotiate response-two');
  });
});
