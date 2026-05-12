/**
 * AgentListPanel — main sidebar panel for the Agents tab.
 *
 * Shows a searchable list of agents with context menu (right-click + triple-dots)
 * for rename and delete. "New Agent" button triggers creation view.
 * Matches the layout patterns of ConversationList and TaskSidebarList.
 */

import { type FC, type MouseEvent, useState, useMemo, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import {
  PlusIcon,
  BotIcon,
  SearchIcon,
  XIcon,
  PencilIcon,
  Trash2Icon,
} from 'lucide-react';
import { useAgents } from '@/providers/AgentProvider';
import { cn } from '@/lib/utils';
import { AgentCard } from './AgentCard';
import { AgentRenameModal } from './AgentRenameModal';
import { DeleteAgentModal } from './DeleteAgentModal';

export const AgentListPanel: FC<{ onNavigateToAgentsPage?: () => void }> = ({ onNavigateToAgentsPage }) => {
  const { state, selectAgent, deleteAgent, updateAgent, setCreatingAgent } = useAgents();
  const { agents, selectedAgentId, isLoading, isCreatingAgent } = state;

  const [searchQuery, setSearchQuery] = useState('');
  const [contextMenu, setContextMenu] = useState<{ agentId: string; x: number; y: number } | null>(null);
  const [renameModal, setRenameModal] = useState<{ id: string; value: string } | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  // Close context menu on click-outside
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!contextMenu) return;
    const handler = (e: PointerEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setContextMenu(null);
      }
    };
    window.addEventListener('pointerdown', handler);
    return () => window.removeEventListener('pointerdown', handler);
  }, [contextMenu]);

  // Filter agents by search
  const filteredAgents = useMemo(() => {
    const query = searchQuery.toLowerCase().trim();
    if (!query) return agents;
    return agents.filter(
      (a) =>
        a.name.toLowerCase().includes(query) ||
        a.role.toLowerCase().includes(query) ||
        a.runtime.toLowerCase().includes(query) ||
        (a.description?.toLowerCase().includes(query) ?? false) ||
        (a.instructions?.toLowerCase().includes(query) ?? false),
    );
  }, [agents, searchQuery]);

  // Context menu handlers
  const handleContextMenu = (e: MouseEvent, agentId: string) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ agentId, x: e.clientX, y: e.clientY });
  };

  const handleMoreClick = (e: MouseEvent, agentId: string) => {
    e.stopPropagation();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setContextMenu({ agentId, x: rect.left, y: rect.bottom + 4 });
  };

  const handleRename = async (id: string, newName: string) => {
    await updateAgent(id, { name: newName });
    setRenameModal(null);
  };

  const handleDelete = async (id: string) => {
    await deleteAgent(id);
    setContextMenu(null);
  };

  const handleNewAgent = () => {
    setCreatingAgent(true);
    selectAgent(null);
    onNavigateToAgentsPage?.();
  };

  return (
    <div className="flex h-full flex-col">
      {/* Header row */}
      <div className="flex items-center gap-1.5 px-3 pb-2 pt-3">
        <button
          type="button"
          onClick={() => { selectAgent(null); onNavigateToAgentsPage?.(); }}
          className="rounded-md px-1.5 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground transition-colors hover:bg-[var(--brand-accent)]/15 hover:text-[var(--brand-accent)]"
        >
          Agents
        </button>
        <div className="flex-1" />
        <button
          type="button"
          onClick={handleNewAgent}
          className={cn(
            'flex items-center gap-1 rounded-lg border border-sidebar-border/60 px-2.5 py-1 text-xs font-medium text-sidebar-foreground transition-colors hover:bg-sidebar-accent/60',
            isCreatingAgent && 'border-primary/40 bg-primary/10 text-primary',
          )}
        >
          <PlusIcon size={12} />
          New Agent
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

      {/* Agent list */}
      <div className="flex-1 overflow-y-auto px-3">
        {isLoading ? (
          <div className="flex items-center justify-center py-12 text-xs text-muted-foreground">
            Loading agents...
          </div>
        ) : filteredAgents.length === 0 ? (
          searchQuery ? (
            <div className="flex flex-col items-center gap-2 px-4 py-10 text-center text-xs text-muted-foreground">
              <BotIcon className="h-6 w-6 opacity-40" />
              <span>No agents match your search</span>
            </div>
          ) : (
            <EmptyState onCreate={handleNewAgent} />
          )
        ) : (
          <div>
            {filteredAgents.map((agent) => (
              <div key={agent.id} className="mb-1.5">
                <AgentCard
                  agent={agent}
                  isSelected={selectedAgentId === agent.id}
                  onClick={() => { setCreatingAgent(false); selectAgent(agent.id); }}
                  onContextMenu={(e) => handleContextMenu(e, agent.id)}
                  onMoreClick={(e) => handleMoreClick(e, agent.id)}
                />
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Context Menu (portal) */}
      {contextMenu && createPortal(
        <div
          ref={menuRef}
          className="fixed z-[9999] min-w-[180px] rounded-2xl border border-border bg-popover p-1.5 shadow-2xl"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-popover-foreground hover:bg-muted/70 transition-colors"
            onClick={() => {
              const agent = agents.find((a) => a.id === contextMenu.agentId);
              setRenameModal({ id: contextMenu.agentId, value: agent?.name ?? '' });
              setContextMenu(null);
            }}
          >
            <PencilIcon className="h-4 w-4 text-muted-foreground" /> Rename
          </button>
          <div className="my-1 h-px bg-border/60" />
          <button
            className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-destructive hover:bg-destructive/10 transition-colors"
            onClick={() => { setConfirmDeleteId(contextMenu.agentId); setContextMenu(null); }}
          >
            <Trash2Icon className="h-4 w-4" /> Delete
          </button>
        </div>,
        document.body,
      )}

      {/* Rename modal */}
      {renameModal && (
        <AgentRenameModal
          initialValue={renameModal.value}
          onSave={(name) => void handleRename(renameModal.id, name)}
          onClose={() => setRenameModal(null)}
        />
      )}

      {/* Delete confirmation modal */}
      {confirmDeleteId && (() => {
        const agentToDelete = agents.find((a) => a.id === confirmDeleteId);
        return (
          <DeleteAgentModal
            agentName={agentToDelete?.name ?? 'this agent'}
            onConfirm={() => void handleDelete(confirmDeleteId)}
            onClose={() => setConfirmDeleteId(null)}
          />
        );
      })()}
    </div>
  );
};

// ── Empty State ──────────────────────────────────────────────────────────

const EmptyState: FC<{ onCreate: () => void }> = ({ onCreate }) => (
  <div className="flex flex-col items-center justify-center py-12 px-4 text-center">
    <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-muted/40 text-muted-foreground">
      <BotIcon size={24} strokeWidth={1.3} />
    </div>
    <h3 className="mb-1 text-sm font-medium text-foreground/80">No agents yet</h3>
    <p className="mb-4 text-xs text-muted-foreground leading-relaxed">
      Create agents to help with your tasks. Each agent has dedicated instructions and a runtime.
    </p>
    <button
      type="button"
      onClick={onCreate}
      className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
    >
      <PlusIcon size={13} />
      Create Your First Agent
    </button>
  </div>
);
