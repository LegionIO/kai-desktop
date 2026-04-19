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
} from '../../shared/workspace-types';

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
  executeTask: (taskId: string) => void;
  reviewTask: (taskId: string, approved: boolean) => void;

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

/* ── AI Review comments (simulated) ──────────────────────── */

const AI_APPROVE_COMMENTS = [
  'Code changes look clean. No regressions detected. Approved.',
  'Implementation follows established patterns. Tests pass. Approved for human review.',
  'Logic verified against requirements. No issues found. Moving to human review.',
  'Static analysis clean, no security concerns identified. Approved.',
  'Changes are minimal and well-scoped. Forwarding to human review.',
];

const AI_REJECT_COMMENTS = [
  'Potential edge case detected: null check missing on input validation. Sending back for rework.',
  'Test coverage below threshold for modified files. Please add unit tests.',
  'Found inconsistent error handling pattern. Please align with project conventions.',
  'Performance concern: N+1 query pattern detected in the data fetch logic.',
];

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [project, setProject] = useState<WorkspaceProject | null>(null);
  const [activeEngine, setActiveEngine] = useState<WorkspaceEngine>('kanban');
  const [tasks, setTasks] = useState<WorkspaceTask[]>([]);
  const [plugins, setPlugins] = useState<InstalledPlugin[]>([]);
  const [autoReviewEnabled, setAutoReviewEnabled] = useState(true);

  // Track active review timers so we can clean them up
  const reviewTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  // Cleanup timers on unmount
  useEffect(() => {
    return () => {
      for (const timer of reviewTimers.current.values()) {
        clearTimeout(timer);
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
    setTasks((prev) => prev.filter((t) => t.id !== taskId));
  }, []);

  // ── Feature #11: Autonomous Task Execution ──────────────

  const executeTask = useCallback((taskId: string) => {
    // Move to in_progress
    setTasks((prev) =>
      prev.map((t) => (t.id === taskId ? { ...t, status: 'in_progress' as TaskStatus, updatedAt: Date.now() } : t)),
    );

    // Simulate execution, then move to ai_review after 3s
    const timer = setTimeout(() => {
      setTasks((prev) =>
        prev.map((t) =>
          t.id === taskId && t.status === 'in_progress'
            ? { ...t, status: 'ai_review' as TaskStatus, updatedAt: Date.now() }
            : t,
        ),
      );
      reviewTimers.current.delete(taskId);
    }, 3000);
    reviewTimers.current.set(taskId, timer);
  }, []);

  const reviewTask = useCallback((taskId: string, approved: boolean) => {
    if (approved) {
      setTasks((prev) =>
        prev.map((t) => (t.id === taskId ? { ...t, status: 'human_review' as TaskStatus, updatedAt: Date.now() } : t)),
      );
    } else {
      setTasks((prev) =>
        prev.map((t) => (t.id === taskId ? { ...t, status: 'in_progress' as TaskStatus, updatedAt: Date.now() } : t)),
      );
    }
  }, []);

  // ── Feature #13: AI-Powered Auto-Review ─────────────────

  useEffect(() => {
    if (!autoReviewEnabled) return;

    const tasksInReview = tasks.filter((t) => t.status === 'ai_review');
    for (const task of tasksInReview) {
      // Don't start a timer if one already exists
      if (reviewTimers.current.has(`review-${task.id}`)) continue;

      const timer = setTimeout(() => {
        const approved = Math.random() < 0.8;
        const comments = approved ? AI_APPROVE_COMMENTS : AI_REJECT_COMMENTS;
        const comment: ReviewComment = {
          author: 'Kai AI Reviewer',
          content: comments[Math.floor(Math.random() * comments.length)],
          timestamp: Date.now(),
        };

        addReviewComment(task.id, comment);

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
                ? { ...t, status: 'in_progress' as TaskStatus, updatedAt: Date.now() }
                : t,
            ),
          );
        }
        reviewTimers.current.delete(`review-${task.id}`);
      }, 3000);

      reviewTimers.current.set(`review-${task.id}`, timer);
    }
  }, [tasks, autoReviewEnabled, addReviewComment]);

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
    }),
    [
      project, activeEngine, tasks, plugins, allCapabilities, autoReviewEnabled,
      addTask, updateTaskStatus, removeTask, executeTask, reviewTask,
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
