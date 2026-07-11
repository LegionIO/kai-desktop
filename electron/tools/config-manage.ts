import { z } from 'zod';
import type { ToolDefinition } from './types.js';
import type { AppConfig } from '../config/schema.js';
import { appConfigSchema } from '../config/schema.js';
import { readEffectiveConfig, writeDesktopConfig } from '../ipc/config.js';

function readConfig(appHome: string): AppConfig {
  return readEffectiveConfig(appHome);
}

/**
 * Fields the MODEL must not be able to change via a settings tool because they
 * are the guardrails that sandbox the model itself. Rewriting shell.allowPatterns
 * to `['*']` or emptying shell.denyPatterns / fileAccess.denyPaths would let the
 * model escalate its own execution privileges. The user changes these in the
 * Settings UI; the model cannot. (Keyed by the field path passed to the tool.)
 */
const MODEL_IMMUTABLE_TOOL_FIELDS = new Set([
  'shell.enabled',
  'shell.allowPatterns',
  'shell.denyPatterns',
  'fileAccess.enabled',
  'fileAccess.allowPaths',
  'fileAccess.denyPaths',
]);

/**
 * True if `field` targets (equals, is an ancestor of, or is a descendant of) any
 * model-immutable guardrail path. Exact matching alone is bypassable — setting
 * `shell` (ancestor) or `shell.allowPatterns.0` (descendant index) would still
 * mutate a protected field. `MODEL_IMMUTABLE_TOOL_FIELDS` holds the field paths
 * RELATIVE to config.tools (the tool_settings root).
 */
function isImmutableToolField(field: string): boolean {
  for (const locked of MODEL_IMMUTABLE_TOOL_FIELDS) {
    if (field === locked || field.startsWith(locked + '.') || locked.startsWith(field + '.')) {
      return true;
    }
    // Also block the bare top-level section (e.g. `shell`, `fileAccess`) whose
    // subtree contains a locked field.
    const lockedTop = locked.split('.')[0];
    if (field === lockedTop || field.startsWith(lockedTop + '.')) return true;
  }
  return false;
}

/**
 * Validate the mutated config against the zod schema before persisting. Returns
 * `{ error }` if the mutation produced an invalid config (e.g. a wrong-typed
 * value from the tool's `z.any()` value field), or `{ data }` = the PARSED config
 * (schema-coerced / unknown-keys-stripped) to persist. Prevents a bad `set` from
 * corrupting config or breaking guard logic (writeDesktopConfig does not itself
 * re-validate).
 */
function validateConfig(config: AppConfig): { data: AppConfig } | { error: string } {
  const result = appConfigSchema.safeParse(config);
  if (result.success) return { data: result.data as AppConfig };
  const first = result.error.issues[0];
  return {
    error: `Invalid value: ${first ? `${first.path.join('.')} — ${first.message}` : 'config failed schema validation'}`,
  };
}

