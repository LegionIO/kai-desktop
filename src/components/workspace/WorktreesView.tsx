import { useState, type FC } from 'react';
import { GitBranchIcon, PlusIcon } from 'lucide-react';
import { generateId } from '@/lib/utils';
import type { Worktree } from '../../../shared/workspace-types';
import { WorktreeCard } from './WorktreeCard';

/* ── Sample worktree generation ─────────────────────────── */

let worktreeCounter = 0;

function createSampleWorktree(): Worktree {
  worktreeCounter += 1;
  const branchName = `feature/task-${100 + worktreeCounter}`;

  return {
    id: generateId(),
    branch: branchName,
    path: `~/.worktrees/${branchName.replace('/', '-')}`,
    taskTitle: worktreeCounter % 3 === 0 ? undefined : `Implement ${branchName.split('/')[1]} functionality`,
    status: 'active',
    createdAt: Date.now(),
  };
}

/* ── Component ──────────────────────────────────────────── */

export const WorktreesView: FC = () => {
  const [worktrees, setWorktrees] = useState<Worktree[]>([]);

  const handleCreate = () => {
    setWorktrees((prev) => [createSampleWorktree(), ...prev]);
  };

  const handleRemove = (id: string) => {
    setWorktrees((prev) => prev.filter((wt) => wt.id !== id));
  };

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border/70 px-5 py-3">
        <h2 className="text-sm font-semibold text-foreground">Worktrees</h2>
        <button
          type="button"
          onClick={handleCreate}
          className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
        >
          <PlusIcon className="h-3.5 w-3.5" />
          Create Worktree
        </button>
      </div>

      {/* Content */}
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {worktrees.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
            <GitBranchIcon className="h-10 w-10 text-muted-foreground/40" />
            <div>
              <p className="text-sm font-medium text-muted-foreground">No worktrees</p>
              <p className="mt-1 text-xs text-muted-foreground/60">
                Create isolated branches for tasks
              </p>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {worktrees.map((wt) => (
              <WorktreeCard
                key={wt.id}
                worktree={wt}
                onRemove={() => handleRemove(wt.id)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
