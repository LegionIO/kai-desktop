import { describe, expect, it, vi } from 'vitest';
import { appConfigSchema, type AppConfig } from '../../config/schema.js';
import {
  resolvePluginConfigView,
  toPluginSafeConfig,
  type PluginSafeConfig,
} from '../safe-config.js';

// Mock electron + heavy main-process deps that PluginManager imports at load
// time. We never construct windows, notifications, or marketplace services in
// these tests — we only exercise runPreSendHooks / runPostReceiveHooks against
// a synthetic spy plugin injected into the private `plugins` map.
vi.mock('electron', () => ({
  Notification: class {
    show() {}
    close() {}
    on() {}
  },
  BrowserWindow: { getAllWindows: () => [] },
}));
vi.mock('../marketplace-service.js', () => ({ MarketplaceService: class {} }));
vi.mock('../plugin-api.js', () => ({
  createPluginAPI: () => ({}),
  cleanupPluginAPI: () => {},
}));
vi.mock('../plugin-bootstrap.js', () => ({ getBundledPluginIntegrity: () => null }));
vi.mock('../plugin-integrity.js', () => ({
  arePermissionSetsEqual: () => true,
  hashPluginDirectory: () => '',
  readPluginManifest: () => null,
}));
vi.mock('../plugin-compat.js', () => ({ checkPluginCompatibility: () => ({ ok: true }) }));
vi.mock('../renderer-build.js', () => ({ buildPluginRendererBundle: async () => null }));
vi.mock('../../utils/window-send.js', () => ({ broadcastToAllWindows: () => {} }));
vi.mock('../../tools/skill-loader.js', () => ({ convertJsonSchemaToZod: () => null }));
vi.mock('../../ipc/conversations.js', () => ({
  readConversationStore: () => ({}),
  writeConversationStore: () => {},
  broadcastConversationChange: () => {},
}));

/**
 * Sentinel strings planted in every credential leaf of the fixture so
 * the schema-walk test can detect any leak through the redactor.
 */
const SECRETS = {
  openaiApiKey: 'sk-test-openai-redact-me-aaaaaaaaaaaaaaaa',
  anthropicApiKey: 'sk-ant-test-redact-me-bbbbbbbbbbbbbbbbb',
  bedrockAccessKeyId: 'AKIATESTREDACTMECCCCC',
  bedrockSecretAccessKey: 'TEST-SECRET-REDACT-DDDDDDDDDDDDDDDDDDDDDDDD',
  bedrockSessionToken: 'TEST-SESSION-REDACT-EEEEEEEEEEEEEEEEEEEEEEEE',
  providerExtraHeader: 'Bearer test-redact-ffffffffffffffffffff',
  embeddingOpenaiKey: 'sk-test-embedding-openai-redact-gggggggg',
  embeddingAzureKey: 'test-embedding-azure-redact-hhhhhhhhhhh',
  embeddingCustomKey: 'sk-test-embedding-custom-redact-iiiiiiii',
  mcpEnvSecret: 'test-mcp-env-redact-jjjjjjjjjjjjjjjjjjjj',
  webPassword: 'test-web-password-redact-kkkkkkkkkkkkkk',
  tlsKeyPath: '/etc/test-tls-redact-llllllllllll/private.key',
  azureSubscriptionKey: 'test-azure-sub-key-redact-mmmmmmmmmmmm',
  realtimeOpenaiKey: 'sk-test-realtime-openai-redact-nnnnnnnn',
  realtimeAzureKey: 'test-realtime-azure-redact-oooooooooooo',
  realtimeCustomKey: 'sk-test-realtime-custom-redact-pppppppp',
  imageOpenaiKey: 'sk-test-image-openai-redact-qqqqqqqqqqq',
  imageAzureKey: 'test-image-azure-redact-rrrrrrrrrrrrrr',
  imageCustomKey: 'sk-test-image-custom-redact-ssssssssss',
  videoOpenaiKey: 'sk-test-video-openai-redact-tttttttttt',
  videoAzureKey: 'test-video-azure-redact-uuuuuuuuuuuuu',
  videoCustomKey: 'sk-test-video-custom-redact-vvvvvvvvvv',
} as const;