function getNested(obj: Record<string, unknown>, path: string): unknown {
  const keys = path.split('.');
  let current: unknown = obj;
  for (const key of keys) {
    if (current == null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function setNested(obj: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split('.');
  if (keys.some((k) => DANGEROUS_KEYS.has(k))) return;
  let current = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    if (
      !Object.prototype.hasOwnProperty.call(current, key) ||
      typeof current[key] !== 'object' ||
      current[key] === null
    ) {
      current[key] = {};
    }
    current = current[key] as Record<string, unknown>;
  }
  current[keys[keys.length - 1]] = value;
}

/** Build a diff response for a settings set operation. Redacts by the field's
 *  last path segment (a directly-set scalar secret like `...apiKey` has no
 *  enclosing key for redactSecrets to catch) AND deep-redacts object values. */
function settingChanged(field: string, previous: unknown, value: unknown) {
  const lastSeg = field.split('.').pop() ?? field;
  const scalarSecret = SECRET_KEY_RE.test(lastSeg);
  const mask = (v: unknown): unknown =>
    scalarSecret && typeof v === 'string' && v.length > 0 ? '[redacted]' : redactSecrets(v);
  return { success: true, changed: { field, previous: mask(previous), new: mask(value) } };
}

/** Key names whose values are secrets and must never be returned to the model. */
const SECRET_KEY_RE =
  /(apikey|api_key|secret|token|password|passwd|subscriptionkey|subscription_key|credential|private_key)/i;

/**
 * Deep-clone `value`, masking any secret-shaped key so config `get`/`set`
 * responses don't leak API keys / passwords into the model transcript. Beyond a
 * safety depth, over-deep objects are masked wholesale rather than passed through
 * unredacted (config is shallow JSON, so this only triggers on pathological input).
 */
function redactSecrets(value: unknown, depth = 0): unknown {
  if (value == null || typeof value !== 'object') return value;
  if (depth > 12) return '[redacted:deep]';
  if (Array.isArray(value)) return value.map((v) => redactSecrets(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEY_RE.test(k) && typeof v === 'string' && v.length > 0) {
      out[k] = '[redacted]';
    } else {
      out[k] = redactSecrets(v, depth + 1);
    }
  }
  return out;
}

/* ── Memory Settings ── */

export function createMemorySettingsTool(appHome: string): ToolDefinition {
  return {
    name: 'memory_settings',
    description: [
      'View or update ' +
        __BRAND_PRODUCT_NAME +
        ' memory settings. Controls working memory, observational memory, semantic recall, embedding provider, and context window.',
      'Use "get" to see current values, "set" to change one.',
      'Embedding provider fields: semanticRecall.embeddingProvider.type (openai|azure|custom), .model, .openai.apiKey, .azure.endpoint, .azure.apiKey, .azure.deploymentName, .azure.apiVersion, .custom.baseUrl, .custom.apiKey.',
    ].join(' '),
    inputSchema: z.object({
      action: z.enum(['get', 'set']).describe('Read or write memory settings'),
      field: z
        .enum([
          'enabled',
          'lastMessages',
          'workingMemory.enabled',
          'workingMemory.scope',
          'observationalMemory.enabled',
          'observationalMemory.scope',
          'semanticRecall.enabled',
          'semanticRecall.topK',
          'semanticRecall.scope',
          'semanticRecall.embeddingProvider.type',
          'semanticRecall.embeddingProvider.model',
          'semanticRecall.embeddingProvider.openai.apiKey',
          'semanticRecall.embeddingProvider.azure.endpoint',
          'semanticRecall.embeddingProvider.azure.apiKey',
          'semanticRecall.embeddingProvider.azure.deploymentName',
          'semanticRecall.embeddingProvider.azure.apiVersion',
          'semanticRecall.embeddingProvider.custom.baseUrl',
          'semanticRecall.embeddingProvider.custom.apiKey',
        ])
        .optional()
        .describe('Field to set (required for "set")'),
      value: z.any().optional().describe('New value (required for "set")'),
    }),
    execute: async (input) => {
      const { action, field, value } = input as { action: string; field?: string; value?: unknown };
      const config = readConfig(appHome);
      if (action === 'get') return { memory: redactSecrets(config.memory) };
      if (!field || value === undefined) return { error: 'Field and value required for "set".' };
      const previous = getNested(config.memory as unknown as Record<string, unknown>, field);
      setNested(config.memory as unknown as Record<string, unknown>, field, value);
      {
        const validated = validateConfig(config);
        if ('error' in validated) return { error: validated.error };
        writeDesktopConfig(appHome, validated.data);
      }
      return settingChanged(field, previous, value);
    },
  };
}

/* ── Compaction Settings ── */

export function createCompactionSettingsTool(appHome: string): ToolDefinition {
  return {
    name: 'compaction_settings',
    description: [
      'View or update compaction settings. Controls tool result compaction and conversation compaction.',
      'Use "get" to see current values, "set" to change one.',
    ].join(' '),
    inputSchema: z.object({
      action: z.enum(['get', 'set']).describe('Read or write compaction settings'),
      field: z
        .enum([
          'tool.enabled',
          'tool.useAI',
          'tool.triggerTokens',
          'tool.outputMaxTokens',
          'tool.truncateMinChars',
          'tool.truncateHeadRatio',
          'tool.truncateMinTailChars',
          'conversation.enabled',
          'conversation.triggerPercent',
          'conversation.ignoreRecentUserMessages',
          'conversation.ignoreRecentAssistantMessages',
          'conversation.outputMaxTokens',
          'conversation.promptReserveTokens',
        ])
        .optional()
        .describe('Field to set (required for "set")'),
      value: z.any().optional().describe('New value (required for "set")'),
    }),
    execute: async (input) => {
      const { action, field, value } = input as { action: string; field?: string; value?: unknown };
      const config = readConfig(appHome);
      if (action === 'get') return { compaction: config.compaction };
      if (!field || value === undefined) return { error: 'Field and value required for "set".' };
      const previous = getNested(config.compaction as unknown as Record<string, unknown>, field);
      setNested(config.compaction as unknown as Record<string, unknown>, field, value);
      {
        const validated = validateConfig(config);
        if ('error' in validated) return { error: validated.error };
        writeDesktopConfig(appHome, validated.data);
      }
      return settingChanged(field, previous, value);
    },
  };
}

/* ── Tool Settings ── */

export function createToolSettingsTool(appHome: string): ToolDefinition {
  return {
    name: 'tool_settings',
    description: [
      'View or update tool settings (shell, file access, process streaming, observer).',
      'Use "get" to see current values, "set" to change one.',
    ].join(' '),
    inputSchema: z.object({
      action: z.enum(['get', 'set']).describe('Read or write tool settings'),
      field: z
        .enum([
          'shell.enabled',
          'shell.timeout',
          'shell.allowPatterns',
          'shell.denyPatterns',
          'fileAccess.enabled',
          'fileAccess.allowPaths',
          'fileAccess.denyPaths',
          'processStreaming.enabled',
          'processStreaming.updateIntervalMs',
          'processStreaming.modelFeedMode',
          'processStreaming.maxOutputBytes',
          'processStreaming.truncationMode',
          'processStreaming.stopAfterMax',
          'processStreaming.headTailRatio',
          'processStreaming.observer.enabled',
          'processStreaming.observer.intervalMs',
          'processStreaming.observer.maxSnapshotChars',
          'processStreaming.observer.maxMessagesPerTool',
          'processStreaming.observer.maxTotalLaunchedTools',
        ])
        .optional()
        .describe('Field to set (required for "set")'),
      value: z.any().optional().describe('New value (required for "set")'),
    }),
    execute: async (input) => {
      const { action, field, value } = input as { action: string; field?: string; value?: unknown };
      const config = readConfig(appHome);
      if (action === 'get') return { tools: config.tools };
      if (!field || value === undefined) return { error: 'Field and value required for "set".' };
      // Refuse to let the model rewrite the guardrails that sandbox it (ancestor,
      // exact, or descendant of an immutable path).
      if (isImmutableToolField(field)) {
        return {
          error: `"${field}" is a security guardrail and can only be changed by the user in Settings, not by a tool call.`,
        };
      }
      const previous = getNested(config.tools as unknown as Record<string, unknown>, field);
      setNested(config.tools as unknown as Record<string, unknown>, field, value);
      const validated = validateConfig(config);
      if ('error' in validated) return { error: validated.error };
      writeDesktopConfig(appHome, validated.data);
      return settingChanged(field, previous, value);
    },
  };
}

/* ── Advanced / LLM Settings ── */

export function createAdvancedSettingsTool(appHome: string): ToolDefinition {
  return {
    name: 'advanced_settings',
    description: [
      'View or update advanced LLM settings: temperature, max steps, max retries, responses API toggle.',
      'Also controls title generation and UI theme. Use "get" to see current values, "set" to change one.',
    ].join(' '),
    inputSchema: z.object({
      action: z.enum(['get', 'set']).describe('Read or write advanced settings'),
      field: z
        .enum(['temperature', 'maxSteps', 'maxRetries', 'useResponsesApi', 'ui.theme'])
        .optional()
        .describe('Field to set (required for "set")'),
      value: z.any().optional().describe('New value (required for "set")'),
    }),
    execute: async (input) => {
      const { action, field, value } = input as { action: string; field?: string; value?: unknown };
      const config = readConfig(appHome);
      if (action === 'get') {
        return {
          advanced: config.advanced,
          ui: config.ui,
        };
      }
      if (!field || value === undefined) return { error: 'Field and value required for "set".' };

      let previous: unknown;
      if (field.startsWith('ui.')) {
        const subField = field.replace('ui.', '');
        previous = getNested(config.ui as unknown as Record<string, unknown>, subField);
        setNested(config.ui as unknown as Record<string, unknown>, subField, value);
      } else {
        previous = getNested(config.advanced as unknown as Record<string, unknown>, field);
        setNested(config.advanced as unknown as Record<string, unknown>, field, value);
      }
      {
        const validated = validateConfig(config);
        if ('error' in validated) return { error: validated.error };
        writeDesktopConfig(appHome, validated.data);
      }
      return settingChanged(field, previous, value);
    },
  };
}

/* ── System Prompt ── */

export function createSystemPromptTool(appHome: string): ToolDefinition {
  return {
    name: 'system_prompt',
    description:
      'View or update ' +
      __BRAND_PRODUCT_NAME +
      ' system prompts. Use "get" to read, "set" to replace a prompt for chat, plan, or computer-use mode.',
    inputSchema: z.object({
      action: z.enum(['get', 'set']).describe('Read or write the system prompt'),
      mode: z.enum(['chat', 'plan', 'computerUse']).optional().describe('Prompt mode. Defaults to chat.'),
      prompt: z.string().optional().describe('The new system prompt text (required for "set")'),
    }),
    execute: async (input) => {
      const {
        action,
        mode = 'chat',
        prompt,
      } = input as { action: string; mode?: 'chat' | 'plan' | 'computerUse'; prompt?: string };
      const config = readConfig(appHome);
      if (action === 'get') return { systemPrompt: config.systemPrompt, systemPrompts: config.systemPrompts };
      if (prompt === undefined) return { error: 'Prompt text required for "set".' };
      const previous = mode === 'chat' ? config.systemPrompt : config.systemPrompts?.[mode];
      config.systemPrompts = {
        ...(config.systemPrompts ?? {}),
        [mode]: prompt,
      };
      if (mode === 'chat') config.systemPrompt = prompt;
      writeDesktopConfig(appHome, config);
      return { success: true, mode, changed: { previous, new: prompt } };
    },
  };
}

/* ── Audio Settings ── */

export function createAudioSettingsTool(appHome: string): ToolDefinition {
  return {
    name: 'audio_settings',
    description: [
      'View or update audio settings. Controls speech provider (native/azure), text-to-speech, voice recording, and Azure AI Speech configuration.',
      'Use "get" to see current values, "set" to change one.',
    ].join(' '),
    inputSchema: z.object({
      action: z.enum(['get', 'set']).describe('Read or write audio settings'),
      field: z
        .enum([
          'provider',
          'tts.enabled',
          'tts.voice',
          'tts.rate',
          'recording.enabled',
          'recording.language',
          'azure.endpoint',
          'azure.region',
          'azure.subscriptionKey',
          'azure.ttsVoice',
          'azure.ttsOutputFormat',
          'azure.ttsRate',
          'azure.sttLanguage',
          'azure.sttEndpoint',
        ])
        .optional()
        .describe('Field to set (required for "set")'),
      value: z.any().optional().describe('New value (required for "set")'),
    }),
    execute: async (input) => {
      const { action, field, value } = input as { action: string; field?: string; value?: unknown };
      const config = readConfig(appHome);
      if (action === 'get') return { audio: redactSecrets(config.audio) };
      if (!field || value === undefined) return { error: 'Field and value required for "set".' };
      const previous = getNested(config.audio as unknown as Record<string, unknown>, field);
      setNested(config.audio as unknown as Record<string, unknown>, field, value);
      {
        const validated = validateConfig(config);
        if ('error' in validated) return { error: validated.error };
        writeDesktopConfig(appHome, validated.data);
      }
      return settingChanged(field, previous, value);
    },
  };
}

/* ── Realtime Audio Settings ── */

export function createRealtimeSettingsTool(appHome: string): ToolDefinition {
  return {
    name: 'realtime_settings',
    description: [
      'View or update realtime audio call settings. Controls provider (openai/azure/custom), API keys, model, voice, turn detection, and auto-end call configuration.',
      'Use "get" to see current values, "set" to change one.',
    ].join(' '),
    inputSchema: z.object({
      action: z.enum(['get', 'set']).describe('Read or write realtime settings'),
      field: z
        .enum([
          'enabled',
          'provider',
          'model',
          'voice',
          'instructions',
          'openai.apiKey',
          'azure.endpoint',
          'azure.apiKey',
          'azure.deploymentName',
          'azure.apiVersion',
          'custom.baseUrl',
          'custom.apiKey',
          'turnDetection.type',
          'turnDetection.threshold',
          'turnDetection.silenceDurationMs',
          'inputAudioTranscription',
          'inputDeviceId',
          'outputDeviceId',
          'autoEndCall.enabled',
          'autoEndCall.silenceTimeoutSec',
        ])
        .optional()
        .describe('Field to set (required for "set")'),
      value: z.any().optional().describe('New value (required for "set")'),
    }),
    execute: async (input) => {
      const { action, field, value } = input as { action: string; field?: string; value?: unknown };
      const config = readConfig(appHome);
      if (action === 'get') return { realtime: redactSecrets(config.realtime) };
      if (!field || value === undefined) return { error: 'Field and value required for "set".' };
      const previous = getNested(config.realtime as unknown as Record<string, unknown>, field);
      setNested(config.realtime as unknown as Record<string, unknown>, field, value);
      {
        const validated = validateConfig(config);
        if ('error' in validated) return { error: validated.error };
        writeDesktopConfig(appHome, validated.data);
      }
      return settingChanged(field, previous, value);
    },
  };
}
