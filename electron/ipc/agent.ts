import type { IpcMain } from 'electron';
import { BrowserWindow } from 'electron';
import { broadcastToWebClients } from '../web-server/web-clients.js';
import { resolveModelCatalog, resolveStreamConfig } from '../agent/model-catalog.js';
import { normalizeAgentCwd, getProviderDefinedToolNames } from '../agent/mastra-agent.js';
import type { StreamEvent, ReasoningEffort } from '../agent/mastra-agent.js';
import { generateTitle } from '../agent/title-generation.js';
import type { AppConfig, ExecutionMode } from '../config/schema.js';
import { readEffectiveConfig } from './config.js';
import {
  broadcastUpsert,
  ensureConversationTree,
  getConversationBranch,
  appendConversationMessages,
} from './conversations.js';
import { readConversation, writeConversation } from './conversation-store.js';
import { detectRuntimeSwitch, generateSwitchContext, wrapSwitchContext } from '../agent/runtime-switch.js';
import { stripDisplayOnlyParts } from '../agent/message-sanitizer.js';
import { accumulateForPersistence, discardPersistenceAccumulator } from '../agent/stream-persistence.js';
import {
  shouldCompact,
  compactConversationPrefix,
  compactToolResult,
  estimateToolTokens,
  isStrictPrefix,
} from '../agent/compaction.js';
import { appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';

// ---------------------------------------------------------------------------
// Debug logging for stream pipeline diagnostics
// ---------------------------------------------------------------------------
const IPC_DEBUG_ENABLED = !!process.env.KAI_DEBUG_STREAM;
const IPC_DEBUG_DIR = join(process.cwd(), 'debug-logs');
const IPC_DEBUG_LOG = join(IPC_DEBUG_DIR, 'stream-pipeline.log');
function ipcDebugLog(msg: string): void {
  if (!IPC_DEBUG_ENABLED) return;
  try {
    mkdirSync(IPC_DEBUG_DIR, { recursive: true });
    appendFileSync(IPC_DEBUG_LOG, `[${new Date().toISOString()}] ${msg}\n`);
  } catch {
    /* ignore */
  }
}
import type { ToolCompactionConfig } from '../agent/compaction.js';
import type { ToolDefinition, ToolExecutionContext } from '../tools/types.js';
import { ensureSafeToolDefinitions, findToolByName } from '../tools/naming.js';
import { resolveRuntimeForStream } from '../agent/runtime/index.js';
import { buildAgentChildEnv, resolveConfinedCwd, providerKeyEnv } from '../agent/runtime/confinement.js';
import {
  ToolObserverManager,
  resolveToolObserverConfig,
  summarizeLatestUserRequest,
  summarizeThreadContext,
  type LaunchToolCallResult,
} from '../agent/tool-observer.js';
import {
  sendSubAgentFollowUp,
  sendSubAgentFollowUpByToolCall,
  stopSubAgent,
  getActiveSubAgentIds,
} from '../tools/sub-agent.js';
import { recordUsageEvent } from './usage.js';
import type { PluginManager } from '../plugins/plugin-manager.js';
import { normalizeTokenUsage } from '../../shared/token-usage.js';
import type { HookMessage } from '../plugins/types.js';
import { hookDispatcher } from '../agent/hooks/dispatcher.js';

const activeStreams = new Map<string, { abort: () => void; token: string }>();

// Delete the active-stream entry only if it still belongs to this run. A newer
// run (e.g. from an edit/regenerate mid-stream) replaces the entry with its own
// token; the old run's cleanup must not remove the new run's controller, or
// cancel/replacement would no longer abort the live run.
function deleteStreamIfOwned(conversationId: string, token: string): void {
  if (activeStreams.get(conversationId)?.token === token) {
    activeStreams.delete(conversationId);
  }
}

/**
 * Token-guarded teardown of ALL per-run state for a stream. Only clears the
 * per-run maps when this token still owns the active stream — otherwise a slow
 * early-exit (e.g. a UserPromptSubmit hook returning denied after the user
 * cancelled and restarted the same conversation) would wipe the REPLACEMENT
 * run's model-key / observer-session state and break its gating + usage
 * attribution.
 */
function cleanupStreamIfOwned(conversationId: string, token: string): void {
  if (activeStreams.get(conversationId)?.token !== token) return;
  activeStreams.delete(conversationId);
  activeStreamModelKeys.delete(conversationId);
  activeObserverSessions.delete(conversationId);
}
const activeObserverSessions = new Map<string, string>();
const PLAN_MODE_CUSTOM_TOOLS = new Set(['ask_user', 'enter_plan_mode', 'exit_plan_mode', 'web_fetch', 'web_search']);

/** The last user message object from a flat message list, or null. */
function lastUserMessage(messages: unknown[]): { role?: unknown; content?: unknown } | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: unknown; content?: unknown } | null;
    if (m && typeof m === 'object' && m.role === 'user') return m;
  }
  return null;
}

/** Structural JSON of a value for change detection (undefined → ''). */
function jsonStableString(value: unknown): string {
  if (value === undefined) return '';
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return String(value);
  }
}

/**
 * Persist a UserPromptSubmit redaction/denial back to the stored conversation.
 * The renderer appended + persisted the ORIGINAL user turn before agent:stream
 * ran, so a DLP change that only altered the model-facing `messages` (or a deny
 * that never reached the model) would otherwise leave the raw prompt visible/
 * exportable in local history. Replace the last user turn's content WHOLESALE
 * with `sanitizedContent` (covering removed attachments/non-text parts, not just
 * text) and flag it so conversations:put preserves it against a stale raw
 * same-id rewrite from the stream-done handler.
 */
function persistRedactedUserTurn(appHome: string, conversationId: string, sanitizedContent: unknown): void {
  try {
    const conv = readConversation(appHome, conversationId);
    if (!conv) return;
    const { tree, headId } = ensureConversationTree(conv);
    const branch = getConversationBranch(tree, headId);
    let target: (typeof branch)[number] | undefined;
    for (let i = branch.length - 1; i >= 0; i--) {
      if (branch[i].role === 'user') {
        target = branch[i];
        break;
      }
    }
    if (!target) return;
    const node = tree.find((m) => m.id === target!.id);
    if (!node) return;
    // Replace the whole content with the sanitized payload so removed non-text
    // parts (attachments/files) are dropped too. Normalize a string to a text
    // part for consistency with the renderer's content-part shape.
    node.content = (
      typeof sanitizedContent === 'string' ? [{ type: 'text', text: sanitizedContent }] : sanitizedContent
    ) as never;
    (node as unknown as { redactedByHook?: boolean }).redactedByHook = true;
    conv.messageTree = tree as never;
    // Recompute the flat `messages` mirror of the active branch so exports/list
    // reflect the redaction immediately.
    conv.messages = getConversationBranch(tree, headId) as never;
    writeConversation(appHome, conv);
    broadcastUpsert(appHome, conv);
    // The renderer ignores conversations:changed while a stream accumulator is
    // active (and then renders/persists its raw in-memory copy), so also emit a
    // stream event carrying the sanitized content + target node id so the live
    // chat updates immediately.
    broadcastStreamEvent({
      conversationId,
      type: 'prompt-redacted',
      data: { messageId: node.id, content: node.content },
    });
  } catch (err) {
    console.warn('[Agent] Failed to persist redacted user turn:', err);
  }
}

// Pending tool approval promises — shared with the Claude Agent SDK MCP bridge
import {
  pendingToolApprovals,
  setServerPersistTagger,
  registerPendingApproval,
  broadcastStreamEventRaw,
} from './tool-approval.js';

// Pending user answers for ask_user tool — populated by IPC handler before approval resolves
import { pendingQuestionAnswers, stashQuestionAnswers } from '../tools/ask-user.js';

// Track the model key used for each active stream so we can attribute token usage
const activeStreamModelKeys = new Map<string, string>();

// Conversations whose current turn was started by a client that does NOT persist
// the assistant reply itself (the `kai` CLI via agent:submit). For these, the
// main process accumulates the stream and writes the assistant turn on `done`.
// The GUI renderer still owns persistence for turns it starts via agent:stream,
// Conversations whose current turn was started by a client that does NOT persist
// the assistant reply itself (the `kai` CLI via agent:submit). For these, the
// main process accumulates the stream and writes the assistant turn on `done`.
// The GUI renderer still owns persistence for turns it starts via agent:stream,
// so we don't double-write. `serverPersistAppHome` is captured at handler
// registration so the free `broadcastStreamEvent` can reach the store path.
//
// Ownership is STREAM-TOKEN-scoped, not just conversation-scoped: a superseded
// CLI run's late `done` (or a mix of CLI + GUI turns on one conversation) must
// not mis-tag or clear the replacement run. `pendingServerPersist` is set by
// agent:submit; streamHandler promotes it to `serverPersistTokens[convId] =
// thisRunToken` once it mints the token. broadcastStreamEvent only acts when
// the conversation's CURRENT active stream token matches the persist owner.
const pendingServerPersist = new Set<string>();
const serverPersistTokens = new Map<string, string>();
// A submit that is still awaiting toolsReady (before any activeStreams entry
// exists) is otherwise uncancellable. Each submit mints a unique id and records
// it as the conversation's current pending submit; agent:cancel-stream marks it
// cancelled so the submit bails after the await instead of starting a run for a
// client that already detached.
let submitIdSeq = 0;
const currentPendingSubmit = new Map<string, number>();
const cancelledSubmits = new Set<number>();
// The conversation head captured at submit time (the just-appended user turn),
// keyed by conversationId. streamHandler binds it to the run's token so the
// assistant reply is persisted as a child of the turn it actually answered —
// NOT whatever head is current at `done` (a mid-run /rewind, edit, or variant
// switch moves the head and would otherwise mis-parent the reply).
const pendingServerPersistParent = new Map<string, string | null>();
const serverPersistParents = new Map<string, string | null>();
let serverPersistAppHome: string | null = null;

/** True if the given conversation's active stream is the server-persist owner. */
function isServerPersistOwner(conversationId: string, activeToken: string | undefined): boolean {
  const owner = serverPersistTokens.get(conversationId);
  return owner !== undefined && owner === activeToken;
}

/**
 * @param emittingToken  The stream token of the run that produced this event.
 *   Persistence/accumulation is only applied when it matches BOTH the persist
 *   owner AND the conversation's current active stream — so a superseded run's
 *   late in-flight events can't pollute the replacement run's accumulator or
 *   clear its ownership on a stale `done`. Omitted for external producers
 *   (automation / redaction), which are never server-persist owners.
 */
