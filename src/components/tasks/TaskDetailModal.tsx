/**
 * TaskDetailModal — a lightweight, read-only preview of a task.
 *
 * Shows title, status, date, agent label, and a truncated description.
 * Provides a button to navigate to the full TaskDetailPanel view.
 */

import { type FC } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { ExternalLinkIcon, TerminalIcon, ClockIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { MarkdownText } from '@/components/thread/MarkdownText';
import type { TaskFile } from '@/types/task';
import { KAI_TASK_STATUS_LABELS, KAI_TASK_STATUS_COLORS } from '@/types/task';

interface TaskDetailModalProps {
  task: TaskFile | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenFullView: (taskId: string) => void;
}

const runtimeDisplayName = (rt: string) =>
  rt === 'claude-code' ? 'Claude Code' : rt === 'codex' ? 'Codex' : rt === 'mastra' ? 'Mastra' : rt;

export const TaskDetailModal: FC<TaskDetailModalProps> = ({ task, open, onOpenChange, onOpenFullView }) => {
  if (!task) return null;

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[9998] bg-black/40 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:pointer-events-none" />
        <Dialog.Content
          className="fixed left-1/2 top-1/2 z-[9999] flex w-full max-w-2xl -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-border/70 bg-popover shadow-2xl data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[state=closed]:pointer-events-none"
          style={{ maxHeight: 'min(85vh, 720px)' }}
        >
          <Dialog.Title className="sr-only">{task.title}</Dialog.Title>
          <Dialog.Description className="sr-only">
            Preview of task: {task.title}
          </Dialog.Description>

          {/* Header */}
          <div className="shrink-0 px-6 pt-6 pb-4">
            <div className="flex items-start justify-between gap-3">
              <h2 className="text-lg font-semibold text-foreground leading-tight">
                {task.title}
              </h2>
              <button
                type="button"
                onClick={() => onOpenFullView(task.id)}
                className="shrink-0 rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                title="Open full task view"
              >
                <ExternalLinkIcon className="h-4 w-4" />
              </button>
            </div>

            {/* Metadata row */}
            <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
              <span
                className={cn(
                  'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium',
                  KAI_TASK_STATUS_COLORS[task.status],
                )}
              >
                {KAI_TASK_STATUS_LABELS[task.status]}
              </span>

              <span className="flex items-center gap-1 text-xs text-muted-foreground">
                <ClockIcon className="h-3 w-3" />
                {new Date(task.updatedAt).toLocaleString()}
              </span>

              {task.agentRuntime && (
                <span className="flex items-center gap-1 text-xs text-muted-foreground">
                  <TerminalIcon className="h-3 w-3" />
                  {runtimeDisplayName(task.agentRuntime)}
                </span>
              )}
            </div>
          </div>

          {/* Description preview */}
          <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">
            {task.description ? (
              <div className="prose-sm text-sm text-foreground/90">
                <MarkdownText text={task.description} />
              </div>
            ) : (
              <p className="text-sm italic text-muted-foreground">No description</p>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
};