function buildPopulatedConfig(): AppConfig {
  const raw = {
    models: {
      defaultModelKey: 'openai-gpt-4',
      providers: {
        openai: {
          type: 'openai-compatible' as const,
          enabled: true,
          endpoint: 'https://api.openai.com/v1',
          apiKey: SECRETS.openaiApiKey,
          extraHeaders: { Authorization: SECRETS.providerExtraHeader },
        },
        anthropic: {
          type: 'anthropic' as const,
          enabled: true,
          apiKey: SECRETS.anthropicApiKey,
        },
        bedrock: {
          type: 'amazon-bedrock' as const,
          enabled: true,
          region: 'us-east-1',
          accessKeyId: SECRETS.bedrockAccessKeyId,
          secretAccessKey: SECRETS.bedrockSecretAccessKey,
          sessionToken: SECRETS.bedrockSessionToken,
        },
      },
      catalog: [
        {
          key: 'openai-gpt-4',
          displayName: 'GPT-4',
          provider: 'openai',
          modelName: 'gpt-4',
        },
      ],
    },
    memory: {
      enabled: true,
      workingMemory: { enabled: true, scope: 'thread' as const },
      observationalMemory: { enabled: true, scope: 'thread' as const },
      semanticRecall: {
        enabled: true,
        topK: 5,
        scope: 'thread' as const,
        embeddingProvider: {
          type: 'openai' as const,
          model: 'text-embedding-3-small',
          openai: { apiKey: SECRETS.embeddingOpenaiKey },
          azure: {
            endpoint: 'https://example.openai.azure.com',
            apiKey: SECRETS.embeddingAzureKey,
            deploymentName: 'text-embedding-3-small',
            apiVersion: '2024-02-01',
          },
          custom: {
            baseUrl: 'https://example.com/embeddings',
            apiKey: SECRETS.embeddingCustomKey,
          },
        },
      },
      lastMessages: 20,
    },
    compaction: {
      tool: {
        enabled: true,
        useAI: false,
        triggerTokens: 1000,
        outputMaxTokens: 500,
        truncateMinChars: 2000,
        truncateHeadRatio: 0.5,
        truncateMinTailChars: 500,
      },
      conversation: {
        enabled: true,
        mode: 'observational-memory' as const,
        triggerPercent: 0.8,
        ignoreRecentUserMessages: 1,
        ignoreRecentAssistantMessages: 1,
        outputMaxTokens: 1000,
        promptReserveTokens: 1000,
      },
    },
    tools: {
      shell: { enabled: true, timeout: 30000, allowPatterns: [], denyPatterns: [] },
      fileAccess: { enabled: true, allowPaths: [], denyPaths: [] },
      processStreaming: {
        enabled: true,
        updateIntervalMs: 1000,
        modelFeedMode: 'incremental' as const,
        maxOutputBytes: 1000000,
        truncationMode: 'tail' as const,
        stopAfterMax: false,
        headTailRatio: 0.5,
        observer: {
          enabled: false,
          intervalMs: 5000,
          maxSnapshotChars: 1000,
          maxMessagesPerTool: 10,
          maxTotalLaunchedTools: 50,
        },
      },
      subAgents: { enabled: false, maxDepth: 2, maxConcurrent: 3, maxPerParent: 2 },
    },
    mcpServers: [
      {
        name: 'test-server',
        command: 'node',
        args: ['server.js'],
        env: {
          TEST_API_KEY: SECRETS.mcpEnvSecret,
          NON_SECRET_FLAG: 'true',
        },
        enabled: true,
      },
    ],
    skills: { directory: '~/.kai/skills', enabled: [] },
    systemPrompt: 'Be helpful.',
    pluginApprovals: {},
    pluginSystem: { compatibilityMode: 'warn' as const },
    launchAtLogin: false,
    ui: {
      theme: 'system' as const,
      sidebarWidth: 280,
    },
    webServer: {
      enabled: true,
      port: 8443,
      bindAddress: '127.0.0.1',
      tls: {
        enabled: true,
        mode: 'custom' as const,
        certPath: '/etc/cert.pem',
        keyPath: SECRETS.tlsKeyPath,
      },
      auth: {
        mode: 'password' as const,
        username: 'admin',
        password: SECRETS.webPassword,
      },
    },
    audio: {
      provider: 'azure' as const,
      azure: {
        region: 'eastus',
        subscriptionKey: SECRETS.azureSubscriptionKey,
        ttsVoice: 'en-US-JennyNeural',
      },
      tts: { enabled: true, rate: 1 },
      recording: { enabled: false, continuous: false },
    },
    realtime: {
      enabled: true,
      provider: 'openai' as const,
      openai: { apiKey: SECRETS.realtimeOpenaiKey },
      azure: {
        endpoint: 'https://example.openai.azure.com',
        apiKey: SECRETS.realtimeAzureKey,
        deploymentName: 'gpt-realtime-1.5',
        apiVersion: '2024-10-01-preview',
      },
      custom: {
        baseUrl: 'wss://example.com/realtime',
        apiKey: SECRETS.realtimeCustomKey,
      },
    },
    computerUse: {
      enabled: false,
      showStepLog: false,
      toolSurface: 'both' as const,
      defaultSurface: 'docked' as const,
      defaultTarget: 'isolated-browser' as const,
      approvalModeDefault: 'step' as const,
      idleTimeoutSec: 600,
      postActionDelayMs: 250,
      maxSessionDurationMin: 60,
      models: {},
      capture: {
        maxDimension: 2048,
        jpegQuality: 0.8,
        modelFrame: { mode: 'canonical' as const, width: 1280, height: 720 },
      },
      safety: { pauseOnTerminal: true, manualTakeoverPauses: true },
      localMacos: {
        autoRequestPermissions: false,
        autoOpenPrivacySettings: false,
        allowedDisplays: [],
        captureExcludedApps: [],
      },
      overlay: { enabled: false, position: 'top' as const, heightPx: 80, opacity: 0.6 },
    },
    advanced: { temperature: 0.7, maxSteps: 25, maxRetries: 2, useResponsesApi: false },
    imageGeneration: {
      enabled: true,
      provider: 'openai' as const,
      openai: { apiKey: SECRETS.imageOpenaiKey },
      azure: {
        endpoint: 'https://example.openai.azure.com',
        apiKey: SECRETS.imageAzureKey,
        deploymentName: 'dall-e-3',
        apiVersion: '2024-02-01',
      },
      custom: {
        baseUrl: 'https://example.com/images',
        apiKey: SECRETS.imageCustomKey,
      },
    },
    videoGeneration: {
      enabled: true,
      provider: 'openai' as const,
      openai: { apiKey: SECRETS.videoOpenaiKey },
      azure: {
        endpoint: 'https://example.openai.azure.com',
        apiKey: SECRETS.videoAzureKey,
        deploymentName: 'sora-1',
        apiVersion: '2024-02-01',
      },
      custom: {
        baseUrl: 'https://example.com/videos',
        apiKey: SECRETS.videoCustomKey,
      },
    },
  };
  return appConfigSchema.parse(raw);
}

function collectStringLeaves(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectStringLeaves(item, out);
  } else if (value && typeof value === 'object') {
    for (const v of Object.values(value)) collectStringLeaves(v, out);
  }
  return out;
}

function collectKeys(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, out);
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      out.push(k);
      collectKeys(v, out);
    }
  }
  return out;
}

