import { useState, useEffect, useCallback, type FC } from 'react';
import { GitBranchIcon, PlusIcon, Loader2Icon, AlertCircleIcon } from 'lucide-react';
import { generateId } from '@/lib/utils';
import type { Worktree } from '../../../shared/workspace-types';
import { WorktreeCard } from './WorktreeCard';
import { useWorkspace } from '@/providers/WorkspaceProvider';
import { app } from '@/lib/ipc-client';

/* ── Component ──────────────────────────────────────────── */

export const WorktreesView: FC = () => {
  const { project } = useWorkspace();
  const [worktrees, setWorktrees] = useState<Worktree[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [branchInput, setBranchInput] = useState('');
  const [showInput, setShowInput] = useState(false);

  // Load worktrees from git
  const loadWorktrees = useCallback(async () => {
    if (!project) {
      setWorktrees([]);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = await app.git.listWorktrees(project.path);
      if (result.error) {
        setError(result.error);
        setWorktrees([]);
      } else {
        setWorktrees(
          result.worktrees.map((wt) => ({
            id: wt.path || wt.head || generateId(),
            branch: wt.branch,
            path: wt.path,
            status: 'active' as const,
            createdAt: Date.now(),
          })),
        );
      }
    } catch (err) {
      setError(String(err));
      setWorktrees([]);
    } finally {
      setLoading(false);
    }
  }, [project]);

  useEffect(() => {
    void loadWorktrees();
  }, [loadWorktrees]);

  const handleCreate = useCallback(async () => {
    const trimmed = branchInput.trim();
    if (!trimmed || !project) return;
    setCreating(true);
    setError(null);
    try {
      const result = await app.git.createWorktree(project.path, trimmed);
      if (result.error) {
        setError(result.error);
      } else {
        setBranchInput('');
        setShowInput(false);
        await loadWorktrees();
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setCreating(false);
    }
  }, [branchInput, project, loadWorktrees]);

  const handleRemove = useCallback(async (wt: Worktree) => {
    if (!project) return;
    setError(null);
    try {
      const result = await app.git.removeWorktree(project.path, wt.path);
      if (result.error) {
        setError(result.error);
      } else {
        await loadWorktrees();
      }
    } catch (err) {
      setError(String(err));
    }
  }, [project, loadWorktrees]);

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border/70 px-5 py-3">
        <h2 className="text-sm font-semibold text-foreground">Worktrees</h2>
        <button
          type="button"
          onClick={() => setShowInput((v) => !v)}
          disabled={!project}
          className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-40"
        >
          <PlusIcon className="h-3.5 w-3.5" />
          Create Worktree
        </button>
      </div>

      {/* Branch name input */}
      {showInput && (
        <div className="flex items-center gap-2 border-b border-border/40 px-5 py-2">
          <input
            type="text"
            value={branchInput}
            onChange={(e) => setBranchInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void handleCreate(); }}
            placeholder="feature/branch-name"
            autoFocus
            className="flex-1 rounded-lg border border-border bg-card px-3 py-1.5 text-xs text-foreground placeholder:text-muted-foreground/50 outline-none focus:ring-1 focus:ring-ring"
          />
          <button
            type="button"
            onClick={() => void handleCreate()}
            disabled={creating || !branchInput.trim()}
            className="rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-40"
          >
            {creating ? 'Creating...' : 'Create'}
          </button>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="flex items-center gap-2 border-b border-border/40 bg-destructive/5 px-5 py-2 text-xs text-destructive/80">
          <AlertCircleIcon className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">{error}</span>
        </div>
      )}

      {/* Content */}
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {loading ? (
          <div className="flex h-full flex-col items-center justify-center gap-3">
            <Loader2Icon className="h-6 w-6 animate-spin text-muted-foreground/40" />
            <p className="text-xs text-muted-foreground/50">Loading worktrees...</p>
          </div>
        ) : worktrees.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
            <GitBranchIcon className="h-10 w-10 text-muted-foreground/40" />
            <div>
              <p className="text-sm font-medium text-muted-foreground">No worktrees</p>
              <p className="mt-1 text-xs text-muted-foreground/60">
                {project ? 'Create isolated branches for tasks' : 'Open a project first'}
              </p>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {worktrees.map((wt) => (
              <WorktreeCard
                key={wt.id}
                worktree={wt}
                onRemove={() => void handleRemove(wt)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
