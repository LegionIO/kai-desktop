import { test, expect, chromium } from '@playwright/test';
import { spawn } from '@lydell/node-pty';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { createServer } from 'node:net';
import { launchElectronForSmoke, type ElectronHandle } from './electron-launcher';
import { startMcpOAuthFixture } from './fixtures/mcp-oauth-server';
import type { McpApi, McpLogin } from '../shared/mcp';

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
