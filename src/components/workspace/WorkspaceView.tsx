import type { FC } from 'react';
import { useWorkspace } from '@/providers/WorkspaceProvider';
import { ProjectSelector } from './ProjectSelector';
import { TaskBoard } from './TaskBoard';
import { TaskThreadView } from './TaskThreadView';
import { ChangesView } from './ChangesView';
import { AnalysisView } from './AnalysisView';
import { ChangelogView } from './ChangelogView';
import { ContextView } from './ContextView';
import { WorktreesView } from './WorktreesView';
import { PluginManager } from './PluginManager';
import { GitHubIssuesView } from './GitHubIssuesView';
// Legacy views (kept as fallbacks during transition)
import { KanbanBoard } from './KanbanBoard';
import { InsightsView } from './InsightsView';
import { RoadmapView } from './RoadmapView';
import { IdeationView } from './IdeationView';

export const WorkspaceView: FC = () => {
  const { project, activeEngine } = useWorkspace();

  if (!project) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center">
          <p className="text-sm font-medium text-muted-foreground">No repository selected</p>
          <p className="mt-1 text-xs text-muted-foreground/50">Use the repository selector in the sidebar to open a project</p>
        </div>
      </div>
    );
  }

  // Plugin sidebar routes (e.g. "plugin:github:github-issues")
  if (activeEngine.startsWith('plugin:github:')) {
    return <GitHubIssuesView />;
  }

  switch (activeEngine) {
    // New primary routes
    case 'tasks':       return <TaskBoard />;
    case 'task-thread': return <TaskThreadView />;
    case 'git':         return <ChangesView />;
    case 'analysis':    return <AnalysisView />;
    case 'changelog':   return <ChangelogView />;
    case 'context':     return <ContextView />;
    case 'worktrees':   return <WorktreesView />;
    case 'plugins':     return <PluginManager />;
    // Legacy routes (still reachable via direct navigation)
    case 'kanban':      return <KanbanBoard />;
    case 'changes':     return <ChangesView />;
    case 'insights':    return <InsightsView />;
    case 'roadmap':     return <RoadmapView />;
    case 'ideation':    return <IdeationView />;
    // Default: task board
    default:            return <TaskBoard />;
  }
};
