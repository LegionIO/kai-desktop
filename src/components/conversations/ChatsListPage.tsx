import { useEffect, useMemo, useRef, useState, useCallback, type FC } from 'react';
import { createPortal } from 'react-dom';
import {
  ArchiveIcon,
  DownloadIcon,
  EllipsisVerticalIcon,
  MessageSquareIcon,
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
import { useComputerUse } from '@/providers/ComputerUseProvider';
import type { ConversationRecord } from '@/providers/RuntimeProvider';
import { ExportDialog } from './ExportDialog';

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

function formatShortDate(timestamp: string | null): string {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  const now = new Date();
  const sameYear = date.getFullYear() === now.getFullYear();
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
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    convId: string;
  } | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [exportConvId, setExportConvId] = useState<string | null>(null);
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
    await loadConversations();
  };

  const handleDelete = async (id: string) => {
    await app.conversations.delete(id);
    await loadConversations();
  };

  const handleRename = async (id: string, newTitle: string) => {
    const trimmed = newTitle.trim();
    if (!trimmed) {
      setRenamingId(null);
      return;
    }
    const conv = (await app.conversations.get(
      id,
    )) as ConversationRecord | null;
    if (!conv) {
      setRenamingId(null);
      return;
    }
    await app.conversations.put({
      ...conv,
      title: trimmed,
      titleStatus: 'manual',
    });
    setRenamingId(null);
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

    // Only active (non-archived) chats
    result = result.filter((c) => !c.archived);

    // Hide empty threads
    result = result.filter(
      (c) =>
        c.messageCount > 0 ||
        Boolean(c.title?.trim() || c.fallbackTitle?.trim()),
    );

    // Search
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      result = result.filter((c) =>
        getDisplayTitle(c).toLowerCase().includes(q),
      );
    }

    // Sort by most recently updated
    result.sort((a, b) => {
      const aAt =
        a.lastAssistantUpdateAt ?? a.lastMessageAt ?? a.updatedAt ?? a.createdAt;
      const bAt =
        b.lastAssistantUpdateAt ?? b.lastMessageAt ?? b.updatedAt ?? b.createdAt;
      return bAt.localeCompare(aAt);
    });

    return result;
  }, [conversations, workspaceId, searchQuery, sessionsByConversation]);

  return (
    <div className="flex flex-col h-full min-h-0 pt-12 md:pt-14">
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-8 py-8">
          {/* Header row */}
          <div className="mb-8 flex items-center justify-between">
            <h1 className="text-3xl font-semibold tracking-tight text-foreground">
              Chats
            </h1>
            <div className="flex items-center gap-2">
              {/* Search toggle */}
              <DropdownMenu.Root>
                <DropdownMenu.Trigger asChild>
                  <button
                    type="button"
                    className="flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
                    title="Filter"
                  >
                    <SlidersHorizontalIcon className="h-4 w-4" />
                  </button>
                </DropdownMenu.Trigger>
                <DropdownMenu.Portal>
                  <DropdownMenu.Content
                    align="end"
                    sideOffset={6}
                    className="z-[9999] min-w-[160px] rounded-xl border border-border/70 bg-popover/95 p-1 text-popover-foreground shadow-xl backdrop-blur-md"
                  >
                    <DropdownMenu.Item
                      className="flex cursor-default items-center gap-2 rounded-lg px-3 py-2 text-sm outline-none transition-colors data-[highlighted]:bg-muted/70"
                      onSelect={() => {/* future: open sort */}}
                    >
                      <ArchiveIcon className="h-3.5 w-3.5 text-muted-foreground" />
                      Show archived
                    </DropdownMenu.Item>
                  </DropdownMenu.Content>
                </DropdownMenu.Portal>
              </DropdownMenu.Root>

              {/* Search button */}
              <button
                type="button"
                className="flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
                title="Search"
                onClick={() => {
                  // Focus the search field below (scrolled into view naturally)
                  const el = document.getElementById('chats-list-search');
                  el?.focus();
                }}
              >
                <SearchIcon className="h-4 w-4" />
              </button>

              {/* New chat button */}
              <button
                type="button"
                onClick={() => void onNewConversation()}
                className="flex h-9 items-center gap-2 rounded-lg bg-foreground px-4 text-sm font-medium text-background transition-colors hover:bg-foreground/85"
              >
                New chat
              </button>
            </div>
          </div>

          {/* Search bar — shown always so the icon above can focus it */}
          {searchQuery !== null && (
            <div className="mb-4 flex items-center gap-2 rounded-xl border border-border/60 bg-muted/30 px-3 py-2">
              <SearchIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <input
                id="chats-list-search"
                type="text"
                placeholder="Search chats…"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
              />
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
          )}

          {/* Conversation rows */}
          <div className="flex flex-col">
            {hasLoaded && processed.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-24 text-center">
                <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-muted/40 text-muted-foreground">
                  <MessageSquareIcon size={26} strokeWidth={1.3} />
                </div>
                <h3 className="mb-1.5 text-sm font-medium text-foreground/80">
                  {searchQuery ? 'No chats match your search' : 'No chats yet'}
                </h3>
                {!searchQuery && (
                  <p className="mb-5 max-w-xs text-xs text-muted-foreground leading-relaxed">
                    Start a conversation with Kai. Your chat history will appear
                    here.
                  </p>
                )}
                {!searchQuery && (
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
                const displayTitle =
                  getDisplayTitle(conv) || 'New Chat';
                const dateStr = formatShortDate(
                  conv.lastAssistantUpdateAt ??
                    conv.lastMessageAt ??
                    conv.updatedAt,
                );
                const isPinned = pinnedIds.has(conv.id);

                return (
                  <div
                    key={conv.id}
                    role="button"
                    tabIndex={0}
                    className={cn(
                      'group flex w-full items-center gap-3 rounded-xl px-3 py-3.5 text-left transition-colors cursor-pointer',
                      isHovered ? 'bg-muted/60' : 'hover:bg-muted/60',
                    )}
                    onMouseEnter={() => setHoveredId(conv.id)}
                    onMouseLeave={() => setHoveredId(null)}
                    onClick={() => onOpenConversation(conv.id)}
                    onKeyDown={(e) =>
                      e.key === 'Enter' && onOpenConversation(conv.id)
                    }
                  >
                    {/* Checkbox (visible on hover) */}
                    <div
                      className={cn(
                        'h-4 w-4 shrink-0 rounded border border-border/60 bg-background transition-opacity',
                        isHovered ? 'opacity-100' : 'opacity-0',
                      )}
                      onClick={(e) => e.stopPropagation()}
                    />

                    {/* Chat icon */}
                    <MessageSquareIcon className="h-4 w-4 shrink-0 text-muted-foreground" />

                    {/* Title */}
                    <div className="flex-1 min-w-0">
                      {renamingId === conv.id ? (
                        <input
                          autoFocus
                          className="w-full rounded bg-muted/80 px-1 py-0.5 text-sm font-medium text-foreground outline-none ring-1 ring-primary/50"
                          value={renameValue}
                          onChange={(e) => setRenameValue(e.target.value)}
                          onBlur={() =>
                            void handleRename(conv.id, renameValue)
                          }
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault();
                              void handleRename(conv.id, renameValue);
                            }
                            if (e.key === 'Escape') setRenamingId(null);
                          }}
                          onClick={(e) => e.stopPropagation()}
                        />
                      ) : (
                        <span className="truncate text-sm font-medium text-foreground">
                          {displayTitle}
                          {isPinned && (
                            <PinIcon className="ml-1.5 inline h-3 w-3 text-muted-foreground" />
                          )}
                        </span>
                      )}
                    </div>

                    {/* Date + ellipsis */}
                    <div className="flex shrink-0 items-center gap-2">
                      <span
                        className={cn(
                          'text-sm text-muted-foreground transition-opacity',
                          isHovered ? 'opacity-0' : 'opacity-100',
                        )}
                      >
                        {dateStr}
                      </span>
                      <button
                        type="button"
                        onClick={(e) => handleMoreClick(e, conv.id)}
                        className={cn(
                          'absolute right-4 flex h-7 w-7 items-center justify-center rounded-lg transition-all',
                          'text-muted-foreground hover:bg-muted/80 hover:text-foreground',
                          isHovered ? 'opacity-100' : 'opacity-0',
                        )}
                        title="More options"
                        aria-label="More options"
                      >
                        <EllipsisVerticalIcon className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      </div>

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
                togglePin(contextMenu.convId);
                setContextMenu(null);
              }}
            >
              <PinIcon className="h-4 w-4 text-muted-foreground" />
              {pinnedIds.has(contextMenu.convId) ? 'Unpin' : 'Pin'}
            </button>
            <button
              className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-popover-foreground hover:bg-muted/70 transition-colors"
              onClick={() => {
                const conv = conversations.find(
                  (c) => c.id === contextMenu.convId,
                );
                setRenameValue(conv?.title || conv?.fallbackTitle || '');
                setRenamingId(contextMenu.convId);
                setContextMenu(null);
              }}
            >
              <PencilIcon className="h-4 w-4 text-muted-foreground" />
              Rename
            </button>
            <button
              className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-popover-foreground hover:bg-muted/70 transition-colors"
              onClick={() => {
                void handleArchive(contextMenu.convId);
                setContextMenu(null);
              }}
            >
              <ArchiveIcon className="h-4 w-4 text-muted-foreground" />
              Archive
            </button>
            <button
              className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-popover-foreground hover:bg-muted/70 transition-colors"
              onClick={() => {
                setExportConvId(contextMenu.convId);
                setContextMenu(null);
              }}
            >
              <DownloadIcon className="h-4 w-4 text-muted-foreground" />
              Export
            </button>
            <div className="my-1 h-px bg-border/60" />
            <button
              className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-destructive hover:bg-destructive/10 transition-colors"
              onClick={() => {
                void handleDelete(contextMenu.convId);
                setContextMenu(null);
              }}
            >
              <Trash2Icon className="h-4 w-4" />
              Delete
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
