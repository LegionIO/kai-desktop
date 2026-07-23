import { Agent } from '@mastra/core/agent';
import { createTool } from '@mastra/core/tools';
import {
  Workspace,
  LocalFilesystem,
  LocalSandbox,
  createWorkspaceTools,
  WORKSPACE_TOOLS,
} from '@mastra/core/workspace';
import type { BackgroundProcessConfig } from '@mastra/core/workspace';
import { toStandardSchema as toJsonStandardSchema } from '@mastra/schema-compat/adapters/json-schema';
import { openai as openaiProvider } from '@ai-sdk/openai';
import { anthropic as anthropicProvider } from '@ai-sdk/anthropic';
import { z } from 'zod';
import { homedir } from 'os';
import { isAbsolute, resolve as resolvePath } from 'path';
import type { AppConfig } from '../config/schema.js';
import type { LLMModelConfig, ResolvedStreamConfig, ModelCatalogEntry, ReasoningEffort } from './model-catalog.js';
import { createLanguageModelFromConfig, shouldUseOpenAIResponsesApi } from './language-model.js';
import { getSharedMemory, getResourceId } from './memory.js';
import type { ToolDefinition, ToolExecutionContext, ToolProgressEvent } from '../tools/types.js';
import { extractModelContent } from './tool-model-content.js';
import { isCommandAllowed, scrubShellEnv } from '../tools/shell.js';
import { filterGrepOutput, isPathAllowed } from '../tools/file-access.js';
import { beginShellSnapshot, trackFileWrite } from '../tools/diff-tracker.js';
import type { DiffTrackingResultMeta } from '../../shared/diff-types.js';
import { classifyError, calculateDelay, isSameModelRetryable } from './retry.js';
import { sanitizeMessagesForModel, deepSanitizeMessages } from './message-sanitizer.js';
import { applyPromptCachingToMessages, buildAnthropicCacheControl } from './prompt-caching.js';
import { DEFAULT_PLAN_PROMPT } from './prompts.js';
import { didHitStepLimit } from './step-limit.js';
import { buildMastraPrepareStep } from './prepare-step-inject.js';
import { createRecentHistoryReconciler } from './recent-history-reconciler.js';

export type { ReasoningEffort } from './model-catalog.js';

export type StreamEvent = {
  conversationId: string;
  /** Stable id of the assistant response being produced. For Mastra streams
   * this is also the id persisted in Mastra memory, allowing Kai and Mastra to
   * refer to the same logical response across later turns. */
  responseMessageId?: string;
  type:
    | 'text-delta'
    | 'observer-message'
    | 'tool-call'
    | 'tool-result'
    | 'tool-error'
    | 'tool-progress'
    | 'tool-compaction'
    | 'tool-approval-required'
    | 'prompt-redacted'
    | 'error'
    | 'done'
    | 'compaction'
    | 'context-usage'
    | 'model-fallback'
    | 'enrichment'
    | 'retry'
    | 'step-progress'
    | 'max-steps-reached'
    // Broadcast when a user turn is submitted (so OTHER attached clients — e.g.
    // the `kai` CLI when the GUI sends — render the prompt, not just the reply).
    // Carries the text; `submitNonce` (in `data`) lets the originating client
    // skip re-rendering its own optimistic local turn.
    | 'user-message';
  messageMeta?: Record<string, unknown>;
  text?: string;
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  result?: unknown;
  error?: string;
  data?: unknown;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  observerInitiated?: boolean;
  compaction?: {
    originalContent: string;
    wasCompacted: boolean;
    extractionDurationMs: number;
  };
  errorCategory?: string;
  errorStatusCode?: number;
  stepInfo?: {
    currentStep: number;
    maxSteps: number;
    hitLimit: boolean;
    taskComplete: boolean;
  };
  /** Set when this event originates from an automation run (not an interactive
   * chat). The renderer uses it to render live but defer persistence to the main
   * process (which owns the automation conversation's on-disk write). */
  automation?: boolean;
  /** Set when this turn was started via agent:submit (the `kai` CLI) and the
   * MAIN process is persisting the assistant reply. A GUI viewing the same
   * conversation must render live but NOT persist (would duplicate). Same
   * render-live-skip-persist-reload-on-done treatment as `automation`. */
  serverPersisted?: boolean;
};

type AgentConfig = ConstructorParameters<typeof Agent>[0];

export type ToolLifecycleHooks = {
  emitEvent?: (event: StreamEvent) => void;
  /** Called when cooperative mid-turn injects are actually consumed at a
   * prepareStep boundary (after the prior step's tool results). */
  onInjected?: (entries: Array<{ id: string; text: string; at: number }>) => void;
  /** Return `{ skip, result }` to short-circuit execution (e.g. PreToolUse deny). */
  onToolExecutionStart?: (state: {
    toolCallId: string;
    toolName: string;
    args: unknown;
    cancel: () => void;
  }) => void | { skip: true; result: unknown } | Promise<void | { skip: true; result: unknown }>;
  onToolExecutionEnd?: (state: { toolCallId: string; toolName: string }) => void;
  augmentToolResult?: (state: {
    toolCallId: string;
    toolName: string;
    args: unknown;
    result: unknown;
  }) => Promise<unknown> | unknown;
};
type JsonStandardSchemaInput = Parameters<typeof toJsonStandardSchema>[0];
type MastraToolExecutionOptions = {
  toolCallId?: string;
  abortSignal?: AbortSignal;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') {
    const maybe = error as { data?: { message?: string }; responseBody?: string; message?: string };
    if (typeof maybe.data?.message === 'string') return maybe.data.message;
    if (typeof maybe.message === 'string') return maybe.message;
    if (typeof maybe.responseBody === 'string' && maybe.responseBody.length > 0) return maybe.responseBody;
  }
  return String(error);
}

function shouldRetryWithoutTemperature(
  error: unknown,
  modelSettings: Record<string, unknown>,
  emittedAnyOutput: boolean,
): boolean {
  if (emittedAnyOutput) return false;
  if (typeof modelSettings.temperature !== 'number') return false;

  const messageParts: string[] = [];
  if (error instanceof Error && error.message) {
    messageParts.push(error.message);
  }
  if (typeof error === 'string') {
    messageParts.push(error);
  } else if (error && typeof error === 'object') {
    const maybe = error as { data?: { message?: string }; responseBody?: string; message?: string };
    if (typeof maybe.data?.message === 'string') messageParts.push(maybe.data.message);
    if (typeof maybe.responseBody === 'string') messageParts.push(maybe.responseBody);
    if (typeof maybe.message === 'string') messageParts.push(maybe.message);
  }

  const message = messageParts.join('\n').toLowerCase();
  if (!message.includes('temperature')) return false;

  return (
    /unsupported parameter:\s*'temperature'/.test(message) ||
    message.includes('temperature is not supported') ||
    /only (?:the )?default \(1\) value is supported/.test(message) ||
    // e.g. Moonshot/Kimi: "invalid temperature: only 1 is allowed for this model"
    /invalid temperature/.test(message) ||
    /only \d+(\.\d+)? is allowed/.test(message)
  );
}

function shouldRetryWithSanitizedMessages(error: unknown, emittedAnyOutput: boolean): boolean {
  if (emittedAnyOutput) return false;

  const message = getErrorMessage(error).toLowerCase();
  return (
    message.includes('expected toolresult') ||
    message.includes('expected tool_result') ||
    (message.includes('tool_use_id') && message.includes('not found')) ||
    message.includes('item_reference') ||
    message.includes('duplicate item found') ||
    /item\b.*\bnot found/i.test(message)
  );
}

function omitTemperature(modelSettings: Record<string, unknown>): Record<string, unknown> {
  const next = { ...modelSettings };
  delete next.temperature;
  return next;
}

function withTemperatureOmissionHeader(modelConfig: LLMModelConfig): LLMModelConfig {
  return {
    ...modelConfig,
    extraHeaders: {
      ...(modelConfig.extraHeaders ?? {}),
      'x-skynet-omit-temperature': '1',
    },
  };
}

function toMastraInputSchema(inputSchema: ToolDefinition['inputSchema']) {
  const jsonSchema = z.toJSONSchema(inputSchema, { target: 'draft-7' }) as JsonStandardSchemaInput & {
    properties?: Record<string, unknown>;
    additionalProperties?: unknown;
  };
  const standard = toJsonStandardSchema(jsonSchema);

  // Enrich the opaque "must NOT have additional properties" issue (empty path,
  // no property name) with the ACTUAL offending key(s) so the model — and any
  // logged validationErrors — can see WHICH property was unexpected and the
  // allowed set. The underlying AJV issue drops params.additionalProperty, so we
  // recover it by diffing the input against the schema's declared properties.
  const allowedKeys = new Set(Object.keys(jsonSchema.properties ?? {}));
  const isClosed = jsonSchema.additionalProperties === false;
  if (!isClosed || allowedKeys.size === 0) return standard;

  const std = (standard as { ['~standard']?: { validate?: (v: unknown) => unknown } })['~standard'];
  const originalValidate = std?.validate;
  if (!std || typeof originalValidate !== 'function') return standard;

  std.validate = (value: unknown) => {
    const enrich = (result: unknown): unknown => {
      const issues = (result as { issues?: Array<{ message?: string; path?: unknown[] }> } | undefined)?.issues;
      if (!issues || !issues.length || !value || typeof value !== 'object') return result;
      const extraKeys = Object.keys(value as Record<string, unknown>).filter((k) => !allowedKeys.has(k));
      if (extraKeys.length === 0) return result;
      let extraIdx = 0;
      for (const issue of issues) {
        if (issue.message === 'must NOT have additional properties' && (!issue.path || issue.path.length === 0)) {
          const key = extraKeys[extraIdx++] ?? extraKeys[extraKeys.length - 1];
          issue.message = `unexpected property "${key}" — this tool only accepts: ${[...allowedKeys].join(', ')}. Remove "${key}".`;
          if (!issue.path || issue.path.length === 0) issue.path = [key];
        }
      }
      return result;
    };
    const out = originalValidate.call(std, value);
    return out instanceof Promise ? out.then(enrich) : enrich(out);
  };
  return standard;
}

