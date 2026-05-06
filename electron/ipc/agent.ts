import type { IpcMain } from 'electron';
import { BrowserWindow } from 'electron';
import { broadcastToWebClients } from '../web-server/web-clients.js';
import { resolveModelCatalog, resolveStreamConfig } from '../agent/model-catalog.js';
import { normalizeAgentCwd } from '../agent/mastra-agent.js';
import type { StreamEvent, ReasoningEffort } from '../agent/mastra-agent.js';
import { generateTitle } from '../agent/title-generation.js';
import type { AppConfig, ExecutionMode } from '../config/schema.js';
import { readEffectiveConfig } from './config.js';
import { shouldCompact, compactConversationPrefix, compactToolResult, estimateToolTokens } from '../agent/compaction.js';
import { appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';

// ---------------------------------------------------------------------------
// Debug logging for stream pipeline diagnostics
// ---------------------------------------------------------------------------
const IPC_DEBUG_DIR = join(process.cwd(), 'debug-logs');
const IPC_DEBUG_LOG = join(IPC_DEBUG_DIR, 'stream-pipeline.log');
function ipcDebugLog(msg: string): void {
  try {
    mkdirSync(IPC_DEBUG_DIR, { recursive: true });
    appendFileSync(IPC_DEBUG_LOG, `[${new Date().toISOString()}] ${msg}\n`);
  } catch { /* ignore */ }
}
import type { ToolCompactionConfig } from '../agent/compaction.js';
import type { ToolDefinition, ToolExecutionContext } from '../tools/types.js';
import { ensureSafeToolDefinitions, findToolByName } from '../tools/naming.js';
import { resolveRuntimeForStream } from '../agent/runtime/index.js';
import {
  ToolObserverManager,
  resolveToolObserverConfig,
  summarizeLatestUserRequest,
  summarizeThreadContext,
  type LaunchToolCallResult,
} from '../agent/tool-observer.js';
import { sendSubAgentFollowUp, sendSubAgentFollowUpByToolCall, stopSubAgent, getActiveSubAgentIds } from '../tools/sub-agent.js';
import { recordUsageEvent } from './usage.js';
import type { PluginManager } from '../plugins/plugin-manager.js';
import type { HookMessage } from '../plugins/types.js';

const activeStreams = new Map<string, { abort: () => void }>();
const activeObserverSessions = new Map<string, string>();
const PLAN_MODE_CUSTOM_TOOLS = new Set([
  'ask_user',
  'enter_plan_mode',
  'exit_plan_mode',
  'web_fetch',
  'web_search',
]);

// Pending tool approval promises — shared with the Claude Agent SDK MCP bridge
import { pendingToolApprovals } from './tool-approval.js';

// Pending user answers for ask_user tool — populated by IPC handler before approval resolves
import { pendingQuestionAnswers } from '../tools/ask-user.js';

// Track the model key used for each active stream so we can attribute token usage
const activeStreamModelKeys = new Map<string, string>();

function broadcastStreamEvent(event: StreamEvent): void {
  // Debug: log every event broadcast
  const eventSummary = event.type === 'text-delta'
    ? `text-delta len=${(event.text ?? '').length}`
    : event.type === 'tool-call'
      ? `tool-call id=${event.toolCallId} name=${event.toolName}`
      : event.type === 'tool-result'
        ? `tool-result id=${event.toolCallId} name=${event.toolName}`
        : event.type === 'done'
          ? `done data=${JSON.stringify((event as Record<string, unknown>).data ?? null)}`
          : event.type === 'error'
            ? `error msg=${(event.error ?? '').slice(0, 200)}`
            : event.type;
  const windowCount = BrowserWindow.getAllWindows().length;
  ipcDebugLog(`[BROADCAST] conv=${event.conversationId} ${eventSummary} windows=${windowCount}`);

  // Intercept context-usage events to record LLM token usage
  if (event.type === 'context-usage' && event.conversationId) {
    const data = event.data as {
      inputTokens?: number;
      outputTokens?: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
      totalTokens?: number;
    } | undefined;
    if (data && (data.inputTokens || data.outputTokens || data.totalTokens)) {
      recordUsageEvent({
        modality: 'llm',
        conversationId: event.conversationId,
        modelKey: activeStreamModelKeys.get(event.conversationId) ?? undefined,
        inputTokens: data.inputTokens ?? 0,
        outputTokens: data.outputTokens ?? 0,
        cacheReadTokens: data.cacheReadTokens ?? 0,
        cacheWriteTokens: data.cacheWriteTokens ?? 0,
        totalTokens: data.totalTokens ?? 0,
      });
    }
  }

  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('agent:stream-event', event);
  }
  broadcastToWebClients('agent:stream-event', event);
}

function mergeAbortSignals(primary?: AbortSignal, secondary?: AbortSignal): AbortSignal | undefined {
  if (!primary && !secondary) return undefined;
  if (!primary) return secondary;
  if (!secondary) return primary;

  const controller = new AbortController();
  if (primary.aborted || secondary.aborted) {
    controller.abort();
    return controller.signal;
  }

  const abort = (): void => controller.abort();
  primary.addEventListener('abort', abort, { once: true });
  secondary.addEventListener('abort', abort, { once: true });
  return controller.signal;
}

function toolsForExecutionMode(tools: ToolDefinition[], executionMode: ExecutionMode): ToolDefinition[] {
  if (executionMode === 'plan-first') {
    return tools.filter((tool) => PLAN_MODE_CUSTOM_TOOLS.has(tool.name));
  }

  return tools;
}

function broadcastExecutionMode(mode: ExecutionMode): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('agent:execution-mode-changed', mode);
  }
  broadcastToWebClients('agent:execution-mode-changed', mode);
}

function withObserverAugmentation(result: unknown, augmentation: Record<string, unknown> | undefined): unknown {
  if (!augmentation) return result;
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return { value: result, ...augmentation };
  }

  const base = result as Record<string, unknown>;
  const observerPayload = augmentation.observer as Record<string, unknown> | undefined;
  const existingObserver = (base.observer && typeof base.observer === 'object')
    ? base.observer as Record<string, unknown>
    : undefined;

  if (!observerPayload) return { ...base, ...augmentation };
  return {
    ...base,
    observer: existingObserver
      ? { ...existingObserver, ...observerPayload }
      : observerPayload,
  };
}

