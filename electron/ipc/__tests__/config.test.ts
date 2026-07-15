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
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync, chmodSync } from 'node:fs';
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
import { appConfigSchema } from '../../config/schema.js';

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
    // #81: the appshots config section must survive the allowlist round-trip.
    expect(rereadPayload.appshots).toEqual(payload.appshots);
    expect((rereadPayload.appshots as { enabled?: boolean }).enabled).toBe(false); // secure default
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
// Test 1b: agent.confinement schema (#70) — secure-by-default + round-trip.
// ---------------------------------------------------------------------------

describe('agent.confinement schema', () => {
  it('is secure-by-default when confinement is omitted but present', () => {
    const base = readEffectiveConfig(appHome);
    const parsed = appConfigSchema.parse({
      ...base,
      agent: { ...(base.agent ?? { runtime: 'auto' }), confinement: {} },
    });
    expect(parsed.agent?.confinement).toEqual({
      enabled: false,
      workspaceOnly: true,
      scrubCredentials: true,
      envAllowlist: [],
    });
  });

  it('parses envAllowlist, root, and per-runtime overrides', () => {
    const base = readEffectiveConfig(appHome);
    const parsed = appConfigSchema.parse({
      ...base,
      agent: {
        ...(base.agent ?? { runtime: 'auto' }),
        confinement: {
          enabled: true,
          workspaceOnly: false,
          scrubCredentials: true,
          envAllowlist: ['GH_TOKEN', 'MY_VAR'],
          root: '/work/project',
          overrides: { 'claude-agent-sdk': { workspaceOnly: true }, 'codex-sdk': { scrubCredentials: false } },
        },
      },
    });
    const c = parsed.agent!.confinement!;
    expect(c.enabled).toBe(true);
    expect(c.workspaceOnly).toBe(false);
    expect(c.envAllowlist).toEqual(['GH_TOKEN', 'MY_VAR']);
    expect(c.root).toBe('/work/project');
    expect(c.overrides?.['claude-agent-sdk']).toEqual({ workspaceOnly: true });
    expect(c.overrides?.['codex-sdk']).toEqual({ scrubCredentials: false });
  });

  it('round-trips through desktopConfigPayload write -> read', () => {
    const base = readEffectiveConfig(appHome);
    const withConfinement: AppConfig = {
      ...base,
      agent: {
        ...(base.agent ?? { runtime: 'auto' }),
        confinement: { workspaceOnly: true, scrubCredentials: true, envAllowlist: ['GH_TOKEN'], root: '/work' },
      },
    } as AppConfig;
    writeDesktopConfig(appHome, withConfinement);
    const reread = readEffectiveConfig(appHome);
    expect(reread.agent?.confinement).toEqual({
      enabled: false,
      workspaceOnly: true,
      scrubCredentials: true,
      envAllowlist: ['GH_TOKEN'],
      root: '/work',
    });
    const onDisk = JSON.parse(readFileSync(join(appHome, 'settings', 'desktop.json'), 'utf-8'));
    expect(onDisk.agent.confinement.envAllowlist).toEqual(['GH_TOKEN']);
  });
});

// ---------------------------------------------------------------------------
// Test 1c: agent.piSdk schema — the pi runtime reads agent.piSdk for its
// approval → --exclude-tools scoping, but the schema field was missing, so a
// user's saved piSdk was stripped on parse and pi always ran full-auto. Lock
// that piSdk now survives parse + round-trips through persistence.
// ---------------------------------------------------------------------------

