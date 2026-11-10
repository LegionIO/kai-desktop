import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IpcMain } from 'electron';
import { createIpcHarness, type IpcHarness } from '../../../test-utils/ipc-harness.js';
import { bridgeSystemFixture, installSkill } from '../../../test-utils/plugin-bridge.js';
import { registerPluginBridgeHandlers } from '../../ipc/plugin-bridge.js';
import { assertBridgeConfigWriteAllowed } from '../state.js';

describe('backend-owned bridge approvals', () => {
  let f: ReturnType<typeof bridgeSystemFixture>, ipc: IpcHarness;
  const primary = { sender: 'primary' },
    foreign = { sender: 'foreign' };
  const confirm = vi.fn<(_: string, detail: string) => Promise<boolean>>();
  beforeEach(async () => {
    f = bridgeSystemFixture();
    confirm.mockReset().mockResolvedValue(true);
    ipc = await createIpcHarness({
      registerHandlers: (main) =>
        registerPluginBridgeHandlers(main as unknown as IpcMain, f.system, {
          isPrimary: (event) => (event as unknown) === primary,
          confirm,
        }),
    });
  });
  afterEach(async () => {
    ipc.reset();
    await f.close();
  });
  it('keeps all switches off and rejects generic config grants', () => {
    expect(f.system.snapshot()).toMatchObject({
      importsEnabled: false,
      sharingEnabled: false,
      remoteEnabled: false,
      plugins: [],
    });
    for (const path of ['', 'pluginBridge', 'pluginBridge.enabled', 'mcpExport', 'mcpExport.remote.enabled'])
      expect(() => assertBridgeConfigWriteAllowed(path)).toThrow('human approval');
    expect(() => assertBridgeConfigWriteAllowed('tools.executionMode')).not.toThrow();
  });
  it('rejects imported/plugin and general local IPC authority before changing anything', async () => {
    for (const event of [foreign, { __kaiWebBridge: true }, { __kaiHumanWeb: false }]) {
      await expect(ipc.invoke('plugin-bridge:mutate', event, { action: 'imports', enabled: true })).rejects.toThrow(
        'settings UI',
      );
    }
    expect(confirm).not.toHaveBeenCalled();
    expect(f.system.imports.enabled()).toBe(false);
  });
  it('requires human confirmation and binds approval to the reviewed revision', async () => {
    const root = f.install('claude');
    installSkill(root);
    confirm.mockResolvedValueOnce(false);
    await expect(ipc.invoke('plugin-bridge:mutate', primary, { action: 'imports', enabled: true })).rejects.toThrow(
      'cancelled',
    );
    await ipc.invoke('plugin-bridge:mutate', primary, { action: 'imports', enabled: true });
    expect(f.system.imports.getTools()).toEqual([]);
    const plugin = f.system.imports.inventory()[0],
      component = plugin.components[0];
    await expect(
      ipc.invoke('plugin-bridge:mutate', primary, {
        action: 'approve',
        pluginId: plugin.id,
        revisions: { [component.id]: '0'.repeat(64) },
        allowOverlap: false,
        packagePath: root,
      }),
    ).rejects.toThrow('changed');
    await ipc.invoke('plugin-bridge:mutate', primary, {
      action: 'approve',
      pluginId: plugin.id,
      revisions: { [component.id]: component.revision },
      allowOverlap: false,
      packagePath: root,
    });
    expect(confirm.mock.calls.at(-1)?.[1]).toContain(root);
    expect(confirm.mock.calls.at(-1)?.[1]).toContain('not an OS sandbox');
    expect(f.system.imports.getTools()).toHaveLength(1);
    expect(f.system.sharing.enabled()).toBe(false);
    await ipc.invoke('plugin-bridge:mutate', primary, { action: 'imports', enabled: false });
    expect(f.system.imports.getTools()).toEqual([]);
    expect(f.system.store.get().grants[component.id]).toBeDefined();
  });
  it('keeps authenticated Web UI authority separate from general IPC', async () => {
    await ipc.invoke('plugin-bridge:mutate', { __kaiHumanWeb: true }, { action: 'sharing', enabled: true });
    expect(f.system.sharing.enabled()).toBe(true);
    expect(f.system.imports.enabled()).toBe(false);
    expect(confirm).not.toHaveBeenCalled();
    await expect(
      ipc.invoke('plugin-bridge:mutate', primary, { action: 'exports', sources: ['invented'], tools: [] }),
    ).rejects.toThrow('inventory changed');
  });
});
