import { useEffect, useMemo, useRef, useState, useCallback, type FC } from 'react';
import { createPortal } from 'react-dom';
import {
  ArchiveIcon,
  ArrowDownAZIcon,
  ArrowUpDownIcon,
  CheckIcon,
  DownloadIcon,
  EllipsisVerticalIcon,
  MessageSquareIcon,
  MinusIcon,
  PencilIcon,
  PinIcon,
  PlusIcon,
  SearchIcon,
  SlidersHorizontalIcon,
  Trash2Icon,
  XIcon,
} from 'lucide-react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { app } from '@/lib/ipc-client';
import { cn } from '@/lib/utils';
import { Tooltip } from '@/components/ui/Tooltip';
import { useComputerUse } from '@/providers/ComputerUseProvider';
import type { ConversationRecord } from '@/providers/RuntimeProvider';
import { ExportDialog } from './ExportDialog';
import { RenameChatModal } from './RenameChatModal';

type ConversationSummary = Pick<
  ConversationRecord,
  | 'id'
  | 'title'
  | 'fallbackTitle'
  | 'createdAt'
  | 'updatedAt'
  | 'lastMessageAt'
  | 'messageCount'
  | 'userMessageCount'
  | 'runStatus'
  | 'hasUnread'
  | 'lastAssistantUpdateAt'
  | 'archived'
  | 'workspaceId'
>;

type ChatsListPageProps = {
  onOpenConversation: (id: string) => void;
  onNewConversation: () => Promise<void> | void;
  workspaceId?: string | null;
};

type FilterMode = 'all' | 'recent' | 'pinned' | 'archived';
type SortMode = 'newest' | 'oldest' | 'alphabetical' | 'activity';

const FILTER_LABELS: Record<FilterMode, string> = {
  all: 'All',
  recent: 'Recent',
  pinned: 'Pinned',
  archived: 'Archived',
};

const SORT_LABELS: Record<SortMode, string> = {
  newest: 'Newest',
  oldest: 'Oldest',
  alphabetical: 'Alphabetical',
  activity: 'Activity',
};

function formatRowTimestamp(timestamp: string | null): string {
  if (!timestamp) return '';
  const diffMs = Date.now() - new Date(timestamp).getTime();
  // Within the last 7 days — show relative time matching the sidebar
  if (diffMs < 60_000) return 'just now';
  if (diffMs < 3_600_000) return `${Math.floor(diffMs / 60_000)}m ago`;
  if (diffMs < 86_400_000) return `${Math.floor(diffMs / 3_600_000)}h ago`;
  if (diffMs < 604_800_000) return `${Math.floor(diffMs / 86_400_000)}d ago`;
  // Older than 7 days — show a short date, include year if not current
  const date = new Date(timestamp);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    ...(!sameYear ? { year: 'numeric' } : {}),
  });
}

function getDisplayTitle(conv: ConversationSummary): string {
  return conv.title?.trim() || conv.fallbackTitle?.trim() || '';
}

