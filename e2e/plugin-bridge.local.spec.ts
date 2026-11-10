import { test, expect, chromium, _electron as electron } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Agent, fetch as undiciFetch } from 'undici';
import { createServer } from 'node:net';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { launchElectronForSmoke, type ElectronHandle } from './electron-launcher';
import { installMcp, installSkill, writeBridgeFile } from '../test-utils/plugin-bridge-files';
import type { PluginBridgeApi } from '../shared/plugin-bridge';
import { LocalBridgeClient } from '../electron/cli/client';

type ApiWindow = Window & {
  app: {
    pluginBridge: PluginBridgeApi;
    config: {
      get(): Promise<Record<string, unknown>>;
      set(path: string, value: unknown): Promise<void>;
    };
  };
};

let handle: ElectronHandle;
let fixtureRoot: string;
let nextApproval: 'approve' | 'cancel' = 'approve';
const approvalChecks: Promise<void>[] = [];
test.beforeAll(async () => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'kai-bridge-browser-'));
  handle = await launchElectronForSmoke({ relativeEntry: true });
  await handle.app.evaluate(({ safeStorage }) => {
    // Test only: no real keychain prompts or credentials.
    safeStorage.encryptString = () => {
      throw new Error('Controlled unavailable keychain');
    };
  });
  handle.app.on('window', (approval) => {
    const check = (async () => {
      await approval.waitForURL(/\/bridge-approval\/index\.html$/);
      await expect(approval.getByRole('alertdialog')).toBeVisible();
      expect(
        await approval.evaluate(() => ({
          app: typeof (window as unknown as ApiWindow).app,
          node: typeof (window as unknown as { require: unknown }).require,
        })),
      ).toEqual({ app: 'undefined', node: 'undefined' });
      await expect(approval.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
      await expect(approval.getByRole('button', { name: 'Approve changes' })).toBeInViewport();
      const choice = nextApproval;
      nextApproval = 'approve';
      await approval
        .getByRole('button', { name: choice === 'approve' ? 'Approve changes' : 'Cancel', exact: true })
        .click();
    })();
    approvalChecks.push(check);
    void check.catch(() => {}); // Report all failures at the test boundary.
  });
  await handle.page.waitForFunction(() => !!(window as unknown as ApiWindow).app?.pluginBridge);
});
test.afterAll(async () => {
  await handle?.close();
  if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
});
test.afterEach(async () => {
  await Promise.all(approvalChecks);
});

