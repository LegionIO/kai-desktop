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
  | { type: 'CANCEL_AI_CREATE' };

const emptyOrder: KaiTaskOrder = {
  todo: [],
  in_progress: [],
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
        tasks: state.tasks.map((t) =>
          t.id === action.id ? { ...t, ...action.updates, id: action.id } : t,
        ),
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
  moveTaskToColumn: (
    taskId: string,
    targetStatus: KaiTaskStatus,
    sourceStatus: KaiTaskStatus,
  ) => void;

  /** Start the AI task creation flow — creates a placeholder task, streams plan. */
  startAITaskCreation: (userMessage: string) => Promise<void>;

  /** Send a follow-up message to refine the currently streaming task plan. */
  refineTaskPlan: (taskId: string, userMessage: string) => Promise<void>;

  /** Cancel any active AI plan stream. */
  cancelAIStream: () => void;

  /** Exit AI creation mode (reset state, keep the task). */
  exitAICreation: () => void;
}

const TaskContext = createContext<TaskContextValue | null>(null);

// ── Provider ─────────────────────────────────────────────────────────────

export const TaskProvider: FC<PropsWithChildren> = ({ children }) => {
  const [state, dispatch] = useReducer(taskReducer, initialState);
  const { config } = useConfig();
  const activeWorkspaceId = (config?.ui as { activeWorkspaceId?: string | null } | undefined)?.activeWorkspaceId ?? null;

  // Hydrate on mount
  useEffect(() => {
    if (!window.app?.tasks) {
      dispatch({ type: 'SET_LOADING', loading: false });
      return;
    }
    let cancelled = false;
    async function load() {
      try {
        const [tasks, order] = await Promise.all([
          app.tasks.list(),
          app.tasks.getOrder(),
        ]);
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
        const task = (await app.tasks.create({
          title: data.title,
          description: data.description,
          status: data.status ?? 'todo',
          metadata: data.metadata,
          workspaceId: activeWorkspaceId || undefined,
        }));
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
        const task = (await app.tasks.create({
          title: opts.title,
          description: opts.description,
          status: 'todo',
          sourceConversationId: opts.sourceConversationId,
          sourceToolCallId: opts.sourceToolCallId,
          metadata: opts.planFileName ? { planFileName: opts.planFileName } : undefined,
          workspaceId: activeWorkspaceId || undefined,
        }));
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
      const tasks = (await app.tasks.list());
      dispatch({ type: 'SET_TASKS', tasks });
    }
  }, []);

  const updateTaskStatus = useCallback(
    async (id: string, status: KaiTaskStatus) => {
      const now = new Date().toISOString();
      const task = state.tasks.find((t) => t.id === id);
      // Kill terminal when marking as done
      if (status === 'done') {
        if (task?.terminalSessionId) {
          void app.tasks.terminalKill(task.terminalSessionId);
          await updateTask(id, { status, terminalSessionId: undefined, completedAt: now });
          return;
        }
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
      const tasks = (await app.tasks.list());
      dispatch({ type: 'SET_TASKS', tasks });
    }
  }, []);

  const archiveTask = useCallback(async (id: string) => {
    try {
      dispatch({ type: 'DELETE_TASK', id }); // remove from active list optimistically
      await app.tasks.update(id, { archivedAt: new Date().toISOString() });
    } catch (err) {
      console.error('[TaskProvider] Failed to archive task:', err);
      const tasks = (await app.tasks.list());
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
        column = tasksInStatus
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
          .map((t) => t.id);
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
      // Optimistic status update
      const statusUpdates: Partial<TaskFile> =
        targetStatus === 'done'
          ? (() => {
              const task = state.tasks.find((t) => t.id === taskId);
              if (task?.terminalSessionId) {
                void app.tasks.terminalKill(task.terminalSessionId);
                return { status: targetStatus, terminalSessionId: undefined };
              }
              return { status: targetStatus };
            })()
          : { status: targetStatus };

      dispatch({ type: 'UPDATE_TASK', id: taskId, updates: statusUpdates });

      // Optimistic order update
      const currentOrder = { ...state.taskOrder };
      currentOrder[sourceStatus] = (currentOrder[sourceStatus] ?? []).filter(
        (id) => id !== taskId,
      );
      currentOrder[targetStatus] = [taskId, ...(currentOrder[targetStatus] ?? [])];
      dispatch({ type: 'SET_ORDER', order: currentOrder });

      // Persist both — reconcile on failure
      try {
        await Promise.all([
          app.tasks.update(taskId, statusUpdates),
          app.tasks.saveOrder(currentOrder),
        ]);
      } catch (err) {
        console.error('[TaskProvider] Failed to move task to column:', err);
        const tasks = (await app.tasks.list());
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

  const startAITaskCreation = useCallback(async (userMessage: string) => {
    try {
      // Create a placeholder task
      const task = (await app.tasks.create({
        title: 'Generating…',
        description: '',
        status: 'todo',
        workspaceId: activeWorkspaceId || undefined,
      }));
      if (!task || !task.id) return;

      dispatch({ type: 'START_AI_CREATE', taskId: task.id });

      // Generate title in parallel (non-blocking)
      void app.tasks.generateTitle(userMessage).then(({ title }) => {
        if (title) {
          dispatch({ type: 'UPDATE_TASK', id: task.id, updates: { title } });
          void app.tasks.update(task.id, { title });
        }
      });

      // Start streaming the plan
      await app.tasks.streamPlan(task.id, userMessage);
    } catch (err) {
      console.error('[TaskProvider] Failed to start AI task creation:', err);
      dispatch({ type: 'CANCEL_AI_CREATE' });
    }
  }, [activeWorkspaceId]);

  const refineTaskPlan = useCallback(async (taskId: string, userMessage: string) => {
    try {
      // Fetch fresh task from IPC to avoid stale closure over state.tasks
      const task = await app.tasks.get(taskId);
      const history = task?.conversationHistory ?? [];

      dispatch({ type: 'START_AI_CREATE', taskId });

      await app.tasks.streamPlan(taskId, userMessage, history);
    } catch (err) {
      console.error('[TaskProvider] Failed to refine task plan:', err);
      dispatch({ type: 'STREAM_DONE' });
    }
  }, []);

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
