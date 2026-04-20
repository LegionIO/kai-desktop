import {
  createContext,
  useContext,
  useState,
  useCallback,
  useMemo,
  useEffect,
  useRef,
  type ReactNode,
} from 'react';
import type {
  WorkspaceProject,
  WorkspaceTask,
  InstalledPlugin,
  WorkspaceEngine,
  TaskStatus,
  TaskPriority,
  ReviewComment,
  WorkspaceTerminalInfo,
  Idea,
  RoadmapPhase,
  InsightMessage,
  ChangelogRelease,
  ExecutionEntryType,
  ExecutionEntry,
  TaskPlan,
} from '../../shared/workspace-types';
import { streamWorkspaceEngine, extractJsonFromResponse } from '@/lib/workspace-agent';
import { app } from '@/lib/ipc-client';

/** Execution state for a task currently being worked by the LLM agent. */
export type TaskExecutionState = {
  taskId: string;
  status: 'running' | 'done' | 'error';
  output: string[];
  activeToolName: string | null;
  cancel: (() => void) | null;
};

/** Streaming state for a workspace engine (insights, roadmap, etc.). Lives in the provider so it survives tab switches. */
export type EngineStreamState = {
  engine: string;
  status: 'idle' | 'streaming' | 'done' | 'error';
  activeToolName: string | null;
  toolHistory: string[];
  accumulated: string;
  lineCount: number;
  error?: string;
};

type StartEngineStreamOpts = {
  engine: string;
  prompt: string;
  freshConversation?: boolean;
  /** Called with each text delta — use for engines that stream text into messages (e.g. insights). */
  onTextDelta?: (delta: string) => void;
  /** Called when the stream completes with the full accumulated text. Parse results here. */
  onComplete?: (accumulated: string) => void;
  /** Called on error. */
  onError?: (error: string) => void;
};

interface WorkspaceContextValue {
  // Project
  project: WorkspaceProject | null;
  setProject: (project: WorkspaceProject | null) => void;

  // Navigation
  activeEngine: WorkspaceEngine;
  setActiveEngine: (engine: WorkspaceEngine) => void;
  selectedTaskId: string | null;
  setSelectedTaskId: (id: string | null) => void;

  // Tasks
  tasks: WorkspaceTask[];
  addTask: (title: string, description: string, priority: TaskPriority, labels?: string[]) => void;
  createTaskFromNaturalLanguage: (text: string) => Promise<void>;
  generatePlan: (taskId: string) => void;
  approvePlan: (taskId: string) => void;
  updateTaskStatus: (taskId: string, status: TaskStatus) => void;
  removeTask: (taskId: string) => void;

  // Feature #11: Autonomous Task Execution
  executeTask: (taskId: string) => Promise<void>;
  reviewTask: (taskId: string, approved: boolean) => Promise<void>;
  mergeTask: (taskId: string) => Promise<{ success: boolean; error?: string }>;

  // Task execution state (for task cards to consume)
  taskExecutions: Map<string, TaskExecutionState>;

  // Task-spawned terminals (kept for manual terminal grid)
  workspaceTerminals: WorkspaceTerminalInfo[];

  // Feature #13: AI-Powered Review
  autoReviewEnabled: boolean;
  setAutoReviewEnabled: (enabled: boolean) => void;

  // Feature #14: Cross-Engine Linking
  convertIdeaToTask: (ideaId: string, title: string, description: string, priority: TaskPriority) => void;
  convertFeatureToTask: (featureId: string, title: string, description: string, priority: TaskPriority) => void;

  // Plugins
  plugins: InstalledPlugin[];
  installPlugin: (plugin: InstalledPlugin) => void;
  removePlugin: (pluginId: string) => void;
  togglePlugin: (pluginId: string) => void;
  updatePluginConfig: (pluginId: string, config: Record<string, unknown>) => void;

  // Plugin capabilities flattened for LLM context
  allCapabilities: Array<{ pluginId: string; pluginName: string; capabilityId: string; name: string; description: string }>;

  // Persisted engine state (survives tab switches)
  ideas: Idea[];
  setIdeas: (ideas: Idea[]) => void;
  roadmapPhases: RoadmapPhase[];
  setRoadmapPhases: (phases: RoadmapPhase[]) => void;
  insightMessages: InsightMessage[];
  setInsightMessages: (messages: InsightMessage[] | ((prev: InsightMessage[]) => InsightMessage[])) => void;
  changelogReleases: ChangelogRelease[];
  setChangelogReleases: (releases: ChangelogRelease[]) => void;