export const ChatsListPage: FC<ChatsListPageProps> = ({
  onOpenConversation,
  onNewConversation,
  workspaceId,
}) => {
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [filterMode, setFilterMode] = useState<FilterMode>('all');
  const [sortMode, setSortMode] = useState<SortMode>('newest');
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    convId: string;
  } | null>(null);
  const [renameModal, setRenameModal] = useState<{ id: string; value: string } | null>(null);
  const [exportConvId, setExportConvId] = useState<string | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const { sessionsByConversation } = useComputerUse();
  const [pinnedIds, setPinnedIds] = useState<Set<string>>(() => {
    try {
      return new Set(
        JSON.parse(
          localStorage.getItem(__BRAND_APP_SLUG + ':pinned-conversations') ?? '[]',
        ),
      );
    } catch {
      return new Set();
    }
  });

  const loadConversations = useCallback(async () => {
    try {
      const list = (await app.conversations.list()) as ConversationSummary[];
      setConversations(list);
      setHasLoaded(true);
    } catch {
      // IPC not ready
    }
  }, []);

  // Focus the search input when the page mounts
  useEffect(() => {
    searchInputRef.current?.focus();
  }, []);

  useEffect(() => {
    let cancelled = false;
    const safeLoad = () => {
      if (!cancelled) void loadConversations();
    };
    safeLoad();
    const unsub = app.conversations.onChanged(() => {
      safeLoad();
    });
    return () => {
      cancelled = true;
      unsub();
    };
  }, [loadConversations]);

  const togglePin = useCallback((id: string) => {
    setPinnedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      localStorage.setItem(
        __BRAND_APP_SLUG + ':pinned-conversations',
        JSON.stringify([...next]),
      );
      return next;
    });
  }, []);

  const handleArchive = async (id: string) => {
    const conv = (await app.conversations.get(id)) as ConversationRecord | null;
    if (!conv) return;
    await app.conversations.put({ ...conv, archived: !conv.archived });
    setSelectedIds((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    await loadConversations();
  };

  const handleDelete = async (id: string) => {
    await app.conversations.delete(id);
    setSelectedIds((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    await loadConversations();
  };

  const handleRename = async (id: string, newTitle: string) => {
    const trimmed = newTitle.trim();
    if (!trimmed) { setRenameModal(null); return; }
    const conv = (await app.conversations.get(id)) as ConversationRecord | null;
    if (!conv) { setRenameModal(null); return; }
    await app.conversations.put({ ...conv, title: trimmed, titleStatus: 'manual' });
    setRenameModal(null);
    await loadConversations();
  };

  const handleMoreClick = useCallback(
    (e: React.MouseEvent<HTMLButtonElement>, convId: string) => {
      e.stopPropagation();
      const rect = e.currentTarget.getBoundingClientRect();
      setContextMenu({ x: rect.left, y: rect.bottom + 4, convId });
    },
    [],
  );

  const handleBulkArchive = useCallback(async () => {
    const shouldArchive = filterMode !== 'archived';
    for (const id of selectedIds) {
      const conv = (await app.conversations.get(id)) as ConversationRecord | null;
      if (conv && conv.archived !== shouldArchive) {
        await app.conversations.put({ ...conv, archived: shouldArchive });
      }
    }
    setSelectedIds(new Set());
    await loadConversations();
  }, [selectedIds, filterMode, loadConversations]);

  const handleBulkDelete = useCallback(async () => {
    for (const id of selectedIds) {
      await app.conversations.delete(id);
    }
    setSelectedIds(new Set());
    await loadConversations();
  }, [selectedIds, loadConversations]);

  const handleRowContextMenu = useCallback(    (e: React.MouseEvent<HTMLDivElement>, convId: string) => {
      e.preventDefault();
      e.stopPropagation();
      setContextMenu({ x: e.clientX, y: e.clientY, convId });
    },
    [],
  );

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

  const processed = useMemo(() => {
    let result = [...conversations];

    // Workspace scoping
    if (workspaceId) {
      result = result.filter(
        (c) => c.workspaceId === workspaceId || !c.workspaceId,
      );
    }

    // Hide empty threads
    result = result.filter(
      (c) =>
        c.messageCount > 0 ||
        Boolean(c.title?.trim() || c.fallbackTitle?.trim()),
    );

    // Filter mode
    if (filterMode === 'archived') {
      result = result.filter((c) => c.archived);
    } else if (filterMode === 'pinned') {
      result = result.filter((c) => !c.archived && pinnedIds.has(c.id));
    } else if (filterMode === 'recent') {
      const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
      result = result.filter((c) => {
        const t = c.lastAssistantUpdateAt ?? c.lastMessageAt ?? c.updatedAt ?? c.createdAt;
        return !c.archived && new Date(t).getTime() >= cutoff;
      });
    } else {
      // 'all' — exclude archived
      result = result.filter((c) => !c.archived);
    }

    // Search
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      result = result.filter((c) =>
        getDisplayTitle(c).toLowerCase().includes(q),
      );
    }

    // Sort
    result.sort((a, b) => {
      if (sortMode === 'alphabetical') {
        return getDisplayTitle(a).localeCompare(getDisplayTitle(b));
      }
      if (sortMode === 'activity') {
        return (b.messageCount ?? 0) - (a.messageCount ?? 0);
      }
      const aAt = a.lastAssistantUpdateAt ?? a.lastMessageAt ?? a.updatedAt ?? a.createdAt;
      const bAt = b.lastAssistantUpdateAt ?? b.lastMessageAt ?? b.updatedAt ?? b.createdAt;
      if (sortMode === 'oldest') return aAt.localeCompare(bAt);
      return bAt.localeCompare(aAt); // newest (default)
    });

    return result;
  }, [conversations, workspaceId, searchQuery, filterMode, sortMode, pinnedIds, sessionsByConversation]);

  const isSelecting = selectedIds.size > 0;
  const allSelected = isSelecting && processed.length > 0 && processed.every((c) => selectedIds.has(c.id));
  const someSelected = isSelecting && !allSelected;

  // Prune selected IDs that are no longer visible in the current filter/search view
  useEffect(() => {
    if (selectedIds.size === 0) return;
    const visibleIds = new Set(processed.map((c) => c.id));
    const stale = [...selectedIds].filter((id) => !visibleIds.has(id));
    if (stale.length > 0) {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        for (const id of stale) next.delete(id);
        return next;
      });
    }
  }, [processed]);

  const toggleSelectAll = useCallback(() => {
    if (allSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(processed.map((c) => c.id)));
    }
  }, [allSelected, processed]);

  const isFilterActive = filterMode !== 'all';
  const isSortActive = sortMode !== 'newest';

  return (
    <div className="flex flex-col h-full min-h-0 pt-12 md:pt-14">

      {/* Fixed toolbar: search + filter + sort */}
      <div className="shrink-0 pt-6 pb-2">
        <div className="mx-auto max-w-3xl px-4 space-y-2">
          <div className="flex items-center gap-2">
            <div className="flex flex-1 items-center gap-2 rounded-xl border border-border/60 bg-muted/30 px-3 py-2">
              <SearchIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <input
                ref={searchInputRef}
                id="chats-list-search"
                type="text"
                placeholder="Search chats…"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') setSearchQuery('');
                }}
                className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
              />
              {/* Active filter / sort badges inside the search box */}
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
              {isSortActive && (
                <button
                  type="button"
                  onClick={() => setSortMode('newest')}
                  className="flex shrink-0 items-center gap-1 rounded-md bg-muted/60 px-1.5 py-0.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted"
                  aria-label="Clear sort"
                >
                  <ArrowDownAZIcon className="h-3 w-3" />
                  {SORT_LABELS[sortMode]}
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

            {/* Sort dropdown */}
            <DropdownMenu.Root>
              <Tooltip content="Sort" side="bottom">
                <DropdownMenu.Trigger asChild>
                  <button
                    type="button"
                    className={cn(
                      'relative flex h-9 w-9 shrink-0 items-center justify-center rounded-lg transition-colors',
                      isSortActive
                        ? 'bg-primary/10 text-primary'
                        : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
                    )}
                  >
                    <ArrowUpDownIcon className="h-4 w-4" />
                    {isSortActive && (
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
                    Sort
                  </DropdownMenu.Label>
                  {(['newest', 'oldest', 'alphabetical', 'activity'] as SortMode[]).map((mode) => (
                    <DropdownMenu.Item
                      key={mode}
                      className={cn(
                        'flex cursor-default items-center justify-between rounded-lg px-2.5 py-1.5 text-sm outline-none transition-colors',
                        sortMode === mode
                          ? 'bg-muted/70 font-medium text-foreground'
                          : 'text-popover-foreground data-[highlighted]:bg-muted/50',
                      )}
                      onSelect={() => setSortMode(mode)}
                    >
                      {SORT_LABELS[mode]}
                      {sortMode === mode && <CheckIcon className="h-3.5 w-3.5 text-primary" />}
                    </DropdownMenu.Item>
                  ))}
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          </div>
        </div>
        {/* Always-present h-8 placeholder for selection bar — prevents layout jump */}
        <div className="mx-auto max-w-3xl px-4 mt-2 h-8 flex items-center">
          {isSelecting && (
            <>
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
              <span className="flex-1 ml-2 text-sm font-medium text-foreground">
                {selectedIds.size} selected
              </span>
              <div className="flex items-center gap-2">
                <Tooltip content={filterMode === 'archived' ? 'Unarchive selected' : 'Archive selected'} side="bottom">
                  <button
                    type="button"
                    onClick={() => void handleBulkArchive()}
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-[var(--brand-accent)]/15 hover:text-[var(--brand-accent)]"
                  >
                    <ArchiveIcon className="h-4 w-4" />
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
            </>
          )}
        </div>
      </div>

      {/* Scrollable content with fade at top */}
      <div className="relative flex-1 min-h-0">
        <div className="pointer-events-none absolute inset-x-0 top-0 z-10 h-6 bg-gradient-to-b from-background to-transparent" />
        <div className="h-full overflow-y-auto">
          <div className="mx-auto max-w-3xl px-4 pb-6">

            {/* Conversation rows */}
            <div className="flex flex-col">
              {hasLoaded && processed.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-24 text-center">
                <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-muted/40 text-muted-foreground">
                  <MessageSquareIcon size={26} strokeWidth={1.3} />
                </div>
                <h3 className="mb-1.5 text-sm font-medium text-foreground/80">
                  {searchQuery
                    ? 'No chats match your search'
                    : isFilterActive
                      ? `No ${FILTER_LABELS[filterMode].toLowerCase()} chats`
                      : 'No chats yet'}
                </h3>
                {!searchQuery && !isFilterActive && (
                  <p className="mb-5 max-w-xs text-xs text-muted-foreground leading-relaxed">
                    Start a conversation with Kai. Your chat history will appear here.
                  </p>
                )}
                {!searchQuery && !isFilterActive && (
                  <button
                    type="button"
                    onClick={() => void onNewConversation()}
                    className="flex items-center gap-1.5 rounded-lg bg-primary px-3.5 py-2 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
                  >
                    <PlusIcon size={13} />
                    Start Your First Chat
                  </button>
                )}
              </div>
            ) : (
              processed.map((conv) => {
                const isHovered = hoveredId === conv.id;
                const displayTitle = getDisplayTitle(conv) || 'New Chat';
                const tsStr = formatRowTimestamp(
                  conv.lastAssistantUpdateAt ?? conv.lastMessageAt ?? conv.updatedAt,
                );
                const metaStr = conv.messageCount > 0
                  ? `${tsStr} · ${conv.messageCount} msgs`
                  : tsStr;
                const isPinned = pinnedIds.has(conv.id);

                return (
                  <div key={conv.id} className="flex w-full items-center">
                    {/* Checkbox — outside the hover/click zone */}
                    <div
                      className="flex w-7 shrink-0 cursor-pointer items-center justify-center py-3"
                      onMouseEnter={() => setHoveredId(conv.id)}
                      onMouseLeave={() => setHoveredId(null)}
                      onClick={(e) => {
                        e.stopPropagation();
                        setSelectedIds((prev) => {
                          const next = new Set(prev);
                          if (next.has(conv.id)) next.delete(conv.id);
                          else next.add(conv.id);
                          return next;
                        });
                      }}
                    >
                      {selectedIds.has(conv.id) ? (
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

                    {/* Hoverable / clickable row */}
                    <div
                      role="button"
                      tabIndex={0}
                      className={cn(
                        'flex flex-1 min-w-0 items-center gap-3 rounded-xl px-3 py-3 text-left transition-colors cursor-pointer',
                        selectedIds.has(conv.id)
                          ? 'bg-[var(--brand-accent)]/10'
                          : isHovered ? 'bg-muted/60' : '',
                      )}
                      onMouseEnter={() => setHoveredId(conv.id)}
                      onMouseLeave={() => setHoveredId(null)}
                      onClick={() => onOpenConversation(conv.id)}
                      onKeyDown={(e) => e.key === 'Enter' && onOpenConversation(conv.id)}
                      onContextMenu={(e) => handleRowContextMenu(e, conv.id)}
                    >
                      <MessageSquareIcon className="h-4 w-4 shrink-0 text-muted-foreground" />

                      <div className="flex-1 min-w-0">
                        <span className="truncate text-sm font-medium text-foreground">
                          {displayTitle}
                          {isPinned && (
                            <PinIcon className="ml-1.5 inline h-3 w-3 text-muted-foreground" />
                          )}
                        </span>
                      </div>

                      <div className="flex shrink-0 items-center gap-1.5">
                        <span className="text-xs text-muted-foreground whitespace-nowrap">
                          {metaStr}
                        </span>
                        <button
                          type="button"
                          onClick={(e) => handleMoreClick(e, conv.id)}
                          className={cn(
                            'flex h-6 w-6 items-center justify-center rounded-md transition-all',
                            'text-muted-foreground hover:bg-muted hover:text-foreground',
                            isHovered ? 'opacity-100' : 'opacity-0 pointer-events-none',
                          )}
                          title="More options"
                          aria-label="More options"
                        >
                          <EllipsisVerticalIcon className="h-4 w-4" />
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>{/* end flex flex-col rows */}
          </div>{/* end max-w-3xl pb-6 */}
        </div>{/* end overflow-y-auto */}
      </div>{/* end relative flex-1 */}

      {/* Bulk delete confirmation modal */}
      {bulkDeleteOpen && createPortal(
        <div className="fixed inset-0 z-50 flex items-center justify-center" onClick={() => setBulkDeleteOpen(false)}>
          <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
          <div
            className="relative w-full max-w-sm rounded-xl border border-border/50 bg-popover/95 p-6 shadow-2xl backdrop-blur-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-sm font-semibold text-foreground">Delete chats</h2>
            <p className="mt-2 text-xs text-muted-foreground">
              {`This will permanently delete ${selectedIds.size} chat${selectedIds.size === 1 ? '' : 's'}. This cannot be undone.`}
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
                onClick={() => { setBulkDeleteOpen(false); void handleBulkDelete(); }}
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

      {/* Context menu */}
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
                setSelectedIds((prev) => {
                  const next = new Set(prev);
                  if (next.has(contextMenu.convId)) next.delete(contextMenu.convId);
                  else next.add(contextMenu.convId);
                  return next;
                });
                setContextMenu(null);
              }}
            >
              <CheckIcon className="h-4 w-4 text-muted-foreground" />
              Select
            </button>
            <div className="my-1 h-px bg-border/60" />
            <button
              className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-popover-foreground hover:bg-muted/70 transition-colors"
              onClick={() => { togglePin(contextMenu.convId); setContextMenu(null); }}
            >
              <PinIcon className="h-4 w-4 text-muted-foreground" />
              {pinnedIds.has(contextMenu.convId) ? 'Unpin' : 'Pin'}
            </button>
            <button
              className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-popover-foreground hover:bg-muted/70 transition-colors"
              onClick={() => {
                const conv = conversations.find((c) => c.id === contextMenu.convId);
                setRenameModal({ id: contextMenu.convId, value: conv?.title || conv?.fallbackTitle || '' });
                setContextMenu(null);
              }}
            >
              <PencilIcon className="h-4 w-4 text-muted-foreground" />
              Rename
            </button>
            <button
              className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-popover-foreground hover:bg-muted/70 transition-colors"
              onClick={() => { void handleArchive(contextMenu.convId); setContextMenu(null); }}
            >
              <ArchiveIcon className="h-4 w-4 text-muted-foreground" />
              {conversations.find((c) => c.id === contextMenu.convId)?.archived ? 'Unarchive' : 'Archive'}
            </button>
            <button
              className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-popover-foreground hover:bg-muted/70 transition-colors"
              onClick={() => { setExportConvId(contextMenu.convId); setContextMenu(null); }}
            >
              <DownloadIcon className="h-4 w-4 text-muted-foreground" />
              Export
            </button>
            <div className="my-1 h-px bg-border/60" />
            <button
              className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-destructive hover:bg-destructive/10 transition-colors"
              onClick={() => { void handleDelete(contextMenu.convId); setContextMenu(null); }}
            >
              <Trash2Icon className="h-4 w-4" />
              Delete
            </button>
          </div>,
          document.body,
        )}

      {/* Rename modal */}
      {renameModal && (
        <RenameChatModal
          initialValue={renameModal.value}
          onSave={(title) => void handleRename(renameModal.id, title)}
          onClose={() => setRenameModal(null)}
        />
      )}

      <ExportDialog
        open={exportConvId !== null}
        onClose={() => setExportConvId(null)}
        conversationId={exportConvId}
      />
    </div>
  );
};
