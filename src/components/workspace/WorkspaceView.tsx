import type { FC } from 'react';
import { useWorkspace } from '@/providers/WorkspaceProvider';
import { ProjectSelector } from './ProjectSelector';
import { TaskBoard } from './TaskBoard';
import { TaskThreadView } from './TaskThreadView';
import { ChangesView } from './ChangesView';
import { AnalysisView } from './AnalysisView';
import { ChangelogView } from './ChangelogView';
import { PluginManager } from './PluginManager';
import { GitHubIssuesView } from './GitHubIssuesView';
// Legacy views (kept as fallbacks during transition)
import { KanbanBoard } from './KanbanBoard';
import { InsightsView } from './InsightsView';
import { RoadmapView } from './RoadmapView';
import { IdeationView } from './IdeationView';

export const WorkspaceView: FC = () => {
  const { project, activeEngine } = useWorkspace();

  if (!project) return <ProjectSelector />;

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
