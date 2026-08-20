/**
 * TaskProvider — React Context + useReducer store for the task queue.
 *
 * Manages task state in the renderer and syncs with the main process via IPC.
 * Follows the same Context pattern as PlanPanelProvider and ConfigProvider.
 */

import {
  createContext,
  useContext,
  useReducer,
  useEffect,
  useCallback,
  useMemo,
  useRef,
  type FC,
  type PropsWithChildren,
} from 'react';
import { app } from '@/lib/ipc-client';
import { useConfig } from '@/providers/ConfigProvider';
import { onAttachmentsCommitted, onAttachmentsReleased } from '@/lib/attachment-limits';
import { generateId } from '@/lib/utils';
import type { TaskFile, KaiTaskStatus, KaiTaskOrder, KaiTaskMetadata } from '@/types/task';
import { isValidTransition } from '../../shared/task-state-machine';

// ── State & Actions ──────────────────────────────────────────────────────

interface TaskState {
  tasks: TaskFile[];
  selectedTaskId: string | null;
  taskOrder: KaiTaskOrder;
  isLoading: boolean;
  /** ID of the task currently being AI-created (splash → streaming flow). */
  creatingTaskId: string | null;
  /** Accumulated streaming text for the AI plan being generated. */
  streamingText: string;
  /** Whether a plan stream is currently in flight. */
  isStreamingPlan: boolean;
  /** Transient notice: images the plan-side caps dropped on the last CREATION submission, keyed by the
   *  task it belongs to (R210/R211) so a different task's detail panel can't consume it. Cleared once shown. */
  droppedImageNotice: { taskId: string; count: number } | null;
  /** Submissions whose background plan stream failed/ended without persisting (R217/R219): keyed by taskId
   *  (a per-task MAP so a concurrent task's failure can't overwrite another's), each holding the prompt+images
   *  the surviving UI restores into that task's composer. An entry is cleared once fully restored. */
  failedSubmissions: Record<string, { text: string; attachments?: Array<{ image: string; mimeType?: string }> }>;
}

type TaskAction =
  | { type: 'SET_TASKS'; tasks: TaskFile[] }
  | { type: 'ADD_TASK'; task: TaskFile }
  | { type: 'UPDATE_TASK'; id: string; updates: Partial<TaskFile> }
  | { type: 'DELETE_TASK'; id: string }
  | { type: 'SELECT_TASK'; id: string | null }
  | { type: 'SET_ORDER'; order: KaiTaskOrder }
  | { type: 'SET_LOADING'; loading: boolean }
  | { type: 'START_AI_CREATE'; taskId: string }
  | { type: 'STREAM_TEXT_DELTA'; text: string }
  | { type: 'STREAM_DONE' }
  | { type: 'CANCEL_AI_CREATE' }
  | { type: 'SET_DROPPED_IMAGE_NOTICE'; notice: { taskId: string; count: number } | null }
  | {
      type: 'SET_FAILED_SUBMISSION';
      taskId: string;
      failed: { text: string; attachments?: Array<{ image: string; mimeType?: string }> } | null;
    };

const emptyOrder: KaiTaskOrder = {
  todo: [],
  in_progress: [],
  blocked: [],
  ai_review: [],
  human_review: [],
  done: [],
};

const initialState: TaskState = {
  tasks: [],
  selectedTaskId: null,
  taskOrder: emptyOrder,
  isLoading: true,
  creatingTaskId: null,
  streamingText: '',
  isStreamingPlan: false,
  droppedImageNotice: null,
  failedSubmissions: {},
};

function taskReducer(state: TaskState, action: TaskAction): TaskState {
  switch (action.type) {
    case 'SET_TASKS':
      return { ...state, tasks: action.tasks, isLoading: false };
    case 'ADD_TASK':
      return { ...state, tasks: [action.task, ...state.tasks] };
    case 'UPDATE_TASK':
      return {
        ...state,
        tasks: state.tasks.map((t) => (t.id === action.id ? { ...t, ...action.updates, id: action.id } : t)),
      };
    case 'DELETE_TASK':
      return {
        ...state,
        tasks: state.tasks.filter((t) => t.id !== action.id),
        selectedTaskId: state.selectedTaskId === action.id ? null : state.selectedTaskId,
      };
    case 'SELECT_TASK':
      return { ...state, selectedTaskId: action.id };
    case 'SET_ORDER':
      return { ...state, taskOrder: action.order };
    case 'SET_LOADING':
      return { ...state, isLoading: action.loading };
    case 'START_AI_CREATE':
      return { ...state, creatingTaskId: action.taskId, streamingText: '', isStreamingPlan: true };
    case 'STREAM_TEXT_DELTA':
      return { ...state, streamingText: state.streamingText + action.text };
    case 'STREAM_DONE':
      return { ...state, isStreamingPlan: false };
    case 'CANCEL_AI_CREATE':
      return { ...state, creatingTaskId: null, streamingText: '', isStreamingPlan: false };
    case 'SET_DROPPED_IMAGE_NOTICE':
      return { ...state, droppedImageNotice: action.notice };
    case 'SET_FAILED_SUBMISSION': {
      const next = { ...state.failedSubmissions };
      if (action.failed) next[action.taskId] = action.failed;
      else delete next[action.taskId];
      return { ...state, failedSubmissions: next };
    }
    default:
      return state;
  }
}

// ── Context ──────────────────────────────────────────────────────────────

interface TaskContextValue {
  state: TaskState;

  /** Create a task from manual input. */
  createTask: (data: {
    title: string;
    description: string;
    status?: KaiTaskStatus;
    metadata?: KaiTaskMetadata;
  }) => Promise<TaskFile | null>;

