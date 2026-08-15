import {
  useState,
  useCallback,
  useEffect,
  useRef,
  useMemo,
  type ReactNode,
  createContext as createCtx,
  useContext as useCtx,
} from 'react';
import type { ThreadMessageLike, AppendMessage } from '@assistant-ui/react';
import { AssistantRuntimeProvider, useExternalStoreRuntime } from '@assistant-ui/react';
import { app } from '@/lib/ipc-client';
import { generateId } from '@/lib/utils';
import { useAttachments } from './AttachmentContext';
import type { AttachedFile } from './AttachmentContext';
import { useConfig } from './ConfigProvider';
import {
  createUnifiedSpeechAdapter,
  createUnifiedRecordingAdapter,
  type AudioProvider,
} from '@/lib/audio/speech-adapters';
import { buildResponseTiming, getResponseTiming, withResponseTiming } from '@/lib/response-timing';
import { normalizeTokenUsage, type TokenUsageData as NormalizedTokenUsageData } from '../../shared/token-usage';

export type DebateEnrichment = {
  enabled: boolean;
  rounds?: number;
  advocate_model?: string;
  challenger_model?: string;
  judge_model?: string;
  advocate_summary?: string;
  challenger_summary?: string;
  judge_confidence?: number;
};

export type CurationEnrichment = {
  thinking_blocks_stripped?: number;
  tool_results_distilled?: number;
  exchanges_folded?: number;
  superseded_reads_evicted?: number;
  duplicates_removed?: number;
  token_savings_estimate?: number;
};

export type PipelineEnrichments = {
  debate?: DebateEnrichment;
  curation?: CurationEnrichment;
};

export type TokenUsageData = NormalizedTokenUsageData;

type ContentPart =
  | { type: 'text'; text: string; source?: 'assistant' | 'observer' | 'interrupt' | 'unspoken' }
  | { type: 'image'; image: string; mimeType?: string }
  | { type: 'file'; data: string; mimeType: string; filename: string; displayOnly?: boolean }
  | { type: 'enrichments'; enrichments: PipelineEnrichments }
  | { type: 'max-turns-reached'; text: string; status: 'pending' | 'continued' }
  | {
      type: 'tool-call';
      toolCallId: string;
      toolName: string;
      args: unknown;
      argsText?: string;
      result?: unknown;
      isError?: boolean;
      startedAt?: string;
      finishedAt?: string;
      /** Server-computed wall-clock duration in milliseconds — more accurate than finishedAt-startedAt for fast tools */
      durationMs?: number;
      /** Original (pre-compaction) result content — present only when tool output was compacted */
      originalResult?: unknown;
      /** Tool compaction metadata — present only when tool output was compacted */
      compactionMeta?: {
        wasCompacted: boolean;
        extractionDurationMs: number;
      };
      /** Live compaction phase — 'start' while AI summarization is running, cleared on complete */
      compactionPhase?: 'start' | 'complete' | null;
      liveOutput?: {
        stdout?: string;
        stderr?: string;
        truncated?: boolean;
        stopped?: boolean;
        subAgentConversationId?: string;
      };
      /** Approval status for tool execution */
      approvalStatus?: 'pending' | 'approved' | 'rejected';
      /** The ID the backend uses for the approval promise — may differ from
       *  toolCallId due to execute-side vs stream-side ID mismatch. */
      approvalId?: string;
    };

// A message with an ID and parentId for tree branching
type StoredMessage = ThreadMessageLike & {
  id: string;
  parentId: string | null;
  tokenUsage?: TokenUsageData;
  messageMeta?: Record<string, unknown>;
  /** Explicit orphan-reconnect hint for the mid-turn-inject repair: when a
   *  background-seeded reply is reparented off a null-parent, we also stamp the
   *  authoritative disk head here so the main-side write chokepoint
   *  (sanitizeMessageTree Pass 5) can restore the edge LITERALLY even if a
   *  cross-process merge or a persist path that bypassed the renderer repair drops
   *  it. Cleared by the sanitizer once honored. */
  reconnectTo?: string;
};

export type ConversationRecord = {
  id: string;
  title: string | null;
  fallbackTitle: string | null;
  messages: ThreadMessageLike[];
  /** Full message tree for branch support. If absent, messages array is the linear history. */
  messageTree?: StoredMessage[];
  /** ID of the current head message in the tree */
  headId?: string | null;
  conversationCompaction: ConversationCompaction;
  lastContextUsage: unknown | null;
  createdAt: string;
  updatedAt: string;
  lastMessageAt: string | null;
  titleStatus: string;
  titleUpdatedAt: string | null;
  messageCount: number;
  userMessageCount: number;
  runStatus: string;
  hasUnread: boolean;
  lastAssistantUpdateAt: string | null;
  selectedModelKey: string | null;
  selectedProfileKey?: string | null;
  fallbackEnabled?: boolean;
  profilePrimaryModelKey?: string | null;
  currentWorkingDirectory?: string | null;
  workspaceId?: string;
  metadata?: Record<string, unknown>;
  // Per-thread settings overrides (null = inherit from profile/global)
  reasoningEffort?: ReasoningEffort | null;
  executionMode?: 'auto' | 'plan-first' | null;
  temperature?: number | null;
  systemPromptOverride?: string | null;
  maxSteps?: number | null;
  maxRetries?: number | null;
  runtimeOverride?: string | null; // 'mastra' | 'claude-agent-sdk' | 'codex-sdk' | null
  // Sub-agent metadata
  parentConversationId?: string | null;
  parentToolCallId?: string | null;
  subAgentDepth?: number;
  isSubAgent?: boolean;
  archived?: boolean;
  /** Precomputed index-summary flags (present on `conversations:list` entries,
   *  absent on freshly-built in-memory records). Used by the chats-list filters. */
  hasToolCalls?: boolean;
  hasComputerUse?: boolean;
  hasMedia?: boolean;
};

export type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh';

export type SubAgentThreadState = {
  conversationId: string;
  parentConversationId: string;
  parentToolCallId: string;
  task: string;
  status: 'running' | 'awaiting-input' | 'completed' | 'stopped' | 'error' | 'failed' | 'paused';
  messages: StoredMessage[];
  headId: string | null;
  depth: number;
  /** Set once the thread has been RESUMED (a terminal thread transitioned back to
   *  running). After a resume, the parent tool-call's frozen `result`/`isError`
   *  is stale — the card must trust the live thread status, not the frozen prop. */
  hasResumed?: boolean;
  /** For `status: 'paused'`, WHY it paused — so the card shows "Awaiting input"
   *  only when the agent actually requested input, and a generic "Paused" for
   *  turn-limit / capacity pauses. */
  pausedReason?: 'awaiting-input' | 'turn-limit' | 'capacity';
};

type PendingAssistantTiming = {
  startedAt: string;
};

type MessageAccumulator = {
  messages: StoredMessage[];
  headId: string | null;
  pendingAssistantTiming?: PendingAssistantTiming | null;
  /** Assistant id preallocated for the current inference response. Mastra uses
   * the same id for its persisted output row and echoes it on stream events. */
  pendingAssistantId?: string | null;
  /** Cooperative-inject continuation override. Mastra reuses the SAME
   *  responseMessageId across a run's steps, so after a mid-turn inject splits the
   *  reply the CONTINUATION arrives under the reused id — which would otherwise
   *  reuse the (already-rendered) PREFIX assistant node id and, on persist,
   *  collapse the continuation into the prefix (dropping the injected user off the
   *  active branch). At the inject boundary we set this to a DETERMINISTIC id
   *  derived from the injected user node id (`${injectedUserId}-cont`) — which the
   *  MAIN-process fallback accumulator derives identically, so a renderer-crash
   *  fallback replace-by-id matches instead of appending a duplicate; and which is
   *  UNIQUE PER BOUNDARY (each inject has a distinct user id), so a second inject
   *  in the same run rotates to a new node rather than colliding. Consumed by
   *  getOrCreateAssistantInAcc for the FIRST continuation node, then cleared. */
  injectContinuationId?: string | null;
  /** Assistant node ids that are CLOSED prefixes (a cooperative inject boundary
   *  passed with this node as the reply-so-far). getOrCreateAssistantInAcc must
   *  not reuse a closed id even if a later event re-sets pendingAssistantId to it. */
  closedPrefixIds?: Set<string>;
  /** STABLE run generation (the server's streamToken) this accumulator is locked to —
   *  set from the first event bearing runGeneration; later events from a DIFFERENT
   *  generation are a superseded run's and dropped (except compaction). */
  runGeneration?: string;
  /** Deferred tool approvals keyed by toolName — handles race where
   *  tool-approval-required arrives before the stream-side tool-call event. */
  deferredApprovals?: Map<string, { toolCallId: string; args?: unknown }>;
  /** True while a tool is awaiting user approval — suppresses the running indicator */
  awaitingApproval?: boolean;
  /** Compaction record captured from the `compaction` stream event this turn.
   *  The event precedes the assistant reply, so we stash it here and fold it into
   *  the terminal (done/error/awaiting) persist rather than writing mid-turn. */
  pendingCompaction?: ConversationCompaction;
  /** When this accumulator was seeded synchronously-empty for a background
   *  (automation/serverPersisted) stream into a NON-active conversation, the
   *  first assistant node is created with parentId:null (there was no head yet).
   *  `seededBackground` marks that provenance so the persist chokepoint knows to
   *  reconnect a detached root against the on-disk head (opt-in — normal persists
   *  never do, so a legitimate edit-root is untouched). `seededDiskHeadId` caches
   *  the disk head once the async backfill resolves; the chokepoint falls back to
   *  reading it from disk when this is still unset (the debounce can beat the
   *  backfill). Both undefined for normally-seeded accumulators. */
  seededBackground?: boolean;
  seededDiskHeadId?: string | null;
  /** The run's OWN stream settings (model/profile/cwd/overrides), captured when the turn
   *  launched. Continuations (max_turns auto-continue, plan-restart) MUST use these, not the
   *  live active-chat refs — a background run whose conversation the user has switched away
   *  from would otherwise restart with the CURRENTLY-active chat's model/profile/working
   *  directory (High: relative-path tools could then modify the wrong project). */
  runConfig?: {
    selectedModelKey?: string | null;
    reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh';
    selectedProfileKey?: string | null;
    fallbackEnabled?: boolean;
    cwd?: string | null;
    executionMode?: 'auto' | 'plan-first';
    threadOverrides?: {
      temperature?: number | null;
      systemPromptOverride?: string | null;
      maxSteps?: number | null;
      maxRetries?: number | null;
      runtimeOverride?: string | null;
    };
  };
  /** True ONLY for an accumulator created by a LOCAL submit on THIS client (onNew/onEdit/
   *  onReload). A mirroring client (a second GUI window / web client viewing the same
   *  conversation) builds its accumulator from broadcast stream events and leaves this false.
   *  Renderer-driven auto-continue (max_turns) and plan-restart must fire ONLY on a locally
   *  originated accumulator — otherwise EVERY mirror independently continues/restarts the same
   *  run (duplicate model calls, supersession races, continuations using another client's
   *  model/CWD). The originating client drives the single continuation; mirrors just render it. */
  locallyOriginated?: boolean;
};

type ConversationCompaction = {
  compactionId: string;
  summaryText: string;
  compactedMessageIds: string[];
  boundaryHeadId: string | null;
  createdAt: string;
  // Opaque per-covered-id baseline signatures (forwarded verbatim from the stream event
  // and persisted) so a later same-turn recovery can verify an expanded synthetic summary.
  coveredContentSig?: Record<string, string>;
  // Main-issued freshness revision (forwarded from the stream event) — the put freshness
  // compare uses this so a stale reconnected client's older record can't overwrite a newer.
  compactionRevision?: number;
} | null;

function nowIso(): string {
  return new Date().toISOString();
}

function summarizeToolParts(parts: ContentPart[]): Array<Record<string, unknown>> {
  return parts
    .filter((part) => part.type === 'tool-call')
    .map((part) => ({
      toolCallId: part.toolCallId,
      toolName: part.toolName,
      hasResult: part.result !== undefined,
      compactionPhase: part.compactionPhase ?? null,
      wasCompacted: part.compactionMeta?.wasCompacted ?? false,
    }));
}

function logRuntimeToolDebug(stage: string, details: Record<string, unknown>): void {
  console.info(`[RuntimeToolDebug] ${stage} ${JSON.stringify(details)}`);
  app.debug?.trace?.({ event: `tool.${stage}`, scope: 'agent', fields: details });
}

// Renderer-side agent lifecycle (stream events, conversation loads). Tagged
// 'agent' so the Diagnostics "agent" scope captures them (not lumped under
// 'renderer', which is for generic renderer diagnostics).
function traceRuntime(event: string, conversationId: string | null, fields?: Record<string, unknown>): void {
  app.debug?.trace?.({ event, scope: 'agent', conversationId: conversationId ?? undefined, fields });
}

function msgId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function toStoredContent(parts: ContentPart[]): ThreadMessageLike['content'] {
  return parts as unknown as ThreadMessageLike['content'];
}

function messagesHaveImages(messages: ThreadMessageLike[]): boolean {
  return messages.some(
    (m) =>
      m.role === 'user' &&
      Array.isArray(m.content) &&
      m.content.some((part: unknown) => (part as { type?: string }).type === 'image'),
  );
}