describe('toPluginSafeConfig', () => {
  it('strips every planted secret literal from the serialized output', () => {
    const fixture = buildPopulatedConfig();
    const safe = toPluginSafeConfig(fixture);
    const serialized = JSON.stringify(safe);

    for (const [label, secret] of Object.entries(SECRETS)) {
      expect(
        serialized.includes(secret),
        `secret "${label}" (${secret}) leaked through toPluginSafeConfig`,
      ).toBe(false);
    }
  });

  it('replaces each provider credential leaf with a boolean indicator', () => {
    const fixture = buildPopulatedConfig();
    const safe = toPluginSafeConfig(fixture);

    expect(safe.models.providers.openai.hasApiKey).toBe(true);
    expect(safe.models.providers.openai.hasExtraHeaders).toBe(true);
    expect('apiKey' in safe.models.providers.openai).toBe(false);
    expect('extraHeaders' in safe.models.providers.openai).toBe(false);

    expect(safe.models.providers.bedrock.hasAccessKeyId).toBe(true);
    expect(safe.models.providers.bedrock.hasSecretAccessKey).toBe(true);
    expect(safe.models.providers.bedrock.hasSessionToken).toBe(true);
    expect('accessKeyId' in safe.models.providers.bedrock).toBe(false);
    expect('secretAccessKey' in safe.models.providers.bedrock).toBe(false);
    expect('sessionToken' in safe.models.providers.bedrock).toBe(false);
  });

  it('preserves MCP server env key names but drops their values', () => {
    const fixture = buildPopulatedConfig();
    const safe = toPluginSafeConfig(fixture);

    const mcp = safe.mcpServers[0];
    expect(mcp.hasEnv).toBe(true);
    expect(mcp.envKeys).toContain('TEST_API_KEY');
    expect(mcp.envKeys).toContain('NON_SECRET_FLAG');
    expect('env' in mcp).toBe(false);
  });

  it('redacts the web server password and TLS private key path', () => {
    const fixture = buildPopulatedConfig();
    const safe = toPluginSafeConfig(fixture);

    expect(safe.webServer.auth.hasPassword).toBe(true);
    expect('password' in safe.webServer.auth).toBe(false);
    expect(safe.webServer.tls.hasKeyPath).toBe(true);
    expect('keyPath' in safe.webServer.tls).toBe(false);
    // certPath is public information, must be preserved.
    expect(safe.webServer.tls.certPath).toBe('/etc/cert.pem');
  });

  it('redacts azure audio subscription key and realtime/media generation provider keys', () => {
    const fixture = buildPopulatedConfig();
    const safe = toPluginSafeConfig(fixture);

    expect(safe.audio.azure?.hasSubscriptionKey).toBe(true);
    expect(safe.audio.azure && 'subscriptionKey' in safe.audio.azure).toBe(false);

    expect(safe.realtime.openai?.hasApiKey).toBe(true);
    expect(safe.realtime.azure?.hasApiKey).toBe(true);
    expect(safe.realtime.custom?.hasApiKey).toBe(true);
    expect(safe.realtime.openai && 'apiKey' in safe.realtime.openai).toBe(false);

    expect(safe.imageGeneration?.openai?.hasApiKey).toBe(true);
    expect(safe.imageGeneration?.azure?.hasApiKey).toBe(true);
    expect(safe.imageGeneration?.custom?.hasApiKey).toBe(true);

    expect(safe.videoGeneration?.openai?.hasApiKey).toBe(true);
    expect(safe.videoGeneration?.azure?.hasApiKey).toBe(true);
    expect(safe.videoGeneration?.custom?.hasApiKey).toBe(true);
  });

  it('returns a deep clone — mutating the result does not affect the source', () => {
    const fixture = buildPopulatedConfig();
    const safe = toPluginSafeConfig(fixture);

    safe.models.providers.openai.endpoint = 'https://malicious.example';
    expect(fixture.models.providers.openai.endpoint).toBe('https://api.openai.com/v1');
  });

  it('schema-walk regression guard: no surviving keys whose name suggests a credential', () => {
    // This is the future-proofing net. If a new field whose name matches
    // /api[_-]?key|password|secret|token|access[_-]?key|subscription[_-]?key/i
    // is added to AppConfig and toPluginSafeConfig is not updated, this
    // test will fail. The redactor must either rename the field (e.g.
    // apiKey -> hasApiKey) or omit it. The intent is conservative: a few
    // false positives are fine; a credential silently surviving is not.
    const fixture = buildPopulatedConfig();
    const safe = toPluginSafeConfig(fixture);

    const suspiciousKeyPattern = /(?:^|[._-])(?:api[_-]?key|password|secret(?!ed)|session[_-]?token|access[_-]?key|subscription[_-]?key)(?:$|[._-])/i;
    const keys = collectKeys(safe);
    const survivors = keys.filter((k) => suspiciousKeyPattern.test(k));

    expect(
      survivors,
      `keys suggesting a credential survived redaction: ${survivors.join(', ')}`,
    ).toEqual([]);
  });

  it('schema-walk regression guard: no string leaf longer than 20 chars matches a known secret prefix', () => {
    // Catches the case where a future credential field uses an unexpected
    // name but its value still ends up serialized into the output.
    const fixture = buildPopulatedConfig();
    const safe = toPluginSafeConfig(fixture);

    const strings = collectStringLeaves(safe);
    const knownSecretPrefixes = ['sk-test-', 'sk-ant-test-', 'AKIATEST', 'Bearer test-'];
    const leaked = strings.filter((s) =>
      knownSecretPrefixes.some((prefix) => s.startsWith(prefix)),
    );

    expect(
      leaked,
      `string values matching known secret prefixes leaked: ${leaked.join(', ')}`,
    ).toEqual([]);
  });
});

/**
 * Adversarial leak markers that should NEVER appear in any plugin-visible
 * config. Distinctive enough to grep for via a substring search across the
 * serialized output.
 */
const LEAK_MARKERS = {
  openaiApiKey: 'sk-test-OPENAI-LEAK-XYZ',
  awsSecretAccessKey: 'AWS-SECRET-LEAK-XYZ',
  awsSessionToken: 'AWS-SESSION-LEAK-XYZ',
  providerBearer: 'Bearer LEAK-TOKEN-XYZ',
  mcpGithubToken: 'ghp_LEAK-XYZ',
  mcpOpenaiKey: 'sk-test-MCP-LEAK-XYZ',
  mcpCustomCred: 'leaky-token-value-XYZ',
  webPassword: 'WEBSERVER-LEAK-XYZ',
  tlsKeyPath: '/Users/secret/leaked-private-XYZ.key',
  azureSubKey: 'AZURE-SUB-LEAK-XYZ',
  realtimeOpenai: 'sk-test-REALTIME-LEAK-XYZ',
  imageOpenai: 'sk-test-IMAGE-LEAK-XYZ',
  videoOpenai: 'sk-test-VIDEO-LEAK-XYZ',
} as const;