  /** Create a task from an approved plan. */
  createTaskFromPlan: (opts: {
    title: string;
    description: string;
    sourceConversationId?: string;
    sourceToolCallId?: string;
    planFileName?: string;
  }) => Promise<TaskFile | null>;

  /** Update an existing task. */
  updateTask: (id: string, updates: Partial<TaskFile>) => Promise<void>;

  /** Update only the status of a task. */
  updateTaskStatus: (id: string, status: KaiTaskStatus) => Promise<void>;

  /** Delete a task. */
  deleteTask: (id: string) => Promise<void>;

  /** Archive a task (hidden from normal views, not deleted). */
  archiveTask: (id: string) => Promise<void>;

  /** Select a task (for detail panel). */
  selectTask: (id: string | null) => void;

  /** Reorder tasks within a column. */
  reorderTasks: (status: KaiTaskStatus, activeId: string, overId: string) => void;

  /** Move a task to a different column (from drag-drop across columns). */
  moveTaskToColumn: (taskId: string, targetStatus: KaiTaskStatus, sourceStatus: KaiTaskStatus) => void;

  /** Start the AI task creation flow — creates a placeholder task, streams plan. */
  startAITaskCreation: (
    userMessage: string,
    metadata?: KaiTaskMetadata,
    attachments?: Array<{ image: string; mimeType?: string }>,
  ) => Promise<{ ok: boolean; droppedImages?: number }>;

  /** Send a follow-up message to refine the currently streaming task plan. */
  refineTaskPlan: (
    taskId: string,
    userMessage: string,
    attachments?: Array<{ image: string; mimeType?: string }>,
  ) => Promise<{ ok: boolean; droppedImages?: number }>;

  /** Cancel any active AI plan stream. */
  cancelAIStream: () => void;

  /** Exit AI creation mode (reset state, keep the task). */
  exitAICreation: () => void;
  /** Clear the transient dropped-image notice once the surviving UI has surfaced it (R210). */
  clearDroppedImageNotice: () => void;
  /** Clear the failed-submission restore payload once the composer has restored it (R217). */
  clearFailedSubmission: (taskId: string) => void;
}

const TaskContext = createContext<TaskContextValue | null>(null);

// ── Provider ─────────────────────────────────────────────────────────────