function extractUserText(messages: ThreadMessageLike[]): string {
  const firstUser = messages.find((message) => message.role === 'user');
  if (!firstUser || !Array.isArray(firstUser.content)) return '';

  return firstUser.content
    .filter((part: unknown) => (part as { type?: string }).type === 'text')
    .map((part: unknown) => (part as { text?: string }).text ?? '')
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function toTitleCase(value: string): string {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

// Generic image-request phrases that convey no meaningful title on their own
const IMAGE_GENERIC_PHRASES =
  /^(can you |could you |please )?(read|look at|analyze|describe|explain|summarize|check|view|see|show me|tell me about)\s+(this\s+)?(image|picture|photo|screenshot|diagram|chart|graph|file)s?[?.!]*$/i;

function deriveFallbackTitle(messages: ThreadMessageLike[]): string | null {
  const hasImages = messagesHaveImages(messages);
  const text = extractUserText(messages)
    .replace(/[?!.,]+$/g, '')
    .trim();

  // If the message has images and the text is empty or a generic image-request phrase,
  // use a sensible image-analysis title rather than producing garbage.
  if (hasImages && (!text || IMAGE_GENERIC_PHRASES.test(text))) {
    return 'Image Analysis';
  }

  if (!text) return null;

  const weatherMatch = text.match(/\bweather(?:\s+(?:in|for|at)\s+(.+))?$/i);
  if (weatherMatch) {
    const location = weatherMatch[1]?.trim();
    return location ? `${toTitleCase(location)} Weather` : 'Weather';
  }

  const simplified = text
    .replace(/^(what(?:'s| is)|can you|could you|would you|please|tell me|show me|give me)\s+/i, '')
    .replace(/[^\w\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!simplified) return hasImages ? 'Image Analysis' : null;

  return (
    toTitleCase(
      simplified
        .split(' ')
        .filter((word) => word.length > 1)
        .slice(0, 4)
        .join(' '),
    ) || (hasImages ? 'Image Analysis' : null)
  );
}

function extractPromptHistoryText(message: ThreadMessageLike): string | null {
  if (message.role !== 'user' || !Array.isArray(message.content)) return null;

  const text = message.content
    .filter((part: unknown) => (part as { type?: string }).type === 'text')
    .map((part: unknown) => (part as { text?: string }).text ?? '')
    .filter((part) => !part.startsWith('\n\n--- File:') && !part.startsWith('\n[Attached file:'))
    .join('');

  return text.trim() ? text : null;
}

// --- Message tree helpers ---

/** Walk from a leaf message up to the root, returning the active branch (reversed to chronological order) */
export function getActiveBranch(tree: StoredMessage[], headId: string | null): StoredMessage[] {
  if (!headId || tree.length === 0) return [];
  const byId = new Map(tree.map((m) => [m.id, m]));
  const branch: StoredMessage[] = [];
  const visited = new Set<string>();
  let current: string | null = headId;
  while (current) {
    // Cycle guard: a corrupt/malicious messageTree (from disk or the web
    // bridge) with a parentId cycle would otherwise loop forever and hang the
    // renderer, since this runs on every render/persist/stream event. Stop at
    // the first repeated id.
    if (visited.has(current)) break;
    visited.add(current);
    const msg = byId.get(current);
    if (!msg) break;
    branch.unshift(msg);
    current = msg.parentId ?? null;
  }
  return branch;
}

/**
 * Return the id of the newest message in `messages` whose parentId chain
 * terminates at a root WITHOUT hitting a dangling edge (a parentId absent from
 * the tree) or a cycle — i.e. a node `getActiveBranch` can actually walk to a
 * root from. Returns null if no such node exists.
 *
 * Used to recover a reachable display parent when the intended parent/head is a
 * dangling authoritative id: parenting the injected node here keeps the full
 * prior chain visible mid-stream instead of truncating at the dangling edge.
 * Messages are appended in arrival order, so scanning newest→oldest yields the
 * live branch tip. Cycle-guarded so a corrupt parentId loop can't hang the
 * renderer.
 */
function lastConnectedNodeId(messages: StoredMessage[]): string | null {
  const byId = new Map(messages.map((m) => [m.id, m]));
  const reachesRoot = (startId: string): boolean => {
    const visited = new Set<string>();
    let current: string | null = startId;
    while (current) {
      if (visited.has(current)) return false; // cycle → not a clean chain
      visited.add(current);
      const node = byId.get(current);
      if (!node) return false; // dangling edge → chain doesn't reach a root
      if (node.parentId == null) return true; // reached a root
      current = node.parentId;
    }
    return true;
  };
  for (let i = messages.length - 1; i >= 0; i--) {
    if (reachesRoot(messages[i].id)) return messages[i].id;
  }
  return null;
}

/**
 * Choose the parent used for a server-persisted injected user message in the
 * LIVE renderer accumulator. Main may just have persisted the partial assistant
 * under an authoritative id that this accumulator does not contain yet. Using
 * that missing id would make the injected node's parent edge dangling, so
 * getActiveBranch would return only the new node and the prior chat would appear
 * to vanish until the authoritative reload. Prefer the persisted parent only
 * when it exists locally; otherwise retain the current live head for display.
 *
 * Burst hardening: during back-to-back mid-turn injections, `currentHeadId`
 * (the fallback) can ITSELF be a dangling authoritative id — the previous
 * injected node in the burst set `acc.headId` to a mastra `msg-*` id that this
 * accumulator never materialized. Falling back to it would leave the edge just
 * as dangling and still truncate the branch mid-stream. So when neither the
 * candidate nor the live head is present locally, parent onto the live branch
 * tip (the newest node that actually reaches a root), and only as a last resort
 * keep the raw head. This affects LIVE display only; the authoritative `done`
 * reload fixes the exact parent from disk regardless.
 */
export function resolveLiveInjectedParentId(
  messages: StoredMessage[],
  currentHeadId: string | null,
  persistedParentId: string | null,
  mainOwnsPersistence = true,
): string | null {
  const inTree = (id: string | null): boolean => id !== null && messages.some((message) => message.id === id);
  // Renderer-owned streams persist with a debounce, so disk may lag the live
  // assistant even when the persisted parent exists locally. The live head is
  // authoritative for display in that mode — but if that head is itself a
  // dangling id (mid-burst), recover the live branch tip rather than orphaning
  // the branch.
  if (!mainOwnsPersistence)
    return inTree(currentHeadId) ? currentHeadId : (lastConnectedNodeId(messages) ?? currentHeadId);
  if (persistedParentId === null) return null;
  if (inTree(persistedParentId)) return persistedParentId;
  if (inTree(currentHeadId)) return currentHeadId;
  // Both the authoritative parent and the live head are absent locally: parent
  // onto the live branch tip so the injected node stays reachable and
  // getActiveBranch keeps the full prior chain visible mid-stream.
  return lastConnectedNodeId(messages) ?? currentHeadId;
}

/**
 * Reconnect the ACTIVE branch's detached base created by a background-seeded
 * accumulator.
 *
 * When an automation/serverPersisted stream targets a NON-active conversation,
 * the accumulator is seeded synchronously-empty (headId:null) so early deltas
 * aren't dropped, then a best-effort async disk backfill prepends the persisted
 * prefix. But the debounced persist fires on the very first delta — before that
 * backfill wins its disk round-trip — so the first assistant (and anything
 * parented on it, e.g. a mid-turn inject) can reach disk with parentId:null: the
 * active branch's base is a detached root. getActiveBranch then walks
 * activeHeadId→root, stops at that null edge, and prior history "disappears".
 *
 * This walks activeHeadId → up to the root of the branch the user is actually on,
 * and reparents ONLY that base root onto `fallbackHeadId`. It deliberately does
 * NOT touch any other null-root:
 *  • Inactive edit branches (a prior first-message edit) have their own null roots
 *    that are NOT ancestors of activeHeadId — reparenting them would corrupt a
 *    legitimate sibling branch. They're left alone.
 *  • The reparent is skipped when it would cycle (fallbackHead is a descendant of
 *    the base, i.e. already reachable from it) or is a no-op (base === fallbackHead,
 *    or fallbackHead is already on the active chain — the branch isn't detached).
 *
 * `fallbackHeadId` may be a disk node not yet present in `messages` (the prefix
 * hasn't been merged locally). That's intentional: the parent edge points at the
 * disk head, and `conversations:put`'s union-merge re-adds stored nodes the
 * incoming tree is missing, healing the edge.
 *
 * No-op (returns the SAME array) when there's no usable fallback or the active
 * branch already reaches a legitimate root, so it's cheap on the hot persist path.
 * Idempotent.
 */
export function reconnectActiveBranchRoot(
  messages: StoredMessage[],
  activeHeadId: string | null,
  fallbackHeadId: string | null,
): StoredMessage[] {
  // Nothing to anchor to, or no active branch to repair.
  if (!fallbackHeadId || !activeHeadId || fallbackHeadId === activeHeadId) return messages;

  const byId = new Map(messages.map((m) => [m.id, m] as const));

  // Walk the ACTIVE branch up to its base root, recording the chain. If we reach
  // the fallback head along the way, the active branch is already connected to disk
  // history — nothing detached, no repair.
  const activeChain = new Set<string>();
  let base = activeHeadId;
  let cur: string | null = activeHeadId;
  while (cur !== null) {
    if (cur === fallbackHeadId) return messages; // already connected
    if (activeChain.has(cur)) return messages; // pre-existing cycle — don't touch
    activeChain.add(cur);
    base = cur;
    cur = byId.get(cur)?.parentId ?? null;
  }
  // `base` is the root of the active branch. Only repair when it's genuinely a
  // detached null-root that isn't the fallback head itself.
  const baseNode = byId.get(base);
  if (!baseNode || baseNode.parentId !== null || base === fallbackHeadId) return messages;

  // Cycle guard: reparenting base → fallbackHead loops if fallbackHead is a
  // DESCENDANT of base (base is reachable by walking up from fallbackHead). Walk
  // fallbackHead's ancestor chain; if it passes through base, skip. (When
  // fallbackHead isn't in `messages` — a disk-only head — the walk ends quickly
  // without hitting base, so the reconnect proceeds and the put union-merge heals
  // the edge.)
  let fh: string | null = fallbackHeadId;
  const fhSeen = new Set<string>();
  while (fh !== null && !fhSeen.has(fh)) {
    if (fh === base) return messages; // fallbackHead descends from base → would cycle
    fhSeen.add(fh);
    fh = byId.get(fh)?.parentId ?? null;
  }

  // Reparent the detached base onto the disk head, AND stamp an explicit
  // `reconnectTo` hint so the main-side write chokepoint can restore the edge even
  // if a cross-process merge (conversations:put union-merge) or a persist path that
  // bypassed this repair drops it. The hint is cleared by the sanitizer once honored.
  return messages.map((m) => (m.id === base ? { ...m, parentId: fallbackHeadId, reconnectTo: fallbackHeadId } : m));
}

/**
 * True when the last turn in `branch` is already a user message equivalent to
 * `text`. Used to dedup a broadcast `user-message` (from the `kai` CLI, a second
 * GUI window, OR this window's OWN turn echoed back by the backend) against the
 * turn already in this window's tree — inserting the echo would double it.
 *
 * The backend FLATTENS a user turn's content parts to text before broadcasting:
 * text as-is, image → `[Image]`, file → `[File: name]`/`[File]`, space-joined
 * and whitespace-collapsed (see extractMessageText in electron/ipc/agent.ts). So
 * we must flatten the local last-user message the SAME way before comparing —
 * otherwise a message with an image (local text = "hi", broadcast = "hi [Image]")
 * fails the naive text-only compare and the echo gets appended as a duplicate.
 * Exported for testing.
 */
export function flattenUserContentForDedup(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      const p = part as { type?: string; text?: string; filename?: string };
      if (p?.type === 'text') return p.text ?? '';
      if (p?.type === 'file') return p.filename ? `[File: ${p.filename}]` : '[File]';
      if (p?.type === 'image') return '[Image]';
      return '';
    })
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function isDuplicateLastUserMessage(branch: StoredMessage[], text: string): boolean {
  const last = branch[branch.length - 1];
  if (!last || last.role !== 'user') return false;
  const content = Array.isArray(last.content) ? last.content : [];
  // Compare against the flattened representation (matching the backend's
  // broadcast flattening), and also against the bare text part as a fallback
  // for older/simple text-only broadcasts.
  const flattened = flattenUserContentForDedup(content);
  if (flattened === text) return true;
  const textPart = content.find((p: unknown) => (p as { type?: string }).type === 'text') as
    | { text?: string }
    | undefined;
  return textPart?.text === text;
}

/**
 * Locate an existing `tool-call` content part by id ANYWHERE on the active
 * branch, searching newest message → oldest. Returns the index of the owning
 * message in `messages` and the index of the part within that message's
 * content, or null if not found.
 *
 * Needed for mid-turn message splices: when a user sends a follow-up while tools
 * are still running (cooperative `prepareStep` splice), the branch tail moves to
 * the new `user` message, so a later `tool-result`/`tool-progress` for a call
 * that lives in the EARLIER assistant message can't be found by the per-current-
 * message search. Without this the handlers fabricated a duplicate "done" row in
 * the new assistant message and left the original stuck on "in progress".
 */
export function locateToolCallInBranch(
  messages: StoredMessage[],
  headId: string | null,
  toolCallId: string,
): { msgIdx: number; partIdx: number } | null {
  if (!toolCallId) return null;
  const branch = getActiveBranch(messages, headId);
  for (let b = branch.length - 1; b >= 0; b--) {
    const m = branch[b];
    if (!Array.isArray(m.content)) continue;
    const partIdx = (m.content as ContentPart[]).findIndex(
      (p) => p.type === 'tool-call' && p.toolCallId === toolCallId,
    );
    if (partIdx >= 0) {
      const msgIdx = messages.findIndex((mm) => mm.id === m.id);
      if (msgIdx >= 0) return { msgIdx, partIdx };
    }
  }
  return null;
}

/**
 * Walk DOWN from `startId` to the deepest descendant, always taking the last
 * (most recent) child, and return that leaf's id. Cycle-guarded the same way as
 * getActiveBranch so a corrupt parentId cycle can't hang the caller.
 */
export function deepestLatestDescendant(tree: StoredMessage[], startId: string): string {
  let head = startId;
  const visited = new Set<string>([head]);
  const childrenOf = (parentId: string) => tree.filter((m) => m.parentId === parentId);
  let children = childrenOf(head);
  while (children.length > 0) {
    const next = children[children.length - 1].id;
    if (visited.has(next)) break;
    visited.add(next);
    head = next;
    children = childrenOf(head);
  }
  return head;
}

// Sub-agent context
type SubAgentActions = {
  threads: Map<string, SubAgentThreadState>;
  sendMessage: (subAgentConversationId: string, text: string) => Promise<boolean>;
  stop: (subAgentConversationId: string) => Promise<boolean>;
  deleteThread: (subAgentConversationId: string) => void | Promise<void>;
  navigateTo: (subAgentConversationId: string) => void;
  activeSubAgentView: string | null;
  setActiveSubAgentView: (id: string | null) => void;
};

const SubAgentContext = createCtx<SubAgentActions>({
  threads: new Map(),
  sendMessage: async () => false,
  stop: async () => false,
  deleteThread: () => {},
  navigateTo: () => {},
  activeSubAgentView: null,
  setActiveSubAgentView: () => {},
});

export function useSubAgents(): SubAgentActions {
  return useCtx(SubAgentContext);
}

type BranchNav = {
  total: number;
  current: number; // 1-based
  goToPrevious: () => void;
  goToNext: () => void;
};

/** Per-message branch navigation lookup — returns nav for any message on the
 *  active branch that has sibling variants, or null. Called with no argument,
 *  returns nav for the last assistant message (legacy behaviour). */
type BranchNavLookup = (messageId?: string) => BranchNav | null;

const BranchNavContext = createCtx<BranchNavLookup>(() => null);

export function useBranchNav(): BranchNavLookup {
  return useCtx(BranchNavContext);
}

type AssistantResponseTimingState = {
  activeRunStartedAt: string | null;
};

const AssistantResponseTimingContext = createCtx<AssistantResponseTimingState>({
  activeRunStartedAt: null,
});

export function useAssistantResponseTiming(): AssistantResponseTimingState {
  return useCtx(AssistantResponseTimingContext);
}

type PromptHistoryState = {
  conversationId: string | null;
  prompts: string[];
};

const PromptHistoryContext = createCtx<PromptHistoryState>({
  conversationId: null,
  prompts: [],
});

export function usePromptHistory(): PromptHistoryState {
  return useCtx(PromptHistoryContext);
}

/**
 * Compose-while-running state for the composer: whether a turn is live, the
 * configured mid-turn-send mode, and a helper to enqueue a mid-turn follow-up.
 * `sendMidTurn` resolves:
 *   - 'injected' — cooperatively spliced into the running turn (clear the input).
 *   - 'blocked'  — a policy hook rejected the message; it was HANDLED, so the
 *                  caller must NOT fall back to a normal send (that would re-run
 *                  the blocked text / supersede the active turn).
 *   - 'fallback' — not injectable (CLI runtime / ownership changed); the caller
 *                  should do the normal send (supersede / new turn).
 */
type MidTurnSendResult = 'injected' | 'blocked' | 'fallback';
type MidTurnSendOutcome = {
  status: MidTurnSendResult;
  reason?: string;
  /** The conversation the send was routed to (active id at call time). A caller
   *  whose composer belongs to a DIFFERENT conversation now (the user switched
   *  chats during the async gate) must NOT resubmit/restore into the wrong chat. */
  originConversationId?: string | null;
};
type MidTurnComposerState = {
  isRunning: boolean;
  midTurnSend: 'splice' | 'queue-editable';
  sendMidTurn: (text: string) => Promise<MidTurnSendOutcome>;
  /** Pending (not-yet-spliced) injects for the active conversation — the
   *  queue-editable chip UI. Empty in 'splice' mode (chips are only shown when
   *  the setting opts in). */
  pendingInjects: Array<{ id: string; text: string }>;
  /** Cancel a queued inject by id. Returns its text (for the "edit" affordance,
   *  which cancels then pre-fills the composer), or null if already gone. */
  cancelInject: (id: string) => Promise<string | null>;
  /** The CURRENT active conversation id, read LIVE (not captured at render). A
   *  composer's post-await fallback callback uses this to confirm the user hasn't
   *  switched chats since the send — resubmitting/restoring only when it still
   *  matches the send's originConversationId. */
  getActiveConversationId: () => string | null;
  /** Stash a draft for later restoration in a SPECIFIC conversation (FIFO), used
   *  when a mid-turn send's async gate resolved after the user switched chats or
   *  typed a new draft — so the old text isn't silently dropped but resurfaces when
   *  the user returns to `convId`. */
  stashRejectedDraft: (convId: string, text: string) => void;
  /** Mark a conversation so its NEXT onNew bypasses cooperative injection and does a
   *  normal superseding send. A composer's `fallback` branch calls this right before
   *  composerRuntime.send() so the forced normal send doesn't re-enter injectMidTurn
   *  (re-running hooks / splicing onto the old transcript). One-shot; onNew consumes it. */
  markForceNormalSend: (convId: string) => void;
};

const MidTurnComposerContext = createCtx<MidTurnComposerState>({
  isRunning: false,
  midTurnSend: 'splice',
  sendMidTurn: async () => ({ status: 'fallback' }),
  pendingInjects: [],
  cancelInject: async () => null,
  getActiveConversationId: () => null,
  stashRejectedDraft: () => {},
  markForceNormalSend: () => {},
});

export function useMidTurnComposer(): MidTurnComposerState {
  return useCtx(MidTurnComposerContext);
}

type CurrentWorkingDirectoryState = {
  currentWorkingDirectory: string | null;
  setCurrentWorkingDirectory: (cwd: string | null) => Promise<void>;
};

const CurrentWorkingDirectoryContext = createCtx<CurrentWorkingDirectoryState>({
  currentWorkingDirectory: null,
  setCurrentWorkingDirectory: async () => {},
});

export function useCurrentWorkingDirectory(): CurrentWorkingDirectoryState {
  return useCtx(CurrentWorkingDirectoryContext);
}

// Step tracking context for Continue Task feature
type StepTrackingState = {
  stepInfo: { currentStep: number; maxSteps: number; hitLimit: boolean } | null;
  showIncompleteTaskBanner: boolean;
  onContinueTask: () => void;
  onAdjustSettings: () => void;
  onDismissBanner: () => void;
};

const StepTrackingContext = createCtx<StepTrackingState>({
  stepInfo: null,
  showIncompleteTaskBanner: false,
  onContinueTask: () => {},
  onAdjustSettings: () => {},
  onDismissBanner: () => {},
});

export function useStepTracking(): StepTrackingState {
  return useCtx(StepTrackingContext);
}

// Exposes the activeConversationId that is set in the same React batch as
// setTree/setHeadId inside loadConversationState. Consumers that need to react
// *after* the new thread's messages are in the tree (e.g. scroll-to-bottom)
// should use this instead of the IPC-driven app.conversations.onChanged event,
// which fires before the tree has been loaded.
const RuntimeConversationIdContext = createCtx<string | null>(null);

export function useRuntimeConversationId(): string | null {
  return useCtx(RuntimeConversationIdContext);
}

// --- Module-level sub-agent state (survives RuntimeProvider remounts) ---

const globalSubAgentThreads = new Map<string, SubAgentThreadState>();
const globalSubAgentAccumulators = new Map<string, MessageAccumulator>();
/**
 * Tombstones for sub-agent ids the user explicitly DELETED. A delete stops the
 * backend, which broadcasts a `stopped` status asynchronously; without a tombstone
 * that late event would recreate the just-deleted thread (forcing a double-delete).
 * The status/done handlers drop events for tombstoned ids. Cleared if a genuinely
 * NEW run reuses the id (ids are timestamp+random, so reuse is effectively never).
 */
const deletedSubAgentIds = new Set<string>();
// Bound the tombstone set so a long session that deletes many sub-agents can't grow it
// without limit. A tombstone only needs to outlive the deleted run's in-flight late events
// (a `stopped` broadcast arriving right after delete); an id deleted thousands of deletions
// ago has no pending events. Set preserves insertion order → evicting the FIRST drops the
// OLDEST. Sub-agent ids are timestamp+random (never reused), so eviction is safe.
const DELETED_SUBAGENT_IDS_MAX = 1000;
function tombstoneDeletedSubAgent(id: string): void {
  deletedSubAgentIds.add(id);
  while (deletedSubAgentIds.size > DELETED_SUBAGENT_IDS_MAX) {
    const oldest = deletedSubAgentIds.values().next().value as string | undefined;
    if (oldest === undefined) break;
    deletedSubAgentIds.delete(oldest);
  }
}
let globalSubAgentVersion = 0; // bumped on every change to trigger re-renders

// --- Stream accumulator functions ---

const streamAccumulators = new Map<string, MessageAccumulator>();
// Per-conversation run generations (streamTokens) of SUPERSEDED runs. A turn-launcher
// replaces the accumulator BEFORE the old stream is invalidated on the main side, so an
// old delta can arrive while the fresh accumulator has no runGeneration yet and would
// otherwise LOCK it to the superseded run (dropping the real replacement run's events).
// Recording the outgoing accumulator's generation here lets the guard drop those stale
// events and refuse to lock to a known-superseded generation. Bounded per conversation.
const supersededGenerations = new Map<string, Set<string>>();
/** Per-conversation generation of the run whose events are CURRENTLY streaming into it,
 *  recorded the moment we see any tagged event — independent of whether the accumulator
 *  has locked (`acc.runGeneration`) yet. The accumulator can be created by an UNTAGGED
 *  external `user-message` (a peer/CLI turn broadcasts the user turn without a
 *  runGeneration), leaving `acc.runGeneration` null even though a real tagged run is live.
 *  Without this, superseding that accumulator would record nothing, and a late event from
 *  the superseded run could then LOCK the replacement accumulator to the old generation. */
const lastLiveGeneration = new Map<string, string>();
/** Per-conversation set of the SUPERSEDED runs' responseMessageIds. A run whose FIRST
 *  event is still queued in the IPC channel when it is superseded has neither locked its
 *  accumulator's generation NOR appeared in lastLiveGeneration — so a generation blacklist
 *  alone can't catch it, and its queued first event would LOCK the replacement accumulator.
 *  Every streamed event also carries the run's responseMessageId (mastra-agent yields
 *  `{...event, responseMessageId}`), which equals the superseded accumulator's
 *  pendingAssistantId, so recording that id lets the guard drop the queued event before it
 *  locks. (Main's server-side token check drops all superseded events once the replacement
 *  registers its token; this only covers the brief pre-registration window in the renderer.) */
const supersededResponseIds = new Map<string, Set<string>>();
/** Mark the CURRENT accumulator's run generation superseded before installing a
 *  replacement, so its in-flight late events can't bind/hijack the new accumulator. */
function supersedeCurrentGeneration(convId: string): void {
  const acc = streamAccumulators.get(convId);
  // Prefer the accumulator's locked generation; fall back to the last live generation seen
  // for this conversation so an as-yet-unlocked (untagged-external) accumulator is still
  // superseded. Both are recorded to cover the transition window.
  const locked = acc?.runGeneration;
  const live = lastLiveGeneration.get(convId);
  const gens = [locked, live].filter((g): g is string => !!g);
  if (gens.length > 0) {
    let set = supersededGenerations.get(convId);
    if (!set) supersededGenerations.set(convId, (set = new Set()));
    for (const gen of gens) {
      set.add(gen);
      if (set.size > 32) set.delete(set.values().next().value as string); // bound
    }
  }
  // Also blacklist the outgoing run's responseMessageId to catch a run whose first event
  // never reached the renderer (so neither generation was recorded) — its queued event
  // carries this id and must not lock the replacement accumulator.
  const rid = acc?.pendingAssistantId;
  if (rid) {
    let rset = supersededResponseIds.get(convId);
    if (!rset) supersededResponseIds.set(convId, (rset = new Set()));
    rset.add(rid);
    if (rset.size > 32) rset.delete(rset.values().next().value as string); // bound
  }
}
/** Conversations whose live accumulator is driven by an automation run (not an
 *  interactive send). Gates automation-specific behavior: background accumulation,
 *  open-mid-run seeding, and deferring persistence to the main process. */
const automationStreams = new Set<string>();
// Stable per-client-session id used to request MAIN-AUTHORITATIVE continuation authorization. Minted
// once per renderer session (a reload mints a new one). Continuation of a GUI turn (auto-continue on
// max-turns / plan-restart) is renderer-driven, so with multiple clients — or a reloaded client that
// came back as a passive mirror — we must ensure EXACTLY ONE drives it. Rather than a renderer-side
// lease (which cannot reliably tell "reloaded" from "2nd viewer"), the driving decision is delegated
// to main: agent:authorize-continuation grants the FIRST caller per turn (keyed by the run's stream
// token) and denies the rest. See the max-turns / plan-restart handlers.
const CONTINUATION_CLIENT_ID = msgId();
// True when this renderer is a WEB-bridge client (browser), not an Electron window. A web client
// receives FRAME-CAPPED stream events (large tool output/media stripped for the transport), so even
// for a turn it ORIGINATED (locallyOriginated:true) its in-memory accumulator is TRUNCATED — a
// continuation must therefore reload the authoritative full branch from main first, exactly like a
// passive mirror, instead of continuing from (and overwriting the full nodes with) the capped copy.
const IS_WEB_BRIDGE = Boolean((window as unknown as { app?: { __isWebBridge?: boolean } }).app?.__isWebBridge);
/** Automation conversations we've begun async-seeding a background accumulator for
 *  (dedupes the disk fetch while events stream in before the seed resolves). */
const automationSeedInProgress = new Set<string>();
/** Conversations where the next assistant message should be forced-new (after realtime call reconnect) */
const forceNewAssistant = new Set<string>();
/** Conversations whose NEXT onNew must BYPASS cooperative mid-turn injection and go
 *  straight to a normal (superseding) send. Set by a composer's `fallback` path
 *  (sendMidTurn reported the branch changed / the run isn't injectable) right before
 *  it calls composerRuntime.send(): without this, onNew sees the run still running
 *  and re-enters injectMidTurn — re-running policy hooks and splicing onto the OLD
 *  transcript, defeating the branch-safety fallback. Consumed (deleted) by onNew. */
const forceNormalSendConvs = new Set<string>();
/** Per-conversation persist version counter — incremented before each persist, checked before writing.
 *  Prevents stale async persists from overwriting newer data. */
const persistVersions = new Map<string, number>();

// Per-conversation snapshot of the tree/head a terminal handler FINALIZED just before it
// deleted the accumulator. Its terminal persist is fire-and-forget, so there's a window where
// the accumulator is gone but the finalized content isn't on disk yet. onNew (after an awaited
// injectMidTurn that falls back) reads this to base the new turn on the AUTHORITATIVE finalized
// content — a plain disk reread in that window could return the pre-finalization PARTIAL tree
// (possibly equal length), and the new turn would then overwrite the terminal write.
// This is a TRANSIENT bridge: it's only needed from the terminal-delete until the fire-and-
// forget persist lands (well under a second). It holds the FULL tree (incl. base64 media), so
// it MUST NOT be retained indefinitely — a self-expiring timer clears it shortly after the
// persist can't still be in flight. Also cleared on consume (next onNew) + conversation delete.
const lastFinalizedBranch = new Map<string, { messages: StoredMessage[]; headId: string | null }>();
const lastFinalizedBranchTimers = new Map<string, ReturnType<typeof setTimeout>>();
const FINALIZED_BRANCH_TTL_MS = 15_000; // far longer than any persist round-trip; bounds media retention
function recordFinalizedBranch(convId: string, messages: StoredMessage[], headId: string | null): void {
  lastFinalizedBranch.set(convId, { messages: [...messages], headId });
  const prevTimer = lastFinalizedBranchTimers.get(convId);
  if (prevTimer) clearTimeout(prevTimer);
  lastFinalizedBranchTimers.set(
    convId,
    setTimeout(() => {
      lastFinalizedBranch.delete(convId);
      lastFinalizedBranchTimers.delete(convId);
    }, FINALIZED_BRANCH_TTL_MS),
  );
}
function clearFinalizedBranch(convId: string): void {
  lastFinalizedBranch.delete(convId);
  const t = lastFinalizedBranchTimers.get(convId);
  if (t) {
    clearTimeout(t);
    lastFinalizedBranchTimers.delete(convId);
  }
}

// Per-conversation handoff for a paid compaction record that a persist is TRYING to write
// but hasn't confirmed on disk yet. A terminal (done/error) persist carrying a compaction
// is fire-and-forget; if a new turn's persist supersedes it (version bump) before it lands,
// the record would be lost AND the new accumulator can't inherit it (the old one was
// deleted). Recording it here — cleared only when a persist returns persisted:true for the
// same compactionId — lets onNew / continuations recover it and durably re-persist.
const pendingCompactionHandoff = new Map<string, ConversationCompaction>();
// TTL + global FIFO cap for handoff entries stashed by the LATE-compaction path (a renderer
// compaction whose accumulator was already deleted, e.g. a Stop, so it never routes through
// persistConversation's confirmed-persist clear). Without this a dormant conversation that
// never gets another turn would retain the summary + covered-id array + signature map for the
// renderer's lifetime. The persistConversation set site (in-flight write) is NOT armed with a
// TTL — it clears on persisted:true / delete — so only the late path expires here.
const lateCompactionHandoffTimers = new Map<string, ReturnType<typeof setTimeout>>();
const LATE_COMPACTION_HANDOFF_TTL_MS = 5 * 60_000; // generous vs a follow-up turn; bounds retention
const LATE_COMPACTION_HANDOFF_MAX = 64; // cap distinct dormant conversations holding a stash
function stashLateCompactionHandoff(convId: string, record: ConversationCompaction): void {
  // Global FIFO cap: evict the oldest stashed conversation (Map preserves insertion order).
  // Only evict entries we armed a timer for (the late path) so an in-flight persist handoff is
  // never dropped; re-inserting an existing key below refreshes its recency.
  pendingCompactionHandoff.delete(convId);
  const t = lateCompactionHandoffTimers.get(convId);
  if (t) clearTimeout(t);
  while (lateCompactionHandoffTimers.size >= LATE_COMPACTION_HANDOFF_MAX) {
    const oldest = lateCompactionHandoffTimers.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    const ot = lateCompactionHandoffTimers.get(oldest);
    if (ot) clearTimeout(ot);
    lateCompactionHandoffTimers.delete(oldest);
    pendingCompactionHandoff.delete(oldest);
  }
  pendingCompactionHandoff.set(convId, record);
  lateCompactionHandoffTimers.set(
    convId,
    setTimeout(() => {
      pendingCompactionHandoff.delete(convId);
      lateCompactionHandoffTimers.delete(convId);
    }, LATE_COMPACTION_HANDOFF_TTL_MS),
  );
}
// Clear a late-handoff TTL timer when the entry is consumed/cleared elsewhere (persist confirm,
// inherit, delete) so a stale timer can't later delete a NEWER in-flight handoff for the same id.
function clearLateCompactionHandoffTimer(convId: string): void {
  const t = lateCompactionHandoffTimers.get(convId);
  if (t) {
    clearTimeout(t);
    lateCompactionHandoffTimers.delete(convId);
  }
}

// Per-conversation QUEUE of inputs that a compact-busy rollback could NOT return to the
// composer at the time — the user had switched to another chat or started a newer draft, so
// restoring then would target the wrong conversation or clobber a live draft. A FIFO queue
// (not a single slot) so that if A is stashed and B is later rejected before A is restored,
// BOTH survive (a single slot would either overwrite A or discard B). Restored one-at-a-time
// (oldest first) by loadConversationState + the composer-empty poll (into an empty composer
// only). Cleared per-entry on restore, or wholesale when the conversation is deleted. Bounded.
type RejectedDraft = { id: string; text: string; attachments: AttachedFile[]; stashedAt: number };
const rejectedDrafts = new Map<string, RejectedDraft[]>();
// Conversations with a draft claim currently in flight on THIS client — serializes the load-restore
// and the composer-empty poll so they can't both claim (and double-restore) the same draft.
const draftClaimInFlight = new Set<string>();
// Rejected drafts are DURABLE USER INPUT (the user's unsent text/attachments), NOT a cache —
// per the durably-persist decision they are cleared ONLY on restore into the composer or when
// the conversation is deleted, NEVER by a time-based TTL or count-eviction (both silently lose
// input the user still expects to get back). The in-memory queue is a fast-restore mirror
// hydrated from disk on load, so its size is bounded by conversations touched this session, not
// unbounded; the durable disk copy is one small `pendingDrafts` per conversation, cleared on
// restore. Each draft carries a UNIQUE id so the durable store is updated by ADD/REMOVE DELTA
// (never a wholesale replace) — otherwise two clients concurrently stashing/restoring drafts for
// the SAME conversation would erase each other's entries (last-writer-wins). A very high
// per-conversation cap remains only as a pathological safety valve.
const MAX_REJECTED_DRAFTS_PER_CONV = 200; // pathological safety valve only
function enqueueRejectedDraft(convId: string, draft: { text: string; attachments: AttachedFile[] }): void {
  if (draft.text.trim().length === 0 && draft.attachments.length === 0) return;
  const q = rejectedDrafts.get(convId) ?? [];
  const entry: RejectedDraft = { id: msgId(), ...draft, stashedAt: Date.now() };
  q.push(entry);
  // Pathological safety valve only. If ever hit, drop the OLDEST (least likely still wanted) —
  // and remove it from the durable store by id so the delta stays consistent.
  const evicted = q.length > MAX_REJECTED_DRAFTS_PER_CONV ? q.shift() : undefined;
  rejectedDrafts.set(convId, q);
  // DURABLE copy: the in-memory queue is the fast-restore mirror, but a reload/close/crash before
  // restore would silently lose this unsent input. ADD this draft to the conversation record's
  // pendingDrafts via a FIELD-ONLY DELTA update on main (merges with any concurrent client's
  // drafts; never wholesale-replaces). loadConversationState hydrates from it; restore removes it.
  void applyPendingDraftsDelta(convId, [entry], evicted ? [evicted.id] : []);
}
// Re-enqueue an EXISTING draft entry (preserving its id + stashedAt) — used when an atomic claim
// removed a draft from disk but the restore couldn't apply (chat switched / composer busy). Push
// to the FRONT so it's the next one restored, and re-ADD it durably so it survives across reload.
function enqueueRejectedDraftEntry(convId: string, entry: RejectedDraft): void {
  if (entry.text.trim().length === 0 && entry.attachments.length === 0) return;
  const q = rejectedDrafts.get(convId) ?? [];
  if (!q.some((d) => d.id === entry.id)) q.unshift(entry);
  const evicted = q.length > MAX_REJECTED_DRAFTS_PER_CONV ? q.pop() : undefined; // drop NEWEST on overflow (keep this requeued one)
  rejectedDrafts.set(convId, q);
  applyPendingDraftsDelta(convId, [entry], evicted ? [evicted.id] : []);
}
/** Dequeue the OLDEST rejected draft for a conversation, or undefined if none. */
function dequeueRejectedDraft(convId: string): RejectedDraft | undefined {
  const q = rejectedDrafts.get(convId);
  if (!q || q.length === 0) return undefined;
  const next = q.shift();
  if (q.length === 0) rejectedDrafts.delete(convId);
  if (next) applyPendingDraftsDelta(convId, [], [next.id]); // remove the consumed draft by id (delta)
  return next;
}
// Peek the OLDEST rejected draft's id without removing it (used to name the atomic claim below).
function peekOldestRejectedDraftId(convId: string): string | undefined {
  const q = rejectedDrafts.get(convId);
  return q && q.length > 0 ? q[0]?.id : undefined;
}
// Remove a specific draft id from the in-memory queue only (no durable delta — the atomic claim
// on main already mutated disk). Used to keep the local mirror consistent after a claim resolves.
function dropRejectedDraftLocal(convId: string, id: string): void {
  const q = rejectedDrafts.get(convId);
  if (!q) return;
  const next = q.filter((d) => d.id !== id);
  if (next.length === 0) rejectedDrafts.delete(convId);
  else rejectedDrafts.set(convId, next);
}
// Re-add an entry to the LOCAL in-memory queue only (front, deduped) — NO durable delta. Used when
// a lease-claimed draft failed to restore: the ack(restored=false) already left it on disk, so a
// durable re-add would duplicate the on-disk copy; we only need it back in this session's queue.
function requeueRejectedDraftLocalOnly(convId: string, entry: RejectedDraft): void {
  if (entry.text.trim().length === 0 && entry.attachments.length === 0) return;
  const q = rejectedDrafts.get(convId) ?? [];
  if (!q.some((d) => d.id === entry.id)) q.unshift(entry);
  rejectedDrafts.set(convId, q);
}
// ATOMICALLY claim the oldest pending draft on MAIN and restore it into the composer — but only if
// THIS client won the claim. When several clients hydrated the same durable pendingDrafts, main's
// single-threaded remove-and-return guarantees exactly one `draft !== null`, so the others don't
// populate a duplicate composer. Because main removes the draft BEFORE `restore` runs, `restore`
// must ACK whether it actually applied: it returns true if it populated the composer, false if it
// bailed (the user switched chats / started typing / added an attachment during the async claim).
// On a false ack we REQUEUE the claimed draft — durably (re-add via delta) AND locally — so the
// input is never lost (the r162 claim otherwise dropped it from both disk and memory). Falls back
// to the local dequeue if the claim IPC is unavailable, so a single-client session is unchanged.
async function claimAndRestoreDraft(convId: string, restore: (d: RejectedDraft) => boolean): Promise<void> {
  // Renderer-side claim-in-flight guard: the load-time restore and the composer-empty poll can
  // overlap for the SAME conversation, and main treats THIS client's own live reservation as
  // available (so it can re-claim after a crash) — so two concurrent same-client claims would both
  // receive the draft and double-restore it. Serialize per conversation on this client.
  if (draftClaimInFlight.has(convId)) return;
  const id = peekOldestRejectedDraftId(convId);
  if (!id) return;
  draftClaimInFlight.add(convId);
  try {
    const res = await app.conversations.claimPendingDraft?.(convId, id, CONTINUATION_CLIENT_ID);
    if (res === undefined) {
      // IPC not present (older bridge) — fall back to the local-only path. Requeue on a false ack.
      const local = dequeueRejectedDraft(convId);
      if (local && !restore(local)) enqueueRejectedDraftEntry(convId, local);
      return;
    }
    if (res.ok && res.draft) {
      const d: RejectedDraft = {
        id: res.draft.id || id,
        text: res.draft.text,
        attachments: (res.draft.attachments as RejectedDraft['attachments']) ?? [],
        stashedAt: res.draft.stashedAt,
      };
      dropRejectedDraftLocal(convId, d.id);
      // Lease+ACK: the draft is still RETAINED on disk (reserved, not removed) — so a crash between
      // here and the ack does NOT lose it (the reservation expires → re-claimable). ACK the
      // outcome: restored=true hard-removes it; restored=false releases the reservation AND we
      // requeue locally so this session retries it. (ack is best-effort; a lost ack just leaves the
      // reservation to expire, after which the draft is re-claimable — never lost.)
      const applied = restore(d);
      void app.conversations.ackPendingDraft?.(convId, d.id, applied, CONTINUATION_CLIENT_ID).catch(() => {});
      // On a failed restore the ack(false) released the reservation → the draft is STILL on disk
      // (unreserved), so re-add it to the LOCAL queue only (no durable delta — that would duplicate
      // the on-disk copy) so this session retries it on a later tick.
      if (!applied) requeueRejectedDraftLocalOnly(convId, d);
    } else if (res.ok && res.reserved) {
      // Another client holds a LIVE reservation on this draft. Do NOT drop our local marker — if
      // that client crashed before ack, its reservation expires (~30s) and we must be able to
      // reclaim it on a later poll tick. Keeping the marker means the poll keeps retrying; the
      // draft is never orphaned. (No composer clobber — we didn't restore anything.)
      // (leave rejectedDrafts[convId] as-is)
    } else {
      // Genuinely gone (no live reservation, not returned) — reconcile our local mirror.
      dropRejectedDraftLocal(convId, id);
    }
  } catch {
    // Claim failed — leave the draft in place (both disk and local) for a later retry tick.
  } finally {
    draftClaimInFlight.delete(convId);
  }
}
// Apply a DELTA to a conversation record's durable `pendingDrafts` — add these drafts, remove
// these ids — via a FIELD-ONLY main-side update (conversations:setPendingDrafts). A DELTA (not a
// wholesale replace of this client's local queue) is essential: two clients concurrently
// stashing/restoring drafts for the SAME conversation must MERGE, not last-writer-wins-erase.
// Main read-modify-writes the CURRENT disk pendingDrafts (never a stale whole-record put).
// Best-effort: the in-memory queue is authoritative within a session; this is the
// crash/reload-survival copy.
//
// Deltas for a given conversation are SERIALIZED and COALESCED through a per-conv buffer +
// single-flight flusher. Serialization matters because the retry loop below can sleep between
// attempts: without it, an ADD whose first attempt fails could re-persist a draft AFTER a
// concurrent REMOVE for that same id already landed (resurrecting a restored draft — struct P3
// r162). Coalescing (an ADD then a REMOVE of the SAME id within one flush cancel out) also
// collapses the common stash-then-immediately-restore case into a no-op write.
type PendingDraftDelta = { adds: Map<string, RejectedDraft>; removes: Set<string> };
const pendingDraftDeltas = new Map<string, PendingDraftDelta>();
const draftDeltaFlushing = new Map<string, Promise<void>>();
function applyPendingDraftsDelta(convId: string, add: RejectedDraft[], removeIds: string[]): void {
  let buf = pendingDraftDeltas.get(convId);
  if (!buf) {
    buf = { adds: new Map(), removes: new Set() };
    pendingDraftDeltas.set(convId, buf);
  }
  for (const d of add) {
    buf.removes.delete(d.id); // a re-add supersedes a pending remove of the same id
    buf.adds.set(d.id, d);
  }
  for (const id of removeIds) {
    if (buf.adds.delete(id)) continue; // add+remove of same id in one flush → net no-op
    buf.removes.add(id);
  }
  // Kick the flusher if idle; if one is running it will re-check the buffer when it finishes.
  if (!draftDeltaFlushing.has(convId)) void flushPendingDraftDeltas(convId);
}
async function flushPendingDraftDeltas(convId: string): Promise<void> {
  if (draftDeltaFlushing.has(convId)) return;
  const run = (async () => {
    // Drain until the buffer is empty; a delta enqueued mid-write is picked up on the next lap.
    for (;;) {
      const buf = pendingDraftDeltas.get(convId);
      if (!buf || (buf.adds.size === 0 && buf.removes.size === 0)) {
        pendingDraftDeltas.delete(convId);
        return;
      }
      pendingDraftDeltas.delete(convId); // take ownership of this batch; new ops start a fresh buffer
      const addPayload = [...buf.adds.values()].map((d) => ({
        id: d.id,
        text: d.text,
        attachments: d.attachments as unknown[],
        stashedAt: d.stashedAt,
      }));
      const removeIds = [...buf.removes];
      // Bounded retry: the in-memory queue is authoritative within a session, but the DURABLE copy
      // matters across restart — a dropped ADD loses the stash if the process exits, and a dropped
      // REMOVE resurrects an already-restored draft on the next launch. A field-only main write
      // rarely fails; a few spaced retries turn a transient IPC/disk blip into an eventual success.
      let ok = false;
      for (let attempt = 0; attempt < 4 && !ok; attempt++) {
        try {
          await app.conversations.setPendingDrafts?.(convId, { add: addPayload, removeIds });
          ok = true;
        } catch {
          if (attempt < 3) await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
        }
      }
      if (!ok) {
        // Exhausted this batch. Re-fold it into the buffer so a later delta's flush retries it —
        // but only ops not already superseded by a newer op (a fresh remove wins over our add).
        const next = pendingDraftDeltas.get(convId) ?? { adds: new Map(), removes: new Set() };
        for (const d of buf.adds.values()) if (!next.removes.has(d.id) && !next.adds.has(d.id)) next.adds.set(d.id, d);
        for (const id of buf.removes) if (!next.adds.has(id)) next.removes.add(id);
        pendingDraftDeltas.set(convId, next);
        return; // stop laps; the next applyPendingDraftsDelta call restarts the flusher
      }
    }
  })();
  draftDeltaFlushing.set(convId, run);
  try {
    await run;
  } finally {
    draftDeltaFlushing.delete(convId);
    // If ops arrived after the loop observed an empty buffer but before we cleared the flag, flush.
    const buf = pendingDraftDeltas.get(convId);
    if (buf && (buf.adds.size > 0 || buf.removes.size > 0)) void flushPendingDraftDeltas(convId);
  }
}
// Hydrate the in-memory queue from a conversation record's persisted `pendingDrafts` (a reload
// or a client that never stashed them in memory). Only fills an EMPTY in-memory slot so a live
// in-session queue is never clobbered. No TTL: rejected drafts are durable user input, cleared
// only on restore / conversation delete. Returns true if anything was hydrated.
function hydrateRejectedDraftsFromDisk(convId: string, conv: { pendingDrafts?: unknown } | null): boolean {
  if (!conv || rejectedDrafts.has(convId)) return false;
  const raw = conv.pendingDrafts;
  if (!Array.isArray(raw) || raw.length === 0) return false;
  const restored: RejectedDraft[] = [];
  for (const d of raw as Array<{ id?: unknown; text?: unknown; attachments?: unknown; stashedAt?: unknown }>) {
    const text = typeof d?.text === 'string' ? d.text : '';
    const attachments = Array.isArray(d?.attachments) ? (d.attachments as AttachedFile[]) : [];
    const stashedAt = typeof d?.stashedAt === 'number' ? d.stashedAt : Date.now();
    const id = typeof d?.id === 'string' && d.id.length > 0 ? d.id : msgId();
    if (text.trim().length === 0 && attachments.length === 0) continue;
    restored.push({ id, text, attachments, stashedAt });
  }
  if (restored.length === 0) return false;
  rejectedDrafts.set(convId, restored);
  return true;
}

function createPendingAssistantTiming(startedAt = nowIso()): PendingAssistantTiming {
  return { startedAt };
}

// Reconstruct a run's captured settings from a persisted conversation record — used when a passive
// mirror (no in-memory runConfig) wins a continuation and must restart with THIS conversation's
// model/profile/CWD/thread overrides rather than the currently-active chat's live refs.
function runConfigFromConversationRecord(conv: Record<string, unknown>): NonNullable<MessageAccumulator['runConfig']> {
  const s = conv as {
    selectedModelKey?: string | null;
    reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh';
    selectedProfileKey?: string | null;
    fallbackEnabled?: boolean;
    currentWorkingDirectory?: string | null;
    executionMode?: 'auto' | 'plan-first';
    temperature?: number | null;
    systemPromptOverride?: string | null;
    maxSteps?: number | null;
    maxRetries?: number | null;
    runtimeOverride?: string | null;
  };
  return {
    selectedModelKey: s.selectedModelKey ?? null,
    reasoningEffort: s.reasoningEffort ?? undefined,
    selectedProfileKey: s.selectedProfileKey ?? null,
    fallbackEnabled: s.fallbackEnabled ?? false,
    cwd: s.currentWorkingDirectory ?? null,
    executionMode: s.executionMode ?? undefined,
    threadOverrides: {
      temperature: s.temperature ?? null,
      systemPromptOverride: s.systemPromptOverride ?? null,
      maxSteps: s.maxSteps ?? null,
      maxRetries: s.maxRetries ?? null,
      runtimeOverride: s.runtimeOverride ?? null,
    },
  };
}

function getAccumulatorStartedAt(acc: MessageAccumulator | undefined): string | null {
  if (!acc) return null;

  if (acc.pendingAssistantTiming?.startedAt) {
    return acc.pendingAssistantTiming.startedAt;
  }

  const branch = getActiveBranch(acc.messages, acc.headId);
  const last = branch[branch.length - 1];
  if (last?.role !== 'assistant') return null;

  return getResponseTiming(last)?.startedAt ?? null;
}

function withPendingAssistantTiming(message: StoredMessage, acc: MessageAccumulator): StoredMessage {
  const startedAt = acc.pendingAssistantTiming?.startedAt;
  if (!startedAt) return message;
  if (getResponseTiming(message)?.startedAt) return message;
  return withResponseTiming(message, { startedAt });
}

function finalizeAssistantResponse(acc: MessageAccumulator, finishedAt = nowIso()): void {
  const branch = getActiveBranch(acc.messages, acc.headId);
  const last = branch[branch.length - 1];

  if (last?.role !== 'assistant') {
    acc.pendingAssistantTiming = null;
    acc.pendingAssistantId = null;
    return;
  }

  const startedAt = getResponseTiming(last)?.startedAt ?? acc.pendingAssistantTiming?.startedAt;
  if (!startedAt) {
    acc.pendingAssistantTiming = null;
    acc.pendingAssistantId = null;
    return;
  }

  const idx = acc.messages.findIndex((m) => m.id === last.id);
  if (idx < 0) {
    acc.pendingAssistantTiming = null;
    acc.pendingAssistantId = null;
    return;
  }

  const content = acc.messages[idx].content;
  if (Array.isArray(content)) {
    type ToolCallPart = {
      type: string;
      result?: unknown;
      finishedAt?: string;
      isError?: boolean;
      isHung?: boolean;
      approvalStatus?: string;
    };
    let mutated = false;
    for (const part of content) {
      const tc = part as ToolCallPart;
      if (tc.type === 'tool-call' && tc.result === undefined && tc.approvalStatus !== 'pending') {
        tc.result = { isHung: true, error: 'Stream ended before tool result was received.' };
        tc.isHung = true;
        tc.finishedAt = finishedAt;
        mutated = true;
      }
    }
    if (mutated) {
      acc.messages[idx] = { ...acc.messages[idx], content: [...content] };
    }
  }

  acc.messages[idx] = withResponseTiming(acc.messages[idx], buildResponseTiming(startedAt, finishedAt));
  acc.pendingAssistantTiming = null;
  acc.pendingAssistantId = null;
}

/**
 * Reorder a mid-turn-inject boundary when the injected user was inserted BEFORE
 * the prior step's assistant prefix existed. If exactly one assistant node is
 * parented on `injectedUserId` and it is NOT the per-boundary continuation node
 * (`${injectedUserId}-cont`, which legitimately follows the user), that assistant
 * is the prior step's output mis-created under the user — swap them so ordering is
 * `prefix → injectedUser` (the model produced the prefix before it saw the
 * inject). Advances headId from the prefix to the user when needed. Pure: returns
 * new messages/headId (no mutation). No-op otherwise.
 */
export function reorderPrefixBeforeInjectedUser(
  messages: StoredMessage[],
  headId: string | null,
  injectedUserId: string,
): { messages: StoredMessage[]; headId: string | null } {
  const user = messages.find((m) => m.id === injectedUserId);
  if (!user) return { messages, headId };
  const contId = `${injectedUserId}-cont`;
  const childAssistants = messages.filter(
    (m) => m.parentId === injectedUserId && m.role === 'assistant' && m.id !== contId,
  );
  // A transient model-fallback can leave MULTIPLE assistant variants under the
  // injected user (a failed partial + the successful reply). Pick the ACTIVE one —
  // the variant on the current head's ancestor lineage — so the successful reply
  // (not a failed sibling) is threaded before the user (matches the disk-side
  // reorderInjectPrefixOnDisk). If none is on the head lineage, don't guess.
  let prefix: StoredMessage | undefined;
  if (childAssistants.length === 1) {
    prefix = childAssistants[0];
  } else if (childAssistants.length > 1) {
    const byId = new Map(messages.map((m) => [m.id, m] as const));
    const onHeadLineage = (id: string): boolean => {
      let cur: string | null = headId;
      const seen = new Set<string>();
      while (cur && !seen.has(cur)) {
        if (cur === id) return true;
        seen.add(cur);
        cur = byId.get(cur)?.parentId ?? null;
      }
      return false;
    };
    prefix = childAssistants.find((m) => onHeadLineage(m.id));
  }
  if (!prefix) return { messages, headId };
  const userParent = user.parentId;
  const prefixId = prefix.id;
  // Move EVERY assistant variant under the injected user (not just the active one):
  // a transient fallback can leave a failed partial + the successful reply as
  // siblings there, both produced BEFORE the model saw the inject. Leaving the
  // failed sibling under the injected user would group it with the eventual
  // continuation in branch selection (and a renderer persist could undo the
  // disk-side repair). Reparent all to the pre-inject head; attach the injected user
  // only to the ACTIVE variant (prefix).
  const variantIds = new Set(
    messages.filter((m) => m.role === 'assistant' && m.parentId === injectedUserId).map((m) => m.id),
  );
  const nextMessages = messages.map((m) => {
    if (variantIds.has(m.id)) return { ...m, parentId: userParent };
    if (m.id === injectedUserId) return { ...m, parentId: prefixId };
    return m;
  });
  const nextHead = headId === prefixId ? injectedUserId : headId;
  return { messages: nextMessages, headId: nextHead };
}

/**
 * Batch-aware variant of reorderPrefixBeforeInjectedUser for a multi-inject
 * boundary consumed together. When several injects were broadcast before the
 * prior step's first assistant delta, the temporary tree is
 * `pre → u1 → u2 → … → prefix` (the prefix landed under the LAST user). The prefix
 * was produced BEFORE any of them, so it belongs BEFORE the whole chain:
 * `pre → prefix → u1 → u2 → …`. Find the single non-continuation assistant parented
 * on ANY injected user in the batch, move it to the FIRST injected user's parent,
 * and reparent that first user onto it — leaving the rest of the user chain intact
 * after it. Pure. No-op when there's no such misplaced prefix. `injectedIds` is in
 * FIFO (chain) order.
 */
export function reorderPrefixBeforeInjectedUserChain(
  messages: StoredMessage[],
  headId: string | null,
  injectedIds: string[],
): { messages: StoredMessage[]; headId: string | null } {
  if (injectedIds.length === 0) return { messages, headId };
  if (injectedIds.length === 1) return reorderPrefixBeforeInjectedUser(messages, headId, injectedIds[0]);
  const idSet = new Set(injectedIds);
  const contIds = new Set(injectedIds.map((id) => `${id}-cont`));
  // The misplaced prefix: a non-continuation assistant whose parent is one of the
  // batch's injected users. A transient model-fallback can leave MULTIPLE variants
  // (a failed partial + the successful reply) — select the ACTIVE one on the
  // current head's ancestor lineage (matches the single-entry + disk repairs).
  const allPrefixes = messages.filter(
    (m) => m.role === 'assistant' && typeof m.parentId === 'string' && idSet.has(m.parentId) && !contIds.has(m.id),
  );
  let prefix: StoredMessage | undefined;
  if (allPrefixes.length === 1) {
    prefix = allPrefixes[0];
  } else if (allPrefixes.length > 1) {
    const byId = new Map(messages.map((m) => [m.id, m] as const));
    const onHeadLineage = (id: string): boolean => {
      let cur: string | null = headId;
      const seen = new Set<string>();
      while (cur && !seen.has(cur)) {
        if (cur === id) return true;
        seen.add(cur);
        cur = byId.get(cur)?.parentId ?? null;
      }
      return false;
    };
    prefix = allPrefixes.find((m) => onHeadLineage(m.id));
  }
  if (!prefix) return { messages, headId };
  const firstUser = messages.find((m) => m.id === injectedIds[0]);
  if (!firstUser) return { messages, headId };
  const prefixId = prefix.id;
  const chainParent = firstUser.parentId; // the pre-inject head
  // Move EVERY assistant variant that sits under the SAME injected user as the
  // active prefix (a transient fallback can leave a failed partial + the successful
  // reply as siblings there, both produced before the inject was consumed) back to
  // the pre-inject head — attaching the first injected user only to the ACTIVE one.
  // Leaving a failed sibling under the injected user would group it with the
  // continuation in branch selection.
  const variantParent = prefix.parentId;
  const variantIds = new Set(
    messages.filter((m) => m.role === 'assistant' && m.parentId === variantParent).map((m) => m.id),
  );
  const nextMessages = messages.map((m) => {
    if (variantIds.has(m.id)) return { ...m, parentId: chainParent };
    if (m.id === injectedIds[0]) return { ...m, parentId: prefixId };
    return m;
  });
  // If the head was the misplaced prefix, advance it to the tail of the user chain.
  const nextHead = headId === prefixId ? injectedIds[injectedIds.length - 1] : headId;
  return { messages: nextMessages, headId: nextHead };
}

export function getOrCreateAssistantInAcc(acc: MessageAccumulator): { msg: StoredMessage; idx: number } {
  let desiredId = acc.pendingAssistantId ?? undefined;
  // Cooperative-inject continuation: if the reused responseMessageId (desiredId)
  // is a CLOSED prefix, do NOT reuse the prefix node id (that collapses the
  // continuation into the prefix on persist, dropping the injected user
  // off-branch). Use the DETERMINISTIC per-boundary continuation id
  // (`${injectedUserId}-cont`, set at the boundary) — which the main-process
  // fallback derives identically (so a crash-time replace-by-id matches, no
  // duplicate) and which differs per inject (so a 2nd inject rotates again).
  if (desiredId && acc.closedPrefixIds?.has(desiredId)) {
    desiredId = acc.injectContinuationId ?? `${desiredId}-cont`;
  }
  // A cooperative-inject continuation boundary is OPEN (injectContinuationId is the
  // CURRENT boundary's deterministic id; a new boundary rotates it and moves the old
  // one into closedPrefixIds). ALL continuation content for this boundary must land on
  // that id. A PRE-CONTENT model-fallback rotates acc.pendingAssistantId to the fallback
  // model's FRESH id — which is NOT a closed prefix, so the branch above wouldn't
  // redirect it; without this pin the renderer would create the continuation under the
  // fresh id while main's fallback accumulator uses `${injectedUser}-cont` → divergent
  // ids → a duplicate sibling on a main finalize. Pin the WHOLE boundary (not just until
  // the node first materializes — else a fallback's SECOND delta, arriving after the
  // deterministic node exists, would revert to the fresh id and fork a duplicate node):
  // the reuse-in-place check below then reuses the materialized node, or creates it.
  if (acc.injectContinuationId && desiredId !== acc.injectContinuationId) {
    desiredId = acc.injectContinuationId;
  }
  // Cooperative-inject ordering guard: when an inject was broadcast mid-step, the
  // `user-message` handler advanced acc.headId to the injected user BEFORE the
  // prior step's remaining deltas arrived (the ordered `inject-consumed` marker
  // that closes the prefix comes AFTER them). Those remainder deltas still belong
  // to the STILL-OPEN node (desiredId not yet closed), but the branch tail is now
  // the user — so the tail check below would create a NEW assistant UNDER the user
  // (`user → remainder`), corrupting order. If a message with the RESOLVED desiredId
  // already exists AND that id is NOT a closed prefix, update THAT node in place so
  // the remainder stays with the still-open node, before the user. Keyed on
  // desiredId (the resolved target), NOT pendingAssistantId — after a 2nd inject the
  // reused pendingAssistantId is closed while desiredId is the OPEN 2nd continuation,
  // which must still be reused in place rather than duplicated.
  if (desiredId && !acc.closedPrefixIds?.has(desiredId)) {
    const existingIdx = acc.messages.findIndex((m) => m.id === desiredId && m.role === 'assistant');
    if (existingIdx >= 0) {
      const timed = withPendingAssistantTiming(acc.messages[existingIdx], acc);
      if (timed !== acc.messages[existingIdx]) acc.messages[existingIdx] = timed;
      return { msg: acc.messages[existingIdx], idx: existingIdx };
    }
  }
  const branch = getActiveBranch(acc.messages, acc.headId);
  const last = branch[branch.length - 1];
  if (last?.role === 'assistant' && (!desiredId || last.id === desiredId)) {
    const idx = acc.messages.findIndex((m) => m.id === last.id);
    const timed = withPendingAssistantTiming(last, acc);
    if (timed !== last && idx >= 0) {
      acc.messages[idx] = timed;
    }
    return { msg: timed, idx };
  }
  // Create new assistant message. When this accumulator was background-seeded
  // (automation/serverPersisted into a non-active conversation) its headId starts
  // null, so parent on the known on-disk head instead — otherwise this first
  // assistant becomes a detached root that severs prior history when persisted
  // (the mid-turn-inject orphan-root bug). Falls back to acc.headId (the normal
  // case) when no seeded disk head is known.
  const parentId = acc.headId ?? acc.seededDiskHeadId ?? null;
  const baseMsg: StoredMessage = {
    id: desiredId ?? msgId(),
    parentId,
    role: 'assistant',
    content: [],
    createdAt: new Date(),
  };
  const newMsg = withPendingAssistantTiming(baseMsg, acc);
  acc.messages.push(newMsg);
  acc.headId = newMsg.id;
  return { msg: newMsg, idx: acc.messages.length - 1 };
}

function applyAssistantMessageMeta(message: StoredMessage, messageMeta?: Record<string, unknown>): StoredMessage {
  if (!messageMeta || Object.keys(messageMeta).length === 0) return message;
  return {
    ...message,
    messageMeta: {
      ...(message.messageMeta ?? {}),
      ...messageMeta,
    },
  };
}

function applyTextDelta(acc: MessageAccumulator, text: string, messageMeta?: Record<string, unknown>): void {
  const { msg, idx } = getOrCreateAssistantInAcc(acc);
  const content = (Array.isArray(msg.content) ? [...msg.content] : []) as ContentPart[];
  const lastPart = content[content.length - 1];

  if (lastPart?.type === 'text' && (lastPart.source ?? 'assistant') === 'assistant') {
    content[content.length - 1] = { type: 'text', source: 'assistant', text: lastPart.text + text };
  } else {
    content.push({ type: 'text', source: 'assistant', text });
  }
  acc.messages[idx] = applyAssistantMessageMeta({ ...msg, content: toStoredContent(content) }, messageMeta);
}

function applyObserverMessage(acc: MessageAccumulator, text: string, messageMeta?: Record<string, unknown>): void {
  const { msg, idx } = getOrCreateAssistantInAcc(acc);
  const content = (Array.isArray(msg.content) ? [...msg.content] : []) as ContentPart[];
  const normalized = text.trim();
  if (!normalized) return;
  const lastPart = content[content.length - 1];
  // Keep observer updates plain and lightweight; the assistant response adds the separator
  // when transitioning back to final output.
  const block = `${lastPart?.type === 'text' ? '\n\n' : ''}${normalized}\n\n`;
  content.push({ type: 'text', source: 'observer', text: block });
  acc.messages[idx] = applyAssistantMessageMeta({ ...msg, content: toStoredContent(content) }, messageMeta);
}

function applyToolCall(
  acc: MessageAccumulator,
  e: { toolCallId: string; toolName: string; args: unknown; startedAt?: string },
): void {
  const { msg, idx } = getOrCreateAssistantInAcc(acc);
  const content = (Array.isArray(msg.content) ? [...msg.content] : []) as ContentPart[];
  const existingIdx = content.findIndex((p) => p.type === 'tool-call' && p.toolCallId === e.toolCallId);
  const matchMode = existingIdx >= 0 ? 'exact' : 'new';
  if (existingIdx >= 0) {
    const existing = content[existingIdx] as ContentPart & { type: 'tool-call' };
    content[existingIdx] = {
      ...existing,
      toolName: e.toolName || existing.toolName,
      args: e.args ?? existing.args ?? {},
      argsText: JSON.stringify(e.args ?? existing.args ?? {}, null, 2),
      startedAt: e.startedAt ?? existing.startedAt ?? nowIso(),
      liveOutput: existing.liveOutput ?? { stdout: '', stderr: '', truncated: false, stopped: false },
    };
  } else {
    content.push({
      type: 'tool-call',
      toolCallId: e.toolCallId,
      toolName: e.toolName,
      args: e.args ?? {},
      argsText: JSON.stringify(e.args, null, 2),
      startedAt: e.startedAt ?? nowIso(),
      liveOutput: { stdout: '', stderr: '', truncated: false, stopped: false },
    });
  }
  logRuntimeToolDebug('apply-tool-call', {
    toolCallId: e.toolCallId,
    toolName: e.toolName,
    matchMode,
    toolParts: summarizeToolParts(content),
  });
  acc.messages[idx] = { ...msg, content: toStoredContent(content) };
}

function applyToolProgress(
  acc: MessageAccumulator,
  e: {
    toolCallId?: string;
    toolName?: string;
    data?: {
      stream?: 'stdout' | 'stderr';
      output?: string;
      truncated?: boolean;
      stopped?: boolean;
      subAgentConversationId?: string;
    };
  },
): void {
  const { msg, idx } = getOrCreateAssistantInAcc(acc);
  const content = (Array.isArray(msg.content) ? [...msg.content] : []) as ContentPart[];
  let tcIdx = -1;
  let matchMode: 'exact' | 'sub-agent' | 'fallback' | 'orphan' = 'orphan';
  // PRIMARY for sub-agent progress: bind by subAgentConversationId. A sub-agent
  // is uniquely identified by its conversation id (namespace-independent, unique
  // per child), so once a tool-call part is bound to a child, ALL its later
  // progress attaches to that exact part — robust to parallel sub-agents and to
  // any execute/stream tool-call id divergence (which the id-exact match below
  // is NOT). The first progress for a child (before binding) falls through to
  // the id/most-recent match, which then sets the binding via mergeLiveOutput.
  const subAgentConvId = e.data?.subAgentConversationId;
  if (subAgentConvId) {
    tcIdx = content.findIndex((p) => p.type === 'tool-call' && p.liveOutput?.subAgentConversationId === subAgentConvId);
    if (tcIdx >= 0) matchMode = 'sub-agent';
  }
  if (tcIdx < 0 && e.toolCallId) {
    const exactIdx = content.findIndex((p) => p.type === 'tool-call' && p.toolCallId === e.toolCallId);
    if (exactIdx >= 0) {
      const exactPart = content[exactIdx] as ContentPart & { type: 'tool-call' };
      // Conflict guard on the exact-id path too: never attach a child's progress
      // to a part already bound to a DIFFERENT child (would mis-route). In the
      // identity case (exec id === stream id, the norm) this never triggers; it
      // only guards a pathological id collision.
      const boundToOther =
        subAgentConvId &&
        exactPart.liveOutput?.subAgentConversationId &&
        exactPart.liveOutput.subAgentConversationId !== subAgentConvId;
      if (!boundToOther) {
        tcIdx = exactIdx;
        matchMode = 'exact';
      }
    }
  }
  if (tcIdx < 0) {
    // Some runtimes emit progress before call metadata or without call id, so
    // attach to the most recent unresolved tool call.
    //
    // AMBIGUITY GUARD for sub-agent progress: the first progress for a child
    // (before its conversation-id binding exists) has no exact/conversation
    // match. The reverse scan below would pick the newest unbound card — but with
    // PARALLEL sub_agent calls whose execute ids differ from stream ids, that can
    // be the WRONG child, and the binding would then permanently mis-route it. So
    // when this progress names a child, only bind via the fallback if there is
    // exactly ONE eligible unbound sub_agent candidate; if several are unbound,
    // leave it unattached this tick (the common case is exec id === stream id, so
    // the id-exact match above resolves it; a genuinely-diverged parallel first
    // progress waits rather than mis-binds).
    //
    // ACCEPTED LIMITATION: if TWO parallel sub_agent calls BOTH had execute ids
    // differing from their stream ids, each first-progress would see two unbound
    // candidates and stay orphaned until one completes (binding only via result).
    // We accept this rather than reintroduce server-side exec↔stream pairing
    // (removed as unsound): Mastra's tool execution context types toolCallId as a
    // required string, so execute id === stream id in practice and the id-exact
    // path above binds each card deterministically — this ambiguous-divergence
    // case does not occur with the Mastra runtime.
    if (subAgentConvId) {
      const unboundSubAgents = content.filter(
        (p) =>
          p.type === 'tool-call' &&
          p.result === undefined &&
          // STRICTLY sub_agent tool calls — never a generic tool (e.g. a lone
          // `bash` card) even when this progress carries no toolName, so a child's
          // conversation id/output can't bind onto an unrelated tool.
          p.toolName === 'sub_agent' &&
          !p.liveOutput?.subAgentConversationId,
      );
      if (unboundSubAgents.length === 1) {
        tcIdx = content.indexOf(unboundSubAgents[0]);
        matchMode = 'fallback';
      }
      // else: ambiguous or none — do not guess (falls through to orphan handling).
    } else {
      for (let i = content.length - 1; i >= 0; i--) {
        const part = content[i];
        if (part.type !== 'tool-call') continue;
        if (part.result !== undefined) continue;
        if (e.toolName && part.toolName !== e.toolName) continue;
        tcIdx = i;
        matchMode = 'fallback';
        break;
      }
    }
  }
  if (tcIdx < 0) {
    // Not in the current assistant message. If the call lives in an EARLIER
    // assistant message on the branch (mid-turn user splice moved the tail),
    // update it in place there rather than dropping the progress.
    if (e.toolCallId) {
      const loc = locateToolCallInBranch(acc.messages, acc.headId, e.toolCallId);
      if (loc) {
        applyLiveOutputAt(acc, loc.msgIdx, loc.partIdx, e);
        return;
      }
    }
    // Ignore orphan progress without a resolvable tool call to avoid duplicate cards.
    logRuntimeToolDebug('apply-tool-progress-orphan', {
      toolCallId: e.toolCallId ?? null,
      toolName: e.toolName ?? null,
      toolParts: summarizeToolParts(content),
    });
    return;
  }

  const existing = content[tcIdx] as ContentPart & { type: 'tool-call' };
  const liveOutput = mergeLiveOutput(existing, e);
  content[tcIdx] = { ...existing, liveOutput };
  logRuntimeToolDebug('apply-tool-progress', {
    toolCallId: e.toolCallId ?? null,
    toolName: e.toolName ?? null,
    matchMode,
    toolParts: summarizeToolParts(content),
  });
  acc.messages[idx] = { ...msg, content: toStoredContent(content) };
}

/** Merge a progress event's stream output into a tool-call part's liveOutput. */
function mergeLiveOutput(
  existing: ContentPart & { type: 'tool-call' },
  e: {
    toolName?: string;
    data?: { stream?: 'stdout' | 'stderr'; output?: string; truncated?: boolean; stopped?: boolean };
  },
): NonNullable<(ContentPart & { type: 'tool-call' })['liveOutput']> {
  // Bind `subAgentConversationId` into liveOutput ONLY from TRUSTED sub-agent
  // progress: the part is already a sub_agent tool-call, OR this progress event's
  // backend toolName is `sub_agent`. `ToolProgressEvent` is supplied by tool
  // implementations, so a non-sub_agent tool could otherwise emit a child's id in
  // its progress and get its card promoted to a sub-agent (exposing that child's
  // navigate/message/stop controls). Once bound, keep the existing id.
  const progressIsSubAgent = existing.toolName === 'sub_agent' || e.toolName === 'sub_agent';
  const boundSubAgentId =
    existing.liveOutput?.subAgentConversationId ??
    (progressIsSubAgent
      ? (e.data as { subAgentConversationId?: string } | undefined)?.subAgentConversationId
      : undefined);
  const liveOutput = {
    stdout: existing.liveOutput?.stdout ?? '',
    stderr: existing.liveOutput?.stderr ?? '',
    truncated: existing.liveOutput?.truncated ?? false,
    stopped: existing.liveOutput?.stopped ?? false,
    subAgentConversationId: boundSubAgentId,
  };
  if (e.data?.stream === 'stdout') liveOutput.stdout = e.data.output ?? liveOutput.stdout;
  if (e.data?.stream === 'stderr') liveOutput.stderr = e.data.output ?? liveOutput.stderr;
  liveOutput.truncated = Boolean(liveOutput.truncated || e.data?.truncated);
  liveOutput.stopped = Boolean(liveOutput.stopped || e.data?.stopped);
  return liveOutput;
}

/** Apply liveOutput to a tool-call at a specific (message, part) location — used
 *  when a progress event's call lives in an earlier branch message. */
function applyLiveOutputAt(
  acc: MessageAccumulator,
  msgIdx: number,
  partIdx: number,
  e: {
    data?: { stream?: 'stdout' | 'stderr'; output?: string; truncated?: boolean; stopped?: boolean };
  },
): void {
  const target = acc.messages[msgIdx];
  if (!target || !Array.isArray(target.content)) return;
  const content = [...(target.content as ContentPart[])];
  const existing = content[partIdx] as ContentPart & { type: 'tool-call' };
  if (!existing || existing.type !== 'tool-call') return;
  content[partIdx] = { ...existing, liveOutput: mergeLiveOutput(existing, e) };
  acc.messages[msgIdx] = { ...target, content: toStoredContent(content) };
}

type ToolCompactionEvent = {
  toolCallId?: string;
  toolName?: string;
  data?: {
    phase?: 'start' | 'complete' | 'error' | null;
    originalContent?: string;
    extractionDurationMs?: number;
  };
};

/** Apply a compaction phase transition to a tool-call part. Pure — returns the
 *  updated part. Shared by the current-message and cross-branch paths. */
function applyCompactionToPart(
  existing: ContentPart & { type: 'tool-call' },
  e: ToolCompactionEvent,
): ContentPart & { type: 'tool-call' } {
  if (e.data?.phase === 'start') {
    return {
      ...existing,
      compactionPhase: 'start',
      ...(typeof e.data.originalContent === 'string' && e.data.originalContent.length > 0
        ? { originalResult: existing.originalResult ?? e.data.originalContent }
        : {}),
    };
  }
  if (e.data?.phase === 'complete') {
    return {
      ...existing,
      compactionPhase: 'complete',
      ...(typeof e.data.originalContent === 'string' && e.data.originalContent.length > 0
        ? { originalResult: existing.originalResult ?? e.data.originalContent }
        : {}),
      compactionMeta: {
        wasCompacted: true,
        extractionDurationMs: e.data.extractionDurationMs ?? existing.compactionMeta?.extractionDurationMs ?? 0,
      },
    };
  }
  return { ...existing, compactionPhase: null };
}

function applyToolCompaction(acc: MessageAccumulator, e: ToolCompactionEvent): void {
  const { msg, idx } = getOrCreateAssistantInAcc(acc);
  const content = (Array.isArray(msg.content) ? [...msg.content] : []) as ContentPart[];
  let tcIdx = -1;
  let matchMode: 'exact' | 'fallback' | 'created' = 'created';
  if (e.toolCallId) {
    tcIdx = content.findIndex((p) => p.type === 'tool-call' && p.toolCallId === e.toolCallId);
    if (tcIdx >= 0) matchMode = 'exact';
  }
  if (tcIdx < 0) {
    for (let i = content.length - 1; i >= 0; i--) {
      const part = content[i];
      if (part.type !== 'tool-call') continue;
      if (part.result !== undefined) continue;
      if (e.toolName && part.toolName !== e.toolName) continue;
      tcIdx = i;
      matchMode = 'fallback';
      break;
    }
  }
  if (tcIdx < 0) {
    // Cross-branch: the call may live in an earlier assistant message (mid-turn
    // splice). Update it there rather than fabricating a duplicate.
    if (e.toolCallId) {
      const loc = locateToolCallInBranch(acc.messages, acc.headId, e.toolCallId);
      if (loc) {
        const target = acc.messages[loc.msgIdx];
        const tContent = [...(target.content as ContentPart[])];
        tContent[loc.partIdx] = applyCompactionToPart(tContent[loc.partIdx] as ContentPart & { type: 'tool-call' }, e);
        acc.messages[loc.msgIdx] = { ...target, content: toStoredContent(tContent) };
        return;
      }
    }
    if (!e.toolCallId) return;
    content.push({
      type: 'tool-call',
      toolCallId: e.toolCallId,
      toolName: e.toolName ?? 'unknown',
      args: {},
      argsText: '{}',
      startedAt: nowIso(),
      liveOutput: { stdout: '', stderr: '', truncated: false, stopped: false },
    });
    tcIdx = content.length - 1;
    matchMode = 'created';
  }

  content[tcIdx] = applyCompactionToPart(content[tcIdx] as ContentPart & { type: 'tool-call' }, e);

  logRuntimeToolDebug('apply-tool-compaction', {
    toolCallId: e.toolCallId ?? null,
    toolName: e.toolName ?? null,
    phase: e.data?.phase ?? null,
    matchMode,
    hasOriginalContent: typeof e.data?.originalContent === 'string' && e.data.originalContent.length > 0,
    extractionDurationMs: e.data?.extractionDurationMs ?? null,
    toolParts: summarizeToolParts(content),
  });
  acc.messages[idx] = { ...msg, content: toStoredContent(content) };
}

type ToolResultEvent = {
  toolCallId?: string;
  toolName?: string;
  result: unknown;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  compaction?: {
    originalContent: string;
    wasCompacted: boolean;
    extractionDurationMs: number;
  };
};

/** Stamp a tool-result event onto a tool-call part (result + timing + any
 *  compaction metadata). Pure — returns the updated part. Shared by the
 *  current-message path and the cross-branch (mid-turn splice) path. */
function applyResultToPart(
  existing: ContentPart & { type: 'tool-call' },
  e: ToolResultEvent,
): ContentPart & { type: 'tool-call' } {
  const finishedAt = e.finishedAt ?? nowIso();
  const compactionFields: Partial<ContentPart & { type: 'tool-call' }> = e.compaction?.wasCompacted
    ? {
        originalResult: e.compaction.originalContent,
        compactionMeta: {
          wasCompacted: true,
          extractionDurationMs: e.compaction.extractionDurationMs,
        },
        compactionPhase: 'complete' as const,
      }
    : {};
  return {
    ...existing,
    result: e.result,
    startedAt: e.startedAt ?? existing.startedAt ?? finishedAt,
    finishedAt,
    ...(e.durationMs !== undefined ? { durationMs: e.durationMs } : {}),
    ...(!e.compaction?.wasCompacted && existing.compactionPhase === 'start'
      ? { compactionPhase: existing.compactionMeta?.wasCompacted ? ('complete' as const) : null }
      : {}),
    ...compactionFields,
  };
}

function applyToolResult(acc: MessageAccumulator, e: ToolResultEvent): void {
  const { msg, idx } = getOrCreateAssistantInAcc(acc);
  const content = (Array.isArray(msg.content) ? [...msg.content] : []) as ContentPart[];
  let tcIdx = -1;
  let matchMode: 'exact' | 'fallback' | 'created' = 'created';
  if (e.toolCallId) {
    tcIdx = content.findIndex((p) => p.type === 'tool-call' && p.toolCallId === e.toolCallId);
    if (tcIdx >= 0) matchMode = 'exact';
  }
  if (tcIdx < 0) {
    for (let i = content.length - 1; i >= 0; i--) {
      const part = content[i];
      if (part.type !== 'tool-call') continue;
      if (part.result !== undefined) continue;
      if (e.toolName && part.toolName !== e.toolName) continue;
      tcIdx = i;
      matchMode = 'fallback';
      break;
    }
  }
  if (tcIdx < 0) {
    // Not in the current assistant message — a mid-turn user splice may have
    // moved the branch tail past the message that holds this call. Update the
    // original tool-call in place (in its earlier message) instead of
    // fabricating a duplicate "done" row here.
    if (e.toolCallId) {
      const loc = locateToolCallInBranch(acc.messages, acc.headId, e.toolCallId);
      if (loc) {
        const target = acc.messages[loc.msgIdx];
        const tContent = [...(target.content as ContentPart[])];
        const tPart = tContent[loc.partIdx] as ContentPart & { type: 'tool-call' };
        tContent[loc.partIdx] = applyResultToPart(tPart, e);
        acc.messages[loc.msgIdx] = { ...target, content: toStoredContent(tContent) };
        logRuntimeToolDebug('apply-tool-result', {
          toolCallId: e.toolCallId ?? null,
          toolName: e.toolName ?? null,
          matchMode: 'cross-branch',
          hasCompaction: Boolean(e.compaction?.wasCompacted),
          toolParts: summarizeToolParts(tContent),
        });
        return;
      }
    }
    if (!e.toolCallId) return;
    content.push({
      type: 'tool-call',
      toolCallId: e.toolCallId,
      toolName: e.toolName ?? 'unknown',
      args: {},
      argsText: '{}',
      startedAt: e.startedAt ?? nowIso(),
      liveOutput: { stdout: '', stderr: '', truncated: false, stopped: false },
    });
    tcIdx = content.length - 1;
    matchMode = 'created';
  }
  if (tcIdx >= 0) {
    content[tcIdx] = applyResultToPart(content[tcIdx] as ContentPart & { type: 'tool-call' }, e);
  }
  logRuntimeToolDebug('apply-tool-result', {
    toolCallId: e.toolCallId ?? null,
    toolName: e.toolName ?? null,
    matchMode,
    hasCompaction: Boolean(e.compaction?.wasCompacted),
    toolParts: summarizeToolParts(content),
  });
  acc.messages[idx] = { ...msg, content: toStoredContent(content) };
}

function applyTokenUsage(acc: MessageAccumulator, usage: TokenUsageData): void {
  const branch = getActiveBranch(acc.messages, acc.headId);
  const last = branch[branch.length - 1];
  if (!last || last.role !== 'assistant') return;
  const idx = acc.messages.findIndex((m) => m.id === last.id);
  if (idx < 0) return;
  acc.messages[idx] = { ...acc.messages[idx], tokenUsage: usage };
}

function applyError(acc: MessageAccumulator, error: string): void {
  const { msg, idx } = getOrCreateAssistantInAcc(acc);
  const content = (Array.isArray(msg.content) ? [...msg.content] : []) as ContentPart[];
  content.push({ type: 'text', text: `\n\n**Error:** ${error}` });
  acc.messages[idx] = { ...msg, content: toStoredContent(content) };
}

function formatStreamError(raw: string, category?: string, statusCode?: number): string {
  if (category === 'auth') {
    if (statusCode === 403) return 'Access denied — please contact your administrator for model access.';
    if (statusCode === 401) return 'Authentication failed — please check your API key or sign in again.';
    return 'Authorization error — please check your credentials and try again.';
  }
  if (category === 'quota') {
    return 'Payment required — this provider account is out of credit or quota. Falling back to another model if one is configured.';
  }
  return raw;
}

function applyEnrichments(acc: MessageAccumulator, data: Record<string, unknown>): void {
  // Normalize enrichment payload from multiple event shapes — supports both flat keys and nested
  const debate = (data['debate:result'] ?? data['debate'] ?? data['debate_result']) as
    | Record<string, unknown>
    | undefined;
  const curation = (data['curation:stats'] ?? data['curation'] ?? data['curation_stats']) as
    | Record<string, unknown>
    | undefined;

  if (!debate && !curation) return;

  const enrichments: PipelineEnrichments = {};

  if (debate && typeof debate === 'object') {
    enrichments.debate = {
      enabled: Boolean(debate.enabled ?? true),
      rounds: typeof debate.rounds === 'number' ? debate.rounds : undefined,
      advocate_model: typeof debate.advocate_model === 'string' ? debate.advocate_model : undefined,
      challenger_model: typeof debate.challenger_model === 'string' ? debate.challenger_model : undefined,
      judge_model: typeof debate.judge_model === 'string' ? debate.judge_model : undefined,
      advocate_summary: typeof debate.advocate_summary === 'string' ? debate.advocate_summary : undefined,
      challenger_summary: typeof debate.challenger_summary === 'string' ? debate.challenger_summary : undefined,
      judge_confidence: typeof debate.judge_confidence === 'number' ? debate.judge_confidence : undefined,
    };
  }

  if (curation && typeof curation === 'object') {
    enrichments.curation = {
      thinking_blocks_stripped:
        typeof curation.thinking_blocks_stripped === 'number' ? curation.thinking_blocks_stripped : undefined,
      tool_results_distilled:
        typeof curation.tool_results_distilled === 'number' ? curation.tool_results_distilled : undefined,
      exchanges_folded: typeof curation.exchanges_folded === 'number' ? curation.exchanges_folded : undefined,
      superseded_reads_evicted:
        typeof curation.superseded_reads_evicted === 'number' ? curation.superseded_reads_evicted : undefined,
      duplicates_removed: typeof curation.duplicates_removed === 'number' ? curation.duplicates_removed : undefined,
      token_savings_estimate:
        typeof curation.token_savings_estimate === 'number' ? curation.token_savings_estimate : undefined,
    };
  }

  const { msg, idx } = getOrCreateAssistantInAcc(acc);
  const content = (Array.isArray(msg.content) ? [...msg.content] : []) as ContentPart[];

  // Replace existing enrichments part if present, otherwise append
  const existingIdx = content.findIndex((p) => p.type === 'enrichments');
  if (existingIdx >= 0) {
    content[existingIdx] = { type: 'enrichments', enrichments };
  } else {
    content.push({ type: 'enrichments', enrichments });
  }

  acc.messages[idx] = { ...msg, content: toStoredContent(content) };
}

function discardTrailingAssistant(acc: MessageAccumulator): void {
  const branch = getActiveBranch(acc.messages, acc.headId);
  const last = branch[branch.length - 1];
  if (last?.role !== 'assistant') return;
  acc.messages = acc.messages.filter((m) => m.id !== last.id);
  acc.headId = last.parentId ?? null;
}

/**
 * Preserve the trailing (partial) assistant message as its OWN variant after a
 * transient mid-stream fallback: annotate it with the error, then rewind the
 * head to that message's PARENT so the retry's first delta creates a fresh
 * assistant SIBLING under the same parent. The BranchPicker then shows the
 * failed partial and the successful retry as "k / N variants". Returns true if a
 * trailing assistant was sealed.
 */
export function preserveErroredAssistantVariant(acc: MessageAccumulator, errorText: string): boolean {
  const branch = getActiveBranch(acc.messages, acc.headId);
  const last = branch[branch.length - 1];
  if (last?.role !== 'assistant') return false;
  const idx = acc.messages.findIndex((m) => m.id === last.id);
  if (idx < 0) return false;
  const content = (Array.isArray(last.content) ? [...last.content] : []) as ContentPart[];
  content.push({ type: 'text', text: `\n\n**Error:** ${errorText}` });
  acc.messages[idx] = { ...last, content: toStoredContent(content) };
  // Rewind head to the errored variant's parent so the retry is a sibling.
  acc.headId = last.parentId ?? null;
  // If the sealed variant IS this run's open inject-continuation node, the boundary
  // is now closed for it: the retry must be a fresh SIBLING, not another delta on
  // this (errored) continuation. Close it out (record it as a closed prefix and clear
  // injectContinuationId) so getOrCreateAssistantInAcc no longer pins the retry's
  // fresh response id onto the sealed node. A subsequent inject re-opens a boundary.
  if (acc.injectContinuationId && last.id === acc.injectContinuationId) {
    acc.closedPrefixIds ??= new Set();
    acc.closedPrefixIds.add(acc.injectContinuationId);
    acc.injectContinuationId = null;
  }
  return true;
}

// --- Persistence ---

async function persistConversation(
  conversationId: string,
  tree: StoredMessage[],
  headId: string | null,
  updates: Partial<ConversationRecord> = {},
  // Opt-in orphan-root repair. Set ONLY by background-seeded persist paths
  // (automation/serverPersisted into a non-active conversation). When
  // `seededBackground` is true, a detached root the background seed produced is
  // reconnected onto `seededDiskHeadId` — or, if that hasn't resolved yet (the
  // debounce can beat the async backfill), onto the head read from disk here.
  // Left undefined for every normal persist (edits, regenerations, active-conv
  // turns) so a LEGITIMATE second root — e.g. editing the first user message
  // creates an intentional sibling branch with parentId:null — is never rewritten.
  seedContext?: { seededBackground?: boolean; seededDiskHeadId?: string | null },
): Promise<{ rejected?: string; superseded?: boolean; persisted?: boolean }> {
  // Bump version BEFORE the async boundary to claim this persist operation.
  // This prevents stale debounced persists from overwriting newer data
  // (e.g. done handler's runStatus:'idle' overwritten by a late schedulePersist's 'running').
  const currentVersion = (persistVersions.get(conversationId) ?? 0) + 1;
  persistVersions.set(conversationId, currentVersion);
  // A compaction record this persist should durably write. Prefer one the caller
  // explicitly carries; otherwise, for a TURN-STARTING persist (runStatus:'running'/
  // 'awaiting-approval'), INHERIT any pending handoff — a terminal done/error's
  // fire-and-forget compaction persist may have been superseded before it landed, and
  // EVERY turn-launching path (onNew/onEdit/onReload/Continue/ContinueTask/branch-switch),
  // not just onNew, must carry that paid summary forward so the next stream reuses it.
  const carriedCompaction = (updates as { conversationCompaction?: ConversationCompaction }).conversationCompaction;
  const startsTurn =
    (updates as { runStatus?: string }).runStatus === 'running' ||
    (updates as { runStatus?: string }).runStatus === 'awaiting-approval';
  const effectiveCompaction = carriedCompaction?.compactionId
    ? carriedCompaction
    : startsTurn
      ? pendingCompactionHandoff.get(conversationId)
      : undefined;
  // Register in the handoff map BEFORE the first await — else a terminal persist that gets
  // superseded during its `conversations.get()` would early-return BEFORE registering, and
  // a racing resubmit would find no handoff. Cleared below only on a confirmed persisted:true.
  // Arm the TTL+cap (via stashLateCompactionHandoff) so a persist that never confirms — REJECTED
  // (busy), SUPERSEDED, or a write ERROR — doesn't leak the record forever; the confirmed-persist
  // clear below cancels the TTL for a write that DID land.
  if (effectiveCompaction?.compactionId) {
    stashLateCompactionHandoff(conversationId, effectiveCompaction);
  }
  // Fold the inherited handoff into what's actually written (the caller didn't supply it).
  if (effectiveCompaction?.compactionId && !carriedCompaction?.compactionId) {
    updates = { ...updates, conversationCompaction: effectiveCompaction };
  }

  try {
    const conv = (await app.conversations.get(conversationId)) as ConversationRecord | null;
    if (!conv) {
      // Conversation was deleted — its pending compaction handoff (registered above) is
      // now worthless; drop it so deleting compacting chats doesn't retain summaries for
      // the renderer's lifetime.
      pendingCompactionHandoff.delete(conversationId);
      clearLateCompactionHandoffTimer(conversationId);
      // REJECTED (deleted), NOT superseded: a launcher treats `superseded` as retry-then-launch
      // (it would eventually start model/tool execution against a GONE conversation whose I/O
      // can't be persisted); `rejected:'conversation-deleted'` makes it roll back + not launch.
      return { rejected: 'conversation-deleted' };
    }

    // After the async get(), check if a newer persist started while we were waiting
    const latestVersion = persistVersions.get(conversationId) ?? 0;
    if (currentVersion < latestVersion) return { superseded: true };

    // INVARIANT (mid-turn-inject orphan-root fix): never persist an active branch
    // whose base is a DETACHED root produced by a background-seeded accumulator.
    // Such an accumulator starts with headId:null, so its first assistant — and
    // anything parented on it, e.g. a mid-turn inject — can carry parentId:null,
    // making the active branch's base a detached root. Writing that severs prior
    // history (getActiveBranch stops at the null edge → the GUI shows an
    // "empty/cleared" thread). Reconnect ONLY the active branch's base onto the
    // authoritative disk head. This is OPT-IN (only background-seeded paths pass
    // seedContext) and scoped to the active branch, so legitimate inactive edit
    // branches (their own null roots) and edit-roots on other persist paths are
    // never touched. `conversations:put`'s union-merge re-adds any stored node the
    // incoming tree lacks, healing an edge that points at a disk-only head.
    let safeTree = tree;
    if (seedContext?.seededBackground) {
      const diskTree = Array.isArray(conv.messageTree) ? (conv.messageTree as StoredMessage[]) : [];
      const fallbackHead =
        seedContext.seededDiskHeadId ?? conv.headId ?? (diskTree.length > 0 ? diskTree[diskTree.length - 1].id : null);
      safeTree = reconnectActiveBranchRoot(tree, headId, fallbackHead);
    }

    const branch = getActiveBranch(safeTree, headId);
    const now = nowIso();

    const res = await app.conversations.put({
      ...conv,
      messages: branch, // linear view for backward compat
      messageTree: safeTree,
      headId,
      fallbackTitle: conv.fallbackTitle ?? null,
      updatedAt: now,
      lastMessageAt: now,
      messageCount: branch.length,
      userMessageCount: branch.filter((m) => m.role === 'user').length,
      ...updates,
    });
    // Main rejects a turn-starting put while the conversation is being /compact-ed
    // (returns { rejected: 'conversation-busy' } and persists nothing new). Surface it so
    // the caller can roll back the optimistic turn instead of launching a stream that
    // would also be rejected.
    if (res && typeof res === 'object' && (res as { rejected?: unknown }).rejected) {
      return { rejected: String((res as { rejected?: unknown }).rejected) };
    }
    // The write landed. If it carried the handed-off compaction, clear the handoff (it's
    // now durably on disk — and the main-side put-preservation keeps it against staler
    // writes). Only clear when it's still the SAME record we recorded (a newer one may
    // have replaced it meanwhile).
    if (effectiveCompaction?.compactionId) {
      const held = pendingCompactionHandoff.get(conversationId);
      if (held?.compactionId === effectiveCompaction.compactionId) {
        pendingCompactionHandoff.delete(conversationId);
        clearLateCompactionHandoffTimer(conversationId);
      }
    }
    return { persisted: true };
  } catch (err) {
    console.error('[Runtime] Failed to persist:', err);
    return {};
  }
}

/** Seed provenance from an accumulator, for persistConversation's orphan-root
 *  repair. Returns undefined for a normally-seeded accumulator so no repair runs
 *  (edits/regenerations/active-conv turns are never rewritten). */
function seedContextFor(
  acc: MessageAccumulator | undefined,
): { seededBackground: boolean; seededDiskHeadId?: string | null } | undefined {
  return acc?.seededBackground ? { seededBackground: true, seededDiskHeadId: acc.seededDiskHeadId } : undefined;
}

// --- Title generation logic ---

type TitleGenerationSettings = {
  enabled: boolean;
};

async function getTitleGenerationSettings(): Promise<TitleGenerationSettings> {
  try {
    const config = (await app.config.get()) as { titleGeneration?: Partial<TitleGenerationSettings> } | null;
    const tg = config?.titleGeneration ?? {};
    return {
      enabled: tg.enabled ?? true,
    };
  } catch {
    return {
      enabled: true,
    };
  }
}

// Track last retitle count per conversation to avoid duplicate title gen
const lastRetitleCount = new Map<string, number>();
const titleGenInFlight = new Set<string>();

/** Update only specific fields on a conversation without overwriting message data.
 *  Reads the latest record from disk immediately before writing to minimize race windows. */
async function updateConversation(
  conversationId: string,
  createPatch: (latest: ConversationRecord) => Partial<ConversationRecord>,
): Promise<void> {
  const latest = (await app.conversations.get(conversationId)) as ConversationRecord | null;
  if (!latest) return;
  await app.conversations.put({ ...latest, ...createPatch(latest) });
}

async function patchConversation(conversationId: string, patch: Partial<ConversationRecord>): Promise<void> {
  await updateConversation(conversationId, () => patch);
}

async function maybeGenerateTitle(conversationId: string, messages: ThreadMessageLike[], hint?: string): Promise<void> {
  try {
    const conv = (await app.conversations.get(conversationId)) as ConversationRecord | null;
    if (!conv) return;

    // Don't clobber a user-renamed conversation. Rename sites
    // (src/App.tsx, src/components/conversations/*) set titleStatus='manual'.
    if (conv.titleStatus === 'manual') return;

    const settings = await getTitleGenerationSettings();
    if (!settings.enabled) return;

    const userMessageCount = messages.filter((m) => m.role === 'user').length;
    if (userMessageCount < 1) return;

    // Only generate a title when the conversation has none yet.
    // Never re-generate after the initial title is set.
    const hasNoTitle = !conv.title?.trim() && !conv.fallbackTitle?.trim();
    if (!hasNoTitle) return;

    // Dedup: don't regenerate if we already did for this exact user message count
    const lastCount = lastRetitleCount.get(conversationId);
    if (lastCount === userMessageCount) return;

    // Don't run concurrent title gen for same conversation
    if (titleGenInFlight.has(conversationId)) return;

    lastRetitleCount.set(conversationId, userMessageCount);
    titleGenInFlight.add(conversationId);

    try {
      // Mark as generating — use patchConversation to avoid overwriting message data
      await patchConversation(conversationId, { titleStatus: 'generating' });

      // Brief stagger to avoid simultaneous requests hitting rate limits
      await new Promise((resolve) => setTimeout(resolve, 100));

      const result = await app.agent.generateTitle(messages, conv.selectedModelKey ?? undefined, hint, conversationId);
      if (result.title) {
        await patchConversation(conversationId, {
          title: result.title,
          fallbackTitle: result.title,
          titleStatus: 'ready',
          titleUpdatedAt: nowIso(),
        });
      } else if (result.suppressed) {
        // A UserPromptSubmit hook blocked title generation for this prompt. Do
        // NOT derive a fallback title from the raw messages — that would leak the
        // blocked/redacted content into the sidebar title. Leave the title empty.
        const latest = (await app.conversations.get(conversationId)) as ConversationRecord | null;
        if (latest && latest.titleStatus === 'generating') {
          await patchConversation(conversationId, { titleStatus: 'idle' });
        }
      } else {
        // Title gen returned nothing — keep the UI moving with a simple fallback.
        const latest = (await app.conversations.get(conversationId)) as ConversationRecord | null;
        if (latest && latest.titleStatus === 'generating') {
          const fallbackTitle = latest.fallbackTitle ?? deriveFallbackTitle(messages);
          await patchConversation(conversationId, { fallbackTitle, titleStatus: 'idle' });
          // If we still have no title at all, clear the dedup counter so the
          // next user message can retry title generation.
          if (!latest.title?.trim() && !fallbackTitle?.trim()) {
            lastRetitleCount.delete(conversationId);
          }
        }
      }
    } finally {
      titleGenInFlight.delete(conversationId);
    }
  } catch {
    const latest = (await app.conversations.get(conversationId)) as ConversationRecord | null;
    if (latest && latest.titleStatus === 'generating') {
      const fallbackTitle = latest.fallbackTitle ?? deriveFallbackTitle(messages);
      await patchConversation(conversationId, { fallbackTitle, titleStatus: 'idle' });
    }
    // Clear the dedup counter on error so subsequent messages can retry
    lastRetitleCount.delete(conversationId);
    titleGenInFlight.delete(conversationId);
  }
}

// --- Helpers to convert flat messages to tree ---

export function ensureTree(conv: ConversationRecord): { tree: StoredMessage[]; headId: string | null } {
  if (conv.messageTree && conv.messageTree.length > 0) {
    // Rehydrate createdAt from ISO string to Date
    const tree = conv.messageTree.map((m) => ({
      ...m,
      createdAt: m.createdAt ? new Date(m.createdAt as unknown as string) : undefined,
    }));
    // Guard against a DANGLING headId: if the persisted head isn't nullish but
    // points to an id not present in the tree (corrupt data), getActiveBranch
    // would return [] — the conversation renders empty and a later persist
    // writes messages:[] / messageCount:0 back, logically losing all history.
    // Fall back to the last node so the tree stays visible and recoverable.
    const headExists = conv.headId != null && tree.some((m) => m.id === conv.headId);
    const headId = headExists ? conv.headId! : (tree[tree.length - 1]?.id ?? null);
    return { tree, headId };
  }
  // Convert flat messages to tree
  let parentId: string | null = null;
  const tree: StoredMessage[] = (conv.messages ?? []).map((m) => {
    const id = (m as StoredMessage).id || msgId();
    const sm: StoredMessage = {
      ...m,
      id,
      parentId,
      role: m.role as 'user' | 'assistant',
      createdAt: m.createdAt ? new Date(m.createdAt as unknown as string) : undefined,
    };
    parentId = id;
    return sm;
  });
  const headId = tree.length > 0 ? tree[tree.length - 1].id : null;
  return { tree, headId };
}

// Fallback banner context
type FallbackBannerState = {
  fromModel: string;
  toModel: string;
  error: string;
  reason?: string;
} | null;

type FallbackBannerActions = {
  banner: FallbackBannerState;
  dismiss: () => void;
};

const FallbackBannerContext = createCtx<FallbackBannerActions>({
  banner: null,
  dismiss: () => {},
});

export function useFallbackBanner(): FallbackBannerActions {
  return useCtx(FallbackBannerContext);
}

const MaxTurnsContinueContext = createCtx<((messageId: string) => void) | null>(null);

export function useMaxTurnsContinue(): ((messageId: string) => void) | null {
  return useCtx(MaxTurnsContinueContext);
}

// =============================================================================

export type ExecutionMode = 'auto' | 'plan-first';

export function RuntimeProvider({
  children,
  conversationId,
  selectedModelKey,
  reasoningEffort,
  executionMode,
  selectedProfileKey,
  fallbackEnabled,
  threadOverrides,
  onModelFallback,
  onConversationSettingsLoaded,
}: {
  children: ReactNode;
  conversationId?: string | null;
  selectedModelKey?: string | null;
  reasoningEffort?: ReasoningEffort;
  executionMode?: ExecutionMode;
  selectedProfileKey?: string | null;
  fallbackEnabled?: boolean;
  threadOverrides?: {
    temperature?: number | null;
    systemPromptOverride?: string | null;
    maxSteps?: number | null;
    maxRetries?: number | null;
    runtimeOverride?: string | null;
  };
  onModelFallback?: (toModelKey: string) => void;
  onConversationSettingsLoaded?: (settings: {
    conversationId: string;
    selectedModelKey: string | null;
    selectedProfileKey: string | null;
    fallbackEnabled: boolean;
    profilePrimaryModelKey: string | null;
    reasoningEffort?: ReasoningEffort | null;
    executionMode?: ExecutionMode | null;
    temperature?: number | null;
    systemPromptOverride?: string | null;
    maxSteps?: number | null;
    maxRetries?: number | null;
    runtimeOverride?: string | null;
  }) => void;
}) {
  const [tree, setTree] = useState<StoredMessage[]>([]);
  const [headId, setHeadId] = useState<string | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [currentWorkingDirectory, setCurrentWorkingDirectoryState] = useState<string | null>(null);
  const [fallbackBanner, setFallbackBanner] = useState<FallbackBannerState>(null);
  const fallbackBannerTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Step tracking state
  const [stepInfo, setStepInfo] = useState<{ currentStep: number; maxSteps: number; hitLimit: boolean } | null>(null);
  const [showIncompleteTaskBanner, setShowIncompleteTaskBanner] = useState(false);
  const dismissedBannersRef = useRef<Set<string>>(new Set());

  const activeIdRef = useRef<string | null>(null);
  const isRunningRef = useRef(false);
  const treeRef = useRef<StoredMessage[]>([]);
  const headIdRef = useRef<string | null>(null);
  const currentWorkingDirectoryRef = useRef<string | null>(null);
  // Monotonic token for loadConversationState so a stale async load can't clobber
  // a newer conversation selection.
  const loadSeqRef = useRef(0);
  const persistTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const onModelFallbackRef = useRef(onModelFallback);
  onModelFallbackRef.current = onModelFallback;
  const onConversationSettingsLoadedRef = useRef(onConversationSettingsLoaded);
  onConversationSettingsLoadedRef.current = onConversationSettingsLoaded;
  const { consumeAttachments, addAttachments, attachments } = useAttachments();
  // Live mirror of the composer's current attachments, for reads inside async rollback
  // closures (state would be stale). Used to avoid clobbering a NEW draft's attachments
  // when restoring a rolled-back turn's consumed attachments.
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;

  // --- Audio adapters (TTS & Voice Recording) ---
  const { config } = useConfig();
  type ExpandedAudioConfig = {
    provider?: AudioProvider;
    azure?: {
      endpoint?: string;
      region?: string;
      subscriptionKey?: string;
      ttsVoice?: string;
      ttsOutputFormat?: string;
      ttsRate?: number;
      sttLanguage?: string;
      sttEndpoint?: string;
    };
    tts?: { enabled?: boolean; voice?: string; rate?: number };
    recording?: { enabled?: boolean; language?: string; continuous?: boolean };
  };
  const audioConfig = (config as Record<string, unknown> | null)?.audio as ExpandedAudioConfig | undefined;
  const audioProvider: AudioProvider = audioConfig?.provider ?? 'native';

  const speechAdapter = useMemo(() => {
    const tts = audioConfig?.tts;
    if (!tts?.enabled) return undefined;

    return createUnifiedSpeechAdapter({
      provider: audioProvider,
      enabled: true,
      voice: tts.voice,
      rate: tts.rate ?? 1,
      azure:
        audioProvider === 'azure'
          ? {
              endpoint: audioConfig?.azure?.endpoint,
              region: audioConfig?.azure?.region ?? 'eastus',
              subscriptionKey: audioConfig?.azure?.subscriptionKey ?? '',
              voice: audioConfig?.azure?.ttsVoice ?? 'en-US-JennyNeural',
              outputFormat: audioConfig?.azure?.ttsOutputFormat ?? 'audio-24khz-48kbitrate-mono-mp3',
              rate: audioConfig?.azure?.ttsRate ?? 1,
            }
          : undefined,
    });
  }, [
    audioProvider,
    audioConfig?.tts?.enabled,
    audioConfig?.tts?.voice,
    audioConfig?.tts?.rate,
    audioConfig?.azure?.endpoint,
    audioConfig?.azure?.region,
    audioConfig?.azure?.subscriptionKey,
    audioConfig?.azure?.ttsVoice,
    audioConfig?.azure?.ttsOutputFormat,
    audioConfig?.azure?.ttsRate,
  ]);

  const recordingAdapter = useMemo(() => {
    const rec = audioConfig?.recording;
    if (!rec?.enabled) return undefined;

    return createUnifiedRecordingAdapter({
      provider: audioProvider,
      enabled: true,
      language: rec.language,
      continuous: rec.continuous ?? true,
      azure:
        audioProvider === 'azure'
          ? {
              endpoint: audioConfig?.azure?.endpoint,
              region: audioConfig?.azure?.region ?? 'eastus',
              subscriptionKey: audioConfig?.azure?.subscriptionKey ?? '',
              language: audioConfig?.azure?.sttLanguage ?? rec.language ?? 'en-US',
              continuous: rec.continuous ?? true,
              inputDeviceId: (audioConfig?.recording as { inputDeviceId?: string } | undefined)?.inputDeviceId,
            }
          : undefined,
    });
  }, [
    audioProvider,
    audioConfig?.recording?.enabled,
    audioConfig?.recording?.language,
    audioConfig?.recording?.continuous,
    audioConfig?.azure?.endpoint,
    audioConfig?.azure?.region,
    audioConfig?.azure?.subscriptionKey,
    audioConfig?.azure?.sttLanguage,
  ]);

  // Sub-agent state — backed by module-level globals so it survives remounts
  const [subAgentVersion, setSubAgentVersion] = useState(globalSubAgentVersion);
  const [activeSubAgentView, setActiveSubAgentView] = useState<string | null>(null);
  // Snapshot of global threads for rendering (updated when version changes)
  const subAgentThreads = useMemo(() => new Map(globalSubAgentThreads), [subAgentVersion]);

  const bumpSubAgentVersion = useCallback(() => {
    globalSubAgentVersion++;
    setSubAgentVersion(globalSubAgentVersion);
  }, []);

  useEffect(() => {
    activeIdRef.current = activeConversationId;
  }, [activeConversationId]);
  useEffect(() => {
    isRunningRef.current = isRunning;
  }, [isRunning]);
  useEffect(() => {
    treeRef.current = tree;
  }, [tree]);
  useEffect(() => {
    headIdRef.current = headId;
  }, [headId]);
  useEffect(() => {
    currentWorkingDirectoryRef.current = currentWorkingDirectory;
  }, [currentWorkingDirectory]);

  // Derive active branch from tree
  const activeBranch = useMemo(() => getActiveBranch(tree, headId), [tree, headId]);
  const activeRunStartedAt = useMemo(() => {
    if (!activeConversationId || !isRunning) return null;
    return getAccumulatorStartedAt(streamAccumulators.get(activeConversationId));
  }, [activeConversationId, isRunning, tree, headId]);

  // Track siblings for branch picking — computed per-message on the active
  // branch so both regenerated assistant replies and edited user prompts
  // surface a ◀ n/m ▶ control at their branch point.
  type BranchPoint = { siblings: StoredMessage[]; currentIdx: number; total: number };
  const branchPoints = useMemo<Map<string, BranchPoint>>(() => {
    const points = new Map<string, BranchPoint>();
    if (isRunning) return points; // don't show branches while generating
    const branch = getActiveBranch(tree, headId);
    for (const msg of branch) {
      const siblings = tree.filter((m) => m.parentId === msg.parentId && m.role === msg.role);
      if (siblings.length <= 1) continue;
      const currentIdx = siblings.findIndex((m) => m.id === msg.id);
      points.set(msg.id, { siblings, currentIdx, total: siblings.length });
    }
    return points;
  }, [tree, headId, isRunning]);

  // Legacy single-branch info for the last assistant message (kept so existing
  // callers of useBranchNav() with no messageId continue to work).
  const branchInfo = useMemo(() => {
    if (isRunning) return null;
    const branch = getActiveBranch(tree, headId);
    const lastAssistant = [...branch].reverse().find((m) => m.role === 'assistant');
    if (!lastAssistant) return null;
    return branchPoints.get(lastAssistant.id) ?? null;
  }, [branchPoints, tree, headId, isRunning]);

  const loadConversationState = useCallback(async (id: string, opts?: { skipInFlightSeed?: boolean }) => {
    // Monotonic guard: if the user switches conversations while an earlier load
    // is still awaiting IPC, the earlier (now-stale) load must not apply its
    // results over the newer selection. Capture a token; only commit state when
    // this call is still the most recent one.
    const seq = ++loadSeqRef.current;
    const isCurrent = () => seq === loadSeqRef.current;

    const conv = (await app.conversations.get(id)) as ConversationRecord | null;
    if (!conv) return false;
    // Superseded by a newer load — return true so callers (e.g. the mount
    // effect) treat it as handled and DON'T fall through to create a new
    // conversation; the newer load owns the resulting state.
    if (!isCurrent()) return true;

    const { tree: t, headId: h } = ensureTree(conv);

    // If a live accumulator already exists for this conversation (e.g. an
    // automation streaming into it in the background), prefer its in-progress
    // messages over the on-disk tree so opening it mid-run shows streamed-so-far
    // content rather than snapping back to the last persisted state.
    const existingAcc = streamAccumulators.get(id);
    const displayTree = existingAcc ? existingAcc.messages : t;
    const displayHead = existingAcc ? existingAcc.headId : h;

    // Only mark orphaned tool-calls as hung if there's no active stream —
    // an active stream or a tool awaiting user approval means the missing
    // result is expected, not an error.
    const hasActiveStream = streamAccumulators.has(id);
    if (!hasActiveStream) {
      for (const msg of t) {
        if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue;
        type PersistedToolPart = {
          type: string;
          result?: unknown;
          isHung?: boolean;
          finishedAt?: string;
          approvalStatus?: string;
        };
        let repaired = false;
        for (const part of msg.content) {
          const tc = part as PersistedToolPart;
          if (tc.type === 'tool-call' && tc.result === undefined && tc.approvalStatus !== 'pending') {
            tc.result = { isHung: true, error: 'Stream ended before tool result was received.' };
            tc.isHung = true;
            tc.finishedAt = tc.finishedAt ?? new Date().toISOString();
            repaired = true;
          }
        }
        if (repaired) {
          const idx = t.indexOf(msg);
          if (idx >= 0) t[idx] = { ...msg, content: [...msg.content] };
        }
      }
    }

    traceRuntime('conversation.loaded', id, {
      persistedTreeLength: t.length,
      displayTreeLength: displayTree.length,
      persistedHeadId: h,
      displayHeadId: displayHead,
      usedAccumulator: Boolean(existingAcc),
      runStatus: conv.runStatus,
    });
    setActiveConversationId(id);
    setTree(displayTree);
    setHeadId(displayHead);
    setStepInfo(null);
    setShowIncompleteTaskBanner(false);
    currentWorkingDirectoryRef.current = conv.currentWorkingDirectory ?? null;
    setCurrentWorkingDirectoryState(conv.currentWorkingDirectory ?? null);

    // Restore an input that a compact-busy rollback couldn't return to the composer at the
    // time (the user had switched away or started a newer draft). DEFER past this tick: the
    // setActiveConversationId above hasn't committed yet, so activeIdRef + the composer still
    // point at the PREVIOUS chat — restoring now would misroute. After the commit, re-verify
    // this conversation is still the active one AND the composer is empty (never clobber a
    // live draft), and only THEN consume the stash so a failed/misrouted restore keeps it.
    // First HYDRATE the in-memory queue from the durable copy on disk (survives a reload/crash
    // that dropped the volatile mirror) — only fills an empty slot, so a live in-session queue
    // is untouched.
    hydrateRejectedDraftsFromDisk(id, conv as { pendingDrafts?: unknown });
    if (rejectedDrafts.has(id)) {
      setTimeout(() => {
        if (activeIdRef.current !== id) return; // user switched again — keep the stash
        if ((rejectedDrafts.get(id)?.length ?? 0) === 0) return;
        const composerText = runtimeRef.current?.thread?.composer?.getState?.().text ?? '';
        if (composerText.trim().length > 0 || attachmentsRef.current.length > 0) return; // don't clobber
        // ATOMIC claim on main so only ONE client restores this draft (the poll restores the rest).
        void claimAndRestoreDraft(id, (rejected) => {
          if (activeIdRef.current !== id) return false; // switched during the async claim — requeue
          const t = runtimeRef.current?.thread?.composer?.getState?.().text ?? '';
          if (t.trim().length > 0 || attachmentsRef.current.length > 0) return false; // busy — requeue
          if (rejected.attachments.length > 0) addAttachments(rejected.attachments);
          restoreComposerDraft(rejected.text);
          return true;
        });
      }, 0);
    }

    // Don't show the running indicator for conversations awaiting user approval —
    // the accumulator is still alive (so hasActiveStream is true) but the model
    // has stopped generating; only user interaction can resume it.
    const accAwait = hasActiveStream && streamAccumulators.get(id)?.awaitingApproval;
    if (hasActiveStream) {
      setIsRunning(!accAwait);
    } else if (conv.runStatus === 'running' && !opts?.skipInFlightSeed) {
      // Persisted as running but we have no local accumulator. Either a run is
      // streaming into it right now (automation OR a CLI/server-persisted submit
      // on the headless backend) and we opened mid-run, or it's a genuinely stale
      // flag. Ask the main process (both owners). If in-flight, seed an accumulator
      // so subsequent events render live. If NOT in-flight, just show not-running
      // locally — do NOT write runStatus:idle here: the main process owns stale
      // reset (resetStaleRunStatus at startup), and a racy renderer write could
      // clobber a run whose first event simply hasn't reached us yet.
      const [autoInFlight, agentInFlight] = await Promise.all([
        app.automations.inFlight(id).catch(() => false),
        app.agent.inFlight(id).catch(() => ({ inFlight: false, serverPersisted: false })),
      ]);
      // A switch may have happened during the in-flight probe — don't seed an
      // accumulator or flip isRunning for a conversation that's no longer active.
      if (!isCurrent()) return true;
      const agentStreamInFlight = agentInFlight.inFlight;
      if (autoInFlight || agentStreamInFlight) {
        // Seed a background accumulator so opening this conversation mid-run shows streamed-so-far
        // content + a running indicator. Ownership:
        //  - automation / SERVER-PERSISTED (CLI) turn → MAIN-owned: mark automationStreams (render
        //    live, never persist here — main writes the authoritative terminal state).
        //  - GUI-started turn → seed a PASSIVE MIRROR accumulator (NO locallyOriginated, NOT in
        //    automationStreams). We cannot tell "reloaded (owner gone)" from "2nd viewer (owner
        //    alive)" from a bare in-flight probe, so we NEVER persist from a mirror — main's GUI
        //    persistence fallback covers a reloaded/crashed owner, and a live owner persists its
        //    own (so a mirror's stale-disk snapshot can't clobber the complete reply). CONTINUATION
        //    (auto-continue / plan-restart) is NOT gated on being the originator here: it's decided
        //    by MAIN at continuation time (agent:authorize-continuation grants exactly one client
        //    per turn), which safely handles both the reloaded-owner and multi-viewer cases without
        //    a renderer-side lease. We stash the run's settings (reconstructed from disk) on the
        //    mirror so that IF this client wins that authorization, its continuation uses the right
        //    model/profile/thread rather than the live active-chat refs.
        const mainOwned = autoInFlight || agentInFlight.serverPersisted;
        if (mainOwned) automationStreams.add(id);
        streamAccumulators.set(id, {
          messages: [...t],
          headId: h,
          ...(mainOwned
            ? {}
            : {
                runConfig: {
                  selectedModelKey: conv.selectedModelKey ?? null,
                  reasoningEffort: conv.reasoningEffort ?? undefined,
                  selectedProfileKey: conv.selectedProfileKey ?? null,
                  fallbackEnabled: conv.fallbackEnabled ?? false,
                  cwd: conv.currentWorkingDirectory ?? null,
                  executionMode: conv.executionMode ?? undefined,
                  threadOverrides: {
                    temperature: conv.temperature ?? null,
                    systemPromptOverride: conv.systemPromptOverride ?? null,
                    maxSteps: conv.maxSteps ?? null,
                    maxRetries: conv.maxRetries ?? null,
                    runtimeOverride: conv.runtimeOverride ?? null,
                  },
                },
              }),
        });
        setIsRunning(true);
      } else {
        setIsRunning(false);
      }
    } else {
      setIsRunning(false);
    }

    // Restore per-conversation settings (model, profile, fallback, thread overrides)
    onConversationSettingsLoadedRef.current?.({
      conversationId: id,
      selectedModelKey: conv.selectedModelKey ?? null,
      selectedProfileKey: conv.selectedProfileKey ?? null,
      fallbackEnabled: conv.fallbackEnabled ?? false,
      profilePrimaryModelKey: conv.profilePrimaryModelKey ?? null,
      reasoningEffort: conv.reasoningEffort ?? null,
      executionMode: conv.executionMode ?? null,
      temperature: conv.temperature ?? null,
      systemPromptOverride: conv.systemPromptOverride ?? null,
      maxSteps: conv.maxSteps ?? null,
      maxRetries: conv.maxRetries ?? null,
      runtimeOverride: conv.runtimeOverride ?? null,
    });

    return true;
  }, []);

  // Stale `running` runStatus is now swept authoritatively by the MAIN process at
  // backend startup (resetStaleRunStatus in electron/main.ts), before any client
  // is served — so a fresh backend can't have a live run yet, and the sweep is
  // race-free. A renderer-side sweep here would additionally have to know about
  // CLI/server-persisted runs (activeStreams/serverPersistTokens/currentPendingSubmit),
  // which it can't see, and could wrongly clear a live headless run the GUI just
  // connected to. So the renderer no longer sweeps. (Removed per codex r2 M2.)

  // Load active conversation on mount
  useEffect(() => {
    (async () => {
      try {
        const id = conversationId ?? (await app.conversations.getActiveId());
        if (id && (await loadConversationState(id))) {
          return;
        }
        const newId = generateId();
        const now = nowIso();
        let defaultCwd: string | null = null;
        try {
          defaultCwd = await app.platform.homedir();
        } catch {
          /* fallback to null */
        }
        await app.conversations.put({
          id: newId,
          title: null,
          fallbackTitle: null,
          messages: [],
          messageTree: [],
          headId: null,
          conversationCompaction: null,
          lastContextUsage: null,
          createdAt: now,
          updatedAt: now,
          lastMessageAt: null,
          titleStatus: 'idle',
          titleUpdatedAt: null,
          messageCount: 0,
          userMessageCount: 0,
          runStatus: 'idle',
          hasUnread: false,
          lastAssistantUpdateAt: null,
          selectedModelKey: null,
          currentWorkingDirectory: defaultCwd,
        } as ConversationRecord);
        await app.conversations.setActiveId(newId);
        setActiveConversationId(newId);
        setTree([]);
        setHeadId(null);
        currentWorkingDirectoryRef.current = defaultCwd;
        setCurrentWorkingDirectoryState(defaultCwd);
      } catch (err) {
        console.error('[Runtime] Failed to load conversation:', err);
      }
    })();
  }, [loadConversationState]);

  useEffect(() => {
    if (!conversationId || conversationId === activeConversationId) return;

    void loadConversationState(conversationId);
  }, [conversationId, activeConversationId, loadConversationState]);

  // Surface a compact-busy rejected draft while the user REMAINS in the chat: the stash is
  // normally restored by loadConversationState on switch-back, but if the user stayed (with a
  // newer draft that blocked immediate restore), that never fires. Poll gently; the moment
  // the active chat's composer is empty AND a stash exists, restore it (into the empty
  // composer only — never clobber a draft they're typing). Cheap: only acts when a stash
  // exists for the active conv.
  useEffect(() => {
    const timer = setInterval(() => {
      const id = activeIdRef.current;
      if (!id || (rejectedDrafts.get(id)?.length ?? 0) === 0) return;
      const composerText = runtimeRef.current?.thread?.composer?.getState?.().text ?? '';
      if (composerText.trim().length > 0 || attachmentsRef.current.length > 0) return;
      // ATOMIC claim on main (one draft per tick, oldest first) so concurrent clients don't both
      // restore the same draft; only the winner populates its composer.
      void claimAndRestoreDraft(id, (rejected) => {
        if (activeIdRef.current !== id) return false; // switched during the async claim — requeue
        const t = runtimeRef.current?.thread?.composer?.getState?.().text ?? '';
        if (t.trim().length > 0 || attachmentsRef.current.length > 0) return false; // busy — requeue
        if (rejected.attachments.length > 0) addAttachments(rejected.attachments);
        restoreComposerDraft(rejected.text);
        return true;
      });
    }, 1500);
    return () => clearInterval(timer);
  }, [addAttachments]);

  // Reload the active conversation when the main process appends to it (e.g. an
  // automation targeting this thread). Our own persists never grow the tree past
  // treeRef.current, so a longer incoming tree reliably signals an external append.
  useEffect(() => {
    return app.conversations.onChanged((change) => {
      // A conversation was DELETED (from any client). Drop any live accumulator we hold for
      // it — otherwise a running GUI chat's accumulator (and its media) leaks for the
      // renderer's lifetime: the backend cancels the stream on delete but emits no terminal
      // event for a GUI run, and nothing else prunes the module-level map. Supersede first
      // so a queued late delta from the cancelled run can't recreate it.
      if (change.kind === 'delete') {
        const deletedId = change.id;
        if (deletedId) {
          if (streamAccumulators.has(deletedId)) {
            supersedeCurrentGeneration(deletedId);
            streamAccumulators.delete(deletedId);
            if (activeIdRef.current === deletedId) setIsRunning(false);
          }
          // Reclaim this conversation's module-level bookkeeping — it's definitively gone,
          // so no live run can reference these entries again. Bounds long-session growth of
          // the per-conversation generation/handoff maps. (Sub-agent tombstones are keyed by
          // sub-agent id, not conversation id, and are handled at sub-agent deletion.)
          supersededGenerations.delete(deletedId);
          lastLiveGeneration.delete(deletedId);
          supersededResponseIds.delete(deletedId);
          pendingCompactionHandoff.delete(deletedId);
          clearLateCompactionHandoffTimer(deletedId);
          rejectedDrafts.delete(deletedId);
          persistVersions.delete(deletedId);
          lastRetitleCount.delete(deletedId);
          clearFinalizedBranch(deletedId);
        }
        return;
      }
      if (change.kind === 'reset') {
        // conversations:clear wiped ALL records (+ aborted their runs server-side, but a GUI
        // stream emits no terminal event on abort). Clear every live accumulator + all
        // per-conversation bookkeeping so no orphan accumulator/tree/running-state lingers and
        // no map grows unbounded. Stop the running indicator too.
        for (const id of [...streamAccumulators.keys()]) {
          supersedeCurrentGeneration(id);
          streamAccumulators.delete(id);
        }
        supersededGenerations.clear();
        lastLiveGeneration.clear();
        supersededResponseIds.clear();
        pendingCompactionHandoff.clear();
        for (const t of lateCompactionHandoffTimers.values()) clearTimeout(t);
        lateCompactionHandoffTimers.clear();
        rejectedDrafts.clear();
        persistVersions.clear();
        lastRetitleCount.clear();
        for (const id of [...lastFinalizedBranch.keys()]) clearFinalizedBranch(id);
        automationStreams.clear();
        setIsRunning(false);
        return;
      }
      const activeId = activeIdRef.current;
      if (!activeId || streamAccumulators.has(activeId)) return;
      // Only an upsert of the ACTIVE conversation can require a reload (an
      // external append, e.g. an automation targeting this thread). Our own
      // persists never grow the tree past treeRef.current, so a longer incoming
      // tree reliably signals an external write.
      if (change.kind !== 'upsert' || change.conversation.id !== activeId) return;
      const conv = change.conversation as { messageTree?: unknown[]; messages?: unknown[]; headId?: string | null };
      const incomingTree = (conv.messageTree ?? conv.messages ?? []) as Array<{ id?: unknown; content?: unknown }>;
      const incomingLen = incomingTree.length;
      const currentTree = treeRef.current as unknown as Array<{ id?: unknown; content?: unknown }>;
      // A longer incoming tree signals an external append (our own persists never grow past
      // treeRef). But a SAME-LENGTH upsert can also be authoritative: a passive-mirror view that
      // reloaded a PARTIAL snapshot, then the owner's terminal persist FINALIZED the assistant
      // in place (same node count, changed content) — a length-only gate would ignore that and
      // leave the view permanently truncated. Also reload when the head moved OR the tail node's
      // id/content differs (cheap: only the tail, only for the active conv with no accumulator).
      let needsReload = incomingLen > currentTree.length;
      if (!needsReload && incomingLen > 0 && incomingLen === currentTree.length) {
        const inHead = conv.headId ?? null;
        const curHead = headIdRef.current ?? null;
        const inTail = incomingTree[incomingLen - 1];
        const curTail = currentTree[currentTree.length - 1];
        const idDiffers = (inTail?.id ?? null) !== (curTail?.id ?? null);
        const contentDiffers = (() => {
          try {
            return JSON.stringify(inTail?.content) !== JSON.stringify(curTail?.content);
          } catch {
            return inTail?.content !== curTail?.content;
          }
        })();
        needsReload = inHead !== curHead || idDiffers || contentDiffers;
      }
      if (needsReload) {
        void loadConversationState(activeId);
      }
    });
  }, [loadConversationState]);

  // (Removed per codex r3 M3.) A prior effect here cleared the active
  // conversation's runStatus:'running' → 'idle' whenever !isRunning + no local
  // accumulator. That raced with live CLI/server-persisted runs (it didn't check
  // agent/automation in-flight) and duplicated logic loadConversationState now
  // owns (it seeds + sets isRunning correctly, and the MAIN process sweeps
  // genuinely-stale flags at startup). The renderer no longer writes runStatus.

  const schedulePersist = useCallback(
    (conversationId: string, t: StoredMessage[], h: string | null, extra: Partial<ConversationRecord> = {}) => {
      const timers = persistTimersRef.current;
      const existing = timers.get(conversationId);
      if (existing) clearTimeout(existing);
      timers.set(
        conversationId,
        setTimeout(() => {
          timers.delete(conversationId);
          // Guard: if the stream has already ended (accumulator deleted), don't
          // overwrite the terminal runStatus that the done/error handler persisted.
          // This prevents a stale debounced persist (runStatus:'running') from
          // racing with the immediate done-persist (runStatus:'idle').
          if (extra.runStatus === 'running' && !streamAccumulators.has(conversationId)) {
            return;
          }
          // Carry the accumulator's seed provenance (read fresh at fire time so the
          // async backfill's seededDiskHeadId is picked up if it resolved) so the
          // persist chokepoint can reconnect a background-seeded detached root.
          const acc = streamAccumulators.get(conversationId);
          const seedContext = acc?.seededBackground
            ? { seededBackground: true, seededDiskHeadId: acc.seededDiskHeadId }
            : undefined;
          persistConversation(conversationId, t, h, extra, seedContext);
        }, 300),
      );
    },
    [],
  );

  const setCurrentWorkingDirectory = useCallback(async (cwd: string | null) => {
    const trimmed = cwd?.trim() ? cwd.trim() : null;
    currentWorkingDirectoryRef.current = trimmed;
    setCurrentWorkingDirectoryState(trimmed);

    const convId = activeIdRef.current;
    if (!convId) return;

    // Persist ONLY the cwd field against the latest on-disk record — never rewrite
    // messageTree here. A whole-tree persist could write a still-detached background
    // -seeded render tree during the post-`done` reload window (accumulator already
    // deleted → no seed provenance to repair it), re-orphaning history. A field-only
    // patch keeps the authoritative disk tree intact.
    await patchConversation(convId, { currentWorkingDirectory: trimmed });
  }, []);

  // Holds the current stream-event handler so a synthetic event (e.g. a `{busy:true}`
  // /compact rejection returned by agent.stream, which arrives as a promise value rather
  // than a stream event — notably on the web bridge, which has no per-client sender to
  // push error/done) can be fed through the SAME processing path as a real event.
  const streamEventHandlerRef = useRef<((event: unknown) => void) | null>(null);
  // Holds the assistant-ui runtime (created below) so an onNew rejection rollback can
  // restore the composer draft text the composer already cleared on submit.
  const runtimeRef = useRef<{
    thread?: { composer?: { setText?: (t: string) => void; getState?: () => { text?: string } } };
  } | null>(null);
  // Restore a rolled-back draft into the composer ONLY if the user hasn't already typed a
  // NEW one during the awaited persist — clobbering newer text would lose their input.
  const restoreComposerDraft = (text: string): void => {
    if (!text) return;
    try {
      const composer = runtimeRef.current?.thread?.composer;
      const current = composer?.getState?.().text ?? '';
      if (current.trim().length === 0) composer?.setText?.(text);
    } catch {
      /* composer unavailable — best-effort */
    }
  };

  // Launch an agent stream and, if the call resolves `{busy:true}` (the conversation is
  // being /compact-ed), synthesize the busy error+done locally so the turn settles
  // instead of leaving the accumulator + runStatus stuck running forever. On the Electron
  // path main already sends these via event.sender, so the synthetic pair is idempotent
  // (the accumulator's terminal handling dedups); on the web bridge this is the ONLY
  // signal the client gets. Takes the exact agent.stream arg list (conversationId first).
  const launchAgentStream = useCallback((...args: Parameters<NonNullable<typeof window.app>['agent']['stream']>) => {
    const conversationId = args[0];
    // responseMessageId is the LAST positional arg of agent.stream (see AppAPI). Stamp it
    // on the synthesized busy error so the run-generation guard can drop it if this run was
    // superseded before the busy result resolved.
    const responseMessageId = args[args.length - 1];
    Promise.resolve(app.agent.stream(...args))
      .then((res) => {
        // A STALE-CONTINUATION rejection (main refused this continuation because a NEWER turn was
        // issued for the conversation): the newer turn is the authoritative driver. Silently DROP
        // our superseded continuation accumulator (no compacting-error surface, no persist) so the
        // newer turn's events render cleanly. Only if we still own the launched accumulator.
        if (res && typeof res === 'object' && (res as { staleContinuation?: unknown }).staleContinuation === true) {
          if (
            typeof responseMessageId === 'string' &&
            streamAccumulators.get(conversationId)?.pendingAssistantId === responseMessageId
          ) {
            streamAccumulators.delete(conversationId);
          }
          return;
        }
        if (
          res &&
          typeof res === 'object' &&
          (res as { busy?: unknown }).busy === true &&
          (res as { delivered?: unknown }).delivered !== true
        ) {
          const h = streamEventHandlerRef.current;
          // A `{busy}` result means the stream was REJECTED before it started — so NO events (and
          // no fallback/overflow retry) happened: the accumulator's pendingAssistantId is still
          // the ORIGINALLY-launched responseMessageId. Synthesize the terminal error ONLY if we
          // STILL OWN that accumulator (a superseding newer run would have a DIFFERENT
          // pendingAssistantId — stamping the current id then would wrongly TERMINATE the newer
          // run). Stamp the original id so the run-generation guard attributes it to THIS run.
          if (
            h &&
            typeof responseMessageId === 'string' &&
            streamAccumulators.get(conversationId)?.pendingAssistantId === responseMessageId
          ) {
            // ONE terminal event only. The error handler is fully terminal; a trailing
            // `done` would recreate the accumulator from the pre-error tree and supersede
            // the error persist (user message left with no visible error).
            h({
              conversationId,
              type: 'error',
              error: 'Compacting the conversation — wait for it to finish, then retry.',
              responseMessageId,
            });
          }
        }
      })
      .catch(() => {
        // The agent:stream INVOKE itself rejected — e.g. a web-socket disconnect before the
        // request reached main, so NO stream events (not even a terminal one) will arrive.
        // Without a synthesized terminal the accumulator + persisted runStatus:'running' are
        // stuck forever. Synthesize an error ONLY if we still own the accumulator for this
        // run (a real run whose events already settled/superseded it has a different
        // pendingAssistantId, so we won't double-terminate it).
        if (
          typeof responseMessageId === 'string' &&
          streamAccumulators.get(conversationId)?.pendingAssistantId === responseMessageId
        ) {
          const h = streamEventHandlerRef.current;
          if (h) {
            h({
              conversationId,
              type: 'error',
              error: 'The connection dropped before the request could start. Please retry.',
              responseMessageId,
            });
          }
        }
      });
  }, []);

  // Stable ref for values the stream handler needs without re-subscribing
  const streamHandlerRef = useRef({
    tree,
    headId,
    schedulePersist,
    selectedModelKey,
    reasoningEffort,
    selectedProfileKey,
    fallbackEnabled,
    threadOverrides,
    executionMode,
  });
  useEffect(() => {
    streamHandlerRef.current = {
      tree,
      headId,
      schedulePersist,
      selectedModelKey,
      reasoningEffort,
      selectedProfileKey,
      fallbackEnabled,
      threadOverrides,
      executionMode,
    };
  }, [
    tree,
    headId,
    schedulePersist,
    selectedModelKey,
    reasoningEffort,
    selectedProfileKey,
    fallbackEnabled,
    threadOverrides,
    executionMode,
  ]);

  // Stream event listener — subscribes ONCE, reads mutable values via refs/globals
  useEffect(() => {
    const handleStreamEvent = (event: unknown) => {
      const e = event as {
        conversationId: string;
        type: string;
        responseMessageId?: string;
        text?: string;
        messageMeta?: Record<string, unknown>;
        toolCallId?: string;
        toolName?: string;
        args?: unknown;
        result?: unknown;
        error?: string;
        errorCategory?: string;
        errorStatusCode?: number;
        startedAt?: string;
        finishedAt?: string;
        durationMs?: number;
        compaction?: {
          originalContent: string;
          wasCompacted: boolean;
          extractionDurationMs: number;
        };
        data?: unknown;
        // Sub-agent fields
        subAgentConversationId?: string;
        parentConversationId?: string;
        parentToolCallId?: string;
        status?: string;
        summary?: string;
        pausedReason?: 'awaiting-input' | 'turn-limit' | 'capacity';
        // Step tracking fields
        stepInfo?: {
          currentStep: number;
          maxSteps: number;
          hitLimit: boolean;
          taskComplete: boolean;
        };
        // Set when the event originates from an automation run (see StreamEvent).
        automation?: boolean;
        // Set when a agent:submit (CLI) turn is persisted by the MAIN process;
        // a GUI on the same conversation renders live but must not persist.
        serverPersisted?: boolean;
      };

      // Debug: log every event received in renderer
      const debugSummary =
        e.type === 'text-delta'
          ? `text-delta len=${(e.text ?? '').length}`
          : e.type === 'tool-call'
            ? `tool-call id=${e.toolCallId} name=${e.toolName}`
            : e.type === 'tool-result'
              ? `tool-result id=${e.toolCallId}`
              : e.type === 'done'
                ? `done data=${JSON.stringify(e.data ?? null)}`
                : e.type === 'error'
                  ? `error msg=${(e.error ?? '').slice(0, 100)}`
                  : e.type;
      const isActive = e.conversationId === activeIdRef.current;
      const hasAccumulator = e.conversationId ? streamAccumulators.has(e.conversationId) : false;
      console.warn(
        `[StreamEvent] conv=${e.conversationId?.slice(0, 8) ?? `sub:${e.subAgentConversationId?.slice(0, 8) ?? 'n/a'}`} ${debugSummary} isActive=${isActive} hasAccumulator=${hasAccumulator}`,
      );

      // Route sub-agent events to global sub-agent state
      if (e.subAgentConversationId) {
        const saId = e.subAgentConversationId;

        // Drop events for a thread the user explicitly DELETED — otherwise a late
        // async `stopped`/`done` (e.g. from the stop the delete triggered) would
        // recreate the just-removed thread, forcing a confusing double-delete.
        if (deletedSubAgentIds.has(saId)) return;

        if (e.type === 'sub-agent-status') {
          const existing = globalSubAgentThreads.get(saId);
          const rawSummary = e.summary ?? '';
          const cleanTask = rawSummary.startsWith('Starting task: ')
            ? rawSummary.slice('Starting task: '.length)
            : rawSummary;
          if (existing) {
            const nextStatus = (e.status as SubAgentThreadState['status']) ?? existing.status;
            // A terminal thread transitioning back to `running` IS a resume — mark
            // it so the card stops trusting the parent tool-call's frozen isError.
            const terminal = ['completed', 'failed', 'stopped', 'paused', 'error'];
            const isResumeTransition = nextStatus === 'running' && terminal.includes(existing.status);
            globalSubAgentThreads.set(saId, {
              ...existing,
              status: nextStatus,
              task: existing.task || cleanTask,
              hasResumed: existing.hasResumed || isResumeTransition,
              // Track the pause cause on a `paused` status; clear it otherwise so a
              // later running/completed doesn't keep a stale reason.
              pausedReason: nextStatus === 'paused' ? (e.pausedReason ?? existing.pausedReason) : undefined,
            });
          } else {
            globalSubAgentThreads.set(saId, {
              conversationId: saId,
              parentConversationId: e.parentConversationId ?? '',
              parentToolCallId: e.parentToolCallId ?? '',
              task: cleanTask,
              status: (e.status as SubAgentThreadState['status']) ?? 'running',
              messages: [],
              headId: null,
              depth: 0,
              pausedReason: e.status === 'paused' ? e.pausedReason : undefined,
            });
          }
          bumpSubAgentVersion();
          // Release the live message accumulator on a TERMINAL status. The initial-run path
          // suppresses the underlying stream's `done` (to avoid a double-terminal), so the
          // `done`-only release below never fires for a normally-completed initial sub-agent,
          // leaking its message array. A terminal STATUS is the reliable end signal here.
          // Also release on `paused`: it's not terminal (resumable), but the accumulator is a
          // REDUNDANT copy of the thread's messages (it re-initializes from existingThread.messages
          // when the sub-agent next streams — see below), and pause stops streaming, so keeping it
          // just leaks a full message array for a never-resumed paused sub-agent. The thread
          // itself retains the messages either way.
          const terminalRelease = ['completed', 'failed', 'stopped', 'error', 'paused'];
          if (typeof e.status === 'string' && terminalRelease.includes(e.status)) {
            globalSubAgentAccumulators.delete(saId);
          }
          return;
        }

        // Accumulate sub-agent messages
        if (!globalSubAgentAccumulators.has(saId)) {
          // Initialize from existing thread messages (survives remount)
          const existingThread = globalSubAgentThreads.get(saId);
          globalSubAgentAccumulators.set(saId, {
            messages: existingThread?.messages ? [...existingThread.messages] : [],
            headId: existingThread?.headId ?? null,
          });
        }
        const saAcc = globalSubAgentAccumulators.get(saId)!;
        if (e.responseMessageId) saAcc.pendingAssistantId = e.responseMessageId;

        if (e.type === 'sub-agent-user-message') {
          // Dedup: skip if the last message in the accumulator is already
          // a user message with identical text (from local add in sendSubAgentMessage)
          const msgText = e.text ?? '';
          const lastMsg = saAcc.messages[saAcc.messages.length - 1];
          const lastIsUser = lastMsg?.role === 'user';
          const lastContent = lastIsUser && Array.isArray(lastMsg.content) ? lastMsg.content : [];
          const lastText = lastContent.find((p: unknown) => (p as { type: string }).type === 'text') as
            | { text?: string }
            | undefined;
          const isDuplicate = lastIsUser && lastText?.text === msgText;

          if (!isDuplicate) {
            const userMsg: StoredMessage = {
              id: msgId(),
              parentId: saAcc.headId,
              role: 'user',
              content: toStoredContent([{ type: 'text', text: msgText }]),
              createdAt: new Date(),
            };
            saAcc.messages.push(userMsg);
            saAcc.headId = userMsg.id;
          }
        } else if (e.type === 'model-fallback') {
          // Mirror the main-conversation handling for the sub-agent UI tree so a
          // mid-stream fallback doesn't append the retry onto the failed partial.
          const fb = e.data as
            | { discardPartialAssistant?: boolean; preserveErroredVariant?: boolean; error?: string }
            | undefined;
          if (fb?.discardPartialAssistant) {
            discardTrailingAssistant(saAcc);
          } else if (fb?.preserveErroredVariant) {
            preserveErroredAssistantVariant(saAcc, fb.error ?? 'model error — retrying');
          }
        } else if (e.type === 'text-delta') {
          applyTextDelta(saAcc, e.text ?? '', e.messageMeta);
        } else if (e.type === 'tool-call' && e.toolCallId) {
          applyToolCall(saAcc, {
            toolCallId: e.toolCallId,
            toolName: e.toolName ?? 'unknown',
            args: e.args,
            startedAt: e.startedAt,
          });
        } else if (e.type === 'tool-result') {
          applyToolResult(saAcc, {
            toolCallId: e.toolCallId,
            toolName: e.toolName,
            result: e.result,
            startedAt: e.startedAt,
            finishedAt: e.finishedAt,
            durationMs: e.durationMs,
          });
        } else if (e.type === 'tool-progress') {
          applyToolProgress(saAcc, {
            toolCallId: e.toolCallId,
            toolName: e.toolName,
            data: e.data as
              | { stream?: 'stdout' | 'stderr'; output?: string; truncated?: boolean; stopped?: boolean }
              | undefined,
          });
        } else if (e.type === 'error') {
          applyError(saAcc, formatStreamError(e.error ?? 'Unknown error', e.errorCategory, e.errorStatusCode));
        }

        const finalMessages = [...saAcc.messages];
        const finalHeadId = saAcc.headId;
        const isDone = e.type === 'done';

        if (isDone) {
          globalSubAgentAccumulators.delete(saId);
        }

        // Update global thread state
        const existing = globalSubAgentThreads.get(saId);
        const msgs = finalMessages.length > 0 ? finalMessages : (existing?.messages ?? []);
        const head = finalMessages.length > 0 ? finalHeadId : (existing?.headId ?? null);
        // On `done`, do NOT clobber an already-terminal status the runner set via
        // a preceding sub-agent-status event (paused/failed/stopped) — `done` is
        // just the stream terminator, not a completion signal. Only default to
        // `completed` when the current status is non-terminal (e.g. still running).
        const terminalStatuses = ['completed', 'failed', 'stopped', 'paused', 'error'];
        const doneStatus = existing && terminalStatuses.includes(existing.status) ? existing.status : 'completed';
        globalSubAgentThreads.set(saId, {
          conversationId: saId,
          parentConversationId: e.parentConversationId ?? existing?.parentConversationId ?? '',
          parentToolCallId: e.parentToolCallId ?? existing?.parentToolCallId ?? '',
          task: existing?.task ?? '',
          status: isDone ? doneStatus : (existing?.status ?? 'running'),
          messages: msgs,
          headId: head,
          depth: existing?.depth ?? 0,
          hasResumed: existing?.hasResumed,
          pausedReason: existing?.pausedReason,
        });
        bumpSubAgentVersion();
        return;
      }

      const convId = e.conversationId;
      const isActiveConv = convId === activeIdRef.current;

      // Both automation runs and CLI (agent:submit) turns are persisted by the
      // MAIN process; track them in one set so the renderer renders live but
      // never double-persists. `automationStreams` = "main-owned stream here".
      // GATE the add on run-generation so a SUPERSEDED run's late main-owned event can't
      // re-add the marker after a renderer (GUI) turn took over + cleared it (else the GUI
      // replacement is treated as server-persisted → its output is never persisted and
      // vanishes on completion). Skip when: (a) this event's generation was superseded, or
      // (b) an accumulator exists locked to a DIFFERENT generation, or (c) a LOCALLY-ORIGINATED
      // (GUI) accumulator currently owns the conversation — that turn is renderer-persisted, so
      // ANY main-owned event reaching here is a stale/foreign run's (the GUI accumulator may not
      // have LOCKED its generation yet, so the staleVsLock check alone misses this window).
      if (e.automation || e.serverPersisted) {
        const addGen = (e as { runGeneration?: string }).runGeneration;
        const ownerAcc = streamAccumulators.get(convId);
        const lockedGen = ownerAcc?.runGeneration;
        const superseded = !!addGen && supersededGenerations.get(convId)?.has(addGen);
        const staleVsLock = !!addGen && lockedGen != null && lockedGen !== addGen;
        const localOwnerActive = ownerAcc?.locallyOriginated === true;
        if (!superseded && !staleVsLock && !localOwnerActive) automationStreams.add(convId);
      }

      // A queued event from a SUPERSEDED run (e.g. a post-Stop delta whose Stop already
      // deleted the accumulator) must NOT CREATE a fresh accumulator here — that orphan
      // would make the conversation look perpetually running AND suppress external updates
      // (the onChanged reload skips a conv with a live accumulator). The generation guard
      // below only runs once an accumulator EXISTS, so check supersession BEFORE creating.
      if (!streamAccumulators.has(convId) && e.type !== 'compaction') {
        const evGenPre = (e as { runGeneration?: string }).runGeneration;
        const evRidPre = (e as { responseMessageId?: string }).responseMessageId;
        if (
          (evGenPre && supersededGenerations.get(convId)?.has(evGenPre)) ||
          (evRidPre && supersededResponseIds.get(convId)?.has(evRidPre))
        ) {
          return; // stale superseded event with no accumulator — drop, don't create an orphan
        }
      }

      // A late `compaction` event whose turn's accumulator is already GONE (Stop deleted it,
      // or the turn ended) must NOT create/rebuild one — that would resurrect a stopped turn
      // from stale tree/head + schedule a `running` persist (losing the cancellation head and
      // suppressing external reloads). But the paid summary is still worth keeping: stash it
      // in the survives-deletion handoff map so a FUTURE turn can reuse it. Then stop.
      if (!streamAccumulators.has(convId) && e.type === 'compaction') {
        // A MAIN-OWNED compaction (automation / CLI / background turn) is already persisted to
        // disk by main, so the renderer must NOT stash it in the handoff map: that stash is
        // only ever cleared by a renderer-driven persistConversation returning persisted:true
        // (or a future turn / delete), so for main-owned turns it would leak for the renderer's
        // lifetime across every inactive conversation. A future renderer turn reads the
        // compaction from disk anyway (main already wrote it), so the stash serves no purpose.
        if (e.automation || e.serverPersisted) return;
        const cd = e.data as
          | {
              compactionId?: string;
              summaryText?: string;
              compactedMessageIds?: string[];
              coveredContentSig?: Record<string, string>;
              compactionRevision?: number;
            }
          | undefined;
        if (
          cd &&
          typeof cd.compactionId === 'string' &&
          typeof cd.summaryText === 'string' &&
          Array.isArray(cd.compactedMessageIds) &&
          cd.compactedMessageIds.every((id) => typeof id === 'string' && id.length > 0)
        ) {
          stashLateCompactionHandoff(convId, {
            compactionId: cd.compactionId,
            summaryText: cd.summaryText,
            compactedMessageIds: cd.compactedMessageIds,
            boundaryHeadId: null,
            createdAt: nowIso(),
            ...(cd.coveredContentSig ? { coveredContentSig: cd.coveredContentSig } : {}),
            ...(typeof cd.compactionRevision === 'number' ? { compactionRevision: cd.compactionRevision } : {}),
          });
        }
        return;
      }

      if (!streamAccumulators.has(convId)) {
        if (isActiveConv) {
          const { tree: curTree, headId: curHead } = streamHandlerRef.current;
          console.warn(
            `[StreamEvent] Creating accumulator for active conv=${convId.slice(0, 8)} treeLen=${curTree.length} headId=${curHead?.slice(0, 8) ?? 'null'}`,
          );
          streamAccumulators.set(convId, { messages: [...curTree], headId: curHead });
        } else if (e.automation || e.serverPersisted) {
          // Automation OR CLI (serverPersisted) streaming into a NON-active
          // conversation: keep a background accumulator so switching to it
          // mid-run shows streamed-so-far content. Seed SYNCHRONOUSLY (empty
          // base) and fall through to process this same event — dropping early
          // events truncated the first thoughts/text from the live view. Kick
          // off an async disk fetch to backfill the persisted
          // prefix (e.g. the user prompt turn) without discarding any deltas; the
          // trailing automation `done` reloads the authoritative tree from disk.
          const seededAcc: MessageAccumulator = { messages: [], headId: null, seededBackground: true };
          streamAccumulators.set(convId, seededAcc);
          if (!automationSeedInProgress.has(convId)) {
            automationSeedInProgress.add(convId);
            void app.conversations
              .get(convId)
              .then((conv) => {
                const rec = conv as ConversationRecord | null;
                // Only touch the SAME accumulator we seeded. If a conversation-switch
                // (loadConversationState) or a superseding/retry run replaced it, this
                // stale callback must NOT mutate the new run's accumulator with our
                // run's disk snapshot — that would corrupt an unrelated turn. The
                // orphan-root repair does NOT depend on this callback winning: the
                // persist chokepoint reconnects a detached root using the on-disk head
                // regardless (a re-seed via loadConversationState already seeds a
                // non-null head from disk, so it can't produce the orphan shape).
                if (streamAccumulators.get(convId) !== seededAcc) return;
                if (!automationStreams.has(convId)) return;
                if (!rec) return;
                const { tree, headId } = ensureTree(rec);
                if (tree.length === 0 || headId === null) return;
                // Record the authoritative disk head so the debounced persist can
                // reconnect any null-parent root even before this prefix merge lands
                // — this is what closes the 300ms debounce race.
                if (seededAcc.seededDiskHeadId == null) seededAcc.seededDiskHeadId = headId;
                // Merge the persisted prefix (user prompt / prior history) in
                // FRONT of whatever live deltas we've already collected, without
                // dropping them. Skip nodes we already hold, and reparent the
                // first live (root) node onto the persisted head so the branch
                // stays connected.
                const haveIds = new Set(seededAcc.messages.map((m) => m.id));
                const prefix = tree.filter((m) => !haveIds.has(m.id));
                if (prefix.length === 0) return;
                const live = seededAcc.messages.map((m) => (m.parentId === null ? { ...m, parentId: headId } : m));
                seededAcc.messages = [...prefix, ...live];
                if (seededAcc.headId === null) seededAcc.headId = headId;
              })
              .catch(() => {})
              .finally(() => automationSeedInProgress.delete(convId));
          }
        } else {
          // No accumulator for a non-active conversation — the stream already
          // completed and was persisted by the done/error handler.  Drop stale events.
          console.warn(
            `[StreamEvent] DROPPING event for non-active conv=${convId.slice(0, 8)} type=${e.type} activeConv=${activeIdRef.current?.slice(0, 8) ?? 'none'}`,
          );
          return;
        }
      }

      const acc = streamAccumulators.get(convId)!;
      // Drop an event from a run whose responseMessageId was blacklisted at supersession —
      // this catches a superseded run whose first event was still queued (so neither its
      // generation nor a lastLiveGeneration was ever recorded); without this its queued
      // event would lock the replacement accumulator's generation. Exempt `compaction`
      // (its paid summary is captured into the handoff below regardless of run) and only
      // act when it targets a DIFFERENT run than the accumulator now holds (a matching
      // pendingAssistantId means we ARE that run — don't drop our own events).
      {
        const evRid = (e as { responseMessageId?: string }).responseMessageId;
        if (
          evRid &&
          e.type !== 'compaction' &&
          evRid !== acc.pendingAssistantId &&
          supersededResponseIds.get(convId)?.has(evRid)
        ) {
          return;
        }
      }
      // Run-generation guard: main stamps every event of a run with that run's STABLE
      // token (e.runGeneration). An accumulator LOCKS to the first generation it sees; a
      // later event bearing a DIFFERENT generation is from a SUPERSEDED run (the
      // replacement turn got its OWN fresh accumulator via onNew), whose late events must
      // NOT mutate this accumulator (they'd hijack pendingAssistantId / persist stale
      // output under the new prompt). Drop them — EXCEPT a `compaction` event, whose paid
      // summary we still capture into the pendingCompaction handoff regardless of run.
      // NOTE: keyed on runGeneration (stable per run), NOT responseMessageId, which a
      // mid-stream fallback intentionally changes per successful variant within one run.
      const evGen = (e as { runGeneration?: string }).runGeneration;
      if (evGen) {
        // A generation explicitly marked superseded (its accumulator was replaced by a
        // newer turn) is a stale run — drop its events regardless of the accumulator's
        // current lock, and never let one become the fresh accumulator's first lock (the
        // race where an old delta arrives before the replacement run's first event). The
        // compaction handoff is still captured below.
        if (supersededGenerations.get(convId)?.has(evGen) && e.type !== 'compaction') {
          return;
        }
        // Record the generation of the run currently streaming into this conversation
        // (compaction events belong to whatever run is active, so they count too). This is
        // what lets supersedeCurrentGeneration blacklist a still-unlocked accumulator
        // seeded by an untagged external user-message.
        lastLiveGeneration.set(convId, evGen);
        if (acc.runGeneration == null) {
          // Lock to the first REAL-run event — BUT if this accumulator already knows its run
          // (pendingAssistantId set by a local onNew/onEdit/onReload) and this event belongs to
          // a DIFFERENT run (its responseMessageId doesn't match), do NOT let it lock. That
          // guards the window where a superseded CLI/mirror run (whose responseMessageId was
          // never blacklisted — its old accumulator had no pendingAssistantId to record) has a
          // queued event arriving after a GUI turn replaced the accumulator; locking to the CLI
          // generation would then drop the GUI run's own events (GUI response stranded).
          const evRidForLock = (e as { responseMessageId?: string }).responseMessageId;
          const foreignRun =
            acc.pendingAssistantId != null && evRidForLock != null && evRidForLock !== acc.pendingAssistantId;
          if (e.type !== 'compaction' && foreignRun) {
            return; // event from a different (superseded) run — don't lock, don't mutate
          }
          if (e.type !== 'compaction') acc.runGeneration = evGen; // lock to the first REAL-run event
        } else if (acc.runGeneration !== evGen && e.type !== 'compaction') {
          // Event from a DIFFERENT generation than this accumulator is locked to. Normally this is
          // a superseded (older) run's late event → drop it. BUT a `user-message` under a different
          // generation is a NEW turn taking over this conversation (a 2nd GUI window / a CLI submit
          // into the conv we're viewing). Dropping it would strand THIS client: it keeps showing
          // the old (now aborted) run, main suppresses the old run's terminal, and the authoritative
          // upsert is ignored while our accumulator exists — and a Stop here would cancel the NEW
          // run. So RESEED as a passive MIRROR of the new turn: adopt the new generation, drop the
          // originating flag (main persists / the new originator drives), and fall through so the
          // user-message renders. (Only when the new generation isn't itself already superseded.)
          if (e.type === 'user-message' && !supersededGenerations.get(convId)?.has(evGen)) {
            acc.runGeneration = evGen;
            acc.locallyOriginated = false;
            acc.pendingAssistantId = (e as { responseMessageId?: string }).responseMessageId ?? acc.pendingAssistantId;
            // RESET run-specific state carried over from the SUPERSEDED run — this accumulator now
            // mirrors a DIFFERENT run. Leaving the old runConfig / pendingCompaction / seed
            // provenance would, if this mirror later won continuation authorization, restart with
            // the wrong model/CWD or persist an unrelated compaction record. Timing is refreshed on
            // the next event; the branch is reconciled from disk at this run's terminal.
            acc.runConfig = undefined;
            acc.pendingCompaction = undefined;
            acc.seededBackground = undefined;
            acc.seededDiskHeadId = undefined;
            acc.awaitingApproval = undefined;
            // Also drop the superseded run's pending approvals + timing: a same-named tool in the
            // successor must not inherit a dead approval id, and response timing must start fresh
            // for the new run (not from the old run's clock). Timing re-seeds on the next event.
            acc.deferredApprovals = undefined;
            acc.pendingAssistantTiming = undefined;
            // Clear the PRIOR run's cooperative-inject boundary state too: these are
            // run-scoped. Left set, the new generation's first assistant delta would be
            // pinned onto the OLD run's continuation id (getOrCreateAssistantInAcc),
            // updating a stale node off the new user's active branch and hiding the new
            // turn's streamed response. A new inject in this generation re-opens them.
            acc.injectContinuationId = null;
            acc.closedPrefixIds = undefined;
            traceRuntime('stream.supersede-adopt-mirror', convId, { newGeneration: evGen });
            // fall through — render the new turn's user-message + subsequent events as a mirror
          } else {
            return; // superseded run's late event — drop
          }
        }
      } else if (
        // No runGeneration → a pre-stream busy rejection (sent directly / synthesized, not
        // via the run's emit). It carries the rejected turn's responseMessageId; if that
        // turn was superseded (the accumulator now holds a DIFFERENT pendingAssistantId),
        // this stale busy error must not terminate/persist against the replacement turn.
        // (Safe to key on responseMessageId here: a pre-stream rejection never fell back,
        // so its id is stable.)
        e.type === 'error' &&
        e.responseMessageId &&
        acc.pendingAssistantId != null &&
        e.responseMessageId !== acc.pendingAssistantId
      ) {
        return;
      }
      // A `compaction` event is exempt from the stale-run drops above (its paid summary is
      // captured into the handoff regardless of run) — but it must NOT mutate ownership. A
      // stale run A's compaction arriving after run B installed its accumulator would else
      // overwrite acc.pendingAssistantId with A's id, failing B's ownership checks so B's
      // stream never launches (stuck running). Only a real run's events set ownership.
      if (e.responseMessageId && e.type !== 'compaction') acc.pendingAssistantId = e.responseMessageId;

      // A realtime (voice-call) turn is a RENDERER-owned, single-client, active-conversation
      // turn — it has no other persister and no `locallyOriginated`-setting submit path (its
      // accumulator is created generically from the first event). Mark it owned so the terminal
      // done/error handlers + persist gate DON'T misclassify it as a passive mirror and discard
      // its output (mirrors are a MULTI-client GUI concept; realtime is single-client).
      if (e.type === 'realtime-user-transcript' || e.type === 'realtime-interrupt' || e.type === 'realtime-status') {
        acc.locallyOriginated = true;
      }

      if (e.type === 'user-message') {
        // A user turn submitted into THIS conversation by ANOTHER client (the
        // `kai` CLI via agent:submit, or a second GUI window). Insert it into the
        // accumulator so it renders IMMEDIATELY, instead of only appearing when
        // the server-persisted tree reloads at `done` (the reported bug: a
        // CLI-driven prompt didn't show on the co-viewing GUI until the response
        // finished). Our OWN submissions are already in the tree locally, so
        // dedup against the last user turn's text (mirrors the sub-agent path).
        const msgText = e.text ?? '';
        if (msgText) {
          const branch = getActiveBranch(acc.messages, acc.headId);
          // Dedup: prefer the AUTHORITATIVE messageId when main supplied one. Two
          // distinct mid-turn injects with IDENTICAL text carry DIFFERENT persisted
          // ids — text-only dedup would collapse the second, dropping an accepted
          // user turn from the branch (main persists + sends both to the model, so
          // the renderer must keep both). Dedup by id when present: skip only if a
          // node with THIS id already exists. Fall back to text dedup for events
          // WITHOUT an authoritative id (a peer GUI/CLI echo of our own submit).
          const persistedForDedup = e.data as { messageId?: unknown } | undefined;
          const authoritativeId = typeof persistedForDedup?.messageId === 'string' ? persistedForDedup.messageId : null;
          const isDuplicate = authoritativeId
            ? acc.messages.some((m) => m.id === authoritativeId)
            : isDuplicateLastUserMessage(branch, msgText);
          if (!isDuplicate) {
            // `acc.headId` already points at the live assistant message during
            // streaming, so an incoming user turn (a follow-up injected mid-turn
            // for automation back-to-back messages) parents on it and forms a
            // clean boundary: …assistant1(partial) → user2 → assistant2. The next
            // delta creates a fresh assistant message (tail is now `user`), so the
            // new reply can't concatenate onto the superseded one. The main
            // process also suppresses the superseded run's stale deltas at the
            // source (see broadcastStreamEvent), which is the primary guard.
            const persisted = e.data as { messageId?: unknown; parentId?: unknown; createdAt?: unknown } | undefined;
            const messageId = typeof persisted?.messageId === 'string' ? persisted.messageId : msgId();
            const candidateParentId =
              persisted?.parentId === null || typeof persisted?.parentId === 'string' ? persisted.parentId : acc.headId;
            // The main process may just have persisted the partial assistant under
            // its authoritative response id while this live accumulator still has
            // a locally-shaped equivalent. Parenting the injected user on an id
            // absent from acc.messages makes getActiveBranch stop at that dangling
            // edge — all prior messages appear to vanish until the done reload.
            // Use the authoritative parent when it is already present; otherwise
            // retain the current live head for display. The user message itself
            // still uses the authoritative persisted id, and the done reload fixes
            // its exact parent from disk.
            const mainOwnsPersistence = e.automation || e.serverPersisted || automationStreams.has(convId);
            // Renderer-owned streams persist with a 300ms debounce, so main may
            // have appended this injected user to an older disk head that still
            // exists locally. Always retain the CURRENT live head there; trusting
            // the stale persisted parent would orphan the live partial assistant.
            // Main-owned streams can use the authoritative parent, with the
            // dangling-edge fallback handled by the helper.
            const persistedParentId = resolveLiveInjectedParentId(
              acc.messages,
              acc.headId,
              candidateParentId,
              mainOwnsPersistence,
            );
            const persistedCreatedAt =
              typeof persisted?.createdAt === 'string' && Number.isFinite(Date.parse(persisted.createdAt))
                ? new Date(persisted.createdAt)
                : new Date();
            const userMsg: StoredMessage = {
              // Prefer the authoritative persisted id/parent broadcast by main.
              // Fabricating a renderer-only id made this live node disappear when
              // the server-persisted tree reloaded at done, even though the model
              // had consumed the injected text.
              id: messageId,
              parentId: persistedParentId,
              role: 'user',
              content: toStoredContent([{ type: 'text', text: msgText }]),
              createdAt: persistedCreatedAt,
            };
            acc.messages.push(userMsg);
            acc.headId = userMsg.id;
            // NB: the cooperative-inject prefix/continuation boundary is NOT
            // closed here. `user-message` is broadcast IMMEDIATELY at enqueue,
            // BEFORE prepareStep has consumed the inject — if we rotated the
            // continuation now, any text the CURRENT step is still emitting would
            // be mis-attributed as the injected user's continuation even though
            // the model has not yet seen that message. Main's fallback correctly
            // waits for the ORDERED `inject-consumed` marker; the renderer now
            // does the same (see the `inject-consumed` case below), so both agree
            // on the split point.
            traceRuntime('stream.user-message', convId, {
              messageId: userMsg.id,
              parentId: userMsg.parentId,
              eventServerPersisted: Boolean(e.serverPersisted),
              eventAutomation: Boolean(e.automation),
              treeLength: acc.messages.length,
            });
          }
        }
        // Falls through to the shared setTree/setHeadId flush at the end of the
        // handler, so the inserted user turn renders immediately for the active
        // conversation. Not persisted here — the main process owns the
        // server-persisted tree for a CLI/agent:submit turn.
      } else if (e.type === 'inject-consumed') {
        // ORDERED cooperative-inject boundary — emitted AFTER the prior step's
        // chunks and BEFORE the next step's, so it marks the exact point at which
        // the model actually consumed the injected user turn(s). Close the
        // reply-so-far as a prefix and rotate the continuation to a DETERMINISTIC
        // per-boundary node id (`${injectedUser}-cont`) that main's fallback
        // derives identically. Doing this HERE (not on the immediate
        // `user-message` broadcast) keeps prior-step deltas attributed to the
        // prefix, not to the injected user's continuation. Close BOTH the reused
        // responseMessageId (pendingAssistantId) AND any prior boundary's
        // continuation id, so a SECOND inject in the same run rotates to the new id
        // instead of reusing the first continuation node.
        const acc2 = streamAccumulators.get(convId);
        if (acc2) {
          const rawEntries = ((e as { data?: { entries?: Array<{ id?: unknown }> } }).data?.entries ?? []).filter(
            (en): en is { id: string } => typeof en?.id === 'string',
          );
          // Filter to ids that actually MATERIALIZED as a node in this accumulator.
          // With id-based dedup of authoritative injects (above), two identical-text
          // injects now BOTH materialize (distinct persisted ids), so this no longer
          // drops a legitimate second turn. It remains a safety net: an id that never
          // produced a node (e.g. a non-authoritative echo collapsed by text dedup, or
          // a race) must not become the head — advancing headId to an absent id would
          // parent later output on a missing node (branch diverges from disk).
          const presentIds = new Set(acc2.messages.map((m) => m.id));
          const entries = rawEntries.filter((en) => presentIds.has(en.id));
          // ORDERING REPAIR (batch-aware) for the "inject(s) broadcast before the
          // prefix existed" case: if the prior step's first assistant delta arrived
          // AFTER the user-message handler advanced the head to the injected user(s),
          // the prefix got created under the LAST injected user. Move it BEFORE the
          // whole user chain (`pre → prefix → u1 → … `). Done ONCE over the batch —
          // per-entry FIFO would leave `u1 → prefix → u2`.
          const repaired = reorderPrefixBeforeInjectedUserChain(
            acc2.messages,
            acc2.headId,
            entries.map((en) => en.id),
          );
          acc2.messages = repaired.messages;
          acc2.headId = repaired.headId;
          for (const en of entries) {
            acc2.closedPrefixIds ??= new Set();
            if (acc2.pendingAssistantId) acc2.closedPrefixIds.add(acc2.pendingAssistantId);
            if (acc2.injectContinuationId) acc2.closedPrefixIds.add(acc2.injectContinuationId);
            acc2.injectContinuationId = `${en.id}-cont`;
          }
          traceRuntime('stream.inject-consumed', convId, {
            entryCount: entries.length,
            injectContinuationId: acc2.injectContinuationId ?? null,
          });
        }
      } else if (e.type === 'tool-call' || e.type === 'tool-result' || e.type === 'tool-compaction') {
        logRuntimeToolDebug('stream-event', {
          conversationId: convId,
          eventType: e.type,
          toolCallId: e.toolCallId ?? null,
          toolName: e.toolName ?? null,
          compactionPhase:
            e.type === 'tool-compaction' ? ((e.data as { phase?: string } | undefined)?.phase ?? null) : null,
          hasResultCompaction: e.type === 'tool-result' ? Boolean(e.compaction?.wasCompacted) : false,
        });
      }

      if (e.type === 'text-delta') {
        // If a new realtime call started, force a fresh assistant message
        if (forceNewAssistant.has(convId)) {
          forceNewAssistant.delete(convId);
          const branch = getActiveBranch(acc.messages, acc.headId);
          const last = branch[branch.length - 1];
          if (last?.role === 'assistant' && Array.isArray(last.content) && last.content.length > 0) {
            const fresh: StoredMessage = {
              id: msgId(),
              parentId: acc.headId,
              role: 'assistant',
              content: [],
              createdAt: new Date(),
            };
            acc.messages.push(fresh);
            acc.headId = fresh.id;
          }
        }
        applyTextDelta(acc, e.text ?? '', e.messageMeta);
      } else if (e.type === 'realtime-user-transcript') {
        // Realtime audio: create/update a user message for spoken text
        const itemId = (e as { itemId?: string }).itemId ?? msgId();
        const text = e.text ?? '';
        const existingIdx = acc.messages.findIndex((m) => m.id === `rt-user-${itemId}`);
        if (existingIdx >= 0) {
          // Update existing partial user message
          acc.messages[existingIdx] = {
            ...acc.messages[existingIdx],
            content: [{ type: 'text', text }],
          };
        } else if (text.trim()) {
          // Create new user message for this spoken utterance
          const userMsg: StoredMessage = {
            id: `rt-user-${itemId}`,
            parentId: acc.headId,
            role: 'user',
            content: [{ type: 'text', text }],
            createdAt: new Date(),
          };
          acc.messages.push(userMsg);
          acc.headId = userMsg.id;

          // Generate title after the first user message in a voice call
          const branch = getActiveBranch(acc.messages, acc.headId);
          void maybeGenerateTitle(convId, branch, 'This conversation took place via voice call');
        }
      } else if (e.type === 'realtime-interrupt') {
        // User interrupted the AI response. Replace the assistant message content
        // to show spoken text normally, then an interrupt marker, then unspoken text struck-through.
        const payload = e as { spokenText?: string; unspokenText?: string };
        const spokenText = payload.spokenText ?? '';
        const unspokenText = payload.unspokenText ?? '';

        // Find the current assistant message and replace its content
        let assistantIdx = -1;
        for (let i = acc.messages.length - 1; i >= 0; i--) {
          if (acc.messages[i].role === 'assistant') {
            assistantIdx = i;
            break;
          }
        }
        if (assistantIdx >= 0) {
          const newContent: ContentPart[] = [];
          if (spokenText) newContent.push({ type: 'text', source: 'assistant', text: spokenText });
          newContent.push({ type: 'text', source: 'interrupt', text: '[interrupted]' });
          if (unspokenText) newContent.push({ type: 'text', source: 'unspoken', text: unspokenText });
          acc.messages[assistantIdx] = { ...acc.messages[assistantIdx], content: toStoredContent(newContent) };
        }
      } else if (e.type === 'realtime-status') {
        const rtStatus = (e as { status?: string }).status;
        // When a new realtime call connects, finalize the existing accumulator
        // so the new call starts with a clean slate — prevents the new greeting
        // from merging into the previous call's last assistant message.
        if (rtStatus === 'connected' && acc.messages.length > 0) {
          finalizeAssistantResponse(acc);
          const _pt1 = persistTimersRef.current.get(convId);
          if (_pt1) {
            clearTimeout(_pt1);
            persistTimersRef.current.delete(convId);
          }
          streamAccumulators.delete(convId);
          forceNewAssistant.add(convId);
          persistConversation(
            convId,
            acc.messages,
            acc.headId,
            {
              lastAssistantUpdateAt: new Date().toISOString(),
            },
            seedContextFor(acc),
          );
          if (isActiveConv) {
            setTree([...acc.messages]);
            setHeadId(acc.headId);
          }
        }
        return;
      } else if (e.type === 'prompt-redacted') {
        // A UserPromptSubmit DLP hook redacted/blocked the just-sent prompt. The
        // main process scrubbed the store, but the live accumulator still holds
        // the raw user turn — update it in place so the current chat reflects the
        // redaction without a reload. (conversations:changed is ignored while a
        // stream accumulator is active.)
        const data = e.data as { messageId?: string; content?: unknown } | undefined;
        if (data && data.content !== undefined) {
          const targetId = typeof data.messageId === 'string' ? data.messageId : undefined;
          let idx = targetId ? acc.messages.findIndex((m) => m.id === targetId) : -1;
          // Only fall back to "last user message" when NO messageId was given.
          // If a messageId WAS provided but isn't in this accumulator yet (e.g. a
          // CLI-appended node the renderer hasn't loaded), do NOT redact a
          // different turn — skip and let the store's own scrub + reload apply.
          if (idx < 0 && !targetId) {
            for (let i = acc.messages.length - 1; i >= 0; i--) {
              if (acc.messages[i].role === 'user') {
                idx = i;
                break;
              }
            }
          }
          if (idx >= 0) {
            const raw = data.content;
            const parts: ContentPart[] = Array.isArray(raw)
              ? (raw as ContentPart[])
              : [{ type: 'text', text: typeof raw === 'string' ? raw : String(raw) }];
            acc.messages[idx] = { ...acc.messages[idx], content: toStoredContent(parts) };
          }
        }
      } else if (e.type === 'observer-message') {
        applyObserverMessage(acc, e.text ?? '', e.messageMeta);
      } else if (e.type === 'tool-call') {
        if (!e.toolCallId) return;
        const toolName = e.toolName ?? 'unknown';
        applyToolCall(acc, {
          toolCallId: e.toolCallId,
          toolName,
          args: e.args,
          startedAt: e.startedAt,
        });
        // Check for deferred approvals that arrived before this tool-call event
        if (acc.deferredApprovals?.has(toolName)) {
          const deferred = acc.deferredApprovals.get(toolName)!;
          acc.deferredApprovals.delete(toolName);
          const { msg, idx } = getOrCreateAssistantInAcc(acc);
          const content = (Array.isArray(msg.content) ? [...msg.content] : []) as ContentPart[];
          const tcIdx = content.findIndex((p) => p.type === 'tool-call' && p.toolCallId === e.toolCallId);
          if (tcIdx >= 0) {
            const existing = content[tcIdx] as ContentPart & { type: 'tool-call' };
            content[tcIdx] = {
              ...existing,
              approvalStatus: 'pending',
              approvalId: deferred.toolCallId,
              // Apply any rich approval args (e.g. dangerous-automation rule +
              // reason) captured when the approval arrived early.
              ...(deferred.args !== undefined ? { args: deferred.args, argsPending: false } : {}),
              finishedAt: nowIso(),
            };
            acc.messages[idx] = { ...msg, content: toStoredContent(content) };
          }
        }
      } else if (e.type === 'tool-approval-required') {
        // Mark the tool call as needing approval
        acc.awaitingApproval = true;
        if (!e.toolCallId) return;
        const { msg, idx } = getOrCreateAssistantInAcc(acc);
        const content = (Array.isArray(msg.content) ? [...msg.content] : []) as ContentPart[];
        let tcIdx = content.findIndex((p) => p.type === 'tool-call' && p.toolCallId === e.toolCallId);
        // Fallback: the approval event may carry an execute-side ID that differs
        // from the stream-side ID used in tool-call events.  Match by toolName
        // against the most recent unapproved tool-call when exact ID lookup misses.
        if (tcIdx < 0 && e.toolName) {
          for (let i = content.length - 1; i >= 0; i--) {
            const p = content[i];
            if (p.type === 'tool-call' && p.toolName === e.toolName && !p.approvalStatus) {
              tcIdx = i;
              break;
            }
          }
        }
        if (tcIdx >= 0) {
          const existing = content[tcIdx] as ContentPart & { type: 'tool-call' };
          content[tcIdx] = {
            ...existing,
            approvalStatus: 'pending',
            approvalId: e.toolCallId as string,
            // Some approvals carry richer args than the tool was originally
            // called with (e.g. the dangerous-automation gate sends the full
            // rule + reason so the user can see the shell command / hook rule
            // they're approving, even for delete/disable which only passed an
            // id). Surface those in the card instead of the bare original args.
            ...(e.args !== undefined ? { args: e.args, argsPending: false } : {}),
            finishedAt: nowIso(),
          };
          acc.messages[idx] = { ...msg, content: toStoredContent(content) };
        } else if (e.toolName) {
          // tool-call event hasn't arrived yet — defer the approval so it can
          // be applied when the matching tool-call stream event is processed.
          if (!acc.deferredApprovals) acc.deferredApprovals = new Map();
          acc.deferredApprovals.set(e.toolName as string, { toolCallId: e.toolCallId as string, args: e.args });
        }
      } else if (e.type === 'tool-result') {
        acc.awaitingApproval = false;
        applyToolResult(acc, {
          toolCallId: e.toolCallId,
          toolName: e.toolName,
          result: e.result,
          startedAt: e.startedAt,
          finishedAt: e.finishedAt,
          durationMs: e.durationMs,
          compaction: e.compaction,
        });
      } else if (e.type === 'tool-progress') {
        const toolProgressData = e.data as
          | {
              type?: string;
              stream?: 'stdout' | 'stderr';
              output?: string;
              truncated?: boolean;
              stopped?: boolean;
              content?: string;
              duration_ms?: number;
            }
          | undefined;
        if (toolProgressData?.type === 'extraction_start' || toolProgressData?.type === 'extraction_complete') {
          applyToolCompaction(acc, {
            toolCallId: e.toolCallId,
            toolName: e.toolName,
            data: {
              phase: toolProgressData.type === 'extraction_start' ? 'start' : 'complete',
              originalContent: toolProgressData.type === 'extraction_start' ? toolProgressData.content : undefined,
              extractionDurationMs: toolProgressData.duration_ms,
            },
          });
        } else {
          applyToolProgress(acc, {
            toolCallId: e.toolCallId,
            toolName: e.toolName,
            data: toolProgressData,
          });
        }
      } else if (e.type === 'tool-compaction') {
        applyToolCompaction(acc, {
          toolCallId: e.toolCallId,
          toolName: e.toolName,
          data: e.data as
            | {
                phase?: 'start' | 'complete' | 'error' | null;
                originalContent?: string;
                extractionDurationMs?: number;
              }
            | undefined,
        });
      } else if (e.type === 'enrichment') {
        const enrichData = e.data as Record<string, unknown> | undefined;
        if (enrichData) applyEnrichments(acc, enrichData);

        // Persist runtime session IDs so they survive app restarts.
        // Claude Code SDK: claudeSdkSessionId → used by ClaudeAgentRuntime to resume via `resume` option.
        // Codex SDK:       codexSdkThreadId → used by CodexRuntime to call resumeThread().
        const claudeSdkSessionId = enrichData?.claudeSdkSessionId as string | undefined;
        const codexSdkThreadId = enrichData?.codexSdkThreadId as string | undefined;
        if (claudeSdkSessionId || codexSdkThreadId) {
          // Merge into existing metadata rather than replacing it wholesale.
          void (async () => {
            await updateConversation(convId, (latest) => {
              const existingMeta = (latest.metadata ?? {}) as Record<string, unknown>;
              return {
                metadata: {
                  ...existingMeta,
                  ...(claudeSdkSessionId ? { claudeSdkSessionId } : {}),
                  ...(codexSdkThreadId ? { codexSdkThreadId } : {}),
                },
              };
            });
          })();
        }
      } else if (e.type === 'compaction') {
        // A conversation compaction happened this turn (main summarized a prefix
        // to fit the context window). The event precedes the assistant reply, so
        // stash the record and fold it into the terminal persist — a mid-turn
        // write would race the done path.
        const cd = e.data as
          | {
              compactionId?: string;
              summaryText?: string;
              compactedMessageIds?: string[];
              coveredContentSig?: Record<string, string>;
              compactionRevision?: number;
            }
          | undefined;
        if (
          cd &&
          typeof cd.compactionId === 'string' &&
          typeof cd.summaryText === 'string' &&
          Array.isArray(cd.compactedMessageIds) &&
          cd.compactedMessageIds.every((id) => typeof id === 'string' && id.length > 0)
        ) {
          acc.pendingCompaction = {
            compactionId: cd.compactionId,
            summaryText: cd.summaryText,
            // Store verbatim — main already guarantees a complete id mapping (or an
            // empty array for a non-reusable record). Re-filtering here could
            // shorten the array and desync it from the count main used for reuse.
            compactedMessageIds: cd.compactedMessageIds,
            boundaryHeadId: acc.headId,
            createdAt: nowIso(),
            // Forward the baseline signatures so the persisted record can back a later
            // same-turn recovery's expansion check (opaque pass-through).
            ...(cd.coveredContentSig ? { coveredContentSig: cd.coveredContentSig } : {}),
            // Forward the main-issued freshness revision so the put compare is always
            // revision-vs-revision (a stale reconnected client carries the OLD revision).
            ...(typeof cd.compactionRevision === 'number' ? { compactionRevision: cd.compactionRevision } : {}),
          };
        }
      } else if (e.type === 'context-usage') {
        const usageData = normalizeTokenUsage(e.data);
        if (usageData) applyTokenUsage(acc, usageData);
      } else if (e.type === 'model-fallback') {
        const fbData = e.data as
          | {
              fromModel: string;
              toModel: string;
              toModelKey?: string;
              error: string;
              reason?: string;
              discardPartialAssistant?: boolean;
              preserveErroredVariant?: boolean;
            }
          | undefined;
        if (fbData?.discardPartialAssistant) {
          discardTrailingAssistant(acc);
        } else if (fbData?.preserveErroredVariant) {
          // Seal the partial+error as its own variant; the retry becomes a
          // sibling. Flush so the growing "k / N variants" shows live.
          if (preserveErroredAssistantVariant(acc, fbData.error) && isActiveConv) {
            setTree([...acc.messages]);
            setHeadId(acc.headId);
          }
        }
        if (fbData && isActiveConv) {
          setFallbackBanner({
            fromModel: fbData.fromModel,
            toModel: fbData.toModel,
            error: fbData.error,
            reason: fbData.reason,
          });
          if (fallbackBannerTimerRef.current) clearTimeout(fallbackBannerTimerRef.current);
          fallbackBannerTimerRef.current = setTimeout(() => setFallbackBanner(null), 8000);
          // Update model selector to show the fallback model
          if (fbData.toModelKey) {
            onModelFallbackRef.current?.(fbData.toModelKey);
          }
        }
      } else if (e.type === 'retry') {
        // Retry events are informational — show as observer message (attached to the CURRENT
        // assistant via applyObserverMessage, NOT keyed by responseMessageId, so it stays
        // correctly attributed across an overflow-recovery retry that mints a fresh id).
        const retryData = e.data as
          | {
              attempt?: number;
              maxRetries?: number;
              delayMs?: number;
              reason?: string;
              category?: string;
              text?: string;
            }
          | undefined;
        if (retryData) {
          // A raw `text` (e.g. the overflow-recovery "compacted and retrying" note) is rendered
          // verbatim; otherwise format the transient-retry attempt line.
          const retryText =
            typeof retryData.text === 'string' && retryData.text.trim().length > 0
              ? retryData.text
              : `Retrying (${retryData.attempt}/${retryData.maxRetries}) in ${Math.round((retryData.delayMs ?? 0) / 1000)}s — ${retryData.category ?? 'transient error'}`;
          applyObserverMessage(acc, retryText);
          if (isActiveConv) {
            setTree([...acc.messages]);
            setHeadId(acc.headId);
          }
        }
      } else if (e.type === 'step-progress') {
        // Update step progress indicator
        if (e.stepInfo && isActiveConv) {
          setStepInfo({
            currentStep: e.stepInfo.currentStep,
            maxSteps: e.stepInfo.maxSteps,
            hitLimit: e.stepInfo.hitLimit,
          });
        }
        return;
      } else if (e.type === 'max-steps-reached') {
        // Max steps reached — show incomplete task banner
        console.warn(
          `[StreamEvent] MAX_STEPS conv=${convId.slice(0, 8)} steps=${e.stepInfo?.currentStep}/${e.stepInfo?.maxSteps}`,
        );

        if (e.stepInfo && isActiveConv) {
          setStepInfo({
            currentStep: e.stepInfo.currentStep,
            maxSteps: e.stepInfo.maxSteps,
            hitLimit: true,
          });

          // Show banner if not dismissed for this conversation
          if (!dismissedBannersRef.current.has(convId)) {
            setShowIncompleteTaskBanner(true);
          }
        }
        return;
      } else if (e.type === 'error' && e.errorCategory === 'max_turns') {
        // Max turns reached — auto-continue or show interactive continue card
        console.warn(`[StreamEvent] MAX_TURNS conv=${convId.slice(0, 8)} error=${(e.error ?? '').slice(0, 200)}`);
        const agentCfg = (config as Record<string, unknown>)?.agent as Record<string, unknown> | undefined;
        // NEVER drive the auto-continue from the renderer for a MAIN-OWNED run (automation /
        // CLI serverPersisted): the renderer only RENDERS those live — main persists + owns
        // them. A renderer-launched GUI continuation would (a) use the ACTIVE chat's settings
        // (model/CWD) instead of the run's — relative-path tools in the wrong project — and
        // (b) double-drive a main-owned turn. main/CLI re-submits to continue its own run.
        const mainOwned = e.automation || e.serverPersisted || automationStreams.has(convId);
        // A GUI continuation (max-turns auto-continue) may be driven by ANY GUI client — the
        // ORIGINATOR or a client that reloaded mid-turn and came back as a mirror. To ensure
        // EXACTLY ONE drives it (no duplicate model calls / supersession races), MAIN authorizes:
        // we ask agent:authorize-continuation for THIS turn (keyed by the run's stream token) and
        // proceed only if granted; a denied client cleans up like a mirror and re-renders the
        // winner's continuation from broadcasts. So the gate here is only "do we WANT to continue"
        // (config on, not main-owned); the single-driver guarantee is main's, not locallyOriginated.
        const wantsAutoContinue = agentCfg?.autoContinueOnMaxTurns === true && !mainOwned;
        const turnToken = acc.runGeneration;

        if (wantsAutoContinue) {
          // Ask MAIN to authorize this client as the single continuation driver for this turn.
          // Denied → clean up like a mirror (drop the live accumulator, reconcile from disk once
          // the winner's continuation lands) and DON'T mutate turn state. Authorized → run the
          // existing continuation body. All of this is async, so return synchronously now; the
          // IIFE fully handles both outcomes (and the manual-card path below is skipped).
          void (async () => {
            let authorized = false;
            try {
              const r = await app.agent.authorizeContinuation?.(convId, CONTINUATION_CLIENT_ID, turnToken ?? convId);
              // If the IPC is absent (older bridge), fall back to the originator-only rule so a
              // single-client session still auto-continues.
              authorized = r ? r.authorized : acc.locallyOriginated === true;
            } catch {
              authorized = acc.locallyOriginated === true;
            }
            // Re-validate we still own this exact turn's accumulator after the async hop (a Stop /
            // supersede / switch may have swapped it). If not, do nothing — the new owner drives.
            const cur = streamAccumulators.get(convId);
            if (cur !== acc) return;
            if (!authorized) {
              // Not the driver — mirror cleanup: drop the accumulator + reconcile from disk when
              // the winner's continuation lands. Never persist idle here (that would race the
              // winner's continuation write).
              const _ptDenied = persistTimersRef.current.get(convId);
              if (_ptDenied) {
                clearTimeout(_ptDenied);
                persistTimersRef.current.delete(convId);
              }
              // WINNER-FAILURE RECOVERY: if the authorized winner dies AFTER auth but BEFORE it
              // launches, no client re-asks and the main-side grant just expires (~20s) with the
              // continuation never happening. So schedule ONE re-attempt just past that TTL: re-ask
              // authorization for this SAME turn — if the winner launched, its continuation started a
              // NEW turn (this old turnToken is no longer the active stream) so main DENIES and we do
              // nothing; if the winner vanished, the old turn is still active + its grant is stale so
              // main GRANTS us, and we drive the continuation from the CONFIRMED disk branch.
              const denyRc = acc.runConfig;
              const denyLive = streamHandlerRef.current;
              let retryCfg = denyRc ?? {
                selectedModelKey: denyLive.selectedModelKey,
                reasoningEffort: denyLive.reasoningEffort,
                selectedProfileKey: denyLive.selectedProfileKey,
                fallbackEnabled: denyLive.fallbackEnabled,
                executionMode: denyLive.executionMode,
                threadOverrides: denyLive.threadOverrides,
                cwd: currentWorkingDirectoryRef.current,
              };
              const retryHadRunConfig = Boolean(denyRc);
              const retryToken = turnToken;
              streamAccumulators.delete(convId);
              if (isActiveConv) {
                setIsRunning(false);
                void loadConversationState(convId, { skipInFlightSeed: true });
              }
              setTimeout(() => {
                void (async () => {
                  // Only if nothing is driving this conversation now (no live accumulator = no
                  // winner continuation running / took over).
                  if (streamAccumulators.has(convId)) return;
                  let regranted = false;
                  try {
                    const r = await app.agent.authorizeContinuation?.(
                      convId,
                      CONTINUATION_CLIENT_ID,
                      retryToken ?? convId,
                    );
                    regranted = Boolean(r?.authorized);
                  } catch {
                    regranted = false;
                  }
                  if (!regranted || streamAccumulators.has(convId)) return;
                  const confirmed = await app.conversations.get(convId).catch(() => null);
                  const tree =
                    confirmed && Array.isArray((confirmed as { messageTree?: unknown }).messageTree)
                      ? (confirmed as { messageTree: StoredMessage[] }).messageTree
                      : null;
                  const head = confirmed ? ((confirmed as { headId?: string | null }).headId ?? null) : null;
                  if (!tree || tree.length === 0 || !head) return;
                  // If the run had NO captured runConfig (a passive mirror), hydrate the settings
                  // from THIS conversation's confirmed record — NOT the live refs, which may now be
                  // a DIFFERENT active chat (the user switched A→B) and would launch A's continuation
                  // with B's model/profile/CWD.
                  if (!retryHadRunConfig && confirmed) {
                    retryCfg = runConfigFromConversationRecord(confirmed as Record<string, unknown>);
                  }
                  const branchRetry = getActiveBranch(tree, head);
                  const rid = msgId();
                  supersedeCurrentGeneration(convId);
                  streamAccumulators.set(convId, {
                    messages: [...tree],
                    headId: head,
                    pendingAssistantTiming: createPendingAssistantTiming(),
                    pendingAssistantId: rid,
                    runConfig: retryCfg,
                    locallyOriginated: true, // this client is now the driver
                  });
                  // Gate the launch on the persist ACTUALLY landing: a concurrent /compact rejects
                  // the running-status persist as conversation-busy, and a delete rejects as
                  // conversation-deleted. Launching regardless would immediately terminate busy or
                  // run against a deleted chat. On a rejection, drop the accumulator we just set (a
                  // best-effort recovery — the turn resumes via the normal path once /compact
                  // clears, or is correctly abandoned for a deleted chat).
                  const retryPersist = await persistConversation(convId, tree, head, { runStatus: 'running' });
                  if (streamAccumulators.get(convId)?.pendingAssistantId !== rid) return;
                  if (retryPersist?.rejected || !retryPersist?.persisted) {
                    streamAccumulators.delete(convId);
                    return;
                  }
                  launchAgentStream(
                    convId,
                    branchRetry,
                    retryCfg.selectedModelKey ?? undefined,
                    retryCfg.reasoningEffort ?? 'medium',
                    retryCfg.selectedProfileKey ?? undefined,
                    retryCfg.fallbackEnabled ?? false,
                    retryCfg.cwd ?? undefined,
                    retryCfg.executionMode ?? 'auto',
                    {
                      ...(retryCfg.threadOverrides ?? {}),
                      ...(retryToken ? { continuationPredecessorToken: retryToken } : {}),
                    },
                    rid,
                  );
                })();
              }, 21000);
              return;
            }
            // Authorized — finalize current response and immediately restart the stream.
            // A MIRROR that WON (a reloaded sole client) has only a PARTIAL accumulator (built from
            // post-reload broadcasts) that can be missing deltas EVEN AT THE SAME node count — a
            // length check isn't enough. So ask MAIN to FINALIZE its authoritative full-turn
            // fallback and return the confirmed head, then reload THAT complete branch from disk and
            // continue from it (never the partial in-memory accumulator). A local originator's
            // accumulator IS authoritative, so it skips this.
            // Reload the authoritative full branch before continuing when this client's accumulator
            // may be TRUNCATED: a passive mirror (locallyOriginated !== true) OR a WEB client (which
            // receives frame-capped events even for a turn it originated). An Electron originator has
            // the full events, so it skips this.
            if (acc.locallyOriginated !== true || IS_WEB_BRIDGE) {
              let finConfirmed: boolean | undefined;
              try {
                const fin = await app.agent.finalizeGuiFallback?.(convId, turnToken ?? undefined);
                finConfirmed = fin?.confirmed;
                // Reload the confirmed branch (whether main finalized its fallback or the renderer's
                // own earlier persist is authoritative — either way disk now holds the full turn).
                const confirmed = await app.conversations.get(convId);
                const confirmedTree =
                  confirmed && Array.isArray((confirmed as { messageTree?: unknown }).messageTree)
                    ? (confirmed as { messageTree: StoredMessage[] }).messageTree
                    : null;
                const confirmedHead =
                  fin?.headId ?? (confirmed ? ((confirmed as { headId?: string | null }).headId ?? null) : null);
                if (confirmedTree && confirmedTree.length > 0) {
                  acc.messages = confirmedTree;
                  if (confirmedHead) acc.headId = confirmedHead;
                }
                // A PLAIN passive mirror (a 2nd viewer, not a reload) built purely from broadcasts
                // has NO runConfig; without it the continuation below falls back to the ACTIVE
                // chat's live model/profile/CWD — wrong for a background conv the user switched away
                // from (relative-path tools could hit the wrong workspace). Hydrate the run settings
                // from THIS conversation's persisted record before continuing.
                if (!acc.runConfig && confirmed) {
                  acc.runConfig = runConfigFromConversationRecord(confirmed as Record<string, unknown>);
                }
              } catch {
                /* main finalize / disk read failed — treated as unconfirmed below */
                finConfirmed = false;
              }
              // ABORT the continuation if main could NOT confirm the authoritative branch: a
              // token mismatch means a REPLACEMENT turn took over (continuing would abort it), and a
              // failed fallback write means the full reply isn't on disk (continuing would truncate
              // history + replay tool side effects). Only `confirmed === false` aborts — `undefined`
              // (older bridge, no finalize IPC) keeps the pre-existing best-effort behavior. Drop our
              // accumulator + reconcile from disk (the winner's turn / retry will drive it).
              if (finConfirmed === false) {
                const _ptUnc = persistTimersRef.current.get(convId);
                if (_ptUnc) {
                  clearTimeout(_ptUnc);
                  persistTimersRef.current.delete(convId);
                }
                if (streamAccumulators.get(convId) === acc) streamAccumulators.delete(convId);
                if (isActiveConv) {
                  setIsRunning(false);
                  void loadConversationState(convId, { skipInFlightSeed: true });
                }
                return;
              }
              // Re-validate ownership after the awaits.
              if (streamAccumulators.get(convId) !== acc) return;
            }
            finalizeAssistantResponse(acc);
            const _ptAC = persistTimersRef.current.get(convId);
            if (_ptAC) {
              clearTimeout(_ptAC);
              persistTimersRef.current.delete(convId);
            }
            const branch = getActiveBranch(acc.messages, acc.headId);
            const responseMessageId = msgId();
            // If a compaction succeeded earlier in THIS turn, its record is in
            // acc.pendingCompaction. Persist it with the running state AND carry it onto the
            // continuation accumulator — else the auto-continue reloads the raw branch and
            // re-summarizes (rebills) the same prefix.
            const continuationPersist = persistConversation(
              convId,
              acc.messages,
              acc.headId,
              {
                runStatus: 'running',
                ...(acc.pendingCompaction ? { conversationCompaction: acc.pendingCompaction } : {}),
              },
              seedContextFor(acc),
            );
            supersedeCurrentGeneration(convId); // stale run's late events must not bind the replacement accumulator
            streamAccumulators.set(convId, {
              messages: [...acc.messages],
              headId: acc.headId,
              pendingAssistantTiming: createPendingAssistantTiming(),
              pendingAssistantId: responseMessageId,
              pendingCompaction: acc.pendingCompaction,
              // Carry background-seed provenance forward: the continuation's messages
              // still contain the (as-yet-unrepaired) branch, so its own persists must
              // keep reconnecting the active-branch base until the disk prefix lands.
              seededBackground: acc.seededBackground,
              seededDiskHeadId: acc.seededDiskHeadId,
              runConfig: acc.runConfig, // carry the run's settings so further continuations stay correct
              locallyOriginated: acc.locallyOriginated, // a continuation of a local turn stays locally driven
            });
            if (isActiveConv) {
              setTree([...acc.messages]);
              setHeadId(acc.headId);
            }
            // Use the RUN's OWN captured settings (acc.runConfig), NOT the live active-chat
            // refs — a background max_turns continuation whose conversation the user switched
            // away from must restart with A's model/profile/cwd/overrides, not B's (else a
            // relative-path tool could modify the wrong project, or it runs on the wrong model).
            // When runConfig is present use ITS fields VERBATIM (incl. a captured null/undefined —
            // e.g. a null model/profile means "the run used the global default"; a `?? live`
            // fallback would wrongly inherit the CURRENTLY-active chat's model/profile). Fall back
            // to the live refs for the WHOLE object only when runConfig is absent (a pre-capture,
            // e.g. automation-seeded, accumulator).
            const rc = acc.runConfig;
            const live = streamHandlerRef.current;
            const cfg = rc
              ? {
                  selectedModelKey: rc.selectedModelKey,
                  reasoningEffort: rc.reasoningEffort,
                  selectedProfileKey: rc.selectedProfileKey,
                  fallbackEnabled: rc.fallbackEnabled,
                  executionMode: rc.executionMode,
                  threadOverrides: rc.threadOverrides,
                }
              : {
                  selectedModelKey: live.selectedModelKey,
                  reasoningEffort: live.reasoningEffort,
                  selectedProfileKey: live.selectedProfileKey,
                  fallbackEnabled: live.fallbackEnabled,
                  executionMode: live.executionMode,
                  threadOverrides: live.threadOverrides,
                };
            // cwd follows the same rule: captured VERBATIM (incl. explicit null) when rc present.
            const runCwd = rc ? rc.cwd : currentWorkingDirectoryRef.current;
            // Await the compaction-bearing persist BEFORE launching the continuation: the
            // continuation's pre-stream reuse gate (main) reads the stored compaction record
            // from disk, so if we launch first it can read BEFORE the record lands and
            // re-summarize + re-bill the same prefix. (Fire-and-forget only when there's no
            // pending compaction to protect.)
            const launchContinuation = () =>
              launchAgentStream(
                convId,
                branch,
                cfg.selectedModelKey ?? undefined,
                cfg.reasoningEffort ?? 'medium',
                cfg.selectedProfileKey ?? undefined,
                cfg.fallbackEnabled ?? false,
                runCwd ?? undefined,
                cfg.executionMode ?? 'auto',
                // Tag the predecessor turn token so main rejects this continuation if a NEWER turn was
                // issued for the conversation since (another client's fresh user turn) — don't clobber it.
                { ...(cfg.threadOverrides ?? {}), ...(turnToken ? { continuationPredecessorToken: turnToken } : {}) },
                responseMessageId,
              );
            // Await a persist that ACTUALLY WROTE the compaction-bearing record before
            // launching: the continuation's pre-stream reuse gate (main) reads the stored
            // record from disk, so launching before it lands re-summarizes + re-bills. A
            // SUPERSEDED persist (a later persist — e.g. the old stream's trailing `done` —
            // bumped the version) didn't write, so re-persist. A REJECTED persist means a
            // concurrent /compact holds the conversation — launching would be rejected as
            // busy and the mandatory continuation lost, so retry the persist until it lands
            // (bounded to span /compact's ~285s, activeIdRef-guarded). Launch only on a
            // persisted (record-on-disk) result. (No pending compaction ⇒ nothing to protect.)
            const repersistContinuation = () =>
              persistConversation(convId, acc.messages, acc.headId, {
                runStatus: 'running',
                ...(acc.pendingCompaction ? { conversationCompaction: acc.pendingCompaction } : {}),
              });
            // This continuation still OWNS the conversation's turn iff the current
            // accumulator is the one WE created (same pendingAssistantId). A Stop or a
            // replacement/superseding turn swaps the accumulator; a stale retry/launch would
            // then revive cancelled work or clobber the new turn. Check ownership before
            // every retry AND every launch. Keyed on ACCUMULATOR OWNERSHIP, NOT active-ness:
            // the max_turns continuation is MANDATORY and must proceed even if the user has
            // switched to another chat (a background/CLI run must still continue) — else it's
            // deleted + persisted idle, silently ending the task. UI updates (setIsRunning)
            // stay separately active-gated below.
            const stillOwns = () => streamAccumulators.get(convId)?.pendingAssistantId === responseMessageId;
            const ownsAcc = () => streamAccumulators.get(convId)?.pendingAssistantId === responseMessageId;
            // On ownership loss, if WE still own the accumulator (conversation switched away,
            // not a replacement turn), drop it + persist idle so no orphan accumulator / disk
            // runStatus:'running' is left behind. A replacement turn (different pendingAssistantId)
            // owns cleanup itself.
            const cleanupIfLost = (): void => {
              if (ownsAcc()) {
                streamAccumulators.delete(convId);
                void persistConversation(convId, acc.messages, acc.headId, { runStatus: 'idle' });
              }
            };
            // Abandon the mandatory continuation (retry budget exhausted / doomed). MUST persist
            // runStatus:'idle' — deleting only the accumulator leaves the disk record 'running'
            // forever (sidebar shows busy + /compact rejects the conversation until another turn
            // completes or the backend restarts). Only when WE still own the accumulator.
            const abandonContinuation = (): void => {
              if (!ownsAcc()) return;
              streamAccumulators.delete(convId);
              void persistConversation(convId, acc.messages, acc.headId, { runStatus: 'idle' });
              if (activeIdRef.current === convId) setIsRunning(false);
            };
            // Schedule a retry that RE-CHECKS ownership when the timer fires, BEFORE issuing
            // repersistContinuation() — a Stop during the delay must not trigger a persist
            // that re-stamps runStatus:'running'. If ownership was lost, clean up instead.
            const scheduleRetry = (remaining: number): void => {
              setTimeout(() => {
                if (!stillOwns()) {
                  cleanupIfLost();
                  return;
                }
                // RENEW our continuation authorization while we retry: a concurrent /compact can hold
                // the conversation for up to ~285s, but the main-side auth grant goes stale after 20s.
                // Without renewal another client could re-win this same turn mid-retry and both would
                // launch. Re-asserting as the current holder is idempotent (granted) and refreshes the
                // grant's timestamp. Fire-and-forget — the launch below still gates on stillOwns().
                void app.agent
                  .authorizeContinuation?.(convId, CONTINUATION_CLIENT_ID, turnToken ?? convId)
                  .catch(() => {});
                launchAfterCompactionPersist(remaining - 1, repersistContinuation());
              }, 1000);
            };
            const launchAfterCompactionPersist = (
              remaining: number,
              p: Promise<{ rejected?: string; superseded?: boolean; persisted?: boolean }>,
            ): void => {
              void p.then(
                (r) => {
                  if (!stillOwns()) {
                    cleanupIfLost();
                    return;
                  }
                  if (r?.persisted) {
                    launchContinuation();
                  } else if (r?.persisted === undefined && !r?.rejected && !r?.superseded) {
                    // Unknown outcome ({} — an IPC/write failure): the record is NOT on disk, so
                    // launching would reload the raw branch + re-bill. Retry (bounded) or abandon.
                    if (remaining > 0) scheduleRetry(remaining);
                    else {
                      abandonContinuation();
                    }
                  } else if (r?.rejected) {
                    if (remaining > 0) {
                      scheduleRetry(remaining);
                    } else {
                      // Give up cleanly rather than launch into a busy backend: drop the
                      // accumulator + persist idle (the incomplete-task banner stays for a manual
                      // retry). Persisting idle prevents a stuck disk runStatus:'running'.
                      abandonContinuation();
                    }
                  } else if (r?.superseded && remaining > 0) {
                    launchAfterCompactionPersist(remaining - 1, repersistContinuation());
                  } else {
                    // superseded with no budget left — abandon (don't launch without the record).
                    abandonContinuation();
                  }
                },
                () => {
                  // persist threw — treat as unknown: retry if still owning + budget, else abandon.
                  if (!stillOwns()) return;
                  if (remaining > 0) scheduleRetry(remaining);
                  else {
                    abandonContinuation();
                  }
                },
              );
            };
            // Always gate the launch on the START persist's outcome — even with NO compaction
            // record. A concurrent /compact rejects the running-status persist as busy; the
            // continuation is MANDATORY (the run hit max_turns), so launching regardless would
            // hit a busy backend and terminate the work. launchAfterCompactionPersist handles
            // all outcomes (persisted → launch; rejected/unknown/superseded → retry-or-abandon)
            // and is compaction-agnostic.
            launchAfterCompactionPersist(300, continuationPersist);
            return;
          })();
          return;
        }

        // MAIN-OWNED (automation / CLI serverPersisted) max_turns: main persists the
        // authoritative terminal state. The renderer must NOT finalize + persist here (that
        // races main's write → duplicate/sibling terminal nodes or overwrites the branch).
        // Drop the accumulator + reconcile from disk, mirroring the mainOwned `done` handler.
        if (mainOwned) {
          automationStreams.delete(convId);
          const _ptMt = persistTimersRef.current.get(convId);
          if (_ptMt) {
            clearTimeout(_ptMt);
            persistTimersRef.current.delete(convId);
          }
          streamAccumulators.delete(convId);
          if (isActiveConv) {
            setIsRunning(false);
            // POST-TERMINAL reload — the turn ended. Skip loadConversationState's in-flight
            // seeding: the disk may still show 'running' (owner/backend persist not yet landed)
            // and agent.inFlight true for a beat, which would seed a stuck accumulator that
            // SUPPRESSES the authoritative upsert (onChanged skips a conv with a live accumulator).
            void loadConversationState(convId, { skipInFlightSeed: true });
          }
          return;
        }

        // MIRROR of a GUI turn this client did NOT start (locallyOriginated:false): the
        // ORIGINATING client owns the auto-continue / manual-continue decision + persistence.
        // A mirror must NOT finalize+persist idle or show its own continue card (that races the
        // originator's continuation + could persist a terminal state the originator will
        // overwrite). Drop the live accumulator, render the terminal state, reconcile from disk
        // when the originator's next turn lands — same as the mainOwned reconcile above.
        if (!acc.locallyOriginated) {
          const _ptMirror = persistTimersRef.current.get(convId);
          if (_ptMirror) {
            clearTimeout(_ptMirror);
            persistTimersRef.current.delete(convId);
          }
          streamAccumulators.delete(convId);
          if (isActiveConv) {
            setIsRunning(false);
            // POST-TERMINAL reload — the turn ended. Skip loadConversationState's in-flight
            // seeding: the disk may still show 'running' (owner/backend persist not yet landed)
            // and agent.inFlight true for a beat, which would seed a stuck accumulator that
            // SUPPRESSES the authoritative upsert (onChanged skips a conv with a live accumulator).
            void loadConversationState(convId, { skipInFlightSeed: true });
          }
          return;
        }

        // Manual continue: show interactive card
        const { msg: mtMsg, idx: mtIdx } = getOrCreateAssistantInAcc(acc);
        const mtContent = (Array.isArray(mtMsg.content) ? [...mtMsg.content] : []) as ContentPart[];
        mtContent.push({
          type: 'max-turns-reached',
          text: e.error ?? 'Reached maximum number of turns',
          status: 'pending',
        });
        acc.messages[mtIdx] = { ...mtMsg, content: toStoredContent(mtContent) };
        finalizeAssistantResponse(acc);
        const _ptMaxTurns = persistTimersRef.current.get(convId);
        if (_ptMaxTurns) {
          clearTimeout(_ptMaxTurns);
          persistTimersRef.current.delete(convId);
        }
        recordFinalizedBranch(convId, acc.messages, acc.headId); // survives the delete for onNew's fallback base
        streamAccumulators.delete(convId);
        persistConversation(
          convId,
          acc.messages,
          acc.headId,
          {
            runStatus: 'idle',
            lastAssistantUpdateAt: nowIso(),
            hasUnread: !isActiveConv,
            ...(acc.pendingCompaction ? { conversationCompaction: acc.pendingCompaction } : {}),
          },
          seedContextFor(acc),
        );
        if (isActiveConv) {
          setIsRunning(false);
          setTree([...acc.messages]);
          setHeadId(acc.headId);
        }
        return;
      } else if (e.type === 'error') {
        console.warn(
          `[StreamEvent] ERROR conv=${convId.slice(0, 8)} error=${(e.error ?? '').slice(0, 200)} accMsgCount=${acc.messages.length}`,
        );
        // Automation-owned stream: main process persists the terminal state and
        // sends its own trailing `done` → keep the accumulator so that `done` does the
        // uniform cleanup + reload.
        if (e.automation || e.serverPersisted || automationStreams.has(convId)) {
          // Keep the accumulator alive so the trailing automation `done` (which
          // arrives right after) does the final cleanup + reload uniformly.
          if (isActiveConv) {
            applyError(acc, formatStreamError(e.error ?? 'Unknown error', e.errorCategory, e.errorStatusCode));
            setTree([...acc.messages]);
            setHeadId(acc.headId);
          }
          return;
        }
        // PASSIVE MIRROR of another client's GUI turn (locallyOriginated !== true): the
        // originating client persists the terminal state. A mirror must NOT persist. Unlike the
        // automation case above, a GUI-turn error has NO trailing `done` — main SUPPRESSES the
        // stream's own `done` after a GUI error (see agent.ts sawTerminalStreamError), so keeping
        // the accumulator "for the trailing done" would strand it (permanently running + retained
        // tree/media). Treat the error as terminal HERE: render it, drop the accumulator, and
        // reconcile from disk (the originator's authoritative terminal state).
        if (!!streamAccumulators.get(convId) && acc.locallyOriginated !== true) {
          const _ptErrMirror = persistTimersRef.current.get(convId);
          if (_ptErrMirror) {
            clearTimeout(_ptErrMirror);
            persistTimersRef.current.delete(convId);
          }
          streamAccumulators.delete(convId);
          if (isActiveConv) {
            setIsRunning(false);
            // POST-TERMINAL reload — the turn ended. Skip loadConversationState's in-flight
            // seeding: the disk may still show 'running' (owner/backend persist not yet landed)
            // and agent.inFlight true for a beat, which would seed a stuck accumulator that
            // SUPPRESSES the authoritative upsert (onChanged skips a conv with a live accumulator).
            void loadConversationState(convId, { skipInFlightSeed: true });
          }
          return;
        }
        applyError(acc, formatStreamError(e.error ?? 'Unknown error', e.errorCategory, e.errorStatusCode));
        // Apply messageMeta (e.g. runtimeId) from error events so the popover
        // shows the correct runtime even when the response is an error.
        if (e.messageMeta && Object.keys(e.messageMeta).length > 0) {
          const branch = getActiveBranch(acc.messages, acc.headId);
          const last = branch[branch.length - 1];
          if (last?.role === 'assistant') {
            const idx = acc.messages.findIndex((m) => m.id === last.id);
            if (idx >= 0) acc.messages[idx] = applyAssistantMessageMeta(acc.messages[idx], e.messageMeta);
          }
        }
        finalizeAssistantResponse(acc);
        const _ptErr = persistTimersRef.current.get(convId);
        if (_ptErr) {
          clearTimeout(_ptErr);
          persistTimersRef.current.delete(convId);
        }
        recordFinalizedBranch(convId, acc.messages, acc.headId); // survives the delete for onNew's fallback base
        streamAccumulators.delete(convId);
        persistConversation(
          convId,
          acc.messages,
          acc.headId,
          {
            runStatus: 'idle',
            lastAssistantUpdateAt: nowIso(),
            hasUnread: !isActiveConv,
            ...(acc.pendingCompaction ? { conversationCompaction: acc.pendingCompaction } : {}),
          },
          seedContextFor(acc),
        );
        if (isActiveConv) {
          setIsRunning(false);
          setTree([...acc.messages]);
          setHeadId(acc.headId);
        }
        return;
      } else if (e.type === 'done') {
        console.warn(
          `[StreamEvent] DONE conv=${convId.slice(0, 8)} accMsgCount=${acc.messages.length} awaitingApproval=${acc.awaitingApproval ?? false} isActive=${isActiveConv} data=${JSON.stringify(e.data ?? null)}`,
        );
        // Automation-owned stream: the MAIN process persisted the authoritative
        // [user, assistant] exchange and set runStatus. Don't persist from here
        // (would duplicate). Drop the accumulator + reload from disk to reconcile.
        // ALSO covers a PASSIVE MIRROR of another client's GUI turn (accumulator built from
        // broadcasts, locallyOriginated !== true): the ORIGINATING client persists the
        // authoritative turn. A mirror persisting here would redirect the shared assistant onto
        // its own fabricated (attachment-free) user branch and corrupt active history — mirror
        // the round-132 mid-stream gate on the TERMINAL path too.
        const doneMirror = !!streamAccumulators.get(convId) && acc.locallyOriginated !== true;
        // A plan-restart / plan-reject-restart is MANDATORY (the prior stream was aborted for it)
        // and is now MAIN-AUTHORITATIVE — the delayed launch below asks agent:authorize-continuation
        // and only ONE client actually restarts. So a GUI MIRROR (not main-owned) that carries a
        // plan-restart signal must FALL THROUGH to that block rather than be short-circuited here:
        // otherwise a reloaded sole client (a mirror) would drop the mandatory restart and planning
        // would stall until manual intervention. The transient finalize/persist a losing mirror runs
        // is immediately superseded by the winner's restart (the branch is rewritten), so — unlike
        // ordinary mirror history — it can't corrupt surviving active history for THIS case.
        // Main-owned runs (automation / CLI serverPersisted) still take the early-return: they
        // restart server-side, and a renderer must never persist their turn.
        const doneData = e.data as Record<string, unknown> | undefined;
        const mirrorWantsPlanRestart =
          doneMirror &&
          !(e.automation || e.serverPersisted || automationStreams.has(convId)) &&
          Boolean(doneData?.planModeRestart || doneData?.planModeRejectRestart);
        if (
          (e.automation || e.serverPersisted || automationStreams.has(convId) || doneMirror) &&
          !mirrorWantsPlanRestart
        ) {
          automationStreams.delete(convId);
          const _ptAuto = persistTimersRef.current.get(convId);
          if (_ptAuto) {
            clearTimeout(_ptAuto);
            persistTimersRef.current.delete(convId);
          }
          streamAccumulators.delete(convId);
          traceRuntime('stream.authoritative-done', convId, {
            eventAutomation: Boolean(e.automation),
            eventServerPersisted: Boolean(e.serverPersisted),
            accumulatorMessages: acc.messages.length,
            accumulatorHeadId: acc.headId,
          });
          if (isActiveConv) {
            setIsRunning(false);
            // POST-TERMINAL reload — the turn ended. Skip loadConversationState's in-flight
            // seeding: the disk may still show 'running' (owner/backend persist not yet landed)
            // and agent.inFlight true for a beat, which would seed a stuck accumulator that
            // SUPPRESSES the authoritative upsert (onChanged skips a conv with a live accumulator).
            void loadConversationState(convId, { skipInFlightSeed: true });
          }
          return;
        }
        // Plan-mode transitions (accept, reject, dismiss) send a done event while
        // a tool is still awaiting approval.  Clear the flag so the normal done
        // path can clean up or restart the stream correctly.
        if (
          acc.awaitingApproval &&
          doneData &&
          (doneData.planModeRestart || doneData.planModeRejectRestart || doneData.planDismissed)
        ) {
          acc.awaitingApproval = false;
        }
        // If a tool is awaiting user approval, the stream "done" just means the
        // model finished generating — tool execution is still blocked.  Keep the
        // accumulator alive and stay in awaiting-approval state so the UI doesn't
        // reset or restart the stream.
        if (acc.awaitingApproval) {
          finalizeAssistantResponse(acc);
          if (isActiveConv) {
            setTree([...acc.messages]);
            setHeadId(acc.headId);
          }
          // Persist with awaiting-approval so the sidebar stays correct
          const _ptAwait = persistTimersRef.current.get(convId);
          if (_ptAwait) {
            clearTimeout(_ptAwait);
            persistTimersRef.current.delete(convId);
          }
          persistConversation(
            convId,
            acc.messages,
            acc.headId,
            {
              runStatus: 'awaiting-approval',
              hasUnread: true,
              ...(acc.pendingCompaction ? { conversationCompaction: acc.pendingCompaction } : {}),
            },
            seedContextFor(acc),
          );
          return;
        }
        // A MIRROR falling through here ONLY for a mandatory plan-restart must NOT run the normal
        // terminal finalize/persist below: persisting its PARTIAL accumulator as 'idle' would make
        // main treat it as the renderer's authoritative terminal + discard main's FULL fallback
        // (truncating history + aborting the restart) BEFORE the plan-restart block's
        // finalizeGuiFallback runs. So for that case, only clear the debounce timer and skip
        // straight to the plan-restart block (which finalizes main's authoritative copy, reloads the
        // confirmed branch, and restarts). Its own ownership check tolerates the absent accumulator.
        if (mirrorWantsPlanRestart) {
          const _ptMirrorPlan = persistTimersRef.current.get(convId);
          if (_ptMirrorPlan) {
            clearTimeout(_ptMirrorPlan);
            persistTimersRef.current.delete(convId);
          }
          streamAccumulators.delete(convId); // drop the partial mirror; do NOT persist it
        } else {
          finalizeAssistantResponse(acc);
          // Apply messageMeta from the done event (e.g. sourceModel reported by
          // an inference provider) to the last assistant message before persisting.
          if (e.messageMeta && Object.keys(e.messageMeta).length > 0) {
            const branch = getActiveBranch(acc.messages, acc.headId);
            const last = branch[branch.length - 1];
            if (last?.role === 'assistant') {
              const idx = acc.messages.findIndex((m) => m.id === last.id);
              if (idx >= 0) acc.messages[idx] = applyAssistantMessageMeta(acc.messages[idx], e.messageMeta);
            }
          }
          const _ptDone = persistTimersRef.current.get(convId);
          if (_ptDone) {
            clearTimeout(_ptDone);
            persistTimersRef.current.delete(convId);
          }
          recordFinalizedBranch(convId, acc.messages, acc.headId); // survives the delete for onNew's fallback base
          streamAccumulators.delete(convId);
          persistConversation(
            convId,
            acc.messages,
            acc.headId,
            {
              runStatus: 'idle',
              lastAssistantUpdateAt: nowIso(),
              hasUnread: !isActiveConv,
              ...(acc.pendingCompaction ? { conversationCompaction: acc.pendingCompaction } : {}),
            },
            seedContextFor(acc),
          );
          if (isActiveConv) {
            setTree([...acc.messages]);
            setHeadId(acc.headId);
            // Update the model selector to reflect the actual model used (may differ
            // from requested if a fallback occurred during the pipeline run).
            const resolvedModel = (e.data as Record<string, unknown> | undefined)?.model as string | undefined;
            if (resolvedModel) {
              onModelFallbackRef.current?.(resolvedModel);
            }
          }
        }
        {
          // Auto-continue after plan mode entry / rejection. This MUST run regardless of
          // active-ness: the prior stream was ABORTED for a mandatory restart, so a `done`
          // arriving after the user switched chats must still restart the (now background)
          // conversation — previously this sat inside `if (isActiveConv)` and was silently
          // skipped. UI updates inside stay active-gated.
          const planModeRestart = (e.data as Record<string, unknown> | undefined)?.planModeRestart;
          // Auto-continue after plan rejection: the user clicked "No, keep planning"
          // so we restart in plan-first mode with a synthetic user message telling the
          // agent to continue refining the plan.
          const planModeRejectRestart = (e.data as Record<string, unknown> | undefined)?.planModeRejectRestart;
          // A plan-restart may be driven by ANY GUI client (originator or a reloaded mirror); MAIN
          // authorizes the single driver per turn (see the max_turns auto-continue). Enter on
          // "wants restart" (a plan-restart signal on a non-main-owned run); the authorization
          // inside the delayed launch guarantees exactly one client actually restarts.
          const planMainOwned = e.automation || e.serverPersisted || automationStreams.has(convId);
          const planTurnToken = acc.runGeneration;
          if ((planModeRestart || planModeRejectRestart) && !planMainOwned) {
            const label = planModeRestart ? 'plan-restart' : 'plan-reject-restart';
            console.info(`[UI:stream] ${label} — auto-continuing with plan-first mode`);
            // Snapshot THIS run's settings for the delayed launch. Prefer the run's OWN
            // captured runConfig (correct even for a background conv the user has switched
            // away from); fall back to the live refs for a run predating runConfig capture.
            // When runConfig is present use ITS fields VERBATIM (incl. captured null/undefined —
            // a `?? live` fallback would wrongly inherit the active chat's model/profile).
            const planLive = streamHandlerRef.current;
            const planRc = acc.runConfig;
            let planCfgSnapshot = planRc
              ? {
                  selectedModelKey: planRc.selectedModelKey,
                  reasoningEffort: planRc.reasoningEffort,
                  selectedProfileKey: planRc.selectedProfileKey,
                  fallbackEnabled: planRc.fallbackEnabled,
                  threadOverrides: planRc.threadOverrides,
                }
              : {
                  selectedModelKey: planLive.selectedModelKey,
                  reasoningEffort: planLive.reasoningEffort,
                  selectedProfileKey: planLive.selectedProfileKey,
                  fallbackEnabled: planLive.fallbackEnabled,
                  threadOverrides: planLive.threadOverrides,
                };
            // cwd follows the same rule: captured VERBATIM (incl. explicit null) when rc present.
            let planCwdSnapshot = planRc ? planRc.cwd : currentWorkingDirectoryRef.current;
            // The restart launches in plan-first mode, so the continuation's runConfig must
            // record executionMode:'plan-first' — NOT the original acc.runConfig (usually
            // 'auto'). Otherwise a further max_turns continuation of the RESTARTED planning
            // run would resume in 'auto', silently restoring mutating tools the user expects
            // to be gated during planning.
            let planRunConfig = { ...(acc.runConfig ?? {}), executionMode: 'plan-first' as const };
            // Small delay to let the executionMode state update propagate from the
            // onExecutionModeChanged listener in App.tsx.
            setTimeout(async () => {
              // MAIN-authoritative single-driver gate: only one client may restart this turn.
              // Denied → do nothing (the winner restarts; this client re-renders via broadcasts).
              let planAuthorized = false;
              try {
                const r = await app.agent.authorizeContinuation?.(
                  convId,
                  CONTINUATION_CLIENT_ID,
                  planTurnToken ?? convId,
                );
                planAuthorized = r ? r.authorized : acc.locallyOriginated === true;
              } catch {
                planAuthorized = acc.locallyOriginated === true;
              }
              if (!planAuthorized) {
                console.info(`[UI:stream] ${label} — not authorized (another client drives it)`);
                // WINNER-FAILURE RECOVERY (mirrors the max-turns path): if the authorized winner
                // dies after its grant but before launching, re-ask past the ~20s TTL — granted only
                // if this turn is still the active un-continued stream (winner vanished), else the
                // winner launched (new turn) and we no-op.
                setTimeout(() => {
                  void (async () => {
                    if (streamAccumulators.has(convId)) return;
                    let regranted = false;
                    try {
                      const rr = await app.agent.authorizeContinuation?.(
                        convId,
                        CONTINUATION_CLIENT_ID,
                        planTurnToken ?? convId,
                      );
                      regranted = Boolean(rr?.authorized);
                    } catch {
                      regranted = false;
                    }
                    if (!regranted || streamAccumulators.has(convId)) return;
                    try {
                      await app.agent.finalizeGuiFallback?.(convId, planTurnToken ?? undefined);
                    } catch {
                      /* best-effort */
                    }
                    const confirmed = await app.conversations.get(convId).catch(() => null);
                    const tree =
                      confirmed && Array.isArray((confirmed as { messageTree?: unknown }).messageTree)
                        ? (confirmed as { messageTree: StoredMessage[] }).messageTree
                        : null;
                    const head = confirmed ? ((confirmed as { headId?: string | null }).headId ?? null) : null;
                    if (!tree || tree.length === 0 || !head) return;
                    // Hydrate settings from THIS conv's confirmed record if the run had no captured
                    // runConfig (a passive mirror) — the pre-captured snapshots fell back to the live
                    // refs, which may now be a different active chat (A->B switch).
                    if (!acc.runConfig && confirmed) {
                      const hydrated = runConfigFromConversationRecord(confirmed as Record<string, unknown>);
                      planCfgSnapshot = {
                        selectedModelKey: hydrated.selectedModelKey,
                        reasoningEffort: hydrated.reasoningEffort,
                        selectedProfileKey: hydrated.selectedProfileKey,
                        fallbackEnabled: hydrated.fallbackEnabled,
                        threadOverrides: hydrated.threadOverrides,
                      };
                      planCwdSnapshot = hydrated.cwd;
                      planRunConfig = { ...hydrated, executionMode: 'plan-first' as const };
                    }
                    const branchRetry = getActiveBranch(tree, head);
                    const rid = msgId();
                    supersedeCurrentGeneration(convId);
                    streamAccumulators.set(convId, {
                      messages: [...tree],
                      headId: head,
                      pendingAssistantTiming: createPendingAssistantTiming(),
                      pendingAssistantId: rid,
                      runConfig: planRunConfig,
                      locallyOriginated: true,
                    });
                    const rp = await persistConversation(convId, tree, head, { runStatus: 'running' });
                    if (streamAccumulators.get(convId)?.pendingAssistantId !== rid) return;
                    if (rp?.rejected || !rp?.persisted) {
                      streamAccumulators.delete(convId);
                      return;
                    }
                    launchAgentStream(
                      convId,
                      branchRetry,
                      planCfgSnapshot.selectedModelKey ?? undefined,
                      planCfgSnapshot.reasoningEffort ?? 'medium',
                      planCfgSnapshot.selectedProfileKey ?? undefined,
                      planCfgSnapshot.fallbackEnabled ?? false,
                      planCwdSnapshot ?? undefined,
                      'plan-first',
                      {
                        ...(planCfgSnapshot.threadOverrides ?? {}),
                        ...(planTurnToken ? { continuationPredecessorToken: planTurnToken } : {}),
                      },
                      rid,
                    );
                  })();
                }, 21000);
                return;
              }
              // A MIRROR winner has a PARTIAL accumulator — finalize main's authoritative full-turn
              // fallback and reload the confirmed branch before restarting (same as max-turns).
              // Reload the authoritative branch before restarting when the accumulator may be
              // truncated: a passive mirror OR a WEB client (capped events even when it originated).
              if (acc.locallyOriginated !== true || IS_WEB_BRIDGE) {
                let planFinConfirmed: boolean | undefined;
                try {
                  const fin = await app.agent.finalizeGuiFallback?.(convId, planTurnToken ?? undefined);
                  planFinConfirmed = fin?.confirmed;
                  const confirmed = await app.conversations.get(convId);
                  const confirmedTree =
                    confirmed && Array.isArray((confirmed as { messageTree?: unknown }).messageTree)
                      ? (confirmed as { messageTree: StoredMessage[] }).messageTree
                      : null;
                  const confirmedHead =
                    fin?.headId ?? (confirmed ? ((confirmed as { headId?: string | null }).headId ?? null) : null);
                  if (confirmedTree && confirmedTree.length > 0) {
                    acc.messages = confirmedTree;
                    if (confirmedHead) acc.headId = confirmedHead;
                  }
                  // Plain passive mirror: hydrate run settings from disk (see max-turns). The plan
                  // config snapshots below were captured from acc.runConfig BEFORE this setTimeout;
                  // if it was absent, recompute them from the hydrated settings so the restart uses
                  // THIS conv's model/profile/CWD, not the active chat's.
                  if (!acc.runConfig && confirmed) {
                    const hydrated = runConfigFromConversationRecord(confirmed as Record<string, unknown>);
                    acc.runConfig = hydrated;
                    planCfgSnapshot = {
                      selectedModelKey: hydrated.selectedModelKey,
                      reasoningEffort: hydrated.reasoningEffort,
                      selectedProfileKey: hydrated.selectedProfileKey,
                      fallbackEnabled: hydrated.fallbackEnabled,
                      threadOverrides: hydrated.threadOverrides,
                    };
                    planCwdSnapshot = hydrated.cwd;
                    planRunConfig = { ...hydrated, executionMode: 'plan-first' as const };
                  }
                } catch {
                  planFinConfirmed = false;
                }
                // ABORT the restart if main couldn't confirm the authoritative branch (a replacement
                // turn took over, or the fallback write failed) — continuing would abort the newer
                // turn or restart from truncated history. `undefined` (older bridge) keeps the
                // best-effort behavior.
                if (planFinConfirmed === false) {
                  if (isActiveConv) {
                    setIsRunning(false);
                    void loadConversationState(convId, { skipInFlightSeed: true });
                  }
                  return;
                }
              }
              // Ownership check BEFORE replacing the accumulator: the done handler above
              // deleted convId's accumulator, so during this 100ms delay either nothing
              // took over (still absent) or a replacement turn installed a NEW accumulator.
              // If one now exists, another run owns convId — don't clobber it with the stale
              // plan branch. Do NOT bail merely because the user switched chats: the
              // plan-restart is MANDATORY (the prior stream was aborted for it), and it works
              // for a background conv (automation/CLI runs are background). The setIsRunning
              // UI update below stays active-gated so a background restart doesn't show the
              // wrong chat as running.
              if (streamAccumulators.has(convId)) {
                console.info(`[UI:stream] ${label} — abandoned (conversation no longer owned)`);
                return;
              }
              const headForStream = acc.headId;
              if (headForStream) {
                const treeForStream = [...acc.messages];

                const branch = getActiveBranch(treeForStream, headForStream);
                const responseMessageId = msgId();
                supersedeCurrentGeneration(convId); // stale run's late events must not bind the replacement accumulator
                streamAccumulators.set(convId, {
                  messages: [...treeForStream],
                  headId: headForStream,
                  pendingAssistantTiming: createPendingAssistantTiming(),
                  pendingAssistantId: responseMessageId,
                  // Carry a compaction produced earlier this turn onto the continuation
                  // (mirrors the max_turns auto-continue) — else the plan-mode restart
                  // reloads the raw branch and re-summarizes the same prefix.
                  pendingCompaction: acc.pendingCompaction,
                  seededBackground: acc.seededBackground,
                  seededDiskHeadId: acc.seededDiskHeadId,
                  runConfig: planRunConfig, // keep the run's settings for any further continuation
                  locallyOriginated: acc.locallyOriginated, // plan-restart of a local turn stays locally driven
                });
                if (activeIdRef.current === convId) setIsRunning(true);
                const planContinuationPersist = persistConversation(
                  convId,
                  treeForStream,
                  headForStream,
                  {
                    runStatus: 'running',
                    ...(acc.pendingCompaction ? { conversationCompaction: acc.pendingCompaction } : {}),
                  },
                  seedContextFor(acc),
                );
                const cfg = planCfgSnapshot;
                console.info(`[UI:stream:${label}] Firing agent:stream conv=${convId} executionMode=plan-first`);
                const launchPlanContinuation = () =>
                  launchAgentStream(
                    convId,
                    branch,
                    cfg.selectedModelKey ?? undefined,
                    cfg.reasoningEffort ?? 'medium',
                    cfg.selectedProfileKey ?? undefined,
                    cfg.fallbackEnabled ?? false,
                    planCwdSnapshot ?? undefined,
                    'plan-first',
                    {
                      ...(cfg.threadOverrides ?? {}),
                      ...(planTurnToken ? { continuationPredecessorToken: planTurnToken } : {}),
                    },
                    responseMessageId,
                  );
                // The plan restart is MANDATORY (the prior stream was aborted for it). If a
                // concurrent /compact rejects the running-status persist as busy, DON'T
                // launch (it'd be rejected too) — retry the persist+launch until the lock
                // clears. /compact can legitimately hold the lock for up to ~285s, so the
                // budget must span that (1s cadence, ~300 attempts) rather than give up in
                // ~5s and leave the UI falsely running. On genuine abandonment (budget
                // exhausted, or the user switched away) restore idle state + drop the
                // accumulator so nothing is left stuck. Await the persist first so the
                // continuation's reuse gate sees any compaction record on disk.
                const abandonPlanRestart = (): void => {
                  // Only if WE still own the accumulator (a replacement turn owns its own
                  // cleanup). MUST persist runStatus:'idle' — deleting the accumulator alone
                  // leaves the disk record 'running' (blocks /compact + shows stale busy).
                  if (streamAccumulators.get(convId)?.pendingAssistantId !== responseMessageId) return;
                  streamAccumulators.delete(convId);
                  void persistConversation(convId, treeForStream, headForStream, { runStatus: 'idle' });
                  if (activeIdRef.current === convId) {
                    setIsRunning(false);
                    // Re-surface the plan-restart affordance so the user can retry manually.
                    setShowIncompleteTaskBanner(true);
                  }
                };
                const attemptPlanRestart = (
                  remaining: number,
                  persistPromise: Promise<{ rejected?: string; superseded?: boolean; persisted?: boolean }>,
                ): void => {
                  // Ownership: only act if the accumulator is still THIS restart's (a Stop /
                  // replacement turn swaps pendingAssistantId). A stale retry/launch would
                  // revive cancelled work or clobber the new turn.
                  const ownsAccumulator = () =>
                    streamAccumulators.get(convId)?.pendingAssistantId === responseMessageId;
                  // Keyed on ACCUMULATOR OWNERSHIP, NOT active-ness — the plan-restart is
                  // MANDATORY and must proceed even after a chat switch (it works for a
                  // background conv). A Stop / replacement turn swaps pendingAssistantId and
                  // correctly abandons it. UI updates below stay active-gated.
                  const stillOwnsPlan = () => ownsAccumulator();
                  // On ownership loss we must not silently leave an orphan accumulator +
                  // disk runStatus:'running'. If WE still own the accumulator (the user just
                  // switched conversations, not a replacement turn), drop it + persist idle.
                  // If a replacement turn took the accumulator (different pendingAssistantId),
                  // leave everything to that new owner.
                  const cleanupIfOwnershipLost = (): void => {
                    if (ownsAccumulator()) {
                      streamAccumulators.delete(convId);
                      void persistConversation(convId, treeForStream, headForStream, { runStatus: 'idle' });
                    }
                  };
                  const repersist = (delayMs: number): void => {
                    if (remaining > 0 && stillOwnsPlan()) {
                      setTimeout(() => {
                        if (!stillOwnsPlan()) {
                          cleanupIfOwnershipLost();
                          return;
                        }
                        // Renew our continuation authorization while retrying past the auth TTL
                        // (a /compact can hold the conv far longer than 20s) — same as max-turns.
                        void app.agent
                          .authorizeContinuation?.(convId, CONTINUATION_CLIENT_ID, planTurnToken ?? convId)
                          .catch(() => {});
                        attemptPlanRestart(
                          remaining - 1,
                          persistConversation(convId, treeForStream, headForStream, {
                            runStatus: 'running',
                            ...(acc.pendingCompaction ? { conversationCompaction: acc.pendingCompaction } : {}),
                          }),
                        );
                      }, delayMs);
                    } else {
                      abandonPlanRestart();
                    }
                  };
                  void persistPromise.then(
                    (res) => {
                      if (!stillOwnsPlan()) {
                        cleanupIfOwnershipLost(); // ownership lost — clean up, don't leave running
                        return;
                      }
                      if (res?.rejected) {
                        repersist(1000);
                        return;
                      }
                      // SUPERSEDED or unknown ({} — IPC/write failure): the record isn't on
                      // disk, so re-persist before launching (else the reuse gate misses a
                      // pending compaction — AND, more importantly, `superseded` can mean the
                      // conversation was DELETED during the 100ms restart delay: launching then
                      // would revive deleted work + waste model/tool execution). Re-persist
                      // regardless of a pending compaction; the re-persist re-checks existence
                      // (a deleted conv keeps returning superseded → the bounded budget abandons
                      // via abandonPlanRestart, which persists idle and never launches).
                      if (res?.superseded || (!res?.persisted && !res?.rejected)) {
                        repersist(0);
                        return;
                      }
                      launchPlanContinuation();
                    },
                    () => {
                      if (stillOwnsPlan()) repersist(1000);
                    },
                  );
                };
                attemptPlanRestart(300, planContinuationPersist);
              }
            }, 100);
          } else {
            console.warn(`[StreamEvent] DONE setting isRunning=false for conv=${convId.slice(0, 8)}`);
            // Gate on active-ness: this block is no longer nested in `if (isActiveConv)` (moved
            // out in round 107 so background plan-restarts fire), so a BACKGROUND conv's `done`
            // reaching here must not clear the ACTIVE chat's running indicator.
            if (isActiveConv) setIsRunning(false);
          }
        }
        return;
      }

      if (isActiveConv) {
        setTree([...acc.messages]);
        setHeadId(acc.headId);
      }
      // Automation-owned stream: render live but NEVER persist from the renderer.
      // The main process writes the authoritative [user, assistant] turns; a
      // debounced renderer persist here could write a partial assistant-only
      // branch before the main write lands, creating duplicate/orphaned nodes.
      // ALSO skip persist for a PASSIVE MIRROR of another client's GUI turn (an accumulator
      // this client did NOT originate — locallyOriginated !== true — built from broadcast
      // events): the ORIGINATING client persists it. A mirror persisting here would write a
      // fabricated pre-reload user node + partial branch and corrupt the tree; it renders live
      // and reconciles from disk on the terminal event.
      if (
        e.automation ||
        e.serverPersisted ||
        automationStreams.has(convId) ||
        (streamAccumulators.get(convId) && acc.locallyOriginated !== true)
      ) {
        if (isActiveConv && !acc.awaitingApproval) setIsRunning(true);
        return;
      }
      const persistStatus =
        e.type === 'tool-approval-required'
          ? 'awaiting-approval'
          : acc.awaitingApproval
            ? 'awaiting-approval'
            : 'running';
      const persistExtra: Partial<ConversationRecord> = { runStatus: persistStatus };
      if (e.type === 'tool-approval-required') {
        persistExtra.hasUnread = true;
        // Mark as not running so the typing indicator / sidebar bubble stops
        if (isActiveConv) {
          setIsRunning(false);
        }
        // Persist immediately — no debounce — so the sidebar picks up the
        // awaiting-approval state even if the user switches threads quickly.
        const _pt = persistTimersRef.current.get(convId);
        if (_pt) {
          clearTimeout(_pt);
          persistTimersRef.current.delete(convId);
        }
        persistConversation(convId, acc.messages, acc.headId, persistExtra, seedContextFor(acc));
      } else {
        // Resume running indicator only if not awaiting approval — stale
        // text-delta events may arrive after tool-approval-required.
        if (isActiveConv && !acc.awaitingApproval) {
          setIsRunning(true);
        }
        streamHandlerRef.current.schedulePersist(convId, acc.messages, acc.headId, persistExtra);
      }
    };
    streamEventHandlerRef.current = handleStreamEvent;
    const unsubscribe = app.agent.onStreamEvent(handleStreamEvent);
    return unsubscribe;
  }, [bumpSubAgentVersion]);

  const onNew = useCallback(
    async (message: AppendMessage) => {
      const convId = activeIdRef.current;
      if (!convId) return;

      const pendingAttachments = consumeAttachments();
      // Capture the submitted text so a /compact-busy rejection (below) can restore the
      // draft the composer already cleared on submit — otherwise it's permanently lost.
      const submittedText = message.content
        .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
        .map((p) => p.text)
        .join('');
      const cwd = currentWorkingDirectoryRef.current;
      const userContent: ContentPart[] = [];
      for (const part of message.content) {
        if (part.type === 'text') userContent.push({ type: 'text', text: part.text });
        else if (part.type === 'image') {
          const imagePart = part as { image: string; mimeType?: string };
          userContent.push({
            type: 'image',
            image: imagePart.image,
            ...(imagePart.mimeType ? { mimeType: imagePart.mimeType } : {}),
          });
        }
      }
      for (const att of pendingAttachments) {
        const pathLabel = att.filePath ? att.filePath : att.name;
        if (att.isImage) {
          // Send the actual image data — the model reads the image directly, no text placeholder needed
          userContent.push({ type: 'image', image: att.dataUrl, mimeType: att.mime });
        } else if (att.text) {
          userContent.push({
            type: 'file',
            data: att.dataUrl,
            mimeType: att.mime,
            filename: att.name,
            displayOnly: true,
          });
          userContent.push({ type: 'text', text: `\n\n--- File: ${pathLabel} ---\n${att.text}\n--- End File ---\n` });
        } else {
          userContent.push({ type: 'file', data: att.dataUrl, mimeType: att.mime, filename: att.name });
          userContent.push({
            type: 'text',
            text: `\n[Attached file: ${pathLabel} (${att.mime}, ${(att.size / 1024).toFixed(1)} KB)]`,
          });
        }
      }
      if (!userContent.some((p) => p.type === 'text' || p.type === 'image')) return;

      // Compose-while-running: if a turn is still generating for this conversation
      // and cooperative mid-turn injection is enabled, route the send to the
      // running turn instead of starting a new one. The main process enqueues +
      // persists + broadcasts the user turn (rendered via the user-message event),
      // and the running Mastra turn splices it at its next step boundary. Only
      // text is supported for a mid-turn splice; if there are images/attachments,
      // fall through to a normal turn (which supersedes). If the main process says
      // the active run isn't cooperatively injectable (a CLI runtime), also fall
      // through to the normal supersede path.
      const wasRunningAtEntry = isRunningRef.current;
      // A composer fallback (sendMidTurn reported the branch changed / not injectable)
      // marks this conversation to FORCE a normal superseding send — do NOT re-enter
      // cooperative injection (which would re-run policy hooks + splice onto the old
      // transcript). Consume the one-shot flag; the block below is skipped when set.
      const forceNormalSend = forceNormalSendConvs.delete(convId);
      if (isRunningRef.current && !forceNormalSend) {
        const onlyText = userContent.length > 0 && userContent.every((p) => p.type === 'text');
        if (onlyText) {
          const text = userContent
            .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
            .map((p) => p.text)
            .join('\n')
            .trim();
          if (text) {
            const res = await app.agent.injectMidTurn(convId, text);
            if (res.ok && res.cooperative) return; // spliced into the running turn
            // A policy hook BLOCKED the send — it was HANDLED (rejected), not a
            // "couldn't inject" case. Do NOT fall through to a normal turn (that
            // would re-run the blocked text + supersede the active run, and a
            // plugin pre-send abort may already have persisted the raw node). Stop
            // here; the draft stays in the composer (onNew already consumed it, so
            // surface the reason for the user).
            if (res.blocked) {
              if (res.error) console.warn(`[mid-turn-inject] blocked: ${res.error}`);
              // The composer already cleared the submitted text on send. A policy
              // block is terminal (no resend), but the draft must NOT be silently
              // lost — restore it the same way the conversation-busy rejection does:
              // put it straight back if this chat is active with an empty composer,
              // else stash it (FIFO) for restoration when the user returns here.
              if (submittedText.trim().length > 0 || pendingAttachments.length > 0) {
                const composerHasNewDraft =
                  activeIdRef.current === convId &&
                  (runtimeRef.current?.thread?.composer?.getState?.().text ?? '').trim().length > 0;
                const canRestoreNow =
                  activeIdRef.current === convId && attachmentsRef.current.length === 0 && !composerHasNewDraft;
                if (canRestoreNow) {
                  if (pendingAttachments.length > 0) addAttachments(pendingAttachments);
                  restoreComposerDraft(submittedText);
                } else {
                  enqueueRejectedDraft(convId, { text: submittedText, attachments: pendingAttachments });
                }
              }
              return;
            }
            // Not cooperatively injectable (CLI runtime / race) — fall through to a
            // normal new turn, which supersedes the running one. NOTE: everything below
            // must use the LIVE accumulator / activeIdRef, not the closure tree/headId
            // captured at entry — the await above let the running turn stream more AND may
            // have let the user switch conversations.
          }
        }
      }

      // Base the new turn on the freshest tree available. If the running turn is still live,
      // use its accumulator (it may have streamed more during an awaited injectMidTurn). If
      // its accumulator is GONE, the run FINALIZED during that await — prefer the FINALIZED
      // snapshot the terminal handler recorded (lastFinalizedBranch): its persist is
      // fire-and-forget, so a plain disk reread here could hit the pre-finalization PARTIAL
      // tree (possibly equal length) and the new turn would overwrite the terminal write.
      // Fall back to a disk reread, then the (stale) closure tree.
      const liveAcc = streamAccumulators.get(convId);
      let baseTree: StoredMessage[] = liveAcc ? liveAcc.messages : tree;
      let baseHead: string | null = liveAcc ? liveAcc.headId : headId;
      if (!liveAcc && wasRunningAtEntry) {
        const finalized = lastFinalizedBranch.get(convId);
        if (finalized && finalized.messages.length >= baseTree.length) {
          baseTree = finalized.messages;
          baseHead = finalized.headId;
        } else {
          try {
            const fresh = (await app.conversations.get(convId)) as ConversationRecord | null;
            if (fresh) {
              const { tree: ft, headId: fh } = ensureTree(fresh);
              if (ft.length >= baseTree.length) {
                baseTree = ft;
                baseHead = fh;
              }
            }
          } catch {
            /* disk read failed — fall back to the closure tree (best-effort) */
          }
        }
      }
      // The finalized snapshot has served its purpose (base for THIS new turn); drop it so it
      // can't stale-base a much-later turn after further edits.
      clearFinalizedBranch(convId);
      const userMsg: StoredMessage = {
        id: msgId(),
        parentId: baseHead,
        role: 'user',
        content: toStoredContent(userContent),
        createdAt: new Date(),
      };
      const newTree = [...baseTree, userMsg];
      const newHead = userMsg.id;
      const pendingAssistantTiming = createPendingAssistantTiming();
      const responseMessageId = msgId();
      // Capture the SUPERSEDED accumulator's seed provenance before we replace it:
      // if it was background-seeded, `tree` (and thus newTree) may still carry its
      // detached orphan base, so this persist must repair it too. Carry the
      // provenance forward onto the new turn's accumulator as well.
      const supersededSeed = seedContextFor(streamAccumulators.get(convId));
      // Carry the SUPERSEDED accumulator's pending compaction forward: if the running turn
      // it replaces had produced a paid compaction summary that hadn't been persisted yet,
      // superseding + persisting without it (and suppressing the old stream's terminal
      // event) would drop the summary, forcing the replacement turn to re-compact/overflow.
      // Carry a pending compaction from the SUPERSEDED accumulator OR — if a terminal
      // done/error already deleted that accumulator but its compaction persist hasn't been
      // confirmed on disk — from the per-conversation handoff map. Otherwise a resubmit
      // that races the terminal persist would drop the paid summary.
      const supersededCompaction =
        streamAccumulators.get(convId)?.pendingCompaction ?? pendingCompactionHandoff.get(convId) ?? undefined;
      // Update the UI ONLY if this conversation is still active — an awaited injectMidTurn
      // above may have let the user switch to another chat, and setTree/setHeadId/setIsRunning
      // would otherwise replace THAT chat's displayed state with this one's.
      if (activeIdRef.current === convId) {
        setTree(newTree);
        setHeadId(newHead);
        setIsRunning(true);
      }

      supersedeCurrentGeneration(convId); // stale run's late events must not bind the replacement accumulator
      // A renderer-initiated (GUI) turn is RENDERER-owned — it persists its own output. If it
      // supersedes a prior CLI/automation (main-owned) turn, clear that conversation's
      // main-owned marker; otherwise the mainOwned/mainOwnsPersistence checks would treat this
      // GUI turn's events as server-persisted and never persist its assistant output (it would
      // disappear on completion). A late event from the superseded run must not re-add it (the
      // add site is generation-guarded).
      automationStreams.delete(convId);
      streamAccumulators.set(convId, {
        messages: [...newTree],
        headId: newHead,
        pendingAssistantTiming,
        pendingAssistantId: responseMessageId,
        pendingCompaction: supersededCompaction,
        seededBackground: supersededSeed?.seededBackground,
        seededDiskHeadId: supersededSeed?.seededDiskHeadId,
        // Capture THIS run's settings so a later continuation (max_turns / plan-restart) uses
        // them even if the user has switched to another chat by then (not the live refs).
        runConfig: {
          selectedModelKey,
          reasoningEffort,
          selectedProfileKey,
          fallbackEnabled,
          cwd,
          executionMode,
          threadOverrides,
        },
        locallyOriginated: true, // this client started the turn → it drives any auto-continue/restart
      });
      const branch = getActiveBranch(newTree, newHead);

      const persistRes = await persistConversation(
        convId,
        newTree,
        newHead,
        { runStatus: 'running', ...(supersededCompaction ? { conversationCompaction: supersededCompaction } : {}) },
        supersededSeed,
      );
      // Did the initial persist CONFIRM landing on disk? Unknown ({} from a caught write error)
      // or superseded means the supersededCompaction it carried may NOT be on disk — the launch
      // below must then confirm it before running (else the stream re-summarizes the raw branch).
      const initialPersistConfirmed = persistRes?.persisted === true;
      // Main rejected the optimistic turn because a /compact holds the conversation. Roll
      // back the optimistic user message + running state and DON'T launch the stream (it
      // would be rejected too). The user can resend once compaction finishes.
      if (persistRes?.rejected) {
        const rejectedKind = persistRes.rejected;
        // Only tear down if we STILL OWN the accumulator. A /compact-concurrent send can
        // await this persist while a Stop or a superseding turn (run C) replaces the
        // accumulator with a new pendingAssistantId; our stale rejection must not delete
        // C's accumulator (which would strand C's run) nor restore our stale tree/draft.
        if (streamAccumulators.get(convId)?.pendingAssistantId !== responseMessageId) {
          // Our submitted text + attachments were cleared from the composer at submit time.
          // Preserve them by enqueueing ONLY when this submission is genuinely lost with
          // nothing else carrying it forward — i.e. a compaction-BUSY reject (retryable once
          // compaction ends) AND the accumulator is now ABSENT (a Stop deleted it; the run is
          // gone). Do NOT enqueue when: (a) the reject is conversation-DELETED (the conv is
          // gone — a stash under its id retains forever + never restores), or (b) a SUPERSEDING
          // turn installed a replacement accumulator (present, different id) — that turn is the
          // user's own newer send, so requeuing this draft would resurface it as a duplicate.
          const supersededByReplacement = streamAccumulators.has(convId);
          if (
            rejectedKind === 'conversation-busy' &&
            !supersededByReplacement &&
            (submittedText.trim().length > 0 || pendingAttachments.length > 0)
          ) {
            enqueueRejectedDraft(convId, { text: submittedText, attachments: pendingAttachments });
          }
          return;
        }
        streamAccumulators.delete(convId);
        // Restore the submitted input so it isn't lost. If THIS conversation is active AND
        // the composer is empty, put it straight back. Otherwise (the user switched to
        // another chat, or started a newer draft here) we can't restore now without
        // targeting the wrong conversation / clobbering a live draft — STASH it so
        // loadConversationState restores it when the user returns to this chat.
        const composerHasNewDraft =
          activeIdRef.current === convId &&
          (runtimeRef.current?.thread?.composer?.getState?.().text ?? '').trim().length > 0;
        const canRestoreNow =
          activeIdRef.current === convId && attachmentsRef.current.length === 0 && !composerHasNewDraft;
        if (canRestoreNow) {
          setTree(baseTree);
          setHeadId(baseHead);
          setIsRunning(false);
          if (pendingAttachments.length > 0) addAttachments(pendingAttachments);
          restoreComposerDraft(submittedText);
        } else {
          // Roll back the tree/running state for the active chat if it's this one, but keep
          // the input for later restoration rather than dropping it.
          if (activeIdRef.current === convId) {
            setTree(baseTree);
            setHeadId(baseHead);
            setIsRunning(false);
          }
          // Enqueue for later restoration (FIFO) rather than dropping it. The queue keeps a
          // second rejection from overwriting/discarding the first (both survive + restore).
          // Skip for a conversation-DELETED reject — a stash under a dead conv id never
          // restores (loadConversationState won't run for it) and retains forever.
          if (rejectedKind !== 'conversation-deleted') {
            enqueueRejectedDraft(convId, { text: submittedText, attachments: pendingAttachments });
          }
        }
        return;
      }
      void maybeGenerateTitle(convId, branch);
      // The old turn's summarizer may have COMPLETED during the awaited persist above,
      // attaching its compaction event to THIS (replacement) accumulator AFTER we already
      // issued the persist with the pre-await snapshot. If the accumulator now carries a
      // compaction the persist didn't include, durably persist it BEFORE launching — else
      // the replacement stream reads disk without the summary and re-summarizes the same
      // prefix. Retry superseded/unknown outcomes; only launch once it's on disk (or there's
      // nothing new to persist). Guard ownership so a Stop/switch abandons the chain.
      const persistedCompactionId = supersededCompaction?.compactionId;
      const launchNew = () =>
        launchAgentStream(
          convId,
          branch,
          selectedModelKey ?? undefined,
          reasoningEffort ?? 'medium',
          selectedProfileKey ?? undefined,
          fallbackEnabled ?? false,
          cwd ?? undefined,
          executionMode ?? 'auto',
          threadOverrides ?? undefined,
          responseMessageId,
        );
      // Ownership is keyed on the ACCUMULATOR (pendingAssistantId), NOT active-ness — a
      // legitimately-started turn for THIS conversation must launch + settle even if the
      // user has since switched to another chat (else A's accumulator + persisted
      // `running` status are stranded running forever). A Stop or a superseding turn
      // replaces pendingAssistantId, which correctly abandons this chain.
      const ownsNew = () => streamAccumulators.get(convId)?.pendingAssistantId === responseMessageId;
      const nowPending = streamAccumulators.get(convId)?.pendingCompaction;
      if (ownsNew() && nowPending && nowPending.compactionId !== persistedCompactionId) {
        const durablyPersistThenLaunch = (remaining: number): void => {
          if (!ownsNew()) return;
          // Re-read the LATEST pending compaction each attempt: a NEWER reactive compaction can
          // land on the accumulator during the retry wait, and launching with the stale one
          // would trigger avoidable overflow recovery / duplicate paid compaction.
          const latestPending = streamAccumulators.get(convId)?.pendingCompaction ?? nowPending;
          void persistConversation(convId, newTree, newHead, {
            runStatus: 'running',
            conversationCompaction: latestPending,
          }).then(
            (r) => {
              if (!ownsNew()) return;
              // A conversation-DELETED rejection is PERMANENT — abandon (don't retry, don't
              // launch): retrying is futile and launching would run model/tool work against a
              // gone chat (unpersisted output + invisible side effects). launchAgentStream's
              // deleted-reject + the main-side guards backstop, but stop here cleanly.
              if (r?.rejected === 'conversation-deleted') return;
              // Launch ONLY once the compaction record is confirmed on disk. A
              // conversation-busy (/compact lock — up to ~285s), superseded, or unknown/write-
              // fail outcome means it did NOT land — retry (bounded to SPAN /compact's window at
              // 1s cadence) rather than launch against the raw branch (which would re-summarize/
              // rebill OR be rejected busy, losing the optimistic prompt). Launch after the
              // budget only as a last resort (reactive recovery backstops).
              if (r?.persisted) launchNew();
              else if (remaining > 0) setTimeout(() => durablyPersistThenLaunch(remaining - 1), 1000);
              else launchNew();
            },
            () => {
              if (!ownsNew()) return;
              if (remaining > 0) setTimeout(() => durablyPersistThenLaunch(remaining - 1), 1000);
              else launchNew();
            },
          );
        };
        durablyPersistThenLaunch(300); // ~300s: spans /compact's max hold
      } else if (ownsNew()) {
        // No late compaction was seen at the sample above. Yield one macrotask so any
        // compaction event already queued on the IPC channel (from a stale run) can land on
        // the accumulator, THEN re-check right before launching — the two synchronous samples
        // above cannot observe such an event, so without this yield the recheck is dead. If one
        // appeared, durably persist it first (else the launched stream's reuse gate reads disk
        // without it and re-compacts/re-bills the same prefix).
        setTimeout(() => {
          if (!ownsNew()) return;
          const lateComp = streamAccumulators.get(convId)?.pendingCompaction;
          // The compaction that MUST be on disk before launching is the late one if newer,
          // else the supersededCompaction the FIRST persist tried to write. That first persist
          // can return UNKNOWN (catch → {}) or fail WITHOUT a rejected flag, in which case its
          // compaction never landed — launching then reads the raw branch and re-summarizes.
          // So confirm-then-launch whenever there is ANY intended compaction that the initial
          // persist did not CONFIRM (persisted:true).
          const intended =
            lateComp && lateComp.compactionId !== persistedCompactionId
              ? lateComp
              : !initialPersistConfirmed && supersededCompaction
                ? supersededCompaction
                : undefined;
          if (intended) {
            const confirmThenLaunch = (remaining: number): void => {
              if (!ownsNew()) return;
              // Re-read the latest pending compaction each attempt (a newer reactive compaction
              // may have landed) — prefer it over the initially-captured `intended`.
              const latest = streamAccumulators.get(convId)?.pendingCompaction;
              const toPersist = latest && latest.compactionId !== persistedCompactionId ? latest : intended;
              void persistConversation(convId, newTree, newHead, {
                runStatus: 'running',
                conversationCompaction: toPersist,
              }).then(
                (r) => {
                  if (!ownsNew()) return;
                  if (r?.rejected === 'conversation-deleted') return; // permanent — abandon (don't launch a gone chat)
                  if (r?.persisted) launchNew();
                  else if (remaining > 0) setTimeout(() => confirmThenLaunch(remaining - 1), 1000);
                  else launchNew(); // budget exhausted — last resort (reactive recovery backstops)
                },
                () => {
                  if (!ownsNew()) return;
                  if (remaining > 0) setTimeout(() => confirmThenLaunch(remaining - 1), 1000);
                  else launchNew();
                },
              );
            };
            confirmThenLaunch(300); // ~300s: spans /compact's max hold
          } else {
            launchNew();
          }
        }, 0);
      }
    },
    [
      tree,
      headId,
      selectedModelKey,
      reasoningEffort,
      executionMode,
      selectedProfileKey,
      fallbackEnabled,
      threadOverrides,
      consumeAttachments,
      addAttachments,
    ],
  );

  const onReload = useCallback(
    async (parentId: string | null) => {
      const convId = activeIdRef.current;
      if (!convId) return;
      // Same concurrency guard as onEdit: don't start a second run while one is
      // streaming or awaiting a tool approval (accumulator still present), or the
      // new controller would replace the live one and break cancel.
      if (isRunningRef.current || streamAccumulators.has(convId)) return;

      // parentId is the message ID to regenerate from (the user message before the assistant response)
      // We keep the old assistant branch (it becomes an alternate sibling) and start a new one
      const reloadParentId = parentId ?? headId;
      if (!reloadParentId) return;

      // Find the parent message — if it's an assistant message, go to its parent (the user message)
      const parentMsg = tree.find((m) => m.id === reloadParentId);
      const actualParent = parentMsg?.role === 'assistant' ? parentMsg.parentId : reloadParentId;

      // Clear retitle dedup so the regenerated response can trigger a title update
      lastRetitleCount.delete(convId);

      setHeadId(actualParent);
      setIsRunning(true);

      const newTree = [...tree]; // keep all existing messages (old branches preserved)
      const responseMessageId = msgId();
      // Capture THIS run's settings + CWD NOW (before any await) so a later continuation —
      // and the launch below — use A's workspace even if the user switches to B during the
      // awaited persist (reading currentWorkingDirectoryRef live would pick up B's CWD).
      const reloadRunCwd = currentWorkingDirectoryRef.current;
      const reloadRunConfig = {
        selectedModelKey,
        reasoningEffort,
        selectedProfileKey,
        fallbackEnabled,
        cwd: reloadRunCwd,
        executionMode,
        threadOverrides,
      };
      supersedeCurrentGeneration(convId); // stale run's late events must not bind the replacement accumulator
      // Renderer-owned GUI reload (regenerate) — clear any stale main-owned marker so its
      // output persists (see onNew).
      automationStreams.delete(convId);
      streamAccumulators.set(convId, {
        messages: newTree,
        headId: actualParent,
        pendingAssistantTiming: createPendingAssistantTiming(),
        pendingAssistantId: responseMessageId,
        runConfig: reloadRunConfig,
        locallyOriginated: true, // this client started the reload → it drives any auto-continue/restart
      });
      const branch = getActiveBranch(newTree, actualParent);
      const reloadPreHead = headIdRef.current;
      const reloadPersistRes = await persistConversation(convId, newTree, actualParent, { runStatus: 'running' });
      // /compact holds the conversation — a regenerate is a head-changing op the put-guard
      // rejects. Roll back head + running state and don't launch (no draft to preserve).
      if (reloadPersistRes?.rejected) {
        if (streamAccumulators.get(convId)?.pendingAssistantId !== responseMessageId) return;
        streamAccumulators.delete(convId);
        if (activeIdRef.current === convId) {
          setHeadId(reloadPreHead);
          setIsRunning(false);
        }
        return;
      }
      console.info(
        `[UI:stream:reload] Firing agent:stream conv=${convId} model=${selectedModelKey ?? 'default'} reasoning=${reasoningEffort ?? 'medium'} messageCount=${branch.length} roles=${branch.map((m) => m.role).join(',')}`,
      );
      // A Stop / superseding turn during the awaited persist may have replaced this
      // accumulator (a superseded persist, not `rejected`); don't launch a cancelled run.
      if (streamAccumulators.get(convId)?.pendingAssistantId !== responseMessageId) return;
      launchAgentStream(
        convId,
        branch,
        selectedModelKey ?? undefined,
        reasoningEffort ?? 'medium',
        selectedProfileKey ?? undefined,
        fallbackEnabled ?? false,
        reloadRunCwd ?? undefined,
        executionMode ?? 'auto',
        threadOverrides ?? undefined,
        responseMessageId,
      );
    },
    [
      tree,
      headId,
      selectedModelKey,
      reasoningEffort,
      executionMode,
      selectedProfileKey,
      fallbackEnabled,
      threadOverrides,
    ],
  );

  const onEdit = useCallback(
    async (message: AppendMessage) => {
      const convId = activeIdRef.current;
      if (!convId) return;
      // Don't start a concurrent run: if a response is streaming, editing would
      // spawn a second run whose controller replaces the live one in
      // activeStreams, breaking cancel. Ignore edits while running. `isRunning`
      // goes false while a tool approval is pending even though the main-process
      // stream is still alive, so ALSO block when an accumulator exists for this
      // conversation (covers the awaiting-approval window).
      if (isRunningRef.current || streamAccumulators.has(convId)) return;

      // assistant-ui's edit action passes sourceId = the original message id and
      // parentId = that same id. Anchor the new node at the ORIGINAL's parent so
      // the edit becomes a sibling variant (not a child of the old prompt).
      const source = message.sourceId ? tree.find((m) => m.id === message.sourceId) : undefined;
      const editParentId = source ? (source.parentId ?? null) : (message.parentId ?? null);

      const userContent: ContentPart[] = [];
      // The user's edited draft text is JUST the text parts of the incoming message —
      // capture it NOW, before we append preserved source attachments (inline
      // `--- File: ---` blocks etc.) to userContent. Restoring userContent's text on a
      // /compact-busy rollback would otherwise re-insert the attachment blocks into the
      // composer, duplicating them when the user retries.
      const editedText = message.content
        .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
        .map((p) => p.text)
        .join('');
      // The edit's OWN image attachments (added via the edit composer — distinct from the source
      // turn's preserved attachments below). Captured as AttachedFile[] so a /compact-busy rollback
      // can restore them too (restoring only editedText would silently DROP a newly-attached image).
      const editedAttachments: AttachedFile[] = [];
      for (const part of message.content) {
        if (part.type === 'image') {
          const imagePart = part as { image: string; mimeType?: string };
          const mime = imagePart.mimeType ?? 'image/png';
          editedAttachments.push({
            name: `image.${(mime.split('/')[1] ?? 'png').split('+')[0]}`,
            mime,
            isImage: true,
            size: Math.floor((imagePart.image.length * 3) / 4), // approx bytes from base64/dataURL length
            dataUrl: imagePart.image,
          });
        }
      }
      for (const part of message.content) {
        if (part.type === 'text') userContent.push({ type: 'text', text: part.text });
        else if (part.type === 'image') {
          const imagePart = part as { image: string; mimeType?: string };
          userContent.push({
            type: 'image',
            image: imagePart.image,
            ...(imagePart.mimeType ? { mimeType: imagePart.mimeType } : {}),
          });
        }
      }
      // Preserve attachments from the original turn so editing the prompt text
      // doesn't silently drop them: images, file parts, and inlined text-file
      // parts (the model-visible `--- File: ... ---` blocks).
      if (source && Array.isArray(source.content)) {
        for (const part of source.content as ContentPart[]) {
          if (part.type === 'image' && !userContent.some((p) => p.type === 'image' && p.image === part.image)) {
            userContent.push(part);
          } else if (part.type === 'file') {
            userContent.push(part);
          } else if (
            part.type === 'text' &&
            (part.text.startsWith('\n\n--- File:') || part.text.startsWith('\n[Attached file:'))
          ) {
            userContent.push(part);
          }
        }
      }
      if (!userContent.some((p) => p.type === 'text' || p.type === 'image')) return;

      const editedMsg: StoredMessage = {
        id: msgId(),
        parentId: editParentId,
        role: 'user',
        content: toStoredContent(userContent),
        createdAt: new Date(),
      };
      const newTree = [...tree, editedMsg];
      const newHead = editedMsg.id;
      const pendingAssistantTiming = createPendingAssistantTiming();
      const responseMessageId = msgId();
      // Capture pre-edit state so a /compact-busy rejection can roll back. (editedText is
      // captured above, from the raw message text, before source attachments were appended.)
      const preEditTree = tree;
      const preEditHead = headIdRef.current;

      lastRetitleCount.delete(convId);
      setTree(newTree);
      setHeadId(newHead);
      setIsRunning(true);

      supersedeCurrentGeneration(convId); // stale run's late events must not bind the replacement accumulator
      // Renderer-owned GUI edit — clear any stale main-owned marker so its output persists
      // (see onNew).
      automationStreams.delete(convId);
      // Capture THIS run's settings + CWD before the persist await so the launch + any later
      // continuation use A's workspace even if the user switches to B during the await.
      const editRunCwd = currentWorkingDirectoryRef.current;
      const editRunConfig = {
        selectedModelKey,
        reasoningEffort,
        selectedProfileKey,
        fallbackEnabled,
        cwd: editRunCwd,
        executionMode,
        threadOverrides,
      };
      streamAccumulators.set(convId, {
        messages: [...newTree],
        headId: newHead,
        pendingAssistantTiming,
        pendingAssistantId: responseMessageId,
        runConfig: editRunConfig,
        locallyOriginated: true, // this client started the edit → it drives any auto-continue/restart
      });
      const branch = getActiveBranch(newTree, newHead);

      const editPersistRes = await persistConversation(convId, newTree, newHead, { runStatus: 'running' });
      // /compact holds the conversation: roll back the optimistic edit, restore the
      // composer draft, and don't launch (the stream would be rejected too).
      if (editPersistRes?.rejected) {
        const rejectedKind = editPersistRes.rejected;
        // If a Stop / superseding turn replaced the accumulator during the await we no longer
        // own it (must not delete it / touch the tree). The edited text was already consumed,
        // so ENQUEUE it — but ONLY when genuinely lost: a compaction-BUSY reject (retryable)
        // AND the accumulator is now ABSENT (a Stop deleted it). Skip for conversation-DELETED
        // (stash under a dead id never restores) and for a SUPERSEDING replacement (present,
        // different id — the user's newer turn; requeuing would resurface a duplicate draft).
        if (streamAccumulators.get(convId)?.pendingAssistantId !== responseMessageId) {
          const supersededByReplacement = streamAccumulators.has(convId);
          if (
            rejectedKind === 'conversation-busy' &&
            !supersededByReplacement &&
            (editedText.trim().length > 0 || editedAttachments.length > 0)
          ) {
            enqueueRejectedDraft(convId, { text: editedText, attachments: editedAttachments });
          }
          return;
        }
        streamAccumulators.delete(convId);
        // Roll back the optimistic edit + restore the edited text so it isn't lost. Mirror
        // onNew: only put the text straight back if THIS chat is active AND the composer is
        // empty; if the user switched away OR already started a NEWER draft here,
        // restoreComposerDraft would silently no-op (it won't clobber a live draft) and the
        // edit would be LOST — so ENQUEUE it for FIFO restoration when the composer next
        // empties / the user returns (loadConversationState + the composer-empty effect).
        const composerHasNewDraft =
          activeIdRef.current === convId &&
          (runtimeRef.current?.thread?.composer?.getState?.().text ?? '').trim().length > 0;
        const canRestoreNow =
          activeIdRef.current === convId && !composerHasNewDraft && attachmentsRef.current.length === 0;
        if (activeIdRef.current === convId) {
          setTree(preEditTree);
          setHeadId(preEditHead);
          setIsRunning(false);
        }
        if (canRestoreNow) {
          if (editedAttachments.length > 0) addAttachments(editedAttachments);
          restoreComposerDraft(editedText);
        } else if (
          (editedText.trim().length > 0 || editedAttachments.length > 0) &&
          rejectedKind !== 'conversation-deleted'
        ) {
          // The user switched away OR has a newer draft/attachments — can't restore into the
          // composer now, so ENQUEUE text + the edit's own attachments (parity with onNew). The
          // queue keeps a second rejection from discarding this one. Skip for DELETED (dead id).
          enqueueRejectedDraft(convId, { text: editedText, attachments: editedAttachments });
        }
        return;
      }
      void maybeGenerateTitle(convId, branch);
      console.info(
        `[UI:stream:edit] Firing agent:stream conv=${convId} model=${selectedModelKey ?? 'default'} reasoning=${reasoningEffort ?? 'medium'} messageCount=${branch.length} sourceId=${message.sourceId ?? '(none)'}`,
      );
      // Stop / superseding turn during the awaited persist may have replaced the
      // accumulator (superseded, not rejected) — don't launch a cancelled run.
      if (streamAccumulators.get(convId)?.pendingAssistantId !== responseMessageId) return;
      launchAgentStream(
        convId,
        branch,
        selectedModelKey ?? undefined,
        reasoningEffort ?? 'medium',
        selectedProfileKey ?? undefined,
        fallbackEnabled ?? false,
        editRunCwd ?? undefined,
        executionMode ?? 'auto',
        threadOverrides ?? undefined,
        responseMessageId,
      );
    },
    [tree, selectedModelKey, reasoningEffort, executionMode, selectedProfileKey, fallbackEnabled, threadOverrides],
  );

  const onCancel = useCallback(async () => {
    const convId = activeIdRef.current;
    if (!convId) return;

    // Automation-owned stream: abort the automation run instead of cancelling an
    // interactive agent stream. The main process persists the partial output and
    // broadcasts a terminal `done` that the automation-done handler reconciles.
    //
    // A mid-turn-INJECTED automation run (busy-target inject) is owned by
    // activeStreams/streamHandler, not automationRunAborts — so automations.abort
    // returns false for it. Fall through to agent:cancel-stream in that case so
    // an injected run is still cancellable from the stop button.
    if (automationStreams.has(convId)) {
      setIsRunning(false);
      let aborted = false;
      try {
        aborted = await app.automations.abort(convId);
      } catch {
        /* ignore */
      }
      if (aborted) return;
      try {
        await app.agent.cancelStream(convId);
      } catch {
        /* ignore */
      }
      return;
    }

    // Use refs to get the latest tree/headId (not stale closure values)
    const currentTree = treeRef.current;
    const currentHeadId = headIdRef.current;

    // Clean up accumulator first — use its state if it has more recent data
    const acc = streamAccumulators.get(convId);
    const finishedAt = nowIso();
    const pendingStartedAt = acc?.pendingAssistantTiming?.startedAt;
    if (acc) finalizeAssistantResponse(acc, finishedAt);
    // Blacklist the cancelled run's generation BEFORE deleting the accumulator so a queued
    // late delta can't recreate the accumulator (2633) and lock it, then schedule a newer
    // `running` persist that supersedes this cancellation's idle persist (stuck running).
    supersedeCurrentGeneration(convId);
    streamAccumulators.delete(convId);
    const latestTree = acc ? acc.messages : currentTree;
    const latestHead = acc ? acc.headId : currentHeadId;

    // If the head is a user message, no assistant response was created yet.
    // Insert a placeholder so the cancelled state is visible with a retry button.
    const headMsg = latestTree.find((m) => m.id === latestHead);
    if (headMsg?.role === 'user') {
      const cancelledMsgBase: StoredMessage = {
        id: msgId(),
        parentId: latestHead,
        role: 'assistant',
        content: [],
        createdAt: new Date(),
      };
      const cancelledMsg = pendingStartedAt
        ? withResponseTiming(cancelledMsgBase, buildResponseTiming(pendingStartedAt, finishedAt))
        : cancelledMsgBase;
      const newTree = [...latestTree, cancelledMsg];
      const newHead = cancelledMsg.id;
      setTree(newTree);
      setHeadId(newHead);
      setIsRunning(false);
      try {
        await app.agent.cancelStream(convId);
      } catch {
        /* ignore */
      }
      persistConversation(convId, newTree, newHead, {
        runStatus: 'idle',
        // Preserve a summary the reactive-recovery path already paid for this turn
        // (staged in acc.pendingCompaction). Omitting it on cancel makes the next turn
        // reload the original branch and re-compact — mirrors the done/error paths.
        ...(acc?.pendingCompaction ? { conversationCompaction: acc.pendingCompaction } : {}),
      });
      return;
    }

    // Head is already an assistant message — preserve whatever content it has
    setTree([...latestTree]);
    setHeadId(latestHead);
    setIsRunning(false);
    try {
      await app.agent.cancelStream(convId);
    } catch (err) {
      console.error('[Runtime] Cancel failed:', err);
    }
    persistConversation(convId, latestTree, latestHead, {
      runStatus: 'idle',
      ...(acc?.pendingCompaction ? { conversationCompaction: acc.pendingCompaction } : {}),
    });
  }, []);

  // Branch navigation
  const goToBranch = useCallback(
    (siblingId: string) => {
      // Walk from this sibling down to the deepest descendant on the "latest"
      // path (cycle-guarded — see deepestLatestDescendant).
      const newHead = deepestLatestDescendant(tree, siblingId);
      const prevHead = headIdRef.current;
      setHeadId(newHead);
      // Persist the head change. If it's REJECTED (a /compact holds the conversation — a
      // head-only mutation is rejected while compacting), the switch did NOT save; REVERT the
      // optimistic setHeadId so the UI doesn't show a branch that disagrees with disk (which a
      // later compaction upsert/reload would abruptly revert anyway). Only revert if the active
      // conv is still this one and the head is still our optimistic value (no newer nav/turn).
      const convId = activeIdRef.current;
      if (convId) {
        void persistConversation(convId, tree, newHead).then((r) => {
          if (r?.rejected && activeIdRef.current === convId && headIdRef.current === newHead) {
            setHeadId(prevHead);
          }
        });
      }
    },
    [tree],
  );

  const branchNav = useCallback<BranchNavLookup>(
    (messageId) => {
      const point = messageId ? branchPoints.get(messageId) : branchInfo;
      if (!point || point.total <= 1) return null;
      return {
        total: point.total,
        current: point.currentIdx + 1,
        goToPrevious: () => {
          if (point.currentIdx <= 0) return;
          goToBranch(point.siblings[point.currentIdx - 1].id);
        },
        goToNext: () => {
          if (point.currentIdx >= point.total - 1) return;
          goToBranch(point.siblings[point.currentIdx + 1].id);
        },
      };
    },
    [branchPoints, branchInfo, goToBranch],
  );

  const assistantResponseTiming = useMemo<AssistantResponseTimingState>(
    () => ({
      activeRunStartedAt,
    }),
    [activeRunStartedAt],
  );
  const promptHistory = useMemo<PromptHistoryState>(
    () => ({
      conversationId: activeConversationId,
      prompts: [...activeBranch]
        .reverse()
        .map((message) => extractPromptHistoryText(message))
        .filter((message): message is string => Boolean(message)),
    }),
    [activeBranch, activeConversationId],
  );

  // Compose-while-running: enqueue a typed follow-up into the running turn.
  // Returns true when it was cooperatively injected (Mastra) so the composer can
  // just clear; false means fall back to the normal send (supersede / new turn).
  const [pendingInjects, setPendingInjects] = useState<Array<{ id: string; text: string }>>([]);
  const midTurnMode: 'splice' | 'queue-editable' =
    (config as { ui?: { composer?: { midTurnSend?: string } } } | null)?.ui?.composer?.midTurnSend === 'queue-editable'
      ? 'queue-editable'
      : 'splice';

  const refreshPendingInjects = useCallback(async () => {
    const convId = activeIdRef.current;
    if (!convId || midTurnMode !== 'queue-editable') {
      setPendingInjects([]);
      return;
    }
    try {
      const list = await app.agent.listInjects(convId);
      setPendingInjects(list.map((e) => ({ id: e.id, text: e.text })));
    } catch {
      setPendingInjects([]);
    }
  }, [midTurnMode]);

  const sendMidTurn = useCallback(
    async (text: string): Promise<MidTurnSendOutcome> => {
      const convId = activeIdRef.current;
      const trimmed = text.trim();
      if (!convId || !trimmed || !isRunningRef.current) return { status: 'fallback', originConversationId: convId };
      try {
        const res = await app.agent.injectMidTurn(convId, trimmed);
        if (res.ok && res.cooperative) {
          void refreshPendingInjects();
          return { status: 'injected', originConversationId: convId };
        }
        // A policy hook BLOCKED the message — it was handled (rejected), NOT a
        // "couldn't inject" case. The caller must NOT fall back to a normal send
        // that would re-run the blocked text; it restores the draft + surfaces
        // the reason instead.
        if (res.blocked) return { status: 'blocked', reason: res.error, originConversationId: convId };
        return { status: 'fallback', originConversationId: convId };
      } catch {
        return { status: 'fallback', originConversationId: convId };
      }
    },
    [refreshPendingInjects],
  );

  const cancelInject = useCallback(async (id: string): Promise<string | null> => {
    const convId = activeIdRef.current;
    if (!convId) return null;
    try {
      const res = await app.agent.cancelInject(convId, id);
      setPendingInjects((prev) => prev.filter((e) => e.id !== id));
      return res.ok ? (res.text ?? null) : null;
    } catch {
      return null;
    }
  }, []);

  // Injects are consumed by prepareStep as the turn steps; refresh the chip list
  // when the turn ends (all spliced/drained) and — in queue-editable mode — poll
  // while running so a chip disappears once its message is spliced mid-turn.
  useEffect(() => {
    if (!isRunning) {
      setPendingInjects([]);
      return;
    }
    void refreshPendingInjects();
    if (midTurnMode !== 'queue-editable') return;
    const iv = setInterval(() => void refreshPendingInjects(), 1500);
    return () => clearInterval(iv);
  }, [isRunning, midTurnMode, refreshPendingInjects]);

  const getActiveConversationId = useCallback(() => activeIdRef.current, []);
  const stashRejectedDraft = useCallback((convId: string, text: string) => {
    if (!convId || !text.trim()) return;
    enqueueRejectedDraft(convId, { text, attachments: [] });
  }, []);
  const markForceNormalSend = useCallback((convId: string) => {
    if (convId) forceNormalSendConvs.add(convId);
  }, []);

  const midTurnComposerState = useMemo<MidTurnComposerState>(
    () => ({
      isRunning,
      midTurnSend: midTurnMode,
      sendMidTurn,
      pendingInjects,
      cancelInject,
      getActiveConversationId,
      stashRejectedDraft,
      markForceNormalSend,
    }),
    [
      isRunning,
      midTurnMode,
      sendMidTurn,
      pendingInjects,
      cancelInject,
      getActiveConversationId,
      stashRejectedDraft,
      markForceNormalSend,
    ],
  );
  const currentWorkingDirectoryState = useMemo<CurrentWorkingDirectoryState>(
    () => ({
      currentWorkingDirectory,
      setCurrentWorkingDirectory,
    }),
    [currentWorkingDirectory, setCurrentWorkingDirectory],
  );

  // Sub-agent actions
  const sendSubAgentMessage = useCallback(async (subAgentConversationId: string, text: string): Promise<boolean> => {
    // Do NOT optimistically insert the raw follow-up. The backend runner gates
    // every follow-up through UserPromptSubmit and then broadcasts a
    // sub-agent-user-message with the (possibly redacted) text — for both
    // running (queue-sourced) and completed (resume) sub-agents. Inserting the
    // raw text here would leave it visible even when a DLP hook redacts it (the
    // renderer only dedupes identical text, so a redacted broadcast appends a
    // second message rather than replacing the raw one). The gated broadcast is
    // the single source of truth.
    //
    // Returns whether the backend ACCEPTED the message. It returns ok:false when
    // no live queue/resumable state exists for this id (e.g. after a main-process
    // restart the in-memory subAgentState is gone even though the persisted status
    // is `paused`). The caller must NOT clear its input on a false result — that
    // would silently discard the user's message.
    try {
      const res = (await app.agent.sendSubAgentMessage(subAgentConversationId, text)) as { ok?: boolean } | undefined;
      return res?.ok !== false;
    } catch (err) {
      console.error('[Runtime] Sub-agent message failed:', err);
      return false;
    }
  }, []);

  const stopSubAgentAction = useCallback(
    async (subAgentConversationId: string): Promise<boolean> => {
      try {
        const res = (await app.agent.stopSubAgent(subAgentConversationId)) as { ok?: boolean } | undefined;
        const ok = res?.ok !== false;
        if (ok) {
          const existing = globalSubAgentThreads.get(subAgentConversationId);
          if (existing) {
            globalSubAgentThreads.set(subAgentConversationId, { ...existing, status: 'stopped' });
          }
          bumpSubAgentVersion();
        }
        return ok;
      } catch (err) {
        console.error('[Runtime] Sub-agent stop failed:', err);
        return false;
      }
    },
    [bumpSubAgentVersion],
  );

  const deleteSubAgentThread = useCallback(
    async (subAgentConversationId: string) => {
      // Tombstone the id BEFORE stopping, so the `stopped` status that stopSubAgent
      // broadcasts asynchronously (and any other late event) can't recreate this
      // just-deleted thread — the event router drops tombstoned ids.
      tombstoneDeletedSubAgent(subAgentConversationId);
      // Snapshot the thread so we can RE-INSTATE it if the backend stop fails — otherwise a
      // web transport failure would hide the thread from the UI while the agent keeps
      // executing tools invisibly.
      const snapshot = globalSubAgentThreads.get(subAgentConversationId);
      const accSnapshot = globalSubAgentAccumulators.get(subAgentConversationId);
      const wasActiveView = activeSubAgentView === subAgentConversationId;
      // Optimistically remove from the UI (responsive), then confirm the backend stop.
      globalSubAgentThreads.delete(subAgentConversationId);
      globalSubAgentAccumulators.delete(subAgentConversationId);
      if (wasActiveView) setActiveSubAgentView(null);
      bumpSubAgentVersion();
      // Tell the BACKEND to stop — for a paused/capacity-deferred child this purges its
      // retained resumable state + pending-resume queue, so a queued follow-up can't execute
      // (with side effects) after the user deleted it. Only a THROWN transport error means
      // the stop didn't reach the backend (agent may still run) → re-instate. A resolved
      // {ok:false} is NORMAL for a cleanly-finished agent (no controller/state to stop) —
      // that's safe to delete, NOT a failure, so don't re-instate on it.
      try {
        await app.agent.stopSubAgent(subAgentConversationId);
      } catch (err) {
        console.error('[Runtime] Failed to stop sub-agent on delete — re-instating:', err);
        deletedSubAgentIds.delete(subAgentConversationId);
        if (snapshot) globalSubAgentThreads.set(subAgentConversationId, snapshot);
        if (accSnapshot) globalSubAgentAccumulators.set(subAgentConversationId, accSnapshot);
        bumpSubAgentVersion();
        // The tombstone above dropped any `stopped` event the backend emitted DURING the
        // awaited stop — so a re-instated snapshot that was RUNNING may be stuck running even
        // though the child actually stopped. Reconcile against the backend's authoritative
        // ACTIVE-id list, but ONLY for a snapshot that was non-terminal (running): if such a
        // child is no longer active, it stopped → remove it (delete effectively succeeded). A
        // paused/completed snapshot is a legitimate re-instate target (and wouldn't be in the
        // active list anyway), so leave it untouched.
        if (snapshot?.status === 'running') {
          void app.agent
            .listSubAgents()
            .then((list) => {
              const activeIds = (list as { ids?: string[] } | undefined)?.ids ?? [];
              if (
                !activeIds.includes(subAgentConversationId) &&
                globalSubAgentThreads.get(subAgentConversationId)?.status === 'running'
              ) {
                tombstoneDeletedSubAgent(subAgentConversationId);
                globalSubAgentThreads.delete(subAgentConversationId);
                globalSubAgentAccumulators.delete(subAgentConversationId);
                bumpSubAgentVersion();
              }
            })
            .catch(() => {
              /* backend unreachable — leave the re-instated snapshot; a later refresh reconciles */
            });
        }
      }
    },
    [bumpSubAgentVersion, activeSubAgentView],
  );

  const navigateToSubAgent = useCallback((subAgentConversationId: string) => {
    setActiveSubAgentView(subAgentConversationId);
  }, []);

  const subAgentActions = useMemo<SubAgentActions>(
    () => ({
      threads: subAgentThreads,
      sendMessage: sendSubAgentMessage,
      stop: stopSubAgentAction,
      deleteThread: deleteSubAgentThread,
      navigateTo: navigateToSubAgent,
      activeSubAgentView,
      setActiveSubAgentView,
    }),
    [
      subAgentThreads,
      sendSubAgentMessage,
      stopSubAgentAction,
      deleteSubAgentThread,
      navigateToSubAgent,
      activeSubAgentView,
    ],
  );

  const threadListAdapter = useMemo(
    () =>
      activeConversationId
        ? {
            threadId: activeConversationId,
            threads: [{ status: 'regular' as const, id: activeConversationId }],
          }
        : undefined,
    [activeConversationId],
  );

  const runtime = useExternalStoreRuntime({
    messages: activeBranch,
    setMessages: () => {},
    onNew,
    onEdit,
    onReload,
    onCancel,
    convertMessage: (m: ThreadMessageLike) => {
      if (!Array.isArray(m.content)) return m;
      const KNOWN_ASSISTANT_UI_TYPES = new Set([
        'text',
        'image',
        'tool-call',
        'tool-result',
        'audio',
        'file',
        'enrichments',
      ]);
      const stripped: string[] = [];
      const known = (m.content as ContentPart[]).filter((p) => {
        if (KNOWN_ASSISTANT_UI_TYPES.has(p.type)) return true;
        stripped.push(p.type);
        return false;
      });
      if (stripped.length > 0) {
        console.warn(
          `[RuntimeProvider] Stripped unsupported content part type(s) before rendering: ${[...new Set(stripped)].join(', ')}`,
        );
      }
      if (known.length === m.content.length) return m;
      return { ...m, content: toStoredContent(known) };
    },
    isRunning,
    adapters: {
      threadList: threadListAdapter,
      ...(speechAdapter ? { speech: speechAdapter } : {}),
      ...(recordingAdapter ? { dictation: recordingAdapter } : {}),
    },
  });
  // Expose the runtime to onNew (defined above) via a ref so a /compact-busy rejection
  // rollback can restore the composer draft text.
  runtimeRef.current = runtime as unknown as {
    thread?: { composer?: { setText?: (t: string) => void; getState?: () => { text?: string } } };
  };

  const handleContinueAfterMaxTurns = useCallback(
    async (messageId: string) => {
      const convId = activeIdRef.current;
      if (!convId || isRunning) return;

      // Compute the updated tree PURELY (mark the max-turns part 'continued'), then do the
      // persist/launch OUTSIDE a setState updater so we can await the persist and roll back
      // if /compact rejects it as busy (a side-effecting reducer couldn't).
      const prevTree = treeRef.current;
      const updated = prevTree.map((msg) => {
        if (msg.id !== messageId) return msg;
        const content = (Array.isArray(msg.content) ? [...msg.content] : []) as ContentPart[];
        const updatedContent = content.map((p) =>
          (p as { type: string }).type === 'max-turns-reached' && (p as { status: string }).status === 'pending'
            ? { ...p, status: 'continued' as const }
            : p,
        );
        return { ...msg, content: toStoredContent(updatedContent) };
      });
      const cfg = streamHandlerRef.current;
      const newHead = cfg.headId;
      const branch = getActiveBranch(updated, newHead);
      const responseMessageId = msgId();
      // Capture CWD + settings NOW (cfg is already a synchronous snapshot) so the launch +
      // any continuation use A's workspace even if the user switches during the persist await.
      const variantRunCwd = currentWorkingDirectoryRef.current;
      const variantRunConfig = {
        selectedModelKey: cfg.selectedModelKey,
        reasoningEffort: cfg.reasoningEffort,
        selectedProfileKey: cfg.selectedProfileKey,
        fallbackEnabled: cfg.fallbackEnabled,
        cwd: variantRunCwd,
        executionMode,
        threadOverrides: cfg.threadOverrides,
      };
      setTree(updated);
      setIsRunning(true);
      supersedeCurrentGeneration(convId); // stale run's late events must not bind the replacement accumulator
      streamAccumulators.set(convId, {
        messages: [...updated],
        headId: newHead,
        pendingAssistantTiming: createPendingAssistantTiming(),
        pendingAssistantId: responseMessageId,
        runConfig: variantRunConfig,
        locallyOriginated: true, // user-initiated continue-after-max-turns → this client drives it
      });
      const persistRes = await persistConversation(convId, updated, newHead, { runStatus: 'running' });
      if (persistRes?.rejected) {
        if (streamAccumulators.get(convId)?.pendingAssistantId !== responseMessageId) return;
        streamAccumulators.delete(convId);
        if (activeIdRef.current === convId) {
          setTree(prevTree);
          setIsRunning(false);
        }
        return;
      }
      // Stop / superseding turn during the awaited persist may have replaced the
      // accumulator (superseded, not rejected) — don't launch a cancelled run.
      if (streamAccumulators.get(convId)?.pendingAssistantId !== responseMessageId) return;
      launchAgentStream(
        convId,
        branch,
        cfg.selectedModelKey ?? undefined,
        cfg.reasoningEffort ?? 'medium',
        cfg.selectedProfileKey ?? undefined,
        cfg.fallbackEnabled ?? false,
        variantRunCwd ?? undefined,
        executionMode ?? 'auto',
        cfg.threadOverrides ?? undefined,
        responseMessageId,
      );
    },
    [isRunning, executionMode],
  );

  const dismissFallbackBanner = useCallback(() => {
    setFallbackBanner(null);
    if (fallbackBannerTimerRef.current) {
      clearTimeout(fallbackBannerTimerRef.current);
      fallbackBannerTimerRef.current = null;
    }
  }, []);

  const fallbackBannerActions = useMemo<FallbackBannerActions>(
    () => ({
      banner: fallbackBanner,
      dismiss: dismissFallbackBanner,
    }),
    [fallbackBanner, dismissFallbackBanner],
  );

  // Step tracking callbacks
  const handleContinueTask = useCallback(async () => {
    const convId = activeIdRef.current;
    if (!convId || isRunning) return;

    console.info(`[RuntimeProvider] Continue task for conversation ${convId}`);

    const cfg = streamHandlerRef.current;
    const currentTree = treeRef.current;
    const currentHead = headIdRef.current;

    const continueMsg: StoredMessage = {
      id: msgId(),
      parentId: currentHead,
      role: 'user',
      content: toStoredContent([{ type: 'text', text: 'Please continue the previous task' }]),
      createdAt: new Date(),
    };
    const newTree = [...currentTree, continueMsg];
    const newHead = continueMsg.id;
    const responseMessageId = msgId();

    setTree(newTree);
    setHeadId(newHead);
    setIsRunning(true);
    setShowIncompleteTaskBanner(false);
    setStepInfo(null);

    supersedeCurrentGeneration(convId); // stale run's late events must not bind the replacement accumulator
    const continueRunCwd = currentWorkingDirectoryRef.current;
    const continueRunConfig = {
      selectedModelKey: cfg.selectedModelKey,
      reasoningEffort: cfg.reasoningEffort,
      selectedProfileKey: cfg.selectedProfileKey,
      fallbackEnabled: cfg.fallbackEnabled,
      cwd: continueRunCwd,
      executionMode,
      threadOverrides: cfg.threadOverrides,
    };
    streamAccumulators.set(convId, {
      messages: [...newTree],
      headId: newHead,
      pendingAssistantTiming: createPendingAssistantTiming(),
      pendingAssistantId: responseMessageId,
      runConfig: continueRunConfig,
      locallyOriginated: true, // user-initiated continue-task → this client drives any further continuation
    });
    const branch = getActiveBranch(newTree, newHead);
    const continuePersistRes = await persistConversation(convId, newTree, newHead, { runStatus: 'running' });
    // /compact holds the conversation: roll back the optimistic continue turn + running
    // state and don't launch (the stream would be rejected as busy too).
    if (continuePersistRes?.rejected) {
      if (streamAccumulators.get(convId)?.pendingAssistantId !== responseMessageId) return;
      streamAccumulators.delete(convId);
      if (activeIdRef.current === convId) {
        setTree(currentTree);
        setHeadId(currentHead);
        setIsRunning(false);
        setShowIncompleteTaskBanner(true);
      }
      return;
    }
    // Stop / superseding turn during the awaited persist may have replaced the accumulator
    // (superseded, not rejected) — don't launch a cancelled run.
    if (streamAccumulators.get(convId)?.pendingAssistantId !== responseMessageId) return;
    launchAgentStream(
      convId,
      branch,
      cfg.selectedModelKey ?? undefined,
      cfg.reasoningEffort ?? 'medium',
      cfg.selectedProfileKey ?? undefined,
      cfg.fallbackEnabled ?? false,
      continueRunCwd ?? undefined,
      executionMode ?? 'auto',
      cfg.threadOverrides ?? undefined,
      responseMessageId,
    );

    console.info('[Analytics] step_limit_continue_clicked', { conversationId: convId });
  }, [isRunning, executionMode]);

  const handleAdjustSettings = useCallback(() => {
    console.info('[RuntimeProvider] Adjust settings clicked');
    setShowIncompleteTaskBanner(false);

    window.dispatchEvent(new CustomEvent('kai:open-settings'));
    window.dispatchEvent(
      new CustomEvent('kai:navigate-settings', {
        detail: { section: 'models', tab: 'runtimes', anchorId: 'agent.maxTurns' },
      }),
    );

    console.info('[Analytics] step_limit_adjust_settings_clicked');
  }, []);

  const handleDismissBanner = useCallback(() => {
    const convId = activeIdRef.current;
    if (convId) {
      dismissedBannersRef.current.add(convId);
    }
    setShowIncompleteTaskBanner(false);
    console.info('[RuntimeProvider] Incomplete task banner dismissed', { conversationId: convId });
  }, []);

  const stepTrackingState = useMemo<StepTrackingState>(
    () => ({
      stepInfo,
      showIncompleteTaskBanner,
      onContinueTask: handleContinueTask,
      onAdjustSettings: handleAdjustSettings,
      onDismissBanner: handleDismissBanner,
    }),
    [stepInfo, showIncompleteTaskBanner, handleContinueTask, handleAdjustSettings, handleDismissBanner],
  );

  return (
    <MaxTurnsContinueContext.Provider value={handleContinueAfterMaxTurns}>
      <FallbackBannerContext.Provider value={fallbackBannerActions}>
        <SubAgentContext.Provider value={subAgentActions}>
          <BranchNavContext.Provider value={branchNav}>
            <AssistantResponseTimingContext.Provider value={assistantResponseTiming}>
              <PromptHistoryContext.Provider value={promptHistory}>
                <MidTurnComposerContext.Provider value={midTurnComposerState}>
                  <CurrentWorkingDirectoryContext.Provider value={currentWorkingDirectoryState}>
                    <StepTrackingContext.Provider value={stepTrackingState}>
                      <RuntimeConversationIdContext.Provider value={activeConversationId}>
                        <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>
                      </RuntimeConversationIdContext.Provider>
                    </StepTrackingContext.Provider>
                  </CurrentWorkingDirectoryContext.Provider>
                </MidTurnComposerContext.Provider>
              </PromptHistoryContext.Provider>
            </AssistantResponseTimingContext.Provider>
          </BranchNavContext.Provider>
        </SubAgentContext.Provider>
      </FallbackBannerContext.Provider>
    </MaxTurnsContinueContext.Provider>
  );
}
