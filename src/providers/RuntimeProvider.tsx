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
};

export type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh';

export type SubAgentThreadState = {
  conversationId: string;
  parentConversationId: string;
  parentToolCallId: string;
  task: string;
  status: 'running' | 'awaiting-input' | 'completed' | 'stopped' | 'error';
  messages: StoredMessage[];
  headId: string | null;
  depth: number;
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
  /** Deferred tool approvals keyed by toolName — handles race where
   *  tool-approval-required arrives before the stream-side tool-call event. */
  deferredApprovals?: Map<string, { toolCallId: string; args?: unknown }>;
  /** True while a tool is awaiting user approval — suppresses the running indicator */
  awaitingApproval?: boolean;
  /** Compaction record captured from the `compaction` stream event this turn.
   *  The event precedes the assistant reply, so we stash it here and fold it into
   *  the terminal (done/error/awaiting) persist rather than writing mid-turn. */
  pendingCompaction?: ConversationCompaction;
};

type ConversationCompaction = {
  compactionId: string;
  summaryText: string;
  compactedMessageIds: string[];
  boundaryHeadId: string | null;
  createdAt: string;
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
  sendMessage: (subAgentConversationId: string, text: string) => Promise<void>;
  stop: (subAgentConversationId: string) => Promise<void>;
  deleteThread: (subAgentConversationId: string) => void;
  navigateTo: (subAgentConversationId: string) => void;
  activeSubAgentView: string | null;
  setActiveSubAgentView: (id: string | null) => void;
};

