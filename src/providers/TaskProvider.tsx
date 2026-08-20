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
  | { type: 'SET_DROPPED_IMAGE_NOTICE'; notice: { taskId: string; count: number } | null };

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

  const deleteTask = useCallback(async (id: string) => {
    try {
      dispatch({ type: 'DELETE_TASK', id });
      await app.tasks.delete(id);
    } catch (err) {
      console.error('[TaskProvider] Failed to delete task:', err);
      const tasks = await app.tasks.list();
      dispatch({ type: 'SET_TASKS', tasks });
    }
  }, []);

  const archiveTask = useCallback(async (id: string) => {
    try {
      dispatch({ type: 'DELETE_TASK', id }); // remove from active list optimistically
      await app.tasks.update(id, { archivedAt: new Date().toISOString() });
    } catch (err) {
      console.error('[TaskProvider] Failed to archive task:', err);
      const tasks = await app.tasks.list();
      dispatch({ type: 'SET_TASKS', tasks });
    }
  }, []);

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

  // Subscribe to task stream events from main process
  useEffect(() => {
    if (!window.app?.tasks?.onStreamEvent) return;
    const unsub = app.tasks.onStreamEvent((evt) => {
      // Only process events for the task we're currently creating
      if (evt.taskId !== creatingTaskIdRef.current) return;

      switch (evt.type) {
        case 'text-delta':
          if (evt.text) dispatch({ type: 'STREAM_TEXT_DELTA', text: evt.text });
          break;
        case 'done':
          dispatch({ type: 'STREAM_DONE' });
          break;
        case 'error':
          console.error('[TaskProvider] Stream error:', evt.error);
          dispatch({ type: 'STREAM_DONE' });
          break;
      }
    });
    return unsub;
  }, []);

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

        // Start streaming the plan BEFORE transitioning the UI (R208): START_AI_CREATE unmounts the
        // TaskCreationView composer, so dispatching it up front means an in-band {error:true} failure would
        // roll back into an unmounted/disposed composer and lose the prompt. streamPlan resolves almost
        // immediately (it launches the stream in the background and returns), and its deltas are broadcast
        // async — so deferring the transition until after this await does not drop early stream events.
        const res = await app.tasks.streamPlan(task.id, userMessage, undefined, attachments);
        if (res && (res as { error?: boolean }).error) {
          // Admission failed before streaming began — the composer is still mounted with the user's
          // input/attachments intact (we never transitioned), so just clean up the placeholder task and
          // report failure; no rollback into a live composer is needed.
          void app.tasks.delete?.(task.id).catch(() => {});
          return { ok: false };
        }

        dispatch({ type: 'START_AI_CREATE', taskId: task.id });

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
        // Delete the orphaned placeholder task created before the throw (R213).
        if (createdTaskId) void app.tasks.delete?.(createdTaskId).catch(() => {});
        return { ok: false };
      }
    },
    [activeWorkspaceId],
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
        // Register stream ownership synchronously before awaiting streamPlan (R214) — see startAITaskCreation.
        creatingTaskIdRef.current = taskId;

        // streamPlan resolves {taskId, error:true} for in-band failures (R207) — roll back on those too.
        const res = await app.tasks.streamPlan(taskId, userMessage, history, attachments);
        if (res && (res as { error?: boolean }).error) {
          dispatch({ type: 'STREAM_DONE' });
          return { ok: false };
        }
        return { ok: true, droppedImages: (res as { droppedImages?: number })?.droppedImages };
      } catch (err) {
        console.error('[TaskProvider] Failed to refine task plan:', err);
        dispatch({ type: 'STREAM_DONE' });
        return { ok: false };
      }
    },
    [],
  );

  const cancelAIStream = useCallback(() => {
    if (state.creatingTaskId) {
      void app.tasks.cancelPlanStream(state.creatingTaskId);
    }
    dispatch({ type: 'CANCEL_AI_CREATE' });
  }, [state.creatingTaskId]);

  const exitAICreation = useCallback(() => {
    if (state.isStreamingPlan && state.creatingTaskId) {
      void app.tasks.cancelPlanStream(state.creatingTaskId);
    }
    dispatch({ type: 'CANCEL_AI_CREATE' });
  }, [state.isStreamingPlan, state.creatingTaskId]);

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
