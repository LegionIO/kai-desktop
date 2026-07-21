import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { inspectSeaCompatibility, resolveSeaHostExecutable, selectPluginHostRuntime } from '../runtime-selection.js';
import type { PluginManifest } from '../../types.js';

const roots: string[] = [];
const originalSeaHost = process.env.KAI_PLUGIN_SEA_HOST;
const originalRuntimeOverride = process.env.KAI_PLUGIN_HOST_RUNTIME;
const originalResourcesPath = Object.getOwnPropertyDescriptor(process, 'resourcesPath');

function manifest(permissions: PluginManifest['permissions'] = []): PluginManifest {
  return {
    name: 'fixture',
    displayName: 'Fixture',
    version: '1.0.0',
    description: 'Runtime selection fixture',
    permissions,
  };
}

function fixture(source = 'export async function activate(api) { api.log.info("ready"); }') {
  const root = mkdtempSync(join(tmpdir(), 'kai-sea-selection-'));
  roots.push(root);
  const backend = join(root, 'backend.js');
  writeFileSync(backend, source);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fixture', type: 'module' }));
  return { root, backend };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  if (originalSeaHost === undefined) delete process.env.KAI_PLUGIN_SEA_HOST;
  else process.env.KAI_PLUGIN_SEA_HOST = originalSeaHost;
  if (originalRuntimeOverride === undefined) delete process.env.KAI_PLUGIN_HOST_RUNTIME;
  else process.env.KAI_PLUGIN_HOST_RUNTIME = originalRuntimeOverride;
  if (originalResourcesPath) Object.defineProperty(process, 'resourcesPath', originalResourcesPath);
  else delete (process as unknown as { resourcesPath?: string }).resourcesPath;
});

describe('SEA plugin compatibility preflight', () => {
  it('allows a pure JavaScript plugin without requiring a manifest rewrite', () => {
    const { root, backend } = fixture();
    expect(inspectSeaCompatibility(root, backend)).toEqual({ compatible: true });
  });

  it('routes native addons to the Electron compatibility host before activation', () => {
    const { root, backend } = fixture();
    mkdirSync(join(root, 'node_modules', 'native'), { recursive: true });
    writeFileSync(join(root, 'node_modules', 'native', 'binding.node'), 'fixture');
    expect(inspectSeaCompatibility(root, backend)).toMatchObject({
      compatible: false,
      reason: expect.stringContaining('native addon'),
    });
  });

  it('routes direct Electron consumers to the compatibility host', () => {
    const { root, backend } = fixture("import { net } from 'electron'; export function activate() { void net; }");
    expect(inspectSeaCompatibility(root, backend)).toMatchObject({
      compatible: false,
      reason: expect.stringContaining('Electron dependency'),
    });
  });

  it('selects SEA for a compatible light plugin when a host is available', () => {
    const { root, backend } = fixture();
    const seaHost = join(root, 'kai-plugin-host');
    writeFileSync(seaHost, '#!/bin/sh\n');
    chmodSync(seaHost, 0o755);
    process.env.KAI_PLUGIN_SEA_HOST = seaHost;
    delete process.env.KAI_PLUGIN_HOST_RUNTIME;

    expect(selectPluginHostRuntime(manifest(['network:fetch']), root, backend)).toMatchObject({
      runtime: 'node-sea',
      seaHostPath: seaHost,
    });
  });

  it('resolves the architecture-specific host from a packaged resources directory', () => {
    const { root } = fixture();
    const name = process.platform === 'win32' ? 'kai-plugin-host.exe' : 'kai-plugin-host';
    const seaHost = join(root, 'plugin-host', `${process.platform}-${process.arch}`, name);
    mkdirSync(join(seaHost, '..'), { recursive: true });
    writeFileSync(seaHost, '#!/bin/sh\n');
    chmodSync(seaHost, 0o755);
    delete process.env.KAI_PLUGIN_SEA_HOST;
    Object.defineProperty(process, 'resourcesPath', { configurable: true, value: root });

    expect(resolveSeaHostExecutable()).toBe(seaHost);
  });

  it.each([
    'tools:register',
    'safe-storage',
    'conversations:read',
    'conversations:write',
    'system:env',
    'agent:inference-provider',
  ] as const)('keeps %s plugins on the lower-footprint Electron compatibility host', (permission) => {
    const { root, backend } = fixture();
    const seaHost = join(root, 'kai-plugin-host');
    writeFileSync(seaHost, '#!/bin/sh\n');
    chmodSync(seaHost, 0o755);
    process.env.KAI_PLUGIN_SEA_HOST = seaHost;
    delete process.env.KAI_PLUGIN_HOST_RUNTIME;

    expect(selectPluginHostRuntime(manifest([permission]), root, backend)).toMatchObject({
      runtime: 'electron-utility',
      reason: expect.stringContaining(permission),
    });
  });
});
