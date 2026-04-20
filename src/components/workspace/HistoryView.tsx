import { useState, useEffect, useCallback, type FC } from 'react';
import { GitCommitHorizontalIcon, FileIcon, FilePlusIcon, FileMinusIcon, FileEditIcon, LoaderIcon, SearchIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { app } from '@/lib/ipc-client';
import { DiffView } from './DiffView';
import type { GitCommit } from '../../../shared/workspace-types';

interface HistoryViewProps {
  projectPath: string;
  commits: GitCommit[];
  loading: boolean;
  onLoadMore?: () => void;
}

const STATUS_MAP: Record<string, { label: string; Icon: typeof FileIcon; className: string }> = {
  M: { label: 'Modified', Icon: FileEditIcon, className: 'text-amber-400' },
  A: { label: 'Added', Icon: FilePlusIcon, className: 'text-emerald-400' },
  D: { label: 'Deleted', Icon: FileMinusIcon, className: 'text-red-400' },
  R: { label: 'Renamed', Icon: FileEditIcon, className: 'text-blue-400' },
};

function getStatusInfo(status: string) {
  return STATUS_MAP[status] ?? { label: status, Icon: FileIcon, className: 'text-muted-foreground' };
}

function timeAgo(timestamp: number): string {
  const seconds = Math.floor((Date.now() / 1000) - timestamp);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

function authorInitial(name: string): string {
  return name.charAt(0).toUpperCase();
}

interface CommitFile {
  path: string;
  status: string;
}

export const HistoryView: FC<HistoryViewProps> = ({ projectPath, commits, loading, onLoadMore }) => {
  const [selectedCommit, setSelectedCommit] = useState<string | null>(null);
  const [commitFiles, setCommitFiles] = useState<CommitFile[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [diff, setDiff] = useState('');
  const [filesLoading, setFilesLoading] = useState(false);
  const [diffLoading, setDiffLoading] = useState(false);
  const [filterText, setFilterText] = useState('');

  // Load files when a commit is selected
  useEffect(() => {
    if (!selectedCommit || !projectPath) {
      setCommitFiles([]);
      setSelectedFile(null);
      setDiff('');
      return;
    }
    let cancelled = false;
    setFilesLoading(true);
    app.git.show(projectPath, selectedCommit).then((result) => {
      if (!cancelled) {
        setCommitFiles(result.files ?? []);
        setSelectedFile(null);
        setDiff('');
        setFilesLoading(false);
      }
    }).catch(() => {
      if (!cancelled) {
        setCommitFiles([]);
        setFilesLoading(false);
      }
    });
    return () => { cancelled = true; };
  }, [selectedCommit, projectPath]);

  // Load diff when a file is selected within a commit
  useEffect(() => {
    if (!selectedCommit || !selectedFile || !projectPath) {
      setDiff('');
      return;
    }
    let cancelled = false;
    setDiffLoading(true);
    app.git.show(projectPath, selectedCommit, selectedFile).then((result) => {
      if (!cancelled) {
        setDiff(result.diff ?? '');
        setDiffLoading(false);
      }
    }).catch(() => {
      if (!cancelled) {
        setDiff('');
        setDiffLoading(false);
      }
    });
    return () => { cancelled = true; };
  }, [selectedCommit, selectedFile, projectPath]);

  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 100 && onLoadMore) {
      onLoadMore();
    }
  }, [onLoadMore]);

  const filteredCommits = filterText
    ? commits.filter((c) => c.message.toLowerCase().includes(filterText.toLowerCase()) || c.author.toLowerCase().includes(filterText.toLowerCase()))
    : commits;

  const selectedCommitData = commits.find((c) => c.hash === selectedCommit);

  return (
    <div className="flex h-full min-h-0">
      {/* Left: commit list */}
      <div className="flex w-80 shrink-0 flex-col border-r border-border/50">
        {/* Filter */}
        <div className="border-b border-border/40 p-2">
          <div className="relative">
            <SearchIcon className="absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground/40" />
            <input
              type="text"
              placeholder="Select Branch to Compare..."
              value={filterText}
              onChange={(e) => setFilterText(e.target.value)}
              className="h-7 w-full rounded-md border border-border/40 bg-muted/10 pl-7 pr-2 text-xs text-foreground placeholder:text-muted-foreground/40 focus:border-primary/50 focus:outline-none"
            />
          </div>
        </div>

        {/* Commit list */}
        <div className="flex-1 overflow-y-auto" onScroll={handleScroll}>
          {loading && commits.length === 0 ? (
            <div className="flex items-center justify-center py-8">
              <LoaderIcon className="h-5 w-5 animate-spin text-muted-foreground/40" />
            </div>
          ) : filteredCommits.length === 0 ? (
            <div className="py-8 text-center text-xs text-muted-foreground/50">No commits found</div>
          ) : (
            filteredCommits.map((commit) => (
              <button
                key={commit.hash}
                type="button"
                onClick={() => setSelectedCommit(commit.hash)}
                className={cn(
                  'flex w-full items-start gap-2.5 border-b border-border/30 px-3 py-2.5 text-left transition-colors',
                  selectedCommit === commit.hash
                    ? 'bg-primary/10'
                    : 'hover:bg-muted/20',
                )}
              >
                {/* Author avatar */}
                <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted/30 text-[10px] font-bold text-muted-foreground">
                  {authorInitial(commit.author)}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs font-medium text-foreground">{commit.message}</div>
                  <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-muted-foreground/60">
                    <span>{commit.author}</span>
                    <span>-</span>
                    <span>{timeAgo(commit.timestamp)}</span>
                  </div>
                </div>
              </button>
            ))
          )}
        </div>
      </div>

      {/* Right: commit detail */}
      <div className="flex min-w-0 flex-1 flex-col">
        {selectedCommitData ? (
          <>
            {/* Commit header */}
            <div className="border-b border-border/50 px-4 py-3">
              <div className="text-sm font-medium text-foreground">{selectedCommitData.message}</div>
              <div className="mt-1.5 flex items-center gap-3 text-[10px] text-muted-foreground/60">
                <div className="flex items-center gap-1">
                  <div className="flex h-4 w-4 items-center justify-center rounded-full bg-muted/30 text-[8px] font-bold">
                    {authorInitial(selectedCommitData.author)}
                  </div>
                  <span>{selectedCommitData.author}</span>
                </div>
                <div className="flex items-center gap-1">
                  <GitCommitHorizontalIcon className="h-3 w-3" />
                  <span className="font-mono">{selectedCommitData.shortHash}</span>
                </div>
                <span>{timeAgo(selectedCommitData.timestamp)}</span>
                {selectedCommitData.refs && (
                  <span className="rounded-full border border-border/40 px-1.5 py-0.5 text-[9px]">{selectedCommitData.refs}</span>
                )}
              </div>
            </div>

            {/* File list + diff */}
            <div className="flex min-h-0 flex-1">
              {/* Files sidebar */}
              <div className="w-56 shrink-0 overflow-y-auto border-r border-border/40 bg-muted/5">
                {filesLoading ? (
                  <div className="flex items-center justify-center py-6">
                    <LoaderIcon className="h-4 w-4 animate-spin text-muted-foreground/40" />
                  </div>
                ) : (
                  <div className="py-1">
                    <div className="px-3 py-1 text-[9px] font-semibold uppercase tracking-wider text-muted-foreground/50">
                      {commitFiles.length} changed file{commitFiles.length !== 1 ? 's' : ''}
                    </div>
                    {commitFiles.map((file) => {
                      const info = getStatusInfo(file.status);
                      const name = file.path.split('/').pop() ?? file.path;
                      const dir = file.path.includes('/') ? file.path.split('/').slice(0, -1).join('/') : '';
                      return (
                        <button
                          key={file.path}
                          type="button"
                          onClick={() => setSelectedFile(file.path)}
                          className={cn(
                            'flex w-full items-center gap-2 rounded-md px-2.5 py-1 text-left transition-colors mx-1',
                            selectedFile === file.path
                              ? 'bg-primary/10 text-foreground'
                              : 'text-muted-foreground hover:bg-muted/20 hover:text-foreground',
                          )}
                          style={{ width: 'calc(100% - 8px)' }}
                        >
                          <info.Icon className={cn('h-3 w-3 shrink-0', info.className)} />
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-[11px] font-medium">{name}</div>
                            {dir && <div className="truncate text-[9px] text-muted-foreground/40">{dir}</div>}
                          </div>
                          <span className={cn('shrink-0 text-[8px] font-bold uppercase', info.className)}>{file.status}</span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Diff panel */}
              <div className="min-w-0 flex-1">
                {diffLoading ? (
                  <div className="flex h-full items-center justify-center">
                    <LoaderIcon className="h-5 w-5 animate-spin text-muted-foreground/40" />
                  </div>
                ) : selectedFile && diff ? (
                  <DiffView diff={diff} filePath={selectedFile} />
                ) : (
                  <div className="flex h-full items-center justify-center text-xs text-muted-foreground/40">
                    {commitFiles.length > 0 ? 'Select a file to view changes' : 'Select a commit to view details'}
                  </div>
                )}
              </div>
            </div>
          </>
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground/40">
            <GitCommitHorizontalIcon className="h-8 w-8" />
            <span className="text-xs">Select a commit to view details</span>
          </div>
        )}
      </div>
    </div>
  );
};
