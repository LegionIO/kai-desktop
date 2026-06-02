/**
 * Regression suite for the `config:changed` broadcast — verifies that
 * `flushConfigBroadcast` in `electron/ipc/config.ts` cannot leak credential
 * leaves over the IPC fan-out (`broadcastToAllWindows`) or the web-server
 * WebSocket fan-out, while keeping the raw config available to the
 * main-process `onChanged` callback consumed by the agent, MCP loader, and
 * other in-process subsystems.
 *
 * Failure modes guarded:
 *   - A future refactor removes the redaction call before the broadcast.
 *   - A new credential-bearing field is added to `AppConfig` without an
 *     update to the shared denylist in `electron/plugins/safe-config.ts`.
 *   - The `onChanged` main-process callback is accidentally rewired to the
 *     redacted payload, breaking the agent / MCP credential flow.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as NodeOs from 'node:os';

import { createIpcHarness } from '../../../test-utils/ipc-harness.js';

// Capture every payload handed to `broadcastToAllWindows`. The production
// helper would normally fan out to BrowserWindows + WebSocket clients; in
// the test the spy is the assertion surface for both fan-outs at once.
const broadcastCalls: Array<{ channel: string; data: unknown }> = [];
vi.mock('../../utils/window-send.js', () => ({
  broadcastToAllWindows: vi.fn((channel: string, data?: unknown) => {
    broadcastCalls.push({ channel, data: structuredClone(data) });
    return 0;
  }),
}));

// `electron` resolves to a path string in Node — must be stubbed for any
// production module that references BrowserWindow at import time.
vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: vi.fn(() => []),
  },
}));

// Redirect homedir for the same reasons as the canonical config test —
// production modules read it at load time and must not touch the real
// `~/.kai/`.
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

// Import production code AFTER mocks are in place.
import { registerConfigHandlers, writeDesktopConfig, type AppConfig } from '../config.js';
import { appConfigSchema } from '../../config/schema.js';

const FAKE_EVENT = Object.freeze({}) as unknown;

let tempHome: string;
let appHome: string;

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), 'kai-config-broadcast-'));
  globalThis.__kaiTestHomedir = tempHome;
  appHome = join(tempHome, '.kai');
  mkdirSync(join(appHome, 'settings'), { recursive: true });
  broadcastCalls.length = 0;
});

afterEach(() => {
  rmSync(tempHome, { recursive: true, force: true });
  globalThis.__kaiTestHomedir = undefined;
});

// ---------------------------------------------------------------------------
// Fixture: every credential leaf in `AppConfig` carries a sentinel string so
// the redactor's coverage can be checked by substring grep.
// ---------------------------------------------------------------------------

const SECRETS = {
  openaiApiKey: 'sk-test-bcast-OPENAI-SENTINEL-AAAA',
  anthropicApiKey: 'sk-ant-test-bcast-SENTINEL-BBBB',
  bedrockAccessKeyId: 'AKIATESTBCAST-CCCC',
  bedrockSecretAccessKey: 'TEST-BCAST-AWS-SECRET-DDDD',
  bedrockSessionToken: 'TEST-BCAST-AWS-SESSION-EEEE',
  providerExtraHeader: 'Bearer test-bcast-FFFF',
  embeddingOpenaiKey: 'sk-test-bcast-embedding-openai-GGGG',
  embeddingAzureKey: 'test-bcast-embedding-azure-HHHH',
  embeddingCustomKey: 'sk-test-bcast-embedding-custom-IIII',
  mcpEnvSecret: 'test-bcast-mcp-env-JJJJ',
  mcpGithubToken: 'ghp_test-bcast-mcp-github-KKKK',
  webPassword: 'test-bcast-web-password-LLLL',
  tlsKeyPath: '/etc/test-bcast-tls/private-MMMM.key',
  azureSubscriptionKey: 'test-bcast-azure-sub-NNNN',
  realtimeOpenaiKey: 'sk-test-bcast-realtime-openai-OOOO',
  realtimeAzureKey: 'test-bcast-realtime-azure-PPPP',
  realtimeCustomKey: 'sk-test-bcast-realtime-custom-QQQQ',
  imageOpenaiKey: 'sk-test-bcast-image-openai-RRRR',
  imageAzureKey: 'test-bcast-image-azure-SSSS',
  imageCustomKey: 'sk-test-bcast-image-custom-TTTT',
  videoOpenaiKey: 'sk-test-bcast-video-openai-UUUU',
  videoAzureKey: 'test-bcast-video-azure-VVVV',
  videoCustomKey: 'sk-test-bcast-video-custom-WWWW',
} as const;

function buildAppConfigWithEverySecret(): AppConfig {
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
      catalog: [{ key: 'openai-gpt-4', displayName: 'GPT-4', provider: 'openai', modelName: 'gpt-4' }],
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
          GITHUB_TOKEN: SECRETS.mcpGithubToken,
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
    ui: { theme: 'system' as const, sidebarWidth: 280 },
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

/**
 * Drive a config:set on the harness and wait long enough for the 25ms
 * debounce inside `scheduleConfigBroadcast` to fire.
 */
