import type { AppConfig } from '../config/schema.js';
import type { ExecutionMode } from '../config/schema.js';
import { resolveModelCatalog, resolveStreamConfig } from './model-catalog.js';
import type { ReasoningEffort, ResolvedStreamConfig } from './model-catalog.js';
import { streamAgentResponse, streamWithFallback } from './mastra-agent.js';
import type { StreamEvent } from './mastra-agent.js';
import type { ToolDefinition } from '../tools/types.js';
import { toolsForExecutionMode } from './plan-mode-tools.js';
import { rehydrateModelMedia } from './offload-display-media.js';
import { readConversation, conversationExistenceState } from '../ipc/conversation-store.js';
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
  /** Working directory for this run's workspace tools (relative-path resolution +
   *  shell cwd). When set, forwarded to the underlying stream's executionContext so
   *  a resumed/recovered turn runs in the CONVERSATION's cwd, not the home default. */
  cwd?: string;
  /** Execution mode overlaid onto config for this run (e.g. `plan-first` filters
   *  mutating workspace tools). When set, the run honors the conversation's mode
   *  instead of the global config default. */
  executionMode?: ExecutionMode;
  /** Per-thread setting overrides (temperature / systemPromptOverride / maxSteps /
   *  maxRetries / runtimeOverride) forwarded to resolveStreamConfig, so a resumed
   *  turn honors the CONVERSATION's persisted instructions + runtime rather than the
   *  global/profile defaults (R92). */
  threadOverrides?: {
    temperature?: number | null;
    systemPromptOverride?: string | null;
    maxSteps?: number | null;
    maxRetries?: number | null;
    runtimeOverride?: string | null;
  };
  /** Cooperative injects consumed at a prepareStep boundary. */
  onInjected?: (entries: Array<{ id: string; text: string; at: number }>) => void;
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
  const { appHome, systemPrompt, tools: pluginToolsRaw } = options;
  // Rehydrate offloaded display media (kai-media:// → base64 data URLs) for the
  // model boundary: this is the shared prep for the plugin/automation stream+
  // generate family (streamForPlugin / generateForPlugin), a SEPARATE path from
  // the GUI/CLI streamHandler, so it needs its own rehydration or a follow-up
  // automation turn referencing a prior attachment would forward an unresolvable
  // kai-media:// URL to the provider. Produces a NEW array (never mutates the
  // caller's branch); no-op when nothing is offloaded.
  const messages = rehydrateModelMedia(options.messages, appHome);
  // Determine the effective execution mode, then filter registered tools + overlay config.
  // Priority: an explicit conversation record (MAIN-authoritative — R129 f-2/f-3) > the
  // passed snapshot > the GLOBAL config.tools.executionMode. The global fallback matters for
  // RECORDLESS calls (background automations / plugin agent.generate|stream) that pass no
  // executionMode and no real conversation but run under a globally plan-first config — those
  // must be read-only too (R130 finding-1), not just the workspace tools.
  const globalMode = (options.config.tools as { executionMode?: ExecutionMode } | undefined)?.executionMode;
  let effectiveMode: ExecutionMode | undefined = options.executionMode ?? globalMode;
  if (options.conversationId) {
    try {
      const rec = readConversation(appHome, options.conversationId) as { executionMode?: ExecutionMode } | null;
      // A conversation record is authoritative: its mode (present, or ABSENT → auto) wins over
      // both the snapshot and the global default. TRUST DISK (R129 f-3). Recordless → keep the
      // snapshot/global fallback computed above.
      if (rec != null) {
        effectiveMode = rec.executionMode ?? 'auto';
      } else {
        // Couldn't read the record. Fail CLOSED via the tri-state probe (R136 f-2): a record
        // that EXISTS-but-unreadable or an UNKNOWN state runs plan-first (read-only); only a
        // definitively-ABSENT record keeps the snapshot/global fallback.
        const state = conversationExistenceState(appHome, options.conversationId);
        if (state !== 'absent') effectiveMode = 'plan-first';
      }
    } catch {
      /* best-effort: keep the passed / global mode */
    }
  }
  // Overlay the run's execution mode onto the config so streamAgentResponse's workspace-tool
  // filtering honors it (R90). Only overlay when we resolved a mode DIFFERENT from the global
  // (a record/snapshot) — otherwise leave config untouched (it already carries the global).
  const config: AppConfig =
    effectiveMode && effectiveMode !== globalMode
      ? { ...options.config, tools: { ...options.config.tools, executionMode: effectiveMode } }
      : options.config;
  // Config-overlay only gates the WORKSPACE tools built downstream. The explicitly-passed
  // registered tools (custom/MCP/skill/plugin) are NOT re-filtered by the config, so in
  // plan-first they'd stay available and a resume / recordless-but-globally-plan-first run
  // could execute mutations (R129 f-1, R130 f-1). Apply the SAME plan-mode filter the main
  // GUI/CLI stream path uses so any plan-first run is read-only for these tools too.
  const pluginTools = effectiveMode ? toolsForExecutionMode(pluginToolsRaw ?? [], effectiveMode) : pluginToolsRaw;

  const streamConfig = resolveStreamConfig(config, {
    threadModelKey: options.modelKey ?? null,
    threadProfileKey: options.profileKey ?? null,
    reasoningEffort: options.reasoningEffort as ReasoningEffort | undefined,
    fallbackEnabled: options.fallbackEnabled ?? false,
    ...(options.threadOverrides ? { threadOverrides: options.threadOverrides } : {}),
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
        ...(options.cwd ? { cwd: options.cwd } : {}),
        onInjected: options.onInjected,
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

  // Sub-agents spawned inside this run inherit the profile the run used —
  // including the global defaultProfileKey when no explicit profile was passed.
  const parentProfileKey =
    options.profileKey ?? (config as { defaultProfileKey?: string | null }).defaultProfileKey ?? null;
  const parentModelKey = options.modelKey ?? streamConfig.primaryModel.key;

  if (streamConfig.fallbackEnabled && streamConfig.fallbackModels.length > 0) {
    stream = streamWithFallback(conversationId, sanitized, streamConfig, configForStream, pluginTools ?? [], dbPath, {
      reasoningEffort: options.reasoningEffort as ReasoningEffort | undefined,
      abortSignal: options.abortSignal,
      isHeadless: true,
      parentProfileKey,
      parentModelKey,
      ...(options.cwd ? { cwd: options.cwd } : {}),
      onInjected: options.onInjected,
    });
  } else {
    stream = streamAgentResponse(conversationId, sanitized, modelConfig, configForStream, pluginTools ?? [], dbPath, {
      reasoningEffort: options.reasoningEffort as ReasoningEffort | undefined,
      abortSignal: options.abortSignal,
      isHeadless: true,
      parentProfileKey,
      parentModelKey,
      ...(options.cwd ? { cwd: options.cwd } : {}),
      onInjected: options.onInjected,
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
    } else if (event.type === 'model-fallback') {
      // A mid-stream fallback restarts the response on the next model. The failed
      // attempt's partial text + tool-calls have already been emitted into this
      // buffer; drop them so the collected result is the SUCCESSFUL retry only,
      // not a failed-prefix + success concatenation. (The renderer separately
      // preserves the errored attempt as its own variant.)
      text = '';
      toolCalls.length = 0;
      pendingToolCalls.clear();
      lastEventWasToolResult = false;
      error = null;
    }
  }

  if (error && !text) {
    throw new Error(error);
  }

  return { text, modelKey, toolCalls };
}
