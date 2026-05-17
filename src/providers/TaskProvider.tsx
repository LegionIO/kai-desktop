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
import type { CouncilMessage } from '../../shared/task-types';

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
  /** Council messages per task (taskId → messages). */
  councilMessages: Record<string, CouncilMessage[]>;
  /** Current council phase per task. */
  councilPhase: Record<string, string>;
  /** Current speaking agent per task. */
  councilAgent: Record<string, string>;
  /** Whether council deliberation is active per task. */
  isDeliberating: Record<string, boolean>;
  /** Currently streaming council message per task (in-progress agent response). */
  councilStreaming: Record<string, { agent: string; phase: string; content: string } | null>;
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
  | { type: 'COUNCIL_MESSAGE'; taskId: string; message: CouncilMessage }
  | { type: 'COUNCIL_PHASE_CHANGE'; taskId: string; phase: string }
  | { type: 'COUNCIL_AGENT_CHANGE'; taskId: string; agent: string }
  | { type: 'COUNCIL_START'; taskId: string }
  | { type: 'COUNCIL_RESUME'; taskId: string }
  | { type: 'COUNCIL_DONE'; taskId: string }
  | { type: 'COUNCIL_STREAM_DELTA'; taskId: string; agent: string; phase: string; content: string }
  | { type: 'COUNCIL_STREAM_CLEAR'; taskId: string };

