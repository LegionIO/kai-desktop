/**
 * KanbanColumn — a single droppable column in the kanban board.
 */

import { memo, type FC } from 'react';
import { useDroppable } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CheckCircle2Icon, InboxIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { TaskFile, KaiTaskStatus } from '@/types/task';
import {
  KAI_TASK_STATUS_LABELS,
  KAI_TASK_STATUS_BORDER_COLORS,
  KAI_TASK_STATUS_OUTER_BORDER_COLORS,
} from '@/types/task';
import { SortableTaskCard } from './SortableTaskCard';

interface KanbanColumnProps {
  status: KaiTaskStatus;
  tasks: TaskFile[];
  isOver: boolean;
  selectedTaskId: string | null;
  onTaskClick: (task: TaskFile) => void;
}

export const KanbanColumn: FC<KanbanColumnProps> = memo(
  ({ status, tasks, isOver, selectedTaskId, onTaskClick }) => {
    const { setNodeRef } = useDroppable({ id: status });
    const taskIds = tasks.map((t) => t.id);

    return (
      <div
        ref={setNodeRef}
        className={cn(
          'flex min-w-[220px] flex-1 flex-col rounded-xl border transition-colors duration-150',
          KAI_TASK_STATUS_OUTER_BORDER_COLORS[status],
          isOver && 'ring-2 ring-primary/25 ring-inset',
        )}
      >
        <div
          className={cn(
            'flex flex-1 flex-col rounded-t-[10px] border-t-2 bg-muted/30',
            KAI_TASK_STATUS_BORDER_COLORS[status],
          )}
        >
        {/* Column header */}
        <div className="flex items-center gap-2 px-3 py-2.5">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {KAI_TASK_STATUS_LABELS[status]}
          </h3>
          <span className={cn(
            'inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-muted px-1.5 text-[10px] font-medium text-muted-foreground',
            tasks.length === 0 && 'invisible',
          )}>
            {tasks.length}
          </span>
        </div>

        {/* Scrollable card area */}
        <div className="flex-1 overflow-y-auto px-2 pb-2">
          <SortableContext items={taskIds} strategy={verticalListSortingStrategy}>
            <div className="flex flex-col gap-2">
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

          {/* Empty state */}
          {tasks.length === 0 && (
            <div className="flex flex-col items-center justify-center py-8 text-muted-foreground/50">
              {status === 'done' ? (
                <>
                  <CheckCircle2Icon className="mb-2 h-6 w-6" />
                  <p className="text-xs">No completed tasks</p>
                </>
              ) : status === 'todo' ? (
                <>
                  <InboxIcon className="mb-2 h-6 w-6" />
                  <p className="text-xs">No tasks</p>
                  <p className="mt-0.5 text-[10px]">Accept a plan to add one</p>
                </>
              ) : (
                <>
                  <InboxIcon className="mb-2 h-6 w-6" />
                  <p className="text-xs">No tasks</p>
                </>
              )}
            </div>
          )}
        </div>
        </div>
      </div>
    );
  },
);

KanbanColumn.displayName = 'KanbanColumn';
