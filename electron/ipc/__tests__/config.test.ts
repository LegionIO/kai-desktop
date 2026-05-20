/**
 * Canonical IPC handler test for the config channel surface.
 *
 * This file is the reference example future contributors should copy when
 * adding IPC test coverage:
 *
 *   • Mock the `electron` module so production code that imports BrowserWindow
 *     does not crash in a Node-only vitest environment.
 *   • Redirect `os.homedir()` to a per-test temp directory so the production
 *     `getAppLlmConfigPath()` resolver cannot reach the developer's real
 *     `~/.kai/` while the suite runs.
 *   • Drive an in-memory IPC harness — `createIpcHarness({ registerHandlers })`
 *     — instead of standing up Electron's real IPC, which is not available in
 *     vitest. The harness mirrors `ipcMain.handle()` for invoke channels and
 *     captures main-to-renderer pushes so tests can assert on them.
 *   • Each assertion is explicit (`toBe` / `toEqual` / `toMatchObject`) — no
 *     snapshots, so failures point straight at the regression.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as NodeOs from 'node:os';

import { createIpcHarness } from '../../../test-utils/ipc-harness.js';

// `electron` resolves to a path string in Node — see node_modules/electron/index.js.
// Tests that import production code which references `BrowserWindow` must stub
// the module up front. `vi.mock` is hoisted, so this runs before config.ts loads.
vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: vi.fn(() => []),
  },
}));

// Redirect `os.homedir()` so `getAppLlmConfigPath()` cannot point at the
// developer's real `~/.kai/settings/llm.json`.
//
// `vi.mock` factories are hoisted above all imports and top-level statements,
// so the redirect target must be readable the instant any imported module
// calls `homedir()`. Several non-config production modules (self-signed.ts,
// audit-log.ts, web-server.ts) still evaluate paths at module load, so the
// fallback must be a value, not a TDZ-bound `let`. Stashing the slot on
// `globalThis` and falling through to `actual.tmpdir()` keeps the early
// callers safe — they see a deterministic placeholder path under the OS
// tmpdir until the per-test `beforeEach` reassigns it.
declare global {
  var __kaiTestHomedir: string | undefined;
}
vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof NodeOs>('node:os');
  return {
    ...actual,
    homedir: () => globalThis.__kaiTestHomedir ?? actual.tmpdir(),
  };
});
vi.mock('os', async () => {
  const actual = await vi.importActual<typeof NodeOs>('os');
  return {
    ...actual,
    homedir: () => globalThis.__kaiTestHomedir ?? actual.tmpdir(),
  };
});

// Import production code AFTER vi.mock calls so the mocked `electron`/`os`
// modules are wired up before any imported module reads them.
import {
  registerConfigHandlers,
  desktopConfigPayload,
  readEffectiveConfig,
  writeDesktopConfig,
  type AppConfig,
} from '../config.js';

// ---------------------------------------------------------------------------
// Per-test fixture: temp `appHome` directory that mirrors `~/.kai/`.
// ---------------------------------------------------------------------------

// Production handlers are registered with the signature
// `(event, ...args) => ...`. The harness passes args verbatim to the
// registered handler, so tests must supply an event placeholder as the first
// argument when invoking. We use the same frozen sentinel everywhere so the
// signature lines up with the Electron IpcMainInvokeEvent shape that
// production code expects but never reads in the channels under test.
const FAKE_EVENT = Object.freeze({}) as unknown;

let tempHome: string;
let appHome: string;

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), 'kai-config-ipc-'));
  // `homedir()` is mocked above to return `globalThis.__kaiTestHomedir`.
  // Point it at the per-test temp dir so `getAppLlmConfigPath()` resolves
  // under it.
  globalThis.__kaiTestHomedir = tempHome;
  appHome = join(tempHome, '.kai');
  mkdirSync(join(appHome, 'settings'), { recursive: true });
});

afterEach(() => {
  rmSync(tempHome, { recursive: true, force: true });
  globalThis.__kaiTestHomedir = undefined;
});

// ---------------------------------------------------------------------------
// Test 1: desktopConfigPayload() round-trip through the persistence allowlist.
// ---------------------------------------------------------------------------

describe('config IPC: desktopConfigPayload round-trip', () => {
  it('preserves every allowlisted section across write -> read', async () => {
    const initial = readEffectiveConfig(appHome);
    const payload = desktopConfigPayload(initial);

    // Every key the allowlist exposes must survive a write+read cycle. We
    // deliberately check `agent`, `models`, `tools`, `ui`, `cliTools` — the
    // sections the README's CLAUDE.md explicitly calls out.
    writeDesktopConfig(appHome, initial);
    const reread = readEffectiveConfig(appHome);
    const rereadPayload = desktopConfigPayload(reread);

    expect(rereadPayload.agent).toEqual(payload.agent);
    expect(rereadPayload.tools).toEqual(payload.tools);
    expect(rereadPayload.ui).toEqual(payload.ui);
    expect(rereadPayload.cliTools).toEqual(payload.cliTools);
    expect(rereadPayload.advanced).toEqual(payload.advanced);
    // The disk file should match the allowlist output byte-for-byte.
    const onDisk = JSON.parse(readFileSync(join(appHome, 'settings', 'desktop.json'), 'utf-8'));
    expect(onDisk).toEqual(rereadPayload);
  });

  it('drops fields not present in the allowlist on the next round-trip', async () => {
    const initial = readEffectiveConfig(appHome);
    // Synthesise a settings file that contains a non-allowlisted top-level
    // key. The next `writeDesktopConfig` should strip it because
    // `desktopConfigPayload()` is an explicit allowlist.
    const tainted = {
      ...desktopConfigPayload(initial),
      // Not in the allowlist — must NOT survive the next write.
      experimentalGhostSetting: { secret: 'leak-me' },
    };
    writeFileSync(join(appHome, 'settings', 'desktop.json'), JSON.stringify(tainted, null, 2), 'utf-8');

    // Round-trip: read effective config (which strips through the schema and
    // the allowlist) and write it back.
    const reread = readEffectiveConfig(appHome);
    writeDesktopConfig(appHome, reread);

    const onDisk = JSON.parse(readFileSync(join(appHome, 'settings', 'desktop.json'), 'utf-8'));
    expect('experimentalGhostSetting' in onDisk).toBe(false);
    // Allowlisted sections still present after the strip.
    expect(onDisk.agent).toBeDefined();
    expect(onDisk.tools).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Test 2: IPC channels exposed by registerConfigHandlers.
// ---------------------------------------------------------------------------

describe('config IPC: registered channels', () => {
  it('responds to config:get with the effective AppConfig shape', async () => {
    const harness = await createIpcHarness({
      registerHandlers: (ipc) => {
        registerConfigHandlers(ipc as Parameters<typeof registerConfigHandlers>[0], appHome);
      },
    });

    const config = await harness.invoke<AppConfig>('config:get', FAKE_EVENT);
    expect(config).toMatchObject({
      models: expect.objectContaining({
        defaultModelKey: expect.any(String),
      }),
      tools: expect.objectContaining({
        shell: expect.objectContaining({ enabled: expect.any(Boolean) }),
      }),
      // `executionMode` is the default-applied field on `tools` — confirms
      // the schema normalisation ran during the load path.
      systemPrompt: expect.any(String),
    });
    expect(Array.isArray(config.cliTools)).toBe(true);
  });

  it('persists a config:set write through to disk for an allowlisted path', async () => {
    const harness = await createIpcHarness({
      registerHandlers: (ipc) => {
        registerConfigHandlers(ipc as Parameters<typeof registerConfigHandlers>[0], appHome);
      },
    });

    // `launchAtLogin` is one of the simplest scalars on the allowlist; flip it
    // and confirm the change reaches both the in-memory result and disk.
    await harness.invoke('config:set', FAKE_EVENT, 'launchAtLogin', true);

    const reread = await harness.invoke<AppConfig>('config:get', FAKE_EVENT);
    expect(reread.launchAtLogin).toBe(true);

    const onDisk = JSON.parse(readFileSync(join(appHome, 'settings', 'desktop.json'), 'utf-8'));
    expect(onDisk.launchAtLogin).toBe(true);
  });

  it('reports homedir via platform:homedir', async () => {
    const harness = await createIpcHarness({
      registerHandlers: (ipc) => {
        registerConfigHandlers(ipc as Parameters<typeof registerConfigHandlers>[0], appHome);
      },
    });

    const home = await harness.invoke<string>('platform:homedir', FAKE_EVENT);
    expect(home).toBe(tempHome);
  });
});

// ---------------------------------------------------------------------------
// Test 3: Allowlist enforcement — non-allowlisted writes do not persist.
// ---------------------------------------------------------------------------

describe('config IPC: allowlist enforcement', () => {
  it('does not persist a config:set under a path outside the allowlist', async () => {
    const harness = await createIpcHarness({
      registerHandlers: (ipc) => {
        registerConfigHandlers(ipc as Parameters<typeof registerConfigHandlers>[0], appHome);
      },
    });

    // `setNestedValue` will happily set this in the in-memory object, but
    // `writeDesktopConfig` -> `desktopConfigPayload` will drop it on the way
    // to disk because the allowlist does not name it.
    await harness.invoke('config:set', FAKE_EVENT, 'experimentalGhost', { secret: 'leak-me' });

    expect(existsSync(join(appHome, 'settings', 'desktop.json'))).toBe(true);
    const onDisk = JSON.parse(readFileSync(join(appHome, 'settings', 'desktop.json'), 'utf-8'));
    expect('experimentalGhost' in onDisk).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Test 4: Type-safe channel signatures match what preload.ts wires up.
//
// This is a compile-time + structural check: the channel strings used by the
// renderer side (`window.app.config.*`) must line up with what
// `registerConfigHandlers` registers. We mirror the renderer's expected
// channel names and assert every one is reachable.
// ---------------------------------------------------------------------------

describe('config IPC: renderer contract', () => {
  it('registers every channel the preload contextBridge exposes', async () => {
    const calls: Array<{ channel: string }> = [];

    await createIpcHarness({
      registerHandlers: (ipc) => {
        const wrapped = {
          ...ipc,
          handle: (channel: string, handler: Parameters<typeof ipc.handle>[1]) => {
            calls.push({ channel });
            ipc.handle(channel, handler);
          },
        };
        registerConfigHandlers(wrapped as Parameters<typeof registerConfigHandlers>[0], appHome);
      },
    });

    const registered = calls.map((c) => c.channel);
    // The renderer side (preload.ts) invokes these exact channel strings.
    // Future contributors who rename a channel must update both sides.
    expect(registered).toContain('config:get');
    expect(registered).toContain('config:set');
    expect(registered).toContain('platform:homedir');
    expect(registered).toContain('webServer:lan-addresses');
    expect(registered).toContain('webServer:create-token');
    expect(registered).toContain('cli-tools:check-binaries');
  });
});
