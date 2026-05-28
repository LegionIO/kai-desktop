/**
 * ReviewResultsPanel — displays per-reviewer status during the AI review phase.
 *
 * Shows each reviewer with their approval status, feedback, progress count,
 * and links to view reviewer terminal output.
 */

import type { FC } from 'react';
import { CheckCircle2Icon, XCircleIcon, Loader2Icon, TerminalIcon, UsersIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { TaskFile, TaskReviewResult } from '@/types/task';

interface ReviewResultsPanelProps {
  task: TaskFile;
  onViewTerminal?: (terminalSessionId: string, reviewerName: string) => void;
}

const StatusBadge: FC<{ status: TaskReviewResult['status'] }> = ({ status }) => {
  switch (status) {
    case 'approved':
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-500">
          <CheckCircle2Icon className="h-3 w-3" />
          Approved
        </span>
      );
    case 'rejected':
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-red-500/10 px-1.5 py-0.5 text-[10px] font-medium text-red-500">
          <XCircleIcon className="h-3 w-3" />
          Rejected
        </span>
      );
    case 'pending':
    default:
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-muted/60 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
          <Loader2Icon className="h-3 w-3 animate-spin" />
          Pending
        </span>
      );
  }
};

export const ReviewResultsPanel: FC<ReviewResultsPanelProps> = ({ task, onViewTerminal }) => {
  const results = task.reviewResults ?? [];
  if (results.length === 0) return null;

  const completedCount = results.filter((r) => r.status !== 'pending').length;
  const totalCount = results.length;
  const allApproved = results.every((r) => r.status === 'approved');
  const hasRejection = results.some((r) => r.status === 'rejected');

  // Overall status message
  let overallStatus: { text: string; className: string };
  if (allApproved && completedCount === totalCount) {
    overallStatus = { text: 'All approved', className: 'text-emerald-500' };
  } else if (hasRejection) {
    overallStatus = { text: 'Review failed', className: 'text-red-500' };
  } else {
    overallStatus = { text: 'Waiting for reviews...', className: 'text-muted-foreground' };
  }

  return (
    <div className="rounded-xl border border-border/50 bg-muted/20 p-3">
      {/* Header */}
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <UsersIcon className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="text-xs font-medium text-foreground/80">AI Review</span>
          <span className="text-[10px] text-muted-foreground">
            {completedCount}/{totalCount} complete
          </span>
        </div>
        <span className={cn('text-[11px] font-medium', overallStatus.className)}>{overallStatus.text}</span>
      </div>

      {/* Reviewer rows */}
      <div className="flex flex-col gap-1.5">
        {results.map((result) => (
          <div key={result.agentId} className="flex items-start gap-2 rounded-lg bg-background/50 px-2.5 py-2">
            {/* Agent name + status */}
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <span className="shrink-0 text-sm">
                {result.agentName.slice(0, 2) === '🤖' ? result.agentName.slice(0, 2) : '🤖'}
              </span>
              <span className="truncate text-xs font-medium text-foreground/80">{result.agentName}</span>
              <StatusBadge status={result.status} />
            </div>

            {/* Terminal link */}
            {result.terminalSessionId && onViewTerminal && (
              <button
                type="button"
                onClick={() => onViewTerminal(result.terminalSessionId!, result.agentName)}
                className="inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
              >
                <TerminalIcon className="h-3 w-3" />
                <span>View</span>
              </button>
            )}
          </div>
        ))}
      </div>

      {/* Feedback section — show any feedback from rejected/completed reviews */}
      {results.some((r) => r.feedback) && (
        <div className="mt-2 border-t border-border/30 pt-2">
          {results
            .filter((r) => r.feedback)
            .map((result) => (
              <div key={`${result.agentId}-feedback`} className="mb-1.5 last:mb-0">
                <div className="flex items-center gap-1 mb-0.5">
                  <span className="text-[10px] font-medium text-muted-foreground">{result.agentName}:</span>
                </div>
                <p className="text-xs text-foreground/70 leading-relaxed pl-0.5">{result.feedback}</p>
              </div>
            ))}
        </div>
      )}
    </div>
  );
};