function toMastraTools(
  conversationId: string,
  tools: ToolDefinition[],
  hooks?: {
    emitEvent?: (event: StreamEvent) => void;
  } & ToolLifecycleHooks,
  executionContext?: Pick<ToolExecutionContext, 'cwd' | 'isHeadless' | 'parentProfileKey' | 'parentModelKey'>,
): Record<string, ReturnType<typeof createTool>> {
  // Null-prototype map: tool names can originate from skills / MCP servers, so a
  // tool named "__proto__"/"constructor" must create a plain entry, not invoke a
  // prototype setter (prototype pollution).
  const result: Record<string, ReturnType<typeof createTool>> = Object.create(null);
  for (const tool of tools) {
    result[tool.name] = createTool({
      id: tool.name,
      description: tool.description,
      inputSchema: toMastraInputSchema(tool.inputSchema),
      execute: async (input, options) => {
        const mastraOptions = options as MastraToolExecutionOptions | undefined;
        const toolCallId =
          typeof mastraOptions?.toolCallId === 'string'
            ? mastraOptions.toolCallId
            : `tc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const localAbortController = new AbortController();
        const cancel = (): void => {
          if (!localAbortController.signal.aborted) {
            localAbortController.abort();
          }
        };

        const mergedAbortSignal = mergeAbortSignals(mastraOptions?.abortSignal, localAbortController.signal);
        try {
          const startOutcome = await hooks?.onToolExecutionStart?.({
            toolCallId,
            toolName: tool.name,
            args: input,
            cancel,
          });
          if (startOutcome && startOutcome.skip) {
            const result = startOutcome.result;
            return hooks?.augmentToolResult
              ? await hooks.augmentToolResult({ toolCallId, toolName: tool.name, args: input, result })
              : result;
          }

          const ctx: ToolExecutionContext = {
            toolCallId,
            conversationId,
            cwd: executionContext?.cwd,
            isHeadless: executionContext?.isHeadless,
            parentProfileKey: executionContext?.parentProfileKey,
            parentModelKey: executionContext?.parentModelKey,
            abortSignal: mergedAbortSignal,
            onProgress: (progress: ToolProgressEvent) => {
              hooks?.emitEvent?.({
                conversationId,
                type: 'tool-progress',
                toolCallId,
                toolName: tool.name,
                data: progress,
              });
            },
          };
          const result = await tool.execute(input, ctx);
          return hooks?.augmentToolResult
            ? await hooks.augmentToolResult({ toolCallId, toolName: tool.name, args: input, result })
            : result;
        } catch (err) {
          // Run thrown errors through PostToolUse/augment so hooks can sanitize.
          const errResult = { isError: true, error: err instanceof Error ? err.message : String(err) };
          if (hooks?.augmentToolResult) {
            return await hooks.augmentToolResult({ toolCallId, toolName: tool.name, args: input, result: errResult });
          }
          throw err;
        } finally {
          hooks?.onToolExecutionEnd?.({ toolCallId, toolName: tool.name });
        }
      },
      // Emit any `_modelContent` (e.g. fetched images) the tool attached as
      // native model content, so the model sees real images rather than an
      // opaque base64 string buried in JSON. Falls back to json/text otherwise.
      toModelOutput: (output: unknown) => {
        const { modelContent, cleaned } = extractModelContent(output);
        if (!modelContent) {
          return typeof cleaned === 'string'
            ? { type: 'text', value: cleaned }
            : { type: 'json', value: cleaned ?? null };
        }
        const value = modelContent.map((p) => {
          if (p.type === 'text') return { type: 'text' as const, text: p.text };
          if (p.type === 'image') {
            return { type: 'image-data' as const, data: p.data, mediaType: p.mediaType };
          }
          return {
            type: 'file-data' as const,
            data: p.data,
            mediaType: p.mediaType,
            ...(p.filename ? { filename: p.filename } : {}),
          };
        });
        // Prepend a compact JSON summary of the remaining fields as text so the
        // model still gets the tool's structured result alongside the media.
        const summary =
          cleaned && typeof cleaned === 'object' && Object.keys(cleaned as object).length > 0
            ? [{ type: 'text' as const, text: JSON.stringify(cleaned) }]
            : [];
        return { type: 'content', value: [...summary, ...value] };
      },
    });
  }
  return result;
}

function mergeAbortSignals(primary?: AbortSignal, secondary?: AbortSignal): AbortSignal | undefined {
  if (!primary && !secondary) return undefined;
  if (!primary) return secondary;
  if (!secondary) return primary;
  // AbortSignal.any (Node 18.17+/22) composes the two without installing ordinary
  // event listeners: it uses weak references + a finalization registry, so the
  // derived signal (and its links to the sources) is reclaimed once the consumer
  // releases it — no listener leak on a long-lived source signal. This matters
  // for callers that reuse one AbortController across many merges (e.g. the
  // sub-agent multi-turn loop, or plugin-supplied signals), where the previous
  // manual addEventListener approach retained one listener per merge until the
  // source aborted. It also propagates the winning signal's abort reason.
  return AbortSignal.any([primary, secondary]);
}

/** Detect reasoning gateway Bedrock models that don't support streaming. */
function isReasoningGatewayModel(modelConfig: LLMModelConfig): boolean {
  if (modelConfig.provider !== 'amazon-bedrock') return false;
  const endpoint = modelConfig.endpoint?.toLowerCase() ?? '';
  return endpoint.includes('/ai-gateway-reasoning/');
}

function buildProviderOptions(
  modelConfig: LLMModelConfig,
  reasoningEffort?: ReasoningEffort,
): Record<string, unknown> | undefined {
  // OpenAI-compatible: pass reasoningEffort + store flag
  if (modelConfig.provider === 'openai-compatible') {
    const usesResponsesApi = shouldUseOpenAIResponsesApi(modelConfig);

    const openaiOptions: Record<string, unknown> = {};
    if (reasoningEffort) {
      openaiOptions.reasoningEffort = reasoningEffort;
    }
    if (usesResponsesApi) {
      // Prevent SDK-side item_reference replay during tool-follow-up turns.
      openaiOptions.store = false;
    }

    return Object.keys(openaiOptions).length > 0 ? { openai: openaiOptions } : undefined;
  }

  // Anthropic (direct or Bedrock with Claude models): map reasoning effort to thinking config
  const isAnthropic = isAnthropicProviderModel(modelConfig);
  // Request-level cache_control (Anthropic-direct only; Bedrock uses message-level cachePoint).
  const cacheControl = buildAnthropicCacheControl(modelConfig);

  if (isAnthropic && (reasoningEffort || cacheControl)) {
    const thinkingByEffort: Record<ReasoningEffort, Record<string, unknown>> = {
      low: { type: 'disabled' },
      medium: { type: 'adaptive' },
      high: { type: 'enabled', budgetTokens: 10_000 },
      xhigh: { type: 'enabled', budgetTokens: 32_000 },
    };
    const anthropicOptions: Record<string, unknown> = {};
    if (reasoningEffort) anthropicOptions.thinking = thinkingByEffort[reasoningEffort];
    if (cacheControl) anthropicOptions.cacheControl = cacheControl;
    return { anthropic: anthropicOptions };
  }

  return undefined;
}

function compactToolArgs<T extends Record<string, unknown>>(args: T): T {
  return Object.fromEntries(Object.entries(args).filter(([, value]) => value !== undefined)) as T;
}

function getStringOption(tool: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = tool[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return undefined;
}

function getNumberOption(tool: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = tool[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}

function getBooleanOption(tool: Record<string, unknown>, ...keys: string[]): boolean | undefined {
  for (const key of keys) {
    const value = tool[key];
    if (typeof value === 'boolean') return value;
  }
  return undefined;
}

function getStringArrayOption(tool: Record<string, unknown>, ...keys: string[]): string[] | undefined {
  for (const key of keys) {
    const value = tool[key];
    if (Array.isArray(value)) {
      const strings = value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
      if (strings.length > 0) return strings;
    }
  }
  return undefined;
}

function getRecordOption(tool: Record<string, unknown>, ...keys: string[]): Record<string, unknown> | undefined {
  for (const key of keys) {
    const value = tool[key];
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  }
  return undefined;
}

function normalizeSearchContextSize(value?: string): 'low' | 'medium' | 'high' | undefined {
  if (value === 'low' || value === 'medium' || value === 'high') return value;
  return undefined;
}

function normalizeApproximateLocation(value?: Record<string, unknown>):
  | {
      type: 'approximate';
      country?: string;
      city?: string;
      region?: string;
      timezone?: string;
    }
  | undefined {
  if (!value) return undefined;
  const type = value.type === 'approximate' ? 'approximate' : undefined;
  if (!type) return undefined;

  const location: {
    type: 'approximate';
    country?: string;
    city?: string;
    region?: string;
    timezone?: string;
  } = { type };
  const country = getStringOption(value, 'country');
  const city = getStringOption(value, 'city');
  const region = getStringOption(value, 'region');
  const timezone = getStringOption(value, 'timezone');

  if (country) location.country = country;
  if (city) location.city = city;
  if (region) location.region = region;
  if (timezone) location.timezone = timezone;

  return location;
}

function normalizeOpenAIWebSearchFilters(value?: Record<string, unknown>): { allowedDomains?: string[] } | undefined {
  if (!value) return undefined;
  const allowedDomains = getStringArrayOption(value, 'allowedDomains', 'allowed_domains');
  return allowedDomains ? { allowedDomains } : undefined;
}

function normalizeProviderToolType(tool: Record<string, unknown>): string | undefined {
  const rawType = getStringOption(tool, 'type');
  if (!rawType) return undefined;
  const normalized = rawType.toLowerCase();
  return normalized.includes('.') ? normalized.split('.').pop() : normalized;
}

function providerToolName(tool: Record<string, unknown>, fallbackName: string): string {
  return getStringOption(tool, 'name') ?? fallbackName;
}

function createOpenAIProviderTool(tool: Record<string, unknown>) {
  const type = normalizeProviderToolType(tool);
  if (type === 'web_search') {
    const filters = normalizeOpenAIWebSearchFilters(getRecordOption(tool, 'filters'));
    return {
      name: providerToolName(tool, 'web_search'),
      tool: openaiProvider.tools.webSearch(
        compactToolArgs({
          externalWebAccess: getBooleanOption(tool, 'externalWebAccess', 'external_web_access'),
          filters,
          searchContextSize: normalizeSearchContextSize(
            getStringOption(tool, 'searchContextSize', 'search_context_size'),
          ),
          userLocation: normalizeApproximateLocation(getRecordOption(tool, 'userLocation', 'user_location')),
        }),
      ),
    };
  }

  if (type === 'web_search_preview') {
    return {
      name: providerToolName(tool, 'web_search_preview'),
      tool: openaiProvider.tools.webSearchPreview(
        compactToolArgs({
          searchContextSize: normalizeSearchContextSize(
            getStringOption(tool, 'searchContextSize', 'search_context_size'),
          ),
          userLocation: normalizeApproximateLocation(getRecordOption(tool, 'userLocation', 'user_location')),
        }),
      ),
    };
  }

  return null;
}

function createAnthropicProviderTool(tool: Record<string, unknown>) {
  const type = normalizeProviderToolType(tool);
  const args = compactToolArgs({
    maxUses: getNumberOption(tool, 'maxUses', 'max_uses'),
    allowedDomains: getStringArrayOption(tool, 'allowedDomains', 'allowed_domains'),
    blockedDomains: getStringArrayOption(tool, 'blockedDomains', 'blocked_domains'),
    userLocation: normalizeApproximateLocation(getRecordOption(tool, 'userLocation', 'user_location')),
  });

  if (type === 'web_search' || type === 'web_search_20260209') {
    return {
      name: providerToolName(tool, 'web_search'),
      tool: anthropicProvider.tools.webSearch_20260209(args),
    };
  }

  if (type === 'web_search_20250305') {
    return {
      name: providerToolName(tool, 'web_search'),
      tool: anthropicProvider.tools.webSearch_20250305(args),
    };
  }

  return null;
}

function isAnthropicProviderModel(modelConfig: LLMModelConfig): boolean {
  return (
    modelConfig.provider === 'anthropic' ||
    (modelConfig.provider === 'amazon-bedrock' && /anthropic|claude/i.test(modelConfig.modelName))
  );
}

function buildProviderDefinedTools(modelConfig: LLMModelConfig): Record<string, unknown> {
  // Null-prototype: provider-tool names are config-controlled; avoid a
  // "__proto__" key mutating the prototype (prototype pollution).
  const result: Record<string, unknown> = Object.create(null);
  for (const configuredTool of modelConfig.providerTools ?? []) {
    if (!configuredTool || typeof configuredTool !== 'object' || Array.isArray(configuredTool)) continue;

    const providerTool =
      modelConfig.provider === 'openai-compatible' && shouldUseOpenAIResponsesApi(modelConfig)
        ? createOpenAIProviderTool(configuredTool)
        : isAnthropicProviderModel(modelConfig)
          ? createAnthropicProviderTool(configuredTool)
          : null;

    if (providerTool) {
      result[providerTool.name] = providerTool.tool;
    }
  }
  return result;
}

/**
 * Tool names that execute inside the provider (server-side web_search etc.) and
 * therefore never flow through our onToolExecutionStart wrapper. Callers use
 * this to skip UI arg-suppression for these tools (they'd never un-suppress).
 */
export function getProviderDefinedToolNames(modelConfig: LLMModelConfig): Set<string> {
  return new Set(Object.keys(buildProviderDefinedTools(modelConfig)));
}

function buildMastraMemoryOptions(
  conversationId: string,
  memory: ReturnType<typeof getSharedMemory>,
  config: AppConfig,
): Record<string, unknown> | undefined {
  if (!memory) return undefined;

  const mergeRecentHistory = config.memory.recentHistoryMode === 'merge-mastra';

  return {
    memory: {
      thread: { id: conversationId },
      resource: getResourceId(),
      // Kai always supplies its complete active branch. It is authoritative by
      // default, preserving edits/regenerations and the reusable prompt prefix.
      // Merge mode deliberately recalls a bounded Mastra suffix; the configured
      // Kai reconciler removes confirmed overlap after Mastra inserts it.
      // Other memory layers keep their shared defaults in either mode.
      options: { lastMessages: mergeRecentHistory ? config.memory.lastMessages : false },
    },
  };
}

function createResponseMessageId(): string {
  return `msg-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
}

type RawStreamChunk = {
  type?: string;
  payload?: Record<string, unknown>;
} & Record<string, unknown>;

function extractStreamText(payload?: Record<string, unknown>): string {
  if (!payload) return '';
  if (typeof payload.text === 'string') return payload.text;
  if (typeof payload.textDelta === 'string') return payload.textDelta;
  if (typeof payload.delta === 'string') return payload.delta;
  return '';
}

function extractStreamFinishReason(payload?: Record<string, unknown>): string | undefined {
  const stepResult = payload?.stepResult as { reason?: string } | undefined;
  if (typeof stepResult?.reason === 'string') return stepResult.reason;
  if (typeof payload?.finishReason === 'string') return payload.finishReason;
  return undefined;
}

function isExpectedMastraStructuralEvent(type: string): boolean {
  return (
    type === 'start' ||
    type === 'abort' ||
    type === 'text-start' ||
    type === 'text-end' ||
    type === 'step-start' ||
    type === 'stream-start' ||
    type === 'response-metadata' ||
    type === 'reasoning' ||
    type === 'reasoning-start' ||
    type === 'reasoning-delta' ||
    type === 'reasoning-end' ||
    type === 'reasoning-signature' ||
    type === 'redacted-reasoning' ||
    type === 'source' ||
    type === 'file' ||
    type === 'tool-call-streaming-start' ||
    type === 'tool-call-input-streaming-start' ||
    type === 'tool-call-input-streaming-end' ||
    type === 'tool-call-delta' ||
    type === 'tool-input-start' ||
    type === 'tool-input-delta' ||
    type === 'tool-input-end' ||
    type === 'raw'
  );
}

/** Mutating workspace tool names — used for plan-mode filtering. */
export const WORKSPACE_MUTATING_TOOLS: Set<string> = new Set([
  WORKSPACE_TOOLS.FILESYSTEM.WRITE_FILE,
  WORKSPACE_TOOLS.FILESYSTEM.EDIT_FILE,
  WORKSPACE_TOOLS.FILESYSTEM.DELETE,
  WORKSPACE_TOOLS.SANDBOX.EXECUTE_COMMAND,
]);

const WORKSPACE_PATH_TOOLS: Set<string> = new Set([
  WORKSPACE_TOOLS.FILESYSTEM.READ_FILE,
  WORKSPACE_TOOLS.FILESYSTEM.WRITE_FILE,
  WORKSPACE_TOOLS.FILESYSTEM.EDIT_FILE,
  WORKSPACE_TOOLS.FILESYSTEM.DELETE,
  WORKSPACE_TOOLS.FILESYSTEM.LIST_FILES,
  WORKSPACE_TOOLS.FILESYSTEM.GREP,
]);

export function normalizeAgentCwd(cwd?: string | null): string {
  const trimmed = cwd?.trim() || homedir();
  if (trimmed === '~') return homedir();
  if (trimmed.startsWith('~/')) return resolvePath(homedir(), trimmed.slice(2));
  if (isAbsolute(trimmed)) return trimmed;
  return resolvePath(homedir(), trimmed);
}

function normalizeWorkspacePath(basePath: string, value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed === '.') return basePath;
  if (trimmed === '~') return homedir();
  if (trimmed.startsWith('~/')) return resolvePath(homedir(), trimmed.slice(2));
  if (isAbsolute(trimmed)) return trimmed;
  return resolvePath(basePath, trimmed);
}

function normalizeWorkspaceToolInput(toolName: string, input: unknown, cwd: string): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;

  const normalized = { ...(input as Record<string, unknown>) };

  if (toolName === WORKSPACE_TOOLS.FILESYSTEM.LIST_FILES) {
    if (Array.isArray(normalized.pattern) && normalized.pattern.length === 0) {
      delete normalized.pattern;
    } else if (typeof normalized.pattern === 'string' && normalized.pattern.trim() === '') {
      delete normalized.pattern;
    }
    if (typeof normalized.extension === 'string' && normalized.extension.trim() === '') {
      delete normalized.extension;
    }
    if (typeof normalized.exclude === 'string' && normalized.exclude.trim() === '') {
      delete normalized.exclude;
    }
  }

  if (WORKSPACE_PATH_TOOLS.has(toolName) && typeof normalized.path === 'string') {
    normalized.path = normalizeWorkspacePath(cwd, normalized.path);
  } else if (
    (toolName === WORKSPACE_TOOLS.FILESYSTEM.LIST_FILES || toolName === WORKSPACE_TOOLS.FILESYSTEM.GREP) &&
    (normalized.path === undefined || normalized.path === null)
  ) {
    normalized.path = cwd;
  }

  if (toolName === WORKSPACE_TOOLS.FILESYSTEM.READ_FILE) {
    if (normalized.offset !== undefined) normalized.offset = coerceFiniteNumberString(normalized.offset);
    if (normalized.limit !== undefined) normalized.limit = coerceFiniteNumberString(normalized.limit);
  }

  if (toolName === WORKSPACE_TOOLS.SANDBOX.EXECUTE_COMMAND && typeof normalized.cwd === 'string') {
    normalized.cwd = normalizeWorkspacePath(cwd, normalized.cwd);
  }

  return normalized;
}

function coerceFiniteNumberString(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed) return value;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : value;
}

/**
 * Models occasionally serialize optional numeric Read arguments as JSON
 * strings (for example `{"offset":"230","limit":"50"}`). Mastra validates
 * a tool call before invoking its execute function, so execute-time input
 * normalization never gets a chance to repair those values. Patch the generated
 * Read schema at the validation boundary while continuing to expose `number` to
 * the model and rejecting nonnumeric strings normally.
 */
function coerceWorkspaceReadLineArguments(tools: Record<string, unknown>): void {
  const tool = tools[WORKSPACE_TOOLS.FILESYSTEM.READ_FILE];
  if (!tool || typeof tool !== 'object') return;

  const candidate = tool as { inputSchema?: unknown };
  if (!candidate.inputSchema || typeof candidate.inputSchema !== 'object') return;

  const schema = candidate.inputSchema as {
    extend?: (shape: Record<string, unknown>) => unknown;
  };
  if (typeof schema.extend !== 'function') return;

  candidate.inputSchema = schema.extend({
    offset: z
      .preprocess(coerceFiniteNumberString, z.number())
      .optional()
      .describe('Line number to start reading from (1-indexed). If omitted, starts from line 1.'),
    limit: z
      .preprocess(coerceFiniteNumberString, z.number())
      .optional()
      .describe('Maximum number of lines to read. If omitted, reads to the end of the file.'),
  });
}

const WORKSPACE_FILE_MUTATING_TOOLS: Set<string> = new Set([
  WORKSPACE_TOOLS.FILESYSTEM.WRITE_FILE,
  WORKSPACE_TOOLS.FILESYSTEM.EDIT_FILE,
  // Included for completeness so deletions are tracked/revertable if the delete
  // tool is ever enabled (it is disabled by default in the workspace config).
  WORKSPACE_TOOLS.FILESYSTEM.DELETE,
]);

function attachDiffMeta(result: unknown, meta: DiffTrackingResultMeta): unknown {
  if (meta.diffs.length === 0 && !meta.snapshotSkipped) return result;
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    return { ...(result as Record<string, unknown>), _diffTracking: meta };
  }
  return { value: result, _diffTracking: meta };
}

