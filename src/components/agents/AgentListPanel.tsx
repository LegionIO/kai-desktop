/**
 * AgentListPanel — main sidebar panel for the Agents tab.
 *
 * Shows a searchable list of agents with options (delete all) and a
 * "New Agent" button. Matches the layout patterns of TaskSidebarList.
 */

import { type FC, useState, useMemo, useCallback } from 'react';
import { createPortal } from 'react-dom';
import {
  PlusIcon,
  BotIcon,
  SearchIcon,
  XIcon,
  ListFilterIcon,
  Trash2Icon,
} from 'lucide-react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { useAgents } from '@/providers/AgentProvider';
import { AgentCard } from './AgentCard';
import { AgentDetailSheet } from './AgentDetailSheet';
import { HireAgentDialog } from './HireAgentDialog';

export const AgentListPanel: FC = () => {
  const { state, selectAgent, fireAgent } = useAgents();
  const { agents, selectedAgentId, isLoading } = state;

  const [hireDialogOpen, setHireDialogOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [isBulkDeleting, setIsBulkDeleting] = useState(false);

  const selectedAgent = selectedAgentId
    ? agents.find((a) => a.id === selectedAgentId) ?? null
    : null;

  // Filter agents by search
  const filteredAgents = useMemo(() => {
    const query = searchQuery.toLowerCase().trim();
    if (!query) return agents;
    return agents.filter(
      (a) =>
        a.name.toLowerCase().includes(query) ||
        a.role.toLowerCase().includes(query) ||
        a.runtime.toLowerCase().includes(query) ||
        (a.description?.toLowerCase().includes(query) ?? false),
    );
  }, [agents, searchQuery]);

  const isSearchActive = searchQuery.trim().length > 0;

  const confirmBulkDelete = useCallback(async () => {
    setIsBulkDeleting(true);
    for (const agent of filteredAgents) {
      // Only delete agents that are not currently running
      if (agent.status !== 'running') {
        await fireAgent(agent.id);
      }
    }
    setIsBulkDeleting(false);
    setBulkDeleteOpen(false);
  }, [filteredAgents, fireAgent]);

  // If an agent is selected, show its detail sheet
  if (selectedAgent) {
    return (
      <AgentDetailSheet
        agent={selectedAgent}
        onClose={() => selectAgent(null)}
      />
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* Header row — label + options dropdown + New Agent button */}
      <div className="flex items-center gap-1.5 px-3 pb-2 pt-3">
        <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
          Agents
        </span>
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button
              type="button"
              className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-sidebar-accent/80 hover:text-sidebar-foreground"
            >
              <ListFilterIcon className="h-3.5 w-3.5" />
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
                className="flex cursor-default items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm text-destructive outline-none transition-colors data-[highlighted]:bg-destructive/10"
                disabled={filteredAgents.length === 0}
                onSelect={() => setBulkDeleteOpen(true)}
              >
                <Trash2Icon size={14} />
                {isSearchActive
                  ? `Delete ${filteredAgents.length} shown`
                  : 'Delete all'}
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
        <div className="flex-1" />
        <button
          type="button"
          onClick={() => setHireDialogOpen(true)}
          className="flex items-center gap-1 rounded-lg border border-sidebar-border/60 px-2.5 py-1 text-xs font-medium text-sidebar-foreground transition-colors hover:bg-sidebar-accent/60"
        >
          <BotIcon size={12} />
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
      <div className="flex-1 overflow-y-auto px-1.5">
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
            <EmptyState onHire={() => setHireDialogOpen(true)} />
          )
        ) : (
          <div className="space-y-0.5">
            {filteredAgents.map((agent) => (
              <AgentCard
                key={agent.id}
                agent={agent}
                isSelected={selectedAgentId === agent.id}
                onClick={() => selectAgent(agent.id)}
              />
            ))}
          </div>
        )}
      </div>

      {/* Hire Dialog */}
      <HireAgentDialog
        open={hireDialogOpen}
        onOpenChange={setHireDialogOpen}
      />

      {/* Bulk delete confirmation modal */}
      {bulkDeleteOpen && createPortal(
        <div className="fixed inset-0 z-50 flex items-center justify-center" onClick={() => setBulkDeleteOpen(false)}>
          <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
          <div
            className="relative w-full max-w-sm rounded-xl border border-border/50 bg-popover/95 p-6 shadow-2xl backdrop-blur-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-sm font-semibold text-foreground">Delete agents</h2>
            <p className="mt-2 text-xs text-muted-foreground">
              {isSearchActive
                ? `This will permanently delete ${filteredAgents.filter((a) => a.status !== 'running').length} agent${filteredAgents.filter((a) => a.status !== 'running').length === 1 ? '' : 's'}. Running agents will be skipped.`
                : `This will permanently delete all ${filteredAgents.filter((a) => a.status !== 'running').length} agent${filteredAgents.filter((a) => a.status !== 'running').length === 1 ? '' : 's'}. Running agents will be skipped.`}
            </p>
            <div className="mt-5 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setBulkDeleteOpen(false)}
                disabled={isBulkDeleting}
                className="rounded-lg px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/50 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void confirmBulkDelete()}
                disabled={isBulkDeleting}
                className="rounded-lg bg-destructive px-3 py-1.5 text-xs font-medium text-destructive-foreground transition-colors hover:bg-destructive/90 disabled:opacity-50"
              >
                {isBulkDeleting ? 'Deleting...' : 'Delete'}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
};

// ── Empty State ──────────────────────────────────────────────────────────

const EmptyState: FC<{ onHire: () => void }> = ({ onHire }) => (
  <div className="flex flex-col items-center justify-center py-12 px-4 text-center">
    <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-muted/40 text-muted-foreground">
      <BotIcon size={24} strokeWidth={1.3} />
    </div>
    <h3 className="mb-1 text-sm font-medium text-foreground/80">No agents yet</h3>
    <p className="mb-4 text-xs text-muted-foreground leading-relaxed">
      Hire agents to work on your tasks. Each agent has a dedicated runtime and can be
      assigned tasks from the board.
    </p>
    <button
      type="button"
      onClick={onHire}
      className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
    >
      <PlusIcon size={13} />
      Hire Your First Agent
    </button>
  </div>
);
