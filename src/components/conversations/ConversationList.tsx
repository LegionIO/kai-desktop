import { useEffect, useMemo, useRef, useState, useCallback, type FC } from 'react';
import { createPortal } from 'react-dom';
import { SearchIcon, Trash2Icon, ArchiveIcon, MessageSquareIcon, LoaderIcon, XIcon, SlidersHorizontalIcon, MonitorIcon, PinIcon, PencilIcon, DownloadIcon, EllipsisVerticalIcon, ListFilterIcon, SquarePenIcon, CheckIcon, ArrowUpDownIcon } from 'lucide-react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { app } from '@/lib/ipc-client';
import { cn } from '@/lib/utils';
import { useComputerUse } from '@/providers/ComputerUseProvider';
import type { ConversationRecord } from '@/providers/RuntimeProvider';
import type { ComputerSession } from '../../../shared/computer-use';
import { useConversationPreferences } from './useConversationPreferences';
import { SortPopover } from './SortPopover';
import { FilterPopover } from './FilterPopover';
import { ExportDialog } from './ExportDialog';

type ConversationSummary = Pick<
  ConversationRecord,
  'id' | 'title' | 'fallbackTitle' | 'createdAt' | 'updatedAt' | 'lastMessageAt' |
  'messageCount' | 'userMessageCount' | 'runStatus' | 'hasUnread' | 'lastAssistantUpdateAt' | 'archived' | 'workspaceId'
> & {
  /** Computed server-side: true if any message contains a tool-call content part */
  hasToolCalls?: boolean;
};

type ConversationListProps = {
  activeConversationId: string | null;
  activeThreadMode?: 'chat' | 'computer';
  onSwitchConversation: (id: string) => void;
  onNewConversation: () => Promise<void> | void;
  onDeleteConversation?: (id: string) => Promise<void> | void;
  /** When set, only conversations matching this workspace (or unscoped legacy conversations) are shown. */
  workspaceId?: string | null;
};

function formatRelativeTime(timestamp: string | null): string {
  if (!timestamp) return 'No messages';
  const diffMs = Date.now() - new Date(timestamp).getTime();
  if (diffMs < 60_000) return 'just now';
  if (diffMs < 3_600_000) return `${Math.floor(diffMs / 60_000)}m ago`;
  if (diffMs < 86_400_000) return `${Math.floor(diffMs / 3_600_000)}h ago`;
  if (diffMs < 604_800_000) return `${Math.floor(diffMs / 86_400_000)}d ago`;
  return `${Math.floor(diffMs / 604_800_000)}w ago`;
}

function getDisplayTitle(conv: ConversationSummary, computerSessions?: ComputerSession[]): string {
  // Prefer chat-based titles
  const chatTitle = conv.title?.trim() || conv.fallbackTitle?.trim();
  if (chatTitle) return chatTitle;

  // Fall back to computer-use session goal
  if (computerSessions?.length) {
    const goal = computerSessions[0].goal;
    if (goal) return goal.length > 50 ? goal.slice(0, 47).trimEnd() + '...' : goal;
  }

  return '';
}

const TypingBubble: FC = () => (
  <div className="flex items-center gap-0.5 px-1">
    <div className="h-1 w-1 rounded-full bg-primary animate-bounce [animation-delay:0ms]" />
    <div className="h-1 w-1 rounded-full bg-primary animate-bounce [animation-delay:150ms]" />
    <div className="h-1 w-1 rounded-full bg-primary animate-bounce [animation-delay:300ms]" />
  </div>
);

/** Pulsing monitor icon — shown when a computer-use session is actively running */
const ComputerActiveIndicator: FC = () => (
  <div className="flex items-center gap-1 px-0.5" title="Computer session running">
    <span className="relative flex h-2 w-2">
      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-blue-400 opacity-75" />
      <span className="relative inline-flex h-2 w-2 rounded-full bg-blue-500" />
    </span>
    <MonitorIcon className="h-3 w-3 text-blue-500" />
  </div>
);