type WorkspaceCommandOutput = {
  stdout: string;
  stderr: string;
  success?: boolean;
};

function captureWorkspaceCommandEvent(output: WorkspaceCommandOutput, event: unknown): void {
  if (!event || typeof event !== 'object') return;
  const typedEvent = event as { type?: unknown; data?: unknown };
  const data = typedEvent.data && typeof typedEvent.data === 'object' ? typedEvent.data : undefined;
  const typedData = data as { output?: unknown; success?: unknown } | undefined;
  if (typedEvent.type === 'data-sandbox-stdout' && typeof typedData?.output === 'string') {
    output.stdout += typedData.output;
  } else if (typedEvent.type === 'data-sandbox-stderr' && typeof typedData?.output === 'string') {
    output.stderr += typedData.output;
  } else if (typedEvent.type === 'data-sandbox-exit' && typeof typedData?.success === 'boolean') {
    output.success = typedData.success;
  }
}

function withWorkspaceCommandOutputCapture(
  context: Record<string, unknown>,
  output: WorkspaceCommandOutput,
): Record<string, unknown> {
  const upstreamWriter =
    context.writer && typeof context.writer === 'object'
      ? (context.writer as { custom?: (event: unknown) => unknown })
      : undefined;
  const writer = Object.create(upstreamWriter ?? null) as { custom: (event: unknown) => Promise<unknown> };
  writer.custom = async (event: unknown) => {
    captureWorkspaceCommandEvent(output, event);
    if (typeof upstreamWriter?.custom === 'function') {
      return upstreamWriter.custom.call(upstreamWriter, event);
    }
    return undefined;
  };
  return { ...context, writer };
}

