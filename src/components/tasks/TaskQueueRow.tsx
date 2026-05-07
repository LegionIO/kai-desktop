/**
 * TaskQueueRow — a single droppable row in the task queue.
 * Cards flow horizontally and scroll right when there are many.
 */

import { memo, type FC } from 'react';
import { SortableContext, horizontalListSortingStrategy } from '@dnd-kit/sortable';
import { InboxIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { TaskFile, KaiTaskStatus } from '@/types/task';
import {
  KAI_TASK_STATUS_LABELS,
  KAI_TASK_STATUS_OUTER_BORDER_COLORS,
} from '@/types/task';
import { SortableTaskCard } from './SortableTaskCard';

/** Status-specific text colors for the floating label. */
const KAI_TASK_STATUS_LABEL_COLORS: Record<KaiTaskStatus, string> = {
  todo: 'text-sky-500',
  in_progress: 'text-rose-500',
  ai_review: 'text-amber-500',
  human_review: 'text-purple-400',
  done: 'text-emerald-500',
};

interface TaskQueueRowProps {
  status: KaiTaskStatus;
  tasks: TaskFile[];
  selectedTaskId: string | null;
  onTaskClick: (task: TaskFile) => void;
}

export const TaskQueueRow: FC<TaskQueueRowProps> = memo(
  ({ status, tasks, selectedTaskId, onTaskClick }) => {
    const taskIds = tasks.map((t) => t.id);

    return (
      <div className="relative pt-2.5">
        {/* Floating label — overlaps the top border */}
        <div className="absolute left-3 top-0 z-10 flex items-center gap-2 px-1.5 bg-background">
          <h3 className={cn(
            'text-[11px] font-semibold uppercase tracking-wider',
            KAI_TASK_STATUS_LABEL_COLORS[status],
          )}>
            {KAI_TASK_STATUS_LABELS[status]}
          </h3>
          <span className={cn(
            'inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-muted px-1 text-[10px] font-medium text-muted-foreground',
            tasks.length === 0 && 'hidden',
          )}>
            {tasks.length}
          </span>
        </div>

        {/* Row container */}
        <div
          className={cn(
            'rounded-xl border transition-colors duration-150',
            KAI_TASK_STATUS_OUTER_BORDER_COLORS[status],
          )}
        >
          {/* Horizontally scrolling card area with bottom buffer for scrollbar */}
          <div className="min-h-[104px] overflow-x-auto px-4 pb-4 pt-4">
            <SortableContext items={taskIds} strategy={horizontalListSortingStrategy}>
              <div className="flex gap-3">
                {tasks.map((task) => (
                  <SortableTaskCard
                    key={task.id}
                    task={task}
                    isSelected={task.id === selectedTaskId}
                    onClick={() => onTaskClick(task)}
                  />
                ))}
              </div>
            </SortableContext>

            {/* Empty state — consistent across all rows */}
            {tasks.length === 0 && (
              <div className="flex h-[72px] items-center justify-center text-muted-foreground/50">
                <div className="flex items-center gap-2">
                  <InboxIcon className="h-4 w-4" />
                  <p className="text-xs">No tasks</p>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  },
);

TaskQueueRow.displayName = 'TaskQueueRow';
