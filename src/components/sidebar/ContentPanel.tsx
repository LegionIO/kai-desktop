import type { FC, ReactNode } from 'react';
import { InboxIcon, BotIcon } from 'lucide-react';
import { StubPanel } from './StubPanel';
import type { SidebarTab } from '../../../electron/config/schema';

interface ContentPanelProps {
  activeTab: SidebarTab;
  /** Rendered when tab === 'chats' */
  chatsContent: ReactNode;
  /** Rendered when tab === 'tasks' */
  tasksContent: ReactNode;
  /** Rendered when tab === 'plugins' */
  pluginsContent: ReactNode;
}

export const ContentPanel: FC<ContentPanelProps> = ({
  activeTab,
  chatsContent,
  tasksContent,
  pluginsContent,
}) => {
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      {activeTab === 'chats' && chatsContent}
      {activeTab === 'tasks' && tasksContent}
      {activeTab === 'plugins' && pluginsContent}
      {activeTab === 'messages' && (
        <StubPanel
          icon={<InboxIcon size={40} strokeWidth={1.2} />}
          title="Messages"
          description="Cross-workspace messaging is coming in a future release."
        />
      )}
      {activeTab === 'agents' && (
        <StubPanel
          icon={<BotIcon size={40} strokeWidth={1.2} />}
          title="Agents"
          description="Agent management is coming in a future release."
        />
      )}
    </div>
  );
};
