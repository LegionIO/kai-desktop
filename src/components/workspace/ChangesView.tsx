import { useState, useEffect, useCallback, useRef, type FC } from 'react';
import {
  GitCompareIcon,
  LoaderIcon,
  FileIcon,
  FilePlusIcon,
  FileMinusIcon,
  FileEditIcon,
  FileQuestionIcon,
  CheckSquareIcon,
  SquareIcon,
  CodeIcon,
  FolderOpenIcon,
  GlobeIcon,
  Trash2Icon,
  AlertTriangleIcon,
  ArrowUpCircleIcon,
  XIcon,
  UndoIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useWorkspace } from '@/providers/WorkspaceProvider';
import { app } from '@/lib/ipc-client';
import { DiffView } from './DiffView';
import { GitToolbar } from './GitToolbar';
import { HistoryView } from './HistoryView';
import { useGitState } from '@/hooks/useGitState';

/* ── Status badge config ────────────────────────────────── */

const STATUS_CONFIG: Record<string, { label: string; Icon: typeof FileIcon; className: string }> = {
  M:  { label: 'Modified', Icon: FileEditIcon,     className: 'text-amber-400' },
  MM: { label: 'Modified', Icon: FileEditIcon,     className: 'text-amber-400' },
  A:  { label: 'Added',    Icon: FilePlusIcon,     className: 'text-emerald-400' },
  AM: { label: 'Added',    Icon: FilePlusIcon,     className: 'text-emerald-400' },
  D:  { label: 'Deleted',  Icon: FileMinusIcon,    className: 'text-red-400' },
  R:  { label: 'Renamed',  Icon: FileEditIcon,     className: 'text-blue-400' },
  '??': { label: 'Untracked', Icon: FileQuestionIcon, className: 'text-muted-foreground/60' },
};

function getStatusConfig(status: string) {
  return STATUS_CONFIG[status] ?? STATUS_CONFIG[status[0]] ?? { label: status, Icon: FileIcon, className: 'text-muted-foreground' };
}

function fileName(path: string): string {
  return path.split('/').pop() ?? path;
}

function fileDir(path: string): string {
  const parts = path.split('/');
  if (parts.length <= 1) return '';
  return parts.slice(0, -1).join('/');
}

function getDisplayStatus(indexStatus: string, worktreeStatus: string): string {
  if (indexStatus === '?' && worktreeStatus === '?') return '??';
  if (indexStatus !== ' ' && indexStatus !== '?') return indexStatus;
  return worktreeStatus;
}

/* ── Context Menu ───────────────────────────────────────── */

interface ContextMenuState {
  visible: boolean;
  x: number;
  y: number;
  filePath: string;
}

const ContextMenu: FC<{
  state: ContextMenuState;
  projectPath: string;
  onClose: () => void;
  onDiscardRequest: (filePath: string) => void;
}> = ({ state, projectPath, onClose, onDiscardRequest }) => {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!state.visible) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [state.visible, onClose]);

  if (!state.visible) return null;

  const fullPath = projectPath + '/' + state.filePath;

  const items: Array<{
    label: string;
    onClick: () => void;
    className?: string;
    separator?: false;
  } | { separator: true }> = [
    {
      label: 'Discard Changes...',
      onClick: () => { onClose(); onDiscardRequest(state.filePath); },
      className: 'text-red-400 hover:text-red-300',
    },
    { separator: true },
    {
      label: 'Copy File Path',
      onClick: () => { navigator.clipboard.writeText(fullPath); onClose(); },
    },
    {
      label: 'Copy Relative File Path',
      onClick: () => { navigator.clipboard.writeText(state.filePath); onClose(); },
    },
    { separator: true },
    {
      label: 'Reveal in Finder',
      onClick: () => { app.git.showFileInFinder(projectPath, state.filePath); onClose(); },
    },
    {
      label: 'Open in Visual Studio Code',
      onClick: () => { app.git.openFileInEditor(projectPath, state.filePath); onClose(); },
    },
  ];

  return (
    <div
      ref={menuRef}
      className="fixed z-50 min-w-52 rounded-lg border border-border/60 bg-popover py-1 shadow-xl animate-in fade-in-0 zoom-in-95"
      style={{ top: state.y, left: state.x }}
    >
      {items.map((item, idx) =>
        'separator' in item && item.separator ? (
          <div key={idx} className="my-1 border-t border-border/30" />
        ) : (
          <button
            key={idx}
            type="button"
            onClick={(item as Exclude<typeof item, { separator: true }>).onClick}
            className={cn(
              'flex w-full items-center gap-2 px-3 py-1.5 text-left text-[11px] text-muted-foreground transition-colors hover:bg-muted/30 hover:text-foreground',
              (item as Exclude<typeof item, { separator: true }>).className,
            )}
          >
            {(item as Exclude<typeof item, { separator: true }>).label}
          </button>
        ),
      )}
    </div>
  );
};