function buildAdversarialConfig(): AppConfig {
  const base = buildPopulatedConfig() as unknown as Record<string, unknown>;
  // Overwrite credential leaves with the LEAK_MARKERS sentinels and add the
  // unknown-name credential-shaped MCP env header.
  const models = base.models as Record<string, unknown>;
  const providers = models.providers as Record<string, Record<string, unknown>>;
  providers.openai.apiKey = LEAK_MARKERS.openaiApiKey;
  providers.openai.extraHeaders = { Authorization: LEAK_MARKERS.providerBearer };
  providers.bedrock.secretAccessKey = LEAK_MARKERS.awsSecretAccessKey;
  providers.bedrock.sessionToken = LEAK_MARKERS.awsSessionToken;

  const mcp = (base.mcpServers as Array<Record<string, unknown>>)[0];
  mcp.env = {
    GITHUB_TOKEN: LEAK_MARKERS.mcpGithubToken,
    OPENAI_API_KEY: LEAK_MARKERS.mcpOpenaiKey,
    // Adversarial: a credential-shaped value under an unknown key name —
    // the redactor must strip ALL env values regardless of key.
    CUSTOM_CRED_HEADER: LEAK_MARKERS.mcpCustomCred,
    NOT_A_SECRET: 'just-a-value',
  };

  const web = base.webServer as Record<string, Record<string, unknown>>;
  web.auth.password = LEAK_MARKERS.webPassword;
  web.tls.keyPath = LEAK_MARKERS.tlsKeyPath;

  const audio = (base.audio as Record<string, Record<string, unknown>>).azure;
  audio.subscriptionKey = LEAK_MARKERS.azureSubKey;

  const realtime = base.realtime as Record<string, Record<string, unknown>>;
  realtime.openai.apiKey = LEAK_MARKERS.realtimeOpenai;

  const image = base.imageGeneration as Record<string, Record<string, unknown>>;
  image.openai.apiKey = LEAK_MARKERS.imageOpenai;

  const video = base.videoGeneration as Record<string, Record<string, unknown>>;
  video.openai.apiKey = LEAK_MARKERS.videoOpenai;

  return appConfigSchema.parse(base);
}

function makeSpyPluginInstance(captured: unknown[]): unknown {
  return {
    manifest: { name: 'spy-plugin', version: '0.0.0', displayName: 'Spy Plugin' },
    dir: '/tmp/spy-plugin',
    fileHash: '',
    state: 'active',
    module: null,
    registeredTools: [],
    preSendHooks: [
      (args: { config: unknown }) => {
        captured.push(args.config);
        return { messages: [], systemPrompt: undefined };
      },
    ],
    postReceiveHooks: [
      (args: { config: unknown; response: unknown }) => {
        captured.push(args.config);
        return { response: args.response };
      },
    ],
    preUpdateHooks: [],
    postUpdateHooks: [],
    uiBanners: [],
    uiModals: [],
    uiSettingsSections: [],
    uiPanels: [],
    uiNavigationItems: [],
    uiCommands: [],
    conversationDecorations: [],
    threadDecorations: [],
    publishedState: {},
    notifications: [],
    configChangeListeners: [],
    rendererBuild: null,
    inferenceProvider: null,
    contributedRuntimes: [],
    contributedCliTools: [],
  };
}

describe('hook fire-site delivers redacted config — spy plugin integration', () => {
  async function buildManagerWithSpy(): Promise<{
    manager: {
      runPreSendHooks: (args: Record<string, unknown>) => Promise<unknown>;
      runPostReceiveHooks: (args: Record<string, unknown>) => Promise<unknown>;
    };
    captured: unknown[];
  }> {
    // Import lazily so the vi.mock declarations at the top of the file are
    // applied before plugin-manager.ts is evaluated.
    const { PluginManager } = await import('../plugin-manager.js');
    const cfg = buildAdversarialConfig();
    const manager = new PluginManager(
      '/tmp/plugins-test',
      '/tmp/app-home-test',
      () => cfg,
      () => {},
      [],
    );
    const captured: unknown[] = [];
    const spy = makeSpyPluginInstance(captured);
    // Access the private `plugins` map and inject the spy plugin directly,
    // bypassing discovery + activation (which depend on filesystem state).
    (manager as unknown as { plugins: Map<string, unknown> }).plugins.set('spy-plugin', spy);
    return {
      manager: manager as unknown as {
        runPreSendHooks: (args: Record<string, unknown>) => Promise<unknown>;
        runPostReceiveHooks: (args: Record<string, unknown>) => Promise<unknown>;
      },
      captured,
    };
  }

  function assertNoLeakStrings(serialized: string): void {
    for (const [label, marker] of Object.entries(LEAK_MARKERS)) {
      expect(
        serialized.includes(marker),
        `leak marker "${label}" (${marker}) reached plugin hook config`,
      ).toBe(false);
    }
  }

  it('pre-send hook fire-site: spy plugin receives redacted config with no leak strings', async () => {
    const { manager, captured } = await buildManagerWithSpy();
    const cfg = buildAdversarialConfig();
    await manager.runPreSendHooks({
      messages: [{ role: 'user', content: 'hello' }],
      modelKey: 'openai-gpt-4',
      config: cfg,
      systemPrompt: 'sys',
    });
    expect(captured.length).toBe(1);
    const serialized = JSON.stringify(captured[0]);
    assertNoLeakStrings(serialized);
  });

  it('post-receive hook fire-site: spy plugin receives redacted config with no leak strings', async () => {
    const { manager, captured } = await buildManagerWithSpy();
    const cfg = buildAdversarialConfig();
    await manager.runPostReceiveHooks({
      messages: [{ role: 'user', content: 'hi' }],
      response: { role: 'assistant', content: 'ok' },
      config: cfg,
    });
    expect(captured.length).toBe(1);
    const serialized = JSON.stringify(captured[0]);
    assertNoLeakStrings(serialized);
  });

  it('non-secret fields survive redaction at the hook fire-site', async () => {
    const { manager, captured } = await buildManagerWithSpy();
    const cfg = buildAdversarialConfig();
    await manager.runPreSendHooks({
      messages: [{ role: 'user', content: 'hi' }],
      modelKey: 'openai-gpt-4',
      config: cfg,
      systemPrompt: 'sys',
    });
    const received = captured[0] as {
      models: {
        providers: { openai: { type: string; enabled: boolean; endpoint: string } };
      };
      mcpServers: Array<{ name: string; command: string; enabled: boolean }>;
      webServer: { enabled: boolean; port: number };
    };
    expect(received.models.providers.openai.type).toBe('openai-compatible');
    expect(received.models.providers.openai.enabled).toBe(true);
    expect(received.models.providers.openai.endpoint).toBe('https://api.openai.com/v1');
    expect(received.mcpServers[0].name).toBe('test-server');
    expect(received.mcpServers[0].command).toBe('node');
    expect(received.mcpServers[0].enabled).toBe(true);
    expect(received.webServer.enabled).toBe(true);
    expect(received.webServer.port).toBe(8443);
  });

  it('mcpServers[*].env is entirely stripped — even credential-shaped values under unknown key names', async () => {
    const { manager, captured } = await buildManagerWithSpy();
    const cfg = buildAdversarialConfig();
    await manager.runPreSendHooks({
      messages: [],
      modelKey: 'openai-gpt-4',
      config: cfg,
      systemPrompt: undefined,
    });
    const received = captured[0] as { mcpServers: Array<Record<string, unknown>> };
    const mcp = received.mcpServers[0];
    expect('env' in mcp).toBe(false);
    // The key names may be exposed as a list (envKeys) so plugins can know
    // which env vars exist, but the VALUES (including the adversarial
    // CUSTOM_CRED_HEADER) must not appear anywhere in the serialized config.
    const serialized = JSON.stringify(received);
    expect(serialized.includes(LEAK_MARKERS.mcpCustomCred)).toBe(false);
    expect(serialized.includes(LEAK_MARKERS.mcpGithubToken)).toBe(false);
    expect(serialized.includes(LEAK_MARKERS.mcpOpenaiKey)).toBe(false);
    // The plain non-secret value 'just-a-value' was passed in under
    // NOT_A_SECRET — since the redactor cannot know which env values are
    // secret, it must drop them all. Verify it did.
    expect(serialized.includes('just-a-value')).toBe(false);
  });

  it('forward-compatibility credential-shape regex sweep — no suspicious patterns survive', async () => {
    // This guards against future schema changes that introduce a new
    // credential-bearing field whose name does not match the existing
    // schema-walk regex. Even if the field name is unrecognized, a string
    // VALUE shaped like a known credential type must not appear in the
    // plugin-visible config. A few false positives are acceptable; a
    // credential silently surviving redaction is not.
    const { manager, captured } = await buildManagerWithSpy();
    const cfg = buildAdversarialConfig();
    await manager.runPreSendHooks({
      messages: [],
      modelKey: 'openai-gpt-4',
      config: cfg,
      systemPrompt: undefined,
    });
    const flat = JSON.stringify(captured[0]);
    const suspiciousPatterns: Array<{ name: string; pattern: RegExp }> = [
      { name: 'OpenAI sk-* key', pattern: /sk-[a-z]/i },
      { name: 'Slack bot token (xoxb-)', pattern: /xoxb-/ },
      { name: 'AWS access key (AKIA*)', pattern: /AKIA[A-Z0-9]/ },
      { name: 'GitHub personal access token (ghp_*)', pattern: /ghp_/ },
      { name: 'HTTP Bearer token', pattern: /Bearer\s/i },
      { name: 'PEM private key header', pattern: /-----BEGIN / },
      { name: 'JWT (eyJ...)', pattern: /eyJ[A-Za-z0-9_-]+\./ },
      { name: 'planted LEAK-XYZ sentinel', pattern: /LEAK-XYZ/i },
    ];
    for (const { name, pattern } of suspiciousPatterns) {
      expect(
        pattern.test(flat),
        `credential-shaped pattern survived redaction: ${name} (${pattern})`,
      ).toBe(false);
    }
  });

  it('post-receive hook fire-site also passes the credential-shape sweep', async () => {
    const { manager, captured } = await buildManagerWithSpy();
    const cfg = buildAdversarialConfig();
    await manager.runPostReceiveHooks({
      messages: [{ role: 'user', content: 'q' }],
      response: { role: 'assistant', content: 'a' },
      config: cfg,
    });
    const flat = JSON.stringify(captured[0]);
    expect(flat.includes('LEAK-XYZ')).toBe(false);
    expect(/sk-test-/i.test(flat)).toBe(false);
    expect(/ghp_/.test(flat)).toBe(false);
    expect(/Bearer\s/i.test(flat)).toBe(false);
  });
});

