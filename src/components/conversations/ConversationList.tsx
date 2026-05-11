import { useEffect, useMemo, useRef, useState, useCallback, type FC } from 'react';
import { createPortal } from 'react-dom';
import { Trash2Icon, ArchiveIcon, MessageSquareIcon, MonitorIcon, PinIcon, PencilIcon, DownloadIcon, EllipsisVerticalIcon, SquarePenIcon, PlusIcon, SearchIcon, XIcon } from 'lucide-react';
import { app } from '@/lib/ipc-client';
import { cn } from '@/lib/utils';
import { useComputerUse } from '@/providers/ComputerUseProvider';
import type { ConversationRecord } from '@/providers/RuntimeProvider';
import type { ComputerSession } from '../../../shared/computer-use';
import { ExportDialog } from './ExportDialog';
import { RenameChatModal } from './RenameChatModal';

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
  onNavigateToChatsPage?: () => void;
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
  onNavigateToChatsPage,
  workspaceId,
}) => {
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [, setDeletingId] = useState<string | null>(null);
  const [removingIds, setRemovingIds] = useState<Set<string>>(new Set());
  const removingIdsRef = useRef<Set<string>>(new Set());
  const [pinnedIds, setPinnedIds] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem(__BRAND_APP_SLUG + ':pinned-conversations') || '[]')); } catch { return new Set(); }
  });
  const { sessionsByConversation } = useComputerUse();
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; convId: string } | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [renameModal, setRenameModal] = useState<{ id: string; value: string } | null>(null);
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

  const processedConversations = useMemo(() => {
    let result = [...conversations];

    // Workspace scoping — show only conversations belonging to the active workspace
    // (or legacy/unscoped conversations that have no workspaceId)
    if (workspaceId) {
      result = result.filter((conv) => conv.workspaceId === workspaceId || !conv.workspaceId);
    }

    result = result.filter((conv) => !conv.archived);

    // Hide empty threads (no messages, no title)
    result = result.filter((conv) => conv.messageCount > 0 || Boolean(conv.title?.trim() || conv.fallbackTitle?.trim()));

    // Text search
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      result = result.filter((c) =>
        getDisplayTitle(c, sessionsByConversation.get(c.id)).toLowerCase().includes(q),
      );
    }

    // Default sort: newest-first by last assistant update
    result.sort((a, b) => {
      const aAt = a.lastAssistantUpdateAt ?? a.lastMessageAt ?? a.updatedAt ?? a.createdAt;
      const bAt = b.lastAssistantUpdateAt ?? b.lastMessageAt ?? b.updatedAt ?? b.createdAt;
      return bAt.localeCompare(aAt);
    });

    return result;
  }, [conversations, searchQuery, sessionsByConversation, workspaceId]);

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
    if (!trimmed) { setRenameModal(null); return; }
    const conv = await app.conversations.get(id) as ConversationRecord | null;
    if (!conv) { setRenameModal(null); return; }
    await app.conversations.put({ ...conv, title: trimmed, titleStatus: 'manual' });
    setRenameModal(null);
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

  const isNewChat = hasLoaded && !!activeConversationId && !processedConversations.some((c) => c.id === activeConversationId);

  return (
    <div className="flex flex-col h-full">
      {/* CHATS heading row — label + New Chat pill */}
      <div className="flex items-center gap-1.5 px-3 pb-2 pt-3">
        <button
          type="button"
          onClick={() => onNavigateToChatsPage?.()}
          className="rounded-md px-1.5 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground transition-colors hover:bg-[var(--brand-accent)]/15 hover:text-[var(--brand-accent)]"
        >
          Chats
        </button>
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
      <div className="px-3 pb-2">
        <div className="flex items-center gap-2 rounded-xl border border-sidebar-border/60 bg-sidebar-accent/50 px-3 py-2">
          <SearchIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
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
              className="shrink-0 rounded p-0.5 transition-colors hover:bg-sidebar-accent"
            >
              <XIcon className="h-3 w-3 text-muted-foreground" />
            </button>
          )}
        </div>
      </div>
      <div className="flex-1 overflow-y-auto px-3 pt-1">
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
                      <span className={`line-clamp-2 text-sm ${hasUnread ? 'font-semibold text-sidebar-foreground' : 'font-medium text-sidebar-foreground/95'}`}>
                        {getDisplayTitle(conv, sessionsByConversation.get(conv.id)) || (
                          <span className="italic text-muted-foreground">New Chat</span>
                        )}
                      </span>
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

        {hasLoaded && processedConversations.length === 0 && (
          <div className="flex flex-col items-center justify-center py-12 px-4 text-center">
            <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-muted/40 text-muted-foreground">
              <MessageSquareIcon size={24} strokeWidth={1.3} />
            </div>
            <h3 className="mb-1 text-sm font-medium text-foreground/80">
              No chats yet
            </h3>
            <p className="mb-4 text-xs text-muted-foreground leading-relaxed">
              Start a conversation with Kai. Your chat history will appear here for easy access.
            </p>
            <button
              type="button"
              onClick={() => { void onNewConversation(); }}
              className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
            >
              <PlusIcon size={13} />
              Start Your First Chat
            </button>
          </div>
        )}
      </div>

      {/* Rename modal */}
      {renameModal && (
        <RenameChatModal
          initialValue={renameModal.value}
          onSave={(title) => void handleRename(renameModal.id, title)}
          onClose={() => setRenameModal(null)}
        />
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
              setRenameModal({ id: contextMenu.convId, value: conv?.title || conv?.fallbackTitle || '' });
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
