import type { AppConfig } from '../config/schema.js';
import { resolveModelCatalog, resolveStreamConfig } from './model-catalog.js';
import type { ReasoningEffort, ResolvedStreamConfig } from './model-catalog.js';
import { streamAgentResponse, streamWithFallback } from './mastra-agent.js';
import type { StreamEvent } from './mastra-agent.js';
import type { ToolDefinition } from '../tools/types.js';
import { sanitizePluginMessages } from './plugin-message-sanitizer.js';
import { randomUUID } from 'crypto';
import { join } from 'path';

export type PluginGenerateOptions = {
  messages: Array<{ role: string; content: unknown }>;
  config: AppConfig;
  appHome: string;
  /** Optional real conversation id to expose to tool executors and memory scoping; falls back to a synthetic `plugin-*` id when omitted. */
  conversationId?: string;
  modelKey?: string;
  profileKey?: string;
  reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh';
  fallbackEnabled?: boolean;
  systemPrompt?: string;
  tools?: ToolDefinition[];
  abortSignal?: AbortSignal;
};

export type PluginGenerateToolCall = {
  toolName: string;
  args: unknown;
  result: unknown;
  error?: string;
  durationMs?: number;
};

export type PluginGenerateResult = {
  text: string;
  modelKey: string;
  toolCalls: PluginGenerateToolCall[];
};

export type PluginGenerateStreamEvent = Omit<StreamEvent, 'type'> & {
  // The plugin generate stream never emits the internal cross-client
  // 'user-message' broadcast (that's a submit-path event), so exclude it here to
  // stay assignable to the plugin-facing PluginAgentStreamEvent union.
  type: Exclude<StreamEvent['type'], 'user-message'>;
  modelKey?: string;
};

/** Synthetic conversation id for a headless run with no real target. Uses a
 *  UUID under a reserved `plugin-` namespace: collision-safe and disjoint from
 *  real conversation ids (which are never `plugin-<uuid>`), so a synthetic id
 *  can't accidentally point at a persisted conversation and misroute a write. */
function syntheticConversationId(): string {
  return `plugin-${randomUUID()}`;
}

function configForPluginStream(
  config: AppConfig,
  streamConfig: ResolvedStreamConfig | null | undefined,
  systemPrompt?: string,
): AppConfig {
  const effectiveSystemPrompt =
    systemPrompt?.trim() || streamConfig?.systemPrompt || config.systemPrompts?.chat || config.systemPrompt;

  return {
    ...config,
    systemPrompt: effectiveSystemPrompt,
    systemPrompts: {
      ...config.systemPrompts,
      chat: effectiveSystemPrompt,
    },
    advanced: {
      ...config.advanced,
      temperature: streamConfig?.temperature ?? config.advanced.temperature,
      maxSteps: streamConfig?.maxSteps ?? config.advanced.maxSteps,
      maxRetries: streamConfig?.maxRetries ?? config.advanced.maxRetries,
    },
  };
}