/** Static green dot — shown when a computer-use session has completed */
const ComputerCompletedIndicator: FC = () => (
  <div className="flex items-center gap-1 px-0.5" title="Computer session completed">
    <div className="h-2 w-2 rounded-full bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.4)]" />
  </div>
);

export const ConversationList: FC<ConversationListProps> = ({
  activeConversationId,
  activeThreadMode,
  onSwitchConversation,
  onNewConversation,
  onDeleteConversation: _onDeleteConversation,
  workspaceId,
}) => {
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [, setDeletingId] = useState<string | null>(null);
  const [removingIds, setRemovingIds] = useState<Set<string>>(new Set());
  const removingIdsRef = useRef<Set<string>>(new Set());
  const [pinnedIds, setPinnedIds] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem(__BRAND_APP_SLUG + ':pinned-conversations') || '[]')); } catch { return new Set(); }
  });
  const { sessionsByConversation } = useComputerUse();
  const [sortOpen, setSortOpen] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const moreButtonRef = useRef<HTMLButtonElement>(null);
  const { sort, setSort, filter, setFilter, activeFilterCount, clearFilters, isDefaultSort } = useConversationPreferences();
  const [showArchived, setShowArchived] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; convId: string } | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [exportConvId, setExportConvId] = useState<string | null>(null);

  const togglePin = useCallback((id: string) => {
    setPinnedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      const serialized = JSON.stringify([...next]);
      localStorage.setItem(__BRAND_APP_SLUG + ':pinned-conversations', serialized);
      window.dispatchEvent(new CustomEvent('pinned-conversations-changed', { detail: serialized }));
      return next;
    });
  }, []);

  // Sync pin state when changed from the title bar dropdown
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as string;
      try { setPinnedIds(new Set(JSON.parse(detail))); } catch { /* ignore */ }
    };
    window.addEventListener('pinned-conversations-changed', handler);
    return () => window.removeEventListener('pinned-conversations-changed', handler);
  }, []);

  /** Get the computer-use session status for a conversation */
  const getComputerStatus = useCallback((conversationId: string): 'running' | 'completed' | null => {
    const sessions = sessionsByConversation.get(conversationId);
    if (!sessions?.length) return null;
    const latest = sessions[0]; // sorted by updatedAt desc
    if (latest.status === 'running' || latest.status === 'starting' || latest.status === 'awaiting-approval') return 'running';
    if (latest.status === 'completed' && !latest.completionSeen) return 'completed';
    return null;
  }, [sessionsByConversation]);

  // Mark computer-use sessions as seen when the user is viewing the Computer tab
  useEffect(() => {
    if (!activeConversationId || activeThreadMode !== 'computer') return;
    const sessions = sessionsByConversation.get(activeConversationId);
    const hasUnseen = sessions?.some((s) => s.status === 'completed' && !s.completionSeen);
    if (hasUnseen) {
      void app.computerUse.markSessionsSeen(activeConversationId);
    }
  }, [activeConversationId, activeThreadMode, sessionsByConversation]);

  const loadConversations = useCallback(async () => {
    try {
      const list = await app.conversations.list() as ConversationSummary[];

      setConversations((prev) => {
        const newIds = new Set(list.map((c) => c.id));
        const vanished = prev.filter((c) => !newIds.has(c.id) && !removingIdsRef.current.has(c.id));

        if (vanished.length > 0) {
          setRemovingIds((ids) => {
            const next = new Set(ids);
            for (const c of vanished) next.add(c.id);
            removingIdsRef.current = next;
            return next;
          });
          setTimeout(() => {
            setRemovingIds((ids) => {
              const next = new Set(ids);
              for (const c of vanished) next.delete(c.id);
              removingIdsRef.current = next;
              return next;
            });
            setConversations((current) =>
              current.filter((c) => !vanished.some((v) => v.id === c.id)),
            );
          }, 300);
          return prev;
        }

        return list;
      });
      setHasLoaded(true);
    } catch {
      // IPC not ready
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const safeLoad = () => { if (!cancelled) void loadConversations(); };
    safeLoad();
    const unsub = app.conversations.onChanged(() => { safeLoad(); });
    return () => { cancelled = true; unsub(); };
  }, [loadConversations]);

  const isSearchActive = searchQuery.trim().length > 0;
  const hasActiveFilters = activeFilterCount > 0;

  const processedConversations = useMemo(() => {
    let result = [...conversations];

    // Stage 0: Workspace scoping — show only conversations belonging to the active workspace
    // (or legacy/unscoped conversations that have no workspaceId)
    if (workspaceId) {
      result = result.filter((conv) => conv.workspaceId === workspaceId || !conv.workspaceId);
    }

    result = result.filter((conv) => showArchived ? Boolean(conv.archived) : !conv.archived);

    // Hide empty threads (no messages, no title) — they only appear after the user sends a message
    result = result.filter((conv) => conv.messageCount > 0 || Boolean(conv.title?.trim() || conv.fallbackTitle?.trim()));

    // Stage 1: Apply filters
    if (hasActiveFilters) {
      result = result.filter((conv) => {
        if (filter.hasToolCalls === true && !conv.hasToolCalls) return false;
        if (filter.hasComputerUse === true && !sessionsByConversation.has(conv.id)) return false;
        if (filter.messageCountMin != null && conv.messageCount < filter.messageCountMin) return false;
        if (filter.messageCountMax != null && conv.messageCount > filter.messageCountMax) return false;
        if (filter.createdAfter && conv.createdAt.slice(0, 10) < filter.createdAfter) return false;
        if (filter.createdBefore && conv.createdAt.slice(0, 10) > filter.createdBefore) return false;
        const effectiveUpdated = conv.lastAssistantUpdateAt ?? conv.lastMessageAt ?? conv.updatedAt;
        if (filter.updatedAfter && (effectiveUpdated ?? '').slice(0, 10) < filter.updatedAfter) return false;
        if (filter.updatedBefore && (effectiveUpdated ?? '').slice(0, 10) > filter.updatedBefore) return false;
        return true;
      });
    }

    // Stage 2: Apply text search
    if (isSearchActive) {
      const q = searchQuery.toLowerCase();
      result = result.filter((c) =>
        getDisplayTitle(c, sessionsByConversation.get(c.id)).toLowerCase().includes(q),
      );
    }

    // Stage 3: Apply sort
    result.sort((a, b) => {
      let cmp = 0;
      switch (sort.field) {
        case 'latest-updated': {
          const aAt = a.lastAssistantUpdateAt ?? a.lastMessageAt ?? a.updatedAt ?? a.createdAt;
          const bAt = b.lastAssistantUpdateAt ?? b.lastMessageAt ?? b.updatedAt ?? b.createdAt;
          cmp = aAt.localeCompare(bAt);
          break;
        }
        case 'first-created':
          cmp = a.createdAt.localeCompare(b.createdAt);
          break;
        case 'alphabetical': {
          const aTitle = getDisplayTitle(a, sessionsByConversation.get(a.id)).toLowerCase();
          const bTitle = getDisplayTitle(b, sessionsByConversation.get(b.id)).toLowerCase();
          cmp = aTitle.localeCompare(bTitle);
          break;
        }
      }
      return sort.direction === 'desc' ? -cmp : cmp;
    });

    return result;
  }, [conversations, filter, hasActiveFilters, searchQuery, isSearchActive, sort, sessionsByConversation, showArchived, workspaceId]);

  // Tracks a conversation that is fading out but should still look "active"
  // so the highlight doesn't jump to the next item during the removal animation.
  const [fadingActiveId, setFadingActiveId] = useState<string | null>(null);

  const handleDelete = async (id: string) => {
    setDeletingId(id);
    try {
      const wasDeletingActive = id === activeConversationId;
      let next: ConversationSummary | undefined;

      if (wasDeletingActive) {
        const idx = processedConversations.findIndex((c) => c.id === id);
        next = processedConversations[idx + 1] ?? processedConversations[idx - 1];
        // Keep the deleted item visually "active" during the fade-out
        setFadingActiveId(id);
      }

      await app.conversations.delete(id);
      await loadConversations();

      if (wasDeletingActive) {
        // Wait for the 300ms removal animation to finish before switching
        setTimeout(async () => {
          setFadingActiveId(null);
          if (next) {
            await app.conversations.setActiveId(next.id);
            onSwitchConversation(next.id);
          } else {
            await onNewConversation();
          }
        }, 300);
      }
    } finally {
      setDeletingId(null);
    }
  };

  const handleArchive = async (id: string) => {
    const conv = await app.conversations.get(id) as ConversationRecord | null;
    if (!conv) return;
    const isArchived = !conv.archived;
    await app.conversations.put({ ...conv, archived: isArchived });
    if (isArchived && id === activeConversationId) {
      await onNewConversation();
    }
    await loadConversations();
  };

  const handleRename = async (id: string, newTitle: string) => {
    const trimmed = newTitle.trim();
    if (!trimmed) { setRenamingId(null); return; }
    const conv = await app.conversations.get(id) as ConversationRecord | null;
    if (!conv) { setRenamingId(null); return; }
    await app.conversations.put({ ...conv, title: trimmed, titleStatus: 'manual' });
    setRenamingId(null);
    await loadConversations();
  };

  const handleContextMenu = useCallback((e: React.MouseEvent, convId: string) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY, convId });
  }, []);

  const handleMoreClick = useCallback((e: React.MouseEvent<HTMLButtonElement>, convId: string) => {
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    setContextMenu({ x: rect.left, y: rect.bottom + 4, convId });
  }, []);

  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    window.addEventListener('click', close);
    window.addEventListener('contextmenu', close);
    return () => { window.removeEventListener('click', close); window.removeEventListener('contextmenu', close); };
  }, [contextMenu]);

  const handleDeleteBulk = async () => {
    const idsToDelete = processedConversations.map((c) => c.id);

    for (const id of idsToDelete) {
      await app.conversations.delete(id);
    }

    if (activeConversationId && idsToDelete.includes(activeConversationId)) {
      await onNewConversation();
    }

    await loadConversations();
  };

  const handleClearUnread = async (id: string) => {
    const conv = await app.conversations.get(id) as ConversationRecord | null;
    // Don't clear hasUnread when the conversation is awaiting approval —
    // the user hasn't actually addressed the pending prompt yet, so the
    // indicator should reappear when they navigate away.
    if (conv?.hasUnread && conv.runStatus !== 'awaiting-approval') {
      await app.conversations.put({ ...conv, hasUnread: false });
    }
    onSwitchConversation(id);
  };

  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [isBulkDeleting, setIsBulkDeleting] = useState(false);

  const confirmBulkDelete = async () => {
    setIsBulkDeleting(true);
    await handleDeleteBulk();
    setIsBulkDeleting(false);
    setBulkDeleteOpen(false);
  };

  const isNewChat = hasLoaded && !!activeConversationId && !processedConversations.some((c) => c.id === activeConversationId);

  return (
    <div className="flex flex-col h-full">
      {/* CHATS heading row — label + options dropdown + New Chat pill */}
      <div className="flex items-center gap-1.5 px-3 pb-2 pt-3">
        <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
          Chats
        </span>
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button
              ref={moreButtonRef}
              type="button"
              className="relative rounded-md p-1 text-muted-foreground transition-colors hover:bg-sidebar-accent/80 hover:text-sidebar-foreground"
            >
              <ListFilterIcon className="h-3.5 w-3.5" />
              {/* Activity dot — visible when sort, filter, or archive is non-default */}
              {(!isDefaultSort || activeFilterCount > 0 || showArchived) && (
                <span className="pointer-events-none absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-primary" />
              )}
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              align="start"
              side="bottom"
              sideOffset={6}
              className="z-[9999] min-w-[180px] rounded-xl border border-border/70 bg-popover/95 p-1 text-popover-foreground shadow-xl backdrop-blur-md"
            >
                <DropdownMenu.Item
                  className="flex cursor-default items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm outline-none transition-colors data-[highlighted]:bg-muted/70"
                  onSelect={() => { setSortOpen(true); setFilterOpen(false); }}
                >
                  <ArrowUpDownIcon size={14} className="text-muted-foreground" />
                  Sort chats
                  {!isDefaultSort && <CheckIcon size={13} className="ml-auto text-primary" />}
                </DropdownMenu.Item>
                <DropdownMenu.Item
                  className="flex cursor-default items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm outline-none transition-colors data-[highlighted]:bg-muted/70"
                  onSelect={() => { setFilterOpen(true); setSortOpen(false); }}
                >
                  <SlidersHorizontalIcon size={14} className="text-muted-foreground" />
                  Filter chats
                  {activeFilterCount > 0 && (
                    <span className="ml-auto flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold text-primary-foreground">
                      {activeFilterCount > 9 ? '9+' : activeFilterCount}
                    </span>
                  )}
                </DropdownMenu.Item>
                <DropdownMenu.Item
                  className="flex cursor-default items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm outline-none transition-colors data-[highlighted]:bg-muted/70"
                  onSelect={() => setShowArchived((p) => !p)}
                >
                  <ArchiveIcon size={14} className="text-muted-foreground" />
                  {showArchived ? 'Show active' : 'Show archived'}
                  {showArchived && <CheckIcon size={13} className="ml-auto text-primary" />}
                </DropdownMenu.Item>
                <DropdownMenu.Separator className="my-1 h-px bg-border/50" />
                <DropdownMenu.Item
                  className="flex cursor-default items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm text-destructive outline-none transition-colors data-[highlighted]:bg-destructive/10"
                  disabled={processedConversations.length === 0}
                  onSelect={() => setBulkDeleteOpen(true)}
                >
                  <Trash2Icon size={14} />
                  {isSearchActive || hasActiveFilters
                    ? `Delete ${processedConversations.length} shown`
                    : 'Delete all'}
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        <div className="flex-1" />
        <button
          type="button"
          onClick={() => { void onNewConversation(); }}
          className={cn(
            'flex items-center gap-1.5 rounded-lg border border-sidebar-border/60 px-2.5 py-1 text-xs font-medium text-sidebar-foreground transition-colors hover:bg-sidebar-accent/60',
            isNewChat && 'border-primary/40 bg-primary/10 text-primary',
          )}
        >
          <SquarePenIcon className="h-3 w-3" />
          New Chat
        </button>
      </div>
      {/* Sort/Filter popovers — anchored to the ··· button */}
      {sortOpen && (
        <SortPopover sort={sort} onSortChange={setSort} onClose={() => setSortOpen(false)} anchorRef={moreButtonRef} />
      )}
      {filterOpen && (
        <FilterPopover
          filter={filter}
          onFilterChange={setFilter}
          activeFilterCount={activeFilterCount}
          onClear={clearFilters}
          onClose={() => setFilterOpen(false)}
          anchorRef={moreButtonRef}
        />
      )}

      <div className="px-3 pb-3">
        <div className="flex items-center gap-2 rounded-xl border border-sidebar-border/60 bg-sidebar-accent/50 px-3 py-2">
          <SearchIcon className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          <input
            type="text"
            placeholder="Search..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
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

      <div className="flex-1 overflow-y-auto px-3">
        {(() => {
          const pinned = processedConversations.filter((c) => pinnedIds.has(c.id));
          const unpinned = processedConversations.filter((c) => !pinnedIds.has(c.id));
          const sections: Array<{ label?: string; items: ConversationSummary[] }> = [];
          if (pinned.length > 0) sections.push({ label: 'Pinned', items: pinned });
          sections.push({ items: unpinned });

          return sections.map((section, si) => (
            <div key={si}>
              {section.label && (
                <div className="flex items-center gap-2 px-1 pb-1 pt-2">
                  <PinIcon className="h-2.5 w-2.5 text-primary/60" />
                  <span className="text-[9px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/60">{section.label}</span>
                </div>
              )}
              {section.items.map((conv) => {
                const isActive = conv.id === activeConversationId || conv.id === fadingActiveId;
                const isAwaitingApproval = conv.runStatus === 'awaiting-approval';
                const isRunning = conv.runStatus === 'running' && !isAwaitingApproval;
                const hasUnread = (conv.hasUnread && !isActive) || (isAwaitingApproval && !isActive);
                const isRemoving = removingIds.has(conv.id);
                const computerStatus = getComputerStatus(conv.id);
                const isPinned = pinnedIds.has(conv.id);

                return (
                  <div
                    key={conv.id}
                    className={`overflow-hidden transition-all duration-300 ease-in-out ${
                      isRemoving ? 'max-h-0 opacity-0 mb-0' : 'max-h-24 opacity-100 mb-1.5'
                    }`}
                  >
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => handleClearUnread(conv.id)}
                    onKeyDown={(e) => e.key === 'Enter' && handleClearUnread(conv.id)}
                    onContextMenu={(e) => handleContextMenu(e, conv.id)}
                    className={`
                      flex w-full items-start gap-2.5 rounded-xl px-3 py-2.5 text-left text-sm transition-all group cursor-pointer relative
                      ${isActive ? 'shadow-[inset_0_0_0_1px_var(--app-active-item-ring)]' : 'hover:bg-sidebar-accent/65'}
                      ${hasUnread && !isActive ? 'bg-sidebar-accent/45' : ''}
                    `}
                    style={isActive ? { backgroundColor: 'var(--app-active-item)' } : undefined}
                  >
                    <MessageSquareIcon className={`mt-0.5 h-4 w-4 shrink-0 ${isActive ? 'text-primary' : hasUnread ? 'text-primary' : 'text-muted-foreground'}`} {...(isActive ? { fill: 'currentColor' } : {})} />
                    <div className="flex-1 min-w-0">
                      {renamingId === conv.id ? (
                        <input
                          autoFocus
                          className="w-full rounded bg-sidebar-accent/80 px-1 py-0.5 text-sm font-medium text-sidebar-foreground outline-none ring-1 ring-primary/50"
                          value={renameValue}
                          onChange={(e) => setRenameValue(e.target.value)}
                          onBlur={() => handleRename(conv.id, renameValue)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') { e.preventDefault(); void handleRename(conv.id, renameValue); }
                            if (e.key === 'Escape') setRenamingId(null);
                          }}
                          onClick={(e) => e.stopPropagation()}
                        />
                      ) : (
                      <span className={`line-clamp-2 text-sm ${hasUnread ? 'font-semibold text-sidebar-foreground' : 'font-medium text-sidebar-foreground/95'}`}>
                        {getDisplayTitle(conv, sessionsByConversation.get(conv.id)) || (
                          <span className="italic text-muted-foreground">New Chat</span>
                        )}
                      </span>
                      )}
                      <span className="mt-1 flex items-center text-[12px] text-muted-foreground">
                        {isRunning ? <TypingBubble /> : formatRelativeTime(conv.lastAssistantUpdateAt ?? conv.lastMessageAt)}
                        {conv.messageCount > 0 && ` · ${conv.messageCount} msgs`}
                      </span>
                    </div>
                    <div className="ml-1 flex shrink-0 self-stretch items-center gap-1">
                      {isAwaitingApproval && !isActive && <div className="h-2 w-2 rounded-full bg-amber-400 shadow-[0_0_10px_var(--color-amber-400)]" />}
                      {hasUnread && !isAwaitingApproval && <div className="h-2 w-2 rounded-full bg-primary app-unread-glow" />}
                      {computerStatus === 'running' && <ComputerActiveIndicator />}
                      {computerStatus === 'completed' && !(isActive && activeThreadMode === 'computer') && <ComputerCompletedIndicator />}
                      {isPinned && <PinIcon className="h-3 w-3 text-muted-foreground" />}
                      {conv.archived && <ArchiveIcon className="h-3 w-3 text-muted-foreground" />}
                      <button
                        type="button"
                        onClick={(e) => handleMoreClick(e, conv.id)}
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
          ));
        })()}

        {processedConversations.length === 0 && (
          <div className="flex flex-col items-center gap-2 px-4 py-10 text-center text-xs text-muted-foreground">
            <MessageSquareIcon className="h-6 w-6 opacity-40" />
            <span>{searchQuery || hasActiveFilters ? 'No chats match your search' : 'No chats yet'}</span>
          </div>
        )}
      </div>

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
              {isSearchActive || hasActiveFilters
                ? `This will permanently delete ${processedConversations.length} shown chat${processedConversations.length === 1 ? '' : 's'}. This cannot be undone.`
                : `This will permanently delete all ${processedConversations.length} chat${processedConversations.length === 1 ? '' : 's'}. This cannot be undone.`}
            </p>
            <div className="mt-5 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setBulkDeleteOpen(false)}
                disabled={isBulkDeleting}
                className="rounded-lg px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-sidebar-accent/80"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => { void confirmBulkDelete(); }}
                disabled={isBulkDeleting}
                className="flex items-center gap-1.5 rounded-lg bg-destructive px-3 py-1.5 text-xs font-medium text-destructive-foreground transition-colors hover:bg-destructive/90 disabled:opacity-50"
              >
                {isBulkDeleting ? (
                  <>
                    <LoaderIcon className="h-3 w-3 animate-spin" />
                    Deleting...
                  </>
                ) : (
                  <>
                    <Trash2Icon className="h-3 w-3" />
                    Delete
                  </>
                )}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}

      {contextMenu && createPortal(
        <div
          className="fixed z-[9999] min-w-[180px] rounded-2xl border border-border bg-popover p-1.5 shadow-2xl"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-popover-foreground hover:bg-muted/70 transition-colors"
            onClick={() => { togglePin(contextMenu.convId); setContextMenu(null); }}
          >
            <PinIcon className="h-4 w-4 text-muted-foreground" /> {pinnedIds.has(contextMenu.convId) ? 'Unpin' : 'Pin'}
          </button>
          <button
            className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-popover-foreground hover:bg-muted/70 transition-colors"
            onClick={() => {
              const conv = conversations.find((c) => c.id === contextMenu.convId);
              setRenameValue(conv?.title || conv?.fallbackTitle || '');
              setRenamingId(contextMenu.convId);
              setContextMenu(null);
            }}
          >
            <PencilIcon className="h-4 w-4 text-muted-foreground" /> Rename
          </button>
          <button
            className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-popover-foreground hover:bg-muted/70 transition-colors"
            onClick={() => { void handleArchive(contextMenu.convId); setContextMenu(null); }}
          >
            <ArchiveIcon className="h-4 w-4 text-muted-foreground" /> {conversations.find((c) => c.id === contextMenu.convId)?.archived ? 'Unarchive' : 'Archive'}
          </button>
          <button
            className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-popover-foreground hover:bg-muted/70 transition-colors"
            onClick={() => { setExportConvId(contextMenu.convId); setContextMenu(null); }}
          >
            <DownloadIcon className="h-4 w-4 text-muted-foreground" /> Export
          </button>
          <div className="my-1 h-px bg-border/60" />
          <button
            className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-destructive hover:bg-destructive/10 transition-colors"
            onClick={() => { void handleDelete(contextMenu.convId); setContextMenu(null); }}
          >
            <Trash2Icon className="h-4 w-4" /> Delete
          </button>
        </div>,
        document.body,
      )}

      <ExportDialog
        open={exportConvId !== null}
        onClose={() => setExportConvId(null)}
        conversationId={exportConvId}
      />
    </div>
  );
};