/**
 * Tests for the permission gate used by `PluginAPI.config.get()` and the
 * `onConfigChanged` dispatch path in PluginManager. The gate is centralised
 * in {@link resolvePluginConfigView} so both call sites share one policy.
 *
 * Threat model: a plugin without the `'config:read-secrets'` permission MUST
 * NOT receive any credential leaf through `api.config.get()`, the
 * `onChanged` callback, or the `onConfigChanged` module hook. The redactor
 * must be the only thing standing between an untrusted plugin and the user's
 * API keys, AWS credentials, MCP env vars, web server password, TLS private
 * key paths, and Azure subscription keys.
 */
describe('resolvePluginConfigView (config:read-secrets gate)', () => {
  /** Sample of the secret literals planted in `buildPopulatedConfig`. */
  const SECRET_VALUES = [
    SECRETS.openaiApiKey,
    SECRETS.anthropicApiKey,
    SECRETS.bedrockAccessKeyId,
    SECRETS.bedrockSecretAccessKey,
    SECRETS.bedrockSessionToken,
    SECRETS.providerExtraHeader,
    SECRETS.embeddingOpenaiKey,
    SECRETS.mcpEnvSecret,
    SECRETS.webPassword,
    SECRETS.tlsKeyPath,
    SECRETS.azureSubscriptionKey,
    SECRETS.realtimeOpenaiKey,
    SECRETS.imageOpenaiKey,
    SECRETS.videoOpenaiKey,
  ];

  it('returns the redacted PluginSafeConfig when the plugin lacks config:read-secrets', () => {
    const config = buildPopulatedConfig();
    const permissions = ['config:read'];

    const view = resolvePluginConfigView(config, permissions);
    const serialized = JSON.stringify(view);

    for (const secret of SECRET_VALUES) {
      expect(
        serialized.includes(secret),
        `plugin without 'config:read-secrets' received credential value "${secret}"`,
      ).toBe(false);
    }

    // Structural sanity check: providers carry the boolean indicators
    // produced by the redactor, not raw credential fields.
    const safe = view as PluginSafeConfig;
    expect(safe.models.providers.openai.hasApiKey).toBe(true);
    expect('apiKey' in safe.models.providers.openai).toBe(false);
    expect(safe.webServer.auth.hasPassword).toBe(true);
    expect('password' in safe.webServer.auth).toBe(false);
  });

  it('returns the full AppConfig (with credentials) when the plugin holds config:read-secrets', () => {
    const config = buildPopulatedConfig();
    const permissions = ['config:read', 'config:read-secrets'];

    const view = resolvePluginConfigView(config, permissions);
    const full = view as AppConfig;

    // The full AppConfig branch is identity — the helper must hand the
    // caller the same object reference it was given. (Plugins with this
    // permission are expected to keep it private and not log it.)
    expect(full).toBe(config);
    expect(full.models.providers.openai.apiKey).toBe(SECRETS.openaiApiKey);
    expect(full.models.providers.bedrock.accessKeyId).toBe(SECRETS.bedrockAccessKeyId);
    expect(full.mcpServers[0].env?.TEST_API_KEY).toBe(SECRETS.mcpEnvSecret);
    expect(full.webServer.auth.password).toBe(SECRETS.webPassword);
  });

  it('treats a missing permission identically to an explicitly-denied one', () => {
    const config = buildPopulatedConfig();

    // Empty permissions list ⇒ redacted.
    const noPerms = resolvePluginConfigView(config, []);
    expect(JSON.stringify(noPerms).includes(SECRETS.openaiApiKey)).toBe(false);

    // Only the baseline 'config:read' ⇒ still redacted (no secrets perm).
    const baseline = resolvePluginConfigView(config, ['config:read']);
    expect(JSON.stringify(baseline).includes(SECRETS.openaiApiKey)).toBe(false);
  });

  it('redacts even when an unrelated permission resembles the secrets gate', () => {
    // Guard against a substring-style bug: 'config:read-secrets-x' (or
    // similar) must NOT satisfy the gate. We test with a sibling
    // permission that shares a prefix.
    const config = buildPopulatedConfig();
    const view = resolvePluginConfigView(config, [
      'config:read',
      'config:read-secrets-not-a-real-permission',
    ]);
    expect(JSON.stringify(view).includes(SECRETS.openaiApiKey)).toBe(false);
  });

  it('redacted view is a deep clone — mutating it cannot leak back into the source', () => {
    // Mirrors the deep-clone guarantee toPluginSafeConfig provides, but
    // exercises it through the gate helper. A hostile plugin that tries
    // to rewrite endpoints or other fields on the returned object must
    // not be able to corrupt the live AppConfig.
    const config = buildPopulatedConfig();
    const view = resolvePluginConfigView(config, []) as PluginSafeConfig;

    view.models.providers.openai.endpoint = 'https://malicious.example';
    expect(config.models.providers.openai.endpoint).toBe('https://api.openai.com/v1');
  });

  it('schema-walk regression guard on the gated view: no surviving credential-shaped keys without the permission', () => {
    // Equivalent of the top-level redactor regression test, but routed
    // through resolvePluginConfigView so future API changes that swap
    // out the redactor implementation still get checked.
    const config = buildPopulatedConfig();
    const view = resolvePluginConfigView(config, ['config:read']);

    const suspiciousKeyPattern = /(?:^|[._-])(?:api[_-]?key|password|secret(?!ed)|session[_-]?token|access[_-]?key|subscription[_-]?key)(?:$|[._-])/i;
    const keys = collectKeys(view);
    const survivors = keys.filter((k) => suspiciousKeyPattern.test(k));

    expect(
      survivors,
      `credential-shaped keys survived the gate for a plugin without 'config:read-secrets': ${survivors.join(', ')}`,
    ).toEqual([]);
  });

  it('grant + revoke transition: removing the permission from a plugin manifest restores the redacted view on the next read', () => {
    // Models the scenario where a user revokes config:read-secrets
    // (e.g. via a future settings UI, or by reapproving a manifest with
    // the permission stripped). Permission state is read fresh on each
    // call, so the next read MUST return the safe view immediately —
    // there is no cached "I had it before" carve-out.
    const config = buildPopulatedConfig();

    const granted = resolvePluginConfigView(config, ['config:read', 'config:read-secrets']);
    expect((granted as AppConfig).models.providers.openai.apiKey).toBe(SECRETS.openaiApiKey);

    // Simulate revocation by passing the same config with a tightened
    // permission list — the helper must respond on the very next call.
    const revoked = resolvePluginConfigView(config, ['config:read']);
    expect(JSON.stringify(revoked).includes(SECRETS.openaiApiKey)).toBe(false);
    expect('apiKey' in (revoked as PluginSafeConfig).models.providers.openai).toBe(false);
  });
});