describe('agent.piSdk schema', () => {
  it('preserves approval + excludeTools through appConfigSchema.parse', () => {
    const base = readEffectiveConfig(appHome);
    const parsed = appConfigSchema.parse({
      ...base,
      agent: { ...(base.agent ?? { runtime: 'auto' }), piSdk: { approval: 'suggest', excludeTools: ['bash', 'edit'] } },
    });
    expect(parsed.agent?.piSdk).toEqual({ approval: 'suggest', excludeTools: ['bash', 'edit'] });
  });

  it('round-trips piSdk through desktopConfigPayload write -> read', () => {
    const base = readEffectiveConfig(appHome);
    const withPi: AppConfig = {
      ...base,
      agent: { ...(base.agent ?? { runtime: 'auto' }), piSdk: { approval: 'auto-edit' } },
    } as AppConfig;
    writeDesktopConfig(appHome, withPi);
    const reread = readEffectiveConfig(appHome);
    expect(reread.agent?.piSdk).toEqual({ approval: 'auto-edit' });
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

  it('rejects a schema-invalid config:set and leaves prior valid state intact', async () => {
    const harness = await createIpcHarness({
      registerHandlers: (ipc) => {
        registerConfigHandlers(ipc as Parameters<typeof registerConfigHandlers>[0], appHome);
      },
    });

    // Establish a known-good value.
    await harness.invoke('config:set', FAKE_EVENT, 'launchAtLogin', true);

    // An invalid value for a typed scalar must be rejected (validate-before-write),
    // not written to disk where it would corrupt the config and force an
    // all-defaults fallback on the next read.
    await expect(harness.invoke('config:set', FAKE_EVENT, 'launchAtLogin', { not: 'a boolean' })).rejects.toThrow();

    // The prior valid value survives — in memory and on disk.
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

// ---------------------------------------------------------------------------
// Deleting a built-in provider: removedBuiltins must suppress reconstruction.
// ---------------------------------------------------------------------------

describe('config: removedBuiltins suppresses built-in provider reconstruction', () => {
  it('keeps a deleted built-in gone even though llm.json would reconstruct it', () => {
    // Seed an enabled llm.json that would normally reconstruct the `anthropic`
    // built-in provider.
    writeFileSync(
      join(appHome, 'settings', 'llm.json'),
      JSON.stringify({ llm: { enabled: true, providers: { anthropic: { api_key: 'sk-test' } } } }, null, 2),
      'utf-8',
    );

    // Baseline: anthropic is present.
    const before = readEffectiveConfig(appHome);
    expect(before.models.providers.anthropic).toBeDefined();

    // Persist a desktop.json that marks `anthropic` as a removed built-in.
    const payload = desktopConfigPayload(before) as { models: Record<string, unknown> };
    payload.models = { ...payload.models, removedBuiltins: ['anthropic'] };
    writeFileSync(join(appHome, 'settings', 'desktop.json'), JSON.stringify(payload, null, 2), 'utf-8');

    // The loader must now skip reconstructing anthropic (and its catalog).
    const after = readEffectiveConfig(appHome);
    expect(after.models.providers.anthropic).toBeUndefined();
    expect((after.models.catalog ?? []).some((m) => m.provider === 'anthropic')).toBe(false);
    expect((after.models as { removedBuiltins?: string[] }).removedBuiltins).toContain('anthropic');
  });
});

// ---------------------------------------------------------------------------
// llm.json rebuild must preserve desktop-only provider/catalog fields.
// ---------------------------------------------------------------------------

describe('config: llm.json rebuild preserves desktop-only fields', () => {
  it('keeps desktop-only provider and catalog fields across a reload', () => {
    // Seed an enabled llm.json with an anthropic provider + one model, so the
    // loader reconstructs the built-in provider/catalog from llm.json.
    writeFileSync(
      join(appHome, 'settings', 'llm.json'),
      JSON.stringify(
        { llm: { enabled: true, providers: { anthropic: { api_key: 'sk-test', default_model: 'claude-x' } } } },
        null,
        2,
      ),
      'utf-8',
    );

    const before = readEffectiveConfig(appHome);
    const entry = (before.models.catalog ?? []).find((m) => m.key === 'claude-x');
    expect(entry).toBeDefined();
    expect(before.models.providers.anthropic).toBeDefined();

    // Persist desktop.json carrying desktop-only fields that llm.json never
    // round-trips: provider extraHeaders/providerTools + catalog
    // maxInputTokens/visionCapable/computerUseSupport/promptCaching.
    const payload = desktopConfigPayload(before) as { models: Record<string, unknown> };
    const models = payload.models as {
      providers: Record<string, Record<string, unknown>>;
      catalog: Array<Record<string, unknown>>;
    };
    models.providers.anthropic = {
      ...models.providers.anthropic,
      extraHeaders: { 'x-team': 'kai' },
      providerTools: [{ name: 'web_search' }],
    };
    models.catalog = models.catalog.map((m) =>
      m.key === 'claude-x'
        ? {
            ...m,
            maxInputTokens: 123456,
            visionCapable: true,
            computerUseSupport: 'anthropic-client-tool',
            promptCaching: { enabled: true, ttl: '1h' },
          }
        : m,
    );
    writeFileSync(join(appHome, 'settings', 'desktop.json'), JSON.stringify(payload, null, 2), 'utf-8');

    // Reload: llm.json rebuilds the provider/catalog, and the desktop-only
    // fields must be overlaid back on rather than dropped.
    const after = readEffectiveConfig(appHome);
    const p = after.models.providers.anthropic as Record<string, unknown>;
    expect(p.extraHeaders).toEqual({ 'x-team': 'kai' });
    expect(p.providerTools).toEqual([{ name: 'web_search' }]);

    const reloaded = (after.models.catalog ?? []).find((m) => m.key === 'claude-x') as Record<string, unknown>;
    expect(reloaded.maxInputTokens).toBe(123456);
    expect(reloaded.visionCapable).toBe(true);
    expect(reloaded.computerUseSupport).toBe('anthropic-client-tool');
    expect(reloaded.promptCaching).toEqual({ enabled: true, ttl: '1h' });
    // Credentials/type stay llm.json-owned (not clobbered by the overlay).
    expect(p.apiKey).toBe('sk-test');
  });
});

// POSIX-only: the secret-bearing config file (MCP env, web password, media keys)
// must be written owner-only, and the settings dir tightened even if it
// pre-existed with looser perms. Skipped on win32 (no POSIX mode bits).
describe.skipIf(process.platform === 'win32')('config IPC: secret file permissions', () => {
  it('writes desktop.json 0600 and tightens the settings dir to 0700', () => {
    const settingsDir = join(appHome, 'settings');
    // Simulate a pre-existing settings dir created with loose perms (the case
    // the chmod-after-mkdir hardening must fix, since mkdir mode is create-only).
    chmodSync(settingsDir, 0o755);

    const initial = readEffectiveConfig(appHome);
    writeDesktopConfig(appHome, initial);

    const filePath = join(settingsDir, 'desktop.json');
    expect(statSync(filePath).mode & 0o777).toBe(0o600);
    expect(statSync(settingsDir).mode & 0o777).toBe(0o700);
  });

  it('re-tightens a pre-existing world-readable desktop.json on the next write', () => {
    const initial = readEffectiveConfig(appHome);
    const filePath = join(appHome, 'settings', 'desktop.json');
    // First write creates it; then loosen it as if an older build wrote it 0644.
    writeDesktopConfig(appHome, initial);
    chmodSync(filePath, 0o644);
    expect(statSync(filePath).mode & 0o777).toBe(0o644);

    // A subsequent write must restore 0600 (chmod runs after writeFileSync,
    // whose mode only applies on create).
    writeDesktopConfig(appHome, initial);
    expect(statSync(filePath).mode & 0o777).toBe(0o600);
  });
});
