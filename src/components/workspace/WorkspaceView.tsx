import type { FC } from 'react';
import { useWorkspace } from '@/providers/WorkspaceProvider';
import { ProjectSelector } from './ProjectSelector';
import { KanbanBoard } from './KanbanBoard';
import { TerminalGrid } from './TerminalGrid';
import { InsightsView } from './InsightsView';
import { RoadmapView } from './RoadmapView';
import { IdeationView } from './IdeationView';
import { ChangelogView } from './ChangelogView';
import { ContextView } from './ContextView';
import { WorktreesView } from './WorktreesView';
import { PluginManager } from './PluginManager';
import { WorkspaceComposer } from './WorkspaceComposer';
import { WorkspaceEmpty } from './WorkspaceEmpty';

export const WorkspaceView: FC = () => {
  const { project, activeEngine } = useWorkspace();

  if (!project) return <ProjectSelector />;

  switch (activeEngine) {
    case 'kanban':    return <KanbanBoard />;
    case 'terminals': return <TerminalGrid />;
    case 'insights':  return <InsightsView />;
    case 'roadmap':   return <RoadmapView />;
    case 'ideation':  return <IdeationView />;
    case 'changelog': return <ChangelogView />;
    case 'context':   return <ContextView />;
    case 'worktrees': return <WorktreesView />;
    case 'plugins':   return <PluginManager />;
    case 'prompt':    return <WorkspaceComposer />;
    default:          return <WorkspaceEmpty />;
  }
};
