import type { FC, ReactNode } from 'react';
import type { SidebarTab } from '../../../electron/config/schema';
import { InboxIcon } from 'lucide-react';
import { StubPanel } from './StubPanel';

interface ContentPanelProps {
  activeTab: SidebarTab;
  /** Rendered when tab === 'chats' */
  chatsContent: ReactNode;
  /** Rendered when tab === 'tasks' */
  tasksContent: ReactNode;
  /** Rendered when tab === 'plugins' */
  pluginsContent: ReactNode;
  /** Rendered when tab === 'agents' */
  agentsContent: ReactNode;
}

export const ContentPanel: FC<ContentPanelProps> = ({
  activeTab,
  chatsContent,
  tasksContent,
  pluginsContent,
  agentsContent,
}) => {
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      {activeTab === 'chats' && chatsContent}
      {activeTab === 'tasks' && tasksContent}
      {activeTab === 'plugins' && pluginsContent}
      {activeTab === 'agents' && agentsContent}
      {activeTab === 'messages' && (
        <StubPanel
          icon={<InboxIcon size={40} strokeWidth={1.2} />}
          title="Messages"
          description="Cross-workspace messaging is coming in a future release."
        />
      )}
    </div>
  );
};