async function preparePluginStream(options: PluginGenerateOptions): Promise<{
  stream: AsyncGenerator<StreamEvent>;
  modelKey: string;
}> {
  const { config, appHome, messages, systemPrompt, tools: pluginTools } = options;

  const streamConfig = resolveStreamConfig(config, {
    threadModelKey: options.modelKey ?? null,
    threadProfileKey: options.profileKey ?? null,
    reasoningEffort: options.reasoningEffort as ReasoningEffort | undefined,
    fallbackEnabled: options.fallbackEnabled ?? false,
  });

  if (!streamConfig?.primaryModel) {
    const catalog = resolveModelCatalog(config);
    const fallbackEntry = catalog.defaultEntry;
    if (!fallbackEntry) {
      throw new Error('No model configured. Set a default model in Kai settings.');
    }
    // Fallback: use default model directly
    const dbPath = join(appHome, 'data', 'memory.db');
    const sanitized = sanitizePluginMessages(messages as Array<{ role: string; content: unknown }>);
    const configForStream = configForPluginStream(config, null, systemPrompt);
    const conversationId = options.conversationId ?? syntheticConversationId();

    const stream = streamAgentResponse(
      conversationId,
      sanitized,
      fallbackEntry.modelConfig,
      configForStream,
      pluginTools ?? [],
      dbPath,
      // isHeadless MUST match the other stream paths: this is still a headless /
      // automation run, so ask_user must fall back to an Alert (not block). Also
      // forward reasoningEffort so the default-model path honors it.
      {
        abortSignal: options.abortSignal,
        reasoningEffort: options.reasoningEffort as ReasoningEffort | undefined,
        isHeadless: true,
      },
    );
    return { stream, modelKey: fallbackEntry.key };
  }

  const modelConfig = streamConfig.primaryModel.modelConfig;
  const dbPath = join(appHome, 'data', 'memory.db');
  const sanitized = sanitizePluginMessages(messages as Array<{ role: string; content: unknown }>);
  const configForStream = configForPluginStream(config, streamConfig, systemPrompt);

  const conversationId = options.conversationId ?? syntheticConversationId();

  let stream: AsyncGenerator<StreamEvent>;

  if (streamConfig.fallbackEnabled && streamConfig.fallbackModels.length > 0) {
    stream = streamWithFallback(conversationId, sanitized, streamConfig, configForStream, pluginTools ?? [], dbPath, {
      reasoningEffort: options.reasoningEffort as ReasoningEffort | undefined,
      abortSignal: options.abortSignal,
      isHeadless: true,
    });
  } else {
    stream = streamAgentResponse(conversationId, sanitized, modelConfig, configForStream, pluginTools ?? [], dbPath, {
      reasoningEffort: options.reasoningEffort as ReasoningEffort | undefined,
      abortSignal: options.abortSignal,
      isHeadless: true,
    });
  }

  return { stream, modelKey: streamConfig.primaryModel.key };
}

export async function generateForPlugin(options: PluginGenerateOptions): Promise<PluginGenerateResult> {
  const { stream, modelKey } = await preparePluginStream(options);
  return collectStreamResult(stream, modelKey);
}

export async function* streamForPlugin(options: PluginGenerateOptions): AsyncGenerator<PluginGenerateStreamEvent> {
  const { stream, modelKey } = await preparePluginStream(options);

  for await (const event of stream) {
    // 'user-message' is a submit-path cross-client broadcast, never part of a
    // generate stream — skip it defensively so it's never forwarded to plugins.
    if (event.type === 'user-message') continue;
    // event.type is now narrowed to exclude 'user-message'; assert the shape so
    // the yield stays within PluginGenerateStreamEvent.
    const forwarded = (event.type === 'done' ? { ...event, modelKey } : event) as PluginGenerateStreamEvent;
    yield forwarded;
  }
}

async function collectStreamResult(
  stream: AsyncGenerator<StreamEvent>,
  modelKey: string,
): Promise<PluginGenerateResult> {
  let text = '';
  let error: string | null = null;
  let lastEventWasToolResult = false;
  const toolCalls: PluginGenerateToolCall[] = [];
  const pendingToolCalls = new Map<string, { toolName: string; args: unknown; startedAt: number }>();

  for await (const event of stream) {
    if (event.type === 'text-delta' && event.text) {
      if (lastEventWasToolResult && text.length > 0 && !text.endsWith('\n')) {
        text += '\n\n';
      }
      text += event.text;
      lastEventWasToolResult = false;
    } else if (event.type === 'tool-call' && event.toolCallId) {
      pendingToolCalls.set(event.toolCallId, {
        toolName: event.toolName ?? 'unknown',
        args: event.args,
        startedAt: Date.now(),
      });
    } else if (event.type === 'tool-result' && event.toolCallId) {
      lastEventWasToolResult = true;
      const pending = pendingToolCalls.get(event.toolCallId);
      toolCalls.push({
        toolName: pending?.toolName ?? event.toolName ?? 'unknown',
        args: pending?.args ?? {},
        result: event.result,
        durationMs: pending ? Date.now() - pending.startedAt : undefined,
      });
      pendingToolCalls.delete(event.toolCallId);
    } else if (event.type === 'tool-error' && event.toolCallId) {
      const pending = pendingToolCalls.get(event.toolCallId);
      toolCalls.push({
        toolName: pending?.toolName ?? event.toolName ?? 'unknown',
        args: pending?.args ?? {},
        result: null,
        error: event.error ?? 'Tool execution failed',
        durationMs: pending ? Date.now() - pending.startedAt : undefined,
      });
      pendingToolCalls.delete(event.toolCallId);
    } else if (event.type === 'error') {
      error = event.error ?? 'Unknown error';
    }
  }

  if (error && !text) {
    throw new Error(error);
  }

  return { text, modelKey, toolCalls };
}
