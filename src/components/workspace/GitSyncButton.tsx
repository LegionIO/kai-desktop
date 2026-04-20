import { type FC } from 'react';
import { RefreshCwIcon, ArrowDownIcon, ArrowUpIcon, LoaderIcon } from 'lucide-react';
import type { GitRemoteStatus } from '../../../shared/workspace-types';

interface GitSyncButtonProps {
  remoteStatus: GitRemoteStatus;
  lastFetchTime: number | null;
  syncing: boolean;
  onFetch: () => Promise<{ success: boolean; error?: string }>;
  onPull: () => Promise<{ success: boolean; error?: string }>;
  onPush: () => Promise<{ success: boolean; error?: string }>;
}

function formatLastFetch(ts: number | null): string {
  if (!ts) return '';
  const seconds = Math.floor((Date.now() - ts) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes === 1) return '1 minute ago';
  if (minutes < 60) return `${minutes} minutes ago`;
  const hours = Math.floor(minutes / 60);
  if (hours === 1) return '1 hour ago';
  return `${hours} hours ago`;
}

export const GitSyncButton: FC<GitSyncButtonProps> = ({
  remoteStatus,
  lastFetchTime,
  syncing,
  onFetch,
  onPull,
  onPush,
}) => {
  const { ahead, behind } = remoteStatus;

  if (syncing) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-border/50 bg-muted/10 px-3 py-1.5 text-xs font-medium text-muted-foreground">
        <LoaderIcon className="h-3.5 w-3.5 animate-spin" />
        <span>Syncing...</span>
      </div>
    );
  }

  if (behind > 0) {
    return (
      <button
        type="button"
        onClick={() => onPull()}
        className="flex items-center gap-2 rounded-lg border border-blue-500/30 bg-blue-500/10 px-3 py-1.5 text-xs font-medium text-blue-400 transition-colors hover:bg-blue-500/20"
      >
        <ArrowDownIcon className="h-3.5 w-3.5" />
        <span>Pull origin</span>
        <span className="rounded-full bg-blue-500/20 px-1.5 py-0.5 text-[9px] font-bold">{behind}</span>
      </button>
    );
  }

  if (ahead > 0) {
    return (
      <button
        type="button"
        onClick={() => onPush()}
        className="flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-1.5 text-xs font-medium text-emerald-400 transition-colors hover:bg-emerald-500/20"
      >
        <ArrowUpIcon className="h-3.5 w-3.5" />
        <span>Push origin</span>
        <span className="rounded-full bg-emerald-500/20 px-1.5 py-0.5 text-[9px] font-bold">{ahead}</span>
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={() => onFetch()}
      className="flex items-center gap-2 rounded-lg border border-border/50 bg-muted/10 px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/30 hover:text-foreground"
    >
      <RefreshCwIcon className="h-3.5 w-3.5" />
      <div className="flex flex-col items-start">
        <span>Fetch origin</span>
        {lastFetchTime && (
          <span className="text-[9px] text-muted-foreground/50">Last fetched {formatLastFetch(lastFetchTime)}</span>
        )}
      </div>
    </button>
  );
};