/**
 * Stringify a tool result into a flat text representation suitable for
 * token counting and compaction.
 */
function stringifyToolResult(result: unknown): string {
  if (typeof result === 'string') return result;
  if (result == null) return '';
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}

/**
 * Extract the latest user query text from the message list.
 * Used to give the AI compactor context about what the user asked.
 */
function extractLatestUserQuery(messages: unknown[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as { role?: string; content?: unknown } | undefined;
    if (msg?.role !== 'user') continue;
    const text = extractMessageText(msg.content);
    if (text) return text;
  }
  return '';
}

function extractMessageText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (!part || typeof part !== 'object') return '';
      const typedPart = part as { type?: string; text?: string; filename?: string };
      if (typedPart.type === 'text') return typedPart.text ?? '';
      if (typedPart.type === 'file') return typedPart.filename ? `[File: ${typedPart.filename}]` : '[File]';
      if (typedPart.type === 'image') return '[Image]';
      return '';
    })
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildTitleGenerationInput(messages: unknown[]): string {
  // Only include user messages — prevents weaker models from parroting assistant responses
  const normalized = messages
    .map((message) => {
      if (!message || typeof message !== 'object') return null;
      const typedMessage = message as { role?: string; content?: unknown };
      if (typedMessage.role !== 'user') return null;
      const text = extractMessageText(typedMessage.content);
      if (!text) return null;
      return `user: ${text}`;
    })
    .filter((line): line is string => Boolean(line))
    .slice(-8);

  return normalized.join('\n');
}

function nowIso(): string {
  return new Date().toISOString();
}



function logToolCompactionDebug(stage: string, details: Record<string, unknown>): void {
  console.info(`[ToolCompactionDebug] ${stage} ${JSON.stringify(details)}`);
}

// Tool registry - will be populated by Phase 4
let registeredTools: ToolDefinition[] = [];

export function registerTools(tools: ToolDefinition[]): void {
  registeredTools = ensureSafeToolDefinitions(tools);
}

export function getRegisteredTools(): ToolDefinition[] {
  return registeredTools;
}

/** Hot-swap MCP tools without touching built-in, skill, or plugin tools */
export function updateMcpTools(mcpTools: ToolDefinition[]): void {
  const nonMcp = registeredTools.filter((t) => t.source !== 'mcp');
  registeredTools = [...nonMcp, ...ensureSafeToolDefinitions(mcpTools)];
}

/** Hot-swap skill tools without touching built-in or MCP tools */
export function updateSkillTools(skillTools: ToolDefinition[]): void {
  const nonSkill = registeredTools.filter((t) => t.source !== 'skill');
  registeredTools = [...nonSkill, ...ensureSafeToolDefinitions(skillTools)];
}

/** Hot-swap plugin tools without touching built-in, MCP, or skill tools */
export function updatePluginTools(pluginTools: ToolDefinition[]): void {
  const nonPlugin = registeredTools.filter((t) => t.source !== 'plugin');
  registeredTools = [...nonPlugin, ...ensureSafeToolDefinitions(pluginTools)];
}

/** Hot-swap CLI tools without touching built-in, MCP, skill, or plugin tools */
export function updateCliTools(cliTools: ToolDefinition[]): void {
  const nonCli = registeredTools.filter((t) => t.source !== 'cli');
  registeredTools = [...nonCli, ...ensureSafeToolDefinitions(cliTools)];
}

