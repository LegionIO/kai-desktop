import { z } from 'zod';
import type { AppConfig } from '../config/schema.js';
import type { ToolDefinition } from '../tools/types.js';
import type { McpEncryption } from '../mcp/credential-store.js';
import type { BridgeMutation, BridgeSnapshot } from '../../shared/plugin-bridge.js';
import { BridgeStateStore } from './state.js';
import { PluginBridgeManager, BRIDGE_COMPATIBILITY } from './manager.js';
import { ImportedHooks } from './hooks.js';
import { setBridgeLifecycle, type BridgePromptGate } from './lifecycle.js';
import type { NativeBridgeSource } from './types.js';
import { SharingCredentials, remoteProblems } from '../mcp-sharing/credentials.js';
import { KaiMcpService } from '../mcp-sharing/service.js';
import { McpClientSetup } from '../mcp-sharing/setup.js';
import { RemoteMcpEndpoint } from '../mcp-sharing/remote.js';
import { setMcpHttpHandler } from '../mcp-sharing/http-hook.js';
import { setLocalMcpHandler } from '../mcp-sharing/local-hook.js';
import { hash, nativeBridgeSessionId } from './files.js';

export class PluginBridgeSystem {
  readonly store: BridgeStateStore;
  readonly imports: PluginBridgeManager;
  readonly hooks: ImportedHooks;
  readonly credentials: SharingCredentials;
  readonly sharing: KaiMcpService;
  readonly setup: McpClientSetup;
  readonly remote: RemoteMcpEndpoint;
  private timer?: ReturnType<typeof setInterval>;
  private refreshing = false;
  private authFingerprint: string;
  private importFingerprint: string;
  private queue: Promise<unknown> = Promise.resolve();
  private resolveLocalReady!: () => void;
  private readonly localReady = new Promise<void>((resolve) => {
    this.resolveLocalReady = resolve;
  });
  private localReadyError?: Error;
  constructor(
    private readonly options: {
      appHome: string;
      getConfig: () => AppConfig;
      setConfig: (section: 'pluginBridge' | 'mcpExport', value: unknown) => void;
      encryption: McpEncryption;
      nativeSources: () => NativeBridgeSource[];
      getTools: () => ToolDefinition[];
      publishTools: (tools: ToolDefinition[]) => void;
      sourceEnabled: (tool: ToolDefinition) => boolean;
      launcher: () => { command: string; args: string[] };
      preSend?: BridgePromptGate;
    },
  ) {
    this.store = new BridgeStateStore(options.appHome);
    this.imports = new PluginBridgeManager(
      options.appHome,
      this.store,
      options.getConfig,
      options.nativeSources,
      options.publishTools,
    );
    this.hooks = new ImportedHooks(this.imports);
    this.credentials = new SharingCredentials(options.appHome, options.encryption, this.store, options.getConfig);
    this.sharing = new KaiMcpService(
      this.store,
      options.getConfig,
      options.getTools,
      (tool) => {
        if (!tool.bridge) return options.sourceEnabled(tool);
        try {
          this.imports.revalidate(tool.bridge.componentId);
          return true;
        } catch {
          return false;
        }
      },
      (principal) => this.credentials.active(principal),
    );
    this.remote = new RemoteMcpEndpoint(this.sharing, this.credentials);
    this.sharing.onSessionClosed = (id) => {
      void this.imports.pool.closeSession(nativeBridgeSessionId(this.store.get().instanceId, id));
      void this.hooks.end(id);
    };
    this.setup = new McpClientSetup(this.credentials, () => this.imports.homes(), options.launcher);
    this.credentials.onRevoked = () => {
      this.sharing.changed();
      this.remote.sweep();
    };
    this.authFingerprint = this.authConfigFingerprint();
    this.importFingerprint = hash(options.getConfig().pluginBridge);
    // Authenticate restricted connectors before the early local socket opens.
    // They keep headless startup alive while native integrations initialize.
    this.registerLocalConnector();
  }
  async initialize(): Promise<void> {
    try {
      await this.initializeServices();
    } catch (error) {
      this.localReadyError = new Error('Kai MCP backend initialization failed.');
      throw error;
    } finally {
      this.resolveLocalReady();
    }
  }
  private registerLocalConnector(): void {
    setLocalMcpHandler({
      authenticate: (token) => (this.sharing.enabled() ? this.credentials.verify(token, 'local') : null),
      active: (principal) => this.sharing.enabled() && this.credentials.active(principal),
      invoke: async (principal, sessionId, channel, args, emit) => {
        if (channel === 'kai-mcp:list' || channel === 'kai-mcp:call') {
          await this.localReady;
          if (this.localReadyError) throw this.localReadyError;
        }
        if (channel === 'kai-mcp:list') return this.sharing.list(principal);
        if (channel === 'kai-mcp:cancel') {
          this.sharing.cancel(principal, sessionId, z.string().parse(args[0]));
          return null;
        }
        if (channel === 'kai-mcp:call') {
          const input = z
            .object({
              name: z.string().max(200),
              args: z.unknown(),
              callId: z.string().uuid(),
              origin: z.array(z.string()).max(8).optional(),
            })
            .strict()
            .parse(args[0]);
          return this.sharing.call(principal, input.name, input.args, {
            sessionId,
            callId: input.callId,
            origin: input.origin,
            onProgress: (progress) => emit('kai-mcp:progress', { callId: input.callId, ...progress }),
          });
        }
        throw new Error('Kai MCP credentials cannot access administrative IPC.');
      },
      closed: (principal, sessionId) => {
        this.sharing.closeSession(principal, sessionId);
      },
      subscribe: (listener) => this.sharing.onChanged(listener),
    });
  }
  private async initializeServices(): Promise<void> {
    setBridgeLifecycle(this.hooks, this.options.preSend);
    setMcpHttpHandler(
      (req, res, session) => this.remote.handle(req, res, session),
      () => this.remote.close(),
    );
    await this.imports.refresh();
    this.timer = setInterval(() => {
      this.sharing.changed();
      this.remote.sweep();
      if (!this.imports.enabled() || this.refreshing) return;
      this.refreshing = true;
      void this.imports
        .refresh()
        .catch(() => this.store.record('error', 'Installed plugin refresh failed.'))
        .finally(() => {
          this.refreshing = false;
        });
    }, 30_000);
    this.timer.unref();
  }
  snapshot(): BridgeSnapshot {
    const config = this.options.getConfig();
    return {
      importsEnabled: this.imports.enabled(),
      sharingEnabled: this.sharing.enabled(),
      remoteEnabled: this.store.get().remoteEnabled && config.mcpExport.remote.enabled,
      publicUrl: config.mcpExport.remote.publicUrl,
      hostHomes: this.imports.homes(),
      plugins: this.imports.inventory(),
      compatibility: BRIDGE_COMPATIBILITY,
      sources: this.sharing.inventory(),
      clients: this.credentials.clients(),
      activity: this.store.recent(),
      remoteProblems: remoteProblems(config),
      credentialStorage: this.credentials.storage,
    };
  }
  async discover(): Promise<BridgeSnapshot> {
    await this.imports.refresh();
    return this.snapshot();
  }
  mutate(change: BridgeMutation): Promise<BridgeSnapshot> {
    const next = this.queue.then(() => this.apply(change));
    this.queue = next.catch(() => {});
    return next;
  }
  private async apply(change: BridgeMutation): Promise<BridgeSnapshot> {
    const config = this.options.getConfig();
    switch (change.action) {
      case 'imports':
        this.store.update((state) => {
          state.importsEnabled = change.enabled;
        });
        this.options.setConfig('pluginBridge', { ...config.pluginBridge, enabled: change.enabled });
        if (!change.enabled) await this.imports.stop();
        await this.imports.refresh();
        break;
      case 'homes':
        this.options.setConfig('pluginBridge', {
          ...config.pluginBridge,
          claudeHome: change.claude,
          codexHome: change.codex,
        });
        await this.imports.refresh();
        break;
      case 'approve':
        await this.imports.approve(change.pluginId, change.revisions, change.allowOverlap, change.packagePath);
        break;
      case 'sharing':
        this.store.update((state) => {
          state.sharingEnabled = change.enabled;
        });
        this.options.setConfig('mcpExport', { ...config.mcpExport, enabled: change.enabled });
        if (!change.enabled) {
          this.credentials.revokeRemote();
          await this.sharing.stop();
          await this.remote.close();
        }
        break;
      case 'remote': {
        const next = { ...config.mcpExport, remote: { enabled: change.enabled, publicUrl: change.publicUrl } };
        if (change.enabled && remoteProblems({ ...config, mcpExport: next }).length)
          throw new Error(remoteProblems({ ...config, mcpExport: next }).join(' '));
        if (!change.enabled || change.publicUrl !== config.mcpExport.remote.publicUrl) {
          this.credentials.revokeRemote();
          await this.remote.close();
        }
        this.store.update((state) => {
          state.remoteEnabled = change.enabled;
        });
        this.options.setConfig('mcpExport', next);
        break;
      }
      case 'exports':
        this.sharing.select(change.sources, change.tools);
        break;
      case 'revoke-client':
        this.credentials.revoke(change.clientId);
        this.remote.provider.clearClient(change.clientId);
        break;
    }
    this.sharing.changed();
    this.store.record(
      ['imports', 'sharing', 'remote'].includes(change.action) && 'enabled' in change && !change.enabled
        ? 'revocation'
        : 'approval',
      `Plugin Bridge ${change.action} settings updated.`,
    );
    return this.snapshot();
  }
  configChanged(): void {
    const auth = this.authConfigFingerprint();
    if (auth !== this.authFingerprint) {
      this.authFingerprint = auth;
      this.credentials.revokeRemote();
      void this.remote.close();
    }
    const imported = hash(this.options.getConfig().pluginBridge);
    if (imported !== this.importFingerprint) {
      this.importFingerprint = imported;
      if (!this.imports.enabled()) void this.imports.stop();
      void this.imports.refresh().catch(() => this.store.record('error', 'Could not revalidate plugin imports.'));
    }
    this.sharing.changed();
    this.remote.sweep();
  }
  private authConfigFingerprint(): string {
    const config = this.options.getConfig();
    return hash([config.webServer.auth, config.webServer.tls, config.webServer.enabled, config.mcpExport?.remote]);
  }
  async close(): Promise<void> {
    this.localReadyError = new Error('Kai MCP backend is shutting down.');
    this.resolveLocalReady();
    if (this.timer) clearInterval(this.timer);
    setBridgeLifecycle(undefined);
    setLocalMcpHandler(undefined);
    setMcpHttpHandler(undefined);
    await this.hooks.close();
    await this.imports.stop();
    await this.remote.close();
    await this.sharing.stop();
  }
}
