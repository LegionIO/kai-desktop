import { randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { Notification } from 'electron';
import { generateForPlugin, streamForPlugin } from '../agent/plugin-generate.js';
import type { PluginGenerateToolCall } from '../agent/plugin-generate.js';
import type { StreamEvent } from '../agent/mastra-agent.js';
import { broadcastAgentStreamEvent } from '../ipc/agent.js';
import { enqueueInject, hasInjects, drainInjects } from '../agent/inject-queue.js';
import type { AppConfig, AutomationAction, AutomationRule } from '../config/schema.js';

// TEMP debug (alert-resume / runAgentAction path). Remove once diagnosed.
const ACTIONS_DEBUG_LOG = join(import.meta.dirname, '../../debug-logs/alerts.log');
function actionsDebug(msg: string): void {
  try {
    appendFileSync(ACTIONS_DEBUG_LOG, `[${new Date().toISOString()}] [actions] ${msg}\n`);
  } catch {
    /* best-effort */
  }
}
import {
  appendConversationMessages,
  broadcastUpsert,
  ensureConversationTree,
  getConversationBranch,
} from '../ipc/conversations.js';
import { readIndex, readConversation, writeConversation } from '../ipc/conversation-store.js';
import type { ConversationRecord } from '../ipc/conversation-store.js';
import type { PluginActionPayload } from '../plugins/types.js';
import type { ToolDefinition } from '../tools/types.js';
import { getPath } from './conditions.js';
import type { AutomationEventBus } from './event-bus.js';
import type { AutomationActionResult, AutomationEvent, AutomationRunRecord } from './types.js';

export type ActionDeps = {
  bus: AutomationEventBus;
  appHome: string;
  getConfig: () => AppConfig;
  getRegisteredTools: () => ToolDefinition[];
  getWorkspaceTools: () => ToolDefinition[];
  handlePluginAction: (payload: PluginActionPayload) => Promise<unknown>;
  /**
   * Inject a user turn into a BUSY target conversation and restart its stream
   * (mid-turn follow-up behavior — the in-flight run is aborted+restarted with
   * the combined branch). Bound to agent.ts's injectUserTurnAndRestart. When
   * absent (or the rule opts out via onBusyTarget:'divert'), a busy target
   * diverts to a new chat as before.
   */
  injectUserTurnAndRestart?: (
    conversationId: string,
    userText: string,
    opts?: { modelKey?: string; reasoningEffort?: string; profileKey?: string; cwd?: string },
  ) => Promise<{ ok: boolean; error?: string; injectedCooperatively?: boolean }>;
};

type InterpolationCtx = { payload: unknown; result: unknown[]; source?: string; event?: string };

const inFlightAutomationTargets = new Set<string>();

/** Abort controllers for in-flight agent runs, keyed by target conversationId.
 * Lets the renderer's stop button interrupt a live automation run. */
const automationRunAborts = new Map<string, AbortController>();

/** True while an automation agent run is actively streaming into this conversation. */
export function isAutomationRunInFlight(conversationId: string): boolean {
  return inFlightAutomationTargets.has(conversationId);
}

/** Abort the in-flight automation run streaming into this conversation, if any. */
export function abortAutomationRun(conversationId: string): boolean {
  const controller = automationRunAborts.get(conversationId);
  if (!controller) return false;
  controller.abort();
  return true;
}

/**
 * Wait (bounded) until no automation run is in flight for this conversation — its
 * finally block has flushed the reply + cleared inFlightAutomationTargets. Used
 * before a forced fresh turn (alert resume) so the answer runs AFTER the prior
 * run finishes, not racing/stranded against its final step. Proceeds on timeout.
 */
async function waitForAutomationRunToSettle(conversationId: string, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (isAutomationRunInFlight(conversationId) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
  }
}

/**
 * Run one agent turn on an EXISTING conversation with a plain-text prompt, reusing
 * the automation agent-run machinery (append user turn → stream response → persist
 * → broadcast live). Used by the Alerts feature to RESUME a suspended run after the
 * user answers a question / decides an approval: the answer is re-injected as a new
 * user message and the agent continues from there.
 *
 * Thin wrapper over `runAgentAction`: it synthesizes a minimal `agent` action
 * targeting `conversationId` (mode:'conversation', tools on, history included) plus
 * a synthetic rule/event/ctx. The prompt is passed as a literal (no `{{ }}`
 * interpolation) so answer text can't be misread as a template.
 */
export async function resumeConversationWithMessage(
  conversationId: string,
  promptText: string,
  deps: ActionDeps,
  opts?: { modelKey?: string; profileKey?: string; tools?: boolean },
): Promise<unknown> {
  const action: Extract<AutomationAction, { type: 'agent' }> = {
    type: 'agent',
    mode: 'conversation',
    prompt: promptText,
    tools: opts?.tools ?? true,
    conversationTarget: { type: 'existing', conversationId },
    includeHistory: true,
    onBusyTarget: 'inject',
    ...(opts?.modelKey ? { modelKey: opts.modelKey } : {}),
    ...(opts?.profileKey ? { profileKey: opts.profileKey } : {}),
  };
  const rule: AutomationRule = {
    id: `alert-resume-${conversationId}`,
    name: 'Alert answer',
    enabled: true,
    trigger: { source: 'alerts', event: 'answered' },
    conditions: [],
    conditionMode: 'all',
    actions: [action],
    debounceMs: 0,
  };
  const event: AutomationEvent = {
    key: `alert-resume:${conversationId}`,
    source: 'alerts',
    event: 'answered',
    payload: null,
    ts: Date.now(),
    depth: 0,
  };
  // Empty ctx: the prompt is a literal, no template substitution wanted.
  const ctx: InterpolationCtx = { payload: null, result: [], source: 'alerts', event: 'answered' };
  return runAgentAction(action, ctx, rule, event, deps, {
    literalPrompt: true,
    strictExistingTarget: true,
    forceFreshTurn: true,
  });
}

const TEMPLATE_RE = /\{\{\s*([^}]+?)\s*\}\}/g;
/** Cap the template length: the `{{…}}` regex is quadratic on many unmatched
 *  `{{`, so a pathological user template shouldn't be able to pin the main
 *  thread. Templates are user-authored config; a real one is tiny. */