/* ── Discard Confirmation Dialog ────────────────────────── */

const DiscardDialog: FC<{
  filePath: string | null;
  onCancel: () => void;
  onConfirm: () => void;
  isDiscarding: boolean;
}> = ({ filePath, onCancel, onConfirm, isDiscarding }) => {
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!filePath) return;
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [filePath, onCancel]);

  if (!filePath) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 animate-in fade-in-0">
      <div
        ref={dialogRef}
        className="w-full max-w-md rounded-xl border border-border/60 bg-popover p-6 shadow-2xl animate-in zoom-in-95"
      >
        <div className="flex items-start gap-3">
          <div className="mt-0.5 rounded-full bg-red-500/10 p-2">
            <AlertTriangleIcon className="h-5 w-5 text-red-400" />
          </div>
          <div className="flex-1">
            <h3 className="text-sm font-semibold text-foreground">Confirm Discard Changes</h3>
            <p className="mt-2 text-xs text-muted-foreground">
              Are you sure you want to discard all changes to:
            </p>
            <p className="mt-1.5 rounded-md bg-muted/20 px-2.5 py-1.5 font-mono text-xs text-foreground">
              {filePath}
            </p>
            <p className="mt-2 text-[10px] text-muted-foreground/60">
              Changes can be restored by retrieving them from the Trash.
            </p>
          </div>
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={isDiscarding}
            className="rounded-md border border-border/50 px-3.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/20 hover:text-foreground disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={isDiscarding}
            className="flex items-center gap-1.5 rounded-md bg-red-600 px-3.5 py-1.5 text-xs font-medium text-white transition-colors hover:bg-red-500 disabled:opacity-50"
          >
            {isDiscarding ? (
              <LoaderIcon className="h-3 w-3 animate-spin" />
            ) : (
              <Trash2Icon className="h-3 w-3" />
            )}
            Discard Changes
          </button>
        </div>
      </div>
    </div>
  );
};

/* ── Post-Commit Banner ─────────────────────────────────── */

const PostCommitBanner: FC<{
  commitMessage: string;
  onDismiss: () => void;
}> = ({ commitMessage, onDismiss }) => {
  useEffect(() => {
    const timer = setTimeout(onDismiss, 10000);
    return () => clearTimeout(timer);
  }, [onDismiss]);

  return (
    <div className="flex items-center gap-2 border-t border-emerald-500/20 bg-emerald-500/5 px-3 py-2 animate-in slide-in-from-bottom-2">
      <CheckSquareIcon className="h-3.5 w-3.5 shrink-0 text-emerald-400" />
      <div className="min-w-0 flex-1">
        <span className="text-[11px] font-medium text-emerald-300">Committed just now</span>
        <span className="ml-1.5 text-[10px] text-muted-foreground/60 truncate">{commitMessage}</span>
      </div>
      <button
        type="button"
        onClick={onDismiss}
        className="flex items-center gap-1 rounded-md border border-border/30 px-2 py-0.5 text-[10px] font-medium text-muted-foreground transition-colors hover:bg-muted/20 hover:text-foreground"
      >
        <XIcon className="h-2.5 w-2.5" />
        Dismiss
      </button>
      <button
        type="button"
        onClick={onDismiss}
        className="shrink-0 rounded p-0.5 text-muted-foreground/40 transition-colors hover:text-foreground"
      >
        <XIcon className="h-3 w-3" />
      </button>
    </div>
  );
};