async function waitForBroadcastFlush(): Promise<void> {
  // The broadcast debounce in `scheduleConfigBroadcast` is 25ms; wait
  // a comfortable margin so flaky timing on slow CI does not regress.
  await new Promise((resolve) => setTimeout(resolve, 75));
}

// ---------------------------------------------------------------------------
// Test 1: every credential sentinel placed into AppConfig is scrubbed from
// the broadcast payload, but the raw config still reaches `onChanged`.
// ---------------------------------------------------------------------------

/**
 * Plant the credential sentinels by writing `llm.json` (for the OpenAI /
 * Anthropic / Bedrock provider apiKey path) and `desktop.json` (for every
 * non-provider secret slot). `readEffectiveConfig` re-runs at handler
 * registration time and layers both files into `currentConfig`, so the
 * subsequent broadcast carries every sentinel and the redactor's coverage
 * is exercised end-to-end.
 */
function plantSecretFixtures(appHome: string): void {
  // llm.json — the on-disk file uses snake_case keys (api_key, access_key_id,
  // etc.) which `loadAppModelsConfig` reshapes into the camelCase `apiKey`
  // field on the in-memory provider config. Setting `enabled: true` keeps
  // the loader on the live path.
  const llmHome = join(appHome, 'settings');
  mkdirSync(llmHome, { recursive: true });
  writeFileSync(
    join(llmHome, 'llm.json'),
    JSON.stringify(
      {
        llm: {
          enabled: true,
          default_provider: 'openai',
          default_model: 'gpt-4',
          providers: {
            anthropic: { enabled: true, api_key: SECRETS.anthropicApiKey },
            openai: {
              enabled: true,
              api_key: SECRETS.openaiApiKey,
              base_url: 'https://api.openai.com/v1',
            },
            bedrock: {
              enabled: true,
              region: 'us-east-1',
              access_key_id: SECRETS.bedrockAccessKeyId,
              secret_access_key: SECRETS.bedrockSecretAccessKey,
              session_token: SECRETS.bedrockSessionToken,
            },
          },
        },
      },
      null,
      2,
    ),
    'utf-8',
  );

  // desktop.json — covers every non-llm-managed secret slot. We construct it
  // from the populated AppConfig fixture, then route through
  // `desktopConfigPayload` to keep the persistence allowlist honest.
  const populated = buildAppConfigWithEverySecret();
  writeDesktopConfig(appHome, populated);
}