const MAX_TEMPLATE_BYTES = 16 * 1024;
/** Cap a single interpolated value so a huge (untrusted) payload field can't
 *  inflate the output into tool input / notification / prompt. */
const MAX_INTERPOLATED_VALUE_BYTES = 32 * 1024;

export function interpolateString(template: string, ctx: InterpolationCtx): string {
  // Over-long template → leave it literal rather than run the quadratic scan.
  if (template.length > MAX_TEMPLATE_BYTES) return template;
  return template.replace(TEMPLATE_RE, (_, path: string) => {
    const value = getPath(ctx, path.trim());
    if (value === undefined || value === null) return '';
    const str = typeof value === 'string' ? value : JSON.stringify(value);
    return str.length > MAX_INTERPOLATED_VALUE_BYTES ? str.slice(0, MAX_INTERPOLATED_VALUE_BYTES) : str;
  });
}

function interpolateDeep<T>(value: T, ctx: InterpolationCtx): T {
  if (typeof value === 'string') return interpolateString(value, ctx) as T;
  if (Array.isArray(value)) return value.map((v) => interpolateDeep(v, ctx)) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = interpolateDeep(v, ctx);
    return out as T;
  }
  return value;
}

function createAutomationConversation(
  appHome: string,
  rule: AutomationRule,
  action: Extract<AutomationAction, { type: 'agent' }>,
  title: string,
  singleton: boolean,
): string {
  const now = new Date().toISOString();
  const id = `auto-${randomUUID()}`;
  const conv: ConversationRecord = {
    id,
    title,
    fallbackTitle: title,
    messages: [],
    messageTree: [],
    headId: null,
    conversationCompaction: null,
    lastContextUsage: null,
    createdAt: now,
    updatedAt: now,
    lastMessageAt: null,
    titleStatus: 'ready',
    titleUpdatedAt: now,
    messageCount: 0,
    userMessageCount: 0,
    runStatus: 'idle',
    hasUnread: true,
    lastAssistantUpdateAt: null,
    selectedModelKey: action.modelKey ?? null,
    selectedProfileKey: action.profileKey ?? null,
    metadata: { automationRuleId: rule.id, automationSingleton: singleton },
  };
  writeConversation(appHome, conv);
  broadcastUpsert(appHome, conv);
  return id;
}