function surfaceWorkspaceCommandStderr(result: unknown, output: WorkspaceCommandOutput): unknown {
  const stderr = output.stderr.trimEnd();
  // Mastra already includes stderr when it considers a command failed. Its
  // lossy branch is a successful final exit (commonly a pipeline ending in
  // `head`) where it returns only stdout and silently drops stderr.
  if (!stderr || output.success === false) return result;
  if (typeof result === 'string') {
    if (result.trim() === '(no output)') return `stderr:\n${stderr}`;
    return `${result}\n\nstderr:\n${stderr}`;
  }
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    const record = result as Record<string, unknown>;
    if (record.stderr === undefined) return { ...record, stderr };
  }
  return result;
}

function applyWorkspaceToolGuards(
  tools: Record<string, unknown>,
  cwd: string,
  getConfig: () => AppConfig,
  conversationId?: string,
  hooks?: ToolLifecycleHooks,
): void {
  for (const [toolName, tool] of Object.entries(tools)) {
    if (!tool || typeof tool !== 'object') continue;
    const candidate = tool as { execute?: (input: unknown, context: unknown) => Promise<unknown> };
    if (typeof candidate.execute !== 'function') continue;
    const originalExecute = candidate.execute.bind(tool);
    candidate.execute = async (input, context) => {
      const normalized = normalizeWorkspaceToolInput(toolName, input, cwd);
      const toolCallId =
        (context as { toolCallId?: string } | undefined)?.toolCallId ??
        `tc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      // Local abort controller so observer/user cancellation can actually stop
      // long-running workspace tools (esp. execute_command). Merged with any
      // signal Mastra already put on the context.
      const localAbort = new AbortController();
      const existingSignal = (context as { abortSignal?: AbortSignal } | undefined)?.abortSignal;
      const mergedSignal = mergeAbortSignals(existingSignal, localAbort.signal);
      const baseExecContext =
        context && typeof context === 'object'
          ? { ...(context as Record<string, unknown>), abortSignal: mergedSignal }
          : { abortSignal: mergedSignal };
      const commandOutput: WorkspaceCommandOutput = { stdout: '', stderr: '' };
      const execContext =
        toolName === WORKSPACE_TOOLS.SANDBOX.EXECUTE_COMMAND
          ? withWorkspaceCommandOutputCapture(baseExecContext, commandOutput)
          : baseExecContext;

      const executeOriginal = async (args: unknown): Promise<unknown> => {
        const result = await originalExecute(args, execContext);
        return toolName === WORKSPACE_TOOLS.SANDBOX.EXECUTE_COMMAND
          ? surfaceWorkspaceCommandStderr(result, commandOutput)
          : result;
      };

      const runGuarded = async (args: unknown): Promise<unknown> => {
        if (WORKSPACE_PATH_TOOLS.has(toolName) && typeof (args as { path?: unknown })?.path === 'string') {
          const check = isPathAllowed((args as { path: string }).path, getConfig());
          if (!check.allowed) {
            throw new Error(`${toolName}: ${check.reason}`);
          }
        }

        // Apply shell allow/deny guardrails (and shell-disabled) to the workspace
        // execute_command tool — it must honor the same policy as CLI/execution
        // tools, or the model can bypass it via this path. Unconditional (not
        // gated on conversationId/diff tracking).
        if (toolName === WORKSPACE_TOOLS.SANDBOX.EXECUTE_COMMAND) {
          const cmd = (args as { command?: unknown })?.command;
          const check = isCommandAllowed(typeof cmd === 'string' ? cmd : '', getConfig());
          if (!check.allowed) {
            throw new Error(`${toolName}: ${check.reason}`);
          }
        }

        if (
          conversationId &&
          WORKSPACE_FILE_MUTATING_TOOLS.has(toolName) &&
          typeof (args as { path?: unknown })?.path === 'string'
        ) {
          const absPath = (args as { path: string }).path;
          const handle = trackFileWrite(conversationId, absPath, { toolName, toolCallId }, getConfig());
          try {
            const result = await executeOriginal(args);
            const ev = handle.finish();
            return attachDiffMeta(result, { diffs: ev ? [ev] : [] });
          } catch (err) {
            // Tool threw after possibly mutating disk — still finalize the diff
            // so the change is tracked/revertable, then rethrow.
            try {
              handle.finish();
            } catch {
              /* ignore */
            }
            throw err;
          }
        }

        if (conversationId && toolName === WORKSPACE_TOOLS.SANDBOX.EXECUTE_COMMAND) {
          const cmdInput = args as { command?: unknown; cwd?: unknown };
          const command = typeof cmdInput.command === 'string' ? cmdInput.command : '';
          const shellCwd = typeof cmdInput.cwd === 'string' ? cmdInput.cwd : cwd;
          const snap = await beginShellSnapshot(
            conversationId,
            { toolName, toolCallId, command, cwd: shellCwd },
            getConfig(),
          );
          try {
            const result = await executeOriginal(args);
            const events = await snap.finish({
              stdout: commandOutput.stdout,
              stderr: commandOutput.stderr,
            });
            return attachDiffMeta(result, { diffs: events, snapshotSkipped: snap.snapshotSkipped });
          } catch (err) {
            // Command threw after possibly mutating disk — finalize the snapshot
            // so tracked changes survive, then rethrow.
            try {
              await snap.finish({ stdout: '', stderr: '' });
            } catch {
              /* ignore */
            }
            throw err;
          }
        }

        const result = await executeOriginal(args);
        if (toolName === WORKSPACE_TOOLS.FILESYSTEM.GREP && typeof result === 'string') {
          return filterGrepOutput(result, getConfig());
        }
        return result;
      };

      try {
        const startOutcome = await hooks?.onToolExecutionStart?.({
          toolCallId,
          toolName,
          args: normalized,
          cancel: () => localAbort.abort(),
        });
        if (startOutcome && startOutcome.skip) {
          const result = startOutcome.result;
          return hooks?.augmentToolResult
            ? await hooks.augmentToolResult({ toolCallId, toolName, args: normalized, result })
            : result;
        }
        const result = await runGuarded(normalized);
        return hooks?.augmentToolResult
          ? await hooks.augmentToolResult({ toolCallId, toolName, args: normalized, result })
          : result;
      } catch (err) {
        // Route thrown tool errors through the same PostToolUse/augment path so
        // a DLP/redaction hook can sanitize error payloads too.
        const errResult = { isError: true, error: err instanceof Error ? err.message : String(err) };
        if (hooks?.augmentToolResult) {
          return await hooks.augmentToolResult({ toolCallId, toolName, args: normalized, result: errResult });
        }
        throw err;
      } finally {
        hooks?.onToolExecutionEnd?.({ toolCallId, toolName });
      }
    };
  }
}

/**
 * Create a Mastra Workspace with LocalFilesystem and LocalSandbox
 * and return the workspace tools for the agent.
 */
async function createWorkspaceForAgent(
  cwd: string,
  getConfig: () => AppConfig,
  executionMode?: string,
  progressHook?: (toolCallId: string, stream: 'stdout' | 'stderr', data: string) => void,
  conversationId?: string,
  hooks?: ToolLifecycleHooks,
): Promise<{ workspace: Workspace; tools: Record<string, unknown> }> {
  const backgroundProcesses: BackgroundProcessConfig | undefined = progressHook
    ? {
        onStdout: (data, meta) => progressHook(meta.toolCallId ?? '', 'stdout', data),
        onStderr: (data, meta) => progressHook(meta.toolCallId ?? '', 'stderr', data),
      }
    : undefined;

  const workspace = new Workspace({
    filesystem: new LocalFilesystem({
      basePath: cwd,
      contained: false, // Agent needs unrestricted host access
    }),
    sandbox: new LocalSandbox({
      workingDirectory: cwd,
      // Scrub the app's own provider secrets / tokens from the environment the
      // model's execute_command tool inherits — otherwise the model (or a
      // prompt-injection via tool output) could `echo $ANTHROPIC_API_KEY` and
      // exfiltrate app credentials. Mirrors the standalone `sh` tool's scrub;
      // PATH/HOME/NODE_* are kept so commands still work.
      env: scrubShellEnv(process.env),
    }),
    tools: {
      mastra_workspace_write_file: { requireReadBeforeWrite: true },
      mastra_workspace_edit_file: { requireReadBeforeWrite: true },
      mastra_workspace_execute_command: {
        ...(backgroundProcesses ? { backgroundProcesses } : {}),
      },
      // Disable tools we don't need
      mastra_workspace_delete: { enabled: false },
      mastra_workspace_file_stat: { enabled: false },
      mastra_workspace_mkdir: { enabled: false },
      mastra_workspace_search: { enabled: false },
      mastra_workspace_index: { enabled: false },
      mastra_workspace_lsp_inspect: { enabled: false },
      mastra_workspace_ast_edit: { enabled: false },
      mastra_workspace_get_process_output: { enabled: false },
      mastra_workspace_kill_process: { enabled: false },
    },
  });
  await workspace.init();

  const tools = await createWorkspaceTools(workspace);
  coerceWorkspaceReadLineArguments(tools as Record<string, unknown>);
  applyWorkspaceToolGuards(tools as Record<string, unknown>, cwd, getConfig, conversationId, hooks);

  // If in plan-first mode, remove mutating workspace tools
  if (executionMode === 'plan-first') {
    for (const name of WORKSPACE_MUTATING_TOOLS) {
      delete (tools as Record<string, unknown>)[name];
    }
  }

  return { workspace, tools };
}

type MastraWorkspaceTool = {
  description?: string;
  execute?: (input: unknown, context?: unknown) => Promise<unknown>;
};

/**
 * Build Mastra workspace tools (read/write/edit/list/grep/execute_command) as
 * ToolDefinition instances so non-agent callers — currently the automation
 * engine's `tool` action — can invoke them directly without going through an
 * agent run. Config guardrails (shell allow/deny patterns, fileAccess.enabled)
 * are re-checked at execute time since automations run unattended.
 */
export async function createWorkspaceToolDefinitions(
  cwd: string,
  getConfig: () => AppConfig,
  options?: { executionMode?: string; conversationId?: string },
): Promise<ToolDefinition[]> {
  const { tools } = await createWorkspaceForAgent(
    normalizeAgentCwd(cwd),
    getConfig,
    options?.executionMode,
    undefined,
    options?.conversationId,
  );
  const isExecuteCommand = (name: string) => name === WORKSPACE_TOOLS.SANDBOX.EXECUTE_COMMAND;

  return Object.entries(tools as Record<string, MastraWorkspaceTool>)
    .filter(([, tool]) => typeof tool?.execute === 'function')
    .map(([name, tool]) => ({
      name,
      description: tool.description ?? '',
      inputSchema: z.any(),
      source: 'builtin' as const,
      execute: async (input, ctx) => {
        const config = getConfig();
        const invocationCwd = normalizeAgentCwd(ctx.cwd ?? cwd);
        let effectiveInput = normalizeWorkspaceToolInput(name, input, invocationCwd);
        if (isExecuteCommand(name)) {
          const raw = (effectiveInput ?? {}) as { command?: unknown; timeout?: unknown; cwd?: unknown };
          const check = isCommandAllowed(typeof raw.command === 'string' ? raw.command : '', config);
          if (!check.allowed) throw new Error(`${name}: ${check.reason}`);
          effectiveInput = {
            ...raw,
            // Definitions are initialized at startup for automation use, but
            // observer calls carry the active run cwd in their execution
            // context. Always make that default explicit so the startup/home
            // workspace cannot accidentally win.
            ...(raw.cwd == null ? { cwd: invocationCwd } : {}),
            // Mastra execute_command takes `timeout` in seconds; Kai's shell config is in ms.
            ...(raw.timeout == null ? { timeout: Math.ceil(config.tools.shell.timeout / 1000) } : {}),
          };
        }
        return tool.execute!(effectiveInput, { toolCallId: ctx.toolCallId, abortSignal: ctx.abortSignal });
      },
    }));
}

export async function* streamAgentResponse(
  conversationId: string,
  messages: unknown[],
  modelConfig: LLMModelConfig,
  config: AppConfig,
  tools: ToolDefinition[],
  dbPath: string,
  options?: {
    reasoningEffort?: ReasoningEffort;
    abortSignal?: AbortSignal;
    cwd?: string;
    /** No live user watching this run — see ToolExecutionContext.isHeadless. */
    isHeadless?: boolean;
    /** Parent turn's profile/model, threaded to tool ctx so a sub_agent tool can
     *  inherit the parent's profile + fallback chain. */
    parentProfileKey?: string | null;
    parentModelKey?: string | null;
    responseMessageId?: string;
    emitEvent?: (event: StreamEvent) => void;
  } & ToolLifecycleHooks,
): AsyncGenerator<StreamEvent> {
  const msgArray = messages as Array<{ role?: string; content?: unknown }>;
  const apiSurface =
    modelConfig.provider === 'openai-compatible'
      ? shouldUseOpenAIResponsesApi(modelConfig)
        ? 'responses'
        : 'chat'
      : modelConfig.provider === 'anthropic'
        ? 'messages'
        : 'native';
  console.info(
    `[Agent:upstream] conv=${conversationId} model=${modelConfig.modelName} provider=${modelConfig.provider} apiSurface=${apiSurface} endpoint=${modelConfig.endpoint ?? 'default'}`,
  );
  console.info(
    `[Agent:upstream] messageCount=${msgArray.length} roles=[${msgArray.map((m) => m.role ?? '?').join(',')}]`,
  );

  const memory = getSharedMemory(config, dbPath);

  // Create Mastra workspace tools (file read/write/edit, grep, list, shell)
  const effectiveCwd = normalizeAgentCwd(options?.cwd);
  const executionMode = config.tools?.executionMode;
  const { tools: workspaceTools } = await createWorkspaceForAgent(
    effectiveCwd,
    () => config,
    executionMode,
    options?.emitEvent
      ? (toolCallId, stream, data) => {
          options.emitEvent!({
            conversationId,
            type: 'tool-progress',
            toolCallId,
            toolName: WORKSPACE_TOOLS.SANDBOX.EXECUTE_COMMAND,
            data: { stream, delta: data, output: data, bytesSeen: 0, truncated: false, stopped: false },
          });
        }
      : undefined,
    conversationId,
    {
      onToolExecutionStart: options?.onToolExecutionStart,
      onToolExecutionEnd: options?.onToolExecutionEnd,
      augmentToolResult: options?.augmentToolResult,
    },
  );

  // Wrap custom (non-workspace) tools through the bridge
  const mastraCustomTools = toMastraTools(
    conversationId,
    tools,
    {
      emitEvent: options?.emitEvent,
      onToolExecutionStart: options?.onToolExecutionStart,
      onToolExecutionEnd: options?.onToolExecutionEnd,
      augmentToolResult: options?.augmentToolResult,
    },
    {
      cwd: effectiveCwd,
      isHeadless: options?.isHeadless,
      parentProfileKey: options?.parentProfileKey,
      parentModelKey: options?.parentModelKey,
    },
  );
  const providerDefinedTools = buildProviderDefinedTools(modelConfig);

  // Merge: workspace tools (native Mastra) + custom tools (bridged)
  const allTools = { ...mastraCustomTools, ...providerDefinedTools, ...workspaceTools };

  const buildAgent = async (activeModelConfig: LLMModelConfig): Promise<Agent> => {
    const model = await createLanguageModelFromConfig(activeModelConfig);
    return new Agent({
      id: `${__BRAND_APP_SLUG}-${conversationId}`,
      name: __BRAND_APP_SLUG,
      instructions: buildAgentInstructions(config, executionMode),
      model: model as AgentConfig['model'],
      // Pass the pre-built, diff-tracking-wrapped workspace tools via `tools`.
      // Do NOT pass `workspace` here: Mastra's Agent re-derives its own workspace
      // tools from a `workspace` object (via createWorkspaceTools) at run time,
      // which would shadow our wrapped tools and bypass diff tracking + guards.
      tools: allTools as AgentConfig['tools'],
      ...(memory ? { memory } : {}),
      ...(memory && config.memory.recentHistoryMode === 'merge-mastra'
        ? { inputProcessors: [createRecentHistoryReconciler()] }
        : {}),
    });
  };

  const modelSettings: Record<string, unknown> = {};
  if (typeof config.advanced.temperature === 'number') {
    modelSettings.temperature = config.advanced.temperature;
  }
  const providerOptions = buildProviderOptions(modelConfig, options?.reasoningEffort);

  const useGenerate = isReasoningGatewayModel(modelConfig);

  const targetModelId = `${modelConfig.provider}:${modelConfig.modelName}`;
  const sanitizedMessages = applyPromptCachingToMessages(
    sanitizeMessagesForModel(messages, targetModelId),
    modelConfig,
  );
  const responseMessageId = options?.responseMessageId ?? createResponseMessageId();

  const eventStream = useGenerate
    ? generateWithSyntheticEvents(
        buildAgent,
        conversationId,
        sanitizedMessages,
        modelConfig,
        config,
        memory,
        modelSettings,
        providerOptions,
        responseMessageId,
        options,
      )
    : streamWithRealEvents(
        buildAgent,
        conversationId,
        sanitizedMessages,
        modelConfig,
        config,
        memory,
        modelSettings,
        providerOptions,
        responseMessageId,
        options,
      );

  for await (const event of eventStream) {
    yield { ...event, responseMessageId };
  }
}

/**
 * Non-streaming path for reasoning gateway models.
 * Uses agent.generate() with onStepFinish to synthesize streaming events.
 */
async function* generateWithSyntheticEvents(
  buildAgent: (modelConfig: LLMModelConfig) => Promise<Agent>,
  conversationId: string,
  messages: unknown[],
  modelConfig: LLMModelConfig,
  config: AppConfig,
  memory: ReturnType<typeof getSharedMemory>,
  modelSettings: Record<string, unknown>,
  providerOptions: Record<string, unknown> | undefined,
  responseMessageId: string,
  options?: {
    abortSignal?: AbortSignal;
    emitEvent?: (event: StreamEvent) => void;
    onInjected?: (entries: Array<{ id: string; text: string; at: number }>) => void;
  },
): AsyncGenerator<StreamEvent> {
  let terminalFinishReason: string | undefined;
  let activeModelSettings = { ...modelSettings };
  let activeModelConfig = { ...modelConfig };
  let compatibilityRetried = false;
  let sanitizationRetried = false;
  let activeMessages = messages;
  const MAX_RETRIES = 4;
  const BASE_DELAY_MS = 500;
  const MAX_DELAY_MS = 32_000;
  const maxStepsLimit = config.agent?.maxTurns ?? config.advanced.maxSteps;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    const eventQueue: StreamEvent[] = [];
    let currentStepCount = 0;

    try {
      const agent = await buildAgent(activeModelConfig);
      const msgArr = activeMessages as Array<{ role?: string }>;
      console.info(
        `[Agent:generate] conv=${conversationId} messageCount=${msgArr.length} roles=[${msgArr.map((m) => m.role ?? '?').join(',')}] maxSteps=${config.advanced.maxSteps} temp=${typeof activeModelSettings.temperature === 'number' ? activeModelSettings.temperature : 'default'}`,
      );
      const memoryOptions = buildMastraMemoryOptions(conversationId, memory, config);

      const generateOptions = {
        maxSteps: maxStepsLimit,
        abortSignal: options?.abortSignal,
        // Synthetic-events path: agent.generate() runs to completion and only
        // yields step events afterward. A per-run boundary-persist callback
        // (options.onInjected, used by automation) would therefore fire before
        // any prior step content is observable and misorder the persisted branch.
        // - GUI/server-persisted runs (no onInjected) persist via the global
        //   injectConsumedHandler, which reconstructs from the persisted stream
        //   independent of path — safe to install prepareStep + drain here.
        // - Automation runs (onInjected present) must NOT drain here; leave the
        //   inject queued for the order-correct drain-at-end fallback.
        prepareStep: options?.onInjected ? undefined : buildMastraPrepareStep(conversationId),
        experimental_generateMessageId: () => responseMessageId,
        ...(Object.keys(activeModelSettings).length > 0 ? { modelSettings: activeModelSettings } : {}),
        ...(providerOptions ? { providerOptions } : {}),
        ...(memoryOptions ?? {}),
        onStepFinish: (step: unknown) => {
          const s = step as {
            text?: string;
            toolCalls?: Array<{ toolCallId: string; toolName: string; args: unknown }>;
            toolResults?: Array<{ toolCallId: string; toolName: string; result: unknown }>;
          };

          // Track step progress
          currentStepCount += 1;
          eventQueue.push({
            conversationId,
            type: 'step-progress',
            stepInfo: {
              currentStep: currentStepCount,
              maxSteps: maxStepsLimit,
              hitLimit: false,
              taskComplete: false,
            },
          });

          if (s.toolCalls) {
            for (const tc of s.toolCalls) {
              const startedAt = new Date().toISOString();
              eventQueue.push({
                conversationId,
                type: 'tool-call',
                toolCallId: tc.toolCallId,
                toolName: tc.toolName,
                args: tc.args,
                startedAt,
              });
            }
          }
          if (s.toolResults) {
            for (const tr of s.toolResults) {
              const finishedAt = new Date().toISOString();
              eventQueue.push({
                conversationId,
                type: 'tool-result',
                toolCallId: tr.toolCallId,
                toolName: tr.toolName,
                result: tr.result,
                finishedAt,
              });
            }
          }
        },
      };
      const generate = agent.generate.bind(agent) as unknown as (
        messageInput: Parameters<typeof agent.generate>[0],
        options: Record<string, unknown>,
      ) => ReturnType<typeof agent.generate>;
      const result = await generate(activeMessages as Parameters<typeof agent.generate>[0], generateOptions);

      for (const event of eventQueue) {
        yield event;
      }

      const fullResult = result as { text?: string; finishReason?: string | { unified?: string } };
      if (fullResult.text) {
        yield {
          conversationId,
          type: 'text-delta',
          text: fullResult.text,
        };
      }
      terminalFinishReason =
        typeof fullResult.finishReason === 'string' ? fullResult.finishReason : fullResult.finishReason?.unified;

      // Check if max steps were reached.
      // The AI SDK / Mastra never emits a 'max-steps' finishReason; instead the
      // stream terminates with the last step's finishReason ('tool-calls',
      // 'length', or 'stop') once `maxSteps` is hit. See `didHitStepLimit` for
      // the predicate.
      const hitStepLimit = didHitStepLimit({
        currentStepCount,
        maxStepsLimit,
        terminalFinishReason,
      });

      if (hitStepLimit) {
        console.warn(`[Agent] Max steps reached for ${conversationId}: ${currentStepCount}/${maxStepsLimit}`);
        yield {
          conversationId,
          type: 'max-steps-reached',
          stepInfo: {
            currentStep: currentStepCount,
            maxSteps: maxStepsLimit,
            hitLimit: true,
            taskComplete: false,
          },
        };
      }

      console.info(`[Agent] Generate completed for ${conversationId}`);
      break;
    } catch (error) {
      const emittedAnyOutput = eventQueue.length > 0;
      // If the caller aborted, do NOT retry — skip all retry branches and fall
      // through to the terminal path (which suppresses the error event for an
      // abort). Otherwise a cancel during the error/backoff window would still
      // yield a `retry`, sleep, and call generate() again for a dead turn.
      const aborted = options?.abortSignal?.aborted === true;
      if (
        !aborted &&
        !compatibilityRetried &&
        shouldRetryWithoutTemperature(error, activeModelSettings, emittedAnyOutput)
      ) {
        compatibilityRetried = true;
        activeModelSettings = omitTemperature(activeModelSettings);
        activeModelConfig = withTemperatureOmissionHeader(activeModelConfig);
        console.warn(
          `[Agent] Retrying ${conversationId} without temperature after compatibility error:`,
          getErrorMessage(error),
        );
        continue;
      }
      if (!aborted && !sanitizationRetried && shouldRetryWithSanitizedMessages(error, emittedAnyOutput)) {
        sanitizationRetried = true;
        activeMessages = deepSanitizeMessages(activeMessages);
        console.warn(
          `[Agent] Retrying ${conversationId} with sanitized messages after provider mismatch:`,
          getErrorMessage(error),
        );
        continue;
      }

      // Classify error for retry decision
      const errorInfo = classifyError(error);

      if (!aborted && isSameModelRetryable(errorInfo) && !emittedAnyOutput && attempt < MAX_RETRIES) {
        const delay = calculateDelay(attempt, errorInfo, BASE_DELAY_MS, MAX_DELAY_MS);
        console.warn(
          `[Agent:generate] Transient ${errorInfo.category} error for ${conversationId} (attempt ${attempt + 1}/${MAX_RETRIES}), retrying in ${delay}ms:`,
          errorInfo.message,
        );

        yield {
          conversationId,
          type: 'retry',
          data: {
            attempt: attempt + 1,
            maxRetries: MAX_RETRIES,
            delayMs: delay,
            reason: errorInfo.message,
            category: errorInfo.category,
          },
        };

        await sleep(delay);
        continue;
      }

      for (const event of eventQueue) {
        yield event;
      }

      if (!options?.abortSignal?.aborted) {
        console.error(`[Agent] Generate error for ${conversationId}:`, error);
        yield {
          conversationId,
          type: 'error',
          error: error instanceof Error ? error.message : String(error),
          errorCategory: errorInfo.category,
          errorStatusCode: errorInfo.statusCode,
        };
      }
      break;
    }
  }

  yield {
    conversationId,
    type: 'done',
    ...(terminalFinishReason ? { data: { finishReason: terminalFinishReason } } : {}),
  };
}

/**
 * Standard streaming path for models that support it.
 */
async function* streamWithRealEvents(
  buildAgent: (modelConfig: LLMModelConfig) => Promise<Agent>,
  conversationId: string,
  messages: unknown[],
  modelConfig: LLMModelConfig,
  config: AppConfig,
  memory: ReturnType<typeof getSharedMemory>,
  modelSettings: Record<string, unknown>,
  providerOptions: Record<string, unknown> | undefined,
  responseMessageId: string,
  options?: {
    abortSignal?: AbortSignal;
    onInjected?: (entries: Array<{ id: string; text: string; at: number }>) => void;
  },
): AsyncGenerator<StreamEvent> {
  const toolStartByCallId = new Map<string, { startedAt: string; toolName: string }>();
  let emittedAnyOutput = false;
  let emittedTerminalError = false;
  let terminalFinishReason: string | undefined;
  let activeModelSettings = { ...modelSettings };
  let activeModelConfig = { ...modelConfig };
  let compatibilityRetried = false;
  let sanitizationRetried = false;
  let activeMessages = messages;
  let currentStepCount = 0;
  let maxStepsReachedEmitted = false;
  const maxStepsLimit = config.agent?.maxTurns ?? config.advanced.maxSteps;
  // Accumulated token usage across all steps
  let accInputTokens = 0;
  let accOutputTokens = 0;
  let accCacheReadTokens = 0;
  let accCacheWriteTokens = 0;

  const MAX_RETRIES = 4;
  const BASE_DELAY_MS = 500;
  const MAX_DELAY_MS = 32_000;

  compatibilityLoop: while (true) {
    let requestCompleted = false;
    let compatibilityRetryRequested = false;
    let sanitizationRetryRequested = false;
    const agent = await buildAgent(activeModelConfig);

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
      try {
        console.info(
          `[Agent] Starting stream for ${conversationId}${attempt > 0 ? ` (retry ${attempt})` : ''}${compatibilityRetried ? ' [temp-omitted]' : ''}`,
        );
        const memoryOptions = buildMastraMemoryOptions(conversationId, memory, config);

        const streamOptions = {
          maxSteps: maxStepsLimit,
          abortSignal: options?.abortSignal,
          // Cooperative mid-turn injection: drain the conversation's inject queue
          // at each step boundary and splice queued follow-ups into this turn's
          // context (no abort). No-op when the queue is empty.
          prepareStep: buildMastraPrepareStep(conversationId, undefined, options?.onInjected),
          experimental_generateMessageId: () => responseMessageId,
          ...(Object.keys(activeModelSettings).length > 0 ? { modelSettings: activeModelSettings } : {}),
          ...(providerOptions ? { providerOptions } : {}),
          ...(memoryOptions ?? {}),
        };
        const stream = agent.stream.bind(agent) as unknown as (
          messageInput: Parameters<typeof agent.stream>[0],
          options: Record<string, unknown>,
        ) => ReturnType<typeof agent.stream>;
        const streamResult = await stream(activeMessages as Parameters<typeof agent.stream>[0], streamOptions);

        const fullStream = streamResult.fullStream;
        const iterator =
          Symbol.asyncIterator in (fullStream as object)
            ? (fullStream as AsyncIterable<unknown>)
            : asAsyncIterable(fullStream as ReadableStream<unknown>);

        for await (const chunk of iterator) {
          const c = chunk as RawStreamChunk;
          const type = c?.type;
          const payload = (c?.payload ?? c) as Record<string, unknown> | undefined;

          if (type === 'text-delta') {
            const text = extractStreamText(payload);
            if (!text) continue;
            emittedAnyOutput = true;
            yield {
              conversationId,
              type: 'text-delta',
              text,
            };
          } else if (type === 'tool-call') {
            emittedAnyOutput = true;
            const toolCallId = (payload?.toolCallId as string) ?? `tc-${Date.now()}`;
            const toolName = (payload?.toolName as string) ?? 'unknown';
            const startedAt = new Date().toISOString();
            toolStartByCallId.set(toolCallId, { startedAt, toolName });
            yield {
              conversationId,
              type: 'tool-call',
              toolCallId,
              toolName,
              args: payload?.args ?? {},
              startedAt,
            };
          } else if (type === 'tool-result') {
            emittedAnyOutput = true;
            const toolCallId = (payload?.toolCallId as string) ?? '';
            const finishedAt = new Date().toISOString();
            const started = toolStartByCallId.get(toolCallId);
            toolStartByCallId.delete(toolCallId);
            yield {
              conversationId,
              type: 'tool-result',
              toolCallId,
              toolName: (payload?.toolName as string) ?? started?.toolName ?? '',
              result: payload?.result,
              startedAt: started?.startedAt ?? finishedAt,
              finishedAt,
            };
          } else if (type === 'tool-error') {
            emittedAnyOutput = true;
            const toolCallId = (payload?.toolCallId as string) ?? '';
            const finishedAt = new Date().toISOString();
            const started = toolStartByCallId.get(toolCallId);
            toolStartByCallId.delete(toolCallId);
            yield {
              conversationId,
              type: 'tool-result',
              toolCallId,
              toolName: (payload?.toolName as string) ?? started?.toolName ?? '',
              result: { isError: true, error: payload?.error },
              startedAt: started?.startedAt ?? finishedAt,
              finishedAt,
            };
          } else if (type === 'error') {
            const rawError = payload?.error ?? payload ?? 'Unknown stream error';
            const errorMessage = getErrorMessage(rawError);
            if (
              !compatibilityRetried &&
              shouldRetryWithoutTemperature(rawError, activeModelSettings, emittedAnyOutput)
            ) {
              compatibilityRetried = true;
              activeModelSettings = omitTemperature(activeModelSettings);
              activeModelConfig = withTemperatureOmissionHeader(activeModelConfig);
              compatibilityRetryRequested = true;
              console.warn(
                `[Agent] Retrying ${conversationId} without temperature after compatibility stream error:`,
                errorMessage,
              );
              break;
            }
            if (!sanitizationRetried && shouldRetryWithSanitizedMessages(rawError, emittedAnyOutput)) {
              sanitizationRetried = true;
              activeMessages = deepSanitizeMessages(activeMessages);
              sanitizationRetryRequested = true;
              console.warn(
                `[Agent] Retrying ${conversationId} with sanitized messages after provider mismatch stream error:`,
                errorMessage,
              );
              break;
            }

            emittedTerminalError = true;
            const inStreamErrorInfo = classifyError(rawError);
            yield {
              conversationId,
              type: 'error',
              error: errorMessage,
              errorCategory: inStreamErrorInfo.category,
              errorStatusCode: inStreamErrorInfo.statusCode,
            };
          } else if (type === 'finish') {
            const finishReason = extractStreamFinishReason(payload);
            if (finishReason) {
              terminalFinishReason = finishReason;
            }
            if (finishReason === 'error' && !emittedTerminalError && !options?.abortSignal?.aborted) {
              emittedTerminalError = true;
              yield {
                conversationId,
                type: 'error',
                error: 'The model ended the stream with an error.',
              };
            }
          } else if (type === 'step-finish') {
            const finishReason = extractStreamFinishReason(payload);
            currentStepCount += 1;
            emittedAnyOutput = true;
            yield {
              conversationId,
              type: 'step-progress',
              stepInfo: {
                currentStep: currentStepCount,
                maxSteps: maxStepsLimit,
                hitLimit: false,
                taskComplete: false,
              },
            };

            if (finishReason) {
              terminalFinishReason = finishReason;
            }
            if (finishReason === 'content-filter') {
              console.info(`[Agent] Ending stream early for ${conversationId} after content-filter step finish`);
              break;
            }
            // Accumulate token usage from each step.
            // Mastra wraps the AI SDK step result — usage may sit at
            // payload.usage (direct) or payload.output.usage (wrapped).
            // Key names also vary: openai-compat uses inputTokens/outputTokens,
            // Anthropic uses promptTokens/completionTokens.
            const payloadOutput = payload?.output as Record<string, unknown> | undefined;
            const stepUsage = (payload?.usage ?? payloadOutput?.usage) as
              | { promptTokens?: number; completionTokens?: number; inputTokens?: number; outputTokens?: number }
              | undefined;
            if (stepUsage) {
              accInputTokens += stepUsage.promptTokens ?? stepUsage.inputTokens ?? 0;
              accOutputTokens += stepUsage.completionTokens ?? stepUsage.outputTokens ?? 0;
            }
            // Extract Anthropic cache token info from providerMetadata or directly from usage
            const stepMeta = (payload?.providerMetadata ?? payloadOutput?.providerMetadata) as
              | Record<string, unknown>
              | undefined;
            const anthropicMeta = stepMeta?.anthropic as Record<string, unknown> | undefined;
            if (anthropicMeta) {
              accCacheReadTokens += (anthropicMeta.cacheReadInputTokens as number | undefined) ?? 0;
              accCacheWriteTokens += (anthropicMeta.cacheCreationInputTokens as number | undefined) ?? 0;
            }
            const bedrockMeta = stepMeta?.bedrock as { usage?: Record<string, unknown> } | undefined;
            if (bedrockMeta?.usage) {
              accCacheReadTokens += (bedrockMeta.usage.cacheReadInputTokens as number | undefined) ?? 0;
              accCacheWriteTokens += (bedrockMeta.usage.cacheWriteInputTokens as number | undefined) ?? 0;
            }
            // openai-compat provider puts cache tokens directly on usage
            if (stepUsage) {
              accCacheReadTokens += ((stepUsage as Record<string, unknown>).cachedInputTokens as number) ?? 0;
            }
          } else if (type && isExpectedMastraStructuralEvent(type)) {
            continue;
          } else if (type) {
            // Silently ignore workspace metadata and sandbox events — they are
            // handled by the task agent stream consumer in agents.ts
          }
        }

        if (compatibilityRetryRequested || sanitizationRetryRequested) {
          continue compatibilityLoop;
        }

        console.info(`[Agent] Stream completed for ${conversationId}`);
        requestCompleted = true;
        break;
      } catch (error) {
        if (options?.abortSignal?.aborted) break compatibilityLoop;

        // Temperature compatibility retry (special case — not counted as a retry attempt)
        if (!compatibilityRetried && shouldRetryWithoutTemperature(error, activeModelSettings, emittedAnyOutput)) {
          compatibilityRetried = true;
          activeModelSettings = omitTemperature(activeModelSettings);
          activeModelConfig = withTemperatureOmissionHeader(activeModelConfig);
          console.warn(
            `[Agent] Retrying ${conversationId} without temperature after compatibility error:`,
            getErrorMessage(error),
          );
          continue compatibilityLoop;
        }

        // Provider metadata sanitization retry (special case — not counted as a retry attempt)
        if (!sanitizationRetried && shouldRetryWithSanitizedMessages(error, emittedAnyOutput)) {
          sanitizationRetried = true;
          activeMessages = deepSanitizeMessages(activeMessages);
          console.warn(
            `[Agent] Retrying ${conversationId} with sanitized messages after provider mismatch:`,
            getErrorMessage(error),
          );
          continue compatibilityLoop;
        }

        // Classify error for retry decision
        const errorInfo = classifyError(error);

        // Only retry transient errors when no content has been emitted
        if (isSameModelRetryable(errorInfo) && !emittedAnyOutput && attempt < MAX_RETRIES) {
          const delay = calculateDelay(attempt, errorInfo, BASE_DELAY_MS, MAX_DELAY_MS);
          console.warn(
            `[Agent] Transient ${errorInfo.category} error for ${conversationId} (attempt ${attempt + 1}/${MAX_RETRIES}), retrying in ${delay}ms:`,
            errorInfo.message,
          );

          // Emit retry event so UI can show progress
          yield {
            conversationId,
            type: 'retry',
            data: {
              attempt: attempt + 1,
              maxRetries: MAX_RETRIES,
              delayMs: delay,
              reason: errorInfo.message,
              category: errorInfo.category,
            },
          };

          await sleep(delay);
          // Abort may have fired DURING the backoff sleep — re-check before
          // starting another attempt so a cancelled turn doesn't open a new
          // stream with an already-aborted signal.
          if (options?.abortSignal?.aborted) break compatibilityLoop;
          continue;
        }

        console.error(`[Agent] Stream error for ${conversationId}:`, error);
        emittedTerminalError = true;
        yield {
          conversationId,
          type: 'error',
          error: getErrorMessage(error),
          errorCategory: errorInfo.category,
          errorStatusCode: errorInfo.statusCode,
        };
      }
    }

    if (requestCompleted || options?.abortSignal?.aborted) {
      break;
    }

    break;
  }

  if (options?.abortSignal?.aborted) {
    const finishedAt = new Date().toISOString();
    for (const [toolCallId, toolState] of toolStartByCallId.entries()) {
      yield {
        conversationId,
        type: 'tool-result',
        toolCallId,
        toolName: toolState.toolName,
        result: { isError: true, error: 'Tool execution cancelled.' },
        startedAt: toolState.startedAt,
        finishedAt,
      };
    }
  }

  const hitStepLimit = didHitStepLimit({
    currentStepCount,
    maxStepsLimit,
    terminalFinishReason,
  });

  if (hitStepLimit && !maxStepsReachedEmitted) {
    maxStepsReachedEmitted = true;
    console.warn(`[Agent] Max steps reached for ${conversationId}: ${currentStepCount}/${maxStepsLimit}`);
    yield {
      conversationId,
      type: 'max-steps-reached',
      stepInfo: {
        currentStep: currentStepCount,
        maxSteps: maxStepsLimit,
        hitLimit: true,
        taskComplete: false,
      },
    };
  }

  // Emit accumulated token usage before done
  if (accInputTokens > 0 || accOutputTokens > 0) {
    yield {
      conversationId,
      type: 'context-usage',
      data: {
        inputTokens: accInputTokens,
        outputTokens: accOutputTokens,
        cacheReadTokens: accCacheReadTokens,
        cacheWriteTokens: accCacheWriteTokens,
        totalTokens: accInputTokens + accOutputTokens,
      },
    };
  }

  yield {
    conversationId,
    type: 'done',
    ...(terminalFinishReason ? { data: { finishReason: terminalFinishReason } } : {}),
  };
}

/**
 * Fallback-aware streaming wrapper.
 * Tries the primary model first, then each fallback in order.
 * Fallback triggers on pre-content errors, and also on terminal content filters.
 */
export async function* streamWithFallback(
  conversationId: string,
  messages: unknown[],
  streamConfig: ResolvedStreamConfig,
  config: AppConfig,
  tools: ToolDefinition[],
  dbPath: string,
  options?: {
    reasoningEffort?: ReasoningEffort;
    abortSignal?: AbortSignal;
    cwd?: string;
    /** No live user watching this run — see ToolExecutionContext.isHeadless. */
    isHeadless?: boolean;
    parentProfileKey?: string | null;
    parentModelKey?: string | null;
    responseMessageId?: string;
    emitEvent?: (event: StreamEvent) => void;
  } & ToolLifecycleHooks,
): AsyncGenerator<StreamEvent> {
  const modelChain: ModelCatalogEntry[] = [
    streamConfig.primaryModel,
    ...(streamConfig.fallbackEnabled ? streamConfig.fallbackModels : []),
  ];
  let responseMessageId = options?.responseMessageId ?? createResponseMessageId();

  for (let attempt = 0; attempt < modelChain.length; attempt++) {
    if (options?.abortSignal?.aborted) {
      yield { conversationId, type: 'done' };
      return;
    }

    const entry = modelChain[attempt];
    const configOverride: AppConfig = {
      ...config,
      systemPrompt: config.systemPrompt || streamConfig.systemPrompt,
      advanced: {
        ...config.advanced,
        temperature: streamConfig.temperature,
        maxSteps: streamConfig.maxSteps,
        maxRetries: streamConfig.maxRetries,
      },
    };

    let emittedContent = false;
    let lastError: string | null = null;
    let terminalFinishReason: string | null = null;
    let fallbackReason: 'content-filter' | 'transient' | null = null;
    let discardPartialAssistant = false;
    // When a TRANSIENT error hits AFTER content already streamed, we still fall
    // back — but the partial+error attempt is preserved as its own variant
    // (sibling assistant message) rather than discarded, so the user sees
    // "k / N variants" with the failed partials selectable.
    let preserveErroredVariant = false;

    try {
      console.info(
        `[Fallback] Attempt ${attempt + 1}/${modelChain.length}: model=${entry.modelConfig.modelName} key=${entry.key}`,
      );

      const innerStream = streamAgentResponse(
        conversationId,
        messages,
        entry.modelConfig,
        configOverride,
        tools,
        dbPath,
        // parentModelKey must reflect the model ACTUALLY handling this attempt,
        // not the (possibly failed) primary — else a sub_agent spawned by a
        // fallback model would pin the known-failing primary. Keep the caller's
        // parentProfileKey (the profile owns the whole chain).
        { ...options, parentModelKey: entry.key, responseMessageId },
      );

      for await (const event of innerStream) {
        // Track whether real content has been emitted
        if (event.type === 'text-delta' || event.type === 'tool-call') {
          emittedContent = true;
        }

        if (event.type === 'error' && attempt < modelChain.length - 1) {
          // Never fall back on a USER abort — that's a deliberate cancel, not a
          // model failure. (The outer catch / abortSignal checks handle the
          // terminal path.)
          const userAborted = options?.abortSignal?.aborted === true;
          if (!userAborted) {
            if (!emittedContent) {
              // Error before any content — classic pre-content fallback: capture
              // and try the next model, don't show the error to the UI.
              lastError = event.error ?? 'Unknown error';
              continue;
            }
            // Error AFTER content started. Only fall back for TRANSIENT upstream
            // failures (500 / 529 / network / timeout / rate-limit / 402 quota /
            // provider cancel). A non-transient error (bad request, auth, content) stays
            // terminal and is yielded below. The partial+error is preserved as
            // its own variant so the user can see the failed attempt.
            // Prefer the event's STRUCTURED status/category (streamAgentResponse
            // classified the raw error) over re-parsing the message string — a
            // 503 with a generic message would otherwise look non-transient.
            const evStatus = (event as { errorStatusCode?: number }).errorStatusCode;
            const evCategory = (event as { errorCategory?: string }).errorCategory;
            const transientCategories = new Set([
              'rate-limit',
              'overload',
              'server-error',
              'timeout',
              'network',
              'quota',
            ]);
            const info =
              evStatus !== undefined
                ? classifyError({ status: evStatus, message: event.error ?? '' })
                : classifyError(event.error ?? '');
            const isTransient = info.isTransient || (evCategory ? transientCategories.has(evCategory) : false);
            if (isTransient) {
              lastError = event.error ?? 'Unknown error';
              fallbackReason = 'transient';
              preserveErroredVariant = true;
              break; // stop consuming this attempt; fall back below
            }
          }
        }

        if (event.type === 'done') {
          const doneData = event.data as { finishReason?: string } | undefined;
          terminalFinishReason = doneData?.finishReason ?? null;

          if (terminalFinishReason === 'content-filter' && attempt < modelChain.length - 1) {
            fallbackReason = 'content-filter';
            discardPartialAssistant = emittedContent;
            break;
          }
        }

        // Skip inner 'done' if we're about to fallback
        if (event.type === 'done' && lastError && !emittedContent && attempt < modelChain.length - 1) {
          break;
        }

        yield event;
      }

      // Transient mid-stream fallback: emit the fallback event carrying the
      // preserve flag so persistence commits the partial+error as a sibling
      // variant, then retry the next model (a fresh sibling under the same parent).
      if (fallbackReason === 'transient') {
        const nextEntry = modelChain[attempt + 1];
        yield {
          conversationId,
          type: 'model-fallback',
          data: {
            fromModel: entry.displayName,
            fromModelKey: entry.key,
            toModel: nextEntry.displayName,
            toModelKey: nextEntry.key,
            error: lastError ?? 'transient error',
            reason: fallbackReason,
            preserveErroredVariant,
            attempt: attempt + 1,
          },
        };
        // The partial response was intentionally preserved as a sibling. The
        // next model attempt must therefore have its own shared Kai/Mastra id.
        responseMessageId = createResponseMessageId();
        continue;
      }

      if (fallbackReason === 'content-filter') {
        const nextEntry = modelChain[attempt + 1];
        yield {
          conversationId,
          type: 'model-fallback',
          data: {
            fromModel: entry.displayName,
            fromModelKey: entry.key,
            toModel: nextEntry.displayName,
            toModelKey: nextEntry.key,
            error: 'content filter',
            reason: fallbackReason,
            discardPartialAssistant,
            attempt: attempt + 1,
          },
        };
        continue;
      }

      // If content was emitted successfully or no error occurred, we're done
      if (emittedContent || !lastError) {
        return;
      }

      // Error before content — emit fallback event and try next model
      const nextEntry = modelChain[attempt + 1];
      yield {
        conversationId,
        type: 'model-fallback',
        data: {
          fromModel: entry.displayName,
          fromModelKey: entry.key,
          toModel: nextEntry.displayName,
          toModelKey: nextEntry.key,
          error: lastError,
          attempt: attempt + 1,
        },
      };
      continue;
    } catch (outerError) {
      if (options?.abortSignal?.aborted) {
        yield { conversationId, type: 'done' };
        return;
      }

      const outerInfo = classifyError(outerError);
      // Fall back on a thrown error when fallbacks remain, IF either no content
      // was emitted yet, OR the error is transient (mid-stream provider failure).
      // A non-transient throw after content stays terminal (yielded below).
      const canFallback = attempt < modelChain.length - 1 && (!emittedContent || outerInfo.isTransient);
      if (canFallback) {
        const nextEntry = modelChain[attempt + 1];
        yield {
          conversationId,
          type: 'model-fallback',
          data: {
            fromModel: entry.displayName,
            fromModelKey: entry.key,
            toModel: nextEntry.displayName,
            toModelKey: nextEntry.key,
            error: getErrorMessage(outerError),
            reason: 'transient',
            // Preserve the partial as a variant only if content actually streamed.
            preserveErroredVariant: emittedContent,
            attempt: attempt + 1,
          },
        };
        if (emittedContent) {
          responseMessageId = createResponseMessageId();
        }
        continue;
      }

      // Last model also failed (or a non-transient error after content)
      const lastErrorInfo = classifyError(outerError);
      yield {
        conversationId,
        type: 'error',
        error: getErrorMessage(outerError),
        errorCategory: lastErrorInfo.category,
        errorStatusCode: lastErrorInfo.statusCode,
      };
      yield { conversationId, type: 'done' };
      return;
    }
  }

  // Should not reach here, but safety net
  yield { conversationId, type: 'done' };
}

function resolveModeSystemPrompt(config: AppConfig, executionMode?: string): string {
  const prompts = config.systemPrompts;
  const chatPrompt = prompts?.chat?.trim() || config.systemPrompt;

  if (executionMode === 'plan-first') {
    return prompts?.plan?.trim() || DEFAULT_PLAN_PROMPT;
  }

  return chatPrompt;
}

function buildAgentInstructions(config: AppConfig, executionMode?: string): string {
  const basePrompt = resolveModeSystemPrompt(config, executionMode);
  const lines = [
    basePrompt,
    '',
    'Runtime capabilities:',
    '- Long-running tool output can be streamed while a tool is running.',
    '- The runtime may emit mid-tool progress updates to the user.',
    '- A tool run may be cancelled if output indicates failure, risk, or mismatch with intent.',
    '- Do not claim that mid-tool progress updates are impossible in this environment.',
    '- For shell commands, prefer the tool working directory and relative paths. Quote every path that contains whitespace.',
    '- Treat stderr as diagnostic output even when the final exit code is zero, and avoid pipelines that mask an earlier command failure.',
  ];

  if (executionMode === 'plan-first') {
    lines.push(
      '',
      'PLAN MODE ACTIVE:',
      '- You are in planning mode. You MUST NOT make any edits, run non-readonly tools, or otherwise make changes to the system.',
      '- Only use read-only tools (mastra_workspace_read_file, mastra_workspace_grep, mastra_workspace_list_files, web_fetch, web_search).',
      '- Do NOT use mastra_workspace_write_file, mastra_workspace_edit_file, or mastra_workspace_execute_command tools — they are not available in this mode.',
      '- Be extremely thorough in your exploration. Read all relevant files, trace code paths, and understand the full picture.',
      '- Use ask_user throughout planning to clarify requirements, preferences, or decisions you cannot resolve from code alone. Never ask what you could find out by reading the code.',
      '- When your plan is ready, call exit_plan_mode with the planContent parameter containing the full plan as markdown. Optionally provide a planTitle for the filename.',
      '- The plan markdown should be structured as:',
      '  1. A top-level heading with the plan title (e.g. "# Plan: Add Dark Mode")',
      '  2. Context: why this change is needed, the problem it addresses, and the intended outcome',
      '  3. A clear, step-by-step implementation plan describing exactly what changes you would make',
      '  4. Paths of critical files to be modified, and existing functions/utilities to reuse',
      '  5. Expected impact, risks, edge cases, and how to verify the changes',
      '- Include only your recommended approach, not all alternatives. Be concise enough to scan quickly but detailed enough to execute.',
      '- Do NOT write the plan as regular text in the conversation. Instead, pass the entire plan as the planContent argument to exit_plan_mode. The user will see it in a dedicated side panel.',
      '- Your turn should ONLY end by either using ask_user (to clarify requirements) or calling exit_plan_mode (to present the plan for approval). Do not stop for any other reason.',
      '- Use exit_plan_mode to request plan approval. Do NOT ask about plan approval via text — phrases like "Is this plan okay?" or "Should I proceed?" MUST use exit_plan_mode instead.',
      '- IMPORTANT: If exit_plan_mode has been approved and its result indicates auto mode is restored, these restrictions no longer apply on the next turn.',
    );
  } else {
    lines.push(
      '- You have enter_plan_mode and exit_plan_mode tools. When the user asks to plan, think first, or explore before coding, call enter_plan_mode to switch to plan-first mode.',
      '- You have an ask_user tool for asking the user questions with multiple-choice options. Use it when you need clarification, preferences, or decisions. Provide 2-4 clear options per question and a short header for each question tab. The user can also type a custom response.',
    );
  }

  return lines.join('\n');
}

async function* asAsyncIterable<T>(stream: ReadableStream<T>): AsyncGenerator<T> {
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

/** Test-only exposure of the pure stream-payload parsers + option normalizers. */
export const __internal = {
  extractStreamText,
  extractStreamFinishReason,
  isExpectedMastraStructuralEvent,
  toMastraInputSchema,
  compactToolArgs,
  getStringOption,
  getNumberOption,
  getBooleanOption,
  getStringArrayOption,
  getRecordOption,
  normalizeSearchContextSize,
  normalizeApproximateLocation,
  normalizeOpenAIWebSearchFilters,
  normalizeProviderToolType,
  normalizeWorkspacePath,
  normalizeWorkspaceToolInput,
  coerceWorkspaceReadLineArguments,
  surfaceWorkspaceCommandStderr,
  mergeAbortSignals,
  buildMastraMemoryOptions,
};