const emptyOrder: KaiTaskOrder = {
  todo: [],
  awaiting_approval: [],
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
  councilMessages: {},
  councilPhase: {},
  councilAgent: {},
  isDeliberating: {},
  councilStreaming: {},
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
    case 'COUNCIL_START':
      return {
        ...state,
        isDeliberating: { ...state.isDeliberating, [action.taskId]: true },
        councilMessages: { ...state.councilMessages, [action.taskId]: [] },
        councilStreaming: { ...state.councilStreaming, [action.taskId]: null },
      };
    case 'COUNCIL_RESUME':
      return {
        ...state,
        isDeliberating: { ...state.isDeliberating, [action.taskId]: true },
      };
    case 'COUNCIL_MESSAGE': {
      const existing = state.councilMessages[action.taskId] ?? [];
      return {
        ...state,
        councilMessages: { ...state.councilMessages, [action.taskId]: [...existing, action.message] },
      };
    }
    case 'COUNCIL_PHASE_CHANGE':
      return {
        ...state,
        councilPhase: { ...state.councilPhase, [action.taskId]: action.phase },
      };
    case 'COUNCIL_AGENT_CHANGE':
      return {
        ...state,
        councilAgent: { ...state.councilAgent, [action.taskId]: action.agent },
      };
    case 'COUNCIL_DONE':
      return {
        ...state,
        isDeliberating: { ...state.isDeliberating, [action.taskId]: false },
        councilStreaming: { ...state.councilStreaming, [action.taskId]: null },
      };
    case 'COUNCIL_STREAM_DELTA':
      return {
        ...state,
        councilStreaming: {
          ...state.councilStreaming,
          [action.taskId]: {
            agent: action.agent,
            phase: action.phase,
            content: action.content,
          },
        },
      };
    case 'COUNCIL_STREAM_CLEAR':
      return {
        ...state,
        councilStreaming: { ...state.councilStreaming, [action.taskId]: null },
      };
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
  startAITaskCreation: (userMessage: string, metadata?: KaiTaskMetadata) => Promise<void>;

  /** Send a follow-up message to refine the currently streaming task plan. */
  refineTaskPlan: (taskId: string, userMessage: string) => Promise<void>;

  /** Cancel any active AI plan stream. */
  cancelAIStream: () => void;

  /** Exit AI creation mode (reset state, keep the task). */
  exitAICreation: () => void;

  /** Approve a council plan and start execution. */
  approveCouncil: (taskId: string) => Promise<{ ok: boolean; error?: string }>;

  /** Respond to council (answer advisor's clarification questions). */
  councilRespond: (taskId: string, message: string) => Promise<{ ok: boolean; error?: string }>;

  /** Get council messages for a specific task. */
  getCouncilMessages: (taskId: string) => CouncilMessage[];

  /** Check if council is actively deliberating for a task. */
  isTaskDeliberating: (taskId: string) => boolean;

  /** Get the current council phase for a task. */
  getCouncilPhase: (taskId: string) => string;

  /** Get the currently speaking council agent for a task. */
  getCouncilAgent: (taskId: string) => string;

  /** Get the live-streaming council message for a task (in-progress agent response). */
  getCouncilStreaming: (taskId: string) => { agent: string; phase: string; content: string } | null;
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
            awaiting_approval: [],
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

  const startAITaskCreation = useCallback(async (userMessage: string, metadata?: KaiTaskMetadata) => {
    try {
      // Create task with user's message as description — this goes directly to council.
      // The council (Aithena) will handle orchestration: gather, plan, review, approve.
      const task = (await app.tasks.create({
        title: userMessage.slice(0, 120),  // Use user's message as initial title
        description: userMessage,           // Full message as description for council
        status: 'todo',
        workspaceId: activeWorkspaceId || undefined,
        metadata,
      }));
      if (!task || !task.id) return;

      // Signal that task was created so TaskCreationView can transition to detail view
      dispatch({ type: 'START_AI_CREATE', taskId: task.id });

      // Council triggers on task_created via the plugin lifecycle hook.
      // It will see the full user message in title + description.
      // No separate streamPlan needed — council handles everything.
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

  // ── Council Event Subscription ────────────────────────────────────────

  // Buffer for accumulating agent_delta content before flushing as a full message
  const councilBufferRef = useRef<Record<string, { agent: string; phase: string; content: string }>>({});
  // Keep a ref to councilMessages so event handlers can check for duplicates without deps
  const councilMessagesRef = useRef(state.councilMessages);
  councilMessagesRef.current = state.councilMessages;
  // Throttle streaming dispatches using rAF batching (~16ms)
  const streamingRafRef = useRef<Record<string, number>>({});

  useEffect(() => {
    if (!window.app?.plugins?.onEvent) {
      console.warn('[TaskProvider] plugins.onEvent NOT available — council events will not render');
      return;
    }
    const unsub = app.plugins.onEvent((evt: unknown) => {
      const e = evt as { pluginName?: string; eventName?: string; data?: unknown };
      if (e.eventName !== 'council:message' && e.eventName !== 'council:result') return;

      // Handle council:result — apply status/title/description from re-deliberation
      if (e.eventName === 'council:result') {
        const { taskId: resultTaskId, result: councilResult } = (e.data ?? {}) as {
          taskId?: string;
          result?: {
            sessionId?: string;
            reviewOutcome?: string;
            planArtifact?: string;
            clarificationRequired?: boolean;
            clarificationQuestions?: string;
          };
        };
        if (!resultTaskId || !councilResult) return;

        // If still requesting clarification, update metadata but don't apply title/status changes
        if (councilResult.clarificationRequired) {
          app.tasks.get(resultTaskId).then((currentTask) => {
            if (!currentTask) return;
            const existingMeta = (currentTask.metadata ?? {}) as Record<string, unknown>;
            const mergedMeta = {
              ...existingMeta,
              councilSessionId: councilResult.sessionId,
              councilPhase: 'awaiting_clarification',
              councilQuestions: councilResult.clarificationQuestions,
            };
            return app.tasks.update(resultTaskId, { metadata: mergedMeta } as Partial<TaskFile>);
          }).then((updatedTask) => {
            if (updatedTask) {
              dispatch({ type: 'UPDATE_TASK', id: resultTaskId, updates: updatedTask as Partial<TaskFile> });
            }
          }).catch((err) => {
            console.error('[TaskProvider] Failed to update task after council clarification:', err);
          });
          // Don't dispatch COUNCIL_DONE — keep composer active
          dispatch({ type: 'COUNCIL_PHASE_CHANGE', taskId: resultTaskId, phase: 'awaiting_clarification' });
          return;
        }

        // Extract plan title (same logic as plugin's extractPlanTitle)
        const planTitle = extractPlanTitleFromArtifact(councilResult.planArtifact ?? '');

        // Fetch current task to merge metadata (spread in IPC handler overwrites entire metadata)
        app.tasks.get(resultTaskId).then((currentTask) => {
          if (!currentTask) return;

          const existingMeta = (currentTask.metadata ?? {}) as Record<string, unknown>;
          const mergedMeta = {
            ...existingMeta,
            councilSessionId: councilResult.sessionId,
            councilOutcome: councilResult.reviewOutcome,
            councilPlan: (councilResult.planArtifact ?? '').slice(0, 8000),
            councilPlanTitle: planTitle || existingMeta.councilPlanTitle,
            councilPhase: councilResult.reviewOutcome === 'approved' ? 'approved' : councilResult.reviewOutcome,
          };

          const updates: Record<string, unknown> = {
            metadata: mergedMeta,
          };

          // Don't override title — keep user's original intent as task title
          if (councilResult.planArtifact) {
            updates.description = councilResult.planArtifact;
          }

          // Auto-execute: council approved → go straight to execution (no human review gate)
          if (councilResult.reviewOutcome === 'approved') {
            updates.status = 'awaiting_approval'; // Temporarily — approve-council will flip to in_progress
          }

          return app.tasks.update(resultTaskId, updates as Partial<TaskFile>);
        }).then((updatedTask) => {
          if (updatedTask) {
            dispatch({ type: 'UPDATE_TASK', id: resultTaskId, updates: updatedTask as Partial<TaskFile> });
          }
          // Auto-approve if council approved — starts execution immediately
          if (councilResult.reviewOutcome === 'approved') {
            app.tasks.approveCouncil(resultTaskId).catch((err) => {
              console.error('[TaskProvider] Auto-approve failed:', err);
            });
          }
        }).catch((err) => {
          console.error('[TaskProvider] Failed to update task after council:result:', err);
        });

        dispatch({ type: 'COUNCIL_DONE', taskId: resultTaskId });
        return;
      }

      const { taskId, event } = (e.data ?? {}) as {
        taskId?: string;
        event?: {
          type: string;
          agent?: string;
          phase?: string;
          content?: string;
          data?: Record<string, unknown>;
        };
      };
      if (!taskId || !event) return;

      switch (event.type) {
        case 'session_start': {
          dispatch({ type: 'COUNCIL_START', taskId });
          // Show the user's original message at the top of the council chat
          const taskTitle = event.data?.task_title as string;
          if (taskTitle) {
            dispatch({
              type: 'COUNCIL_MESSAGE',
              taskId,
              message: {
                id: `${taskId}-${Date.now()}-user-init`,
                agent: 'user',
                phase: '',
                content: taskTitle,
                timestamp: new Date().toISOString(),
                type: 'text',
              },
            });
          }
          break;
        }

        case 'session_resumed':
          dispatch({ type: 'COUNCIL_RESUME', taskId });
          break;

        case 'phase_change':
          dispatch({ type: 'COUNCIL_PHASE_CHANGE', taskId, phase: event.phase ?? event.data?.phase as string ?? '' });
          break;

        case 'agent_start': {
          const agent = event.agent ?? '';
          dispatch({ type: 'COUNCIL_AGENT_CHANGE', taskId, agent });
          // Initialize buffer for this task+agent
          councilBufferRef.current[taskId] = {
            agent,
            phase: event.phase ?? '',
            content: '',
          };
          // Initialize streaming state — shows live-updating bubble immediately
          dispatch({
            type: 'COUNCIL_STREAM_DELTA',
            taskId,
            agent,
            phase: event.phase ?? '',
            content: '',
          });
          break;
        }

        case 'agent_delta': {
          // Accumulate into buffer
          const buf = councilBufferRef.current[taskId];
          if (buf) {
            buf.content += event.content ?? '';
            // Throttle streaming UI updates via rAF (~16ms batching)
            if (!streamingRafRef.current[taskId]) {
              streamingRafRef.current[taskId] = requestAnimationFrame(() => {
                delete streamingRafRef.current[taskId];
                const currentBuf = councilBufferRef.current[taskId];
                if (currentBuf) {
                  dispatch({
                    type: 'COUNCIL_STREAM_DELTA',
                    taskId,
                    agent: currentBuf.agent,
                    phase: currentBuf.phase,
                    content: currentBuf.content,
                  });
                }
              });
            }
          }
          break;
        }

        case 'agent_done': {
          // Cancel any pending rAF for this task
          if (streamingRafRef.current[taskId]) {
            cancelAnimationFrame(streamingRafRef.current[taskId]);
            delete streamingRafRef.current[taskId];
          }
          // Clear streaming state — the final message replaces the live bubble
          dispatch({ type: 'COUNCIL_STREAM_CLEAR', taskId });

          // Flush buffer as a complete message.
          // Falls back to event.content for cases where agent_done arrives without
          // preceding agent_delta (history restoration, user clarification responses).
          const buf = councilBufferRef.current[taskId];
          const content = (buf?.content?.trim()) || (event.content?.trim()) || '';
          const agent = event.agent ?? buf?.agent ?? 'aithena';
          const phase = event.phase ?? buf?.phase ?? '';

          if (content) {
            // Deduplicate user messages — prevent echo from fetch-history re-emitting
            // messages that were already added by councilRespond's local dispatch.
            if (agent === 'user') {
              const existing = councilMessagesRef.current[taskId] ?? [];
              const isDuplicate = existing.some(
                (m) => m.agent === 'user' && m.content === content,
              );
              if (isDuplicate) {
                delete councilBufferRef.current[taskId];
                break;
              }
            }

            const msgType = agent === 'aidan' ? 'plan' as const
              : agent === 'airen' ? 'review' as const
              : 'text' as const;

            dispatch({
              type: 'COUNCIL_MESSAGE',
              taskId,
              message: {
                id: `${taskId}-${Date.now()}-${agent}`,
                agent: (agent as 'aithena' | 'aidan' | 'airen' | 'user') || 'aithena',
                phase,
                content,
                timestamp: new Date().toISOString(),
                type: msgType,
              },
            });
          }
          delete councilBufferRef.current[taskId];
          break;
        }

        case 'review_outcome': {
          const outcome = event.data?.outcome as string ?? 'unknown';
          dispatch({
            type: 'COUNCIL_MESSAGE',
            taskId,
            message: {
              id: `${taskId}-${Date.now()}-outcome`,
              agent: 'aithena',
              phase: 'advisor_signoff',
              content: `Council outcome: **${outcome}**`,
              timestamp: new Date().toISOString(),
              type: 'outcome',
            },
          });
          dispatch({ type: 'COUNCIL_DONE', taskId });
          break;
        }

        case 'clarification_required': {
          // Advisor gate fired — advisor's questions are already in council messages
          // (flushed via agent_done buffer). Don't add a duplicate message.
          // Just set phase + clear agent to stop "thinking" indicator.
          dispatch({ type: 'COUNCIL_PHASE_CHANGE', taskId, phase: 'awaiting_clarification' });
          dispatch({ type: 'COUNCIL_AGENT_CHANGE', taskId, agent: '' });
          break;
        }
      }
    });
    return unsub;
  }, []);

  // ── Council Session History Restoration ──────────────────────────────────
  // When a task is selected and has a council session but no messages in memory,
  // fetch the session transcript from the server to restore the conversation.
  // Track which tasks we've already fetched history for to prevent re-fetching.
  const fetchedHistoryRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!state.selectedTaskId) return;
    const task = state.tasks.find(t => t.id === state.selectedTaskId);
    if (!task) return;

    const meta = task.metadata as Record<string, unknown> | undefined;
    const sessionId = meta?.councilSessionId as string | undefined;
    if (!sessionId) return;

    // Don't fetch if deliberation is currently active (live events are flowing)
    if (state.isDeliberating[task.id]) return;

    // Don't re-fetch if we already fetched for this task+session combo
    const fetchKey = `${task.id}:${sessionId}`;
    if (fetchedHistoryRef.current.has(fetchKey)) return;

    // Only fetch if we have no messages cached in memory for this task
    const existingMessages = state.councilMessages[task.id];
    if (existingMessages && existingMessages.length > 0) return;

    fetchedHistoryRef.current.add(fetchKey);

    // Trigger the plugin action to fetch session history.
    // Pass task metadata so the plugin can reconstruct from local data if server is unreachable.
    // Retry once after 1.5s if the first call fails (startup race: plugin may not be ready yet)
    const fetchHistory = () => app.plugins?.action?.('aithena', 'council:fetch-history', 'fetch', {
      sessionId,
      taskId: task.id,
      taskMetadata: meta,
    });

    fetchHistory()?.catch((err) => {
      console.warn('[TaskProvider:restore] First fetch-history attempt failed:', err);
      // Retry once after delay — plugin may still be loading at startup
      setTimeout(() => {
        fetchHistory()?.catch((err2) => {
          console.warn('[TaskProvider:restore] Retry also failed:', err2);
          // Allow retry on next selection
          fetchedHistoryRef.current.delete(fetchKey);
        });
      }, 1500);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.selectedTaskId, state.tasks]);

  // ── Council Actions ────────────────────────────────────────────────────

  const approveCouncil = useCallback(async (taskId: string): Promise<{ ok: boolean; error?: string }> => {
    try {
      const result = await app.tasks.approveCouncil(taskId);
      return result;
    } catch (err) {
      console.error('[TaskProvider] Failed to approve council:', err);
      return { ok: false, error: String(err) };
    }
  }, []);

  const councilRespond = useCallback(async (taskId: string, message: string): Promise<{ ok: boolean; error?: string }> => {
    // Immediately add the user's message to the council chat so they see their own input
    dispatch({
      type: 'COUNCIL_MESSAGE',
      taskId,
      message: {
        id: `${taskId}-${Date.now()}-user`,
        agent: 'user',
        phase: '',
        content: message,
        timestamp: new Date().toISOString(),
        type: 'text',
      },
    });
    // Show "thinking" indicator immediately after user sends
    dispatch({ type: 'COUNCIL_RESUME', taskId });
    dispatch({ type: 'COUNCIL_PHASE_CHANGE', taskId, phase: 'gathering' });

    try {
      const result = await app.tasks.councilRespond(taskId, message);
      return result;
    } catch (err) {
      console.error('[TaskProvider] Failed to respond to council:', err);
      return { ok: false, error: String(err) };
    }
  }, []);

  const getCouncilMessages = useCallback((taskId: string): CouncilMessage[] => {
    return state.councilMessages[taskId] ?? [];
  }, [state.councilMessages]);

  const isTaskDeliberating = useCallback((taskId: string): boolean => {
    return state.isDeliberating[taskId] ?? false;
  }, [state.isDeliberating]);

  const getCouncilPhase = useCallback((taskId: string): string => {
    return state.councilPhase[taskId] ?? '';
  }, [state.councilPhase]);

  const getCouncilAgent = useCallback((taskId: string): string => {
    return state.councilAgent[taskId] ?? '';
  }, [state.councilAgent]);

  const getCouncilStreaming = useCallback((taskId: string) => {
    return state.councilStreaming[taskId] ?? null;
  }, [state.councilStreaming]);

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
      approveCouncil,
      councilRespond,
      getCouncilMessages,
      isTaskDeliberating,
      getCouncilPhase,
      getCouncilAgent,
      getCouncilStreaming,
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
      approveCouncil,
      councilRespond,
      getCouncilMessages,
      isTaskDeliberating,
      getCouncilPhase,
      getCouncilAgent,
      getCouncilStreaming,
    ],
  );

  return <TaskContext.Provider value={value}>{children}</TaskContext.Provider>;
};

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Extract a meaningful title from a council plan artifact (first heading or "Plan:" line). */
function extractPlanTitleFromArtifact(plan: string): string | null {
  if (!plan) return null;
  const lines = plan.split('\n');
  let firstHeading: string | null = null;
  let planLine: string | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#') && !firstHeading) {
      firstHeading = trimmed.replace(/^#+\s*/, '').slice(0, 120);
    }
    if (!planLine && /^Plan[\s:v]/i.test(trimmed)) {
      planLine = trimmed
        .replace(/^Plan\s*(?:v[\d.]+)?\s*[—–-]\s*/i, '')
        .replace(/^Plan:\s*/i, '')
        .slice(0, 120);
    }
  }

  // Reject titles that are just meta-planning noise or contain "New Task"
  const isUseless = (t: string) =>
    /\bnew task\b/i.test(t) ||
    /\btask clarification\b/i.test(t) ||
    /\breadiness plan\b/i.test(t) ||
    /\bplaceholder\b/i.test(t);

  if (planLine && planLine.length > 5 && !isUseless(planLine)) return planLine;
  if (firstHeading && firstHeading.length > 5 && !isUseless(firstHeading)) return firstHeading;

  for (const line of lines) {
    const trimmed = line.trim();
    if (
      trimmed.length > 5
      && !trimmed.startsWith('Acknowledged')
      && !trimmed.startsWith('---')
      && !trimmed.startsWith('#')
      && !isUseless(trimmed)
    ) {
      return trimmed.slice(0, 120);
    }
  }
  return null;
}

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