function resolveConversationTarget(
  action: Extract<AutomationAction, { type: 'agent' }>,
  rule: AutomationRule,
  appHome: string,
  title: string,
  canInject: boolean,
): { targetId: string; created: boolean } | { busyInject: string } | null {
  const target = action.conversationTarget;
  if (target.type === 'per-invocation') return null;

  const isBusy = (c: { id: string; runStatus?: string }) =>
    c.runStatus === 'running' || c.runStatus === 'awaiting-approval' || inFlightAutomationTargets.has(c.id);
  // A busy target injects a mid-turn follow-up (abort+restart) instead of
  // diverting to a new chat, unless the rule opts out (onBusyTarget:'divert')
  // or no inject helper is bound.
  const injectOnBusy = canInject && action.onBusyTarget !== 'divert';

  if (target.type === 'existing') {
    const conv = readConversation(appHome, target.conversationId);
    if (!conv) {
      console.warn(
        `[automations] rule "${rule.name}" targets missing conversation ${target.conversationId}; creating a new one`,
      );
      return null;
    }
    if (isBusy(conv)) {
      if (injectOnBusy) {
        console.info(`[automations] rule "${rule.name}" target ${target.conversationId} busy; injecting mid-turn`);
        return { busyInject: target.conversationId };
      }
      console.warn(
        `[automations] rule "${rule.name}" target ${target.conversationId} is busy (${conv.runStatus}); diverting`,
      );
      return null;
    }
    return { targetId: target.conversationId, created: false };
  }

  // Singleton lookup uses the lightweight index (metadata + runStatus + id are all
  // in the index entry — no need to load message bodies).
  for (const conv of Object.values(readIndex(appHome).conversations)) {
    const meta = conv.metadata as { automationRuleId?: unknown; automationSingleton?: unknown } | undefined;
    if (meta?.automationRuleId === rule.id && meta?.automationSingleton === true) {
      if (isBusy(conv)) {
        if (injectOnBusy) {
          console.info(`[automations] rule "${rule.name}" singleton ${conv.id} busy; injecting mid-turn`);
          return { busyInject: conv.id };
        }
        console.warn(`[automations] rule "${rule.name}" singleton ${conv.id} is busy (${conv.runStatus}); diverting`);
        return null;
      }
      return { targetId: conv.id, created: false };
    }
  }
  // Reserve the singleton synchronously so concurrent first-runs converge on one id.
  return { targetId: createAutomationConversation(appHome, rule, action, title, true), created: true };
}

