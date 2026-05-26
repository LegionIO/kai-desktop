/**
 * IPC seam smoke — NOT a packaging E2E. Packaging integration runs in
 * pr-mac-build.
 *
 * What this test asserts (in one round trip, against an unpackaged build):
 *   (a) Main process boots without crashing.
 *   (b) Preload bridge exposes `window.app` via contextBridge.
 *   (c) `ipcRenderer.invoke('config:get')` round-trips through main and
 *       returns a `Record`-shaped object (the lightest persisted-config
 *       channel — verifies the bidirectional invoke seam).
 *   (d) `webContents.send` from main reaches the renderer (one-way push
 *       — verifies the main → renderer notification seam).
 *   (e) Fuse-adjacent runtime probes from the renderer: `window.process`
 *       is undefined (nodeIntegration off) and `window.require` is
 *       undefined (contextIsolation honoured).
 *
 * Why these five and not more: this is the *seam* smoke, fast feedback for
 * broken wiring. Behavioural coverage of individual IPC handlers belongs
 * in the vitest suite under `electron/__tests__/`, where it can use a
 * full mock harness without spinning up a real Electron process.
 */
import { test, expect } from '@playwright/test';
import { launchElectronForSmoke, type ElectronHandle } from './electron-launcher';

let handle: ElectronHandle;

test.beforeAll(async () => {
  handle = await launchElectronForSmoke();
});

test.afterAll(async () => {
  if (handle) {
    await handle.close();
  }
});

test('(a) main process boots without crashing', async () => {
  // The launcher resolves only after `data-app-ready` fires, which is itself
  // emitted from inside the main bootstrap. If we reached this point at all,
  // the main process is up. We additionally probe a benign main-side fact
  // (the app name) to confirm the app handle still talks to a live process.
  const name = await handle.app.evaluate(({ app }) => app.getName());
  expect(typeof name).toBe('string');
  expect(name.length).toBeGreaterThan(0);
});

test('(b) preload bridge exposes window.app via contextBridge', async () => {
  // Plain `typeof` check from inside the renderer's main world. If
  // contextIsolation broke or the preload script failed to evaluate,
  // `window.app` would be undefined and this assertion would fail.
  const appType = await handle.page.evaluate(() => typeof (window as unknown as { app?: unknown }).app);
  expect(appType).toBe('object');
});

test('(c) ipcRenderer.invoke("config:get") round-trips and returns a Record', async () => {
  // Calling `window.app.config.get()` from the renderer fans out to
  // `ipcRenderer.invoke("config:get")` in preload, which the main-process
  // handler resolves with the full effective `AppConfig`. We only assert
  // the shape (an object with at least one key) — anything stronger would
  // duplicate the schema tests that already live under the vitest suite.
  const config = await handle.page.evaluate(async () => {
    const api = (window as unknown as { app: { config: { get: () => Promise<unknown> } } }).app;
    return api.config.get();
  });
  expect(config).not.toBeNull();
  expect(typeof config).toBe('object');
  expect(Object.keys(config as Record<string, unknown>).length).toBeGreaterThan(0);
});

test('(d) webContents.send from main reaches the renderer (one-way push)', async () => {
  // Subscribe in the renderer first, exposing a one-shot Promise on
  // `window.__menuOpenSettingsFired` so the test can await it.
  await handle.page.evaluate(() => {
    interface MenuSink {
      __menuOpenSettingsFired?: Promise<boolean>;
    }
    const sink = window as unknown as MenuSink;
    const api = (
      window as unknown as {
        app: { onMenuOpenSettings: (cb: () => void) => () => void };
      }
    ).app;
    sink.__menuOpenSettingsFired = new Promise<boolean>((resolveOnce) => {
      const unsubscribe = api.onMenuOpenSettings(() => {
        unsubscribe();
        resolveOnce(true);
      });
    });
  });

  // Trigger the push from main. `menu:open-settings` is one of the menu
  // bridge channels declared in main.ts (sent by the Settings… menu item)
  // and is a no-op on the renderer side, which makes it a safe carrier
  // event for the smoke test.
  await handle.app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) throw new Error('no BrowserWindow available to send from');
    win.webContents.send('menu:open-settings');
  });

  // Await the renderer's signal — the test framework's expect timeout
  // bounds the wait, so a broken send will surface as a clean failure.
  const fired = await handle.page.evaluate(async () => {
    const sink = window as unknown as { __menuOpenSettingsFired?: Promise<boolean> };
    if (!sink.__menuOpenSettingsFired) return false;
    return sink.__menuOpenSettingsFired;
  });
  expect(fired).toBe(true);
});

test('(e) renderer-side fuse-adjacent runtime probes', async () => {
  // `nodeIntegration: false` plus `contextIsolation: true` should leave
  // the renderer's main world without any Node globals. We probe two
  // observable facts from inside `page.evaluate` so a regression in
  // either webPreferences flag would fail this assertion.
  const probes = await handle.page.evaluate(() => {
    const w = window as unknown as { process?: unknown; require?: unknown; module?: unknown };
    return {
      processType: typeof w.process,
      requireType: typeof w.require,
      moduleType: typeof w.module,
    };
  });
  expect(probes.processType).toBe('undefined');
  expect(probes.requireType).toBe('undefined');
  expect(probes.moduleType).toBe('undefined');
});
