import { randomUUID } from 'node:crypto';
import { newDiagnosticCorrelationId, traceDiagnostic } from '../diagnostics/debug-trace.js';
import { Notification } from 'electron';
import { generateForPlugin, streamForPlugin } from '../agent/plugin-generate.js';
import type { PluginGenerateToolCall } from '../agent/plugin-generate.js';
import type { StreamEvent } from '../agent/mastra-agent.js';
import { broadcastAgentStreamEvent } from '../ipc/agent.js';
import { enqueueInject, hasInjects, drainInjects, reenqueueInject, reenqueueFreshAtFront } from '../agent/inject-queue.js';
import type { AppConfig, AutomationAction, AutomationRule } from '../config/schema.js';
import {
  appendConversationMessages,
  broadcastUpsert,
  dropConversationMessages,
  insertConversationMessageBefore,
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

/** Ordered fresh-turn barriers (primarily alert answers) per conversation. Once
 * an answer is queued, later automation events for that same singleton queue
 * behind it instead of overtaking it via true mid-turn injection. Ordinary busy
 * events still inject cooperatively when no barrier exists. */
const orderedConversationTails = new Map<string, Promise<void>>();

function enqueueOrderedConversationTurn<T>(conversationId: string, task: () => Promise<T>): Promise<T> {
  const previous = orderedConversationTails.get(conversationId) ?? Promise.resolve();
  const run = previous.catch(() => {}).then(task);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  orderedConversationTails.set(conversationId, tail);
  void tail.finally(() => {
    if (orderedConversationTails.get(conversationId) === tail) orderedConversationTails.delete(conversationId);
  });
  return run;
}

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
 * run finishes, not racing/stranded against its final step. On timeout it throws;
 * the alert-resume caller re-opens the alert so the recorded answer returns to
 * the Alerts tab for retry rather than being silently dropped. The cap is
 * generous (long tools) but bounded so a wedged run can't pin the queue forever.
 */
async function waitForAutomationRunToSettle(conversationId: string, timeoutMs = 30 * 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (isAutomationRunInFlight(conversationId)) {
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out waiting for automation turn ${conversationId} to settle; alert answer returned for retry`,
      );
    }
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
  opts?: { modelKey?: string; profileKey?: string; tools?: boolean; correlationId?: string },
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
    // Thread the alert's stable correlation id so the resumed agent turn's traces
    // share the alert's `alert-<id>` id (creation → answer → resume all correlate).
    ...(opts?.correlationId ? { correlationId: opts.correlationId } : {}),
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
    /** Internal: this invocation already owns its slot in orderedConversationTails. */
    orderedExecution?: boolean;
    correlationId?: string;
  },
): Promise<unknown> {
  const config = deps.getConfig();
  const correlationId =
    opts?.correlationId ?? newDiagnosticCorrelationId(opts?.forceFreshTurn ? 'alert-resume' : 'automation');
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

  // The conversation this turn will order against, ONLY when it actually targets
  // an existing conversation for injection/resume. A `null` resolution means the
  // target was missing or the rule opted into `divert` (create a new chat) — such
  // turns must NOT join the alert barrier (that would rerun them in the existing
  // conversation instead of diverting). Forced resumes (alert answers) always
  // order against their explicit existing target.
  const orderingConversationId =
    resolved && 'busyInject' in resolved
      ? resolved.busyInject
      : resolved && 'targetId' in resolved
        ? resolved.targetId
        : opts?.forceFreshTurn && action.conversationTarget?.type === 'existing'
          ? action.conversationTarget.conversationId
          : null;
  if (
    !opts?.orderedExecution &&
    orderingConversationId &&
    (opts?.forceFreshTurn || orderedConversationTails.has(orderingConversationId))
  ) {
    // Alert answers create an ordered barrier. Later events for this singleton
    // join the same FIFO instead of overtaking the answer via mid-turn injection.
    traceDiagnostic({
      scope: 'automation',
      event: 'turn.queued',
      correlationId,
      conversationId: orderingConversationId,
      ruleId: rule.id,
      fields: { reason: opts?.forceFreshTurn ? 'alert-resume' : 'ordered-follower' },
    });
    return enqueueOrderedConversationTurn(orderingConversationId, async () => {
      // Alert resumes: the answer is the ONLY in-memory copy while we wait (the
      // alert is already marked answered). Cap the wait so a still-busy run
      // re-opens the alert (via the resume() catch → reopenAlert) and returns it
      // to the Alerts list rather than holding delivery in memory across a long
      // run where a crash would silently lose it. Non-alert ordered followers are
      // re-derivable from their source event, so they keep the generous wait.
      const settleMs = opts?.forceFreshTurn ? 60_000 : undefined;
      try {
        await waitForAutomationRunToSettle(orderingConversationId, settleMs);
      } catch (settleErr) {
        // Alert resume timed out → the caller re-opens the alert (returns it to
        // the Alerts list for re-answer). Do NOT cancel followers already queued
        // behind it: one-shot plugin events (e.g. Teams message-received) are not
        // replayed by AutomationEventBus, so cancelling would permanently lose
        // them. Since the answer is now re-opened (no pending in-memory delivery),
        // letting the followers proceed does not violate answer-before-followers
        // — there is no longer a pending answer to precede. The re-answer, when it
        // arrives, is a genuinely later user action and queues after them.
        if (opts?.forceFreshTurn) {
          traceDiagnostic({
            scope: 'automation',
            event: 'turn.alert-resume-timeout',
            level: 'warn',
            correlationId,
            conversationId: orderingConversationId,
            ruleId: rule.id,
          });
        }
        throw settleErr;
      }
      return runAgentAction(action, ctx, rule, event, deps, {
        ...opts,
        forceFreshTurn: false,
        orderedExecution: true,
        correlationId,
      });
    });
  }

  // An ordered alert/follower resumes after the preceding automation released
  // its in-memory reservation. If disk still says running/awaiting (the raising
  // turn suspended to alert and left a stale flag), clear only that stale status
  // and re-resolve; never inject the ordered turn into a non-existent run.
  if (opts?.orderedExecution && action.conversationTarget?.type === 'existing') {
    const targetId = action.conversationTarget.conversationId;
    if (!isAutomationRunInFlight(targetId)) {
      const stuck = readConversation(deps.appHome, targetId);
      if (stuck && (stuck.runStatus === 'running' || stuck.runStatus === 'awaiting-approval')) {
        writeConversation(deps.appHome, { ...stuck, runStatus: 'idle' });
        resolved = resolveConversationTarget(action, rule, deps.appHome, title, canInject);
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
      const injectId = enqueueInject(targetConvId, prompt);
      if (!injectId) throw new Error(`mid-turn injection into ${targetConvId} failed: could not enqueue`);
      // Display immediately with the stable queue id, but defer authoritative
      // persistence to the running turn's prepareStep consumption boundary so the
      // node parents correctly as: partial assistant → injected user →
      // continuation. (Persisting here instead would parent it on the current disk
      // head, which mid-stream differs from the boundary's parent and forks the
      // branch — the failure mode fixed in round 12.) Trade-off: a crash in the
      // sub-second window before the next step boundary loses this queued event;
      // the drain-at-end path covers the far more common turn-end case.
      traceDiagnostic({
        scope: 'automation',
        event: 'turn.injected',
        correlationId,
        conversationId: targetConvId,
        ruleId: rule.id,
        messageId: injectId,
        fields: { eventKey: event.key },
      });
      broadcastAgentStreamEvent({
        conversationId: targetConvId,
        type: 'user-message',
        text: prompt,
        data: { messageId: injectId },
        // Tag automation-owned so the renderer renders it live but DEFERS
        // persistence to the main process (prepareStep boundary). Without this,
        // an inject arriving before the first automation-tagged event would be
        // treated as renderer-owned and persisted immediately → duplicate/forked
        // user nodes racing the boundary write.
        automation: true,
      });
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
  traceDiagnostic({
    scope: 'automation',
    event: 'turn.start',
    correlationId,
    conversationId,
    ruleId: rule.id,
    fields: { eventKey: event.key, ordered: Boolean(opts?.orderedExecution), created },
  });

  const abortController = new AbortController();
  automationRunAborts.set(conversationId, abortController);

  let turnSucceeded = false;
  let turnResult: unknown;
  let strandedInjects: ReturnType<typeof drainInjects> = [];
  // Injected user turns whose boundary persist failed twice — retried PERSIST-ONLY
  // (never re-fed to the model) in the finally so they aren't lost on reload.
  const failedBoundaryUsers: Array<{ id: string; text: string; at: number }> = [];
  // The finalized terminal-assistant node id (set at finalize) so a recovered
  // injected user can be inserted BEFORE it (user → assistant), not after.
  let finalizedAssistantId: string | null = null;
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
        // Include tool-call parts (with their results) so the model SEES the
        // request_review/ask_user call it made — stripping them (text/image only)
        // made a resumed turn think it never asked → "this answer is fabricated".
        // A tool-call part carries its own result in Kai's stored shape; keep it.
        const HISTORY_PART_TYPES = new Set(['text', 'image', 'tool-call']);
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
    let userTurnHeadId = parentId ?? null;
    if (opts?.continueOnBranch) {
      const statusWrite = appendConversationMessages(deps.appHome, conversationId, [], { runStatus: 'running' });
      userTurnHeadId = statusWrite?.headId ?? userTurnHeadId;
    } else {
      const promptWrite = appendConversationMessages(
        deps.appHome,
        conversationId,
        [{ role: 'user', content: [{ type: 'text', text: prompt }], createdAt: new Date().toISOString() }],
        // A resume (strictExistingTarget) MUST land in the alert's own
        // conversation — never skip-if-busy (which would then divert to a NEW
        // chat, so the answer vanishes from the thread the user is watching).
        { skipIfBusy: !opts?.strictExistingTarget, parentId, runStatus: 'running' },
      );
      if (promptWrite?.headId) userTurnHeadId = promptWrite.headId;
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
        const divertedWrite = appendConversationMessages(
          deps.appHome,
          conversationId,
          [{ role: 'user', content: [{ type: 'text', text: prompt }], createdAt: new Date().toISOString() }],
          { parentId: null, runStatus: 'running' },
        );
        userTurnHeadId = divertedWrite?.headId ?? null;
      }
    }

    traceDiagnostic({
      scope: 'automation',
      event: 'turn.prompt-persisted',
      correlationId,
      conversationId,
      ruleId: rule.id,
      messageId: userTurnHeadId ?? undefined,
      parentMessageId: parentId ?? null,
      fields: { historyMessages: messages.length },
    });

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
    // Text from segments already finalized at mid-turn inject boundaries. The
    // full transcript for the action result / run log / {{result[N].text}} is
    // `committedText + text` — `text` is reset per persisted segment, but the
    // cumulative result must survive inject splits. Model-fallback resets only
    // `text` (current segment), so committedText is unaffected.
    let committedText = '';
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

    // Assistant/user nodes persisted at mid-turn inject boundaries THIS turn, and
    // the branch head just before the first boundary. If the model then falls
    // back (whole response regenerated — e.g. content filter), these are rolled
    // back so discarded/failed segments don't remain on disk as ancestors of the
    // successful retry.
    const boundaryPersistedIds: string[] = [];
    // The actual inject entries consumed at boundaries this turn, so a
    // model-fallback (which regenerates the whole response from the ORIGINAL
    // messages and has already drained the queue) can re-enqueue them for the
    // retry's prepareStep to re-consume — otherwise the follow-up is lost.
    const consumedInjectEntries: Array<{ id: string; text: string; at: number }> = [];
    let preBoundaryParentId: string | null | undefined;
    // prepareStep can fire the inject callback BEFORE the current step's
    // tool-call/result events reach this fullStream consumer. Buffer the entries
    // here and flush (persist the boundary) only at the TOP of the next loop
    // iteration / after the loop, by which point contentParts holds all prior
    // events — so the injected user lands AFTER the completed tool result, not
    // before it.
    let pendingBoundary: Array<{ id: string; text: string; at: number }> = [];

    /** Persist a genuine mid-turn boundary. Called from the stream loop (NOT
     * directly from prepareStep) once the prior step's events are consumed, so all
     * tool-call parts are complete before rotating the accumulator. */
    const flushInjectedBoundary = (entries: Array<{ id: string; text: string; at: number }>): void => {
      if (entries.length === 0) return;
      consumedInjectEntries.push(...entries);
      if (preBoundaryParentId === undefined) preBoundaryParentId = userTurnHeadId;
      traceDiagnostic({
        scope: 'automation',
        event: 'inject.consumed',
        correlationId,
        conversationId,
        ruleId: rule.id,
        parentMessageId: userTurnHeadId,
        fields: { injectIds: entries.map((entry) => entry.id), count: entries.length },
      });
      // Persist the partial assistant. If its content won't serialize (e.g. an
      // exotic tool result), fall back to a text-only assistant so the segment +
      // subsequent injected-user ordering is still recorded.
      if (contentParts.length > 0) {
        // Stable id so a partial commit (file written, index update threw) can be
        // ADOPTED on retry instead of appending a phantom sibling.
        const partialId = `auto-partial-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const partialOnDisk = () =>
          ((readConversation(deps.appHome, conversationId)?.messageTree ?? []) as Array<{ id?: unknown }>).some(
            (m) => m.id === partialId,
          );
        try {
          const partial = appendConversationMessages(
            deps.appHome,
            conversationId,
            [{ id: partialId, role: 'assistant', content: [...contentParts], createdAt: new Date().toISOString() }],
            { parentId: userTurnHeadId, runStatus: 'running' },
          );
          if (partial?.headId) {
            userTurnHeadId = partial.headId;
            boundaryPersistedIds.push(partial.headId);
          }
        } catch (partialErr) {
          // The failed append may have committed the file before throwing. If the
          // partial is already on disk, adopt it (don't append a second sibling).
          if (partialOnDisk()) {
            userTurnHeadId = partialId;
            boundaryPersistedIds.push(partialId);
          } else {
            try {
              const fallback = appendConversationMessages(
                deps.appHome,
                conversationId,
                [
                  {
                    role: 'assistant',
                    content: [{ type: 'text', text: text || '⚠️ (assistant content could not be saved)' }],
                    createdAt: new Date().toISOString(),
                  },
                ],
                { parentId: userTurnHeadId, runStatus: 'running' },
              );
              if (fallback?.headId) {
                userTurnHeadId = fallback.headId;
                boundaryPersistedIds.push(fallback.headId);
              }
            } catch {
              /* give up on the partial; still persist the injected users below */
            }
          }
          traceDiagnostic({
            scope: 'automation',
            event: 'inject.partial-persist-failed',
            level: 'error',
            correlationId,
            conversationId,
            ruleId: rule.id,
            fields: { error: partialErr },
          });
        }
      }
      // Persist the injected user turns. These are plain text so this effectively
      // never fails; if it does, retry ONCE immediately (still before the model's
      // continuation is persisted, so the parent relationship stays
      // …assistant(partial) → user → continuation). We do NOT re-feed the model
      // (it already consumed them) and do NOT defer to `finally` (which would
      // parent the user AFTER the continuation assistant, heading the branch on an
      // apparently-unanswered prompt).
      // Once any entry fails to persist, ALL subsequent entries are deferred to
      // recovery too (without attempting to persist), so failed entries keep their
      // original FIFO position relative to each other rather than being inserted
      // out of order before a later entry that succeeded.
      let boundaryFailed = false;
      for (const entry of entries) {
        if (boundaryFailed) {
          failedBoundaryUsers.push(entry);
          continue;
        }
        const appendUser = () =>
          appendConversationMessages(
            deps.appHome,
            conversationId,
            [
              {
                id: entry.id,
                role: 'user',
                content: [{ type: 'text', text: entry.text }],
                createdAt: new Date(entry.at).toISOString(),
              },
            ],
            { parentId: userTurnHeadId, runStatus: 'running' },
          );
        try {
          // If the inject was already durably persisted at enqueue time (crash
          // safety), ADOPT that node instead of re-appending — re-appending would
          // let appendConversationMessages mint a fresh id and fork a duplicate.
          const existingTree = readConversation(deps.appHome, conversationId)?.messageTree ?? [];
          if ((existingTree as Array<{ id?: unknown }>).some((m) => m.id === entry.id)) {
            userTurnHeadId = entry.id;
            boundaryPersistedIds.push(entry.id);
            continue;
          }
          const injected = appendUser();
          if (injected?.headId) {
            userTurnHeadId = injected.headId;
            boundaryPersistedIds.push(injected.headId);
          }
        } catch (injErr) {
          // The first append may have written the conversation file but thrown
          // while updating the index. Re-appending would let
          // appendConversationMessages mint a NEW id and fork a sibling. Only
          // retry if entry.id is NOT already on disk; otherwise treat it as
          // committed and adopt it as the head.
          const existingTree = readConversation(deps.appHome, conversationId)?.messageTree ?? [];
          const already = (existingTree as Array<{ id?: unknown }>).some((m) => m.id === entry.id);
          if (already) {
            userTurnHeadId = entry.id;
            boundaryPersistedIds.push(entry.id);
          } else {
            try {
              const retried = appendUser();
              if (retried?.headId) {
                userTurnHeadId = retried.headId;
                boundaryPersistedIds.push(retried.headId);
              }
            } catch (retryErr) {
              // The retry may itself have committed the file before throwing on the
              // index update. Recheck: if the id is now on disk, ADOPT it (so the
              // continuation parents after it: user → assistant) rather than
              // treating it as absent (which would fork a sibling and skip it in
              // the final recovery). Otherwise track for a persist-only retry.
              const retriedTree = readConversation(deps.appHome, conversationId)?.messageTree ?? [];
              if ((retriedTree as Array<{ id?: unknown }>).some((m) => m.id === entry.id)) {
                userTurnHeadId = entry.id;
                boundaryPersistedIds.push(entry.id);
              } else {
                // prepareStep already drained the queue. Track for a PERSIST-ONLY
                // end-of-turn retry (see finally) — do NOT re-enqueue here, or this
                // running turn's next prepareStep could re-consume + re-feed the
                // model (double answer / repeated side effects). Mark the boundary
                // failed so subsequent entries are deferred too, preserving FIFO.
                failedBoundaryUsers.push(entry);
                boundaryFailed = true;
                traceDiagnostic({
                  scope: 'automation',
                  event: 'inject.persist-failed',
                  level: 'error',
                  correlationId,
                  conversationId,
                  ruleId: rule.id,
                  fields: { injectId: entry.id, error: retryErr ?? injErr },
                });
              }
            }
          }
        }
      }
      // Preserve this segment's text in the cumulative result before resetting
      // the per-segment accumulator (separator mirrors the tool-result spacing).
      if (text) committedText += (committedText ? '\n\n' : '') + text;
      text = '';
      contentParts.length = 0;
      toolPartById.clear();
      // Keep the cumulative toolCalls result for automation run records even
      // though persistence starts a fresh assistant segment after the inject.
      pendingToolCalls.clear();
      lastEventWasToolResult = false;
      error = null;
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
        // prepareStep may fire this BEFORE the prior step's events reach this
        // loop; buffer, don't persist synchronously. Flushed at the top of each
        // iteration (below) once those events have been consumed.
        onInjected: (entries) => {
          pendingBoundary.push(...entries);
        },
      })) {
        // Flush a buffered inject boundary only when it's provably safe: the next
        // event is NEW-step content (text-delta / tool-call) AND no tool call is
        // still awaiting its result (all prior-step tool-results consumed). This
        // avoids splitting the branch before a buffered tool-result chunk arrives,
        // which would leave the persisted tool call unresolved. A tool-result or
        // done event does NOT trigger a flush (prior step not yet complete).
        if (
          pendingBoundary.length > 0 &&
          pendingToolCalls.size === 0 &&
          (ev.type === 'text-delta' || ev.type === 'tool-call')
        ) {
          const toFlush = pendingBoundary;
          pendingBoundary = [];
          flushInjectedBoundary(toFlush);
        }
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
        } else if (ev.type === 'model-fallback') {
          // A mid-stream fallback restarts the response on the next model. Reset
          // the in-memory accumulators so the collected/persisted result is the
          // successful retry only, not a failed-prefix + success concatenation.
          text = '';
          committedText = '';
          contentParts.length = 0;
          toolPartById.clear();
          toolCalls.length = 0;
          pendingToolCalls.clear();
          lastEventWasToolResult = false;
          error = null;
          // If a mid-turn inject boundary was already persisted this turn, ALWAYS
          // roll it back on fallback — regardless of preserveErroredVariant.
          // Variant preservation would otherwise retain a branch that interleaves
          // an injected USER turn between assistant segments (parent→assistant→
          // user→assistant), but the retry re-branches as parent→user→assistant;
          // RuntimeProvider only surfaces SAME-ROLE siblings as variants, so the
          // retained branch would be unreachable after reload. Discarding it (and
          // re-injecting the follow-up with its original id into the freed slot)
          // keeps a single navigable branch. Variant preservation still applies
          // normally to non-injected turns (handled by the stream layer).
          let rollbackConfirmed = true;
          if (boundaryPersistedIds.length > 0) {
            try {
              dropConversationMessages(deps.appHome, conversationId, [...boundaryPersistedIds], {
                runStatus: 'running',
              });
            } catch {
              /* best effort — verified below */
            }
            // Verify the nodes were actually removed. If the drop threw before
            // committing, some may remain; reusing their ids would make the retry
            // adopt stale failed-branch nodes.
            const remainingTree = (readConversation(deps.appHome, conversationId)?.messageTree ?? []) as Array<{
              id?: unknown;
            }>;
            rollbackConfirmed = !boundaryPersistedIds.some((id) => remainingTree.some((m) => m.id === id));
            traceDiagnostic({
              scope: 'automation',
              event: 'inject.boundary-rolled-back',
              correlationId,
              conversationId,
              ruleId: rule.id,
              fields: { droppedIds: [...boundaryPersistedIds], reason: 'model-fallback', rollbackConfirmed },
            });
            userTurnHeadId = preBoundaryParentId ?? userTurnHeadId;
          }
          boundaryPersistedIds.length = 0;
          preBoundaryParentId = undefined;
          // Re-inject the follow-up for the retry (streamWithFallback restarts from
          // the ORIGINAL messages with the queue already drained, so without this
          // the retry never sees the follow-up). If rollback CONFIRMED the on-disk
          // nodes were removed, reuse the SAME ids into the freed slots (reverse →
          // FIFO). If rollback could NOT be confirmed (stale nodes remain), use
          // FRESH ids so the retry doesn't adopt the stale failed-branch nodes.
          if (consumedInjectEntries.length > 0) {
            if (rollbackConfirmed) {
              for (let i = consumedInjectEntries.length - 1; i >= 0; i -= 1) {
                reenqueueInject(conversationId, consumedInjectEntries[i]);
              }
            } else {
              reenqueueFreshAtFront(
                conversationId,
                consumedInjectEntries.map((entry) => entry.text),
              );
            }
          }
          consumedInjectEntries.length = 0;
        }
      }
      // Flush a boundary buffered on the FINAL step (no further iteration will).
      // Its prior-step events are all consumed by now.
      if (pendingBoundary.length > 0) {
        const toFlush = pendingBoundary;
        pendingBoundary = [];
        flushInjectedBoundary(toFlush);
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
    finalizedAssistantId = appended?.headId ?? null;

    traceDiagnostic({
      scope: 'automation',
      event: 'turn.finalized',
      correlationId,
      conversationId,
      ruleId: rule.id,
      messageId: appended?.headId ?? undefined,
      parentMessageId: userTurnHeadId,
      headId: appended?.headId ?? null,
      level: finalizeError ? 'error' : 'info',
      fields: { aborted, caughtStreamError, persistDropped: appended === null && !finalizeError },
    });

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
    turnSucceeded = true;
    const resultText = committedText && text ? `${committedText}\n\n${text}` : committedText || text;
    turnResult = { text: resultText, modelKey, toolCalls, conversationId };
  } finally {
    inFlightAutomationTargets.delete(conversationId);
    automationRunAborts.delete(conversationId);
    // Persist-only retry for injected user turns whose boundary persist failed
    // twice (the model already consumed them; never re-feed). Idempotent: adopt an
    // already-committed id, else append; best-effort.
    for (const entry of failedBoundaryUsers) {
      try {
        const onDisk = ((readConversation(deps.appHome, conversationId)?.messageTree ?? []) as Array<{ id?: unknown }>).some(
          (m) => m.id === entry.id,
        );
        if (onDisk) continue;
        const userMsg = {
          id: entry.id,
          role: 'user' as const,
          content: [{ type: 'text', text: entry.text }],
          createdAt: new Date(entry.at).toISOString(),
        };
        // The model already answered this user; the terminal assistant is on disk.
        // Insert the user BEFORE it so the stored order is `… → user → assistant`,
        // not `assistant → user` (which would look unanswered). Fall back to a
        // plain append at the head only if the assistant id is unknown.
        if (finalizedAssistantId) {
          insertConversationMessageBefore(deps.appHome, conversationId, userMsg, finalizedAssistantId, {
            runStatus: 'idle',
          });
        } else {
          const head = readConversation(deps.appHome, conversationId)?.headId ?? null;
          appendConversationMessages(deps.appHome, conversationId, [userMsg], { parentId: head, runStatus: 'idle' });
        }
      } catch {
        /* best effort — already traced at the boundary */
      }
    }
    // Persist any leftover queued injects UNCONDITIONALLY (even on stream
    // failure/abort). They were displayed but their authoritative persistence was
    // deferred to prepareStep; if the turn errored before consuming them, this is
    // the only place they land on the branch, so they aren't lost or misrouted
    // into an unrelated later turn. The continuation run (success-only, below)
    // then answers them.
    if (hasInjects(conversationId)) {
      const leftover = drainInjects(conversationId);
      let branchHead = readConversation(deps.appHome, conversationId)?.headId ?? null;
      const persisted: typeof leftover = [];
      const idOnDisk = (id: string): boolean =>
        ((readConversation(deps.appHome, conversationId)?.messageTree ?? []) as Array<{ id?: unknown }>).some(
          (m) => m.id === id,
        );
      const appendEntry = (entry: (typeof leftover)[number]) =>
        appendConversationMessages(
          deps.appHome,
          conversationId,
          [
            {
              id: entry.id,
              role: 'user',
              content: [{ type: 'text', text: entry.text }],
              createdAt: new Date(entry.at).toISOString(),
            },
          ],
          { parentId: branchHead, runStatus: 'idle' },
        );
      for (const entry of leftover) {
        // Idempotent: if a prior attempt committed the conversation file but
        // failed the index update, the id is already on disk — adopt it instead
        // of re-appending (which would mint a fresh id and duplicate the turn).
        if (idOnDisk(entry.id)) {
          branchHead = entry.id;
          persisted.push(entry);
          continue;
        }
        try {
          const injected = appendEntry(entry);
          if (injected?.headId) branchHead = injected.headId;
          persisted.push(entry);
        } catch {
          // Retry once after re-reading (adopt if the first attempt actually
          // committed it); otherwise re-queue this + remaining entries (FIFO).
          if (idOnDisk(entry.id)) {
            branchHead = entry.id;
            persisted.push(entry);
            continue;
          }
          try {
            const retried = appendEntry(entry);
            if (retried?.headId) branchHead = retried.headId;
            persisted.push(entry);
          } catch {
            // The retry may have committed the file before failing the index
            // update — recheck and adopt rather than re-queue (which would let a
            // later turn re-feed the same text). Only re-queue entries genuinely
            // absent from disk.
            if (idOnDisk(entry.id)) {
              branchHead = entry.id;
              persisted.push(entry);
              continue;
            }
            const remaining = leftover.slice(leftover.indexOf(entry)).filter((r) => !idOnDisk(r.id));
            for (let i = remaining.length - 1; i >= 0; i -= 1) reenqueueInject(conversationId, remaining[i]);
            traceDiagnostic({
              scope: 'automation',
              event: 'inject.drain-persist-failed',
              level: 'error',
              correlationId,
              conversationId,
              ruleId: rule.id,
              fields: { injectIds: remaining.map((r) => r.id), count: remaining.length },
            });
            break;
          }
        }
      }
      if (persisted.length > 0) {
        strandedInjects = persisted;
        traceDiagnostic({
          scope: 'automation',
          event: 'inject.drained-at-end',
          correlationId,
          conversationId,
          ruleId: rule.id,
          headId: branchHead,
          fields: {
            injectIds: persisted.map((entry) => entry.id),
            count: persisted.length,
            turnSucceeded,
          },
        });
      }
    }
  }

  // Drain-at-end continuation: only on success, and only if we persisted stranded
  // injects above. The user turns are already on the branch (idle); run one more
  // turn on the current branch to answer them. Bounded to avoid loops.
  const continueBudget = opts?.continueBudget ?? 3;
  if (turnSucceeded && continueBudget > 0 && strandedInjects.length > 0) {
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