  // Engine stream state (survives tab switches)
  engineStreams: Map<string, EngineStreamState>;
  startEngineStream: (opts: StartEngineStreamOpts) => void;
  cancelEngineStream: (engine: string) => void;
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

export function useWorkspace() {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) throw new Error('useWorkspace must be used within WorkspaceProvider');
  return ctx;
}

function makeId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [project, setProject] = useState<WorkspaceProject | null>(null);
  const [activeEngine, setActiveEngine] = useState<WorkspaceEngine>('tasks');
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [tasks, setTasks] = useState<WorkspaceTask[]>([]);
  const [plugins, setPlugins] = useState<InstalledPlugin[]>([]);
  const [autoReviewEnabled, setAutoReviewEnabled] = useState(true);
  const [taskExecutions, setTaskExecutions] = useState<Map<string, TaskExecutionState>>(new Map());
  const [workspaceTerminals, setWorkspaceTerminals] = useState<WorkspaceTerminalInfo[]>([]);

  // Persisted engine state (survives tab switches)
  const [ideas, setIdeas] = useState<Idea[]>([]);
  const [roadmapPhases, setRoadmapPhases] = useState<RoadmapPhase[]>([]);
  const [insightMessages, setInsightMessages] = useState<InsightMessage[]>([]);
  const [changelogReleases, setChangelogReleases] = useState<ChangelogRelease[]>([]);

  // Track active review timers so we can clean them up
  const reviewTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  // Track active stream cancellers for task execution
  const executionCancels = useRef<Map<string, () => void>>(new Map());

  // ── Task Persistence ───────────────────────────────────
  // Load tasks from disk when project changes
  useEffect(() => {
    if (!project?.path) {
      setTasks([]);
      return;
    }
    app.workspaceTasks.list(project.path).then((loaded) => {
      // Ensure loaded tasks have executionThread (migration for old data)
      const migrated = loaded.map((t) => ({ ...t, executionThread: t.executionThread ?? [] }));
      setTasks(migrated);
    }).catch(() => setTasks([]));

    // Subscribe to changes from other windows
    const unsub = app.workspaceTasks.onChanged((data) => {
      if (data.projectPath === project.path) {
        app.workspaceTasks.list(project.path).then((loaded) => {
          const migrated = loaded.map((t) => ({ ...t, executionThread: t.executionThread ?? [] }));
          setTasks(migrated);
        }).catch(() => {});
      }
    });
    return unsub;
  }, [project?.path]);

  // Helper: persist a single task to disk (fire-and-forget)
  const persistTask = useCallback((task: WorkspaceTask) => {
    if (!project?.path) return;
    app.workspaceTasks.put(project.path, task).catch(() => {});
  }, [project?.path]);

  const deleteTaskFromDisk = useCallback((taskId: string) => {
    if (!project?.path) return;
    app.workspaceTasks.delete(project.path, taskId).catch(() => {});
  }, [project?.path]);

  // ── Engine stream state (survives tab switches) ─────────

  const [engineStreams, setEngineStreams] = useState<Map<string, EngineStreamState>>(new Map());
  // Store cancel functions and view callbacks in refs (not serialized into state)
  const engineCancels = useRef<Map<string, () => void>>(new Map());
  const engineCallbacks = useRef<Map<string, { onTextDelta?: (d: string) => void; onComplete?: (a: string) => void; onError?: (e: string) => void }>>(new Map());

  const updateEngineStream = useCallback((engine: string, update: Partial<EngineStreamState>) => {
    setEngineStreams((prev) => {
      const existing = prev.get(engine);
      if (!existing) return prev;
      const next = new Map(prev);
      next.set(engine, { ...existing, ...update });
      return next;
    });
  }, []);

  const startEngineStream = useCallback((opts: StartEngineStreamOpts) => {
    if (!project) return;
    const { engine, prompt, freshConversation, onTextDelta, onComplete, onError } = opts;

    // Cancel any existing stream for this engine
    const existingCancel = engineCancels.current.get(engine);
    if (existingCancel) existingCancel();

    // Initialize stream state
    const initial: EngineStreamState = {
      engine,
      status: 'streaming',
      activeToolName: null,
      toolHistory: [],
      accumulated: '',
      lineCount: 0,
    };
    setEngineStreams((prev) => new Map(prev).set(engine, initial));

    // Store view callbacks in ref so they can be called even after tab switch
    engineCallbacks.current.set(engine, { onTextDelta, onComplete, onError });

    const cancel = streamWorkspaceEngine({
      workspaceId: project.path,
      engine,
      userMessage: prompt,
      projectPath: project.path,
      freshConversation,
      onTextDelta: (delta) => {
        setEngineStreams((prev) => {
          const s = prev.get(engine);
          if (!s) return prev;
          const newAccum = s.accumulated + delta;
          const next = new Map(prev);
          next.set(engine, { ...s, accumulated: newAccum, lineCount: newAccum.split('\n').length, activeToolName: null });
          return next;
        });
        // Forward to view callback if still registered
        engineCallbacks.current.get(engine)?.onTextDelta?.(delta);
      },
      onToolCall: (_id, toolName) => {
        setEngineStreams((prev) => {
          const s = prev.get(engine);
          if (!s) return prev;
          const next = new Map(prev);
          next.set(engine, { ...s, activeToolName: toolName, toolHistory: [...s.toolHistory.slice(-9), toolName] });
          return next;
        });
      },
      onToolResult: () => {
        updateEngineStream(engine, { activeToolName: null });
      },
      onDone: () => {
        // Read accumulated from the latest state, then call onComplete outside the updater
        let accumulated = '';
        setEngineStreams((prev) => {
          const s = prev.get(engine);
          accumulated = s?.accumulated ?? '';
          const next = new Map(prev);
          next.set(engine, { ...(s ?? initial), status: 'done', activeToolName: null });
          return next;
        });

        // Call view's onComplete OUTSIDE the state updater to avoid double-fire in strict mode
        setTimeout(() => {
          engineCallbacks.current.get(engine)?.onComplete?.(accumulated);
        }, 0);
        engineCancels.current.delete(engine);
      },
      onError: (error) => {
        updateEngineStream(engine, { status: 'error', activeToolName: null, error });
        engineCallbacks.current.get(engine)?.onError?.(error);
        engineCancels.current.delete(engine);
      },
    });

    engineCancels.current.set(engine, cancel);
  }, [project, updateEngineStream]);

  const cancelEngineStream = useCallback((engine: string) => {
    const cancel = engineCancels.current.get(engine);
    if (cancel) {
      cancel();
      engineCancels.current.delete(engine);
    }
    updateEngineStream(engine, { status: 'idle', activeToolName: null });
  }, [updateEngineStream]);

  // Cleanup timers and streams on unmount
  useEffect(() => {
    return () => {
      for (const timer of reviewTimers.current.values()) {
        clearTimeout(timer);
      }
      for (const cancel of executionCancels.current.values()) {
        cancel();
      }
      for (const cancel of engineCancels.current.values()) {
        cancel();
      }
    };
  }, []);

  // ── Task CRUD ────────────────────────────────────────────

  const addTask = useCallback((title: string, description: string, priority: TaskPriority, labels?: string[]) => {
    if (!title.trim()) return;
    const task: WorkspaceTask = {
      id: makeId(),
      title: title.trim(),
      description: description.trim(),
      status: 'defining',
      priority,
      labels: labels ?? [],
      executionThread: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    setTasks((prev) => [...prev, task]);
    persistTask(task);
  }, [persistTask]);

  const nlParsingRef = useRef(false);

  const createTaskFromNaturalLanguage = useCallback(async (text: string) => {
    if (nlParsingRef.current) return;
    nlParsingRef.current = true;

    if (!project) {
      addTask(text, text, 'medium');
      nlParsingRef.current = false;
      return;
    }
    return new Promise<void>((resolve) => {
      startEngineStream({
        engine: 'task-parse',
        prompt: text,
        freshConversation: true,
        onComplete: (accumulated) => {
          try {
            const parsed = extractJsonFromResponse(accumulated) as { title?: string; description?: string; priority?: string; labels?: string[] } | null;
            if (parsed?.title) {
              addTask(
                parsed.title,
                parsed.description ?? text,
                (parsed.priority as TaskPriority) ?? 'medium',
                parsed.labels ?? [],
              );
            } else {
              addTask(text, text, 'medium');
            }
          } catch {
            addTask(text, text, 'medium');
          }
          nlParsingRef.current = false;
          resolve();
        },
        onError: () => {
          addTask(text, text, 'medium');
          nlParsingRef.current = false;
          resolve();
        },
      });
    });
  }, [project, addTask, startEngineStream]);

  const addReviewComment = useCallback((taskId: string, comment: ReviewComment) => {
    setTasks((prev) =>
      prev.map((t) =>
        t.id === taskId
          ? { ...t, reviewComments: [...(t.reviewComments ?? []), comment], updatedAt: Date.now() }
          : t,
      ),
    );
  }, []);

  const updateTaskStatus = useCallback((taskId: string, status: TaskStatus) => {
    setTasks((prev) => {
      const updated = prev.map((t) => {
        if (t.id !== taskId) return t;
        const u = { ...t, status, updatedAt: Date.now() };
        persistTask(u);
        return u;
      });
      return updated;
    });
  }, [persistTask]);

  const removeTask = useCallback((taskId: string) => {
    // Clear any pending review timer
    const timer = reviewTimers.current.get(taskId);
    if (timer) {
      clearTimeout(timer);
      reviewTimers.current.delete(taskId);
    }
    // Cancel any active execution
    const cancel = executionCancels.current.get(taskId);
    if (cancel) {
      cancel();
      executionCancels.current.delete(taskId);
    }
    setTaskExecutions((prev) => {
      const next = new Map(prev);
      next.delete(taskId);
      return next;
    });
    setTasks((prev) => prev.filter((t) => t.id !== taskId));
    deleteTaskFromDisk(taskId);
  }, [deleteTaskFromDisk]);

  // ── Helper: update execution state immutably ──────────────

  const updateExecution = useCallback((taskId: string, update: Partial<TaskExecutionState>) => {
    setTaskExecutions((prev) => {
      const existing = prev.get(taskId);
      if (!existing) return prev;
      const next = new Map(prev);
      next.set(taskId, { ...existing, ...update });
      return next;
    });
  }, []);

  const appendExecutionOutput = useCallback((taskId: string, line: string) => {
    setTaskExecutions((prev) => {
      const existing = prev.get(taskId);
      if (!existing) return prev;
      const next = new Map(prev);
      const output = [...existing.output, line];
      // Cap output buffer at 1000 lines
      if (output.length > 1000) output.splice(0, output.length - 1000);
      next.set(taskId, { ...existing, output });
      return next;
    });
  }, []);

  // Debounced persistence for execution thread entries
  const pendingPersist = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const appendExecutionEntry = useCallback((taskId: string, type: ExecutionEntryType, content: string, metadata?: Record<string, unknown>) => {
    const entry: ExecutionEntry = {
      id: `${taskId}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      type,
      timestamp: Date.now(),
      content,
      metadata,
    };
    setTasks((prev) =>
      prev.map((t) => {
        if (t.id !== taskId) return t;
        const updated = { ...t, executionThread: [...t.executionThread, entry], updatedAt: Date.now() };
        // Debounce persistence: flush every 2 seconds
        const existing = pendingPersist.current.get(taskId);
        if (existing) clearTimeout(existing);
        pendingPersist.current.set(taskId, setTimeout(() => {
          persistTask(updated);
          pendingPersist.current.delete(taskId);
        }, 2000));
        return updated;
      }),
    );
  }, [persistTask]);

  // ── AI Planning ─────────────────────────────────────────

  const generatePlan = useCallback((taskId: string) => {
    const task = tasks.find((t) => t.id === taskId);
    if (!task || !project) return;

    updateTaskStatus(taskId, 'planning');

    const prompt = [
      `Task: ${task.title}`,
      '',
      `Description: ${task.description}`,
      '',
      `Project directory: ${project.path}`,
    ].join('\n');

    startEngineStream({
      engine: 'planning',
      prompt,
      freshConversation: true,
      onComplete: (accumulated) => {
        const parsed = extractJsonFromResponse(accumulated) as {
          approach?: string; steps?: Array<{ id?: string; description?: string; status?: string }>;
          filesToModify?: string[]; testsToRun?: string[]; risks?: string[];
        } | null;
        if (parsed?.approach && Array.isArray(parsed.steps)) {
          const plan: TaskPlan = {
            approach: parsed.approach,
            steps: parsed.steps.map((s, i) => ({
              id: s.id ?? String(i + 1),
              description: s.description ?? '',
              status: 'pending' as const,
            })),
            filesToModify: parsed.filesToModify ?? [],
            testsToRun: parsed.testsToRun ?? [],
            risks: parsed.risks ?? [],
          };
          setTasks((prev) =>
            prev.map((t) => {
              if (t.id !== taskId) return t;
              const updated = { ...t, plan, updatedAt: Date.now() };
              persistTask(updated);
              return updated;
            }),
          );
          appendExecutionEntry(taskId, 'plan', 'AI generated implementation plan');
        } else {
          appendExecutionEntry(taskId, 'error', 'Failed to parse plan from AI response');
        }
      },
      onError: (error) => {
        appendExecutionEntry(taskId, 'error', `Planning failed: ${error}`);
      },
    });
  }, [tasks, project, updateTaskStatus, startEngineStream, persistTask, appendExecutionEntry]);

  const approvePlan = useCallback((taskId: string) => {
    setTasks((prev) =>
      prev.map((t) => {
        if (t.id !== taskId) return t;
        const updated = { ...t, planApprovedAt: Date.now(), status: 'queued' as TaskStatus, updatedAt: Date.now() };
        persistTask(updated);
        return updated;
      }),
    );
  }, [persistTask]);

  // ── Feature #11: Autonomous Task Execution (LLM Agent) ──

  // Track partial text lines for streaming accumulation
  const partialLines = useRef(new Map<string, string>());

  const appendStreamText = useCallback((taskId: string, delta: string) => {
    const current = partialLines.current.get(taskId) ?? '';
    const combined = current + delta;
    const lines = combined.split('\n');

    if (lines.length > 1) {
      const completeLines = lines.slice(0, -1).filter((l) => l.trim());
      if (completeLines.length > 0) {
        setTaskExecutions((prev) => {
          const existing = prev.get(taskId);
          if (!existing) return prev;
          const next = new Map(prev);
          next.set(taskId, { ...existing, output: [...existing.output, ...completeLines] });
          return next;
        });
      }
    }

    partialLines.current.set(taskId, lines[lines.length - 1]);
  }, []);

  const MAX_PARALLEL_TASKS = 3;

  const executeTask = useCallback(async (taskId: string) => {
    const task = tasks.find((t) => t.id === taskId);
    if (!task || !project) return;

    // Move to executing
    updateTaskStatus(taskId, 'executing');
    appendExecutionEntry(taskId, 'step_start', `Starting execution: ${task.title}`);

    // Create isolated worktree for this task
    const slug = task.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30);
    const branchName = `task/${taskId.slice(0, 8)}-${slug}`;
    let executionPath = project.path;

    try {
      const worktreeResult = await app.git.createWorktree(project.path, branchName);
      if (worktreeResult.path) {
        executionPath = worktreeResult.path;
        // Store worktree info on task
        setTasks((prev) =>
          prev.map((t) => {
            if (t.id !== taskId) return t;
            const updated = { ...t, worktreePath: worktreeResult.path, worktreeBranch: branchName, updatedAt: Date.now() };
            persistTask(updated);
            return updated;
          }),
        );
        appendExecutionEntry(taskId, 'step_start', `Created isolated worktree: ${branchName}`);
      }
    } catch {
      appendExecutionEntry(taskId, 'text', 'Could not create worktree, executing in main directory');
    }

    // Initialize execution state
    const initialState: TaskExecutionState = {
      taskId,
      status: 'running',
      output: [`Starting: ${task.title}`],
      activeToolName: null,
      cancel: null,
    };
    setTaskExecutions((prev) => new Map(prev).set(taskId, initialState));
    partialLines.current.delete(taskId);

    // Build execution prompt — use worktree path
    const prompt = [
      `Task: ${task.title}`,
      '',
      `Description: ${task.description}`,
      '',
      `Project directory: ${executionPath}`,
      '',
      'Work through this task step by step. Use available tools to explore the codebase, make changes, and verify your work.',
      'IMPORTANT: All file operations must be within the project directory shown above.',
    ].join('\n');

    // Stream using the existing workspace agent
    const cancel = streamWorkspaceEngine({
      workspaceId: project.path,
      engine: 'execution',
      userMessage: prompt,
      projectPath: executionPath,
      freshConversation: true,
      onTextDelta: (text) => {
        appendStreamText(taskId, text);
      },
      onToolCall: (_id, name) => {
        updateExecution(taskId, { activeToolName: name });
      },
      onToolResult: (_id, name, result) => {
        updateExecution(taskId, { activeToolName: null });
        const summary = typeof result === 'string' ? result.slice(0, 200) : JSON.stringify(result).slice(0, 200);
        appendExecutionOutput(taskId, `[${name}] ${summary}`);
      },
      onDone: () => {
        const remaining = partialLines.current.get(taskId);
        if (remaining?.trim()) {
          appendExecutionOutput(taskId, remaining);
        }
        partialLines.current.delete(taskId);

        updateExecution(taskId, { status: 'done', activeToolName: null, cancel: null });
        executionCancels.current.delete(taskId);

        // Transition to review in a single setTasks call to avoid race conditions
        setTasks((prev) =>
          prev.map((t) => {
            if (t.id !== taskId) return t;
            const updated = { ...t, status: 'review' as TaskStatus, executionCompletedAt: Date.now(), updatedAt: Date.now() };
            persistTask(updated);
            return updated;
          }),
        );

        // Force flush pending persistence
        const pending = pendingPersist.current.get(taskId);
        if (pending) {
          clearTimeout(pending);
          pendingPersist.current.delete(taskId);
        }
      },
      onError: (error) => {
        appendExecutionOutput(taskId, `[Error] ${error}`);
        partialLines.current.delete(taskId);
        updateExecution(taskId, { status: 'error', activeToolName: null, cancel: null });
        executionCancels.current.delete(taskId);

        // Clean up worktree on error
        if (executionPath !== project.path && project) {
          app.git.removeWorktree(project.path, executionPath).catch(() => {});
          app.git.deleteBranch(project.path, branchName).catch(() => {});
        }

        // Transition back to planning in a single setTasks call
        setTasks((prev) =>
          prev.map((t) => {
            if (t.id !== taskId) return t;
            const updated = { ...t, status: 'planning' as TaskStatus, worktreePath: undefined, worktreeBranch: undefined, updatedAt: Date.now() };
            persistTask(updated);
            return updated;
          }),
        );
      },
    });

    executionCancels.current.set(taskId, cancel);
    updateExecution(taskId, { cancel });
  }, [tasks, project, updateTaskStatus, updateExecution, appendExecutionOutput, appendStreamText, appendExecutionEntry, persistTask]);

  const reviewTask = useCallback(async (taskId: string, approved: boolean) => {
    const task = tasks.find((t) => t.id === taskId);
    if (approved) {
      setTasks((prev) =>
        prev.map((t) => {
          if (t.id !== taskId) return t;
          const updated = { ...t, status: 'done' as TaskStatus, reviewResult: 'approved' as const, completedAt: Date.now(), updatedAt: Date.now() };
          persistTask(updated);
          return updated;
        }),
      );
    } else {
      // Rejected — clean up worktree and branch
      if (task?.worktreePath && project) {
        try { await app.git.removeWorktree(project.path, task.worktreePath); } catch { /* ignore */ }
      }
      if (task?.worktreeBranch && project) {
        try { await app.git.deleteBranch(project.path, task.worktreeBranch); } catch { /* ignore */ }
      }
      setTasks((prev) =>
        prev.map((t) => {
          if (t.id !== taskId) return t;
          const updated = { ...t, status: 'rejected' as TaskStatus, reviewResult: 'rejected' as const, worktreePath: undefined, worktreeBranch: undefined, updatedAt: Date.now() };
          persistTask(updated);
          return updated;
        }),
      );
    }
  }, [tasks, project, persistTask]);

  const mergeTask = useCallback(async (taskId: string): Promise<{ success: boolean; error?: string }> => {
    const task = tasks.find((t) => t.id === taskId);
    if (!task?.worktreeBranch || !project) return { success: false, error: 'No branch to merge' };

    // Merge the task branch into the current branch
    const result = await app.git.mergeBranch(project.path, task.worktreeBranch);
    if (result.success) {
      // Clean up worktree and branch
      if (task.worktreePath) {
        try { await app.git.removeWorktree(project.path, task.worktreePath); } catch { /* ignore */ }
      }
      try { await app.git.deleteBranch(project.path, task.worktreeBranch); } catch { /* ignore */ }

      setTasks((prev) =>
        prev.map((t) => {
          if (t.id !== taskId) return t;
          const updated = { ...t, status: 'done' as TaskStatus, completedAt: Date.now(), worktreePath: undefined, worktreeBranch: undefined, updatedAt: Date.now() };
          persistTask(updated);
          return updated;
        }),
      );
      appendExecutionEntry(taskId, 'step_complete', `Merged branch ${task.worktreeBranch} and cleaned up worktree`);
    }
    return result;
  }, [tasks, project, persistTask, appendExecutionEntry]);

  // ── Feature #13: AI-Powered Review (real LLM review using git diff) ──

  const reviewTaskWithAI = useCallback(async (task: WorkspaceTask) => {
    if (!project) return;

    // Fetch actual git diff — use branch diff if worktree exists
    let diffText = '';
    try {
      if (task.worktreeBranch) {
        const currentBranch = await app.git.currentBranch(project.path);
        const baseBranch = currentBranch.branch || 'main';
        const result = await app.git.diffBranch(project.path, baseBranch, task.worktreeBranch);
        diffText = result.diff || '(no changes detected)';
      } else {
        const result = await app.git.diff(project.path);
        diffText = result.diff || '(no changes detected)';
      }
    } catch {
      diffText = '(failed to fetch diff)';
    }

    // Truncate very large diffs to avoid token limits
    const maxDiffLen = 8000;
    const truncatedDiff = diffText.length > maxDiffLen
      ? diffText.slice(0, maxDiffLen) + '\n\n... (diff truncated)'
      : diffText;

    const prompt = [
      `## Task`,
      `**${task.title}**: ${task.description}`,
      '',
      `## Git Diff`,
      '```diff',
      truncatedDiff,
      '```',
      '',
      'Review these changes and provide your assessment.',
    ].join('\n');

    startEngineStream({
      engine: 'review',
      prompt,
      freshConversation: true,
      onComplete: (accumulated) => {
        // Parse the LLM's structured review
        const parsed = extractJsonFromResponse<{
          approved?: boolean;
          summary?: string;
          comments?: string[];
        }>(accumulated);

        const approved = parsed?.approved ?? true;
        const summary = parsed?.summary ?? (approved ? 'Changes look good.' : 'Issues found in the changes.');
        const comments = parsed?.comments ?? [];

        // Add the summary as a review comment
        addReviewComment(task.id, {
          author: 'Kai AI Reviewer',
          content: summary,
          timestamp: Date.now(),
        });

        // Add specific comments
        for (const comment of comments) {
          addReviewComment(task.id, {
            author: 'Kai AI Reviewer',
            content: comment,
            timestamp: Date.now(),
          });
        }

        // Move task based on review result
        if (approved) {
          setTasks((prev) =>
            prev.map((t) =>
              t.id === task.id && t.status === 'review'
                ? { ...t, status: 'review' as TaskStatus, reviewResult: 'approved', updatedAt: Date.now() }
                : t,
            ),
          );
        } else {
          setTasks((prev) =>
            prev.map((t) =>
              t.id === task.id && t.status === 'review'
                ? { ...t, status: 'planning' as TaskStatus, reviewResult: 'changes_requested', updatedAt: Date.now() }
                : t,
            ),
          );
        }
        reviewTimers.current.delete(`review-${task.id}`);
      },
      onError: (error) => {
        // On error, add the error as a comment and send back to planning
        addReviewComment(task.id, {
          author: 'Kai AI Reviewer',
          content: `Review failed: ${error}`,
          timestamp: Date.now(),
        });
        setTasks((prev) =>
          prev.map((t) =>
            t.id === task.id && t.status === 'review'
              ? { ...t, status: 'planning' as TaskStatus, updatedAt: Date.now() }
              : t,
          ),
        );
        reviewTimers.current.delete(`review-${task.id}`);
      },
    });
  }, [project, startEngineStream, addReviewComment]);

  useEffect(() => {
    if (!autoReviewEnabled || !project) return;

    const tasksInReview = tasks.filter((t) => t.status === 'review');
    for (const task of tasksInReview) {
      if (reviewTimers.current.has(`review-${task.id}`)) continue;
      // Mark as in-review immediately so we don't double-trigger
      reviewTimers.current.set(`review-${task.id}`, setTimeout(() => {}, 0));
      reviewTaskWithAI(task);
    }
  }, [tasks, autoReviewEnabled, project, reviewTaskWithAI]);

  // Auto-execute queued tasks with concurrency limit
  useEffect(() => {
    if (!project) return;
    const queued = tasks.filter((t) => t.status === 'queued');
    const running = tasks.filter((t) => t.status === 'executing').length;
    const available = MAX_PARALLEL_TASKS - running;
    if (available <= 0) return;

    for (const task of queued.slice(0, available)) {
      if (!taskExecutions.has(task.id)) {
        executeTask(task.id);
      }
    }
  }, [tasks, project, taskExecutions, executeTask]);

  // Auto-archive done tasks after 14 days
  useEffect(() => {
    if (!project?.path) return;
    const FOURTEEN_DAYS = 14 * 24 * 60 * 60 * 1000;
    const now = Date.now();
    const toArchive = tasks.filter(
      (t) => (t.status === 'done' || t.status === 'rejected') && !t.archivedAt && t.completedAt && (now - t.completedAt) > FOURTEEN_DAYS,
    );
    if (toArchive.length === 0) return;
    setTasks((prev) =>
      prev.map((t) => {
        if (!toArchive.find((a) => a.id === t.id)) return t;
        const updated = { ...t, archivedAt: now, updatedAt: now };
        persistTask(updated);
        return updated;
      }),
    );
  }, [tasks, project?.path, persistTask]);

  // ── Feature #14: Cross-Engine Linking ───────────────────

  const convertIdeaToTask = useCallback(
    (ideaId: string, title: string, description: string, priority: TaskPriority) => {
      addTask(title, description, priority, [`idea:${ideaId}`]);
    },
    [addTask],
  );

  const convertFeatureToTask = useCallback(
    (featureId: string, title: string, description: string, priority: TaskPriority) => {
      addTask(title, description, priority, [`roadmap:${featureId}`]);
    },
    [addTask],
  );

  // ── Plugin Management ────────────────────────────────────

  const installPlugin = useCallback((plugin: InstalledPlugin) => {
    setPlugins((prev) => [...prev.filter((p) => p.id !== plugin.id), plugin]);
  }, []);

  const removePlugin = useCallback((pluginId: string) => {
    setPlugins((prev) => prev.filter((p) => p.id !== pluginId));
  }, []);

  const togglePlugin = useCallback((pluginId: string) => {
    setPlugins((prev) =>
      prev.map((p) => (p.id === pluginId ? { ...p, enabled: !p.enabled } : p)),
    );
  }, []);

  const updatePluginConfig = useCallback((pluginId: string, config: Record<string, unknown>) => {
    setPlugins((prev) =>
      prev.map((p) => (p.id === pluginId ? { ...p, config: { ...p.config, ...config } } : p)),
    );
  }, []);

  // ── Flattened capabilities for LLM context ───────────────

  const allCapabilities = useMemo(() => {
    return plugins
      .filter((p) => p.enabled)
      .flatMap((p) =>
        p.capabilities.map((c) => ({
          pluginId: p.id,
          pluginName: p.name,
          capabilityId: c.id,
          name: c.name,
          description: c.description,
        })),
      );
  }, [plugins]);

  // ── Context value ────────────────────────────────────────

  const value = useMemo<WorkspaceContextValue>(
    () => ({
      project,
      setProject,
      activeEngine,
      setActiveEngine,
      selectedTaskId,
      setSelectedTaskId,
      tasks,
      addTask,
      createTaskFromNaturalLanguage,
      generatePlan,
      approvePlan,
      updateTaskStatus,
      removeTask,
      executeTask,
      reviewTask,
      mergeTask,
      taskExecutions,
      workspaceTerminals,
      autoReviewEnabled,
      setAutoReviewEnabled,
      convertIdeaToTask,
      convertFeatureToTask,
      plugins,
      installPlugin,
      removePlugin,
      togglePlugin,
      updatePluginConfig,
      allCapabilities,
      ideas,
      setIdeas,
      roadmapPhases,
      setRoadmapPhases,
      insightMessages,
      setInsightMessages,
      changelogReleases,
      setChangelogReleases,
      engineStreams,
      startEngineStream,
      cancelEngineStream,
    }),
    [
      project, activeEngine, selectedTaskId, tasks, plugins, allCapabilities, autoReviewEnabled, taskExecutions,
      workspaceTerminals, ideas, roadmapPhases, insightMessages, changelogReleases, engineStreams,
      addTask, createTaskFromNaturalLanguage, generatePlan, approvePlan, updateTaskStatus, removeTask, executeTask, reviewTask, mergeTask,
      startEngineStream, cancelEngineStream,
      convertIdeaToTask, convertFeatureToTask,
      installPlugin, removePlugin, togglePlugin, updatePluginConfig,
    ],
  );

  return (
    <WorkspaceContext.Provider value={value}>
      {children}
    </WorkspaceContext.Provider>
  );
}