function broadcastStreamEvent(event: StreamEvent, emittingToken?: string): void {
  let eventToBroadcast = event;
  // Debug: log every event broadcast
  const eventSummary =
    event.type === 'text-delta'
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
    const data = normalizeTokenUsage(event.data);
    if (data) {
      eventToBroadcast = { ...event, data };
      recordUsageEvent({
        modality: 'llm',
        conversationId: event.conversationId,
        modelKey: activeStreamModelKeys.get(event.conversationId) ?? undefined,
        inputTokens: data.inputTokens,
        outputTokens: data.outputTokens,
        cacheReadTokens: data.cacheReadTokens,
        cacheWriteTokens: data.cacheWriteTokens,
        totalTokens: data.totalTokens,
      });
    }
  }

  // Server-side persistence for client-driven turns (CLI). Accumulate the
  // stream and write the assistant reply on `done` so it survives without a
  // renderer. Only when THIS conversation's active stream is the server-persist
  // owner (token match) — GUI turns (agent:stream) are persisted by the
  // renderer, and a superseded CLI run's stale events are ignored. Tag the
  // broadcast `serverPersisted` so a GUI viewing the SAME conversation renders
  // live but skips its own persistence (main owns the write here).
  if (event.conversationId) {
    const activeToken = activeStreams.get(event.conversationId)?.token;
    // Only the run that currently owns the active stream may drive persistence,
    // and only when the event actually came from THAT run. Every in-run CLI
    // broadcast is stamped with its streamToken via emit(); external/automation
    // producers (broadcastAgentStreamEvent) and the raw approval path pass no
    // token. Requiring an exact token match means a superseded run's late event
    // (stale token) OR an untagged external broadcast can neither pollute the
    // accumulator nor clear ownership on a stray `done`. (The raw approval path
    // still tags serverPersisted for live rendering via tool-approval.ts; that's
    // separate from the persistence side effects gated here.)
    const fromCurrentRun = emittingToken !== undefined && emittingToken === activeToken;
    if (fromCurrentRun && isServerPersistOwner(event.conversationId, activeToken)) {
      eventToBroadcast = { ...eventToBroadcast, serverPersisted: true };
      if (serverPersistAppHome) {
        // Parent the persisted assistant turn on the head captured at submit
        // (the user node it answers), so a mid-run branch change can't reparent it.
        const parentId = serverPersistParents.get(event.conversationId);
        accumulateForPersistence(serverPersistAppHome, event, parentId ?? undefined);
        if (event.type === 'done') {
          serverPersistTokens.delete(event.conversationId);
          serverPersistParents.delete(event.conversationId);
          void maybeAutoTitle(serverPersistAppHome, event.conversationId);
        }
      }
    }
  }

  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('agent:stream-event', eventToBroadcast);
  }
  broadcastToWebClients('agent:stream-event', eventToBroadcast);
}

/**
 * Run the title-generation messages through the UserPromptSubmit DLP gate
 * (shared by agent:generate-title and the CLI auto-title path). Title
 * generation sends the user's prompt to a model, so it must pass the same
 * enforcement gate as a normal turn. Returns the (possibly hook-modified)
 * messages, or `suppressed: true` when a hook denies — callers must then NOT
 * fall back to a raw-message title. Fails closed (suppressed) on hook error.
 */
async function gateTitleGenerationMessages(
  messages: unknown[],
  config: AppConfig,
  conversationId: string,
  modelKey?: string,
): Promise<{ suppressed: boolean; messages: unknown[] }> {
  if (!hookDispatcher.hasEnforcingHooksFor('UserPromptSubmit')) {
    return { suppressed: false, messages };
  }
  try {
    const dispatch = await hookDispatcher.dispatch(
      'UserPromptSubmit',
      {
        conversationId,
        messages,
        systemPrompt: '',
        modelKey: modelKey ?? config.models.defaultModelKey,
        purpose: 'title-generation',
      },
      { suppressObserve: true },
    );
    if (dispatch.denied) return { suppressed: true, messages };
    const next = dispatch.payload as { messages?: unknown[] };
    return { suppressed: false, messages: Array.isArray(next?.messages) ? next.messages : messages };
  } catch {
    return { suppressed: true, messages };
  }
}

/**
 * Auto-title a client-driven (CLI) conversation after its first completed turn,
 * mirroring what the GUI does client-side. No-op if the chat already has a
 * title or has no user turn yet. Best-effort: title failures are swallowed.
 * Uses the per-conversation store (readConversation/writeConversation).
 */
async function maybeAutoTitle(appHome: string, conversationId: string): Promise<void> {
  try {
    const conv = readConversation(appHome, conversationId);
    if (!conv || conv.title) return;

    const { tree, headId } = ensureConversationTree(conv);
    const branch = getConversationBranch(tree, headId);
    if (!branch.some((m) => m.role === 'user')) return;

    const config = readEffectiveConfig(appHome);
    // Same DLP gate as agent:generate-title — a title-specific deny/modify hook
    // must apply to CLI-created conversations too. Suppressed ⇒ no title.
    const gated = await gateTitleGenerationMessages(branch, config, conversationId);
    if (gated.suppressed) return;

    const input = buildTitleGenerationInput(gated.messages);
    if (!input) return;

    const title = await generateTitle({
      systemPrompt:
        "Generate a concise conversation title using at most 4 words. Summarize the user's main topic or task, not the assistant's answer. Use a neutral noun phrase, not a sentence. Return only the title text with no quotes or formatting.",
      maxWords: 4,
      input,
      config,
    });
    if (!title) return;

    // Re-read so we don't clobber a concurrent write, then persist the title.
    const latest = readConversation(appHome, conversationId);
    if (!latest || latest.title) return;
    latest.title = title;
    latest.titleStatus = 'ready';
    latest.titleUpdatedAt = new Date().toISOString();
    writeConversation(appHome, latest);
    broadcastUpsert(appHome, latest);
  } catch {
    // Best-effort — never let titling break the turn.
  }
}

/**
 * Public entry point for non-interactive producers (currently automation runs)
 * to emit on the same `agent:stream-event` channel the renderer listens on, so
 * their output renders live in the target conversation. Callers should tag the
 * event with `automation: true` so the renderer defers persistence to the main
 * process (which owns the automation conversation's on-disk write).
 */
export function broadcastAgentStreamEvent(event: StreamEvent): void {
  broadcastStreamEvent(event);
}

function mergeAbortSignals(primary?: AbortSignal, secondary?: AbortSignal): AbortSignal | undefined {
  if (!primary && !secondary) return undefined;
  if (!primary) return secondary;
  if (!secondary) return primary;
  // AbortSignal.any (Node 22) composes without installing ordinary 'abort'
  // listeners: it uses weak refs + a finalization registry, so the derived
  // signal is reclaimed once the consumer releases it — no listener retained on
  // a long-lived source. The previous manual addEventListener({once:true})
  // approach leaked one listener per merge on the (turn-scoped, reused across
  // every tool call in a turn) `primary` signal, cleared only if it aborted.
  // Mirrors the mastra-agent.ts mergeAbortSignals fix (78639c2); also propagates
  // the winning signal's abort reason.
  return AbortSignal.any([primary, secondary]);
}

function toolsForExecutionMode(tools: ToolDefinition[], executionMode: ExecutionMode): ToolDefinition[] {
  if (executionMode === 'plan-first') {
    return tools.filter((tool) => PLAN_MODE_CUSTOM_TOOLS.has(tool.name));
  }

  return tools;
}

/**
 * Resolve {placeholder} templates in extraHeaders with runtime values.
 * Templates use the format `{key}` where key is one of the supported
 * runtime variables (conversationId, cwd, modelKey, modelName).
 * Returns the original object if no templates are found (avoids allocation).
 */
