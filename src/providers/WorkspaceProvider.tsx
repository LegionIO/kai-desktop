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

  // Tasks
  tasks: WorkspaceTask[];
  addTask: (title: string, description: string, priority: TaskPriority, labels?: string[]) => void;
  updateTaskStatus: (taskId: string, status: TaskStatus) => void;
  removeTask: (taskId: string) => void;

  // Feature #11: Autonomous Task Execution
  executeTask: (taskId: string) => Promise<void>;
  reviewTask: (taskId: string, approved: boolean) => void;

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
  const [activeEngine, setActiveEngine] = useState<WorkspaceEngine>('kanban');
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
        // Read accumulated from the latest state via updater
        setEngineStreams((prev) => {
          const s = prev.get(engine);
          const accumulated = s?.accumulated ?? '';
          const next = new Map(prev);
          next.set(engine, { ...(s ?? initial), status: 'done', activeToolName: null });

          // Call view's onComplete with accumulated text
          engineCallbacks.current.get(engine)?.onComplete?.(accumulated);
          return next;
        });
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
    const task: WorkspaceTask = {
      id: makeId(),
      title,
      description,
      status: 'planning',
      priority,
      labels: labels ?? [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    setTasks((prev) => [...prev, task]);
  }, []);

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
    setTasks((prev) =>
      prev.map((t) => (t.id === taskId ? { ...t, status, updatedAt: Date.now() } : t)),
    );
  }, []);

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
  }, []);

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
      next.set(taskId, { ...existing, output: [...existing.output, line] });
      return next;
    });
  }, []);

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

  const executeTask = useCallback(async (taskId: string) => {
    const task = tasks.find((t) => t.id === taskId);
    if (!task || !project) return;

    // Move to in_progress
    updateTaskStatus(taskId, 'in_progress');

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

    // Build execution prompt
    const prompt = [
      `Task: ${task.title}`,
      '',
      `Description: ${task.description}`,
      '',
      `Project directory: ${project.path}`,
      '',
      'Work through this task step by step. Use available tools to explore the codebase, make changes, and verify your work.',
    ].join('\n');

    // Stream using the existing workspace agent — uses whatever LLM provider is configured
    const cancel = streamWorkspaceEngine({
      workspaceId: project.path,
      engine: 'execution',
      userMessage: prompt,
      projectPath: project.path,
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
        // Flush any remaining partial line
        const remaining = partialLines.current.get(taskId);
        if (remaining?.trim()) {
          appendExecutionOutput(taskId, remaining);
        }
        partialLines.current.delete(taskId);

        updateExecution(taskId, { status: 'done', activeToolName: null, cancel: null });
        executionCancels.current.delete(taskId);
        updateTaskStatus(taskId, 'ai_review');
      },
      onError: (error) => {
        appendExecutionOutput(taskId, `[Error] ${error}`);
        partialLines.current.delete(taskId);
        updateExecution(taskId, { status: 'error', activeToolName: null, cancel: null });
        executionCancels.current.delete(taskId);
        updateTaskStatus(taskId, 'planning');
      },
    });

    executionCancels.current.set(taskId, cancel);
    updateExecution(taskId, { cancel });
  }, [tasks, project, updateTaskStatus, updateExecution, appendExecutionOutput, appendStreamText]);

  const reviewTask = useCallback((taskId: string, approved: boolean) => {
    if (approved) {
      setTasks((prev) =>
        prev.map((t) => (t.id === taskId ? { ...t, status: 'human_review' as TaskStatus, updatedAt: Date.now() } : t)),
      );
    } else {
      setTasks((prev) =>
        prev.map((t) => (t.id === taskId ? { ...t, status: 'planning' as TaskStatus, updatedAt: Date.now() } : t)),
      );
    }
  }, []);

  // ── Feature #13: AI-Powered Review (real LLM review using git diff) ──

  const reviewTaskWithAI = useCallback(async (task: WorkspaceTask) => {
    if (!project) return;

    // Fetch actual git diff
    let diffText = '';
    try {
      const result = await app.git.diff(project.path);
      diffText = result.diff || '(no changes detected)';
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
              t.id === task.id && t.status === 'ai_review'
                ? { ...t, status: 'human_review' as TaskStatus, updatedAt: Date.now() }
                : t,
            ),
          );
        } else {
          setTasks((prev) =>
            prev.map((t) =>
              t.id === task.id && t.status === 'ai_review'
                ? { ...t, status: 'planning' as TaskStatus, updatedAt: Date.now() }
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
            t.id === task.id && t.status === 'ai_review'
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

    const tasksInReview = tasks.filter((t) => t.status === 'ai_review');
    for (const task of tasksInReview) {
      if (reviewTimers.current.has(`review-${task.id}`)) continue;
      // Mark as in-review immediately so we don't double-trigger
      reviewTimers.current.set(`review-${task.id}`, setTimeout(() => {}, 0));
      reviewTaskWithAI(task);
    }
  }, [tasks, autoReviewEnabled, project, reviewTaskWithAI]);

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
      tasks,
      addTask,
      updateTaskStatus,
      removeTask,
      executeTask,
      reviewTask,
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
      project, activeEngine, tasks, plugins, allCapabilities, autoReviewEnabled, taskExecutions,
      workspaceTerminals, ideas, roadmapPhases, insightMessages, changelogReleases, engineStreams,
      addTask, updateTaskStatus, removeTask, executeTask, reviewTask,
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
