import { type FC } from 'react';
import { cn } from '@/lib/utils';
import { BranchSwitcher } from './BranchSwitcher';
import { GitSyncButton } from './GitSyncButton';
import type { GitBranch, GitRemoteStatus } from '../../../shared/workspace-types';

interface GitToolbarProps {
  currentBranch: string;
  branches: GitBranch[];
  defaultBranch: string;
  remoteStatus: GitRemoteStatus;
  lastFetchTime: number | null;
  syncing: boolean;
  activeTab: 'changes' | 'history';
  onTabChange: (tab: 'changes' | 'history') => void;
  onCheckout: (branchName: string) => Promise<{ success: boolean; error?: string }>;
  onCreateBranch: (branchName: string) => Promise<{ success: boolean; error?: string }>;
  onFetch: () => Promise<{ success: boolean; error?: string }>;
  onPull: () => Promise<{ success: boolean; error?: string }>;
  onPush: () => Promise<{ success: boolean; error?: string }>;
}

export const GitToolbar: FC<GitToolbarProps> = ({
  currentBranch,
  branches,
  defaultBranch,
  remoteStatus,
  lastFetchTime,
  syncing,
  activeTab,
  onTabChange,
  onCheckout,
  onCreateBranch,
  onFetch,
  onPull,
  onPush,
}) => {
  return (
    <div className="flex items-center gap-3 border-b border-border/70 px-4 py-2">
      {/* Branch switcher */}
      <BranchSwitcher
        currentBranch={currentBranch}
        branches={branches}
        defaultBranch={defaultBranch}
        onCheckout={onCheckout}
        onCreateBranch={onCreateBranch}
      />

      {/* Tabs */}
      <div className="flex items-center rounded-lg border border-border/40 bg-muted/10">
        <button
          type="button"
          onClick={() => onTabChange('changes')}
          className={cn(
            'rounded-l-lg px-3 py-1 text-xs font-medium transition-colors',
            activeTab === 'changes'
              ? 'bg-primary/15 text-primary'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          Changes
        </button>
        <button
          type="button"
          onClick={() => onTabChange('history')}
          className={cn(
            'rounded-r-lg px-3 py-1 text-xs font-medium transition-colors',
            activeTab === 'history'
              ? 'bg-primary/15 text-primary'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          History
        </button>
      </div>

      {/* Spacer */}
      <div className="flex-1" />

      {/* Sync button */}
      <GitSyncButton
        remoteStatus={remoteStatus}
        lastFetchTime={lastFetchTime}
        syncing={syncing}
        onFetch={onFetch}
        onPull={onPull}
        onPush={onPush}
      />
    </div>
  );
};
