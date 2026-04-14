import type { AppConfig } from '../config/schema.js';
import { resolveModelCatalog, resolveStreamConfig } from './model-catalog.js';
import type { ReasoningEffort } from './model-catalog.js';
import { streamAgentResponse, streamWithFallback } from './mastra-agent.js';
import type { StreamEvent } from './mastra-agent.js';
import type { ToolDefinition } from '../tools/types.js';
import { join } from 'path';

export type PluginGenerateOptions = {
  messages: Array<{ role: string; content: unknown }>;
  config: AppConfig;
  appHome: string;
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

type SanitizedContent = string | Array<{ type: 'text'; text: string } | { type: 'image'; image: unknown; mimeType?: string }>;

function sanitizeMessages(
  messages: Array<{ role: string; content: unknown }>,
): Array<{ role: 'user' | 'assistant' | 'system'; content: SanitizedContent }> {
  const clean: Array<{ role: 'user' | 'assistant' | 'system'; content: SanitizedContent }> = [];

  for (const msg of messages) {
    const role = msg.role;
    if (role !== 'user' && role !== 'assistant' && role !== 'system') continue;

    if (Array.isArray(msg.content)) {
      const parts = msg.content as Array<Record<string, unknown>>;
      const textParts: Array<{ type: 'text'; text: string }> = [];
      const imageParts: Array<{ type: 'image'; image: unknown; mimeType?: string }> = [];

      for (const part of parts) {
        if (part.type === 'text' && typeof part.text === 'string') {
          textParts.push({ type: 'text', text: part.text });
        } else if (part.type === 'image' && part.image != null) {
          imageParts.push({
            type: 'image',
            image: part.image,
            ...(typeof part.mimeType === 'string' ? { mimeType: part.mimeType } : {}),
          });
        }
      }

      if (imageParts.length > 0) {
        const contentArray: SanitizedContent = [...textParts, ...imageParts];
        if (contentArray.length > 0) {
          clean.push({ role, content: contentArray });
        }
      } else if (textParts.length > 0) {
        clean.push({ role, content: textParts.map((p) => p.text).join('\n') });
      }
      continue;
    }

    if (typeof msg.content !== 'string') continue;
    if (!msg.content.trim()) continue;

    clean.push({ role, content: msg.content });
  }

  return clean;
}

export async function generateForPlugin(options: PluginGenerateOptions): Promise<PluginGenerateResult> {
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
    const sanitized = sanitizeMessages(messages as Array<{ role: string; content: unknown }>);
    const allMessages: Array<{ role: string; content: SanitizedContent }> = [];
    if (systemPrompt) allMessages.push({ role: 'system', content: systemPrompt });
    allMessages.push(...sanitized);
    const conversationId = `plugin-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const stream = streamAgentResponse(conversationId, allMessages, fallbackEntry.modelConfig, config, pluginTools ?? [], dbPath, { abortSignal: options.abortSignal });
    return collectStreamResult(stream, fallbackEntry.key);
  }

  const modelConfig = streamConfig.primaryModel.modelConfig;
  const dbPath = join(appHome, 'data', 'memory.db');
  const sanitized = sanitizeMessages(messages as Array<{ role: string; content: unknown }>);

  const allMessages: Array<{ role: string; content: SanitizedContent }> = [];
  if (systemPrompt) {
    allMessages.push({ role: 'system', content: systemPrompt });
  }
  allMessages.push(...sanitized);

  const conversationId = `plugin-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  let stream: AsyncGenerator<StreamEvent>;

  if (streamConfig.fallbackEnabled && streamConfig.fallbackModels.length > 0) {
    stream = streamWithFallback(
      conversationId,
      allMessages,
      streamConfig,
      config,
      pluginTools ?? [],
      dbPath,
      { reasoningEffort: options.reasoningEffort as ReasoningEffort | undefined, abortSignal: options.abortSignal },
    );
  } else {
    stream = streamAgentResponse(
      conversationId,
      allMessages,
      modelConfig,
      config,
      pluginTools ?? [],
      dbPath,
      { reasoningEffort: options.reasoningEffort as ReasoningEffort | undefined, abortSignal: options.abortSignal },
    );
  }

  return collectStreamResult(stream, streamConfig.primaryModel.key);
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
