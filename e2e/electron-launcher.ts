/**
 * Electron launcher helper for the IPC seam smoke test.
 *
 * Launches the **unpackaged** Electron binary against the freshly-built
 * `out/main/index.js`. This is a thin harness — it does not exercise the
 * packaged DMG, code signing, or auto-update channels. Those concerns are
 * validated by the `pr-mac-build` job, which runs the real electron-builder
 * pipeline. See TESTING.md for the full distinction.
 *
 * The launcher:
 *   - Points `KAI_USER_DATA` at a per-run tmp dir so the test never touches
 *     the developer's real `~/.kai/` and tests can run in parallel sessions
 *     without colliding.
 *   - On Linux, passes `--no-sandbox` unconditionally. xvfb-driven CI runners
 *     (and most container environments) cannot use Chromium's setuid sandbox.
 *     This flag is orthogonal to all Electron Fuses; it changes only the
 *     OS-level sandbox attached at process start, not any bit baked into the
 *     packaged binary. The Mac DMG security signal is asserted independently
 *     by the `pr-mac-build` job, so this dev-only switch cannot contaminate
 *     the production trust surface.
 *   - Waits for the main process to emit `data-app-ready` (the sentinel the
 *     main bootstrap fires once `ensureAppHome()` has finished provisioning
 *     the user-data directory). At that point IPC handlers are registered
 *     and the renderer's first paint is in flight.
 *
 * Cleanup is the caller's responsibility — call `handle.close()` from a
 * Playwright `afterAll`/`afterEach` hook.
 */
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export interface ElectronHandle {
  app: ElectronApplication;
  page: Page;
  /** Per-run tmp dir handed to the app via `KAI_USER_DATA`. */
  userDataDir: string;
  /** Tear down the app and remove the tmp user-data dir. */
  close(): Promise<void>;
}

/**
 * Resolve the path to the unpackaged main entry. We resolve from the
 * repository root rather than via `import.meta.dirname` so the path is
 * stable regardless of how Playwright invokes the test.
 */
function mainEntryPoint(): string {
  return resolve(process.cwd(), 'out', 'main', 'index.js');
}

/**
 * Build the launch args list. On Linux we always pass `--no-sandbox` —
 * see the file header for the security-orthogonality rationale.
 */
function launchArgs(mainPath: string): string[] {
  const args = [mainPath];
  if (process.platform === 'linux') {
    args.push('--no-sandbox');
  }
  return args;
}

export async function launchElectronForSmoke(): Promise<ElectronHandle> {
  const userDataDir = mkdtempSync(join(tmpdir(), 'kai-ipc-smoke-'));
  const mainPath = mainEntryPoint();

  const app = await electron.launch({
    args: launchArgs(mainPath),
    env: {
      ...process.env,
      // Point the app at a throwaway user-data dir so the test cannot
      // pollute `~/.kai/`. Honoured by `resolveUserDataDir()` in main.ts.
      KAI_USER_DATA: userDataDir,
      // Silence Electron's "Insecure Content-Security-Policy" / dev warnings
      // so the test output stays focused on real failures.
      ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
      // Disable the auto-updater path — there is no `KAI_UPDATE_TEST_VERSION`
      // env in this run, so the updater is already inert, but we set
      // `NODE_ENV` explicitly to be safe.
      NODE_ENV: 'test',
    },
  });

  // Wait for the main process to emit the `data-app-ready` sentinel.
  // The bootstrap fires this once `ensureAppHome()` has finished, which
  // also guarantees the IPC handlers are registered (they're registered
  // earlier in `app.whenReady`, before `data-app-ready` is emitted).
  await app.evaluate(({ app: electronApp }) => {
    return new Promise<void>((resolveOnce) => {
      // If the event already fired before we attached, the listener will
      // simply never be called — fall back to a `whenReady` race so the
      // launcher cannot hang.
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolveOnce();
      };
      // `data-app-ready` is a custom event name (not part of Electron's
      // typed event list) so we cast the emitter to the loose EventEmitter
      // shape for the listener registration.
      const emitter = electronApp as unknown as {
        once(event: string, listener: () => void): void;
      };
      emitter.once('data-app-ready', finish);
      // Safety net: if the app is already ready and `data-app-ready` was
      // emitted before our listener attached, fall back to a short wait
      // after `whenReady` resolves so the renderer has a chance to load.
      electronApp.whenReady().then(() => {
        setTimeout(finish, 1500);
      });
    });
  });

  const page = await app.firstWindow();
  // Drain any initial loading state so subsequent `evaluate` calls see a
  // stable renderer. `domcontentloaded` is enough — we don't need a fully
  // hydrated React tree to assert the contextBridge.
  await page.waitForLoadState('domcontentloaded');

  return {
    app,
    page,
    userDataDir,
    async close() {
      try {
        await app.close();
      } catch {
        // The Electron app may already be exiting — swallow.
      }
      try {
        rmSync(userDataDir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup; the OS will reclaim tmp eventually.
      }
    },
  };
}
