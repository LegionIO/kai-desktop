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

// New lifecycle: defining → planning → queued → executing → review → done
// Also: needs_input (sub-state of executing), rejected (terminal)
export type TaskStatus =
  | 'defining' | 'planning' | 'queued' | 'executing'
  | 'needs_input' | 'review' | 'done' | 'rejected'
  // Legacy (kept temporarily for migration)
  | 'in_progress' | 'ai_review' | 'human_review';

export type TaskPriority = 'low' | 'medium' | 'high' | 'critical';

export interface ReviewComment {
  author: string;
  content: string;
  timestamp: number;
}

// ── Task Planning ──────────────────────────────────────────

export interface TaskPlanStep {
  id: string;
  description: string;
  status: 'pending' | 'in_progress' | 'done' | 'skipped';
}

export interface TaskPlan {
  approach: string;
  steps: TaskPlanStep[];
  filesToModify: string[];
  testsToRun: string[];
  risks: string[];
}

// ── Execution Thread ───────────────────────────────────────

export type ExecutionEntryType =
  | 'plan' | 'step_start' | 'step_complete'
  | 'tool_call' | 'tool_result' | 'text'
  | 'error' | 'user_input' | 'review_comment';

export interface ExecutionEntry {
  id: string;
  type: ExecutionEntryType;
  timestamp: number;
  content: string;
  metadata?: Record<string, unknown>;
}

// ── Workspace Task ─────────────────────────────────────────

export interface WorkspaceTask {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  labels: string[];
  linkedPluginData?: Record<string, unknown>;
  reviewComments?: ReviewComment[];
  worktreePath?: string;
  worktreeBranch?: string;
  createdAt: number;
  updatedAt: number;

  // Planning
  plan?: TaskPlan;
  planApprovedAt?: number;

  // Execution
  executionThread: ExecutionEntry[];
  executionStartedAt?: number;
  executionCompletedAt?: number;

  // Review
  reviewResult?: 'approved' | 'changes_requested' | 'rejected';

  // Completion
  completedAt?: number;
  archivedAt?: number;

  // Cross-linking
  linkedInsightId?: string;
  linkedChangelogEntry?: string;
}

// ── Workspace Engine ────────────────────────────────────────

export type WorkspaceEngine =
  // New primary routes
  | 'tasks' | 'task-thread' | 'git' | 'analysis'
  // Kept routes
  | 'changelog' | 'plugins'
  // Legacy (still rendered during transition)
  | 'kanban' | 'changes' | 'insights' | 'roadmap'
  | 'ideation' | 'context' | 'worktrees' | 'prompt'
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

// ── Task Store (persistence) ───────────────────────────────

export interface WorkspaceTaskStore {
  tasks: Record<string, WorkspaceTask>;
  version: number;
  lastUpdated: string;
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