export function registerAgentHandlers(ipcMain: IpcMain, appHome: string, pluginManager?: PluginManager): void {

  ipcMain.handle(
    'agent:stream',
    async (
      _event,
      conversationId: string,
      messages: unknown[],
      modelKey?: string,
      reasoningEffort?: ReasoningEffort,
      profileKey?: string,
      fallbackEnabled?: boolean,
      cwd?: string,
      executionMode?: ExecutionMode,
    ) => {
    const effectiveCwd = normalizeAgentCwd(cwd);
    const effectiveExecutionMode: ExecutionMode = executionMode ?? 'auto';

    // Cancel any existing stream for this conversation
    const existing = activeStreams.get(conversationId);
    if (existing) existing.abort();

    const controller = new AbortController();
    activeStreams.set(conversationId, { abort: () => controller.abort() });
    const randomBytes = new Uint8Array(4);
    crypto.getRandomValues(randomBytes);
    const observerSessionId = `${Date.now()}-${Array.from(randomBytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
    activeObserverSessions.set(conversationId, observerSessionId);

    let config: AppConfig;
    try {
      config = readEffectiveConfig(appHome);
    } catch (error) {
      broadcastStreamEvent({
        conversationId,
        type: 'error',
        error: 'Failed to load config: ' + (error instanceof Error ? error.message : String(error)),
      });
      broadcastStreamEvent({ conversationId, type: 'done' });
      return { conversationId };
    }

    let streamConfig = resolveStreamConfig(config, {
      threadModelKey: modelKey ?? null,
      threadProfileKey: profileKey ?? null,
      reasoningEffort,
      fallbackEnabled: fallbackEnabled ?? false,
    });
    const modelEntry = streamConfig?.primaryModel ?? null;
    let effectiveSystemPrompt = streamConfig?.systemPrompt ?? config.systemPrompt ?? '';

    // Inject execution mode before plugin hooks so prompt/message middleware sees
    // the same mode that the runtime will use.
    const configWithExecutionMode: AppConfig = {
      ...config,
      tools: {
        ...config.tools,
        executionMode: effectiveExecutionMode,
      },
    };

    if (pluginManager) {
      const hookResult = await pluginManager.runPreSendHooks({
        messages: messages as HookMessage[],
        modelKey: modelEntry?.key ?? modelKey ?? config.models.defaultModelKey,
        config: configWithExecutionMode,
        systemPrompt: effectiveSystemPrompt,
      });

      if (hookResult.abort) {
        broadcastStreamEvent({
          conversationId,
          type: 'error',
          error: hookResult.abortReason ?? 'A plugin blocked this message before it was sent.',
        });
        broadcastStreamEvent({ conversationId, type: 'done' });
        activeStreams.delete(conversationId);
        activeStreamModelKeys.delete(conversationId);
        activeObserverSessions.delete(conversationId);
        return { conversationId };
      }

      messages = hookResult.messages;
      if (typeof hookResult.systemPrompt === 'string') {
        effectiveSystemPrompt = hookResult.systemPrompt;
        if (streamConfig) {
          streamConfig = { ...streamConfig, systemPrompt: effectiveSystemPrompt };
        }
      }
    }

    // Resolve runtime using model-aware logic:
    //   - auto mode: picks the best runtime for the model's provider type
    //   - explicit mode: validates compatibility, returns a warning on mismatch
    const { runtime, resolution } = await resolveRuntimeForStream(config, modelEntry);
    ipcDebugLog(`[RUNTIME] conv=${conversationId} runtime=${runtime.id} name=${runtime.name} runtimeId=${resolution.runtimeId} claudeAuth=${resolution.claudeAuth ? `model=${resolution.claudeAuth.modelName} baseUrl=${resolution.claudeAuth.baseUrl}` : 'none'} capabilities=${JSON.stringify(runtime.capabilities)}`);

    // If the user has an explicitly-set runtime that is incompatible with the
    // selected model, surface the warning in the chat and bail early.
    if (resolution.warning) {
      broadcastStreamEvent({ conversationId, type: 'text-delta', text: `⚠️ ${resolution.warning}` });
      broadcastStreamEvent({ conversationId, type: 'done' });
      activeStreams.delete(conversationId);
      activeStreamModelKeys.delete(conversationId);
      activeObserverSessions.delete(conversationId);
      return { conversationId };
    }

    const observerSupported = runtime.capabilities.toolObserver;
    const compactionSupported = runtime.capabilities.compaction;

    const messageList = messages as Array<{ role?: string; content?: unknown }>;
    console.info(`[Agent:stream] conv=${conversationId} model=${modelKey ?? config.models.defaultModelKey} profile=${profileKey ?? 'none'} fallback=${fallbackEnabled ? 'on' : 'off'} fallbackModels=${streamConfig?.fallbackModels.length ?? 0} messageCount=${messageList.length} cwd=${effectiveCwd} executionMode=${effectiveExecutionMode}`);

    // Track the model key for usage attribution
    activeStreamModelKeys.set(
      conversationId,
      modelEntry?.modelConfig?.modelName ?? modelKey ?? config.models.defaultModelKey,
    );
    for (const [index, message] of messageList.entries()) {
      const contentPreview = typeof message.content === 'string'
        ? message.content.slice(0, 200)
        : Array.isArray(message.content)
          ? JSON.stringify(message.content).slice(0, 200)
          : String(message.content ?? '').slice(0, 200);
      console.info(`[Agent:stream]   msg[${index}] role=${message.role ?? '?'} contentLen=${JSON.stringify(message.content ?? '').length} preview=${contentPreview}`);
    }

    // Run streaming in background
    (async () => {
      // Check for plugin inference provider before starting the standard pipeline
      const inferenceProvider = pluginManager?.getInferenceProvider() ?? null;
      if (inferenceProvider) {
        console.info(`[Agent:stream] Using plugin inference provider: ${inferenceProvider.name} for conv=${conversationId}`);
        let emittedTextDelta = false;
        try {
          const providerStream = inferenceProvider.stream({
            conversationId,
            messages: messages as Array<{ role: string; content: unknown }>,
            modelKey: modelEntry?.key ?? modelKey ?? config.models.defaultModelKey,
            systemPrompt: effectiveSystemPrompt,
            reasoningEffort,
            abortSignal: controller.signal,
          });

          for await (const event of providerStream) {
            if (controller.signal.aborted && event.type !== 'done') continue;
            if (event.type === 'text-delta') emittedTextDelta = true;
            broadcastStreamEvent({ ...event, conversationId });
            if (event.type === 'done') break;
          }

          // Provider handled the request — clean up and exit
          activeStreams.delete(conversationId);
          activeStreamModelKeys.delete(conversationId);
          activeObserverSessions.delete(conversationId);
          return;
        } catch (providerError) {
          if (emittedTextDelta) {
            // Already started streaming text — can't fall back mid-response
            console.error(`[Agent:stream] Plugin inference provider "${inferenceProvider.name}" failed after emitting text:`, providerError);
            broadcastStreamEvent({
              conversationId,
              type: 'error',
              error: `Inference provider error: ${providerError instanceof Error ? providerError.message : String(providerError)}`,
            });
            broadcastStreamEvent({ conversationId, type: 'done' });
            activeStreams.delete(conversationId);
            activeStreamModelKeys.delete(conversationId);
            activeObserverSessions.delete(conversationId);
            return;
          }
          // No text emitted yet — fall through to standard Mastra pipeline
          console.warn(`[Agent:stream] Plugin inference provider "${inferenceProvider.name}" failed before emitting text, falling back to standard pipeline:`, providerError);
        }
      }

      const toolCancels = new Map<string, () => void>();
      const pendingObserverToolExecutions = new Set<Promise<void>>();
      let observerLaunchesEnabled = true;
      let observer: ToolObserverManager | null = null;
      // Track the provider:modelName that is producing the current response.
      // Updated on model-fallback events so persisted messages carry the
      // correct source even after automatic fallback.
      let activeSourceModel = modelEntry?.modelConfig
        ? `${modelEntry.modelConfig.provider}:${modelEntry.modelConfig.modelName}`
        : null;
      let activeModelDisplayName: string | null = modelEntry?.displayName ?? null;
      // Compaction metadata keyed by execute-side toolCallId.
      // Populated in augmentToolResult, consumed when the matching
      // tool-result stream event is broadcast.
      const compactionByExecuteId = new Map<string, {
        originalContent: string;
        wasCompacted: boolean;
        extractionDurationMs: number;
      }>();
      type PendingToolCompactionEvent = {
        toolName: string;
        data: {
          phase: 'start' | 'complete';
          originalContent?: string;
          extractionDurationMs?: number;
          timestamp: string;
        };
      };
      const pendingExecIdsByToolName = new Map<string, string[]>();
      const pendingStreamIdsByToolName = new Map<string, string[]>();
      const streamToolCallIdByExecId = new Map<string, string>();
      const execToolCallIdByStreamId = new Map<string, string>();
      const pendingToolCompactionByExecId = new Map<string, PendingToolCompactionEvent[]>();

      const enqueueByToolName = (map: Map<string, string[]>, toolName: string, id: string): void => {
        const queue = map.get(toolName) ?? [];
        queue.push(id);
        map.set(toolName, queue);
      };

      const shiftByToolName = (map: Map<string, string[]>, toolName: string): string | null => {
        const queue = map.get(toolName);
        if (!queue || queue.length === 0) return null;
        const value = queue.shift() ?? null;
        if (queue.length === 0) {
          map.delete(toolName);
        }
        return value;
      };

      const queueOrBroadcastToolCompaction = (
        executeToolCallId: string,
        toolName: string,
        data: PendingToolCompactionEvent['data'],
        mode: 'defer-until-stream-id' | 'direct',
      ): void => {
        if (mode === 'direct') {
          logToolCompactionDebug('broadcast-tool-compaction', {
            conversationId,
            toolCallId: executeToolCallId,
            toolName,
            phase: data.phase,
            mode,
            hasOriginalContent: typeof data.originalContent === 'string' && data.originalContent.length > 0,
            extractionDurationMs: data.extractionDurationMs ?? null,
          });
          broadcastStreamEvent({
            conversationId,
            type: 'tool-compaction',
            toolCallId: executeToolCallId,
            toolName,
            data,
          });
          return;
        }

        const streamToolCallId = streamToolCallIdByExecId.get(executeToolCallId);
        if (streamToolCallId) {
          logToolCompactionDebug('broadcast-tool-compaction-after-pair', {
            conversationId,
            toolCallId: executeToolCallId,
            streamToolCallId,
            toolName,
            phase: data.phase,
            mode,
            hasOriginalContent: typeof data.originalContent === 'string' && data.originalContent.length > 0,
            extractionDurationMs: data.extractionDurationMs ?? null,
          });
          broadcastStreamEvent({
            conversationId,
            type: 'tool-compaction',
            toolCallId: streamToolCallId,
            toolName,
            data,
          });
          return;
        }

        const pending = pendingToolCompactionByExecId.get(executeToolCallId) ?? [];
        pending.push({ toolName, data });
        pendingToolCompactionByExecId.set(executeToolCallId, pending);
        logToolCompactionDebug('queue-tool-compaction', {
          conversationId,
          toolCallId: executeToolCallId,
          toolName,
          phase: data.phase,
          mode,
          queueLength: pending.length,
          hasOriginalContent: typeof data.originalContent === 'string' && data.originalContent.length > 0,
          extractionDurationMs: data.extractionDurationMs ?? null,
        });
      };

      const flushPendingToolCompaction = (executeToolCallId: string): void => {
        const streamToolCallId = streamToolCallIdByExecId.get(executeToolCallId);
        const pending = pendingToolCompactionByExecId.get(executeToolCallId);
        if (!streamToolCallId || !pending || pending.length === 0) return;

        pendingToolCompactionByExecId.delete(executeToolCallId);
        for (const event of pending) {
          logToolCompactionDebug('flush-tool-compaction', {
            conversationId,
            toolCallId: executeToolCallId,
            streamToolCallId,
            toolName: event.toolName,
            phase: event.data.phase,
            queueLength: pending.length,
            hasOriginalContent: typeof event.data.originalContent === 'string' && event.data.originalContent.length > 0,
            extractionDurationMs: event.data.extractionDurationMs ?? null,
          });
          broadcastStreamEvent({
            conversationId,
            type: 'tool-compaction',
            toolCallId: streamToolCallId,
            toolName: event.toolName,
            data: event.data,
          });
        }
      };

      const pairExecuteAndStreamToolCallIds = (toolName: string): string | null => {
        const executeToolCallId = shiftByToolName(pendingExecIdsByToolName, toolName);
        const streamToolCallId = shiftByToolName(pendingStreamIdsByToolName, toolName);
        if (!executeToolCallId || !streamToolCallId) {
          if (executeToolCallId) enqueueByToolName(pendingExecIdsByToolName, toolName, executeToolCallId);
          if (streamToolCallId) enqueueByToolName(pendingStreamIdsByToolName, toolName, streamToolCallId);
          return null;
        }

        streamToolCallIdByExecId.set(executeToolCallId, streamToolCallId);
        execToolCallIdByStreamId.set(streamToolCallId, executeToolCallId);
        logToolCompactionDebug('pair-tool-call-ids', {
          conversationId,
          toolName,
          executeToolCallId,
          streamToolCallId,
        });
        flushPendingToolCompaction(executeToolCallId);
        return executeToolCallId;
      };

      const maybeCompactToolOutput = async (
        toolCallId: string,
        toolName: string,
        result: unknown,
        lifecycleMode: 'defer-until-stream-id' | 'direct',
      ): Promise<{
        result: unknown;
        compaction?: {
          originalContent: string;
          wasCompacted: boolean;
          extractionDurationMs: number;
        };
      }> => {
        const toolCompaction = config.compaction?.tool as ToolCompactionConfig | undefined;
        if (!compactionSupported || !toolCompaction?.enabled || controller.signal.aborted) {
          return { result };
        }

        const originalText = stringifyToolResult(result);
        const userQuery = extractLatestUserQuery(messages);
        const shouldAttemptCompaction = originalText.length > 0
          && estimateToolTokens(originalText, modelEntry?.modelConfig.modelName) > toolCompaction.triggerTokens;

        logToolCompactionDebug('evaluate-tool-output', {
          conversationId,
          toolCallId,
          toolName,
          lifecycleMode,
          originalLength: originalText.length,
          triggerTokens: toolCompaction.triggerTokens,
          modelName: modelEntry?.modelConfig.modelName ?? null,
          shouldAttemptCompaction,
        });

        if (!shouldAttemptCompaction) {
          return { result };
        }

        queueOrBroadcastToolCompaction(toolCallId, toolName, {
          phase: 'start',
          originalContent: originalText,
          timestamp: nowIso(),
        }, lifecycleMode);

        try {
          const compactionResult = await compactToolResult(
            originalText,
            toolName,
            userQuery,
            toolCompaction,
            modelEntry?.modelConfig,
            modelEntry?.modelConfig.modelName,
          );

          if (compactionResult.wasCompacted && !controller.signal.aborted) {
            queueOrBroadcastToolCompaction(toolCallId, toolName, {
              phase: 'complete',
              extractionDurationMs: compactionResult.extractionDurationMs ?? 0,
              timestamp: nowIso(),
            }, lifecycleMode);

            logToolCompactionDebug('compaction-complete', {
              conversationId,
              toolCallId,
              toolName,
              lifecycleMode,
              compactedLength: typeof compactionResult.content === 'string' ? compactionResult.content.length : null,
              extractionDurationMs: compactionResult.extractionDurationMs ?? 0,
            });

            return {
              result: compactionResult.content,
              compaction: {
                originalContent: originalText,
                wasCompacted: true,
                extractionDurationMs: compactionResult.extractionDurationMs ?? 0,
              },
            };
          }
        } catch (compactionError) {
          logToolCompactionDebug('compaction-error', {
            conversationId,
            toolCallId,
            toolName,
            lifecycleMode,
            error: compactionError instanceof Error ? compactionError.message : String(compactionError),
          });
          console.warn('[Agent] Tool compaction failed for', toolName, ':', compactionError);
        }

        return { result };
      };

      const waitForObserverToolExecutions = async (): Promise<void> => {
        while (pendingObserverToolExecutions.size > 0) {
          const pending = Array.from(pendingObserverToolExecutions);
          await Promise.allSettled(pending);
        }
      };

      const activeTools = toolsForExecutionMode(registeredTools, effectiveExecutionMode);

      const launchObserverToolCall = async (toolName: string, args: unknown): Promise<LaunchToolCallResult> => {
        if (!observer) {
          return { ok: false, details: 'Observer runtime not initialized.' };
        }
        if (!observerLaunchesEnabled) {
          return { ok: false, details: 'Observer launches are disabled for this run phase.' };
        }
        if (activeObserverSessions.get(conversationId) !== observerSessionId) {
          return { ok: false, details: 'Observer session is not active for this thread.' };
        }
        if (controller.signal.aborted) {
          return { ok: false, details: 'Thread run is already cancelled.' };
        }

        const tool = findToolByName(activeTools, toolName);
        if (!tool) {
          return { ok: false, details: `Tool "${toolName}" is not registered.` };
        }

        const tcBytes = new Uint8Array(4);
        crypto.getRandomValues(tcBytes);
        const toolCallId = `tc-obs-${Date.now()}-${Array.from(tcBytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
        const startedAt = new Date().toISOString();
        const localAbortController = new AbortController();
        const cancel = (): void => {
          if (!localAbortController.signal.aborted) {
            localAbortController.abort();
          }
        };
        const mergedAbortSignal = mergeAbortSignals(controller.signal, localAbortController.signal);
        toolCancels.set(toolCallId, cancel);

        observer.onToolExecutionStart({
          toolCallId,
          toolName,
          args,
          observerInitiated: true,
        });

        broadcastStreamEvent({
          conversationId,
          type: 'tool-call',
          toolCallId,
          toolName,
          args,
          startedAt,
          observerInitiated: true,
        });

        const runObserverToolExecution = async (): Promise<void> => {
          try {
            const context: ToolExecutionContext = {
              toolCallId,
              conversationId,
              cwd: effectiveCwd,
              abortSignal: mergedAbortSignal,
              onProgress: (progress) => {
                if (activeObserverSessions.get(conversationId) !== observerSessionId) return;
                observer?.onToolProgress({
                  toolCallId,
                  toolName,
                  data: progress,
                });
                if (!controller.signal.aborted) {
                  broadcastStreamEvent({
                    conversationId,
                    type: 'tool-progress',
                    toolCallId,
                    toolName,
                    data: progress,
                  });
                }
              },
            };

            const rawResult = await tool.execute(args, context);
            observer?.onToolExecutionResult(toolCallId, toolName, rawResult);
            const observerAugmented = withObserverAugmentation(rawResult, observer?.getToolAugmentation(toolCallId));
            const compacted = await maybeCompactToolOutput(
              toolCallId,
              toolName,
              observerAugmented,
              'direct',
            );
            const finishedAt = new Date().toISOString();

            if (activeObserverSessions.get(conversationId) === observerSessionId && !controller.signal.aborted) {
              broadcastStreamEvent({
                conversationId,
                type: 'tool-result',
                toolCallId,
                toolName,
                result: compacted.result,
                startedAt,
                finishedAt,
                observerInitiated: true,
                ...(compacted.compaction ? { compaction: compacted.compaction } : {}),
              });
            }
          } catch (error) {
            const errorResult = {
              isError: true,
              error: error instanceof Error ? error.message : String(error),
            };
            observer?.onToolExecutionResult(toolCallId, toolName, errorResult);
            const observerAugmented = withObserverAugmentation(errorResult, observer?.getToolAugmentation(toolCallId));
            const compacted = await maybeCompactToolOutput(
              toolCallId,
              toolName,
              observerAugmented,
              'direct',
            );
            const finishedAt = new Date().toISOString();

            if (activeObserverSessions.get(conversationId) === observerSessionId && !controller.signal.aborted) {
              broadcastStreamEvent({
                conversationId,
                type: 'tool-result',
                toolCallId,
                toolName,
                result: compacted.result,
                startedAt,
                finishedAt,
                observerInitiated: true,
                ...(compacted.compaction ? { compaction: compacted.compaction } : {}),
              });
            }
          } finally {
            toolCancels.delete(toolCallId);
            observer?.onToolExecutionEnd(toolCallId);
          }
        };

        // Defer execution to the next tick so observer-side parent linkage is established
        // before very fast tools emit their first result.
        let launchPromise: Promise<void> | null = null;
        launchPromise = new Promise<void>((resolve) => {
          setTimeout(() => {
            void runObserverToolExecution().finally(() => resolve());
          }, 0);
        }).finally(() => {
          if (launchPromise) pendingObserverToolExecutions.delete(launchPromise);
        });
        pendingObserverToolExecutions.add(launchPromise);

        return { ok: true, launchedToolCallId: toolCallId, details: 'Observer-launched tool started.' };
      };

      try {
        if (controller.signal.aborted) {
          broadcastStreamEvent({ conversationId, type: 'done' });
          return;
        }
        // Check if compaction is needed (only if runtime supports it)
        if (compactionSupported && config.compaction.conversation.enabled && modelEntry) {
          const chatMessages = messages as Array<{ role: string; content: unknown; id?: string }>;
          const check = shouldCompact(
            chatMessages as Parameters<typeof shouldCompact>[0],
            modelEntry.modelConfig.modelName,
            config.compaction.conversation.triggerPercent,
            modelEntry.modelConfig.maxInputTokens,
          );

          if (check.shouldCompact) {
            broadcastStreamEvent({
              conversationId,
              type: 'context-usage',
              data: {
                usedTokens: check.usedTokens,
                contextWindowTokens: check.contextWindowTokens,
                phase: 'pre-compaction',
              },
            });

            const compactionResult = await compactConversationPrefix(
              chatMessages as Parameters<typeof compactConversationPrefix>[0],
              modelEntry.modelConfig,
              config.compaction.conversation,
            );
            if (controller.signal.aborted) {
              broadcastStreamEvent({ conversationId, type: 'done' });
              return;
            }

            if (compactionResult.compactedMessages) {
              broadcastStreamEvent({
                conversationId,
                type: 'compaction',
                data: {
                  compactionId: compactionResult.compactionId,
                  summaryText: compactionResult.summaryText,
                  compactedMessageIds: compactionResult.compactedMessageIds,
                },
              });
              messages = compactionResult.compactedMessages;
            }
          }
        }

        if (modelEntry && observerSupported) {
          observer = new ToolObserverManager({
            conversationId,
            modelConfig: modelEntry.modelConfig,
            config: resolveToolObserverConfig(config),
            userRequestSummary: summarizeLatestUserRequest(messages),
            baseThreadContext: summarizeThreadContext(messages),
            emitMidToolMessage: (text) => {
              if (activeObserverSessions.get(conversationId) !== observerSessionId) return;
              if (!controller.signal.aborted) {
                broadcastStreamEvent({
                  conversationId,
                  type: 'observer-message',
                  text,
                });
              }
            },
            cancelToolCall: (toolCallId) => {
              if (activeObserverSessions.get(conversationId) !== observerSessionId) return false;
              const cancel = toolCancels.get(toolCallId);
              if (!cancel) return false;
              cancel();
              return true;
            },
            launchToolCall: launchObserverToolCall,
            messageSubAgent: (toolCallId, message) => {
              return sendSubAgentFollowUpByToolCall(toolCallId, message);
            },
          });
        }

        // Track whether we already sent a plan-related done event so we skip
        // any trailing plain done events from the generator after abort.
        let planDoneSent = false;

        const streamOptions = {
            reasoningEffort,
            abortSignal: controller.signal,
            emitEvent: (event: StreamEvent) => {
              if (event.type === 'tool-progress') {
                if (activeObserverSessions.get(conversationId) !== observerSessionId) return;
                observer?.onToolProgress({
                  toolCallId: event.toolCallId,
                  toolName: event.toolName,
                  data: event.data as {
                    stream?: 'stdout' | 'stderr';
                    output?: string;
                    delta?: string;
                    bytesSeen?: number;
                    truncated?: boolean;
                    stopped?: boolean;
                  } | undefined,
                });
              }
              // Side-channel events (tool progress) should stop immediately on abort.
              if (!controller.signal.aborted) {
                broadcastStreamEvent(event);
              }
            },
            onToolExecutionStart: async (state: { toolCallId: string; toolName: string; args: unknown; cancel: () => void }) => {
              toolCancels.set(state.toolCallId, state.cancel);
              enqueueByToolName(pendingExecIdsByToolName, state.toolName, state.toolCallId);
              pairExecuteAndStreamToolCallIds(state.toolName);
              observer?.onToolExecutionStart(state);

              // Gate exit_plan_mode behind user approval regardless of execution mode
              if (state.toolName === 'exit_plan_mode') {
                const streamId = streamToolCallIdByExecId.get(state.toolCallId) ?? state.toolCallId;
                broadcastStreamEvent({
                  conversationId,
                  type: 'tool-approval-required',
                  toolCallId: streamId,
                  toolName: state.toolName,
                  args: state.args,
                });
                observer?.onToolAwaitingApproval(state.toolCallId);
                const approved = await new Promise<boolean | 'dismiss'>((resolve) => {
                  pendingToolApprovals.set(streamId, { resolve });
                });
                if (approved !== true) {
                  state.cancel();
                  if (approved === 'dismiss') {
                    // User clicked X — exit plan mode entirely and stop the stream.
                    console.info(`[Agent:stream] exit_plan_mode dismissed by user, exiting plan mode and stopping`);
                    broadcastExecutionMode('auto');
                    planDoneSent = true;
                    broadcastStreamEvent({ conversationId, type: 'done', data: { planDismissed: true } });
                    controller.abort();
                    return;
                  }
                  // User clicked "No, keep planning" — stay in plan-first mode.
                  // Re-broadcast plan-first mode so the UI toggle stays in plan mode
                  // even if a race with the tool's execute() emitted 'auto'.
                  broadcastExecutionMode('plan-first');
                  // Abort the stream and signal the renderer to restart in plan-first
                  // mode so the agent can continue planning with the user.
                  console.info(`[Agent:stream] exit_plan_mode rejected by user, aborting to restart in plan-first mode`);
                  planDoneSent = true;
                  broadcastStreamEvent({ conversationId, type: 'done', data: { planModeRejectRestart: true } });
                  controller.abort();
                  return;
                }
              }

              // Gate ask_user behind user response — blocks until user submits answers
              if (state.toolName === 'ask_user') {
                const streamId = streamToolCallIdByExecId.get(state.toolCallId) ?? state.toolCallId;
                broadcastStreamEvent({
                  conversationId,
                  type: 'tool-approval-required',
                  toolCallId: streamId,
                  toolName: state.toolName,
                  args: state.args,
                });
                observer?.onToolAwaitingApproval(state.toolCallId);
                const approved = await new Promise<boolean | 'dismiss'>((resolve) => {
                  pendingToolApprovals.set(streamId, { resolve });
                });
                if (approved !== true) {
                  state.cancel();
                } else {
                  // Copy answers from stream-side ID to execute-side ID so the tool's execute() can find them
                  const answers = pendingQuestionAnswers.get(streamId);
                  if (answers) {
                    pendingQuestionAnswers.set(state.toolCallId, answers);
                    pendingQuestionAnswers.delete(streamId);
                  }
                }
              }
            },
            onToolExecutionEnd: ({ toolCallId }: { toolCallId: string; toolName: string }) => {
              toolCancels.delete(toolCallId);
              observer?.onToolExecutionEnd(toolCallId);
            },
            augmentToolResult: async ({ toolCallId, toolName, result }: { toolCallId: string; toolName: string; args: unknown; result: unknown }) => {
              await observer?.waitForLinkedLaunchedTools(toolCallId);
              observer?.onToolExecutionResult(toolCallId, toolName, result);
              const observerAugmented = withObserverAugmentation(result, observer?.getToolAugmentation(toolCallId));
              const compacted = await maybeCompactToolOutput(
                toolCallId,
                toolName,
                observerAugmented,
                'defer-until-stream-id',
              );
              if (compacted.compaction) {
                compactionByExecuteId.set(toolCallId, compacted.compaction);
              }
              return compacted.result;
            },
          };

        // NOTE: Workspace tool filtering is handled in createWorkspaceForAgent().
        // Custom tools are filtered here so planning cannot mutate app state and
        // implementation cannot fall back to asking more questions or re-planning.

        const stream = runtime.stream({
          conversationId,
          messages,
          config: configWithExecutionMode,
          tools: activeTools,
          appHome,
          cwd: effectiveCwd,
          reasoningEffort,
          abortSignal: controller.signal,
          streamConfig: streamConfig ?? undefined,
          primaryModel: modelEntry,
          claudeAuth: resolution.claudeAuth,
          emitEvent: streamOptions.emitEvent,
          onToolExecutionStart: streamOptions.onToolExecutionStart,
          onToolExecutionEnd: streamOptions.onToolExecutionEnd,
          augmentToolResult: streamOptions.augmentToolResult,
        });

        for await (const event of stream) {
          // After a plan-related done event has been sent and the stream aborted,
          // ignore any trailing events (especially the generator's final plain done).
          if (planDoneSent) {
            ipcDebugLog(`[LOOP-SKIP] conv=${conversationId} event.type=${event.type} reason=planDoneSent`);
            continue;
          }
          if (event.type === 'tool-call' || event.type === 'tool-result' || event.type === 'tool-compaction') {
            logToolCompactionDebug('stream-event', {
              conversationId,
              eventType: event.type,
              toolCallId: event.toolCallId ?? null,
              toolName: event.toolName ?? null,
              hasCompaction: 'compaction' in event && Boolean(event.compaction),
              compactionPhase: event.type === 'tool-compaction'
                ? ((event.data as { phase?: string } | undefined)?.phase ?? null)
                : null,
            });
          }
          if (event.type === 'tool-call' && event.toolCallId && event.toolName) {
            enqueueByToolName(pendingStreamIdsByToolName, event.toolName, event.toolCallId);
            pairExecuteAndStreamToolCallIds(event.toolName);
          }
          if (event.type === 'tool-result' && event.toolName === 'enter_plan_mode') {
            // Plan mode was entered mid-stream. Abort this stream so the renderer
            // can re-send with executionMode='plan-first' (correct system prompt + tool set).
            console.info(`[Agent:stream] enter_plan_mode detected mid-stream, aborting to restart with plan-first mode`);
            broadcastStreamEvent(event);
            planDoneSent = true;
            broadcastStreamEvent({ conversationId, type: 'done', data: { planModeRestart: true } });
            controller.abort();
            return { conversationId };
          }
          if (event.type === 'tool-result' && event.toolCallId) {
            observer?.onToolExecutionEnd(event.toolCallId);
            // Inject compaction metadata into the event's data field
            const execId = execToolCallIdByStreamId.get(event.toolCallId) ?? event.toolCallId;
            const compaction = execId ? compactionByExecuteId.get(execId) : undefined;
            if (compaction) {
              compactionByExecuteId.delete(execId!);
              // Attach as a data field the renderer will pick up
              (event as Record<string, unknown>).compaction = compaction;
              logToolCompactionDebug('attach-result-compaction', {
                conversationId,
                toolCallId: event.toolCallId,
                executeToolCallId: execId,
                toolName: event.toolName ?? null,
                extractionDurationMs: compaction.extractionDurationMs,
                originalLength: compaction.originalContent.length,
              });
            }
            if (execId) {
              streamToolCallIdByExecId.delete(execId);
            }
            execToolCallIdByStreamId.delete(event.toolCallId);
            pendingToolCompactionByExecId.delete(execId);
          }
          if (event.type === 'done' && !controller.signal.aborted) {
            observerLaunchesEnabled = false;
            await waitForObserverToolExecutions();
          }
          if (event.type === 'model-fallback') {
            const fbData = event.data as { toModelKey?: string } | undefined;
            if (fbData?.toModelKey && streamConfig) {
              const fallbackEntry = streamConfig.fallbackModels.find(
                (m) => m.key === fbData.toModelKey,
              );
              if (fallbackEntry?.modelConfig) {
                activeSourceModel = `${fallbackEntry.modelConfig.provider}:${fallbackEntry.modelConfig.modelName}`;
                activeModelDisplayName = fallbackEntry.displayName ?? null;
              }
            }
          }
          if (event.type === 'text-delta' && activeSourceModel) {
            (event as Record<string, unknown>).messageMeta = {
              ...((event as Record<string, unknown>).messageMeta as Record<string, unknown> | undefined ?? {}),
              sourceModel: activeSourceModel,
              sourceModelDisplayName: activeModelDisplayName,
              reasoningEffort: reasoningEffort ?? null,
              runtimeId: runtime.id,
            };
          }
          if (activeObserverSessions.get(conversationId) !== observerSessionId) {
            ipcDebugLog(`[LOOP-SKIP] conv=${conversationId} event.type=${event.type} reason=observerSessionMismatch current=${activeObserverSessions.get(conversationId)} expected=${observerSessionId}`);
            continue;
          }
          ipcDebugLog(`[LOOP-EMIT] conv=${conversationId} event.type=${event.type} toolCallId=${event.toolCallId ?? 'none'} toolName=${event.toolName ?? 'none'}`);
          broadcastStreamEvent(event);
        }
      } catch (error) {
        ipcDebugLog(`[LOOP-ERROR] conv=${conversationId} aborted=${controller.signal.aborted} error=${error instanceof Error ? error.message : String(error)}`);
        if (!controller.signal.aborted) {
          broadcastStreamEvent({
            conversationId,
            type: 'error',
            error: error instanceof Error ? error.message : String(error),
          });
          broadcastStreamEvent({ conversationId, type: 'done' });
        }
      } finally {
        ipcDebugLog(`[LOOP-FINALLY] conv=${conversationId} cleaning up`);
        observerLaunchesEnabled = false;
        await waitForObserverToolExecutions();
        observer?.dispose();
        activeStreams.delete(conversationId);
        activeStreamModelKeys.delete(conversationId);
        if (activeObserverSessions.get(conversationId) === observerSessionId) {
          activeObserverSessions.delete(conversationId);
        }
      }
    })();

      return { conversationId };
    },
  );

  ipcMain.handle('agent:cancel-stream', async (_event, conversationId: string) => {
    const controller = activeStreams.get(conversationId);
    if (controller) {
      controller.abort();
      activeStreams.delete(conversationId);
      activeStreamModelKeys.delete(conversationId);
    }
    activeObserverSessions.delete(conversationId);
    return { ok: true };
  });

  ipcMain.handle('agent:approve-tool', (_event, toolCallId: string) => {
    const pending = pendingToolApprovals.get(toolCallId);
    if (pending) {
      pending.resolve(true);
      pendingToolApprovals.delete(toolCallId);
    }
    return { ok: true };
  });

  ipcMain.handle('agent:reject-tool', (_event, toolCallId: string) => {
    const pending = pendingToolApprovals.get(toolCallId);
    if (pending) {
      pending.resolve(false);
      pendingToolApprovals.delete(toolCallId);
    }
    return { ok: true };
  });

  ipcMain.handle('agent:dismiss-tool', (_event, toolCallId: string) => {
    const pending = pendingToolApprovals.get(toolCallId);
    if (pending) {
      pending.resolve('dismiss');
      pendingToolApprovals.delete(toolCallId);
    }
    return { ok: true };
  });

  ipcMain.handle('agent:answer-tool-question', (_event, toolCallId: string, answers: Record<string, string>) => {
    // Store answers so the tool's execute() can read them, then approve the tool
    pendingQuestionAnswers.set(toolCallId, answers);
    const pending = pendingToolApprovals.get(toolCallId);
    if (pending) {
      pending.resolve(true);
      pendingToolApprovals.delete(toolCallId);
    }
    return { ok: true };
  });

  ipcMain.handle('agent:generate-title', async (_event, messages: unknown[], modelKey?: string, hint?: string) => {
    let config: AppConfig;
    try {
      config = readEffectiveConfig(appHome);
    } catch {
      return { title: null };
    }

    const input = buildTitleGenerationInput(messages);
    if (!input) return { title: null };

    const promptParts = [
      'Generate a concise conversation title using at most 4 words.',
      'Summarize the user\'s main topic or task, not the assistant\'s answer.',
      'Use a neutral noun phrase, not a sentence.',
      'Avoid apologies, disclaimers, or copied response text.',
      'Return only the title text with no quotes or formatting.',
    ];

    if (hint) {
      promptParts.push(`Context: ${hint}.`);
    }

    const CHAT_TITLE_PROMPT = promptParts.join(' ');

    const title = await generateTitle({
      systemPrompt: CHAT_TITLE_PROMPT,
      maxWords: 4,
      input,
      config,
      modelKey,
      inferenceProvider: pluginManager?.getInferenceProvider() ?? null,
    });

    return { title };
  });

  // Sub-agent interaction handlers
  ipcMain.handle('agent:sub-agent-message', async (_event, subAgentConversationId: string, message: string) => {
    const ok = sendSubAgentFollowUp(subAgentConversationId, message);
    return { ok, subAgentConversationId };
  });

  ipcMain.handle('agent:sub-agent-stop', async (_event, subAgentConversationId: string) => {
    const ok = stopSubAgent(subAgentConversationId);
    return { ok, subAgentConversationId };
  });

  ipcMain.handle('agent:sub-agent-list', async () => {
    return { ids: getActiveSubAgentIds() };
  });

  // Model catalog endpoint
  ipcMain.handle('agent:model-catalog', () => {
    try {
      const config = readEffectiveConfig(appHome);
      const catalog = resolveModelCatalog(config);
      return {
        models: catalog.entries.map((e) => {
          return {
            key: e.key,
            displayName: e.displayName,
            maxInputTokens: e.modelConfig.maxInputTokens,
            computerUseSupport: e.computerUseSupport,
            visionCapable: e.visionCapable,
            preferredTarget: e.preferredTarget,
          };
        }),
        defaultKey: catalog.defaultEntry?.key ?? null,
      };
    } catch {
      return { models: [], defaultKey: null };
    }
  });

  // Profile catalog endpoint
  ipcMain.handle('agent:profiles', () => {
    try {
      const config = readEffectiveConfig(appHome);
      return {
        profiles: (config.profiles ?? []).map((p) => ({
          key: p.key,
          name: p.name,
          primaryModelKey: p.primaryModelKey,
          fallbackModelKeys: p.fallbackModelKeys,
        })),
        defaultKey: config.defaultProfileKey ?? null,
      };
    } catch {
      return { profiles: [], defaultKey: null };
    }
  });

  // Runtime introspection endpoints
  ipcMain.handle('agent:get-available-runtimes', async () => {
    const { getAvailableRuntimes } = await import('../agent/runtime/index.js');
    return getAvailableRuntimes();
  });

  ipcMain.handle('agent:get-active-runtime', async () => {
    const { getActiveRuntimeId } = await import('../agent/runtime/index.js');
    try {
      const config = readEffectiveConfig(appHome);
      return getActiveRuntimeId(config);
    } catch {
      return 'mastra';
    }
  });
}
