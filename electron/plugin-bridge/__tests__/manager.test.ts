import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { bridgeFixture, installSkill, installMcp, writeBridgeFile } from '../../../test-utils/plugin-bridge.js';
import { PluginBridgeManager, bridgeToolName } from '../manager.js';
import { BridgeStateStore, assertBridgeConfigWriteAllowed } from '../state.js';
import { loadPluginPlan } from '../manifest.js';
import { discoverInstallations } from '../discovery.js';
import { nativeMcpSources } from '../dedup.js';
import type { NativeBridgeSource } from '../types.js';
import type { ToolDefinition } from '../../tools/types.js';

describe('PluginBridgeManager consent, updates and isolated execution', () => {
  let f: ReturnType<typeof bridgeFixture>,
    manager: PluginBridgeManager,
    published: ToolDefinition[],
    native: NativeBridgeSource[];
  beforeEach(() => {
    f = bridgeFixture();
    published = [];
    native = [];
    manager = new PluginBridgeManager(
      f.appHome,
      f.store,
      () => f.config,
      () => native,
      (tools) => {
        published = tools;
      },
    );
  });
  afterEach(async () => {
    await manager.stop();
    f.cleanup();
  });
  async function approve(index = 0, overlap = false) {
    const plugin = manager.inventory()[index];
    await manager.approve(
      plugin.id,
      Object.fromEntries(plugin.components.map((c) => [c.id, c.revision])),
      overlap,
      plugin.packagePath,
    );
  }
  it('requires both the backend enable operation and per-component consent', async () => {
    const root = f.install('claude');
    const peer = installMcp(root);
    installSkill(root);
    f.config.pluginBridge.enabled = true;
    await manager.refresh();
    expect(published).toEqual([]);
    expect(manager.inventory()).toEqual([]);
    f.enableImports();
    await manager.refresh();
    expect(published).toEqual([]);
    expect(peer.starts()).toEqual([]);
    await approve();
    expect(published).toHaveLength(4);
    expect(peer.starts()).toHaveLength(1);
    const stale = published.find((t) => t.originalName === 'echo')!;
    f.config.pluginBridge.enabled = false;
    await manager.refresh();
    expect(published).toEqual([]);
    await expect(stale.execute({}, { toolCallId: 'x', conversationId: 'chat' })).rejects.toThrow('disabled');
    expect(Object.keys(f.store.get().grants)).toHaveLength(2);
  });
  it('automatically adopts instruction updates but gates access expansion before reading', async () => {
    const root = f.install('claude');
    installSkill(root);
    f.enableImports();
    await manager.refresh();
    await approve();
    const tool = published[0];
    installSkill(root, 'Updated instructions.');
    expect(await tool.execute({ file: 'SKILL.md' }, { toolCallId: 'x' })).toMatchObject({
      instructions: expect.stringContaining('Updated instructions.'),
    });
    installSkill(root, 'Expanded instructions.', 'write_file');
    await expect(tool.execute({ file: 'SKILL.md' }, { toolCallId: 'x' })).rejects.toThrow('requires review');
    expect(manager.inventory()[0].components[0]).toMatchObject({ status: 'review-required', selected: true });
  });
  it('retains explicit missing-component diagnostics and never activates new components', async () => {
    const root = f.install('claude');
    installSkill(root);
    f.enableImports();
    await manager.refresh();
    await approve();
    writeBridgeFile(join(root, 'skills', 'new', 'SKILL.md'), '---\ndescription: new\n---\nNew workflow');
    rmSync(join(root, 'skills', 'helper'), { recursive: true });
    await manager.refresh();
    expect(manager.inventory()[0].components.map((c) => [c.name, c.status, c.selected])).toEqual([
      ['skills/new', 'off', false],
      ['skills/helper', 'error', true],
    ]);
    expect(published).toEqual([]);
  });
  it('rejects stale reviews and explicitly selects ambiguous installed versions', async () => {
    const one = f.install('codex', 'sample', '1');
    installSkill(one);
    const two = f.install('codex', 'sample', '2');
    installSkill(two, 'New version');
    f.enableImports();
    await manager.refresh();
    const review = manager.inventory()[0];
    installSkill(one, 'Changed after review');
    await expect(
      manager.approve(review.id, Object.fromEntries(review.components.map((c) => [c.id, c.revision])), false, one),
    ).rejects.toThrow('changed');
    await manager.refresh();
    await approve(1);
    expect(manager.inventory().map((p) => p.selected)).toEqual([false, true]);
    expect(published).toHaveLength(1);
  });
  it('prefers native equivalents without mistaking package identity for account equivalence', async () => {
    const root = f.install('claude', 'sample', '1', {
      name: 'sample',
      repository: 'https://example.com/plugins/sample',
    });
    installSkill(root);
    const plan = loadPluginPlan(discoverInstallations(f.homes).installations[0], f.appHome);
    native = [{ id: 'plugin:sample', name: 'Sample native', packageIdentity: plan.packageIdentity }];
    f.enableImports();
    await manager.refresh();
    expect(manager.inventory()[0].overlaps[0].confidence).toBe('possible');
    native[0].componentIdentities = [plan.components[0].identity];
    await manager.refresh();
    expect(manager.inventory()[0].overlaps[0].confidence).toBe('verified');
    await expect(approve()).rejects.toThrow('overlap');
    await approve(0, true);
    expect(published).toHaveLength(1);
  });
  it('keeps concurrent chat and subagent MCP sessions distinct, with bounded cancellation', async () => {
    const root = f.install('claude');
    const peer = installMcp(root);
    f.enableImports();
    await manager.refresh();
    await approve();
    const echo = published.find((t) => t.originalName === 'echo')!,
      wait = published.find((t) => t.originalName === 'wait')!;
    const [first, second] = await Promise.all([
      echo.execute({ value: 'one' }, { toolCallId: '1', conversationId: 'chat-a', cwd: f.homes.claude }),
      echo.execute({ value: 'two' }, { toolCallId: '2', conversationId: 'child-b', cwd: f.homes.codex }),
    ]);
    expect(first).toMatchObject({
      structuredContent: { session: `kai:${f.store.get().instanceId}:chat-a`, cwd: f.homes.claude },
    });
    expect(second).toMatchObject({
      structuredContent: { session: `kai:${f.store.get().instanceId}:child-b`, cwd: f.homes.codex },
    });
    const controller = new AbortController();
    const call = wait.execute(
      {},
      { toolCallId: '3', conversationId: 'chat-a', cwd: f.homes.claude, abortSignal: controller.signal },
    );
    controller.abort();
    await expect(call).rejects.toThrow();
    expect(peer.starts()).toHaveLength(3);
  });
  it('recognizes an equivalent configured native endpoint but keeps authenticated accounts separate', async () => {
    const root = f.install('claude');
    writeBridgeFile(join(root, 'mcp.json'), { mcpServers: { fixture: { url: 'https://fixture.test/mcp' } } });
    f.config.mcpServers = [{ name: 'native-endpoint', url: 'https://fixture.test/mcp', enabled: true }];
    native = nativeMcpSources(f.config, () => false);
    f.enableImports();
    await manager.refresh();
    expect(manager.inventory()[0].overlaps).toMatchObject([
      { sourceId: 'mcp:native-endpoint', native: true, confidence: 'verified' },
    ]);
    await expect(approve()).rejects.toThrow('overlap');
    native = nativeMcpSources(f.config, () => true);
    await manager.refresh();
    expect(manager.inventory()[0].overlaps.some((o) => o.confidence === 'verified')).toBe(false);
    native = nativeMcpSources(f.config, () => false);
    writeBridgeFile(join(root, 'mcp.json'), {
      mcpServers: {
        fixture: { url: 'https://fixture.test/mcp', headers: { Authorization: 'Bearer fixture-different-account' } },
      },
    });
    await manager.refresh();
    expect(manager.inventory()[0].overlaps.some((o) => o.confidence === 'verified')).toBe(false);
    expect(published).toEqual([]);
  });
  it('rejects aliased Kai forwarding servers after handshake', async () => {
    const root = f.install('claude');
    installMcp(root, 'kai-mcp');
    f.enableImports();
    await manager.refresh();
    await approve();
    expect(published).toEqual([]);
    expect(manager.inventory()[0].components[0].status).toBe('error');
  });
  it('does not expose approval grants through ordinary config setters', () => {
    for (const path of ['pluginBridge', 'pluginBridge.enabled', 'mcpExport', 'mcpExport.remote.enabled', ''])
      expect(() => assertBridgeConfigWriteAllowed(path)).toThrow('human');
    expect(() => assertBridgeConfigWriteAllowed('tools.executionMode')).not.toThrow();
    writeBridgeFile(join(f.appHome, 'plugin-bridge', 'approvals.json'), 'invalid');
    const corrupt = new BridgeStateStore(f.appHome);
    expect(corrupt.get().importsEnabled).toBe(false);
    expect(() => corrupt.update(() => {})).toThrow('unreadable');
  });
  it('uses deterministic names within every runtime limit', () => {
    const first = bridgeToolName('claude:sample/mcp/server', 'x'.repeat(100));
    expect(first.length).toBeLessThanOrEqual(54);
    expect(first).toBe(bridgeToolName('claude:sample/mcp/server', 'x'.repeat(100)));
    expect(first).not.toBe(bridgeToolName('codex:sample/mcp/server', 'x'.repeat(100)));
  });
});
