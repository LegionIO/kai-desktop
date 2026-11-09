import { test, expect, chromium } from '@playwright/test';
import { spawn } from '@lydell/node-pty';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { createServer } from 'node:net';
import { launchElectronForSmoke, type ElectronHandle } from './electron-launcher';
import { startMcpOAuthFixture } from './fixtures/mcp-oauth-server';
import type { McpApi, McpLogin } from '../shared/mcp';
import { mcpToolCallFixture } from '../test-utils/mcp-ui';

type ApiWindow = Window & { app: { mcp: McpApi; config: { set(path: string, value: unknown): Promise<void> } } };
let handle: ElectronHandle;
let fixture: Awaited<ReturnType<typeof startMcpOAuthFixture>>;
test.beforeAll(async () => {
  fixture = await startMcpOAuthFixture();
  handle = await launchElectronForSmoke();
  // Exercise the documented session-only path without requesting access to the host keychain.
  await handle.app.evaluate(({ safeStorage }) => {
    safeStorage.encryptString = () => {
      throw new Error('Controlled unavailable keychain');
    };
  });
});
test.afterAll(async () => {
  await handle?.close();
  await fixture?.close();
});

test('desktop, authenticated browser and terminal share login, refresh and reconnect', async () => {
  test.setTimeout(90_000);
  await handle.page.evaluate(async (url) => {
    await (window as unknown as ApiWindow).app.config.set('mcpServers', [{ name: 'controlled', url, enabled: true }]);
  }, `${fixture.origin}/mcp`);
  await expect
    .poll(() =>
      handle.page.evaluate(async () => (await (window as unknown as ApiWindow).app.mcp.getStatus())[0]?.state),
    )
    .toBe('required');
  const first = await handle.page.evaluate(() => (window as unknown as ApiWindow).app.mcp.login('controlled'));
  const callback = await fetch(fixture.callback(first.authorizationUrl));
  expect(callback.status).toBe(200);
  await callback.text();
  await expect
    .poll(() =>
      handle.page.evaluate(async () => (await (window as unknown as ApiWindow).app.mcp.getStatus())[0]?.toolCount),
    )
    .toBe(1);

  fixture.behavior.rejectAccess = true;
  const checked = await handle.page.evaluate(
    async (url) => (window as unknown as ApiWindow).app.mcp.testConnection({ name: 'controlled', url, enabled: true }),
    `${fixture.origin}/mcp`,
  );
  expect(checked.status).toBe('connected');
  expect(fixture.refreshes()).toBe(1);
  fixture.behavior.rejectAccess = true;
  fixture.behavior.rejectRefresh = true;
  await handle.page.evaluate(
    async (url) => (window as unknown as ApiWindow).app.mcp.testConnection({ name: 'controlled', url, enabled: true }),
    `${fixture.origin}/mcp`,
  );
  expect(
    await handle.page.evaluate(async () => (await (window as unknown as ApiWindow).app.mcp.getStatus())[0]?.reason),
  ).toBe('expired');
  fixture.behavior.rejectRefresh = false;

  const portProbe = createServer();
  await new Promise<void>((done) => portProbe.listen(0, '127.0.0.1', done));
  const webPort = (portProbe.address() as { port: number }).port;
  await new Promise<void>((done) => portProbe.close(() => done()));
  await handle.page.evaluate(async (port) => {
    await (window as unknown as ApiWindow).app.config.set('webServer', {
      enabled: true,
      port,
      bindAddress: '127.0.0.1',
      tls: { enabled: false, mode: 'self-signed', certPath: '', keyPath: '' },
      auth: { mode: 'password', username: 'fixture', password: 'local-fixture-password' },
    });
  }, webPort);
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const context = await browser.newContext();
    await expect
      .poll(async () => {
        try {
          return (
            await context.request.post(`http://127.0.0.1:${webPort}/api/login`, {
              data: { username: 'fixture', password: 'local-fixture-password' },
            })
          ).status();
        } catch {
          return 0;
        }
      })
      .toBe(200);
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${webPort}`);
    await page.waitForFunction(() => Boolean((window as unknown as ApiWindow).app?.mcp?.getStatus));
    const flow = (await page.evaluate(() => (window as unknown as ApiWindow).app.mcp.login('controlled'))) as McpLogin;
    await page.evaluate(
      async ({ id, callback }) => (window as unknown as ApiWindow).app.mcp.completeLogin(id, callback),
      {
        id: flow.loginId,
        callback: fixture.callback(flow.authorizationUrl),
      },
    );
    expect(
      await page.evaluate(async () => (await (window as unknown as ApiWindow).app.mcp.getStatus())[0]?.state),
    ).toBe('authorized');
    expect(
      (await page.evaluate(() => (window as unknown as ApiWindow).app.mcp.logout('controlled'))).localCleared,
    ).toBe(true);
  } finally {
    await browser.close();
  }

  const terminal = spawn(process.execPath, [resolve('out/main/cli.js'), 'mcp', 'login', 'controlled', '--no-browser'], {
    name: 'xterm',
    cols: 500,
    rows: 30,
    cwd: homedir(),
    env: { ...process.env, KAI_USER_DATA: handle.userDataDir },
  });
  let output = '',
    pasted = false;
  try {
    const exit = new Promise<number>((done) => terminal.onExit(({ exitCode }) => done(exitCode)));
    terminal.onData((text) => {
      output += text;
      if (!pasted && output.includes('then Enter:')) {
        const auth = output.match(/http:\/\/127\.0\.0\.1:\d+\/authorize\?[^\s]+/)?.[0];
        if (auth) {
          pasted = true;
          terminal.write(fixture.callback(auth) + '\r');
        }
      }
    });
    expect(await exit).toBe(0);
    expect(pasted).toBe(true);
    expect(output).toContain('Signed in.');
    expect(output).not.toContain('code=controlled-code');
    expect(
      await handle.page.evaluate(async () => (await (window as unknown as ApiWindow).app.mcp.getStatus())[0]?.state),
    ).toBe('authorized');
  } finally {
    terminal.kill();
  }
});

test('dedicated desktop sign-in windows complete and cancel without exposing the app bridge', async () => {
  await handle.page.evaluate(async (url) => {
    await (window as unknown as ApiWindow).app.config.set('mcpServers', [
      { name: 'window-fixture', url, enabled: true },
    ]);
  }, `${fixture.origin}/mcp`);
  await expect
    .poll(() =>
      handle.page.evaluate(
        async () =>
          (await (window as unknown as ApiWindow).app.mcp.getStatus()).find(
            (status) => status.name === 'window-fixture',
          )?.state,
      ),
    )
    .toBe('required');
  const flow = await handle.page.evaluate(() => (window as unknown as ApiWindow).app.mcp.login('window-fixture'));
  const nextWindow = handle.app.waitForEvent('window');
  await handle.page.evaluate((id) => (window as unknown as ApiWindow).app.mcp.openLogin(id, 'in-app'), flow.loginId);
  const signIn = await nextWindow;
  await expect(signIn.getByRole('heading', { name: 'Controlled sign-in' })).toBeVisible();
  expect(await signIn.evaluate(() => typeof (window as unknown as ApiWindow).app)).toBe('undefined');
  await handle.page.evaluate((id) => (window as unknown as ApiWindow).app.mcp.openLogin(id, 'in-app'), flow.loginId);
  expect(handle.app.windows()).toHaveLength(2);
  await signIn.getByRole('link', { name: 'Authorize fixture' }).click();
  await expect.poll(() => signIn.isClosed()).toBe(true);
  await expect
    .poll(() =>
      handle.page.evaluate(async () => (await (window as unknown as ApiWindow).app.mcp.getStatus())[0]?.state),
    )
    .toBe('authorized');

  const second = await handle.page.evaluate(() => (window as unknown as ApiWindow).app.mcp.login('window-fixture'));
  const cancelledWindow = handle.app.waitForEvent('window');
  await handle.page.evaluate((id) => (window as unknown as ApiWindow).app.mcp.openLogin(id, 'in-app'), second.loginId);
  const cancelled = await cancelledWindow;
  await cancelled.close();
  await expect
    .poll(() =>
      handle.page.evaluate(async () => (await (window as unknown as ApiWindow).app.mcp.getStatus())[0]?.state),
    )
    .toBe('required');
  await expect(
    handle.page.evaluate((id) => (window as unknown as ApiWindow).app.mcp.openLogin(id, 'in-app'), second.loginId),
  ).rejects.toThrow('expired');
});

test('reset recovers a lost dynamic registration from an invalid_client page without refresh tokens', async () => {
  const idp = await startMcpOAuthFixture({ dynamicRegistration: true, refreshTokens: false });
  try {
    const config = { name: 'registration-fixture', url: `${idp.origin}/mcp`, enabled: true };
    await handle.page.evaluate(async (server) => {
      await (window as unknown as ApiWindow).app.config.set('mcpServers', [server]);
    }, config);
    const status = () =>
      handle.page.evaluate(async () => (await (window as unknown as ApiWindow).app.mcp.getStatus())[0]);
    await expect.poll(async () => (await status())?.state).toBe('required');
    const first = await handle.page.evaluate(() =>
      (window as unknown as ApiWindow).app.mcp.login('registration-fixture'),
    );
    const callback = await fetch(idp.callback(first.authorizationUrl));
    expect(callback.status).toBe(200);
    await callback.text();
    await expect.poll(async () => (await status())?.toolCount).toBe(1);

    idp.loseRegistrations();
    idp.behavior.rejectAccess = true;
    await handle.page.evaluate(
      async (server) => (window as unknown as ApiWindow).app.mcp.testConnection(server),
      config,
    );
    await expect.poll(async () => (await status())?.reason).toBe('expired');
    const notice = handle.page.getByRole('complementary', { name: 'MCP sign-in required' });
    const rejectedWindow = handle.app.waitForEvent('window');
    await notice.getByRole('button', { name: 'Reconnect', exact: true }).click();
    const rejected = await rejectedWindow;
    await expect(rejected.locator('body')).toContainText('invalid_client');
    expect(idp.registrations()).toBe(1);
    await handle.page.getByRole('dialog').getByRole('button', { name: 'Reset registration' }).click();
    await expect.poll(() => rejected.isClosed()).toBe(true);
    await expect(handle.page.getByRole('dialog')).toHaveCount(0);
    expect(idp.registrations()).toBe(1);
    const restoredWindow = handle.app.waitForEvent('window');
    await notice.getByRole('button', { name: 'Sign in', exact: true }).click();
    const restored = await restoredWindow;
    await expect(restored.getByRole('heading', { name: 'Controlled sign-in' })).toBeVisible();
    await restored.getByRole('link', { name: 'Authorize fixture' }).click();
    await expect.poll(() => restored.isClosed()).toBe(true);
    await expect.poll(async () => (await status())?.state).toBe('authorized');
    await expect.poll(async () => (await status())?.toolCount).toBe(1);
    expect(idp.registrations()).toBe(2);
    expect(idp.refreshes()).toBe(0);
  } finally {
    await handle.page.evaluate(async () => (window as unknown as ApiWindow).app.config.set('mcpServers', []));
    await idp.close();
  }
});

test('expanded MCP calls display inputs and output in the real desktop renderer', async () => {
  await handle.page.evaluate(async (part) => {
    const timestamp = new Date().toISOString();
    const messageTree = [
      {
        id: 'mcp-input-user',
        parentId: null,
        role: 'user',
        content: [{ type: 'text', text: 'Verify this MCP request.' }],
        createdAt: timestamp,
      },
      {
        id: 'mcp-input-assistant',
        parentId: 'mcp-input-user',
        role: 'assistant',
        content: [part],
        createdAt: timestamp,
      },
    ];
    const conversations = (
      window as unknown as {
        app: {
          conversations: {
            put(value: Record<string, unknown>): Promise<void>;
            setActiveId(id: string): Promise<void>;
          };
        };
      }
    ).app.conversations;
    await conversations.put({
      id: 'mcp-input-visual',
      title: 'MCP inputs fixture',
      fallbackTitle: 'MCP inputs fixture',
      messages: messageTree,
      messageTree,
      headId: 'mcp-input-assistant',
      createdAt: timestamp,
      updatedAt: timestamp,
      lastMessageAt: timestamp,
      messageCount: 2,
      userMessageCount: 1,
      titleStatus: 'idle',
      runStatus: 'idle',
      hasUnread: false,
    });
    await conversations.setActiveId('mcp-input-visual');
  }, mcpToolCallFixture());
  await handle.page.getByRole('complementary').getByText('MCP inputs fixture', { exact: true }).click();
  await handle.page.getByRole('button', { name: /Mcp Secplat/ }).click();
  await expect(handle.page.getByText('Input', { exact: true })).toBeVisible();
  await expect(handle.page.getByText('"Verify the MCP request"', { exact: false })).toBeVisible();
  await expect(handle.page.getByText('MCP repeat test verified', { exact: true })).toBeVisible();
  await handle.page.screenshot({ path: test.info().outputPath('mcp-inputs.png') });
});
