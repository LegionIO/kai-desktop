/**
 * Sub-Agent Execution Engine
 *
 * Runs a child agent as an async generator, yielding stream events back to the caller.
 * The sub-agent has a control tool to signal completion, request input, etc.
 * Multi-turn: the runner loops until the sub-agent signals done or max turns.
 */

import { BrowserWindow } from 'electron';
import { broadcastToWebClients } from '../web-server/web-clients.js';
import { capRemoteEvent } from './remote-frame-cap.js';
import { z } from 'zod';
import {
  streamAgentResponse,
  streamWithFallback,
  getProviderDefinedToolNames,
  buildAgentInstructions,
} from './mastra-agent.js';
import type { StreamEvent } from './mastra-agent.js';
import { hookDispatcher } from './hooks/dispatcher.js';
import type { LLMModelConfig, ResolvedStreamConfig } from './model-catalog.js';
import type { AppConfig } from '../config/schema.js';
import type { ToolDefinition, ToolExecutionContext } from '../tools/types.js';
import {
  ToolObserverManager,
  resolveToolObserverConfig,
  summarizeLatestUserRequest,
  summarizeThreadContext,
} from './tool-observer.js';
import { type MediaFitConfig } from './media-fit.js';
import { createSubAgentMediaFitter, estimateSubAgentStaticTokens } from './sub-agent-media-fit.js';

export type SubAgentEvent =
  | (StreamEvent & { subAgentConversationId: string; parentConversationId: string; parentToolCallId: string })
  | {
      subAgentConversationId: string;
      parentConversationId: string;
      parentToolCallId: string;
      // The sub-agent's own conversation id, mirrored here because the renderer's
      // top-level stream listener reads `conversationId` on EVERY event (for its
      // debug log / active-conversation check) before routing by
      // subAgentConversationId. Omitting it made that read throw and drop the
      // status transition. Always equals subAgentConversationId for these events.
      conversationId: string;
      type: 'sub-agent-status';
      status: 'running' | 'awaiting-input' | 'completed' | 'stopped' | 'failed' | 'paused';
      summary?: string;
      /** For `status: 'paused'`, WHY it paused — so the UI/persistence can tell an
       *  agent that REQUESTED input ('awaiting-input') apart from a non-input pause
       *  (turn-budget exhaustion, or concurrency-cap deferral). Absent for other
       *  statuses. */
      pausedReason?: 'awaiting-input' | 'turn-limit' | 'capacity';
    }
  | {
      subAgentConversationId: string;
      parentConversationId: string;
      parentToolCallId: string;
      conversationId: string;
      type: 'sub-agent-user-message';
      text: string;
      source: 'task' | 'parent' | 'user';
    };

export type SubAgentRunOptions = {
  subAgentConversationId: string;
  parentConversationId: string;
  parentToolCallId: string;
  task: string;
  context?: string;
  depth: number;
  config: AppConfig;
  modelConfig: LLMModelConfig;
  /** When the sub-agent runs under a profile, the resolved chain (primary +
   *  fallbacks). Present → the runner uses streamWithFallback (mid-stream
   *  fallback + errored variants); absent → single-model streamAgentResponse
   *  with `modelConfig`. */
  streamConfig?: ResolvedStreamConfig;
  /** The sub-agent's OWN resolved profile/model keys — threaded to the tool
   *  execution context so a nested `sub_agent` call inherits this sub-agent's
   *  profile/model (not the global default). */
  profileKey?: string | null;
  modelKey?: string | null;
  tools: ToolDefinition[];
  dbPath: string;
  abortSignal?: AbortSignal;
  /** Called between agent turns to check for pending follow-up messages. */
  getFollowUp: () => Promise<string | null>;
  /** Non-destructively report whether a follow-up is currently queued (does NOT
   *  consume). Used at the turn-budget boundary to distinguish "a follow-up is
   *  waiting but no turn remains" (→ paused/resumable, leave it queued) from
   *  "queue empty" (→ normal completion). */
  peekFollowUp?: () => boolean;
  /**
   * Called the MOMENT the sub-agent runs its control tool, before the turn loop
   * emits sub-agent-status. The caller forwards it to the parent turn's
   * tool-progress so a watching parent observer sees a declared completion
   * immediately and stops nudging.
   */
  onControlSignal?: (action: 'complete' | 'failed' | 'awaiting_response' | 'continue', message?: string) => void;
  /**
   * Called with the runner's final (gated + accumulated) message history so the
   * caller can persist SANITIZED history for resume — rather than rebuilding it
   * from the raw task/context, which would let a later resume (after the DLP
   * hook is disabled) send the unredacted content to the model.
   */
  onFinalMessages?: (messages: Array<{ role: string; content: unknown }>) => void;
  /**
   * RESUME seeding. When present, the run starts from this ALREADY-GATED message
   * history (persisted from a prior run) instead of building an initial task
   * message from `task`/`context`. `resumeFollowUp` is the NEW user message to
   * append and gate (only it is gated — the prior history is not re-gated). This
   * routes a resume through the same hardened turn loop / terminal handling as an
   * initial run, so the two share one lifecycle engine.
   */
  resumeMessages?: Array<{ role: string; content: unknown }>;
  resumeFollowUp?: string;
  /**
   * RESUME seeding for the SYSTEM PROMPT. When present, the resumed run uses this
   * ALREADY-GATED system prompt (persisted from the prior run) as its base rather
   * than rebuilding from `config` — so a context-dependent guardrail a
   * UserPromptSubmit hook applied on the original run is preserved across resume,
   * instead of silently reverting to the ungated config prompt. The new follow-up
   * is still gated (and may further modify the prompt).
   */
  resumeSystemPrompt?: string;
  /** Called with the run's FINAL (gated) system prompt so the caller can persist
   *  it for resume (paired with onFinalMessages). Reflects any UserPromptSubmit
   *  hook modification. */
  onFinalSystemPrompt?: (systemPrompt: string) => void;
  /** When true, the caller already reserved a concurrency slot (reserveSubAgentSlot)
   *  and owns releasing it — runSubAgent skips its own increment/decrement AND its
   *  cap check. Used by resume to hold the slot across its awaited DB reopen. */
  slotPreReserved?: boolean;
};

/** Global counter for enforcing maxConcurrent limit */
let activeSubAgentCount = 0;

export function getActiveSubAgentCount(): number {
  return activeSubAgentCount;
}

/** Synchronously reserve a concurrency slot (used by resume, which must hold the
 *  slot across its awaited DB reopen before runSubAgent starts — otherwise
 *  concurrent resumes could all pass admission during that await). Paired with
 *  releaseSubAgentSlot. runSubAgent skips its own inc/dec when slotPreReserved. */
export function reserveSubAgentSlot(): void {
  activeSubAgentCount++;
}
export function releaseSubAgentSlot(): void {
  if (activeSubAgentCount > 0) activeSubAgentCount--;
}

