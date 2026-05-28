/**
 * ReviewerAssignment — compact multi-select for assigning reviewer agents + review mode toggle.
 *
 * Shown in the task detail header. Allows selecting zero to many reviewers
 * and toggling between parallel/sequential review execution.
 */

import { type FC, useMemo } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { BotIcon, PlusIcon, XIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAgents } from '@/providers/AgentProvider';
import type { TaskFile } from '@/types/task';
import type { AgentFile } from '../../../shared/agent-types';

interface ReviewerAssignmentProps {
  task: TaskFile;
  onUpdate: (reviewerAgentIds: string[], reviewMode: 'parallel' | 'sequential') => void;
}

export const ReviewerAssignment: FC<ReviewerAssignmentProps> = ({ task, onUpdate }) => {
  const { state } = useAgents();

  const reviewerIds = task.reviewerAgentIds ?? [];
  const reviewMode = task.reviewMode ?? 'parallel';
  const isEditable = task.status === 'todo' || task.status === 'in_progress';

  const selectedAgents = useMemo(
    () => reviewerIds.map((id) => state.agents.find((a) => a.id === id)).filter(Boolean) as AgentFile[],
    [reviewerIds, state.agents],
  );

  const availableAgents = useMemo(
    () => state.agents.filter((a) => !reviewerIds.includes(a.id)),
    [state.agents, reviewerIds],
  );

  const handleAdd = (agentId: string) => {
    onUpdate([...reviewerIds, agentId], reviewMode);
  };

  const handleRemove = (agentId: string) => {
    onUpdate(
      reviewerIds.filter((id) => id !== agentId),
      reviewMode,
    );
  };

  const handleModeToggle = (mode: 'parallel' | 'sequential') => {
    onUpdate(reviewerIds, mode);
  };

  if (!isEditable && reviewerIds.length === 0) {
    return <span className="text-xs text-muted-foreground/50">No reviewers (skip AI review)</span>;
  }

  return (
    <div className="flex items-center gap-1.5">
      {/* Selected reviewer chips */}
      {selectedAgents.map((agent) => (
        <span
          key={agent.id}
          className="inline-flex items-center gap-0.5 rounded-full bg-purple-500/10 px-1.5 py-0.5 text-[11px] text-purple-400"
        >
          <span className="shrink-0">{agent.icon ?? '🤖'}</span>
          <span className="max-w-[60px] truncate">{agent.name}</span>
          {isEditable && (
            <button
              type="button"
              onClick={() => handleRemove(agent.id)}
              className="ml-0.5 rounded-full p-0.5 transition-colors hover:bg-purple-500/20"
            >
              <XIcon className="h-2.5 w-2.5" />
            </button>
          )}
        </span>
      ))}

      {/* Add reviewer popover */}
      {isEditable && (
        <Popover.Root>
          <Popover.Trigger asChild>
            <button
              type="button"
              className="inline-flex items-center gap-0.5 rounded-full bg-muted/40 px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground/80"
            >
              <PlusIcon className="h-3 w-3" />
              {reviewerIds.length === 0 && <span>Add reviewer</span>}
            </button>
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Content
              align="start"
              sideOffset={6}
              className="z-50 min-w-[220px] rounded-xl border border-border/70 bg-popover/95 p-1.5 text-popover-foreground shadow-xl backdrop-blur-md"
            >
              {availableAgents.length === 0 ? (
                <div className="px-3 py-3 text-center text-xs text-muted-foreground">No more agents available</div>
              ) : (
                <div className="flex flex-col">
                  <div className="px-2 pt-1 pb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                    Add Reviewer
                  </div>
                  {availableAgents.map((agent) => (
                    <button
                      key={agent.id}
                      type="button"
                      onClick={() => handleAdd(agent.id)}
                      className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none transition-colors hover:bg-muted"
                    >
                      <span className="flex h-5 w-5 shrink-0 items-center justify-center text-sm">
                        {agent.icon ?? <BotIcon className="h-3.5 w-3.5 text-muted-foreground" />}
                      </span>
                      <span className="flex-1 truncate text-left text-foreground">{agent.name}</span>
                      <span className="ml-2 inline-flex items-center rounded-full bg-purple-500/10 px-1.5 py-px text-[10px] font-medium text-purple-400">
                        {agent.role}
                      </span>
                    </button>
                  ))}
                </div>
              )}

              {/* Review mode toggle */}
              {reviewerIds.length > 0 && (
                <>
                  <div className="mx-1.5 my-1.5 border-t border-border/50" />
                  <div className="px-2 pb-1">
                    <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground mb-1.5">
                      Review Mode
                    </div>
                    <div className="flex rounded-lg border border-border/50 bg-muted/30 p-0.5">
                      <button
                        type="button"
                        onClick={() => handleModeToggle('parallel')}
                        className={cn(
                          'flex-1 rounded-md px-2 py-1 text-[11px] font-medium transition-colors',
                          reviewMode === 'parallel'
                            ? 'bg-background text-foreground shadow-sm'
                            : 'text-muted-foreground hover:text-foreground/80',
                        )}
                      >
                        Parallel
                      </button>
                      <button
                        type="button"
                        onClick={() => handleModeToggle('sequential')}
                        className={cn(
                          'flex-1 rounded-md px-2 py-1 text-[11px] font-medium transition-colors',
                          reviewMode === 'sequential'
                            ? 'bg-background text-foreground shadow-sm'
                            : 'text-muted-foreground hover:text-foreground/80',
                        )}
                      >
                        Sequential
                      </button>
                    </div>
                  </div>
                </>
              )}
              <Popover.Arrow className="fill-border/70" />
            </Popover.Content>
          </Popover.Portal>
        </Popover.Root>
      )}

      {/* Review mode indicator (when not editing and has reviewers) */}
      {!isEditable && reviewerIds.length > 1 && (
        <span className="ml-1 text-[10px] text-muted-foreground/60">({reviewMode})</span>
      )}

      {/* Empty state */}
      {reviewerIds.length === 0 && !isEditable && (
        <span className="text-xs text-muted-foreground/50">No reviewers (skip AI review)</span>
      )}
    </div>
  );
};
