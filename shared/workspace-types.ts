// ── Workspace Types ─────────────────────────────────────────
// Shared between main process and renderer

// ── Plugin System ───────────────────────────────────────────

export interface PluginCapability {
  id: string;
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
}

export interface PluginSetting {
  id: string;
  label: string;
  type: 'string' | 'password' | 'boolean' | 'select';
  required: boolean;
  placeholder?: string;
  options?: Array<{ value: string; label: string }>;
}

export interface PluginSidebarItem {
  id: string;
  label: string;
  icon: string;
}

export interface WorkspacePlugin {
  id: string;
  name: string;
  description: string;
  version: string;
  icon: string;
  capabilities: PluginCapability[];
  settings: PluginSetting[];
  sidebarItems?: PluginSidebarItem[];
}

export interface InstalledPlugin extends WorkspacePlugin {
  enabled: boolean;
  config: Record<string, unknown>;
}

// ── Tasks ───────────────────────────────────────────────────

export type TaskStatus = 'planning' | 'in_progress' | 'ai_review' | 'human_review' | 'done';
export type TaskPriority = 'low' | 'medium' | 'high' | 'critical';

export interface WorkspaceTask {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  labels: string[];
  linkedPluginData?: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

// ── Workspace Engine ────────────────────────────────────────

export type WorkspaceEngine = 'kanban' | 'plugins' | 'prompt' | string;

// ── Workspace State ─────────────────────────────────────────

export interface WorkspaceProject {
  path: string;
  name: string;
}

export interface WorkspaceState {
  project: WorkspaceProject | null;
  activeEngine: WorkspaceEngine;
  tasks: WorkspaceTask[];
  plugins: InstalledPlugin[];
}

// ── IPC Types ───────────────────────────────────────────────

export interface WorkspaceIPC {
  openProject: () => Promise<WorkspaceProject | null>;
  getTasks: (projectPath: string) => Promise<WorkspaceTask[]>;
  saveTasks: (projectPath: string, tasks: WorkspaceTask[]) => Promise<void>;
  getPlugins: () => Promise<InstalledPlugin[]>;
  installPlugin: (plugin: WorkspacePlugin) => Promise<void>;
  removePlugin: (pluginId: string) => Promise<void>;
  updatePluginConfig: (pluginId: string, config: Record<string, unknown>) => Promise<void>;
  executeCapability: (pluginId: string, capabilityId: string, input: Record<string, unknown>) => Promise<unknown>;
}