test('headless backend suppresses plugin windows without destroying a native constructor', async () => {
  const userData = join(fixtureRoot, 'headless');
  const backend = await electron.launch({
    args: [resolve('out/main/index.js'), '--kai-headless', ...(process.platform === 'linux' ? ['--no-sandbox'] : [])],
    env: { ...process.env, KAI_USER_DATA: userData, NODE_ENV: 'test', ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
  });
  let connection: LocalBridgeClient | undefined;
  try {
    await backend.evaluate(({ app }) => app.whenReady());
    const run = join(userData, 'run');
    await expect.poll(() => existsSync(join(run, 'kai.sock'))).toBe(true);
    // This fixture uses the normal CLI connection to keep its headless backend
    // alive while it exercises real Electron window construction.
    writeBridgeFile(join(run, 'bridge.token'), 'headless-fixture-token');
    connection = new LocalBridgeClient(join(run, 'kai.sock'), 'headless-fixture-token');
    await expect
      .poll(async () => {
        try {
          await connection!.connect();
          return true;
        } catch {
          return false;
        }
      })
      .toBe(true);
    const outcome = await backend.evaluate(
      ({ BrowserWindow }) =>
        new Promise((resolveOnce) => {
          const win = new BrowserWindow({ show: false });
          const constructorReturned = !win.isDestroyed();
          win.show();
          win.showInactive();
          const stayedHidden = !win.isVisible();
          win.once('closed', () => resolveOnce({ constructorReturned, stayedHidden }));
        }),
    );
    expect(outcome).toEqual({ constructorReturned: true, stayedHidden: true });
    expect(await connection.invoke('config:get')).toBeTruthy();
  } finally {
    await connection?.requestShutdown().catch(() => {});
    connection?.close();
    await backend.close().catch(() => {});
  }
});

test('human settings, installed packages, stdio and authenticated HTTPS sharing', async ({}, testInfo) => {
  const page = handle.page;
  const homes = { claude: join(fixtureRoot, 'claude'), codex: join(fixtureRoot, 'codex') };
  const packageRoot = join(homes.codex, 'plugins/cache/fixture/sample/1.0.0');
  mkdirSync(homes.claude, { recursive: true });
  writeBridgeFile(join(packageRoot, '.codex-plugin/plugin.json'), {
    name: 'sample',
    version: '1.0.0',
    description: 'Local MCP fixture',
  });
  installSkill(packageRoot);
  const mcp = installMcp(packageRoot);
  const codexConfig = '# Preserve this comment\nmodel = "fixture-model"\n[plugins."sample@fixture"]\nenabled=true\n';
  writeBridgeFile(join(homes.codex, 'config.toml'), codexConfig);
  writeBridgeFile(join(homes.claude, '.claude.json'), {
    fixturePreference: 'preserved',
    mcpServers: { existing: { command: 'fixture' } },
  });

  expect(await page.evaluate(() => (window as unknown as ApiWindow).app.pluginBridge.snapshot())).toMatchObject({
    importsEnabled: false,
    sharingEnabled: false,
    remoteEnabled: false,
    plugins: [],
  });
  nextApproval = 'cancel';
  const cancelled = await page.evaluate(async () => {
    try {
      await (window as unknown as ApiWindow).app.pluginBridge.mutate({ action: 'imports', enabled: true });
    } catch (error) {
      return String(error);
    }
  });
  expect(cancelled).toContain('Bridge change cancelled.');
  expect((await page.evaluate(() => (window as unknown as ApiWindow).app.pluginBridge.snapshot())).importsEnabled).toBe(
    false,
  );
  await page.evaluate(
    (homes) => (window as unknown as ApiWindow).app.pluginBridge.mutate({ action: 'homes', ...homes }),
    homes,
  );
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent('kai:open-settings'));
    window.dispatchEvent(new CustomEvent('kai:navigate-settings', { detail: { section: 'plugin-bridge' } }));
  });
  const importSwitch = page.getByRole('switch', { name: 'Import installed plugins' });
  await expect(importSwitch).toHaveAttribute('data-state', 'unchecked');
  await importSwitch.click();
  await expect(page.getByRole('heading', { name: 'sample', exact: true })).toBeVisible();
  expect(mcp.starts()).toEqual([]);
  await page.getByRole('button', { name: 'Review', exact: true }).click();
  await page.getByRole('button', { name: 'Skills + MCP', exact: true }).click();
  await page.getByRole('button', { name: 'Save component approvals', exact: true }).click();
  await expect(page.getByText('2 approved', { exact: false })).toBeVisible();
  expect(mcp.starts().length).toBe(1);
  const imported = await page.evaluate(() => (window as unknown as ApiWindow).app.pluginBridge.snapshot());
  expect(imported.sharingEnabled).toBe(false);
  expect(
    imported.sources.filter((s) => s.imported).every((s) => !s.selected && s.tools.every((t) => !t.selected)),
  ).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('plugin-bridge-review.png'), fullPage: true });
  await page.getByRole('heading', { name: 'Plugin Bridge', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('plugin-bridge-imports.png'), fullPage: true });

  await page.getByRole('tab', { name: 'Share Kai', exact: true }).click();
  await page.getByRole('switch', { name: 'Share Kai through MCP' }).click();
  await expect(page.getByRole('switch', { name: 'Share Kai through MCP' })).toHaveAttribute('data-state', 'checked');
  const source = imported.sources.find((s) => s.tools.some((t) => t.id.endsWith('/echo')))!;
  const echo = source.tools.find((t) => t.id.endsWith('/echo'))!;
  await page.evaluate(
    (id) => (window as unknown as ApiWindow).app.pluginBridge.mutate({ action: 'exports', sources: [], tools: [id] }),
    echo.id,
  );
  const setup = await page.evaluate(async () => {
    const api = (window as unknown as ApiWindow).app.pluginBridge;
    const preview = await api.previewClient('claude');
    await api.applyClient(preview.id, true);
    return preview;
  });
  const claudeConfig = JSON.parse(readFileSync(setup.path, 'utf8'));
  expect(claudeConfig.fixturePreference).toBe('preserved');
  expect(claudeConfig.mcpServers.existing).toEqual({ command: 'fixture' });
  const launch = claudeConfig.mcpServers['kai-mcp'] as { command: string; args: string[]; env: Record<string, string> };
  const client = new Client({ name: 'fixture-stdio-client', version: '1' });
  const transport = new StdioClientTransport({
    command: launch.command,
    args: launch.args,
    cwd: fixtureRoot,
    env: { PATH: process.env.PATH ?? '', ...launch.env },
    stderr: 'pipe',
  });
  const diagnostics: string[] = [];
  transport.stderr?.on('data', (data) => diagnostics.push(String(data)));
  try {
    await client.connect(transport);
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual([echo.name]);
    expect(await client.callTool({ name: echo.name, arguments: { value: 'stdio fixture' } })).toMatchObject({
      structuredContent: { input: { value: 'stdio fixture' } },
    });
    await page.evaluate(() =>
      (window as unknown as ApiWindow).app.pluginBridge.mutate({ action: 'exports', sources: [], tools: [] }),
    );
    expect((await client.listTools()).tools).toEqual([]);
    await expect(client.callTool({ name: echo.name, arguments: {} })).rejects.toThrow();
  } finally {
    await client.close();
  }
  expect(diagnostics.join('')).not.toContain('SyntaxError');
  await Promise.all(approvalChecks);
  expect(readFileSync(join(homes.codex, 'config.toml'), 'utf8')).toBe(codexConfig);
  const codexSetup = await page.evaluate(async () => {
    const api = (window as unknown as ApiWindow).app.pluginBridge;
    const preview = await api.previewClient('codex');
    await api.applyClient(preview.id, true);
    return preview;
  });
  const configuredCodex = readFileSync(codexSetup.path, 'utf8');
  expect(configuredCodex).toContain('# Preserve this comment');
  expect(parseToml(configuredCodex).model).toBe('fixture-model');

  const probe = createServer();
  await new Promise<void>((done) => probe.listen(0, '127.0.0.1', done));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((done) => probe.close(() => done()));
  const origin = `https://127.0.0.1:${port}`;
  await page.evaluate(
    async ({ port, url, tool }) => {
      const api = (window as unknown as ApiWindow).app;
      await api.config.set('webServer', {
        enabled: true,
        port,
        bindAddress: '127.0.0.1',
        tls: { enabled: true, mode: 'self-signed', certPath: '', keyPath: '' },
        auth: { mode: 'password', username: 'fixture', password: 'fixture-password' },
      });
      await api.pluginBridge.mutate({ action: 'exports', sources: [], tools: [tool] });
      await api.pluginBridge.mutate({ action: 'remote', enabled: true, publicUrl: url });
    },
    { port, url: `${origin}/mcp`, tool: echo.id },
  );

  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const tls = new Agent({ connect: { rejectUnauthorized: false } }); // isolated fixture endpoint only
  const remote = new Client({ name: 'fixture-http-client', version: '1' });
  try {
    await expect
      .poll(async () => {
        try {
          return (await context.request.get(`${origin}/.well-known/oauth-protected-resource/mcp`)).status();
        } catch {
          return 0;
        }
      })
      .toBe(200);
    const metadata = await context.request.get(`${origin}/.well-known/oauth-protected-resource/mcp`, {
      headers: { Host: 'untrusted.invalid' },
    });
    expect((await metadata.json()).resource).toBe(`${origin}/mcp`);
    expect((await context.request.post(`${origin}/mcp`, { data: {} })).status()).toBe(401);
    const redirectUri = 'http://127.0.0.1:4567/callback';
    const registration = await context.request.post(`${origin}/register`, {
      data: {
        client_name: 'Browser fixture',
        redirect_uris: [redirectUri],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
      },
    });
    expect(registration.status()).toBe(201);
    const registered = await registration.json();
    const verifier = 'v'.repeat(43);
    const auth = new URLSearchParams({
      client_id: registered.client_id,
      response_type: 'code',
      redirect_uri: redirectUri,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
      resource: `${origin}/mcp`,
      scope: 'kai:tools',
      state: 'fixture-state',
    });
    const consent = await context.newPage();
    await context.route('http://127.0.0.1:4567/callback**', (route) =>
      route.fulfill({ contentType: 'text/html', body: 'Fixture callback received.' }),
    );
    await consent.goto(`${origin}/authorize?${auth}`);
    await expect(consent).toHaveURL(/\/login\?returnTo=/);
    await consent.locator('#username').fill('fixture');
    await consent.locator('#password').fill('fixture-password');
    await consent.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(consent.getByRole('heading', { name: 'Allow Browser fixture to use Kai?' })).toBeVisible();
    await consent.screenshot({ path: testInfo.outputPath('plugin-bridge-consent.png'), fullPage: true });
    await consent.getByRole('button', { name: 'Allow connection' }).click();
    await expect(consent).toHaveURL(/127\.0\.0\.1:4567\/callback/);
    const callback = new URL(consent.url());
    expect(callback.searchParams.get('state')).toBe('fixture-state');
    const tokenResponse = await context.request.post(`${origin}/token`, {
      form: {
        grant_type: 'authorization_code',
        code: callback.searchParams.get('code')!,
        code_verifier: verifier,
        redirect_uri: redirectUri,
        client_id: registered.client_id,
        resource: `${origin}/mcp`,
      },
    });
    expect(tokenResponse.status()).toBe(200);
    const tokens = await tokenResponse.json();
    expect(tokens.expires_in).toBe(3600);
    const remoteTransport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${tokens.access_token}` } },
      fetch: ((input, init) => undiciFetch(input, { ...init, dispatcher: tls })) as typeof fetch,
    });
    await remote.connect(remoteTransport);
    expect((await remote.listTools()).tools.map((t) => t.name)).toEqual([echo.name]);
    expect(await remote.callTool({ name: echo.name, arguments: { value: 'HTTPS fixture' } })).toMatchObject({
      structuredContent: { input: { value: 'HTTPS fixture' } },
    });
    const refreshed = await context.request.post(`${origin}/token`, {
      form: {
        grant_type: 'refresh_token',
        refresh_token: tokens.refresh_token,
        client_id: registered.client_id,
        resource: `${origin}/mcp`,
      },
    });
    expect(refreshed.status()).toBe(200);
    expect(
      (
        await context.request.post(`${origin}/token`, {
          form: { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: registered.client_id },
        })
      ).status(),
    ).toBe(400);
    const staticToken = await page.evaluate(() =>
      (window as unknown as ApiWindow).app.pluginBridge.createToken('Static fixture', 30),
    );
    const deniedAdmin = await browser.newContext({ ignoreHTTPSErrors: true });
    expect(
      (
        await deniedAdmin.request.get(origin, {
          headers: { Authorization: `Bearer ${staticToken.token}` },
          maxRedirects: 0,
        })
      ).status(),
    ).toBe(302);
    await deniedAdmin.close();
    await page.evaluate(
      (clientId) => (window as unknown as ApiWindow).app.pluginBridge.mutate({ action: 'revoke-client', clientId }),
      registered.client_id,
    );
    await expect(remote.listTools()).rejects.toThrow();
    await page.evaluate(async () => {
      const api = (window as unknown as ApiWindow).app.pluginBridge;
      await api.mutate({ action: 'remote', enabled: false, publicUrl: '' });
      await api.mutate({ action: 'imports', enabled: false });
    });
    expect(
      (
        await context.request.post(`${origin}/mcp`, {
          data: {},
          headers: { Authorization: `Bearer ${staticToken.token}` },
        })
      ).status(),
    ).toBe(404);
    const final = await page.evaluate(() => (window as unknown as ApiWindow).app.pluginBridge.snapshot());
    expect(final.importsEnabled).toBe(false);
    expect(final.clients.every((c) => c.kind === 'local')).toBe(true);
  } finally {
    await remote.close();
    await tls.close();
    await context.close();
    await browser.close();
  }
});
