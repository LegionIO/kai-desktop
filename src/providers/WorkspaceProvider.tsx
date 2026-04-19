import {
  createContext,
  useContext,
  useState,
  useCallback,
  useMemo,
  type ReactNode,
} from 'react';
import type {
  WorkspaceProject,
  WorkspaceTask,
  InstalledPlugin,
  WorkspaceEngine,
  TaskStatus,
  TaskPriority,
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
  addTask: (title: string, description: string, priority: TaskPriority) => void;
  updateTaskStatus: (taskId: string, status: TaskStatus) => void;
  removeTask: (taskId: string) => void;

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

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [project, setProject] = useState<WorkspaceProject | null>(null);
  const [activeEngine, setActiveEngine] = useState<WorkspaceEngine>('kanban');
  const [tasks, setTasks] = useState<WorkspaceTask[]>([]);
  const [plugins, setPlugins] = useState<InstalledPlugin[]>([]);

  // ── Task CRUD ────────────────────────────────────────────

  const addTask = useCallback((title: string, description: string, priority: TaskPriority) => {
    const task: WorkspaceTask = {
      id: makeId(),
      title,
      description,
      status: 'backlog',
      priority,
      labels: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    setTasks((prev) => [...prev, task]);
  }, []);

  const updateTaskStatus = useCallback((taskId: string, status: TaskStatus) => {
    setTasks((prev) =>
      prev.map((t) => (t.id === taskId ? { ...t, status, updatedAt: Date.now() } : t)),
    );
  }, []);

  const removeTask = useCallback((taskId: string) => {
    setTasks((prev) => prev.filter((t) => t.id !== taskId));
  }, []);

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
      plugins,
      installPlugin,
      removePlugin,
      togglePlugin,
      updatePluginConfig,
      allCapabilities,
    }),
    [
      project, activeEngine, tasks, plugins, allCapabilities,
      addTask, updateTaskStatus, removeTask,
      installPlugin, removePlugin, togglePlugin, updatePluginConfig,
    ],
  );

  return (
    <WorkspaceContext.Provider value={value}>
      {children}
    </WorkspaceContext.Provider>
  );
}