function broadcastSubAgentEvent(event: SubAgentEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('agent:stream-event', event);
  }
  // REMOTE clients are frame-capped (web 4 MiB / CLI 8 MiB) — a sub-agent tool result can retain
  // large media/originals that would exceed a frame and disconnect the socket. Strip the remote
  // copy (same shared cap as the parent stream); local Electron windows get the full event.
  broadcastToWebClients('agent:stream-event', capRemoteEvent(event));
}

/** Sub-agent control signal — set by the sub_agent_control tool */
type ControlSignal = {
  action: 'complete' | 'failed' | 'awaiting_response' | 'continue';
  message?: string;
};

/** Create the virtual control tool that the sub-agent uses to signal state */
function createControlTool(
  signalRef: { current: ControlSignal | null },
  onSignal?: (action: ControlSignal['action'], message?: string) => void,
): ToolDefinition {
  return {
    name: 'sub_agent_control',
    description: [
      'Signal your current state to the parent agent and user.',
      'You MUST call this tool when you have completed your task, encountered a failure,',
      'or need input from the user/parent before continuing.',
      '',
      'Actions:',
      '- "complete": Task is done. Include a summary of what you accomplished.',
      '- "failed": Task cannot be completed. Explain why.',
      '- "awaiting_response": You need input/clarification before continuing. Ask your question in the message.',
      '- "continue": You are not done yet and will keep working (use between multi-step operations).',
    ].join(' '),
    inputSchema: z.object({
      action: z.enum(['complete', 'failed', 'awaiting_response', 'continue']).describe('Your current state'),
      message: z.string().optional().describe('Summary, error explanation, or question for the user'),
    }),
    execute: async (input: unknown, _ctx: ToolExecutionContext): Promise<unknown> => {
      const { action, message } = input as { action: string; message?: string };
      const typedAction = action as ControlSignal['action'];
      signalRef.current = { action: typedAction, message };
      // Surface the signal IMMEDIATELY (at control-tool execute time), so a
      // watching parent observer sees a complete/failed declaration the moment it
      // happens — before the turn loop later emits sub-agent-status — and stops
      // nudging in that window. Observer-only; no lifecycle status is published
      // here (the turn loop owns that after follow-up arbitration).
      onSignal?.(typedAction, message);
      return { acknowledged: true, action, message: message ?? '' };
    },
  };
}

function buildSubAgentSystemPrompt(baseSystemPrompt: string, depth?: number): string {
  const parts = [
    baseSystemPrompt,
    '',
    '--- Sub-Agent Context ---',
    `You are a sub-agent (depth ${depth ?? 0}) spawned to handle a specific task.`,
    'Your assigned task (and any parent context) is provided in the conversation messages below.',
  ];
  parts.push(
    '',
    'Instructions:',
    '- Focus on the assigned task. Use tools as needed.',
    '- You MUST call sub_agent_control with action "complete" when done, or "failed" if you cannot finish.',
    '- If you need user input or clarification, call sub_agent_control with action "awaiting_response".',
    '- For multi-step work, call sub_agent_control with "continue" between major steps if needed.',
    '- The user or parent agent may send you follow-up messages between turns.',
    '- Do NOT just provide a text response without calling sub_agent_control — the system needs the signal.',
  );
  return parts.join('\n');
}

/**
 * The sub-agent's opening user message carries the raw task + parent context.
 * Keeping it in a MESSAGE (not the system prompt) means a UserPromptSubmit DLP
 * modify hook that sanitizes `messages` actually covers it — embedding it in the
 * system prompt would let the raw task leak past a messages-only sanitizer.
 */
export function buildSubAgentTaskMessage(task: string, context?: string): string {
  const parts = [`Your assigned task: ${task}`];
  if (context) parts.push('', 'Additional context from parent agent:', context);
  return parts.join('\n');
}

/**
 * Derive the display text to broadcast for a sub-agent user message from the
 * GATED message content. A UserPromptSubmit modify hook may return a string, an
 * app-native content-part array (e.g. `[{type:'text',text:'[redacted]'}]`), or
 * remove the message entirely. We must NOT fall back to the raw pre-gate text —
 * that would leak content the hook redacted. Returns '' (fail closed) when no
 * sanitized text can be derived, so the broadcast shows nothing rather than raw.
 */
export function sanitizedMessageDisplayText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((p): p is { type?: string; text?: unknown } => !!p && typeof p === 'object')
      .filter((p) => p.type === 'text' || typeof p.text === 'string')
      .map((p) => (typeof p.text === 'string' ? p.text : ''))
      .join('\n');
  }
  return '';
}

