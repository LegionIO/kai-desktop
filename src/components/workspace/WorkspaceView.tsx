import type { FC } from 'react';
import { useWorkspace } from '@/providers/WorkspaceProvider';
import { ProjectSelector } from './ProjectSelector';
import { KanbanBoard } from './KanbanBoard';
import { PluginManager } from './PluginManager';
import { WorkspaceComposer } from './WorkspaceComposer';
import { WorkspaceEmpty } from './WorkspaceEmpty';

export const WorkspaceView: FC = () => {
  const { project, activeEngine } = useWorkspace();

  if (!project) return <ProjectSelector />;

  switch (activeEngine) {
    case 'kanban':
      return <KanbanBoard />;
    case 'plugins':
      return <PluginManager />;
    case 'prompt':
      return <WorkspaceComposer />;
    default:
      return <WorkspaceEmpty />;
  }
};