describe('config:changed broadcast — credential redaction', () => {
  it('no credential sentinel reaches the broadcast payload, but onChanged sees the raw config', async () => {
    plantSecretFixtures(appHome);

    let rawObservedByOnChanged: AppConfig | null = null;
    const harness = await createIpcHarness({
      registerHandlers: (ipc) => {
        registerConfigHandlers(ipc as Parameters<typeof registerConfigHandlers>[0], appHome, (cfg) => {
          rawObservedByOnChanged = cfg;
        });
      },
    });

    // Trigger a broadcast by mutating a non-secret allowlisted scalar.
    // `launchAtLogin` is harmless and on the desktopConfigPayload allowlist,
    // so the change persists and `flushConfigBroadcast` fires.
    await harness.invoke('config:set', FAKE_EVENT, 'launchAtLogin', true);
    await waitForBroadcastFlush();

    // The broadcast must have fired at least once on the `config:changed`
    // channel with a non-empty payload.
    const changedBroadcasts = broadcastCalls.filter((c) => c.channel === 'config:changed');
    expect(changedBroadcasts.length).toBeGreaterThanOrEqual(1);

    // Assert on the first broadcast — the direct response to our
    // `config:set` call. Subsequent broadcasts may fire from the file
    // watcher's debounced re-read which can race with the assertion and
    // is orthogonal to the redaction contract being verified here.
    const payload = changedBroadcasts[0].data;
    const serialized = JSON.stringify(payload);

    // No sentinel string for ANY credential field may appear in the
    // broadcast — neither known names (apiKey, password, subscriptionKey)
    // nor adversarial ones routed through mcpServers[*].env.
    for (const [label, sentinel] of Object.entries(SECRETS)) {
      expect(
        serialized.includes(sentinel),
        `credential sentinel "${label}" (${sentinel}) leaked through the config:changed broadcast`,
      ).toBe(false);
    }

    // Raw config must still reach the main-process `onChanged` listener —
    // the agent runtime and MCP loader depend on it.
    expect(rawObservedByOnChanged).not.toBeNull();
    const raw = rawObservedByOnChanged as unknown as AppConfig;
    expect(raw.models.providers.openai.apiKey).toBe(SECRETS.openaiApiKey);
    expect(raw.models.providers.bedrock.accessKeyId).toBe(SECRETS.bedrockAccessKeyId);
    expect(raw.models.providers.bedrock.secretAccessKey).toBe(SECRETS.bedrockSecretAccessKey);
    expect(raw.mcpServers[0].env?.GITHUB_TOKEN).toBe(SECRETS.mcpGithubToken);
    expect(raw.webServer.auth.password).toBe(SECRETS.webPassword);
    expect(raw.audio.azure?.subscriptionKey).toBe(SECRETS.azureSubscriptionKey);
  });
});

// ---------------------------------------------------------------------------
// Test 2: schema-walk regression guard. The broadcast payload's keys must
// not include any name suggesting a credential. If a new credential field
// is added to `AppConfig` and the redactor is not updated, this test fails.
// ---------------------------------------------------------------------------

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

