/**
 * TaskProvider — React Context + useReducer store for the kanban board.
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

// ── Task Plan System Prompt ─────────────────────────────────────────────────
// Used as systemPromptOverride when routing task chat through agent:stream.

const TASK_PLAN_SYSTEM_PROMPT = `You are a task planning assistant. When a user describes work they want done, create a structured task plan.

Write the plan as clear, actionable markdown with this structure:

## Objective
One sentence summarizing the goal.

## Steps
1. First step — specific and actionable
2. Second step — with enough detail to execute
3. Continue as needed...

## Acceptance Criteria
- [ ] Criterion 1
- [ ] Criterion 2

## Notes
Any additional context, risks, or dependencies.

Rules:
- Be specific and actionable, not vague
- Include technical details where relevant
- Use markdown checkboxes for criteria
- Keep the plan concise but complete
- When the user sends follow-up messages, regenerate the FULL plan incorporating their feedback
- Always output the complete updated plan, never just a diff or partial update`;

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
  startAITaskCreation: (userMessage: string, metadata?: KaiTaskMetadata, runtime?: string) => Promise<void>;

  /** Send a follow-up message to refine the currently streaming task plan. */
  refineTaskPlan: (taskId: string, userMessage: string, runtime?: string) => Promise<void>;

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
          workspaceId: activeWorkspaceId ?? undefined,
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
          workspaceId: activeWorkspaceId ?? undefined,
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
      // Kill terminal when marking as done
      if (status === 'done') {
        const task = state.tasks.find((t) => t.id === id);
        if (task?.terminalSessionId) {
          void app.tasks.terminalKill(task.terminalSessionId);
          await updateTask(id, { status, terminalSessionId: undefined });
          return;
        }
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

  const selectTask = useCallback((id: string | null) => {
    dispatch({ type: 'SELECT_TASK', id });
  }, []);

  const reorderTasks = useCallback(
    (status: KaiTaskStatus, activeId: string, overId: string) => {
      const currentOrder = { ...state.taskOrder };
      const column = [...(currentOrder[status] ?? [])];

      const activeIdx = column.indexOf(activeId);
      const overIdx = column.indexOf(overId);
      if (activeIdx < 0 || overIdx < 0) return;

      column.splice(activeIdx, 1);
      column.splice(overIdx, 0, activeId);
      currentOrder[status] = column;

      dispatch({ type: 'SET_ORDER', order: currentOrder });
      void app.tasks.saveOrder(currentOrder);
    },
    [state.taskOrder],
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

  // Subscribe to agent stream events for task plan generation
  useEffect(() => {
    if (!window.app?.agent?.onStreamEvent) return;
    const unsub = app.agent.onStreamEvent((evt: unknown) => {
      const event = evt as { conversationId?: string; type?: string; text?: string; error?: string };
      // Only process events for task plan conversations (namespaced with 'task-plan:')
      const taskId = creatingTaskIdRef.current;
      if (!taskId) return;
      if (event.conversationId !== `task-plan:${taskId}`) return;

      switch (event.type) {
        case 'text-delta':
          if (event.text) dispatch({ type: 'STREAM_TEXT_DELTA', text: event.text });
          break;
        case 'done':
          dispatch({ type: 'STREAM_DONE' });
          break;
        case 'error':
          console.error('[TaskProvider] Stream error:', event.error);
          dispatch({ type: 'STREAM_DONE' });
          break;
      }
    });
    return unsub;
  }, []);

  const startAITaskCreation = useCallback(async (userMessage: string, metadata?: KaiTaskMetadata, runtime?: string) => {
    try {
      // Create a placeholder task
      const task = (await app.tasks.create({
        title: 'Generating…',
        description: '',
        status: 'todo',
        metadata,
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

      // Map terminal runtime names to agent runtime IDs
      const runtimeOverride = runtime === 'codex' ? 'codex-sdk'
        : runtime === 'claude-code' ? 'claude-agent-sdk'
        : runtime === 'mastra' ? 'mastra'
        : null;

      // Build messages for agent:stream
      const messages = [{ role: 'user', content: userMessage }];

      // Route through the main agent:stream pipeline
      await app.agent.stream(
        `task-plan:${task.id}`,
        messages,
        undefined, // modelKey — use default
        undefined, // reasoningEffort
        undefined, // profileKey
        false,     // fallbackEnabled
        metadata?.cwd ?? undefined,
        'auto',    // executionMode
        {
          runtimeOverride,
          systemPromptOverride: TASK_PLAN_SYSTEM_PROMPT,
        },
      );
    } catch (err) {
      console.error('[TaskProvider] Failed to start AI task creation:', err);
      dispatch({ type: 'CANCEL_AI_CREATE' });
    }
  }, []);

  const refineTaskPlan = useCallback(async (taskId: string, userMessage: string, runtime?: string) => {
    try {
      // Fetch fresh task from IPC to avoid stale closure over state.tasks
      const task = await app.tasks.get(taskId);
      const history = task?.conversationHistory ?? [];

      dispatch({ type: 'START_AI_CREATE', taskId });

      // Map terminal runtime names to agent runtime IDs
      const runtimeOverride = runtime === 'codex' ? 'codex-sdk'
        : runtime === 'claude-code' ? 'claude-agent-sdk'
        : runtime === 'mastra' ? 'mastra'
        : null;

      // Build messages from conversation history + new user message
      const messages = [
        ...history.map((msg: { role: string; content: string }) => ({ role: msg.role, content: msg.content })),
        { role: 'user', content: userMessage },
      ];

      // Route through the main agent:stream pipeline
      await app.agent.stream(
        `task-plan:${taskId}`,
        messages,
        undefined, // modelKey — use default
        undefined, // reasoningEffort
        undefined, // profileKey
        false,     // fallbackEnabled
        task?.metadata?.cwd ?? undefined,
        'auto',    // executionMode
        {
          runtimeOverride,
          systemPromptOverride: TASK_PLAN_SYSTEM_PROMPT,
        },
      );
    } catch (err) {
      console.error('[TaskProvider] Failed to refine task plan:', err);
      dispatch({ type: 'STREAM_DONE' });
    }
  }, []);

  const cancelAIStream = useCallback(() => {
    if (state.creatingTaskId) {
      void app.agent.cancelStream(`task-plan:${state.creatingTaskId}`);
    }
    dispatch({ type: 'CANCEL_AI_CREATE' });
  }, [state.creatingTaskId]);

  const exitAICreation = useCallback(() => {
    if (state.isStreamingPlan && state.creatingTaskId) {
      void app.agent.cancelStream(`task-plan:${state.creatingTaskId}`);
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