/**
 * Adversarial coverage of the permission gate against runtime mutation of the
 * `permissions` argument. The gate is a single `permissions.includes(...)`
 * call inside {@link resolvePluginConfigView}, so the threat surface is:
 *
 *  - Mutating the array between two `resolvePluginConfigView` calls
 *  - Passing a hostile object whose `permissions` property is a getter that
 *    returns different values on each access
 *  - Substring / case / whitespace variants of the gate literal
 *  - Non-string permission entries (Symbols, etc.)
 *  - Inherited (prototype-chain) `permissions` properties
 *  - Subscribe-time vs. dispatch-time evaluation for `onConfigChanged`-style
 *    callbacks that re-call the gate with a captured permissions reference
 *  - Forward-compat noise (never-defined permission strings sitting alongside
 *    the real gate literal)
 *
 * Each scenario either pins the gate's defensive behavior with assertions or
 * documents (via a `// SKIPPED:` comment) why an attack vector is
 * architecturally impossible against the current implementation. The intent
 * is that any future refactor that subtly weakens the comparison logic
 * (substring search, regex, case-insensitive compare, etc.) lights up a CI
 * failure here rather than silently widening the gate.
 */
describe('resolvePluginConfigView — adversarial runtime mutation', () => {
  it('array push between calls: each call evaluates permissions afresh, neither call retroactively changes', () => {
    // Production wiring: `PluginAPI.config.get()` reads
    // `manifest.permissions` and hands it to `resolvePluginConfigView`
    // at every call (see plugin-api.ts line ~396). The gate therefore
    // sees the array contents at-call. The defensive guarantee being
    // pinned here is twofold:
    //
    //   (a) A first call without the secrets permission returns the
    //       redacted view, and pushing the secrets permission onto the
    //       *same array reference* afterwards does NOT mutate the
    //       already-returned view (the redactor deep-clones).
    //   (b) A second call after the push correctly reflects the new
    //       state — i.e. the gate is not memoising on the array identity.
    const config = buildPopulatedConfig();
    const permissions: string[] = ['config:read'];

    const before = resolvePluginConfigView(config, permissions);
    expect(JSON.stringify(before).includes(SECRETS.openaiApiKey)).toBe(false);
    expect('apiKey' in (before as PluginSafeConfig).models.providers.openai).toBe(false);

    // Hostile mutation: a misbehaving plugin tries to elevate its own
    // permissions by pushing onto the array it knows the host holds.
    permissions.push('config:read-secrets');

    // The already-returned `before` view must NOT have been retroactively
    // upgraded — it is a deep-cloned PluginSafeConfig and structurally
    // cannot contain raw credentials regardless of subsequent mutations.
    expect(JSON.stringify(before).includes(SECRETS.openaiApiKey)).toBe(false);

    // A fresh call DOES see the new state — this is by design (and matches
    // PluginManager.onConfigChanged which reads manifest.permissions at
    // dispatch). The defensive property is that there is no stale cached
    // view, not that revocation is one-way.
    const after = resolvePluginConfigView(config, permissions);
    expect(after).toBe(config);
    expect((after as AppConfig).models.providers.openai.apiKey).toBe(SECRETS.openaiApiKey);
  });

  it('hostile defineProperty getter: the gate sees whatever the array contains at the moment of `.includes`', () => {
    // A hostile plugin could install a getter on an object so that
    // `obj.permissions` returns one value on the first access and a
    // different value on the second. The gate only reads `permissions`
    // ONCE per call (it's the function parameter, not a property access
    // inside the loop), so a getter that flips between accesses cannot
    // sneak past — the host code resolves `obj.permissions` exactly
    // once at the call site and hands the *resulting array reference*
    // to `resolvePluginConfigView`. We exercise both cases below.
    const config = buildPopulatedConfig();

    // Case A: the getter returns a redacted permission list on the
    // access the host makes — the resolved view must be redacted, even
    // if the getter would have returned a privileged list on a *later*
    // access. We simulate this by reading the getter once and passing
    // the result, matching the host's call pattern.
    let accessCount = 0;
    const obj: { permissions: readonly string[] } = Object.defineProperty(
      {} as { permissions: readonly string[] },
      'permissions',
      {
        get: () => {
          accessCount += 1;
          return accessCount === 1
            ? ['config:read']
            : ['config:read', 'config:read-secrets'];
        },
        configurable: true,
        enumerable: true,
      },
    );

    const firstReadPermissions = obj.permissions; // host reads once
    const view = resolvePluginConfigView(config, firstReadPermissions);
    expect(JSON.stringify(view).includes(SECRETS.openaiApiKey)).toBe(false);
    expect('apiKey' in (view as PluginSafeConfig).models.providers.openai).toBe(false);
    expect(accessCount).toBe(1);

    // Case B: even if the host were to do a fresh read each time (which
    // is the actual production behavior in PluginAPI.config.get), a
    // hostile getter that flips between reads is no different from any
    // other case where the permission list legitimately changed —
    // tomorrow's call gets the new list, yesterday's already-returned
    // view is unchanged (Object.frozen post-clone or deep-cloned).
    const secondReadPermissions = obj.permissions;
    const view2 = resolvePluginConfigView(config, secondReadPermissions);
    expect(view2).toBe(config); // upgraded — by design, no stale caching
    expect(JSON.stringify(view).includes(SECRETS.openaiApiKey)).toBe(false); // first view unaffected
  });

  it('substring injection: variants of "config:read-secrets" that share a prefix or suffix must NOT satisfy the gate', () => {
    // The gate uses Array.prototype.includes which is strict (SameValueZero)
    // equality, so substring/sibling permission strings cannot pass. This
    // test pins the contract across several realistic injection shapes:
    // a stricter-looking sibling, an extension-style suffix, an uppercased
    // variant masquerading as the literal.
    const config = buildPopulatedConfig();
    const variants = [
      'config:read-secrets-not-real',
      'config:read-secrets-extension',
      'config:read-secrets-v2',
      'CONFIG:READ-SECRETS-WITH-SUFFIX',
      'xconfig:read-secrets', // prefix attack
      'config:read-secret', // missing trailing 's'
      'config:read-secretss', // doubled trailing 's'
    ];

    for (const variant of variants) {
      const view = resolvePluginConfigView(config, ['config:read', variant]);
      expect(
        JSON.stringify(view).includes(SECRETS.openaiApiKey),
        `substring variant "${variant}" wrongly satisfied the gate`,
      ).toBe(false);
      expect('apiKey' in (view as PluginSafeConfig).models.providers.openai).toBe(false);
    }
  });

  it('whitespace and case injection: case-sensitive, no trim, no normalisation', () => {
    // Locks the contract that the gate is case-sensitive and does no
    // whitespace normalisation. A future refactor that "helpfully"
    // calls .trim() or .toLowerCase() on permission entries would
    // widen the gate (e.g. an attacker could ship 'Config:Read-Secrets'
    // in their manifest and have it normalised to match) — that bug
    // surfaces as a CI failure here.
    const config = buildPopulatedConfig();
    const variants = [
      'Config:Read-Secrets',
      'CONFIG:READ-SECRETS',
      'config:Read-Secrets',
      ' config:read-secrets',
      'config:read-secrets ',
      ' config:read-secrets ',
      'config:read-secrets\n',
      'config:read-secrets\t',
      '\tconfig:read-secrets',
      'config:read-secrets​', // zero-width space suffix
    ];

    for (const variant of variants) {
      const view = resolvePluginConfigView(config, ['config:read', variant]);
      expect(
        JSON.stringify(view).includes(SECRETS.openaiApiKey),
        `whitespace/case variant ${JSON.stringify(variant)} wrongly satisfied the gate`,
      ).toBe(false);
      expect('apiKey' in (view as PluginSafeConfig).models.providers.openai).toBe(false);
    }
  });

  it('Symbol injection: a Symbol whose description matches the literal must NOT satisfy the gate', () => {
    // SameValueZero treats Symbols as never-equal to a string primitive,
    // so a hostile manifest that smuggles in a Symbol("config:read-secrets")
    // through a `permissions: unknown[]` type cast cannot bypass the gate.
    // We have to type-cast for the test because the public type is
    // `readonly string[]`; a real plugin's only path to do this would be
    // a manifest-loader bug. The test guards against that bug regressing
    // the gate.
    const config = buildPopulatedConfig();
    const symbolPerm = Symbol('config:read-secrets') as unknown as string;
    const view = resolvePluginConfigView(config, ['config:read', symbolPerm]);
    expect(JSON.stringify(view).includes(SECRETS.openaiApiKey)).toBe(false);
    expect('apiKey' in (view as PluginSafeConfig).models.providers.openai).toBe(false);
  });

  it('prototype-chain attack: a `permissions` array that inherits the gate literal from its prototype does not pass', () => {
    // SKIPPED-ish caveat: Array.prototype.includes walks indexed elements
    // of the array itself, not properties on its prototype, so a
    // prototype carrying a `0: 'config:read-secrets'` slot does NOT
    // satisfy `.includes`. We pin this with two shapes:
    //
    //  (a) An empty array whose prototype has indexed string slots.
    //  (b) An object whose `permissions` property is empty-array but
    //      whose prototype's `permissions` is privileged — confirming
    //      that the host's `manifest.permissions` access reads the own
    //      property, and even if the inherited array leaked through,
    //      the gate would still reject it.
    const config = buildPopulatedConfig();

    // (a) Inherited indexed slot — does not affect `.includes` on the
    //     own array because the own array has length 0 and no indexed
    //     props of its own.
    const ownEmpty: string[] = [];
    Object.setPrototypeOf(ownEmpty, Object.assign(Object.create(Array.prototype), {
      0: 'config:read-secrets',
      length: 1,
    }));
    const viewA = resolvePluginConfigView(config, ownEmpty);
    expect(JSON.stringify(viewA).includes(SECRETS.openaiApiKey)).toBe(false);

    // (b) Inherited `permissions` slot on a manifest-like wrapper. This
    //     models a manifest object whose own `permissions` is `[]` but
    //     whose prototype carries a privileged list. The host's
    //     `manifest.permissions` access in plugin-api.ts will resolve to
    //     the inherited array (JS property lookup walks the chain), but
    //     the gate still receives that array by value and rejects it
    //     only if its CONTENTS lack the literal. We're really testing
    //     the gate here, not the host's lookup; so we explicitly pass
    //     the OWN empty array — matching what a host that correctly
    //     reads own-properties would do.
    const malicious: { permissions: readonly string[] } = { permissions: [] };
    Object.setPrototypeOf(malicious, { permissions: ['config:read-secrets'] });
    // Read own-property explicitly to mirror a defensive host.
    const own = Object.getOwnPropertyDescriptor(malicious, 'permissions')?.value as readonly string[];
    const viewB = resolvePluginConfigView(config, own);
    expect(JSON.stringify(viewB).includes(SECRETS.openaiApiKey)).toBe(false);
    expect('apiKey' in (viewB as PluginSafeConfig).models.providers.openai).toBe(false);

    // SKIPPED: testing what happens when a host *does* let the
    // prototype-chain lookup leak through (i.e. passes `malicious.permissions`
    // directly, returning the inherited array) is out of scope for the
    // gate itself — that bug would live in the host, and at that point
    // the gate is being handed a real privileged array and is correct
    // to honor it. The host's correctness on own-property access is
    // covered by the manifest validator in plugin-manager.ts (manifest
    // schema parsing forces `permissions` to be an own property of the
    // parsed JSON, not inherited).
  });

  it('onConfigChanged-style race: a callback registered without secrets remains gated by the permissions seen at dispatch', () => {
    // Production behavior (PluginManager.onConfigChanged, line ~717): the
    // dispatcher reads `instance.manifest.permissions` at dispatch time,
    // not at subscribe time. The defensive property being pinned here
    // is that the gate function consumes its `permissions` parameter
    // synchronously, so a callback that was registered while the
    // permission list said `['config:read']` and is later fired with
    // a stale snapshot still gets a correctly-gated view for the
    // snapshot it was handed.
    //
    // We model this with two captured snapshots fed to two separate
    // gate calls; the callback receives whichever payload the dispatcher
    // computed at fire time. The test fails if any redacted dispatch
    // payload contains a secret.
    const config = buildPopulatedConfig();

    const dispatched: Array<AppConfig | PluginSafeConfig> = [];
    const listener = (payload: AppConfig | PluginSafeConfig) => {
      dispatched.push(payload);
    };

    // Simulate first dispatch — caller has the unprivileged permission set.
    const permsAtFirstDispatch: readonly string[] = ['config:read'];
    listener(resolvePluginConfigView(config, permsAtFirstDispatch));

    // Simulate a hostile mutation of the captured reference between
    // dispatches — this is the race a malicious plugin would try.
    // It does NOT affect the first dispatched payload because the gate
    // already produced a deep-cloned view.
    (permsAtFirstDispatch as string[]).push?.('config:read-secrets'); // no-op on readonly, but try

    // Simulate second dispatch — caller has elevated permissions now.
    const permsAtSecondDispatch: readonly string[] = ['config:read', 'config:read-secrets'];
    listener(resolvePluginConfigView(config, permsAtSecondDispatch));

    expect(dispatched.length).toBe(2);

    // First payload MUST be redacted regardless of any subsequent perm change.
    expect(JSON.stringify(dispatched[0]).includes(SECRETS.openaiApiKey)).toBe(false);
    expect('apiKey' in (dispatched[0] as PluginSafeConfig).models.providers.openai).toBe(false);

    // Second payload is the privileged identity view — by design, since
    // the gate was called with the elevated perms. This is not a bypass;
    // it's the intended behavior when permissions are granted.
    expect(dispatched[1]).toBe(config);
  });

  it('forward-compat noise: unknown permission strings beside the real gate literal do not affect the decision', () => {
    // Two flavours:
    //  (a) Unknown permissions in addition to the secrets perm → still privileged.
    //  (b) Unknown permissions WITHOUT the secrets perm → still redacted.
    // Pins that the gate matches only the exact 'config:read-secrets'
    // literal and treats every other entry as irrelevant noise (no
    // privilege escalation via unknown names, no privilege loss via
    // unknown names).
    const config = buildPopulatedConfig();

    // (a) Real perm + noise: privileged view.
    const withSecretsAndNoise = resolvePluginConfigView(config, [
      'config:read',
      'config:read-secrets',
      'config:omnipotent', // not a defined permission
      'plugin:rule-them-all',
      '',
      'config:read-secrets-but-not', // sibling string
    ]);
    expect(withSecretsAndNoise).toBe(config);
    expect((withSecretsAndNoise as AppConfig).models.providers.openai.apiKey).toBe(SECRETS.openaiApiKey);

    // (b) Just noise, no real secrets perm: redacted view.
    const onlyNoise = resolvePluginConfigView(config, [
      'config:read',
      'config:omnipotent',
      'plugin:rule-them-all',
      'config:read-secrets-but-not',
      '*',
    ]);
    expect(JSON.stringify(onlyNoise).includes(SECRETS.openaiApiKey)).toBe(false);
    expect('apiKey' in (onlyNoise as PluginSafeConfig).models.providers.openai).toBe(false);
  });
});
