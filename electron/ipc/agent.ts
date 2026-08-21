import type { IpcMain } from 'electron';
import { BrowserWindow } from 'electron';
import { randomUUID } from 'node:crypto';
import { broadcastToWebClients } from '../web-server/web-clients.js';
import { broadcastToAllWindows } from '../utils/window-send.js';
import { openApprovalWindow, closeApprovalWindow, registerApprovalWindowIpc } from '../approval-window.js';
import { getExistingBrowserManager } from '../browser/service.js';
import { resolveApprovalPopOut } from '../agent/kai-presence.js';
import { resolveModelCatalog, resolveStreamConfig } from '../agent/model-catalog.js';
import { toolsForExecutionMode as filterToolsForExecutionMode } from '../agent/plan-mode-tools.js';
import {
  createWorkspaceToolDefinitions,
  normalizeAgentCwd,
  getProviderDefinedToolNames,
  WORKSPACE_MUTATING_TOOLS,
  buildAgentInstructions,
} from '../agent/mastra-agent.js';
import type { StreamEvent, ReasoningEffort } from '../agent/mastra-agent.js';
import { generateTitle } from '../agent/title-generation.js';
import type { AppConfig, ExecutionMode } from '../config/schema.js';
import { readEffectiveConfig } from './config.js';
import {
  broadcastUpsert,
  ensureConversationTree,
  getConversationBranch,
  appendConversationMessages,
  reparentConversationMessage,
  reorderInjectPrefixOnDisk,
} from './conversations.js';
import {
  readConversation,
  writeConversation,
  nextCompactionRevision,
  isRecentlyDeleted,
  isWriteTombstoned,
  conversationExistenceState,
} from './conversation-store.js';
import { detectRuntimeSwitch, generateSwitchContext, wrapSwitchContext } from '../agent/runtime-switch.js';
import { stripDisplayOnlyParts, invalidateStaleTokenCounts } from '../agent/message-sanitizer.js';
import { estimateStaticRequestTokens, WORKSPACE_TOOL_SCHEMA_TOKENS_ALLOWANCE } from '../agent/static-tokens.js';
import { gateMessagesThroughUserPromptSubmit } from '../agent/hooks/prompt-submit-gate.js';
import {
  accumulateForPersistence,
  discardPersistenceAccumulator,
  purgeConversationPersistence,
  recordSpliceOnlyOrphan,
  hasPersistenceAccumulator,
  persistenceAccumulatorHasContent,
  finalizeInterruptedTurn,
  finalizeInterruptedTurnReplacing,
  finalizeInterruptedTurnUpsert,
  persistCooperativeInjectedUserTurn,
  clearFinalizedResponseIds,
  finalizeGuiFallbackPrefixAtInject,
  messageContentSignature,
} from '../agent/stream-persistence.js';
import {
  clearInjects,
  drainInjects,
  enqueueInject,
  hasInjects,
  listInjects,
  removeInject,
} from '../agent/inject-queue.js';
import { capRemoteEvent } from '../agent/remote-frame-cap.js';
import { traceDiagnostic } from '../diagnostics/debug-trace.js';
import { setInjectConsumedHandler } from '../agent/prepare-step-inject.js';
import {
  shouldCompactAsync,
  compactConversationPrefix,
  compactToolResult,
  splitPreservedFields,
  estimateToolTokens,
  isStrictPrefix,
  selectProtectedTail,
} from '../agent/compaction.js';
import {
  messageContentSig,
  resolveConversationTokenization,
  sumBranchTokensForGate,
  encodeCappedWithAsync,
  serializeForTokenCounting,
} from '../agent/tokenization.js';
import {
  fitModelContentToBudget,
  stripBranchMediaForCount,
  DEFAULT_MAX_TOTAL_MEDIA_BYTES,
  type MediaFitConfig,
} from '../agent/media-fit.js';
import { isContextOverflowError } from '../agent/retry.js';
import { resolveHeaderTemplates as resolveHeaderTemplatesShared } from '../agent/header-templates.js';
import { isCompacting } from '../agent/compaction-lock.js';
import { COMPACTION_SYSTEM_PROMPT } from '../agent/prompts.js';
import { appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { getAppHome } from '../local-bridge/paths.js';
import {
  isRealtimeConversationBrowserAuthorized,
  isRealtimeConversationTurnActive,
  onRealtimeExecutionModeChanged,
} from './realtime.js';

// ---------------------------------------------------------------------------
// Debug logging for stream pipeline diagnostics
// ---------------------------------------------------------------------------
const IPC_DEBUG_ENABLED = !!process.env.KAI_DEBUG_STREAM;
// Under ~/.kai/debug-logs/ (NOT process.cwd(), which for the installed app's
// main process is typically '/') so the [BROADCAST] trace is capturable from
// the packaged app — matches the CLI's cliDebugLog target.
const IPC_DEBUG_DIR = join(getAppHome(), 'debug-logs');
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
import type { ChatMessage as ChatMessageForCompaction } from '../agent/compaction.js';
import type { ToolDefinition, ToolExecutionContext } from '../tools/types.js';
import { dedupeToolNames, ensureSafeToolDefinitions, findToolByName } from '../tools/naming.js';
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
import {
  redactBrowserErrorForExposure,
  redactBrowserToolArgsForExposure,
  redactBrowserToolErrorForExposure,
} from '../../shared/browser.js';
import type { HookMessage, PluginInferenceProvider } from '../plugins/types.js';
import { hookDispatcher } from '../agent/hooks/dispatcher.js';
import { applyPostToolUseHooks, prepareToolUseWithHooks } from '../agent/hooks/tool-lifecycle.js';

type ActiveStreamState = {
  abort: () => void;
  token: string;
  /** Sticky provenance: this run was admitted with native Browser authority.
   * Revocation removes its tools but must not let a web/secondary surface take
   * over the still-running private turn. */
  nativeBrowserInitiator: boolean;
  /** Current Browser-tool capability. This may be revoked independently of the
   * initiator provenance above. */
  nativeBrowserTools: boolean;
};

function shouldWarnAboutUnwrappedRuntimeTools(
  capabilities: { builtInTools?: boolean },
  enforcingHooksActive: boolean,
): boolean {
  return enforcingHooksActive && capabilities.builtInTools === true;
}

const UNCORRELATED_TOOL_ARGS_REASON =
  'Arguments hidden because enforcing tool hooks cannot be correlated with this runtime event.';

/** Prevent a streamed tool-call from exposing arguments before an enforcing
 * PreToolUse hook has resolved. Mastra has an execution callback with the same
 * call id, so its placeholder can be corrected later. Bridged runtimes and
 * plugin providers use unrelated ids; fail closed with a permanent redacted
 * sentinel rather than leaking the pre-hook payload or leaving a pending card. */
function protectUnresolvedToolCallArgs(
  event: StreamEvent,
  enforcingHooksActive: boolean,
  hookApplies: boolean,
  correctionExpected: boolean,
): void {
  if (event.type !== 'tool-call' || !enforcingHooksActive || !hookApplies) return;
  const mutableEvent = event as StreamEvent & { argsPending?: boolean };
  if (correctionExpected) {
    mutableEvent.args = { pending: true };
    mutableEvent.argsPending = true;
    return;
  }
  mutableEvent.args = { redacted: true, reason: UNCORRELATED_TOOL_ARGS_REASON };
  mutableEvent.argsPending = false;
}

const activeStreams = new Map<string, ActiveStreamState>();

/** True if any conversation currently has a live agent stream. Used by the
 *  headless update-restart watcher to avoid exiting mid-turn. */
export function hasActiveStreams(): boolean {
  return activeStreams.size > 0;
}

function markTextBrowserCapabilitiesRevoked(streams: Iterable<Pick<ActiveStreamState, 'nativeBrowserTools'>>): void {
  for (const stream of streams) stream.nativeBrowserTools = false;
}

function revokeTextBrowserCapabilities(
  streams: Iterable<readonly [string, Pick<ActiveStreamState, 'token' | 'nativeBrowserTools'>]>,
  approvals: Iterable<Pick<PendingToolApproval, 'authority' | 'streamOwner' | 'resolve'>>,
): void {
  const revokedOwners = new Map<string, Set<string>>();
  for (const [conversationId, stream] of streams) {
    if (stream.nativeBrowserTools) {
      const tokens = revokedOwners.get(conversationId) ?? new Set<string>();
      tokens.add(stream.token);
      revokedOwners.set(conversationId, tokens);
    }
    stream.nativeBrowserTools = false;
  }

  // A Browser policy prompt can no longer succeed after revocation. Settle
  // only those native-browser waiters; generic ask_user/plan approvals remain
  // live as long as their owning stream token is still current.
  for (const approval of approvals) {
    const owner = approval.streamOwner;
    if (
      approval.authority === 'native-browser' &&
      owner &&
      revokedOwners.get(owner.conversationId)?.has(owner.streamToken)
    ) {
      approval.resolve('dismiss');
    }
  }
}

/** Permanently remove the Browser bit from every live text stream. The Browser
 * manager separately rotates its authority generation and clears run leases,
 * so registry/tool refreshes after re-enable cannot restore the capability. */
export function revokeActiveTextBrowserTools(): void {
  revokeTextBrowserCapabilities(activeStreams.entries(), pendingToolApprovals.values());
}

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
  // Clear this run's raced-answer state BEFORE the ownership guard: on
  // supersession/Stop the activeStreams entry is replaced/deleted before this
  // run's finally runs, so an ownership-guarded clear would be skipped and leave
  // a stale `deliver` callback (or handoff) that a late answer could target at
  // the replacement turn. Token-scoped so a replacement's own claimant is intact.
  dropRacedAnswerClaimantForToken(conversationId, token);
  // Record that THIS token's run has ended (whether or not it still owns the
  // stream) so a later ask_user abort-site registration can tell a dead bound
  // successor from a not-yet-started one (see recentlyEndedTokens).
  markTokenEnded(token);
  // Recover any answer THIS token's run CONSUMED via ask_user.execute but whose
  // tool-result never committed (a supersession/abort during the PostToolUse window)
  // — BEFORE the ownership guard below, because on supersession/Stop this run may no
  // longer own the stream, and the ledger entry is TOKEN-scoped to THIS run. Draining
  // it here (not after the guard) means a superseded predecessor recovers ITS OWN
  // answer instead of leaking it for a later unrelated run to mis-recover (R101 f-2).
  // Only for a NON-terminal abort: on an explicit Stop / genuine dismiss (terminal
  // token) the user ended the turn, so drop the token's entries without resurrecting.
  const inFlight = drainInFlightAnswersForToken(token);
  if (inFlight.length > 0 && !terminalAbortTokens.has(token)) {
    const deliverer = getRecoveredAnswerDeliverer();
    if (deliverer) {
      for (const { answers } of inFlight) {
        void deliverer(conversationId, '', answers).catch(() => {
          /* best-effort durable recovery; nothing else holds this answer */
        });
      }
    }
  }
  if (activeStreams.get(conversationId)?.token !== token) return;
  // Finalize the GUI persistence fallback BEFORE dropping ownership: EVERY terminal path that
  // cleans up an owned stream — the main finally AND every early-exit (config error, hook denial,
  // provider return, etc.) — must run it, else a renderer reload loses the partial output and the
  // fallback accumulator/marker leak. Idempotent (no-op if this run kept no GUI fallback, or it
  // already ran), so calling it here + at explicit sites is safe.
  finalizeGuiFallbackIfOwned(conversationId, token);
  activeStreams.delete(conversationId);
  activeStreamModelKeys.delete(conversationId);
  activeStreamRuntime.delete(conversationId);
  activeStreamResponseIds.delete(conversationId);
  activeInjectContinuationId.delete(conversationId);
  activeObserverSessions.delete(conversationId);
  // Per-turn same-turn bookkeeping — clear on terminal cleanup so a one-off chat
  // (with a mid-turn inject) doesn't leak these module-level entries indefinitely.
  conversationsWithConsumedInject.delete(conversationId);
  consumedInjectBytes.delete(conversationId);
}

/** Close assistant-created browser tabs only while this exact turn still owns
 * the conversation. A superseded turn must never close its replacement's tabs. */
function cleanupAssistantTabsIfOwned(conversationId: string, token: string): boolean {
  if (activeStreams.get(conversationId)?.token !== token) return false;
  const cleanup = getExistingBrowserManager()?.cleanupAssistantTabs(conversationId, token);
  if (cleanup) {
    void cleanup.catch((error) => {
      console.error('[Agent:stream] Failed to clean up assistant Browser tabs:', error);
    });
  }
  return true;
}

/** A Browser-authorized turn can lose its renderer while waiting for preflight
 * drains, before the normal stream/fallback terminal path exists. Clear only a
 * still-running disk marker; a renderer that survived will persist its richer
 * terminal error after receiving the rejection result. */
function resetBrowserAuthorityRevokedRunStatus(appHome: string, conversationId: string): boolean {
  try {
    const conversation = readConversation(appHome, conversationId);
    if (!conversation || conversation.runStatus !== 'running') return false;
    conversation.runStatus = 'idle';
    broadcastUpsert(appHome, writeConversation(appHome, conversation));
    return true;
  } catch {
    return false;
  }
}

function shouldPrepareBrowserContinuation(
  event: { type: StreamEvent['type']; errorCategory?: string },
  serverPersistedRun: boolean,
  autoContinueOnMaxTurns: boolean,
  allowNativeBrowserTools: boolean,
): boolean {
  return (
    event.type === 'error' &&
    event.errorCategory === 'max_turns' &&
    !serverPersistedRun &&
    autoContinueOnMaxTurns &&
    allowNativeBrowserTools
  );
}

function isBrowserDrainSuperseded(aborted: boolean, activeToken: string | undefined, streamToken: string): boolean {
  return aborted || activeToken !== streamToken;
}

function isNativeBrowserAuthorityCurrent(
  manager: ReturnType<typeof getExistingBrowserManager>,
  generation: number | null | undefined,
): generation is number {
  return (
    generation !== null && generation !== undefined && manager?.isHostRendererAuthorityCurrent(generation) === true
  );
}

function isNativeBrowserAuthorityRevoked(
  wasAuthorized: boolean,
  managerAtAuthorization: ReturnType<typeof getExistingBrowserManager>,
  currentManager: ReturnType<typeof getExistingBrowserManager>,
  generation: number | null | undefined,
): boolean {
  return (
    wasAuthorized &&
    (managerAtAuthorization !== currentManager || !isNativeBrowserAuthorityCurrent(currentManager, generation))
  );
}

function mayDriveBrowserContinuation(
  manager: ReturnType<typeof getExistingBrowserManager>,
  conversationId: string,
  predecessorRunId: string,
  hasNativeBrowserAuthority: boolean,
): boolean {
  return !manager?.hasPendingAssistantContinuation(conversationId, predecessorRunId) || hasNativeBrowserAuthority;
}

function pluginProviderErrorForExposure(error: unknown, allowNativeBrowserTools: boolean): string {
  const message = error instanceof Error ? error.message : String(error);
  return allowNativeBrowserTools ? redactBrowserErrorForExposure(message) : message;
}
const activeObserverSessions = new Map<string, string>();

/** The last user message object from a flat message list, or null. */
function lastUserMessage(messages: unknown[]): { role?: unknown; content?: unknown } | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: unknown; content?: unknown } | null;
    if (m && typeof m === 'object' && m.role === 'user') return m;
  }
  return null;
}

/** Plain text of the newest user turn in a branch — string content as-is, or the
 *  concatenated text parts of a content-part array. Used to mirror a GUI-driven
 *  turn's prompt to co-viewing clients (the `kai` CLI) via a user-message event. */
function extractLastUserText(messages: unknown[]): string {
  const content = lastUserMessage(messages)?.content;
  if (typeof content === 'string') return content.trim();
  return extractMessageText(content);
}

/**
 * Map the post-enforcement payload of a mid-turn inject back to the text to
 * enqueue. Pure so the gate's decision (redaction vs. removal) is unit-testable
 * apart from the async hook orchestration.
 *
 * The gate runs hooks over the ACTIVE-BRANCH HISTORY plus the injected user turn
 * (so a history-dependent hook sees the same context a normal send shows it), then
 * this extracts ONLY the injected turn's (possibly-redacted) text. `historyLen` is
 * the number of leading history messages the payload was built with (0 when the
 * gate ran the injected turn alone — the legacy single-message shape).
 *
 * The injected turn is the message at index `historyLen` and MUST be the LAST one:
 * a hook that ADDED messages after it (a system/context turn) can't be represented
 * as a single user-text inject, so this DENIES (fail closed) unless the payload is
 * EXACTLY `historyLen + 1` messages, the last is a user turn, and it is text-only.
 * Text is extracted VERBATIM (no whitespace normalization — an inject may be
 * multiline / spacing-sensitive code, unlike extractMessageText's projection).
 */
export function resolveInjectedTextFromGatedPayload(
  payload: unknown[],
  historyLen = 0,
): { allowed: boolean; text: string } {
  // The injected turn is the LAST message, appended after `historyLen` history
  // messages. A hook that ADDED messages (extra system/context turns) makes the
  // payload longer than expected — can't be spliced as one inject, so fail closed.
  // A hook that REMOVED the injected turn makes it shorter → also fail closed.
  if (payload.length !== historyLen + 1) return { allowed: false, text: '' };
  const only = payload[historyLen] as { role?: unknown; content?: unknown } | null;
  if (!only || typeof only !== 'object' || only.role !== 'user') return { allowed: false, text: '' };
  // A hook that redacts the message to EMPTY text is effectively removing it — an
  // empty inject can't be enqueued (enqueueInject rejects it) and would otherwise
  // trigger a spurious supersede / a 20× retry. Treat empty resolved text as a
  // terminal removal (allowed:false) at every branch below.
  if (typeof only.content === 'string') {
    return only.content.trim().length > 0 ? { allowed: true, text: only.content } : { allowed: false, text: '' };
  }
  if (!Array.isArray(only.content)) return { allowed: false, text: '' };
  // Concatenate text parts VERBATIM; reject if any non-text part is present (an
  // inject is a plain user-text turn — a hook that introduced media/file parts
  // produced something we can't faithfully splice, so fail closed).
  let text = '';
  for (const part of only.content) {
    if (!part || typeof part !== 'object') return { allowed: false, text: '' };
    const p = part as { type?: string; text?: string };
    if (p.type !== 'text') return { allowed: false, text: '' };
    text += p.text ?? '';
  }
  return text.trim().length > 0 ? { allowed: true, text } : { allowed: false, text: '' };
}

/**
 * Split a branch into (a) a copy with native media base64 removed from the text
 * projection and (b) the NATIVE token cost of that media.
 *
 * Stream-persistence stores each tool result verbatim, so a prior image's cached
 * count includes its serialized base64 (hundreds of KB → hundreds of thousands of
 * bogus text tokens). That media is sent NATIVELY, costing far fewer provider
 * tokens. Counting the base64 as text massively over-counts (collapsing the media
 * budget); counting it as ZERO lets prior media overflow. So we strip the base64
 * AND add back a dimension-based native estimate (via estimateNativeMediaTokens).
 *
 * `_modelContent` TEXT parts (e.g. prior truncation/omission notes) are model-
 * visible and NOT media — they're preserved into the text projection so they keep
 * costing their real tokens (dropping them would under-count the branch).
 *
 * Async because the accurate per-image estimate probes sharp metadata.
 */
async function splitBranchMediaForTokenSum(
  messages: unknown[],
  signal?: AbortSignal,
): Promise<{ messages: unknown[]; nativeMediaTokens: number; branchMediaBytes: number }> {
  // Delegate to the shared, sanitizer-aware stripper so the token estimate AND the
  // whole-request byte seed both count ONLY media the downstream sanitizer forwards
  // (mirrors extractModelContent's validity + 5 MiB per-part / 12 MiB per-result /
  // 64-part limits) and strip UI-only backups (originalResult/compactionMeta). This is
  // the single source of truth — a divergent inline copy previously over-counted
  // over-size / sanitizer-dropped media and wrongly shrank the media budget.
  const { stripped, nativeMediaTokens, retainedMediaBytes } = await stripBranchMediaForCount(messages, signal);
  return { messages: stripped, nativeMediaTokens, branchMediaBytes: retainedMediaBytes };
}

/** Structural JSON of a value for change detection (undefined → ''). */
function jsonStableString(value: unknown): string {
  if (value === undefined) return '';
  try {
    const seen = new WeakSet<object>();
    return (
      JSON.stringify(value, (_key, nested) => {
        if (typeof nested === 'bigint') return `${nested.toString()}n`;
        if (typeof nested === 'object' && nested !== null) {
          if (seen.has(nested)) return '[Circular]';
          seen.add(nested);
        }
        return nested;
      }) ?? ''
    );
  } catch {
    try {
      return String(value);
    } catch {
      return '[Unserializable value]';
    }
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
function persistRedactedUserTurn(
  appHome: string,
  conversationId: string,
  sanitizedContent: unknown,
): { id: string; sig: string } | null {
  try {
    const conv = readConversation(appHome, conversationId);
    if (!conv) return null;
    const { tree, headId } = ensureConversationTree(conv);
    const branch = getConversationBranch(tree, headId);
    let target: (typeof branch)[number] | undefined;
    for (let i = branch.length - 1; i >= 0; i--) {
      if (branch[i].role === 'user') {
        target = branch[i];
        break;
      }
    }
    if (!target) return null;
    const node = tree.find((m) => m.id === target!.id);
    if (!node) return null;
    // Replace the whole content with the sanitized payload so removed non-text
    // parts (attachments/files) are dropped too. Normalize a string to a text
    // part for consistency with the renderer's content-part shape.
    node.content = (
      typeof sanitizedContent === 'string' ? [{ type: 'text', text: sanitizedContent }] : sanitizedContent
    ) as never;
    (node as unknown as { redactedByHook?: boolean }).redactedByHook = true;
    // Content replaced ⇒ the cached count's signature no longer matches. Clearing
    // both count + signature makes the write sanitizer recompute them for the
    // redacted content (belt-and-suspenders: sumBranchTokenCounts would already
    // reject the count on signature mismatch).
    delete (node as unknown as { tokenCount?: number }).tokenCount;
    delete (node as unknown as { tokenCountSig?: number }).tokenCountSig;
    conv.messageTree = tree as never;
    // Recompute the flat `messages` mirror of the active branch so exports/list
    // reflect the redaction immediately.
    conv.messages = getConversationBranch(tree, headId) as never;
    const writtenConv = writeConversation(appHome, conv);
    broadcastUpsert(appHome, writtenConv);
    // The renderer ignores conversations:changed while a stream accumulator is
    // active (and then renders/persists its raw in-memory copy), so also emit a
    // stream event carrying the sanitized content + target node id so the live
    // chat updates immediately.
    broadcastStreamEvent({
      conversationId,
      type: 'prompt-redacted',
      data: { messageId: node.id, content: node.content },
    });
    return {
      id: node.id as string,
      sig: messageContentSignature(node as Parameters<typeof messageContentSignature>[0]),
    };
  } catch (err) {
    console.warn('[Agent] Failed to persist redacted user turn:', err);
    return null;
  }
}

// Pending tool approval promises — shared with the Claude Agent SDK MCP bridge
import {
  pendingToolApprovals,
  setServerPersistTagger,
  setToolApprovalOwnerResolver,
  setRawApprovalWindowOpener,
  setRawApprovalWindowCloser,
  setPrimaryApprovalWindowResolver,
  authorizePendingApprovalWindow,
  mayBroadcastApprovalToWebClients,
  resolveApprovalBroadcastWindowIds,
  registerPendingApproval,
  broadcastStreamEventRaw,
  getRecordedApprovalAuthority,
  findRunNonceForAuthorityRecord,
  approvalKey,
  type PendingToolApproval,
  type ToolApprovalAuthority,
} from './tool-approval.js';

// Pending user answers for ask_user tool — populated by IPC handler before approval resolves
import {
  pendingQuestionAnswers,
  stashQuestionAnswers,
  resolveAskUserGateOutcome,
  rekeyRacedAnswer,
  formatRacedAnswerAsUserTurn,
  getRecoveredAnswerDeliverer,
  setAskUserRecoveryRouter,
  setActiveStreamTokenAccessor,
  setPlanModeDismissHandler,
  clearInFlightAnswer,
  drainInFlightAnswersForToken,
  dropInFlightAnswersForToken,
  dropInFlightAnswersForConversation,
  makeAnswerKey,
} from '../tools/ask-user.js';

// Track the model key used for each active stream so we can attribute token usage
const activeStreamModelKeys = new Map<string, string>();
/** Conversations that consumed a mid-turn inject during the current turn. Overflow
 *  recovery refuses to auto-retry these (the outer `messages` lacks the consumed
 *  inject). Set by the inject-consumed handler; cleared at each turn's start. */
const conversationsWithConsumedInject = new Set<string>();
/** Cumulative BYTES of mid-turn injects CONSUMED this turn per conversation. A
 *  cooperative inject's text lives only in Mastra's internal step messages, not the
 *  outer `messages` branch the media budget sums — so charge it here (bytes as a
 *  conservative token proxy) or a big inject + a media tool could overflow the next
 *  step. Cleared at each turn start. */
const consumedInjectBytes = new Map<string, number>();

// Track the runtime driving each active stream, so a mid-turn inject can route:
// the Mastra runtime supports cooperative step-boundary injection (prepareStep +
// inject-queue), while the CLI runtimes (codex/claude/pi/opencode) can't be
// stepped and use the abort+restart fallback.
// Runtime id driving each conversation's active stream, TOKEN-SCOPED: a
// superseding replacement sets `activeStreams` (new token) BEFORE it resolves +
// records its own runtime, so a plain `conversationId → runtimeId` map would
// still report the ABORTED run's stale runtime during that window. Storing the
// owning token lets readers confirm the runtime belongs to the CURRENT active
// stream and treat a not-yet-recorded replacement as "unknown" rather than
// inheriting the predecessor's value.
const activeStreamRuntime = new Map<
  string,
  {
    token: string;
    runtimeId: string;
    modelKey?: string;
    systemPrompt?: string;
    // The PRE-hook system prompt base this run fed its own pre-send / UserPromptSubmit
    // hooks (streamConfig.systemPrompt ?? config.systemPrompt). A mid-turn inject must
    // replay the hooks from THIS base — not the legacy config default — else a run using
    // a chat/profile/thread-specific prompt would produce effectivePrompt !== the run's
    // post-hook prompt even for an allow-only hook, wrongly blocking every inject.
    preHookSystemPrompt?: string;
    executionMode?: ExecutionMode;
    // Canonical fingerprint of the run's full EFFECTIVE context (resolved model /
    // profile / temperature / systemPrompt / maxSteps / maxRetries / reasoning /
    // fallback / runtime / cwd / executionMode). A mid-turn inject that would
    // resolve to a DIFFERENT effective context falls through to abort+restart
    // instead of cooperatively splicing under the wrong settings — comparing
    // resolved values (not raw optional inputs) closes the default-vs-pinned hole
    // and covers every behavior-affecting override (R97).
    contextFingerprint?: string;
    // TRUE only for a genuine Mastra prepareStep-driven run that can DRAIN the inject
    // queue at a step boundary. A direct plugin-inference-provider run is recorded
    // with runtimeId 'mastra' but streams OUTSIDE prepareStep, so a cooperative splice
    // into it is acknowledged yet never consumed (and could leak into a later turn).
    // The cooperative-inject path gates on THIS flag, not runtimeId === 'mastra' (R100).
    cooperativelyInjectable?: boolean;
  }
>();

/** Canonical dispatch descriptor from a RuntimeResolution — folds runtimeId together
 *  with providerOverride + inferenceProviderRuntimeId so plain Mastra, a Mastra run
 *  with a provider override, and a plugin-inference-provider run are DISTINCT (all
 *  three otherwise resolve to bare 'mastra'). Used in the run-context fingerprint on
 *  BOTH the live and caller sides so a config/provider change while a Mastra run is
 *  active forces a mid-turn inject to restart under the newly-selected provider
 *  instead of splicing into the old one (R101 finding-5). */
function runtimeDispatchDescriptor(resolution: {
  runtimeId?: string;
  providerOverride?: string;
  inferenceProviderRuntimeId?: string;
}): string {
  const base = resolution.runtimeId ?? 'mastra';
  if (!resolution.providerOverride && !resolution.inferenceProviderRuntimeId) return base;
  return `${base}|prov:${resolution.providerOverride ?? ''}|inf:${resolution.inferenceProviderRuntimeId ?? ''}`;
}

/** Canonical string of a turn's full EFFECTIVE run context, so a mid-turn inject
 *  can decide cooperative-splice (same context) vs. abort+restart (different) by
 *  comparing RESOLVED values rather than raw optional inputs. Resolving here means
 *  a pinned profile B vs. a live default-profile-A run differ (both resolve to
 *  their real profiles), and a changed temperature / prompt / step limit / fallback
 *  is caught too (R97). `runtimeDescriptor` is the canonical dispatch descriptor
 *  (runtimeDispatchDescriptor), NOT a bare runtimeId (R101 f-5). Best-effort: a
 *  resolution failure yields a sentinel so an inject conservatively restarts rather
 *  than splicing under an unknown context. */
function computeRunContextFingerprint(
  config: AppConfig,
  runtimeDescriptor: string,
  effectiveCwd: string | undefined,
  effectiveExecutionMode: ExecutionMode,
  opts: {
    modelKey?: string;
    profileKey?: string;
    reasoningEffort?: ReasoningEffort;
    fallbackEnabled?: boolean;
    threadOverrides?: {
      temperature?: number | null;
      systemPromptOverride?: string | null;
      maxSteps?: number | null;
      maxRetries?: number | null;
      runtimeOverride?: string | null;
    };
  },
): string {
  try {
    const sc = resolveStreamConfig(config, {
      threadModelKey: opts.modelKey ?? null,
      threadProfileKey: opts.profileKey ?? null,
      reasoningEffort: opts.reasoningEffort,
      fallbackEnabled: opts.fallbackEnabled ?? false,
      ...(opts.threadOverrides ? { threadOverrides: opts.threadOverrides } : {}),
    });
    return JSON.stringify({
      model: sc?.primaryModel?.key ?? null,
      profile: sc?.profileKey ?? null,
      temperature: sc?.temperature ?? null,
      maxSteps: sc?.maxSteps ?? null,
      maxRetries: sc?.maxRetries ?? null,
      reasoning: sc?.reasoningEffort ?? null,
      systemPrompt: sc?.systemPrompt ?? null,
      fallback: sc?.fallbackEnabled ?? false,
      runtime: runtimeDescriptor,
      cwd: effectiveCwd ?? null,
      mode: effectiveExecutionMode,
    });
  } catch {
    return '__unresolved__';
  }
}

/** True only when the conversation's CURRENT active run is a genuine Mastra
 *  prepareStep-driven run that can drain the inject queue — i.e. cooperative
 *  mid-turn splicing is actually honored. A direct plugin-inference-provider run
 *  (recorded runtimeId 'mastra' but streaming outside prepareStep) returns FALSE, so
 *  the inject path force-restarts instead of stranding the message (R100). */
function isCooperativelyInjectable(conversationId: string): boolean {
  const activeToken = activeStreams.get(conversationId)?.token;
  if (activeToken === undefined) return false;
  const entry = activeStreamRuntime.get(conversationId);
  return Boolean(entry && entry.token === activeToken && entry.cooperativelyInjectable);
}

/** Mark the CURRENT active run as NOT cooperatively injectable (token-scoped no-op if
 *  superseded) — called when a run takes the direct plugin-inference-provider path,
 *  which bypasses Mastra's prepareStep inject drain (R100). */
function markRunNotCooperativelyInjectable(conversationId: string, token: string): void {
  const entry = activeStreamRuntime.get(conversationId);
  if (entry && entry.token === token && activeStreams.get(conversationId)?.token === token) {
    entry.cooperativelyInjectable = false;
  }
}

// Node ids that belong to the CURRENT active run's OWN lineage, token-scoped.
// Used by injectHeadStillOnBranch to distinguish the run's OWN head advancement
// (from the pre-inject head down to one of these nodes) from a concurrent
// sibling-variant selection: a regenerated user node can have MANY assistant
// variant children, so "current head descends from headBeforeGate" is true for a
// sibling too. Requiring the descent path to pass through a node THIS run produced
// rejects the sibling. Populated from BOTH the provider's streamed
// `responseMessageId`s AND the cooperative-inject boundary nodes (the injected
// user node + its deterministic `${id}-cont` continuation, which are this run's
// own lineage but never carry a provider responseMessageId). Cleared on terminal
// cleanup (token-scoped).
const activeStreamResponseIds = new Map<string, { token: string; ids: Set<string> }>();
function recordActiveRunResponseId(conversationId: string, token: string, responseId: string): void {
  if (activeStreams.get(conversationId)?.token !== token) return;
  const entry = activeStreamResponseIds.get(conversationId);
  if (entry && entry.token === token) {
    entry.ids.add(responseId);
  } else {
    activeStreamResponseIds.set(conversationId, { token, ids: new Set([responseId]) });
  }
}
/** Drop a response id from the run's active lineage — used when a model-fallback
 *  SEALS the failed partial as an INACTIVE sibling variant and mints a fresh id for
 *  the retry. The sealed id is no longer on the live branch, so it must not count as
 *  same-run advancement in injectHeadStillOnBranch: if the user selected that failed
 *  sibling during a mid-turn gate's await, the walk would otherwise cross the sealed
 *  id and wrongly accept the inject onto the successful variant despite the user's
 *  selection. Token-scoped no-op if superseded. */
function forgetActiveRunResponseId(conversationId: string, token: string, responseId: string): void {
  if (activeStreams.get(conversationId)?.token !== token) return;
  const entry = activeStreamResponseIds.get(conversationId);
  if (entry && entry.token === token) entry.ids.delete(responseId);
}
// The CURRENT cooperative-inject continuation node id (`${injectedUserId}-cont`) for
// the active run, token-scoped. A continuation partial persists under this id (NOT
// the provider's responseMessageId), so a model-fallback that SEALS it as an
// inactive sibling must forget THIS id from the run lineage too (the provider id
// forget alone misses it — R85). Set at each inject-consumed boundary; cleared on
// terminal cleanup with the rest of the run lineage.
const activeInjectContinuationId = new Map<string, { token: string; contId: string }>();
function recordActiveInjectContinuationId(conversationId: string, token: string, contId: string): void {
  if (activeStreams.get(conversationId)?.token !== token) return;
  activeInjectContinuationId.set(conversationId, { token, contId });
}
/** Record a cooperative-inject boundary's nodes as this run's own lineage: the
 *  injected user node AND its deterministic `${id}-cont` continuation. After a
 *  splice, subsequent output persists under `-cont` (renderer) / after the
 *  injected user (server) — NOT under the provider's original responseMessageId —
 *  so without this a SECOND mid-turn send whose head advanced to the continuation
 *  node would fail injectHeadStillOnBranch and wrongly supersede a healthy run. */
function recordInjectBoundaryLineage(conversationId: string, token: string, injectedUserId: string): void {
  recordActiveRunResponseId(conversationId, token, injectedUserId);
  recordActiveRunResponseId(conversationId, token, `${injectedUserId}-cont`);
}
/** The response node ids the CURRENT active run has produced (empty if none/unknown). */
function getActiveRunResponseIds(conversationId: string): Set<string> {
  const activeToken = activeStreams.get(conversationId)?.token;
  if (activeToken === undefined) return new Set();
  const entry = activeStreamResponseIds.get(conversationId);
  return entry && entry.token === activeToken ? entry.ids : new Set();
}

/** The runtime id driving the current active stream for a conversation, if any.
 *  Returns undefined unless a runtime has been recorded FOR THE CURRENT active
 *  token — so a replacement whose runtime hasn't resolved yet reads as unknown
 *  (never the superseded predecessor's stale value). */
export function getActiveStreamRuntime(conversationId: string): string | undefined {
  const activeToken = activeStreams.get(conversationId)?.token;
  if (activeToken === undefined) return undefined;
  const entry = activeStreamRuntime.get(conversationId);
  return entry && entry.token === activeToken ? entry.runtimeId : undefined;
}

/** The active stream's token for a conversation, or undefined when idle. A
 *  non-Mastra runtime (SDK ask_user handler) captures this while its stream is
 *  live so a later abort-driven recovery can classify the abort via
 *  terminalAbortTokens (Stop / genuine dismiss = terminal → no recovery) rather
 *  than resurrecting a stopped turn (R95). */
export function getActiveStreamToken(conversationId: string): string | undefined {
  return activeStreams.get(conversationId)?.token;
}

/** The active run's model + system prompt + execution mode (for the CURRENT
 *  active token only), so a mid-turn inject gates its text through
 *  DLP/UserPromptSubmit under the SAME model/prompt/mode context a normal turn
 *  uses — a model/prompt/mode-conditioned hook must see what the running turn
 *  shows it, or it could allow an injected message it would block. Undefined
 *  fields when unrecorded (caller falls back to defaults). */
function getActiveRunContext(conversationId: string):
  | {
      modelKey?: string;
      systemPrompt?: string;
      preHookSystemPrompt?: string;
      executionMode?: ExecutionMode;
      contextFingerprint?: string;
    }
  | undefined {
  const activeToken = activeStreams.get(conversationId)?.token;
  if (activeToken === undefined) return undefined;
  const entry = activeStreamRuntime.get(conversationId);
  if (!entry || entry.token !== activeToken) return undefined;
  return {
    modelKey: entry.modelKey,
    systemPrompt: entry.systemPrompt,
    preHookSystemPrompt: entry.preHookSystemPrompt,
    executionMode: entry.executionMode,
    contextFingerprint: entry.contextFingerprint,
  };
}

/** Update the active run's recorded model key after a mid-stream model-fallback,
 *  so a mid-turn inject that arrives AFTER the switch gates under the model the
 *  text will actually be sent to (not the primary). Token-scoped no-op if the run
 *  was superseded. */
function updateActiveRunModelKey(conversationId: string, token: string, modelKey: string): void {
  const entry = activeStreamRuntime.get(conversationId);
  if (entry && entry.token === token && activeStreams.get(conversationId)?.token === token) {
    entry.modelKey = modelKey;
    // Keep the effective-context fingerprint in sync with the model actually in use
    // after a mid-stream fallback (R97/R98): otherwise a later mid-turn inject would
    // compare against the stale PRIMARY-model fingerprint — an inject pinning the
    // now-active fallback model would spuriously restart, and one pinning the primary
    // would spuriously splice under the wrong (fallback) model. Only the `model`
    // dimension changes on a fallback, so patch it in place.
    if (entry.contextFingerprint !== undefined && entry.contextFingerprint !== '__unresolved__') {
      try {
        const fp = JSON.parse(entry.contextFingerprint) as { model?: unknown };
        fp.model = modelKey;
        entry.contextFingerprint = JSON.stringify(fp);
      } catch {
        /* leave the fingerprint as-is; a mismatch just fails safe toward restart */
      }
    }
  }
}

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
// Conversations whose caller ALREADY broadcast the turn's user-message itself (with a
// submitNonce + authoritative data) BEFORE calling streamHandler — currently only the
// agent:submit path. streamHandler must skip its own user-message mirror for these to
// avoid a double render. A server-persist turn that did NOT self-broadcast (e.g. the
// injectUserTurnAndRestart abort+restart) is NOT in this set, so streamHandler emits
// the token-tagged user-message — which the renderer needs (its runGeneration) to
// adopt the successor as a takeover instead of rejecting its events (R108 finding-1).
const serverPersistTokens = new Map<string, string>();
// agent:submit's one-shot submitNonce, handed to streamHandler so ITS token-tagged
// user-message mirror carries the nonce (the originating client dedups its optimistic
// echo). agent:submit no longer self-broadcasts before the token exists — an untagged
// early mirror let a pre-lock GUI accumulator ignore the submit + drop the CLI run's
// tagged deltas as foreign, then launch its own stream and abort the accepted CLI turn
// (R111 finding-2). Consumed once in streamHandler's mirror.
const pendingSubmitMirrorNonce = new Map<string, string>();
// A submit that is still awaiting toolsReady (before any activeStreams entry
// exists) is otherwise uncancellable. Each submit mints a unique id and records
// it as the conversation's current pending submit; agent:cancel-stream marks it
// cancelled so the submit bails after the await instead of starting a run for a
// client that already detached.
let submitIdSeq = 0;
const currentPendingSubmit = new Map<string, number>();
const cancelledSubmits = new Set<number>();

// Stream tokens whose abort is TERMINAL — no successor turn is coming. Covers an
// explicit user Stop (agent:cancel-stream) AND an exit_plan_mode dismissal
// (planDismissed: plan mode is exited and the turn stops). The ask_user gate
// consults this: on a terminal abort it must NOT hand a raced answer to the
// replacement coordinator (there is no replacement — a later UNRELATED turn the
// user starts must not receive the stale answer). A supersession or a plan-mode
// RESTART is NOT terminal (a successor is coming), so its token is not marked.
// Bounded so a long-lived process can't accumulate tokens; entries are only read
// within the aborted run's own teardown, so a small cap is safe.
const terminalAbortTokens = new Set<string>();
const MAX_TERMINAL_ABORT_TOKENS = 100;
// Monotonic per-conversation counter, incremented on every explicit Stop. A
// deferred raced-answer re-injection captures this at schedule time and re-checks
// it at fire time: if it advanced, the user pressed Stop (on this turn OR a
// successor) during the delay, so the re-injection must NOT start a new run.
// Per-conversation STOP marker. The value is a process-wide MONOTONIC sequence (never a
// per-conversation count), assigned on every explicit Stop. A deferred raced-answer /
// plan re-injection captures this at schedule time and re-checks at fire time; a change
// means the user Stopped during the delay, so the re-injection must NOT start a new run.
//
// ABA-SAFETY (R132 finding-1): the map is bounded + evictable, so an entry can be evicted
// under memory pressure (500 other conversations Stopped). The capture stores the RAW value
// (which may be `undefined` = "never Stopped") and comparisons use undefined-aware strict
// inequality — NOT `?? 0`. That way an evicted-after-Stop entry re-reads as `undefined`,
// which differs from the captured POSITIVE sequence → the re-injection correctly treats it
// as "state changed" (fail-safe deny) instead of colliding with a `0` that also meant "never
// Stopped". A conversation that was never Stopped has no entry to evict, so its `undefined`
// capture stays `undefined`. Monotonic global seq (vs per-conv count) also means a re-Stop
// always yields a strictly different value.
const explicitCancelGeneration = new Map<string, number>();
const MAX_EXPLICIT_CANCEL_GEN_ENTRIES = 500;
let globalStopSequence = 0;
// PUSH-based cancel invalidation (R135) for deferred ops that will START A RUN after a delay
// (plan-restart continuation; injectUserTurnAndRestart). The per-conversation stop map is
// bounded + LRU, so it can't be the SOLE durable answer to "was this Stopped after my capture?"
// — a capture of `undefined` (never Stopped) then a Stop then eviction of this conv's entry
// re-reads `undefined` and misses the Stop (R134 f-2). So those ops register a live token; a
// Stop actively flips `cancelled` on every token for the conversation. The token is held until
// the op fires (live deferred ops are few + short-lived), so it can't be evicted out from under
// a pending op. (The numeric undefined-aware capture/compare below stays for the raced-answer
// handoff/tombstone EQUALITY fields, which live in their own bounded structs across turns.)
type CancelGenToken = { conversationId: string; cancelled: boolean };
const liveCancelGenTokens = new Set<CancelGenToken>();
function registerCancelGenToken(conversationId: string): CancelGenToken {
  const token: CancelGenToken = { conversationId, cancelled: false };
  liveCancelGenTokens.add(token);
  // NOT capped/evicted: an evicting cap could remove a token whose op is still pending → its
  // Stop would be missed (R135 f-2). The set is bounded by CONCURRENT live deferred ops (a
  // handful) because every op releases its token on EVERY exit path (see the release calls in
  // injectUserTurnAndRestart + the plan-restart microtask finally). If this ever grew large it
  // would signal a release leak (a bug to fix), not something to paper over with a lossy cap.
  return token;
}
function releaseCancelGenToken(token: CancelGenToken | undefined): void {
  if (token) liveCancelGenTokens.delete(token);
}
function bumpExplicitCancelGeneration(conversationId: string): void {
  // Re-insert (delete → set) so a bumped entry becomes the NEWEST in iteration order (LRU):
  // the most-recently-Stopped conversations are the LAST evicted (reduces map-eviction races;
  // the token registry is the durable guarantee for run-starting deferred ops).
  globalStopSequence += 1;
  explicitCancelGeneration.delete(conversationId);
  explicitCancelGeneration.set(conversationId, globalStopSequence);
  while (explicitCancelGeneration.size > MAX_EXPLICIT_CANCEL_GEN_ENTRIES) {
    const oldest = explicitCancelGeneration.keys().next().value;
    if (oldest === undefined) break;
    explicitCancelGeneration.delete(oldest);
  }
  // PUSH: cancel every live deferred-op token for this conversation — durable regardless of
  // whether the map entry later evicts.
  for (const t of liveCancelGenTokens) if (t.conversationId === conversationId) t.cancelled = true;
}
/** Capture the current stop marker for a conversation (RAW — `undefined` when never Stopped).
 *  Pair with {@link cancelGenerationChanged}. Used for the raced-answer handoff/tombstone
 *  EQUALITY fields; a run-STARTING deferred op should additionally hold a push token. */
function captureCancelGeneration(conversationId: string): number | undefined {
  return explicitCancelGeneration.get(conversationId);
}
/** True when the stop marker has CHANGED since `captured` — undefined-aware so an evicted
 *  (previously-Stopped) entry re-reading as `undefined` counts as changed, not as a `0` match. */
function cancelGenerationChanged(conversationId: string, captured: number | undefined): boolean {
  return explicitCancelGeneration.get(conversationId) !== captured;
}
function markTokenTerminalAbort(token: string): void {
  terminalAbortTokens.add(token);
  while (terminalAbortTokens.size > MAX_TERMINAL_ABORT_TOKENS) {
    const oldest = terminalAbortTokens.values().next().value;
    if (oldest === undefined) break;
    terminalAbortTokens.delete(oldest);
  }
}

/**
 * Authoritative (in-memory) check of whether a conversation currently has a turn
 * either STREAMING (`activeStreams`) or SUBMITTED-but-not-yet-streaming
 * (`currentPendingSubmit`, awaiting toolsReady before an activeStreams entry
 * exists, and not already cancelled). `/compact` consults this when acquiring its
 * lock: the disk `runStatus: 'running'` write lands AFTER streaming begins, so a
 * disk-only check has a window where an active turn looks idle — during which
 * `/compact` would launch a paid summarizer alongside the live turn and then
 * usually discard it as busy. This closes that window.
 */
export function isConversationTurnActive(conversationId: string): boolean {
  if (isRealtimeConversationTurnActive(conversationId)) return true;
  return isTextConversationTurnActive(conversationId);
}

/** Text-only half of the per-conversation turn exclusion contract. Realtime
 * startup consumes this through an injected callback to avoid an agent↔realtime
 * module cycle. */
export function isTextConversationTurnActive(conversationId: string): boolean {
  if (activeStreams.has(conversationId)) return true;
  const pending = currentPendingSubmit.get(conversationId);
  return typeof pending === 'number' && !cancelledSubmits.has(pending);
}
// Abort an active stream/submit for a conversation without going through the IPC handler —
// set during registerAgentHandlers (needs the appHome closure). Deleting a conversation
// with a live run must abort it, else its tools + side effects keep running after the
// record is gone. Callable from other IPC modules (see conversations:delete/deleteMany).
let cancelConversationStreamImpl: ((conversationId: string) => void) | null = null;
export function cancelConversationStream(conversationId: string): void {
  cancelConversationStreamImpl?.(conversationId);
}
// The conversation head captured at submit time (the just-appended user turn),
// keyed by conversationId. streamHandler binds it to the run's token so the
// assistant reply is persisted as a child of the turn it actually answered —
// NOT whatever head is current at `done` (a mid-run /rewind, edit, or variant
// switch moves the head and would otherwise mis-parent the reply).
const pendingServerPersistParent = new Map<string, string | null>();
const serverPersistParents = new Map<string, string | null>();
// GUI (renderer-persisted) turns for which main keeps a FALLBACK persistence accumulator, keyed
// to the user-turn head the assistant reply parents on. Present iff a GUI agent:stream turn is
// live; the terminal handler polls whether the renderer persisted and, if not (sole renderer
// reloaded/crashed), finalizes main's accumulator so the reply isn't lost. Cleared at terminal.
const guiFallbackParents = new Map<string, string | null>();
// GUI turns ORIGINATED by a REMOTE (web-bridge) client — those clients receive the frame-capped
// stream events (capRemoteStreamEvent strips large tool-result media/originals), so if they persist
// their accumulator as authoritative history the full media would be LOST. For these turns MAIN is
// authoritative: it accumulated the FULL (un-capped) events, so at terminal it FINALIZES its own
// copy rather than deferring to the remote client's capped persist. (A LOCAL Electron window gets
// the full events, so its persist is authoritative and main discards its fallback as usual.)
const guiFallbackRemoteOrigin = new Set<string>();
// Conversations with a REMOTE-origin deferred replace-finalize in flight (both the cancel path AND
// the normal terminal fallback poll): main holds the FULL turn while the web client persists only a
// FRAME-CAPPED copy, and main is waiting to overwrite that capped copy with its full one. If a NEW
// turn is admitted for the conversation before that lands, the new turn's accumulator-discard would
// drop main's full copy (and the poll would bail on the active-stream check) — leaving the prior
// assistant permanently frame-capped. So the new-turn admission finalize-REPLACES the pending copy
// FIRST (before discarding). Cleared when the poll/defer resolves.
const pendingRemoteReplace = new Set<string>();
// Same idea for a LOCAL-origin GUI fallback whose terminal persistence poll is in flight: the
// guiFallbackParents marker is consumed when the poll starts, so a new-turn admission during the
// poll window can't see the live local fallback and would discard main's full accumulator (the sole
// complete reply if the renderer reloaded before persisting). Admission APPENDS main's copy for a
// pending LOCAL fallback (unless the renderer already persisted). Cleared when the poll resolves.
const pendingLocalReplace = new Set<string>();
let serverPersistAppHome: string | null = null;

// ── Main-authoritative GUI continuation ───────────────────────────────────────
// A GUI turn's auto-continue-on-max-turns and plan-restart are driven by a renderer (it has the
// user's model/profile/thread settings + plan state to synthesize the follow-up). With multiple
// clients — or a client that reloaded mid-turn and came back as a passive mirror — EXACTLY ONE must
// drive the continuation, or the run is double-restarted (duplicate model calls, supersession
// races). Rather than a renderer-side lease (which cannot reliably tell "reloaded" from "2nd
// viewer"), MAIN authorizes: the first client to request continuation for a given turn (keyed by the
// run's stream TOKEN) is granted; all others are denied. Keying on the turn token means a fresh turn
// (or a granted continuation, which starts a NEW token) is independently authorizable, so a
// reloaded winner can keep continuing across successive max-turns hits. No heartbeat/liveness is
// needed: a crashed/reloaded winner simply isn't the one asking for the NEXT turn's authorization.
const continuationAuthByConv = new Map<string, { turnToken: string; clientId: string; grantedAt: number }>();
const CONTINUATION_AUTH_MAX = 500; // bound the map (evict oldest) — conversations touched are few
// The most recent stream token ISSUED for each conversation (set at every stream start). Used to
// reject a continuation request for a turn OLDER than the latest issued — covers the case where a
// newer turn B started AND FINISHED (leaving no active stream token and no continuation-auth record)
// before turn A's delayed continuation request arrives: without this, A's request would find no
// active token + no record and be wrongly granted, relaunching stale history. Bounded like the auth
// map; a missing entry (evicted) falls back to the other recency rules.
const latestIssuedTurnToken = new Map<string, string>();
// EXPLICIT supersession lineage: maps a superseded predecessor token → the successor
// token that replaced it (recorded at stream admission when a new turn aborts a live
// predecessor). Used by the raced-answer rebind path to decide whether a handoff
// bound to token B may be transferred to the current turn C — ONLY when C is reachable
// from B by following these edges (C genuinely superseded B). A recency-only check
// (B older + inactive, C newer) can't distinguish that from B completing and C being
// an UNRELATED later turn, which would misdeliver B's stale answer to C. Bounded.
const supersededByToken = new Map<string, string>();
const MAX_SUPERSEDED_BY_ENTRIES = 400;
function recordSupersession(predecessorToken: string, successorToken: string): void {
  if (predecessorToken === successorToken) return;
  supersededByToken.set(predecessorToken, successorToken);
  while (supersededByToken.size > MAX_SUPERSEDED_BY_ENTRIES) {
    const oldest = supersededByToken.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    supersededByToken.delete(oldest);
  }
}
/** True when `candidateSuccessor` is reachable from `boundToken` by following
 *  recorded supersession edges (boundToken → … → candidateSuccessor) — i.e. the
 *  candidate genuinely replaced the bound successor through a chain of aborts, not
 *  merely started later. Cycle-guarded + depth-bounded. */
function isSupersessionDescendant(boundToken: string, candidateSuccessor: string): boolean {
  let cur: string | undefined = boundToken;
  const seen = new Set<string>();
  let hops = 0;
  while (cur !== undefined && !seen.has(cur) && hops < MAX_SUPERSEDED_BY_ENTRIES) {
    const next: string | undefined = supersededByToken.get(cur);
    if (next === undefined) return false;
    if (next === candidateSuccessor) return true;
    seen.add(cur);
    cur = next;
    hops += 1;
  }
  return false;
}
// A grant is abandoned if its holder never launches within this window (crashed/reloaded after
// authorization but before the continuation started). After it, another client (including the
// reloaded one with a fresh clientId) may win the SAME turn — so a crash can't wedge continuation.
// Staleness NEVER resurrects an OLDER turn (see below).
const CONTINUATION_AUTH_STALE_MS = 20_000;
// Stream tokens are `${Date.now()}-${random}`; parse the ms prefix to compare turn recency. A
// higher prefix = a newer turn. Unparseable → 0 (treated as oldest, so a well-formed token wins).
// Per-token MONOTONIC ordinal, assigned at stream start (recordIssuedTurnToken). Turn recency is
// compared by this ordinal, NOT the token's wall-clock prefix — a system clock correction
// (backward or forward) would otherwise reorder turns (deny a newer turn's continuation, or expire
// a live grant and admit a second driver). A monotonic counter is immune to clock jumps.
let turnOrdinalCounter = 0;
const turnOrdinalByToken = new Map<string, number>();
const TURN_ORDINAL_MAX = 2000; // bound the map (evict oldest)
function recordIssuedTurnToken(token: string): void {
  if (turnOrdinalByToken.has(token)) return;
  turnOrdinalByToken.set(token, ++turnOrdinalCounter);
  while (turnOrdinalByToken.size > TURN_ORDINAL_MAX) {
    const oldest = turnOrdinalByToken.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    turnOrdinalByToken.delete(oldest);
  }
}
// Recency of a turn token: prefer its monotonic ordinal (immune to clock jumps); fall back to the
// wall-clock `${Date.now()}-…` prefix for a token not issued this session (e.g. a cross-session /
// pre-restart token, which can't race a live turn anyway). Ordinals are offset above any plausible
// ms epoch (ORDINAL_RECENCY_BASE ≫ Date.now(), which is ~1.7e12 and grows ~3e10/yr) so an ordinal
// always outranks a wall-clock fallback (a live-session turn is newest) — while `base + ord` stays
// comfortably within Number.MAX_SAFE_INTEGER (~9e15) for any realistic ordinal count, unlike the
// old `MAX_SAFE_INTEGER - TURN_ORDINAL_MAX + ord`, which overflowed once ord exceeded the reserved
// window (2000 stream starts) and rounded adjacent ordinals to equal values.
const ORDINAL_RECENCY_BASE = 1e15;
function turnTokenTime(token: string): number {
  const ord = turnOrdinalByToken.get(token);
  if (ord !== undefined) return ORDINAL_RECENCY_BASE + ord;
  const dash = token.indexOf('-');
  const n = Number.parseInt(dash > 0 ? token.slice(0, dash) : token, 10);
  return Number.isFinite(n) ? n : 0;
}

/**
 * True when a conversation's CURRENT disk head is still on the branch a mid-turn
 * inject was composed against — i.e. the head is `headBeforeGate` itself OR a
 * DESCENDANT of it REACHED THROUGH ONE OF THE ACTIVE RUN'S OWN RESPONSE NODES. A
 * cooperative inject captures the head before its async policy gate; during that
 * await the SAME live run's debounced partial persist legitimately advances the
 * head from the user node to its assistant node (or a later step), which is NOT a
 * branch switch. Exact-equality would misread that same-run advancement as a
 * rewind/variant-switch and wrongly fall back to a superseding send (cancelling the
 * live run's in-flight tools).
 *
 * A plain descendant check is too loose: `headBeforeGate` may be a REGENERATED user
 * node with several assistant variant CHILDREN, so if another client selects a
 * sibling variant during the gate await, that sibling also descends from
 * headBeforeGate — but the running turn is on a DIFFERENT child. We therefore accept
 * a descendant ONLY when the path from the current head up to headBeforeGate passes
 * through a node THIS run produced (`runResponseIds`), which the sibling's lineage
 * does not. When the run has produced no response node yet (head hasn't advanced
 * past headBeforeGate), only exact equality is "on branch".
 * headBeforeGate === null (no prior head) → any current head is "on branch".
 */
function injectHeadStillOnBranch(
  appHome: string,
  conversationId: string,
  headBeforeGate: string | null,
  runResponseIds: Set<string>,
): boolean {
  if (headBeforeGate === null) return true;
  const conv = readConversation(appHome, conversationId);
  if (!conv) return false;
  const { tree, headId } = ensureConversationTree(conv);
  if (headId === headBeforeGate) return true;
  // Walk up from the current head toward headBeforeGate. Same-branch advancement is
  // ONLY confirmed if we reach headBeforeGate AND crossed one of this run's own
  // response nodes STRICTLY BELOW it — a sibling variant selected concurrently
  // reaches headBeforeGate too, but never through a node this run produced beneath
  // it. Do NOT count headBeforeGate ITSELF as a crossed run node: when it is itself
  // a recorded run-owned node (e.g. a prior inject's user id), counting the endpoint
  // would let ANY descendant (including a failed fallback sibling selected during
  // this gate) pass without crossing a live node below the gate head. Bounded +
  // cycle-guarded by the tree size.
  const byId = new Map(tree.map((m) => [m.id, m] as const));
  let cur: string | null = headId;
  const seen = new Set<string>();
  let crossedOwnResponse = false;
  while (cur && !seen.has(cur)) {
    if (cur === headBeforeGate) return crossedOwnResponse;
    if (runResponseIds.has(cur)) crossedOwnResponse = true;
    seen.add(cur);
    cur = byId.get(cur)?.parentId ?? null;
  }
  return false;
}
// Grant continuation-driver authorization for a turn to exactly ONE client. Rules:
//  1. The turn must be the conversation's CURRENT active stream (activeStreams token) — a request
//     for a turn that has already been superseded/ended is denied outright, so a delayed old-turn
//     request can never abort or duplicate a newer live continuation (the r164-TTL regression:
//     staleness must NOT let an older token win). When no stream is active (the brief window at a
//     turn's terminal before the continuation registers its own), fall through to the recency rules.
//  2. For that turn: the first client wins; the holder may re-win; a different client is denied
//     UNLESS the grant went stale (holder crashed pre-launch → winner-failure recovery).
//  3. A record for an OLDER turn than the incoming one is replaced (new turn supersedes); a record
//     for a NEWER turn than the incoming one always denies (never downgrade to an older turn).
function authorizeContinuation(conversationId: string, clientId: string, turnToken: string): boolean {
  if (
    typeof conversationId !== 'string' ||
    !conversationId ||
    typeof clientId !== 'string' ||
    !clientId ||
    typeof turnToken !== 'string' ||
    !turnToken
  ) {
    return false;
  }
  const now = Date.now();
  // Rule 1: if a stream is active for this conversation, the requested turn MUST be it. This is the
  // authoritative anti-stale guard — an older/superseded turn is never the active token.
  const activeToken = activeStreams.get(conversationId)?.token;
  if (activeToken !== undefined && activeToken !== turnToken) return false;
  // Reject a turn OLDER than the latest one ever issued for this conversation — covers a newer turn
  // that already started AND finished (no active token, no auth record) before this delayed request.
  const latestIssued = latestIssuedTurnToken.get(conversationId);
  if (latestIssued !== undefined && turnTokenTime(turnToken) < turnTokenTime(latestIssued)) return false;
  const existing = continuationAuthByConv.get(conversationId);
  if (existing && existing.turnToken === turnToken) {
    // Same turn: only the holder may (re)win it, unless the grant went stale (holder gone).
    if (existing.clientId !== clientId && now - existing.grantedAt <= CONTINUATION_AUTH_STALE_MS) {
      return false;
    }
  } else if (existing) {
    // Different turn. NEVER grant an OLDER turn than the recorded one — regardless of staleness —
    // so a delayed/stale request can't revoke a newer winner. A strictly-newer turn supersedes.
    if (turnTokenTime(turnToken) <= turnTokenTime(existing.turnToken)) return false;
  }
  continuationAuthByConv.delete(conversationId); // re-insert at back so ordering reflects recency
  continuationAuthByConv.set(conversationId, { turnToken, clientId, grantedAt: now });
  while (continuationAuthByConv.size > CONTINUATION_AUTH_MAX) {
    const oldest = continuationAuthByConv.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    continuationAuthByConv.delete(oldest);
  }
  return true;
}
function releaseContinuationAuth(conversationId: string): void {
  continuationAuthByConv.delete(conversationId);
}
// Reactive-recovery compaction hook awaits ABANDONED on turn-cancel (raceRecoveryAbort won, but
// the underlying trusted-plugin callback promise stays pending, pinning its transcript — we can't
// force-cancel a callback protocol). Bounded so repeated cancel→retry cycles against hung hooks
// can't accumulate transcripts + exhaust memory: over the cap, recovery bails (surfaces overflow)
// rather than start another abandonable hook. Decremented when each abandoned promise settles.
let outstandingAbandonedRecoveryHooks = 0;
const MAX_ABANDONED_RECOVERY_HOOKS = 8;

// Finalize the GUI-turn persistence FALLBACK for a run that just ended. The renderer normally
// persists its own reply (on a ~300ms debounce); we poll briefly and, if it never lands (the sole
// renderer reloaded/crashed → runStatus stays 'running'), persist main's accumulated copy so the
// reply isn't lost. ONLY when this run still owns the conversation (a superseding replacement run
// owns the shared accumulator — leave it). Called from BOTH the main stream loop's finally AND the
// plugin-provider return path (which bypasses the loop). No-op if this run kept no GUI fallback.
function finalizeGuiFallbackIfOwned(conversationId: string, streamToken: string): void {
  if (!serverPersistAppHome || !guiFallbackParents.has(conversationId)) return;
  const fbOwner = activeStreams.get(conversationId)?.token;
  if (fbOwner !== undefined && fbOwner !== streamToken) return; // replacement owns it — leave alone
  const fbAppHome = serverPersistAppHome;
  const fbToken = streamToken;
  const remoteOrigin = guiFallbackRemoteOrigin.delete(conversationId); // consume the marker
  guiFallbackParents.delete(conversationId);
  // For a REMOTE-origin terminal, register a pending replace up front: if a NEW turn is admitted for
  // this conversation before the poll observes the web client's capped persist, the poll would bail
  // on the active-stream check (below) and the new turn's admission would discard main's full copy —
  // losing the uncapped result. The admission finalize-REPLACES a pending copy first (see the
  // agent:stream discard site). Cleared once the poll finalizes/discards normally.
  if (remoteOrigin) pendingRemoteReplace.add(conversationId);
  else pendingLocalReplace.add(conversationId); // LOCAL fallback: flushable by admission during the poll
  const pollGuiFallback = (remaining: number): void => {
    const owner = activeStreams.get(conversationId)?.token;
    if (owner !== undefined && owner !== fbToken) return; // superseded — replacement owns the accumulator (admission finalized any pending remote/local copy)
    if (isRecentlyDeleted(conversationId)) {
      pendingRemoteReplace.delete(conversationId);
      pendingLocalReplace.delete(conversationId);
      discardPersistenceAccumulator(conversationId);
      return;
    }
    let rendererPersisted = false;
    try {
      const conv = readConversation(fbAppHome, conversationId);
      // A GENUINE terminal persist writes 'idle' (or an error state) — NOT 'awaiting-approval',
      // which means the turn PAUSED for a tool approval, not finished. Treating awaiting-approval as
      // "renderer persisted" would discard main's accumulator while the turn is still live (main may
      // resume + complete it), leaving disk at the pre-approval state. Only a real terminal counts.
      if (conv && conv.runStatus !== 'running' && conv.runStatus !== 'awaiting-approval') rendererPersisted = true;
    } catch {
      /* best-effort — treat as not-yet-persisted, keep polling */
    }
    if (rendererPersisted) {
      pendingRemoteReplace.delete(conversationId);
      pendingLocalReplace.delete(conversationId);
      if (remoteOrigin) {
        // REMOTE-originated: the web client persisted a FRAME-CAPPED assistant under the run's
        // responseMessageId. Main holds the FULL events — REPLACE that node's content in place
        // (upsert by id) with main's full copy, rather than appending a duplicate sibling variant.
        try {
          finalizeInterruptedTurnReplacing(fbAppHome, conversationId);
        } catch {
          discardPersistenceAccumulator(conversationId);
        }
        return;
      }
      discardPersistenceAccumulator(conversationId); // local renderer owns the (full) write — no double-persist
      return;
    }
    if (remaining <= 0) {
      pendingRemoteReplace.delete(conversationId);
      pendingLocalReplace.delete(conversationId);
      // Budget exhausted, runStatus still 'running' → the renderer reloaded/crashed. Persist
      // main's accumulated reply, reset runStatus, settle. For a REMOTE origin use the REPLACE
      // variant (it replaces a capped node by id if one exists, else appends) so we never leave a
      // duplicate sibling should the web client have persisted a capped node; finalize* no-ops if
      // the accumulator is empty.
      try {
        if (remoteOrigin) finalizeInterruptedTurnReplacing(fbAppHome, conversationId);
        // LOCAL origin: upsert-by-id, not a plain append. The renderer's debounced
        // persist may have landed the assistant node under this run's responseMessageId
        // just before it reloaded/crashed (disk still 'running'); a plain append would
        // id-collision-rename it to a bogus `auto-msg-*` sibling. replaceById upserts in
        // place (falls back to append when no such node exists).
        else finalizeInterruptedTurnUpsert(fbAppHome, conversationId);
      } catch {
        discardPersistenceAccumulator(conversationId);
      }
      try {
        const conv = readConversation(fbAppHome, conversationId);
        if (conv && conv.runStatus === 'running') {
          conv.runStatus = 'idle';
          broadcastUpsert(fbAppHome, writeConversation(fbAppHome, conv));
        }
      } catch {
        /* best-effort */
      }
      return;
    }
    setTimeout(() => pollGuiFallback(remaining - 1), 100);
  };
  pollGuiFallback(80); // ~8s: ample for the renderer's debounced persist; then fall back
}

/**
 * Raced-answer → successor rendezvous.
 *
 * When an ask_user question is still pending and its turn aborts WITH INTENT TO
 * RESTART (a supersession by a new submit, or a plan-mode restart — NOT a
 * terminal Stop/dismiss), the submitted answer must be carried into THE actual
 * successor turn. We run a RENDEZVOUS between three events, in any order:
 *   1. handoff registration (the aborting gate) — records the pending answerKey(s)
 *      in a PRE-successor holding map,
 *   2. successor start (streamHandler) — the NEXT Mastra turn TRANSFERS the
 *      pending keys into its own token-scoped claimant record (so nothing lingers
 *      in the pre-successor map for an unrelated later turn to pick up), and
 *   3. answer arrival (agent:answer-tool-question) — stashes the answer.
 * Delivery fires from whichever of (2)/(3) happens LAST once BOTH a live Mastra
 * claimant AND the stashed answer are present.
 *
 * Ownership: once a successor transfers the keys into its claimant record, that
 * record is TOKEN-SCOPED and torn down (dropRacedAnswerClaimantForToken) on the
 * successor's terminal path — including supersession/Stop, where activeStreams is
 * replaced before the finally runs (cleared BEFORE the ownership guard). A
 * successor that config/hook-fails before transferring still drops the
 * pre-successor holding entry on teardown, so no stale answer reaches a later
 * unrelated turn. The answer text lives in the pending-answer stash under each
 * `answerKey` throughout; delivery reads + removes it only at the delivery moment.
 */
const RACED_ANSWER_HANDOFF_TTL_MS = 30_000;
const MAX_RACED_ANSWER_DELIVERY_RETRIES = 20;
const RACED_ANSWER_RETRY_MS = 500;
// Stream tokens whose run has FULLY ended (terminal cleanup ran), bounded FIFO.
// Lets the ask_user abort-site handoff registration tell "the bound successor
// already DIED synchronously" (token in this set) from "the successor hasn't
// started yet" (token absent) — so it can durably recover an answer bound to a
// dead successor without false-positive premature recovery of a still-starting
// one (R86). Recorded in cleanupStreamIfOwned; a genuine successor that later
// starts is never in here at its own registration time.
const recentlyEndedTokens = new Set<string>();
const MAX_RECENTLY_ENDED_TOKENS = 400;
function markTokenEnded(token: string): void {
  recentlyEndedTokens.add(token);
  while (recentlyEndedTokens.size > MAX_RECENTLY_ENDED_TOKENS) {
    const oldest = recentlyEndedTokens.values().next().value as string | undefined;
    if (oldest === undefined) break;
    recentlyEndedTokens.delete(oldest);
  }
}
type RacedAnswerState = {
  /** Pending answer stash keys — a SET so parallel ask_user calls in one turn,
   *  which each register on the shared controller abort, don't overwrite. */
  answerKeys: Set<string>;
  /** explicit-cancel marker at abort (RAW — `undefined` = never Stopped); the rendezvous is
   *  void if it changed (undefined-aware, ABA-safe — R132). */
  cancelGenAtAbort: number | undefined;
  /** The PREDECESSOR run's stream token (the aborting run that registered this).
   *  Its OWN cleanupStreamIfOwned must NOT consume the handoff it just created
   *  (that would delete it before the successor transfers it); only a LATER
   *  run's teardown may invalidate a pre-successor handoff. */
  sourceToken: string;
  /** Bounded count of delivery retries after a failed cooperative splice, so a
   *  persistently-failing inject can't reschedule forever. */
  deliveryRetries: number;
  /** The token of the successor turn that was ALREADY issued at abort time, when
   *  known. Populated only when a DIFFERENT run had already claimed
   *  `latestIssuedTurnToken` before this gate registered — i.e. a genuine
   *  supersession (a fresh submit that issued its token at stream-start, THEN
   *  aborted us). In that case only a claimant with THIS exact token may transfer
   *  the handoff: if that successor synchronously config/hook-failed and died, no
   *  live run will ever carry the token, so the handoff simply ages out instead of
   *  being mis-delivered to an unrelated later turn (the R27-P2b residual).
   *  `undefined` when no successor was issued yet at abort (e.g. a plan-mode
   *  restart, whose successor token is minted asynchronously and is unpredictable
   *  here) — then the claim stays permissive (any next turn may carry it). */
  expectedSuccessorToken?: string;
  expiresAt: number;
  /** Count of async `deliver()` calls (each awaits the pre-send / UserPromptSubmit
   *  policy gate) currently in flight. A COUNTER, not a boolean: parallel ask_user
   *  answers deliver concurrently, and the first to settle must not clear the flag
   *  while another is still awaiting its gate. onFailure re-registers the handoff on
   *  ORDINARY completion only while a delivery is in flight (>0) — the answer a slow
   *  gate hadn't finished delivering is genuinely still owed. */
  deliveryInFlightCount?: number;
};
// PRE-successor holding map: keys registered by an aborting gate before the
// successor turn starts. Transferred into a claimant on successor start.
const racedAnswerHandoffs = new Map<string, RacedAnswerState>();
const MAX_RACED_ANSWER_HANDOFFS = 200;
// The live Mastra successor claimant: owns the transferred keys + a `deliver`
// that splices text into THAT running turn. Token-scoped; torn down on teardown.
// `deliver` returns `terminal:true` for a permanent outcome (a policy hook block /
// hook failure) so the retry loop drops the answer instead of re-running
// enforcement up to the retry cap; `ok:false` without `terminal` is a transient
// ownership race that IS retried.
type RacedDeliverResult = { ok: boolean; terminal?: boolean };
const liveRacedAnswerClaimant = new Map<
  string,
  { token: string; deliver: (text: string) => Promise<RacedDeliverResult>; state: RacedAnswerState }
>();

/** Register (or MERGE) a conversation's pending raced-answer handoff in the
 *  pre-successor holding map. Parallel ask_user gates aborting together each add
 *  their own answerKey. `expiresAtOverride` carries the ORIGINAL expiry forward on
 *  a re-registration (claimant teardown) so repeated quick successors can't renew
 *  the 30s TTL indefinitely — the answer must still age out on its original clock. */
function registerRacedAnswerHandoff(
  conversationId: string,
  answerKey: string,
  cancelGenAtAbort: number | undefined,
  sourceToken: string,
  expiresAtOverride?: number,
): void {
  const now = Date.now();
  // A carried-forward expiry that has ALREADY passed → don't resurrect (drop).
  if (expiresAtOverride !== undefined && now > expiresAtOverride) return;
  const expiresAt = expiresAtOverride ?? now + RACED_ANSWER_HANDOFF_TTL_MS;
  const existing = racedAnswerHandoffs.get(conversationId);
  // MERGE into the existing handoff ONLY when it belongs to the SAME source run
  // (parallel ask_user gates of one turn each add their key), the cancel generation
  // still matches (no Stop since), AND it hasn't expired. During rapid supersessions
  // a STALE unclaimed handoff from an EARLIER run can linger with the same cancel
  // generation but a DIFFERENT sourceToken/expectedSuccessorToken — merging a newer
  // key into it would bind the new answer to a dead successor or drop it as expired.
  // In that case fall through and REPLACE the stale state with a fresh binding.
  if (
    existing &&
    existing.sourceToken === sourceToken &&
    !cancelGenerationChanged(conversationId, existing.cancelGenAtAbort) &&
    now <= existing.expiresAt
  ) {
    existing.answerKeys.add(answerKey);
    // Keep the EARLIER expiry (never extend) — merge must not renew a bounded TTL.
    existing.expiresAt = Math.min(existing.expiresAt, expiresAt);
    return;
  }
  // If a DIFFERENT run has already claimed the latest-issued turn token by the
  // time this gate registers, that run is our genuine successor (a fresh submit
  // issues its token at stream-start, then aborts us). Bind the handoff to it so
  // a successor that synchronously died can't leave the handoff claimable by an
  // unrelated later turn. When the latest-issued token is still our OWN (no
  // successor issued yet — e.g. a plan-mode restart minted asynchronously), leave
  // it unbound so that async successor may still claim it.
  const latestIssued = latestIssuedTurnToken.get(conversationId);
  // A newer token than ours counts as our successor ONLY when it's a genuine
  // supersession descendant that hasn't already ended. A merely-latest-issued but
  // UNRELATED later turn D (no sourceToken→…→D lineage) or a DEAD successor must NOT
  // be bound: binding to D would let D claim + inject our stale answer, and binding to
  // a dead successor strands it. In either case route the key(s) through durable
  // recovery instead of registering a claimable handoff (R115/R116 finding-1).
  const genuineSuccessor =
    latestIssued !== undefined &&
    latestIssued !== sourceToken &&
    !recentlyEndedTokens.has(latestIssued) &&
    isSupersessionDescendant(sourceToken, latestIssued);
  const nonGenuineLaterToken = latestIssued !== undefined && latestIssued !== sourceToken && !genuineSuccessor;
  if (nonGenuineLaterToken) {
    // No genuine live successor to hand off to (unrelated or dead) — recover durably.
    const keysToRecover = new Set<string>([answerKey]);
    if (existing && !racedStateInvalid(existing, conversationId)) {
      for (const k of existing.answerKeys) keysToRecover.add(k);
      racedAnswerHandoffs.delete(conversationId);
    }
    recoverOrphanedAnswerKeys(conversationId, keysToRecover);
    return;
  }
  const expectedSuccessorToken = genuineSuccessor ? latestIssued : undefined;
  // We're about to REPLACE an existing (different-source) handoff. If it's still
  // valid, don't silently drop its answer keys: MERGE them into the new handoff when
  // both target the SAME successor (out-of-order abort gates — A→B then X→B), else
  // recover the displaced keys durably so they aren't orphaned (R89).
  const displacedKeys = new Set<string>();
  if (existing && !racedStateInvalid(existing, conversationId)) {
    if (existing.expectedSuccessorToken === expectedSuccessorToken) {
      for (const k of existing.answerKeys) displacedKeys.add(k);
    } else {
      recoverOrphanedAnswerKeys(conversationId, existing.answerKeys);
    }
  }
  racedAnswerHandoffs.set(conversationId, {
    answerKeys: new Set([answerKey, ...displacedKeys]),
    cancelGenAtAbort,
    sourceToken,
    deliveryRetries: 0,
    expectedSuccessorToken,
    // When merging same-successor keys, keep the EARLIER expiry (never extend TTL).
    expiresAt: existing && displacedKeys.size > 0 ? Math.min(expiresAt, existing.expiresAt) : expiresAt,
  });
  while (racedAnswerHandoffs.size > MAX_RACED_ANSWER_HANDOFFS) {
    const oldest = racedAnswerHandoffs.keys().next().value;
    if (oldest === undefined) break;
    racedAnswerHandoffs.delete(oldest);
  }
}

function racedStateInvalid(state: RacedAnswerState, conversationId: string): boolean {
  return Date.now() > state.expiresAt || cancelGenerationChanged(conversationId, state.cancelGenAtAbort);
}

/**
 * Attempt to deliver any raced answers for a conversation to its live Mastra
 * claimant. Called from BOTH the successor-start path (after transfer) and the
 * answer-arrival path. Fires only when a live claimant AND at least one stashed
 * answer are present and the state is still valid. On a non-confirmed
 * `injectUserTurnAndRestart` result it re-stashes the answer and keeps the key in
 * the (still-registered, non-detached) claimant state so a retry can find it.
 */
function attemptRacedAnswerDelivery(conversationId: string): void {
  const claimant = liveRacedAnswerClaimant.get(conversationId);
  if (!claimant) return; // no live successor yet — answer arrival / successor start will retry
  // The claimant must STILL own the active stream. Between supersession (which
  // replaces activeStreams synchronously with turn C) and claimant B's async
  // finally (which deregisters B), B lingers here; delivering would splice the
  // stale answer into the UNRELATED turn C. Only deliver into the turn that
  // actually registered as claimant AND still owns the stream.
  if (activeStreams.get(conversationId)?.token !== claimant.token) return;
  const { state } = claimant;
  if (racedStateInvalid(state, conversationId)) {
    // Expired or a Stop intervened — abandon; answers stay in the bounded stash.
    liveRacedAnswerClaimant.delete(conversationId);
    return;
  }
  for (const answerKey of [...state.answerKeys]) {
    const answer = pendingQuestionAnswers.get(answerKey);
    if (!answer) continue; // answer not arrived yet — arrival retries
    // Consume optimistically; restore into the SAME (registered) claimant state
    // on a non-confirmed delivery so a retry still finds it.
    pendingQuestionAnswers.delete(answerKey);
    state.answerKeys.delete(answerKey);
    const text = formatRacedAnswerAsUserTurn(answer);
    const onFailure = (): void => {
      // If the conversation was DELETED while this delivery was in flight,
      // invalidateConversationRecovery already purged its recovery state — do NOT re-stash
      // (that would resurrect an answer for a deleted chat, R133 f-1). THROW-SAFE (R147): a
      // tombstone-lookup throw must NOT skip the re-stash (the answer was already removed from the
      // stash above — losing it + an unhandled rejection); a failed lookup → treat as not deleted.
      if (isConversationDeletedSafe(appHomeForRuntimeResolve, conversationId)) {
        return;
      }
      // Always put the answer back in the stash.
      stashQuestionAnswers(answerKey, answer);
      if (liveRacedAnswerClaimant.get(conversationId) === claimant) {
        // THIS claimant still owns the conversation — re-arm its own bounded retry.
        state.answerKeys.add(answerKey);
        if (state.deliveryRetries < MAX_RACED_ANSWER_DELIVERY_RETRIES) {
          state.deliveryRetries += 1;
          setTimeout(() => attemptRacedAnswerDelivery(conversationId), RACED_ANSWER_RETRY_MS);
        }
        return;
      }
      // The claimant was torn down / replaced WHILE delivery was in flight (an async
      // policy gate let the successor finish or be superseded after we optimistically
      // removed the key). Re-register it as a pre-successor handoff so a later turn
      // can pick it up — but ONLY under the SAME conditions as claimant teardown
      // (dropRacedAnswerClaimantForToken): (a) no explicit cancel (Stop) bumped the
      // generation, (b) the torn-down token wasn't a TERMINAL abort (a genuine
      // plan/dismiss), and (c) a LIVE replacement actually superseded it
      // (latestIssuedTurnToken advanced past it). On ordinary completion — no
      // replacement — DISCARD, so an unrelated later turn can't claim the stale answer.
      // Re-register the still-owed answer as a pre-successor handoff ONLY when a LIVE
      // replacement GENUINELY superseded the claimant — established by the recorded
      // supersession lineage (claimant.token → … → latestIssued), NOT mere token
      // difference. A token-difference check (latestIssued !== claimant.token) also
      // matches an UNRELATED turn C that merely started after claimant B completed
      // (B's async delivery gate still pending): C would then claim B's stale answer
      // (R82 misdelivery, the same recency-vs-lineage flaw R81 fixed at the rebind
      // site). Plus the usual guards: no Stop bumped the generation; the torn-down
      // token wasn't a TERMINAL abort. registerRacedAnswerHandoff binds the handoff to
      // latestIssued (sourceToken = claimant.token ≠ latestIssued), the genuine
      // successor in the chain.
      //
      // We do NOT register on ORDINARY completion (no genuine successor supersedes the
      // claimant), even when a delivery was in flight. There is no turn that
      // legitimately owns this answer: the run that asked the question finished. The
      // answer stays in the bounded stash and is recovered by id if that ask_user
      // question is re-invoked (the tool's execute reads the stash by toolCallId — see
      // waitForRacedAnswer/rekeyRacedAnswer). Registering a handoff here is unsound
      // either way: UNBOUND lets an unrelated turn claim it (R76 misdelivery);
      // SELF-BOUND to the completed token is either unclaimable (dead token) or, via
      // the rebind path, ALSO reaches an unrelated newer turn (R80/R82 misdelivery).
      // The stash is the correct resting place.
      const latestIssued = latestIssuedTurnToken.get(conversationId);
      const supersededByLiveReplacement =
        latestIssued !== undefined &&
        latestIssued !== claimant.token &&
        // Must not have already ENDED — a dead successor (registered its supersession
        // edge, then config-failed + cleaned up) would otherwise get a handoff no
        // claimant/tombstone ever recovers, losing the answer (R116 finding-2). The
        // else-branch below then performs durable recovery instead.
        !recentlyEndedTokens.has(latestIssued) &&
        isSupersessionDescendant(claimant.token, latestIssued);
      if (
        !cancelGenerationChanged(conversationId, state.cancelGenAtAbort) &&
        !terminalAbortTokens.has(claimant.token) &&
        supersededByLiveReplacement
      ) {
        // Carry the ORIGINAL expiry forward so repeated teardowns can't renew the TTL.
        registerRacedAnswerHandoff(conversationId, answerKey, state.cancelGenAtAbort, claimant.token, state.expiresAt);
        // If a replacement claimant is ALREADY live (it passed its claim site before
        // this teardown), MERGE the requeued key into it + deliver, so the answer
        // isn't stuck until the next trigger. No-op if there's no live claimant yet
        // (a later successor start transfers the handoff instead).
        mergePendingHandoffIntoLiveClaimant(conversationId);
      } else if (
        !cancelGenerationChanged(conversationId, state.cancelGenAtAbort) &&
        !terminalAbortTokens.has(claimant.token) &&
        (state.deliveryInFlightCount ?? 0) > 0
      ) {
        // ORDINARY completion (no genuine successor) but a delivery was IN FLIGHT: the
        // run finished before consuming an answer the user DID submit. A raced-answer
        // handoff can't own this without misdelivery (see above), so hand it to the
        // durable recovery path: re-inject into the ORIGIN conversation as a labeled
        // turn, with a persistent Alert fallback (deliverRecoveredAnswer). On inline
        // delivery, purge the stash copy (delivered elsewhere); otherwise the alert
        // fallback / bounded stash retains it. Never registers a claimable handoff.
        const deliverer = getRecoveredAnswerDeliverer();
        if (deliverer) {
          // We don't carry the original question title in the raced state; the
          // deliverer falls back to a generic "your earlier question" label.
          void deliverer(conversationId, '', answer)
            .then((res) => {
              if (res.delivered) pendingQuestionAnswers.delete(answerKey);
            })
            .catch(() => {
              /* best-effort — the re-stashed copy above remains as the last resort */
            });
        }
      }
    };
    // A TERMINAL outcome (policy hook blocked the answer / a hook errored) must
    // NOT be retried — re-running enforcement 20× would repeat the same block and
    // then silently drop the answer anyway. Purge the key so it isn't re-stashed
    // or re-delivered from any surface, and surface it in the trace.
    const onTerminal = (): void => {
      purgeRacedAnswerForKey(answerKey);
    };
    // Mark the delivery in-flight (COUNTER — parallel sibling answers each track
    // their own) so a claimant teardown DURING the (async policy gate) delivery
    // re-registers the handoff even on ordinary completion (see onFailure) — the
    // answer is genuinely still owed. Decremented when this deliver settles.
    state.deliveryInFlightCount = (state.deliveryInFlightCount ?? 0) + 1;
    void claimant
      .deliver(text)
      .then((res) => {
        // Run the failure handler BEFORE decrementing the in-flight count: onFailure
        // reads it (>0) to decide whether to re-register the handoff on an ordinary
        // completion (see above). Decrementing first could drop it to 0 and make
        // onFailure see "not in flight" — the very bug this counter exists to prevent.
        if (!res.ok) {
          if (res.terminal) onTerminal();
          else onFailure();
        }
        state.deliveryInFlightCount = Math.max(0, (state.deliveryInFlightCount ?? 1) - 1);
        traceDiagnostic({
          scope: 'agent',
          event: 'question.answer-handoff-claimed',
          level: res.ok ? 'warn' : 'error',
          conversationId,
          toolName: 'ask_user',
          fields: { status: res.ok ? 'delivered' : res.terminal ? 'blocked-by-policy' : 'failed' },
        });
      })
      .catch(() => {
        onFailure();
        state.deliveryInFlightCount = Math.max(0, (state.deliveryInFlightCount ?? 1) - 1);
      });
  }
}

/** Recovery TOMBSTONES: answerKey → {conversationId, expiresAt, cancelGenAtRecord}.
 *  Recorded whenever a raced-answer handoff/claimant is dropped with NO viable
 *  successor (ordinary completion, non-Mastra takeover, dead bound successor) AND
 *  the answer hasn't arrived yet. Keeps the answerKey→conversation association alive
 *  through the handoff TTL so a LATE-arriving answer can still be routed durably by
 *  agent:answer-tool-question, instead of being silently orphaned in the bounded
 *  stash under an obsolete id (R87). Bounded FIFO; lazily expired. The captured
 *  cancel generation invalidates the tombstone across an explicit Stop, so a stale
 *  surface answering within the TTL can't start a recovered tool-capable turn after
 *  the user stopped (R88). */
const recoveryTombstones = new Map<
  string,
  { conversationId: string; expiresAt: number; cancelGenAtRecord: number | undefined }
>();
const MAX_RECOVERY_TOMBSTONES = 400;
function recordRecoveryTombstone(conversationId: string, answerKey: string): void {
  recoveryTombstones.set(answerKey, {
    conversationId,
    expiresAt: Date.now() + RACED_ANSWER_HANDOFF_TTL_MS,
    cancelGenAtRecord: captureCancelGeneration(conversationId),
  });
  while (recoveryTombstones.size > MAX_RECOVERY_TOMBSTONES) {
    const oldest = recoveryTombstones.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    recoveryTombstones.delete(oldest);
  }
}
/** The still-valid tombstone conversation for a key, or undefined (also purges an
 *  expired / Stop-invalidated entry). Invalid when the TTL passed OR an explicit
 *  cancel (Stop) bumped the conversation's generation since the tombstone was
 *  recorded — a stale answer must not resurrect a stopped turn. */
function recoveryTombstoneConversation(answerKey: string): string | undefined {
  const t = recoveryTombstones.get(answerKey);
  if (!t) return undefined;
  if (Date.now() > t.expiresAt || cancelGenerationChanged(t.conversationId, t.cancelGenAtRecord)) {
    recoveryTombstones.delete(answerKey);
    return undefined;
  }
  return t.conversationId;
}

/** R251/R252: recover the run nonce for a `${convId}::<nonce>::${toolCallId}` key by scanning the run-scoped
 *  raced-answer RECOVERY state (handoff answerKeys + LIVE claimant answerKeys + tombstone keys). This is the
 *  ONLY server-side place the nonce reliably survives a post-abort settle of an ORDINARY `any-renderer`
 *  approval (no durable authority record exists for those). R252: include the live claimant — once a successor
 *  transfers a handoff into liveRacedAnswerClaimant, the handoff map no longer holds the key. Returns the nonce
 *  ONLY on an UNAMBIGUOUS single match; undefined otherwise (caller falls back to the conversation-only key). */
function recoverRunNonceFromRecoveryState(convId: string | undefined, toolCallId: string): string | undefined {
  if (!convId) return undefined;
  const prefix = `${convId}::`;
  const suffix = `::${toolCallId}`;
  const seen = new Set<string>();
  const consider = (key: string): void => {
    if (!key.startsWith(prefix) || !key.endsWith(suffix)) return;
    const middle = key.slice(prefix.length, key.length - suffix.length);
    if (middle.length === 0 || middle.includes('::')) return;
    seen.add(middle);
  };
  const state = racedAnswerHandoffs.get(convId);
  if (state) {
    for (const k of state.answerKeys) consider(k);
  }
  const claimant = liveRacedAnswerClaimant.get(convId);
  if (claimant) {
    for (const k of claimant.state.answerKeys) consider(k);
  }
  for (const [k, t] of recoveryTombstones) {
    if (t.conversationId === convId) consider(k);
  }
  return seen.size === 1 ? [...seen][0] : undefined;
}

/** Route any ALREADY-STASHED answers for these keys through the durable
 *  recovered-answer path (re-inject into the ORIGIN conversation as a labeled turn,
 *  or persist as an Alert) instead of leaving them orphaned in the bounded stash
 *  when their handoff/claimant is about to be dropped with NO viable successor —
 *  an ordinary-completion teardown, a non-Mastra successor takeover, or a handoff
 *  bound to an already-dead successor (R86). Best-effort + bounded; the stash copy
 *  remains as the last resort. Consumes the stash key on successful inline delivery.
 *  ALSO records a TTL-bound recovery tombstone per key so a LATE-arriving answer
 *  (not yet stashed here) is still routed by agent:answer-tool-question (R87), and
 *  the durable path is re-driven when the late answer arrives. */
function recoverOrphanedAnswerKeys(conversationId: string, keys: Iterable<string>): void {
  const deliverer = getRecoveredAnswerDeliverer();
  for (const key of keys) {
    const answer = pendingQuestionAnswers.get(key);
    if (answer && deliverer) {
      // The answer is ALREADY present — deliver it inline (one-shot) and do NOT
      // leave a tombstone: a lingering tombstone would let ANOTHER surface submit
      // the same card during/after delivery and queue a DUPLICATE recovered turn
      // (R88). Clear any prior tombstone for this key too.
      recoveryTombstones.delete(key);
      void deliverer(conversationId, '', answer)
        .then((res) => {
          if (res.delivered) pendingQuestionAnswers.delete(key);
        })
        .catch(() => {
          /* best-effort — the bounded stash copy remains as the last resort */
        });
    } else {
      // Answer hasn't arrived (or no deliverer wired) — record a TTL-bound tombstone
      // so a LATE answer can still be routed durably by agent:answer-tool-question.
      recordRecoveryTombstone(conversationId, key);
    }
  }
}

/** Public hook for a non-Mastra runtime (e.g. the Claude Agent SDK ask_user
 *  handler) to route a raced/aborted ask_user answer through the SAME durable
 *  recovered-answer path the Mastra drop-sites use. When abort settles the SDK's
 *  ask_user before its answer is consumed, the SDK tears down its query()
 *  subprocess and can't return the answer inline, and its randomly-minted
 *  `sdk-ask-*` id has no conversation binding — so without this the answer would be
 *  orphaned in the bounded stash and eventually FIFO-evicted / lost on restart
 *  (R93). Calling this at SDK abort delivers an already-arrived answer inline
 *  (labeled re-inject / Alert) and, for a not-yet-arrived one, records a TTL-bound
 *  tombstone so agent:answer-tool-question routes the late answer durably.
 *
 *  `streamToken` is the SDK stream's token, captured while the stream was live. A
 *  TERMINAL abort — explicit user Stop or a genuine plan dismiss — marks that token
 *  in terminalAbortTokens BEFORE aborting. An abort settle-source alone can't tell a
 *  Stop from a supersession (both abort the signal), and on Stop the cancel
 *  generation is ALREADY bumped, so a freshly-recorded tombstone would capture the
 *  post-Stop generation as valid and let a late answer resurrect the stopped turn.
 *  So when the token is terminal, skip recovery entirely: the answer stays in the
 *  bounded stash, never routed into a new turn (R95). Mirrors the Mastra gate's
 *  `terminalAbortTokens.has(streamToken)` check. */
export function recoverAskUserAnswerForRuntime(conversationId: string, answerKey: string, streamToken?: string): void {
  if (!conversationId || !answerKey) return;
  if (streamToken !== undefined && terminalAbortTokens.has(streamToken)) {
    traceDiagnostic({
      scope: 'agent',
      event: 'question.answer-dropped-on-terminal-abort',
      level: 'warn',
      conversationId,
      toolName: 'ask_user',
      fields: { toolCallId: answerKey, streamToken, runtime: 'non-mastra' },
    });
    return;
  }
  // A mass-delete (deleteMany/clear) aborts SDK questions in a synchronous loop; the
  // FIFO terminalAbortTokens set (bounded) could evict this run's token before the
  // check above under a >100-conversation delete. Don't route recovery for a DELETED
  // conversation — it would record a tombstone / raise an Alert pointing at a deleted chat
  // (R96). Use the DURABLE deletion tombstone (isWriteTombstoned = in-memory OR the index's
  // persisted deleted-id ring), NOT a null read: a transient I/O error also reads null (would
  // drop a live answer), and an in-memory-only tombstone can expire/evict before this routes
  // under a huge bulk-delete (R134 f-1). All delete paths set the durable ring. THROW-SAFE
  // (R147): a lookup throw must NOT skip recording the recovery tombstone (the answer would be
  // lost under an obsolete sdk-ask-* id) — a failed lookup → treat as not deleted → recover.
  if (isConversationDeletedSafe(appHomeForRuntimeResolve, conversationId)) {
    return;
  }
  recoverOrphanedAnswerKeys(conversationId, [answerKey]);
}

/** Validate the OPTIONAL, UNTRUSTED conversationId that arrives with an answer/reject/dismiss over the
 *  (possibly web/WS) IPC boundary. Returns the string when it is a bounded non-empty string, else
 *  undefined — makeAnswerKey then falls back to the raw id (legacy/headless behavior). Keeping this in
 *  ONE place ensures the answer path and the reject/dismiss purge compose the SAME composite key (R192).
 *  The cap is only anti-abuse (bounding the composite stash key's byte size) — set generously above any
 *  real conversation/sub-agent/automation id (UUIDs, `auto-…`, `subagent-…`) so a legitimately long id is
 *  never silently downgraded to undefined (which would miss the composite lookup and wedge the turn — R193). */
function sanitizeAnswerConversationId(conversationId: unknown): string | undefined {
  return typeof conversationId === 'string' && conversationId.length > 0 && conversationId.length <= 1024
    ? conversationId
    : undefined;
}

/** Find the conversation whose pending handoff OR live claimant holds `answerKey`
 *  (the answer-arrival side only knows the key). Bounded scan over small maps. */
function conversationForRacedAnswerKey(answerKey: string): string | undefined {
  for (const [conversationId, c] of liveRacedAnswerClaimant) {
    if (c.state.answerKeys.has(answerKey)) return conversationId;
  }
  for (const [conversationId, h] of racedAnswerHandoffs) {
    if (h.answerKeys.has(answerKey)) return conversationId;
  }
  return undefined;
}

/** Purge a specific answerKey from any pending handoff / live claimant (used when
 *  the user explicitly rejects/dismisses the question AFTER its turn aborted +
 *  registered a handoff — a delayed answer from another surface must then NOT be
 *  delivered). Drops an emptied handoff. For a LIVE claimant, drops it only when it
 *  no longer owns the active stream: a claimant that STILL owns its run must survive
 *  empty (its run is ongoing and another parallel ask_user call may register a late
 *  successor-bound handoff that needs a live claimant to merge into — deleting it
 *  here would strand that answer). It is torn down on the run's teardown. */
function purgeRacedAnswerForKey(answerKey: string): void {
  // FIRST-SURFACE-WINS: if an answer for this key is ALREADY stashed, a surface
  // answered and won the abort race — a LATER reject/dismiss from a DIFFERENT open
  // surface must NOT purge the handoff (that would override the accepted answer and
  // prevent its delivery to the successor). Only purge when no answer has won yet.
  if (pendingQuestionAnswers.has(answerKey)) return;
  for (const [conversationId, c] of liveRacedAnswerClaimant) {
    if (c.state.answerKeys.delete(answerKey) && c.state.answerKeys.size === 0) {
      const stillOwnsRun = activeStreams.get(conversationId)?.token === c.token;
      if (!stillOwnsRun) liveRacedAnswerClaimant.delete(conversationId);
    }
  }
  for (const [conversationId, h] of racedAnswerHandoffs) {
    if (h.answerKeys.delete(answerKey) && h.answerKeys.size === 0) {
      racedAnswerHandoffs.delete(conversationId);
    }
  }
  // Also drop any recovery tombstone for this key: an explicit reject/dismiss means a
  // late answer from another open surface must NOT be routed through the durable
  // recovered-answer path within the TTL, overriding the user's rejection (R88).
  recoveryTombstones.delete(answerKey);
}

/**
 * Throw-safe "is this conversation confirmed-deleted?" (R147). isWriteTombstoned reads the index
 * and can THROW (readIndex → readdirSync EMFILE/permission during a rebuild), so it is NOT a total
 * boolean. Every recovery/abandonment decision must treat a lookup FAILURE as "not deleted" — a
 * throw must never skip re-stashing / recovery-routing for a possibly-LIVE conversation (that
 * would silently lose a real answer / cause an unhandled rejection). Only a CONFIRMED tombstone
 * abandons.
 */
function isConversationDeletedSafe(appHome: string, conversationId: string): boolean {
  try {
    return isWriteTombstoned(appHome, conversationId);
  } catch {
    return false;
  }
}

/**
 * Invalidate ALL recovery state for a conversation on confirmed DELETE (R132 finding-3).
 * Deletion removes the on-disk record BEFORE cancelConversationStream runs, so the
 * cancel-stream "real conversation" guard (which reads the record) skips the generation bump
 * for an idle deleted chat — leaving its recovery tombstones valid. A later stale answer from
 * another surface would then route through the durable recovered-answer path and raise a
 * persistent FYI Alert referencing the already-deleted conversation. Purge directly (no record
 * needed): tombstones + handoffs + live claimants + pending/in-flight answers for its keys, so
 * nothing can resurrect or surface an answer for a chat the user deleted.
 */
export function invalidateConversationRecovery(conversationId: string): void {
  // Tombstones + handoffs + claimants are keyed/tagged by conversationId — drop them, and
  // collect the answer keys they referenced so their stashed answers go too.
  const keys = new Set<string>();
  for (const [answerKey, t] of recoveryTombstones) {
    if (t.conversationId === conversationId) {
      keys.add(answerKey);
      recoveryTombstones.delete(answerKey);
    }
  }
  const handoff = racedAnswerHandoffs.get(conversationId);
  if (handoff) {
    for (const k of handoff.answerKeys) keys.add(k);
    racedAnswerHandoffs.delete(conversationId);
  }
  const claimant = liveRacedAnswerClaimant.get(conversationId);
  if (claimant) {
    for (const k of claimant.state.answerKeys) keys.add(k);
    liveRacedAnswerClaimant.delete(conversationId);
  }
  for (const k of keys) {
    pendingQuestionAnswers.delete(k);
    clearInFlightAnswer(k);
  }
  // Also drop any in-flight answer tagged with THIS conversation but held under a key the maps
  // above didn't reference (a consumed answer on a superseded predecessor awaiting PostToolUse —
  // invisible to the tombstone/handoff/claimant scan). Otherwise the predecessor's later cleanup
  // would start a recovery delivery for the deleted chat (R139 f-3).
  dropInFlightAnswersForConversation(conversationId);
  // R243: this runs on confirmed conversation DELETE/clear (see conversations:delete/deleteMany/clear). Hard-purge
  // all persistence state for the gone conversation — unlike a Stop, a deleted chat can never flush a retained
  // orphaned inject-prefix (reads return null forever), so retaining it would leak text/tool payloads until exit.
  purgeConversationPersistence(conversationId);
}

/** Tear down a successor's raced-answer state for this token: clear its claimant
 *  AND drop a pre-successor holding entry ONLY when THIS token was its intended
 *  (now-dead) successor. Called on every terminal/early-exit path (from
 *  cleanupStreamIfOwned, BEFORE its ownership guard). Token-scoped claimant clear
 *  so a replacement's own claimant survives. */
function dropRacedAnswerClaimantForToken(conversationId: string, token: string): void {
  const claimant = liveRacedAnswerClaimant.get(conversationId);
  if (claimant && claimant.token === token) {
    // A TERMINAL abort of this token (explicit Stop, or a genuine exit_plan_mode
    // dismiss — which marks the token terminal WITHOUT bumping the cancel gen) must
    // DISCARD the claimant's keys, NOT re-register them: there is no successor, so a
    // late answer must not reach a later unrelated turn. (racedStateInvalid only
    // catches a cancel-gen bump, so check terminalAbortTokens explicitly.)
    if (terminalAbortTokens.has(token)) {
      liveRacedAnswerClaimant.delete(conversationId);
      return;
    }
    // The claimant is torn down but may STILL hold undelivered answer keys (a slow
    // or remote answer that never arrived before this successor finished). Re-register
    // them as a pre-successor handoff so a LATER turn / late answer can pick them up —
    // but ONLY when this run is being SUPERSEDED by a live replacement (a NEWER turn
    // token was issued for this conversation). On ORDINARY completion (this token is
    // still the latest issued — no replacement), DISCARD instead: keeping the answer
    // alive would let an unrelated turn C started within the 30s TTL claim + inject
    // A's stale answer. (The answer stays in the bounded stash either way.)
    const latestIssued = latestIssuedTurnToken.get(conversationId);
    // A newer token was issued for a genuine SUPERSESSION of this run, and that
    // replacement has not already ENDED. Two guards beyond "a newer token exists":
    //   • recentlyEndedTokens: the replacement (e.g. C) may have FAILED to register —
    //     config load threw before its claimant/stream came up — and be marked ended.
    //     Binding a handoff to a dead successor strands the answer (no claimant ever
    //     consumes it; its handoff reference also bypasses tombstone recovery) (R115).
    //   • isSupersessionDescendant: the newer token must be in THIS run's supersession
    //     lineage — not an UNRELATED later turn D that happens to be latest-issued
    //     (which would otherwise inherit + inject A's stale answer without a B→D edge).
    // A not-yet-registered but alive successor in the chain still qualifies (that's
    // what the pre-successor handoff is FOR). A dead/unrelated replacement → treat as
    // ordinary completion below (recover the keys durably).
    const supersededByLiveReplacement =
      latestIssued !== undefined &&
      latestIssued !== token &&
      !recentlyEndedTokens.has(latestIssued) &&
      isSupersessionDescendant(token, latestIssued);
    if (
      supersededByLiveReplacement &&
      claimant.state.answerKeys.size > 0 &&
      !racedStateInvalid(claimant.state, conversationId)
    ) {
      for (const key of claimant.state.answerKeys) {
        registerRacedAnswerHandoff(
          conversationId,
          key,
          captureCancelGeneration(conversationId),
          token, // sourceToken = this finished successor; a later DIFFERENT run claims it
          claimant.state.expiresAt, // carry ORIGINAL expiry — repeated successors can't renew the TTL
        );
      }
      liveRacedAnswerClaimant.delete(conversationId);
      // A replacement C may ALREADY be the live claimant (it passed its own claim
      // site before this lagging teardown re-registered the handoff). Merge into it
      // now so the requeued answer isn't stuck in the pre-successor map until TTL.
      mergePendingHandoffIntoLiveClaimant(conversationId);
      return;
    }
    // ORDINARY completion (no live replacement): don't re-register a claimable
    // handoff (an unrelated later turn could grab it). But an answer already stashed
    // for an undelivered key is owed to THIS conversation — route it through the
    // durable recovered-answer path (labeled re-inject / Alert) BEFORE dropping, so
    // it isn't orphaned in the bounded stash under an obsolete tool-call id (R86).
    if (claimant.state.answerKeys.size > 0 && !racedStateInvalid(claimant.state, conversationId)) {
      recoverOrphanedAnswerKeys(conversationId, claimant.state.answerKeys);
    }
    liveRacedAnswerClaimant.delete(conversationId);
  }
  // Drop a pre-successor holding entry ONLY when THIS token was its INTENDED
  // successor that has now died (bound handoff, expectedSuccessorToken === token).
  // A handoff bound to a DIFFERENT successor — e.g. a newer A→B handoff registered
  // while an OLDER superseded run C's cleanup lagged — must survive C's teardown
  // (C is neither its source nor its intended successor). An UNBOUND handoff
  // (plan-restart, no known successor) is never dropped here; it ages out via TTL.
  const handoff = racedAnswerHandoffs.get(conversationId);
  if (handoff && handoff.expectedSuccessorToken !== undefined && handoff.expectedSuccessorToken === token) {
    // The intended successor died — recover any stashed answers durably + leave a
    // TTL tombstone for a late arrival BEFORE dropping, so the answer isn't silently
    // lost (R89). Only when not a terminal Stop (a Stop's cancel-gen invalidates the
    // tombstone anyway) and the state is still valid.
    if (!terminalAbortTokens.has(token) && !racedStateInvalid(handoff, conversationId)) {
      recoverOrphanedAnswerKeys(conversationId, handoff.answerKeys);
    }
    racedAnswerHandoffs.delete(conversationId);
  }
}

/** Register the current Mastra turn as the live claimant: TRANSFER the pending
 *  handoff keys into a token-scoped claimant record, then attempt delivery (the
 *  answer may already be stashed). When there's no pending handoff YET but a prior
 *  (different-token) claimant still owns this conversation's raced state — a
 *  predecessor being superseded by THIS run whose async teardown will re-register
 *  a handoff shortly — register with EMPTY keys so that late handoff can merge in
 *  (mergePendingHandoffIntoLiveClaimant). No-op if neither condition holds. */
/** Register the current Mastra turn as the live claimant: TRANSFER the pending
 *  handoff keys into a token-scoped claimant record, then attempt delivery (the
 *  answer may already be stashed). When there's no pending handoff YET but a prior
 *  (different-token) claimant still owns this conversation's raced state — a
 *  predecessor being superseded by THIS run whose async teardown will re-register
 *  a handoff shortly — register with EMPTY keys so that late handoff can merge in
 *  (mergePendingHandoffIntoLiveClaimant). `forceEmpty` ALSO registers an empty
 *  claimant when there is neither a handoff nor a prior claimant: used when THIS
 *  run superseded a live predecessor that may still be awaiting a slow ask_user
 *  PreToolUse hook and will register its (successor-bound) handoff only AFTER this
 *  claim site — the empty claimant gives that late handoff a live target to merge
 *  into. No-op otherwise. */
function registerLiveRacedAnswerClaimant(
  conversationId: string,
  token: string,
  deliver: (text: string) => Promise<RacedDeliverResult>,
  opts?: { forceEmpty?: boolean },
): void {
  const handoff = racedAnswerHandoffs.get(conversationId);
  if (!handoff) {
    // No handoff now. If a prior claimant still owns the raced state (a predecessor
    // being superseded by this run), INHERIT its still-pending answer keys into a
    // fresh claimant bound to THIS token, and attempt delivery — so a supersession
    // in the delivery window doesn't drop the predecessor's undelivered answer.
    const prior = liveRacedAnswerClaimant.get(conversationId);
    // Inherit a prior claimant's pending keys ONLY when THIS run genuinely superseded
    // it (recorded supersession lineage prior.token → … → token). Without this an
    // UNRELATED later turn D that merely started while B's teardown lagged would
    // inherit B's claimant and receive B's stale answer (no B→D edge) (R115). A true
    // successor in the chain still inherits; an unrelated run leaves B's keys for B's
    // own teardown to recover durably.
    if (prior && prior.token !== token && isSupersessionDescendant(prior.token, token)) {
      const inheritedKeys = new Set(prior.state.answerKeys);
      liveRacedAnswerClaimant.set(conversationId, {
        token,
        deliver,
        state: {
          answerKeys: inheritedKeys,
          cancelGenAtAbort: prior.state.cancelGenAtAbort,
          sourceToken: token,
          deliveryRetries: 0,
          // Inherit the prior's expiry — a supersession-chain must not renew the TTL.
          expiresAt: prior.state.expiresAt,
        },
      });
      if (!racedStateInvalid(liveRacedAnswerClaimant.get(conversationId)!.state, conversationId)) {
        attemptRacedAnswerDelivery(conversationId);
      }
      return;
    }
    // No handoff AND no prior claimant. Register an EMPTY claimant only when asked
    // (forceEmpty): this run superseded a live predecessor whose still-pending
    // ask_user hook may register a successor-bound handoff after this point. The
    // empty claimant carries no keys (delivers nothing now) and is torn down on
    // teardown; it exists purely so mergePendingHandoffIntoLiveClaimant / answer
    // arrival has a live target when that late handoff lands.
    if (opts?.forceEmpty && !prior) {
      liveRacedAnswerClaimant.set(conversationId, {
        token,
        deliver,
        state: {
          answerKeys: new Set<string>(),
          cancelGenAtAbort: captureCancelGeneration(conversationId),
          sourceToken: token,
          deliveryRetries: 0,
          expiresAt: Date.now() + RACED_ANSWER_HANDOFF_TTL_MS,
        },
      });
    }
    return;
  }
  // If the handoff is BOUND to a specific successor token (a supersession whose
  // successor was already issued at abort time), only that exact successor may
  // transfer it. A mismatch normally means this is an unrelated later turn — leave
  // the handoff in the pre-successor map so the real successor can still claim it,
  // or so it ages out if that successor died (the R27-P2b residual). Do NOT deliver.
  //
  // EXCEPTION — the bound successor was ITSELF superseded BY THIS TURN's lineage: A
  // bound the answer to B, but C superseded B before B reached this claim site. C
  // arrives here with a mismatch, and if we just returned, B's teardown
  // (expectedSuccessorToken === B) would delete the handoff and orphan the answer.
  // REBIND to C ONLY when C genuinely superseded B — established by the recorded
  // supersession lineage (B → … → C), NOT by token recency. A recency-only check
  // (B inactive + C newer) would also match an UNRELATED later turn C that merely
  // started within the TTL, misdelivering B's stale answer into it (R81).
  if (handoff.expectedSuccessorToken !== undefined && handoff.expectedSuccessorToken !== token) {
    const boundToken = handoff.expectedSuccessorToken;
    const activeToken = activeStreams.get(conversationId)?.token;
    const boundSuccessorSuperseded = activeToken !== boundToken && isSupersessionDescendant(boundToken, token);
    const thisIsCurrentActive = activeToken === token;
    if (boundSuccessorSuperseded && thisIsCurrentActive) {
      handoff.expectedSuccessorToken = token; // rebind to the genuine successor in the chain
    } else {
      return;
    }
  }
  racedAnswerHandoffs.delete(conversationId); // transfer out of the pre-successor map
  if (racedStateInvalid(handoff, conversationId)) return; // expired / Stop → drop (answers stay stashed)
  // If a PRIOR claimant (a superseded predecessor B whose teardown is still pending)
  // still holds undelivered keys, MERGE them into the handoff before replacing it —
  // else overwriting B's claimant here loses A's keys B was carrying, and B's later
  // teardown sees C's token and can't recover them. Keep the earliest expiry.
  const priorClaimant = liveRacedAnswerClaimant.get(conversationId);
  if (priorClaimant && priorClaimant.token !== token) {
    for (const k of priorClaimant.state.answerKeys) handoff.answerKeys.add(k);
    handoff.expiresAt = Math.min(handoff.expiresAt, priorClaimant.state.expiresAt);
  }
  liveRacedAnswerClaimant.set(conversationId, { token, deliver, state: handoff });
  attemptRacedAnswerDelivery(conversationId);
}

/** If a live claimant ALREADY owns the conversation's active stream AND a pending
 *  pre-successor handoff exists (e.g. a prior claimant's in-flight delivery failed
 *  and re-registered the answer AFTER the replacement passed its claim site), MERGE
 *  the handoff's keys into the live claimant and attempt delivery — so a requeued
 *  answer reaches an already-started successor instead of sitting until TTL. No-op
 *  if there's no live+owning claimant or no valid handoff. Respects the same
 *  successor-token binding as registerLiveRacedAnswerClaimant. */
function mergePendingHandoffIntoLiveClaimant(conversationId: string): void {
  const claimant = liveRacedAnswerClaimant.get(conversationId);
  if (!claimant) return;
  if (activeStreams.get(conversationId)?.token !== claimant.token) return; // not the owning run
  const handoff = racedAnswerHandoffs.get(conversationId);
  if (!handoff) return;
  // Honor the successor binding: only merge a handoff that this claimant is allowed
  // to claim (unbound, or bound to this claimant's token). EXCEPTION: if the bound
  // successor was itself superseded BY THIS claimant's lineage (established by the
  // recorded supersession chain, NOT token recency — see registerLiveRacedAnswerClaimant),
  // rebind to this live claimant — else the answer would be orphaned when the bound
  // successor's teardown deletes the handoff. A recency-only check would misdeliver
  // the stale answer to an unrelated later turn (R81).
  if (handoff.expectedSuccessorToken !== undefined && handoff.expectedSuccessorToken !== claimant.token) {
    const boundToken = handoff.expectedSuccessorToken;
    // claimant already verified as the active stream above.
    if (isSupersessionDescendant(boundToken, claimant.token)) {
      handoff.expectedSuccessorToken = claimant.token;
    } else {
      return;
    }
  }
  racedAnswerHandoffs.delete(conversationId);
  if (racedStateInvalid(handoff, conversationId)) return;
  for (const key of handoff.answerKeys) claimant.state.answerKeys.add(key);
  attemptRacedAnswerDelivery(conversationId);
}

/**
 * Inject a user turn into a conversation and (re)start the stream — the shared
 * mechanism behind the GUI/CLI "mid-turn follow-up" behavior. When the target
 * is busy, streamHandler aborts the in-flight run and restarts with the new
 * combined branch (the aborted partial is discarded, same as the GUI). The
 * assistant reply is written via the server-persist accumulator (there may be
 * no renderer, e.g. an automation). Set by registerAgentHandlers (closes over
 * streamHandler + module state); consumed by the automations busy-inject path.
 * Returns { ok }. Background callers are rejected before any mutation when a
 * native Browser-authorized stream owns the conversation.
 */
export type InjectUserTurnFn = (
  conversationId: string,
  userText: string,
  opts?: {
    modelKey?: string;
    reasoningEffort?: ReasoningEffort;
    profileKey?: string;
    cwd?: string;
    /** Execution mode for the restarted turn. Threaded so a re-injection from a
     *  plan-first turn (e.g. an ask_user answer recovered after a plan-mode
     *  restart) does NOT silently resume in `auto` with mutating tools enabled. */
    executionMode?: ExecutionMode;
    /** Per-thread overrides (temperature / systemPromptOverride / maxSteps /
     *  maxRetries / runtimeOverride) so an abort+restart re-injection honors the
     *  conversation's own runtime instead of reverting to global/profile values
     *  (R93). Forwarded to streamHandler on the restart path. */
    threadOverrides?: {
      temperature?: number | null;
      systemPromptOverride?: string | null;
      maxSteps?: number | null;
      maxRetries?: number | null;
      runtimeOverride?: string | null;
    };
    /** COOPERATIVE-ONLY: never fall through to abort+restart. Used by raced-answer
     *  delivery — a stale ask_user answer must splice into the LIVE successor turn
     *  or fail; it must NEVER abort a newer run or restart after a Stop. When set
     *  and the run isn't cooperatively injectable (or ownership changed under the
     *  async gate), returns { ok:false, notCooperative:true } without restarting. */
    cooperativeOnly?: boolean;
    /** The stream token the caller expects to still own the conversation. With
     *  cooperativeOnly, enqueue only proceeds while this token is active — so a
     *  supersession that lands during the async policy gate can't misdeliver. */
    expectedToken?: string;
    /** Caller-allocated STABLE id for the persisted/spliced user turn (alert resume),
     *  so a post-failure commit check can find THIS exact turn regardless of a
     *  content-rewriting policy hook (R104). Applied to BOTH the cooperative enqueue
     *  and the abort+restart append. */
    userTurnId?: string;
    /** Resolved fallback-enabled for THIS caller's semantics (e.g. an automation's
     *  `opts.fallbackEnabled ?? Boolean(action.profileKey)`). Used in the cooperative
     *  fingerprint + the abort+restart so a profile-pinned action doesn't splice into
     *  / restart a no-fallback run when its fresh semantics enable fallback (R107 f-5).
     *  Falls back to the conversation's persisted toggle when omitted. */
    fallbackEnabled?: boolean;
  },
) => Promise<{
  ok: boolean;
  error?: string;
  injectedCooperatively?: boolean;
  blockedByPolicy?: boolean;
  notCooperative?: boolean;
}>;

let injectUserTurnAndRestart: InjectUserTurnFn | null = null;

/** Accessor for the automations engine (bound after registerAgentHandlers). */
export function getInjectUserTurnAndRestart(): InjectUserTurnFn | null {
  return injectUserTurnAndRestart;
}

/** Resolve the EFFECTIVE canonical DISPATCH DESCRIPTOR a turn WOULD use (mirrors the
 *  streamHandler resolution: resolveStreamConfig → primaryModel → resolveRuntimeForStream,
 *  with a thread runtimeOverride overlaid onto agent.runtime). The descriptor folds
 *  in NOT JUST resolution.runtimeId but ALSO providerOverride and
 *  inferenceProviderRuntimeId — because a run recorded with runtimeId 'mastra' can
 *  still route through a plugin provider override (e.g. legionio) or a plugin
 *  inference runtime, which streamForPlugin would IGNORE. Returning the bare
 *  runtimeId conflated those with plain Mastra, so an alert/recovered resume of such
 *  a conversation ran under ordinary Mastra and sent to the wrong provider (R100
 *  finding-4). The automations layer compares this to the plain-Mastra descriptor to
 *  decide whether to delegate to the runtime-resolving injectUserTurnAndRestart path.
 *  Falls back to the plain-Mastra descriptor on any resolution error. */
export const PLAIN_MASTRA_DISPATCH = 'mastra';
export async function resolveEffectiveRuntimeId(opts: {
  modelKey?: string;
  profileKey?: string;
  runtimeOverride?: string | null;
}): Promise<string> {
  try {
    const config = readEffectiveConfig(appHomeForRuntimeResolve);
    const streamConfig = resolveStreamConfig(config, {
      threadModelKey: opts.modelKey ?? null,
      threadProfileKey: opts.profileKey ?? null,
      fallbackEnabled: false,
    });
    const modelEntry = streamConfig?.primaryModel ?? null;
    const runtimeConfig = opts.runtimeOverride
      ? ({ ...config, agent: { ...config.agent, runtime: opts.runtimeOverride } } as AppConfig)
      : config;
    const { resolution } = await resolveRuntimeForStream(runtimeConfig, modelEntry);
    // Canonical descriptor: plain 'mastra' ONLY when there's no provider override and
    // no plugin inference runtime; otherwise a distinct string so the caller doesn't
    // treat it as ordinary (streamForPlugin-safe) Mastra.
    return runtimeDispatchDescriptor(resolution);
  } catch {
    return 'mastra';
  }
}
/** Captured at registerAgentHandlers so resolveEffectiveRuntimeId can read config
 *  without threading appHome through the automations layer. */
let appHomeForRuntimeResolve = '';

/** True if the given conversation's active stream is the server-persist owner. */
function isServerPersistOwner(conversationId: string, activeToken: string | undefined): boolean {
  const owner = serverPersistTokens.get(conversationId);
  return owner !== undefined && owner === activeToken;
}

/**
 * True if a stream event should be suppressed because it came from a SUPERSEDED
 * run — a run whose token no longer matches the conversation's active stream
 * token (a newer run took over, e.g. a mid-turn follow-up injection). Pure so it
 * can be unit-tested. Only suppresses TOKEN-STAMPED events: an untagged event
 * (`emittingToken === undefined`, e.g. an automation/external/approval broadcast)
 * is never suppressed, and while no run is active (`activeToken === undefined`)
 * nothing is stale.
 */
export function isSupersededRunEvent(emittingToken: string | undefined, activeToken: string | undefined): boolean {
  if (emittingToken === undefined || activeToken === undefined) return false;
  return emittingToken !== activeToken;
}

/** Open the optional dedicated approval surface and bind that exact window to
 * the already-registered pending request. Raw approval producers install this
 * helper through tool-approval.ts so every approval path gets identical
 * presence policy and one-shot authority. */
function maybeOpenDedicatedApprovalWindow(event: StreamEvent): void {
  if (event.type !== 'tool-approval-required' || !event.toolCallId || !event.conversationId) return;
  let popOut = false;
  if (serverPersistAppHome) {
    try {
      const raw = readEffectiveConfig(serverPersistAppHome).ui?.approvals?.dedicatedWindow;
      popOut = resolveApprovalPopOut(raw);
    } catch {
      popOut = false;
    }
  }
  if (!popOut) return;
  const win = openApprovalWindow({
    approvalId: event.toolCallId,
    conversationId: event.conversationId,
    runNonce: event.runGeneration, // R252: run-scope the pop-out registry so overlapping runs don't share a window
    toolName: event.toolName ?? 'tool',
    args: event.args,
  });
  const webContentsId = win?.webContents?.id;
  if (typeof webContentsId === 'number') {
    // R250: pass the emitting run's nonce so the pop-out binds to the RUN-SCOPED pending entry
    // (conversationId::runNonce::toolCallId). authorizePendingApprovalWindow falls back to the
    // conversation-scoped / raw key when the nonce is absent (legacy), matching registration.
    authorizePendingApprovalWindow(event.toolCallId, webContentsId, event.conversationId, event.runGeneration);
  }
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
  let eventToBroadcast: StreamEvent =
    event.type === 'tool-call'
      ? { ...event, args: redactBrowserToolArgsForExposure(event.toolName, event.args) }
      : event;
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
        const persistOutcome = accumulateForPersistence(serverPersistAppHome, eventToBroadcast, parentId ?? undefined);
        if (event.type === 'done') {
          // Clear persistence ownership only when the terminal finalize did NOT fail with a retained
          // accumulator (R169 f-1): if the append hit a transient write/read failure,
          // accumulateForPersistence returns 'failed' and KEEPS the accumulator for a retry — clearing
          // ownership here would orphan it (the next turn discards it), permanently losing a complete
          // CLI/headless reply. Leave ownership intact so a subsequent finalize (a follow-up turn's
          // drain, or a retry) can still persist it. On 'failed' we also keep runStatus as-is rather
          // than declaring the turn done.
          if (persistOutcome !== 'failed') {
            serverPersistTokens.delete(event.conversationId);
            serverPersistParents.delete(event.conversationId);
            clearFinalizedResponseIds(event.conversationId);
            void maybeAutoTitle(serverPersistAppHome, event.conversationId);
          }
        }
      }
    } else if (fromCurrentRun && serverPersistAppHome && guiFallbackParents.has(event.conversationId)) {
      // GUI turn (renderer-persisted) — accumulate its output in main as a FALLBACK so a SOLE
      // renderer that reloads/crashes mid-stream doesn't lose the reply (no one else persists
      // it). Do NOT let `done` finalize here (that would double-write with the renderer's own
      // persist); the stream loop's terminal handler polls disk and finalizes this accumulator
      // ONLY if the renderer didn't. Non-terminal events just build the accumulator.
      if (event.type === 'inject-consumed') {
        // Ordered cooperative-inject boundary (emitted AFTER the prior step's
        // chunks are in the accumulator — race-free, unlike the prepareStep-time
        // injectConsumedHandler). Split main's fallback: finalize the prefix,
        // reparent each injected user onto it, advance the head + rebind the
        // continuation accumulator. Shapes the crash-backstop tree correctly.
        const injEntries = ((event.data as { entries?: Array<{ id?: unknown }> } | undefined)?.entries ?? []).filter(
          (en): en is { id: string } => typeof en?.id === 'string',
        );
        // The parent the NEXT injected user attaches under. Starts as the
        // conversation's current fallback parent (the prior head), then walks
        // forward: each entry's finalize either produces a prefix assistant (new
        // parent = that assistant) or, when no content intervened in the same
        // batch, leaves the parent as the PRIOR injected user so the batch chains
        // in FIFO order. Every entry is reparented under this running parent AND
        // becomes the head — otherwise a multi-inject batch would strand entries
        // 2..N off the active branch on a reload/crash before continuation output.
        let chainParent: string | null = guiFallbackParents.get(event.conversationId) ?? null;
        let lastInjectedId: string | null = null;
        for (const en of injEntries) {
          const prefixHead = finalizeGuiFallbackPrefixAtInject(serverPersistAppHome, event.conversationId, en.id);
          if (prefixHead) chainParent = prefixHead;
          if (chainParent) {
            // R247: reparentConversationMessage can THROW (write failure), not just return falsy — treat both as
            // a failed splice so recordSpliceOnlyOrphan always runs and flushOrphanedPrefixes can retry.
            let spliced: unknown = null;
            try {
              spliced = reparentConversationMessage(serverPersistAppHome, event.conversationId, en.id, chainParent, {
                makeHead: true,
              });
            } catch {
              spliced = null;
            }
            // R246/R248: if the prefix persisted (prefixHead) but this SPLICE failed (falsy OR threw), record a
            // splice-only orphan so flushOrphanedPrefixes retries the reparent on the next finalize — otherwise
            // the continuation persists under the inject's sibling branch and hides the prefix permanently. R248:
            // record unconditionally (no disk reread) — a reread here would also fail if the conversation was
            // unreadable (the likely splice-failure cause), skipping the retry record. The prefix content is
            // already on disk; flushOrphanedPrefixes reads it fresh when it retries.
            if (!spliced && prefixHead && chainParent === prefixHead) {
              recordSpliceOnlyOrphan(event.conversationId, en.id, prefixHead);
            }
          }
          // The next entry in the batch chains under THIS injected user (its
          // continuation accumulator was reseeded parented on en.id, so any prefix
          // it later produces already sits here; with no intervening content the
          // sibling still threads correctly).
          chainParent = en.id;
          lastInjectedId = en.id;
        }
        if (lastInjectedId) guiFallbackParents.set(event.conversationId, lastInjectedId);
      } else if (event.type !== 'done') {
        accumulateForPersistence(
          serverPersistAppHome,
          eventToBroadcast,
          guiFallbackParents.get(event.conversationId) ?? undefined,
        );
      }
    }
  }

  // Dedicated approval window (ui.approvals.dedicatedWindow). Registration is
  // synchronous and happens before this broadcast, so the exact pop-out can be
  // attached as a one-shot resolver capability before any answer arrives.
  if (event.conversationId) {
    if (event.type === 'tool-approval-required' && event.toolCallId) {
      maybeOpenDedicatedApprovalWindow(event);
    } else if (event.type === 'tool-result' && event.toolCallId) {
      closeApprovalWindow(event.toolCallId, event.conversationId);
      // The tool-result committed — an ask_user answer consumed by execute() is now
      // on the branch, so drop its in-flight ledger entry (no recovery needed). No-op
      // for non-ask_user ids (the ledger only holds ask_user answers) (R100 finding-7).
      // BUT only when this event is NOT from a SUPERSEDED run: a stale predecessor can
      // emit its tool-result AFTER a successor took the stream, and that event is
      // suppressed (dropped, never persisted) below — clearing the ledger here would
      // discard the entry the predecessor's cleanup must still recover, silently
      // losing the answer (R101 finding-1). A live/owning run's tool-result IS
      // persisted, so clearing is correct then.
      // Only clear when the emitting run STILL OWNS the active stream (strict
      // same-token). isSupersededRunEvent returns false when there's NO active token
      // (a delayed tool-result from run A arriving AFTER successor B finished), which
      // would wrongly clear A's uncommitted ledger entry so A's cleanup recovers
      // nothing (R107 finding-1). A live/owning run's tool-result IS persisted, so
      // clearing is correct then; anything else leaves recovery to A's cleanup.
      const activeTok = event.conversationId ? activeStreams.get(event.conversationId)?.token : undefined;
      // The in-flight ledger is keyed by the run-scoped answerKey (R191/R192 conversation + R249 run).
      // For ask_user, exec id == stream id (pairing is by id-identity), so the event's toolCallId composes
      // the same key execute() ledgered under. execute keyed with THIS run's token as the nonce, and only
      // the OWNING run's tool-result reaches here (same-token guard below), so emittingToken IS that nonce.
      // Clear the run-scoped, conversation-scoped, AND raw keys defensively (R193/R249): the clear is
      // idempotent, and the fallbacks cover any path where the ledger entry was keyed with fewer parts
      // (no run token, or headless/legacy no conversationId) — otherwise a committed answer lingers and
      // teardown re-delivers it.
      if (emittingToken !== undefined && emittingToken === activeTok) {
        clearInFlightAnswer(makeAnswerKey(event.conversationId, event.toolCallId, emittingToken));
        clearInFlightAnswer(makeAnswerKey(event.conversationId, event.toolCallId));
        clearInFlightAnswer(event.toolCallId);
      }
    } else if (event.type === 'done') {
      // Turn ended (completed/cancelled) — no approval can still be pending.
      // We don't have a per-id list here; the window's own resolve path + the
      // tool-result close cover the normal case, and a stale window is harmless
      // (it self-closes on answer). Nothing to do for the bulk case.
    }
  }

  // Suppress events from a SUPERSEDED run. When a follow-up is injected mid-turn
  // (automation back-to-back messages), the prior run is aborted and a new run
  // takes over the conversation's active stream token. The aborted run can still
  // emit trailing deltas AND a terminal done/error before it notices the abort.
  // If broadcast, its deltas concatenate into the new turn's live message and its
  // stale `done` resets the UI mid-new-turn (stops the spinner + reloads from
  // disk — the reported "concatenated, then fixed once the final message lands"
  // bug). Drop ALL of a known-stale run's events: only when the event carries an
  // emitting token that DOESN'T match the current active token. Events with no
  // token (external/automation/approval broadcasts) are never suppressed; the new
  // run emits its own terminal done, so no client hangs.
  if (event.conversationId && emittingToken !== undefined) {
    const activeToken = activeStreams.get(event.conversationId)?.token;
    if (isSupersededRunEvent(emittingToken, activeToken)) {
      return;
    }
  }

  // Stamp the emitting run's STABLE token as a renderer-visible run generation so the
  // renderer can drop a superseded run's late events that slip through the server-side
  // supersession check above during the window before the replacement run registers its
  // activeStreams token. Stable across mid-stream fallback (unlike responseMessageId).
  if (emittingToken !== undefined && !(eventToBroadcast as { runGeneration?: string }).runGeneration) {
    eventToBroadcast = { ...eventToBroadcast, runGeneration: emittingToken } as StreamEvent;
  }

  // Per-recipient guarded fan-out: a throw from ONE window's send (destroyed /
  // navigating mid-send) must NOT abort delivery to the remaining healthy windows,
  // nor propagate to the caller — a raw loop that threw here left the local
  // persistence-owning renderer without its user node (→ discards the later
  // inject-consumed id, persists the continuation on the wrong branch) and could
  // leave agent:submit stuck 'running' before stream launch (R106 finding-1).
  // Browser-owned approvals are restricted to authorized windows (main's authority routing). R251: use the
  // STAMPED copy (eventToBroadcast) — it carries runGeneration (the run nonce), so lookupPendingByEvent can
  // resolve the RUN-SCOPED pending entry and recognize a browser-owned generic approval as restricted. The raw
  // `event` may not have runGeneration yet (stamped just above), which would miss the entry and over-broadcast.
  const authorizedApprovalWindowIds = resolveApprovalBroadcastWindowIds(eventToBroadcast);
  for (const win of BrowserWindow.getAllWindows()) {
    if (authorizedApprovalWindowIds && !authorizedApprovalWindowIds.has(win.webContents.id)) continue;
    try {
      if (!win.isDestroyed?.() && !win.webContents?.isDestroyed?.()) {
        win.webContents.send('agent:stream-event', eventToBroadcast);
      }
    } catch {
      /* window disappeared between the check and send; skip it, keep fanning out */
    }
  }
  // REMOTE clients are frame-capped (web WS 4 MiB / CLI local-bridge 8 MiB) — strip oversized
  // media/originals from the copy fanned out to them (local Electron windows keep the full event).
  // Shared with the sub-agent broadcast (electron/agent/remote-frame-cap.ts).
  if (mayBroadcastApprovalToWebClients(event)) {
    try {
      broadcastToWebClients('agent:stream-event', capRemoteEvent(eventToBroadcast));
    } catch {
      /* web-client fan-out is best-effort; never abort the caller (R106 finding-1) */
    }
  }
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
  systemPrompt: string = '',
): Promise<{ suppressed: boolean; messages: unknown[]; systemPrompt?: string }> {
  // NB: gateMessagesThroughUserPromptSubmit takes (…, modelKey, purpose, systemPrompt). Pass the
  // purpose explicitly so the title systemPrompt lands in the SIXTH arg — passing it as the fifth
  // would put it in `purpose` and leave the gate's systemPrompt empty (DLP hooks then see no
  // system prompt, and a system-prompt-conditioned rule could wrongly pass).
  return gateMessagesThroughUserPromptSubmit(
    messages,
    config,
    conversationId,
    modelKey,
    'title-generation',
    systemPrompt,
  );
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
    // must apply to CLI-created conversations too. Pass the ACTUAL title system prompt through the
    // gate (so a system-prompt-conditioned hook sees the real outbound context) and USE the gated
    // system prompt for generation. Suppressed ⇒ no title.
    const CLI_TITLE_SYSTEM_PROMPT =
      "Generate a concise conversation title using at most 4 words. Summarize the user's main topic or task, not the assistant's answer. Use a neutral noun phrase, not a sentence. Return only the title text with no quotes or formatting.";
    const gated = await gateTitleGenerationMessages(branch, config, conversationId, undefined, CLI_TITLE_SYSTEM_PROMPT);
    if (gated.suppressed) return;

    const input = buildTitleGenerationInput(gated.messages);
    if (!input) return;

    const title = await generateTitle({
      systemPrompt: gated.systemPrompt ?? CLI_TITLE_SYSTEM_PROMPT,
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
    const writtenLatest = writeConversation(appHome, latest);
    broadcastUpsert(appHome, writtenLatest);
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
  return filterToolsForExecutionMode(tools, executionMode);
}

/**
 * True when an `enter_plan_mode` tool RESULT indicates the tool did NOT enter plan mode (a
 * fail-closed persist failure, or a stopped-run refusal) — so MAIN must NOT abort+restart into
 * plan-first (the trust-disk reconcile would see 'auto' and run mutating tools). Covers every
 * result shape (R146 f-1): a Mastra OBJECT `{success:false}`; a Pi STRINGIFIED object; and the
 * SDK ERROR wrap `{isError:true, error:'{"success":false,...}'}` where the failure is nested in
 * `.error` (or just `isError:true`). Pure for focused unit coverage.
 */
function planEnterResultFailed(planResult: unknown): boolean {
  if (planResult == null) return false;
  if (typeof planResult === 'string') return /"success"\s*:\s*false/.test(planResult);
  if (typeof planResult === 'object') {
    const r = planResult as { success?: unknown; isError?: unknown; error?: unknown };
    if (r.success === false) return true;
    if (r.isError === true) return true; // any errored tool result → did NOT enter
    if (typeof r.error === 'string' && /"success"\s*:\s*false/.test(r.error)) return true;
  }
  return false;
}

/**
 * Reconcile a GUI-submitted executionMode against the persisted (MAIN-authoritative) mode.
 *
 * executionMode is MAIN-authoritative: the ONLY writers are genuine user intent (the composer
 * toggle / settings modal via the dedicated setter) and plan-mode transitions — reconciliation
 * paths (hydration, broadcasts) never write it (R127). So the PERSISTED mode is the true intended
 * mode, and the renderer-submitted value can be STALE in EITHER direction:
 *   - stale 'auto' submitted, disk 'plan-first' (R128 f-1) → must run plan-first (not expose tools)
 *   - stale 'plan-first' submitted, disk 'auto' (R129 f-3) → must run auto (a latched OR would
 *     pin plan-first forever after a plan→auto toggle on another client)
 * BOTH want the persisted value. So: trust disk whenever the conversation HAS a persisted record;
 * fall back to the submitted mode only when there is no persisted mode to consult (`persistedKnown`
 * false — a brand-new conversation whose first turn is dispatching before any record/mode exists).
 * A single renderer's set-execution-mode IPC precedes its submit IPC, so a toggle-then-send lands
 * the disk write first; `persistedKnown` guards the genuinely-recordless first-turn case.
 * Pure for focused unit coverage.
 */
function reconcileExecutionMode(
  submitted: ExecutionMode | undefined,
  persisted: ExecutionMode | undefined,
  persistedKnown: boolean,
): ExecutionMode {
  if (persistedKnown) return persisted ?? 'auto';
  return submitted ?? 'auto';
}

function toolsForRun(
  tools: ToolDefinition[],
  executionMode: ExecutionMode,
  allowNativeBrowserTools: boolean,
): ToolDefinition[] {
  const surfaceTools = allowNativeBrowserTools ? tools : tools.filter((tool) => tool.source !== 'browser');
  return toolsForExecutionMode(surfaceTools, executionMode);
}

function toolsForPluginInferenceProvider(
  tools: ToolDefinition[],
  executionMode: ExecutionMode,
  allowNativeBrowserTools: boolean,
  pluginManager: PluginManager | undefined,
  provider: PluginInferenceProvider,
): ToolDefinition[] {
  const providerMayUseBrowser =
    allowNativeBrowserTools &&
    pluginManager?.inferenceProviderHasPermission(provider, 'browser:authenticated-session') === true;
  return toolsForRun(tools, executionMode, providerMayUseBrowser);
}

function validateToolInput(tool: ToolDefinition, input: unknown): unknown {
  const parsed = tool.inputSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error(`Invalid arguments for tool "${tool.name}".`);
  }
  return parsed.data;
}

function observerToolErrorForExposure(toolName: string, error: unknown): { isError: true; error: string } {
  return {
    isError: true,
    error: redactBrowserToolErrorForExposure(toolName, error),
  };
}

/** Plugin inference providers receive executable host tool definitions and may
 * call them directly. Validate every host-tool invocation at this trust boundary,
 * and bind every tool to the host turn so approvals cannot be detached from a
 * Browser-authorized stream. Browser tools additionally rely on this binding
 * for tab/control cleanup ownership. */
function bindBrowserToolsToRun(
  tools: ToolDefinition[],
  conversationId: string,
  browserOwnerId: string,
  abortSignal: AbortSignal,
  trustedContext: Pick<ToolExecutionContext, 'cwd' | 'isHeadless' | 'parentProfileKey' | 'parentModelKey'>,
  isCurrent: (tool: ToolDefinition) => boolean,
): ToolDefinition[] {
  return tools.map((tool) => ({
    ...tool,
    execute: async (input: unknown, _context: ToolExecutionContext) => {
      const assertCurrent = (): void => {
        if (abortSignal.aborted || !isCurrent(tool)) {
          throw new Error('This plugin tool capability is no longer active.');
        }
      };
      assertCurrent();
      const toolCallId = `plugin-${tool.source === 'browser' ? 'browser-' : ''}tool-${randomUUID()}`;
      const prepared = await prepareToolUseWithHooks(conversationId, toolCallId, tool.name, input);
      assertCurrent();
      if (!prepared.allowed) {
        const denied = await applyPostToolUseHooks(
          conversationId,
          toolCallId,
          tool.name,
          prepared.exposedArgs,
          prepared.result,
        );
        assertCurrent();
        return denied.result;
      }

      let validatedInput: unknown;
      try {
        validatedInput = validateToolInput(tool, prepared.args);
      } catch (error) {
        const errorResult = {
          isError: true,
          error: redactBrowserToolErrorForExposure(tool.name, error),
        };
        const postTool = await applyPostToolUseHooks(
          conversationId,
          toolCallId,
          tool.name,
          prepared.exposedArgs,
          errorResult,
        );
        assertCurrent();
        if (postTool.denied || postTool.modified) return postTool.result;
        throw new Error(errorResult.error);
      }
      const exposedArgs = redactBrowserToolArgsForExposure(tool.name, validatedInput);
      const context: ToolExecutionContext = {
        // The provider is a plugin trust boundary. Never preserve any context
        // field supplied by the plugin. Bind only host-derived values so a
        // supplied call id cannot collide with another pending approval and a
        // supplied cwd/profile/model cannot redirect or re-parent host tools.
        toolCallId,
        conversationId,
        browserOwnerId,
        abortSignal,
        cwd: trustedContext.cwd,
        isHeadless: trustedContext.isHeadless,
        parentProfileKey: trustedContext.parentProfileKey,
        parentModelKey: trustedContext.parentModelKey,
      };
      try {
        assertCurrent();
        const result = await tool.execute(validatedInput, context);
        assertCurrent();
        const postTool = await applyPostToolUseHooks(conversationId, toolCallId, tool.name, exposedArgs, result);
        assertCurrent();
        return postTool.result;
      } catch (error) {
        // If disable/update/cancellation happened during execution, do not run
        // more plugin hooks or deliver a stale result through the old provider.
        assertCurrent();
        const errorResult = {
          isError: true,
          error: redactBrowserToolErrorForExposure(tool.name, error),
        };
        const postTool = await applyPostToolUseHooks(conversationId, toolCallId, tool.name, exposedArgs, errorResult);
        assertCurrent();
        if (postTool.denied || postTool.modified) return postTool.result;
        throw new Error(errorResult.error);
      }
    },
  }));
}

function isPrimaryBrowserToolCaller(
  event:
    | {
        sender?: { send?: (channel: string, ...args: unknown[]) => void; mainFrame?: unknown } | null;
        senderFrame?: unknown;
        __kaiWebBridge?: boolean;
      }
    | null
    | undefined,
  getPrimaryWindow: () => BrowserWindow | null,
): boolean {
  const primaryWindow = getPrimaryWindow();
  return (
    !!primaryWindow &&
    !primaryWindow.isDestroyed() &&
    event?.__kaiWebBridge !== true &&
    event?.sender === primaryWindow.webContents &&
    event?.senderFrame === primaryWindow.webContents.mainFrame
  );
}

function mayMutateBrowserAuthorizedStream(
  event: Parameters<typeof isPrimaryBrowserToolCaller>[0],
  stream: Pick<ActiveStreamState, 'nativeBrowserInitiator' | 'nativeBrowserTools'> | undefined,
  getPrimaryWindow: () => BrowserWindow | null,
): boolean {
  return (
    (!stream?.nativeBrowserInitiator && !stream?.nativeBrowserTools) ||
    isPrimaryBrowserToolCaller(event, getPrimaryWindow)
  );
}

/** Authoritative admission check for renderer-owned conversation persistence.
 * A renderer persists its optimistic user turn before invoking `agent:stream`.
 * Reject that write while another renderer owns a Browser-capable stream so a
 * later stream rejection cannot leave the unauthorized branch active on disk. */
export function mayPersistConversationForBrowserAuthority(
  event: Parameters<typeof isPrimaryBrowserToolCaller>[0],
  conversationId: string,
  getPrimaryWindow: () => BrowserWindow | null,
): boolean {
  if (isRealtimeConversationBrowserAuthorized(conversationId) && !isPrimaryBrowserToolCaller(event, getPrimaryWindow)) {
    return false;
  }
  const browserManager = getExistingBrowserManager();
  if (browserManager?.hasPendingAssistantContinuationForConversation(conversationId)) {
    const authorityGeneration = browserManager.getHostRendererAuthorityGeneration();
    if (
      !isPrimaryBrowserToolCaller(event, getPrimaryWindow) ||
      !isNativeBrowserAuthorityCurrent(browserManager, authorityGeneration)
    ) {
      return false;
    }
  }
  return mayMutateBrowserAuthorizedStream(event, activeStreams.get(conversationId), getPrimaryWindow);
}

/** Background automations have no native renderer capability. Keep this
 * separate from mayMutateBrowserAuthorizedStream so a sender-less internal
 * caller cannot accidentally be treated as a trusted continuation. */
function mayInjectAutomationIntoActiveStream(
  stream: Pick<ActiveStreamState, 'nativeBrowserInitiator' | 'nativeBrowserTools'> | undefined,
): boolean {
  return !stream?.nativeBrowserInitiator && !stream?.nativeBrowserTools;
}

function isAuthorizedApprovalWindowCaller(
  event: Parameters<typeof isPrimaryBrowserToolCaller>[0],
  pending: Pick<PendingToolApproval, 'approvalWindowWebContentsId'>,
): boolean {
  const expectedId = pending.approvalWindowWebContentsId;
  const sender = event?.sender as { id?: unknown; mainFrame?: unknown } | null | undefined;
  return (
    event?.__kaiWebBridge !== true &&
    typeof expectedId === 'number' &&
    sender?.id === expectedId &&
    event?.senderFrame === sender.mainFrame
  );
}

function isPendingApprovalStreamCurrent(
  pending: Pick<PendingToolApproval, 'streamOwner'>,
  streams: Pick<Map<string, ActiveStreamState>, 'get'> = activeStreams,
): boolean {
  if (!pending.streamOwner) return true;
  if (pending.streamOwner.isCurrent) {
    try {
      return pending.streamOwner.isCurrent();
    } catch {
      return false;
    }
  }
  const stream = streams.get(pending.streamOwner.conversationId);
  return stream?.token === pending.streamOwner.streamToken;
}

function mayResolveToolApproval(
  event: Parameters<typeof isPrimaryBrowserToolCaller>[0],
  pending: Pick<PendingToolApproval, 'authority' | 'streamOwner' | 'approvalWindowWebContentsId'>,
  getPrimaryWindow: () => BrowserWindow | null,
): boolean {
  if (!isPendingApprovalStreamCurrent(pending)) return false;
  const requiresNativeAuthority = pending.authority === 'native-browser' || Boolean(pending.streamOwner);
  return (
    !requiresNativeAuthority ||
    isPrimaryBrowserToolCaller(event, getPrimaryWindow) ||
    isAuthorizedApprovalWindowCaller(event, pending)
  );
}

function toolApprovalResolutionError(
  event: Parameters<typeof isPrimaryBrowserToolCaller>[0],
  pending: Pick<PendingToolApproval, 'authority' | 'streamOwner' | 'approvalWindowWebContentsId'>,
  getPrimaryWindow: () => BrowserWindow | null,
): 'stale-browser-stream' | 'native-browser-authority-required' | null {
  if (!isPendingApprovalStreamCurrent(pending)) return 'stale-browser-stream';
  return mayResolveToolApproval(event, pending, getPrimaryWindow) ? null : 'native-browser-authority-required';
}

function observerToolsForExecutionMode(
  customTools: ToolDefinition[],
  workspaceTools: ToolDefinition[],
  executionMode: ExecutionMode,
): ToolDefinition[] {
  const activeCustomTools = toolsForExecutionMode(customTools, executionMode);
  const activeWorkspaceTools =
    executionMode === 'plan-first'
      ? workspaceTools.filter((tool) => !WORKSPACE_MUTATING_TOOLS.has(tool.name))
      : workspaceTools;
  return [...activeCustomTools, ...activeWorkspaceTools];
}

/**
 * Resolve {placeholder} templates in extraHeaders with runtime values.
 * (Implementation shared with the /compact path — see agent/header-templates.ts.)
 */
const resolveHeaderTemplates = resolveHeaderTemplatesShared;

function broadcastExecutionMode(mode: ExecutionMode, conversationId?: string): boolean {
  // Persist the authoritative per-conversation mode FIRST (the exit_plan_mode dismiss
  // path previously failed to persist it — R121 finding-1), then broadcast. Carry
  // conversationId so the renderer applies the mode ONLY to the DISPLAYED conversation
  // — a background conversation's plan-mode transition must not flip the viewed
  // conversation (and expose mutating tools there). Route through the guarded,
  // non-throwing broadcaster (R107 finding-4). Returns whether the authoritative disk
  // persist SUCCEEDED — a caller that will run a plan-first turn based on this (the
  // server-persisted plan-restart) must FAIL CLOSED if it didn't (R135 f-1): the
  // trust-disk reconcile would otherwise read stale 'auto' and run with mutating tools.
  let persisted = true;
  if (conversationId) {
    try {
      const conv = readConversation(appHomeForRuntimeResolve, conversationId);
      if (conv) {
        writeConversation(appHomeForRuntimeResolve, { ...conv, executionMode: mode } as never);
      } else {
        // No record to persist the mode onto → NOT durably set (for plan-first this must
        // fail closed at the caller).
        persisted = false;
      }
    } catch {
      persisted = false;
    }
  }
  // Only broadcast when the persist succeeded (R137 f-3): announcing a mode the disk doesn't
  // hold makes the UI show it while the next (trust-disk) turn runs the OTHER mode's tool set.
  // A conversationId-less broadcast (global default change) has nothing to persist → still send.
  if (persisted) {
    broadcastToAllWindows('agent:execution-mode-changed', { conversationId: conversationId ?? null, mode });
    // Re-gate any LIVE Realtime call for this conversation (R183): a Realtime session freezes its
    // plan-first tool filter at install, so a mode toggle here must re-resolve + re-apply it or the
    // connected socket keeps mutating tools. A conversationId-less (global default) change has no
    // specific live session to target; those calls re-resolve on their own next tool reload.
    if (conversationId) {
      try {
        onRealtimeExecutionModeChanged(conversationId);
      } catch (err) {
        console.warn('[Agent] onRealtimeExecutionModeChanged failed (non-fatal):', err);
      }
    }
  }
  return persisted;
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

/** Browser tool names are a trusted app contract. Normalize/dedupe every live
 * registry with Browser tools first so a plugin/MCP/CLI name or alias cannot
 * capture browser_tabs/browser_action dispatch, then restore the public
 * registry ordering with Browser tools last. */
function normalizeRegisteredTools(tools: ToolDefinition[]): ToolDefinition[] {
  const safe = ensureSafeToolDefinitions(tools);
  const browserTools = safe.filter((tool) => tool.source === 'browser');
  const nonBrowserTools = safe.filter((tool) => tool.source !== 'browser');
  const prioritized = dedupeToolNames([...browserTools, ...nonBrowserTools]);
  return [...prioritized.slice(browserTools.length), ...prioritized.slice(0, browserTools.length)];
}

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
  registeredTools = normalizeRegisteredTools(tools);
  if (!toolsRegistered) {
    toolsRegistered = true;
    resolveToolsReady();
  }
}

/** Commit the asynchronously-built startup registry without overwriting the
 * Browser source that the live window/config lifecycle already hot-swapped.
 * Browser enablement can change while MCP connections are still resolving. */
export function registerToolsPreservingBrowserState(tools: ToolDefinition[]): void {
  const browserTools = registeredTools.filter((tool) => tool.source === 'browser');
  registerTools([...tools.filter((tool) => tool.source !== 'browser'), ...browserTools]);
}

export function getRegisteredTools(): ToolDefinition[] {
  return registeredTools;
}

// Await the one-time tool-registration latch. `/compact` budget estimation must wait
// for this before snapshotting getRegisteredTools() — the CLI/GUI can invoke /compact
// during early startup, before MCP/plugin tool schemas have registered. Estimating the
// next-turn static input against an EMPTY registry under-counts, and /compact would then
// persist a summary that the first real turn (with full schemas) rejects/recompacts,
// wasting the paid summarization. Resolves immediately once tools are registered.
export function whenToolsReady(): Promise<void> {
  return toolsReady;
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
  // normalizeRegisteredTools re-runs dedup after every hot-swap (R153 f-1): appending
  // safe-but-not-deduped names lets a reloaded tool SHADOW a built-in in the name-keyed tool map (a
  // CLI/MCP `enter_plan_mode` would execute instead of entering plan mode). It reserves built-in
  // names + disambiguates (and applies ensureSafeToolDefinitions + browser-priority ordering).
  registeredTools = normalizeRegisteredTools([...nonMcp, ...mcpTools]);
}

/** Hot-swap skill tools without touching built-in or MCP tools */
export function updateSkillTools(skillTools: ToolDefinition[]): void {
  const nonSkill = registeredTools.filter((t) => t.source !== 'skill');
  registeredTools = normalizeRegisteredTools([...nonSkill, ...skillTools]);
}

/** Hot-swap plugin tools without touching built-in, MCP, or skill tools */
export function updatePluginTools(pluginTools: ToolDefinition[]): void {
  const nonPlugin = registeredTools.filter((t) => t.source !== 'plugin');
  registeredTools = normalizeRegisteredTools([...nonPlugin, ...pluginTools]);
}

/** Hot-swap CLI tools without touching built-in, MCP, skill, or plugin tools */
export function updateCliTools(cliTools: ToolDefinition[]): void {
  const nonCli = registeredTools.filter((t) => t.source !== 'cli');
  registeredTools = normalizeRegisteredTools([...nonCli, ...cliTools]);
}

/** Hot-swap native browser tools as the desktop window is enabled/created/closed. */
export function updateBrowserTools(browserTools: ToolDefinition[]): void {
  const nonBrowser = registeredTools.filter((tool) => tool.source !== 'browser');
  registeredTools = normalizeRegisteredTools([...nonBrowser, ...browserTools]);
}

export function registerAgentHandlers(
  ipcMain: IpcMain,
  appHome: string,
  pluginManager?: PluginManager,
  getPrimaryWindow: () => BrowserWindow | null = () => null,
  resolveRealtimeBrowserApprovalOwner: (
    conversationId: string,
    browserOwnerId: string,
    authority: ToolApprovalAuthority,
  ) => (() => boolean) | undefined = () => undefined,
): void {
  hookDispatcher.configure({ getConfig: () => readEffectiveConfig(appHome) });
  serverPersistAppHome = appHome;
  setToolApprovalOwnerResolver((conversationId, browserOwnerId, authority) => {
    const stream = activeStreams.get(conversationId);
    const ownerCurrent =
      stream?.token === browserOwnerId &&
      (authority === 'native-browser'
        ? stream.nativeBrowserTools
        : stream.nativeBrowserInitiator || stream.nativeBrowserTools);
    if (ownerCurrent) {
      return { conversationId, streamToken: stream.token };
    }
    const isCurrent = resolveRealtimeBrowserApprovalOwner(conversationId, browserOwnerId, authority);
    return isCurrent ? { conversationId, streamToken: browserOwnerId, isCurrent } : undefined;
  });
  setRawApprovalWindowOpener(maybeOpenDedicatedApprovalWindow);
  setRawApprovalWindowCloser(closeApprovalWindow);
  setPrimaryApprovalWindowResolver(getPrimaryWindow);
  // Persist cooperative injects for server-owned (CLI/headless) turns at the
  // ACTUAL prepareStep consumption boundary — after the prior tool step's results
  // have arrived. Splitting at enqueue time can clear the persistence tool index
  // between tool-call and tool-result, permanently losing the later result.
  setInjectConsumedHandler((conversationId, entries) => {
    // Record inject consumption FIRST — before the server-persist-owner early
    // return below — so a GUI-owned turn (not a server-persist owner) still marks
    // it. Overflow recovery must not auto-retry from the outer `messages` (which
    // lacks the consumed inject) regardless of who owns persistence.
    if (entries.length > 0) conversationsWithConsumedInject.add(conversationId);
    // Record each consumed inject's boundary nodes (injected user + `${id}-cont`)
    // as THIS run's own lineage BEFORE the server-owner early return, so both a
    // GUI-owned and a server-owned turn's continuation head passes
    // injectHeadStillOnBranch (a later mid-turn send must not read a same-run
    // continuation advancement as a branch switch). Token-scoped no-op if the run
    // was superseded. `entry.id` is the id the renderer keys its continuation on.
    {
      const activeToken0 = activeStreams.get(conversationId)?.token;
      if (activeToken0 !== undefined) {
        for (const entry of entries) recordInjectBoundaryLineage(conversationId, activeToken0, entry.id);
        // Track the LATEST boundary's continuation id so a model-fallback that seals
        // a failed continuation partial (persisted under `${id}-cont`, not the
        // provider response id) can forget it from the run lineage too (R85).
        const lastEntry = entries[entries.length - 1];
        if (lastEntry) recordActiveInjectContinuationId(conversationId, activeToken0, `${lastEntry.id}-cont`);
      }
    }
    // Accumulate consumed-inject text bytes so the media budget can charge them
    // (they aren't in the outer `messages` branch it sums).
    if (entries.length > 0) {
      let addBytes = 0;
      for (const entry of entries) addBytes += Buffer.byteLength(entry.text ?? '', 'utf8');
      consumedInjectBytes.set(conversationId, (consumedInjectBytes.get(conversationId) ?? 0) + addBytes);
    }
    const activeToken = activeStreams.get(conversationId)?.token;
    if (!isServerPersistOwner(conversationId, activeToken)) {
      // GUI (renderer-owned) turn: the fallback-accumulator boundary split does
      // NOT happen here. This injectConsumedHandler fires from prepareStep (a
      // side-channel that can run BEFORE the prior step's fullStream chunks reach
      // main's fallback accumulator), so finalizing here could split before a late
      // tool-call/result landed. The split instead happens on the ORDERED
      // `inject-consumed` STREAM event (see broadcastStreamEvent's GUI-fallback
      // branch → splitGuiFallbackAtInjectBoundary), which is emitted only after
      // prior-step chunks are consumed. Here we only keep the consumed-marker
      // bookkeeping above.
      return;
    }
    let lastMessageId: string | null = null;
    for (const entry of entries) {
      const persisted = persistCooperativeInjectedUserTurn(appHome, conversationId, entry.text, entry.id);
      if (persisted) {
        lastMessageId = persisted.messageId;
        // The disk write may have assigned a DIFFERENT id than entry.id; record the
        // authoritative persisted node (+ its `-cont`) as this run's lineage too.
        {
          const activeToken1 = activeStreams.get(conversationId)?.token;
          if (activeToken1 !== undefined)
            recordInjectBoundaryLineage(conversationId, activeToken1, persisted.messageId);
        }
        traceDiagnostic({
          scope: 'agent',
          event: 'inject.boundary-persisted',
          conversationId,
          messageId: persisted.messageId,
          parentMessageId: persisted.parentId,
        });
      }
    }
    if (lastMessageId) {
      // Continuation output from this same turn now persists after the last
      // injected user node, producing:
      // original user → partial assistant → injected user → continuation.
      serverPersistParents.set(conversationId, lastMessageId);
    }
  });

  // The dedicated approval window (flag-gated) posts answers through the
  // existing agent:approve/reject/answer handlers, then asks to close itself.
  registerApprovalWindowIpc();

  // Let the low-level raw broadcaster (used by the Claude SDK approval path)
  // tag events for CLI/headless-owned turns so a watching GUI renders live but
  // defers persistence to the main process, avoiding a duplicate/forked branch.
  setServerPersistTagger((event) => {
    if (!event.conversationId) return event;
    const activeToken = activeStreams.get(event.conversationId)?.token;
    return isServerPersistOwner(event.conversationId, activeToken) ? { ...event, serverPersisted: true } : event;
  });

  const streamHandler = async (
    event:
      | {
          sender?: { send?: (channel: string, ...args: unknown[]) => void } | null;
          __kaiWebBridge?: boolean;
        }
      | null
      | undefined,
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
      // Set by a renderer-driven CONTINUATION (max-turns auto-continue / plan-restart): the token of
      // the turn this continuation follows. Main rejects the launch if a NEWER turn was issued for
      // the conversation since (another client submitted a fresh user turn in the auth->launch
      // window) — so the genuine new turn wins and the stale continuation is dropped, instead of
      // this continuation's unconditional abort clobbering it.
      continuationPredecessorToken?: string;
    },
    responseMessageId?: string,
    nativeBrowserToolsOverride?: boolean,
    nativeBrowserAuthorityGenerationOverride?: number,
  ) => {
    messages = stripDisplayOnlyParts(messages);
    // Raw disk-equivalent per-id content signature of the turn's INPUT branch, captured
    // NOW — before any pre-send/DLP hook rewrites `messages` in-memory. Reactive recovery
    // uses this as its drift baseline: a hook redaction changes `messages` but NOT disk,
    // so signing the post-hook branch would always differ from the raw disk read at
    // persist and falsely reject the summary (re-bill loop). Signing here (pre-hook, after
    // the displayOnly normalization the signature already ignores) is disk-equivalent, and
    // a genuine concurrent disk edit after turn-start still diverges → correctly rejected.
    const turnStartBranchSig = new Map<string, string>();
    for (const m of messages as Array<{ id?: unknown }>) {
      if (typeof m?.id === 'string') {
        turnStartBranchSig.set(m.id, messageContentSignature(m as Parameters<typeof messageContentSignature>[0]));
      }
    }
    const effectiveCwd = normalizeAgentCwd(cwd);
    // executionMode reconciliation (R128 finding-1): the renderer-supplied `executionMode` can be
    // STALE — a reconciliation (loadConversationState hydration / a background-conv broadcast) may
    // have reset the renderer's in-memory mode to 'auto' AFTER MAIN persisted 'plan-first', and the
    // next GUI turn then submits that stale 'auto'. Trusting it verbatim would run a plan-mode
    // conversation with MUTATING tools. executionMode is MAIN-authoritative (persisted on disk by
    // the dedicated setter / plan-mode transitions), so reconcile against the persisted value —
    // FAIL-SAFE: if EITHER the submitted OR the persisted mode is 'plan-first', run plan-first.
    // This never wrongly exposes mutating tools: a stale 'auto' submit is overridden by disk
    // 'plan-first', and a just-toggled 'plan-first' submit still wins even if its (async) disk
    // write hasn't landed. The only cost is that a genuine plan→auto toggle whose setter write is
    // still in flight runs one extra turn read-only — strictly safer than the inverse.
    let effectiveExecutionMode: ExecutionMode = executionMode ?? 'auto';
    try {
      const persistedConv = readConversation(appHome, conversationId) as { executionMode?: ExecutionMode } | null;
      if (persistedConv != null) {
        // Record read OK — its executionMode (present, or absent → 'auto') is authoritative.
        effectiveExecutionMode = reconcileExecutionMode(executionMode, persistedConv.executionMode, true);
      } else {
        // Couldn't read the record. Distinguish genuinely-absent (first turn → trust submitted)
        // from present-but-unreadable / unknown (transient I/O) via a TRI-STATE probe that fails
        // CLOSED (R135 f-3 / R136 f-2): 'exists' or 'unknown' → run plan-first (read-only) rather
        // than trust a possibly-stale submitted 'auto' and expose mutating tools; only a
        // definitively 'absent' record falls back to the submitted mode.
        const state = conversationExistenceState(appHome, conversationId);
        effectiveExecutionMode =
          state === 'absent' ? reconcileExecutionMode(executionMode, undefined, false) : 'plan-first';
      }
    } catch {
      // Even the probe path threw — fail CLOSED to plan-first rather than the submitted mode.
      effectiveExecutionMode = 'plan-first';
    }
    // Web/CLI/background callers have no native sidebar to render or own a
    // WebContentsView. Only a real Electron renderer invocation may expose the
    // in-app browser tools. Internal continuations inherit a generation-bound
    // grant rather than a bare boolean: host reload/crash teardown increments
    // the manager generation, so a delayed continuation cannot restore access
    // to an authenticated Browser profile after its renderer authority ended.
    const browserManagerAtAuthorization = getExistingBrowserManager();
    const directRendererAuthorized = isPrimaryBrowserToolCaller(event, getPrimaryWindow);
    const nativeBrowserAuthorityGeneration =
      nativeBrowserToolsOverride === undefined
        ? directRendererAuthorized
          ? browserManagerAtAuthorization?.getHostRendererAuthorityGeneration()
          : undefined
        : nativeBrowserAuthorityGenerationOverride;
    const hasNativeBrowserAuthority =
      (nativeBrowserToolsOverride ?? directRendererAuthorized) &&
      isNativeBrowserAuthorityCurrent(browserManagerAtAuthorization, nativeBrowserAuthorityGeneration);
    const continuationPredecessorToken =
      typeof threadOverrides?.continuationPredecessorToken === 'string' &&
      threadOverrides.continuationPredecessorToken.length > 0
        ? threadOverrides.continuationPredecessorToken
        : undefined;

    // Text and Realtime runtimes maintain independent accumulators, tool
    // ownership, and terminal persistence. Never run them concurrently for the
    // same conversation or their events can merge into one renderer branch.
    if (isRealtimeConversationTurnActive(conversationId)) {
      const sender = event?.sender;
      let delivered = false;
      if (sender && typeof sender.send === 'function') {
        try {
          sender.send('agent:stream-event', {
            conversationId,
            type: 'error',
            error: 'End the active voice call before starting a text response.',
            ...(responseMessageId ? { responseMessageId } : {}),
          });
          delivered = true;
        } catch {
          delivered = false;
        }
      }
      return { conversationId, busy: true as const, delivered, realtimeTurnActive: true as const };
    }

    // An on-demand `/compact` is summarizing this conversation right now (a paid,
    // slow op). Don't start a concurrent turn — it would race + force /compact to
    // discard its summary. Reject cleanly, but ONLY to the invoking client — a global
    // broadcast (broadcastStreamEventRaw) would make PASSIVE viewers of this chat, who
    // never submitted, create an accumulator and persist a spurious assistant error
    // node. Target event.sender (the window/client that called agent:stream); for the
    // web bridge (no sender) the returned { busy } marker signals the caller. Internal
    // callers (automations/submit) pass no event and handle busy their own way.
    if (isCompacting(conversationId)) {
      const sender = event?.sender;
      let delivered = false;
      if (sender && typeof sender.send === 'function') {
        try {
          // Emit ONLY a terminal `error` — NOT a trailing `done`. The renderer's error
          // handler is already fully terminal (finalizes, deletes the accumulator, sets
          // runStatus idle). A following `done` would find no accumulator and RECREATE one
          // from the pre-error tree, superseding the error persist and leaving the user
          // message with no visible error. One terminal event only. Call via `sender.send`
          // (bound) inside try/catch: a WebContents destroyed during this post-persist/
          // pre-stream window makes `.send` throw — if it did, leave delivered=false so the
          // caller synthesizes the terminal event instead of the renderer hanging.
          sender.send('agent:stream-event', {
            conversationId,
            type: 'error',
            error: 'Compacting the conversation — wait for it to finish, then retry.',
            // Stamp the run's responseMessageId so the renderer's run-generation guard can
            // drop this busy error if THIS run was superseded before the (possibly delayed)
            // error arrived — else it would terminate/persist against the replacement run.
            ...(responseMessageId ? { responseMessageId } : {}),
          });
          delivered = true;
        } catch {
          delivered = false;
        }
      }
      // `delivered` tells the caller whether the busy error was already pushed via the
      // sender (Electron). The web bridge has NO per-client sender (and a dead WebContents
      // couldn't receive it), so delivered=false and the renderer must synthesize the
      // terminal error from this return value — else its accumulator + runStatus stay stuck.
      return { conversationId, busy: true as const, delivered };
    }

    // STALE-CONTINUATION guard: a renderer-driven continuation carries the predecessor turn's token.
    // If a NEWER turn has been issued for this conversation since that predecessor (another client
    // submitted a fresh user turn in the auth->launch window), this continuation is stale — reject it
    // rather than let its unconditional abort below clobber the genuine newer turn. (A continuation
    // whose predecessor IS still the latest proceeds normally.)
    {
      const predToken = continuationPredecessorToken;
      if (predToken) {
        const latest = latestIssuedTurnToken.get(conversationId);
        if (latest !== undefined && latest !== predToken && turnTokenTime(latest) > turnTokenTime(predToken)) {
          return { conversationId, busy: true as const, delivered: false, staleContinuation: true as const };
        }
      }
    }

    // A web/secondary renderer may observe this max-turn event, but it has no
    // native Browser authority. Do not let a direct or stale bridge call bypass
    // the continuation-driver authorization and abort the predecessor before
    // adopting tabs it cannot control.
    if (
      continuationPredecessorToken &&
      !mayDriveBrowserContinuation(
        getExistingBrowserManager(),
        conversationId,
        continuationPredecessorToken,
        hasNativeBrowserAuthority,
      )
    ) {
      return {
        conversationId,
        busy: true as const,
        delivered: false,
        nativeBrowserContinuationRequired: true as const,
      };
    }

    if (
      !continuationPredecessorToken &&
      !hasNativeBrowserAuthority &&
      getExistingBrowserManager()?.hasPendingAssistantContinuationForConversation(conversationId)
    ) {
      return {
        conversationId,
        busy: true as const,
        delivered: false,
        nativeBrowserContinuationRequired: true as const,
      };
    }

    // Cancel any existing stream for this conversation
    const existing = activeStreams.get(conversationId);
    const supersededPredecessorToken = existing?.token;
    // Did this turn SUPERSEDE a live predecessor? If so, that predecessor may still
    // be awaiting a slow PreToolUse hook on an ask_user call and will register its
    // raced-answer handoff (bound to THIS successor) only AFTER we pass the claimant
    // registration below. We must register an (empty) claimant now so that late
    // handoff has something to merge into — see the claim site + finding note there.
    const supersededLivePredecessor = Boolean(existing);
    if (existing) {
      // A Browser-authorized turn carries access to the primary window's
      // authenticated Chromium profile. Passive/web/secondary clients may view
      // it, but must not abort and replace it with their own prompt. The only
      // sender-less exception is the generation-bound continuation minted by
      // this process for the exact predecessor token.
      const trustedInternalContinuation =
        event == null && hasNativeBrowserAuthority && continuationPredecessorToken === existing.token;
      if (!trustedInternalContinuation && !mayMutateBrowserAuthorizedStream(event, existing, getPrimaryWindow)) {
        return {
          conversationId,
          busy: true as const,
          delivered: false,
          nativeBrowserAuthorityRequired: true as const,
        };
      }
      existing.abort();
      if (continuationPredecessorToken === existing.token) {
        // A renderer can launch the successor while the predecessor is still
        // unwinding its finally block. Freeze that browser capability now, but
        // retain its temporary tabs for the logical-turn handoff below.
        getExistingBrowserManager()?.prepareAssistantContinuation(conversationId, existing.token);
      } else {
        // The old token still owns the map at this point and the replacement has
        // not created tabs yet, so its temporary tabs can be reclaimed safely.
        cleanupAssistantTabsIfOwned(conversationId, existing.token);
      }
    }
    // A live GUI persistence FALLBACK for the PRIOR turn is about to be discarded by this new turn.
    // If main still holds the authoritative full copy and it hasn't been superseded on disk, FLUSH
    // it first — else the prior turn's complete reply is lost (e.g. a sole renderer reloaded after
    // terminal output but before its own persist landed, within the fallback poll's window).
    //   - REMOTE origin (pendingRemoteReplace): replace the web client's capped node in place.
    //   - LOCAL origin: append main's copy, but ONLY if the renderer hasn't already persisted (disk
    //     still 'running'); if it persisted (runStatus flipped) main's fallback is redundant → drop.
    const hadRemotePending = pendingRemoteReplace.delete(conversationId);
    if (hadRemotePending) {
      try {
        finalizeInterruptedTurnReplacing(appHome, conversationId);
      } catch {
        /* fall through to the discard below */
      }
    } else if (
      // LOCAL fallback either not-yet-polling (guiFallbackParents still set) OR mid-poll
      // (pendingLocalReplace set — guiFallbackParents already consumed by the poll).
      (guiFallbackParents.delete(conversationId) || pendingLocalReplace.delete(conversationId)) &&
      hasPersistenceAccumulator(conversationId)
    ) {
      let rendererPersisted = false;
      try {
        const prior = readConversation(appHome, conversationId);
        // Only a GENUINE terminal (idle/error) means the renderer persisted — 'awaiting-approval'
        // is a live pause, so main's full copy is still needed (don't drop it as redundant).
        if (prior && prior.runStatus !== 'running' && prior.runStatus !== 'awaiting-approval') rendererPersisted = true;
      } catch {
        /* treat as not-persisted → flush main's full copy */
      }
      if (!rendererPersisted) {
        try {
          // Upsert-by-id (NOT a plain append): the local originator's renderer runs a
          // ~300ms debounced stream-persist, so disk may ALREADY carry the assistant
          // node under this run's responseMessageId even while runStatus is still
          // 'running'. A plain finalizeInterruptedTurn would id-collision-rename it to a
          // bogus `auto-msg-*` duplicate sibling AND move the head back to it, writing
          // 'idle' over the just-admitted replacement turn (whose new prompt is already
          // the disk head) — leaving that prompt off-branch if it produced no assistant
          // node yet. replaceById upserts in place (falls back to append when absent).
          finalizeInterruptedTurnUpsert(appHome, conversationId);
        } catch {
          /* fall through to the discard below */
        }
      }
    }
    pendingLocalReplace.delete(conversationId); // ensure cleared even if the branch above didn't run
    guiFallbackRemoteOrigin.delete(conversationId);
    // Handle cooperative injects STRANDED by a just-superseded turn (queued but
    // not yet drained — e.g. a raced ask_user answer). They belonged to that turn;
    // carrying them into this fresh/superseding turn would splice an unrelated
    // message. If the superseded turn was a SERVER-persist owner, its injects were
    // only QUEUED (persistence deferred to the consumption boundary) — DRAIN +
    // persist them now so the accepted user message isn't lost; then CLEAR the
    // rest (GUI-owned, already persisted at injection by the renderer). No-op for
    // the drain-at-end continuation (it drainInjects() before re-invoking us → the
    // queue is already empty) and for a plain first turn.
    //
    // MUST run BEFORE discardPersistenceAccumulator: persistCooperativeInjectedUserTurn
    // calls finalizeInterruptedTurn to save the superseded run's assistant PREFIX and
    // parent the stranded inject on it. Discarding the accumulator first would leave
    // no prefix to finalize, stranding the inject on the wrong head / off-branch.
    if (hasInjects(conversationId)) {
      if (serverPersistTokens.has(conversationId)) {
        // Capture the superseded run's OWN branch point BEFORE draining. When a
        // stranded inject has no accumulated assistant prefix to finalize, this is
        // where it chronologically belongs (right after the node the superseded run
        // was streaming under) — NOT the store's current head, which a newer prompt
        // may already have advanced to (mis-ordering the older inject after it). Only
        // the FIRST inject uses it; subsequent injects chain onto their predecessor.
        const supersededBranchPoint = serverPersistParents.get(conversationId) ?? null;
        const stranded = drainInjects(conversationId);
        let persistedAny = false;
        let priorInjectId: string | null = null;
        for (const entry of stranded) {
          const persisted = persistCooperativeInjectedUserTurn(appHome, conversationId, entry.text, entry.id, {
            // First inject → pin on the superseded branch point; later injects → pin on
            // the previously-persisted inject so the batch forms an ordered chain.
            noPrefixParentId: priorInjectId ?? supersededBranchPoint,
          });
          if (persisted) {
            persistedAny = true;
            priorInjectId = persisted.messageId;
          }
        }
        // The replacement's `messages` snapshot was captured BEFORE this drain, so
        // it doesn't include the just-persisted stranded inject (a recovered
        // ask_user answer). Reconcile the model input with the disk branch (which
        // now ends at the stranded inject) WITHOUT dropping any NEWER prompt the
        // incoming `messages` carries (a fresh GUI/CLI submit that superseded this
        // run — via agent:stream OR agent:submit — already has its new user turn in
        // `messages`). Take the disk branch as the base, then APPEND the incoming
        // branch's trailing user turn(s) that aren't already on it — so the model
        // sees `…history… → strandedInject → newPrompt` and neither is lost.
        if (persistedAny) {
          const rebuilt = readConversation(appHome, conversationId);
          if (rebuilt) {
            const { tree, headId } = ensureConversationTree(rebuilt);
            // A newer prompt may have superseded this run (a fresh submit persisted
            // its own user node before the abort/restart reached here). After the
            // stranded-inject drain advanced the disk head to the inject, that new
            // prompt node is now on a SIBLING branch. Find it on disk (a user node,
            // NOT one of the stranded injects, whose text matches the incoming
            // branch's last user turn) and REPARENT it onto the stranded inject so
            // the authoritative branch is `…history… → strandedInject → newPrompt`
            // and the head advances to it. Then rebuild `messages` from that branch —
            // NOT an in-memory append (which would duplicate the prompt in model
            // input and leave the disk reply mis-parented).
            const incomingLast = lastUserMessage(messages as unknown[]) as { id?: unknown; content?: unknown } | null;
            const incomingLastId = typeof incomingLast?.id === 'string' ? incomingLast.id : undefined;
            const strandedIds = new Set(stranded.map((e) => e.id));
            const incomingLastText =
              incomingLast && typeof incomingLast.content !== 'undefined'
                ? typeof incomingLast.content === 'string'
                  ? incomingLast.content
                  : extractMessageText(incomingLast.content)
                : '';
            let effectiveHead = headId;
            // The incoming last user turn is a NEWER superseding prompt (to
            // reparent after the stranded inject) ONLY when it's a DISTINCT node —
            // identified by ID, not text: a fresh prompt whose text happens to
            // equal the inject's is still a different node that must be preserved.
            // (When the incoming id IS a stranded inject, this run is a pure
            // continuation of that inject — nothing extra to reparent.)
            const incomingIsDistinctPrompt =
              !!incomingLast &&
              !!incomingLastText &&
              (incomingLastId === undefined || !strandedIds.has(incomingLastId));
            if (incomingIsDistinctPrompt) {
              // Locate the new prompt's already-persisted disk node. Prefer an exact
              // ID match (the incoming node), else fall back to the newest user node
              // (not a stranded inject, off the current head) with matching text.
              const headLine = new Set(getConversationBranch(tree, headId).map((m) => m.id));
              const newPromptNode =
                (incomingLastId !== undefined && !strandedIds.has(incomingLastId)
                  ? tree.find((m) => m.id === incomingLastId && !headLine.has(m.id))
                  : undefined) ??
                [...tree]
                  .reverse()
                  .find(
                    (m) =>
                      m.role === 'user' &&
                      !strandedIds.has(m.id) &&
                      !headLine.has(m.id) &&
                      extractMessageText(m.content) === incomingLastText,
                  );
              if (newPromptNode && headId) {
                const reparented = reparentConversationMessage(appHome, conversationId, newPromptNode.id, headId, {
                  makeHead: true,
                });
                if (reparented?.headId) effectiveHead = reparented.headId;
              }
            }
            const finalConv = readConversation(appHome, conversationId) ?? rebuilt;
            const { tree: finalTree } = ensureConversationTree(finalConv);
            messages = stripDisplayOnlyParts(getConversationBranch(finalTree, effectiveHead) as unknown[]);
          }
        }
      } else {
        // GUI-owned turn: the inject was ALREADY persisted at injection by the
        // renderer. Normally the renderer keeps it on the active branch — but if
        // ANOTHER GUI client submitted from a stale branch before receiving this
        // inject's broadcast, conversations:put's union-merge can leave the inject
        // as an off-branch SIBLING while the new prompt is the head. Reconcile any
        // such stranded inject node onto the branch (so the replacement's branch —
        // rebuilt below — includes it), THEN clear the queue.
        const stranded = drainInjects(conversationId);
        const conv = readConversation(appHome, conversationId);
        if (conv) {
          const { tree, headId } = ensureConversationTree(conv);
          const headLine = new Set(getConversationBranch(tree, headId).map((m) => m.id));
          // The stranded injects that actually exist off-branch (the cross-client
          // stale-submit sibling case) — in FIFO order.
          const offBranch = stranded.filter((e) => tree.some((m) => m.id === e.id) && !headLine.has(e.id));
          // Is the current head a DISTINCT superseding prompt? That is: a user node
          // submitted AFTER these injects were queued (a fresh submit from another
          // client that won the head), NOT itself one of the stranded injects and
          // NOT already carrying an inject as an ancestor. If so, the injects are
          // OLDER and must land BEFORE it — `pre → inject… → newPrompt` — never
          // after it (which would present the stale inject as the current request).
          const strandedIds = new Set(stranded.map((e) => e.id));
          const headNode = headId ? tree.find((m) => m.id === headId) : undefined;
          const headIsSupersedingPrompt =
            !!headNode && headNode.role === 'user' && !strandedIds.has(headNode.id) && offBranch.length > 0;
          let head = headId;
          let reconciled = false;
          if (headIsSupersedingPrompt && headNode) {
            // Splice the inject chain between the superseding prompt and its parent:
            // reparent the first inject onto the prompt's parent, chain the rest in
            // FIFO order, then reparent the prompt onto the last inject. Head stays
            // at the (unchanged-id) superseding prompt so it remains the request.
            // The prompt's parent may be NULL — an edit of the FIRST user message is a
            // root; then the first inject becomes the new root (parentId null) so the
            // accepted inject isn't left hidden off-branch (R90).
            const promptParent = headNode.parentId ?? null;
            {
              let chainTail: string | null = promptParent;
              let spliced = true;
              for (const entry of offBranch) {
                const r = reparentConversationMessage(appHome, conversationId, entry.id, chainTail);
                if (!r) {
                  spliced = false;
                  break;
                }
                chainTail = entry.id;
              }
              if (spliced && chainTail) {
                const r = reparentConversationMessage(appHome, conversationId, headNode.id, chainTail, {
                  makeHead: true,
                });
                if (r?.headId) {
                  head = r.headId;
                  reconciled = true;
                }
              }
            }
          } else {
            // No superseding prompt — the head is (or descends from) prior history.
            // Reconcile each off-branch inject onto the current head in FIFO order.
            for (const entry of offBranch) {
              if (!head) break;
              const r = reparentConversationMessage(appHome, conversationId, entry.id, head, { makeHead: true });
              if (r?.headId) {
                head = r.headId;
                reconciled = true;
              }
            }
          }
          if (reconciled) {
            const reread = readConversation(appHome, conversationId) ?? conv;
            const { tree: rt } = ensureConversationTree(reread);
            messages = stripDisplayOnlyParts(getConversationBranch(rt, head) as unknown[]);
          }
        }
      }
      clearInjects(conversationId);
    }
    // Discard any half-accumulated server-persist buffer from a superseded run
    // so its partial output can't merge into this fresh turn's assistant message.
    // (A stranded server-inject drain above already finalized+deleted it via
    // persistCooperativeInjectedUserTurn — this is then a no-op for that path.)
    discardPersistenceAccumulator(conversationId);
    // Fresh turn → clear any consumed-inject marker from a prior turn (the flag is
    // only meaningful within the turn that consumed the inject).
    conversationsWithConsumedInject.delete(conversationId);
    consumedInjectBytes.delete(conversationId);

    const controller = new AbortController();
    const streamToken = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    activeStreams.set(conversationId, {
      abort: () => controller.abort(),
      token: streamToken,
      // Reserve Browser authority immediately for a primary-renderer request.
      // Runtime/plugin filtering below may downgrade it, but while asynchronous
      // admission drains are pending a remote renderer must not steal the run.
      nativeBrowserInitiator: hasNativeBrowserAuthority,
      nativeBrowserTools: hasNativeBrowserAuthority,
    });
    const rejectRevokedBrowserLaunch = () => {
      releaseContinuationAuth(conversationId);
      resetBrowserAuthorityRevokedRunStatus(appHome, conversationId);
      let delivered = false;
      const sender = event?.sender;
      if (sender && typeof sender.send === 'function') {
        try {
          sender.send('agent:stream-event', {
            conversationId,
            type: 'error',
            error: 'The Browser sidebar reloaded before the request could start. Please retry.',
            ...(responseMessageId ? { responseMessageId } : {}),
          });
          delivered = true;
        } catch {
          delivered = false;
        }
      }
      return {
        conversationId,
        busy: true as const,
        delivered,
        browserAuthorityRevoked: true as const,
      };
    };
    // Record the latest issued turn token so a delayed continuation request for an OLDER turn is
    // rejected even after a newer turn has already finished (see authorizeContinuation). Bounded.
    // Also assign a monotonic ordinal so turn recency comparisons are immune to system-clock jumps.
    recordIssuedTurnToken(streamToken);
    latestIssuedTurnToken.delete(conversationId);
    latestIssuedTurnToken.set(conversationId, streamToken);
    while (latestIssuedTurnToken.size > CONTINUATION_AUTH_MAX) {
      const oldest = latestIssuedTurnToken.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      latestIssuedTurnToken.delete(oldest);
    }
    // Record the EXPLICIT supersession edge (predecessor → this successor) when this
    // turn aborted a live predecessor. The raced-answer rebind path consults this to
    // transfer a handoff bound to the predecessor ONLY to a genuine successor in the
    // chain — never to an unrelated later turn that merely started within the TTL.
    if (supersededPredecessorToken !== undefined) {
      recordSupersession(supersededPredecessorToken, streamToken);
    }

    // Bind an UNBOUND raced-answer handoff (a plan-mode restart, whose successor
    // token was unknown at abort) to THIS just-issued successor token NOW — before
    // any early exit (config-load / pre-send hook / runtime resolution). If this
    // run exits before reaching the claim site, its teardown
    // (dropRacedAnswerClaimantForToken, expectedSuccessorToken === token) then
    // drops the handoff instead of leaving it claimable by an unrelated later turn
    // within the 30s TTL. (A handoff already bound to a different successor is left
    // alone; the claim site re-checks binding before transferring.)
    {
      const pendingHandoff = racedAnswerHandoffs.get(conversationId);
      if (pendingHandoff && pendingHandoff.expectedSuccessorToken === undefined) {
        pendingHandoff.expectedSuccessorToken = streamToken;
      }
    }

    // (The user-message mirror is emitted AFTER server-persist ownership is bound
    // below — see the block after the binding. Emitting it here, before
    // the binding, meant the mirror carried neither serverPersisted tagging nor the
    // authoritative user-node id, so a delayed GUI launch racing an automation restart
    // could keep local ownership, abort the accepted turn, and fabricate a duplicate
    // user node (R109 finding-1).)
    // If agent:submit flagged this turn for server-side persistence, bind that
    // ownership to THIS run's token (so a later superseding run doesn't inherit
    // or clobber it). Consume the one-shot pending marker.
    let serverPersistedRun = false;
    if (pendingServerPersist.delete(conversationId)) {
      serverPersistedRun = true;
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
      // GUI turn: keep a FALLBACK persistence accumulator in main (parented on the user turn the
      // reply answers — the last message on the incoming branch) so a SOLE renderer that reloads/
      // crashes mid-stream doesn't lose the reply. The terminal handler discards it if the
      // renderer persisted (the normal case), or finalizes it if not.
      {
        const guiParent = (() => {
          const arr = messages as Array<{ id?: unknown }>;
          const last = arr[arr.length - 1];
          return typeof last?.id === 'string' ? last.id : null;
        })();
        guiFallbackParents.set(conversationId, guiParent);
        // Mark the origin: a web-bridge invoke passes a null sender (invokeHandler's fake event),
        // whereas an Electron window has a real WebContents sender. A remote origin means the
        // persisting client will have received frame-capped events, so main must finalize its own
        // full copy at terminal (see finalizeGuiFallbackIfOwned / guiFallbackRemoteOrigin).
        if (event == null || event.sender == null) guiFallbackRemoteOrigin.add(conversationId);
        else guiFallbackRemoteOrigin.delete(conversationId);
      }
    }

    // Mirror the newest user turn to OTHER attached clients so a GUI/automation-driven
    // turn shows the prompt (skipped for agent:submit — it self-broadcast a nonced copy).
    // Emitted AFTER the server-persist binding above so it carries this run's
    // serverPersisted tagging AND the AUTHORITATIVE persisted user-node metadata: a
    // receiving renderer inserts the turn under the DISK id (never fabricates one) and,
    // for a server-persist restart takeover, adopts this generation as main-owned —
    // invalidating a pending local launch rather than aborting the accepted turn
    // (R108 f-1 / R109 f-1). Token-tagged so the renderer attributes it to this run.
    // Every server-persist / GUI turn's user-message goes through THIS single path now
    // (no caller self-broadcasts before the token exists — R111 f-2).
    {
      const lastUserText = extractLastUserText(messages);
      // agent:submit's one-shot nonce (if this run came from a submit) — included so
      // the originating client dedups its optimistic echo. Consumed here (R111 f-2).
      const submitMirrorNonce = pendingSubmitMirrorNonce.get(conversationId);
      pendingSubmitMirrorNonce.delete(conversationId);
      const branchArr = messages as Array<{ id?: unknown; parentId?: unknown; role?: unknown }>;
      const lastNode = branchArr[branchArr.length - 1];
      const authoritativeUserId = typeof lastNode?.id === 'string' ? lastNode.id : undefined;
      const authoritativeParentId = typeof lastNode?.parentId === 'string' ? lastNode.parentId : null;
      // Emit the mirror when there's user TEXT, OR when this is a server-persist run
      // with an authoritative user node even if the text is EMPTY (an image-only CLI
      // submission) — a pending GUI accumulator needs this token-tagged takeover to
      // adopt it; without it the delayed GUI launch could run over the accepted run
      // (R113 finding-4).
      const shouldMirror = Boolean(lastUserText) || (serverPersistedRun && authoritativeUserId != null);
      if (shouldMirror) {
        broadcastStreamEvent(
          {
            conversationId,
            type: 'user-message',
            text: lastUserText,
            // serverPersisted runs carry the authoritative id + PARENT so the renderer
            // inserts under them (no fabricated duplicate, correct ordering) and adopts
            // the takeover. Without parentId a takeover parented the accepted turn under
            // the displaced optimistic node → transient A→B→A misorder (R112 f-4). A
            // plain GUI mirror keeps prior behavior. The submitNonce rides in data so
            // the originating client skips its own optimistic echo.
            ...(serverPersistedRun && authoritativeUserId
              ? {
                  serverPersisted: true,
                  data: {
                    messageId: authoritativeUserId,
                    parentId: authoritativeParentId,
                    ...(submitMirrorNonce ? { submitNonce: submitMirrorNonce } : {}),
                  },
                }
              : submitMirrorNonce
                ? { data: { submitNonce: submitMirrorNonce } }
                : {}),
          },
          streamToken,
        );
      }
    }

    const randomBytes = new Uint8Array(4);
    crypto.getRandomValues(randomBytes);
    const observerSessionId = `${Date.now()}-${Array.from(randomBytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
    activeObserverSessions.set(conversationId, observerSessionId);

    // All broadcasts from THIS run carry its stream token so broadcastStreamEvent can
    // reject persistence-side effects from a superseded run's late events — AND so the
    // RENDERER can attribute each event to its run (the token is stamped as `runGeneration`
    // on the broadcast, see broadcastStreamEvent) and drop a SUPERSEDED run's late events
    // that would otherwise hijack a replacement turn's accumulator. The token is STABLE for
    // the whole run — unlike responseMessageId, which a mid-stream fallback intentionally
    // changes per successful variant, so it must NOT be used for supersession.
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
      // Trailing `done` ONLY for a serverPersisted (CLI/automation) turn — a GUI error is
      // fully terminal (the renderer deletes the accumulator + persists idle); a following
      // `done` would recreate it from stale React state + supersede the error write (the
      // config error would flash then vanish). serverPersisted keeps its accumulator on error.
      if (serverPersistedRun) emit({ conversationId, type: 'done' });
      // Clean up the activeStreams entry set above — otherwise this conversation
      // stays "busy" forever and later agent:submit calls return conversation-busy.
      cleanupAssistantTabsIfOwned(conversationId, streamToken);
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
    // The prompt sent to the model this turn (thread/profile override wins, then the
    // resolved chat prompt). This is the value written back to streamConfig after the
    // pre-send hook, so it MUST preserve the override — do NOT run resolveModeSystemPrompt
    // here (its chat branch prefers the GLOBAL systemPrompts.chat and would discard the
    // override, changing what Mastra sends). The mode-aware BUDGET prompt is computed
    // separately below (budgetSystemPrompt) and never written back.
    let effectiveSystemPrompt = streamConfig?.systemPrompt ?? config.systemPrompt ?? '';
    // Capture the PRE-hook base (before the pre-send / UserPromptSubmit hooks below
    // may rewrite effectiveSystemPrompt) so a mid-turn inject can replay the hooks
    // from the SAME input this run used — recorded on activeStreamRuntime below.
    const preHookSystemPrompt = effectiveSystemPrompt;

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
          if (serverPersistedRun) emit({ conversationId, type: 'done' });
          void hookDispatcher.dispatch('AgentStop', { conversationId, aborted: false });
          cleanupAssistantTabsIfOwned(conversationId, streamToken);
        }
        cleanupStreamIfOwned(conversationId, streamToken);
        return { conversationId };
      }

      // A pre-send hook may have rewritten message content (even IN PLACE on the
      // same array reference), leaving a now-stale cached tokenCount. Only when a
      // pre-send hook actually EXISTS do we drop counts whose content-signature no
      // longer matches — otherwise skip the O(total-history) scan entirely so a
      // normal no-hook send keeps the integer-only fast path.
      messages = stripDisplayOnlyParts(hookResult.messages);
      if (pluginManager.hasPreSendHooks()) messages = invalidateStaleTokenCounts(messages);
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
          {
            const red = persistRedactedUserTurn(appHome, conversationId, '[blocked by a policy hook]');
            // The redaction is now on DISK; update the drift baseline for that id so the
            // recovery/reuse content check (which recomputes from redacted disk) matches.
            // Unrelated ids keep their raw baseline, so a concurrent edit is still caught.
            if (red) turnStartBranchSig.set(red.id, red.sig);
          }
          emit({
            conversationId,
            type: 'error',
            error: promptDispatch.reason ?? 'A hook blocked this message before it was sent.',
          });
          if (serverPersistedRun) emit({ conversationId, type: 'done' });
          void hookDispatcher.dispatch('AgentStop', { conversationId, aborted: false });
          cleanupAssistantTabsIfOwned(conversationId, streamToken);
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
        // A modify hook may have rewritten content (even in place); drop counts on
        // any message whose content no longer matches its signature. Only scan when
        // an enforcing UserPromptSubmit hook actually exists — otherwise skip the
        // O(total-history) work so a normal send keeps the integer-only fast path.
        messages = stripDisplayOnlyParts(next.messages);
        if (hookDispatcher.hasEnforcingHooksFor('UserPromptSubmit')) {
          messages = invalidateStaleTokenCounts(messages);
        }
        const afterMsg = lastUserMessage(messages);
        const afterContent = jsonStableString(afterMsg?.content);
        const afterUsers = countUsers(messages);
        const submittedTurnRemoved = afterUsers < beforeUsers || !afterMsg;
        if (beforeMsg && (submittedTurnRemoved || afterContent !== beforeContent)) {
          const red = persistRedactedUserTurn(
            appHome,
            conversationId,
            submittedTurnRemoved ? '[removed by a policy hook]' : afterMsg!.content,
          );
          // Refresh the drift baseline for the redacted id (now persisted to disk) so the
          // recovery/reuse content check matches; other ids keep their raw baseline.
          if (red) turnStartBranchSig.set(red.id, red.sig);
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
      cleanupAssistantTabsIfOwned(conversationId, streamToken);
      cleanupStreamIfOwned(conversationId, streamToken);
      return { conversationId };
    }

    // Non-blocking fallback notice: the preferred runtime is unavailable but we
    // can still route through the standard pipeline. Show a visible notice.
    if (resolution.fallbackNotice) {
      emit({ conversationId, type: 'text-delta', text: `> ⚠️ ${resolution.fallbackNotice}\n\n` });
    }

    const enforcingToolHooksActive = hookDispatcher.hasEnforcingToolHooks();

    // SDK/CLI runtimes can execute provider-owned shell, file, and web tools
    // without crossing Kai's bridged-tool boundary. Keep this warning even
    // though their Kai MCP tools now receive lifecycle hooks: otherwise a
    // block/modify policy would look complete while silently covering only a
    // subset of the runtime's tool surface.
    if (shouldWarnAboutUnwrappedRuntimeTools(runtime.capabilities, enforcingToolHooksActive)) {
      emit({
        conversationId,
        type: 'text-delta',
        text:
          `> ⚠️ The **${runtime.name}** runtime has built-in tools that run outside Kai's tool wrappers. ` +
          `Those built-in shell, file, and web actions are NOT covered by your block/modify ` +
          `PreToolUse/PostToolUse hooks; Kai MCP and Browser tools remain covered. ` +
          `Use the Mastra runtime if complete hook enforcement is required.\n\n`,
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
    if (hasProviderTools && enforcingToolHooksActive) {
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

    // Resolve the exact host-tool surface before registering Browser ownership.
    // A primary renderer may have native Browser authority while this particular
    // run still has no Browser tools (feature disabled, plan mode, or a plugin
    // inference provider without authenticated-session permission). Registering
    // those runs would needlessly conflict with Realtime and apply privileged
    // cancellation/input rules to an ordinary stream.
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
    const effectiveRunTools =
      pluginRuntimeId && !inferenceProvider
        ? toolsForRun(registeredTools, effectiveExecutionMode, false)
        : inferenceProvider
          ? toolsForPluginInferenceProvider(
              registeredTools,
              effectiveExecutionMode,
              hasNativeBrowserAuthority,
              pluginManager,
              inferenceProvider,
            )
          : toolsForRun(registeredTools, effectiveExecutionMode, hasNativeBrowserAuthority);
    const allowNativeBrowserTools = effectiveRunTools.some((tool) => tool.source === 'browser');
    const admittedStream = activeStreams.get(conversationId);
    if (admittedStream?.token === streamToken) {
      // Renderer authority reserves the stream during async setup; once the
      // effective tool set is known, retain that protection only for a run that
      // can actually receive native Browser tools.
      admittedStream.nativeBrowserInitiator = allowNativeBrowserTools;
      admittedStream.nativeBrowserTools = allowNativeBrowserTools;
    }

    const rollbackBrowserAdmissionIfOwned = (): boolean => {
      if (activeStreams.get(conversationId)?.token !== streamToken) return false;
      releaseContinuationAuth(conversationId);
      resetBrowserAuthorityRevokedRunStatus(appHome, conversationId);
      if (serverPersistTokens.get(conversationId) === streamToken) {
        serverPersistTokens.delete(conversationId);
        serverPersistParents.delete(conversationId);
        discardPersistenceAccumulator(conversationId);
      }
      cleanupStreamIfOwned(conversationId, streamToken);
      void hookDispatcher.dispatch('AgentStop', { conversationId, aborted: false });
      return true;
    };

    // Browser continuation cleanup applies to every replacement turn, but only
    // a run whose final tool array contains a Browser tool receives a Browser
    // capability. Publish activeStreams.nativeBrowserTools only after admission
    // succeeds, so a rejection cannot leave a phantom privileged/busy stream.
    const browserManager = getExistingBrowserManager();
    const browserAuthorityRevoked = () =>
      isNativeBrowserAuthorityRevoked(
        allowNativeBrowserTools,
        browserManagerAtAuthorization,
        getExistingBrowserManager(),
        nativeBrowserAuthorityGeneration,
      );
    if (allowNativeBrowserTools && (!browserManager || browserAuthorityRevoked())) {
      const stillOwned = activeStreams.get(conversationId)?.token === streamToken;
      rollbackBrowserAdmissionIfOwned();
      if (stillOwned) return rejectRevokedBrowserLaunch();
      return { conversationId };
    }
    if (browserManager) {
      try {
        // Realtime terminal cleanup revokes its Browser owner synchronously but
        // may still be draining an in-flight action. Do not race a replacement
        // text turn into beginAssistantRun while that owner is still registered.
        await browserManager.waitForAssistantTabCleanup(conversationId);
        if (allowNativeBrowserTools && continuationPredecessorToken) {
          await browserManager.beginAssistantContinuation(conversationId, streamToken, continuationPredecessorToken);
        } else {
          // A non-Browser run must reclaim a retained predecessor instead of
          // adopting its authenticated temporary tabs.
          await browserManager.cancelAssistantContinuations(conversationId);
        }

        // Browser drains can wait behind an in-flight action. A replacement
        // turn may take ownership while this handler is suspended; do not let
        // the old handler resume into shared bookkeeping or stream setup.
        const drainSuperseded = isBrowserDrainSuperseded(
          controller.signal.aborted,
          activeStreams.get(conversationId)?.token,
          streamToken,
        );
        const authorityRevoked = browserAuthorityRevoked();
        if (drainSuperseded || authorityRevoked) {
          await browserManager.cleanupAssistantTabs(conversationId, streamToken);
          const stillOwned = activeStreams.get(conversationId)?.token === streamToken;
          rollbackBrowserAdmissionIfOwned();
          if (authorityRevoked && stillOwned) return rejectRevokedBrowserLaunch();
          return { conversationId };
        }

        if (allowNativeBrowserTools && !continuationPredecessorToken) {
          browserManager.beginAssistantRun(conversationId, streamToken);
        }

        const postAdmissionSuperseded = isBrowserDrainSuperseded(
          controller.signal.aborted,
          activeStreams.get(conversationId)?.token,
          streamToken,
        );
        const postAdmissionAuthorityRevoked = browserAuthorityRevoked();
        if (postAdmissionSuperseded || postAdmissionAuthorityRevoked) {
          await browserManager.cleanupAssistantTabs(conversationId, streamToken);
          const stillOwned = activeStreams.get(conversationId)?.token === streamToken;
          rollbackBrowserAdmissionIfOwned();
          if (postAdmissionAuthorityRevoked && stillOwned) return rejectRevokedBrowserLaunch();
          return { conversationId };
        }

        if (allowNativeBrowserTools) {
          const ownedStream = activeStreams.get(conversationId);
          if (ownedStream?.token === streamToken) ownedStream.nativeBrowserTools = true;
        }
      } catch (error) {
        // beginAssistantRun can reject when Realtime owns this conversation.
        // Roll back every state item published before admission so the failed
        // request does not remain phantom-busy and the conversation can retry.
        try {
          await browserManager.cleanupAssistantTabs(conversationId, streamToken);
        } catch {
          // The rejected run may never have reached the Browser registry.
        }
        rollbackBrowserAdmissionIfOwned();
        throw error;
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
    // Track the runtime so a mid-turn inject can pick cooperative (Mastra) vs
    // abort+restart (CLI runtimes). Token-scoped so a superseded predecessor's
    // stale runtime is never read for this run (see getActiveStreamRuntime).
    // Guard on CURRENT ownership: if a superseding run (B) already took the
    // active stream while THIS run (A) was awaiting resolveRuntimeForStream, A
    // must NOT overwrite B's entry with A's stale token (that would leave B
    // runtime-unknown and block cooperative delivery). Only the owning run writes.
    if (activeStreams.get(conversationId)?.token === streamToken) {
      activeStreamRuntime.set(conversationId, {
        token: streamToken,
        runtimeId: runtime.id,
        // Captured so a mid-turn inject can gate its text under the SAME model +
        // system prompt + execution mode this run uses (see getActiveRunContext /
        // gateInjectedUserText). modelKey is refreshed on model-fallback below.
        modelKey: modelEntry?.key ?? modelKey ?? config.models.defaultModelKey,
        systemPrompt: effectiveSystemPrompt,
        preHookSystemPrompt,
        executionMode: effectiveExecutionMode,
        // Fingerprint of this run's full EFFECTIVE context so a mid-turn inject that
        // would resolve differently falls through to abort+restart rather than
        // splicing under the wrong settings (R97). Computed from the SAME config +
        // inputs the run resolved, so it matches an identical-context inject.
        contextFingerprint: computeRunContextFingerprint(
          config,
          runtimeDispatchDescriptor(resolution),
          effectiveCwd,
          effectiveExecutionMode,
          {
            modelKey,
            profileKey,
            reasoningEffort,
            fallbackEnabled,
            threadOverrides,
          },
        ),
        // Optimistically cooperative for a Mastra runtime; the inference-provider
        // branch below CLEARS this before its first await if it takes the direct
        // (non-prepareStep) path (R100).
        cooperativelyInjectable: runtime.id === 'mastra',
      });
      // Seed the run's INITIAL response id into its lineage NOW, before any provider
      // event. A GUI turn passes a caller-provided responseMessageId that the
      // renderer persists a PRE-MODEL notice under (e.g. the provider-native-tool
      // warning) before the first provider event carries an id — without seeding,
      // injectHeadStillOnBranch would see that legitimate head advance as a branch
      // switch and wrongly supersede the healthy run (a mid-turn send whose gate is
      // still awaiting). Token-scoped no-op if superseded.
      if (responseMessageId) recordActiveRunResponseId(conversationId, streamToken, responseMessageId);
    }

    // Raced-answer → successor rendezvous (see registerRacedAnswerHandoff): if a
    // prior turn aborted-to-restart while an ask_user answer was pending, THIS
    // turn is the successor by construction. A Mastra successor registers itself
    // as the live claimant and attempts delivery now (the answer may already be
    // stashed); if the answer arrives LATER, agent:answer-tool-question retries
    // delivery. Cleared on teardown (cleanupRacedAnswerClaimant) so a later
    // unrelated turn can't be treated as the successor. Only Mastra registers
    // (cooperative injects require it); a non-Mastra successor invalidates any
    // pending handoff so it can't linger for a later Mastra turn.
    // Cleanup of this claimant registration is centralized (token-scoped) in
    // cleanupStreamIfOwned, which runs on every terminal + early-exit path.
    // Register when EITHER a pending handoff exists now, OR a prior claimant still
    // owns this conversation's raced state (a predecessor B being superseded by
    // THIS run C, whose async teardown may re-register a handoff AFTER we pass this
    // point — see dropRacedAnswerClaimantForToken), OR this run SUPERSEDED a live
    // predecessor that may still be awaiting a slow ask_user PreToolUse hook and
    // will register its (successor-bound) handoff only AFTER this point — neither
    // map is populated yet in that window, so without an empty claimant here the
    // late handoff would have nothing to merge into and the answer would be lost.
    // Registering C now (even with no keys yet) lets that late handoff merge into C
    // instead of sitting until TTL.
    if (
      activeStreams.get(conversationId)?.token === streamToken &&
      (racedAnswerHandoffs.has(conversationId) ||
        liveRacedAnswerClaimant.has(conversationId) ||
        supersededLivePredecessor)
    ) {
      if (runtime.id === 'mastra') {
        // A plugin INFERENCE PROVIDER resolves as runtime.id === 'mastra' but its
        // `.stream()` path bypasses Mastra's prepareStep — so cooperative injection
        // NEVER drains (the terminal inject-drain is Mastra-only). Registering a
        // cooperative claimant for it would report delivery "success" on enqueue while
        // the answer is never consumed (and lingers for a later turn). Detect that path
        // HERE (same resolution the provider dispatch below uses) and treat it as
        // NON-cooperative: invalidate the handoff so the answer stays in the bounded
        // stash rather than being falsely claimed.
        const claimantModelKey = modelEntry?.key ?? modelKey ?? config.models.defaultModelKey;
        const claimantProviderKey =
          config.models.catalog.find((m) => m.key === claimantModelKey)?.provider ?? undefined;
        const isBuiltInRuntimeId = (id: string): boolean =>
          id === 'mastra' || id === 'claude-agent-sdk' || id === 'codex-sdk' || id === 'auto';
        const claimantPluginRuntimeId =
          resolution.inferenceProviderRuntimeId ??
          (!isBuiltInRuntimeId(resolution.runtimeId) ? resolution.runtimeId : undefined);
        const willUseDirectInferenceProvider = Boolean(
          pluginManager?.getInferenceProvider({
            runtimeId: claimantPluginRuntimeId ?? resolution.runtimeId,
            modelProviderKey: claimantProviderKey,
          }),
        );
        if (willUseDirectInferenceProvider) {
          // Non-cooperative: same handling as the non-Mastra branch below.
          // Recover any stashed answers durably before dropping both maps (R86).
          {
            const h = racedAnswerHandoffs.get(conversationId);
            if (h) recoverOrphanedAnswerKeys(conversationId, h.answerKeys);
            const c = liveRacedAnswerClaimant.get(conversationId);
            if (c) recoverOrphanedAnswerKeys(conversationId, c.state.answerKeys);
          }
          racedAnswerHandoffs.delete(conversationId);
          liveRacedAnswerClaimant.delete(conversationId);
          traceDiagnostic({
            scope: 'agent',
            event: 'question.answer-handoff-dropped-non-mastra',
            level: 'warn',
            conversationId,
            toolName: 'ask_user',
            fields: { reason: 'direct-inference-provider' },
          });
        } else {
          // Bind an UNBOUND pending handoff (a plan-restart, whose successor token was
          // unknown at abort) to THIS admitted successor, so that if this run dies
          // before/without claiming (config/hook fail), its teardown
          // (dropRacedAnswerClaimantForToken, expectedSuccessorToken === token) drops
          // the handoff instead of leaving it claimable by a later unrelated turn.
          const pending = racedAnswerHandoffs.get(conversationId);
          if (pending && pending.expectedSuccessorToken === undefined) {
            pending.expectedSuccessorToken = streamToken;
          }
          registerLiveRacedAnswerClaimant(
            conversationId,
            streamToken,
            async (text) => {
              const reinject = injectUserTurnAndRestart;
              if (!reinject) return { ok: false };
              try {
                // COOPERATIVE-ONLY: a stale ask_user answer must splice into THIS live
                // successor or fail — never abort a newer run / restart after Stop. Bind
                // to streamToken so a supersession during the async policy gate fails
                // (transient) rather than misdelivering.
                const res = await reinject(conversationId, text, {
                  cooperativeOnly: true,
                  expectedToken: streamToken,
                });
                if (res?.ok && res.injectedCooperatively) return { ok: true };
                // A policy block is permanent for this content — don't retry it.
                // notCooperative (ownership changed / not injectable) is transient.
                return { ok: false, terminal: Boolean(res?.blockedByPolicy) };
              } catch {
                return { ok: false };
              }
              // forceEmpty: even with no handoff/prior claimant yet, register an
              // empty claimant when this run superseded a live predecessor — its
              // still-pending ask_user hook may register a successor-bound handoff
              // after this point, which then merges here instead of being lost.
            },
            { forceEmpty: supersededLivePredecessor },
          );
        }
      } else {
        // Non-Mastra successor can't cooperatively inject — invalidate the handoff
        // (answers stay in the bounded stash) so it can't attach to a later turn.
        // ALSO clear a token-mismatched live claimant left by a superseded Mastra
        // predecessor whose teardown is still pending: if THIS non-Mastra run
        // finishes first, its cleanup wouldn't touch that claimant (token mismatch),
        // and a subsequent Mastra turn could inherit + inject the stale answer.
        // First route any ALREADY-STASHED answers through the durable recovered-answer
        // path (labeled re-inject / Alert) so they aren't orphaned under an obsolete
        // tool-call id once both maps are dropped (R86).
        {
          const h = racedAnswerHandoffs.get(conversationId);
          if (h) recoverOrphanedAnswerKeys(conversationId, h.answerKeys);
          const c = liveRacedAnswerClaimant.get(conversationId);
          if (c) recoverOrphanedAnswerKeys(conversationId, c.state.answerKeys);
        }
        racedAnswerHandoffs.delete(conversationId);
        liveRacedAnswerClaimant.delete(conversationId);
        traceDiagnostic({
          scope: 'agent',
          event: 'question.answer-handoff-dropped-non-mastra',
          level: 'warn',
          conversationId,
          toolName: 'ask_user',
        });
      }
    }
    for (const [index, message] of messageList.entries()) {
      const serializedContent = jsonStableString(message.content ?? '');
      const contentPreview =
        typeof message.content === 'string' ? message.content.slice(0, 200) : serializedContent.slice(0, 200);
      console.info(
        `[Agent:stream]   msg[${index}] role=${message.role ?? '?'} contentLen=${serializedContent.length} preview=${contentPreview}`,
      );
    }

    const enforcingHooksActive = hookDispatcher.hasEnforcingToolHooks();

    // Run streaming in background
    (async () => {
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
        cleanupAssistantTabsIfOwned(conversationId, streamToken);
        cleanupStreamIfOwned(conversationId, streamToken);
        return;
      }
      if (inferenceProvider) {
        // A direct inference-provider stream bypasses Mastra's prepareStep, so it
        // canNOT drain the inject queue — a cooperative mid-turn splice would be
        // acknowledged but never consumed. Mark this run non-cooperative so the
        // inject path force-restarts instead (R100). Done BEFORE the first await.
        markRunNotCooperativelyInjectable(conversationId, streamToken);
        console.info(
          `[Agent:stream] Using plugin inference provider: ${inferenceProvider.name} for conv=${conversationId}`,
        );
        let emittedTextDelta = false;
        try {
          const providerModelKey =
            rawCatalogEntry?.provider === rawCatalogEntry?.key
              ? undefined
              : (modelEntry?.key ?? modelKey ?? config.models.defaultModelKey);
          let providerResponseText = '';
          const pluginToolCapability = new AbortController();
          const pluginToolSignal = mergeAbortSignals(controller.signal, pluginToolCapability.signal)!;
          try {
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
              tools: bindBrowserToolsToRun(
                effectiveRunTools,
                conversationId,
                streamToken,
                pluginToolSignal,
                {
                  cwd: effectiveCwd,
                  isHeadless: false,
                  parentProfileKey:
                    profileKey ?? (config as { defaultProfileKey?: string | null }).defaultProfileKey ?? null,
                  parentModelKey: modelEntry?.key ?? modelKey ?? null,
                },
                (tool) =>
                  !controller.signal.aborted &&
                  activeStreams.get(conversationId)?.token === streamToken &&
                  pluginManager?.inferenceProviderHasPermission(inferenceProvider, 'agent:inference-provider') ===
                    true &&
                  (tool.source !== 'browser' ||
                    pluginManager?.inferenceProviderHasPermission(
                      inferenceProvider,
                      'browser:authenticated-session',
                    ) === true),
              ),
            });

            for await (const event of providerStream) {
              if (controller.signal.aborted && event.type !== 'done') continue;
              if (event.type === 'text-delta') {
                emittedTextDelta = true;
                providerResponseText += event.text ?? '';
              }
              // A plugin provider may YIELD an error event (not just throw). If it's a
              // context overflow, classify it + append provider-appropriate guidance
              // (parity with the throw path below) so the renderer surfaces recovery
              // steps — the plugin runs outside Kai's compact-and-retry loop.
              if (event.type === 'error' && !(event as { errorCategory?: unknown }).errorCategory) {
                const evErr = (event as { error?: unknown }).error;
                if (isContextOverflowError(evErr)) {
                  (event as Record<string, unknown>).errorCategory = 'context-overflow';
                  (event as Record<string, unknown>).error =
                    `${evErr instanceof Error ? evErr.message : String(evErr ?? 'Context window exceeded.')}` +
                    `\n\n> ℹ️ The request exceeded the context window. This model runs through a plugin provider that manages its own context — start a new chat or remove older messages/attachments, then resend.`;
                }
              }
              if (event.type === 'error' && (event as { error?: unknown }).error !== undefined) {
                (event as Record<string, unknown>).error = pluginProviderErrorForExposure(
                  (event as { error?: unknown }).error,
                  allowNativeBrowserTools,
                );
              }
              protectUnresolvedToolCallArgs(
                event,
                enforcingHooksActive,
                event.type === 'tool-call' &&
                  !!event.toolName &&
                  findToolByName(effectiveRunTools, event.toolName) !== undefined,
                false,
              );

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
          } finally {
            // A provider can retain executable tool closures after its iterator
            // settles. Revoke them at that exact boundary, before post-receive
            // hooks or later turns can run, even when the provider throws.
            pluginToolCapability.abort();
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
          cleanupAssistantTabsIfOwned(conversationId, streamToken);

          // Provider handled the request — clean up and exit. cleanupStreamIfOwned runs the
          // GUI-turn persistence fallback (finalize main's accumulated reply if the renderer never
          // persisted — sole-reload/crash — else discard), so this early exit is covered too.
          cleanupStreamIfOwned(conversationId, streamToken);
          return;
        } catch (providerError) {
          if (emittedTextDelta) {
            // Already started streaming text — can't fall back mid-response
            const exposedProviderError = pluginProviderErrorForExposure(providerError, allowNativeBrowserTools);
            console.error(
              `[Agent:stream] Plugin inference provider "${inferenceProvider.name}" failed after emitting text:`,
              exposedProviderError,
            );
            const meta = { runtimeId: inferenceProvider.name };
            emit({
              conversationId,
              type: 'error',
              error: `Inference provider error: ${exposedProviderError}`,
              messageMeta: meta,
            });
            emit({ conversationId, type: 'done', messageMeta: meta });
            void hookDispatcher.dispatch('AgentStop', { conversationId, aborted: controller.signal.aborted });
            cleanupAssistantTabsIfOwned(conversationId, streamToken);
            cleanupStreamIfOwned(conversationId, streamToken);
            return;
          }
          const meta = { runtimeId: inferenceProvider.name };
          // A plugin inference provider runs OUTSIDE the Mastra do/while retry loop
          // AND doesn't consume Kai's persisted compaction record, so neither
          // auto-retry nor `/compact` applies here. Still classify a context overflow
          // and give actionable (provider-appropriate) guidance + the structured
          // category so the renderer surfaces a recovery hint.
          const pluginOverflow = isContextOverflowError(providerError);
          const pluginBaseMsg = pluginProviderErrorForExposure(providerError, allowNativeBrowserTools);
          console.error(
            `[Agent:stream] Plugin inference provider "${inferenceProvider.name}" failed before emitting text:`,
            pluginBaseMsg,
          );
          emit({
            conversationId,
            type: 'error',
            error: pluginOverflow
              ? `${pluginBaseMsg}\n\n> ℹ️ The request exceeded the context window. This model runs through a plugin provider that manages its own context — start a new chat or remove older messages/attachments, then resend.`
              : `Inference provider error: ${pluginBaseMsg}`,
            ...(pluginOverflow ? { errorCategory: 'context-overflow' as const } : {}),
            messageMeta: meta,
          });
          emit({ conversationId, type: 'done', messageMeta: meta });
          void hookDispatcher.dispatch('AgentStop', { conversationId, aborted: controller.signal.aborted });
          cleanupAssistantTabsIfOwned(conversationId, streamToken);
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
          // Browser typing can contain passwords, OTPs, recovery codes, and
          // tokens. Hooks and their automation fan-out receive only the safe
          // display form; the original remains private to the executor unless
          // an enforcing modify hook explicitly supplies replacement args.
          const exposedArgs = redactBrowserToolArgsForExposure(toolName, args);
          const preTool = await hookDispatcher.dispatch('PreToolUse', {
            conversationId,
            toolCallId,
            toolName,
            args: exposedArgs,
          });
          if (preTool.denied) {
            const reason = preTool.reason ?? 'Blocked by PreToolUse hook.';
            return { denied: true, reason, args: { redacted: true, reason } };
          }
          const nextArgs = preTool.modified ? (preTool.payload as { args?: unknown } | undefined)?.args : undefined;
          return { denied: false, args: nextArgs !== undefined ? nextArgs : args };
        })();
        preToolResults.set(toolCallId, p);
        return p;
      };
      // When block/modify hooks are active, the UI-facing `tool-call` stream
      // event can arrive before PreToolUse resolves. Mastra calls back with a
      // matching id, so its initial pending placeholder is corrected below.
      // Runtimes without correlatable ids remain permanently redacted.
      // Provider-native tool names for the CURRENTLY ACTIVE model. Provider-
      // native tools execute in-provider and never hit onToolExecutionStart,
      // so their args must not be suppressed (nothing would un-suppress them →
      // stuck {pending}). This must track the active model, NOT a union across
      // fallbacks: unioning would wrongly exempt the primary model's LOCAL
      // tool (e.g. a client-side `web_search`) just because a fallback model
      // has a provider-native tool of the same name — letting raw args leak
      // past a DLP hook. Recomputed on each model-fallback event below.
      let providerDefinedToolNames = modelEntry?.modelConfig
        ? getProviderDefinedToolNames(modelEntry.modelConfig, effectiveExecutionMode)
        : new Set<string>();
      const pendingObserverToolExecutions = new Set<Promise<void>>();
      let observerLaunchesEnabled = true;
      let observer: ToolObserverManager | null = null;
      let browserContinuationPrepared = false;
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
        const execQ = pendingExecIdsByToolName.get(toolName);
        const streamQ = pendingStreamIdsByToolName.get(toolName);
        if (!execQ || execQ.length === 0 || !streamQ || streamQ.length === 0) {
          return null;
        }
        // Pair STRICTLY by id-identity: the execute wrapper reads the tool-call
        // id from Mastra's execution context (top-level OR nested agent context),
        // so execute and stream ids are the SAME id — the correct, order-
        // independent, cross-wire-proof pairing is by id equality. We do NOT pair
        // non-matching ids even when momentarily singleton: under parallel calls,
        // exec(A) then stream(B) arriving before their counterparts would each be
        // "singleton" and get wrongly cross-wired A↔B. A non-matching id waits for
        // its identical counterpart.
        const shared = execQ.find((id) => streamQ.includes(id));
        if (shared === undefined) return null;
        const executeToolCallId = shared;
        const streamToolCallId = shared;
        pendingExecIdsByToolName.set(
          toolName,
          execQ.filter((id) => id !== executeToolCallId),
        );
        pendingStreamIdsByToolName.set(
          toolName,
          streamQ.filter((id) => id !== streamToolCallId),
        );
        if (pendingExecIdsByToolName.get(toolName)?.length === 0) pendingExecIdsByToolName.delete(toolName);
        if (pendingStreamIdsByToolName.get(toolName)?.length === 0) pendingStreamIdsByToolName.delete(toolName);

        streamToolCallIdByExecId.set(executeToolCallId, streamToolCallId);
        execToolCallIdByStreamId.set(streamToolCallId, executeToolCallId);
        logToolCompactionDebug('pair-tool-call-ids', {
          conversationId,
          toolName,
          executeToolCallId,
          streamToolCallId,
        });
        flushPendingToolCompaction(executeToolCallId);
        // Drain any OTHER already-matchable shared ids now, so a pair that became
        // unambiguous doesn't linger unpaired until some future event happens to
        // re-invoke this function (or never does). Each is a definitive identity
        // match; pairing them here is safe and order-independent.
        for (;;) {
          const nextExecQ = pendingExecIdsByToolName.get(toolName);
          const nextStreamQ = pendingStreamIdsByToolName.get(toolName);
          if (!nextExecQ || !nextStreamQ) break;
          const nextShared = nextExecQ.find((id) => nextStreamQ.includes(id));
          if (nextShared === undefined) break;
          pendingExecIdsByToolName.set(
            toolName,
            nextExecQ.filter((id) => id !== nextShared),
          );
          pendingStreamIdsByToolName.set(
            toolName,
            nextStreamQ.filter((id) => id !== nextShared),
          );
          if (pendingExecIdsByToolName.get(toolName)?.length === 0) pendingExecIdsByToolName.delete(toolName);
          if (pendingStreamIdsByToolName.get(toolName)?.length === 0) pendingStreamIdsByToolName.delete(toolName);
          streamToolCallIdByExecId.set(nextShared, nextShared);
          execToolCallIdByStreamId.set(nextShared, nextShared);
          flushPendingToolCompaction(nextShared);
        }
        return executeToolCallId;
      };

      /**
       * Fit any `_modelContent` images on a tool result into the model's
       * REMAINING context budget (contextWindow − current branch − reserve),
       * per `config.compaction.media`. Downscales toward the floor, or fails
       * safe (drops with a note to the model). On a drop, emits a ⚠️ UI note
       * suggesting `/compact`. Returns the (possibly transformed) result;
       * a no-op passthrough when media fitting is disabled or the result
       * carries no images.
       */
      // Running total of estimated tokens the KEPT media (images) from THIS
      // turn's tool results already commit to the model input. `messages` is the
      // turn-initial branch and doesn't include media produced earlier in the
      // same multi-step turn, so each fit subtracts this accumulator too — else
      // several media-producing tool calls could each independently "fit" the
      // same remaining budget while their sum overflows the window.
      let committedMediaTokens = 0;
      // Cumulative decoded MEDIA BYTES kept by tool results this turn. extractModelContent's
      // 12 MiB aggregate cap is PER RESULT; fed back into each fitModelContentToBudget call as
      // the seed so the cap becomes a per-TURN media ceiling (else N results each just under
      // 12 MiB collectively produce a huge follow-up request — memory/network/provider-reject).
      let committedMediaBytes = 0;
      // Non-media text/JSON output committed by tool results THIS turn (their
      // cleaned, non-`_modelContent` bodies). Not present in the turn-initial
      // `messages`, so tracked here to budget cumulative same-turn output.
      let committedNonMediaTokens = 0;
      // Memoized token cost of the STATIC per-request input the runtime always
      // submits alongside the branch: the system prompt + the serialized tool
      // schemas. These aren't in `messages`, and with a big custom prompt / many
      // MCP tools they can exceed the fixed reserve — so subtract them from the
      // media budget. Computed once (lazily) via the UTF-8 byte ceiling. `-1`
      // sentinel = not yet computed.
      let staticInputTokensMemo = -1;
      // Lazily compute + memoize the static per-request input tokens (assembled
      // system prompt + tool schemas + workspace allowance). Used by BOTH the
      // small-text fast-path fit check and the full media budget so both subtract
      // the same static cost.
      const getStaticInputTokens = async (): Promise<number> => {
        if (staticInputTokensMemo < 0) {
          // Use the ACTIVE model (post-fallback) so a cross-provider fallback with a
          // different tokenizer counts the static input under ITS encoder. Reset to
          // -1 on model-fallback so this recomputes for the new model.
          const activeModel = activeModelEntryForRecovery ?? modelEntry;
          // Estimate the FULLY-BUILT instructions the turn sends — buildAgentInstructions
          // appends runtime-capability (and plan-mode) text to the resolved prompt — not
          // just the base prompt, or the fitter under-counts and can retain media that
          // overflows the next step (parity with the sub-agent fitter). Force
          // resolveModeSystemPrompt to yield effectiveSystemPrompt (post-plugin-rewrite)
          // by seeding both the plain + mode prompt fields, then let buildAgentInstructions
          // add the capability suffix for the active mode.
          const instructionsForEstimate = buildAgentInstructions(
            {
              ...config,
              systemPrompt: effectiveSystemPrompt ?? '',
              // Seed ONLY the chat prompt with the override-respecting send prompt (mirrors
              // the runtime's configForStream, which overrides systemPrompts.chat only).
              // Leave systemPrompts.plan as-is: in plan-first mode Mastra sends the REAL
              // plan prompt, so overwriting it here would mis-estimate (chat prompt in place
              // of the possibly-larger plan prompt). buildAgentInstructions(cfg, mode) then
              // yields chat=sendPrompt for chat mode, the real plan prompt for plan-first.
              systemPrompts: {
                ...config.systemPrompts,
                chat: effectiveSystemPrompt ?? '',
              },
            },
            effectiveExecutionMode,
          );
          staticInputTokensMemo = await estimateStaticRequestTokens(
            instructionsForEstimate,
            effectiveCwd ?? undefined,
            activeCustomTools,
            WORKSPACE_TOOL_SCHEMA_TOKENS_ALLOWANCE,
            activeModel?.modelConfig.modelName,
          );
        }
        return staticInputTokensMemo;
      };
      // Serialize media fitting across the turn. Mastra can execute tool calls in
      // parallel, so two media results could each read the SAME committedMediaTokens
      // before either commits (the fit is async), letting both "fit" the same
      // remaining budget and collectively overflow. Chaining every fit through one
      // promise makes the read-budget → fit → commit sequence atomic per turn.
      let mediaFitChain: Promise<unknown> = Promise.resolve();
      // Tool-call arguments the assistant generated THIS turn also go to the next
      // model step (in the assistant tool-call message), but they're neither in the
      // turn-initial branch nor in a tool RESULT. Charge them ONCE per toolCallId
      // as early as the args are known (at tool-execution START, and again at
      // result time as a fallback for tools that bypass the start hook) — charging
      // only at result time would let a PARALLEL call A's media be committed before
      // call B's (large) args are counted, so A retains media that then overflows.
      const committedToolCallArgIds = new Set<string>();
      // Bytes charged so far per toolCallId, so a PreToolUse hook that REWRITES args
      // to a larger payload (in-place mutation, below) can be re-charged by DELTA —
      // the initial charge reflects the pre-rewrite args, and under-charging would let
      // near-budget media be retained and overflow the follow-up (recovery is off once
      // a tool has run).
      const chargedArgBytesById = new Map<string, number>();
      const argBytesOf = (args: unknown): number => {
        if (args === undefined) return 0;
        try {
          return Buffer.byteLength(JSON.stringify(args) ?? '', 'utf8');
        } catch {
          return 0; // unserializable → treat as 0 (matches prior skip behavior)
        }
      };
      // Apply an arg charge to the accumulator (idempotent per id). Synchronous —
      // safe to call from INSIDE the mediaFitChain (the fit's fallback path).
      const applyArgCharge = (toolCallId: string | undefined, args: unknown): void => {
        if (!toolCallId || committedToolCallArgIds.has(toolCallId) || args === undefined) return;
        committedToolCallArgIds.add(toolCallId);
        const bytes = argBytesOf(args);
        chargedArgBytesById.set(toolCallId, bytes);
        committedNonMediaTokens += bytes;
      };
      // Re-charge the DELTA when a PreToolUse hook rewrote an already-charged call's
      // args (idempotent-safe: only the increase over what was already charged is
      // added; a shrink is left as-is so we never UNDER-reserve). Synchronous.
      const applyArgRecharge = (toolCallId: string | undefined, newArgs: unknown): void => {
        if (!toolCallId || !committedToolCallArgIds.has(toolCallId)) return;
        const prev = chargedArgBytesById.get(toolCallId) ?? 0;
        const next = argBytesOf(newArgs);
        if (next > prev) {
          committedNonMediaTokens += next - prev;
          chargedArgBytesById.set(toolCallId, next);
        }
      };
      // Charge args from the tool-execution START hook (OUTSIDE the fit): route
      // through the mediaFitChain so the mutation is ordered w.r.t. media fits that
      // read committed* inside the chain. NOTE: this can't fix the inherent
      // STREAMING-ORDER case — if call B's start hook fires only AFTER call A's fit
      // already committed, B's args weren't known when A fit; that irreducible
      // residual is what `reserveTokens` covers.
      const chargeToolCallArgs = (toolCallId: string | undefined, args: unknown): void => {
        if (!toolCallId || committedToolCallArgIds.has(toolCallId) || args === undefined) return;
        mediaFitChain = mediaFitChain.then(() => applyArgCharge(toolCallId, args));
      };
      // Re-charge a PreToolUse arg rewrite SYNCHRONOUSLY the moment the hook resolves
      // (not chain-routed): it only bumps the committed* counter, and applying it
      // immediately makes the enlargement visible to any sibling fit that has not yet
      // STARTED — narrowing the parallel race to fits already executing. (A fit already
      // in flight when a sibling's hook enlarges its args is the irreducible residual
      // the reserve covers; serializing all tool execution to close it would defeat
      // parallel tool calls.)
      const rechargeToolCallArgs = (toolCallId: string | undefined, newArgs: unknown): void => {
        if (!toolCallId) return;
        applyArgRecharge(toolCallId, newArgs);
      };
      const fitToolMediaToBudget = (
        toolName: string,
        result: unknown,
        toolCallId?: string,
        args?: unknown,
      ): Promise<unknown> => {
        const run = mediaFitChain.then(() => fitToolMediaToBudgetInner(toolName, result, toolCallId, args));
        // Keep the chain alive regardless of this run's outcome (swallow to avoid
        // an unhandled rejection breaking the chain for the next result).
        mediaFitChain = run.then(
          () => undefined,
          () => undefined,
        );
        return run;
      };
      const fitToolMediaToBudgetInner = async (
        toolName: string,
        result: unknown,
        toolCallId?: string,
        args?: unknown,
      ): Promise<unknown> => {
        const mediaConfig = config.compaction?.media as MediaFitConfig | undefined;
        if (!mediaConfig?.enabled || !modelEntry) return result;
        // Fallback arg accounting (idempotent) for tools that bypassed the start
        // hook; the primary charge happens at tool-execution START. This runs INSIDE
        // the fit chain, so apply it SYNCHRONOUSLY (not via the chain-routed variant,
        // which would enqueue after this fit and miss the current budget).
        applyArgCharge(toolCallId, args);
        // Predict the model-visible byte size of a NON-media result AFTER tool-output
        // compaction, mirroring maybeCompactToolOutput: `_diffTracking`/`_modelContent`
        // are split off (diff preserved in full, media handled separately), and the
        // remaining body is shrunk to ~outputMaxTokens when over the trigger. Counting
        // the RAW pre-compaction size here would over-charge committedNonMediaTokens
        // and wrongly shrink a later media part's budget.
        // Byte-size a tool result AFTER tool-output compaction (bounded to
        // ~outputMaxTokens by the model tokenizer). Crediting that shrink as
        // `outputMaxTokens * 4` bytes assumes ≤4 bytes/token — SAFE only for a canonical
        // (o200k, ~4 B/tok English) model. For a fallback/unknown model the real
        // bytes/token is uncertain and can exceed 4, so crediting the shrink would
        // UNDER-count the compacted body and let media be retained that then overflows
        // (and after a tool runs, reactive recovery is off). So credit the shrink ONLY
        // for canonical models; otherwise charge the raw bytes (conservative, never under).
        // The tool-output compaction (maybeCompactToolOutput → compactToolResult) shrinks the
        // body to ~outputMaxTokens using the PRIMARY model's tokenizer, but the resulting
        // bytes are then RE-TOKENIZED by whatever model actually SENDS the request (the
        // fallback after a mid-stream fallback). The `outputMaxTokens * 4` credit assumes
        // ≤4 B/tok — SAFE only if BOTH are canonical (o200k). If EITHER the compaction model
        // OR the active/send model is a fallback/unknown (denser, >4 B/tok possible), grant NO
        // credit and charge raw bytes (conservative — never under-count → media never wrongly
        // retained → no post-tool overflow with recovery off).
        const compactModelName = modelEntry?.modelConfig.modelName; // model that actually compacts
        const sendModelName = (activeModelEntryForRecovery ?? modelEntry)?.modelConfig.modelName; // model that sends
        const isCanonicalModel = (name: string | undefined): boolean => {
          if (!name) return false;
          try {
            const tk = resolveConversationTokenization(name);
            // The outputMaxTokens*4 credit assumes ≤4 bytes/token, which holds for the MODERN
            // o200k base (GPT-4o/4.1/5/o-series). A RECOGNIZED cl100k model (GPT-4-turbo/3.5)
            // is NOT fallback but tokenizes DENSER on non-Latin scripts (>4 B/tok) — so a
            // token-based credit under-charges. Require o200k_base.
            return !!tk?.encoding && !tk.isFallbackEncoding && tk.encodingBaseName === 'o200k_base';
          } catch {
            return false; // unknown → treat as fallback (no credit)
          }
        };
        // The truncation marker inserted by truncateToTokenBudget (must match compaction.ts).
        const TRUNCATE_MARKER = '\n\n...[tool output truncated for size]...\n\n';
        // A GUARANTEED byte upper bound on the compacted body. truncateToTokenBudget TARGETS
        // outputMaxTokens but is NOT guaranteed to reach it (12 proportional-shrink iterations
        // that ignore the char floors, or a first pass that already fits) — so a flat
        // outputMaxTokens*N credit is not a real upper bound and could UNDER-count → media
        // wrongly retained → post-tool overflow (recovery off after a tool ran). Instead compute
        // the DETERMINISTIC first-pass output size head+marker+tail (the shrink loop only ever
        // REDUCES it), which is a true upper bound regardless of token density. Only when BOTH
        // the compacting and sending models are canonical (o200k) do we also cap by
        // outputMaxTokens*4 (safe ≤4 B/tok); otherwise the first-pass bound alone (clamped to
        // rawBytes) is the conservative estimate.
        const compactedBodyBytesUpperBound = (bodyText: string, rawBytes: number, totalTokens: number): number => {
          const toolCfg = config.compaction?.tool as ToolCompactionConfig | undefined;
          const maxTokens = toolCfg?.outputMaxTokens ?? 0;
          if (maxTokens <= 0 || totalTokens <= maxTokens) return rawBytes;
          const canonical = isCanonicalModel(compactModelName) && isCanonicalModel(sendModelName);
          // AI compaction (useAI) REPLACES the body with an AI summary, then truncates THAT to
          // outputMaxTokens — so the bound can NOT be derived from the ORIGINAL body's char
          // slices (the summary is arbitrary text). For a CANONICAL tokenizer the truncated
          // summary is ≤ outputMaxTokens*4 bytes (≤4 B/tok); for a FALLBACK/unknown tokenizer the
          // bytes-per-token is uncertain, so no shrink credit is safe → charge rawBytes (AI
          // summarization + truncation won't GROW past the original in practice, and this can't
          // under-count → no wrongly-retained media → no post-tool overflow).
          if (toolCfg?.useAI) {
            return canonical
              ? Math.min(rawBytes, Math.max(maxTokens * 4, Buffer.byteLength(TRUNCATE_MARKER, 'utf8')))
              : rawBytes;
          }
          const minChars = Math.max(0, toolCfg?.truncateMinChars ?? 200);
          const headRatio = toolCfg?.truncateHeadRatio ?? 0.7;
          const minTailChars = Math.max(0, toolCfg?.truncateMinTailChars ?? 200);
          const ratio = Math.max(0.05, maxTokens / totalTokens);
          const keepChars = Math.max(minChars, Math.floor(bodyText.length * ratio));
          const headChars = Math.floor(keepChars * headRatio);
          const tailChars = Math.max(minTailChars, keepChars - headChars);
          // Exact first-pass output = content.slice(0,head) + marker + content.slice(-tail); its
          // byte size is a true upper bound on the returned (only-shrinking) result.
          const head = Math.min(headChars, bodyText.length);
          const tail = Math.min(tailChars, bodyText.length);
          const firstPassBytes =
            Buffer.byteLength(bodyText.slice(0, head), 'utf8') +
            Buffer.byteLength(TRUNCATE_MARKER, 'utf8') +
            (tail > 0 ? Buffer.byteLength(bodyText.slice(-tail), 'utf8') : 0);
          let bound = firstPassBytes;
          if (canonical) {
            // Cap by the token budget (≤4 B/tok on o200k) — but NEVER below the truncation
            // marker's own byte size: truncateToTokenBudget always emits the marker (its shrink
            // loop reduces head/tail toward 0 but keeps the marker), so a tiny outputMaxTokens
            // (e.g. 1 → 4 bytes) must not cap below the ~44-byte marker, which would under-count
            // the real output and retain media past the true remaining context.
            const markerBytes = Buffer.byteLength(TRUNCATE_MARKER, 'utf8');
            bound = Math.min(bound, Math.max(maxTokens * 4, markerBytes));
          }
          return Math.min(rawBytes, bound);
        };
        const predictCommittedNonMediaBytes = (r: unknown): number => {
          const toolCfg = config.compaction?.tool as ToolCompactionConfig | undefined;
          // maybeCompactToolOutput SKIPS compaction when it's unsupported/disabled
          // AND for the artifact tools (create_artifact/update_artifact). Mirror that
          // here — predicting shrinkage for a body that will actually be sent RAW
          // under-counts and lets a later media part overflow.
          const compactionApplies =
            compactionSupported && toolName !== 'create_artifact' && toolName !== 'update_artifact';
          try {
            const { resultForCompaction } = splitPreservedFields(r);
            const bodyText =
              typeof resultForCompaction === 'string'
                ? resultForCompaction
                : (JSON.stringify(resultForCompaction) ?? '');
            const rawBytes = Buffer.byteLength(bodyText, 'utf8');
            // Diff (preserved in full) is added back on top of the compacted body.
            let diffBytes = 0;
            if (r && typeof r === 'object' && !Array.isArray(r)) {
              const dt = (r as Record<string, unknown>)._diffTracking as { diffs?: unknown[] } | undefined;
              if (dt && Array.isArray(dt.diffs) && dt.diffs.length > 0) {
                diffBytes = Buffer.byteLength(JSON.stringify({ _diffTracking: dt }) ?? '', 'utf8');
              }
            }
            const bodyTotalTokens = estimateToolTokens(bodyText, modelEntry.modelConfig.modelName);
            const willCompact =
              compactionApplies &&
              !!toolCfg?.enabled &&
              toolCfg.outputMaxTokens > 0 &&
              bodyTotalTokens > toolCfg.triggerTokens;
            return (
              (willCompact ? compactedBodyBytesUpperBound(bodyText, rawBytes, bodyTotalTokens) : rawBytes) + diffBytes
            );
          } catch {
            return 0;
          }
        };
        if (!result || typeof result !== 'object' || Array.isArray(result)) {
          // A bare/string/array result still contributes model-visible text this
          // turn — account for its POST-COMPACTION size so later media budgets
          // against what the model actually sees. Arrays are common for MCP
          // multi-block results.
          if (typeof result === 'string' || Array.isArray(result)) {
            committedNonMediaTokens += predictCommittedNonMediaBytes(result);
          }
          return result;
        }
        const obj = result as Record<string, unknown>;
        const parts = obj._modelContent;
        if (!Array.isArray(parts) || parts.length === 0) {
          // Non-media result: still count its POST-COMPACTION serialized text toward
          // this turn's committed output so a later image budgets against what the
          // model actually sees (not the raw pre-compaction body).
          committedNonMediaTokens += predictCommittedNonMediaBytes(obj);
          return result;
        }
        // Run the (cheap) budget check whenever there's media OR any non-trivial
        // text. We can't use a fixed "large text" threshold as a skip: near the
        // context limit even a few KB of token-dense text can overflow, and
        // `_modelContent` text is exempt from normal tool compaction so nothing
        // else truncates it. Only skip when the content is genuinely negligible
        // (a few hundred bytes can't overflow any realistic remaining budget);
        // otherwise fall through to the budget-aware fit below.
        const NEGLIGIBLE_TEXT_BYTES = 512;
        // Single bounded pass. Media detection is a cheap boolean (no byte work) and
        // short-circuits on the first media part. Text-byte summation — the only
        // potentially expensive step — stops as soon as the negligible threshold is
        // crossed (past it the exact total can't change the decision). We scan the
        // FULL array for media rather than stopping at a part-index cap: downstream
        // SKIPS malformed entries when applying its 64 VALID-part cap, so a valid
        // media/text part after many malformed entries still gets fit — a raw-index
        // cap here would wrongly declare such a result negligible and send the
        // oversized valid part unfitted. The threshold break bounds the byte work; a
        // pathological all-media array only does cheap boolean checks.
        let hasMedia = false;
        let aggregateTextBytes = 0;
        let stopTextScan = false;
        for (let pi = 0; pi < parts.length; pi++) {
          const p = parts[pi];
          if (!p || typeof p !== 'object') continue;
          const ptype = (p as { type?: unknown }).type;
          if ((ptype === 'image' || ptype === 'file') && typeof (p as { data?: unknown }).data === 'string') {
            if ((p as { data: string }).data.length > 0) {
              hasMedia = true;
              break; // media forces the fit path — no need to keep scanning
            }
          } else if (ptype === 'text' && !stopTextScan) {
            const t = (p as { text?: unknown }).text;
            if (typeof t === 'string') aggregateTextBytes += Buffer.byteLength(t, 'utf8');
            if (aggregateTextBytes > NEGLIGIBLE_TEXT_BYTES) stopTextScan = true; // exact total no longer matters
          }
        }
        if (!hasMedia && aggregateTextBytes <= NEGLIGIBLE_TEXT_BYTES) {
          // No media and only a small `_modelContent` text block. This is USUALLY
          // safe to send unchanged, but on a NEARLY-FULL branch even ≤512 bytes can
          // overflow — and a tool has already run, so reactive recovery is off. So
          // we still verify it fits the remaining window (cheap: cached branch sum);
          // only truly skip the fit when it comfortably does. The cleaned object
          // body is model-visible text this turn, so account for it either way.
          const windowOverride0 = (config.compaction?.conversation as { contextWindowTokens?: number } | undefined)
            ?.contextWindowTokens;
          // Active model only (see the main fit below — fallback resets the budget).
          const eligibleModels0 = [activeModelEntryForRecovery ?? modelEntry].filter(Boolean);
          let remaining0 = Infinity;
          for (const entry of eligibleModels0) {
            const t = resolveConversationTokenization(
              entry!.modelConfig.modelName,
              windowOverride0 ?? entry!.modelConfig.maxInputTokens,
            );
            if (!t.contextWindowTokens) continue;
            const { messages: branchForSum0, nativeMediaTokens: nmt0 } = await splitBranchMediaForTokenSum(
              messages as unknown[],
              controller.signal,
            );
            const branchTokens0 =
              (t.encoding && !t.isFallbackEncoding
                ? await encodeCappedWithAsync(serializeForTokenCounting(branchForSum0), t, controller.signal)
                : sumBranchTokensForGate(branchForSum0 as Parameters<typeof sumBranchTokensForGate>[0], t)) + nmt0;
            const r = t.contextWindowTokens - branchTokens0;
            if (r < remaining0) remaining0 = r;
          }
          let clonedBodyBytes = 0;
          try {
            const { _modelContent, ...rest } = obj;
            void _modelContent;
            clonedBodyBytes = Buffer.byteLength(JSON.stringify(rest) ?? '', 'utf8');
          } catch {
            /* unserializable → skip */
          }
          // bytes ≥ tokens; subtract committed + static + reserve for the fit-fits
          // check. If it comfortably fits, skip the (unnecessary) fit and just
          // account for the text; otherwise fall through to the budget-aware fit.
          const static0 = await getStaticInputTokens();
          // Same terms the full fit path (below) subtracts: assistant text streamed
          // BEFORE this tool call and any consumed mid-turn inject — both are sent to
          // the next step but live outside `messages`. Omitting them here let a small
          // result ride a long preamble/inject over budget on the fast path (and a
          // tool already ran, so reactive recovery is off — a hard overflow).
          const preToolAssistantBytes0 = Buffer.byteLength(accumulatedResponseText ?? '', 'utf8');
          const injectBytes0 = consumedInjectBytes.get(conversationId) ?? 0;
          const smallTextFits =
            Number.isFinite(remaining0) &&
            aggregateTextBytes +
              clonedBodyBytes +
              committedNonMediaTokens +
              committedMediaTokens +
              static0 +
              preToolAssistantBytes0 +
              injectBytes0 <
              remaining0 - Math.max(0, mediaConfig.reserveTokens);
          if (!Number.isFinite(remaining0) || smallTextFits) {
            committedNonMediaTokens += clonedBodyBytes + aggregateTextBytes;
            return result;
          }
          // else: near-full window — fall through to fit (may truncate/drop).
        }

        // Remaining budget = min over each ELIGIBLE model of (window − branch
        // tokens) − media already kept this turn − reserve. Compute per-model (not
        // min-window-then-one-tokenizer): a model with a larger window but a
        // heavier tokenizer for this branch can be the true binding constraint.
        // Include fallback models ONLY when fallback is enabled for this turn —
        // resolveStreamConfig populates `fallbackModels` regardless, but a disabled
        // fallback can never run, so budgeting against its (smaller) window would
        // needlessly drop media. Window override (compaction.conversation.
        // contextWindowTokens) applies to every model when set.
        const windowOverride = (config.compaction?.conversation as { contextWindowTokens?: number } | undefined)
          ?.contextWindowTokens;
        // Fit against the CURRENTLY-ACTIVE model only. Fallback attempts restart
        // from the original messages AND reset the same-turn accumulators + static
        // memo on the `model-fallback` event, so the budget is recomputed for the
        // new (smaller-window) model at that point. Budgeting against the min of ALL
        // eligible models here would needlessly downscale/drop media that fits the
        // active model when a fallback never occurs. Window override applies to it.
        const activeFitModel = activeModelEntryForRecovery ?? modelEntry;
        const eligibleModels = [activeFitModel].filter(Boolean);
        // Split the branch: strip `_modelContent`/native media base64 from the
        // TEXT token sum (stream-persistence stores each tool result verbatim, so
        // a prior image's cached count includes its base64 — counting that as text
        // massively over-counts), and add back the media's NATIVE token estimate
        // so prior media still costs its real (smaller) amount rather than zero.
        const {
          messages: branchForSum,
          nativeMediaTokens,
          branchMediaBytes,
        } = await splitBranchMediaForTokenSum(messages as unknown[], controller.signal);
        let remaining = Infinity;
        for (const entry of eligibleModels) {
          const t = resolveConversationTokenization(
            entry!.modelConfig.modelName,
            windowOverride ?? entry!.modelConfig.maxInputTokens,
          );
          if (!t.contextWindowTokens) continue;
          // The media-STRIPPED branch has its per-message tokenCount cache dropped (the
          // strip changed the content), so sumBranchTokensForGate would byte-ceiling every
          // touched message — massively over-charging a canonical (o200k) model (120 KB of
          // repetitive text ≈ 15K tokens counted as ~120K), wrongly dropping later media.
          // For a canonical encoder, recount the stripped branch EXACTLY off-thread; use
          // the byte ceiling only for a fallback-encoding model (its true upper bound).
          const branchTokens =
            (t.encoding && !t.isFallbackEncoding
              ? await encodeCappedWithAsync(serializeForTokenCounting(branchForSum), t, controller.signal)
              : sumBranchTokensForGate(branchForSum as Parameters<typeof sumBranchTokensForGate>[0], t)) +
            nativeMediaTokens;
          const modelRemaining = t.contextWindowTokens - branchTokens;
          if (modelRemaining < remaining) remaining = modelRemaining;
        }
        if (!Number.isFinite(remaining)) return result; // no known window → static caps still apply
        // Also subtract non-media output already produced THIS turn (prior tool
        // results' cleaned JSON/text) plus THIS result's own cleaned text — none
        // of which is in the turn-initial `messages`. Without this, several
        // under-threshold text results followed by an image could collectively
        // overflow while each individually "fit". The current result's cleaned
        // (non-`_modelContent`) text is estimated by its serialized byte length.
        // Predict the model-visible NON-media text this result contributes AFTER
        // tool-output compaction, mirroring how the real compaction path splits the
        // result: `_modelContent` (media, budgeted separately below) AND
        // `_diffTracking` (preserved in FULL, never summarized) are excluded from
        // the compactable body — only the remaining body is shrunk to
        // ~outputMaxTokens. Charging the whole cleaned result (diff included) to the
        // compaction cap would UNDER-count when a large `_diffTracking` is present
        // (a big-diff tool result), leaving an optimistic media budget that can
        // overflow after the tool has run (no reactive recovery then). So: estimate
        // compaction on the body-without-diff, then add the full diff bytes back.
        const { compactableText, diffBytes } = (() => {
          try {
            const { _modelContent, _diffTracking, ...rest } = obj as Record<string, unknown>;
            void _modelContent;
            const dt = _diffTracking as { diffs?: unknown[] } | undefined;
            const diffPreserved = dt && Array.isArray(dt.diffs) && dt.diffs.length > 0;
            const bodyText = JSON.stringify(rest) ?? '';
            const diffText = diffPreserved ? (JSON.stringify({ _diffTracking }) ?? '') : '';
            return {
              compactableText: bodyText,
              diffBytes: Buffer.byteLength(diffText, 'utf8'),
            };
          } catch {
            return { compactableText: '', diffBytes: 0 };
          }
        })();
        // If TOOL-text compaction is enabled and this body is over its trigger, the
        // body the model actually receives will be shrunk to ~outputMaxTokens
        // shortly after this fit (maybeCompactToolOutput runs compactToolResult
        // next). Budget against that post-compaction size so media isn't dropped on
        // the basis of text the model never sees. Use the SAME estimateToolTokens
        // the real compaction gate uses (not a rough bytes/4) so the trigger
        // decision here matches whether compaction actually fires. The trigger is
        // evaluated on the COMPACTABLE body only (diff excluded, as in the real
        // path); the preserved diff bytes are always added on top of the result.
        const toolCompactionCfg = config.compaction?.tool as ToolCompactionConfig | undefined;
        // Artifact tools + unsupported/disabled compaction are SKIPPED by
        // maybeCompactToolOutput, so their body is sent RAW — don't predict shrinkage.
        const toolCompactionApplies =
          compactionSupported && toolName !== 'create_artifact' && toolName !== 'update_artifact';
        const compactableTextTotalTokens = estimateToolTokens(compactableText, modelEntry.modelConfig.modelName);
        const willToolCompact =
          toolCompactionApplies &&
          !!toolCompactionCfg?.enabled &&
          toolCompactionCfg.outputMaxTokens > 0 &&
          compactableTextTotalTokens > toolCompactionCfg.triggerTokens;
        const compactableTextRaw = Buffer.byteLength(compactableText, 'utf8');
        const cleanedTextTokens =
          (willToolCompact
            ? compactedBodyBytesUpperBound(compactableText, compactableTextRaw, compactableTextTotalTokens)
            : compactableTextRaw) + diffBytes;
        // Static per-request input (system prompt + tool schemas), computed once.
        if (staticInputTokensMemo < 0) {
          // The static per-request input (assembled system prompt + tool schemas +
          // workspace/provider allowance) isn't in the message branch — count it so
          // media isn't kept on the basis of a window the static input already ate.
          await getStaticInputTokens();
        }
        // Assistant text streamed BEFORE this tool call (accumulatedResponseText)
        // is part of the assistant message sent to the next step but isn't in the
        // branch, args, or results — count it (bytes as a conservative proxy) so a
        // long pre-tool preamble + an image can't overflow the follow-up.
        const preToolAssistantBytes = Buffer.byteLength(accumulatedResponseText ?? '', 'utf8');
        // Consumed mid-turn inject text lives only in Mastra's internal step
        // messages, not the outer `messages` branch — charge it too.
        const injectBytes = consumedInjectBytes.get(conversationId) ?? 0;
        remaining = Math.max(
          0,
          remaining -
            staticInputTokensMemo -
            committedMediaTokens -
            committedNonMediaTokens -
            cleanedTextTokens -
            preToolAssistantBytes -
            injectBytes -
            Math.max(0, mediaConfig.reserveTokens),
        );
        // Commit this result's cleaned text so later results this turn budget
        // against it too.
        committedNonMediaTokens += cleanedTextTokens;

        const fit = await fitModelContentToBudget(
          parts as Parameters<typeof fitModelContentToBudget>[0],
          remaining,
          mediaConfig,
          controller.signal,
          // Seed = the retained BRANCH media bytes (prior turns) + this turn's already-
          // kept media bytes, so the whole-request ceiling bounds the CUMULATIVE media
          // in the provider request — not just this turn's (a branch can accumulate
          // many small-dimension/large-byte images that never trip token compaction).
          branchMediaBytes + committedMediaBytes,
        );
        // Commit the kept media's estimated cost so later tool results this turn
        // budget against it (cumulative-overflow guard). Also accumulate the kept
        // decoded BYTES so the 12 MiB aggregate cap is enforced across the WHOLE
        // turn's media, not reset per result.
        committedMediaTokens += fit.keptTokens;
        committedMediaBytes += fit.keptMediaBytes;
        if (!fit.changed) return result;

        // Surface a ⚠️ UI note. A DROP is the fail-safe the user asked to be loud
        // about; a pure downscale is informational. Use fit.note VERBATIM — it now
        // carries the accurate reason + remedy (context-window→/compact for budget
        // drops, resize/re-encode for fixed image/pixel limits, file vs image, etc.),
        // so don't wrap it in a hardcoded "image is too large…run /compact" that
        // misdescribes file drops or fixed-limit drops.
        if (!controller.signal.aborted) {
          const msg = fit.dropped
            ? `> ⚠️ Media from \`${toolName}\` was omitted: ${fit.note}\n\n`
            : `> ℹ️ ${fit.note} from \`${toolName}\` to fit the context window.\n\n`;
          emit({ conversationId, type: 'text-delta', text: msg });
        }

        return { ...obj, _modelContent: fit.parts };
      };

      const maybeCompactToolOutput = async (
        toolCallId: string,
        toolName: string,
        result: unknown,
        lifecycleMode: 'defer-until-stream-id' | 'direct',
        toolArgs?: unknown,
      ): Promise<{
        result: unknown;
        compaction?: {
          originalContent: string;
          wasCompacted: boolean;
          extractionDurationMs: number;
        };
      }> => {
        // ── Budget-aware media fitting ──────────────────────────────────
        // Independent of TEXT compaction (gated by `compaction.media`): a
        // plugin tool may attach `_modelContent` images that would push this
        // turn over the model's REMAINING context window. Downscale/recompress
        // them toward the configured floor, or fail safe (drop + note to the
        // model + a ⚠️ UI note suggesting /compact). Runs first so the rest of
        // this function operates on the fitted result. Pass toolCallId+args so the
        // budget also charges this call's tool-call arguments (same-turn).
        // SKIP for observer-launched tools (`lifecycleMode === 'direct'`): their
        // result is only broadcast to the UI — the MAIN model receives a bounded
        // summary via the parent tool's observer augmentation, so fitting here would
        // needlessly drop/downscale a UI attachment AND charge its full result
        // against the model-visible media budget.
        if (lifecycleMode !== 'direct') {
          result = await fitToolMediaToBudget(toolName, result, toolCallId, toolArgs);
        }

        const toolCompaction = config.compaction?.tool as ToolCompactionConfig | undefined;
        if (!compactionSupported || !toolCompaction?.enabled || controller.signal.aborted) {
          return { result };
        }
        if (toolName === 'create_artifact' || toolName === 'update_artifact') {
          return { result };
        }
        // Preserve inline diffs AND model-visible media (images/files) THROUGH
        // compaction: split them off, compact only the text/JSON rest, then
        // re-attach. Without this, `_modelContent` base64 gets serialized into
        // the string fed to the token estimator + head/tail truncator (or AI
        // summarizer), which corrupts the base64 or drops the attachment
        // entirely — defeating the plugin-attachment feature.
        const { resultForCompaction, reattach } = splitPreservedFields(result);

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
            controller.signal, // Stop cancels a hung tool-compaction extraction
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

      const activeCustomTools = effectiveRunTools;
      let observerWorkspaceToolsPromise: Promise<ToolDefinition[]> | undefined;
      const getObserverWorkspaceTools = (): Promise<ToolDefinition[]> => {
        observerWorkspaceToolsPromise ??= createWorkspaceToolDefinitions(effectiveCwd, () => config, {
          executionMode: effectiveExecutionMode,
          conversationId,
        });
        return observerWorkspaceToolsPromise;
      };

      // Set true once any tool call/result or text delta is seen this turn — gates
      // the reactive context-overflow auto-retry (safe only before anything ran).
      // Declared here (before the observer-launch fn) so an observer-launched tool,
      // which emits OUTSIDE the main stream loop, can also flip it.
      let sawToolOrTextThisTurn = false;
      // Distinct from the above: TRUE once a TOOL actually EXECUTED this turn (a committed
      // side effect), NOT merely text streamed. A model-fallback discards the primary's
      // partial TEXT (not in the new context) so sawToolOrTextThisTurn can reset for a
      // text-only primary — but a tool's SIDE EFFECT already happened, so if one executed we
      // must NOT reset (else overflow compact-and-retry on the fallback could replay the
      // mutation). Set at the SAME tool sites, never on text-delta.
      let executedToolThisTurn = false;
      // True once the in-place overflow retry has been used for this turn — caps
      // it at a single attempt (the model-stream is re-run in the overflowAttempt
      // loop below; this replaces the old cross-invocation overflowRetry guard).
      let overflowRecoveryUsed = false;
      // The model entry currently serving the turn — starts as the primary and is
      // repointed on each model-fallback. Overflow recovery compacts with THIS
      // model's config (tokenizer/window/credentials), so a summary produced after
      // a fallback fits the fallback's (possibly smaller) window and doesn't repeat
      // the primary's auth/provider failure.
      let activeModelEntryForRecovery = modelEntry;

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

        // Workspace tools deliberately live outside `registeredTools` because
        // Mastra builds a guarded workspace per main-agent run. Build the
        // observer adapter lazily from this run's cwd/config/conversation so it
        // gets the same guards and diff tracking without slowing turns where
        // the observer launches only a custom tool (or nothing at all).
        let tool = findToolByName(activeCustomTools, toolName);
        if (!tool && runtime.id === 'mastra') {
          try {
            const workspaceTools = await getObserverWorkspaceTools();
            tool = findToolByName(observerToolsForExecutionMode([], workspaceTools, effectiveExecutionMode), toolName);
          } catch (error) {
            return {
              ok: false,
              details: `Workspace tool initialization failed: ${
                error instanceof Error ? error.message : String(error)
              }`,
            };
          }
        }
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
        // Validate AFTER PreToolUse because a hook may replace the payload. Use
        // the parsed (possibly transformed/defaulted) value for observer state,
        // UI events, PostToolUse, compaction accounting, and execution.
        let effectiveArgs: unknown;
        try {
          effectiveArgs = validateToolInput(tool, preTool.args);
        } catch (error) {
          toolCancels.delete(toolCallId);
          return { ok: false, details: error instanceof Error ? error.message : String(error) };
        }
        const exposedEffectiveArgs = redactBrowserToolArgsForExposure(toolName, effectiveArgs);

        observer.onToolExecutionStart({
          toolCallId,
          toolName,
          args: exposedEffectiveArgs,
          observerInitiated: true,
        });

        emit({
          conversationId,
          type: 'tool-call',
          toolCallId,
          toolName,
          args: exposedEffectiveArgs,
          startedAt,
          observerInitiated: true,
        });

        const runObserverToolExecution = async (): Promise<void> => {
          try {
            const context: ToolExecutionContext = {
              toolCallId,
              conversationId,
              browserOwnerId: streamToken,
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
              args: exposedEffectiveArgs,
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
            const compacted = await maybeCompactToolOutput(
              toolCallId,
              toolName,
              observerAugmented,
              'direct',
              exposedEffectiveArgs,
            );
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
            let errorResult: unknown = observerToolErrorForExposure(toolName, error);
            // PostToolUse on the error path too, so a DLP hook can sanitize
            // error payloads from observer-launched tools.
            const postTool = await hookDispatcher.dispatch('PostToolUse', {
              conversationId,
              toolCallId,
              toolName,
              args: exposedEffectiveArgs,
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
            const compacted = await maybeCompactToolOutput(
              toolCallId,
              toolName,
              observerAugmented,
              'direct',
              exposedEffectiveArgs,
            );
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

        // An observer tool executed this turn (it emits outside the main stream
        // loop) → mark the turn as having side effects so overflow recovery won't
        // auto-retry and replay it.
        sawToolOrTextThisTurn = true;
        executedToolThisTurn = true;
        return { ok: true, launchedToolCallId: toolCallId, details: 'Observer-launched tool started.' };
      };

      // Set by computeOverflowCompaction: true when the LAST call returned null
      // because recovery was SKIPPED (unsafe to auto-replay), false when it actually
      // attempted compaction. Drives whether the terminal guidance still offers
      // `/compact`.
      let recoveryGatedOffLast = false;
      // A compaction record emitted THIS turn (pre-stream compaction) that the
      // renderer persists asynchronously — so a same-turn reactive recovery can
      // resolve its synthetic summary id before it lands on disk.
      let pendingCompactionThisTurn: {
        compactionId: string;
        compactedMessageIds: string[];
        // Baseline covered-id → sig captured when THIS record was produced. When a later
        // reactive recovery recompacts a branch that begins with this record's synthetic
        // summary, it expands into these underlying ids — which aren't in the recovery's
        // OWN baseline. Carrying this baseline lets the composition re-verify those
        // expanded ids against fresh disk, so a concurrent edit to one of them (which
        // would have made THIS record's own persist stale) can't be silently trusted.
        coveredContentSig?: Record<string, string>;
      } | null = null;
      // Synthetic `compaction-summary-*` ids WE injected into `messages` THIS turn (via a
      // stored-summary reuse or a proactive pre-stream compaction). Expansion/composition
      // must consult THIS set — NOT the id NAME prefix — to decide a leading id is an
      // expandable synthetic summary: an imported/plugin branch can legitimately contain a
      // real message literally id'd `compaction-summary-*`, and inferring provenance from
      // the name would wrongly expand it and over-claim coverage of later real messages.
      const syntheticSummaryIdsThisTurn = new Set<string>();
      // Per-message DISK content signature (id → "role:JSON") for the whole branch,
      // read from disk. Snapshotted BEFORE reactive recovery starts summarizing (a
      // concurrent conversations:put during the awaited summarizer call must NOT become
      // the baseline). At persist we re-read disk for the COVERED ids and reject if any
      // changed — a stale summary of pre-edit content would otherwise hide the edit.
      // Keyed by compactionId (set when recovery produces a result) → the id→sig map
      // captured before that recovery ran. Raw disk on both ends → synthetic
      // compaction-summary-* ids (not on disk) and hook redactions (in-memory only)
      // are consistently absent, so no false-negative.
      const diskSigMap = (): Map<string, string> => {
        const m = new Map<string, string>();
        try {
          const dc = readConversation(appHome, conversationId);
          if (!dc) return m;
          const { tree, headId } = ensureConversationTree(dc);
          for (const n of getConversationBranch(tree, headId) as Array<{ id?: unknown }>) {
            if (typeof n?.id !== 'string') continue;
            try {
              // Shared canonical signature (role + content + tool_calls + tool_call_id)
              // so the reactive self-check and the emitted coveredContentSig both match
              // what stream-persistence recomputes from disk before persisting.
              m.set(n.id, messageContentSignature(n as Parameters<typeof messageContentSignature>[0]));
            } catch {
              m.set(n.id, 'unserializable');
            }
          }
        } catch {
          /* disk read failed — empty map; the strict-prefix check still guards ids */
        }
        return m;
      };
      const recoveryPreDiskSig = new Map<string, Map<string, string>>();

      /**
       * Reactive context-overflow recovery — the COMPACTION step only. The
       * provider rejected the request as over the context window (a normally
       * non-transient hard-fail). This computes a compacted branch to retry with;
       * the caller re-runs the model stream IN-PLACE with it (see the
       * `overflowAttempt` loop around `runtime.stream`), so hooks (pre-send /
       * UserPromptSubmit), the AgentStop lifecycle dispatch, mid-turn inject
       * draining, and warning emissions all stay OUTSIDE the retry — re-invoking
       * the whole streamHandler would fire them twice.
       *
       * Returns the compacted messages to retry with, or null when recovery
       * doesn't apply / can't help (already retried, something already ran this
       * turn, unsupported/disabled, not an overflow, cancelled, superseded, or the
       * prefix wouldn't compact). Never re-invokes anything and has no side
       * effects except the summarizer LLM call.
       *
       * Gated on `!sawToolOrTextThisTurn`: only a pure over-context FIRST model
       * call is safe to retry — once a tool ran or text streamed, re-running the
       * model step would duplicate/replay it.
       */
      const computeOverflowCompaction = async (
        isOverflow: boolean,
      ): Promise<Awaited<ReturnType<typeof compactConversationPrefix>> | null> => {
        // Distinguish "recovery SKIPPED (unsafe to auto-replay: a tool/text/inject
        // already happened, or unsupported/disabled)" from "recovery ATTEMPTED but
        // produced nothing (protected tail too big / no prefix)". Only the latter
        // means `/compact` would also be a no-op; a skip leaves `/compact` viable
        // next turn. Set true on a skip so the terminal guidance stays accurate.
        recoveryGatedOffLast =
          controller.signal.aborted ||
          sawToolOrTextThisTurn ||
          overflowRecoveryUsed ||
          conversationsWithConsumedInject.has(conversationId) ||
          !compactionSupported ||
          !config.compaction?.conversation?.enabled ||
          !modelEntry ||
          // Memory backstop: too many prior recovery hook awaits are ABANDONED-but-pending (hung
          // trusted-plugin callbacks pinning transcripts). Don't start another abandonable run —
          // surface the overflow instead; frees as the hung hooks eventually settle.
          outstandingAbandonedRecoveryHooks >= MAX_ABANDONED_RECOVERY_HOOKS ||
          !isOverflow;
        if (recoveryGatedOffLast) {
          return null;
        }
        // Compact with the CURRENTLY-active model (post-fallback) so the summary
        // fits its window/tokenizer and uses its credentials. Non-null here: the
        // gate above returned when `!modelEntry` (TS can't narrow through the var).
        const recoveryModelBase = activeModelEntryForRecovery ?? modelEntry;
        if (!recoveryModelBase) return null;
        // Apply the provider override (plugin/gateway) to the recovery model too:
        // after a model-fallback, activeModelEntryForRecovery is a RAW
        // streamConfig.fallbackModels entry pointing at the model's ORIGINAL
        // endpoint. `disableAmbientFallback` stops a further fallback but does NOT
        // re-route the endpoint — without this the summarizer would send the full
        // transcript to the fallback's original (e.g. public) provider, defeating
        // the override's data-routing guarantee (mirrors the turn path).
        let recoveryModel = recoveryModelBase;
        if (resolution.providerOverride) {
          const ov = config.models.providers[resolution.providerOverride];
          if (ov) {
            recoveryModel = {
              ...recoveryModelBase,
              modelConfig: {
                ...recoveryModelBase.modelConfig,
                provider: ov.type as typeof recoveryModelBase.modelConfig.provider,
                endpoint: ov.endpoint ?? recoveryModelBase.modelConfig.endpoint,
                apiKey: ov.apiKey ?? recoveryModelBase.modelConfig.apiKey,
                useResponsesApi: ov.useResponsesApi ?? false,
              },
            };
          }
        }
        try {
          // Summarize the IN-MEMORY (post-hook) branch, NOT a fresh disk read:
          // pre-send/DLP hooks redact content in memory only, so re-reading disk
          // would feed the summarizer un-redacted content.
          const inMemoryBranch =
            Array.isArray(messages) && messages.length > 0 ? (messages as unknown as ChatMessageForCompaction[]) : null;
          if (!inMemoryBranch) return null;
          // Drift baseline = the RAW turn-start signature (captured pre-hook at the top of
          // the handler), NOT the post-hook in-memory branch. A pre-send/DLP hook rewrites
          // `messages` in memory only; signing that would differ from the raw disk read at
          // persist and falsely reject a valid summary. turnStartBranchSig is disk-
          // equivalent and captured before any concurrent edit could land.
          const preCompactInMemorySig = turnStartBranchSig;
          // Stop AWAITING a recovery hook once the turn is cancelled. The plugin
          // pre-send hook + DLP gate run over a callback protocol we can't force-
          // cancel, so a hung trusted hook's promise stays pending — racing the await
          // against controller.signal lets this background recovery run reach its
          // `finally` (releasing transcript + turn state) instead of hanging suspended
          // after the client cancelled. Rejects on abort so the surrounding try/catch
          // fails closed (returns null → the turn surfaces the overflow).
          const raceRecoveryAbort = async <T>(p: Promise<T>): Promise<T> => {
            if (controller.signal.aborted) throw new Error('recovery-aborted');
            let onAbort: (() => void) | undefined;
            let aborted = false;
            const abortP = new Promise<never>((_, reject) => {
              onAbort = () => {
                aborted = true;
                reject(new Error('recovery-aborted'));
              };
              controller.signal.addEventListener('abort', onAbort, { once: true });
            });
            try {
              return await Promise.race([p, abortP]);
            } finally {
              if (onAbort) controller.signal.removeEventListener('abort', onAbort);
              // Deadline/cancel won → `p` (the hook) is ABANDONED but still pending, pinning its
              // transcript. Count it (decrement when it eventually settles) so repeated
              // cancel-retry cycles against hung hooks can't accumulate unboundedly.
              if (aborted) {
                outstandingAbandonedRecoveryHooks++;
                void p.then(
                  () => {
                    outstandingAbandonedRecoveryHooks = Math.max(0, outstandingAbandonedRecoveryHooks - 1);
                  },
                  () => {
                    outstandingAbandonedRecoveryHooks = Math.max(0, outstandingAbandonedRecoveryHooks - 1);
                  },
                );
              }
            }
          };
          // Gate the branch through the UserPromptSubmit DLP hooks with the
          // 'compaction' purpose — same enforcement the on-demand /compact path
          // applies before sending a transcript to the summarizer. A hook may
          // block/redact specifically for compaction; skipping it here would be a
          // reactive-recovery-only DLP bypass. Fail closed: a denying hook aborts
          // recovery (the turn then surfaces the overflow error instead).
          let gatedBranch: ChatMessageForCompaction[] = inMemoryBranch;
          let recoveryCompactionPrompt = COMPACTION_SYSTEM_PROMPT;
          // Run plugin pre-send (`messages:hook`) middleware FIRST with the COMPACTION
          // prompt, then the UserPromptSubmit DLP gate LAST — the SAME order /compact
          // and a normal turn use. The earlier turn invocation ran these hooks with the
          // CHAT prompt; a plugin that enforces compaction-specific policy (or rewrites
          // the summarizer prompt) must see COMPACTION_SYSTEM_PROMPT here, or reactive
          // recovery would be a plugin-middleware bypass unlike the /compact path.
          // Fail closed: an aborting plugin cancels recovery (the turn then surfaces the
          // overflow error). A plugin rewrite of the summarizer prompt is honored below.
          if (pluginManager?.hasPreSendHooks()) {
            try {
              const hookResult = await raceRecoveryAbort(
                pluginManager.runPreSendHooks({
                  messages: gatedBranch as unknown as HookMessage[],
                  modelKey: recoveryModel.key,
                  config: configWithExecutionMode,
                  systemPrompt: recoveryCompactionPrompt,
                }),
              );
              if (hookResult.abort) return null;
              if (Array.isArray(hookResult.messages)) {
                gatedBranch = hookResult.messages as unknown as ChatMessageForCompaction[];
              }
              if (typeof hookResult.systemPrompt === 'string') recoveryCompactionPrompt = hookResult.systemPrompt;
            } catch {
              return null; // hook error → fail closed (surface the overflow instead)
            }
          }
          if (hookDispatcher.hasEnforcingHooksFor('UserPromptSubmit')) {
            try {
              const gated = await raceRecoveryAbort(
                gateMessagesThroughUserPromptSubmit(
                  gatedBranch as unknown[],
                  config,
                  conversationId,
                  recoveryModel.key,
                  'compaction',
                  recoveryCompactionPrompt,
                ),
              );
              if (gated.suppressed) return null;
              gatedBranch = gated.messages as unknown as ChatMessageForCompaction[];
              // Honor a hook rewrite of the COMPACTION prompt (parity with /compact).
              if (typeof gated.systemPrompt === 'string') recoveryCompactionPrompt = gated.systemPrompt;
            } catch {
              return null; // fail closed
            }
          }
          // The compaction budget is `window - outputMaxTokens - promptReserveTokens`.
          // But the STATIC per-request input (assembled system prompt + tool schemas)
          // can exceed promptReserveTokens — a large AGENTS.md / many MCP schemas —
          // in which case a compacted branch that "fits" the raw window would STILL
          // overflow once the static input is added, wasting the summary + the sole
          // retry. Reduce the effective window by the amount static input exceeds the
          // reserve so the summary is sized to actually fit. Best-effort (a resolve
          // failure just leaves the raw window, matching prior behavior).
          const recoveryConvConfig = config.compaction.conversation as typeof config.compaction.conversation & {
            contextWindowTokens?: number;
          };
          // Prefer the config override, then the catalog maxInputTokens, then the
          // window INFERRED from the model name (resolveConversationTokenization) —
          // an imported model may omit maxInputTokens yet still have a known window.
          // Leaving baseWindow undefined here would SKIP static-input budgeting, so a
          // summary sized to the raw window overflows once system + tool-schema tokens
          // are added on the retry — and recovery is single-use, so the turn then fails.
          let baseWindow: number | undefined =
            recoveryConvConfig.contextWindowTokens ?? recoveryModel.modelConfig.maxInputTokens;
          if (typeof baseWindow !== 'number' || baseWindow <= 0) {
            try {
              baseWindow =
                resolveConversationTokenization(recoveryModel.modelConfig.modelName).contextWindowTokens ?? undefined;
            } catch {
              /* leave undefined — no window to budget against */
            }
          }
          let recoveryConfig = config.compaction.conversation as Parameters<typeof compactConversationPrefix>[2];
          let recoveryExternalOverReserve = 0;
          if (typeof baseWindow === 'number' && baseWindow > 0) {
            let staticTokens = 0;
            try {
              // Budget the FULLY-BUILT instructions the retry sends (buildAgentInstructions
              // = resolved prompt + runtime-capability/plan-mode suffix), not the bare
              // prompt — else the sole recovery retry re-overflows and hard-fails. Parity
              // with getStaticInputTokens; seed systemPrompts so resolveModeSystemPrompt
              // yields effectiveSystemPrompt (override-respecting) regardless of mode.
              const recoveryInstructions = buildAgentInstructions(
                {
                  ...config,
                  systemPrompt: effectiveSystemPrompt ?? '',
                  // chat only (see getStaticInputTokens) — plan-first sends the REAL plan prompt.
                  systemPrompts: {
                    ...config.systemPrompts,
                    chat: effectiveSystemPrompt ?? '',
                  },
                },
                effectiveExecutionMode,
              );
              staticTokens = await estimateStaticRequestTokens(
                recoveryInstructions,
                effectiveCwd ?? undefined,
                activeCustomTools,
                WORKSPACE_TOOL_SCHEMA_TOKENS_ALLOWANCE,
                recoveryModel.modelConfig.modelName,
              );
            } catch {
              /* best-effort — leave the raw window */
            }
            const staticOverReserve = Math.max(0, staticTokens - Math.max(0, recoveryConvConfig.promptReserveTokens));
            // Pin the RAW window and hand the next-turn static excess to
            // compactConversationPrefix as externalPromptOverReserve — it reduces by
            // max(this, summarizer-prompt-excess), not the sum (separate requests;
            // double-subtracting would wrongly reject a valid recovery summary).
            recoveryExternalOverReserve = staticOverReserve;
            recoveryConfig = { ...recoveryConvConfig, contextWindowTokens: baseWindow };
          }
          const overflowResult = await compactConversationPrefix(
            gatedBranch as Parameters<typeof compactConversationPrefix>[0],
            recoveryModel.modelConfig,
            recoveryConfig,
            controller.signal,
            // A provider override routes this turn through a plugin/gateway; the
            // recovery model's config already carries the overridden endpoint, so
            // the summarizer must NOT fall back to the ambient chain (which would
            // send the transcript to the model's original provider).
            {
              disableAmbientFallback: !!resolution.providerOverride,
              externalPromptOverReserve: recoveryExternalOverReserve,
              protectNewestUser: true, // live recovery: never summarize away the current user turn
              ...(recoveryCompactionPrompt !== COMPACTION_SYSTEM_PROMPT
                ? { systemPromptOverride: recoveryCompactionPrompt }
                : {}),
            },
          );

          // Only proceed if THIS run still owns the conversation — a superseding
          // run (new user turn / stop-resend) would have taken the active-stream
          // token, and we must not retry over it.
          const stillOwns = activeStreams.get(conversationId)?.token === streamToken;
          if (
            !stillOwns ||
            controller.signal.aborted ||
            !overflowResult?.compactedMessages ||
            overflowResult.compactedMessages.length === 0
          ) {
            return null;
          }
          // Store the baseline signature (of the branch we summarized, captured at
          // recovery start) keyed by this summary's id — the persist step compares the
          // covered ids against a fresh disk read to detect a concurrent edit that
          // happened at ANY point since the turn's input branch was established
          // (including before AND during the awaited summarizer call).
          if (overflowResult.compactionId && overflowResult.compactedMessageIds.length > 0) {
            recoveryPreDiskSig.set(overflowResult.compactionId, preCompactInMemorySig);
          }
          return overflowResult;
        } catch (recoveryErr) {
          ipcDebugLog(
            `[LOOP-ERROR] conv=${conversationId} overflow-recovery-failed=${recoveryErr instanceof Error ? recoveryErr.message : String(recoveryErr)}`,
          );
          return null;
        }
      };

      // Build the terminal message for an unrecovered context-overflow. Only
      // suggest `/compact` when it would actually help: the runtime supports
      // Kai-side history compaction AND conversation compaction is enabled AND
      // recovery hasn't ALREADY proven there's nothing compactable (a protected tail
      // too large / no compactable prefix — `/compact` runs the same prefix
      // compaction and would return nothing-to-compact). For external CLI runtimes,
      // a disabled config, or an exhausted-recovery case, give generic guidance.
      const overflowGuidance = (recoveryExhausted = false): string =>
        compactionSupported && config.compaction?.conversation?.enabled && !recoveryExhausted
          ? "\n\nThis conversation is too large for the model's context window. Run /compact to summarize older messages, then retry."
          : "\n\nThis request is too large for the model's context window. Start a new chat, remove large/older messages or attachments, or switch to a model with a larger context window, then retry.";

      // Response ids this run streamed (event.responseMessageId). The terminal-drain
      // repair uses these to recognize main's crash-backstop fallback reply — a
      // sibling assistant under the pre-inject head, written by THIS run when the
      // renderer crashed before persisting — and DISTINGUISH it from a user-selected
      // historical sibling variant (whose id this run never produced).
      // The response id of this run's CURRENT (latest) reply variant — updated on
      // each content event, so a transient model-fallback's FAILED partial variant
      // (preserved as a sibling with its OWN id) is superseded by the retry's id.
      // The terminal-drain repair uses THIS (not every id the run emitted) to
      // recognize main's crash-backstop fallback reply — the accumulator finalizes
      // under the latest id — and distinguish it from both a user-selected
      // historical sibling AND a failed fallback variant the user might select.
      let latestReplyResponseId: string | null = null;
      // R122 finding-5: set true when a plan-mode transition (enter_plan_mode mid-stream,
      // or a "keep planning" reject of exit_plan_mode) aborts a SERVER-PERSISTED run. A GUI
      // renderer drives the plan-first restart for GUI turns, but a `kai`/web submit has no
      // renderer that will (the renderer path skips main-owned runs), so the finally block
      // drives a MAIN-side plan-first continuation. Declared out here so the finally sees it.
      let serverPersistPlanRestart = false;

      try {
        if (controller.signal.aborted) {
          emit({ conversationId, type: 'done' });
          return;
        }
        // Check if compaction is needed (only if runtime supports it)
        if (compactionSupported && config.compaction.conversation.enabled && modelEntry) {
          const chatMessages = messages as Array<{
            role: string;
            content: unknown;
            id?: string;
            tokenCount?: number;
            tokenCountSig?: number;
          }>;

          // The renderer sends its in-memory branch, whose locally-created nodes may
          // lack the per-message tokenCount the store backfilled on the last put
          // (RuntimeProvider doesn't round-trip the written record). Merge the
          // persisted counts by id so the compaction gate stays on the integer-only
          // fast path instead of re-serializing every message this turn.
          try {
            const persisted = readConversation(appHome, conversationId);
            const persistedTree = persisted && Array.isArray(persisted.messageTree) ? persisted.messageTree : null;
            if (persistedTree) {
              const counts = new Map<string, { tokenCount?: number; tokenCountSig?: number }>();
              for (const node of persistedTree as Array<{
                id?: unknown;
                tokenCount?: number;
                tokenCountSig?: number;
              }>) {
                if (typeof node?.id === 'string' && typeof node.tokenCount === 'number') {
                  counts.set(node.id, { tokenCount: node.tokenCount, tokenCountSig: node.tokenCountSig });
                }
              }
              for (const m of chatMessages) {
                if (typeof m.tokenCount !== 'number' && typeof m.id === 'string') {
                  const c = counts.get(m.id);
                  // Only adopt a persisted count whose signature matches THIS
                  // message's current content — so a count persisted for older
                  // content is never applied to a renderer copy the user/hook has
                  // since changed (that would under/over-count silently).
                  if (c && typeof c.tokenCountSig === 'number' && c.tokenCountSig === messageContentSig(m)) {
                    m.tokenCount = c.tokenCount;
                    m.tokenCountSig = c.tokenCountSig;
                  }
                }
              }
            }
          } catch {
            /* best-effort — the estimate fallback still keeps the gate safe */
          }

          // Reuse a previously-persisted compaction when it still applies to this
          // branch, instead of re-summarizing the same prefix every turn. The
          // stored record's compactedMessageIds must be an ordered prefix of the
          // current branch (a fork/rewind/variant/edit changes the leading ids and
          // fails this check → we recompute). Fail-safe: any mismatch or over-window
          // reuse falls through to the normal shouldCompact/recompute path; we never
          // drop a message. Substitution stays LOCAL to this turn's `messages`.
          const storedCompaction = readConversation(appHome, conversationId)?.conversationCompaction as
            | {
                compactionId?: string;
                summaryText?: string;
                compactedMessageIds?: string[];
                coveredContentSig?: Record<string, string>;
              }
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
            // Reject reuse if the stored summary now covers messages that are PROTECTED
            // under the CURRENT boundary — e.g. ignoreRecentUserMessages/AssistantMessages
            // was raised since the summary was written. `coveredCount > boundaryIndex` means
            // the summary swallowed messages that should now be in the live protected tail;
            // recompute so they're restored. (`/compact`'s no-op already checks this; the
            // agent pre-stream reuse path needs the same guard.)
            const reuseBoundary = (() => {
              try {
                return selectProtectedTail(
                  chatMessages as unknown as Parameters<typeof selectProtectedTail>[0],
                  config.compaction.conversation.ignoreRecentUserMessages,
                  config.compaction.conversation.ignoreRecentAssistantMessages,
                  true, // live reuse: newest user is protected, mirror the compaction boundary
                ).boundaryIndex;
              } catch {
                return coveredCount; // best-effort — don't block reuse on a boundary calc failure
              }
            })();
            // Covered-CONTENT check: a supported direct writer (a trusted plugin's
            // conversations.upsert → writeConversation) can edit a covered message under
            // the SAME id WITHOUT clearing conversationCompaction, so the id-prefix check
            // alone would substitute a summary of the OLD content and hide the edit. If the
            // stored record carries coveredContentSig, require every covered id's CURRENT
            // content to still match it; else don't reuse (recompute over current content).
            const coveredContentUnchanged = (() => {
              const sig = storedCompaction.coveredContentSig;
              // An UNSIGNED record (pre-upgrade, or a direct writer that preserved the record
              // without a baseline) can't be verified against current content — a same-id
              // content rewrite would be undetectable, so reusing its summary could hide the
              // edit. Don't trust it: recompute over current content (a one-time cost after
              // upgrade). Likewise a partially-signed record with an unsigned covered id.
              if (!sig) return false;
              const byId = new Map(
                (chatMessages as Array<{ id?: unknown }>).map((m) => [typeof m?.id === 'string' ? m.id : '', m]),
              );
              return (storedCompaction.compactedMessageIds ?? []).every((id) => {
                const expected = sig[id];
                if (expected === undefined) return false; // unsigned covered id — can't verify → recompute
                const node = byId.get(id);
                if (!node) return false; // covered id vanished → stale
                return messageContentSignature(node as Parameters<typeof messageContentSignature>[0]) === expected;
              });
            })();
            if (
              coveredAllIded &&
              coveredCount <= reuseBoundary &&
              coveredContentUnchanged &&
              isStrictPrefix(storedCompaction.compactedMessageIds, coveredBranchIds as string[])
            ) {
              const summaryMsg = {
                id: `compaction-summary-${storedCompaction.compactionId}`,
                role: 'assistant' as const,
                content: storedCompaction.summaryText,
              };
              const candidate = [summaryMsg, ...chatMessages.slice(coveredCount)];
              // Only adopt the reuse if the candidate still fits under the trigger;
              // if the branch has grown enough to need a NEW compaction, fall through
              // to recompute (which will overwrite the record + emit a new event).
              // Strip media base64 to its native estimate first (same projection as
              // the fit path + final compaction check) — else a retained protected-
              // tail image counts as ~hundreds of k "text" tokens and would refuse
              // this reuse, re-summarizing the same prefix every turn.
              const {
                messages: candidateForSum,
                nativeMediaTokens: candidateMediaTokens,
                branchMediaBytes: candidateMediaBytes,
              } = await splitBranchMediaForTokenSum(candidate as unknown[], controller.signal);
              const reuseCheck = await shouldCompactAsync(
                candidateForSum as Parameters<typeof shouldCompactAsync>[0],
                modelEntry.modelConfig.modelName,
                config.compaction.conversation.triggerPercent,
                modelEntry.modelConfig.maxInputTokens,
                controller.signal,
                candidateMediaTokens,
              );
              // This recount can await the off-thread tokenizer; bail if the run
              // was cancelled during it, rather than falling into a second
              // full-branch recount below.
              if (controller.signal.aborted) {
                emit({ conversationId, type: 'done' });
                return;
              }
              // Beyond the trigger: the trigger check ignores STATIC input (instructions
              // + tool schemas). On a small window with large static input a candidate
              // can sit under trigger×window yet still overflow the real request
              // (window − output − reserve − static-excess). Reuse such a candidate only
              // if it ALSO fits that hard input budget — else fall through and recompute
              // a tighter summary now, rather than let the turn overflow and pay reactive
              // recovery to summarize again. (Parity with candidateSafeForAllModels.)
              const reuseFitsHardBudget = await (async (): Promise<boolean> => {
                if (reuseCheck.contextWindowTokens <= 0) return true; // unknown window — trigger check governs
                try {
                  const staticTokens = await getStaticInputTokens();
                  const hardInputBudget =
                    reuseCheck.contextWindowTokens -
                    Math.max(0, config.compaction.conversation.outputMaxTokens) -
                    Math.max(0, config.compaction.conversation.promptReserveTokens) -
                    Math.max(0, staticTokens - Math.max(0, config.compaction.conversation.promptReserveTokens));
                  return reuseCheck.usedTokens <= hardInputBudget;
                } catch {
                  return true; // best-effort — don't block reuse on an estimate failure
                }
              })();
              // Reuse also requires the candidate's RETAINED media bytes to be under the
              // whole-request ceiling. The trigger/hard-budget checks only see native
              // media TOKENS; a branch of many low-token-but-large-byte images can pass
              // both yet still exceed the 20 MiB request ceiling. Reusing it would skip
              // the fresh compaction's prefix-removable-media decision (which could drop
              // now-aged prefix media) and hit the fail-closed outgoing gate instead. So
              // an over-ceiling candidate must fall through to the fresh decision.
              const reuseMediaBytesUnderCeiling = candidateMediaBytes <= DEFAULT_MAX_TOTAL_MEDIA_BYTES;
              if (!reuseCheck.shouldCompact && reuseFitsHardBudget && reuseMediaBytesUnderCeiling) {
                // The stored summary is HISTORICAL content generated on a prior turn. A
                // plugin's redaction policy OR a UserPromptSubmit (DLP) hook may have
                // changed since it was written — so re-gate it through BOTH, in the SAME
                // order a real send / reactive recovery uses (plugin pre-send FIRST, then
                // DLP). If EITHER suppresses OR modifies the summary, DON'T reuse (fall
                // through to recompute over the current, re-gated branch) — else the stale
                // unredacted summary would be sent while the raw history is redacted.
                let summarySafeToReuse = true;
                if (pluginManager?.hasPreSendHooks()) {
                  try {
                    const hookResult = await pluginManager.runPreSendHooks({
                      messages: [summaryMsg] as unknown as HookMessage[],
                      modelKey: modelEntry.key,
                      config: configWithExecutionMode,
                      systemPrompt: effectiveSystemPrompt ?? '',
                    });
                    const hookMsg = (hookResult.messages as Array<{ content?: unknown }> | undefined)?.[0];
                    if (hookResult.abort || !hookMsg || hookMsg.content !== storedCompaction.summaryText) {
                      summarySafeToReuse = false;
                    }
                  } catch {
                    summarySafeToReuse = false; // fail closed → recompute
                  }
                }
                if (summarySafeToReuse && hookDispatcher.hasEnforcingHooksFor('UserPromptSubmit')) {
                  try {
                    const gated = await gateMessagesThroughUserPromptSubmit(
                      [summaryMsg],
                      config,
                      conversationId,
                      modelEntry.key,
                      'compaction',
                      effectiveSystemPrompt ?? '',
                    );
                    const gatedMsg = (gated.messages as Array<{ content?: unknown }> | undefined)?.[0];
                    if (gated.suppressed || !gatedMsg || gatedMsg.content !== storedCompaction.summaryText) {
                      summarySafeToReuse = false;
                    }
                  } catch {
                    summarySafeToReuse = false; // fail closed → recompute
                  }
                }
                if (summarySafeToReuse) {
                  messages = candidate as typeof messages;
                  reusedCompaction = true;
                  syntheticSummaryIdsThisTurn.add(summaryMsg.id); // WE injected this synthetic summary
                }
              }
            }
          }

          const check = reusedCompaction
            ? { shouldCompact: false, usedTokens: 0, contextWindowTokens: 0 }
            : await (async () => {
                // Same media-aware projection as the reuse check + fit path: charge
                // retained media its native estimate, not its base64 text length.
                const {
                  messages: branchForCheck,
                  nativeMediaTokens: checkMediaTokens,
                  branchMediaBytes,
                } = await splitBranchMediaForTokenSum(chatMessages as unknown[], controller.signal);
                const gate = await shouldCompactAsync(
                  branchForCheck as Parameters<typeof shouldCompactAsync>[0],
                  modelEntry.modelConfig.modelName,
                  config.compaction.conversation.triggerPercent,
                  modelEntry.modelConfig.maxInputTokens,
                  controller.signal,
                  checkMediaTokens,
                );
                // ALSO compact if the branch's sanitizer-RETAINED media BYTES exceed the
                // whole-request media ceiling: many small-DIMENSION images (cheap in
                // tokens, so the token gate misses them) can still push the FIRST request
                // over the provider's payload limit. BUT compaction only removes the
                // PREFIX — so force it only when removing the prefix media would actually
                // bring the total under the ceiling. If the over-cap media is all in the
                // PROTECTED recent tail, a paid summarizer call can't help (the outgoing
                // media gate / fail-closed error handles that), so don't waste it.
                if (branchMediaBytes > DEFAULT_MAX_TOTAL_MEDIA_BYTES) {
                  let prefixMediaBytes = 0;
                  try {
                    const { boundaryIndex } = selectProtectedTail(
                      chatMessages as unknown as Parameters<typeof selectProtectedTail>[0],
                      config.compaction.conversation.ignoreRecentUserMessages,
                      config.compaction.conversation.ignoreRecentAssistantMessages,
                      true, // match the actual live compaction boundary (protects newest user)
                    );
                    const prefix = (chatMessages as unknown[]).slice(0, boundaryIndex);
                    prefixMediaBytes = (await stripBranchMediaForCount(prefix, controller.signal)).retainedMediaBytes;
                  } catch {
                    /* best-effort — treat as removable (fall through to force) */
                    prefixMediaBytes = branchMediaBytes;
                  }
                  if (branchMediaBytes - prefixMediaBytes <= DEFAULT_MAX_TOTAL_MEDIA_BYTES) {
                    return { ...gate, shouldCompact: true };
                  }
                }
                return gate;
              })();

          // The exact-recount gate can await the off-thread tokenizer; the run may
          // have been cancelled or superseded during that await. Bail before doing
          // any further work (notably before compactConversationPrefix, which would
          // issue a summarizer LLM request) so a cancelled run doesn't proceed.
          if (controller.signal.aborted) {
            emit({ conversationId, type: 'done' });
            return;
          }

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

            // Gate the branch through the SAME compaction-purpose hook sequence reactive
            // recovery + /compact use, BEFORE summarizing — plugin pre-send FIRST, then the
            // UserPromptSubmit DLP gate, both with the COMPACTION prompt. Otherwise this
            // proactive path is a middleware bypass: a hook that permits chat but blocks/
            // redacts `purpose:'compaction'` would still have the raw transcript sent to
            // the summarizer. A suppression/abort fails closed (skip proactive compaction;
            // the turn proceeds and reactive recovery backstops an overflow). A prompt
            // rewrite is honored via systemPromptOverride.
            let proactiveBranch = chatMessages as unknown[];
            let proactiveCompactionPrompt = COMPACTION_SYSTEM_PROMPT;
            let proactiveHooksOk = true;
            if (pluginManager?.hasPreSendHooks()) {
              try {
                const hookResult = await pluginManager.runPreSendHooks({
                  messages: proactiveBranch as unknown as HookMessage[],
                  modelKey: modelEntry.key,
                  config: configWithExecutionMode,
                  systemPrompt: proactiveCompactionPrompt,
                });
                if (hookResult.abort) proactiveHooksOk = false;
                else {
                  if (Array.isArray(hookResult.messages)) proactiveBranch = hookResult.messages as unknown[];
                  if (typeof hookResult.systemPrompt === 'string') proactiveCompactionPrompt = hookResult.systemPrompt;
                }
              } catch {
                proactiveHooksOk = false;
              }
            }
            if (proactiveHooksOk && hookDispatcher.hasEnforcingHooksFor('UserPromptSubmit')) {
              try {
                const gated = await gateMessagesThroughUserPromptSubmit(
                  proactiveBranch,
                  config,
                  conversationId,
                  modelEntry.key,
                  'compaction',
                  proactiveCompactionPrompt,
                );
                if (gated.suppressed) proactiveHooksOk = false;
                else {
                  proactiveBranch = gated.messages as unknown[];
                  if (typeof gated.systemPrompt === 'string') proactiveCompactionPrompt = gated.systemPrompt;
                }
              } catch {
                proactiveHooksOk = false;
              }
            }
            if (controller.signal.aborted) {
              emit({ conversationId, type: 'done' });
              return;
            }
            const compactionResult = proactiveHooksOk
              ? await compactConversationPrefix(
                  proactiveBranch as Parameters<typeof compactConversationPrefix>[0],
                  modelEntry.modelConfig,
                  config.compaction.conversation,
                  controller.signal,
                  // A provider override routes this turn through a plugin/gateway; the
                  // summarizer must NOT fall back to the ambient chain (which would send
                  // the prefix to the model's original provider). Parity with reactive
                  // recovery + /compact.
                  {
                    disableAmbientFallback: !!resolution.providerOverride,
                    // Hand the NEXT-turn static excess (instructions + tool schemas beyond
                    // the reserve) to compactConversationPrefix so the summary leaves room
                    // for it — otherwise on a small window with large static input the
                    // summary "fits" the raw window yet the real request overflows, forcing
                    // reactive recovery to summarize AGAIN (a second paid call). Parity with
                    // /compact + recovery, which already pass this.
                    externalPromptOverReserve: Math.max(
                      0,
                      (await getStaticInputTokens()) - Math.max(0, config.compaction.conversation.promptReserveTokens),
                    ),
                    // Honor a hook rewrite of the COMPACTION prompt (parity with recovery/compact).
                    protectNewestUser: true, // live proactive: never summarize away the current user turn
                    ...(proactiveCompactionPrompt !== COMPACTION_SYSTEM_PROMPT
                      ? { systemPromptOverride: proactiveCompactionPrompt }
                      : {}),
                  },
                )
              : { compactedMessages: null, summaryText: null, compactionId: null, compactedMessageIds: [] };
            if (controller.signal.aborted) {
              emit({ conversationId, type: 'done' });
              return;
            }

            if (compactionResult.compactedMessages) {
              // Sign the covered ids' PRE-compaction content so the server-side
              // persister (stream-persistence) can detect a same-id content edit that
              // slipped in while the (awaited) summarizer ran — the id-prefix alone
              // wouldn't catch it. Built from `messages` before it's reassigned below.
              // Covered-id baseline for the persister/reuse drift check: use the RAW
              // turn-start signatures (disk-equivalent), NOT the post-hook `messages` —
              // an in-memory-only hook redaction would otherwise never match the raw disk
              // read at persist and falsely reject the record.
              const preSigById = (() => {
                const sig: Record<string, string> = {};
                for (const id of compactionResult.compactedMessageIds) {
                  const s = turnStartBranchSig.get(id);
                  if (s !== undefined) sig[id] = s;
                }
                return sig;
              })();
              // Emit the PERSISTED record only when it has real covered ids. A pre-send
              // hook can reconstruct messages WITHOUT ids (the public HookMessage type omits
              // `id`), so compaction may return compactedMessageIds:[]. Emitting an
              // empty-id record would let conversations:put pick it as "newer" then null it
              // on strict-prefix validation — dropping a prior REUSABLE record. Still apply
              // the compacted branch to THIS turn's in-memory messages (below) regardless.
              if (compactionResult.compactionId && compactionResult.compactedMessageIds.length > 0) {
                emit({
                  conversationId,
                  type: 'compaction',
                  data: {
                    compactionId: compactionResult.compactionId,
                    summaryText: compactionResult.summaryText,
                    compactedMessageIds: compactionResult.compactedMessageIds,
                    coveredContentSig: preSigById,
                    // Stamp a main-authoritative freshness revision AT EMIT time so the
                    // renderer-persisted record carries it — the put freshness compare is then
                    // always revision-vs-revision (no "unstamped == newer" guess that a stale
                    // reconnected client's Stop could exploit to overwrite a newer record).
                    compactionRevision: nextCompactionRevision(),
                  },
                });
              }
              messages = compactionResult.compactedMessages;
              // The renderer persists this record asynchronously; a same-turn reactive
              // recovery (below) may recompose a synthetic summary id BEFORE it lands
              // on disk. Remember it in-memory so that composition can resolve it.
              if (compactionResult.compactionId && compactionResult.compactedMessageIds.length > 0) {
                pendingCompactionThisTurn = {
                  compactionId: compactionResult.compactionId,
                  compactedMessageIds: compactionResult.compactedMessageIds,
                  coveredContentSig: preSigById,
                };
                // Mark the synthetic summary id we just injected into `messages` so a later
                // recovery expands it by PROVENANCE, not by id-name inference.
                syntheticSummaryIdsThisTurn.add(`compaction-summary-${compactionResult.compactionId}`);
              }
            }
          }
        }

        // FAIL-CLOSED media byte gate: after any pre-stream compaction/reuse, the
        // OUTGOING branch can still exceed the whole-request media ceiling when the
        // over-cap media sits in the PROTECTED recent tail (compaction only summarizes
        // the prefix) or compaction produced nothing. Sending it raw would be rejected
        // by the provider (and waste memory/network). Detect it here and surface a
        // clear, actionable error instead of a raw provider failure. (Media in the tail
        // can't be compacted away; the user must remove/​shrink a recent attachment.)
        if (modelEntry && (config.compaction?.media as MediaFitConfig | undefined)?.enabled) {
          try {
            const { branchMediaBytes: outgoingMediaBytes } = await splitBranchMediaForTokenSum(
              messages as unknown[],
              controller.signal,
            );
            if (!controller.signal.aborted && outgoingMediaBytes > DEFAULT_MAX_TOTAL_MEDIA_BYTES) {
              const mb = (DEFAULT_MAX_TOTAL_MEDIA_BYTES / (1024 * 1024)).toFixed(0);
              emit({
                conversationId,
                type: 'error',
                error: `This request carries more than ${mb} MB of attached media, which exceeds what can be sent in one request. Remove or shrink recent image/file attachments and retry.`,
                errorCategory: 'client-error',
              });
              // Only a serverPersisted (CLI/automation) turn needs a trailing `done` (its
              // renderer error handler keeps the accumulator + relies on `done` for cleanup).
              // For a GUI turn the `error` is fully terminal; a following `done` would
              // recreate the accumulator from stale React state and supersede the error
              // write — the media error would flash then vanish from UI and disk (round-76).
              if (serverPersistedRun) {
                emit({ conversationId, type: 'done' });
              }
              return;
            }
          } catch {
            /* best-effort — a probe failure falls through to the normal request */
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
        // Set true when context-overflow recovery took over from an `error` event:
        // suppress that error and every trailing event (incl. the generator's
        // `done`) for THIS run — the queued retry owns the turn now.
        let overflowRecoveryTookOver = false;

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
            // A tool is about to execute this turn — mark the turn as having side
            // effects BEFORE PreToolUse/execution. Overflow recovery only auto-
            // retries when nothing ran (`!sawToolOrTextThisTurn`); relying solely
            // on the in-band stream `tool-call` event would race a tool that
            // executes via this path first, risking a replay of destructive side
            // effects on retry.
            sawToolOrTextThisTurn = true;
            executedToolThisTurn = true;
            // Charge this call's RAW args against the media budget IMMEDIATELY —
            // before the PreToolUse await and before any denial early-return — so a
            // slow or denied large-argument call can't stay uncounted while a
            // parallel sibling's media is fit and retained (which would overflow the
            // next step). Idempotent per id; a later modify only changes content,
            // and raw args are a conservative proxy.
            chargeToolCallArgs(state.toolCallId, state.args);
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
              hookRewrittenArgs.set(state.toolCallId, redactBrowserToolArgsForExposure(state.toolName, preTool.args));
              const denyStreamId = streamToolCallIdByExecId.get(state.toolCallId);
              if (denyStreamId) {
                hookRewrittenArgs.set(denyStreamId, redactBrowserToolArgsForExposure(state.toolName, preTool.args));
              }
              // Only rebroadcast when the stream id is known; otherwise the
              // stream `tool-call` handler will apply the stored args when it
              // fires (avoids emitting a duplicate card under the exec id).
              if (denyStreamId) {
                emit({
                  conversationId,
                  type: 'tool-call',
                  toolCallId: denyStreamId,
                  toolName: state.toolName,
                  args: redactBrowserToolArgsForExposure(state.toolName, preTool.args),
                });
              }
              return { skip: true as const, result: { isError: true, error: reason } };
            }
            const modStreamId = streamToolCallIdByExecId.get(state.toolCallId);
            if (preTool.args !== state.args) {
              // A modify hook crosses a second trust boundary: parse it through
              // the target tool's schema before touching the by-reference args.
              // This also applies schema defaults/transforms consistently with
              // observer-launched tools.
              let parsedReplacement: unknown;
              try {
                let tool = findToolByName(activeCustomTools, state.toolName);
                if (!tool && runtime.id === 'mastra') {
                  const workspaceTools = await getObserverWorkspaceTools();
                  tool = findToolByName(
                    observerToolsForExecutionMode([], workspaceTools, effectiveExecutionMode),
                    state.toolName,
                  );
                }
                if (!tool) throw new Error(`Tool "${state.toolName}" is not registered.`);
                parsedReplacement = validateToolInput(tool, preTool.args);
              } catch (error) {
                const reason =
                  error instanceof Error ? error.message : `Invalid arguments for tool "${state.toolName}".`;
                hookDeniedToolCalls.set(state.toolCallId, reason);
                hookRewrittenArgs.set(state.toolCallId, { redacted: true, reason });
                if (modStreamId) {
                  hookRewrittenArgs.set(modStreamId, { redacted: true, reason });
                  emit({
                    conversationId,
                    type: 'tool-call',
                    toolCallId: modStreamId,
                    toolName: state.toolName,
                    args: { redacted: true, reason },
                  });
                }
                return { skip: true as const, result: { isError: true, error: reason } };
              }
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
                parsedReplacement &&
                typeof parsedReplacement === 'object' &&
                !Array.isArray(parsedReplacement);
              if (canMutateInPlace) {
                const target = state.args as Record<string, unknown>;
                for (const k of Object.keys(target)) delete target[k];
                Object.assign(target, parsedReplacement as Record<string, unknown>);
                // The args were charged (pre-rewrite) at execution start; a hook that
                // ENLARGED them must re-charge the delta so the media budget accounts
                // for the bigger tool-call message sent to the next step.
                rechargeToolCallArgs(state.toolCallId, target);
              } else {
                const reason =
                  'PreToolUse modify hook returned args that cannot be applied to this tool (non-object replacement); failing closed to avoid running with unsanitized input.';
                hookDeniedToolCalls.set(state.toolCallId, reason);
                hookRewrittenArgs.set(state.toolCallId, redactBrowserToolArgsForExposure(state.toolName, preTool.args));
                const failStreamId = streamToolCallIdByExecId.get(state.toolCallId);
                if (failStreamId) {
                  hookRewrittenArgs.set(failStreamId, redactBrowserToolArgsForExposure(state.toolName, preTool.args));
                  emit({
                    conversationId,
                    type: 'tool-call',
                    toolCallId: failStreamId,
                    toolName: state.toolName,
                    args: redactBrowserToolArgsForExposure(state.toolName, preTool.args),
                  });
                }
                return { skip: true as const, result: { isError: true, error: reason } };
              }
            }
            // When enforcing hooks are active the initial stream tool-call was
            // broadcast with suppressed ({pending}) args; emit the resolved
            // args now (sanitized or allowed-unchanged). Renderer upserts by id.
            if (enforcingHooksActive) {
              const exposedResolvedArgs = redactBrowserToolArgsForExposure(state.toolName, state.args);
              // Store under exec id always; also under the stream id if paired.
              // The stream `tool-call` handler resolves either when it fires.
              hookRewrittenArgs.set(state.toolCallId, exposedResolvedArgs);
              if (modStreamId) hookRewrittenArgs.set(modStreamId, exposedResolvedArgs);
              // Only rebroadcast when the stream id is known; otherwise the
              // stream handler applies the stored args on arrival (no dup card).
              if (modStreamId) {
                emit({
                  conversationId,
                  type: 'tool-call',
                  toolCallId: modStreamId,
                  toolName: state.toolName,
                  args: exposedResolvedArgs,
                });
              }
            }

            // Observer sees post-enforcement (allowed, possibly sanitized) args.
            observer?.onToolExecutionStart(state);

            // Gate exit_plan_mode behind user approval regardless of execution mode
            if (state.toolName === 'exit_plan_mode') {
              const streamId = streamToolCallIdByExecId.get(state.toolCallId) ?? state.toolCallId;
              // Register before broadcasting so even a synchronous renderer
              // answer resolves this waiter, and so the dedicated pop-out can
              // receive a one-shot capability for the pending request.
              const approvalDecision = registerPendingApproval(
                streamId,
                controller.signal,
                'any-renderer',
                { conversationId, browserOwnerId: streamToken },
                { conversationId, toolName: state.toolName, execToolCallId: state.toolCallId },
              );
              emit({
                conversationId,
                type: 'tool-approval-required',
                toolCallId: streamId,
                runGeneration: streamToken, // R254: run-scope the pop-out registry / resolve (see mcp-manage)
                toolName: state.toolName,
                args: state.args,
              });
              observer?.onToolAwaitingApproval(state.toolCallId);
              // Abort-aware: a cancel-stream aborts controller.signal, which
              // resolves this with 'dismiss' and deletes the pending entry, so a
              // later GUI approval can't resume a cancelled run (and no leak).
              const approved = await approvalDecision;
              if (approved !== true) {
                state.cancel();
                if (approved === 'dismiss') {
                  // registerPendingApproval resolves 'dismiss' for BOTH a genuine user
                  // dismiss AND a controller abort (Stop / a superseding turn). Only a
                  // GENUINE dismiss (!aborted) actually leaves plan mode — an abort means
                  // a successor exists (or the user Stopped), and persisting 'auto' here
                  // would strip plan-first from that successor / the next turn (finding-2).
                  const genuineDismiss = !controller.signal.aborted;
                  if (genuineDismiss) {
                    // User clicked X — exit plan mode entirely and stop the stream.
                    console.info(`[Agent:stream] exit_plan_mode dismissed by user, exiting plan mode and stopping`);
                    broadcastExecutionMode('auto', conversationId);
                  }
                  planDoneSent = true;
                  emit({ conversationId, type: 'done', data: { planDismissed: true } });
                  // Mark terminal (no successor) ONLY for a GENUINE user dismiss — on an
                  // abort a successor DOES exist and a parallel ask_user's answer should
                  // still hand off to it.
                  if (genuineDismiss) {
                    markTokenTerminalAbort(streamToken);
                    // Bump the per-conversation cancel generation too: a genuine
                    // dismiss is terminal-with-no-successor exactly like a Stop, so a
                    // raced-answer tombstone recorded by a DIFFERENT (already-superseded)
                    // run for this conversation must be invalidated — otherwise a late
                    // answer to that earlier run could resurrect a tool-enabled turn
                    // after the user dismissed. markTokenTerminalAbort only covers the
                    // dismissed run's OWN token; the cancel-gen bump covers cross-run
                    // tombstones the same way Stop does (R96).
                    bumpExplicitCancelGeneration(conversationId);
                  }
                  controller.abort();
                  // SKIP the tool — returning undefined here lets mastra-agent.ts fall
                  // through to tool.execute (it only skips on `{skip:true}`), which would
                  // WRITE the plan file + persist 'auto' via applyModeChange despite the
                  // dismiss (R125 finding-1). Return an explicit skip so exit_plan_mode's
                  // execute never runs.
                  return {
                    skip: true as const,
                    result: { isError: true, error: 'User dismissed the plan. Exiting plan mode.' },
                  };
                }
                // User clicked "No, keep planning" — stay in plan-first mode.
                // Re-broadcast plan-first mode so the UI toggle stays in plan mode
                // even if a race with the tool's execute() emitted 'auto'.
                broadcastExecutionMode('plan-first', conversationId);
                // Abort the stream and signal the renderer to restart in plan-first
                // mode so the agent can continue planning with the user.
                console.info(`[Agent:stream] exit_plan_mode rejected by user, aborting to restart in plan-first mode`);
                planDoneSent = true;
                if (serverPersistedRun) {
                  // No GUI renderer will restart this run — MAIN must (finding-5). The
                  // reject means "keep planning"; re-run the branch in plan-first mode.
                  serverPersistPlanRestart = true;
                }
                emit({ conversationId, type: 'done', data: { planModeRejectRestart: true } });
                controller.abort();
                // SKIP the tool (see the dismiss branch): a plain return would let
                // exit_plan_mode's execute write the plan + persist 'auto', accepting the
                // very plan the user rejected (R125 finding-1). Return an explicit skip so
                // the tool never runs; the restart re-enters plan-first to keep planning.
                return {
                  skip: true as const,
                  result: {
                    isError: true,
                    error:
                      "User rejected the plan. Continue planning — refine the approach based on the user's feedback and call exit_plan_mode again when ready.",
                  },
                };
              }
            }

            // Gate ask_user behind user response — blocks until user submits answers
            if (state.toolName === 'ask_user') {
              const streamId = streamToolCallIdByExecId.get(state.toolCallId) ?? state.toolCallId;
              // The stash + raced-recovery key is run-scoped (R191 conversation + R249 run) so neither a
              // provider that reuses `call_1` across conversations NOR two overlapping runs in the SAME
              // conversation can cross-route an answer. The run nonce is this run's streamToken (the SAME
              // value threaded to execute as browserOwnerId, so the gate key and execute key agree). The
              // APPROVAL id stays the raw streamId (the renderer/browser-authority key); only the
              // answer/recovery routing composes.
              const answerKey = makeAnswerKey(conversationId, streamId, streamToken);
              const approvalDecision = registerPendingApproval(
                streamId,
                controller.signal,
                'any-renderer',
                { conversationId, browserOwnerId: streamToken },
                { conversationId, toolName: state.toolName, execToolCallId: state.toolCallId },
              );
              emit({
                conversationId,
                type: 'tool-approval-required',
                toolCallId: streamId,
                runGeneration: streamToken, // R254: run-scope the pop-out registry / resolve (see mcp-manage)
                toolName: state.toolName,
                args: state.args,
              });
              observer?.onToolAwaitingApproval(state.toolCallId);
              // Abort-aware (see exit_plan_mode above): cancel resolves this as
              // 'dismiss' and cleans up, instead of leaking a pending approval.
              const approved = await approvalDecision;
              const raced = pendingQuestionAnswers.get(answerKey);
              const outcome = resolveAskUserGateOutcome(approved, controller.signal.aborted);
              // ── Abort path: register the successor handoff IMMEDIATELY ──────
              // On a non-terminal abort, the answer is delivered by the NEXT
              // stream (the successor) claiming a handoff — NOT inline here. The
              // handoff must be registered BEFORE we yield anywhere: a fast
              // successor could reach its sole claim site within the ~250ms the
              // grace wait would otherwise block, and an unregistered handoff then
              // orphans the answer. Registration does NOT need the answer present
              // (it lives in the stash independently; the claim reads it at claim
              // time via the handoff↔stash rendezvous), so register + return with
              // no await. A TERMINAL abort (Stop / genuine plan dismiss) registers
              // nothing — the answer just stays in the bounded stash.
              if (outcome.skip && outcome.reason === 'abort') {
                const cancelGenAtAbort = captureCancelGeneration(conversationId);
                if (terminalAbortTokens.has(streamToken)) {
                  traceDiagnostic({
                    scope: 'agent',
                    event: 'question.answer-dropped-on-terminal-abort',
                    level: 'warn',
                    conversationId,
                    toolName: state.toolName,
                    fields: { toolCallId: state.toolCallId, streamId, reason: outcome.reason },
                  });
                  state.cancel();
                  return {
                    skip: true as const,
                    result: { isError: true, error: 'The turn was stopped before this question was answered.' },
                  };
                }
                // Non-terminal abort (supersession / plan-restart): the answer
                // stays stashed under `answerKey`; the actual successor claims it
                // (see registerRacedAnswerHandoff + the claim in streamHandler).
                registerRacedAnswerHandoff(conversationId, answerKey, cancelGenAtAbort, streamToken);
                // A successor may have ALREADY started and passed its sole claim
                // site (registerLiveRacedAnswerClaimant) before this gate — one of a
                // turn's PARALLEL ask_user calls whose slow PreToolUse hook only just
                // resolved — registered its handoff. That successor transferred the
                // EARLIER-registered handoff into its live claimant and emptied the
                // pre-successor map, so this key would sit unclaimed there: answer
                // arrival scans the live claimant, and the successor's teardown drops
                // this entry, losing the answer. Merge it into the live claimant NOW
                // (no-op if there's no live+owning claimant, honoring the same
                // successor-token binding as the claim site).
                mergePendingHandoffIntoLiveClaimant(conversationId);
                // If the handoff is bound to a successor that ALREADY ENDED
                // synchronously (B aborted A, then config-failed + ran teardown
                // BEFORE this gate registered — so B's own drop couldn't remove this
                // A→B handoff), it would linger bound to a dead token until TTL with no
                // turn able to claim it. recentlyEndedTokens tells a dead bound
                // successor from a not-yet-started one; on a dead one, recover the
                // stashed answer durably (labeled re-inject / Alert) and drop the
                // handoff (R86).
                {
                  const h = racedAnswerHandoffs.get(conversationId);
                  const bound = h?.expectedSuccessorToken;
                  if (h && bound !== undefined && bound !== streamToken && recentlyEndedTokens.has(bound)) {
                    recoverOrphanedAnswerKeys(conversationId, h.answerKeys);
                    racedAnswerHandoffs.delete(conversationId);
                  }
                }
                traceDiagnostic({
                  scope: 'agent',
                  event: 'question.answer-handoff-registered',
                  level: 'warn',
                  conversationId,
                  toolName: state.toolName,
                  fields: { toolCallId: state.toolCallId, streamId, reason: outcome.reason },
                });
                state.cancel();
                return {
                  skip: true as const,
                  result: {
                    isError: true,
                    error:
                      'The turn ended before this question was answered; if the user has answered, their response will arrive as a new message.',
                  },
                };
              }
              // ── Non-abort path (turn still live) ──────────────────────────
              // A genuine reject / non-aborted dismiss: the user did NOT answer
              // (an answer would have resolved the approval as `true` via
              // agent:answer-tool-question, taking the happy path below). Do NOT
              // grace-poll for a late answer here — that would let an answer from
              // another surface (inline / pop-out / CLI / web) arriving in the
              // next ~250ms OVERRIDE an already-settled dismiss/reject and run the
              // tool. Skip cleanly.
              if (outcome.skip) {
                state.cancel();
                return { skip: true as const, result: outcome.result };
              }
              if (raced) {
                // Happy path (approved === true): the answer is already stashed
                // under the key execute() reads. Both keys are run-scoped (R191
                // conversation + R249 run, same streamToken nonce); rekey is a no-op for equal ids.
                rekeyRacedAnswer(answerKey, makeAnswerKey(conversationId, state.toolCallId, streamToken), raced);
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
            const postArgs = redactBrowserToolArgsForExposure(
              toolName,
              hookRewrittenArgs.get(toolCallId) ?? hookRewrittenArgs.get(execIdForArgs) ?? args,
            );
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
              postArgs,
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

        // Overflow-retry loop: re-runs ONLY the model-stream portion in place
        // (with a compacted `messages`) when a context-overflow is recoverable —
        // so pre-send/UserPromptSubmit hooks, mid-turn inject draining, warning
        // emissions, and the AgentStop lifecycle dispatch (all above/around this
        // loop) do NOT re-fire. Capped at one retry via `overflowRecoveryUsed`.
        // `retryAfterOverflow` is set inside the event loop and consumed here.
        let retryAfterOverflow = false;
        // The response id passed to each stream attempt. Starts as the caller's id; an OVERFLOW
        // RETRY refreshes it to a FRESH id (undefined → mastra-agent mints one) so the retry's
        // assistant node can't collide with a FAILED SIBLING the prior attempt preserved under
        // the original id (a transient fallback preserves the partial as a sibling, then the
        // fallback can overflow before content — reusing the original id here would merge the
        // successful retry into that failed sibling, mixing failed+successful replies). This
        // mirrors how a mid-stream fallback already changes the response id per variant.
        let currentResponseMessageId = responseMessageId;
        // Whether a mid-stream model-fallback occurred on the CURRENT stream attempt.
        // If overflow recovery then retries at the primary, we emit a restoration
        // event so the renderer's model selector un-pins from the fallback.
        let fellBackThisStream = false;
        do {
          retryAfterOverflow = false;
          fellBackThisStream = false;
          // Per-stream: set when we forward a terminal `error` for a GUI turn, so the stream's
          // OWN trailing `done` (mastra-agent yields error THEN done) isn't forwarded after it
          // — a GUI error is terminal (renderer deletes the accumulator); a following `done`
          // would recreate it from stale state + supersede the error write (error vanishes).
          let sawTerminalStreamError = false;
          const stream = runtime.stream({
            conversationId,
            messages,
            responseMessageId: currentResponseMessageId,
            config: configWithExecutionMode,
            tools: activeCustomTools,
            appHome,
            cwd: effectiveCwd,
            reasoningEffort,
            abortSignal: controller.signal,
            browserOwnerId: streamToken,
            streamConfig: streamConfig ?? undefined,
            primaryModel: modelEntry,
            // Thread this turn's active profile/model so a sub_agent tool can
            // inherit the parent's profile + fallback chain (see sub-agent.ts).
            // Fall back to the global defaultProfileKey when the turn has no
            // explicit profile — the turn ran under that default, so the sub-agent
            // should inherit it rather than dropping to the single-model path.
            parentProfileKey: profileKey ?? (config as { defaultProfileKey?: string | null }).defaultProfileKey ?? null,
            parentModelKey: modelEntry?.key ?? modelKey ?? null,
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
            // Track whether this turn produced any tool side effects or streamed
            // output. The reactive context-overflow recovery only auto-retries when
            // NOTHING ran yet (a pure over-context prompt on the first model call);
            // once a tool executed or text streamed, replaying the turn could
            // duplicate side effects or lose partial output, so we surface the
            // /compact guidance instead of silently re-running.
            if (event.type === 'tool-call' || event.type === 'tool-result' || event.type === 'text-delta') {
              sawToolOrTextThisTurn = true;
              if (event.type === 'tool-call' || event.type === 'tool-result') executedToolThisTurn = true;
            }
            // Track the CURRENT reply variant's response id — the id under which
            // the accumulator will finalize. Updated from text/tool AND `error`
            // events: an error-ONLY reply (provider failed before any content) still
            // finalizes an assistant node under the error's id, and the crash-backstop
            // drain guard must recognize it. A transient model-fallback's FAILED
            // partial sets this to its id, but the retry's later content event
            // OVERWRITES it (the terminal-drain poll only runs at runStatus:'idle',
            // by which point the retry finished), so a failed variant is never the
            // value here at finalize — the guard won't mistake a user-selected failed
            // sibling for the finalized reply.
            if (
              (event.type === 'text-delta' ||
                event.type === 'tool-call' ||
                event.type === 'tool-result' ||
                event.type === 'error') &&
              typeof event.responseMessageId === 'string' &&
              event.responseMessageId
            ) {
              latestReplyResponseId = event.responseMessageId;
              // Record this run's OWN response node id (token-scoped) so a
              // concurrent mid-turn inject can tell the run's own head advancement
              // apart from a sibling-variant selection under the same pre-inject
              // user node (see injectHeadStillOnBranch).
              recordActiveRunResponseId(conversationId, streamToken, event.responseMessageId);
            }
            // After a plan-related done event has been sent and the stream aborted,
            // ignore any trailing events (especially the generator's final plain done).
            if (planDoneSent || overflowRecoveryTookOver) {
              ipcDebugLog(
                `[LOOP-SKIP] conv=${conversationId} event.type=${event.type} reason=${planDoneSent ? 'planDoneSent' : 'overflowRecovery'}`,
              );
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
              } else {
                protectUnresolvedToolCallArgs(
                  event,
                  enforcingHooksActive,
                  !providerDefinedToolNames.has(event.toolName),
                  runtime.id === 'mastra',
                );
              }
            }
            if (event.type === 'tool-result' && event.toolName === 'enter_plan_mode') {
              // Only restart into plan-first if the tool actually ENTERED plan mode. On a
              // fail-closed persist failure (R136 f-1) / a stopped-run refusal (R145) it does NOT
              // enter — restarting then would run a "planning" turn the trust-disk reconcile sees
              // as auto (mutating tools). Detect non-entry across ALL result shapes (R146 f-1):
              //  - Mastra OBJECT: { success:false } at top level
              //  - Pi STRINGIFIED object: a "success":false substring
              //  - SDK ERROR wrap: { isError:true, error:'{"success":false,...}' } — the failure
              //    is INSIDE .error (or just isError:true), matching neither of the above.
              const planResult = (event as { result?: unknown }).result;
              const planEntered = !planEnterResultFailed(planResult);
              if (!planEntered) {
                emit(event);
                // Not entering plan mode — let the turn continue normally (no abort/restart).
              } else {
                // Plan mode was entered mid-stream. Abort this stream so the renderer
                // can re-send with executionMode='plan-first' (correct system prompt + tool set).
                console.info(
                  `[Agent:stream] enter_plan_mode detected mid-stream, aborting to restart with plan-first mode`,
                );
                emit(event);
                planDoneSent = true;
                if (serverPersistedRun) {
                  // No GUI renderer will restart this server-persisted run — MAIN must
                  // (finding-5). enter_plan_mode leaves the user's original request on the
                  // branch; re-run it in plan-first so the agent produces the plan under
                  // the read-only tool set.
                  serverPersistPlanRestart = true;
                }
                emit({ conversationId, type: 'done', data: { planModeRestart: true } });
                controller.abort();
                return { conversationId };
              }
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
              // A mid-stream fallback restarts the response on the next model —
              // drop the failed partial so post-receive hooks / AssistantMessage
              // don't get the failed + successful variants concatenated (matching
              // the renderer + persistence + other collectors).
              accumulatedResponseText = '';
              // The failed partial's response id is no longer the LIVE branch: it was
              // either discarded or SEALED as an inactive sibling variant, and the
              // retry continues under a FRESH id (recorded when its events arrive).
              // Forget it from the run's active lineage so injectHeadStillOnBranch
              // won't accept a mid-turn inject onto that failed sibling if the user
              // selected it during a gate's await (R83). Token-scoped no-op if gone.
              if (latestReplyResponseId) {
                forgetActiveRunResponseId(conversationId, streamToken, latestReplyResponseId);
                latestReplyResponseId = null;
              }
              // If the failed partial was an injected CONTINUATION, it persisted under
              // `${injectedUserId}-cont` (NOT the provider id forgotten above) and the
              // renderer seals it as an inactive sibling on preserveErroredVariant.
              // Forget that continuation id too so a later gate can't accept a mid-turn
              // inject onto the sealed continuation sibling (R85). The retry re-opens a
              // fresh boundary / node, re-recorded when its events arrive.
              {
                const contEntry = activeInjectContinuationId.get(conversationId);
                if (contEntry && contEntry.token === streamToken) {
                  forgetActiveRunResponseId(conversationId, streamToken, contEntry.contId);
                  activeInjectContinuationId.delete(conversationId);
                }
              }
              // NOTE: a just-consumed cooperative inject is NOT re-queued for the
              // fallback attempt. It's already PERSISTED on the branch (the
              // consumption handler wrote it) and IS in the messages the fallback
              // re-reads from disk on a server-owned turn; re-queuing would make the
              // consumption handler persist it a SECOND time (duplicate user turn)
              // and, for a GUI turn, parent fallback state on a never-broadcast id
              // (detaching the reply on crash recovery). The benign residual — a
              // fallback model may not re-see an inject consumed by the FAILED
              // attempt within the same step — is preferable to duplicate/detached
              // persistence; the answer stays on the branch either way.
              // streamWithFallback restarts the next model from the ORIGINAL messages —
              // the failed attempt's tool args/results are NOT in the new model's
              // context. Reset the same-turn media budget accumulators so the fallback
              // doesn't downscale/omit otherwise-fitting media against phantom usage.
              committedMediaTokens = 0;
              committedMediaBytes = 0;
              committedNonMediaTokens = 0;
              committedToolCallArgIds.clear();
              // The fallback restarts from the ORIGINAL messages: the failed primary's partial
              // TEXT is discarded (not in the new model's context), so a text-only primary can
              // reset sawToolOrTextThisTurn — otherwise a content-filtered primary that emitted
              // text would leave it TRUE, gating off the overflow compact-and-retry on a
              // fallback that immediately overflows with NO retained output (safe overflow
              // wrongly hard-failed). BUT if a TOOL actually EXECUTED, its SIDE EFFECT already
              // happened — do NOT reset (a compact-and-retry could replay the mutation). Only
              // reset when no tool executed.
              if (!executedToolThisTurn) sawToolOrTextThisTurn = false;
              // Invalidate the static-input memo so it recomputes under the FALLBACK
              // model's tokenizer (a cross-provider fallback can tokenize the same
              // system prompt / schemas very differently).
              staticInputTokensMemo = -1;
              const fbData = event.data as { toModelKey?: string } | undefined;
              if (fbData?.toModelKey && streamConfig) {
                fellBackThisStream = true;
                const fallbackEntry = streamConfig.fallbackModels.find((m) => m.key === fbData.toModelKey);
                if (fallbackEntry?.modelConfig) {
                  activeSourceModel = `${fallbackEntry.modelConfig.provider}:${fallbackEntry.modelConfig.modelName}`;
                  activeModelDisplayName = fallbackEntry.displayName ?? null;
                  // Track the active model's config so overflow recovery compacts
                  // with the CURRENTLY-active model's tokenizer/window/creds (not the
                  // primary's, which may be unavailable or have a larger window).
                  activeModelEntryForRecovery = fallbackEntry;
                  // Re-point the provider-native exemption at the now-active
                  // fallback model so its provider tools aren't suppressed and,
                  // conversely, the previous model's local tools aren't wrongly
                  // exempted.
                  providerDefinedToolNames = getProviderDefinedToolNames(
                    fallbackEntry.modelConfig,
                    effectiveExecutionMode,
                  );
                }
                // Refresh the run context's model key so a mid-turn inject arriving
                // AFTER this fallback gates under the model its text will actually
                // be sent to (a model-conditioned DLP hook would otherwise decide
                // against the primary's key). Token-scoped no-op if superseded.
                updateActiveRunModelKey(conversationId, streamToken, fbData.toModelKey);
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
            // Intercept a context-overflow ERROR EVENT before emitting it. Mastra
            // surfaces non-transient provider failures as an `error` event (then
            // `done`), NOT a thrown error — so this branch, not the catch below, is
            // where a typical overflow arrives. Compact and retry the model stream
            // in place (see the do/while); if recoverable, swallow this error event
            // (and the trailing `done`) so the UI sees only the retry. If not
            // recoverable, upgrade the message with the /compact guidance.
            // `errorCategory` is authoritative WHEN PRESENT — a structured non-
            // overflow category (e.g. 'rate-limit' whose message happens to mention
            // token limits) must NOT be reclassified as overflow. Only fall back to
            // message-string classification when no category was provided.
            const isOverflowEvent =
              event.type === 'error' &&
              (event.errorCategory ? event.errorCategory === 'context-overflow' : isContextOverflowError(event.error));
            if (isOverflowEvent) {
              // If streamWithFallback preserved a MASKED primary overflow across the
              // fallback chain (the terminal error was actually an unrelated fallback
              // failure), it tells us WHICH model overflowed. Recover THAT model — not the
              // failed fallback that `activeModelEntryForRecovery` currently points at, or
              // we'd retry the broken (e.g. 401) fallback summarizer and never recover.
              const ovKey = (event as { overflowRecoveryModelKey?: string }).overflowRecoveryModelKey;
              if (ovKey && streamConfig) {
                const ovEntry =
                  (streamConfig.primaryModel?.key === ovKey ? streamConfig.primaryModel : undefined) ??
                  streamConfig.fallbackModels.find((m) => m.key === ovKey);
                if (ovEntry?.modelConfig) activeModelEntryForRecovery = ovEntry;
              }
              const compacted = await computeOverflowCompaction(true);
              if (compacted?.compactedMessages && compacted.compactedMessages.length > 0) {
                overflowRecoveryUsed = true;
                messages = compacted.compactedMessages as unknown as typeof messages;
                retryAfterOverflow = true;
                overflowRecoveryTookOver = true; // swallow this error + trailing done from the FAILED stream
                // Emit a `compaction` event so persistence records the summary for
                // REUSE on the next turn (else the next turn reloads the original
                // branch, re-overflows, and re-summarizes). BUT skip persisting when
                // the compacted ids include a synthetic `compaction-summary-*` id —
                // that means the in-memory branch was ALREADY compacted this turn
                // (pre-turn compaction / prior recovery), so the ids don't exist in
                // the stored tree; persisting would overwrite a good record with one
                // whose prefix check always fails. The in-place retry still uses the
                // compacted messages directly regardless.
                // If the recompacted prefix begins with a synthetic
                // `compaction-summary-<id>` (the branch already reused a stored
                // record this turn), COMPOSE it back to the underlying message ids the
                // OLD summary covered (from the stored record) so the new record's ids
                // are real disk-branch ids and REUSABLE next turn. Otherwise the retry
                // lives only in memory and the next turn re-overflows + re-pays.
                const composedCompactedIds: string[] = (() => {
                  const ids = compacted.compactedMessageIds;
                  if (ids.length === 0 || !syntheticSummaryIdsThisTurn.has(ids[0])) return ids;
                  // Resolve the synthetic id from the stored record on disk OR the
                  // pre-stream compaction emitted THIS turn (renderer persists it
                  // async, so it may not be on disk yet).
                  const candidates: Array<
                    { compactionId?: string; compactedMessageIds?: string[] } | null | undefined
                  > = [];
                  if (pendingCompactionThisTurn) candidates.push(pendingCompactionThisTurn);
                  try {
                    candidates.push(
                      readConversation(appHome, conversationId)?.conversationCompaction as
                        | { compactionId?: string; compactedMessageIds?: string[] }
                        | null
                        | undefined,
                    );
                  } catch {
                    /* disk read failed — rely on the in-memory pending record */
                  }
                  for (const rec of candidates) {
                    if (
                      rec &&
                      `compaction-summary-${rec.compactionId}` === ids[0] &&
                      Array.isArray(rec.compactedMessageIds) &&
                      rec.compactedMessageIds.length > 0
                    ) {
                      return [...rec.compactedMessageIds, ...ids.slice(1)];
                    }
                  }
                  return ids;
                })();
                // Whether the composed ids resolved to REAL disk-branch ids is decided by
                // the strict-prefix disk check below — NOT by a name heuristic. (An earlier
                // version rejected any id starting with `compaction-summary-`, but an
                // imported/plugin conversation may legitimately carry such an id; a synthetic
                // id that FAILED to expand simply isn't on disk, so isStrictPrefix rejects it
                // anyway. Relying on the disk check avoids false-rejecting legit ids.)
                const persistIsStrictPrefix = (() => {
                  try {
                    const diskConv = readConversation(appHome, conversationId);
                    if (!diskConv) return false;
                    const { tree, headId } = ensureConversationTree(diskConv);
                    const branchIds = getConversationBranch(tree, headId).map((m) => m.id);
                    if (!isStrictPrefix(composedCompactedIds, branchIds)) return false;
                    // Reject if a concurrent conversations:put edited a covered message's
                    // CONTENT (same id) at ANY point since the turn's input branch was
                    // established. Two baselines cover the composed ids:
                    //  (1) preSig = the RAW in-memory branch THIS recovery summarized
                    //      (captured at recovery start) — covers ids we summarized directly.
                    //  (2) earlierSig = the baseline of the EARLIER same-turn record whose
                    //      synthetic summary this recovery expanded (composedCompactedIds
                    //      spliced its underlying ids in). Those ids are NOT in preSig; the
                    //      earlier record signed them. If that earlier record's own persist
                    //      was rejected due to a concurrent edit on one of them, trusting the
                    //      expansion blindly would persist THIS summary over the changed
                    //      content — so we re-verify them against fresh disk here too.
                    const preSig = compacted.compactionId ? recoveryPreDiskSig.get(compacted.compactionId) : undefined;
                    const rawIds = compacted.compactedMessageIds;
                    const expandedFromSynthetic = rawIds.length > 0 && syntheticSummaryIdsThisTurn.has(rawIds[0]);
                    let earlierSig: Record<string, string> | undefined;
                    if (expandedFromSynthetic) {
                      if (
                        pendingCompactionThisTurn &&
                        `compaction-summary-${pendingCompactionThisTurn.compactionId}` === rawIds[0]
                      ) {
                        earlierSig = pendingCompactionThisTurn.coveredContentSig;
                      }
                      if (!earlierSig) {
                        try {
                          const rec = readConversation(appHome, conversationId)?.conversationCompaction as
                            | { compactionId?: string; coveredContentSig?: Record<string, string> }
                            | null
                            | undefined;
                          if (rec && `compaction-summary-${rec.compactionId}` === rawIds[0]) {
                            earlierSig = rec.coveredContentSig;
                          }
                        } catch {
                          /* disk read failed — handled by the missing-baseline check below */
                        }
                      }
                    }
                    if (preSig) {
                      const nowSig = diskSigMap();
                      // Every composed id must have a baseline (from preSig or the earlier
                      // record) that MATCHES fresh disk. An id with NO baseline on an
                      // expanded record means we can't prove it's unchanged → don't persist.
                      for (const id of composedCompactedIds) {
                        const base = preSig.has(id) ? preSig.get(id) : earlierSig?.[id];
                        if (base === undefined) {
                          // No baseline: only tolerated for the NON-expanded case (all ids in
                          // preSig by construction). For an expanded record a missing earlier
                          // signature is unsafe → reject.
                          if (expandedFromSynthetic) return false;
                          continue;
                        }
                        if (base !== nowSig.get(id)) return false;
                      }
                    }
                    return true;
                  } catch {
                    return false;
                  }
                })();
                if (
                  compacted.compactionId &&
                  compacted.summaryText &&
                  composedCompactedIds.length > 0 &&
                  persistIsStrictPrefix
                ) {
                  // Baseline signatures for the persisted record. For ids THIS recovery
                  // summarized directly, use its own baseline (recoveryPreDiskSig). For ids
                  // spliced in by expanding an earlier same-turn synthetic summary, carry
                  // the EARLIER record's signatures so a chained future recovery can still
                  // verify every composed id (persistIsStrictPrefix already required these
                  // to match fresh disk, so they're current).
                  const preSig = recoveryPreDiskSig.get(compacted.compactionId);
                  const coveredContentSig: Record<string, string> = {};
                  const rawIds = compacted.compactedMessageIds;
                  let earlierSig: Record<string, string> | undefined;
                  if (rawIds.length > 0 && syntheticSummaryIdsThisTurn.has(rawIds[0])) {
                    if (
                      pendingCompactionThisTurn &&
                      `compaction-summary-${pendingCompactionThisTurn.compactionId}` === rawIds[0]
                    ) {
                      earlierSig = pendingCompactionThisTurn.coveredContentSig;
                    }
                    if (!earlierSig) {
                      try {
                        const rec = readConversation(appHome, conversationId)?.conversationCompaction as
                          | { compactionId?: string; coveredContentSig?: Record<string, string> }
                          | null
                          | undefined;
                        if (rec && `compaction-summary-${rec.compactionId}` === rawIds[0])
                          earlierSig = rec.coveredContentSig;
                      } catch {
                        /* disk read failed — omit; a future expansion of this record then rejects */
                      }
                    }
                  }
                  for (const id of composedCompactedIds) {
                    const s = preSig?.get(id) ?? earlierSig?.[id];
                    if (s !== undefined) coveredContentSig[id] = s;
                  }
                  emit({
                    conversationId,
                    type: 'compaction',
                    data: {
                      compactionId: compacted.compactionId,
                      summaryText: compacted.summaryText,
                      compactedMessageIds: composedCompactedIds,
                      coveredContentSig,
                      compactionRevision: nextCompactionRevision(),
                    },
                  });
                }
                // Informational "compacting + retrying" note. Emit as a `retry` (observer) event,
                // NOT a `text-delta`: a text-delta has no responseMessageId here (the retry mints a
                // FRESH id downstream), so the renderer would attach it to the PRIOR attempt's
                // assistant — mis-attributed, and after a preserved fallback variant it can collide
                // with a duplicate id. The retry/observer path attaches to the current assistant
                // without responseMessageId keying, so it survives the id change cleanly.
                emit({
                  conversationId,
                  type: 'retry',
                  data: {
                    reason: 'context-overflow',
                    text: '> ℹ️ The request exceeded the context window; compacted the conversation and retrying…',
                  },
                });
                continue; // drain the rest of the failed stream; the do/while re-runs it
              }
              // Recovery declined/failed. If the turn was cancelled or superseded
              // while recovery's compaction ran, don't emit a stale terminal error
              // over a run that no longer owns the conversation.
              if (controller.signal.aborted || activeStreams.get(conversationId)?.token !== streamToken) {
                overflowRecoveryTookOver = true; // suppress this + trailing done
                continue;
              }
              emit({
                ...event,
                // Recovery EXHAUSTED = it actually ran compaction (not gated off) and
                // got nothing → `/compact` would also be a no-op, so give generic
                // guidance. If recovery was merely SKIPPED (a tool/text/inject already
                // happened this turn), `/compact` may still help next turn — keep it.
                error: `${event.error ?? 'Context window exceeded.'}${overflowGuidance(!compacted && !recoveryGatedOffLast)}`,
                errorCategory: 'context-overflow',
              });
              // This terminal error is fully terminal for a GUI turn (the renderer's error
              // handler deletes the accumulator + persists idle). Suppress the FAILED stream's
              // trailing `done` (via overflowRecoveryTookOver) so it can't recreate the
              // accumulator from stale tree state and overwrite the persisted overflow error
              // (round-100/108 pattern). A serverPersisted (CLI/automation) turn KEEPS its
              // accumulator on error and needs the trailing `done`, so leave it flowing there.
              if (!serverPersistedRun) overflowRecoveryTookOver = true;
              continue;
            }
            // The stream yields a terminal `error` and THEN an unconditional `done`
            // (mastra-agent). For a GUI turn the error is fully terminal (renderer deletes the
            // accumulator); forwarding the trailing `done` would recreate it from stale state +
            // supersede the error write (a provider failure would flash then vanish). Track the
            // error and drop the following `done` for GUI turns. serverPersisted keeps its
            // accumulator on error and needs the `done`.
            if (
              shouldPrepareBrowserContinuation(
                event,
                serverPersistedRun,
                config.agent?.autoContinueOnMaxTurns === true,
                allowNativeBrowserTools,
              ) &&
              getExistingBrowserManager()?.prepareAssistantContinuation(conversationId, streamToken)
            ) {
              browserContinuationPrepared = true;
            }
            if (event.type === 'error' && !serverPersistedRun) sawTerminalStreamError = true;
            if (event.type === 'done' && sawTerminalStreamError && !serverPersistedRun) continue;
            emit(event);
          }
          // If the just-drained stream was an overflow that we compacted, reset the
          // per-stream suppression flag and re-run the model with the compacted
          // `messages` (hooks/lifecycle/injects already ran and are NOT repeated).
          if (retryAfterOverflow) {
            overflowRecoveryTookOver = false;
            // If this failed stream fell back to a fallback model, the renderer's
            // model selector is now pinned to that fallback key. The retry restarts at
            // the PRIMARY, so emit a restoration model-fallback (primary as the target)
            // to un-pin the selector — otherwise a successful compacted retry on the
            // primary would leave the selector (and subsequent bare-model turns) stuck
            // on the fallback.
            if (fellBackThisStream && modelEntry?.key) {
              emit({
                conversationId,
                type: 'model-fallback',
                data: {
                  fromModel: activeModelDisplayName ?? 'fallback model',
                  toModel: modelEntry.displayName ?? modelEntry.key,
                  toModelKey: modelEntry.key,
                  error: '',
                  reason: 'overflow-recovery-retry-primary',
                },
              });
            }
            // Reset per-model state to the PRIMARY before re-running. The failed
            // stream may have fallen back to a fallback model before overflowing,
            // mutating these; the retry restarts at the primary, so stale values
            // would misattribute the reply's source model AND (critically) apply
            // the fallback's provider-native tool exemptions to the primary —
            // which could leak unsanitized local-tool args past a DLP hook or leave
            // the primary's native-tool args stuck pending.
            accumulatedResponseText = '';
            activeSourceModel = modelEntry?.modelConfig
              ? `${modelEntry.modelConfig.provider}:${modelEntry.modelConfig.modelName}`
              : null;
            activeModelDisplayName = modelEntry?.displayName ?? null;
            providerDefinedToolNames = modelEntry?.modelConfig
              ? getProviderDefinedToolNames(modelEntry.modelConfig, effectiveExecutionMode)
              : new Set<string>();
            activeModelEntryForRecovery = modelEntry;
            // Restore the active-run context's model key to the PRIMARY too, so a
            // mid-turn inject during the retry gates under the model its text will
            // actually be sent to (not the fallback the failed attempt used).
            if (modelEntry?.key) updateActiveRunModelKey(conversationId, streamToken, modelEntry.key);
            // Fresh response id for the retry (undefined → mastra-agent mints one) so the retried
            // reply can't collide with a failed sibling preserved under the prior attempt's id.
            currentResponseMessageId = undefined;
          }
        } while (retryAfterOverflow);
      } catch (error) {
        ipcDebugLog(
          `[LOOP-ERROR] conv=${conversationId} aborted=${controller.signal.aborted} error=${error instanceof Error ? error.message : String(error)}`,
        );
        // Note: a context-overflow surfaced by Mastra as an `error` STREAM EVENT
        // is handled (with in-place compact+retry) inside the do/while above. This
        // catch only sees a THROWN error — rare for overflow — so we don't retry
        // here (re-running below the hook boundary would require re-entering the
        // loop); we surface actionable, runtime-aware guidance instead.
        if (!controller.signal.aborted) {
          const overflow = isContextOverflowError(error);
          const baseMsg = error instanceof Error ? error.message : String(error);
          emit({
            conversationId,
            type: 'error',
            error: overflow ? `${baseMsg}${overflowGuidance()}` : baseMsg,
            ...(overflow ? { errorCategory: 'context-overflow' } : {}),
          });
          // Only a serverPersisted (CLI/automation) turn needs a trailing `done`: its
          // renderer error handler KEEPS the accumulator alive and relies on the terminal
          // `done` for cleanup+reload. For a GUI turn the `error` is fully terminal (the
          // handler deletes the accumulator + persists idle); a following `done` would
          // recreate it from stale React state and supersede the error write, making the
          // error flash then vanish (round-76 pattern).
          if (serverPersistedRun) {
            emit({ conversationId, type: 'done' });
          }
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
        // conversation keeps its own stream + model-key state. Capture ownership
        // BEFORE cleanup (which deletes the activeStreams entry). Use the shared
        // cleanup so ALL per-run maps are cleared on normal termination — including
        // the same-turn inject bookkeeping — not just activeStreams/model-keys (a
        // one-off chat that consumed a mid-turn inject would otherwise leak those two
        // module-level entries until it happened to start another turn). Nothing
        // below reads the inject maps (their only readers are the tool-fit/recovery
        // paths that already ran during streaming), and the observer is disposed above.
        const stillOwnsRun = activeStreams.get(conversationId)?.token === streamToken;
        if (!browserContinuationPrepared) cleanupAssistantTabsIfOwned(conversationId, streamToken);
        cleanupStreamIfOwned(conversationId, streamToken);

        // Drain-at-end safety net for a cooperative inject that arrived AFTER the
        // final prepareStep boundary. It was accepted + optimistically broadcast,
        // but the consumption hook never ran, so persist it now rather than leave
        // it queued to leak into an unrelated future turn. On normal completion,
        // immediately continue once on the resulting branch so the user still gets
        // an answer. On explicit abort/stop, preserve the user message but respect
        // the stop (no automatic restart). A superseding run owns its own queue,
        // so only the still-current token may drain.
        // A cooperative inject that arrived AFTER the final prepareStep boundary must be
        // drained regardless of run type — a GUI-injected message is just as stranded as a
        // CLI one and would otherwise leak (re-spliced) into an unrelated future turn. The
        // continuation below is marked serverPersisted, so the GUI renderer takes its
        // render-only path (no double-persist). Only the still-current token may drain.
        if (stillOwnsRun && hasInjects(conversationId)) {
          // Drain (dequeue) the stranded injects so they don't re-splice into a future turn.
          // PERSISTENCE differs by run type:
          //  - server-owned turn: the inject was only QUEUED (not written at injection time),
          //    so persist it now via persistCooperativeInjectedUserTurn.
          //  - GUI turn: the inject was ALREADY persisted at injection (appendConversationMessages,
          //    the !serverOwnsPersistence branch), so re-persisting here would DUPLICATE it
          //    (the helper re-appends the occupied id → a replacement id, but returns the
          //    original) → the continuation gets the prompt twice + a mis-parented response.
          //    Just take its already-persisted id as the continuation head.
          const stranded = drainInjects(conversationId);
          let lastInjectedHead: string | null = null;
          let lastInjectedText = '';
          // GUI-injected ids (FIFO) whose prefix/user order may need on-disk repair
          // AFTER the renderer persists the assistant — done in the poll below, not
          // here (at drain time the renderer hasn't written the assistant yet, so a
          // repair now would be a no-op — the R42 finding).
          const guiInjectedIds: string[] = [];
          for (const entry of stranded) {
            if (serverPersistedRun) {
              const persisted = persistCooperativeInjectedUserTurn(appHome, conversationId, entry.text, entry.id);
              if (persisted) {
                lastInjectedHead = persisted.messageId;
                lastInjectedText = entry.text;
              }
            } else {
              // GUI turn: the inject was ALREADY persisted at injection. If it arrived
              // AFTER the final prepareStep, the renderer will parent THIS turn's
              // assistant UNDER the (last) injected user, making the assistant the
              // disk head — so `entry.id` is NOT the head. The order repair is
              // deferred to the post-idle poll (batch-aware); here just record the id
              // + take the last as the provisional continuation head.
              guiInjectedIds.push(entry.id);
              lastInjectedHead = entry.id;
              lastInjectedText = entry.text;
            }
          }
          if (lastInjectedHead && !controller.signal.aborted) {
            const injectedHead = lastInjectedHead;
            const injectedText = lastInjectedText;
            // Launch the automatic continuation on `branch`, marking this conversation
            // server-persist so the renderer takes its render-only path (no double-persist).
            const launchContinuation = (branch: unknown[], busyRetries = 300): void => {
              if (controller.signal.aborted) return;
              // The delayed continuation timers fire AFTER this run's finally cleaned up
              // activeStreams, so a conversation DELETE (which aborts via activeStreams) can no
              // longer reach this controller. Guard the launch on the conversation still existing
              // + not tombstoned — else the timer would start a stream against a DELETED chat and
              // run tools invisibly.
              if (!readConversation(appHome, conversationId) || isRecentlyDeleted(conversationId)) return;
              // The captured `branch` ends at injectedHead. If the user switched branches or
              // rewound during the (possibly long, /compact-busy) retry wait, the conversation's
              // active head no longer points at injectedHead — retrying then would run tools
              // against ABANDONED history and later yank the active head back, overriding the
              // user's selection. Verify injectedHead is still the current active head before
              // launching; if it moved, the continuation is stale → abandon.
              {
                const cur = readConversation(appHome, conversationId);
                if (cur) {
                  const { headId: curHead } = ensureConversationTree(cur);
                  if (curHead !== injectedHead) return;
                }
              }
              // A superseding turn (new GUI/CLI submit) installs a new activeStreams token
              // for this conversation; it owns its own continuation queue, so a stale
              // continuation must not launch. This run's OWN token is already removed by the
              // finally-block cleanup above (an absent entry means a clean finish, we still own
              // the continuation); a present entry with a DIFFERENT token means superseded.
              const owner = activeStreams.get(conversationId)?.token;
              if (owner !== undefined && owner !== streamToken) return;
              pendingServerPersist.add(conversationId);
              pendingServerPersistParent.set(conversationId, injectedHead);
              queueMicrotask(() => {
                void (async () => {
                  const res = await streamHandler(
                    null,
                    conversationId,
                    branch,
                    modelKey,
                    reasoningEffort,
                    profileKey,
                    fallbackEnabled,
                    effectiveCwd ?? undefined,
                    effectiveExecutionMode,
                    threadOverrides,
                    undefined,
                    allowNativeBrowserTools,
                    nativeBrowserAuthorityGeneration,
                  );
                  // streamHandler consumes pendingServerPersist at its top on the NORMAL path.
                  // If it rejected EARLY (compaction lock held → `{busy}`) it did NOT consume,
                  // so the marker we set above would leak and mis-flag the NEXT GUI turn as
                  // server-persisted (its reply persisted server-side under injectedHead →
                  // corrupt branch). Clear our marker on a busy rejection — but only if it is
                  // still OURS (a superseding turn may have installed its own since).
                  if (res && (res as { busy?: boolean }).busy) {
                    const stillOurs = pendingServerPersistParent.get(conversationId) === injectedHead;
                    if (stillOurs) {
                      pendingServerPersist.delete(conversationId);
                      pendingServerPersistParent.delete(conversationId);
                    }
                    // A /compact holds the conversation — transient but up to ~285s. RETRY the
                    // continuation (bounded to SPAN that window) rather than abandoning, else the
                    // accepted injected message is left PERMANENTLY unanswered. 1s cadence ×
                    // budget covers /compact's max hold. Only if still ours + not superseded.
                    if (stillOurs && busyRetries > 0 && !controller.signal.aborted) {
                      const o = activeStreams.get(conversationId)?.token;
                      if (o === undefined || o === streamToken) {
                        setTimeout(() => launchContinuation(branch, busyRetries - 1), 1000);
                      }
                    }
                  }
                })();
              });
            };
            if (serverPersistedRun) {
              // Main owns persistence for this turn: the assistant reply + the injected user
              // are already on disk here, so an immediate reread yields the complete branch.
              // Re-arm CLI clients (the prior run broadcast `done`, settling them) with a
              // continuation-tagged user-message before launching — CLI sets running without
              // re-rendering the turn; renderer dedup handles the same stable id.
              const updated = readConversation(appHome, conversationId);
              if (updated) {
                const { tree: continuationTree, headId: continuationHead } = ensureConversationTree(updated);
                broadcastStreamEventRaw({
                  conversationId,
                  type: 'user-message',
                  text: injectedText,
                  serverPersisted: true,
                  data: { messageId: injectedHead, continuation: true },
                });
                launchContinuation(getConversationBranch(continuationTree, continuationHead));
              }
            } else {
              // GUI turn: the renderer OWNS persistence + rendering. The injected user was
              // persisted + rendered at injection time, and the just-finished assistant reply
              // is written by the renderer ASYNCHRONOUSLY (after its `done` handler finalizes).
              // Two things follow:
              //  (1) Do NOT rebroadcast the user-message — the renderer already rendered it; a
              //      rebroadcast can double-insert the same id when a text delta made the branch
              //      tail an assistant (dedup only checks the last USER turn).
              //  (2) Do NOT reread disk immediately — that races the renderer's assistant write,
              //      launching the continuation without the just-produced reply in context. Poll
              //      until disk reflects the finalized turn (the injected user is the branch tail,
              //      i.e. the assistant reply landed and the renderer re-appended the user turn),
              //      then launch on that confirmed branch. Bounded; fall back after the budget.
              const pollForFinalizedBranch = (remaining: number): void => {
                if (controller.signal.aborted) return;
                // Conversation deleted/tombstoned during the poll → stop (don't keep polling or
                // launch a continuation against a gone chat).
                if (isRecentlyDeleted(conversationId)) return;
                // Bail if a superseding run took over (present entry, different token). Our own
                // token is already cleaned up (absent) by finally — absent means we still own it.
                const owner = activeStreams.get(conversationId)?.token;
                if (owner !== undefined && owner !== streamToken) return;
                // A newer turn may have STARTED AND FINISHED between poll ticks — then
                // `activeStreams` is empty (owner === undefined) AND disk is 'idle', so the
                // owner + runStatus checks below both pass even though our turn is stale.
                // Reject when a strictly-newer turn has been issued for this conversation
                // (latestIssuedTurnToken advanced past ours): rewriting the head back to our
                // old drain's injected user here would HIDE the newer completed branch and
                // could replay model/tool work from stale history. Mirrors authorizeContinuation.
                const latestIssued = latestIssuedTurnToken.get(conversationId);
                if (
                  latestIssued !== undefined &&
                  latestIssued !== streamToken &&
                  turnTokenTime(streamToken) < turnTokenTime(latestIssued)
                ) {
                  return;
                }
                const updated = readConversation(appHome, conversationId);
                if (updated) {
                  const { tree: continuationTree, headId: continuationHead } = ensureConversationTree(updated);
                  const continuationBranch = getConversationBranch(continuationTree, continuationHead);
                  // Wait for the RENDERER to have finished persisting THIS turn's assistant reply
                  // before launching — else the continuation reads a branch missing the just-
                  // produced reply (stale context → the model repeats tool calls). The reliable
                  // signal is the renderer's terminal persist writing runStatus:'idle' (it was
                  // 'running' throughout the turn AND at mid-turn injection); the injected user
                  // being the branch tail is NOT a valid signal (it's the tail from the moment of
                  // injection, before the reply lands). Launch once idle, or after the budget
                  // (reactive recovery + the renderer's reconciliation backstop any residual gap).
                  // Launch the continuation ONLY once the renderer confirmed it persisted this
                  // turn (runStatus:'idle'). On budget exhaustion do NOT launch on the still-
                  // 'running' (partial) branch: retrying from stale history could REPEAT mutating
                  // tool calls AND race the eventual terminal write. The injected user turn stays
                  // persisted-but-unanswered (the user sees it + can resend; reactive recovery /
                  // the renderer's own reconciliation backstop it) — strictly safer than a
                  // stale-context re-run. A renderer that never writes idle in the budget almost
                  // certainly crashed/reloaded (its runStatus is startup-swept).
                  if (updated.runStatus === 'idle') {
                    // The renderer has now persisted this turn's assistant. If GUI
                    // injects arrived after the final prepareStep, the renderer
                    // parented that assistant UNDER the (last) injected user, making
                    // it the head. Repair the order on disk NOW (batch-aware) so the
                    // continuation launches on `pre → assistant → u1 … uN` with the
                    // last injected user as the head — matching launchContinuation's
                    // head check. No-op when nothing needs reordering.
                    let launchBranch = continuationBranch;
                    if (guiInjectedIds.length > 0) {
                      // BRANCH-SWITCH guard: the user can rewind or switch this
                      // conversation's active branch WHILE we wait for the idle
                      // persist — that changes the disk head WITHOUT minting a newer
                      // stream token (so the recency guard above still passes). Forcing
                      // the drained inject as head would then clobber the user's
                      // selection and could restart model/tools on the abandoned branch.
                      //
                      // The head must be a genuine terminal-drain shape:
                      //  (1) it passes THROUGH an injected node — after the renderer's
                      //      idle persist (the usual state that gets us here), this turn's
                      //      reply was reordered BEFORE the inject chain with the last
                      //      injected user as head, so the head lineage contains an inject;
                      //      OR
                      //  (2) it is THIS run's crash-backstop fallback reply — a sibling
                      //      assistant under the pre-inject head that main persisted (when
                      //      the renderer crashed before its own reorder), identified as
                      //      the run's FINALIZED reply id (latestReplyResponseId — the
                      //      accumulator's current variant, NOT a failed fallback partial
                      //      that this run also streamed under an earlier id).
                      // A user who switched to a historical SIBLING variant beneath the
                      // pre-inject head — or a FAILED fallback partial variant — reaches
                      // the common ancestor too, but neither passes through an inject NOR
                      // is the run's finalized reply id — so it's rejected. Otherwise
                      // abandon (the inject stays persisted-but-unanswered — the user can
                      // resend; reactive recovery backstops it).
                      const injectedSet = new Set(guiInjectedIds);
                      const byId = new Map(continuationTree.map((m) => [m.id, m] as const));
                      const firstInjected = guiInjectedIds.find((id) => byId.has(id));
                      const preInjectHead = firstInjected ? (byId.get(firstInjected)?.parentId ?? null) : undefined;
                      const headIsGenuineDrainShape = ((): boolean => {
                        // No injected user present on disk any more → nothing to repair here.
                        if (firstInjected === undefined) return false;
                        let cur: string | null = continuationHead;
                        const seen = new Set<string>();
                        while (cur && !seen.has(cur)) {
                          // (1) Head is (or descends from) an injected user.
                          if (injectedSet.has(cur)) return true;
                          // (2) Head is (or descends from) THIS run's FINALIZED reply — the
                          // accumulator's latest variant (latestReplyResponseId) — sitting
                          // directly under the pre-inject head (the crash-backstop sibling
                          // shape reorderInjectPrefixOnDisk case (a) repairs). A failed
                          // fallback partial (earlier id) is NOT accepted.
                          const node = byId.get(cur);
                          if (
                            node?.role === 'assistant' &&
                            latestReplyResponseId !== null &&
                            cur === latestReplyResponseId &&
                            (node.parentId ?? null) === (preInjectHead ?? null)
                          ) {
                            return true;
                          }
                          seen.add(cur);
                          cur = byId.get(cur)?.parentId ?? null;
                        }
                        return false;
                      })();
                      if (!headIsGenuineDrainShape) return;
                      const repairedHead = reorderInjectPrefixOnDisk(appHome, conversationId, guiInjectedIds);
                      const reread = readConversation(appHome, conversationId);
                      if (reread && repairedHead) {
                        const { tree: rt, headId: rh } = ensureConversationTree(reread);
                        launchBranch = getConversationBranch(rt, repairedHead ?? rh);
                      }
                    }
                    launchContinuation(launchBranch);
                    return;
                  }
                  if (remaining <= 0) return; // budget exhausted, still running → abandon (don't re-run stale)
                }
                setTimeout(() => pollForFinalizedBranch(remaining - 1), 100);
              };
              pollForFinalizedBranch(80); // ~8s: generous for a slow renderer persist; then abandon
            }
          }
        }
        if (activeObserverSessions.get(conversationId) === observerSessionId) {
          activeObserverSessions.delete(conversationId);
        }
        // If this run still owns server-persist here, the stream ended WITHOUT a
        // `done` (abnormal termination — a producer that didn't emit the closing
        // event). `done` normally persists the accumulated reply, deletes the token +
        // accumulator, resets runStatus, and emits the terminal event. Its absence would
        // otherwise DISCARD the accumulated partial reply AND leave runStatus stuck 'running'
        // (wedged until restart) with no terminal event for clients. So do the terminal work
        // here: FINALIZE (persist) the accumulated partial, reset runStatus→idle, and emit a
        // terminal `done` so clients settle.
        if (serverPersistAppHome && serverPersistTokens.get(conversationId) === streamToken) {
          serverPersistTokens.delete(conversationId);
          serverPersistParents.delete(conversationId);
          try {
            finalizeInterruptedTurn(serverPersistAppHome, conversationId); // persists the partial (if any) + deletes the accumulator
          } catch {
            discardPersistenceAccumulator(conversationId); // fall back to release if finalize throws
          }
          // finalizeInterruptedTurn RETAINS the accumulator on a (non-throwing) persist failure
          // (R168 f-2). This is the terminal give-up: we've dropped ownership (above) and will reset
          // runStatus + emit `done` below, so the accumulator can NEVER be persisted later — discard
          // it explicitly (R170 f-1) rather than leave it ownerless and leaking for the process life.
          if (hasPersistenceAccumulator(conversationId)) {
            console.error(
              `[agent] terminal finalize could not persist accumulated reply for ${conversationId}; discarding`,
            );
            discardPersistenceAccumulator(conversationId);
          }
          try {
            const conv = readConversation(serverPersistAppHome, conversationId);
            if (conv && conv.runStatus === 'running') {
              conv.runStatus = 'idle';
              broadcastUpsert(serverPersistAppHome, writeConversation(serverPersistAppHome, conv));
            }
          } catch {
            /* best-effort */
          }
          emit({ conversationId, type: 'done' }); // settle clients (CLI/GUI) — no `done` came from the stream
        }
        // R122 finding-5: MAIN-side plan-first continuation for a server-persisted run.
        // A plan-mode transition aborted THIS run (so controller.signal.aborted is true)
        // and emitted a plan-restart `done`, but no GUI renderer will relaunch it. Drive
        // the restart here: re-read the finalized branch (the terminal finalize above has
        // written any partial + the user's request is already on the branch) and re-run it
        // in plan-first mode so the agent produces the plan under the read-only tool set.
        if (serverPersistPlanRestart) {
          // Guard the restart against every way THIS run may no longer be the
          // authoritative owner by the time the continuation would launch (findings 3&4):
          //  - stillOwnsRun (captured BEFORE cleanupStreamIfOwned): an ABSENT activeStreams
          //    entry is ambiguous — it happens on a clean finish (we own it) AND after Stop
          //    deleted our entry AND after a successor started+finished. Only stillOwnsRun
          //    (token matched pre-cleanup) means we genuinely owned the run at teardown.
          //  - not terminal-aborted: a Stop/dismiss on THIS token marks it terminal — never
          //    resurrect a stopped planning turn.
          //  - cancel-generation unchanged from teardown: a Stop DURING the microtask gap
          //    is caught by a PUSH cancellation token (R135) — the bounded stop-map alone
          //    could evict this conv's entry under a 500+ concurrent-Stop flood and miss it.
          //  - head-bound: capture the finalized head NOW and re-run ONLY if it is still the
          //    current head at fire time. A viewer rewind / sibling-select during the
          //    (async) observer cleanup moves the head WITHOUT minting a newer token, so an
          //    owner/recency check alone would run the user's abandoned branch + move the
          //    head (finding-4). If it moved, abandon (the plan simply isn't produced; the
          //    user's selection wins).
          const planCancelToken = registerCancelGenToken(conversationId);
          const planFinalized = readConversation(appHome, conversationId);
          const plannedHead = planFinalized ? ensureConversationTree(planFinalized).headId : undefined;
          if (
            stillOwnsRun &&
            !terminalAbortTokens.has(streamToken) &&
            plannedHead !== undefined &&
            !isRecentlyDeleted(conversationId)
          ) {
            queueMicrotask(() => {
              void (async () => {
                try {
                  if (isRecentlyDeleted(conversationId)) return;
                  const updated = readConversation(appHome, conversationId);
                  if (!updated) return;
                  // A newer turn took over (present entry, different token). Our own token was
                  // removed by cleanupStreamIfOwned — absent means we still own the slot.
                  const owner = activeStreams.get(conversationId)?.token;
                  if (owner !== undefined && owner !== streamToken) return;
                  // A strictly-newer turn was ISSUED (started+finished in the gap, leaving the
                  // map empty) — mirrors authorizeContinuation / the inject-drain recency guard.
                  const latestIssued = latestIssuedTurnToken.get(conversationId);
                  if (
                    latestIssued !== undefined &&
                    latestIssued !== streamToken &&
                    turnTokenTime(streamToken) < turnTokenTime(latestIssued)
                  ) {
                    return;
                  }
                  // A Stop landed during the gap. The PUSH token (R135) is authoritative and
                  // eviction-proof; terminalAbortTokens is a secondary signal.
                  if (planCancelToken.cancelled || terminalAbortTokens.has(streamToken)) return;
                  // The head must still be the finalized head we captured — else the user
                  // rewound/switched branches; abandon rather than clobber their selection.
                  const { tree, headId } = ensureConversationTree(updated);
                  if (headId !== plannedHead) return;
                  const branch = getConversationBranch(tree, headId);
                  // Persist plan-first as the authoritative mode for the restarted turn so the
                  // continuation (and any of ITS continuations) runs read-only. FAIL CLOSED
                  // (R135 f-1): if the persist didn't land, the trust-disk reconcile would read
                  // stale 'auto' and run the planning turn with MUTATING tools — so abandon the
                  // restart rather than launch unsafely (the plan simply isn't produced).
                  if (!broadcastExecutionMode('plan-first', conversationId)) return;
                  pendingServerPersist.add(conversationId);
                  pendingServerPersistParent.set(conversationId, headId);
                  // Re-run the branch verbatim in plan-first (parity with the renderer path,
                  // which appends no synthetic nudge). `null` event = no renderer sender.
                  const res = await streamHandler(
                    null,
                    conversationId,
                    branch,
                    modelKey,
                    reasoningEffort,
                    profileKey,
                    fallbackEnabled,
                    effectiveCwd ?? undefined,
                    'plan-first',
                    threadOverrides,
                  );
                  // On a busy rejection (compaction lock) the marker would leak → clear it if
                  // still ours (mirrors launchContinuation's busy handling).
                  if (res && (res as { busy?: boolean }).busy) {
                    if (pendingServerPersistParent.get(conversationId) === headId) {
                      pendingServerPersist.delete(conversationId);
                      pendingServerPersistParent.delete(conversationId);
                    }
                  }
                } finally {
                  releaseCancelGenToken(planCancelToken);
                }
              })();
            });
          } else {
            // Guard failed → the continuation won't launch; release the token we registered.
            releaseCancelGenToken(planCancelToken);
          }
        }
        // NOTE: the GUI-turn persistence fallback (finalizeGuiFallbackIfOwned) is invoked by
        // cleanupStreamIfOwned at the TOP of this finally (and on every early-exit path), so it
        // is NOT re-invoked here — it's idempotent, but the single cleanup call covers all paths.
      }
    })();

    return { conversationId };
  };

  // Keep the final browser-tools bit internal. Bridge clients can pass surplus
  // positional arguments to an IPC handler, so registering streamHandler
  // directly would let an untrusted web/local caller set that bit to true and
  // obtain the primary window's authenticated browser tools. This explicit
  // renderer-facing signature intentionally drops every argument after
  // responseMessageId; only in-process continuation calls reach the override.
  ipcMain.handle(
    'agent:stream',
    (
      event,
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
        continuationPredecessorToken?: string;
      },
      responseMessageId?: string,
    ) =>
      streamHandler(
        event,
        conversationId,
        messages,
        modelKey,
        reasoningEffort,
        profileKey,
        fallbackEnabled,
        cwd,
        executionMode,
        threadOverrides,
        responseMessageId,
      ),
  );

  // ── Renderer-facing cooperative mid-turn injection ────────────────────────
  // The GUI composer, when a message is sent while a Mastra turn is still
  // generating (ui.composer.midTurnSend), calls these instead of starting a new
  // turn. `inject` enqueues + persists + broadcasts the user turn (prepareStep
  // splices it at the running turn's next step boundary — see inject-queue.ts).
  // `list`/`cancel` back the queue-editable chip. These are Mastra-path only;
  // the renderer only routes here when the active run is the Mastra runtime.
  ipcMain.handle(
    'agent:inject-mid-turn',
    async (
      event,
      conversationId: string,
      userText: string,
      expectedGeneration?: string,
    ): Promise<{ ok: boolean; cooperative?: boolean; blocked?: boolean; id?: string; error?: string }> => {
      if (!conversationId || !userText) return { ok: false, error: 'missing conversationId or text' };
      // Caller may pin the generation (active stream token, echoed as runGeneration on
      // stream events) it INTENDS to inject into — e.g. the renderer routing a displaced
      // GUI prompt into a specific accepted run. If the run was already superseded by a
      // LATER run before this IPC landed, refuse rather than splice into the wrong run;
      // the caller then preserves the prompt (R113 finding-3). The subsequent post-gate
      // ownership check also revalidates it (a supersession during the async policy gate).
      if (expectedGeneration !== undefined && activeStreams.get(conversationId)?.token !== expectedGeneration) {
        return { ok: false, cooperative: false, error: 'expected-generation-superseded' };
      }
      // A Browser-authorized stream must not be mutated by a passive/web/secondary caller.
      if (!mayMutateBrowserAuthorizedStream(event, activeStreams.get(conversationId), getPrimaryWindow)) {
        return { ok: false, error: 'native-browser-authority-required' };
      }
      const conv = readConversation(appHome, conversationId);
      if (!conv) return { ok: false, error: 'conversation-not-found' };
      // Cooperative splice only works on a genuine Mastra prepareStep run. If the
      // live run is a CLI runtime, a direct plugin-inference-provider stream (which
      // bypasses prepareStep — recorded runtimeId 'mastra' but non-draining), or
      // nothing is running, tell the renderer so it can fall back to a normal turn
      // (abort+restart) instead of stranding the message in a queue no prepareStep
      // will drain (R100).
      if (!isCooperativelyInjectable(conversationId)) {
        return { ok: false, cooperative: false, error: 'active run is not cooperatively injectable' };
      }
      // Enforce plugin pre-send + UserPromptSubmit policy before the text is
      // spliced (prepareStep does not re-gate). DENY → reject; redaction →
      // persist/broadcast/enqueue the redacted text. Gate under the active run's
      // model + system prompt so a conditioned hook sees the same context a normal
      // turn shows it.
      const tokenBeforeGate = activeStreams.get(conversationId)?.token;
      // Capture the ORIGINATING branch head before the (async) gate. If the user
      // switches to another branch WHILE a slow policy hook is pending, the disk head
      // moves — and the stream token is UNCHANGED (a branch switch doesn't supersede
      // the run), so the token check below wouldn't catch it. Splicing then would
      // append the inject onto the newly-selected lineage while the running turn
      // consumes it on the OLD branch → conflicting parents / the old head restored.
      // Revalidate the head after the gate; on a mismatch, fall back to a normal turn.
      const headBeforeGate = conv.headId ?? null;
      const runCtx = getActiveRunContext(conversationId);
      const gate = await gateInjectedUserText(conversationId, userText, {
        modelKey: runCtx?.modelKey,
        systemPrompt: runCtx?.systemPrompt,
        preHookSystemPrompt: runCtx?.preHookSystemPrompt,
        executionMode: runCtx?.executionMode,
        // GUI mid-turn send always gates under the live run's model — revalidate
        // against a mid-stream fallback that lands during the async gate.
        revalidateLiveModel: true,
      });
      // Classify ownership FIRST (token/runtime unchanged AND head still on the
      // composed-against branch, descendant-aware). A terminal policy block is only a
      // true permanent rejection if we STILL own the run it was decided against — if
      // ownership changed during the async gate, the block was against a STALE run, so
      // fall back to a normal turn (which re-gates on the fresh turn) rather than
      // surfacing a permanent block for a decision that no longer applies.
      const runOwnershipIntact =
        activeStreams.get(conversationId)?.token === tokenBeforeGate &&
        isCooperativelyInjectable(conversationId) &&
        injectHeadStillOnBranch(appHome, conversationId, headBeforeGate, getActiveRunResponseIds(conversationId));
      if (!gate.allowed) {
        return gate.terminal && runOwnershipIntact
          ? { ok: false, blocked: true, error: gate.reason ?? 'blocked-by-policy' }
          : { ok: false, cooperative: false, error: gate.reason ?? 'gate-invalidated' };
      }
      // The gate awaited hooks; the cooperatively-injectable run may have finished
      // or been superseded meanwhile (token/runtime/branch changed). Tell the renderer
      // to fall back to a normal turn instead (cooperative:false).
      if (!runOwnershipIntact) {
        return { ok: false, cooperative: false, error: 'active run ended during policy enforcement' };
      }
      const injectText = gate.text;
      const id = enqueueInject(conversationId, injectText);
      if (!id) return { ok: false, error: 'failed-to-enqueue' };
      // Failure-atomic acceptance (R105 finding-2): the entry is live in the queue the
      // instant it's enqueued, so a throw from persist/broadcast must NOT surface a
      // plain failure — the renderer would then fallback-send a duplicate while the
      // running turn drains this same inject. On any throw: if the id is already
      // on-tree (drained + committed) report success; else remove the queued entry and
      // report a non-cooperative failure so the renderer's fallback is safe.
      try {
        const activeToken = activeStreams.get(conversationId)?.token;
        const serverOwnsPersistence = isServerPersistOwner(conversationId, activeToken);

        // For a server-owned turn, display immediately with the stable queue id but
        // DO NOT persist/split yet. prepareStep consumes this entry only after the
        // prior step's tool results have arrived; the consumption hook above then
        // persists the partial assistant + user boundary without losing tool state.
        let persistedMessageId = id;
        let persistedParentId: string | null | undefined = serverOwnsPersistence ? undefined : (conv.headId ?? null);
        let persistedCreatedAt: string | undefined = new Date().toISOString();
        if (!serverOwnsPersistence) {
          const write = appendConversationMessages(
            appHome,
            conversationId,
            [{ id, role: 'user', content: [{ type: 'text', text: injectText }], createdAt: persistedCreatedAt }],
            { runStatus: 'running' },
          );
          if (!write) {
            removeInject(conversationId, id);
            return { ok: false, error: 'conversation-not-found' };
          }
          persistedMessageId = write.headId ?? id;
          const persistedNode = (
            (write.messageTree ?? []) as Array<{ id?: string; parentId?: string | null; createdAt?: string }>
          ).find((message) => message.id === persistedMessageId);
          persistedParentId = persistedNode?.parentId ?? null;
          persistedCreatedAt = persistedNode?.createdAt ?? persistedCreatedAt;
        }

        // Record this inject's node ids as THIS run's own lineage IMMEDIATELY (not only
        // at inject-consumed). A first accepted GUI inject advances the disk head to its
        // (just-persisted) user node; a SECOND overlapping mid-turn send whose slow
        // policy hook then resolves would otherwise walk from that head to headBeforeGate
        // WITHOUT crossing a recorded lineage id and wrongly classify it a branch switch
        // (forcing a superseding send that aborts the healthy Mastra turn instead of
        // batching both injects). Record both the queue id and the persisted id (they can
        // differ if the append reassigned) plus their `-cont` continuations.
        if (activeToken !== undefined) {
          recordInjectBoundaryLineage(conversationId, activeToken, id);
          if (persistedMessageId !== id) recordInjectBoundaryLineage(conversationId, activeToken, persistedMessageId);
        }

        // Broadcast is best-effort: the inject is already enqueued + persisted, so a
        // broadcast throw must NOT unwind acceptance.
        try {
          broadcastStreamEvent({
            conversationId,
            type: 'user-message',
            text: injectText,
            data: {
              messageId: persistedMessageId,
              parentId: persistedParentId,
              createdAt: persistedCreatedAt,
            },
          });
        } catch {
          /* best-effort mirror; acceptance already succeeded */
        }
        return { ok: true, cooperative: true, id: id ?? undefined };
      } catch {
        // persist threw. If the running turn already drained + committed this inject
        // (its id is on the tree), acceptance genuinely succeeded — report ok so the
        // renderer does NOT fallback-send a duplicate. Otherwise remove the still-queued
        // entry and tell the renderer to fall back to a normal turn.
        const tree = (readConversation(appHome, conversationId)?.messageTree ?? []) as Array<{
          id?: unknown;
        }>;
        if (tree.some((m) => m?.id === id)) {
          // The inject IS committed but the throw skipped the normal lineage record;
          // record it now so an overlapping slow-gated inject doesn't see the advanced
          // head as a branch switch and needlessly abort the healthy turn (R106 f-2).
          const tok = activeStreams.get(conversationId)?.token;
          if (tok !== undefined) recordInjectBoundaryLineage(conversationId, tok, id);
          return { ok: true, cooperative: true, id };
        }
        removeInject(conversationId, id);
        return { ok: false, cooperative: false, error: 'inject persistence failed' };
      }
    },
  );

  ipcMain.handle('agent:list-injects', (_event, conversationId: string) =>
    listInjects(conversationId).map((e) => ({ id: e.id, text: e.text, at: e.at })),
  );

  // Cancel a queued (not-yet-spliced) inject by id. Returns the removed text so
  // the renderer's "edit" affordance can pre-fill the composer with it.
  ipcMain.handle(
    'agent:cancel-inject',
    (event, conversationId: string, id: string): { ok: boolean; text?: string; error?: string } => {
      if (!mayMutateBrowserAuthorizedStream(event, activeStreams.get(conversationId), getPrimaryWindow)) {
        return { ok: false, error: 'native-browser-authority-required' };
      }
      const text = removeInject(conversationId, id);
      return { ok: text !== null, text: text ?? undefined };
    },
  );

  // Shared mid-turn-inject helper (see the exported InjectUserTurnFn doc). This
  // is the same append-user-turn → server-persist → streamHandler sequence the
  // CLI's agent:submit uses; here it's used by the automations busy-target
  // inject path so an automation targeting a live conversation behaves like a
  // consecutive user follow-up (streamHandler aborts the in-flight run and
  // restarts with the combined branch) instead of diverting to a new chat.
  // NO skipIfBusy — superseding the in-flight run is the intended behavior.

  // ── Enforcement gate for mid-turn injected user text ───────────────────────
  // A cooperative inject splices raw user text into the running turn at the next
  // prepareStep boundary (prepare-step-inject.ts) — that spliced text NEVER
  // re-enters the primary turn's plugin pre-send / UserPromptSubmit enforcement,
  // so without this gate an inject (GUI compose-while-running, an automation
  // follow-up, OR a recovered ask_user answer) would be persisted + sent to the
  // model UNFILTERED, unlike a normal turn. Run the injected text through the
  // SAME enforcement a normal turn applies (plugin pre-send FIRST, then the
  // UserPromptSubmit DLP gate LAST — the ordering at line ~1906), as a single
  // one-user-message payload. Returns the possibly-redacted text to enqueue, or
  // `{ allowed:false }` when a hook DENIES (caller must not inject). FAST PATH:
  // when neither an enforcing UserPromptSubmit hook nor a plugin pre-send hook
  // exists, returns the input verbatim — zero behavior change for the common case.
  const gateInjectedUserText = async (
    conversationId: string,
    userText: string,
    ctx?: {
      modelKey?: string;
      systemPrompt?: string;
      preHookSystemPrompt?: string;
      executionMode?: ExecutionMode;
      revalidateLiveModel?: boolean;
    },
  ): Promise<{ allowed: boolean; text: string; reason?: string; terminal?: boolean; requiresRestart?: boolean }> => {
    const hasPluginHooks = Boolean(pluginManager?.hasPreSendHooks());
    const hasPromptHooks = hookDispatcher.hasEnforcingHooksFor('UserPromptSubmit');
    if (!hasPluginHooks && !hasPromptHooks) return { allowed: true, text: userText };
    let config: AppConfig;
    try {
      config = readEffectiveConfig(appHome);
    } catch {
      // Can't read config to run enforcement → fail CLOSED (don't inject unfiltered).
      // Not terminal: a transient read error may clear on a later retry.
      return { allowed: false, text: userText, reason: 'Failed to load config for policy enforcement.' };
    }
    // Overlay the ACTIVE run's execution mode (e.g. a per-thread `plan-first`
    // override while global config is `auto`) so a mode-aware plugin pre-send hook
    // sees the same mode the running turn built via configWithExecutionMode — else
    // it could allow/rewrite an injected message differently than a normal send.
    if (ctx?.executionMode) {
      config = { ...config, tools: { ...config.tools, executionMode: ctx.executionMode } };
    }
    // Gate under the ACTIVE run's model + system prompt (a model/prompt-conditioned
    // DLP hook must see the same context a normal turn shows it), falling back to
    // the configured default only when the run context is unknown.
    const resolvedModelKey = ctx?.modelKey ?? config.models.defaultModelKey;
    // The ACTIVE run's system prompt is ALREADY the hook's OUTPUT (the run applied
    // UserPromptSubmit / plugin pre-send hooks when it started). Feeding that back
    // INTO the hooks here would double-apply a prompt-deriving hook (e.g. a suffix
    // `…|fixture` becomes `…|fixture|fixture`), so the equality check below would
    // flag every message as a "prompt change" and block it. So distinguish:
    //   • hookInputPrompt — the PRE-hook base the hooks receive as input, the SAME
    //     input the active run fed its own hooks (ctx.preHookSystemPrompt, i.e.
    //     streamConfig.systemPrompt ?? config.systemPrompt — a chat/profile/thread
    //     override, NOT the legacy config default). Feeding the legacy default here
    //     when the run used an override would leave effectivePrompt !== the run's
    //     post-hook prompt even for an allow-only hook, wrongly blocking every send.
    //   • runPostHookPrompt — the active run's post-hook prompt (ctx.systemPrompt),
    //     the BASELINE to compare the gate's hook output against. If they match,
    //     this message didn't cause a message-specific prompt change → allow.
    const hookInputPrompt = ctx?.preHookSystemPrompt ?? config.systemPrompt ?? '';
    const runPostHookPrompt = ctx?.systemPrompt ?? hookInputPrompt;
    // Gate the injected turn ALONE (no history). Prepending the disk-read active
    // branch (a prior attempt) was unsound: the disk snapshot lags Mastra's LIVE
    // prepareStep transcript during CLI turns / the GUI persist-debounce window (so a
    // history-dependent policy would gate against STALE context), and a same-length
    // reordering hook could move the injected turn off the last position (so a
    // position-based extract would enqueue the wrong text). The gate can't
    // synchronously reach the run's live transcript from this IPC handler, so it
    // enforces on the injected turn in isolation — a bounded, well-defined contract:
    // a history-dependent hook sees only the new turn mid-inject (documented), which
    // is strictly safer than enforcing against a stale/misordered reconstruction.
    const historyLen = 0;
    let payload: unknown[] = [{ role: 'user', content: [{ type: 'text', text: userText }] }];
    // Track any hook rewrite of the system prompt. A cooperative inject splices
    // into an ALREADY-RUNNING turn whose system prompt is fixed — we CANNOT honor
    // a content-dependent prompt rewrite for this message the way a normal
    // submission would. So if either hook changes the prompt (vs. the run's
    // post-hook baseline), FAIL CLOSED rather than send the text under a prompt the
    // policy didn't intend.
    let effectivePrompt = hookInputPrompt;
    // 1) Plugin pre-send middleware (messages:hook). An abort denies the inject; a
    //    rewrite of the sole user message is honored.
    if (hasPluginHooks && pluginManager) {
      try {
        const hookResult = await pluginManager.runPreSendHooks({
          messages: payload as unknown as HookMessage[],
          modelKey: resolvedModelKey,
          config,
          systemPrompt: hookInputPrompt,
        });
        if (hookResult.abort)
          return { allowed: false, text: userText, reason: 'A plugin blocked this message.', terminal: true };
        if (Array.isArray(hookResult.messages)) payload = hookResult.messages as unknown[];
        if (typeof hookResult.systemPrompt === 'string') effectivePrompt = hookResult.systemPrompt;
      } catch {
        return {
          allowed: false,
          text: userText,
          reason: 'A plugin errored while checking this message.',
          terminal: true,
        };
      }
    }
    // 2) UserPromptSubmit DLP gate LAST (authoritative over the final payload).
    //    Run it under the prompt the plugin stage produced (mirrors the normal
    //    turn's order), and capture any further prompt rewrite it makes.
    if (hasPromptHooks) {
      const gated = await gateMessagesThroughUserPromptSubmit(
        payload,
        config,
        conversationId,
        resolvedModelKey,
        'mid-turn-inject',
        effectivePrompt,
      );
      if (gated.suppressed)
        return { allowed: false, text: userText, reason: 'A policy hook blocked this message.', terminal: true };
      payload = gated.messages;
      if (typeof gated.systemPrompt === 'string') effectivePrompt = gated.systemPrompt;
    }
    // A message-specific prompt rewrite can't be applied to the running turn a
    // cooperative inject splices into — but this is NOT a DENIAL: a fresh
    // abort+restart turn WOULD honor the content-dependent rewrite. So flag it as
    // requiresRestart (cooperatively unrepresentable) rather than terminal (blocked),
    // so a normal caller restarts and a cooperative-only raced answer is RETAINED for
    // its successor instead of being purged as policy-blocked (R99 finding-2).
    if (effectivePrompt !== runPostHookPrompt) {
      return {
        allowed: false,
        text: userText,
        reason: 'A policy hook changed the system prompt for this message; it cannot be injected mid-turn.',
        requiresRestart: true,
      };
    }
    // Extract the (possibly-redacted) text of the surviving INJECTED user turn (the
    // last message, after `historyLen` history messages). If a hook REMOVED it or
    // ADDED messages around it, treat as cooperatively-unrepresentable (requiresRestart),
    // NOT a denial — a fresh turn re-runs the hooks and can honor the reshaping (R99).
    const resolved = resolveInjectedTextFromGatedPayload(payload, historyLen);
    if (!resolved.allowed)
      return {
        allowed: false,
        text: userText,
        reason: 'A policy hook reshaped this message; it cannot be injected mid-turn.',
        requiresRestart: true,
      };
    // The gate awaited async hooks. If a mid-stream model-fallback changed the
    // ACTIVE run's model during that await, the decision we just made was for the
    // OLD model — a model-conditioned hook could allow text the new model should
    // block. The stream token/runtime are unchanged by a fallback (same run), so
    // the caller's token revalidation won't catch this. Only when we gated under
    // the LIVE run's model (revalidateLiveModel — NOT a caller-forced model, e.g.
    // an automation that intentionally pins a model): compare the model key we
    // gated under against the current one and fail closed on a mismatch (the
    // caller re-reads context + retries / falls back). Not terminal — a retry
    // under the new model may pass.
    if (ctx?.revalidateLiveModel && ctx.modelKey !== undefined) {
      const currentModelKey = getActiveRunContext(conversationId)?.modelKey;
      if (currentModelKey !== undefined && currentModelKey !== ctx.modelKey) {
        return {
          allowed: false,
          text: userText,
          reason: 'The active model changed during policy enforcement; re-evaluate under the new model.',
        };
      }
    }
    return { allowed: true, text: resolved.text };
  };

  // Wire the raced/aborted ask_user recovery router so a non-Mastra runtime (the
  // Claude Agent SDK ask_user handler) can route a late answer through the durable
  // recovered-answer path instead of orphaning it in the bounded stash (R93).
  setAskUserRecoveryRouter(recoverAskUserAnswerForRuntime);
  setActiveStreamTokenAccessor(getActiveStreamToken);
  // Wire the plan-mode DISMISS handler so the SDK runtime's exit_plan_mode dismiss
  // (R122 finding-4) leaves plan mode authoritatively in MAIN. The SDK worker can
  // only return an MCP error; MAIN must persist+broadcast `auto`, mark the turn
  // terminal (a late raced answer/inject must not resurrect a dismissed planning
  // turn), and abort the still-running SDK query — there is no plan to execute, so
  // the turn is done. Token-scoped: a stale dismiss (the run was already superseded
  // by the time the user tapped "exit plan mode") only persists+broadcasts the mode
  // and does NOT abort/mark-terminal a DIFFERENT owning run.
  setPlanModeDismissHandler((conversationId, streamToken) => {
    // Persisting+broadcasting `auto` is safe regardless of which run is active —
    // the user asked to leave plan mode for this conversation.
    broadcastExecutionMode('auto', conversationId);
    // Only tear down the query when the dismiss still owns the active run. If a
    // successor already replaced it, its token no longer matches and we must not
    // abort/terminal-mark the successor's run.
    const entry = activeStreams.get(conversationId);
    if (streamToken !== undefined && entry?.token !== streamToken) return;
    if (streamToken !== undefined) markTokenTerminalAbort(streamToken);
    bumpExplicitCancelGeneration(conversationId);
    entry?.abort();
  });
  // Capture appHome so resolveEffectiveRuntimeId can read config lazily (R94).
  appHomeForRuntimeResolve = appHome;

  injectUserTurnAndRestart = async (conversationId, userText, opts) => {
    // Automations are background principals, not the native Browser renderer.
    // Reject synchronously before enqueueing, finalizing a partial reply,
    // appending history, or arming server persistence. The initiator bit is
    // sticky after Browser-tool revocation, so a still-private turn cannot be
    // taken over merely because its tool list was downgraded.
    if (!mayInjectAutomationIntoActiveStream(activeStreams.get(conversationId))) {
      return { ok: false, error: 'native-browser-authority-required' };
    }
    const existingConv = readConversation(appHome, conversationId);
    if (!existingConv) return { ok: false, error: 'conversation-not-found' };
    // Cancel generation at ENTRY. The abort+restart path below awaits a policy gate;
    // if the user presses Stop during that await, the generation bumps. Revalidated
    // immediately before the restart launches so a durable-recovery re-injection (a
    // late ask_user answer) can NOT start a new tool-enabled turn after an explicit
    // Stop landed mid-gate (R105 finding-3). Cooperative splice has its own
    // terminalAbortTokens/ownership guards; this covers the fresh-turn restart.
    const cancelGenAtEntry = captureCancelGeneration(conversationId);
    // PUSH token (R135): the numeric capture above can miss a Stop whose map entry is evicted
    // under a 500+ concurrent-Stop flood during the policy-gate await. Hold a token from here to
    // the pre-restart re-check; a Stop flips it regardless of map eviction. Released at the
    // re-check (its guard window ends there — the restart launches synchronously after).
    const injectCancelToken = registerCancelGenToken(conversationId);

    // COOPERATIVE mid-turn injection (Mastra runtime only): if a Mastra turn is
    // still generating, splice the follow-up into the RUNNING turn at its next
    // step boundary instead of aborting. Enqueue the message (prepareStep drains
    // it — see inject-queue.ts + prepare-step-inject.ts), persist + broadcast the
    // user turn so it renders immediately, and let the live turn continue. The
    // CLI runtimes can't be stepped, so they fall through to abort+restart below.
    const cooperativeOnly = opts?.cooperativeOnly === true;
    // A cooperative-only caller (raced-answer delivery) that finds no cooperatively
    // injectable Mastra run, or whose expected token no longer owns the stream,
    // must NOT abort+restart — a stale ask_user answer must never abort a newer run
    // or restart after a Stop. Fail delivery instead (the answer stays stashed).
    if (
      cooperativeOnly &&
      (!isCooperativelyInjectable(conversationId) ||
        (opts?.expectedToken !== undefined && activeStreams.get(conversationId)?.token !== opts.expectedToken))
    ) {
      releaseCancelGenToken(injectCancelToken);
      return { ok: false, notCooperative: true };
    }
    if (isCooperativelyInjectable(conversationId)) {
      // Enforce the same plugin pre-send + UserPromptSubmit policy a normal turn
      // applies before this text is spliced into the running turn (prepareStep
      // does NOT re-gate spliced text). A DENY rejects the inject; a redaction
      // replaces the text that is enqueued/persisted/broadcast. Gate under the
      // ACTIVE run's model + system prompt so a model/prompt-conditioned hook sees
      // the same context a normal turn shows it.
      const tokenBeforeGate = activeStreams.get(conversationId)?.token;
      // Capture the disk head before the async gate: a rewind / variant switch during
      // a slow policy hook moves the head WITHOUT changing the stream token, so the
      // token check below wouldn't catch it and the splice would land on a divergent
      // branch while the running turn consumes it on the old one (mirror of the
      // renderer-facing agent:inject-mid-turn guard).
      const headBeforeGate = readConversation(appHome, conversationId)?.headId ?? null;
      const runCtx = getActiveRunContext(conversationId);
      // A cooperative splice injects into the UNCHANGED live run — so it must be
      // gated (and will execute) under the LIVE run's full context, NOT a caller
      // override. If the caller (e.g. a busy-target automation / recovered-answer
      // resume) pinned overrides that would resolve to a DIFFERENT effective context
      // than the live run, cooperative splicing would run the text under the wrong
      // settings — fall through to abort+restart so the caller's context is honored
      // on a fresh turn. Compare RESOLVED fingerprints (not raw optional inputs):
      // that closes the default-vs-pinned hole (a pinned profile B vs a live
      // default-profile-A run differ even though runCtx has no raw profileKey) and
      // covers every behavior-affecting override — temperature / systemPrompt /
      // maxSteps / maxRetries / reasoning / fallback / runtime / cwd / mode (R97).
      // A caller that pinned NOTHING (all overrides undefined — a plain cooperative
      // inject / raced-answer delivery) skips the check and always splices: it has no
      // intent to change context, and a defaults-vs-live-nondefault fingerprint
      // mismatch must not force a needless restart.
      const callerPinnedAnyOverride =
        opts?.modelKey !== undefined ||
        opts?.profileKey !== undefined ||
        opts?.reasoningEffort !== undefined ||
        opts?.cwd !== undefined ||
        opts?.executionMode !== undefined ||
        // A fallback-only caller (e.g. an automation whose fresh semantics set
        // fallbackEnabled:false vs a live fallback-enabled run) must also trigger the
        // fingerprint comparison — otherwise it would cooperatively splice and run
        // through a fallback model contrary to its config (R108 finding-2).
        opts?.fallbackEnabled !== undefined ||
        (opts?.threadOverrides !== undefined &&
          (opts.threadOverrides.temperature != null ||
            opts.threadOverrides.systemPromptOverride != null ||
            opts.threadOverrides.maxSteps != null ||
            opts.threadOverrides.maxRetries != null ||
            opts.threadOverrides.runtimeOverride != null));
      let overrideDiffersFromLive = false;
      // Set inside the fingerprint block below when the caller pinned overrides:
      // recomputes the caller-vs-live fingerprint AFTER the async policy gate to catch
      // a mid-gate context drift the token/head ownership check can't see (R100 f-2).
      let recheckContextAfterGate: (() => boolean) | null = null;
      if (callerPinnedAnyOverride && runCtx?.contextFingerprint !== undefined) {
        // Build the caller's would-be EFFECTIVE context EXACTLY as the abort+restart
        // path (below) merges it: caller opts take precedence, omitted fields fall
        // back to the conversation's persisted values — NOT global defaults. Using
        // globals for an omitted field (e.g. cwd) would spuriously mismatch a live
        // run that inherited the conversation's cwd and needlessly abort in-flight
        // tool work (R98 finding-1). fallbackEnabled comes from the conversation the
        // same way the restart reads updated.fallbackEnabled (R98 finding-2).
        type ConvMerge = {
          selectedModelKey?: string | null;
          selectedProfileKey?: string | null;
          currentWorkingDirectory?: string | null;
          fallbackEnabled?: boolean;
          executionMode?: ExecutionMode | null;
          temperature?: number | null;
          systemPromptOverride?: string | null;
          maxSteps?: number | null;
          maxRetries?: number | null;
          runtimeOverride?: string | null;
        };
        const mergeThreadOverrides = (c: ConvMerge) =>
          opts?.threadOverrides ?? {
            ...(typeof c.temperature === 'number' ? { temperature: c.temperature } : {}),
            ...(typeof c.systemPromptOverride === 'string' ? { systemPromptOverride: c.systemPromptOverride } : {}),
            ...(typeof c.maxSteps === 'number' ? { maxSteps: c.maxSteps } : {}),
            ...(typeof c.maxRetries === 'number' ? { maxRetries: c.maxRetries } : {}),
            ...(typeof c.runtimeOverride === 'string' ? { runtimeOverride: c.runtimeOverride } : {}),
          };
        const cfgBefore = readEffectiveConfig(appHome);
        const convBefore = existingConv as ConvMerge;
        const toBefore = mergeThreadOverrides(convBefore);
        const modelBefore = opts?.modelKey ?? convBefore.selectedModelKey ?? undefined;
        const profileBefore = opts?.profileKey ?? convBefore.selectedProfileKey ?? undefined;
        const fallbackBefore = opts?.fallbackEnabled ?? convBefore.fallbackEnabled ?? false;
        // Resolve the caller's EFFECTIVE runtime the same authoritative way streamHandler
        // does (resolveRuntimeForStream, honoring a thread runtimeOverride overlay +
        // model-based auto resolution) — NOT a hardcoded 'mastra', which would let an
        // auto+Anthropic-model caller (→ claude-agent-sdk) spuriously match a live Mastra
        // run and splice under the wrong runtime (R98 finding-3).
        let callerRuntimeId = 'mastra';
        try {
          const sc = resolveStreamConfig(cfgBefore, {
            threadModelKey: modelBefore ?? null,
            threadProfileKey: profileBefore ?? null,
            reasoningEffort: opts?.reasoningEffort,
            fallbackEnabled: fallbackBefore,
            ...(toBefore ? { threadOverrides: toBefore } : {}),
          });
          const runtimeCfg = toBefore.runtimeOverride
            ? ({ ...cfgBefore, agent: { ...cfgBefore.agent, runtime: toBefore.runtimeOverride } } as AppConfig)
            : cfgBefore;
          const { resolution } = await resolveRuntimeForStream(runtimeCfg, sc?.primaryModel ?? null);
          // Canonical descriptor (with provider/inference overrides), matching what
          // the live run's fingerprint records — bare runtimeId would conflate a
          // provider-override run with plain Mastra (R101 finding-5).
          callerRuntimeId = runtimeDispatchDescriptor(resolution);
        } catch {
          callerRuntimeId = '__unresolved__';
        }
        // Re-read config + conversation AFTER the await and compute the caller
        // fingerprint from those CURRENT values. A metadata-only settings/conversation
        // update during resolveRuntimeForStream changes neither the stream token nor the
        // head (so the post-gate ownership check wouldn't catch it), but it DOES change
        // what a fresh restart would run under — so computing the fingerprint from the
        // post-await state makes such drift produce a mismatch and force restart, rather
        // than cooperatively splicing under a now-stale context (R99 finding-1). Also
        // re-read the live fingerprint: a supersession during the await would carry its
        // own fingerprint / no longer be Mastra.
        const cfgNow = readEffectiveConfig(appHome);
        const convNow = (readConversation(appHome, conversationId) ?? convBefore) as ConvMerge;
        const toNow = mergeThreadOverrides(convNow);
        const mergedModelKey = opts?.modelKey ?? convNow.selectedModelKey ?? undefined;
        const mergedProfileKey = opts?.profileKey ?? convNow.selectedProfileKey ?? undefined;
        const mergedCwd = normalizeAgentCwd(opts?.cwd ?? convNow.currentWorkingDirectory ?? undefined);
        const mergedMode = opts?.executionMode ?? convNow.executionMode ?? runCtx.executionMode ?? 'auto';
        const mergedFallback = opts?.fallbackEnabled ?? convNow.fallbackEnabled ?? false;
        // The runtime was resolved from the PRE-await snapshot (cfgBefore/toBefore).
        // If any runtime-determining input drifted during the await — global
        // agent.runtime, the merged runtimeOverride, the model, or the profile — that
        // resolution is stale, so a fresh restart could pick a DIFFERENT runtime.
        // Invalidate it (→ '__unresolved__' → forced restart) rather than compare a
        // fingerprint built on a stale runtime (R100 finding-1).
        const runtimeInputsDrifted =
          (cfgNow.agent?.runtime ?? 'auto') !== (cfgBefore.agent?.runtime ?? 'auto') ||
          (toNow.runtimeOverride ?? null) !== (toBefore.runtimeOverride ?? null) ||
          mergedModelKey !== modelBefore ||
          mergedProfileKey !== profileBefore ||
          mergedFallback !== fallbackBefore;
        if (runtimeInputsDrifted) callerRuntimeId = '__unresolved__';
        const liveCtxNow = getActiveRunContext(conversationId);
        const callerFingerprint =
          callerRuntimeId === '__unresolved__'
            ? '__unresolved__'
            : computeRunContextFingerprint(cfgNow, callerRuntimeId, mergedCwd, mergedMode, {
                modelKey: mergedModelKey,
                profileKey: mergedProfileKey,
                reasoningEffort: opts?.reasoningEffort,
                fallbackEnabled: mergedFallback,
                threadOverrides: toNow,
              });
        // An unresolved fingerprint on EITHER side is not trustworthy for equality
        // (both could be the '__unresolved__' sentinel and spuriously match) — treat
        // it as a difference so the inject fails safe toward abort+restart (R98).
        overrideDiffersFromLive =
          liveCtxNow?.contextFingerprint === undefined ||
          callerFingerprint === '__unresolved__' ||
          liveCtxNow.contextFingerprint === '__unresolved__' ||
          callerFingerprint !== liveCtxNow.contextFingerprint;
        // Post-gate drift recheck (R100 finding-2): the policy gate below is a SECOND
        // await; the conversation's context can drift during it WITHOUT changing the
        // token/head (so the ownership check misses it). Recompute the caller
        // fingerprint synchronously from the CURRENT conversation + config after the
        // gate (reusing the pre-gate resolved runtime — a runtime flip mid-gate is a
        // far narrower window and still fails safe) and, if it no longer equals the
        // live run's fingerprint, force abort+restart so the splice can't run under a
        // now-stale context.
        recheckContextAfterGate = () => {
          if (callerRuntimeId === '__unresolved__') return true;
          const cfg2 = readEffectiveConfig(appHome);
          const conv2 = (readConversation(appHome, conversationId) ?? convNow) as ConvMerge;
          const to2 = mergeThreadOverrides(conv2);
          const model2 = opts?.modelKey ?? conv2.selectedModelKey ?? undefined;
          const profile2 = opts?.profileKey ?? conv2.selectedProfileKey ?? undefined;
          // callerRuntimeId was resolved from the PRE-gate snapshot. If any
          // runtime-determining input changed during the gate — global agent.runtime,
          // the merged runtimeOverride, the model, or the profile — that descriptor is
          // stale and computeRunContextFingerprint below would embed the WRONG runtime
          // (possibly matching the live run and splicing into the obsolete runtime).
          // Fail safe: force restart on any such drift (R101 finding-6).
          if (
            (cfg2.agent?.runtime ?? 'auto') !== (cfgBefore.agent?.runtime ?? 'auto') ||
            (to2.runtimeOverride ?? null) !== (toBefore.runtimeOverride ?? null) ||
            model2 !== modelBefore ||
            profile2 !== profileBefore
          ) {
            return true;
          }
          const fp2 = computeRunContextFingerprint(
            cfg2,
            callerRuntimeId,
            normalizeAgentCwd(opts?.cwd ?? conv2.currentWorkingDirectory ?? undefined),
            opts?.executionMode ?? conv2.executionMode ?? getActiveRunContext(conversationId)?.executionMode ?? 'auto',
            {
              modelKey: model2,
              profileKey: profile2,
              reasoningEffort: opts?.reasoningEffort,
              fallbackEnabled: opts?.fallbackEnabled ?? conv2.fallbackEnabled ?? false,
              threadOverrides: to2,
            },
          );
          const liveFp2 = getActiveRunContext(conversationId)?.contextFingerprint;
          return liveFp2 === undefined || fp2 === '__unresolved__' || liveFp2 === '__unresolved__' || fp2 !== liveFp2;
        };
      }
      if (overrideDiffersFromLive && !cooperativeOnly) {
        // Skip cooperative splice; fall through to abort+restart with the override.
      } else {
        const gate = await gateInjectedUserText(conversationId, userText, {
          // Gate under the LIVE run's context — the splice lands in that run.
          modelKey: runCtx?.modelKey,
          systemPrompt: runCtx?.systemPrompt,
          preHookSystemPrompt: runCtx?.preHookSystemPrompt,
          executionMode: runCtx?.executionMode,
          // Revalidate against a mid-stream model change during the async gate.
          revalidateLiveModel: true,
        });
        // Compute ownership change FIRST — a terminal policy denial must be
        // re-interpreted through it. If the run we gated for is GONE (token/runtime/
        // branch changed during the async gate), a `terminal` block was decided
        // against a STALE run: for a cooperative-only raced answer, treating it as
        // terminal would PURGE the only copy of the answer instead of retrying it
        // against the actual successor. So classify ownership before acting on the
        // denial. (Branch check is descendant-aware: same-run debounced head
        // advancement is NOT a switch — see injectHeadStillOnBranch.)
        const ownershipChanged =
          activeStreams.get(conversationId)?.token !== tokenBeforeGate ||
          !isCooperativelyInjectable(conversationId) ||
          (opts?.expectedToken !== undefined && activeStreams.get(conversationId)?.token !== opts.expectedToken) ||
          !injectHeadStillOnBranch(appHome, conversationId, headBeforeGate, getActiveRunResponseIds(conversationId));
        let gateForcedFallthrough = false;
        if (!gate.allowed) {
          // A terminal block is only truly terminal if we STILL own the run it was
          // decided against. If ownership changed, report transient so a raced answer
          // retries against the successor (cooperativeOnly) / a normal caller re-gates
          // on the fresh turn — never purge the answer on a stale-run denial.
          if (gate.terminal && !ownershipChanged) {
            releaseCancelGenToken(injectCancelToken);
            return { ok: false, error: gate.reason ?? 'blocked-by-policy', blockedByPolicy: true };
          }
          if (cooperativeOnly) {
            releaseCancelGenToken(injectCancelToken);
            return { ok: false, notCooperative: true };
          }
          gateForcedFallthrough = true;
        }
        // The gate awaited hooks; the turn may have finished/superseded meanwhile. If
        // this conversation's active token changed (or the run ended / branch diverged),
        // the run we resolved as cooperatively-injectable is gone — enqueueing now would
        // strand the text (no prepareStep to drain it) or splice it into a DIFFERENT run
        // than the one we gated for. Also fall through if the caller's effective context
        // drifted DURING the gate (R100 finding-2): a splice would run under a now-stale
        // context a fresh restart wouldn't. cooperativeOnly callers pin nothing, so
        // recheckContextAfterGate is null for them (never forces a needless fallthrough).
        const contextDriftedDuringGate = recheckContextAfterGate?.() ?? false;
        if (gateForcedFallthrough || ownershipChanged || contextDriftedDuringGate) {
          // Cooperative-only (raced answer): FAIL rather than abort+restart, so the
          // stale answer can't restart a stopped run or abort a newer one.
          if (cooperativeOnly) {
            releaseCancelGenToken(injectCancelToken);
            return { ok: false, notCooperative: true };
          }
          // Otherwise fall through to abort+restart. Use the ORIGINAL userText (NOT
          // gate.text): the fresh turn re-runs plugin pre-send + UserPromptSubmit as
          // part of its normal flow, so passing the already-gated text would apply
          // non-idempotent redaction/prefix hooks TWICE (and could desync persisted
          // text from model input). Enforcement happens exactly once, on the fresh turn.
          // (userText is left unchanged — just fall through.)
        } else {
          const injectText = gate.text;
          const injectId = enqueueInject(conversationId, injectText, opts?.userTurnId);
          if (!injectId) {
            releaseCancelGenToken(injectCancelToken);
            return { ok: false, error: 'failed-to-enqueue' };
          }
          // Make acceptance FAILURE-ATOMIC (R104 finding-1): the entry is live in the
          // queue the moment it's enqueued, so if persist/broadcast throws we must not
          // return a plain failure (the renderer would then fallback-send a duplicate
          // while the running turn drains this same inject). On any throw: if the entry
          // was ALREADY drained/committed (on-branch by id), report success; else
          // remove the queued entry so no duplicate can drain, then fall through to the
          // abort+restart path.
          try {
            const activeToken = activeStreams.get(conversationId)?.token;
            const serverOwnsPersistence = isServerPersistOwner(conversationId, activeToken);
            let persistedMeta: { messageId: string; parentId?: string | null; createdAt?: string } | null = {
              messageId: injectId,
              // For deferred server-owned persistence, omit the stale disk parent so a
              // co-viewing renderer keeps its current live assistant head.
              ...(serverOwnsPersistence ? {} : { parentId: existingConv.headId ?? null }),
              createdAt: new Date().toISOString(),
            };
            if (!serverOwnsPersistence) {
              const write = appendConversationMessages(
                appHome,
                conversationId,
                [
                  {
                    id: injectId,
                    role: 'user',
                    content: [{ type: 'text', text: injectText }],
                    createdAt: persistedMeta.createdAt,
                  },
                ],
                // Keep runStatus 'running' — the turn is still live; we're extending it.
                { runStatus: 'running' },
              );
              if (write?.headId) {
                const messageId = write.headId;
                const node = (
                  (write.messageTree ?? []) as Array<{ id?: string; parentId?: string | null; createdAt?: string }>
                ).find((message) => message.id === messageId);
                persistedMeta = {
                  messageId,
                  parentId: node?.parentId ?? null,
                  createdAt: node?.createdAt ?? persistedMeta.createdAt,
                };
              } else {
                persistedMeta = null;
              }
            }
            if (!persistedMeta) {
              removeInject(conversationId, injectId);
              // Conversation vanished between the runtime check and the write — the run
              // is effectively gone; fall through to the abort+restart path which
              // re-reads + handles a missing conversation cleanly.
            } else {
              // Record this inject's node ids as THIS run's own lineage immediately, so a
              // SECOND overlapping mid-turn send whose head advanced to this inject node
              // isn't misread as a branch switch (see the agent:inject-mid-turn handler).
              if (activeToken !== undefined) {
                recordInjectBoundaryLineage(conversationId, activeToken, injectId);
                if (persistedMeta.messageId !== injectId)
                  recordInjectBoundaryLineage(conversationId, activeToken, persistedMeta.messageId);
              }
              // Broadcast is best-effort: the inject is already enqueued + persisted, so a
              // broadcast throw must NOT unwind acceptance (that would drop a co-viewer's
              // render but the turn still consumes the inject) — swallow it.
              try {
                broadcastStreamEvent({
                  conversationId,
                  type: 'user-message',
                  text: injectText,
                  data: persistedMeta,
                });
              } catch {
                /* best-effort mirror; acceptance already succeeded */
              }
              releaseCancelGenToken(injectCancelToken);
              return { ok: true, injectedCooperatively: true };
            }
          } catch {
            // persist threw. If the running turn ALREADY drained + committed this inject
            // (its node id is on the tree), acceptance genuinely succeeded — report ok so
            // the caller does NOT fallback-send a duplicate. Otherwise remove the still-
            // queued entry so nothing drains it, and fall through to abort+restart.
            const tree = (readConversation(appHome, conversationId)?.messageTree ?? []) as Array<{ id?: unknown }>;
            if (tree.some((m) => m?.id === injectId)) {
              // Committed despite the throw — record the boundary lineage the normal
              // path would have, so an overlapping slow-gated inject doesn't misread
              // the advanced head as a branch switch (R106 finding-2).
              const tok = activeStreams.get(conversationId)?.token;
              if (tok !== undefined) recordInjectBoundaryLineage(conversationId, tok, injectId);
              releaseCancelGenToken(injectCancelToken);
              return { ok: true, injectedCooperatively: true };
            }
            removeInject(conversationId, injectId);
          }
        }
      }
    }

    // Revalidate the cancel generation before we abort+restart: if an explicit Stop
    // bumped it since entry (e.g. while a durable-recovery re-injection awaited its
    // policy gate), the user ended this conversation's turn — do NOT abort a run and
    // launch a fresh tool-enabled turn for a now-stopped conversation (R105 finding-3). The
    // PUSH token (R135) catches a Stop whose bounded stop-map entry was evicted during the gate
    // await; the numeric compare is the secondary signal. Release the token here — its guard
    // window ends (the abort+restart below is synchronous, no further Stop-race to catch).
    const stoppedDuringInject =
      injectCancelToken.cancelled || cancelGenerationChanged(conversationId, cancelGenAtEntry);
    releaseCancelGenToken(injectCancelToken);
    if (stoppedDuringInject) {
      return { ok: false, error: 'conversation-stopped-during-injection' };
    }

    // If a turn is still generating into this conversation, PRESERVE its
    // in-progress reply as its own (interrupted) turn before we abort + restart.
    // Without this, the fresh run's discardPersistenceAccumulator (in
    // streamHandler) would throw the partial away, the model wouldn't see the
    // work it had already started, and the two runs' deltas would concatenate in
    // the renderer. UPSERT-by-id (not a plain append): a GUI turn's ~300ms debounced
    // stream-persist may ALREADY have written this run's assistant node (still
    // 'running') to disk, so a plain finalize would id-collision-remint it into a
    // duplicate `auto-msg-*` sibling that the resumed prompt then parents onto
    // (R121 finding-2). Upsert replaces by id, or falls through to a normal append
    // when no such node exists yet. So the new user turn parents cleanly on top:
    // …user1 → assistant1(interrupted) → user2 → assistant2.
    if (activeStreams.has(conversationId)) {
      finalizeInterruptedTurnUpsert(appHome, conversationId);
    }

    const promptWrite = appendConversationMessages(
      appHome,
      conversationId,
      [
        {
          ...(opts?.userTurnId ? { id: opts.userTurnId } : {}),
          role: 'user',
          content: [{ type: 'text', text: userText }],
        },
      ],
      { runStatus: 'running' },
    );
    if (!promptWrite) return { ok: false, error: 'conversation-not-found' };

    // NOTE: we intentionally do NOT broadcast the user-message here. streamHandler
    // below emits it TOKEN-TAGGED with the restarted run's generation (this turn is
    // NOT in serverPersistSelfMirrored), which a renderer locked to the aborted
    // predecessor needs to adopt the successor as a takeover instead of rejecting its
    // events (R108 finding-1). An untagged pre-stream mirror (the earlier R107 fix)
    // carried no generation and so couldn't drive that takeover.

    const updated = readConversation(appHome, conversationId);
    if (!updated) return { ok: false, error: 'conversation-not-found' };
    const { tree, headId } = ensureConversationTree(updated);
    const branch = getConversationBranch(tree, headId);

    // Server-persist the assistant reply (no renderer for an automation turn).
    // streamHandler binds this to the run's token so a superseding run can't
    // inherit it; parent the reply on the injected user head.
    pendingServerPersist.add(conversationId);
    pendingServerPersistParent.set(conversationId, headId);

    // Honor the conversation's own per-thread overrides on the restart (R93): the
    // caller may pin them (recovered/alert answer), otherwise fall back to the
    // values persisted on the conversation so an abort+restart doesn't revert to
    // global/profile defaults for temperature / prompt / step limits / runtime.
    const updatedOverrides = updated as {
      temperature?: number | null;
      systemPromptOverride?: string | null;
      maxSteps?: number | null;
      maxRetries?: number | null;
      runtimeOverride?: string | null;
    };
    const restartThreadOverrides = opts?.threadOverrides ?? {
      ...(typeof updatedOverrides.temperature === 'number' ? { temperature: updatedOverrides.temperature } : {}),
      ...(typeof updatedOverrides.systemPromptOverride === 'string'
        ? { systemPromptOverride: updatedOverrides.systemPromptOverride }
        : {}),
      ...(typeof updatedOverrides.maxSteps === 'number' ? { maxSteps: updatedOverrides.maxSteps } : {}),
      ...(typeof updatedOverrides.maxRetries === 'number' ? { maxRetries: updatedOverrides.maxRetries } : {}),
      ...(typeof updatedOverrides.runtimeOverride === 'string'
        ? { runtimeOverride: updatedOverrides.runtimeOverride }
        : {}),
    };

    await streamHandler(
      undefined,
      conversationId,
      branch,
      opts?.modelKey ?? updated.selectedModelKey ?? undefined,
      opts?.reasoningEffort,
      opts?.profileKey ?? updated.selectedProfileKey ?? undefined,
      opts?.fallbackEnabled ?? updated.fallbackEnabled,
      opts?.cwd ?? updated.currentWorkingDirectory ?? undefined,
      opts?.executionMode ?? (updated as { executionMode?: ExecutionMode }).executionMode,
      Object.keys(restartThreadOverrides).length > 0 ? restartThreadOverrides : undefined,
    );
    return { ok: true };
  };

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
        /** Force a specific agent runtime for this turn (CLI --runtime). */
        runtimeOverride?: string;
        /** Optional image attachments (CLI @image / paste / AppShots). Each
         *  `image` is a data URL or base64 string; appended as image parts to
         *  the user message so vision-capable models receive them. */
        attachments?: Array<{ image: string; mimeType?: string }>;
        /** Opaque per-submit id from the originating client. Echoed back in the
         *  broadcast `user-message` stream event so that client can skip
         *  re-rendering its own optimistic local turn (other clients render it). */
        submitNonce?: string;
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
      if (
        currentPendingSubmit.has(conversationId) ||
        activeStreams.has(conversationId) ||
        isRealtimeConversationTurnActive(conversationId)
      ) {
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
        activeStreams.has(conversationId) ||
        isRealtimeConversationTurnActive(conversationId) ||
        isCompacting(conversationId)
      ) {
        // Distinguish a COMPACTION lock (drains on the conversations:compacting broadcast)
        // from an active TURN (drains on that turn's own terminal `done`) so a client can
        // wait on the RIGHT unlock signal instead of draining a queued prompt into the lock.
        const busyKind = isCompacting(conversationId) ? 'compaction' : 'turn';
        return { ok: false, error: 'conversation-busy', busyKind };
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
      // A retained Browser continuation has no activeStreams entry and its disk
      // status is idle, but its authenticated temporary tabs still belong to the
      // desktop renderer. Re-check that authority immediately before the
      // synchronous append so a web/CLI submit cannot durably move the head and
      // only then be rejected by streamHandler.
      if (!mayPersistConversationForBrowserAuthority(event, conversationId, getPrimaryWindow)) {
        return { ok: false, error: 'native-browser-authority-required' };
      }
      const promptWrite = appendConversationMessages(
        appHome,
        conversationId,
        [{ role: 'user', content: userContent }],
        { skipIfBusy: true, runStatus: 'running' },
      );
      if (!promptWrite) {
        // Lost the admission race: a turn started OR a /compact acquired the lock between the
        // check above and this append (appendConversationMessages rejects both). Report the RIGHT
        // busyKind — a compaction lock drains on the conversations:compacting broadcast, so the
        // CLI must busy-WAIT for it; without this it treats a compaction as a turn-busy and
        // RESUBMITS in a tight loop until the lock clears.
        const busyKind = isCompacting(conversationId) ? 'compaction' : 'turn';
        return { ok: false, error: 'conversation-busy', busyKind };
      }

      // The authoritative user-message id (the just-appended node = the new head) + its parent,
      // read from the write result, so the broadcast carries the SAME id the disk holds.
      const promptTree = Array.isArray(promptWrite.messageTree) ? promptWrite.messageTree : [];
      const promptUserId = promptWrite.headId ?? null;
      const promptUserParent =
        (
          promptTree.find((m) => (m as { id?: unknown }).id === promptUserId) as
            | { parentId?: string | null }
            | undefined
        )?.parentId ?? null;

      // Defer the user-message mirror to streamHandler so it is emitted TOKEN-TAGGED
      // (with this run's generation + the authoritative disk id), AFTER server-persist
      // ownership is bound — a pre-lock GUI accumulator needs the generation to adopt
      // the submit as a takeover instead of dropping the CLI run's tagged deltas as
      // foreign and launching its own stream (R111 finding-2). Hand streamHandler the
      // one-shot submitNonce so the originating client still dedups its optimistic echo.
      // (promptUserId/promptUserParent are recomputed by streamHandler from the branch.)
      void promptUserId;
      void promptUserParent;

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
      // NOT serverPersistSelfMirrored: we deferred the mirror to streamHandler (above),
      // so streamHandler SHOULD emit the token-tagged mirror. Pass the nonce through.
      if (opts?.submitNonce) pendingSubmitMirrorNonce.set(conversationId, opts.submitNonce);

      await streamHandler(
        event,
        conversationId,
        branch,
        opts?.modelKey ?? updated.selectedModelKey ?? undefined,
        opts?.reasoningEffort,
        opts?.profileKey ?? updated.selectedProfileKey ?? undefined,
        opts?.fallbackEnabled ?? updated.fallbackEnabled,
        opts?.cwd ?? updated.currentWorkingDirectory ?? undefined,
        // Fall back to the conversation's PERSISTED executionMode when the CLI submit
        // doesn't pin one — otherwise a plan-first conversation would silently run as
        // auto (exposing mutating tools) for a `kai` submit (R122 finding-2).
        opts?.executionMode ?? (updated as { executionMode?: ExecutionMode }).executionMode,
        opts?.runtimeOverride ? { runtimeOverride: opts.runtimeOverride } : undefined,
      );
      return { ok: true, conversationId };
    },
  );

  // Whether a live agent run (interactive stream, CLI/server-persisted submit, or
  // a pending pre-toolsReady submit) currently owns this conversation. The GUI
  // uses this to avoid clearing a `running` conversation it doesn't have a local
  // accumulator for (a headless CLI run it just connected to). Complements
  // automations.inFlight (automation runs). Does NOT cover automation runs — the
  // renderer checks both. Returns whether a stream is in flight AND whether it is
  // SERVER-PERSISTED (a CLI/automation turn main persists) vs a GUI turn (renderer-persisted).
  // A renderer that reloaded mid-turn needs this: a server-persisted in-flight turn is main-owned
  // (mark automationStreams, don't persist), but a GUI in-flight turn has NO renderer persisting
  // it after the reload — the reconnecting renderer must ADOPT it (own its persistence), not
  // treat it as main-owned (which would discard its terminal output + leave it stuck running).
  ipcMain.handle(
    'agent:in-flight',
    (_event, conversationId: string): { inFlight: boolean; serverPersisted: boolean } => {
      const inFlight = activeStreams.has(conversationId) || currentPendingSubmit.has(conversationId);
      const serverPersisted = serverPersistTokens.has(conversationId) || pendingServerPersist.has(conversationId);
      return { inFlight, serverPersisted };
    },
  );

  // Main-authoritative GUI continuation authorization. A renderer about to drive an auto-continue
  // (max-turns) or plan-restart asks main to authorize it for THIS turn (keyed by the run's stream
  // token, which the renderer knows as runGeneration). Main grants the FIRST asker per turn and
  // denies the rest — so with multiple clients, or a reloaded client that came back as a passive
  // mirror, exactly one drives the continuation and the run is never double-restarted. A crashed
  // winner simply isn't the one asking for the NEXT turn's authorization, so continuation resumes.
  ipcMain.handle(
    'agent:authorize-continuation',
    (event, conversationId: string, clientId: string, turnToken: string) => {
      const browserManager = getExistingBrowserManager();
      const browserAuthorityGeneration = browserManager?.getHostRendererAuthorityGeneration();
      const hasNativeBrowserAuthority =
        isPrimaryBrowserToolCaller(event, getPrimaryWindow) &&
        isNativeBrowserAuthorityCurrent(browserManager, browserAuthorityGeneration);
      if (!mayDriveBrowserContinuation(browserManager, conversationId, turnToken, hasNativeBrowserAuthority)) {
        return { authorized: false };
      }
      return { authorized: authorizeContinuation(conversationId, clientId, turnToken) };
    },
  );

  // Force main to FINALIZE its GUI persistence fallback for a conversation NOW and return the
  // confirmed head. A reloaded MIRROR that won continuation authorization must not continue from its
  // own PARTIAL (post-reload) accumulator — main holds the FULL turn. This synchronously flushes
  // main's fallback accumulator (the authoritative full reply) to disk and returns { confirmed:true,
  // headId } so the winner can reload that complete branch before continuing. Returns
  // { confirmed:false } when main has no fallback for this conv (the caller then uses its own
  // accumulator — it IS the originator, or the turn was server-persisted) OR when a REPLACEMENT turn
  // now owns the conversation (never finalize/discard a newer turn's accumulator).
  ipcMain.handle('agent:finalize-gui-fallback', (event, conversationId: string, turnToken?: string) => {
    if (typeof conversationId !== 'string' || !conversationId || !serverPersistAppHome) {
      return { confirmed: false, headId: null as string | null };
    }
    // Finalizing consumes main's crash-recovery accumulator and can persist a
    // still-partial assistant reply. A passive web/secondary renderer may see
    // the same runGeneration, but it must not mutate a Browser-authorized turn
    // owned by the primary desktop renderer.
    if (!mayMutateBrowserAuthorizedStream(event, activeStreams.get(conversationId), getPrimaryWindow)) {
      return { confirmed: false, headId: null as string | null };
    }
    // TURN-TOKEN guard: only finalize the turn the caller was authorized for. If a REPLACEMENT turn
    // is now the active stream (a different token), its accumulator must NOT be finalized/discarded
    // by this stale call — refuse. (No active stream = the turn ended; safe to finalize the fallback.)
    const activeToken = activeStreams.get(conversationId)?.token;
    if (typeof turnToken === 'string' && activeToken !== undefined && activeToken !== turnToken) {
      return { confirmed: false, headId: null as string | null };
    }
    if (!guiFallbackParents.has(conversationId) && !hasPersistenceAccumulator(conversationId)) {
      return { confirmed: false, headId: null as string | null };
    }
    // Distinguish an EMPTY accumulator (head null is fine) from one that HAD content — if the latter
    // finalizes to a null head, the write FAILED and we must NOT report confirmed (the caller would
    // continue on a stale branch, losing the authoritative reply).
    const hadContent = persistenceAccumulatorHasContent(conversationId);
    // Remote origin marker may already have been CONSUMED into pendingRemoteReplace by an in-flight
    // terminal fallback poll — check BOTH, else an explicit flush during the poll would misclassify
    // the run as local and APPEND a duplicate sibling instead of replacing the web client's capped node.
    const remoteOrigin = guiFallbackRemoteOrigin.delete(conversationId) || pendingRemoteReplace.has(conversationId);
    guiFallbackParents.delete(conversationId);
    pendingRemoteReplace.delete(conversationId);
    pendingLocalReplace.delete(conversationId);
    try {
      // REMOTE origin: the web client already persisted a FRAME-CAPPED node under this
      // responseMessageId — REPLACE it in place with main's full copy (appending would create a
      // duplicate sibling). LOCAL origin: the originator's renderer runs a ~300ms debounced
      // stream-persist, so disk may ALREADY carry this run's assistant node (still 'running')
      // by the time a passive client wins continuation and flushes here — UPSERT by id so we
      // don't collision-rename it into a duplicate `auto-msg-*` sibling; falls through to a
      // normal append when no such node exists yet.
      const head = remoteOrigin
        ? finalizeInterruptedTurnReplacing(serverPersistAppHome, conversationId)
        : finalizeInterruptedTurnUpsert(serverPersistAppHome, conversationId);
      if (head) return { confirmed: true, headId: head };
      if (hadContent) return { confirmed: false, headId: null as string | null }; // write failed → not confirmed
      // Genuinely empty accumulator: the on-disk head is the confirmed branch.
      const conv = readConversation(serverPersistAppHome, conversationId);
      return { confirmed: true, headId: conv?.headId ?? null };
    } catch {
      return { confirmed: false, headId: null as string | null };
    }
  });

  ipcMain.handle('agent:cancel-stream', async (event, conversationId: string) => {
    if (!mayMutateBrowserAuthorizedStream(event, activeStreams.get(conversationId), getPrimaryWindow)) {
      return { ok: false, error: 'native-browser-authority-required' };
    }
    cancelConversationStreamInner(conversationId);
    return { ok: true };
  });
  // Shared cancel body — used by the IPC handler above AND cancelConversationStream (called
  // when a conversation is deleted). Idempotent + race-guarded (deleteStreamIfOwned).
  function cancelConversationStreamInner(conversationId: string): void {
    // An explicit user Stop for this conversation — bump the cancel generation so
    // any deferred raced-answer re-injection scheduled before now aborts at fire
    // time (covers a Stop on a SUCCESSOR turn during the re-inject delay).
    // Only bump for a REAL conversation (has an active stream, a pending submit, or a
    // persisted record). A cancel-stream for an arbitrary/bogus id would otherwise create
    // a spurious entry and, in bulk, FIFO-evict the entries of genuine conversations that
    // a deferred op still needs to re-check (R131 finding-1 — the flood vector).
    const isRealConversation =
      activeStreams.has(conversationId) ||
      currentPendingSubmit.has(conversationId) ||
      readConversation(appHome, conversationId) != null;
    if (isRealConversation) {
      bumpExplicitCancelGeneration(conversationId);
    }
    // Cancel a submit still waiting on toolsReady (no activeStreams entry yet)
    // so it bails after the await instead of starting a run for a gone client.
    const pendingSubmitId = currentPendingSubmit.get(conversationId);
    if (pendingSubmitId !== undefined) {
      cancelledSubmits.add(pendingSubmitId);
      currentPendingSubmit.delete(conversationId);
    }
    const controller = activeStreams.get(conversationId);
    if (controller) {
      // Mark this run's token as a TERMINAL abort BEFORE aborting, so the
      // ask_user gate (which resumes synchronously off the abort) sees it and
      // does NOT hand a raced answer to the replacement coordinator — an explicit
      // Stop has no successor and must not restart the agent.
      markTokenTerminalAbort(controller.token);
      // Synchronously DROP (no recovery) any answer this stopped run consumed but
      // hadn't committed — the user explicitly Stopped, so it must not be resurrected
      // or mis-attributed to a later run (R101 finding-2). Token-scoped to the run
      // being stopped.
      dropInFlightAnswersForToken(controller.token);
      controller.abort();
      // Close this cancelled turn's temporary tabs while its token is still the
      // active owner. Its finally block cannot do this after the map entry is
      // removed below, and a future replacement must be left untouched.
      cleanupAssistantTabsIfOwned(conversationId, controller.token);
      // Delete only the entry we just aborted (guard against a race where a
      // replacement run already took over).
      const stillOwnedAtCancel = activeStreams.get(conversationId)?.token === controller.token;
      deleteStreamIfOwned(conversationId, controller.token);
      activeStreamModelKeys.delete(conversationId);
      // deleteStreamIfOwned removed activeStreams synchronously, so the aborted
      // run's finally → cleanupStreamIfOwned finds no owned entry and SKIPS
      // activeStreamRuntime.delete — leaking that entry (which now holds the run's
      // model key + system prompt) in an unbounded map. Clear it HERE, but only when
      // WE still owned the token (don't clobber a replacement run's fresh entry).
      if (stillOwnedAtCancel && activeStreamRuntime.get(conversationId)?.token === controller.token) {
        activeStreamRuntime.delete(conversationId);
      }
      if (stillOwnedAtCancel && activeStreamResponseIds.get(conversationId)?.token === controller.token) {
        activeStreamResponseIds.delete(conversationId);
      }
      if (stillOwnedAtCancel && activeInjectContinuationId.get(conversationId)?.token === controller.token) {
        activeInjectContinuationId.delete(conversationId);
      }
    }
    activeObserverSessions.delete(conversationId);
    // Clear same-turn inject bookkeeping here too: deleteStreamIfOwned above removes
    // the activeStreams entry synchronously, so the aborted run's own finally (which
    // calls cleanupStreamIfOwned) finds no owned entry and skips clearing these — they
    // would otherwise leak for a conversation cancelled mid-turn after consuming an inject.
    conversationsWithConsumedInject.delete(conversationId);
    consumedInjectBytes.delete(conversationId);
    // Drop any server-side persistence accumulation + ownership for a cancelled
    // turn, and reset a CLI turn's runStatus so it doesn't look stuck 'running'.
    // First preserve any ACCEPTED cooperative injects still queued (a cancellation
    // deletes activeStreams before the stream finally runs, so the terminal drain
    // there no longer owns the token). Persist the partial assistant + injected
    // user boundary now, then respect the cancellation by NOT restarting.
    const wasServerPersist = serverPersistTokens.has(conversationId);
    if (wasServerPersist && hasInjects(conversationId)) {
      const stranded = drainInjects(conversationId);
      for (const entry of stranded) {
        // Persist each accepted server-owned inject as a real user turn. Guard every entry
        // (R164 f-2): persistCooperativeInjectedUserTurn can THROW, and a throw here would abort the
        // rest of Stop cleanup below (inject/bookkeeping clears, serverPersist teardown, the terminal
        // broadcast) — leaving a half-torn-down conversation. It also returns null on a transient
        // conversation-read failure; log that (the inject can't be recovered on this terminal Stop,
        // but a silent drop must at least be visible). NEVER let either abort the cleanup.
        try {
          const persisted = persistCooperativeInjectedUserTurn(appHome, conversationId, entry.text, entry.id);
          if (!persisted) {
            console.error(
              `[agent] cancel: stranded inject ${entry.id} for ${conversationId} not persisted (conversation unreadable)`,
            );
          }
        } catch (err) {
          console.error(`[agent] cancel: failed to persist stranded inject ${entry.id}`, err);
        }
      }
    }
    // Any injects STILL queued here are GUI-owned (the server-owned drain above
    // already consumed + persisted server injects). A GUI-turn Stop: the renderer
    // owns persistence (already persisted the injected user at injection) and the
    // Stop is respected (no restart to drain), so main must CLEAR them — else they
    // linger in the conversation-scoped queue and a later turn drains a stale
    // answer/follow-up. No-op when empty; never touches a server-owned deferred
    // inject (drained above).
    clearInjects(conversationId);
    pendingServerPersist.delete(conversationId);
    pendingServerPersistParent.delete(conversationId);
    serverPersistParents.delete(conversationId);
    serverPersistTokens.delete(conversationId);
    clearFinalizedResponseIds(conversationId);
    // GUI-turn cancel: deleteStreamIfOwned above removed the activeStreams entry, so the aborted
    // run's finally → cleanupStreamIfOwned finds no owned entry and SKIPS finalizeGuiFallbackIfOwned
    // — leaking the fallback accumulator + guiFallbackParents marker. Clean them up here directly
    // (like the inject bookkeeping above). On cancel the RENDERER's onCancel persists the partial +
    // resets runStatus, so main's fallback normally DISCARDS (no double-write). EXCEPT a REMOTE
    // origin: the web client's cancel-persist carries the FRAME-CAPPED partial, so main must
    // REPLACE-finalize its FULL copy (upsert by id) instead of discarding — else Stop after a large
    // tool result would permanently store only omission placeholders.
    const remoteOriginCancel = guiFallbackRemoteOrigin.delete(conversationId);
    if (guiFallbackParents.delete(conversationId)) {
      if (remoteOriginCancel) {
        // The web client's onCancel persists its FRAME-CAPPED tree AFTER cancelStream returns.
        // If we REPLACE-finalize main's full copy NOW (synchronously), that later capped persist
        // would overwrite it. So DEFER: poll briefly for the renderer's cancel-persist to land
        // (runStatus flips off 'running'), THEN replace-finalize main's full copy on top. Keep the
        // accumulator alive meanwhile (do NOT discard). Bounded; if it never lands (renderer gone)
        // replace anyway so the full copy still wins.
        const deferReplace = (remaining: number): void => {
          // A replacement turn was admitted → it already finalize-replaced our pending copy at
          // admission (see the agent:stream discard site) and owns the accumulator now. Stop.
          if (!pendingRemoteReplace.has(conversationId)) return;
          if (activeStreams.has(conversationId)) {
            pendingRemoteReplace.delete(conversationId);
            return;
          }
          let persisted = false;
          try {
            const conv = readConversation(appHome, conversationId);
            if (conv && conv.runStatus !== 'running') persisted = true;
          } catch {
            /* keep polling */
          }
          if (persisted || remaining <= 0) {
            pendingRemoteReplace.delete(conversationId);
            try {
              finalizeInterruptedTurnReplacing(appHome, conversationId);
            } catch {
              discardPersistenceAccumulator(conversationId);
            }
            return;
          }
          setTimeout(() => deferReplace(remaining - 1), 100);
        };
        pendingRemoteReplace.add(conversationId);
        deferReplace(80); // ~8s budget, matching the GUI fallback poll
      } else {
        // LOCAL cancel: the renderer's onCancel persists the partial + resets runStatus. Normally
        // main's copy is then redundant. But if the renderer CRASHES/reloads after cancelStream
        // returns but before its persist lands, discarding now loses the partial. So DEFER (same as
        // the remote case, but APPEND main's copy): poll for the renderer's persist; if it lands,
        // discard main's (renderer owns the write); if it never does, finalize main's partial.
        const deferLocal = (remaining: number): void => {
          if (!pendingLocalReplace.has(conversationId)) return;
          if (activeStreams.has(conversationId)) {
            pendingLocalReplace.delete(conversationId);
            return; // a replacement turn's admission already handled the pending local copy
          }
          let persisted = false;
          try {
            const conv = readConversation(appHome, conversationId);
            if (conv && conv.runStatus !== 'running' && conv.runStatus !== 'awaiting-approval') persisted = true;
          } catch {
            /* keep polling */
          }
          if (persisted) {
            pendingLocalReplace.delete(conversationId);
            discardPersistenceAccumulator(conversationId); // renderer persisted — no double-write
            return;
          }
          if (remaining <= 0) {
            pendingLocalReplace.delete(conversationId);
            try {
              // Upsert-by-id: the renderer's debounced persist may have landed the
              // assistant node under this run's responseMessageId just before it
              // crashed/reloaded (disk still 'running'); a plain append would
              // id-collision-rename it to a bogus `auto-msg-*` sibling. replaceById
              // upserts in place (falls back to append when no such node exists).
              finalizeInterruptedTurnUpsert(appHome, conversationId); // renderer never persisted → save main's partial
            } catch {
              discardPersistenceAccumulator(conversationId);
            }
            return;
          }
          setTimeout(() => deferLocal(remaining - 1), 100);
        };
        pendingLocalReplace.add(conversationId);
        deferLocal(80);
      }
    }
    // A cancel ends the turn — drop its continuation authorization (a resumed turn re-authorizes).
    releaseContinuationAuth(conversationId);
    if (wasServerPersist) {
      discardPersistenceAccumulator(conversationId);
      try {
        const conv = readConversation(appHome, conversationId);
        if (conv && conv.runStatus === 'running') {
          conv.runStatus = 'idle';
          const writtenIdle = writeConversation(appHome, conv);
          broadcastUpsert(appHome, writtenIdle);
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
  }
  cancelConversationStreamImpl = cancelConversationStreamInner;

  // Recover the run nonce embedded in a pending-approval / answer-stash map key (R249). A run-scoped key
  // is `${convId}::${runNonce}::${toolCallId}`; the middle segment is the nonce. Returns undefined when
  // the key is absent, was composed WITHOUT a run nonce (`${convId}::${toolCallId}` or the raw id), or its
  // shape doesn't match — so callers fall back to the conversation-only key (pre-R249 behavior). Used by
  // agent:answer-tool-question when the client didn't thread the nonce, so the answer is stashed under the
  // EXACT key the ask_user gate/execute reads.
  const extractRunNonceFromApprovalKey = (
    key: string | undefined,
    convId: string | undefined,
    toolCallId: string,
  ): string | undefined => {
    if (!key || !convId) return undefined;
    const prefix = `${convId}::`;
    const suffix = `::${toolCallId}`;
    if (!key.startsWith(prefix) || !key.endsWith(suffix)) return undefined;
    const middle = key.slice(prefix.length, key.length - suffix.length);
    if (middle.length === 0 || middle.includes('::')) return undefined;
    return middle;
  };

  // Resolve a pending approval by the renderer-facing raw toolCallId, honoring the run-scoped key
  // (R192 conversation + R249 run). Tries the run-scoped composite key first (conversationId + runNonce,
  // the run's streamToken echoed to the renderer as runGeneration), then the conversation-only composite,
  // then — for a nonce-less resolve (older client / legacy test) whose approval was nonetheless STORED
  // run-scoped — a UNAMBIGUOUS suffix scan for the single pending `${convId}::<anyNonce>::${toolCallId}`,
  // and finally the raw key. The suffix scan fires ONLY when exactly one candidate matches: if two
  // OVERLAPPING runs both hold `call_1` in this conversation, a nonce-less caller can't say which it
  // means (that's the collision R249 fixes), so we refuse rather than resolve the wrong run's card.
  // Returns the entry + the ACTUAL map key it was found under so the caller deletes the right one.
  const resolvePendingApproval = (
    toolCallId: string,
    conversationId?: string,
    runNonce?: string,
  ): { pending: PendingToolApproval; key: string } | undefined => {
    const convId = sanitizeAnswerConversationId(conversationId);
    if (convId && runNonce) {
      // R258: an EXPLICIT nonce must FAIL CLOSED on a miss — do NOT fall through to the conversation-scoped
      // key or the unambiguous scan. After run A settles, a delayed A response carrying A's nonce would
      // otherwise "unambiguously" resolve run B's same-id approval and approve B's unrelated action. Try only
      // the exact run-scoped key, then the raw id (a legacy/headless caller that happened to pass a nonce for a
      // raw-keyed approval). The conversation-scoped + suffix-scan fallbacks below are for NONCE-LESS callers.
      const runScoped = approvalKey(convId, toolCallId, runNonce);
      const p = pendingToolApprovals.get(runScoped);
      if (p) return { pending: p, key: runScoped };
      const raw = pendingToolApprovals.get(toolCallId);
      return raw ? { pending: raw, key: toolCallId } : undefined;
    }
    if (convId) {
      const composite = approvalKey(convId, toolCallId);
      const p = pendingToolApprovals.get(composite);
      if (p) return { pending: p, key: composite };
      // Nonce-less resolve of a run-scoped-stored approval: find the single pending entry keyed
      // `${convId}::<nonce>::${toolCallId}`. Only accept an UNAMBIGUOUS match (exactly one).
      const suffix = `::${toolCallId}`;
      const prefix = `${convId}::`;
      let match: { pending: PendingToolApproval; key: string } | undefined;
      let ambiguous = false;
      for (const [k, pend] of pendingToolApprovals) {
        if (!k.startsWith(prefix) || !k.endsWith(suffix)) continue;
        // Middle segment (the run nonce) must be present + non-empty: `${convId}::<nonce>::${toolCallId}`.
        const middle = k.slice(prefix.length, k.length - suffix.length);
        if (middle.length === 0 || middle.includes('::')) continue;
        if (match) {
          ambiguous = true;
          break;
        }
        match = { pending: pend, key: k };
      }
      if (match && !ambiguous) return match;
    }
    const raw = pendingToolApprovals.get(toolCallId);
    return raw ? { pending: raw, key: toolCallId } : undefined;
  };

  ipcMain.handle('agent:approve-tool', (event, toolCallId: string, conversationId?: string, runNonce?: string) => {
    const resolved = resolvePendingApproval(toolCallId, conversationId, runNonce);
    const pending = resolved?.pending;
    const approvalError = pending ? toolApprovalResolutionError(event, pending, getPrimaryWindow) : null;
    if (pending && approvalError) {
      if (approvalError === 'stale-browser-stream') {
        pending.resolve(false);
        closeApprovalWindow(toolCallId, conversationId);
      }
      return { ok: false, error: approvalError };
    }
    if (pending && resolved) {
      pending.resolve(true);
      pendingToolApprovals.delete(resolved.key);
    }
    // Sync dismissal: if the user answered the INLINE card, close the dedicated
    // approval window too. (Approve normally emits a tool-result that also closes
    // it, but reject/dismiss may not — close here so the surfaces never diverge.)
    closeApprovalWindow(toolCallId, conversationId);
    return { ok: true };
  });

  ipcMain.handle(
    'agent:get-tool-approval-private-details',
    (event, toolCallId: string, conversationId?: string, runNonce?: string) => {
      if (typeof toolCallId !== 'string' || !toolCallId) return null;
      const pending = resolvePendingApproval(toolCallId, conversationId, runNonce)?.pending;
      if (!pending?.privateDetails || !mayResolveToolApproval(event, pending, getPrimaryWindow)) return null;
      // This is intentionally the only path that returns exact Browser approval
      // input. It is restricted to the primary renderer or the exact one-shot
      // approval pop-out, and the pending map drops it on every settle path.
      return { ...pending.privateDetails };
    },
  );

  ipcMain.handle('agent:reject-tool', (event, toolCallId: string, conversationId?: string, runNonce?: string) => {
    const resolved = resolvePendingApproval(toolCallId, conversationId, runNonce);
    const pending = resolved?.pending;
    const approvalError = pending ? toolApprovalResolutionError(event, pending, getPrimaryWindow) : null;
    if (pending && approvalError) {
      if (approvalError === 'stale-browser-stream') {
        pending.resolve(false);
        closeApprovalWindow(toolCallId, conversationId);
      }
      return { ok: false, error: approvalError };
    }
    if (pending && resolved) {
      pending.resolve(false);
      pendingToolApprovals.delete(resolved.key);
    }
    // If the turn already aborted + registered a raced-answer handoff for this
    // question, an explicit reject must purge it so a delayed answer from another
    // surface can't still be delivered to the successor. The handoff/tombstone keys are
    // run-scoped (R192/R249). R251: recover the run nonce even when the caller didn't thread it AND the pending
    // entry is already gone — from the pending key, else the durable authority record, else the run-scoped
    // recovery state itself (the only place it survives for an ordinary any-renderer approval post-abort). Purge
    // under the run-scoped key, with a conversation-only fallback for a truly nonce-less legacy path.
    const rejConv = sanitizeAnswerConversationId(conversationId);
    const rejNonce =
      runNonce ??
      extractRunNonceFromApprovalKey(resolved?.key, rejConv, toolCallId) ??
      recoverRunNonceFromRecoveryState(rejConv, toolCallId) ??
      findRunNonceForAuthorityRecord(rejConv, toolCallId);
    purgeRacedAnswerForKey(makeAnswerKey(rejConv, toolCallId, rejNonce));
    if (rejNonce) purgeRacedAnswerForKey(makeAnswerKey(rejConv, toolCallId));
    closeApprovalWindow(toolCallId, conversationId, rejNonce); // R258: exact run-scoped close, don't hit a sibling
    return { ok: true };
  });

  ipcMain.handle('agent:dismiss-tool', (event, toolCallId: string, conversationId?: string, runNonce?: string) => {
    const resolved = resolvePendingApproval(toolCallId, conversationId, runNonce);
    const pending = resolved?.pending;
    const approvalError = pending ? toolApprovalResolutionError(event, pending, getPrimaryWindow) : null;
    if (pending && approvalError) {
      if (approvalError === 'stale-browser-stream') {
        pending.resolve(false);
        closeApprovalWindow(toolCallId, conversationId);
      }
      return { ok: false, error: approvalError };
    }
    if (pending && resolved) {
      pending.resolve('dismiss');
      pendingToolApprovals.delete(resolved.key);
    }
    // R251: same run-nonce recovery as reject — purge the run-scoped handoff/tombstone even when the caller
    // didn't thread the nonce and the pending entry is already gone (post-abort).
    const disConv = sanitizeAnswerConversationId(conversationId);
    const disNonce =
      runNonce ??
      extractRunNonceFromApprovalKey(resolved?.key, disConv, toolCallId) ??
      recoverRunNonceFromRecoveryState(disConv, toolCallId) ??
      findRunNonceForAuthorityRecord(disConv, toolCallId);
    purgeRacedAnswerForKey(makeAnswerKey(disConv, toolCallId, disNonce));
    if (disNonce) purgeRacedAnswerForKey(makeAnswerKey(disConv, toolCallId));
    closeApprovalWindow(toolCallId, conversationId, disNonce); // R258: exact run-scoped close, don't hit a sibling
    return { ok: true };
  });

  ipcMain.handle(
    'agent:answer-tool-question',
    (event, toolCallId: string, answers: Record<string, string>, conversationId?: string, runNonce?: string) => {
      // Runtime type-guard (R132 finding-2): the web/WebSocket boundary is UNTYPED, so a client
      // can send a non-string toolCallId (e.g. a ~4 MiB object used as the Map key, whose bulk
      // slips past a length-based byte measure) or non-string answer values. Coerce/reject here
      // so downstream (stash byte-accounting, id equality, recovery routing) only ever sees the
      // declared shape: a string id and a flat Record<string,string>. Reject a malformed frame.
      if (typeof toolCallId !== 'string' || toolCallId.length === 0 || toolCallId.length > 4096) {
        return { ok: false, error: 'invalid-tool-call-id' };
      }
      // Must be a PLAIN object (R137 f-7): a Map / ArrayBuffer / class instance passes a bare
      // `typeof === 'object'` + `Object.values()` (which is empty for them) so byte-accounting
      // would measure it as `{}` while structured-clone still retains its (large) internal
      // payload in MAIN — defeating the 64 KiB/4 MiB bounds. Require Object/null prototype.
      if (answers === null || typeof answers !== 'object' || Array.isArray(answers)) {
        return { ok: false, error: 'invalid-answers' };
      }
      const proto = Object.getPrototypeOf(answers);
      if (proto !== Object.prototype && proto !== null) {
        return { ok: false, error: 'invalid-answers' };
      }
      for (const v of Object.values(answers)) {
        if (typeof v !== 'string') return { ok: false, error: 'invalid-answers' };
      }
      // Run-scoped keys (R191/R192 conversation + R249 run): the stash + raced-recovery AND the
      // pending-approval map are keyed by conversationId::runNonce::toolCallId so neither a provider that
      // reuses `call_1` across conversations NOR two OVERLAPPING runs in the same conversation can
      // cross-route an answer / fail-close a foreign run's live approval. conversationId + runNonce are
      // optional/untrusted here — validate the conversationId; when a part is absent (older client, or a
      // legacy/headless registration) the keys fall back to conversation-only then raw (unchanged behavior).
      // The window-close map stays keyed by the raw wire id.
      const convId = sanitizeAnswerConversationId(conversationId);
      // Resolve the pending entry first (run-scoped → conversation-scoped → unambiguous suffix scan → raw)
      // so a caller that didn't thread the run nonce still lands on a run-scoped-stored approval.
      const pendingResolved = resolvePendingApproval(toolCallId, conversationId, runNonce);
      const pending = pendingResolved?.pending;
      // The EFFECTIVE run nonce for the answer/authority keys: the caller's runNonce when provided, else
      // the nonce recovered from the pending entry's ACTUAL map key (`convId::<nonce>::toolCallId`), else
      // (R250: the pending entry was already deleted by an abort — the raced-answer path) the nonce from the
      // DURABLE authority record's key, so the stash key we write matches EXACTLY the run-scoped key the
      // handoff/tombstone recovery reads. Undefined → keys fall back to conversation-only (pre-R249 behavior).
      // R252: consult the ACTIVE recovery state (handoff/claimant/tombstone) BEFORE the durable authority
      // record — authority records survive settlement and a reused call_1 must not recover an OLDER run's nonce
      // over the current handoff (which would stash under the wrong run / reject under stale Browser authority).
      const effectiveNonce =
        runNonce ??
        extractRunNonceFromApprovalKey(pendingResolved?.key, convId, toolCallId) ??
        recoverRunNonceFromRecoveryState(convId, toolCallId) ??
        findRunNonceForAuthorityRecord(convId, toolCallId);
      const answerKey = makeAnswerKey(convId, toolCallId, effectiveNonce);
      const approvalMapKey = approvalKey(convId, toolCallId, effectiveNonce);
      // A Browser-authorized approval may only be answered by the authorized surface (main's authority
      // routing). A stale-browser-stream answer resolves the approval closed (dismiss) + closes the
      // pop-out; other authority errors reject the answer without touching the pending entry.
      const approvalError = pending ? toolApprovalResolutionError(event, pending, getPrimaryWindow) : null;
      if (pending && approvalError) {
        if (approvalError === 'stale-browser-stream') {
          pending.resolve(false);
          closeApprovalWindow(toolCallId, conversationId);
        }
        return { ok: false, error: approvalError };
      }
      // PENDINGLESS authority enforcement (R174): the raced-answer stash path below accepts an answer
      // even when `pending` was already deleted by an abort (that's the whole ask_user-race fix). But a
      // browser-authorized approval's authority must STILL be enforced there — otherwise a non-primary
      // web surface could submit an answer for a browser-owned ask_user after abort and have it injected
      // into the successor/recovery turn that still holds authenticated Browser authority. Consult the
      // DURABLE authority record (survives the pending deletion) and reject an unauthorized late answer.
      if (!pending) {
        // Authority record is keyed the same way registration keyed it (run-scoped when the turn had a
        // conversationId + run nonce); fall back to the conversation-scoped then raw key for a legacy
        // registration (R192/R249).
        const recordedAuthority =
          getRecordedApprovalAuthority(approvalMapKey) ??
          (effectiveNonce ? getRecordedApprovalAuthority(approvalKey(convId, toolCallId)) : undefined) ??
          getRecordedApprovalAuthority(toolCallId);
        const requiresNativeAuthority =
          recordedAuthority?.authority === 'native-browser' || Boolean(recordedAuthority?.streamOwner);
        if (requiresNativeAuthority) {
          // Enforce CALLER authority, NOT stream-current: the recovery path deliberately runs after the
          // original stream ended, so a stream-current gate would wrongly reject a legitimate answer.
          // Accept the PRIMARY window OR the exact authorized pop-out (its webContents id is mirrored
          // onto the durable record, so an answer submitted while the one-shot capability was valid is
          // not lost when abort deletes the pending entry — R175). A non-primary web/secondary surface
          // fails both and is rejected.
          const authorized =
            isPrimaryBrowserToolCaller(event, getPrimaryWindow) ||
            isAuthorizedApprovalWindowCaller(event, recordedAuthority!);
          if (!authorized) {
            return { ok: false, error: 'native-browser-authority-required' };
          }
        }
      }
      // Stash the answers before resolving. A fully-submitted answer can race an
      // abort (turn ended / superseded / plan-restart) that already settled + removed
      // the pending approval a beat earlier — the old `if (pending)` guard dropped the
      // answer in that window, and the tool then emitted "No user response received"
      // even though the user DID answer. The stash is bounded (MAX_PENDING_QUESTION_ANSWERS
      // FIFO), so an orphaned entry for a genuinely-dead turn can't leak. The ask_user
      // gate + execute recover this entry by id; a still-live pending approval is
      // resolved below.
      //
      // FIRST-SURFACE-WINS: multiple surfaces (inline card / dedicated window / web /
      // CLI) can answer the same question. Once the FIRST answer resolved the pending
      // approval (entry deleted), a LATER differing answer must NOT overwrite the
      // already-stashed first answer before a raced-abort handoff consumes it — that
      // would deliver the second surface's answer even though the first already
      // succeeded. So stash only when this is the first answer (no existing stash) OR a
      // pending approval is still live (this IS the winning surface resolving it now).
      const alreadyStashed = pendingQuestionAnswers.has(answerKey);
      let stashed = true;
      if (pending || !alreadyStashed) {
        // stashQuestionAnswers rejects an oversized single entry (byte cap) — a legitimate
        // answer is short typed text; an oversized frame is discarded rather than allowed to
        // retain memory / FIFO-evict real recovery entries (R130 finding-2). A live pending
        // approval is still resolved below (don't wedge a genuine turn), but there's no stash
        // to recover from on a raced abort — acceptable, since a 64 KiB+ "answer" is abuse.
        stashed = stashQuestionAnswers(answerKey, answers);
      }
      traceDiagnostic({
        scope: 'agent',
        event: 'question.answer-received',
        toolName: 'ask_user',
        fields: {
          toolCallId,
          hadPending: Boolean(pending),
          answerCount: Object.keys(answers ?? {}).length,
          stashRejectedOversize: !stashed,
        },
      });
      if (pending) {
        // Resolve with the explicit `answered` source so the trace distinguishes a
        // real ask_user answer from a generic tool approval. (settle() already deletes the
        // composite map key; this explicit delete is a belt-and-suspenders no-op under the SAME key.)
        pending.resolve(true, 'answered');
        if (pendingResolved) pendingToolApprovals.delete(pendingResolved.key);
      }
      // Answer-arrival side of the raced-answer rendezvous: if this answer belongs
      // to a pending handoff whose successor is already live (the successor started
      // before the answer landed — a slow/remote client), deliver it now. No-op if
      // there's no matching handoff/claimant yet (the successor-start path delivers
      // once it registers). Locate the owning conversation by the conversation-scoped
      // answerKey (R191).
      const owningConv = conversationForRacedAnswerKey(answerKey);
      if (owningConv) {
        attemptRacedAnswerDelivery(owningConv);
      } else {
        // No live handoff/claimant references this key — but a no-successor drop may
        // have left a TTL-bound recovery tombstone. If so, this LATE-arriving answer is
        // owed to that conversation; route it through the durable recovered-answer path
        // (labeled re-inject / Alert) instead of leaving it orphaned in the stash (R87).
        const tombstoneConv = recoveryTombstoneConversation(answerKey);
        if (tombstoneConv) {
          recoveryTombstones.delete(answerKey);
          recoverOrphanedAnswerKeys(tombstoneConv, [answerKey]);
        }
      }
      return { ok: true };
    },
  );

  ipcMain.handle(
    'agent:generate-title',
    async (_event, messages: unknown[], modelKey?: string, hint?: string, conversationId?: string) => {
      let config: AppConfig;
      try {
        config = readEffectiveConfig(appHome);
      } catch {
        return { title: null };
      }

      // Build the title system prompt FIRST (from the incoming messages) so it can be passed
      // THROUGH the DLP gate: a system-prompt-conditioned enforcement hook must see the real
      // outbound title request, and its returned systemPrompt modification must be honored.
      const hasImages = messagesContainImages(messages);
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

      // Title generation sends the user's prompt to a model too, so when hook
      // enforcement is active it must pass through the same UserPromptSubmit gate
      // (shared with the CLI auto-title path). A `deny` returns
      // { title: null, suppressed: true } so the renderer does NOT fall back to
      // deriving a title from the raw messages; a `modify` rewrites the messages
      // and/or the system prompt.
      const gated = await gateTitleGenerationMessages(
        messages,
        config,
        conversationId ?? '',
        modelKey,
        CHAT_TITLE_PROMPT,
      );
      if (gated.suppressed) return { title: null, suppressed: true };
      const effectiveMessages = gated.messages;

      const input = buildTitleGenerationInput(effectiveMessages);
      if (!input) return { title: null };

      const title = await generateTitle({
        systemPrompt: gated.systemPrompt ?? CHAT_TITLE_PROMPT,
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

/** Exposed for unit tests only. */
export const __internal = {
  extractLastUserText,
  observerToolsForExecutionMode,
  resolveInjectedTextFromGatedPayload,
  // Supersession-lineage primitives — the raced-answer handoff/claimant transfer
  // sites gate on isSupersessionDescendant so a DEAD or UNRELATED replacement can't
  // inherit/strand a stale answer (R81 / R115). Exposed for focused unit coverage.
  recordSupersession,
  isSupersessionDescendant,
  reconcileExecutionMode,
  planEnterResultFailed,
  isConversationDeletedSafe,
  // Cancel-generation ABA-safety primitives (R132): capture RAW (undefined = never Stopped),
  // compare undefined-aware so an evicted-after-Stop entry counts as changed (fail-safe).
  bumpExplicitCancelGeneration,
  captureCancelGeneration,
  cancelGenerationChanged,
  // PUSH-based cancel invalidation (R135) — eviction-proof "was this Stopped after capture?"
  // for run-starting deferred ops. A Stop flips the token regardless of stop-map eviction.
  registerCancelGenToken,
  releaseCancelGenToken,
  isPrimaryBrowserToolCaller,
  mayMutateBrowserAuthorizedStream,
  mayInjectAutomationIntoActiveStream,
  isAuthorizedApprovalWindowCaller,
  isPendingApprovalStreamCurrent,
  mayResolveToolApproval,
  toolApprovalResolutionError,
  shouldPrepareBrowserContinuation,
  isBrowserDrainSuperseded,
  isNativeBrowserAuthorityCurrent,
  isNativeBrowserAuthorityRevoked,
  mayDriveBrowserContinuation,
  pluginProviderErrorForExposure,
  resetBrowserAuthorityRevokedRunStatus,
  toolsForPluginInferenceProvider,
  bindBrowserToolsToRun,
  redactBrowserToolArgsForExposure,
  observerToolErrorForExposure,
  validateToolInput,
  markTextBrowserCapabilitiesRevoked,
  revokeTextBrowserCapabilities,
  shouldWarnAboutUnwrappedRuntimeTools,
  protectUnresolvedToolCallArgs,
};
