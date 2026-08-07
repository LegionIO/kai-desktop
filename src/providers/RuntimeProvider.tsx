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
 * Choose the parent used for a server-persisted injected user message in the
 * LIVE renderer accumulator. Main may just have persisted the partial assistant
 * under an authoritative id that this accumulator does not contain yet. Using
 * that missing id would make the injected node's parent edge dangling, so
 * getActiveBranch would return only the new node and the prior chat would appear
 * to vanish until the authoritative reload. Prefer the persisted parent only
 * when it exists locally; otherwise retain the current live head for display.
 */
export function resolveLiveInjectedParentId(
  messages: StoredMessage[],
  currentHeadId: string | null,
  persistedParentId: string | null,
  mainOwnsPersistence = true,
): string | null {
  // Renderer-owned streams persist with a debounce, so disk may lag the live
  // assistant even when the persisted parent exists locally. The live head is
  // authoritative for display in that mode.
  if (!mainOwnsPersistence) return currentHeadId;
  if (persistedParentId === null) return null;
  return messages.some((message) => message.id === persistedParentId) ? persistedParentId : currentHeadId;
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
 * `sendMidTurn` returns true if the message was cooperatively injected into the
 * running turn (the composer should then just clear its input); false means the
 * caller should fall back to the normal send (supersede / new turn).
 */
type MidTurnComposerState = {
  isRunning: boolean;
  midTurnSend: 'splice' | 'queue-editable';
  sendMidTurn: (text: string) => Promise<boolean>;
  /** Pending (not-yet-spliced) injects for the active conversation — the
   *  queue-editable chip UI. Empty in 'splice' mode (chips are only shown when
   *  the setting opts in). */
  pendingInjects: Array<{ id: string; text: string }>;
  /** Cancel a queued inject by id. Returns its text (for the "edit" affordance,
   *  which cancels then pre-fills the composer), or null if already gone. */
  cancelInject: (id: string) => Promise<string | null>;
};

const MidTurnComposerContext = createCtx<MidTurnComposerState>({
  isRunning: false,
  midTurnSend: 'splice',
  sendMidTurn: async () => false,
  pendingInjects: [],
  cancelInject: async () => null,
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
/** Automation conversations we've begun async-seeding a background accumulator for
 *  (dedupes the disk fetch while events stream in before the seed resolves). */
const automationSeedInProgress = new Set<string>();
/** Conversations where the next assistant message should be forced-new (after realtime call reconnect) */
const forceNewAssistant = new Set<string>();
/** Per-conversation persist version counter — incremented before each persist, checked before writing.
 *  Prevents stale async persists from overwriting newer data. */
const persistVersions = new Map<string, number>();

// Per-conversation handoff for a paid compaction record that a persist is TRYING to write
// but hasn't confirmed on disk yet. A terminal (done/error) persist carrying a compaction
// is fire-and-forget; if a new turn's persist supersedes it (version bump) before it lands,
// the record would be lost AND the new accumulator can't inherit it (the old one was
// deleted). Recording it here — cleared only when a persist returns persisted:true for the
// same compactionId — lets onNew / continuations recover it and durably re-persist.
const pendingCompactionHandoff = new Map<string, ConversationCompaction>();

// Per-conversation QUEUE of inputs that a compact-busy rollback could NOT return to the
// composer at the time — the user had switched to another chat or started a newer draft, so
// restoring then would target the wrong conversation or clobber a live draft. A FIFO queue
// (not a single slot) so that if A is stashed and B is later rejected before A is restored,
// BOTH survive (a single slot would either overwrite A or discard B). Restored one-at-a-time
// (oldest first) by loadConversationState + the composer-empty poll (into an empty composer
// only). Cleared per-entry on restore, or wholesale when the conversation is deleted. Bounded.
type RejectedDraft = { text: string; attachments: AttachedFile[] };
const rejectedDrafts = new Map<string, RejectedDraft[]>();
const MAX_REJECTED_DRAFTS_PER_CONV = 20;
function enqueueRejectedDraft(convId: string, draft: RejectedDraft): void {
  if (draft.text.trim().length === 0 && draft.attachments.length === 0) return;
  const q = rejectedDrafts.get(convId) ?? [];
  q.push(draft);
  if (q.length > MAX_REJECTED_DRAFTS_PER_CONV) q.shift(); // bound — drop the oldest
  rejectedDrafts.set(convId, q);
}
/** Dequeue the OLDEST rejected draft for a conversation, or undefined if none. */
function dequeueRejectedDraft(convId: string): RejectedDraft | undefined {
  const q = rejectedDrafts.get(convId);
  if (!q || q.length === 0) return undefined;
  const next = q.shift();
  if (q.length === 0) rejectedDrafts.delete(convId);
  return next;
}

function createPendingAssistantTiming(startedAt = nowIso()): PendingAssistantTiming {
  return { startedAt };
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

export function getOrCreateAssistantInAcc(acc: MessageAccumulator): { msg: StoredMessage; idx: number } {
  const desiredId = acc.pendingAssistantId ?? undefined;
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
    tcIdx = content.findIndex(
      (p) => p.type === 'tool-call' && p.liveOutput?.subAgentConversationId === subAgentConvId,
    );
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
  const effectiveCompaction =
    carriedCompaction?.compactionId ? carriedCompaction : startsTurn ? pendingCompactionHandoff.get(conversationId) : undefined;
  // Register in the handoff map BEFORE the first await — else a terminal persist that gets
  // superseded during its `conversations.get()` would early-return BEFORE registering, and
  // a racing resubmit would find no handoff. Cleared below only on a confirmed persisted:true.
  if (effectiveCompaction?.compactionId) pendingCompactionHandoff.set(conversationId, effectiveCompaction);
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
      return { superseded: true };
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
      if (held?.compactionId === effectiveCompaction.compactionId) pendingCompactionHandoff.delete(conversationId);
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

  const loadConversationState = useCallback(async (id: string) => {
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
    if (rejectedDrafts.has(id)) {
      setTimeout(() => {
        if (activeIdRef.current !== id) return; // user switched again — keep the stash
        if ((rejectedDrafts.get(id)?.length ?? 0) === 0) return;
        const composerText = runtimeRef.current?.thread?.composer?.getState?.().text ?? '';
        if (composerText.trim().length > 0 || attachmentsRef.current.length > 0) return; // don't clobber
        const rejected = dequeueRejectedDraft(id); // OLDEST first; the poll restores the rest
        if (!rejected) return;
        if (rejected.attachments.length > 0) addAttachments(rejected.attachments);
        restoreComposerDraft(rejected.text);
      }, 0);
    }

    // Don't show the running indicator for conversations awaiting user approval —
    // the accumulator is still alive (so hasActiveStream is true) but the model
    // has stopped generating; only user interaction can resume it.
    const accAwait = hasActiveStream && streamAccumulators.get(id)?.awaitingApproval;
    if (hasActiveStream) {
      setIsRunning(!accAwait);
    } else if (conv.runStatus === 'running') {
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
        app.agent.inFlight(id).catch(() => false),
      ]);
      // A switch may have happened during the in-flight probe — don't seed an
      // accumulator or flip isRunning for a conversation that's no longer active.
      if (!isCurrent()) return true;
      if (autoInFlight || agentInFlight) {
        automationStreams.add(id);
        streamAccumulators.set(id, { messages: [...t], headId: h });
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
      const rejected = dequeueRejectedDraft(id); // one per tick, oldest first (drains over ticks)
      if (!rejected) return;
      if (rejected.attachments.length > 0) addAttachments(rejected.attachments);
      restoreComposerDraft(rejected.text);
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
          rejectedDrafts.delete(deletedId);
        }
        return;
      }
      const activeId = activeIdRef.current;
      if (!activeId || streamAccumulators.has(activeId)) return;
      // Only an upsert of the ACTIVE conversation can require a reload (an
      // external append, e.g. an automation targeting this thread). Our own
      // persists never grow the tree past treeRef.current, so a longer incoming
      // tree reliably signals an external write.
      if (change.kind !== 'upsert' || change.conversation.id !== activeId) return;
      const conv = change.conversation as { messageTree?: unknown[]; messages?: unknown[] };
      const incomingLen = (conv.messageTree ?? conv.messages ?? []).length;
      if (incomingLen > treeRef.current.length) {
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
        if (
          res &&
          typeof res === 'object' &&
          (res as { busy?: unknown }).busy === true &&
          (res as { delivered?: unknown }).delivered !== true
        ) {
          const h = streamEventHandlerRef.current;
          if (h) {
            // ONE terminal event only. The error handler is fully terminal; a trailing
            // `done` would recreate the accumulator from the pre-error tree and supersede
            // the error persist (user message left with no visible error).
            h({
              conversationId,
              type: 'error',
              error: 'Compacting the conversation — wait for it to finish, then retry.',
              ...(typeof responseMessageId === 'string' ? { responseMessageId } : {}),
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
          // `paused` is NOT terminal (resumable → may stream again), so keep its accumulator.
          const terminalRelease = ['completed', 'failed', 'stopped', 'error'];
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
        const doneStatus =
          existing && terminalStatuses.includes(existing.status) ? existing.status : 'completed';
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
      if (e.automation || e.serverPersisted) automationStreams.add(convId);

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
        const cd = e.data as
          | { compactionId?: string; summaryText?: string; compactedMessageIds?: string[]; coveredContentSig?: Record<string, string>; compactionRevision?: number }
          | undefined;
        if (
          cd &&
          typeof cd.compactionId === 'string' &&
          typeof cd.summaryText === 'string' &&
          Array.isArray(cd.compactedMessageIds) &&
          cd.compactedMessageIds.every((id) => typeof id === 'string' && id.length > 0)
        ) {
          pendingCompactionHandoff.set(convId, {
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
          if (e.type !== 'compaction') acc.runGeneration = evGen; // lock to the first REAL-run event
        } else if (acc.runGeneration !== evGen && e.type !== 'compaction') {
          return; // superseded run's late event — drop
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
          const isDuplicate = isDuplicateLastUserMessage(branch, msgText);
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
        // Retry events are informational — show as observer message
        const retryData = e.data as
          | { attempt?: number; maxRetries?: number; delayMs?: number; reason?: string; category?: string }
          | undefined;
        if (retryData) {
          const delaySec = Math.round((retryData.delayMs ?? 0) / 1000);
          const retryText = `Retrying (${retryData.attempt}/${retryData.maxRetries}) in ${delaySec}s — ${retryData.category ?? 'transient error'}`;
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
        const autoContinue = agentCfg?.autoContinueOnMaxTurns === true && !mainOwned;

        if (autoContinue) {
          // Auto-continue: finalize current response and immediately restart the stream
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
            { runStatus: 'running', ...(acc.pendingCompaction ? { conversationCompaction: acc.pendingCompaction } : {}) },
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
          });
          if (isActiveConv) {
            setTree([...acc.messages]);
            setHeadId(acc.headId);
          }
          // Use the RUN's OWN captured settings (acc.runConfig), NOT the live active-chat
          // refs — a background max_turns continuation whose conversation the user switched
          // away from must restart with A's model/profile/cwd/overrides, not B's (else a
          // relative-path tool could modify the wrong project). Fall back to the live refs
          // only for a run that predates runConfig capture (e.g. an automation-seeded acc).
          const rc = acc.runConfig;
          const live = streamHandlerRef.current;
          const cfg = {
            selectedModelKey: rc?.selectedModelKey ?? live.selectedModelKey,
            reasoningEffort: rc?.reasoningEffort ?? live.reasoningEffort,
            selectedProfileKey: rc?.selectedProfileKey ?? live.selectedProfileKey,
            fallbackEnabled: rc?.fallbackEnabled ?? live.fallbackEnabled,
            executionMode: rc?.executionMode ?? live.executionMode,
            threadOverrides: rc?.threadOverrides ?? live.threadOverrides,
          };
          const runCwd = rc?.cwd ?? currentWorkingDirectoryRef.current;
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
              cfg.threadOverrides ?? undefined,
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
              launchAfterCompactionPersist(remaining - 1, repersistContinuation());
            }, 1000);
          };
          const launchAfterCompactionPersist = (
            remaining: number,
            p: Promise<{ rejected?: string; superseded?: boolean; persisted?: boolean }>,
          ): void => {
            void p.then((r) => {
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
            }, () => {
              // persist threw — treat as unknown: retry if still owning + budget, else abandon.
              if (!stillOwns()) return;
              if (remaining > 0) scheduleRetry(remaining);
              else {
                abandonContinuation();
              }
            });
          };
          // Always gate the launch on the START persist's outcome — even with NO compaction
          // record. A concurrent /compact rejects the running-status persist as busy; the
          // continuation is MANDATORY (the run hit max_turns), so launching regardless would
          // hit a busy backend and terminate the work. launchAfterCompactionPersist handles
          // all outcomes (persisted → launch; rejected/unknown/superseded → retry-or-abandon)
          // and is compaction-agnostic.
          launchAfterCompactionPersist(300, continuationPersist);
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
        // sends its own `done`. Don't persist from here; just reconcile from disk.
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
        if (e.automation || e.serverPersisted || automationStreams.has(convId)) {
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
            void loadConversationState(convId);
          }
          return;
        }
        // Plan-mode transitions (accept, reject, dismiss) send a done event while
        // a tool is still awaiting approval.  Clear the flag so the normal done
        // path can clean up or restart the stream correctly.
        const doneData = e.data as Record<string, unknown> | undefined;
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
          if (planModeRestart || planModeRejectRestart) {
            const label = planModeRestart ? 'plan-restart' : 'plan-reject-restart';
            console.info(`[UI:stream] ${label} — auto-continuing with plan-first mode`);
            // Snapshot THIS run's settings for the delayed launch. Prefer the run's OWN
            // captured runConfig (correct even for a background conv the user has switched
            // away from); fall back to the live refs for a run predating runConfig capture.
            const planLive = streamHandlerRef.current;
            const planCfgSnapshot = {
              selectedModelKey: acc.runConfig?.selectedModelKey ?? planLive.selectedModelKey,
              reasoningEffort: acc.runConfig?.reasoningEffort ?? planLive.reasoningEffort,
              selectedProfileKey: acc.runConfig?.selectedProfileKey ?? planLive.selectedProfileKey,
              fallbackEnabled: acc.runConfig?.fallbackEnabled ?? planLive.fallbackEnabled,
              threadOverrides: acc.runConfig?.threadOverrides ?? planLive.threadOverrides,
            };
            const planCwdSnapshot = acc.runConfig?.cwd ?? currentWorkingDirectoryRef.current;
            const planRunConfig = acc.runConfig;
            // Small delay to let the executionMode state update propagate from the
            // onExecutionModeChanged listener in App.tsx.
            setTimeout(() => {
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
                });
                if (activeIdRef.current === convId) setIsRunning(true);
                const planContinuationPersist = persistConversation(
                  convId,
                  treeForStream,
                  headForStream,
                  { runStatus: 'running', ...(acc.pendingCompaction ? { conversationCompaction: acc.pendingCompaction } : {}) },
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
                    cfg.threadOverrides ?? undefined,
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
                      // disk, so re-persist before launching (else the reuse gate misses it).
                      if ((res?.superseded || (!res?.persisted && !res?.rejected)) && acc.pendingCompaction) {
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
      if (e.automation || e.serverPersisted || automationStreams.has(convId)) {
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
      if (isRunningRef.current) {
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
            // Not cooperatively injectable (CLI runtime / race) — fall through to a
            // normal new turn, which supersedes the running one.
          }
        }
      }

      const userMsg: StoredMessage = {
        id: msgId(),
        parentId: headId,
        role: 'user',
        content: toStoredContent(userContent),
        createdAt: new Date(),
      };
      const newTree = [...tree, userMsg];
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
      setTree(newTree);
      setHeadId(newHead);
      setIsRunning(true);

      supersedeCurrentGeneration(convId); // stale run's late events must not bind the replacement accumulator
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
        runConfig: { selectedModelKey, reasoningEffort, selectedProfileKey, fallbackEnabled, cwd, executionMode, threadOverrides },
      });
      const branch = getActiveBranch(newTree, newHead);

      const persistRes = await persistConversation(
        convId,
        newTree,
        newHead,
        { runStatus: 'running', ...(supersededCompaction ? { conversationCompaction: supersededCompaction } : {}) },
        supersededSeed,
      );
      // Main rejected the optimistic turn because a /compact holds the conversation. Roll
      // back the optimistic user message + running state and DON'T launch the stream (it
      // would be rejected too). The user can resend once compaction finishes.
      if (persistRes?.rejected) {
        // Only tear down if we STILL OWN the accumulator. A /compact-concurrent send can
        // await this persist while a Stop or a superseding turn (run C) replaces the
        // accumulator with a new pendingAssistantId; our stale rejection must not delete
        // C's accumulator (which would strand C's run) nor restore our stale tree/draft.
        if (streamAccumulators.get(convId)?.pendingAssistantId !== responseMessageId) return;
        streamAccumulators.delete(convId);
        // Restore the submitted input so it isn't lost. If THIS conversation is active AND
        // the composer is empty, put it straight back. Otherwise (the user switched to
        // another chat, or started a newer draft here) we can't restore now without
        // targeting the wrong conversation / clobbering a live draft — STASH it so
        // loadConversationState restores it when the user returns to this chat.
        const composerHasNewDraft =
          activeIdRef.current === convId && (runtimeRef.current?.thread?.composer?.getState?.().text ?? '').trim().length > 0;
        const canRestoreNow = activeIdRef.current === convId && attachmentsRef.current.length === 0 && !composerHasNewDraft;
        if (canRestoreNow) {
          setTree(tree);
          setHeadId(headId);
          setIsRunning(false);
          if (pendingAttachments.length > 0) addAttachments(pendingAttachments);
          restoreComposerDraft(submittedText);
        } else {
          // Roll back the tree/running state for the active chat if it's this one, but keep
          // the input for later restoration rather than dropping it.
          if (activeIdRef.current === convId) {
            setTree(tree);
            setHeadId(headId);
            setIsRunning(false);
          }
          // Enqueue for later restoration (FIFO) rather than dropping it. The queue keeps a
          // second rejection from overwriting/discarding the first (both survive + restore).
          enqueueRejectedDraft(convId, { text: submittedText, attachments: pendingAttachments });
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
          void persistConversation(convId, newTree, newHead, {
            runStatus: 'running',
            conversationCompaction: nowPending,
          }).then(
            (r) => {
              if (!ownsNew()) return;
              // Launch ONLY once the compaction record is confirmed on disk. A
              // conversation-busy (brief /compact lock), superseded, or unknown/write-fail
              // outcome means it did NOT land — retry (bounded) rather than launch against
              // the raw branch (which would re-summarize/rebill). Abandon after the budget.
              if (r?.persisted) launchNew();
              else if (remaining > 0) setTimeout(() => durablyPersistThenLaunch(remaining - 1), 500);
              else launchNew(); // budget exhausted — launch anyway (reactive recovery backstops)
            },
            () => {
              if (!ownsNew()) return;
              if (remaining > 0) setTimeout(() => durablyPersistThenLaunch(remaining - 1), 500);
              else launchNew();
            },
          );
        };
        durablyPersistThenLaunch(20);
      } else if (ownsNew()) {
        // No late compaction to durably persist. Still verify WE own the accumulator — a
        // Stop (or a superseding turn) during the awaited turn-start persist may have
        // deleted/replaced it; launching then would start a cancelled/superseded run.
        launchNew();
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
      streamAccumulators.set(convId, {
        messages: newTree,
        headId: actualParent,
        pendingAssistantTiming: createPendingAssistantTiming(),
        pendingAssistantId: responseMessageId,
        runConfig: reloadRunConfig,
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
      });
      const branch = getActiveBranch(newTree, newHead);

      const editPersistRes = await persistConversation(convId, newTree, newHead, { runStatus: 'running' });
      // /compact holds the conversation: roll back the optimistic edit, restore the
      // composer draft, and don't launch (the stream would be rejected too).
      if (editPersistRes?.rejected) {
        if (streamAccumulators.get(convId)?.pendingAssistantId !== responseMessageId) return;
        streamAccumulators.delete(convId);
        if (activeIdRef.current === convId) {
          setTree(preEditTree);
          setHeadId(preEditHead);
          setIsRunning(false);
          restoreComposerDraft(editedText);
        } else if (editedText.trim().length > 0) {
          // The user switched away before the /compact rejection returned — can't restore the
          // edited text into the (now other) composer now, so ENQUEUE it for when they return
          // (parity with the onNew rollback; loadConversationState / the composer-empty effect
          // restore it FIFO). The queue keeps a second rejection from discarding this one.
          enqueueRejectedDraft(convId, { text: editedText, attachments: [] });
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
      setHeadId(newHead);
      // Persist
      const convId = activeIdRef.current;
      if (convId) persistConversation(convId, tree, newHead);
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
    async (text: string): Promise<boolean> => {
      const convId = activeIdRef.current;
      const trimmed = text.trim();
      if (!convId || !trimmed || !isRunningRef.current) return false;
      try {
        const res = await app.agent.injectMidTurn(convId, trimmed);
        if (res.ok && res.cooperative) {
          void refreshPendingInjects();
          return true;
        }
        return false;
      } catch {
        return false;
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

  const midTurnComposerState = useMemo<MidTurnComposerState>(
    () => ({ isRunning, midTurnSend: midTurnMode, sendMidTurn, pendingInjects, cancelInject }),
    [isRunning, midTurnMode, sendMidTurn, pendingInjects, cancelInject],
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
      const res = (await app.agent.sendSubAgentMessage(subAgentConversationId, text)) as
        | { ok?: boolean }
        | undefined;
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
