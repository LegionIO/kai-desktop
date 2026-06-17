/**
 * Pi runtime end-to-end (real Electron app, real IPC, real subprocess).
 *
 * Unlike the IPC-seam smoke, this drives the *whole pi path* through a live
 * Electron build:
 *   - a fake `pi` binary (the shim from the unit/integration fixtures, copied
 *     to a temp dir as `pi`) is placed on the app's PATH;
 *   - the user-data dir is seeded with `agent.runtime = 'pi'` + a first-party
 *     model so the runtime resolves and maps cleanly;
 *   - from the renderer we assert pi is *detected* via the real
 *     `agent.getAvailableRuntimes()` IPC, then run a turn via
 *     `agent.stream(..., { runtimeOverride: 'pi' })` and assert the translated
 *     `StreamEvent`s (text + tool call) arrive over `agent:stream-event`.
 *
 * Determinism: the shim emits a fixed script and exits — no LLM, no network.
 */
import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtempSync, rmSync, copyFileSync, chmodSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, delimiter } from 'node:path';

const SHIM = resolve(process.cwd(), 'electron/agent/runtime/__tests__/fixtures/fake-pi.mjs');
const MAIN = resolve(process.cwd(), 'out', 'main', 'index.js');

let app: ElectronApplication;
let page: Page;
let userDataDir: string;
let binDir: string;

const SEED_CONFIG = {
  agent: { runtime: 'pi' },
  models: {
    defaultModelKey: 'pi-e2e-model',
    providers: {
      anthropic: { type: 'anthropic', endpoint: '', apiKey: 'sk-ant-e2e-not-real', enabled: true },
    },
    catalog: [{ key: 'pi-e2e-model', displayName: 'E2E Claude', provider: 'anthropic', modelName: 'claude-sonnet-4' }],
  },
};

test.beforeAll(async () => {
  userDataDir = mkdtempSync(join(tmpdir(), 'kai-pi-e2e-'));
  binDir = mkdtempSync(join(tmpdir(), 'kai-pi-bin-'));

  // Expose the shim as a binary literally named `pi` on PATH.
  const piPath = join(binDir, 'pi');
  copyFileSync(SHIM, piPath);
  chmodSync(piPath, 0o755);

  // Seed config so the pi runtime is selected and a model resolves.
  // The app reads desktop settings from `<appHome>/settings/desktop.json`
  // (see getDesktopSettingsPath), deep-merged over defaults.
  mkdirSync(join(userDataDir, 'settings'), { recursive: true });
  writeFileSync(join(userDataDir, 'settings', 'desktop.json'), JSON.stringify(SEED_CONFIG, null, 2));

  const args = [MAIN];
  if (process.platform === 'linux') args.push('--no-sandbox');

  app = await electron.launch({
    args,
    env: {
      ...process.env,
      KAI_USER_DATA: userDataDir,
      // Prepend our fake-pi dir; the app's PATH resolver merges process.env.PATH
      // into its resolved PATH, so `pi` becomes detectable.
      PATH: `${binDir}${delimiter}${process.env.PATH ?? ''}`,
      // Drive the shim's scripted "normal" turn.
      PI_FAKE_MODE: 'normal',
      ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
      NODE_ENV: 'test',
    },
  });

  await app.evaluate(({ app: electronApp }) => {
    return new Promise<void>((resolveOnce) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolveOnce();
      };
      const emitter = electronApp as unknown as { once(event: string, listener: () => void): void };
      emitter.once('data-app-ready', finish);
      electronApp.whenReady().then(() => setTimeout(finish, 1500));
    });
  });

  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
});

test.afterAll(async () => {
  try {
    await app?.close();
  } catch {
    /* exiting */
  }
  for (const dir of [userDataDir, binDir]) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

test('pi runtime is registered and detected as available in the live app', async () => {
  // `agent.getAvailableRuntimes()` round-trips to the main-process registry,
  // which runs PiRuntime.isAvailable() → detectPiCli() → resolves our fake `pi`
  // on the PATH we injected. Proves registration + detection end-to-end.
  const runtimes = await page.evaluate(async () => {
    const api = (
      window as unknown as {
        app: {
          agent: { getAvailableRuntimes: () => Promise<Array<{ id: string; name: string; available: boolean }>> };
        };
      }
    ).app;
    return api.agent.getAvailableRuntimes();
  });

  const pi = runtimes.find((r) => r.id === 'pi');
  expect(pi, 'pi runtime should be registered').toBeTruthy();
  expect(pi?.name).toBe('Pi');
  expect(pi?.available, 'pi should be detected as available (fake pi on PATH)').toBe(true);
});

test('streams a real pi turn through IPC: text + tool events reach the renderer', async () => {
  const result = await page.evaluate(async (cwd: string) => {
    interface StreamEvt {
      conversationId?: string;
      type?: string;
      text?: string;
      toolName?: string;
    }
    const api = (
      window as unknown as {
        app: {
          agent: {
            stream: (
              conversationId: string,
              messages: unknown[],
              modelKey?: string,
              reasoningEffort?: string,
              profileKey?: string,
              fallbackEnabled?: boolean,
              cwd?: string,
              executionMode?: string,
              threadOverrides?: { runtimeOverride?: string | null },
            ) => Promise<unknown>;
            onStreamEvent: (cb: (e: unknown) => void) => () => void;
          };
        };
      }
    ).app;

    const conversationId = `e2e-pi-${Date.now()}`;
    const events: StreamEvt[] = [];

    const done = new Promise<void>((resolveOnce) => {
      const unsubscribe = api.agent.onStreamEvent((raw) => {
        const evt = raw as StreamEvt;
        if (evt.conversationId !== conversationId) return;
        events.push(evt);
        if (evt.type === 'done') {
          unsubscribe();
          resolveOnce();
        }
      });
      // Safety valve so the test fails cleanly rather than hanging.
      setTimeout(() => {
        unsubscribe();
        resolveOnce();
      }, 25_000);
    });

    await api.agent.stream(
      conversationId,
      [{ role: 'user', content: 'hello pi' }],
      'pi-e2e-model',
      undefined,
      undefined,
      false,
      cwd,
      'auto',
      { runtimeOverride: 'pi' },
    );

    await done;

    return {
      text: events
        .filter((e) => e.type === 'text-delta')
        .map((e) => e.text ?? '')
        .join(''),
      toolNames: events.filter((e) => e.type === 'tool-call').map((e) => e.toolName),
      types: events.map((e) => e.type),
      errors: events.filter((e) => e.type === 'error').map((e) => (e as { error?: string }).error),
    };
  }, userDataDir);

  const ctx = `types=${JSON.stringify(result.types)} errors=${JSON.stringify(result.errors)}`;
  expect(result.types, `stream should terminate with done — ${ctx}`).toContain('done');
  expect(result.text, `assistant text from fake pi should stream through — ${ctx}`).toContain('Hello from fake pi.');
  expect(result.toolNames, `pi bash tool call should surface as a tool-call event — ${ctx}`).toContain('bash');
});
