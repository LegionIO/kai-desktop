/**
 * TaskStatusDropdown — clickable status badge with valid-transition dropdown.
 *
 * Allows changing task status by clicking the badge and choosing a valid
 * next status from the dropdown.
 */

import { type FC } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { ChevronDownIcon, CheckIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { KAI_TASK_STATUS_LABELS, KAI_TASK_STATUS_COLORS, type KaiTaskStatus, type TaskFile } from '@/types/task';
import { getValidManualTransitions } from '../../../shared/task-state-machine';

const itemClassName =
  'flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-muted data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50';

interface TaskStatusDropdownProps {
  task: TaskFile;
  onStatusChange: (newStatus: KaiTaskStatus) => void;
}

export const TaskStatusDropdown: FC<TaskStatusDropdownProps> = ({ task, onStatusChange }) => {
  const transitions = getValidManualTransitions(task.status);
  const currentLabel = KAI_TASK_STATUS_LABELS[task.status];
  const currentColor = KAI_TASK_STATUS_COLORS[task.status];

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          className={cn(
            'inline-flex items-center gap-1 rounded-full px-2 py-px text-xs font-medium transition-colors hover:opacity-80 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            currentColor,
          )}
          aria-label="Change status"
        >
          <span>{currentLabel}</span>
          <ChevronDownIcon className="h-3 w-3 opacity-70" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="start"
          sideOffset={6}
          className="z-50 min-w-[180px] rounded-xl border border-border/70 bg-popover/95 p-1.5 text-popover-foreground shadow-xl backdrop-blur-md"
        >
          <DropdownMenu.Label className="px-2 pt-1 pb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Move to
          </DropdownMenu.Label>
          {transitions.length === 0 ? (
            <div className="px-3 py-2 text-center text-xs text-muted-foreground">No valid transitions.</div>
          ) : (
            transitions.map((status) => (
              <DropdownMenu.Item key={status} className={itemClassName} onSelect={() => onStatusChange(status)}>
                <span
                  className={cn(
                    'inline-flex items-center rounded-full px-2 py-px text-[11px] font-medium',
                    KAI_TASK_STATUS_COLORS[status],
                  )}
                >
                  {KAI_TASK_STATUS_LABELS[status]}
                </span>
              </DropdownMenu.Item>
            ))
          )}
          <DropdownMenu.Separator className="my-1 h-px bg-border/60" />
          <DropdownMenu.Item className={cn(itemClassName, 'opacity-60')} disabled>
            <CheckIcon className="h-3.5 w-3.5" />
            <span>{currentLabel} (current)</span>
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
};
