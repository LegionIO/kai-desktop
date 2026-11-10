import { mkdtempSync, realpathSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appConfigSchema, type AppConfig } from '../electron/config/schema.js';
import type { PluginHost } from '../shared/plugin-bridge.js';
import { BridgeStateStore } from '../electron/plugin-bridge/state.js';
import { SharingCredentials } from '../electron/mcp-sharing/credentials.js';
import { fixtureEncryption } from './mcp-oauth.js';
import { PluginBridgeSystem } from '../electron/plugin-bridge/system.js';
import type { ToolDefinition } from '../electron/tools/types.js';

import { writeBridgeFile } from './plugin-bridge-files.js';
export {
  writeBridgeFile,
  installSkill,
  installMcp,
  installHooks,
  installClanksFixture,
} from './plugin-bridge-files.js';

export function bridgeFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kai-bridge-test-')));
  const homes = { claude: join(root, 'claude'), codex: join(root, 'codex') };
  const appHome = join(root, 'kai');
  Object.values(homes).forEach((home) => mkdirSync(home, { recursive: true }));
  // Only fields read by these services; defaults for the new sections come
  // from the production schema, so the disabled-default contract is exercised.
  const config = {
    pluginBridge: {
      ...appConfigSchema.shape.pluginBridge.parse(undefined),
      claudeHome: homes.claude,
      codexHome: homes.codex,
    },
    mcpExport: appConfigSchema.shape.mcpExport.parse(undefined),
    tools: { executionMode: 'auto' },
    models: { defaultModelKey: 'fixture' },
    systemPrompt: '',
    mcpServers: [],
    webServer: {
      enabled: false,
      auth: { mode: 'password', username: 'fixture', password: 'fixture-password' },
      tls: { enabled: false },
    },
  } as unknown as AppConfig;
  const store = new BridgeStateStore(appHome);
  const credentials = new SharingCredentials(appHome, fixtureEncryption(), store, () => config);
  const claude: Record<string, unknown[]> = {};
  const codex = new Set<string>();
  function install(host: PluginHost, name = 'sample', version = '1.0.0', manifest: object = { name, version }) {
    const packageRoot = join(homes[host], 'plugins', 'cache', 'fixture', name, version);
    writeBridgeFile(join(packageRoot, `.${host}-plugin`, 'plugin.json'), manifest);
    const key = `${name}@fixture`;
    if (host === 'claude') {
      claude[key] = [{ scope: 'user', version, installPath: packageRoot }];
      writeBridgeFile(join(homes.claude, 'plugins', 'installed_plugins.json'), { version: 2, plugins: claude });
      writeBridgeFile(join(homes.claude, 'settings.json'), { enabledPlugins: { [key]: true } });
    } else {
      codex.add(key);
      writeBridgeFile(
        join(homes.codex, 'config.toml'),
        [...codex].map((id) => `[plugins."${id}"]\nenabled = true\n`).join('\n'),
      );
    }
    return packageRoot;
  }
  function enableImports() {
    config.pluginBridge.enabled = true;
    store.update((state) => {
      state.importsEnabled = true;
    });
  }
  function enableSharing(remote = false) {
    config.mcpExport.enabled = true;
    config.mcpExport.remote = { enabled: remote, publicUrl: 'https://kai.test/mcp' };
    config.webServer.enabled = remote;
    config.webServer.tls.enabled = remote;
    store.update((state) => {
      state.sharingEnabled = true;
      state.remoteEnabled = remote;
    });
  }
  function localClient(name = 'fixture client') {
    const client = credentials.createClient(name, 'local', null);
    const token = credentials.issue(client.id, 'local', Date.now() + 86_400_000);
    return { client, token, principal: credentials.verify(token, 'local')! };
  }
  return {
    root,
    homes,
    appHome,
    config,
    store,
    credentials,
    install,
    enableImports,
    enableSharing,
    localClient,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

export function bridgeSystemFixture(initialTools: ToolDefinition[] = []) {
  const fixture = bridgeFixture();
  let registered = initialTools;
  const system = new PluginBridgeSystem({
    appHome: fixture.appHome,
    getConfig: () => fixture.config,
    setConfig: (section, value) => {
      Object.assign(fixture.config, { [section]: value });
    },
    encryption: fixtureEncryption(),
    nativeSources: () => [],
    getTools: () => registered,
    publishTools: (tools) => {
      registered = [...registered.filter((tool) => tool.source !== 'bridge'), ...tools];
    },
    sourceEnabled: () => true,
    launcher: () => ({ command: '/fixture/bin/kai', args: [] }),
  });
  return {
    ...fixture,
    system,
    tools: () => registered,
    close: async () => {
      await system.close();
      fixture.cleanup();
    },
  };
}
