/**
 * TaskSidebarList — task list shown in the sidebar when the "Tasks" tab is active.
 *
 * Matches ConversationList patterns: pin, context menu, triple-dot.
 */

import { useState, useMemo, useCallback, useEffect, type FC } from 'react';
import { createPortal } from 'react-dom';
import {
  SearchIcon,
  Trash2Icon,
  XIcon,
  ClipboardListIcon,
  PinIcon,
  EllipsisVerticalIcon,
  PlusIcon,
  FilePlusIcon,
  PencilIcon,
  ArchiveRestoreIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useTasks } from '@/providers/TaskProvider';
import type { TaskFile } from '@/types/task';
import { KAI_TASK_STATUS_LABELS } from '@/types/task';
import { CreateTaskDialog } from './CreateTaskDialog';

function formatRelativeTime(timestamp: string): string {
  const diffMs = Date.now() - new Date(timestamp).getTime();
  if (diffMs < 60_000) return 'just now';
  if (diffMs < 3_600_000) return `${Math.floor(diffMs / 60_000)}m ago`;
  if (diffMs < 86_400_000) return `${Math.floor(diffMs / 3_600_000)}h ago`;
  if (diffMs < 604_800_000) return `${Math.floor(diffMs / 86_400_000)}d ago`;
  return `${Math.floor(diffMs / 604_800_000)}w ago`;
}

const PIN_STORAGE_KEY = __BRAND_APP_SLUG + ':pinned-tasks';
const PIN_EVENT = 'pinned-tasks-changed';

interface TaskSidebarListProps {
  onSelectTask?: (taskId: string) => void;
  /** When provided, "New Task" opens the AI creation view instead of the dialog. */
  onCreateTask?: () => void;
  /** Navigate to the task queue view in the main panel. */
  onViewBoard?: () => void;
  /** Whether the board view is currently shown in the main panel. */
  isBoardActive?: boolean;
  /** Whether the task creation view is currently shown. */
  isCreatingTask?: boolean;
  /** When set, only tasks matching this workspace (or unscoped legacy tasks) are shown. */
  workspaceId?: string | null;
}

