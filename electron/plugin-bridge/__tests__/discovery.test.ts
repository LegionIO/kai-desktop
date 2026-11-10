import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { symlinkSync, rmSync, existsSync } from 'node:fs';
import {
  bridgeFixture,
  installSkill,
  installMcp,
  installHooks,
  writeBridgeFile,
} from '../../../test-utils/plugin-bridge.js';
import { discoverInstallations, hostHomes } from '../discovery.js';
import { loadPluginPlan, expandPluginVariables } from '../manifest.js';
import { packageFile } from '../files.js';

describe('installed plugin discovery and plans', () => {
  let f: ReturnType<typeof bridgeFixture>;
  beforeEach(() => {
    f = bridgeFixture();
  });
  afterEach(() => f.cleanup());
  it('discovers user installations with independent host enablement, without launching code', () => {
    const root = f.install('claude');
    installSkill(root);
    const peer = installMcp(root);
    const result = discoverInstallations(f.homes);
    expect(result.installations).toHaveLength(1);
    const plan = loadPluginPlan(result.installations[0], f.appHome);
    expect(plan.public.hostEnabled).toBe(true);
    expect(plan.public.components.map((c) => c.status)).toEqual(['off', 'off']);
    expect(plan.public.components.map((c) => c.kind)).toEqual(['mcp', 'skill']);
    expect(JSON.stringify(plan.public)).not.toContain('fixture-secret-value');
    expect(existsSync(peer.log)).toBe(false);
  });
  it('ignores project registrations and refuses development-folder sources', () => {
    const root = f.install('claude');
    writeBridgeFile(join(f.homes.claude, 'plugins', 'installed_plugins.json'), {
      plugins: {
        project: [{ scope: 'project', installPath: root }],
        development: [{ scope: 'user', installPath: f.root }],
      },
    });
    expect(discoverInstallations(f.homes).installations).toEqual([]);
    expect(discoverInstallations(f.homes).diagnostics).toHaveLength(1);
  });
  it('uses configured marketplace version metadata instead of guessing from caches', () => {
    f.install('codex', 'sample', '1.0.0');
    f.install('codex', 'sample', '2.0.0');
    const market = join(f.root, 'marketplace');
    writeBridgeFile(join(market, '.agents/plugins/marketplace.json'), {
      name: 'fixture',
      plugins: [{ name: 'sample', version: '1.0.0' }],
    });
    writeBridgeFile(
      join(f.homes.codex, 'config.toml'),
      `[plugins."sample@fixture"]\nenabled=false\n[marketplaces.fixture]\nsource=${JSON.stringify(market)}\n`,
    );
    const installed = discoverInstallations(f.homes).installations;
    expect(installed.map((p) => p.version)).toEqual(['1.0.0']);
    expect(installed[0].hostEnabled).toBe(false);
    expect(installed[0].ambiguous).toBe(false);
  });
  it('requires explicit choice when two versions cannot be disambiguated', () => {
    f.install('codex', 'sample', '1');
    f.install('codex', 'sample', '2');
    expect(discoverInstallations(f.homes).installations.every((p) => p.ambiguous)).toBe(true);
    writeBridgeFile(join(f.homes.codex, 'config.toml'), '[plugins."sample@fixture"]\nenabled=true\nversion="missing"');
    expect(discoverInstallations(f.homes).installations.map((p) => p.version)).toEqual(['missing']);
  });
  it('matches local cache metadata without treating another build as a fallback', () => {
    f.install('codex', 'sample', 'local', { name: 'sample', version: '1.2.0' });
    writeBridgeFile(join(f.homes.codex, 'config.toml'), '[plugins."sample@fixture"]\nenabled=false\nversion="1.2.0"');
    expect(discoverInstallations(f.homes).installations).toMatchObject([{ version: 'local', ambiguous: false }]);
    writeBridgeFile(join(f.homes.codex, 'config.toml'), '[plugins."sample@fixture"]\nenabled=false\nversion="2.0.0"');
    expect(discoverInstallations(f.homes).installations).toMatchObject([{ version: '2.0.0' }]);
    expect(discoverInstallations(f.homes).diagnostics).toHaveLength(1);
  });
  it('does not identify an orphaned cache as a current install', () => {
    f.install('codex');
    rmSync(join(f.homes.codex, 'config.toml'));
    expect(discoverInstallations(f.homes).installations[0].ambiguous).toBe(true);
  });
  it('handles portable extension hook arrays and reports unsupported components', () => {
    const root = f.install('codex');
    installSkill(root);
    writeBridgeFile(join(root, 'plugin.json'), {
      name: 'portable',
      extensions: { 'com.openai': { hooks: ['./a.json', './b.json'] } },
      agents: './agents',
    });
    writeBridgeFile(join(root, 'a.json'), {
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo one' }] }] },
    });
    writeBridgeFile(join(root, 'b.json'), {
      hooks: {
        SessionStart: [{ hooks: [{ type: 'command', command: 'echo two' }] }],
        Idle: [{ type: 'prompt', prompt: 'x' }],
      },
    });
    const plan = loadPluginPlan(discoverInstallations(f.homes).installations[0], f.appHome);
    expect(plan.components.find((c) => c.hooks)?.hooks?.commands).toHaveLength(2);
    expect(plan.components.filter((c) => c.public.status === 'unsupported').map((c) => c.public.name)).toEqual([
      'hooks:Idle',
      'agents',
    ]);
  });
  it('bounds package file access including symlinks and expands only declared variables', () => {
    const root = f.install('claude');
    installSkill(root);
    writeBridgeFile(join(f.root, 'secret'), 'outside');
    symlinkSync(join(f.root, 'secret'), join(root, 'escape'));
    expect(() => packageFile(root, 'escape')).toThrow('symlink');
    expect(() => packageFile(root, '../../escape')).toThrow('escapes');
    expect(
      expandPluginVariables('${PLUGIN_ROOT}/${DECLARED}/${MISSING:-fallback}', root, '/data', { DECLARED: 'value' }),
    ).toBe(`${root}/value/fallback`);
    expect(() => expandPluginVariables('${MISSING}', root, '/data', {})).toThrow('not configured');
    expect(hostHomes({ claudeHome: f.homes.claude, codexHome: f.homes.codex })).toEqual(f.homes);
  });
  it('loads portable compatibility overlays and referenced MCP arrays with package-relative arguments', () => {
    const root = f.install('codex', 'sample', 'local', {
      name: 'sample',
      mcpServers: ['./a.json', './b.json'],
      hooks: './hooks/hooks.json',
    });
    writeBridgeFile(join(root, 'plugin.json'), { name: 'portable', version: '1.0.0' });
    writeBridgeFile(join(root, 'server file.mjs'), '// fixture only');
    writeBridgeFile(join(root, 'a.json'), {
      mcpServers: { one: { command: process.execPath, args: ['./server file.mjs'] } },
    });
    writeBridgeFile(join(root, 'b.json'), {
      mcpServers: { two: { type: 'streamable-http', url: 'https://fixture.test/mcp' } },
    });
    writeBridgeFile(join(root, 'hooks/hooks.json'), {
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo fixture' }] }] },
    });
    const plan = loadPluginPlan(discoverInstallations(f.homes).installations[0], f.appHome);
    expect(plan.public.name).toBe('portable');
    expect(plan.components.map((c) => c.public.name)).toEqual(['one', 'two', 'SessionStart']);
    expect(plan.components[0].mcp?.args).toEqual([join(root, 'server file.mjs')]);
    expect(plan.components.every((c) => c.public.status === 'off')).toBe(true);
  });
  it('does not silently combine duplicate server identifiers from referenced configurations', () => {
    const root = f.install('claude', 'sample', '1', { name: 'sample', mcpServers: ['./a.json', './b.json'] });
    for (const name of ['a', 'b'])
      writeBridgeFile(join(root, `${name}.json`), {
        mcpServers: { duplicate: { command: process.execPath, args: [] } },
      });
    const plan = loadPluginPlan(discoverInstallations(f.homes).installations[0], f.appHome);
    expect(plan.components).toEqual([]);
    expect(plan.public.diagnostics).toContain('The referenced MCP configuration could not be read.');
  });
  it('resolves plugin-root variables in component references while retaining package containment', () => {
    const root = f.install('claude', 'sample', '1', {
      name: 'sample',
      mcpServers: '${CLAUDE_PLUGIN_ROOT}/mcp.json',
      skills: '${PLUGIN_ROOT}/skills',
      hooks: '${CODEX_PLUGIN_ROOT}/hooks/hooks.json',
    });
    installMcp(root);
    installSkill(root);
    installHooks(root, ['SessionStart']);
    const plan = loadPluginPlan(discoverInstallations(f.homes).installations[0], f.appHome);
    expect(plan.components.map((c) => c.public.kind)).toEqual(['mcp', 'skill', 'hooks']);
    expect(plan.public.diagnostics).toEqual([]);
    expect(plan.components.every((c) => c.public.status === 'off')).toBe(true);
  });
  it('rejects importing a known Kai forwarding connector', () => {
    const root = f.install('claude');
    writeBridgeFile(join(root, 'mcp.json'), { mcpServers: { 'kai-mcp': { command: 'kai', args: ['mcp', 'serve'] } } });
    const plan = loadPluginPlan(discoverInstallations(f.homes).installations[0], f.appHome);
    expect(plan.components[0].public.status).toBe('error');
  });
});