function resolveHeaderTemplates(headers: Record<string, string>, vars: Record<string, string>): Record<string, string> {
  let changed = false;
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value.includes('{')) {
      const resolved = value.replace(/\{(\w+)\}/g, (_, name) => vars[name] ?? '');
      result[key] = resolved;
      if (resolved !== value) changed = true;
    } else {
      result[key] = value;
    }
  }
  return changed ? result : headers;
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
  const existingObserver =
    base.observer && typeof base.observer === 'object' ? (base.observer as Record<string, unknown>) : undefined;

  if (!observerPayload) return { ...base, ...augmentation };
  return {
    ...base,
    observer: existingObserver ? { ...existingObserver, ...observerPayload } : observerPayload,
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

function messagesContainImages(messages: unknown[]): boolean {
  return messages.some((message) => {
    if (!message || typeof message !== 'object') return false;
    const typedMessage = message as { role?: string; content?: unknown };
    if (typedMessage.role !== 'user' || !Array.isArray(typedMessage.content)) return false;
    return typedMessage.content.some(
      (part: unknown) => part && typeof part === 'object' && (part as { type?: string }).type === 'image',
    );
  });
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

// Resolves once the initial tool registry (built-in + MCP + skills + plugins +
// CLI tools) has been registered. The local CLI bridge starts serving EARLY
// (before this, for fast connect), so a CLI turn arriving in that window would
// otherwise run with an empty tool set. agent:submit awaits this.
let resolveToolsReady: () => void;
const toolsReady: Promise<void> = new Promise((r) => {
  resolveToolsReady = r;
});
let toolsRegistered = false;

export function registerTools(tools: ToolDefinition[]): void {
  registeredTools = ensureSafeToolDefinitions(tools);
  if (!toolsRegistered) {
    toolsRegistered = true;
    resolveToolsReady();
  }
}

export function getRegisteredTools(): ToolDefinition[] {
  return registeredTools;
}

// Mastra workspace tools (file/shell) adapted as ToolDefinitions. These live
// outside the main registry because the agent path builds its own workspace
// per run; this cache exists so automation `tool` actions can reach them.
let workspaceToolDefinitions: ToolDefinition[] = [];

export function setWorkspaceToolDefinitions(tools: ToolDefinition[]): void {
  workspaceToolDefinitions = tools;
}

export function getWorkspaceToolDefinitions(): ToolDefinition[] {
  return workspaceToolDefinitions;
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
  hookDispatcher.configure({ getConfig: () => readEffectiveConfig(appHome) });
  serverPersistAppHome = appHome;

  // Let the low-level raw broadcaster (used by the Claude SDK approval path)
  // tag events for CLI/headless-owned turns so a watching GUI renders live but
  // defers persistence to the main process, avoiding a duplicate/forked branch.
  setServerPersistTagger((event) => {
    if (!event.conversationId) return event;
    const activeToken = activeStreams.get(event.conversationId)?.token;
    return isServerPersistOwner(event.conversationId, activeToken) ? { ...event, serverPersisted: true } : event;
  });

  const streamHandler = async (
    _event: unknown,
    conversationId: string,
    messages: unknown[],
    modelKey?: string,
    reasoningEffort?: ReasoningEffort,
    profileKey?: string,
    fallbackEnabled?: boolean,
    cwd?: string,
    executionMode?: ExecutionMode,
    threadOverrides?: {
      temperature?: number | null;
      systemPromptOverride?: string | null;
      maxSteps?: number | null;
      maxRetries?: number | null;
      runtimeOverride?: string | null;
    },
  ) => {
    messages = stripDisplayOnlyParts(messages);
    const effectiveCwd = normalizeAgentCwd(cwd);
    const effectiveExecutionMode: ExecutionMode = executionMode ?? 'auto';

    // Cancel any existing stream for this conversation
    const existing = activeStreams.get(conversationId);
    if (existing) existing.abort();
    // Discard any half-accumulated server-persist buffer from a superseded run
    // so its partial output can't merge into this fresh turn's assistant message.
    discardPersistenceAccumulator(conversationId);

    const controller = new AbortController();
    const streamToken = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    activeStreams.set(conversationId, { abort: () => controller.abort(), token: streamToken });
    // If agent:submit flagged this turn for server-side persistence, bind that
    // ownership to THIS run's token (so a later superseding run doesn't inherit
    // or clobber it). Consume the one-shot pending marker.
    if (pendingServerPersist.delete(conversationId)) {
      serverPersistTokens.set(conversationId, streamToken);
      // Bind the submit-time parent head to this run (consume the one-shot).
      serverPersistParents.set(conversationId, pendingServerPersistParent.get(conversationId) ?? null);
      pendingServerPersistParent.delete(conversationId);
    } else {
      // A GUI (agent:stream) turn superseding a CLI turn: the new run is NOT
      // server-persisted, so drop any stale ownership for this conversation.
      serverPersistTokens.delete(conversationId);
      serverPersistParents.delete(conversationId);
      pendingServerPersistParent.delete(conversationId);
    }
    const randomBytes = new Uint8Array(4);
    crypto.getRandomValues(randomBytes);
    const observerSessionId = `${Date.now()}-${Array.from(randomBytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
    activeObserverSessions.set(conversationId, observerSessionId);

    // All broadcasts from THIS run carry its stream token so broadcastStreamEvent
    // can reject persistence-side effects from a superseded run's late events.
    const emit = (e: StreamEvent): void => broadcastStreamEvent(e, streamToken);

    let config: AppConfig;
    try {
      config = readEffectiveConfig(appHome);
    } catch (error) {
      emit({
        conversationId,
        type: 'error',
        error: 'Failed to load config: ' + (error instanceof Error ? error.message : String(error)),
      });
      emit({ conversationId, type: 'done' });
      // Clean up the activeStreams entry set above — otherwise this conversation
      // stays "busy" forever and later agent:submit calls return conversation-busy.
      cleanupStreamIfOwned(conversationId, streamToken);
      pendingServerPersist.delete(conversationId);
      pendingServerPersistParent.delete(conversationId);
      serverPersistTokens.delete(conversationId);
      serverPersistParents.delete(conversationId);
      activeObserverSessions.delete(conversationId);
      void hookDispatcher.dispatch('AgentStop', { conversationId, aborted: false });
      return { conversationId };
    }

    let streamConfig = resolveStreamConfig(config, {
      threadModelKey: modelKey ?? null,
      threadProfileKey: profileKey ?? null,
      reasoningEffort,
      fallbackEnabled: fallbackEnabled ?? false,
      threadOverrides: threadOverrides ?? undefined,
    });
    let modelEntry = streamConfig?.primaryModel ?? null;
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
        // Only surface terminal events if this run still owns the stream — a
        // slow pre-send hook may resolve after the user cancelled/restarted,
        // and finalizing here would corrupt the replacement run.
        if (activeStreams.get(conversationId)?.token === streamToken) {
          emit({
            conversationId,
            type: 'error',
            error: hookResult.abortReason ?? 'A plugin blocked this message before it was sent.',
          });
          emit({ conversationId, type: 'done' });
          void hookDispatcher.dispatch('AgentStop', { conversationId, aborted: false });
        }
        cleanupStreamIfOwned(conversationId, streamToken);
        return { conversationId };
      }

      messages = stripDisplayOnlyParts(hookResult.messages);
      if (typeof hookResult.systemPrompt === 'string') {
        effectiveSystemPrompt = hookResult.systemPrompt;
        if (streamConfig) {
          streamConfig = { ...streamConfig, systemPrompt: effectiveSystemPrompt };
        }
      }
    }

    // ── Lifecycle hook: UserPromptSubmit ────────────────────────────────
    // Runs AFTER plugin pre-send hooks so a block/modify DLP hook sees (and is
    // authoritative over) the FINAL payload actually sent to the model — a
    // plugin's messages:hook can't slip past enforcement by mutating after us.
    // `modify` hooks may rewrite `messages`/`systemPrompt`; `block` aborts.
    {
      const promptDispatch = await hookDispatcher.dispatch('UserPromptSubmit', {
        conversationId,
        messages,
        systemPrompt: effectiveSystemPrompt,
        modelKey: modelEntry?.key ?? modelKey ?? config.models.defaultModelKey,
      });
      if (promptDispatch.denied) {
        // Guard against a stale denial after cancel/restart (see plugin branch).
        if (activeStreams.get(conversationId)?.token === streamToken) {
          // The renderer already persisted the raw user turn — a deny stops the
          // model call but must ALSO scrub the sensitive prompt from local
          // history/exports. Replace it with a policy placeholder.
          persistRedactedUserTurn(appHome, conversationId, '[blocked by a policy hook]');
          emit({
            conversationId,
            type: 'error',
            error: promptDispatch.reason ?? 'A hook blocked this message before it was sent.',
          });
          emit({ conversationId, type: 'done' });
          void hookDispatcher.dispatch('AgentStop', { conversationId, aborted: false });
        }
        cleanupStreamIfOwned(conversationId, streamToken);
        return { conversationId };
      }
      const next = promptDispatch.payload as {
        messages?: unknown[];
        systemPrompt?: string;
      };
      if (Array.isArray(next?.messages)) {
        // A modify hook may rewrite/remove the last user turn's content. The
        // renderer already persisted the ORIGINAL turn before agent:stream ran,
        // so persist the FULL sanitized content (not just text — this also drops
        // removed attachments/non-text parts) back to the store when it changed.
        // Compare the whole content STRUCTURALLY, not just extracted text, so a
        // hook that strips an attachment while leaving the text intact still
        // triggers persistence. Track the user-message COUNT too: if the hook
        // removed the just-submitted turn, the "last user message" would shift
        // to an EARLIER turn — writing that earlier content into the stored
        // latest turn would be wrong; use the placeholder instead.
        const countUsers = (ms: unknown[]): number =>
          ms.filter((m) => m && typeof m === 'object' && (m as { role?: unknown }).role === 'user').length;
        const beforeMsg = lastUserMessage(messages);
        const beforeContent = jsonStableString(beforeMsg?.content);
        const beforeUsers = countUsers(messages);
        messages = stripDisplayOnlyParts(next.messages);
        const afterMsg = lastUserMessage(messages);
        const afterContent = jsonStableString(afterMsg?.content);
        const afterUsers = countUsers(messages);
        const submittedTurnRemoved = afterUsers < beforeUsers || !afterMsg;
        if (beforeMsg && (submittedTurnRemoved || afterContent !== beforeContent)) {
          persistRedactedUserTurn(
            appHome,
            conversationId,
            submittedTurnRemoved ? '[removed by a policy hook]' : afterMsg!.content,
          );
        }
      }
      if (typeof next?.systemPrompt === 'string') {
        effectiveSystemPrompt = next.systemPrompt;
        if (streamConfig) streamConfig = { ...streamConfig, systemPrompt: effectiveSystemPrompt };
      }
    }

    // The pre-send hooks above (plugin + UserPromptSubmit) are awaited and can
    // be slow. If the user cancelled or restarted this conversation while they
    // were pending, a newer run now owns the stream. Bail out silently (no
    // terminal broadcast) so this stale run can't continue into the normal
    // path and later emit a `done` that finalizes/truncates the replacement.
    if (controller.signal.aborted || activeStreams.get(conversationId)?.token !== streamToken) {
      cleanupStreamIfOwned(conversationId, streamToken);
      return { conversationId };
    }

    // Resolve runtime using model-aware logic:
    //   - auto mode: picks the best runtime for the model's provider type
    //   - explicit mode: validates compatibility, returns a warning on mismatch
    // Thread-level runtimeOverride takes precedence over global config.
    const runtimeConfig = threadOverrides?.runtimeOverride
      ? ({ ...config, agent: { ...config.agent, runtime: threadOverrides.runtimeOverride } } as AppConfig)
      : config;
    const { runtime, resolution } = await resolveRuntimeForStream(runtimeConfig, modelEntry);
    ipcDebugLog(
      `[RUNTIME] conv=${conversationId} runtime=${runtime.id} name=${runtime.name} runtimeId=${resolution.runtimeId} modelAuth=${resolution.modelAuth ? `model=${resolution.modelAuth.modelName} baseUrl=${resolution.modelAuth.baseUrl}` : 'none'} capabilities=${JSON.stringify(runtime.capabilities)}`,
    );

    // If the user has an explicitly-set runtime that is incompatible with the
    // selected model, surface the warning in the chat and bail early.
    if (resolution.warning) {
      const warningMeta = resolution.inferenceProviderRuntimeId
        ? { runtimeId: resolution.inferenceProviderRuntimeId }
        : undefined;
      emit({
        conversationId,
        type: 'text-delta',
        text: `⚠️ ${resolution.warning}`,
        ...(warningMeta ? { messageMeta: warningMeta } : {}),
      });
      emit({
        conversationId,
        type: 'done',
        ...(warningMeta ? { messageMeta: warningMeta } : {}),
      });
      void hookDispatcher.dispatch('AgentStop', { conversationId, aborted: false });
      cleanupStreamIfOwned(conversationId, streamToken);
      return { conversationId };
    }

    // Non-blocking fallback notice: the preferred runtime is unavailable but we
    // can still route through the standard pipeline. Show a visible notice.
    if (resolution.fallbackNotice) {
      emit({ conversationId, type: 'text-delta', text: `> ⚠️ ${resolution.fallbackNotice}\n\n` });
    }

    // Lifecycle tool hooks are only enforced by the Mastra runtime. If the
    // user has block/modify PreToolUse/PostToolUse hooks configured but is
    // running under an SDK runtime that executes tools directly, warn that
    // those hooks will NOT be applied — a silently-bypassed DLP/deny policy
    // is worse than none.
    if (runtime.id !== 'mastra' && hookDispatcher.hasEnforcingToolHooks()) {
      emit({
        conversationId,
        type: 'text-delta',
        text:
          `> ⚠️ Block/modify tool hooks are configured but the **${runtime.name}** runtime does not enforce them; ` +
          `tool calls in this chat will run without PreToolUse/PostToolUse hooks. Switch to the Mastra runtime to enforce them.\n\n`,
      });
    }

    // Provider-native tools (e.g. OpenAI/Anthropic server-side web_search)
    // execute inside the provider and never hit our tool wrappers, so
    // PreToolUse/PostToolUse hooks can't see or block their args. Warn when
    // enforcing hooks are active alongside configured provider tools — across
    // the PRIMARY and every enabled FALLBACK model, since fallback can switch
    // to a provider-tool model mid-stream where the hooks would be bypassed.
    const chainForProviderTools = [modelEntry, ...(fallbackEnabled ? (streamConfig?.fallbackModels ?? []) : [])];
    const hasProviderTools = chainForProviderTools.some((m) => (m?.modelConfig.providerTools?.length ?? 0) > 0);
    if (runtime.id === 'mastra' && hasProviderTools && hookDispatcher.hasEnforcingToolHooks()) {
      emit({
        conversationId,
        type: 'text-delta',
        text:
          `> ⚠️ This model (or an enabled fallback model) has provider-native tools enabled (e.g. server-side web search). ` +
          `Those run inside the provider and are NOT covered by your block/modify PreToolUse/PostToolUse hooks. ` +
          `Disable provider tools for these models if hook enforcement is required.\n\n`,
      });
    }

    // Provider override: a plugin runtime was selected for a non-plugin model.
    // Override the model's provider config to route through the plugin's endpoint.
    if (resolution.providerOverride && modelEntry) {
      const overrideProviderConfig = config.models.providers[resolution.providerOverride];
      if (overrideProviderConfig) {
        const overriddenModelConfig = {
          ...modelEntry.modelConfig,
          provider: overrideProviderConfig.type as typeof modelEntry.modelConfig.provider,
          endpoint: overrideProviderConfig.endpoint ?? modelEntry.modelConfig.endpoint,
          apiKey: overrideProviderConfig.apiKey ?? modelEntry.modelConfig.apiKey,
          useResponsesApi: overrideProviderConfig.useResponsesApi ?? false,
        };
        modelEntry = { ...modelEntry, modelConfig: overriddenModelConfig };
        // Also update streamConfig if it references the primary model
        if (streamConfig) {
          streamConfig = {
            ...streamConfig,
            primaryModel: modelEntry,
          };
        }
        console.info(
          `[Agent:stream] Provider override: routing ${modelEntry.key} through ${resolution.providerOverride} (${overrideProviderConfig.endpoint})`,
        );
      }
    }

    // ── Dynamic header template resolution ────────────────────────────────
    // Provider extraHeaders may contain {placeholder} templates that are
    // substituted with runtime values per-stream. This enables plugins to
    // declare headers like {"X-My-Conv-Id": "{conversationId}"} in their
    // static provider config and have them resolved at request time.
    if (modelEntry?.modelConfig?.extraHeaders) {
      const templateVars: Record<string, string> = {
        conversationId: conversationId ?? '',
        cwd: effectiveCwd ?? '',
        modelKey: modelEntry.key ?? '',
        modelName: modelEntry.modelConfig.modelName ?? '',
      };
      const resolved = resolveHeaderTemplates(modelEntry.modelConfig.extraHeaders, templateVars);
      if (resolved !== modelEntry.modelConfig.extraHeaders) {
        modelEntry = { ...modelEntry, modelConfig: { ...modelEntry.modelConfig, extraHeaders: resolved } };
        if (streamConfig) {
          streamConfig = { ...streamConfig, primaryModel: modelEntry };
        }
      }
    }

    const observerSupported = runtime.capabilities.toolObserver;
    const compactionSupported = runtime.capabilities.compaction;

    const messageList = messages as Array<{ role?: string; content?: unknown }>;
    console.info(
      `[Agent:stream] conv=${conversationId} model=${modelKey ?? config.models.defaultModelKey} profile=${profileKey ?? 'none'} fallback=${fallbackEnabled ? 'on' : 'off'} fallbackModels=${streamConfig?.fallbackModels.length ?? 0} messageCount=${messageList.length} cwd=${effectiveCwd} executionMode=${effectiveExecutionMode}`,
    );

    // Track the model key for usage attribution
    activeStreamModelKeys.set(
      conversationId,
      modelEntry?.modelConfig?.modelName ?? modelKey ?? config.models.defaultModelKey,
    );
    for (const [index, message] of messageList.entries()) {
      const contentPreview =
        typeof message.content === 'string'
          ? message.content.slice(0, 200)
          : Array.isArray(message.content)
            ? JSON.stringify(message.content).slice(0, 200)
            : String(message.content ?? '').slice(0, 200);
      console.info(
        `[Agent:stream]   msg[${index}] role=${message.role ?? '?'} contentLen=${JSON.stringify(message.content ?? '').length} preview=${contentPreview}`,
      );
    }

    // Run streaming in background
    (async () => {
      // Check for plugin inference provider — only use it when the resolved
      // runtime or model belongs to the plugin that registered the provider.
      // This prevents a plugin provider from hijacking requests meant for
      // other configured providers (e.g. llm-gateway, OpenAI direct).
      const effectiveModelKey = modelEntry?.key ?? modelKey ?? config.models.defaultModelKey;
      const rawCatalogEntry = config.models.catalog.find((m) => m.key === effectiveModelKey);
      const modelProviderKey = rawCatalogEntry?.provider ?? undefined;
      const isBuiltInRuntime = (id: string): boolean =>
        id === 'mastra' || id === 'claude-agent-sdk' || id === 'codex-sdk' || id === 'auto';
      const pluginRuntimeId =
        resolution.inferenceProviderRuntimeId ??
        (!isBuiltInRuntime(resolution.runtimeId) ? resolution.runtimeId : undefined);
      const inferenceProvider =
        pluginManager?.getInferenceProvider({
          runtimeId: pluginRuntimeId ?? resolution.runtimeId,
          modelProviderKey,
        }) ?? null;
      if (!inferenceProvider && pluginRuntimeId) {
        const meta = { runtimeId: pluginRuntimeId };
        emit({
          conversationId,
          type: 'error',
          error: `Runtime "${pluginRuntimeId}" is selected, but no inference provider is available. Start or re-enable the plugin before sending messages.`,
          messageMeta: meta,
        });
        emit({ conversationId, type: 'done', messageMeta: meta });
        void hookDispatcher.dispatch('AgentStop', { conversationId, aborted: false });
        cleanupStreamIfOwned(conversationId, streamToken);
        return;
      }
      if (inferenceProvider) {
        console.info(
          `[Agent:stream] Using plugin inference provider: ${inferenceProvider.name} for conv=${conversationId}`,
        );
        // A plugin inference provider executes host tools inside the plugin,
        // outside our onToolExecutionStart/augmentToolResult wrappers, so
        // block/modify hooks can't be enforced there. Warn (same posture as
        // non-Mastra runtimes) since the runtime.id check below won't fire.
        if (hookDispatcher.hasEnforcingToolHooks()) {
          emit({
            conversationId,
            type: 'text-delta',
            text:
              `> ⚠️ Block/modify tool hooks are configured but the **${inferenceProvider.name}** inference provider ` +
              `executes tools outside hook enforcement; tool calls in this chat will not run PreToolUse/PostToolUse hooks.\n\n`,
          });
        }
        let emittedTextDelta = false;
        try {
          const providerModelKey =
            rawCatalogEntry?.provider === rawCatalogEntry?.key
              ? undefined
              : (modelEntry?.key ?? modelKey ?? config.models.defaultModelKey);
          const providerStream = inferenceProvider.stream({
            conversationId,
            messages: messages as Array<{ role: string; content: unknown }>,
            ...(providerModelKey ? { modelKey: providerModelKey } : {}),
            systemPrompt: effectiveSystemPrompt,
            reasoningEffort,
            abortSignal: controller.signal,
            // Forward host-registered tools, filtered by execution mode (plan-first
            // strips mutating tools). Mirrors the standard runtime path at the
            // `runtime.stream(...)` call below. Without this, the LLM behind a
            // plugin inference provider has no awareness of any tools.
            tools: toolsForExecutionMode(registeredTools, effectiveExecutionMode),
          });

          let providerResponseText = '';
          for await (const event of providerStream) {
            if (controller.signal.aborted && event.type !== 'done') continue;
            if (event.type === 'text-delta') {
              emittedTextDelta = true;
              providerResponseText += event.text ?? '';
            }

            // Stamp runtimeId on every event so the UI popover shows the
            // inference provider name regardless of whether the stream ends
            // with a normal done, an error, or an early abort.
            const eventWithMeta = (() => {
              const ev = event as Record<string, unknown>;
              const existingMeta = (ev.messageMeta as Record<string, unknown> | undefined) ?? {};
              return {
                ...event,
                conversationId,
                messageMeta: { ...existingMeta, runtimeId: inferenceProvider.name },
              };
            })();

            if (event.type === 'done') {
              emit(eventWithMeta as typeof event);
              break;
            }

            emit(eventWithMeta as typeof event);
          }

          // Run post-receive hooks for plugin inference provider path.
          // Awaited + abort-guarded to mirror the Mastra path below (the
          // `runtime.stream(...)` loop's `event.type === 'done'` branch).
          // Without the abort guard, a mid-stream cancel that still flushes
          // a final `'done'` event would fire hooks on truncated content;
          // without the await, plugin learning pipelines (e.g.
          // kai-plugin-aithena) can race the next user turn.
          if (pluginManager && providerResponseText.length > 0 && !controller.signal.aborted) {
            try {
              await pluginManager.runPostReceiveHooks({
                response: { role: 'assistant', content: providerResponseText },
                messages: messages as HookMessage[],
                config,
              });
            } catch (err) {
              console.error('[Agent:stream] Post-receive hook error (provider path):', err);
            }
          }

          // Fire lifecycle hooks so provider-backed streams behave like the
          // Mastra path (which dispatches these on `done` / in `finally`).
          if (providerResponseText.length > 0 && !controller.signal.aborted) {
            void hookDispatcher.dispatch('AssistantMessage', { conversationId, text: providerResponseText });
          }
          void hookDispatcher.dispatch('AgentStop', {
            conversationId,
            aborted: controller.signal.aborted,
          });

          // Provider handled the request — clean up and exit
          cleanupStreamIfOwned(conversationId, streamToken);
          return;
        } catch (providerError) {
          if (emittedTextDelta) {
            // Already started streaming text — can't fall back mid-response
            console.error(
              `[Agent:stream] Plugin inference provider "${inferenceProvider.name}" failed after emitting text:`,
              providerError,
            );
            const meta = { runtimeId: inferenceProvider.name };
            emit({
              conversationId,
              type: 'error',
              error: `Inference provider error: ${providerError instanceof Error ? providerError.message : String(providerError)}`,
              messageMeta: meta,
            });
            emit({ conversationId, type: 'done', messageMeta: meta });
            void hookDispatcher.dispatch('AgentStop', { conversationId, aborted: controller.signal.aborted });
            cleanupStreamIfOwned(conversationId, streamToken);
            return;
          }
          console.error(
            `[Agent:stream] Plugin inference provider "${inferenceProvider.name}" failed before emitting text:`,
            providerError,
          );
          const meta = { runtimeId: inferenceProvider.name };
          emit({
            conversationId,
            type: 'error',
            error: `Inference provider error: ${providerError instanceof Error ? providerError.message : String(providerError)}`,
            messageMeta: meta,
          });
          emit({ conversationId, type: 'done', messageMeta: meta });
          void hookDispatcher.dispatch('AgentStop', { conversationId, aborted: controller.signal.aborted });
          cleanupStreamIfOwned(conversationId, streamToken);
          return;
        }
      }

      const toolCancels = new Map<string, () => void>();
      const hookDeniedToolCalls = new Map<string, string>();
      // toolCallId → sanitized args, set when a PreToolUse hook modifies/denies.
      // Used to rewrite the streamed `tool-call` event so raw args aren't
      // persisted into chat history after a DLP hook redacted them.
      const hookRewrittenArgs = new Map<string, unknown>();
      // Memoized PreToolUse result per execution toolCallId, so the stream
      // `tool-call` handler (which the UI renders) and `onToolExecutionStart`
      // (which runs the tool) share ONE dispatch — no double-fire, and no race
      // where the UI shows raw args before the hook resolves.
      type PreToolResult = { denied: boolean; reason?: string; args: unknown };
      const preToolResults = new Map<string, Promise<PreToolResult>>();
      const runPreToolUseOnce = (toolCallId: string, toolName: string, args: unknown): Promise<PreToolResult> => {
        const existing = preToolResults.get(toolCallId);
        if (existing) return existing;
        const p = (async (): Promise<PreToolResult> => {
          const preTool = await hookDispatcher.dispatch('PreToolUse', {
            conversationId,
            toolCallId,
            toolName,
            args,
          });
          if (preTool.denied) {
            const reason = preTool.reason ?? 'Blocked by PreToolUse hook.';
            return { denied: true, reason, args: { redacted: true, reason } };
          }
          const nextArgs = (preTool.payload as { args?: unknown } | undefined)?.args;
          return { denied: false, args: nextArgs !== undefined ? nextArgs : args };
        })();
        preToolResults.set(toolCallId, p);
        return p;
      };
      // When block/modify hooks are active, the UI-facing `tool-call` stream
      // event can arrive before PreToolUse resolves. To guarantee raw args
      // never reach the renderer/persistence, we SUPPRESS args on the initial
      // broadcast (showing a pending placeholder) and fill them in via the
      // corrective re-broadcast once the hook has run.
      const enforcingHooksActive = hookDispatcher.hasEnforcingToolHooks();
      // Provider-native tool names for the CURRENTLY ACTIVE model. Provider-
      // native tools execute in-provider and never hit onToolExecutionStart,
      // so their args must not be suppressed (nothing would un-suppress them →
      // stuck {pending}). This must track the active model, NOT a union across
      // fallbacks: unioning would wrongly exempt the primary model's LOCAL
      // tool (e.g. a client-side `web_search`) just because a fallback model
      // has a provider-native tool of the same name — letting raw args leak
      // past a DLP hook. Recomputed on each model-fallback event below.
      let providerDefinedToolNames = modelEntry?.modelConfig
        ? getProviderDefinedToolNames(modelEntry.modelConfig)
        : new Set<string>();
      const pendingObserverToolExecutions = new Set<Promise<void>>();
      let observerLaunchesEnabled = true;
      let observer: ToolObserverManager | null = null;
      // Accumulate assistant response text for post-receive hooks
      let accumulatedResponseText = '';
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
      const compactionByExecuteId = new Map<
        string,
        {
          originalContent: string;
          wasCompacted: boolean;
          extractionDurationMs: number;
        }
      >();
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
          emit({
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
          emit({
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
          emit({
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
        if (toolName === 'create_artifact' || toolName === 'update_artifact') {
          return { result };
        }
        // Preserve inline diffs THROUGH compaction: capture the diff metadata,
        // compact the (possibly large) rest, then re-attach the metadata so a
        // build/install that both prints a lot and touches a lockfile still
        // gets its stdout shrunk without losing the inline diff.
        let preservedDiffTracking: unknown;
        let resultForCompaction = result;
        if (result && typeof result === 'object' && !Array.isArray(result)) {
          const r = result as Record<string, unknown>;
          const dt = r._diffTracking as { diffs?: unknown[] } | undefined;
          if (dt && Array.isArray(dt.diffs) && dt.diffs.length > 0) {
            preservedDiffTracking = dt;
            const { _diffTracking, ...rest } = r;
            void _diffTracking;
            resultForCompaction = rest;
          }
        }
        const reattach = (value: unknown): unknown => {
          if (preservedDiffTracking === undefined) return value;
          if (value && typeof value === 'object' && !Array.isArray(value)) {
            return { ...(value as Record<string, unknown>), _diffTracking: preservedDiffTracking };
          }
          // Compaction produced a bare string. Only shell/CLI results carry
          // _diffTracking, and the shell renderer recognizes { stdout } — so
          // reattach as a shell-shaped object to keep the output view working
          // (wrapping as { value } would render as "No output").
          return { stdout: String(value ?? ''), _diffTracking: preservedDiffTracking };
        };

        const originalText = stringifyToolResult(resultForCompaction);
        const userQuery = extractLatestUserQuery(messages);
        const shouldAttemptCompaction =
          originalText.length > 0 &&
          estimateToolTokens(originalText, modelEntry?.modelConfig.modelName) > toolCompaction.triggerTokens;

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
          return { result: reattach(resultForCompaction) };
        }

        queueOrBroadcastToolCompaction(
          toolCallId,
          toolName,
          {
            phase: 'start',
            originalContent: originalText,
            timestamp: nowIso(),
          },
          lifecycleMode,
        );

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
            queueOrBroadcastToolCompaction(
              toolCallId,
              toolName,
              {
                phase: 'complete',
                extractionDurationMs: compactionResult.extractionDurationMs ?? 0,
                timestamp: nowIso(),
              },
              lifecycleMode,
            );

            logToolCompactionDebug('compaction-complete', {
              conversationId,
              toolCallId,
              toolName,
              lifecycleMode,
              compactedLength: typeof compactionResult.content === 'string' ? compactionResult.content.length : null,
              extractionDurationMs: compactionResult.extractionDurationMs ?? 0,
            });

            return {
              result: reattach(compactionResult.content),
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

        return { result: reattach(resultForCompaction) };
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

        // ── Lifecycle hook: PreToolUse ──────────────────────────────
        // Observer-launched tools must go through the same block/modify
        // enforcement as normal tool calls, or a DLP hook is bypassed.
        const preTool = await runPreToolUseOnce(toolCallId, toolName, args);
        if (preTool.denied) {
          const reason = preTool.reason ?? 'Blocked by PreToolUse hook.';
          toolCancels.delete(toolCallId);
          return { ok: false, details: reason };
        }
        // Use the (possibly sanitized) args for observer, UI, and execution.
        const effectiveArgs = preTool.args;

        observer.onToolExecutionStart({
          toolCallId,
          toolName,
          args: effectiveArgs,
          observerInitiated: true,
        });

        emit({
          conversationId,
          type: 'tool-call',
          toolCallId,
          toolName,
          args: effectiveArgs,
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
                  emit({
                    conversationId,
                    type: 'tool-progress',
                    toolCallId,
                    toolName,
                    data: progress,
                  });
                }
              },
            };

            const rawResult = await tool.execute(effectiveArgs, context);
            // ── Lifecycle hook: PostToolUse ─────────────────────────────
            // Same enforcement as the normal path: deny → error result,
            // modify → replace result, before observer/compaction/broadcast.
            let hookedResult: unknown = rawResult;
            const postTool = await hookDispatcher.dispatch('PostToolUse', {
              conversationId,
              toolCallId,
              toolName,
              args: effectiveArgs,
              result: rawResult,
            });
            if (postTool.denied) {
              hookedResult = { isError: true, error: postTool.reason ?? 'Blocked by PostToolUse hook.' };
            } else {
              const nextResult = (postTool.payload as { result?: unknown } | undefined)?.result;
              if (nextResult !== undefined) hookedResult = nextResult;
            }
            observer?.onToolExecutionResult(toolCallId, toolName, hookedResult);
            const observerAugmented = withObserverAugmentation(hookedResult, observer?.getToolAugmentation(toolCallId));
            const compacted = await maybeCompactToolOutput(toolCallId, toolName, observerAugmented, 'direct');
            const finishedAt = new Date().toISOString();

            if (activeObserverSessions.get(conversationId) === observerSessionId && !controller.signal.aborted) {
              emit({
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
            let errorResult: unknown = {
              isError: true,
              error: error instanceof Error ? error.message : String(error),
            };
            // PostToolUse on the error path too, so a DLP hook can sanitize
            // error payloads from observer-launched tools.
            const postTool = await hookDispatcher.dispatch('PostToolUse', {
              conversationId,
              toolCallId,
              toolName,
              args: effectiveArgs,
              result: errorResult,
            });
            if (postTool.denied) {
              errorResult = { isError: true, error: postTool.reason ?? 'Blocked by PostToolUse hook.' };
            } else {
              const nextResult = (postTool.payload as { result?: unknown } | undefined)?.result;
              if (nextResult !== undefined) errorResult = nextResult;
            }
            observer?.onToolExecutionResult(toolCallId, toolName, errorResult);
            const observerAugmented = withObserverAugmentation(errorResult, observer?.getToolAugmentation(toolCallId));
            const compacted = await maybeCompactToolOutput(toolCallId, toolName, observerAugmented, 'direct');
            const finishedAt = new Date().toISOString();

            if (activeObserverSessions.get(conversationId) === observerSessionId && !controller.signal.aborted) {
              emit({
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
          emit({ conversationId, type: 'done' });
          return;
        }
        // Check if compaction is needed (only if runtime supports it)
        if (compactionSupported && config.compaction.conversation.enabled && modelEntry) {
          const chatMessages = messages as Array<{ role: string; content: unknown; id?: string }>;

          // Reuse a previously-persisted compaction when it still applies to this
          // branch, instead of re-summarizing the same prefix every turn. The
          // stored record's compactedMessageIds must be an ordered prefix of the
          // current branch (a fork/rewind/variant/edit changes the leading ids and
          // fails this check → we recompute). Fail-safe: any mismatch or over-window
          // reuse falls through to the normal shouldCompact/recompute path; we never
          // drop a message. Substitution stays LOCAL to this turn's `messages`.
          const storedCompaction = readConversation(appHome, conversationId)?.conversationCompaction as
            | { compactionId?: string; summaryText?: string; compactedMessageIds?: string[] }
            | null
            | undefined;
          let reusedCompaction = false;
          if (
            storedCompaction &&
            typeof storedCompaction.compactionId === 'string' &&
            typeof storedCompaction.summaryText === 'string' &&
            Array.isArray(storedCompaction.compactedMessageIds) &&
            storedCompaction.compactedMessageIds.length > 0
          ) {
            // The summary covers the first N branch messages (N = stored id
            // count). Reuse is only safe if EACH of those N messages carries a
            // real (non-empty string) id we can match against the stored ids — an
            // id-less covered message can't be verified and must not be silently
            // folded into the summary (that would drop it). Restrict matching to
            // the covered span so no sentinel/collision reasoning is needed.
            const coveredCount = storedCompaction.compactedMessageIds.length;
            const coveredBranchIds = chatMessages
              .slice(0, coveredCount)
              .map((m) => (typeof m.id === 'string' && m.id.length > 0 ? m.id : null));
            const coveredAllIded =
              coveredBranchIds.length === coveredCount && coveredBranchIds.every((id) => id !== null);
            if (coveredAllIded && isStrictPrefix(storedCompaction.compactedMessageIds, coveredBranchIds as string[])) {
              const summaryMsg = {
                id: `compaction-summary-${storedCompaction.compactionId}`,
                role: 'assistant' as const,
                content: storedCompaction.summaryText,
              };
              const candidate = [summaryMsg, ...chatMessages.slice(coveredCount)];
              // Only adopt the reuse if the candidate still fits under the trigger;
              // if the branch has grown enough to need a NEW compaction, fall through
              // to recompute (which will overwrite the record + emit a new event).
              const reuseCheck = shouldCompact(
                candidate as Parameters<typeof shouldCompact>[0],
                modelEntry.modelConfig.modelName,
                config.compaction.conversation.triggerPercent,
                modelEntry.modelConfig.maxInputTokens,
              );
              if (!reuseCheck.shouldCompact) {
                messages = candidate as typeof messages;
                reusedCompaction = true;
              }
            }
          }

          const check = reusedCompaction
            ? { shouldCompact: false, usedTokens: 0, contextWindowTokens: 0 }
            : shouldCompact(
                chatMessages as Parameters<typeof shouldCompact>[0],
                modelEntry.modelConfig.modelName,
                config.compaction.conversation.triggerPercent,
                modelEntry.modelConfig.maxInputTokens,
              );

          if (check.shouldCompact) {
            emit({
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
              emit({ conversationId, type: 'done' });
              return;
            }

            if (compactionResult.compactedMessages) {
              emit({
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
                emit({
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
                data: event.data as
                  | {
                      stream?: 'stdout' | 'stderr';
                      output?: string;
                      delta?: string;
                      bytesSeen?: number;
                      truncated?: boolean;
                      stopped?: boolean;
                    }
                  | undefined,
              });
            }
            // Side-channel events (tool progress) should stop immediately on abort.
            if (!controller.signal.aborted) {
              emit(event);
            }
          },
          onToolExecutionStart: async (state: {
            toolCallId: string;
            toolName: string;
            args: unknown;
            cancel: () => void;
          }) => {
            toolCancels.set(state.toolCallId, state.cancel);
            enqueueByToolName(pendingExecIdsByToolName, state.toolName, state.toolCallId);
            pairExecuteAndStreamToolCallIds(state.toolName);

            // ── Lifecycle hook: PreToolUse (memoized) ───────────────────
            // Shared with the stream `tool-call` handler so the UI and the
            // executor agree on one outcome. Runs BEFORE the observer so a
            // block/modify DLP hook denies/sanitizes args before the observer
            // model sees them. `block` → skip execution with an error result;
            // `modify` → replace args in place before the tool runs.
            const preTool = await runPreToolUseOnce(state.toolCallId, state.toolName, state.args);
            if (preTool.denied) {
              const reason = preTool.reason ?? 'Blocked by PreToolUse hook.';
              hookDeniedToolCalls.set(state.toolCallId, reason);
              // Key rewritten args by BOTH the exec id (stable, known now) and
              // the paired stream id if available. The stream `tool-call`
              // handler resolves either — so a rebroadcast reaches the correct
              // rendered card regardless of which side fired first.
              hookRewrittenArgs.set(state.toolCallId, preTool.args);
              const denyStreamId = streamToolCallIdByExecId.get(state.toolCallId);
              if (denyStreamId) hookRewrittenArgs.set(denyStreamId, preTool.args);
              // Only rebroadcast when the stream id is known; otherwise the
              // stream `tool-call` handler will apply the stored args when it
              // fires (avoids emitting a duplicate card under the exec id).
              if (denyStreamId) {
                emit({
                  conversationId,
                  type: 'tool-call',
                  toolCallId: denyStreamId,
                  toolName: state.toolName,
                  args: preTool.args,
                });
              }
              return { skip: true as const, result: { isError: true, error: reason } };
            }
            const modStreamId = streamToolCallIdByExecId.get(state.toolCallId);
            if (preTool.args !== state.args) {
              // The executor passes `state.args` to tool.execute() BY REFERENCE,
              // so the only way to deliver modified args is to mutate that object
              // in place. That works when both sides are plain objects. If a
              // modify hook returned an array or a primitive (or the tool's args
              // were an array), we cannot swap the reference — running the tool
              // with the ORIGINAL args would silently fail OPEN. Fail CLOSED
              // instead: deny the call, mirroring the dispatcher's modify policy.
              const canMutateInPlace =
                state.args &&
                typeof state.args === 'object' &&
                !Array.isArray(state.args) &&
                preTool.args &&
                typeof preTool.args === 'object' &&
                !Array.isArray(preTool.args);
              if (canMutateInPlace) {
                const target = state.args as Record<string, unknown>;
                for (const k of Object.keys(target)) delete target[k];
                Object.assign(target, preTool.args as Record<string, unknown>);
              } else {
                const reason =
                  'PreToolUse modify hook returned args that cannot be applied to this tool (non-object replacement); failing closed to avoid running with unsanitized input.';
                hookDeniedToolCalls.set(state.toolCallId, reason);
                hookRewrittenArgs.set(state.toolCallId, preTool.args);
                const failStreamId = streamToolCallIdByExecId.get(state.toolCallId);
                if (failStreamId) {
                  hookRewrittenArgs.set(failStreamId, preTool.args);
                  emit({
                    conversationId,
                    type: 'tool-call',
                    toolCallId: failStreamId,
                    toolName: state.toolName,
                    args: preTool.args,
                  });
                }
                return { skip: true as const, result: { isError: true, error: reason } };
              }
            }
            // When enforcing hooks are active the initial stream tool-call was
            // broadcast with suppressed ({pending}) args; emit the resolved
            // args now (sanitized or allowed-unchanged). Renderer upserts by id.
            if (enforcingHooksActive) {
              // Store under exec id always; also under the stream id if paired.
              // The stream `tool-call` handler resolves either when it fires.
              hookRewrittenArgs.set(state.toolCallId, preTool.args);
              if (modStreamId) hookRewrittenArgs.set(modStreamId, preTool.args);
              // Only rebroadcast when the stream id is known; otherwise the
              // stream handler applies the stored args on arrival (no dup card).
              if (modStreamId) {
                emit({
                  conversationId,
                  type: 'tool-call',
                  toolCallId: modStreamId,
                  toolName: state.toolName,
                  args: preTool.args,
                });
              }
            }

            // Observer sees post-enforcement (allowed, possibly sanitized) args.
            observer?.onToolExecutionStart(state);

            // Gate exit_plan_mode behind user approval regardless of execution mode
            if (state.toolName === 'exit_plan_mode') {
              const streamId = streamToolCallIdByExecId.get(state.toolCallId) ?? state.toolCallId;
              emit({
                conversationId,
                type: 'tool-approval-required',
                toolCallId: streamId,
                toolName: state.toolName,
                args: state.args,
              });
              observer?.onToolAwaitingApproval(state.toolCallId);
              // Abort-aware: a cancel-stream aborts controller.signal, which
              // resolves this with 'dismiss' and deletes the pending entry, so a
              // later GUI approval can't resume a cancelled run (and no leak).
              const approved = await registerPendingApproval(streamId, controller.signal);
              if (approved !== true) {
                state.cancel();
                if (approved === 'dismiss') {
                  // User clicked X — exit plan mode entirely and stop the stream.
                  console.info(`[Agent:stream] exit_plan_mode dismissed by user, exiting plan mode and stopping`);
                  broadcastExecutionMode('auto');
                  planDoneSent = true;
                  emit({ conversationId, type: 'done', data: { planDismissed: true } });
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
                emit({ conversationId, type: 'done', data: { planModeRejectRestart: true } });
                controller.abort();
                return;
              }
            }

            // Gate ask_user behind user response — blocks until user submits answers
            if (state.toolName === 'ask_user') {
              const streamId = streamToolCallIdByExecId.get(state.toolCallId) ?? state.toolCallId;
              emit({
                conversationId,
                type: 'tool-approval-required',
                toolCallId: streamId,
                toolName: state.toolName,
                args: state.args,
              });
              observer?.onToolAwaitingApproval(state.toolCallId);
              // Abort-aware (see exit_plan_mode above): cancel resolves this as
              // 'dismiss' and cleans up, instead of leaking a pending approval.
              const approved = await registerPendingApproval(streamId, controller.signal);
              if (approved !== true) {
                state.cancel();
              } else {
                // Copy answers from stream-side ID to execute-side ID so the tool's execute() can find them
                const answers = pendingQuestionAnswers.get(streamId);
                if (answers) {
                  stashQuestionAnswers(state.toolCallId, answers);
                  pendingQuestionAnswers.delete(streamId);
                }
              }
            }
          },
          onToolExecutionEnd: ({ toolCallId }: { toolCallId: string; toolName: string }) => {
            toolCancels.delete(toolCallId);
            observer?.onToolExecutionEnd(toolCallId);
          },
          augmentToolResult: async ({
            toolCallId,
            toolName,
            args,
            result,
          }: {
            toolCallId: string;
            toolName: string;
            args: unknown;
            result: unknown;
          }) => {
            // If PreToolUse denied this call, the tool was cancelled and `result`
            // is whatever the aborted execute() produced. Replace it with an
            // explicit error so the model sees the deny reason.
            const denyReason = hookDeniedToolCalls.get(toolCallId);
            if (denyReason !== undefined) {
              hookDeniedToolCalls.delete(toolCallId);
              result = { isError: true, error: denyReason };
            }

            // ── Lifecycle hook: PostToolUse ─────────────────────────────
            // `modify` → replace `result` before it is fed back to the model.
            // `block`  → convert to an error result.
            // Use the redacted/sanitized args (if a PreToolUse hook rewrote or
            // denied them) so PostToolUse/observers never see the raw args.
            const execIdForArgs = execToolCallIdByStreamId.get(toolCallId) ?? toolCallId;
            const postArgs = hookRewrittenArgs.get(toolCallId) ?? hookRewrittenArgs.get(execIdForArgs) ?? args;
            const postTool = await hookDispatcher.dispatch('PostToolUse', {
              conversationId,
              toolCallId,
              toolName,
              args: postArgs,
              result,
            });
            if (postTool.denied) {
              result = { isError: true, error: postTool.reason ?? 'Blocked by PostToolUse hook.' };
            } else {
              const nextResult = (postTool.payload as { result?: unknown } | undefined)?.result;
              if (nextResult !== undefined) result = nextResult;
            }

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

        // Load persisted conversation metadata so runtimes can resume sessions.
        // Claude Code SDK uses `claudeSdkSessionId`; Codex SDK uses `codexSdkThreadId`.
        const convMetadata = (readConversation(appHome, conversationId)?.metadata ?? {}) as Record<string, unknown>;

        // -----------------------------------------------------------------------
        // Cross-runtime switch: detect runtime change and inject prior context
        // -----------------------------------------------------------------------
        let switchContext: string | undefined;
        // Skip for Mastra — it already receives the full message history natively.
        if (runtime.id !== 'mastra') {
          const previousRuntimeId = detectRuntimeSwitch(messages, runtime.id);
          if (previousRuntimeId && modelEntry) {
            const switchToolCallId = `switch-${Date.now()}`;
            emit({
              conversationId,
              type: 'tool-call',
              toolCallId: switchToolCallId,
              toolName: 'runtime_switch',
              args: { fromRuntime: previousRuntimeId, toRuntime: runtime.id },
              startedAt: new Date().toISOString(),
            });

            const generatedContext = await generateSwitchContext(messages, modelEntry.modelConfig, {
              abortSignal: controller.signal,
            });

            emit({
              conversationId,
              type: 'tool-result',
              toolCallId: switchToolCallId,
              toolName: 'runtime_switch',
              result: generatedContext ? generatedContext : 'No prior context to transfer',
              finishedAt: new Date().toISOString(),
            });

            if (generatedContext && !controller.signal.aborted) {
              // Wrap the raw context in XML tags for LLM injection
              const wrappedContext = wrapSwitchContext(generatedContext, previousRuntimeId);
              switchContext = wrappedContext;
              effectiveSystemPrompt = effectiveSystemPrompt
                ? `${wrappedContext}\n\n${effectiveSystemPrompt}`
                : wrappedContext;
              if (streamConfig) {
                streamConfig = { ...streamConfig, systemPrompt: effectiveSystemPrompt };
              }
            }
          }
        }

        // ── Confinement chokepoint (#71) ───────────────────────────────────
        // When enabled AND the resolved runtime spawns untrusted, model-directed
        // tools, pre-build the scrubbed child env + validated cwd here (once) and
        // hand them to the runtime via StreamOptions. Gated behind
        // agent.confinement.enabled (default false) so this is inert until an
        // operator opts in. mastra (executesUntrustedTools=false) is unaffected.
        let confinedChildEnv: NodeJS.ProcessEnv | undefined;
        let confinedCwdValue: string | undefined;
        const confinementCfg = config.agent?.confinement;
        if (confinementCfg?.enabled && runtime.capabilities.executesUntrustedTools) {
          const perRuntime = confinementCfg.overrides?.[runtime.id];
          const scrub = perRuntime?.scrubCredentials ?? confinementCfg.scrubCredentials;
          const workspaceOnly = perRuntime?.workspaceOnly ?? confinementCfg.workspaceOnly;

          if (scrub) {
            const mc = modelEntry?.modelConfig;
            confinedChildEnv = buildAgentChildEnv({
              modelProvider: mc?.provider,
              modelEnv: providerKeyEnv(mc?.provider, mc?.apiKey),
              hasExplicitAwsKeys: Boolean(mc?.accessKeyId && mc?.secretAccessKey),
              passthrough: confinementCfg.envAllowlist,
            });
          }
          if (workspaceOnly) {
            const resolved = resolveConfinedCwd(effectiveCwd, { workspaceRoot: confinementCfg.root });
            if (resolved.refused) {
              emit({ conversationId, type: 'text-delta', text: `> ⚠️ Agent confinement: ${resolved.reason}\n\n` });
            } else {
              confinedCwdValue = resolved.cwd ?? undefined;
              if (resolved.escaped) {
                emit({
                  conversationId,
                  type: 'text-delta',
                  text: `> ⚠️ Agent confinement: requested directory is outside the workspace root.\n\n`,
                });
              }
            }
          }
        }

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
          modelAuth: resolution.modelAuth,
          conversationMetadata: convMetadata,
          switchContext,
          childEnv: confinedChildEnv,
          confinedCwd: confinedCwdValue,
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
              compactionPhase:
                event.type === 'tool-compaction'
                  ? ((event.data as { phase?: string } | undefined)?.phase ?? null)
                  : null,
            });
          }
          if (event.type === 'tool-call' && event.toolCallId && event.toolName) {
            enqueueByToolName(pendingStreamIdsByToolName, event.toolName, event.toolCallId);
            pairExecuteAndStreamToolCallIds(event.toolName);
            // Resolve rewritten args by this stream id OR the now-paired exec
            // id (onToolExecutionStart may have run first and stored under the
            // exec id before pairing existed).
            const pairedExecId = execToolCallIdByStreamId.get(event.toolCallId);
            const rewritten =
              hookRewrittenArgs.get(event.toolCallId) ??
              (pairedExecId ? hookRewrittenArgs.get(pairedExecId) : undefined);
            if (rewritten !== undefined) {
              // Hook already resolved — publish the sanitized args.
              (event as Record<string, unknown>).args = rewritten;
            } else if (
              enforcingHooksActive &&
              runtime.id === 'mastra' &&
              !providerDefinedToolNames.has(event.toolName)
            ) {
              // Suppress raw args until the corrective re-broadcast fills them
              // in — but ONLY under Mastra (which calls onToolExecutionStart)
              // and NOT for provider-native tools (which execute in-provider
              // and never un-suppress → would stick at {pending} forever).
              (event as Record<string, unknown>).args = { pending: true };
              (event as Record<string, unknown>).argsPending = true;
            }
          }
          if (event.type === 'tool-result' && event.toolName === 'enter_plan_mode') {
            // Plan mode was entered mid-stream. Abort this stream so the renderer
            // can re-send with executionMode='plan-first' (correct system prompt + tool set).
            console.info(
              `[Agent:stream] enter_plan_mode detected mid-stream, aborting to restart with plan-first mode`,
            );
            emit(event);
            planDoneSent = true;
            emit({ conversationId, type: 'done', data: { planModeRestart: true } });
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

            // ── Lifecycle hook: AssistantMessage ────────────────────────
            if (accumulatedResponseText.length > 0) {
              void hookDispatcher.dispatch('AssistantMessage', {
                conversationId,
                text: accumulatedResponseText,
              });
            }

            // Run post-receive hooks (e.g. plugin learning pipelines)
            if (pluginManager && accumulatedResponseText.length > 0) {
              try {
                await pluginManager.runPostReceiveHooks({
                  response: { role: 'assistant', content: accumulatedResponseText },
                  messages: messages as HookMessage[],
                  config,
                });
              } catch (err) {
                console.error('[Agent:stream] Post-receive hook error:', err);
              }
            }
          }
          if (event.type === 'model-fallback') {
            const fbData = event.data as { toModelKey?: string } | undefined;
            if (fbData?.toModelKey && streamConfig) {
              const fallbackEntry = streamConfig.fallbackModels.find((m) => m.key === fbData.toModelKey);
              if (fallbackEntry?.modelConfig) {
                activeSourceModel = `${fallbackEntry.modelConfig.provider}:${fallbackEntry.modelConfig.modelName}`;
                activeModelDisplayName = fallbackEntry.displayName ?? null;
                // Re-point the provider-native exemption at the now-active
                // fallback model so its provider tools aren't suppressed and,
                // conversely, the previous model's local tools aren't wrongly
                // exempted.
                providerDefinedToolNames = getProviderDefinedToolNames(fallbackEntry.modelConfig);
              }
            }
          }
          if (event.type === 'text-delta') {
            accumulatedResponseText += event.text ?? '';
            (event as Record<string, unknown>).messageMeta = {
              ...(((event as Record<string, unknown>).messageMeta as Record<string, unknown> | undefined) ?? {}),
              ...(activeSourceModel ? { sourceModel: activeSourceModel } : {}),
              ...(activeModelDisplayName ? { sourceModelDisplayName: activeModelDisplayName } : {}),
              reasoningEffort: reasoningEffort ?? null,
              runtimeId: runtime.id,
              ...(resolution.providerOverride ? { providerKey: resolution.providerOverride } : {}),
            };
          }
          if (activeObserverSessions.get(conversationId) !== observerSessionId) {
            ipcDebugLog(
              `[LOOP-SKIP] conv=${conversationId} event.type=${event.type} reason=observerSessionMismatch current=${activeObserverSessions.get(conversationId)} expected=${observerSessionId}`,
            );
            continue;
          }
          ipcDebugLog(
            `[LOOP-EMIT] conv=${conversationId} event.type=${event.type} toolCallId=${event.toolCallId ?? 'none'} toolName=${event.toolName ?? 'none'}`,
          );
          emit(event);
        }
      } catch (error) {
        ipcDebugLog(
          `[LOOP-ERROR] conv=${conversationId} aborted=${controller.signal.aborted} error=${error instanceof Error ? error.message : String(error)}`,
        );
        if (!controller.signal.aborted) {
          emit({
            conversationId,
            type: 'error',
            error: error instanceof Error ? error.message : String(error),
          });
          emit({ conversationId, type: 'done' });
        }
      } finally {
        ipcDebugLog(`[LOOP-FINALLY] conv=${conversationId} cleaning up`);
        // ── Lifecycle hook: AgentStop ───────────────────────────────────
        void hookDispatcher.dispatch('AgentStop', {
          conversationId,
          aborted: controller.signal.aborted,
        });
        observerLaunchesEnabled = false;
        await waitForObserverToolExecutions();
        observer?.dispose();
        // Token-guarded so a replacement run that already took over this
        // conversation keeps its own stream + model-key state.
        if (activeStreams.get(conversationId)?.token === streamToken) {
          activeStreams.delete(conversationId);
          activeStreamModelKeys.delete(conversationId);
        }
        if (activeObserverSessions.get(conversationId) === observerSessionId) {
          activeObserverSessions.delete(conversationId);
        }
        // If this run still owns server-persist here, the stream ended WITHOUT a
        // `done` (abnormal termination — a producer that didn't emit the closing
        // event). `done` deletes the token + the accumulator; its absence would
        // otherwise leak the persistence accumulator forever. Release both.
        if (serverPersistAppHome && serverPersistTokens.get(conversationId) === streamToken) {
          serverPersistTokens.delete(conversationId);
          serverPersistParents.delete(conversationId);
          discardPersistenceAccumulator(conversationId);
        }
      }
    })();

    return { conversationId };
  };

  ipcMain.handle('agent:stream', streamHandler);

  // Thin server-side entry point for clients that don't manage the message tree
  // themselves (the `kai` CLI). Appends the user turn (server-authoritative
  // persistence), creating the conversation if the client hasn't yet, then
  // delegates to the same stream path the GUI uses.
  ipcMain.handle(
    'agent:submit',
    async (
      event,
      conversationId: string,
      userText: string,
      opts?: {
        modelKey?: string;
        reasoningEffort?: ReasoningEffort;
        profileKey?: string;
        fallbackEnabled?: boolean;
        cwd?: string;
        executionMode?: ExecutionMode;
        /** Optional image attachments (CLI @image / paste / AppShots). Each
         *  `image` is a data URL or base64 string; appended as image parts to
         *  the user message so vision-capable models receive them. */
        attachments?: Array<{ image: string; mimeType?: string }>;
      },
    ) => {
      const conv = readConversation(appHome, conversationId);
      if (!conv) return { ok: false, error: 'conversation-not-found' };

      // Reject a second concurrent submit into the same conversation while one is
      // still pending (waiting on toolsReady). currentPendingSubmit holds one id
      // per conversation; a second submit would overwrite it, so a later cancel
      // could cancel the wrong one and let a detached run proceed. The post-
      // toolsReady busy-check covers the already-streaming case; this covers the
      // pre-toolsReady window.
      if (currentPendingSubmit.has(conversationId) || activeStreams.has(conversationId)) {
        return { ok: false, error: 'conversation-busy' };
      }

      // Mint a cancellable id for the pre-stream window (waiting on toolsReady):
      // no activeStreams entry exists yet, so agent:cancel-stream can only reach
      // us via cancelledSubmits.
      const submitId = ++submitIdSeq;
      currentPendingSubmit.set(conversationId, submitId);

      // The CLI bridge serves before the tool registry finishes building, so a
      // turn arriving in that window would run tool-less. Wait for tools first.
      await toolsReady;

      // If the client detached (or cancelled) while we awaited toolsReady, bail
      // before appending the user turn / starting a model run.
      if (cancelledSubmits.delete(submitId)) {
        if (currentPendingSubmit.get(conversationId) === submitId) currentPendingSubmit.delete(conversationId);
        return { ok: false, error: 'cancelled' };
      }
      if (currentPendingSubmit.get(conversationId) === submitId) currentPendingSubmit.delete(conversationId);

      // Re-read AFTER toolsReady: another stream (automation/GUI) may have started
      // during the wait. Refuse to submit into a busy conversation — appending our
      // user turn under a head a concurrent run will later move would corrupt/hide
      // this branch. An in-flight automation run marks its target runStatus:'running',
      // so the runStatus check + activeStreams entry together cover automation, GUI,
      // and CLI concurrency without importing the automations module (avoids a cycle).
      const busyCheck = readConversation(appHome, conversationId);
      if (!busyCheck) return { ok: false, error: 'conversation-not-found' };
      if (
        busyCheck.runStatus === 'running' ||
        busyCheck.runStatus === 'awaiting-approval' ||
        activeStreams.has(conversationId)
      ) {
        return { ok: false, error: 'conversation-busy' };
      }

      // Build the user message content: the text part plus any validated image
      // attachments (CLI @image / paste / AppShots). Cap the count and total
      // size — data URLs are large and go straight into the persisted tree +
      // the model request. Non-string / oversized entries are dropped.
      //
      // The caps stay UNDER the local-bridge MAX_FRAME_BYTES (8 MiB): the whole
      // agent:submit call (text + attachments + JSON envelope) travels in one
      // bridge frame, so an over-frame payload is destroyed at the socket before
      // it ever reaches here. Keep headroom for the text + envelope so a valid
      // multi-image message isn't silently killed by the frame guard.
      const MAX_ATTACHMENTS = 8;
      const MAX_ATTACHMENT_BYTES = 6 * 1024 * 1024; // 6 MiB per image (data-URL length)
      const MAX_ATTACHMENTS_TOTAL_BYTES = 7 * 1024 * 1024; // 7 MiB across all images (< 8 MiB frame)
      const userContent: Array<Record<string, unknown>> = [{ type: 'text', text: userText }];
      if (Array.isArray(opts?.attachments)) {
        // Only accept a known set of image MIME types; anything else (including
        // an oversized arbitrary string that would bypass the byte budget) is
        // dropped to the bare {image} part with no mimeType.
        const ALLOWED_IMAGE_MIME = new Set([
          'image/png',
          'image/jpeg',
          'image/gif',
          'image/webp',
          'image/bmp',
          'image/svg+xml',
          'image/heic',
          'image/heif',
        ]);
        let imageCount = 0;
        let totalBytes = 0;
        for (const att of opts!.attachments) {
          if (imageCount >= MAX_ATTACHMENTS) break;
          const image = att?.image;
          if (typeof image !== 'string' || image.length === 0) continue;
          // Byte-accurate accounting (a data URL is ASCII, but be exact so a
          // multibyte string can't slip past the intended persisted/model cap).
          const imageBytes = Buffer.byteLength(image, 'utf8');
          if (imageBytes > MAX_ATTACHMENT_BYTES) continue; // single image too big — skip
          if (totalBytes + imageBytes > MAX_ATTACHMENTS_TOTAL_BYTES) break; // budget exhausted
          totalBytes += imageBytes;
          imageCount += 1;
          const mimeType =
            typeof att.mimeType === 'string' && ALLOWED_IMAGE_MIME.has(att.mimeType) ? att.mimeType : undefined;
          userContent.push(mimeType ? { type: 'image', image, mimeType } : { type: 'image', image });
        }
      }

      // Mark the conversation running so automation busy-checks and the GUI
      // index see a live CLI turn and don't target it with a concurrent write.
      // The terminal assistant/error persist (or cancel) resets it to idle.
      // skipIfBusy guards against a run that started between the check above and
      // this write; a null return means we lost the race and must abort.
      const promptWrite = appendConversationMessages(
        appHome,
        conversationId,
        [{ role: 'user', content: userContent }],
        { skipIfBusy: true, runStatus: 'running' },
      );
      if (!promptWrite) return { ok: false, error: 'conversation-busy' };

      const updated = readConversation(appHome, conversationId);
      if (!updated) return { ok: false, error: 'conversation-not-found' };
      const { tree, headId } = ensureConversationTree(updated);
      const branch = getConversationBranch(tree, headId);

      // Flag this turn for server-side assistant persistence — the CLI/headless
      // client won't write the reply itself. streamHandler binds this to the
      // run's token so a later superseding run can't inherit it. Capture the
      // post-user head as the intended parent for the assistant reply so a
      // mid-run branch change doesn't reparent it.
      pendingServerPersist.add(conversationId);
      pendingServerPersistParent.set(conversationId, headId);

      await streamHandler(
        event,
        conversationId,
        branch,
        opts?.modelKey ?? updated.selectedModelKey ?? undefined,
        opts?.reasoningEffort,
        opts?.profileKey ?? updated.selectedProfileKey ?? undefined,
        opts?.fallbackEnabled ?? updated.fallbackEnabled,
        opts?.cwd ?? updated.currentWorkingDirectory ?? undefined,
        opts?.executionMode,
      );
      return { ok: true, conversationId };
    },
  );

  // Whether a live agent run (interactive stream, CLI/server-persisted submit, or
  // a pending pre-toolsReady submit) currently owns this conversation. The GUI
  // uses this to avoid clearing a `running` conversation it doesn't have a local
  // accumulator for (a headless CLI run it just connected to). Complements
  // automations.inFlight (automation runs). Does NOT cover automation runs — the
  // renderer checks both.
  ipcMain.handle('agent:in-flight', (_event, conversationId: string): boolean => {
    return activeStreams.has(conversationId) || currentPendingSubmit.has(conversationId);
  });

  ipcMain.handle('agent:cancel-stream', async (_event, conversationId: string) => {
    // Cancel a submit still waiting on toolsReady (no activeStreams entry yet)
    // so it bails after the await instead of starting a run for a gone client.
    const pendingSubmitId = currentPendingSubmit.get(conversationId);
    if (pendingSubmitId !== undefined) {
      cancelledSubmits.add(pendingSubmitId);
      currentPendingSubmit.delete(conversationId);
    }
    const controller = activeStreams.get(conversationId);
    if (controller) {
      controller.abort();
      // Delete only the entry we just aborted (guard against a race where a
      // replacement run already took over).
      deleteStreamIfOwned(conversationId, controller.token);
      activeStreamModelKeys.delete(conversationId);
    }
    activeObserverSessions.delete(conversationId);
    // Drop any server-side persistence accumulation + ownership for a cancelled
    // turn, and reset a CLI turn's runStatus so it doesn't look stuck 'running'.
    pendingServerPersist.delete(conversationId);
    pendingServerPersistParent.delete(conversationId);
    serverPersistParents.delete(conversationId);
    const wasServerPersist = serverPersistTokens.delete(conversationId);
    if (wasServerPersist) {
      discardPersistenceAccumulator(conversationId);
      try {
        const conv = readConversation(appHome, conversationId);
        if (conv && conv.runStatus === 'running') {
          conv.runStatus = 'idle';
          writeConversation(appHome, conv);
          broadcastUpsert(appHome, conv);
        }
      } catch {
        // best-effort
      }
      // Tell any GUI watching this CLI-owned turn that the stream ended, so it
      // drops its live accumulator + running indicator (it only clears on a
      // terminal event, and ignores conversation upserts while accumulating).
      // Tag serverPersisted explicitly so the renderer takes its render-only
      // path (the token is already cleared, so the auto-tagger wouldn't).
      broadcastStreamEventRaw({ conversationId, type: 'done', serverPersisted: true, data: { cancelled: true } });
    }
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
    // Only stash answers if there's actually a pending approval to resolve; a
    // stale toolCallId (already dismissed/aborted) would otherwise leave an
    // orphaned pendingQuestionAnswers entry that the terminated tool never reads.
    const pending = pendingToolApprovals.get(toolCallId);
    if (pending) {
      stashQuestionAnswers(toolCallId, answers);
      pending.resolve(true);
      pendingToolApprovals.delete(toolCallId);
    }
    return { ok: true };
  });

  ipcMain.handle(
    'agent:generate-title',
    async (_event, messages: unknown[], modelKey?: string, hint?: string, conversationId?: string) => {
      let config: AppConfig;
      try {
        config = readEffectiveConfig(appHome);
      } catch {
        return { title: null };
      }

      // Title generation sends the user's prompt to a model too, so when hook
      // enforcement is active it must pass through the same UserPromptSubmit gate
      // (shared with the CLI auto-title path). A `deny` returns
      // { title: null, suppressed: true } so the renderer does NOT fall back to
      // deriving a title from the raw messages; a `modify` rewrites the messages.
      const gated = await gateTitleGenerationMessages(messages, config, conversationId ?? '', modelKey);
      if (gated.suppressed) return { title: null, suppressed: true };
      const effectiveMessages = gated.messages;

      const input = buildTitleGenerationInput(effectiveMessages);
      if (!input) return { title: null };

      const hasImages = messagesContainImages(effectiveMessages);

      const promptParts = [
        'Generate a concise conversation title using at most 4 words.',
        "Summarize the user's main topic or task, not the assistant's answer.",
        'Use a neutral noun phrase, not a sentence.',
        'Avoid apologies, disclaimers, or copied response text.',
        'Return only the title text with no quotes or formatting.',
      ];

      if (hasImages) {
        promptParts.push(
          'The user attached one or more images. [Image] is a placeholder — do not treat it as literal text.',
          'If the user\'s text is a short generic phrase like "read this image" or "what is this", title it based on the action, e.g. "Image Analysis" or "Analyze Image".',
          'Never generate text that refers to not seeing an image or being unable to view it.',
        );
      }

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
      });

      return { title };
    },
  );

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
      // Determine the active runtime. If a plugin inference provider is active
      // and the current model belongs to it, report the plugin name.
      const inferenceProvider = pluginManager?.getInferenceProvider() ?? null;
      if (inferenceProvider && inferenceProvider.isAvailable()) {
        const defaultModelKey = config.models.defaultModelKey;
        const rawEntry = config.models.catalog.find((m) => m.key === defaultModelKey);
        if (rawEntry) {
          // Check with context to see if the plugin owns this model
          const contextualProvider =
            pluginManager?.getInferenceProvider({
              modelProviderKey: rawEntry.provider,
            }) ?? null;
          if (contextualProvider) {
            return contextualProvider.name;
          }
        }
      }
      return getActiveRuntimeId(config);
    } catch {
      return 'mastra';
    }
  });
}