export const TaskSidebarList: FC<TaskSidebarListProps> = ({
  onSelectTask,
  onCreateTask,
  onViewBoard,
  isCreatingTask,
  workspaceId,
}) => {
  const { state, selectTask, archiveTask } = useTasks();
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  // ── Pin state ──────────────────────────────────────────────────────────
  const [pinnedIds, setPinnedIds] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem(PIN_STORAGE_KEY) || '[]')); } catch { return new Set(); }
  });

  const togglePin = useCallback((id: string) => {
    const raw = localStorage.getItem(PIN_STORAGE_KEY) || '[]';
    let ids: string[];
    try { ids = JSON.parse(raw); } catch { ids = []; }
    const set = new Set(ids);
    if (set.has(id)) set.delete(id); else set.add(id);
    const serialized = JSON.stringify([...set]);
    localStorage.setItem(PIN_STORAGE_KEY, serialized);
    setPinnedIds(set);
    window.dispatchEvent(new CustomEvent(PIN_EVENT, { detail: serialized }));
  }, []);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as string;
      try { setPinnedIds(new Set(JSON.parse(detail))); } catch { /* ignore */ }
    };
    window.addEventListener(PIN_EVENT, handler);
    return () => window.removeEventListener(PIN_EVENT, handler);
  }, []);

  // ── Context menu state ─────────────────────────────────────────────────
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; taskId: string } | null>(null);

  const handleContextMenu = useCallback((e: React.MouseEvent, taskId: string) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY, taskId });
  }, []);

  const handleMoreClick = useCallback((e: React.MouseEvent<HTMLButtonElement>, taskId: string) => {
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    setContextMenu({ x: rect.left, y: rect.bottom + 4, taskId });
  }, []);

  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    window.addEventListener('click', close);
    window.addEventListener('contextmenu', close);
    return () => { window.removeEventListener('click', close); window.removeEventListener('contextmenu', close); };
  }, [contextMenu]);

  // ── Sort and filter tasks ──────────────────────────────────────────────

  const sortedTasks = useMemo(() => {
    let tasks = [...state.tasks];

    if (workspaceId) {
      tasks = tasks.filter((t) => t.workspaceId === workspaceId);
    }

    const query = searchQuery.toLowerCase().trim();
    if (query) {
      tasks = tasks.filter(
        (t) => t.title.toLowerCase().includes(query) || t.description.toLowerCase().includes(query),
      );
    }
    tasks.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return tasks;
  }, [state.tasks, searchQuery, workspaceId]);

  // Split into pinned / unpinned
  const sections = useMemo(() => {
    const pinned = sortedTasks.filter((t) => pinnedIds.has(t.id));
    const unpinned = sortedTasks.filter((t) => !pinnedIds.has(t.id));
    const result: Array<{ label?: string; items: TaskFile[] }> = [];
    if (pinned.length > 0) result.push({ label: 'Pinned', items: pinned });
    result.push({ items: unpinned });
    return result;
  }, [sortedTasks, pinnedIds]);

  const handleClick = (taskId: string) => {
    selectTask(taskId);
    onSelectTask?.(taskId);
  };

  return (
    <div className="flex flex-col h-full">
      {/* TASKS heading row */}
      <div className="flex items-center gap-1.5 px-3 pb-2 pt-3">
        <button
          type="button"
          onClick={() => onViewBoard?.()}
          className="rounded-md px-1.5 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground transition-colors hover:bg-[var(--brand-accent)]/15 hover:text-[var(--brand-accent)]"
        >
          Tasks
        </button>
        <div className="flex-1" />
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onCreateTask?.(); }}
          className={cn(
            'flex items-center gap-1.5 rounded-lg border border-sidebar-border/60 px-2.5 py-1 text-xs font-medium text-sidebar-foreground transition-colors hover:bg-sidebar-accent/60',
            isCreatingTask && 'border-primary/40 bg-primary/10 text-primary',
          )}
        >
          <FilePlusIcon className="h-3 w-3" />
          New Task
        </button>
      </div>

      {/* Search bar */}
      <div className="px-3 pb-3">
        <div className="flex items-center gap-2 rounded-xl border border-sidebar-border/60 bg-sidebar-accent/50 px-3 py-2">
          <SearchIcon className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search..."
            className="flex-1 bg-transparent text-xs text-sidebar-foreground placeholder:text-muted-foreground focus:outline-none"
          />
          {searchQuery && (
            <button
              type="button"
              onClick={() => setSearchQuery('')}
              className="shrink-0 p-0.5 rounded hover:bg-sidebar-accent transition-colors"
            >
              <XIcon className="h-3 w-3 text-muted-foreground" />
            </button>
          )}
        </div>
      </div>

      {/* Task list */}
      <div className="flex-1 overflow-y-auto px-3">
        {sections.map((section, si) => (
          <div key={si}>
            {section.label && (
              <div className="flex items-center gap-2 px-1 pb-1 pt-2">
                <PinIcon className="h-2.5 w-2.5 text-primary/60" />
                <span className="text-[9px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/60">{section.label}</span>
              </div>
            )}
            {section.items.map((task) => {
              const isPinned = pinnedIds.has(task.id);
              return (
                <div key={task.id} className="mb-1.5">
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => handleClick(task.id)}
                    onKeyDown={(e) => e.key === 'Enter' && handleClick(task.id)}
                    onContextMenu={(e) => handleContextMenu(e, task.id)}
                    className={cn(
                      'flex w-full items-start gap-2.5 rounded-xl px-3 py-2.5 text-left text-sm transition-all group cursor-pointer relative',
                      state.selectedTaskId === task.id
                        ? 'shadow-[inset_0_0_0_1px_var(--app-active-item-ring)]'
                        : 'hover:bg-sidebar-accent/65',
                    )}
                    style={state.selectedTaskId === task.id ? { backgroundColor: 'var(--app-active-item)' } : undefined}
                  >
                    <ClipboardListIcon
                      className={cn(
                        'mt-0.5 h-4 w-4 shrink-0',
                        state.selectedTaskId === task.id ? 'text-primary' : 'text-muted-foreground',
                      )}
                    />
                    <div className="flex flex-col flex-1 min-w-0">
                      {(() => {
                        const isPending = task.title === 'New Task';
                        return (
                          <>
                            <span className={cn(
                              'line-clamp-2 text-sm font-medium',
                              isPending ? 'italic text-muted-foreground/50' : 'text-sidebar-foreground/95',
                            )}>
                              {task.title}
                            </span>
                            <div className="mt-1 flex items-center text-[12px] text-muted-foreground">
                              {KAI_TASK_STATUS_LABELS[task.status]}
                              <span className="mx-1">·</span>
                              {task.status === 'in_progress' ? (
                                <div className="flex items-center gap-0.5 px-1">
                                  <div className="h-1 w-1 rounded-full bg-primary animate-bounce [animation-delay:0ms]" />
                                  <div className="h-1 w-1 rounded-full bg-primary animate-bounce [animation-delay:150ms]" />
                                  <div className="h-1 w-1 rounded-full bg-primary animate-bounce [animation-delay:300ms]" />
                                </div>
                              ) : (
                                formatRelativeTime(task.updatedAt)
                              )}
                            </div>
                          </>
                        );
                      })()}
                    </div>
                    <div className="ml-1 flex shrink-0 self-stretch items-center gap-1">
                      {isPinned && <PinIcon className="h-3 w-3 text-muted-foreground" />}
                      <button
                        type="button"
                        onClick={(e) => handleMoreClick(e, task.id)}
                        className="shrink-0 rounded p-0.5 opacity-0 transition-all group-hover:opacity-100 hover:bg-sidebar-accent"
                        title="More options"
                        aria-label="More options"
                      >
                        <EllipsisVerticalIcon className="h-4 w-4 text-muted-foreground" />
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        ))}

        {!state.isLoading && sortedTasks.length === 0 && (
          <div className="flex flex-col items-center justify-center py-12 px-4 text-center">
            <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-muted/40 text-muted-foreground">
              <ClipboardListIcon size={24} strokeWidth={1.3} />
            </div>
            <h3 className="mb-1 text-sm font-medium text-foreground/80">
              {searchQuery ? 'No tasks match your search' : 'No tasks yet'}
            </h3>
            {!searchQuery && (
              <>
                <p className="mb-4 text-xs text-muted-foreground leading-relaxed">
                  Create tasks to track your work. Organize them on the board and assign them to agents.
                </p>
                <button
                  type="button"
                  onClick={() => onCreateTask?.()}
                  className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
                >
                  <PlusIcon size={13} />
                  Create Your First Task
                </button>
              </>
            )}
          </div>
        )}
      </div>

      {/* Create task dialog */}
      <CreateTaskDialog
        open={createDialogOpen}
        onOpenChange={setCreateDialogOpen}
      />

      {/* Context menu portal */}
      {contextMenu && createPortal(
        <div
          className="fixed z-[9999] min-w-[180px] rounded-2xl border border-border bg-popover p-1.5 shadow-2xl"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-popover-foreground hover:bg-muted/70 transition-colors"
            onClick={() => { togglePin(contextMenu.taskId); setContextMenu(null); }}
          >
            <PinIcon className="h-4 w-4 text-muted-foreground" /> {pinnedIds.has(contextMenu.taskId) ? 'Unpin' : 'Pin'}
          </button>
          <button
            className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-popover-foreground hover:bg-muted/70 transition-colors"
            onClick={() => { window.dispatchEvent(new CustomEvent('kai:request-task-rename', { detail: contextMenu.taskId })); setContextMenu(null); }}
          >
            <PencilIcon className="h-4 w-4 text-muted-foreground" /> Rename
          </button>
          <button
            className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-popover-foreground hover:bg-muted/70 transition-colors"
            onClick={() => { void archiveTask(contextMenu.taskId); setContextMenu(null); }}
          >
            <ArchiveRestoreIcon className="h-4 w-4 text-muted-foreground" /> Archive
          </button>
          <div className="my-1 h-px bg-border/60" />
          <button
            className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-destructive hover:bg-destructive/10 transition-colors"
            onClick={() => { window.dispatchEvent(new CustomEvent('kai:request-task-delete', { detail: contextMenu.taskId })); setContextMenu(null); }}
          >
            <Trash2Icon className="h-4 w-4" /> Delete
          </button>
        </div>,
        document.body,
      )}
    </div>
  );
};