/* ── Push Commits Card ──────────────────────────────────── */

const PushCommitsCard: FC<{
  ahead: number;
  onPush: () => void;
  pushing: boolean;
}> = ({ ahead, onPush, pushing }) => {
  return (
    <div className="w-full max-w-lg rounded-lg border border-blue-500/30 bg-blue-500/5 p-4">
      <div className="flex items-start gap-3">
        <ArrowUpCircleIcon className="mt-0.5 h-5 w-5 shrink-0 text-blue-400" />
        <div className="flex-1">
          <p className="text-xs font-semibold text-blue-300">Push commits to the origin remote</p>
          <p className="mt-1 text-[10px] text-muted-foreground/60">
            You have {ahead} local commit{ahead !== 1 ? 's' : ''} waiting to be pushed to GitHub.
          </p>
          <button
            type="button"
            onClick={onPush}
            disabled={pushing}
            className="mt-2.5 flex items-center gap-1.5 rounded-md bg-blue-600 px-3.5 py-1.5 text-[11px] font-medium text-white transition-colors hover:bg-blue-500 disabled:opacity-50"
          >
            {pushing ? (
              <LoaderIcon className="h-3 w-3 animate-spin" />
            ) : (
              <ArrowUpCircleIcon className="h-3 w-3" />
            )}
            Push origin
          </button>
        </div>
      </div>
    </div>
  );
};

/* ── Component ──────────────────────────────────────────── */