async function runAgentAction(
  action: Extract<AutomationAction, { type: 'agent' }>,
  ctx: InterpolationCtx,
  rule: AutomationRule,
  event: AutomationEvent,
  deps: ActionDeps,
  opts?: {
    /** Treat `action.prompt` as literal text — skip `{{ }}` interpolation (used
     *  by alert resume, where the user's answer must not be read as a template). */
    literalPrompt?: boolean;
    /** For `{type:'existing'}`: if the target is missing/busy, THROW instead of
     *  silently diverting to a new conversation (which would misroute the turn). */
    strictExistingTarget?: boolean;
    /** Drain-at-end re-run: the follow-up user turn(s) are ALREADY persisted to
     *  the branch (a mid-turn inject that arrived after the running turn's final
     *  step boundary, so prepareStep never spliced it). Run a turn on the current
     *  branch WITHOUT appending a new user prompt. Bounded by the caller to avoid
     *  loops. */
    continueOnBranch?: boolean;
    /** Remaining drain-at-end continuations allowed (loop guard). Defaults to a
     *  small cap; each stranded-inject continuation decrements it. */
    continueBudget?: number;
    /** Force a GUARANTEED fresh turn even if the target is busy: an alert answer
     *  MUST be processed (not cooperatively enqueued, which can strand it if the
     *  in-flight run is on its final step and never re-splices). When busy, wait
     *  for the in-flight run to settle, then run a normal turn that appends the
     *  answer + responds. */
    forceFreshTurn?: boolean;
  },
): Promise<unknown> {
  const config = deps.getConfig();
  const prompt = opts?.literalPrompt ? action.prompt : interpolateString(action.prompt, ctx);
  const tools = action.tools ? deps.getRegisteredTools() : [];
  const title = action.conversationTitle ? interpolateString(action.conversationTitle, ctx) : rule.name;

  // Background mode has no conversation to stream into — keep the simple
  // collect-and-return path.
  if (action.mode !== 'conversation') {
    const result = await generateForPlugin({
      messages: [{ role: 'user', content: prompt }],
      config,
      appHome: deps.appHome,
      modelKey: action.modelKey,
      profileKey: action.profileKey,
      fallbackEnabled: Boolean(action.profileKey),
      tools,
    });
    return { text: result.text, modelKey: result.modelKey, toolCalls: result.toolCalls };
  }

  const canInject = typeof deps.injectUserTurnAndRestart === 'function';
  let resolved = resolveConversationTarget(action, rule, deps.appHome, title, canInject);
  actionsDebug(
    `runAgentAction resolve target=${JSON.stringify(action.conversationTarget)} forceFreshTurn=${!!opts?.forceFreshTurn} canInject=${canInject} → resolved=${JSON.stringify(resolved)}`,
  );

  // Alert resume (forceFreshTurn): a busy target must NOT cooperatively enqueue
  // (that can strand the answer if the in-flight run is on its final step). Wait
  // for the run to settle, then RE-RESOLVE — the conversation is now idle, so the
  // normal existing-target path below appends the answer + runs a real turn.
  if (opts?.forceFreshTurn && action.conversationTarget?.type === 'existing') {
    const targetConvId = action.conversationTarget.conversationId;
    const busyish = resolved && 'busyInject' in resolved;
    const strandedNull = resolved === null && !!readConversation(deps.appHome, targetConvId);
    if (busyish || strandedNull) {
      actionsDebug(
        `forceFreshTurn: target busy/stranded (${JSON.stringify(resolved)}), waiting to settle conv=${targetConvId}`,
      );
      await waitForAutomationRunToSettle(targetConvId);
      resolved = resolveConversationTarget(action, rule, deps.appHome, title, canInject);
      actionsDebug(`forceFreshTurn: after settle re-resolved=${JSON.stringify(resolved)}`);
      // Still not a clean target AND no automation run is actually in flight →
      // the conversation's runStatus is STUCK 'running' (a live turn that
      // suspended to raise this alert never reset it). A resume answers a
      // persisted alert, so the raising turn is definitively over — force-clear
      // the stale status and re-resolve so the answer runs a real turn instead of
      // being enqueued / diverted.
      const stillBad = !resolved || 'busyInject' in resolved;
      if (stillBad && !isAutomationRunInFlight(targetConvId)) {
        try {
          const stuck = readConversation(deps.appHome, targetConvId);
          if (stuck && (stuck.runStatus === 'running' || stuck.runStatus === 'awaiting-approval')) {
            actionsDebug(`forceFreshTurn: force-clearing stuck runStatus=${stuck.runStatus} conv=${targetConvId}`);
            writeConversation(deps.appHome, { ...stuck, runStatus: 'idle' });
            resolved = resolveConversationTarget(action, rule, deps.appHome, title, canInject);
            actionsDebug(`forceFreshTurn: after force-clear re-resolved=${JSON.stringify(resolved)}`);
          }
        } catch (err) {
          actionsDebug(`forceFreshTurn: force-clear failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
  }

  // Busy target + inject enabled: append this prompt as a mid-turn follow-up and
  // restart the stream (abort+restart with the combined branch), reusing the
  // GUI/CLI stream path. Do NOT go through streamForPlugin or reserve
  // inFlightAutomationTargets — the injected run is owned by activeStreams /
  // streamHandler, and its assistant reply is written by the server-persist
  // accumulator. The literal (already-interpolated) prompt is passed as-is.
  if (resolved && 'busyInject' in resolved) {
    const targetConvId = resolved.busyInject;

    // An in-flight AUTOMATION run is always the Mastra runtime (streamForPlugin
    // drives streamAgentResponse directly — never a CLI runtime adapter), so it
    // supports cooperative step-boundary injection. Enqueue the follow-up + write
    // the user turn; the running turn's prepareStep hook splices it at its next
    // step boundary. NO abort — the partial turn continues, the model sees the
    // new message in the SAME turn.
    if (isAutomationRunInFlight(targetConvId)) {
      enqueueInject(targetConvId, prompt);
      const write = appendConversationMessages(
        deps.appHome,
        targetConvId,
        [{ role: 'user', content: [{ type: 'text', text: prompt }], createdAt: new Date().toISOString() }],
        { runStatus: 'running' }, // still live — extending the turn
      );
      if (!write) {
        throw new Error(`mid-turn injection into ${targetConvId} failed: conversation missing`);
      }
      broadcastAgentStreamEvent({ conversationId: targetConvId, type: 'user-message', text: prompt });
      return { injectedInto: targetConvId, ok: true };
    }

    // Otherwise the busy target is held by an activeStreams run (a GUI /
    // agent:submit turn). injectUserTurnAndRestart routes it: cooperative splice
    // if that run is Mastra, else abort+restart-with-preserved-partial for a CLI
    // runtime. It handles the activeStreams-owned partial itself.
    const res = await deps.injectUserTurnAndRestart!(targetConvId, prompt, {
      modelKey: action.modelKey,
      profileKey: action.profileKey,
    });
    // Surface a failed injection as a failed action (don't record ok:false as
    // success) so e.g. an alert answer that couldn't be delivered isn't lost.
    if (!res.ok) {
      throw new Error(`mid-turn injection into ${targetConvId} failed: ${res.error ?? 'unknown error'}`);
    }
    return { injectedInto: targetConvId, ok: true };
  }

  if (opts?.strictExistingTarget && action.conversationTarget?.type === 'existing' && !resolved) {
    // The caller demanded a specific existing conversation but it's gone/busy.
    // Diverting to a new chat would misroute the turn (e.g. an answered alert),
    // so fail loudly rather than silently spawn a duplicate. (A busyInject
    // resolve is handled above and is the desired outcome for a busy target.)
    const targetId =
      action.conversationTarget.type === 'existing' ? action.conversationTarget.conversationId : '(unknown)';
    throw new Error(`Target conversation ${targetId} is missing or busy; not diverting to a new conversation.`);
  }
  // Ensure a target conversation exists up front so the user prompt (and the
  // live stream) can render immediately instead of after generation. (busyInject
  // was handled + returned above, so `resolved` here is a target or null.)
  const target = resolved && 'targetId' in resolved ? resolved : null;
  let conversationId = target?.targetId ?? createAutomationConversation(deps.appHome, rule, action, title, false);
  let created = target ? (target.created ?? false) : true;
  inFlightAutomationTargets.add(conversationId);

  const abortController = new AbortController();
  automationRunAborts.set(conversationId, abortController);

  let turnSucceeded = false;
  let turnResult: unknown;
  try {
    // Build the model input (optionally including prior history), then write the
    // user prompt turn immediately with runStatus:'running' so the conversation
    // shows the prompt + a working indicator during generation.
    let messages: Array<{ role: string; content: unknown }> = [{ role: 'user', content: prompt }];
    const existing = readConversation(deps.appHome, conversationId);
    let parentId: string | null | undefined;
    if (existing) {
      const { tree, headId } = ensureConversationTree(existing);
      parentId = headId;
      if (action.includeHistory || opts?.continueOnBranch) {
        const branch = getConversationBranch(tree, headId);
        const HISTORY_PART_TYPES = new Set(['text', 'image']);
        const history = branch
          .map((m) => ({
            role: m.role,
            content: Array.isArray(m.content)
              ? (m.content as Array<{ type?: unknown }>).filter(
                  (p) => typeof p?.type === 'string' && HISTORY_PART_TYPES.has(p.type),
                )
              : m.content,
          }))
          .filter((m) => (Array.isArray(m.content) ? m.content.length > 0 : Boolean(m.content)))
          .slice(-40);
        // continueOnBranch: the follow-up user turn is ALREADY the branch head, so
        // the branch IS the full input — do not append another prompt turn.
        messages = opts?.continueOnBranch ? history : [...history, { role: 'user', content: prompt }];
      }
    }

    // continueOnBranch: skip the prompt append (the user turn is already on the
    // branch). Just flip runStatus to running for the continuation turn.
    if (opts?.continueOnBranch) {
      appendConversationMessages(deps.appHome, conversationId, [], { runStatus: 'running' });
    } else {
      actionsDebug(
        `append user turn conv=${conversationId} parentId=${parentId ?? 'null'} continueOnBranch=${!!opts?.continueOnBranch} strict=${!!opts?.strictExistingTarget} prompt="${prompt.slice(0, 60)}"`,
      );
      const promptWrite = appendConversationMessages(
        deps.appHome,
        conversationId,
        [{ role: 'user', content: [{ type: 'text', text: prompt }], createdAt: new Date().toISOString() }],
        // A resume (strictExistingTarget) MUST land in the alert's own
        // conversation — never skip-if-busy (which would then divert to a NEW
        // chat, so the answer vanishes from the thread the user is watching).
        { skipIfBusy: !opts?.strictExistingTarget, parentId, runStatus: 'running' },
      );
      actionsDebug(
        `append result conv=${conversationId} wrote=${Boolean(promptWrite)} newHead=${promptWrite?.headId ?? 'null'}`,
      );
      if (!promptWrite) {
        // Target was genuinely busy (a concurrent run) or deleted mid-flight —
        // divert to a fresh conversation and write the prompt there. NEVER divert
        // a resume (strictExistingTarget): fail loudly instead so the answer isn't
        // silently moved to a new chat the user won't see.
        if (opts?.strictExistingTarget) {
          throw new Error(`resume target ${conversationId} could not be written (missing/busy)`);
        }
        console.warn(
          `[automations] rule "${rule.name}" target ${conversationId} is busy or was deleted; diverting to a new conversation`,
        );
        inFlightAutomationTargets.delete(conversationId);
        automationRunAborts.delete(conversationId);
        conversationId = createAutomationConversation(deps.appHome, rule, action, title, false);
        created = true;
        inFlightAutomationTargets.add(conversationId);
        automationRunAborts.set(conversationId, abortController);
        appendConversationMessages(
          deps.appHome,
          conversationId,
          [{ role: 'user', content: [{ type: 'text', text: prompt }], createdAt: new Date().toISOString() }],
          { parentId: null, runStatus: 'running' },
        );
      }
    }
    const userTurnHeadId = readConversation(deps.appHome, conversationId)?.headId ?? parentId ?? null;

    // Stream the model response, broadcasting each event tagged `automation` so
    // the renderer renders it live in this conversation but defers persistence
    // to us (the main process owns this conversation's on-disk write). We build
    // the assistant content parts (text interleaved with tool-call parts) in
    // stream order so the PERSISTED message matches what rendered live — clicking
    // away and back must still show the tool calls, not just the final text.
    type ToolCallPart = {
      type: 'tool-call';
      toolCallId: string;
      toolName: string;
      args: unknown;
      argsText: string;
      startedAt: string;
      result?: unknown;
      error?: string;
      finishedAt?: string;
    };
    type TextPart = { type: 'text'; text: string };
    const contentParts: Array<TextPart | ToolCallPart> = [];
    const toolPartById = new Map<string, ToolCallPart>();
    let text = '';
    let error: string | null = null;
    let caughtStreamError = false;
    let modelKey = '';
    let lastEventWasToolResult = false;
    const toolCalls: PluginGenerateToolCall[] = [];
    const pendingToolCalls = new Map<string, { toolName: string; args: unknown; startedAt: number }>();

    const appendTextPart = (delta: string): void => {
      const last = contentParts[contentParts.length - 1];
      if (last && last.type === 'text') last.text += delta;
      else contentParts.push({ type: 'text', text: delta });
    };

    // The stream (and its setup, e.g. resolving a model) can throw. If it does
    // AFTER we've written the prompt turn, we must still finalize: write an
    // assistant (error) turn, flip runStatus back to idle, and broadcast a
    // terminal `done` — otherwise the conversation is stuck `running` forever
    // with no reply. Catch here and fall through to the shared finalize path.
    try {
      for await (const ev of streamForPlugin({
        messages,
        config,
        appHome: deps.appHome,
        conversationId,
        modelKey: action.modelKey,
        profileKey: action.profileKey,
        fallbackEnabled: Boolean(action.profileKey),
        tools,
        abortSignal: abortController.signal,
      })) {
        // Don't forward the inner stream's `done` — the renderer treats an
        // automation `done` as terminal (clears + reloads). We broadcast exactly
        // one terminal `done` AFTER the authoritative append below. Consume the
        // inner done only for its modelKey.
        if (ev.type === 'done') {
          modelKey = (ev as { modelKey?: string }).modelKey ?? modelKey;
          continue;
        }
        broadcastAgentStreamEvent({ ...(ev as StreamEvent), conversationId, automation: true });

        if (ev.type === 'text-delta' && ev.text) {
          if (lastEventWasToolResult && text.length > 0 && !text.endsWith('\n')) {
            text += '\n\n';
            appendTextPart('\n\n');
          }
          text += ev.text;
          appendTextPart(ev.text);
          lastEventWasToolResult = false;
        } else if (ev.type === 'tool-call' && ev.toolCallId) {
          pendingToolCalls.set(ev.toolCallId, {
            toolName: ev.toolName ?? 'unknown',
            args: ev.args,
            startedAt: Date.now(),
          });
          const part: ToolCallPart = {
            type: 'tool-call',
            toolCallId: ev.toolCallId,
            toolName: ev.toolName ?? 'unknown',
            args: ev.args ?? {},
            argsText: JSON.stringify(ev.args ?? {}, null, 2),
            startedAt: new Date().toISOString(),
          };
          toolPartById.set(ev.toolCallId, part);
          contentParts.push(part);
        } else if (ev.type === 'tool-result' && ev.toolCallId) {
          lastEventWasToolResult = true;
          const pending = pendingToolCalls.get(ev.toolCallId);
          toolCalls.push({
            toolName: pending?.toolName ?? ev.toolName ?? 'unknown',
            args: pending?.args ?? {},
            result: ev.result,
            durationMs: pending ? Date.now() - pending.startedAt : undefined,
          });
          const part = toolPartById.get(ev.toolCallId);
          if (part) {
            part.result = ev.result;
            part.finishedAt = new Date().toISOString();
          }
          pendingToolCalls.delete(ev.toolCallId);
        } else if (ev.type === 'tool-error' && ev.toolCallId) {
          const pending = pendingToolCalls.get(ev.toolCallId);
          toolCalls.push({
            toolName: pending?.toolName ?? ev.toolName ?? 'unknown',
            args: pending?.args ?? {},
            result: null,
            error: ev.error ?? 'Tool execution failed',
            durationMs: pending ? Date.now() - pending.startedAt : undefined,
          });
          const part = toolPartById.get(ev.toolCallId);
          if (part) {
            part.error = ev.error ?? 'Tool execution failed';
            part.result = { isError: true, error: ev.error ?? 'Tool execution failed' };
            part.finishedAt = new Date().toISOString();
          }
          pendingToolCalls.delete(ev.toolCallId);
        } else if (ev.type === 'error') {
          error = ev.error ?? 'Unknown error';
        }
      }
    } catch (streamErr) {
      // Setup or mid-stream failure after the prompt was written. Record it and
      // fall through to finalize (assistant turn + idle + terminal done).
      error = streamErr instanceof Error ? streamErr.message : String(streamErr);
      caughtStreamError = true;
    }

    const aborted = abortController.signal.aborted;
    if (!text) {
      // No text was produced — surface a status line so the message isn't empty.
      const fallbackText = aborted ? '_(stopped)_' : error ? `⚠️ ${error}` : '';
      if (fallbackText) appendTextPart(fallbackText);
    } else if (caughtStreamError && error) {
      // Partial text was produced before the throw — append the error so the
      // failure is visible instead of being silently swallowed.
      appendTextPart(`\n\n⚠️ ${error}`);
    }
    const assistantContent = contentParts.length > 0 ? contentParts : [{ type: 'text', text: '' }];

    // Persist the assistant turn (authoritative on-disk write) and return to idle.
    // Persisting the full content parts (text + tool calls) keeps the tool calls
    // visible after the conversation is reloaded from disk.
    //
    // This write MUST NOT be able to leave the conversation stuck at
    // runStatus:'running'. If it throws (disk/index error, or a tool result that
    // won't JSON-serialize), fall back to a minimal idle write, and always
    // broadcast the terminal `done` so the renderer clears its running indicator.
    let appended: ReturnType<typeof appendConversationMessages> = null;
    let finalizeError: unknown = null;
    try {
      appended = appendConversationMessages(
        deps.appHome,
        conversationId,
        [{ role: 'assistant', content: assistantContent, createdAt: new Date().toISOString() }],
        { parentId: userTurnHeadId, runStatus: 'idle' },
      );
    } catch (persistErr) {
      finalizeError = persistErr;
      console.error(`[automations] failed to persist assistant turn for ${conversationId}; forcing idle:`, persistErr);
      // Best-effort: at minimum flip runStatus back to idle so the conversation
      // isn't wedged. Try a plain-text fallback message (drops unserializable
      // tool-call parts), then a status-only write if even that fails.
      try {
        appended = appendConversationMessages(
          deps.appHome,
          conversationId,
          [
            {
              role: 'assistant',
              content: [{ type: 'text', text: text || '⚠️ Automation result could not be saved.' }],
              createdAt: new Date().toISOString(),
            },
          ],
          { parentId: userTurnHeadId, runStatus: 'idle' },
        );
      } catch (fallbackErr) {
        console.error(`[automations] fallback persist also failed for ${conversationId}:`, fallbackErr);
        try {
          appendConversationMessages(deps.appHome, conversationId, [], { runStatus: 'idle' });
        } catch {
          /* give up on disk; the terminal `done` below still unwedges the UI */
        }
      }
    }

    // Tell the renderer the automation stream is finished so it clears the
    // running indicator and reloads the authoritative tree from disk. Emitted
    // even if persistence failed above — otherwise the UI spins forever.
    broadcastAgentStreamEvent({ conversationId, type: 'done', automation: true });

    const emittedTitle = appended?.title ?? appended?.fallbackTitle ?? title;
    deps.bus.emit(
      'conversation',
      created ? 'created' : 'updated',
      { id: conversationId, title: emittedTitle },
      event.depth + 1,
    );

    // Surface a real failure to the engine's run record — but only AFTER the
    // conversation has been finalized above. A thrown stream error (or an
    // `error` event with no output) is a genuine failure; an abort is not. A
    // persistence failure during finalize is also a genuine failure. And a
    // `null` append with no error (appendConversationMessages returns null, not
    // throws, when the target conversation was DELETED mid-stream) means the
    // reply was silently dropped — also a genuine failure, not a success.
    const persistDropped = appended === null && !finalizeError;
    if (!aborted && (caughtStreamError || finalizeError || persistDropped || (error && !text))) {
      const failMsg =
        error ??
        (finalizeError instanceof Error ? finalizeError.message : null) ??
        (persistDropped ? `conversation ${conversationId} was removed before the reply could be saved` : null);
      throw new Error(failMsg ?? 'Automation agent run failed');
    }
    // Success — record whether a stranded mid-turn inject remains for this
    // conversation (an inject that landed after the final step boundary, so
    // prepareStep never spliced it). Handled AFTER the finally clears in-flight
    // state, so the continuation sees an idle conversation.
    turnSucceeded = true;
    turnResult = { text, modelKey, toolCalls, conversationId };
  } finally {
    inFlightAutomationTargets.delete(conversationId);
    automationRunAborts.delete(conversationId);
  }

  // Drain-at-end: a mid-turn inject may have arrived AFTER this turn's final step
  // boundary (so prepareStep never spliced it). Its user turn is already on the
  // branch; now that the turn is done + in-flight state cleared, run one more
  // turn on the current branch to answer it. Bounded to avoid loops.
  const continueBudget = opts?.continueBudget ?? 3;
  if (turnSucceeded && continueBudget > 0 && hasInjects(conversationId)) {
    // Consume the queue so prepareStep on the continuation turn doesn't also
    // re-splice them (they're already persisted on the branch).
    drainInjects(conversationId);
    try {
      // Force the SAME conversation (not per-invocation/singleton re-resolution)
      // and continue on its current branch without appending a new prompt.
      const continueAction = {
        ...action,
        conversationTarget: { type: 'existing' as const, conversationId },
      };
      await runAgentAction(continueAction, ctx, rule, event, deps, {
        ...opts,
        literalPrompt: true, // prompt is unused on a continueOnBranch run
        strictExistingTarget: true,
        continueOnBranch: true,
        continueBudget: continueBudget - 1,
      });
    } catch (contErr) {
      console.warn(
        `[automations] drain-at-end continuation for ${conversationId} failed:`,
        contErr instanceof Error ? contErr.message : contErr,
      );
    }
  }
  return turnResult;
}

async function runSingleAction(
  action: AutomationAction,
  ctx: InterpolationCtx,
  rule: AutomationRule,
  event: AutomationEvent,
  deps: ActionDeps,
): Promise<unknown> {
  switch (action.type) {
    case 'agent':
      return runAgentAction(action, ctx, rule, event, deps);

    case 'plugin-action': {
      const data = action.data ? interpolateDeep(action.data, ctx) : undefined;
      const result = await deps.handlePluginAction({
        pluginName: action.pluginName,
        targetId: action.targetId,
        action: action.action,
        data,
      });
      if (result && typeof result === 'object' && typeof (result as { error?: unknown }).error === 'string') {
        throw new Error(`${action.pluginName}:${action.targetId} → ${(result as { error: string }).error}`);
      }
      return result;
    }

    case 'tool': {
      const tools = [...deps.getRegisteredTools(), ...deps.getWorkspaceTools()];
      const tool = tools.find((t) => t.name === action.toolName || t.aliases?.includes(action.toolName));
      if (!tool) throw new Error(`Tool not found: ${action.toolName}`);
      const input = interpolateDeep(action.input, ctx);
      return tool.execute(input, { toolCallId: `auto-${randomUUID()}` });
    }

    case 'notification': {
      const title = interpolateString(action.title, ctx);
      const body = action.body ? interpolateString(action.body, ctx) : undefined;
      new Notification({ title, body }).show();
      return { title, body };
    }

    case 'emit': {
      const payload = action.payload ? interpolateDeep(action.payload, ctx) : undefined;
      deps.bus.emit(action.source, action.event, payload, event.depth + 1);
      return { emitted: `${action.source}:${action.event}` };
    }

    case 'runHookCommand':
      // runHookCommand actions on `hook:*` triggers are executed inline by the
      // hook dispatcher (electron/agent/hooks/dispatcher.ts) so that block/modify
      // modes can gate the agent synchronously. The automation engine only sees
      // the observe-mode fan-out on the event bus, so this branch is a no-op.
      return { note: 'executed inline by hook dispatcher' };
  }
}

export async function executeActions(
  rule: AutomationRule,
  event: AutomationEvent,
  deps: ActionDeps,
): Promise<AutomationRunRecord> {
  const record: AutomationRunRecord = {
    id: randomUUID(),
    ruleId: rule.id,
    ruleName: rule.name,
    ts: Date.now(),
    event: { key: event.key, source: event.source, event: event.event, payload: event.payload },
    matched: true,
    results: [],
  };

  const ctx: InterpolationCtx = { payload: event.payload, result: [], source: event.source, event: event.event };

  for (const action of rule.actions) {
    const started = Date.now();
    try {
      const output = await runSingleAction(action, ctx, rule, event, deps);
      ctx.result.push(output);
      const result: AutomationActionResult = {
        type: action.type,
        ok: true,
        output,
        durationMs: Date.now() - started,
      };
      record.results.push(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.result.push({ error: message });
      record.results.push({
        type: action.type,
        ok: false,
        error: message,
        durationMs: Date.now() - started,
      });
      record.error = record.error ?? message;
    }
  }

  return record;
}