describe('config:changed broadcast — schema-walk regression guard', () => {
  it('no key name in the broadcast payload matches a credential-shape pattern', async () => {
    plantSecretFixtures(appHome);

    const harness = await createIpcHarness({
      registerHandlers: (ipc) => {
        registerConfigHandlers(ipc as Parameters<typeof registerConfigHandlers>[0], appHome);
      },
    });

    await harness.invoke('config:set', FAKE_EVENT, 'launchAtLogin', true);
    await waitForBroadcastFlush();

    const changed = broadcastCalls.filter((c) => c.channel === 'config:changed');
    expect(changed.length).toBeGreaterThanOrEqual(1);
    const payload = changed[0].data;

    // Conservative net. False positives (e.g. a non-credential field whose
    // name happens to match) are an acceptable tax — the cost of a false
    // negative is leaked credentials. mcpServers[*].envKeys is excluded
    // because env *key names* (e.g. `TEST_API_KEY`) are intentionally
    // preserved by the redactor — only env *values* are stripped.
    const suspiciousKeyPattern =
      /(?:^|[._-])(?:api[_-]?key|password|secret(?!ed)|session[_-]?token|access[_-]?key|subscription[_-]?key)(?:$|[._-])/i;
    const keys = collectKeys(payload);
    const survivors = keys.filter((k) => suspiciousKeyPattern.test(k));

    expect(survivors, `credential-shape keys survived redaction in the broadcast: ${survivors.join(', ')}`).toEqual([]);
  });

  it('no string leaf in the broadcast payload matches a known credential prefix', async () => {
    plantSecretFixtures(appHome);

    const harness = await createIpcHarness({
      registerHandlers: (ipc) => {
        registerConfigHandlers(ipc as Parameters<typeof registerConfigHandlers>[0], appHome);
      },
    });

    await harness.invoke('config:set', FAKE_EVENT, 'launchAtLogin', true);
    await waitForBroadcastFlush();

    const changed = broadcastCalls.filter((c) => c.channel === 'config:changed');
    const payload = changed[0].data;
    const serialized = JSON.stringify(payload);

    // Catch the case where a future field uses an unexpected name but the
    // VALUE still matches a recognised credential shape. The patterns mirror
    // the safe-config plugin-sandbox test for parity.
    const credentialShapePatterns: Array<{ name: string; pattern: RegExp }> = [
      { name: 'OpenAI sk-test sentinel', pattern: /sk-test-bcast-/i },
      { name: 'Anthropic sk-ant sentinel', pattern: /sk-ant-test-bcast-/i },
      { name: 'AWS access key prefix', pattern: /AKIATESTBCAST/ },
      { name: 'GitHub personal access token', pattern: /ghp_test-bcast-/ },
      { name: 'HTTP Bearer token', pattern: /Bearer\s+test-bcast-/i },
    ];
    for (const { name, pattern } of credentialShapePatterns) {
      expect(
        pattern.test(serialized),
        `credential-shape value leaked through the broadcast: ${name} (${pattern})`,
      ).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Test 3: indicator fields and non-secret fields survive redaction so the
// broadcast remains useful as a "something changed" signal carrying public
// information (the public, non-secret slots of AppConfig).
// ---------------------------------------------------------------------------

describe('config:changed broadcast — non-secret fields preserved', () => {
  it('hasApiKey / hasPassword / hasKeyPath indicators replace the raw values', async () => {
    plantSecretFixtures(appHome);

    const harness = await createIpcHarness({
      registerHandlers: (ipc) => {
        registerConfigHandlers(ipc as Parameters<typeof registerConfigHandlers>[0], appHome);
      },
    });

    await harness.invoke('config:set', FAKE_EVENT, 'launchAtLogin', true);
    await waitForBroadcastFlush();

    const changed = broadcastCalls.filter((c) => c.channel === 'config:changed');
    const payload = changed[0].data as Record<string, unknown>;

    // Cast through `unknown` to inspect the redacted shape's indicator fields.
    const models = payload.models as { providers: Record<string, Record<string, unknown>> };
    expect(models.providers.openai.hasApiKey).toBe(true);
    expect('apiKey' in models.providers.openai).toBe(false);
    // `extraHeaders` is a Kai-internal provider field not represented in
    // the llm.json snake_case schema, so it stays undefined for fixtures
    // planted via that file — the indicator existence is verified
    // structurally rather than checking its boolean value here.
    expect('extraHeaders' in models.providers.openai).toBe(false);
    expect('hasExtraHeaders' in models.providers.openai).toBe(true);

    expect(models.providers.bedrock.hasAccessKeyId).toBe(true);
    expect(models.providers.bedrock.hasSecretAccessKey).toBe(true);
    expect(models.providers.bedrock.hasSessionToken).toBe(true);

    const webServer = payload.webServer as {
      auth: { hasPassword: boolean; username: string };
      tls: { hasKeyPath: boolean; certPath: string };
      port: number;
      enabled: boolean;
    };
    expect(webServer.auth.hasPassword).toBe(true);
    expect('password' in webServer.auth).toBe(false);
    expect(webServer.tls.hasKeyPath).toBe(true);
    expect('keyPath' in webServer.tls).toBe(false);
    // Public information stays public — the cert path is non-secret and
    // settings UIs use it.
    expect(webServer.tls.certPath).toBe('/etc/cert.pem');
    expect(webServer.port).toBe(8443);
    expect(webServer.enabled).toBe(true);
    expect(webServer.auth.username).toBe('admin');

    const mcp = payload.mcpServers as Array<Record<string, unknown>>;
    expect(mcp[0].name).toBe('test-server');
    expect(mcp[0].command).toBe('node');
    expect('env' in mcp[0]).toBe(false);
    // Env key names are preserved so settings UIs can render
    // configured-vs-not indicators; env values are stripped.
    const envKeys = mcp[0].envKeys as string[];
    expect(envKeys).toContain('GITHUB_TOKEN');
    expect(envKeys).toContain('NON_SECRET_FLAG');
  });
});