export const TaskProvider: FC<PropsWithChildren> = ({ children }) => {
  const [state, dispatch] = useReducer(taskReducer, initialState);
  const { config } = useConfig();
  const activeWorkspaceId =
    (config?.ui as { activeWorkspaceId?: string | null } | undefined)?.activeWorkspaceId ?? null;

  // Hydrate on mount
  useEffect(() => {
    if (!window.app?.tasks) {
      dispatch({ type: 'SET_LOADING', loading: false });
      return;
    }
    let cancelled = false;
    async function load() {
      try {
        const [tasks, order] = await Promise.all([app.tasks.list(), app.tasks.getOrder()]);
        if (cancelled) return;
        dispatch({ type: 'SET_TASKS', tasks });

        if (order) {
          // Prune stale IDs (deleted tasks) from order.json
          const taskIds = new Set(tasks.map((t) => t.id));
          let pruned = false;
          const cleanOrder = { ...order };
          for (const status of Object.keys(cleanOrder) as (keyof KaiTaskOrder)[]) {
            const original = cleanOrder[status] ?? [];
            const filtered = original.filter((id) => taskIds.has(id));
            if (filtered.length !== original.length) {
              cleanOrder[status] = filtered;
              pruned = true;
            }
          }
          dispatch({ type: 'SET_ORDER', order: cleanOrder });
          if (pruned) void app.tasks.saveOrder(cleanOrder);
        } else if (tasks.length > 0) {
          // No order.json — initialize order from current tasks
          const initialOrder: KaiTaskOrder = {
            todo: [],
            in_progress: [],
            blocked: [],
            ai_review: [],
            human_review: [],
            done: [],
          };
          for (const task of tasks) {
            initialOrder[task.status]?.push(task.id);
          }
          dispatch({ type: 'SET_ORDER', order: initialOrder });
          void app.tasks.saveOrder(initialOrder);
        }
      } catch (err) {
        console.error('[TaskProvider] Failed to load tasks:', err);
        if (!cancelled) dispatch({ type: 'SET_LOADING', loading: false });
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  // Subscribe to IPC broadcasts (changes from main process)
  useEffect(() => {
    if (!window.app?.tasks?.onChanged) return;
    const unsub = app.tasks.onChanged((tasks) => {
      // R222/R225: a task deleted in ANOTHER window (or by a plugin) arrives here only as a replaced list.
      // Reconcile orphaned recovery entries: any parked recovery whose id is no longer in the incoming list is
      // unreachable (its TaskDetailPanel will never mount) so remove it AND release its byte charge (parked
      // recovery stays accounted, R225). We iterate recoveryBytesRef — a ref mutated SYNCHRONOUSLY by
      // parkRecovery/clearFailedSubmission — NOT a passive state-mirror — so a recovery entry
      // parked microseconds before this broadcast is still seen (fixes the stale-mirror miss, R225). We
      // intentionally do NOT touch submittedPayloadRef here — an in-flight entry is THIS window's live
      // creation/refine and the broadcast list may simply not include it yet.
      const liveIds = new Set(tasks.map((t) => t.id));
      for (const id of Array.from(recoveryBytesRef.current.keys())) {
        if (!liveIds.has(id)) {
          const bytes = recoveryBytesRef.current.get(id) ?? 0;
          recoveryBytesRef.current.delete(id);
          if (bytes > 0) onAttachmentsReleased(bytes);
          dispatch({ type: 'SET_FAILED_SUBMISSION', taskId: id, failed: null });
        }
      }
      dispatch({ type: 'SET_TASKS', tasks: tasks });
    });
    return unsub;
  }, []);

  // ── Actions ──────────────────────────────────────────────────────────

  const createTask = useCallback(
    async (data: {
      title: string;
      description: string;
      status?: KaiTaskStatus;
      metadata?: KaiTaskMetadata;
    }): Promise<TaskFile | null> => {
      try {
        const task = await app.tasks.create({
          title: data.title,
          description: data.description,
          status: data.status ?? 'todo',
          metadata: data.metadata,
          workspaceId: activeWorkspaceId || undefined,
        });
        // No optimistic ADD_TASK dispatch — the IPC broadcast from main
        // process triggers SET_TASKS which includes the new task.
        return task;
      } catch (err) {
        console.error('[TaskProvider] Failed to create task:', err);
        return null;
      }
    },
    [activeWorkspaceId],
  );

  const createTaskFromPlan = useCallback(
    async (opts: {
      title: string;
      description: string;
      sourceConversationId?: string;
      sourceToolCallId?: string;
      planFileName?: string;
    }): Promise<TaskFile | null> => {
      try {
        const task = await app.tasks.create({
          title: opts.title,
          description: opts.description,
          status: 'todo',
          sourceConversationId: opts.sourceConversationId,
          sourceToolCallId: opts.sourceToolCallId,
          metadata: opts.planFileName ? { planFileName: opts.planFileName } : undefined,
          workspaceId: activeWorkspaceId || undefined,
        });
        // No optimistic ADD_TASK dispatch — broadcast handles it.
        return task;
      } catch (err) {
        console.error('[TaskProvider] Failed to create task from plan:', err);
        return null;
      }
    },
    [activeWorkspaceId],
  );

  const updateTask = useCallback(async (id: string, updates: Partial<TaskFile>) => {
    try {
      // Optimistic update
      dispatch({ type: 'UPDATE_TASK', id, updates });
      await app.tasks.update(id, updates);
    } catch (err) {
      console.error('[TaskProvider] Failed to update task:', err);
      // Re-fetch to reconcile state
      const tasks = await app.tasks.list();
      dispatch({ type: 'SET_TASKS', tasks });
    }
  }, []);

  const updateTaskStatus = useCallback(
    async (id: string, status: KaiTaskStatus) => {
      const now = new Date().toISOString();
      const task = state.tasks.find((t) => t.id === id);
      // Validate the transition against the formal state machine
      if (task && !isValidTransition(task.status, status)) {
        console.warn(`[TaskProvider] Rejected invalid status transition for task ${id}: ${task.status} → ${status}`);
        return;
      }
      // When marking as done, don't kill or clear terminal — preserve output for review
      if (status === 'done') {
        await updateTask(id, { status, completedAt: now });
        return;
      }
      // Stamp startedAt on first transition to in_progress
      if (status === 'in_progress' && !task?.startedAt) {
        await updateTask(id, { status, startedAt: now });
        return;
      }
      await updateTask(id, { status });
    },
    [updateTask, state.tasks],
  );

  // R221/R225: release any in-flight/parked payload a task is holding so a deleted/archived task can't strand
  // its charged attachment bytes or leave an unreachable recovery entry. In-flight bytes live on
  // submittedPayloadRef; parked recovery bytes live on recoveryBytesRef (R225 — parked payloads stay accounted).
  // Release from whichever holds it. Safe to reference the refs here — this runs on a user event, long after mount.
  const purgeTaskPayload = useCallback((id: string) => {
    const p = submittedPayloadRef.current.get(id);
    if (p) {
      onAttachmentsReleased(p.bytes);
      submittedPayloadRef.current.delete(id);
    }
    const recoveryBytes = recoveryBytesRef.current.get(id);
    if (recoveryBytes !== undefined) {
      recoveryBytesRef.current.delete(id);
      if (recoveryBytes > 0) onAttachmentsReleased(recoveryBytes);
    }
    dispatch({ type: 'SET_FAILED_SUBMISSION', taskId: id, failed: null });
  }, []);

  const deleteTask = useCallback(
    async (id: string) => {
      try {
        // R222: purge the recovery/in-flight payload ONLY after the delete is confirmed. Task IPC returns
        // {error} (or {ok:false}) as a RESOLVED promise, not a rejection — so purging before the await would
        // irrecoverably lose the prompt/attachments while the task remains on disk. Optimistically remove from
        // the visible list (cheap to re-sync), but keep the payload until success.
        dispatch({ type: 'DELETE_TASK', id });
        const res = await app.tasks.delete(id);
        if (res && res.ok) {
          purgeTaskPayload(id);
        } else {
          console.error('[TaskProvider] Delete task did not succeed:', id, res);
          const tasks = await app.tasks.list();
          dispatch({ type: 'SET_TASKS', tasks });
        }
      } catch (err) {
        console.error('[TaskProvider] Failed to delete task:', err);
        const tasks = await app.tasks.list();
        dispatch({ type: 'SET_TASKS', tasks });
      }
    },
    [purgeTaskPayload],
  );

  const archiveTask = useCallback(
    async (id: string) => {
      try {
        dispatch({ type: 'DELETE_TASK', id }); // remove from active list optimistically
        // R222: archive via tasks:update returns the updated TaskFile on success or an {error} object on
        // failure (resolved, not rejected). Only purge the payload once we confirm the archive succeeded.
        const res = await app.tasks.update(id, { archivedAt: new Date().toISOString() });
        if (res && !(res as { error?: string }).error) {
          purgeTaskPayload(id);
        } else {
          console.error('[TaskProvider] Archive task did not succeed:', id, res);
          const tasks = await app.tasks.list();
          dispatch({ type: 'SET_TASKS', tasks });
        }
      } catch (err) {
        console.error('[TaskProvider] Failed to archive task:', err);
        const tasks = await app.tasks.list();
        dispatch({ type: 'SET_TASKS', tasks });
      }
    },
    [purgeTaskPayload],
  );

  const selectTask = useCallback((id: string | null) => {
    dispatch({ type: 'SELECT_TASK', id });
  }, []);

  const reorderTasks = useCallback(
    (status: KaiTaskStatus, activeId: string, overId: string) => {
      const currentOrder = { ...state.taskOrder };
      let column = [...(currentOrder[status] ?? [])];

      // If the order array is empty or missing task IDs, rebuild from current tasks
      const tasksInStatus = state.tasks.filter((t) => t.status === status);
      if (column.length === 0) {
        column = tasksInStatus.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((t) => t.id);
      } else {
        // Ensure any tasks not yet in the order array get appended
        const columnSet = new Set(column);
        for (const t of tasksInStatus) {
          if (!columnSet.has(t.id)) column.push(t.id);
        }
      }

      const activeIdx = column.indexOf(activeId);
      const overIdx = column.indexOf(overId);
      if (activeIdx < 0 || overIdx < 0) return;

      column.splice(activeIdx, 1);
      column.splice(overIdx, 0, activeId);
      currentOrder[status] = column;

      dispatch({ type: 'SET_ORDER', order: currentOrder });
      void app.tasks.saveOrder(currentOrder);
    },
    [state.taskOrder, state.tasks],
  );

  const moveTaskToColumn = useCallback(
    async (taskId: string, targetStatus: KaiTaskStatus, sourceStatus: KaiTaskStatus) => {
      // Validate the transition against the formal state machine
      if (!isValidTransition(sourceStatus, targetStatus)) {
        console.warn(
          `[TaskProvider] Rejected invalid status transition for task ${taskId}: ${sourceStatus} → ${targetStatus}`,
        );
        return;
      }
      // Build status updates with proper timestamps
      const now = new Date().toISOString();
      const task = state.tasks.find((t) => t.id === taskId);
      const statusUpdates: Partial<TaskFile> = { status: targetStatus };

      if (targetStatus === 'done') {
        statusUpdates.completedAt = now;
        if (task?.terminalSessionId) {
          void app.tasks.terminalKill(task.terminalSessionId);
          statusUpdates.terminalSessionId = undefined;
        }
      }
      if (targetStatus === 'in_progress' && !task?.startedAt) {
        statusUpdates.startedAt = now;
      }

      dispatch({ type: 'UPDATE_TASK', id: taskId, updates: statusUpdates });

      // Optimistic order update
      const currentOrder = { ...state.taskOrder };
      currentOrder[sourceStatus] = (currentOrder[sourceStatus] ?? []).filter((id) => id !== taskId);
      currentOrder[targetStatus] = [taskId, ...(currentOrder[targetStatus] ?? [])];
      dispatch({ type: 'SET_ORDER', order: currentOrder });

      // Persist both — reconcile on failure
      try {
        await Promise.all([app.tasks.update(taskId, statusUpdates), app.tasks.saveOrder(currentOrder)]);
      } catch (err) {
        console.error('[TaskProvider] Failed to move task to column:', err);
        const tasks = await app.tasks.list();
        dispatch({ type: 'SET_TASKS', tasks });
      }
    },
    [state.taskOrder, state.tasks],
  );

  // ── AI Creation Actions ─────────────────────────────────────────────

  // Track creatingTaskId in a ref for the stream event callback
  const creatingTaskIdRef = useRef<string | null>(null);
  useEffect(() => {
    creatingTaskIdRef.current = state.creatingTaskId;
  }, [state.creatingTaskId]);
  // Buffer for stream events that arrive for a task BEFORE its START_AI_CREATE dispatch has initialized the
  // stream UI state (R215): main begins broadcasting as soon as streamPlan launches, and we register the ref
  // before START_AI_CREATE (R214). Without buffering, an early delta would be appended and then wiped by
  // START_AI_CREATE's streamingText reset, and an early `done` would be overwritten by isStreamingPlan=true
  // (stuck streaming). Events land here until the dispatch flushes them.
  const streamBufferRef = useRef<{ taskId: string; text: string; done: boolean; error: boolean } | null>(null);
  const streamStartedRef = useRef<string | null>(null); // taskId whose START_AI_CREATE has been dispatched
  // Per-task recovery for a plan stream that fails/ends without persisting (R217/R218/R219). Keyed PER TASK
  // (main runs concurrent per-task streams). `producedText` tracks whether any delta arrived; tasks.ts persists
  // history ONLY when fullText is nonempty AND `done` fires — so we must restore on `error` (nothing written)
  // AND on a `done` that produced NO text (empty provider response — also not written). `bytes` is the parked
  // attachment payload size, committed to the renderer-wide counter while held so it can't exceed the ceiling
  // (R219), released when resolved.
  const submittedPayloadRef = useRef<
    Map<
      string,
      {
        text: string;
        attachments?: Array<{ image: string; mimeType?: string }>;
        producedText: boolean;
        bytes: number;
        // R223: the stream INSTANCE id this window owns for the task, recorded once streamPlan resolves. The
        // listener only lets an event resolve/feed this payload when the event's streamId matches (or is absent —
        // pre-streamId early terminal events). Prevents a replacement stream started by ANOTHER window from
        // resolving this window's in-flight payload.
        streamId?: string;
      }
    >
  >(new Map());
  // R225: parked recovery payloads (moved to failedSubmissions) DO consume renderer heap — the data-URL strings
  // live on until the entry is cleared, so R221's "release the charge because it's not composer-resident" was a
  // memory-leak premise. We keep the charge accounted while parked (recoveryBytesRef mirrors each entry's bytes
  // so clearFailedSubmission can release exactly once, stale-closure-free) AND bound the total: parking a new
  // recovery entry evicts the OLDEST entries (insertion order) until the total is under the cap, so background
  // failures across many tasks can't accumulate unbounded 12 MiB payloads. Eviction drops the strings (releasing
  // both the charge and the heap) — a rare recovery draft is worth losing before the renderer OOMs.
  const recoveryBytesRef = useRef<Map<string, number>>(new Map());
  const RECOVERY_BYTES_CAP = 48 * 1024 * 1024; // 48 MiB total parked recovery payloads (≈4 max-size task submissions)
  // R226: the client MINTS the stream instance id and records it SYNCHRONOUSLY at submission (rememberSubmission),
  // then passes it to streamPlan so main stamps every event with it. This eliminates the pending-admission window
  // that R223-R225 kept creating races around: there is no interval where we own an in-flight payload but don't
  // yet know its streamId, so streamMatchesOwned always has the real id and neither our own fast terminal nor a
  // superseding stream's stamped error can be misattributed.
  // Decide whether an incoming stream event may act on THIS window's view/recovery for the task. R226: the
  // streamId is minted client-side and recorded synchronously at rememberSubmission, so a payload we own ALWAYS
  // has its streamId — there is no pending-admission window. Cases:
  //  - We hold a payload → accept iff the event's streamId matches ours (an unstamped event, e.g. a pre-stream
  //    validation terminal or a legacy emitter, is accepted for backward-compat — it carries our taskId and the
  //    display gate bounds it).
  //  - We hold NO payload → no in-flight ownership; reject any STAMPED (foreign) event so its deltas can't append
  //    to our stale streamingText (R224). Unstamped events fall through (display gate handles them).
  const streamMatchesOwned = useCallback((taskId: string, eventStreamId: string | undefined): boolean => {
    const entry = submittedPayloadRef.current.get(taskId);
    if (!entry) return !eventStreamId; // no local ownership: reject any stamped (foreign) event
    if (!eventStreamId) return true; // unstamped event (backward-compat / pre-stream validation terminal)
    return entry.streamId === eventStreamId;
  }, []);
  // R226: a recovery payload's accounted size counts BOTH the prompt text and the attachment data URLs. Counting
  // only attachments (R225) let text-only failures have zero cost, so they were never evicted and repeated
  // background failures could retain unbounded ~50k-char prompts. Text length is a fair proxy for its heap cost.
  const computePayloadBytes = useCallback(
    (text: string, attachments?: Array<{ image: string; mimeType?: string }>): number => {
      const attBytes = (attachments ?? []).reduce((sum, a) => sum + (a.image?.length ?? 0), 0);
      return (text?.length ?? 0) + attBytes;
    },
    [],
  );
  // Store (or replace) a task's recovery payload, accounting its bytes. A replace releases the prior bytes.
  const rememberSubmission = useCallback(
    (
      taskId: string,
      text: string,
      attachments: Array<{ image: string; mimeType?: string }> | undefined,
      streamId: string,
    ) => {
      const prev = submittedPayloadRef.current.get(taskId);
      if (prev) onAttachmentsReleased(prev.bytes);
      const bytes = computePayloadBytes(text, attachments);
      if (bytes > 0) onAttachmentsCommitted(bytes);
      // R226: streamId is minted by the caller and stored HERE, synchronously, before streamPlan is awaited —
      // no pending-admission window (streamId is known before streamPlan is awaited).
      submittedPayloadRef.current.set(taskId, { text, attachments, producedText: false, bytes, streamId });
      // R221/R226: a NEW submission for this task supersedes any stale recovery entry from a prior failed attempt —
      // the user is actively retrying, so the earlier stashed draft is obsolete. Release the prior recovery entry's
      // byte charge from recoveryBytesRef (R226: previously only the state was cleared, leaving a phantom charge
      // that reduced the global budget after a successful retry) AND remove the state entry.
      const staleRecovery = recoveryBytesRef.current.get(taskId);
      if (staleRecovery !== undefined) {
        recoveryBytesRef.current.delete(taskId);
        if (staleRecovery > 0) onAttachmentsReleased(staleRecovery);
      }
      dispatch({ type: 'SET_FAILED_SUBMISSION', taskId, failed: null });
    },
    [computePayloadBytes],
  );
  const dropSubmission = useCallback((taskId: string) => {
    const p = submittedPayloadRef.current.get(taskId);
    if (p) {
      onAttachmentsReleased(p.bytes); // release parked bytes (R219)
      submittedPayloadRef.current.delete(taskId);
    }
  }, []);
  const clearFailedSubmission = useCallback((taskId: string) => {
    // R225: release the parked recovery payload's byte charge (kept accounted while parked so the renderer-wide
    // ceiling reflects the strings actually resident in failedSubmissions state). Delete-then-release is
    // idempotent — a second clear finds no ref entry and releases nothing.
    const bytes = recoveryBytesRef.current.get(taskId);
    if (bytes !== undefined) {
      recoveryBytesRef.current.delete(taskId);
      if (bytes > 0) onAttachmentsReleased(bytes);
    }
    dispatch({ type: 'SET_FAILED_SUBMISSION', taskId, failed: null });
  }, []);
  // R225: park a recovery payload, keeping its bytes accounted and bounding the total. Evicts OLDEST parked
  // entries (Map insertion order) until this new entry fits under RECOVERY_BYTES_CAP. Evicting drops the entry's
  // strings + releases its charge so parked recovery can't grow the heap without limit.
  const parkRecovery = useCallback(
    (
      taskId: string,
      text: string,
      attachments: Array<{ image: string; mimeType?: string }> | undefined,
      bytes: number,
    ) => {
      // Drop any prior parked entry for THIS task first (superseded), releasing its charge.
      const prior = recoveryBytesRef.current.get(taskId);
      if (prior !== undefined) {
        recoveryBytesRef.current.delete(taskId);
        if (prior > 0) onAttachmentsReleased(prior);
      }
      // Evict oldest until the new entry fits (never evict below zero / infinite-loop-safe: stop when empty).
      let total = 0;
      for (const b of recoveryBytesRef.current.values()) total += b;
      while (total + bytes > RECOVERY_BYTES_CAP && recoveryBytesRef.current.size > 0) {
        const oldestId = recoveryBytesRef.current.keys().next().value as string;
        const oldestBytes = recoveryBytesRef.current.get(oldestId) ?? 0;
        recoveryBytesRef.current.delete(oldestId);
        if (oldestBytes > 0) onAttachmentsReleased(oldestBytes);
        total -= oldestBytes;
        dispatch({ type: 'SET_FAILED_SUBMISSION', taskId: oldestId, failed: null });
      }
      recoveryBytesRef.current.set(taskId, bytes); // keep the charge accounted while parked
      dispatch({ type: 'SET_FAILED_SUBMISSION', taskId, failed: { text, attachments } });
    },
    [RECOVERY_BYTES_CAP],
  );
  const resolveTerminalOutcome = useCallback(
    (taskId: string, isError: boolean) => {
      const payload = submittedPayloadRef.current.get(taskId);
      if (!payload) return;
      // Restore on error OR on an empty `done` (no text produced → tasks.ts wrote nothing). A `done` WITH
      // text produced is genuinely persisted — just drop the payload.
      const needsRecovery = isError || !payload.producedText;
      if (needsRecovery) {
        // R225: move the payload OUT of the in-flight ref (delete WITHOUT releasing here) and hand its bytes to
        // parkRecovery, which keeps the charge accounted while the strings live in failedSubmissions and evicts
        // to a hard cap. Exactly one owner holds the charge at all times: submittedPayloadRef → recoveryBytesRef.
        const bytes = payload.bytes;
        submittedPayloadRef.current.delete(taskId);
        parkRecovery(taskId, payload.text, payload.attachments, bytes);
      } else {
        dropSubmission(taskId); // genuinely persisted → release parked bytes
      }
    },
    [dropSubmission, parkRecovery],
  );
  // Called synchronously right after dispatching START_AI_CREATE for taskId: flush any events buffered
  // before the dispatch so early output isn't lost and an early terminal event isn't overwritten.
  const flushStreamBuffer = useCallback(
    (taskId: string) => {
      streamStartedRef.current = taskId;
      const buf = streamBufferRef.current;
      streamBufferRef.current = null;
      if (!buf || buf.taskId !== taskId) return;
      if (buf.text) {
        const p = submittedPayloadRef.current.get(taskId);
        if (p) p.producedText = true; // buffered text counts as produced (R219) so an empty-done isn't misjudged
        dispatch({ type: 'STREAM_TEXT_DELTA', text: buf.text });
      }
      if (buf.done) {
        // A terminal event arrived while buffered — resolve recovery (R218: a buffered ERROR must still
        // trigger restore) then finalize the stream UI.
        resolveTerminalOutcome(taskId, buf.error);
        dispatch({ type: 'STREAM_DONE' });
      }
    },
    [resolveTerminalOutcome],
  );

  // Subscribe to task stream events from main process
  useEffect(() => {
    if (!window.app?.tasks?.onStreamEvent) return;
    const unsub = app.tasks.onStreamEvent((evt) => {
      // ---- Stream-instance ownership gate (R223) ----
      // Ignore an event whose streamId doesn't match the instance THIS window owns for the task. A task's
      // stream can be replaced (another window issues a new streamPlan for the same taskId); without this gate
      // the replacement's events would resolve/clear or feed this window's in-flight payload and UI. Absent
      // streamIds (on either side) fall through as a match for backward-compat with pre-assignment events.
      if (!streamMatchesOwned(evt.taskId, evt.streamId)) return;

      // ---- Recovery/persistence bookkeeping: PER TASK, never gated by which task the UI shows (R220). ----
      // Any task with a tracked submitted payload must have its produced-text flag and terminal outcome
      // resolved, whether or not it is the displayed task and whether or not its START_AI_CREATE has run.
      // R220: the old single-task buffer-gate `return`ed for non-displayed tasks, so a background task's
      // terminal event never reached resolveTerminalOutcome and its draft was stranded. Do recovery first,
      // unconditionally, then handle display below.
      if (submittedPayloadRef.current.has(evt.taskId)) {
        if (evt.type === 'text-delta' && evt.text) {
          const p = submittedPayloadRef.current.get(evt.taskId);
          if (p) p.producedText = true; // R219: buffered/live text counts as produced so an empty-done isn't misjudged
        } else if (evt.type === 'done' && evt.reason === 'deleted') {
          // R223: the task was deleted while its stream was in flight — drop the payload WITHOUT recovery
          // (a deliberate delete is not a failure, and the task no longer exists to restore into).
          dropSubmission(evt.taskId);
          clearFailedSubmission(evt.taskId);
        } else if (evt.type === 'done') {
          resolveTerminalOutcome(evt.taskId, false);
        } else if (evt.type === 'error') {
          console.error('[TaskProvider] Stream error:', evt.error);
          resolveTerminalOutcome(evt.taskId, true);
        }
      }

      // ---- Display: buffer or dispatch, gated on the task currently being created/shown. ----
      // Buffer events for a task whose START_AI_CREATE hasn't run yet (R215), capturing a terminal error flag.
      if (streamStartedRef.current !== evt.taskId) {
        // Only buffer for the task we're actually creating; ignore unrelated ids for the UI.
        if (evt.taskId !== creatingTaskIdRef.current) return;
        const buf = streamBufferRef.current ?? { taskId: evt.taskId, text: '', done: false, error: false };
        if (buf.taskId !== evt.taskId) {
          buf.taskId = evt.taskId;
          buf.text = '';
          buf.done = false;
          buf.error = false;
        }
        if (evt.type === 'text-delta' && evt.text) buf.text += evt.text;
        else if (evt.type === 'done' || evt.type === 'error') {
          buf.done = true;
          if (evt.type === 'error') buf.error = true;
        }
        streamBufferRef.current = buf;
        return;
      }

      if (evt.taskId !== creatingTaskIdRef.current) return;
      switch (evt.type) {
        case 'text-delta':
          if (evt.text) dispatch({ type: 'STREAM_TEXT_DELTA', text: evt.text });
          break;
        case 'done':
          dispatch({ type: 'STREAM_DONE' });
          break;
        case 'error':
          dispatch({ type: 'STREAM_DONE' });
          break;
      }
    });
    return unsub;
  }, [resolveTerminalOutcome, streamMatchesOwned, dropSubmission, clearFailedSubmission]);

  const startAITaskCreation = useCallback(
    async (
      userMessage: string,
      metadata?: KaiTaskMetadata,
      attachments?: Array<{ image: string; mimeType?: string }>,
    ): Promise<{ ok: boolean; droppedImages?: number }> => {
      // Track the placeholder task id outside the try so the catch can delete it if streamPlan (or a later
      // step) THROWS after creation — otherwise a durable orphaned "New Task" is left behind (R213).
      let createdTaskId: string | null = null;
      try {
        // Create a placeholder task
        const task = await app.tasks.create({
          title: 'New Task',
          description: '',
          status: 'todo',
          workspaceId: activeWorkspaceId || undefined,
          metadata,
        });
        if (!task || !task.id) return { ok: false };
        createdTaskId = task.id;
        // Register stream ownership SYNCHRONOUSLY before awaiting streamPlan (R214): main begins
        // broadcasting deltas as soon as streamPlan launches its background stream, but the React effect
        // that syncs creatingTaskIdRef from state runs later — so the listener would discard early
        // deltas/errors (stuck stream) and, during a task switch, could route them to the wrong buffer.
        // Setting the ref here makes the listener accept this task's events immediately.
        creatingTaskIdRef.current = task.id;
        // R226: mint the stream instance id client-side and record it SYNCHRONOUSLY (rememberSubmission) before
        // awaiting streamPlan, then pass it to main so every event is stamped with it. No pending-admission
        // window — the listener always knows our id, so our own fast terminal and a superseding stream's error
        // are never confused.
        const streamId = generateId();
        rememberSubmission(task.id, userMessage, attachments, streamId);

        // Start streaming the plan BEFORE transitioning the UI (R208): START_AI_CREATE unmounts the
        // TaskCreationView composer, so dispatching it up front means an in-band {error:true} failure would
        // roll back into an unmounted/disposed composer and lose the prompt. streamPlan resolves almost
        // immediately (it launches the stream in the background and returns), and its deltas are broadcast
        // async — so deferring the transition until after this await does not drop early stream events.
        const res = await app.tasks.streamPlan(task.id, userMessage, undefined, attachments, streamId);
        if (res && (res as { error?: boolean }).error) {
          // Admission failed before streaming began — the composer is still mounted with the user's
          // input/attachments intact (we never transitioned), so just clean up the placeholder task and
          // report failure; no rollback into a live composer is needed. The placeholder is DELETED, so purge
          // BOTH the in-flight payload (dropSubmission) AND any recovery entry a concurrently-broadcast stream
          // `error` already created (clearFailedSubmission) — otherwise a deleted task strands an unreachable
          // data-URL recovery entry (R222). Exactly one of the two holds the payload.
          dropSubmission(task.id);
          clearFailedSubmission(task.id);
          // R223: tasks:delete resolves {error}/{ok:false} rather than rejecting, so a fire-and-forget
          // .catch() would leave a durable orphaned "New Task" on a filesystem delete failure. Await the
          // result and re-sync the list if it didn't succeed so the orphan doesn't linger in the UI.
          try {
            const del = await app.tasks.delete?.(task.id);
            if (del && !del.ok) {
              const tasks = await app.tasks.list();
              dispatch({ type: 'SET_TASKS', tasks });
            }
          } catch (delErr) {
            console.error('[TaskProvider] Failed to clean up placeholder task after admission failure:', delErr);
            const tasks = await app.tasks.list();
            dispatch({ type: 'SET_TASKS', tasks });
          }
          return { ok: false };
        }

        dispatch({ type: 'START_AI_CREATE', taskId: task.id });
        flushStreamBuffer(task.id); // flush events buffered before this dispatch (R215)

        // Generate title in parallel (non-blocking)
        void app.tasks.generateTitle(userMessage).then(({ title }) => {
          if (title) {
            dispatch({ type: 'UPDATE_TASK', id: task.id, updates: { title } });
            void app.tasks.update(task.id, { title });
          }
        });
        const dropped = (res as { droppedImages?: number })?.droppedImages ?? 0;
        if (dropped > 0) dispatch({ type: 'SET_DROPPED_IMAGE_NOTICE', notice: { taskId: task.id, count: dropped } });
        return { ok: true, droppedImages: dropped || undefined };
      } catch (err) {
        console.error('[TaskProvider] Failed to start AI task creation:', err);
        dispatch({ type: 'CANCEL_AI_CREATE' });
        // Delete the orphaned placeholder task created before the throw (R213). A concurrently-broadcast stream
        // `error` may already have moved the payload from in-flight (submittedPayloadRef) to failedSubmissions
        // (R221) — so purge BOTH: dropSubmission releases the charge if still in-flight, clearFailedSubmission
        // removes an unreachable recovery entry for a task that no longer exists. Exactly one holds the charge.
        if (createdTaskId) {
          dropSubmission(createdTaskId);
          clearFailedSubmission(createdTaskId);
          void app.tasks.delete?.(createdTaskId).catch(() => {});
        }
        return { ok: false };
      }
    },
    [activeWorkspaceId, flushStreamBuffer, rememberSubmission, dropSubmission, clearFailedSubmission],
  );

  const refineTaskPlan = useCallback(
    async (
      taskId: string,
      userMessage: string,
      attachments?: Array<{ image: string; mimeType?: string }>,
    ): Promise<{ ok: boolean; droppedImages?: number }> => {
      try {
        // Fetch fresh task from IPC to avoid stale closure over state.tasks
        const task = await app.tasks.get(taskId);
        const history = task?.conversationHistory ?? [];

        dispatch({ type: 'START_AI_CREATE', taskId });
        flushStreamBuffer(taskId); // marks streamStartedRef so subsequent events dispatch live (R215)
        // Register stream ownership synchronously before awaiting streamPlan (R214) — see startAITaskCreation.
        creatingTaskIdRef.current = taskId;
        // R226: mint + record the stream id synchronously (see startAITaskCreation), pass it to streamPlan.
        const streamId = generateId();
        rememberSubmission(taskId, userMessage, attachments, streamId);

        // streamPlan resolves {taskId, error:true} for in-band admission failures (R207).
        const res = await app.tasks.streamPlan(taskId, userMessage, history, attachments, streamId);
        if (res && (res as { error?: boolean }).error) {
          // R225/R228: a refine failure NEVER keeps recovery — the refine composer stays mounted and KEEPS the
          // user's draft on !res.ok (TaskDetailPanel.handleComposerSubmit), so parking recovery would give BOTH
          // the composer and failedSubmissions ownership (clearing the composer later resurrects it; images
          // double-charged). Release the in-flight payload (dropSubmission) AND clear any recovery the async
          // stream-event listener may have ALREADY parked before this resolved — R226's client-minted streamId
          // makes a stamped broadcast `error` match immediately, so the listener can park recovery before this
          // {error:true} arrives, and a bare dropSubmission would then no-op. Both calls are idempotent.
          dropSubmission(taskId);
          clearFailedSubmission(taskId);
          dispatch({ type: 'STREAM_DONE' });
          return { ok: false };
        }
        return { ok: true, droppedImages: (res as { droppedImages?: number })?.droppedImages };
      } catch (err) {
        console.error('[TaskProvider] Failed to refine task plan:', err);
        // Thrown BEFORE/at admission → composer still holds the draft (as above); release + clear, don't park.
        dropSubmission(taskId);
        clearFailedSubmission(taskId);
        dispatch({ type: 'STREAM_DONE' });
        return { ok: false };
      }
    },
    [flushStreamBuffer, rememberSubmission, dropSubmission, clearFailedSubmission],
  );

  const cancelAIStream = useCallback(() => {
    if (state.creatingTaskId) {
      void app.tasks.cancelPlanStream(state.creatingTaskId);
      dropSubmission(state.creatingTaskId); // R220: a deliberate cancel releases the parked payload (no recovery)
    }
    dispatch({ type: 'CANCEL_AI_CREATE' });
  }, [state.creatingTaskId, dropSubmission]);

  const exitAICreation = useCallback(() => {
    if (state.creatingTaskId) {
      if (state.isStreamingPlan) void app.tasks.cancelPlanStream(state.creatingTaskId);
      dropSubmission(state.creatingTaskId); // R220: releasing here prevents a leaked committed-bytes reservation
    }
    dispatch({ type: 'CANCEL_AI_CREATE' });
  }, [state.isStreamingPlan, state.creatingTaskId, dropSubmission]);

  // ── Memoized context value ───────────────────────────────────────────

  const clearDroppedImageNotice = useCallback(() => {
    dispatch({ type: 'SET_DROPPED_IMAGE_NOTICE', notice: null });
  }, []);

  const value = useMemo<TaskContextValue>(
    () => ({
      state,
      createTask,
      createTaskFromPlan,
      updateTask,
      updateTaskStatus,
      deleteTask,
      archiveTask,
      selectTask,
      reorderTasks,
      moveTaskToColumn,
      startAITaskCreation,
      refineTaskPlan,
      cancelAIStream,
      exitAICreation,
      clearDroppedImageNotice,
      clearFailedSubmission,
    }),
    [
      state,
      createTask,
      createTaskFromPlan,
      updateTask,
      updateTaskStatus,
      deleteTask,
      archiveTask,
      selectTask,
      reorderTasks,
      moveTaskToColumn,
      startAITaskCreation,
      refineTaskPlan,
      cancelAIStream,
      exitAICreation,
      clearDroppedImageNotice,
      clearFailedSubmission,
    ],
  );

  return <TaskContext.Provider value={value}>{children}</TaskContext.Provider>;
};

// ── Hook ─────────────────────────────────────────────────────────────────

export function useTasks(): TaskContextValue {
  const ctx = useContext(TaskContext);
  if (!ctx) {
    throw new Error('useTasks must be used within a <TaskProvider>');
  }
  return ctx;
}

/** Optional variant — returns null instead of throwing when outside TaskProvider. */
export function useTasksOptional(): TaskContextValue | null {
  return useContext(TaskContext);
}

/** Test-only exposure of the pure reducer + initial state. */
export const __internal = { taskReducer, initialState };
