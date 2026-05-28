/**
 * TaskQueue — main task queue view with 5 status rows and drag-and-drop reordering.
 *
 * Adapted from Aperant's kanban pattern with dnd-kit,
 * simplified for Kai's 5-lane workflow.
 */

import { useState, useMemo, useCallback, useRef, useEffect, type FC } from 'react';
import { createPortal } from 'react-dom';
import {
  DndContext,
  DragOverlay,
  pointerWithin,
  rectIntersection,
  PointerSensor,
  KeyboardSensor,
  useSensors,
  useSensor,
  type DragStartEvent,
  type DragEndEvent,
  type CollisionDetection,
} from '@dnd-kit/core';
import { sortableKeyboardCoordinates } from '@dnd-kit/sortable';
import {
  SearchIcon,
  SlidersHorizontalIcon,
  XIcon,
  CheckIcon,
  MinusIcon,
  ArchiveIcon,
  ArchiveRestoreIcon,
  Trash2Icon,
  ClipboardListIcon,
  EllipsisVerticalIcon,
  PinIcon,
} from 'lucide-react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { cn } from '@/lib/utils';
import { useFullWidthContent } from '@/hooks/useFullWidthContent';
import { useTasks } from '@/providers/TaskProvider';
import { app } from '@/lib/ipc-client';
import type { TaskFile, KaiTaskStatus } from '@/types/task';
import { KAI_TASK_STATUS_COLUMNS, KAI_TASK_STATUS_LABELS } from '@/types/task';
import { TaskQueueRow } from './TaskQueueRow';
import { TaskCard } from './TaskCard';
import { TaskDetailPanel } from './TaskDetailPanel';
import { TaskDetailModal } from './TaskDetailModal';
import { AutopilotToggle } from './AutopilotToggle';
import { Tooltip } from '@/components/ui/Tooltip';

// ── Filter types ───────────────────────────────────────────────────────────

type FilterMode = 'all' | 'recent' | 'pinned' | 'archived';

const FILTER_LABELS: Record<FilterMode, string> = {
  all: 'All',
  recent: 'Recent',
  pinned: 'Pinned',
  archived: 'Archived',
};

const PIN_STORAGE_KEY = __BRAND_APP_SLUG + ':pinned-tasks';

function formatRelativeTime(timestamp: string): string {
  const diffMs = Date.now() - new Date(timestamp).getTime();
  if (diffMs < 60_000) return 'just now';
  if (diffMs < 3_600_000) return `${Math.floor(diffMs / 60_000)}m ago`;
  if (diffMs < 86_400_000) return `${Math.floor(diffMs / 3_600_000)}h ago`;
  if (diffMs < 604_800_000) return `${Math.floor(diffMs / 86_400_000)}d ago`;
  return `${Math.floor(diffMs / 604_800_000)}w ago`;
}

interface TaskQueueProps {
  /** Active workspace ID — only tasks belonging to this workspace (or unscoped) are shown */
  workspaceId?: string | null;
}