const SubAgentContext = createCtx<SubAgentActions>({
  threads: new Map(),
  sendMessage: async () => {},
  stop: async () => {},
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
let globalSubAgentVersion = 0; // bumped on every change to trigger re-renders

// --- Stream accumulator functions ---

const streamAccumulators = new Map<string, MessageAccumulator>();
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
  // Create new assistant message
  const baseMsg: StoredMessage = {
    id: desiredId ?? msgId(),
    parentId: acc.headId,
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
    };
  },
): void {
  const { msg, idx } = getOrCreateAssistantInAcc(acc);
  const content = (Array.isArray(msg.content) ? [...msg.content] : []) as ContentPart[];
  let tcIdx = -1;
  let matchMode: 'exact' | 'fallback' | 'orphan' = 'orphan';
  if (e.toolCallId) {
    tcIdx = content.findIndex((p) => p.type === 'tool-call' && p.toolCallId === e.toolCallId);
    if (tcIdx >= 0) matchMode = 'exact';
  }
  if (tcIdx < 0) {
    // Some runtimes emit progress before call metadata or without call id.
    // In that case attach to the most recent unresolved tool call.
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
    data?: { stream?: 'stdout' | 'stderr'; output?: string; truncated?: boolean; stopped?: boolean };
  },
): NonNullable<(ContentPart & { type: 'tool-call' })['liveOutput']> {
  const liveOutput = {
    stdout: existing.liveOutput?.stdout ?? '',
    stderr: existing.liveOutput?.stderr ?? '',
    truncated: existing.liveOutput?.truncated ?? false,
    stopped: existing.liveOutput?.stopped ?? false,
    subAgentConversationId:
      existing.liveOutput?.subAgentConversationId ??
      (e.data as { subAgentConversationId?: string } | undefined)?.subAgentConversationId,
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
): Promise<void> {
  // Bump version BEFORE the async boundary to claim this persist operation.
  // This prevents stale debounced persists from overwriting newer data
  // (e.g. done handler's runStatus:'idle' overwritten by a late schedulePersist's 'running').
  const currentVersion = (persistVersions.get(conversationId) ?? 0) + 1;
  persistVersions.set(conversationId, currentVersion);

  try {
    const conv = (await app.conversations.get(conversationId)) as ConversationRecord | null;
    if (!conv) return;

    // After the async get(), check if a newer persist started while we were waiting
    const latestVersion = persistVersions.get(conversationId) ?? 0;
    if (currentVersion < latestVersion) return;

    const branch = getActiveBranch(tree, headId);
    const now = nowIso();

    await app.conversations.put({
      ...conv,
      messages: branch, // linear view for backward compat
      messageTree: tree,
      headId,
      fallbackTitle: conv.fallbackTitle ?? null,
      updatedAt: now,
      lastMessageAt: now,
      messageCount: branch.length,
      userMessageCount: branch.filter((m) => m.role === 'user').length,
      ...updates,
    });
  } catch (err) {
    console.error('[Runtime] Failed to persist:', err);
  }
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
  const { consumeAttachments } = useAttachments();

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

    setActiveConversationId(id);
    setTree(displayTree);
    setHeadId(displayHead);
    setStepInfo(null);
    setShowIncompleteTaskBanner(false);
    currentWorkingDirectoryRef.current = conv.currentWorkingDirectory ?? null;
    setCurrentWorkingDirectoryState(conv.currentWorkingDirectory ?? null);

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

  // Reload the active conversation when the main process appends to it (e.g. an
  // automation targeting this thread). Our own persists never grow the tree past
  // treeRef.current, so a longer incoming tree reliably signals an external append.
  useEffect(() => {
    return app.conversations.onChanged((change) => {
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
          persistConversation(conversationId, t, h, extra);
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

    await persistConversation(convId, treeRef.current, headIdRef.current, {
      currentWorkingDirectory: trimmed,
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
    const unsubscribe = app.agent.onStreamEvent((event: unknown) => {
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
      const hasAccumulator = streamAccumulators.has(e.conversationId);
      console.warn(
        `[StreamEvent] conv=${e.conversationId.slice(0, 8)} ${debugSummary} isActive=${isActive} hasAccumulator=${hasAccumulator}`,
      );

      // Route sub-agent events to global sub-agent state
      if (e.subAgentConversationId) {
        const saId = e.subAgentConversationId;

        if (e.type === 'sub-agent-status') {
          const existing = globalSubAgentThreads.get(saId);
          const rawSummary = e.summary ?? '';
          const cleanTask = rawSummary.startsWith('Starting task: ')
            ? rawSummary.slice('Starting task: '.length)
            : rawSummary;
          if (existing) {
            globalSubAgentThreads.set(saId, {
              ...existing,
              status: (e.status as SubAgentThreadState['status']) ?? existing.status,
              task: existing.task || cleanTask,
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
            });
          }
          bumpSubAgentVersion();
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
        globalSubAgentThreads.set(saId, {
          conversationId: saId,
          parentConversationId: e.parentConversationId ?? existing?.parentConversationId ?? '',
          parentToolCallId: e.parentToolCallId ?? existing?.parentToolCallId ?? '',
          task: existing?.task ?? '',
          status: isDone ? 'completed' : (existing?.status ?? 'running'),
          messages: msgs,
          headId: head,
          depth: existing?.depth ?? 0,
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
          const seededAcc: MessageAccumulator = { messages: [], headId: null };
          streamAccumulators.set(convId, seededAcc);
          if (!automationSeedInProgress.has(convId)) {
            automationSeedInProgress.add(convId);
            void app.conversations
              .get(convId)
              .then((conv) => {
                const rec = conv as ConversationRecord | null;
                // Bail unless the SAME accumulator we seeded is still current and
                // this conversation is still an automation stream. Otherwise the
                // original run ended (accumulator deleted) and a new interactive/
                // retry run may own convId now — mutating it or reparenting to a
                // stale head would corrupt that unrelated run.
                if (streamAccumulators.get(convId) !== seededAcc) return;
                if (!automationStreams.has(convId)) return;
                if (!rec) return;
                const { tree, headId } = ensureTree(rec);
                if (tree.length === 0) return;
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
      if (e.responseMessageId) acc.pendingAssistantId = e.responseMessageId;

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
          persistConversation(convId, acc.messages, acc.headId, {
            lastAssistantUpdateAt: new Date().toISOString(),
          });
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
          | { compactionId?: string; summaryText?: string; compactedMessageIds?: string[] }
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
        const autoContinue = agentCfg?.autoContinueOnMaxTurns === true;

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
          persistConversation(convId, acc.messages, acc.headId, { runStatus: 'running' });
          streamAccumulators.set(convId, {
            messages: [...acc.messages],
            headId: acc.headId,
            pendingAssistantTiming: createPendingAssistantTiming(),
            pendingAssistantId: responseMessageId,
          });
          if (isActiveConv) {
            setTree([...acc.messages]);
            setHeadId(acc.headId);
          }
          const cfg = streamHandlerRef.current;
          app.agent.stream(
            convId,
            branch,
            cfg.selectedModelKey ?? undefined,
            cfg.reasoningEffort ?? 'medium',
            cfg.selectedProfileKey ?? undefined,
            cfg.fallbackEnabled ?? false,
            currentWorkingDirectoryRef.current ?? undefined,
            cfg.executionMode ?? 'auto',
            cfg.threadOverrides ?? undefined,
            responseMessageId,
          );
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
        persistConversation(convId, acc.messages, acc.headId, {
          runStatus: 'idle',
          lastAssistantUpdateAt: nowIso(),
          hasUnread: !isActiveConv,
          ...(acc.pendingCompaction ? { conversationCompaction: acc.pendingCompaction } : {}),
        });
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
        persistConversation(convId, acc.messages, acc.headId, {
          runStatus: 'idle',
          lastAssistantUpdateAt: nowIso(),
          hasUnread: !isActiveConv,
          ...(acc.pendingCompaction ? { conversationCompaction: acc.pendingCompaction } : {}),
        });
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
          persistConversation(convId, acc.messages, acc.headId, {
            runStatus: 'awaiting-approval',
            hasUnread: true,
            ...(acc.pendingCompaction ? { conversationCompaction: acc.pendingCompaction } : {}),
          });
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
        persistConversation(convId, acc.messages, acc.headId, {
          runStatus: 'idle',
          lastAssistantUpdateAt: nowIso(),
          hasUnread: !isActiveConv,
          ...(acc.pendingCompaction ? { conversationCompaction: acc.pendingCompaction } : {}),
        });
        if (isActiveConv) {
          setTree([...acc.messages]);
          setHeadId(acc.headId);
          // Update the model selector to reflect the actual model used (may differ
          // from requested if a fallback occurred during the pipeline run).
          const resolvedModel = (e.data as Record<string, unknown> | undefined)?.model as string | undefined;
          if (resolvedModel) {
            onModelFallbackRef.current?.(resolvedModel);
          }

          // Auto-continue after plan mode entry: the stream was aborted so we can
          // restart with the correct executionMode, system prompt, and tool set.
          const planModeRestart = (e.data as Record<string, unknown> | undefined)?.planModeRestart;
          // Auto-continue after plan rejection: the user clicked "No, keep planning"
          // so we restart in plan-first mode with a synthetic user message telling the
          // agent to continue refining the plan.
          const planModeRejectRestart = (e.data as Record<string, unknown> | undefined)?.planModeRejectRestart;
          if (planModeRestart || planModeRejectRestart) {
            const label = planModeRestart ? 'plan-restart' : 'plan-reject-restart';
            console.info(`[UI:stream] ${label} — auto-continuing with plan-first mode`);
            // Small delay to let the executionMode state update propagate from the
            // onExecutionModeChanged listener in App.tsx.
            setTimeout(() => {
              const headForStream = acc.headId;
              if (headForStream) {
                const treeForStream = [...acc.messages];

                const branch = getActiveBranch(treeForStream, headForStream);
                const responseMessageId = msgId();
                streamAccumulators.set(convId, {
                  messages: [...treeForStream],
                  headId: headForStream,
                  pendingAssistantTiming: createPendingAssistantTiming(),
                  pendingAssistantId: responseMessageId,
                });
                setIsRunning(true);
                persistConversation(convId, treeForStream, headForStream, { runStatus: 'running' });
                const cfg = streamHandlerRef.current;
                console.info(`[UI:stream:${label}] Firing agent:stream conv=${convId} executionMode=plan-first`);
                app.agent.stream(
                  convId,
                  branch,
                  cfg.selectedModelKey ?? undefined,
                  cfg.reasoningEffort ?? 'medium',
                  cfg.selectedProfileKey ?? undefined,
                  cfg.fallbackEnabled ?? false,
                  currentWorkingDirectoryRef.current ?? undefined,
                  'plan-first',
                  cfg.threadOverrides ?? undefined,
                  responseMessageId,
                );
              }
            }, 100);
          } else {
            console.warn(`[StreamEvent] DONE setting isRunning=false for conv=${convId.slice(0, 8)}`);
            setIsRunning(false);
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
        persistConversation(convId, acc.messages, acc.headId, persistExtra);
      } else {
        // Resume running indicator only if not awaiting approval — stale
        // text-delta events may arrive after tool-approval-required.
        if (isActiveConv && !acc.awaitingApproval) {
          setIsRunning(true);
        }
        streamHandlerRef.current.schedulePersist(convId, acc.messages, acc.headId, persistExtra);
      }
    });
    return unsubscribe;
  }, [bumpSubAgentVersion]);

  const onNew = useCallback(
    async (message: AppendMessage) => {
      const convId = activeIdRef.current;
      if (!convId) return;

      const pendingAttachments = consumeAttachments();
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
      setTree(newTree);
      setHeadId(newHead);
      setIsRunning(true);

      streamAccumulators.set(convId, {
        messages: [...newTree],
        headId: newHead,
        pendingAssistantTiming,
        pendingAssistantId: responseMessageId,
      });
      const branch = getActiveBranch(newTree, newHead);

      await persistConversation(convId, newTree, newHead, { runStatus: 'running' });
      void maybeGenerateTitle(convId, branch);
      console.info(
        `[UI:stream] Firing agent:stream conv=${convId} model=${selectedModelKey ?? 'default'} reasoning=${reasoningEffort ?? 'medium'} messageCount=${branch.length} roles=${branch.map((m) => m.role).join(',')} cwd=${cwd ?? '(none)'} executionMode=${executionMode ?? 'auto'}`,
      );
      console.info(
        '[UI:stream] Last message preview:',
        branch.length > 0 ? JSON.stringify(branch[branch.length - 1]).slice(0, 500) : '(empty)',
      );
      app.agent.stream(
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
      streamAccumulators.set(convId, {
        messages: newTree,
        headId: actualParent,
        pendingAssistantTiming: createPendingAssistantTiming(),
        pendingAssistantId: responseMessageId,
      });
      const branch = getActiveBranch(newTree, actualParent);
      persistConversation(convId, newTree, actualParent, { runStatus: 'running' });
      console.info(
        `[UI:stream:reload] Firing agent:stream conv=${convId} model=${selectedModelKey ?? 'default'} reasoning=${reasoningEffort ?? 'medium'} messageCount=${branch.length} roles=${branch.map((m) => m.role).join(',')}`,
      );
      app.agent.stream(
        convId,
        branch,
        selectedModelKey ?? undefined,
        reasoningEffort ?? 'medium',
        selectedProfileKey ?? undefined,
        fallbackEnabled ?? false,
        currentWorkingDirectoryRef.current ?? undefined,
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

      lastRetitleCount.delete(convId);
      setTree(newTree);
      setHeadId(newHead);
      setIsRunning(true);

      streamAccumulators.set(convId, {
        messages: [...newTree],
        headId: newHead,
        pendingAssistantTiming,
        pendingAssistantId: responseMessageId,
      });
      const branch = getActiveBranch(newTree, newHead);

      await persistConversation(convId, newTree, newHead, { runStatus: 'running' });
      void maybeGenerateTitle(convId, branch);
      console.info(
        `[UI:stream:edit] Firing agent:stream conv=${convId} model=${selectedModelKey ?? 'default'} reasoning=${reasoningEffort ?? 'medium'} messageCount=${branch.length} sourceId=${message.sourceId ?? '(none)'}`,
      );
      app.agent.stream(
        convId,
        branch,
        selectedModelKey ?? undefined,
        reasoningEffort ?? 'medium',
        selectedProfileKey ?? undefined,
        fallbackEnabled ?? false,
        currentWorkingDirectoryRef.current ?? undefined,
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
      persistConversation(convId, newTree, newHead, { runStatus: 'idle' });
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
    persistConversation(convId, latestTree, latestHead, { runStatus: 'idle' });
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
  const sendSubAgentMessage = useCallback(async (subAgentConversationId: string, text: string) => {
    // Do NOT optimistically insert the raw follow-up. The backend runner gates
    // every follow-up through UserPromptSubmit and then broadcasts a
    // sub-agent-user-message with the (possibly redacted) text — for both
    // running (queue-sourced) and completed (resume) sub-agents. Inserting the
    // raw text here would leave it visible even when a DLP hook redacts it (the
    // renderer only dedupes identical text, so a redacted broadcast appends a
    // second message rather than replacing the raw one). The gated broadcast is
    // the single source of truth.
    try {
      await app.agent.sendSubAgentMessage(subAgentConversationId, text);
    } catch (err) {
      console.error('[Runtime] Sub-agent message failed:', err);
    }
  }, []);

  const stopSubAgentAction = useCallback(
    async (subAgentConversationId: string) => {
      try {
        await app.agent.stopSubAgent(subAgentConversationId);
        const existing = globalSubAgentThreads.get(subAgentConversationId);
        if (existing) {
          globalSubAgentThreads.set(subAgentConversationId, { ...existing, status: 'stopped' });
        }
        bumpSubAgentVersion();
      } catch (err) {
        console.error('[Runtime] Sub-agent stop failed:', err);
      }
    },
    [bumpSubAgentVersion],
  );

  const deleteSubAgentThread = useCallback(
    (subAgentConversationId: string) => {
      globalSubAgentThreads.delete(subAgentConversationId);
      globalSubAgentAccumulators.delete(subAgentConversationId);
      if (activeSubAgentView === subAgentConversationId) setActiveSubAgentView(null);
      bumpSubAgentVersion();
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

  const handleContinueAfterMaxTurns = useCallback(
    (messageId: string) => {
      const convId = activeIdRef.current;
      if (!convId || isRunning) return;

      // Update the max-turns-reached part status to 'continued'
      setTree((prev) => {
        const updated = prev.map((msg) => {
          if (msg.id !== messageId) return msg;
          const content = (Array.isArray(msg.content) ? [...msg.content] : []) as ContentPart[];
          const updatedContent = content.map((p) =>
            (p as { type: string }).type === 'max-turns-reached' && (p as { status: string }).status === 'pending'
              ? { ...p, status: 'continued' as const }
              : p,
          );
          return { ...msg, content: toStoredContent(updatedContent) };
        });
        // Re-invoke stream with updated tree
        const cfg = streamHandlerRef.current;
        const newHead = cfg.headId;
        const branch = getActiveBranch(updated, newHead);
        const responseMessageId = msgId();
        streamAccumulators.set(convId, {
          messages: [...updated],
          headId: newHead,
          pendingAssistantTiming: createPendingAssistantTiming(),
          pendingAssistantId: responseMessageId,
        });
        persistConversation(convId, updated, newHead, { runStatus: 'running' });
        app.agent.stream(
          convId,
          branch,
          cfg.selectedModelKey ?? undefined,
          cfg.reasoningEffort ?? 'medium',
          cfg.selectedProfileKey ?? undefined,
          cfg.fallbackEnabled ?? false,
          currentWorkingDirectoryRef.current ?? undefined,
          executionMode ?? 'auto',
          cfg.threadOverrides ?? undefined,
          responseMessageId,
        );
        return updated;
      });
      setIsRunning(true);
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
  const handleContinueTask = useCallback(() => {
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

    streamAccumulators.set(convId, {
      messages: [...newTree],
      headId: newHead,
      pendingAssistantTiming: createPendingAssistantTiming(),
      pendingAssistantId: responseMessageId,
    });
    const branch = getActiveBranch(newTree, newHead);
    persistConversation(convId, newTree, newHead, { runStatus: 'running' });
    app.agent.stream(
      convId,
      branch,
      cfg.selectedModelKey ?? undefined,
      cfg.reasoningEffort ?? 'medium',
      cfg.selectedProfileKey ?? undefined,
      cfg.fallbackEnabled ?? false,
      currentWorkingDirectoryRef.current ?? undefined,
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
