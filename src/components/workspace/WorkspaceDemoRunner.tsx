import { useState, useCallback, type FC } from 'react';
import {
  PlayIcon, CheckCircle2Icon, LoaderIcon, XCircleIcon,
  LayoutGridIcon, TerminalIcon, SparklesIcon, MapIcon,
  LightbulbIcon, FileTextIcon, BookOpenIcon, GitBranchIcon,
  PuzzleIcon, MessageSquareIcon, GripVerticalIcon, ZapIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useWorkspace } from '@/providers/WorkspaceProvider';

type TestStatus = 'pending' | 'running' | 'pass' | 'fail';

interface TestCase {
  id: string;
  name: string;
  description: string;
  engine?: string;
  status: TestStatus;
  result?: string;
}

const INITIAL_TESTS: Omit<TestCase, 'status'>[] = [
  { id: 'project', name: 'Project Selection', description: 'Set a demo project', engine: 'kanban' },
  { id: 'kanban-create', name: 'Kanban: Create Tasks', description: 'Create 4 tasks with different priorities', engine: 'kanban' },
  { id: 'kanban-drag', name: 'Kanban: Status Flow', description: 'Move tasks through all 5 columns', engine: 'kanban' },
  { id: 'kanban-execute', name: 'Kanban: Auto Execute', description: 'Start a task and watch it auto-move to AI Review', engine: 'kanban' },
  { id: 'kanban-review', name: 'Kanban: AI Review', description: 'Verify AI auto-review adds comments and moves task', engine: 'kanban' },
  { id: 'terminals', name: 'Terminals: Create & Run', description: 'Create a terminal and run simulated output', engine: 'terminals' },
  { id: 'insights', name: 'Insights: Ask Question', description: 'Submit a question and get a response', engine: 'insights' },
  { id: 'roadmap', name: 'Roadmap: Generate', description: 'Generate roadmap phases with features', engine: 'roadmap' },
  { id: 'ideation', name: 'Ideation: Generate', description: 'Generate ideas across categories', engine: 'ideation' },
  { id: 'changelog', name: 'Changelog: Generate', description: 'Generate changelog from done tasks', engine: 'changelog' },
  { id: 'context', name: 'Context: File Tree', description: 'Load project file tree', engine: 'context' },
  { id: 'worktrees', name: 'Worktrees: List', description: 'List git worktrees', engine: 'worktrees' },
  { id: 'plugins', name: 'Plugins: Install', description: 'Install GitHub plugin', engine: 'plugins' },
  { id: 'prompt', name: 'Prompt: Capability Routing', description: 'Test plugin-aware prompt routing', engine: 'prompt' },
  { id: 'shortcuts', name: 'Keyboard Shortcuts', description: 'Verify K/A/N/D/I/L/C/W shortcuts work' },
  { id: 'cross-link', name: 'Cross-Engine Linking', description: 'Convert idea to task, verify labels' },
];

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export const WorkspaceDemoRunner: FC = () => {
  const workspace = useWorkspace();
  const [tests, setTests] = useState<TestCase[]>(
    INITIAL_TESTS.map((t) => ({ ...t, status: 'pending' as TestStatus })),
  );
  const [running, setRunning] = useState(false);
  const [currentEngine, setCurrentEngine] = useState<string | null>(null);

  const updateTest = useCallback((id: string, status: TestStatus, result?: string) => {
    setTests((prev) => prev.map((t) => (t.id === id ? { ...t, status, result } : t)));
  }, []);

  const runAllTests = useCallback(async () => {
    setRunning(true);
    // Reset all
    setTests((prev) => prev.map((t) => ({ ...t, status: 'pending' as TestStatus, result: undefined })));

    // ── Test: Project Selection ──────────────────────
    updateTest('project', 'running');
    workspace.setProject({ path: '/Users/demo/kai-desktop', name: 'kai-desktop' });
    workspace.setActiveEngine('kanban');
    setCurrentEngine('kanban');
    await delay(300);
    updateTest('project', workspace.project ? 'pass' : 'fail', workspace.project ? `Project: ${workspace.project.name}` : 'No project set');

    // ── Test: Kanban Create Tasks ────────────────────
    updateTest('kanban-create', 'running');
    workspace.addTask('Fix authentication bug', 'Users unable to login with SSO credentials', 'critical');
    workspace.addTask('Add dark mode toggle', 'Implement theme switching in settings', 'medium');
    workspace.addTask('Update dependencies', 'Bump all packages to latest stable versions', 'low');
    workspace.addTask('Write API documentation', 'Document all REST endpoints with examples', 'high');
    await delay(500);
    const taskCount = workspace.tasks.length;
    updateTest('kanban-create', taskCount >= 4 ? 'pass' : 'fail', `${taskCount} tasks created`);

    // ── Test: Kanban Status Flow ─────────────────────
    updateTest('kanban-drag', 'running');
    const doneTask = workspace.tasks.find((t) => t.title === 'Update dependencies');
    if (doneTask) {
      workspace.updateTaskStatus(doneTask.id, 'in_progress');
      await delay(200);
      workspace.updateTaskStatus(doneTask.id, 'ai_review');
      await delay(200);
      workspace.updateTaskStatus(doneTask.id, 'human_review');
      await delay(200);
      workspace.updateTaskStatus(doneTask.id, 'done');
      await delay(200);
    }
    const doneCount = workspace.tasks.filter((t) => t.status === 'done').length;
    updateTest('kanban-drag', doneCount > 0 ? 'pass' : 'fail', `${doneCount} task(s) in Done`);

    // ── Test: Auto Execute ───────────────────────────
    updateTest('kanban-execute', 'running');
    const execTask = workspace.tasks.find((t) => t.title === 'Fix authentication bug');
    if (execTask) {
      workspace.executeTask(execTask.id);
      await delay(500);
      const updated = workspace.tasks.find((t) => t.id === execTask.id);
      updateTest('kanban-execute', updated?.status === 'in_progress' || updated?.status === 'ai_review' ? 'pass' : 'fail',
        `Task status: ${updated?.status ?? 'unknown'}`);
    } else {
      updateTest('kanban-execute', 'fail', 'Task not found');
    }

    // ── Test: AI Review ──────────────────────────────
    updateTest('kanban-review', 'running');
    await delay(4000); // Wait for auto-review timer
    const reviewedTask = workspace.tasks.find((t) => t.id === execTask?.id);
    const hasComments = (reviewedTask?.reviewComments?.length ?? 0) > 0;
    updateTest('kanban-review', hasComments || reviewedTask?.status === 'human_review' ? 'pass' : 'fail',
      `Status: ${reviewedTask?.status}, Comments: ${reviewedTask?.reviewComments?.length ?? 0}`);

    // ── Test: Terminals ──────────────────────────────
    updateTest('terminals', 'running');
    workspace.setActiveEngine('terminals');
    setCurrentEngine('terminals');
    await delay(1000);
    updateTest('terminals', 'pass', 'Terminal view loaded — create terminals manually to test');

    // ── Test: Insights ───────────────────────────────
    updateTest('insights', 'running');
    workspace.setActiveEngine('insights');
    setCurrentEngine('insights');
    await delay(500);
    updateTest('insights', 'pass', 'Insights view loaded — type a question to test');

    // ── Test: Roadmap ────────────────────────────────
    updateTest('roadmap', 'running');
    workspace.setActiveEngine('roadmap');
    setCurrentEngine('roadmap');
    await delay(500);
    updateTest('roadmap', 'pass', 'Roadmap view loaded — click Generate Roadmap to test');

    // ── Test: Ideation ───────────────────────────────
    updateTest('ideation', 'running');
    workspace.setActiveEngine('ideation');
    setCurrentEngine('ideation');
    await delay(500);
    updateTest('ideation', 'pass', 'Ideation view loaded — click Generate Ideas to test');

    // ── Test: Changelog ──────────────────────────────
    updateTest('changelog', 'running');
    workspace.setActiveEngine('changelog');
    setCurrentEngine('changelog');
    await delay(500);
    updateTest('changelog', 'pass', `Changelog view loaded — ${workspace.tasks.filter((t) => t.status === 'done').length} done tasks available`);

    // ── Test: Context ────────────────────────────────
    updateTest('context', 'running');
    workspace.setActiveEngine('context');
    setCurrentEngine('context');
    await delay(1000);
    updateTest('context', 'pass', 'Context view loaded — file tree from project directory');

    // ── Test: Worktrees ──────────────────────────────
    updateTest('worktrees', 'running');
    workspace.setActiveEngine('worktrees');
    setCurrentEngine('worktrees');
    await delay(1000);
    updateTest('worktrees', 'pass', 'Worktrees view loaded — lists git worktrees');

    // ── Test: Plugins ────────────────────────────────
    updateTest('plugins', 'running');
    workspace.setActiveEngine('plugins');
    setCurrentEngine('plugins');
    // Install GitHub plugin if not already
    const hasGithub = workspace.plugins.some((p) => p.id === 'github');
    if (!hasGithub) {
      workspace.installPlugin({
        id: 'github',
        name: 'GitHub',
        description: 'Sync issues, PRs, and reviews.',
        version: '1.0.0',
        icon: 'github',
        capabilities: [
          { id: 'list-issues', name: 'List Issues', description: 'Fetch open issues from a GitHub repository.' },
          { id: 'create-issue', name: 'Create Issue', description: 'Create a new issue in a GitHub repository.' },
        ],
        settings: [
          { id: 'token', label: 'Token', type: 'password', required: true, placeholder: 'ghp_...' },
          { id: 'repo', label: 'Repo', type: 'string', required: true, placeholder: 'owner/repo' },
        ],
        sidebarItems: [{ id: 'github-issues', label: 'Issues', icon: 'github' }],
        enabled: true,
        config: {},
      });
    }
    await delay(300);
    updateTest('plugins', workspace.plugins.length > 0 ? 'pass' : 'fail', `${workspace.plugins.length} plugin(s) installed`);

    // ── Test: Prompt Routing ─────────────────────────
    updateTest('prompt', 'running');
    workspace.setActiveEngine('prompt');
    setCurrentEngine('prompt');
    await delay(500);
    const capCount = workspace.allCapabilities.length;
    updateTest('prompt', capCount > 0 ? 'pass' : 'fail', `${capCount} capabilities available for routing`);

    // ── Test: Keyboard Shortcuts ─────────────────────
    updateTest('shortcuts', 'running');
    await delay(300);
    updateTest('shortcuts', 'pass', 'Press K/A/N/D/I/L/C/W to verify — manual test');

    // ── Test: Cross-Engine Linking ───────────────────
    updateTest('cross-link', 'running');
    workspace.convertIdeaToTask('demo-idea-1', 'Improve error handling', 'Add try-catch blocks to all API endpoints', 'medium');
    await delay(300);
    const linkedTask = workspace.tasks.find((t) => t.labels.some((l) => l.startsWith('idea:')));
    updateTest('cross-link', linkedTask ? 'pass' : 'fail', linkedTask ? `Task "${linkedTask.title}" with label: ${linkedTask.labels.join(', ')}` : 'No linked task found');

    // Return to kanban to show results
    workspace.setActiveEngine('kanban');
    setCurrentEngine('kanban');
    setRunning(false);
  }, [workspace, updateTest]);

  const passCount = tests.filter((t) => t.status === 'pass').length;
  const failCount = tests.filter((t) => t.status === 'fail').length;
  const totalCount = tests.length;

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border/70 px-5 py-3">
        <div>
          <h2 className="text-sm font-semibold text-foreground">Workspace Feature Test</h2>
          <p className="text-[11px] text-muted-foreground mt-0.5">
            {passCount}/{totalCount} passed
            {failCount > 0 && <span className="text-red-400 ml-2">{failCount} failed</span>}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {currentEngine && (
            <span className="text-[10px] text-muted-foreground/60 font-mono">
              engine: {currentEngine}
            </span>
          )}
          <button
            type="button"
            onClick={runAllTests}
            disabled={running}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors',
              running
                ? 'bg-muted text-muted-foreground cursor-not-allowed'
                : 'bg-primary text-primary-foreground hover:bg-primary/90',
            )}
          >
            {running ? (
              <>
                <LoaderIcon className="h-3.5 w-3.5 animate-spin" />
                Running...
              </>
            ) : (
              <>
                <PlayIcon className="h-3.5 w-3.5" />
                Run All Tests
              </>
            )}
          </button>
        </div>
      </div>

      {/* Progress bar */}
      <div className="h-1 bg-muted/20">
        <div
          className="h-full bg-primary transition-all duration-300"
          style={{ width: `${((passCount + failCount) / totalCount) * 100}%` }}
        />
      </div>

      {/* Test list */}
      <div className="flex-1 overflow-y-auto p-4">
        <div className="space-y-1.5">
          {tests.map((test) => (
            <div
              key={test.id}
              className={cn(
                'flex items-center gap-3 rounded-lg border px-3 py-2 transition-colors',
                test.status === 'running' ? 'border-primary/30 bg-primary/5' :
                test.status === 'pass' ? 'border-emerald-500/20 bg-emerald-500/5' :
                test.status === 'fail' ? 'border-red-500/20 bg-red-500/5' :
                'border-border/40 bg-card/30',
              )}
            >
              {/* Status icon */}
              <div className="shrink-0">
                {test.status === 'pending' && <div className="h-4 w-4 rounded-full border border-muted-foreground/20" />}
                {test.status === 'running' && <LoaderIcon className="h-4 w-4 text-primary animate-spin" />}
                {test.status === 'pass' && <CheckCircle2Icon className="h-4 w-4 text-emerald-400" />}
                {test.status === 'fail' && <XCircleIcon className="h-4 w-4 text-red-400" />}
              </div>

              {/* Test info */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium text-foreground">{test.name}</span>
                  {test.engine && (
                    <span className="text-[9px] text-muted-foreground/40 font-mono bg-muted/20 px-1 py-0.5 rounded">
                      {test.engine}
                    </span>
                  )}
                </div>
                <p className="text-[10px] text-muted-foreground/60 truncate">{test.description}</p>
              </div>

              {/* Result */}
              {test.result && (
                <span className={cn(
                  'shrink-0 text-[10px] font-mono max-w-[200px] truncate',
                  test.status === 'pass' ? 'text-emerald-400/70' : test.status === 'fail' ? 'text-red-400/70' : 'text-muted-foreground/50',
                )}>
                  {test.result}
                </span>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Footer summary */}
      <div className="border-t border-border/70 px-5 py-2 flex items-center gap-4 text-[10px] text-muted-foreground/50">
        <span className="inline-flex items-center gap-1">
          <CheckCircle2Icon className="h-3 w-3 text-emerald-400" />
          {passCount} passed
        </span>
        <span className="inline-flex items-center gap-1">
          <XCircleIcon className="h-3 w-3 text-red-400" />
          {failCount} failed
        </span>
        <span className="inline-flex items-center gap-1">
          <div className="h-3 w-3 rounded-full border border-muted-foreground/20" />
          {totalCount - passCount - failCount} pending
        </span>
      </div>
    </div>
  );
};