export async function* runSubAgent(opts: SubAgentRunOptions): AsyncGenerator<SubAgentEvent> {
  const {
    subAgentConversationId,
    parentConversationId,
    parentToolCallId,
    task,
    context,
    depth,
    config,
    modelConfig,
    streamConfig,
    profileKey,
    modelKey,
    tools,
    dbPath,
    abortSignal,
    getFollowUp,
    peekFollowUp,
    onControlSignal,
    onFinalMessages,
    resumeMessages,
    resumeFollowUp,
    resumeSystemPrompt,
    onFinalSystemPrompt,
    slotPreReserved,
  } = opts;

  const isResume = Array.isArray(resumeMessages);
  const maxConcurrent = config.tools?.subAgents?.maxConcurrent ?? 4;
  // When the caller pre-reserved a slot (resume), it already performed admission
  // synchronously and owns the slot — skip both the cap check AND the inc/dec
  // here. Otherwise (initial run) enforce the cap and manage the counter.
  if (!slotPreReserved && activeSubAgentCount >= maxConcurrent) {
    yield {
      subAgentConversationId,
      parentConversationId,
      parentToolCallId,
      conversationId: subAgentConversationId,
      type: 'error',
      error: `Maximum concurrent sub-agents (${maxConcurrent}) reached.`,
    };
    yield {
      subAgentConversationId,
      parentConversationId,
      parentToolCallId,
      conversationId: subAgentConversationId,
      type: 'done',
    };
    return;
  }

  if (!slotPreReserved) activeSubAgentCount++;

  // Declared in the FUNCTION scope (not the try) so the finally can dispose it on
  // ANY exit — throw, early generator-return, or normal completion — without the
  // "not defined in finally" scope error.
  let subObserver: ToolObserverManager | null = null;
  // Latest GATED message history + system prompt, tracked in function scope so the
  // finally can surface them to the caller even when the run throws AFTER the
  // prompt was gated/broadcast but BEFORE the normal onFinalMessages call. Without
  // this, an early throw (e.g. workspace/model setup) would leave the caller with
  // no gated snapshot, dropping the visible follow-up from resume context.
  let latestGatedMessages: Array<{ role: string; content: unknown }> | null = null;
  let latestGatedSystemPrompt: string | undefined;
  let finalMessagesEmitted = false;

  try {
    // Resume: reuse the persisted, ALREADY-GATED+built system prompt verbatim so
    // a hook's context-dependent guardrail survives (do NOT re-wrap or rebuild
    // from config, which would revert it). Initial run: build from config.
    const systemPrompt =
      isResume && typeof resumeSystemPrompt === 'string'
        ? resumeSystemPrompt
        : buildSubAgentSystemPrompt(config.systemPrompts?.chat?.trim() || config.systemPrompt, depth);
    // Initial run: seed with the task message (gated below). Resume: start from
    // the persisted ALREADY-GATED history and append the new follow-up, which is
    // the only message gated (see gateUserPrompt scoping).
    const messages: Array<{ role: string; content: unknown }> = isResume
      ? [...(resumeMessages ?? []), { role: 'user', content: resumeFollowUp ?? '' }]
      : [{ role: 'user', content: buildSubAgentTaskMessage(task, context) }];

    // Override the system prompt with the sub-agent wrapper. buildAgentInstructions ->
    // resolveModeSystemPrompt PREFERS systemPrompts.chat/.plan over config.systemPrompt, so
    // leaving those set would SHADOW the wrapper with the user's generic chat/plan prompt
    // (losing the sub_agent_control lifecycle guidance + a resume's gated prompt). Clear the
    // per-mode overrides so resolveModeSystemPrompt falls back to our systemPrompt.
    let subAgentConfig: AppConfig = { ...config, systemPrompt, systemPrompts: undefined };

    // Control signal shared with the control tool
    const controlSignal: { current: ControlSignal | null } = { current: null };
    const controlTool = createControlTool(controlSignal, (action, message) => {
      onControlSignal?.(action, message);
    });

    // Inject the control tool into the sub-agent's toolset
    const allTools = [...tools.filter((t) => t.name !== 'sub_agent_control'), controlTool];

    let fullResponseText = '';
    let turnCount = 0;
    const maxTurns = Math.max(config.advanced.maxSteps, 20); // generous turn limit

    // Emit initial status
    const emitStatus = (
      _status: never,
      st: 'running' | 'awaiting-input' | 'completed' | 'stopped' | 'failed' | 'paused',
      summary?: string,
      pausedReason?: 'awaiting-input' | 'turn-limit' | 'capacity',
    ) => {
      const evt: SubAgentEvent = {
        subAgentConversationId,
        parentConversationId,
        parentToolCallId,
        conversationId: subAgentConversationId,
        type: 'sub-agent-status',
        status: st,
        summary,
        ...(pausedReason ? { pausedReason } : {}),
      };
      broadcastSubAgentEvent(evt);
      return evt;
    };

    // Note: don't echo the raw task in this pre-gate status — a DLP hook may
    // redact it below. A generic message here; the sanitized task is broadcast
    // as the user-message after the gate.
    yield emitStatus(undefined as never, 'running', 'Starting task');

    // Gate the sub-agent prompt through UserPromptSubmit BEFORE broadcasting the
    // task to clients, so a DLP block/modify hook can deny/redact it and the raw
    // task never reaches the renderer/web. Enforcement-only (suppressObserve) so
    // a sub-agent turn doesn't re-fire the parent's UserPromptSubmit automations.
    //
    // The hook sees the FULL model-bound history every turn — because that whole
    // history is what gets retransmitted to the model, so a context-dependent or
    // newly-enabled DLP hook MUST be able to block/redact ANY of it (not just the
    // newly-appended message). `gateFromIdx` is used only to pick which message's
    // display text to broadcast (the just-appended one) — NOT to scope the gate.
    const newMessagesStartIdx = isResume ? messages.length - 1 : 0;
    // Identify the NEWLY-submitted user turn for DISPLAY robustly across ANY trusted
    // UserPromptSubmit hook transform. Two independent signals, so a hook that
    // returns a fresh `messages` array (documented to preserve only role/content,
    // dropping our marker) still resolves:
    //  1. An enumerable marker on the new-turn object — survives pass-through,
    //     spreads, and JSON round-trips; unambiguous when present.
    //  2. POSITION fallback tracked OUTSIDE the hook payload: the caller passes the
    //     new turn's index; if the gated array is the SAME LENGTH (a pure redaction
    //     preserves order and count), the new turn is at that same index. If the
    //     length changed (the hook added/removed messages) we can't safely locate
    //     it, so display nothing rather than risk showing an unrelated turn.
    // The marker is stripped from every message after reading, so it never reaches
    // the model or persisted history.
    const NEW_TURN_MARKER = '__kaiNewTurn';
    type Marked = { role: string; content: unknown; [NEW_TURN_MARKER]?: boolean };
    const clearMarkers = (): void => {
      for (const m of messages as Marked[]) {
        if (m && NEW_TURN_MARKER in m) delete m[NEW_TURN_MARKER];
      }
    };
    const markNewTurn = (msg: { role: string; content: unknown }): void => {
      // Clear any prior turn's marker first — only the NEWEST turn carries it.
      clearMarkers();
      (msg as Marked)[NEW_TURN_MARKER] = true;
    };
    const gateUserPrompt = async (
      newTurnIndex: number,
    ): Promise<{ ok: true; displayText: string } | { ok: false; reason: string }> => {
      const preGateLength = messages.length;
      // The marked message's gated content is the display text; else, if the hook
      // returned a same-length (order-preserving) array, the new turn is at its
      // original index; else empty (hook restructured — can't safely identify it).
      const displayFrom = (): string => {
        const marked = (messages as Marked[]).find((m) => m?.[NEW_TURN_MARKER]);
        if (marked) return sanitizedMessageDisplayText(marked.content);
        if (messages.length === preGateLength && newTurnIndex >= 0 && newTurnIndex < messages.length) {
          return sanitizedMessageDisplayText(messages[newTurnIndex]?.content);
        }
        return '';
      };
      if (!hookDispatcher.hasEnforcingHooksFor('UserPromptSubmit')) {
        const text = displayFrom();
        clearMarkers(); // never let the marker reach the model / persistence
        return { ok: true, displayText: text };
      }
      // Send the COMPLETE message history for enforcement. A denial blocks the
      // whole turn; a modify replaces the ENTIRE array with the returned (redacted)
      // messages, so redactions to historical content take effect before streaming.
      const gate = await hookDispatcher.dispatch(
        'UserPromptSubmit',
        {
          conversationId: subAgentConversationId,
          parentConversationId,
          messages,
          systemPrompt: subAgentConfig.systemPrompt,
          modelKey: modelConfig.modelName,
          purpose: isResume ? 'sub-agent-resume' : 'sub-agent',
        },
        { suppressObserve: true },
      );
      if (gate.denied) {
        clearMarkers(); // don't leave the marker on the (to-be-rolled-back) messages
        return { ok: false, reason: gate.reason ?? 'Blocked by a UserPromptSubmit hook.' };
      }
      const gated = gate.payload as { messages?: unknown[]; systemPrompt?: string };
      if (Array.isArray(gated?.messages)) {
        // Replace the WHOLE history with the gated (possibly redacted) version so
        // the model receives exactly what the hook approved.
        messages.length = 0;
        messages.push(...(gated.messages as Array<{ role: string; content: unknown }>));
      }
      if (typeof gated?.systemPrompt === 'string') {
        subAgentConfig = { ...subAgentConfig, systemPrompt: gated.systemPrompt };
      }
      // Read the new-turn's gated display text, THEN strip the marker from every
      // message so it never reaches the model or persisted history.
      const text = displayFrom();
      clearMarkers();
      return { ok: true, displayText: text };
    };

    // Mark the newly-submitted turn (the task for an initial run, or the appended
    // follow-up for a resume) so its gated text can be found for display; also pass
    // its index as the position fallback (used if a hook drops the marker).
    const initialNewTurn = messages[newMessagesStartIdx];
    if (initialNewTurn) markNewTurn(initialNewTurn);
    const initialGate = await gateUserPrompt(newMessagesStartIdx);
    if (!initialGate.ok) {
      yield emitStatus(undefined as never, 'failed', initialGate.reason);
      return;
    }
    // Capture the gated snapshot NOW so an early throw after this point (e.g. in
    // model/workspace setup) still surfaces the gated prompt to the caller via the
    // finally — the visible follow-up isn't dropped from resume context.
    latestGatedMessages = [...messages];
    latestGatedSystemPrompt = subAgentConfig.systemPrompt;

    // Display text of the newly-gated prompt (empty if a DLP hook removed it),
    // returned by the gate so we never re-read prior gated history.
    const gatedPromptText = initialGate.displayText;

    // Emit the prompt as a user message — sourced as the task (initial) or a
    // user follow-up (resume).
    const taskMsgEvent: SubAgentEvent = {
      subAgentConversationId,
      parentConversationId,
      parentToolCallId,
      conversationId: subAgentConversationId,
      type: 'sub-agent-user-message',
      text: gatedPromptText,
      source: isResume ? 'user' : 'task',
    };
    yield taskMsgEvent;
    broadcastSubAgentEvent(taskMsgEvent);

    // Create observer for the sub-agent's tool executions
    const observerConfig = resolveToolObserverConfig(config);
    const toolCancels = new Map<string, () => void>();
    // Suppress raw tool-call args in the sub-agent stream until PreToolUse
    // resolves, matching the main-agent path, so a DLP block/modify hook can't
    // leak raw args into the sub-agent UI/persistence.
    const subEnforcingHooks = hookDispatcher.hasEnforcingToolHooks();
    // Provider-native tools execute in-provider and never hit
    // onToolExecutionStart, so their args must not be suppressed (nothing would
    // un-suppress them → stuck {pending}).
    // Recomputed on model-fallback (a cross-provider fallback changes which
    // tools are provider-defined vs wrapped-local).
    let subProviderToolNames = getProviderDefinedToolNames(modelConfig, subAgentConfig.tools?.executionMode);
    const subHookRewrittenArgs = new Map<string, unknown>();
    // Sub-agent runtime has no exec/stream id pairing map. To reconcile a
    // possible id mismatch, the stream loop records suppressed stream ids per
    // toolName (FIFO); onToolExecutionStart dequeues one and re-broadcasts the
    // resolved args under the stream id the renderer actually rendered.
    const subSuppressedStreamIdsByTool = new Map<string, string[]>();
    // Symmetric case: onToolExecutionStart resolved args BEFORE the stream
    // tool-call event arrived AND the exec id differs from the stream id. There
    // is no stream id to correct yet, so the resolved args are parked here per
    // toolName (FIFO); the stream loop consumes one before falling back to
    // {pending}, so the card is never left permanently suppressed.
    const subResolvedArgsByTool = new Map<string, unknown[]>();

    // Helper: add a follow-up message and emit it as a UI event. The message is
    // gated through UserPromptSubmit BEFORE broadcasting, so a DLP block/modify
    // hook can redact/deny it and the raw follow-up never reaches clients.
    // Returns null when the follow-up was denied (caller should stop the turn).
    const addFollowUpMessage = async (
      text: string,
      source: 'user' | 'parent' | 'task' = 'parent',
    ): Promise<{ event: SubAgentEvent } | { deniedReason: string }> => {
      const beforeFollowUp = [...messages];
      // Append + mark the new follow-up so the display logic can find its gated
      // text directly (surviving a modify hook that reorders/redacts history).
      const newTurn = { role: 'user', content: text };
      markNewTurn(newTurn);
      messages.push(newTurn);
      const newTurnIndex = messages.length - 1;
      // Gate the full history (the hook enforces on everything the model will see).
      const gate = await gateUserPrompt(newTurnIndex);
      if (!gate.ok) {
        // Roll the raw denied follow-up back out so it isn't surfaced via
        // onFinalMessages / persisted for resume. Return the reason so the caller
        // can YIELD a failed status (which both broadcasts it AND lets the tool's
        // stream consumer mark the run failed — a direct broadcast here would be
        // seen by clients but not by the caller, so the run would look completed).
        messages.length = 0;
        messages.push(...beforeFollowUp);
        return { deniedReason: gate.reason };
      }
      // Broadcast the gated display text (empty if the hook removed the message).
      const gatedText = gate.displayText;
      const evt: SubAgentEvent = {
        subAgentConversationId,
        parentConversationId,
        parentToolCallId,
        conversationId: subAgentConversationId,
        type: 'sub-agent-user-message',
        text: gatedText,
        source,
      };
      broadcastSubAgentEvent(evt);
      // Refresh the gated snapshot so a later throw surfaces this follow-up too.
      latestGatedMessages = [...messages];
      latestGatedSystemPrompt = subAgentConfig.systemPrompt;
      return { event: evt };
    };

    // Whether another agent turn is available. `turnCount` has already been
    // incremented for the CURRENT turn when the branches below run, so a next
    // turn exists iff turnCount < maxTurns.
    const hasTurnForFollowUp = (): boolean => turnCount < maxTurns;

    // Consume + gate a follow-up for processing in another turn. Returns a
    // discriminated outcome the caller yields/acts on:
    //  - 'none'       : no follow-up was pending.
    //  - 'no-turn'    : a follow-up was pending but NO turn remains to process it.
    //                   The caller surfaces a CONTENT-FREE terminal failure (the
    //                   raw text is NOT returned — it never passed the DLP
    //                   UserPromptSubmit gate, so it must not be interpolated into
    //                   a broadcast status). Resurrecting it via resume is racy
    //                   (see the removed drain); the honest outcome is an explicit
    //                   failure that a follow-up went unprocessed.
    //  - 'denied'     : the follow-up was denied by a hook (already rolled back).
    //  - 'processing' : consumed + gated; caller yields `event` then re-loops.
    const consumeFollowUpForNextTurn = async (): Promise<
      | { kind: 'none' }
      | { kind: 'no-turn' }
      | { kind: 'denied'; reason: string }
      | { kind: 'processing'; event: SubAgentEvent }
    > => {
      // Check the turn budget BEFORE consuming: getFollowUp() is destructive
      // (shifts the queue), so if no turn remains we must NOT consume — a queued
      // message stays queued so it survives to resume rather than being
      // acknowledged-then-discarded. Distinguish (via non-destructive peek) an
      // actually-queued follow-up ('no-turn' → paused) from an empty queue
      // ('none' → the caller finalizes normally, e.g. a clean final-turn answer
      // must NOT be misclassified as paused).
      if (!hasTurnForFollowUp()) {
        return peekFollowUp?.() ? { kind: 'no-turn' } : { kind: 'none' };
      }
      const followUp = await getFollowUp();
      if (followUp === null) return { kind: 'none' };
      const fu = await addFollowUpMessage(followUp);
      if ('deniedReason' in fu) return { kind: 'denied', reason: fu.deniedReason };
      return { kind: 'processing', event: fu.event };
    };

    // Explicit terminal outcome, set by whichever branch reaches a real terminal
    // state. `completed`/`failed` are final; `awaiting-timeout` is PAUSED —
    // terminal-but-resumable (awaiting-input timeout, or maxTurns reached
    // mid-work). Left null until a branch sets it; a null at loop exit (maxTurns
    // hit while `continue`-ing) is finalized as paused/resumable below.
    let terminalOutcome: 'completed' | 'failed' | 'awaiting-timeout' | null = null;

    while (turnCount < maxTurns) {
      if (abortSignal?.aborted) break;
      turnCount++;
      controlSignal.current = null; // reset for this turn
      // Reset the provider-tool exemption set to THIS turn's starting (primary) model each turn
      // (R156 f-1): the set is recomputed within a turn on model-fallback, so if turn N ended on
      // a fallback model whose provider had a native web_search, turn N+1 (which restarts on the
      // primary) would otherwise keep that stale exemption and skip DLP arg-suppression for a
      // LOCAL primary web_search. A turn that itself falls back re-recomputes it (line ~909).
      subProviderToolNames = getProviderDefinedToolNames(modelConfig, subAgentConfig.tools?.executionMode);

      // The initial prompt was gated up front; each follow-up is gated inside
      // addFollowUpMessage before it's added/broadcast. So no per-turn gate here.

      let turnText = '';
      // Accumulate this turn's TOOL calls + results so a `continue` (multi-turn) sub-agent carries
      // the tool evidence + side effects it just observed into the next turn's context (R170 f-9):
      // pushing only turnText dropped tool-only turns entirely, making the next turn repeat work or
      // decide without the results. Parts are ordered assistant tool-call parts; toolResults become a
      // following `tool` message. On model-fallback (turn restart) these reset alongside turnText.
      type SubToolPart = { type: 'tool-call'; toolCallId: string; toolName: string; args?: unknown };
      let turnToolParts: SubToolPart[] = [];
      const turnToolIndex = new Map<string, number>();
      let turnToolResults: Array<{ type: 'tool-result'; toolCallId: string; toolName: string; result: unknown }> = [];
      // Set if the model stream emits an `error` event this turn — a terminal
      // failure that must NOT fall through to a `completed` classification.
      let turnError: string | null = null;

      // Create/re-create observer each turn with updated context
      subObserver?.dispose();
      if (observerConfig.enabled) {
        subObserver = new ToolObserverManager({
          conversationId: subAgentConversationId,
          modelConfig,
          config: observerConfig,
          userRequestSummary: summarizeLatestUserRequest(messages),
          baseThreadContext: summarizeThreadContext(messages),
          emitMidToolMessage: (text) => {
            if (!abortSignal?.aborted) {
              broadcastSubAgentEvent({
                subAgentConversationId,
                parentConversationId,
                parentToolCallId,
                conversationId: subAgentConversationId,
                type: 'observer-message',
                text,
              });
            }
          },
          cancelToolCall: (toolCallId) => {
            const cancel = toolCancels.get(toolCallId);
            if (!cancel) return false;
            cancel();
            return true;
          },
        });
      }

      // Budget-fit media on sub-agent tool results (parity with the parent turn).
      // Shared factory: budget = min over eligible models of (window − branch −
      // committed − static − reserve), mutex-serialized. Sub-agents have no reactive
      // overflow recovery, so err toward shrinking. The SAME fitter path is used by
      // the completed-agent RESUME hook (tools/sub-agent.ts).
      const subMediaConfig = config.compaction?.media as MediaFitConfig | undefined;
      const SUB_WORKSPACE_TOOL_SCHEMA_TOKENS_ALLOWANCE = 3000;
      const computeSubStatic = (mn: string): number =>
        estimateSubAgentStaticTokens(
          // Estimate against the ACTUAL instructions the runtime sends — resolveModeSystemPrompt
          // (systemPrompts.chat ?? systemPrompt) PLUS the appended runtime-capability text —
          // not the bare subAgentConfig.systemPrompt, which under-counts and can retain media
          // that overflows (sub-agents have no reactive recovery).
          buildAgentInstructions(subAgentConfig),
          allTools,
          (schema) => z.toJSONSchema(schema as Parameters<typeof z.toJSONSchema>[0], { target: 'draft-7' }),
          SUB_WORKSPACE_TOOL_SCHEMA_TOKENS_ALLOWANCE,
          mn,
        );
      const subStaticInputTokens = computeSubStatic(modelConfig.modelName);
      // Eligible models for budgeting: primary + fallbacks when fallback enabled.
      const subEligibleModels =
        streamConfig && streamConfig.fallbackEnabled
          ? [streamConfig.primaryModel, ...streamConfig.fallbackModels]
          : [{ modelConfig } as { modelConfig: LLMModelConfig }];
      const windowOverride = (config.compaction?.conversation as { contextWindowTokens?: number } | undefined)
        ?.contextWindowTokens;
      const subMediaFitter = createSubAgentMediaFitter({
        mediaConfig: subMediaConfig,
        eligibleModels: subEligibleModels,
        windowOverride,
        staticInputTokens: subStaticInputTokens,
        computeStaticInputTokens: computeSubStatic,
        messages,
        getAccumulatedText: () => turnText,
        signal: abortSignal,
        conversationId: subAgentConversationId,
      });
      const fitSubAgentMedia = subMediaFitter.fit;

      const subStreamOpts = {
        abortSignal,
        // Nested sub_agent inheritance: this sub-agent's own profile/model.
        parentProfileKey: profileKey ?? null,
        parentModelKey: modelKey ?? null,
        emitEvent: (event) => {
          if (event.type === 'tool-progress') {
            subObserver?.onToolProgress({
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
          broadcastSubAgentEvent({
            ...event,
            subAgentConversationId,
            parentConversationId,
            parentToolCallId,
          } as SubAgentEvent);
        },
        onToolExecutionStart: async (state) => {
          toolCancels.set(state.toolCallId, state.cancel);
          // Charge RAW args against the media budget BEFORE the PreToolUse await /
          // any denial early-return (parallel-safe; idempotent per id).
          subMediaFitter.chargeArgs(state.toolCallId, state.args);
          // PreToolUse BEFORE the observer so a block/modify hook can deny or
          // sanitize args before the observer model sees them.
          const preTool = await hookDispatcher.dispatch('PreToolUse', {
            conversationId: subAgentConversationId,
            parentConversationId,
            toolCallId: state.toolCallId,
            toolName: state.toolName,
            args: state.args,
          });
          // Resolve the stream id the renderer used. If the stream event
          // already arrived it's queued here; otherwise (exec-first) we get
          // undefined and stash the resolved args by toolName so the stream
          // loop applies them when its id shows up.
          const dequeueStreamId = (): string | undefined => {
            const q = subSuppressedStreamIdsByTool.get(state.toolName);
            return q && q.length > 0 ? q.shift() : undefined;
          };
          const publishResolved = (resolved: unknown): void => {
            if (!subEnforcingHooks) return;
            const streamId = dequeueStreamId();
            // Record under the exec id (the stream loop checks this by id).
            subHookRewrittenArgs.set(state.toolCallId, resolved);
            if (streamId) {
              // Stream-first: a card was already rendered under `streamId` as
              // {pending}. Re-broadcast the resolved args to correct it — even
              // when streamId === exec id, since the renderer will NOT re-emit
              // that card on its own. Alias the extra key only when the ids
              // actually differ.
              if (streamId !== state.toolCallId) subHookRewrittenArgs.set(streamId, resolved);
              broadcastSubAgentEvent({
                type: 'tool-call',
                toolCallId: streamId,
                toolName: state.toolName,
                args: resolved,
                subAgentConversationId,
                parentConversationId,
                parentToolCallId,
              } as SubAgentEvent);
            } else {
              // Exec-first: the stream event hasn't arrived yet. If it later
              // uses the SAME id, it finds `resolved` via subHookRewrittenArgs
              // by id. If it uses a DIFFERENT id, that by-id lookup misses and
              // it would suppress to {pending} forever — so also park the
              // resolved args by toolName (FIFO) for the stream loop to claim.
              const q = subResolvedArgsByTool.get(state.toolName) ?? [];
              q.push(resolved);
              subResolvedArgsByTool.set(state.toolName, q);
            }
          };
          if (preTool.denied) {
            const reason = preTool.reason ?? 'Blocked by PreToolUse hook.';
            publishResolved({ redacted: true, reason });
            return {
              skip: true as const,
              result: { isError: true, error: reason },
            };
          }
          const nextArgs = (preTool.payload as { args?: unknown } | undefined)?.args;
          if (nextArgs !== undefined && nextArgs !== state.args) {
            const canMutateInPlace =
              state.args &&
              typeof state.args === 'object' &&
              !Array.isArray(state.args) &&
              nextArgs &&
              typeof nextArgs === 'object' &&
              !Array.isArray(nextArgs);
            if (canMutateInPlace) {
              const target = state.args as Record<string, unknown>;
              for (const k of Object.keys(target)) delete target[k];
              Object.assign(target, nextArgs as Record<string, unknown>);
              // Re-charge the delta so a hook that ENLARGED the args doesn't leave the
              // media budget under-counted (recovery is off once a tool has run).
              subMediaFitter.rechargeArgs(state.toolCallId, target);
            } else {
              // A modify hook returned a non-object replacement we can't apply
              // to the by-reference args — fail CLOSED rather than run the tool
              // with unsanitized input.
              const reason =
                'PreToolUse modify hook returned args that cannot be applied to this tool (non-object replacement); failing closed.';
              publishResolved({ redacted: true, reason });
              return { skip: true as const, result: { isError: true, error: reason } };
            }
          }
          // Emit resolved args (sanitized or allowed-unchanged) so the
          // suppressed initial tool-call event is corrected in place.
          publishResolved(state.args);
          subObserver?.onToolExecutionStart(state);
        },
        onToolExecutionEnd: ({ toolCallId }) => {
          toolCancels.delete(toolCallId);
          subObserver?.onToolExecutionEnd(toolCallId);
        },
        augmentToolResult: async ({ toolCallId, toolName, args, result }) => {
          // Use redacted/sanitized args (if PreToolUse rewrote/denied them) so
          // PostToolUse hooks/observers never see the raw denied args.
          const postArgs = subHookRewrittenArgs.get(toolCallId) ?? args;
          const postTool = await hookDispatcher.dispatch('PostToolUse', {
            conversationId: subAgentConversationId,
            parentConversationId,
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
          await subObserver?.waitForLinkedLaunchedTools(toolCallId);
          subObserver?.onToolExecutionResult(toolCallId, toolName, result);
          const augmentation = subObserver?.getToolAugmentation(toolCallId);
          // Budget-fit `_modelContent` media LAST — after PostToolUse + observer
          // augmentation, which can themselves add/replace media (parity with the
          // parent turn, and so post-hook media is fit rather than sent raw).
          if (!augmentation) return await fitSubAgentMedia(result, toolCallId, args);
          if (!result || typeof result !== 'object' || Array.isArray(result)) {
            return await fitSubAgentMedia({ value: result, ...augmentation }, toolCallId, args);
          }
          return await fitSubAgentMedia({ ...(result as Record<string, unknown>), ...augmentation }, toolCallId, args);
        },
      } satisfies Parameters<typeof streamAgentResponse>[6];

      // Run under the profile's fallback chain when the caller resolved one;
      // otherwise the single-model path (backward-compatible).
      const stream =
        streamConfig && streamConfig.fallbackEnabled && streamConfig.fallbackModels.length > 0
          ? streamWithFallback(
              subAgentConversationId,
              messages,
              streamConfig,
              subAgentConfig,
              allTools,
              dbPath,
              subStreamOpts,
            )
          : streamAgentResponse(
              subAgentConversationId,
              messages,
              modelConfig,
              subAgentConfig,
              allTools,
              dbPath,
              subStreamOpts,
            );

      for await (const event of stream) {
        if (event.type === 'text-delta' && event.text) {
          turnText += event.text;
        } else if (event.type === 'tool-call' && event.toolCallId) {
          // Record the tool call for next-turn context (R170 f-9). Update-in-place on a repeat id.
          const existing = turnToolIndex.get(event.toolCallId);
          if (existing === undefined) {
            turnToolIndex.set(event.toolCallId, turnToolParts.length);
            turnToolParts.push({
              type: 'tool-call',
              toolCallId: event.toolCallId,
              toolName: event.toolName ?? 'tool',
              args: event.args,
            });
          } else {
            turnToolParts[existing] = {
              type: 'tool-call',
              toolCallId: event.toolCallId,
              toolName: event.toolName ?? turnToolParts[existing].toolName,
              args: event.args ?? turnToolParts[existing].args,
            };
          }
        } else if ((event.type === 'tool-result' || event.type === 'tool-error') && event.toolCallId) {
          turnToolResults.push({
            type: 'tool-result',
            toolCallId: event.toolCallId,
            toolName: event.toolName ?? 'tool',
            result:
              event.type === 'tool-error'
                ? { isError: true, error: event.error ?? 'Tool execution failed' }
                : event.result,
          });
        } else if (event.type === 'error') {
          // Model/stream error this turn — terminal failure. Capture the reason;
          // handled after the loop so it can't be classified as `completed`.
          turnError = ('error' in event && event.error ? String(event.error) : '') || 'Sub-agent stream error.';
        } else if (event.type === 'model-fallback') {
          // A mid-stream fallback restarts the response on the next model. Drop
          // this turn's accumulated partial text so the persisted assistant
          // message is the SUCCESSFUL retry only, not a failed-prefix + success
          // concatenation. Only the LOCAL accumulation is reset — the event is
          // still enriched, broadcast, and yielded below like any other.
          turnText = '';
          // Reset the tool accumulators too (R170 f-9) — the discarded attempt's tool calls/results
          // must not carry into the successful retry's next-turn context.
          turnToolParts = [];
          turnToolIndex.clear();
          turnToolResults = [];
          const toKey = (event.data as { toModelKey?: string } | undefined)?.toModelKey;
          const nextEntry = toKey
            ? (streamConfig?.fallbackModels.find((m) => m.key === toKey) ??
              (streamConfig?.primaryModel.key === toKey ? streamConfig.primaryModel : undefined))
            : undefined;
          if (nextEntry)
            subProviderToolNames = getProviderDefinedToolNames(
              nextEntry.modelConfig,
              subAgentConfig.tools?.executionMode,
            );
          // streamWithFallback restarts the next model from the original messages —
          // reset the same-turn media budget so the discarded attempt's committed
          // args/text/media don't phantom-charge the fallback's budget, and recompute
          // the static-input estimate under the fallback model's tokenizer.
          subMediaFitter.reset(nextEntry ?? undefined);
        }
        const enriched = { ...event, subAgentConversationId, parentConversationId, parentToolCallId } as SubAgentEvent;
        // Suppress raw args on tool-call events until PreToolUse resolves; the
        // onToolExecutionStart handler re-broadcasts the resolved args.
        if (event.type === 'tool-call' && event.toolCallId) {
          const rewritten = subHookRewrittenArgs.get(event.toolCallId);
          if (rewritten !== undefined) {
            (enriched as Record<string, unknown>).args = rewritten;
            // Exec-first + SAME id: publishResolved both recorded args by id AND
            // speculatively parked a copy by toolName (it couldn't yet know the
            // stream id would match). We resolved by id here, so drain that
            // parked entry — otherwise it leaks onto the next same-named call.
            const pq = event.toolName ? subResolvedArgsByTool.get(event.toolName) : undefined;
            if (pq && pq.length > 0) pq.shift();
          } else if (subEnforcingHooks && !(event.toolName && subProviderToolNames.has(event.toolName))) {
            // Exec-first with a mismatched id: onToolExecutionStart already
            // resolved args and parked them by toolName. Claim one instead of
            // suppressing, so the card is never stuck {pending}.
            const parkedQueue = event.toolName ? subResolvedArgsByTool.get(event.toolName) : undefined;
            const parked = parkedQueue && parkedQueue.length > 0 ? parkedQueue.shift() : undefined;
            if (parked !== undefined) {
              (enriched as Record<string, unknown>).args = parked;
              subHookRewrittenArgs.set(event.toolCallId, parked);
            } else {
              (enriched as Record<string, unknown>).args = { pending: true };
              (enriched as Record<string, unknown>).argsPending = true;
              // Record this stream id so onToolExecutionStart can re-broadcast the
              // resolved args under it even if the exec-side id differs.
              if (event.toolName) {
                const q = subSuppressedStreamIdsByTool.get(event.toolName) ?? [];
                q.push(event.toolCallId);
                subSuppressedStreamIdsByTool.set(event.toolName, q);
              }
            }
          }
        }
        if (event.type !== 'done') {
          broadcastSubAgentEvent(enriched);
        }
        yield enriched;
        if (event.type === 'done') break;
      }

      if (turnText) {
        fullResponseText += (fullResponseText ? '\n\n' : '') + turnText;
      }
      // Push a structured assistant turn carrying BOTH text and tool calls into the next-turn context
      // (R170 f-9). Previously only turnText was pushed, so a tool-only turn contributed nothing and a
      // `continue` re-ran without the tool evidence/side effects. Build assistant content = [text?, …
      // tool-call parts]; follow with a `tool` message holding the results so the model sees outcomes.
      if (turnText || turnToolParts.length > 0) {
        const assistantContent: Array<Record<string, unknown>> = [];
        if (turnText) assistantContent.push({ type: 'text', text: turnText });
        for (const p of turnToolParts) assistantContent.push({ ...p });
        // If there are no tool parts, keep the legacy plain-string content shape for text-only turns.
        messages.push(
          turnToolParts.length > 0
            ? { role: 'assistant', content: assistantContent }
            : { role: 'assistant', content: turnText },
        );
        if (turnToolResults.length > 0) {
          messages.push({ role: 'tool', content: turnToolResults.map((r) => ({ ...r })) });
        }
      }

      if (abortSignal?.aborted) break;

      // A stream error this turn is terminal — fail explicitly rather than
      // falling through to signal arbitration (which could reach the no-signal
      // `completed` branch or start another turn).
      if (turnError) {
        terminalOutcome = 'failed';
        yield emitStatus(undefined as never, 'failed', turnError);
        break;
      }

      // Check what the sub-agent signaled via the control tool
      const signal = controlSignal.current as ControlSignal | null;

      if (signal?.action === 'complete' || signal?.action === 'failed') {
        // The sub-agent DECLARED completion. If a turn remains, drain a pending
        // follow-up ("one more thing") into another turn. If no turn remains,
        // FINALIZE with the declared status — any still-queued follow-up is left
        // in the queue (not destructively consumed) and survives to the resume
        // path (a completed run is resumable). This is the sub-agent's own
        // declared outcome, not a turn-limit failure.
        const outcome = await consumeFollowUpForNextTurn();
        if (outcome.kind === 'denied') {
          terminalOutcome = 'failed';
          yield emitStatus(undefined as never, 'failed', outcome.reason);
          break;
        }
        if (outcome.kind === 'processing') {
          yield outcome.event;
          yield emitStatus(undefined as never, 'running', 'Processing follow-up');
          continue;
        }
        // 'none' or 'no-turn' → finalize with the declared status.
        const finalSt = signal.action === 'complete' ? ('completed' as const) : ('failed' as const);
        terminalOutcome = finalSt;
        yield emitStatus(undefined as never, finalSt, signal.message ?? fullResponseText.slice(0, 500));
        break;
      }
      if (signal?.action === 'awaiting_response') {
        yield emitStatus(undefined as never, 'awaiting-input', signal.message ?? 'Waiting for input');

        // Only wait for input if a turn remains to process it. If the turn budget
        // is exhausted while awaiting input, the sub-agent is PAUSED (resumable) —
        // emit `paused`, not a hard failure, so a later user response can resume.
        if (!hasTurnForFollowUp()) {
          terminalOutcome = 'awaiting-timeout';
          yield emitStatus(undefined as never, 'paused', 'Paused — awaiting a response.', 'awaiting-input');
          break;
        }
        const followUp = await waitForFollowUp(getFollowUp, abortSignal, 300000);
        if (abortSignal?.aborted) break; // aborted → classified 'stopped' below
        if (!followUp) {
          // Timed out waiting for input. This is NOT a failure — the sub-agent is
          // legitimately PAUSED awaiting a response the user may still provide via
          // the composer. Emit the terminal 'paused' status (resumable; the
          // wrapper persists resumable state and the observer latches on it so it
          // won't nudge/resume the paused agent during teardown).
          terminalOutcome = 'awaiting-timeout';
          yield emitStatus(undefined as never, 'paused', 'Paused — awaiting a response.', 'awaiting-input');
          break;
        }

        const fu = await addFollowUpMessage(followUp);
        if ('deniedReason' in fu) {
          terminalOutcome = 'failed';
          yield emitStatus(undefined as never, 'failed', fu.deniedReason);
          break;
        }
        yield fu.event;
        yield emitStatus(undefined as never, 'running', 'Processing follow-up');
        continue;
      }

      // signal === 'continue' or no signal — check for opportunistic follow-ups.
      {
        const outcome = await consumeFollowUpForNextTurn();
        if (outcome.kind === 'denied') {
          terminalOutcome = 'failed';
          yield emitStatus(undefined as never, 'failed', outcome.reason);
          break;
        }
        if (outcome.kind === 'processing') {
          yield outcome.event;
          yield emitStatus(undefined as never, 'running', `Processing follow-up (turn ${turnCount + 1})`);
          continue;
        }
        if (outcome.kind === 'no-turn') {
          // Turn budget exhausted while the sub-agent was still working (or had a
          // queued follow-up). Terminal-but-RESUMABLE: emit `paused` (not a hard
          // failure) so resumable state is persisted and any queued follow-up —
          // left intact, never destructively consumed — survives to the resume
          // path. The user can continue the sub-agent from where it stopped.
          terminalOutcome = 'awaiting-timeout';
          yield emitStatus(
            undefined as never,
            'paused',
            `Paused — reached the turn limit (${maxTurns}).`,
            'turn-limit',
          );
          break;
        }
      }

      // No control signal and no follow-up — brief window then auto-complete.
      if (!signal) {
        // Only wait if a turn remains to process anything that arrives.
        const lateFollowUp = hasTurnForFollowUp() ? await waitForFollowUp(getFollowUp, abortSignal, 5000) : null;
        if (lateFollowUp) {
          const fu = await addFollowUpMessage(lateFollowUp);
          if ('deniedReason' in fu) {
            terminalOutcome = 'failed';
            yield emitStatus(undefined as never, 'failed', fu.deniedReason);
            break;
          }
          yield fu.event;
          yield emitStatus(undefined as never, 'running', `Processing follow-up (turn ${turnCount + 1})`);
          continue;
        }
        // No signal and nothing pending: the sub-agent produced its turn without
        // signaling continue/complete — treat as a normal completion.
        terminalOutcome = 'completed';
        yield emitStatus(undefined as never, 'completed', fullResponseText.slice(0, 500));
        break;
      }

      // signal === 'continue' — keep going (loop re-evaluates turnCount<maxTurns).
      yield emitStatus(undefined as never, 'running', `Continuing (turn ${turnCount + 1})`);
    }

    // Finalize. Branches that reached a real terminal state already emitted their
    // status and broke. The one remaining case is the loop hitting maxTurns while
    // the sub-agent was still `continue`-ing (terminalOutcome === null, no abort):
    // that is PAUSED (resumable) — the sub-agent ran out of turns mid-work and can
    // be resumed — NOT a hard failure.
    if (abortSignal?.aborted) {
      // Aborted (parent stop or observer cancel): emit the terminal `stopped`
      // status so renderer/web clients mark the child stopped (not left running/
      // awaiting) and the observer latches. The wrapper independently returns a
      // stopped result from localController.signal.
      yield emitStatus(undefined as never, 'stopped', fullResponseText.slice(0, 500));
    } else if (terminalOutcome === null) {
      terminalOutcome = 'awaiting-timeout';
      yield emitStatus(undefined as never, 'paused', `Paused — reached the turn limit (${maxTurns}).`, 'turn-limit');
    }

    // Refresh the final GATED snapshot (message history + system prompt). The
    // actual onFinalMessages/onFinalSystemPrompt emit happens in the finally so it
    // ALSO fires when the run throws — surfacing whatever was gated so far (the
    // visible follow-up) rather than nothing.
    latestGatedMessages = [...messages];
    latestGatedSystemPrompt = subAgentConfig.systemPrompt ?? systemPrompt;
  } finally {
    // Dispose the observer HERE (not only on the normal path) so a throw — or the
    // consumer breaking out of the generator early — can't leave the observer's
    // evaluation timer / in-flight model request running against a finished run.
    // dispose() is idempotent. `subObserver` is declared in the enclosing scope,
    // so it's visible here regardless of how the try exited.
    subObserver?.dispose();
    subObserver = null;
    // Hand the caller the final GATED message history + system prompt so it can
    // persist sanitized resume state (never the raw task/context). Emitted HERE so
    // an early throw still surfaces the gated-so-far snapshot (the visible
    // follow-up); guarded to emit at most once. Only emit if we actually gated
    // something (latestGatedMessages set after the initial gate) — a pre-gate
    // throw (e.g. cap rejection) legitimately has no gated history.
    if (!finalMessagesEmitted && latestGatedMessages !== null) {
      finalMessagesEmitted = true;
      onFinalMessages?.([...latestGatedMessages]);
      if (latestGatedSystemPrompt !== undefined) onFinalSystemPrompt?.(latestGatedSystemPrompt);
    }
    // Only decrement the counter here. Skip when the slot was pre-reserved — the
    // caller (resume) owns releasing it.
    if (!slotPreReserved) activeSubAgentCount--;
  }
}

/** Wait for a follow-up message with timeout */
async function waitForFollowUp(
  getFollowUp: () => Promise<string | null>,
  abortSignal?: AbortSignal,
  timeoutMs = 15000,
): Promise<string | null> {
  // Check immediately
  const immediate = await getFollowUp();
  if (immediate) return immediate;

  // Poll with timeout. Uses a self-scheduling setTimeout (re-armed AFTER each
  // async getFollowUp resolves) rather than setInterval, so a slow getter can
  // never overlap ticks. All handles + the abort listener are torn down exactly
  // once in finish() — the previous version left the deadline timer running for
  // up to timeoutMs after an early resolve and never removed the {once} abort
  // listener on the (run-scoped, reused-across-turns) signal.
  return new Promise<string | null>((resolve) => {
    let resolved = false;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
    const onAbort = (): void => finish(null);

    const teardown = (): void => {
      if (pollTimer) clearTimeout(pollTimer);
      if (deadlineTimer) clearTimeout(deadlineTimer);
      abortSignal?.removeEventListener('abort', onAbort);
    };

    function finish(val: string | null): void {
      if (resolved) return;
      resolved = true;
      teardown();
      resolve(val);
    }

    const poll = async (): Promise<void> => {
      if (resolved) return;
      if (abortSignal?.aborted) {
        finish(null);
        return;
      }
      const msg = await getFollowUp();
      if (resolved) return; // finished (deadline/abort) while this tick awaited
      if (msg) {
        finish(msg);
        return;
      }
      pollTimer = setTimeout(poll, 300); // re-arm only after the await settles
    };

    deadlineTimer = setTimeout(() => finish(null), timeoutMs);
    if (abortSignal) abortSignal.addEventListener('abort', onAbort, { once: true });

    void poll();
  });
}

/** Exposed for unit tests only. */
export const __internal = { waitForFollowUp };
