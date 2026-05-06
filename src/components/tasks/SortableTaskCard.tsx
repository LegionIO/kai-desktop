/**
 * SortableTaskCard — wraps TaskCard with dnd-kit sortable behavior.
 */

import type { FC } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { TaskCard } from './TaskCard';
import type { TaskFile } from '@/types/task';

interface SortableTaskCardProps {
  task: TaskFile;
  onClick: () => void;
  isSelected?: boolean;
}

export const SortableTaskCard: FC<SortableTaskCardProps> = ({ task, onClick, isSelected }) => {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: task.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
    zIndex: isDragging ? 50 : undefined,
  };

  return (
    <div ref={setNodeRef} style={style} {...attributes} {...listeners}>
      <TaskCard task={task} onClick={onClick} isSelected={isSelected} />
    </div>
  );
};