export const ChangesView: FC = () => {
  const { project } = useWorkspace();
  const projectPath = project?.path ?? '';

  const git = useGitState(projectPath);
  const [activeTab, setActiveTab] = useState<'changes' | 'history'>('changes');
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [diff, setDiff] = useState('');
  const [diffLoading, setDiffLoading] = useState(false);
  const [commitSummary, setCommitSummary] = useState('');
  const [commitDescription, setCommitDescription] = useState('');
  const [isCommitting, setIsCommitting] = useState(false);
  const [commitError, setCommitError] = useState('');

  // Context menu state
  const [contextMenu, setContextMenu] = useState<ContextMenuState>({
    visible: false,
    x: 0,
    y: 0,
    filePath: '',
  });

  // Discard dialog state
  const [discardFilePath, setDiscardFilePath] = useState<string | null>(null);
  const [isDiscarding, setIsDiscarding] = useState(false);

  // Post-commit banner state
  const [postCommitMessage, setPostCommitMessage] = useState<string | null>(null);

  // Load history when switching to history tab
  useEffect(() => {
    if (activeTab === 'history') {
      git.loadHistory();
    }
  }, [activeTab]);

  // Auto-select first file
  useEffect(() => {
    if (git.files.length > 0 && !selectedFile) {
      setSelectedFile(git.files[0].path);
    }
    // Clear selection if file no longer exists in list
    if (selectedFile && !git.files.find((f) => f.path === selectedFile)) {
      setSelectedFile(git.files.length > 0 ? git.files[0].path : null);
    }
  }, [git.files]);

  // Fetch diff when selected file changes
  useEffect(() => {
    if (!projectPath || !selectedFile) {
      setDiff('');
      return;
    }
    let cancelled = false;
    setDiffLoading(true);
    app.git.diff(projectPath, selectedFile).then((result) => {
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
  }, [projectPath, selectedFile]);

  const handleToggleStage = useCallback(async (filePath: string, isCurrentlyStaged: boolean) => {
    if (isCurrentlyStaged) {
      await git.unstage([filePath]);
    } else {
      await git.stage([filePath]);
    }
  }, [git]);

  const handleToggleAll = useCallback(async () => {
    const allStaged = git.files.every((f) => f.staged);
    if (allStaged) {
      await git.unstageAll();
    } else {
      await git.stageAll();
    }
  }, [git]);

  const handleCommit = useCallback(async () => {
    if (!commitSummary.trim()) return;
    const stagedFiles = git.files.filter((f) => f.staged);
    if (stagedFiles.length === 0) return;

    setIsCommitting(true);
    setCommitError('');
    const result = await git.commit(commitSummary.trim(), commitDescription.trim() || undefined);
    setIsCommitting(false);

    if (result.success) {
      setPostCommitMessage(commitSummary.trim());
      setCommitSummary('');
      setCommitDescription('');
    } else {
      setCommitError(result.error ?? 'Commit failed');
    }
  }, [commitSummary, commitDescription, git]);

  // Context menu handlers
  const handleContextMenu = useCallback((e: React.MouseEvent, filePath: string) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ visible: true, x: e.clientX, y: e.clientY, filePath });
  }, []);

  const closeContextMenu = useCallback(() => {
    setContextMenu((prev) => ({ ...prev, visible: false }));
  }, []);

  // Discard handlers
  const handleDiscardRequest = useCallback((filePath: string) => {
    setDiscardFilePath(filePath);
  }, []);

  const handleDiscardConfirm = useCallback(async () => {
    if (!discardFilePath || !projectPath) return;
    setIsDiscarding(true);
    try {
      await app.git.discard(projectPath, [discardFilePath]);
      await git.refreshFiles();
    } catch {
      // Silently fail — the file list refresh will show reality
    } finally {
      setIsDiscarding(false);
      setDiscardFilePath(null);
    }
  }, [discardFilePath, projectPath, git]);

  const handleDiscardCancel = useCallback(() => {
    setDiscardFilePath(null);
  }, []);

  const dismissPostCommitBanner = useCallback(() => {
    setPostCommitMessage(null);
  }, []);

  // Stats
  const stagedCount = git.files.filter((f) => f.staged).length;
  const totalCount = git.files.length;
  const allStaged = totalCount > 0 && stagedCount === totalCount;

  if (!projectPath) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-muted-foreground/50">Open a project to view changes</p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* Git Toolbar */}
      <GitToolbar
        currentBranch={git.currentBranch}
        branches={git.branches}
        defaultBranch={git.defaultBranch}
        remoteStatus={git.remoteStatus}
        lastFetchTime={git.lastFetchTime}
        syncing={git.syncing}
        activeTab={activeTab}
        onTabChange={setActiveTab}
        onCheckout={git.checkout}
        onCreateBranch={git.createBranch}
        onFetch={git.fetchOrigin}
        onPull={git.pullOrigin}
        onPush={git.pushOrigin}
      />

      {/* Tab Content */}
      {activeTab === 'history' ? (
        <HistoryView
          projectPath={projectPath}
          commits={git.commits}
          loading={git.loading}
          onLoadMore={() => git.loadHistory((git.commits.length || 50) + 50)}
        />
      ) : (
        /* Changes content */
        git.files.length === 0 && !git.loading ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-4 text-center px-8">
            <GitCompareIcon className="h-10 w-10 text-muted-foreground/40" />
            <div>
              <p className="text-base font-semibold text-muted-foreground">No local changes</p>
              <p className="mt-1 text-xs text-muted-foreground/60">
                There are no uncommitted changes in this repository. Here are some friendly suggestions for what to do next.
              </p>
            </div>

            {/* Push commits card - shown when ahead of remote */}
            {git.remoteStatus.ahead > 0 && (
              <PushCommitsCard
                ahead={git.remoteStatus.ahead}
                onPush={git.pushOrigin}
                pushing={git.syncing}
              />
            )}

            {/* Quick action cards */}
            <div className="mt-2 w-full max-w-lg space-y-0 rounded-lg border border-border/50 overflow-hidden">
              {/* Open in VS Code */}
              <div className="flex items-center justify-between border-b border-border/40 px-4 py-3">
                <div>
                  <p className="text-xs font-medium text-foreground">Open the repository in your external editor</p>
                  <p className="mt-0.5 text-[10px] text-muted-foreground/50">Open in Visual Studio Code</p>
                </div>
                <button
                  type="button"
                  onClick={() => app.git.openInEditor(projectPath)}
                  className="flex items-center gap-1.5 rounded-md border border-border/50 bg-muted/10 px-3 py-1.5 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted/30 hover:text-foreground"
                >
                  <CodeIcon className="h-3.5 w-3.5" />
                  Open in Visual Studio Code
                </button>
              </div>

              {/* Show in Finder */}
              <div className="flex items-center justify-between border-b border-border/40 px-4 py-3">
                <div>
                  <p className="text-xs font-medium text-foreground">View the files of your repository in Finder</p>
                  <p className="mt-0.5 text-[10px] text-muted-foreground/50">Open the project folder</p>
                </div>
                <button
                  type="button"
                  onClick={() => app.git.showInFinder(projectPath)}
                  className="flex items-center gap-1.5 rounded-md border border-border/50 bg-muted/10 px-3 py-1.5 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted/30 hover:text-foreground"
                >
                  <FolderOpenIcon className="h-3.5 w-3.5" />
                  Show in Finder
                </button>
              </div>

              {/* View on GitHub */}
              <div className="flex items-center justify-between px-4 py-3">
                <div>
                  <p className="text-xs font-medium text-foreground">Open the repository page on GitHub in your browser</p>
                  <p className="mt-0.5 text-[10px] text-muted-foreground/50">View on GitHub</p>
                </div>
                <button
                  type="button"
                  onClick={async () => {
                    const result = await app.git.remoteUrl(projectPath);
                    if (result.url) app.git.openUrl(result.url);
                  }}
                  className="flex items-center gap-1.5 rounded-md border border-border/50 bg-muted/10 px-3 py-1.5 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted/30 hover:text-foreground"
                >
                  <GlobeIcon className="h-3.5 w-3.5" />
                  View on GitHub
                </button>
              </div>
            </div>
          </div>
        ) : (
          <div className="flex min-h-0 flex-1">
            {/* Left panel: file list + commit form */}
            <div className="flex w-72 shrink-0 flex-col border-r border-border/50 bg-muted/5">
              {/* File list header with select-all checkbox */}
              <div className="flex items-center gap-2 border-b border-border/40 px-3 py-2">
                <button
                  type="button"
                  onClick={handleToggleAll}
                  className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
                >
                  {allStaged ? (
                    <CheckSquareIcon className="h-3.5 w-3.5 text-primary" />
                  ) : (
                    <SquareIcon className="h-3.5 w-3.5" />
                  )}
                </button>
                <span className="text-[10px] font-medium text-muted-foreground">
                  {totalCount} changed file{totalCount !== 1 ? 's' : ''}
                </span>
              </div>

              {/* Scrollable file list */}
              <div className="flex-1 overflow-y-auto">
                <div className="p-1">
                  {git.loading && git.files.length === 0 ? (
                    <div className="flex items-center justify-center py-6">
                      <LoaderIcon className="h-4 w-4 animate-spin text-muted-foreground/40" />
                    </div>
                  ) : (
                    git.files.map((file) => {
                      const displayStatus = getDisplayStatus(file.indexStatus, file.worktreeStatus);
                      const cfg = getStatusConfig(displayStatus);
                      const isSelected = selectedFile === file.path;

                      return (
                        <div
                          key={file.path}
                          onContextMenu={(e) => handleContextMenu(e, file.path)}
                          className={cn(
                            'flex items-center gap-1.5 rounded-md px-1.5 py-1 transition-colors',
                            isSelected
                              ? 'bg-primary/10 text-foreground'
                              : 'text-muted-foreground hover:bg-muted/20 hover:text-foreground',
                          )}
                        >
                          {/* Staging checkbox */}
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); handleToggleStage(file.path, file.staged); }}
                            className="shrink-0 p-0.5"
                          >
                            {file.staged ? (
                              <CheckSquareIcon className="h-3.5 w-3.5 text-primary" />
                            ) : (
                              <SquareIcon className="h-3.5 w-3.5 text-muted-foreground/40" />
                            )}
                          </button>

                          {/* File button */}
                          <button
                            type="button"
                            onClick={() => setSelectedFile(file.path)}
                            className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                          >
                            <cfg.Icon className={cn('h-3 w-3 shrink-0', cfg.className)} />
                            <div className="min-w-0 flex-1">
                              <div className="truncate text-[11px] font-medium">{fileName(file.path)}</div>
                              {fileDir(file.path) && (
                                <div className="truncate text-[9px] text-muted-foreground/40">{fileDir(file.path)}</div>
                              )}
                            </div>
                            <span className={cn('shrink-0 rounded px-1 py-0.5 text-[8px] font-bold uppercase', cfg.className)}>
                              {displayStatus}
                            </span>
                          </button>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>

              {/* Post-commit banner */}
              {postCommitMessage && (
                <PostCommitBanner
                  commitMessage={postCommitMessage}
                  onDismiss={dismissPostCommitBanner}
                />
              )}

              {/* Commit form */}
              <div className="border-t border-border/50 p-3">
                {commitError && (
                  <div className="mb-2 rounded-md border border-red-500/30 bg-red-500/10 px-2 py-1 text-[10px] text-red-400">
                    {commitError}
                  </div>
                )}
                <input
                  type="text"
                  placeholder="Summary (required)"
                  value={commitSummary}
                  onChange={(e) => setCommitSummary(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) handleCommit(); }}
                  className="mb-2 h-8 w-full rounded-md border border-border/40 bg-muted/10 px-2.5 text-xs text-foreground placeholder:text-muted-foreground/40 focus:border-primary/50 focus:outline-none"
                />
                <textarea
                  placeholder="Description"
                  value={commitDescription}
                  onChange={(e) => setCommitDescription(e.target.value)}
                  rows={3}
                  className="mb-2 w-full resize-none rounded-md border border-border/40 bg-muted/10 px-2.5 py-1.5 text-xs text-foreground placeholder:text-muted-foreground/40 focus:border-primary/50 focus:outline-none"
                />
                <button
                  type="button"
                  onClick={handleCommit}
                  disabled={!commitSummary.trim() || stagedCount === 0 || isCommitting}
                  className="flex h-8 w-full items-center justify-center gap-1.5 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {isCommitting ? (
                    <LoaderIcon className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <>Commit to <span className="font-bold">{git.currentBranch || 'branch'}</span></>
                  )}
                </button>
              </div>
            </div>

            {/* Right panel: diff */}
            <div className="min-w-0 flex-1">
              {diffLoading ? (
                <div className="flex h-full items-center justify-center">
                  <LoaderIcon className="h-5 w-5 animate-spin text-muted-foreground/40" />
                </div>
              ) : selectedFile ? (
                <DiffView diff={diff} filePath={selectedFile} />
              ) : (
                <div className="flex h-full items-center justify-center text-xs text-muted-foreground/40">
                  Select a file to view changes
                </div>
              )}
            </div>
          </div>
        )
      )}

      {/* Context Menu (portal-level, rendered outside scroll containers) */}
      <ContextMenu
        state={contextMenu}
        projectPath={projectPath}
        onClose={closeContextMenu}
        onDiscardRequest={handleDiscardRequest}
      />

      {/* Discard Confirmation Dialog */}
      <DiscardDialog
        filePath={discardFilePath}
        onCancel={handleDiscardCancel}
        onConfirm={handleDiscardConfirm}
        isDiscarding={isDiscarding}
      />
    </div>
  );
};
