import { useState, useEffect, useRef, type FC } from 'react';
import { GitBranchIcon, ChevronDownIcon, SearchIcon, PlusIcon, CheckIcon, LoaderIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { GitBranch } from '../../../shared/workspace-types';

interface BranchSwitcherProps {
  currentBranch: string;
  branches: GitBranch[];
  defaultBranch: string;
  onCheckout: (branchName: string) => Promise<{ success: boolean; error?: string }>;
  onCreateBranch: (branchName: string) => Promise<{ success: boolean; error?: string }>;
}

export const BranchSwitcher: FC<BranchSwitcherProps> = ({
  currentBranch,
  branches,
  defaultBranch,
  onCheckout,
  onCreateBranch,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [newBranchName, setNewBranchName] = useState('');
  const [error, setError] = useState('');
  const [switching, setSwitching] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);

  // Close on outside click
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setIsOpen(false);
        setIsCreating(false);
        setFilter('');
        setError('');
      }
    };
    if (isOpen) document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [isOpen]);

  // Focus filter input when opened
  useEffect(() => {
    if (isOpen && filterRef.current) filterRef.current.focus();
  }, [isOpen]);

  const filtered = branches.filter((b) =>
    b.name.toLowerCase().includes(filter.toLowerCase()),
  );
  const defaultBranches = filtered.filter((b) => b.isDefault);
  const otherBranches = filtered.filter((b) => !b.isDefault);

  const handleCheckout = async (branchName: string) => {
    if (branchName === currentBranch) {
      setIsOpen(false);
      return;
    }
    setSwitching(true);
    setError('');
    const result = await onCheckout(branchName);
    setSwitching(false);
    if (result.success) {
      setIsOpen(false);
      setFilter('');
    } else {
      setError(result.error ?? 'Failed to switch branch');
    }
  };

  const handleCreate = async () => {
    if (!newBranchName.trim()) return;
    setSwitching(true);
    setError('');
    const result = await onCreateBranch(newBranchName.trim());
    setSwitching(false);
    if (result.success) {
      setIsOpen(false);
      setIsCreating(false);
      setNewBranchName('');
      setFilter('');
    } else {
      setError(result.error ?? 'Failed to create branch');
    }
  };

  const renderBranchItem = (branch: GitBranch) => (
    <button
      key={branch.name}
      type="button"
      onClick={() => handleCheckout(branch.name)}
      disabled={switching}
      className={cn(
        'flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs transition-colors',
        branch.isCurrent
          ? 'bg-primary/10 text-primary'
          : 'text-muted-foreground hover:bg-muted/30 hover:text-foreground',
      )}
    >
      {branch.isCurrent ? (
        <CheckIcon className="h-3.5 w-3.5 shrink-0 text-primary" />
      ) : (
        <GitBranchIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground/50" />
      )}
      <span className="flex-1 truncate font-medium">{branch.name}</span>
      <span className="shrink-0 text-[10px] text-muted-foreground/50">{branch.lastActivity}</span>
    </button>
  );

  return (
    <div className="relative" ref={dropdownRef}>
      {/* Trigger */}
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-2 rounded-lg border border-border/50 bg-muted/10 px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted/30"
      >
        <GitBranchIcon className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="max-w-[160px] truncate">{currentBranch || 'No branch'}</span>
        <ChevronDownIcon className={cn('h-3 w-3 text-muted-foreground transition-transform', isOpen && 'rotate-180')} />
      </button>

      {/* Dropdown */}
      {isOpen && (
        <div className="absolute left-0 top-full z-50 mt-1 w-72 rounded-lg border border-border/60 bg-background shadow-lg">
          {/* Header tabs */}
          <div className="flex items-center border-b border-border/40 px-1 py-1">
            <span className="flex-1 px-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60">Branches</span>
          </div>

          {/* Filter + New Branch */}
          <div className="flex items-center gap-1 border-b border-border/40 p-2">
            <div className="relative flex-1">
              <SearchIcon className="absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground/40" />
              <input
                ref={filterRef}
                type="text"
                placeholder="Filter"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                className="h-7 w-full rounded-md border border-border/40 bg-muted/10 pl-7 pr-2 text-xs text-foreground placeholder:text-muted-foreground/40 focus:border-primary/50 focus:outline-none"
              />
            </div>
            <button
              type="button"
              onClick={() => {
                setIsCreating(!isCreating);
                setNewBranchName(filter);
              }}
              className="flex h-7 items-center gap-1 rounded-md border border-border/40 bg-muted/10 px-2 text-[10px] font-medium text-muted-foreground transition-colors hover:bg-muted/30 hover:text-foreground"
            >
              <PlusIcon className="h-3 w-3" />
              New Branch
            </button>
          </div>

          {/* New branch input */}
          {isCreating && (
            <div className="border-b border-border/40 p-2">
              <div className="flex items-center gap-1">
                <input
                  type="text"
                  placeholder="Branch name"
                  value={newBranchName}
                  onChange={(e) => setNewBranchName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') handleCreate(); if (e.key === 'Escape') setIsCreating(false); }}
                  autoFocus
                  className="h-7 flex-1 rounded-md border border-border/40 bg-muted/10 px-2 text-xs text-foreground placeholder:text-muted-foreground/40 focus:border-primary/50 focus:outline-none"
                />
                <button
                  type="button"
                  onClick={handleCreate}
                  disabled={!newBranchName.trim() || switching}
                  className="flex h-7 items-center rounded-md bg-primary px-3 text-[10px] font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
                >
                  {switching ? <LoaderIcon className="h-3 w-3 animate-spin" /> : 'Create'}
                </button>
              </div>
            </div>
          )}

          {/* Error */}
          {error && (
            <div className="border-b border-border/40 px-3 py-1.5 text-[10px] text-red-400">
              {error}
            </div>
          )}

          {/* Branch list */}
          <div className="max-h-64 overflow-y-auto p-1">
            {switching && (
              <div className="flex items-center justify-center py-3">
                <LoaderIcon className="h-4 w-4 animate-spin text-muted-foreground/40" />
              </div>
            )}

            {!switching && defaultBranches.length > 0 && (
              <>
                <div className="px-2.5 py-1 text-[9px] font-semibold uppercase tracking-wider text-muted-foreground/50">Default Branch</div>
                {defaultBranches.map(renderBranchItem)}
              </>
            )}

            {!switching && otherBranches.length > 0 && (
              <>
                <div className="mt-1 px-2.5 py-1 text-[9px] font-semibold uppercase tracking-wider text-muted-foreground/50">Other Branches</div>
                {otherBranches.map(renderBranchItem)}
              </>
            )}

            {!switching && filtered.length === 0 && (
              <div className="py-3 text-center text-[10px] text-muted-foreground/50">
                No branches match &ldquo;{filter}&rdquo;
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
