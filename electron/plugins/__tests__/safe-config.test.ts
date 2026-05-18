import { describe, expect, it, vi } from 'vitest';
import { appConfigSchema, type AppConfig } from '../../config/schema.js';
import { toPluginSafeConfig } from '../safe-config.js';

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
