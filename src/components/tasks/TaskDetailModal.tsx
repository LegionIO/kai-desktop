/**
 * TaskDetailModal — wraps TaskDetailPanel in a Radix Dialog modal.
 *
 * Used by KanbanBoard and navigated to via the "View Task" link
 * in the PlanApprovalCard after a plan is accepted.
 */

import { type FC } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import type { TaskFile } from '@/types/task';
import { TaskDetailPanel } from './TaskDetailPanel';

interface TaskDetailModalProps {
  task: TaskFile | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export const TaskDetailModal: FC<TaskDetailModalProps> = ({ task, open, onOpenChange }) => {
  if (!task) return null;

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[9998] bg-black/40 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <Dialog.Content
          className="fixed left-1/2 top-1/2 z-[9999] w-full max-w-2xl -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-2xl border border-border/70 bg-popover shadow-2xl data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95"
          style={{ height: 'min(85vh, 780px)' }}
        >
          {/* Accessible title (visually hidden — TaskDetailPanel has its own header) */}
          <Dialog.Title className="sr-only">{task.title}</Dialog.Title>
          <Dialog.Description className="sr-only">
            Task detail view for {task.title}
          </Dialog.Description>

          <TaskDetailPanel
            task={task}
            onClose={() => onOpenChange(false)}
          />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
};