export const TaskQueue: FC<TaskQueueProps> = ({ workspaceId }) => {
  const { state, reorderTasks, moveTaskToColumn, updateTaskStatus, selectTask, deleteTask } = useTasks();
  const fullWidth = useFullWidthContent();

  const [activeTask, setActiveTask] = useState<TaskFile | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [filterMode, setFilterMode] = useState<FilterMode>('all');
  const [modalTaskId, setModalTaskId] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // ── Pin state ──────────────────────────────────────────────────────────
  const [pinnedIds, setPinnedIds] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem(PIN_STORAGE_KEY) || '[]'));
    } catch {
      return new Set();
    }
  });

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as string;
      try {
        setPinnedIds(new Set(JSON.parse(detail)));
      } catch {
        /* ignore */
      }
    };
    window.addEventListener('pinned-tasks-changed', handler);
    return () => window.removeEventListener('pinned-tasks-changed', handler);
  }, []);

  // ── Archived task list ─────────────────────────────────────────────────
  const [archivedTasks, setArchivedTasks] = useState<TaskFile[]>([]);
  const [archivedLoading, setArchivedLoading] = useState(false);

  const loadArchivedTasks = useCallback(async () => {
    if (!window.app?.tasks?.listAll) return;
    setArchivedLoading(true);
    try {
      const all = await app.tasks.listAll();
      setArchivedTasks(all.filter((t) => !!t.archivedAt));
    } catch {
      /* ignore */
    } finally {
      setArchivedLoading(false);
    }
  }, []);

  useEffect(() => {
    if (filterMode === 'archived') void loadArchivedTasks();
  }, [filterMode, loadArchivedTasks]);

  // Refresh when tasks broadcast changes (e.g. after unarchiving)
  useEffect(() => {
    if (filterMode === 'archived') void loadArchivedTasks();
  }, [state.tasks]); // intentional: re-run when task list changes, not when filterMode changes

  // ── Bulk selection (archived view) ────────────────────────────────────
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; taskId: string } | null>(null);

  useEffect(() => {
    if (filterMode !== 'archived') setSelectedIds(new Set());
  }, [filterMode]);

  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    window.addEventListener('click', close);
    window.addEventListener('contextmenu', close);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('contextmenu', close);
    };
  }, [contextMenu]);

  // Custom collision detection: prioritize droppable columns, fall back to pointer position
  const collisionDetection: CollisionDetection = useCallback((args) => {
    // First check if pointer is within any droppable column
    const pointerCollisions = pointerWithin(args);
    if (pointerCollisions.length > 0) {
      // Prefer column droppables over sortable items
      const columnHit = pointerCollisions.find((c) => String(c.id).startsWith('column-'));
      if (columnHit) return [columnHit];
      return pointerCollisions;
    }
    // Fall back to rect intersection
    return rectIntersection(args);
  }, []);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  // ── Group tasks by status for board view ──────────────────────────────

  const tasksByStatus = useMemo(() => {
    const query = searchQuery.toLowerCase().trim();
    const grouped: Record<KaiTaskStatus, TaskFile[]> = {
      todo: [],
      in_progress: [],
      ai_review: [],
      human_review: [],
      done: [],
    };

    for (const task of state.tasks) {
      if (workspaceId && task.workspaceId !== workspaceId) continue;
      if (query && !task.title.toLowerCase().includes(query) && !task.description.toLowerCase().includes(query))
        continue;

      if (filterMode === 'pinned' && !pinnedIds.has(task.id)) continue;
      if (filterMode === 'recent') {
        const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
        if (new Date(task.updatedAt).getTime() < cutoff) continue;
      }

      grouped[task.status]?.push(task);
    }

    for (const status of KAI_TASK_STATUS_COLUMNS) {
      const order = state.taskOrder[status];
      if (order?.length) {
        const indexMap = new Map(order.map((id, i) => [id, i]));
        grouped[status].sort((a, b) => (indexMap.get(a.id) ?? 999) - (indexMap.get(b.id) ?? 999));
      } else {
        grouped[status].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      }
    }
    return grouped;
  }, [state.tasks, state.taskOrder, searchQuery, filterMode, pinnedIds, workspaceId]);

  // ── Filtered archived list ─────────────────────────────────────────────

  const filteredArchived = useMemo(() => {
    let tasks = [...archivedTasks];
    if (workspaceId) tasks = tasks.filter((t) => t.workspaceId === workspaceId);
    const query = searchQuery.toLowerCase().trim();
    if (query)
      tasks = tasks.filter((t) => t.title.toLowerCase().includes(query) || t.description.toLowerCase().includes(query));
    return tasks;
  }, [archivedTasks, searchQuery, workspaceId]);

  // Bulk helpers
  const isSelecting = selectedIds.size > 0;
  const allSelected =
    isSelecting && filteredArchived.length > 0 && filteredArchived.every((t) => selectedIds.has(t.id));
  const someSelected = isSelecting && !allSelected;

  const toggleSelectAll = useCallback(() => {
    if (allSelected) setSelectedIds(new Set());
    else setSelectedIds(new Set(filteredArchived.map((t) => t.id)));
  }, [allSelected, filteredArchived]);

  const handleBulkUnarchive = useCallback(async () => {
    for (const id of selectedIds) await app.tasks.unarchive(id);
    setSelectedIds(new Set());
    await loadArchivedTasks();
  }, [selectedIds, loadArchivedTasks]);

  const handleBulkDelete = useCallback(async () => {
    for (const id of selectedIds) await deleteTask(id);
    setSelectedIds(new Set());
    await loadArchivedTasks();
  }, [selectedIds, deleteTask, loadArchivedTasks]);

  // ── Drag handlers ──────────────────────────────────────────────────────

  const handleDragStart = useCallback(
    (event: DragStartEvent) => {
      const task = state.tasks.find((t) => t.id === event.active.id);
      if (task) setActiveTask(task);
    },
    [state.tasks],
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      setActiveTask(null);
      if (!over || !active) return;

      const task = state.tasks.find((t) => t.id === active.id);
      if (!task) return;

      // Check if dropped on a column (cross-column move)
      const overId = String(over.id);
      if (overId.startsWith('column-')) {
        const targetStatus = overId.replace('column-', '') as KaiTaskStatus;
        if (task.status !== targetStatus) {
          void updateTaskStatus(task.id, targetStatus);
        }
        return;
      }

      // Dropped on another task card
      if (active.id === over.id) return;
      const overTask = state.tasks.find((t) => t.id === over.id);
      if (!overTask) return;

      if (task.status === overTask.status) {
        // Same column — reorder
        reorderTasks(task.status, active.id as string, over.id as string);
      } else {
        // Cross-column: move to the target task's column
        void updateTaskStatus(task.id, overTask.status);
      }
    },
    [state.tasks, reorderTasks, updateTaskStatus],
  );

  const handleTaskClick = useCallback((task: TaskFile) => {
    setModalTaskId(task.id);
  }, []);

  const handleOpenFullView = useCallback(
    (taskId: string) => {
      setModalTaskId(null);
      selectTask(taskId);
    },
    [selectTask],
  );

  const selectedTask = useMemo(
    () => state.tasks.find((t) => t.id === state.selectedTaskId) ?? null,
    [state.tasks, state.selectedTaskId],
  );
  const isQueueVisible = !state.isLoading && !selectedTask;

  useEffect(() => {
    if (!isQueueVisible) return;
    const t = setTimeout(() => searchRef.current?.focus({ preventScroll: true }), 50);
    return () => clearTimeout(t);
  }, [isQueueVisible]);

  const modalTask = useMemo(
    () => (modalTaskId ? (state.tasks.find((t) => t.id === modalTaskId) ?? null) : null),
    [state.tasks, modalTaskId],
  );

  const isFilterActive = filterMode !== 'all';

  // ── Loading ────────────────────────────────────────────────────────────

  if (state.isLoading) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        <p className="text-sm">Loading tasks…</p>
      </div>
    );
  }

  if (selectedTask) {
    return <TaskDetailPanel task={selectedTask} />;
  }

  // ── Render ─────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Fixed toolbar */}
      <div className="shrink-0 pt-6 pb-2">
        <div className={cn('mx-auto w-full px-4', !fullWidth && 'max-w-3xl')}>
          <div className="flex items-center gap-2">
            {/* Search */}
            <div className="flex flex-1 items-center gap-2 rounded-xl border border-border/60 bg-muted/30 px-3 py-2">
              <SearchIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <input
                ref={searchRef}
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') setSearchQuery('');
                }}
                placeholder="Search tasks…"
                className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
              />
              {/* Active filter badge */}
              {isFilterActive && (
                <button
                  type="button"
                  onClick={() => setFilterMode('all')}
                  className="flex shrink-0 items-center gap-1 rounded-md bg-[var(--brand-accent)]/15 px-1.5 py-0.5 text-xs font-medium text-[var(--brand-accent)] transition-colors hover:bg-[var(--brand-accent)]/25"
                  aria-label="Clear filter"
                >
                  {FILTER_LABELS[filterMode]}
                  <XIcon className="h-2.5 w-2.5" />
                </button>
              )}
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => setSearchQuery('')}
                  className="shrink-0 rounded p-0.5 hover:bg-muted transition-colors"
                >
                  <XIcon className="h-3.5 w-3.5 text-muted-foreground" />
                </button>
              )}
            </div>

            {/* Autopilot toggle */}
            <AutopilotToggle className="shrink-0" />

            {/* Filter dropdown */}
            <DropdownMenu.Root>
              <Tooltip content="Filter" side="bottom">
                <DropdownMenu.Trigger asChild>
                  <button
                    type="button"
                    className={cn(
                      'relative flex h-9 w-9 shrink-0 items-center justify-center rounded-lg transition-colors',
                      isFilterActive
                        ? 'bg-primary/10 text-primary'
                        : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
                    )}
                  >
                    <SlidersHorizontalIcon className="h-4 w-4" />
                    {isFilterActive && (
                      <span className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-primary" />
                    )}
                  </button>
                </DropdownMenu.Trigger>
              </Tooltip>
              <DropdownMenu.Portal>
                <DropdownMenu.Content
                  align="end"
                  sideOffset={6}
                  className="z-[9999] w-44 rounded-xl border border-border/70 bg-popover/95 p-1.5 shadow-xl backdrop-blur-md"
                >
                  <DropdownMenu.Label className="px-2 pb-1 pt-0.5 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60">
                    Filter
                  </DropdownMenu.Label>
                  {(['all', 'recent', 'pinned', 'archived'] as FilterMode[]).map((mode) => (
                    <DropdownMenu.Item
                      key={mode}
                      className={cn(
                        'flex cursor-default items-center justify-between rounded-lg px-2.5 py-1.5 text-sm outline-none transition-colors',
                        filterMode === mode
                          ? 'bg-muted/70 font-medium text-foreground'
                          : 'text-popover-foreground data-[highlighted]:bg-muted/50',
                      )}
                      onSelect={() => setFilterMode(mode)}
                    >
                      {FILTER_LABELS[mode]}
                      {filterMode === mode && <CheckIcon className="h-3.5 w-3.5 text-primary" />}
                    </DropdownMenu.Item>
                  ))}
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          </div>
        </div>
      </div>

      {/* ── Archived view ─────────────────────────────────────────────────── */}
      {filterMode === 'archived' ? (
        <div className="relative flex-1 min-h-0">
          <div className="pointer-events-none absolute inset-x-0 top-0 z-10 h-10 bg-gradient-to-b from-background to-transparent" />

          {/* Floating selection bar */}
          {isSelecting && (
            <div
              className={cn(
                'absolute inset-x-0 top-0 z-20 mx-auto w-full px-4 h-8 flex items-center',
                !fullWidth && 'max-w-3xl',
              )}
            >
              <button
                type="button"
                onClick={toggleSelectAll}
                className="flex h-8 w-7 shrink-0 items-center justify-center rounded-lg transition-colors hover:bg-muted/60"
                aria-label={allSelected ? 'Deselect all' : 'Select all'}
              >
                {allSelected ? (
                  <div className="flex h-4 w-4 items-center justify-center rounded bg-[var(--brand-accent)]">
                    <CheckIcon className="h-2.5 w-2.5 text-[var(--brand-accent-fg)]" strokeWidth={3} />
                  </div>
                ) : someSelected ? (
                  <div className="flex h-4 w-4 items-center justify-center rounded bg-[var(--brand-accent)]">
                    <MinusIcon className="h-2.5 w-2.5 text-[var(--brand-accent-fg)]" strokeWidth={3} />
                  </div>
                ) : (
                  <div className="h-4 w-4 rounded border-2 border-muted-foreground/40" />
                )}
              </button>
              <span className="flex-1 ml-2 text-sm font-medium text-foreground">{selectedIds.size} selected</span>
              <div className="flex items-center gap-2">
                <Tooltip content="Unarchive selected" side="bottom">
                  <button
                    type="button"
                    onClick={() => void handleBulkUnarchive()}
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-[var(--brand-accent)]/15 hover:text-[var(--brand-accent)]"
                  >
                    <ArchiveRestoreIcon className="h-4 w-4" />
                  </button>
                </Tooltip>
                <Tooltip content="Delete selected" side="bottom">
                  <button
                    type="button"
                    onClick={() => setBulkDeleteOpen(true)}
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                  >
                    <Trash2Icon className="h-4 w-4" />
                  </button>
                </Tooltip>
                <Tooltip content="Cancel selection" side="bottom">
                  <button
                    type="button"
                    onClick={() => setSelectedIds(new Set())}
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
                  >
                    <XIcon className="h-4 w-4" />
                  </button>
                </Tooltip>
              </div>
            </div>
          )}

          <div className="h-full overflow-y-auto">
            <div className={cn('mx-auto w-full px-4 pt-10 pb-6', !fullWidth && 'max-w-3xl')}>
              {archivedLoading ? (
                <div className="flex items-center justify-center py-24">
                  <div className="h-5 w-5 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-muted-foreground" />
                </div>
              ) : filteredArchived.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-24 text-center">
                  <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-muted/40 text-muted-foreground">
                    <ArchiveIcon size={26} strokeWidth={1.3} />
                  </div>
                  <h3 className="mb-1.5 text-sm font-medium text-foreground/80">
                    {searchQuery ? 'No archived tasks match your search' : 'No archived tasks'}
                  </h3>
                </div>
              ) : (
                <div className="flex flex-col">
                  {filteredArchived.map((task) => {
                    const isSelected = selectedIds.has(task.id);
                    const isHovered = hoveredId === task.id;
                    return (
                      <div key={task.id} className="flex w-full items-center">
                        {/* Checkbox */}
                        <div
                          className="flex w-7 shrink-0 cursor-pointer items-center justify-center py-3"
                          onMouseEnter={() => setHoveredId(task.id)}
                          onMouseLeave={() => setHoveredId(null)}
                          onClick={(e) => {
                            e.stopPropagation();
                            setSelectedIds((prev) => {
                              const next = new Set(prev);
                              if (next.has(task.id)) next.delete(task.id);
                              else next.add(task.id);
                              return next;
                            });
                          }}
                        >
                          {isSelected ? (
                            <div className="flex h-4 w-4 shrink-0 items-center justify-center rounded bg-[var(--brand-accent)]">
                              <CheckIcon className="h-2.5 w-2.5 text-[var(--brand-accent-fg)]" strokeWidth={3} />
                            </div>
                          ) : (
                            <div
                              className={cn(
                                'h-4 w-4 shrink-0 rounded border-2 border-muted-foreground/40 transition-opacity',
                                isHovered || isSelecting ? 'opacity-100' : 'opacity-0',
                              )}
                            />
                          )}
                        </div>

                        {/* Row */}
                        <div
                          role="button"
                          tabIndex={0}
                          className={cn(
                            'flex flex-1 min-w-0 items-center gap-3 rounded-xl px-3 py-3 text-left transition-colors cursor-pointer',
                            isSelected ? 'bg-[var(--brand-accent)]/10' : isHovered ? 'bg-muted/60' : '',
                          )}
                          onMouseEnter={() => setHoveredId(task.id)}
                          onMouseLeave={() => setHoveredId(null)}
                          onClick={() =>
                            setSelectedIds((prev) => {
                              const next = new Set(prev);
                              if (next.has(task.id)) next.delete(task.id);
                              else next.add(task.id);
                              return next;
                            })
                          }
                          onKeyDown={(e) =>
                            e.key === 'Enter' &&
                            setSelectedIds((prev) => {
                              const next = new Set(prev);
                              if (next.has(task.id)) next.delete(task.id);
                              else next.add(task.id);
                              return next;
                            })
                          }
                          onContextMenu={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            setContextMenu({ x: e.clientX, y: e.clientY, taskId: task.id });
                          }}
                        >
                          <ClipboardListIcon className="h-4 w-4 shrink-0 text-muted-foreground/60" />
                          <div className="flex-1 min-w-0">
                            <span className="truncate text-sm font-medium text-foreground/70">
                              {task.title}
                              {pinnedIds.has(task.id) && (
                                <PinIcon className="ml-1.5 inline h-3 w-3 text-muted-foreground" />
                              )}
                            </span>
                            <p className="mt-0.5 text-xs text-muted-foreground/60">
                              {KAI_TASK_STATUS_LABELS[task.status]}
                              {' · '}
                              {formatRelativeTime(task.updatedAt)}
                            </p>
                          </div>
                          <div className="flex shrink-0 items-center gap-1.5">
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                const rect = e.currentTarget.getBoundingClientRect();
                                setContextMenu({ x: rect.left, y: rect.bottom + 4, taskId: task.id });
                              }}
                              className={cn(
                                'flex h-6 w-6 items-center justify-center rounded-md transition-all',
                                'text-muted-foreground hover:bg-muted hover:text-foreground',
                                isHovered ? 'opacity-100' : 'opacity-0 pointer-events-none',
                              )}
                              aria-label="More options"
                            >
                              <EllipsisVerticalIcon className="h-4 w-4" />
                            </button>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          {/* Archived context menu */}
          {contextMenu &&
            createPortal(
              <div
                className="fixed z-[9999] min-w-[180px] rounded-2xl border border-border bg-popover p-1.5 shadow-2xl"
                style={{ left: contextMenu.x, top: contextMenu.y }}
                onClick={(e) => e.stopPropagation()}
              >
                <button
                  className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-popover-foreground hover:bg-muted/70 transition-colors"
                  onClick={() => {
                    void app.tasks.unarchive(contextMenu.taskId).then(() => void loadArchivedTasks());
                    setContextMenu(null);
                  }}
                >
                  <ArchiveRestoreIcon className="h-4 w-4 text-muted-foreground" /> Unarchive
                </button>
                <div className="my-1 h-px bg-border/60" />
                <button
                  className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-destructive hover:bg-destructive/10 transition-colors"
                  onClick={() => {
                    void deleteTask(contextMenu.taskId).then(() => void loadArchivedTasks());
                    setContextMenu(null);
                  }}
                >
                  <Trash2Icon className="h-4 w-4" /> Delete
                </button>
              </div>,
              document.body,
            )}

          {/* Bulk delete confirmation */}
          {bulkDeleteOpen &&
            createPortal(
              <div
                className="fixed inset-0 z-50 flex items-center justify-center"
                onClick={() => setBulkDeleteOpen(false)}
              >
                <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
                <div
                  className="relative w-full max-w-sm rounded-xl border border-border/50 bg-popover/95 p-6 shadow-2xl backdrop-blur-xl"
                  onClick={(e) => e.stopPropagation()}
                >
                  <h2 className="text-sm font-semibold text-foreground">Delete tasks</h2>
                  <p className="mt-2 text-xs text-muted-foreground">
                    {`This will permanently delete ${selectedIds.size} task${selectedIds.size === 1 ? '' : 's'}. This cannot be undone.`}
                  </p>
                  <div className="mt-5 flex items-center justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => setBulkDeleteOpen(false)}
                      className="rounded-lg px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/80"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setBulkDeleteOpen(false);
                        void handleBulkDelete();
                      }}
                      className="flex items-center gap-1.5 rounded-lg bg-destructive px-3 py-1.5 text-xs font-medium text-destructive-foreground transition-colors hover:bg-destructive/90"
                    >
                      <Trash2Icon className="h-3 w-3" />
                      Delete
                    </button>
                  </div>
                </div>
              </div>,
              document.body,
            )}
        </div>
      ) : (
        /* ── Board view (all / recent / pinned) ──────────────────────────── */
        <div className="relative flex-1 min-h-0">
          <div className="pointer-events-none absolute inset-x-0 top-0 z-10 h-10 bg-gradient-to-b from-background to-transparent" />

          <div className="h-full overflow-y-auto">
            <DndContext
              sensors={sensors}
              collisionDetection={collisionDetection}
              onDragStart={handleDragStart}
              onDragEnd={handleDragEnd}
            >
              <div className={cn('mx-auto w-full flex flex-col gap-4 px-4 pt-10 pb-6', !fullWidth && 'max-w-3xl')}>
                {KAI_TASK_STATUS_COLUMNS.map((status) => (
                  <TaskQueueRow
                    key={status}
                    status={status}
                    tasks={tasksByStatus[status]}
                    selectedTaskId={state.selectedTaskId}
                    onTaskClick={handleTaskClick}
                  />
                ))}
              </div>

              <DragOverlay dropAnimation={null}>
                {activeTask && (
                  <div className="w-[180px] scale-105 rotate-1 opacity-90 shadow-lg shadow-black/20">
                    <TaskCard task={activeTask} onClick={() => {}} />
                  </div>
                )}
              </DragOverlay>
            </DndContext>
          </div>
        </div>
      )}

      {/* Read-only task preview modal */}
      <TaskDetailModal
        task={modalTask}
        open={!!modalTask}
        onOpenChange={(open) => {
          if (!open) setModalTaskId(null);
        }}
        onOpenFullView={handleOpenFullView}
      />
    </div>
  );
};
