/**
 * TaskDetailPanel — a slide-over panel that shows full task details.
 *
 * Renders to the right of the kanban board with the full plan markdown,
 * status controls, and agent terminal embed area.
 * Follows the same visual pattern as PlanPanel.tsx.
 */

import { type FC, useCallback, useEffect, useState } from 'react';
import {
  TrashIcon,
  PlayIcon,
  TerminalIcon,
  StopCircleIcon,
} from 'lucide-react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { cn } from '@/lib/utils';
import { useTasks } from '@/providers/TaskProvider';
import { app } from '@/lib/ipc-client';
import { MarkdownText } from '@/components/thread/MarkdownText';
import { TaskTerminal } from './TaskTerminal';
import type { TaskFile, KaiTaskStatus } from '@/types/task';
import {
  KAI_TASK_STATUS_COLUMNS,
  KAI_TASK_STATUS_LABELS,
  KAI_TASK_STATUS_COLORS,
} from '@/types/task';

interface TaskDetailPanelProps {
  task: TaskFile;
  onClose?: () => void;
}

export const TaskDetailPanel: FC<TaskDetailPanelProps> = ({ task, onClose }) => {
  const { updateTaskStatus, updateTask, deleteTask, selectTask } = useTasks();
  const [terminalSessionId, setTerminalSessionId] = useState<string | null>(
    task.terminalSessionId ?? null,
  );
  const [isStartingAgent, setIsStartingAgent] = useState(false);
  const [selectedRuntime, setSelectedRuntime] = useState<string>('claude-code');
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Sync terminal session when task changes (e.g. switching between tasks)
  useEffect(() => {
    setTerminalSessionId(task.terminalSessionId ?? null);
    setConfirmDelete(false);
  }, [task.id, task.terminalSessionId]);

  // Close on Escape (if onClose provided)
  useEffect(() => {
    if (!onClose) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const handleStatusChange = useCallback(
    (status: KaiTaskStatus) => {
      void updateTaskStatus(task.id, status);
    },
    [task.id, updateTaskStatus],
  );

  const handleDelete = useCallback(() => {
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    // Kill terminal if running
    if (terminalSessionId) {
      void app.tasks.terminalKill(terminalSessionId);
    }
    void deleteTask(task.id);
    selectTask(null);
    onClose?.();
  }, [task.id, deleteTask, selectTask, onClose, terminalSessionId, confirmDelete]);

  const handleStartAgent = useCallback(async () => {
    setIsStartingAgent(true);
    try {
      const result = await app.tasks.terminalCreate(task.id, {
        runtime: selectedRuntime,
        cwd: task.metadata?.cwd,
      });
      if (result.sessionId) {
        setTerminalSessionId(result.sessionId);
        // Update task with session and move to in_progress
        void updateTask(task.id, {
          terminalSessionId: result.sessionId,
          agentRuntime: selectedRuntime,
          status: 'in_progress',
        });
      }
    } finally {
      setIsStartingAgent(false);
    }
  }, [task.id, task.metadata?.cwd, selectedRuntime, updateTask]);

  const handleStopAgent = useCallback(() => {
    if (terminalSessionId) {
      void app.tasks.terminalKill(terminalSessionId);
      setTerminalSessionId(null);
      void updateTask(task.id, { terminalSessionId: undefined });
    }
  }, [terminalSessionId, task.id, updateTask]);

  const handleTerminalExit = useCallback(
    (_exitCode: number) => {
      setTerminalSessionId(null);
      void updateTask(task.id, { terminalSessionId: undefined });
    },
    [task.id, updateTask],
  );

  return (
    <div className="flex h-full w-full flex-col bg-background">
      {/* Status & Controls */}
      <div className="flex items-center gap-2 border-b border-border/50 px-4 py-2.5">
        {/* Status dropdown */}
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button
              type="button"
              className={cn(
                'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium transition-colors hover:opacity-80',
                KAI_TASK_STATUS_COLORS[task.status],
              )}
            >
              {KAI_TASK_STATUS_LABELS[task.status]}
              <svg className="h-3 w-3" viewBox="0 0 12 12" fill="none">
                <path d="M3 5l3 3 3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              align="start"
              sideOffset={4}
              className="z-[9999] min-w-[160px] rounded-xl border border-border/70 bg-popover/95 p-1 text-popover-foreground shadow-xl backdrop-blur-md"
            >
              {KAI_TASK_STATUS_COLUMNS.map((status) => (
                <DropdownMenu.Item
                  key={status}
                  disabled={status === task.status}
                  className="flex cursor-default items-center gap-2 rounded-lg px-3 py-1.5 text-xs outline-none transition-colors data-[highlighted]:bg-muted/70 data-[disabled]:opacity-40"
                  onSelect={() => handleStatusChange(status)}
                >
                  <span
                    className={cn(
                      'h-2 w-2 rounded-full',
                      KAI_TASK_STATUS_COLORS[status].split(' ')[0],
                    )}
                  />
                  {KAI_TASK_STATUS_LABELS[status]}
                </DropdownMenu.Item>
              ))}
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>

        <div className="flex-1" />

        {/* Delete button */}
        {confirmDelete ? (
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setConfirmDelete(false)}
              className="rounded-lg px-2 py-1 text-[10px] font-medium text-muted-foreground transition-colors hover:bg-muted"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleDelete}
              className="rounded-lg bg-destructive/10 px-2 py-1 text-[10px] font-medium text-destructive transition-colors hover:bg-destructive/20"
            >
              Confirm
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={handleDelete}
            className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
            title="Delete task"
          >
            <TrashIcon className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {/* Agent terminal section */}
      <div className="border-b border-border/50 px-4 py-3">
        {terminalSessionId ? (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <TerminalIcon className="h-4 w-4 text-emerald-500" />
                <span className="text-xs font-medium text-foreground">
                  {selectedRuntime === 'claude-code' ? 'Claude Code' : selectedRuntime === 'codex' ? 'Codex' : selectedRuntime}
                </span>
              </div>
              <button
                type="button"
                onClick={handleStopAgent}
                className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-destructive transition-colors hover:bg-destructive/10"
              >
                <StopCircleIcon className="h-3.5 w-3.5" />
                Stop
              </button>
            </div>
            <TaskTerminal sessionId={terminalSessionId} onExit={handleTerminalExit} />
          </div>
        ) : (
          <div className="flex items-center gap-2">
            {/* Runtime selector */}
            <DropdownMenu.Root>
              <DropdownMenu.Trigger asChild>
                <button
                  type="button"
                  className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs text-foreground transition-colors hover:bg-muted"
                >
                  <TerminalIcon className="h-3.5 w-3.5" />
                  {selectedRuntime === 'claude-code' ? 'Claude Code' : selectedRuntime === 'codex' ? 'Codex' : selectedRuntime === 'mastra' ? 'Mastra' : 'Shell'}
                  <svg className="h-3 w-3 text-muted-foreground" viewBox="0 0 12 12" fill="none">
                    <path d="M3 5l3 3 3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content
                  align="start"
                  sideOffset={4}
                  className="z-[9999] min-w-[140px] rounded-xl border border-border/70 bg-popover/95 p-1 text-popover-foreground shadow-xl backdrop-blur-md"
                >
                  {['claude-code', 'codex', 'mastra', 'shell'].map((rt) => (
                    <DropdownMenu.Item
                      key={rt}
                      className="flex cursor-default items-center gap-2 rounded-lg px-3 py-1.5 text-xs outline-none transition-colors data-[highlighted]:bg-muted/70"
                      onSelect={() => setSelectedRuntime(rt)}
                    >
                      {rt === 'claude-code' ? 'Claude Code' : rt === 'codex' ? 'Codex' : rt === 'mastra' ? 'Mastra' : 'Shell'}
                    </DropdownMenu.Item>
                  ))}
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>

            <button
              type="button"
              onClick={handleStartAgent}
              disabled={isStartingAgent}
              className="inline-flex items-center gap-1.5 rounded-lg bg-primary/10 px-2.5 py-1.5 text-xs font-medium text-primary transition-colors hover:bg-primary/20 disabled:opacity-50"
            >
              <PlayIcon className="h-3.5 w-3.5" />
              {isStartingAgent ? 'Starting…' : 'Start Agent'}
            </button>
          </div>
        )}
      </div>

      {/* Plan / Description content */}
      <div className="flex-1 overflow-y-auto px-5 py-4">
        {task.description ? (
          <MarkdownText text={task.description} />
        ) : (
          <p className="text-sm italic text-muted-foreground">No description</p>
        )}
      </div>

      {/* Footer metadata */}
      <div className="border-t border-border/50 px-4 py-2">
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-muted-foreground">
          <span>Created {new Date(task.createdAt).toLocaleDateString()}</span>
          {task.sourceConversationId && (
            <span>From conversation</span>
          )}
          {task.metadata?.planFileName && (
            <span>{task.metadata.planFileName}</span>
          )}
        </div>
      </div>
    </div>
  );
};
