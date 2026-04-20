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

export interface ReviewComment {
  author: string;
  content: string;
  timestamp: number;
}

export interface WorkspaceTask {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  labels: string[];
  linkedPluginData?: Record<string, unknown>;
  reviewComments?: ReviewComment[];
  worktreePath?: string;      // path to the task's worktree
  worktreeBranch?: string;    // branch name
  createdAt: number;
  updatedAt: number;
}

// ── Workspace Engine ────────────────────────────────────────

export type WorkspaceEngine =
  | 'kanban' | 'changes' | 'insights' | 'roadmap'
  | 'ideation' | 'changelog' | 'context' | 'worktrees'
  | 'plugins' | 'prompt'
  | string;

// ── Terminals ──────────────────────────────────────────────

export type TerminalStatus = 'idle' | 'running' | 'completed' | 'failed';

export interface WorkspaceTerminal {
  id: string;
  title: string;
  taskId?: string;
  status: TerminalStatus;
  output: string[];
  createdAt: number;
}

/** Info about a terminal spawned by task execution (tracked in WorkspaceProvider). */
export interface WorkspaceTerminalInfo {
  id: string;
  taskId: string;
  taskTitle: string;
  cwd: string;
  status: 'running' | 'completed' | 'failed';
}

// ── Insights ───────────────────────────────────────────────

export interface InsightMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

// ── Roadmap ────────────────────────────────────────────────

export type RoadmapPriority = 'low' | 'medium' | 'high' | 'critical';

export interface RoadmapFeature {
  id: string;
  title: string;
  description: string;
  priority: RoadmapPriority;
  effort: 'small' | 'medium' | 'large' | 'xlarge';
  status: 'planned' | 'in_progress' | 'completed';
}

export interface RoadmapPhase {
  id: string;
  name: string;
  description: string;
  features: RoadmapFeature[];
}

// ── Ideation ───────────────────────────────────────────────

export type IdeaCategory =
  | 'code-improvement' | 'code-quality' | 'performance'
  | 'security' | 'documentation' | 'ui-ux';

export type IdeaSeverity = 'info' | 'low' | 'medium' | 'high' | 'critical';

export interface Idea {
  id: string;
  title: string;
  description: string;
  category: IdeaCategory;
  severity: IdeaSeverity;
  affectedFiles: string[];
  createdAt: number;
}

// ── Changelog ──────────────────────────────────────────────

export interface ChangelogChange {
  type: 'added' | 'changed' | 'fixed' | 'removed';
  description: string;
  taskId?: string;
}

export interface ChangelogRelease {
  id: string;
  version: string;
  date: string;
  summary: string;
  changes: ChangelogChange[];
}

// ── Worktrees ──────────────────────────────────────────────

export type WorktreeStatus = 'active' | 'stale' | 'merging';

export interface Worktree {
  id: string;
  branch: string;
  path: string;
  taskId?: string;
  taskTitle?: string;
  status: WorktreeStatus;
  createdAt: number;
}

// ── Git Types ──────────────────────────────────────────────

export interface GitBranch {
  name: string;
  shortHash: string;
  upstream: string;
  isCurrent: boolean;
  isDefault: boolean;
  lastActivity: string; // relative timestamp like "12 days ago"
}

export interface GitCommit {
  hash: string;
  shortHash: string;
  author: string;
  email: string;
  timestamp: number;
  message: string;
  refs: string;
}

export interface GitStagedFile {
  path: string;
  indexStatus: string;
  worktreeStatus: string;
  staged: boolean;
}

export interface GitRemoteStatus {
  ahead: number;
  behind: number;
}

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
