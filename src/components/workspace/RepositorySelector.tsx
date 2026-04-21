import {
  useState,
  useEffect,
  useCallback,
  useRef,
  useMemo,
  type FC,
} from 'react';
import {
  ChevronDownIcon,
  SearchIcon,
  PlusIcon,
  GitBranchIcon,
  FolderOpenIcon,
  CopyIcon,
  CodeIcon,
  Trash2Icon,
  LoaderIcon,
  XIcon,
  AlertTriangleIcon,
  DownloadCloudIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { app } from '@/lib/ipc-client';
import { useWorkspace } from '@/providers/WorkspaceProvider';

/* ── Types ─────────────────────────────────────────────────── */

interface RecentProject {
  path: string;
  name: string;
  lastOpened: number;
}

interface ContextMenuState {
  visible: boolean;
  x: number;
  y: number;
  project: RecentProject | null;
}

/* ── Helpers ───────────────────────────────────────────────── */

/** Extract a grouping key from a project path. */
function extractGroup(path: string): string {
  // Look for patterns like /Users/.../SomeOrg/repo or /home/.../github.com/org/repo
  const segments = path.split('/').filter(Boolean);
  if (segments.length >= 2) {
    // The parent of the repo folder is often the org/owner
    return segments[segments.length - 2];
  }
  return 'Other';
}

/** Derive the base name from a path. */
function baseName(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path;
}

/* ── Context Menu ──────────────────────────────────────────── */

const RepoContextMenu: FC<{
  state: ContextMenuState;
  onClose: () => void;
  onRemoveRequest: (project: RecentProject) => void;
}> = ({ state, onClose, onRemoveRequest }) => {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!state.visible) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [state.visible, onClose]);

  if (!state.visible || !state.project) return null;

  const { project } = state;

  const items: Array<
    | { label: string; Icon: typeof CopyIcon; onClick: () => void; className?: string; separator?: false }
    | { separator: true }
  > = [
    {
      label: 'Copy Repo Name',
      Icon: CopyIcon,
      onClick: () => {
        app.clipboard.writeText(project.name);
        onClose();
      },
    },
    {
      label: 'Copy Repo Path',
      Icon: CopyIcon,
      onClick: () => {
        app.clipboard.writeText(project.path);
        onClose();
      },
    },
    { separator: true },
    {
      label: 'Reveal in Finder',
      Icon: FolderOpenIcon,
      onClick: () => {
        app.git.showInFinder(project.path);
        onClose();
      },
    },
    {
      label: 'Open in Visual Studio Code',
      Icon: CodeIcon,
      onClick: () => {
        app.git.openInEditor(project.path);
        onClose();
      },
    },
    { separator: true },
    {
      label: 'Remove...',
      Icon: Trash2Icon,
      onClick: () => {
        onClose();
        onRemoveRequest(project);
      },
      className: 'text-red-400 hover:text-red-300',
    },
  ];

  return (
    <div
      ref={menuRef}
      className="fixed z-[60] min-w-52 rounded-lg border border-border/60 bg-popover py-1 shadow-xl animate-in fade-in-0 zoom-in-95"
      style={{ top: state.y, left: state.x }}
    >
      {items.map((item, idx) =>
        'separator' in item && item.separator ? (
          <div key={idx} className="my-1 border-t border-border/30" />
        ) : (
          <button
            key={idx}
            type="button"
            onClick={(item as Exclude<typeof item, { separator: true }>).onClick}
            className={cn(
              'flex w-full items-center gap-2 px-3 py-1.5 text-left text-[11px] text-muted-foreground transition-colors hover:bg-muted/30 hover:text-foreground',
              (item as Exclude<typeof item, { separator: true }>).className,
            )}
          >
            {(() => {
              const { Icon } = item as Exclude<typeof item, { separator: true }>;
              return <Icon className="h-3.5 w-3.5 shrink-0" />;
            })()}
            {(item as Exclude<typeof item, { separator: true }>).label}
          </button>
        ),
      )}
    </div>
  );
};

/* ── Remove Confirmation Dialog ────────────────────────────── */

const RemoveDialog: FC<{
  project: RecentProject | null;
  onCancel: () => void;
  onConfirm: () => void;
}> = ({ project, onCancel, onConfirm }) => {
  useEffect(() => {
    if (!project) return;
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [project, onCancel]);

  if (!project) return null;

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 animate-in fade-in-0">
      <div className="w-full max-w-md rounded-xl border border-border/60 bg-popover p-6 shadow-2xl animate-in zoom-in-95">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 rounded-full bg-red-500/10 p-2">
            <AlertTriangleIcon className="h-5 w-5 text-red-400" />
          </div>
          <div className="flex-1">
            <h3 className="text-sm font-semibold text-foreground">Remove Repository</h3>
            <p className="mt-2 text-xs text-muted-foreground">
              Are you sure you want to remove this repository from your recent list?
            </p>
            <p className="mt-1.5 rounded-md bg-muted/20 px-2.5 py-1.5 font-mono text-xs text-foreground">
              {project.name}
            </p>
            <p className="mt-2 text-[10px] text-muted-foreground/60">
              The repository will not be deleted from disk. It will only be removed from the recent list.
            </p>
          </div>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md border border-border/50 px-3.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/20 hover:text-foreground"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="flex items-center gap-1.5 rounded-md bg-red-600 px-3.5 py-1.5 text-xs font-medium text-white transition-colors hover:bg-red-500"
          >
            <Trash2Icon className="h-3 w-3" />
            Remove
          </button>
        </div>
      </div>
    </div>
  );
};

/* ── Clone Repository Dialog ───────────────────────────────── */

const CloneDialog: FC<{
  open: boolean;
  onClose: () => void;
  onCloned: (path: string, name: string) => void;
}> = ({ open, onClose, onCloned }) => {
  const [url, setUrl] = useState('');
  const [localPath, setLocalPath] = useState('');
  const [cloning, setCloning] = useState(false);
  const [error, setError] = useState('');

  // Set a sensible default path on mount
  useEffect(() => {
    if (open && !localPath) {
      app.platform.homedir().then((home) => {
        setLocalPath(`${home}/Projects`);
      }).catch(() => {});
    }
  }, [open, localPath]);

  // Reset state when dialog opens
  useEffect(() => {
    if (open) {
      setUrl('');
      setError('');
      setCloning(false);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !cloning) onClose();
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [open, cloning, onClose]);

  const handleChoosePath = useCallback(async () => {
    const result = await app.dialog.openDirectory();
    if (!result.canceled && result.directoryPath) {
      setLocalPath(result.directoryPath);
    }
  }, []);

  const handleClone = useCallback(async () => {
    if (!url.trim() || !localPath.trim()) return;
    setCloning(true);
    setError('');

    try {
      const result = await app.projects.clone(url.trim(), localPath.trim());
      if (result.success && result.path) {
        onCloned(result.path, result.name ?? baseName(result.path));
      } else {
        setError(result.error ?? 'Clone failed');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Clone failed');
    } finally {
      setCloning(false);
    }
  }, [url, localPath, onCloned]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 animate-in fade-in-0">
      <div className="w-full max-w-lg rounded-xl border border-border/60 bg-popover shadow-2xl animate-in zoom-in-95">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border/40 px-5 py-4">
          <h2 className="text-sm font-semibold text-foreground">Clone a Repository</h2>
          <button
            type="button"
            onClick={onClose}
            disabled={cloning}
            className="rounded-md p-1 text-muted-foreground/50 transition-colors hover:bg-muted/20 hover:text-foreground disabled:opacity-50"
          >
            <XIcon className="h-4 w-4" />
          </button>
        </div>

        {/* Tab bar (URL is the only tab for now, styled to allow future expansion) */}
        <div className="border-b border-border/40 px-5">
          <div className="flex">
            <button
              type="button"
              className="border-b-2 border-primary px-3 py-2 text-xs font-medium text-foreground"
            >
              URL
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="space-y-4 p-5">
          {/* URL input */}
          <div>
            <label className="mb-1.5 block text-[11px] font-medium text-muted-foreground">
              Repository URL or GitHub username and repository
            </label>
            <input
              type="text"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="URL or username/repository"
              disabled={cloning}
              className="h-9 w-full rounded-md border border-border/40 bg-muted/10 px-3 text-xs text-foreground placeholder:text-muted-foreground/40 focus:border-primary/50 focus:outline-none disabled:opacity-50"
              autoFocus
              onKeyDown={(e) => { if (e.key === 'Enter') handleClone(); }}
            />
          </div>

          {/* Local path */}
          <div>
            <label className="mb-1.5 block text-[11px] font-medium text-muted-foreground">
              Local Path
            </label>
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={localPath}
                onChange={(e) => setLocalPath(e.target.value)}
                disabled={cloning}
                className="h-9 min-w-0 flex-1 rounded-md border border-border/40 bg-muted/10 px-3 text-xs text-foreground placeholder:text-muted-foreground/40 focus:border-primary/50 focus:outline-none disabled:opacity-50"
              />
              <button
                type="button"
                onClick={handleChoosePath}
                disabled={cloning}
                className="h-9 shrink-0 rounded-md border border-border/50 bg-muted/10 px-3 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/30 hover:text-foreground disabled:opacity-50"
              >
                Choose...
              </button>
            </div>
          </div>

          {/* Error */}
          {error && (
            <div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-[11px] text-red-400">
              {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 border-t border-border/40 px-5 py-4">
          <button
            type="button"
            onClick={onClose}
            disabled={cloning}
            className="rounded-md border border-border/50 px-4 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/20 hover:text-foreground disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleClone}
            disabled={cloning || !url.trim() || !localPath.trim()}
            className="flex items-center gap-1.5 rounded-md bg-primary px-4 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {cloning ? (
              <>
                <LoaderIcon className="h-3.5 w-3.5 animate-spin" />
                Cloning...
              </>
            ) : (
              <>
                <DownloadCloudIcon className="h-3.5 w-3.5" />
                Clone
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
};

/* ── Add Menu (Clone / Add Existing) ───────────────────────── */

const AddMenu: FC<{
  open: boolean;
  anchorRef: React.RefObject<HTMLButtonElement | null>;
  onClose: () => void;
  onClone: () => void;
  onAddExisting: () => void;
}> = ({ open, anchorRef, onClose, onClone, onAddExisting }) => {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (
        menuRef.current && !menuRef.current.contains(e.target as Node) &&
        anchorRef.current && !anchorRef.current.contains(e.target as Node)
      ) {
        onClose();
      }
    };
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [open, onClose, anchorRef]);

  if (!open) return null;

  // Position relative to anchor
  const rect = anchorRef.current?.getBoundingClientRect();
  const top = rect ? rect.bottom + 4 : 0;
  const right = rect ? window.innerWidth - rect.right : 0;

  return (
    <div
      ref={menuRef}
      className="fixed z-[60] min-w-56 rounded-lg border border-border/60 bg-popover py-1 shadow-xl animate-in fade-in-0 zoom-in-95"
      style={{ top, right }}
    >
      <button
        type="button"
        onClick={() => { onClose(); onClone(); }}
        className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-[11px] text-muted-foreground transition-colors hover:bg-muted/30 hover:text-foreground"
      >
        <DownloadCloudIcon className="h-3.5 w-3.5 shrink-0" />
        Clone Repository...
      </button>
      <button
        type="button"
        onClick={() => { onClose(); onAddExisting(); }}
        className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-[11px] text-muted-foreground transition-colors hover:bg-muted/30 hover:text-foreground"
      >
        <FolderOpenIcon className="h-3.5 w-3.5 shrink-0" />
        Add Existing Repository...
      </button>
    </div>
  );
};

/* ── Main Component ────────────────────────────────────────── */

export const RepositorySelector: FC = () => {
  const { project, setProject } = useWorkspace();

  // Dropdown state
  const [isOpen, setIsOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const [recentProjects, setRecentProjects] = useState<RecentProject[]>([]);
  const [loadingRecent, setLoadingRecent] = useState(false);

  // Add menu state
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const addButtonRef = useRef<HTMLButtonElement>(null);

  // Clone dialog state
  const [cloneDialogOpen, setCloneDialogOpen] = useState(false);

  // Context menu state
  const [contextMenu, setContextMenu] = useState<ContextMenuState>({
    visible: false,
    x: 0,
    y: 0,
    project: null,
  });

  // Remove confirmation state
  const [removeTarget, setRemoveTarget] = useState<RecentProject | null>(null);

  // Refs for click-outside handling
  const dropdownRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const filterInputRef = useRef<HTMLInputElement>(null);

  // ── Load recent projects ──────────────────────────────────

  const loadRecent = useCallback(async () => {
    setLoadingRecent(true);
    try {
      const result = await app.projects.listRecent();
      setRecentProjects(result.projects);
    } catch {
      setRecentProjects([]);
    } finally {
      setLoadingRecent(false);
    }
  }, []);

  // Load on mount
  useEffect(() => {
    loadRecent();
  }, [loadRecent]);

  // Reload when dropdown opens
  useEffect(() => {
    if (isOpen) {
      loadRecent();
      // Focus the filter input when dropdown opens
      requestAnimationFrame(() => {
        filterInputRef.current?.focus();
      });
    } else {
      setFilter('');
      setAddMenuOpen(false);
    }
  }, [isOpen, loadRecent]);

  // ── Close dropdown on outside click ────────────────────────

  useEffect(() => {
    if (!isOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (
        dropdownRef.current && !dropdownRef.current.contains(e.target as Node) &&
        triggerRef.current && !triggerRef.current.contains(e.target as Node)
      ) {
        setIsOpen(false);
      }
    };
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [isOpen]);

  // ── Filtered + grouped repos ───────────────────────────────

  const groupedRepos = useMemo(() => {
    const lowerFilter = filter.toLowerCase().trim();
    const filtered = lowerFilter
      ? recentProjects.filter(
          (p) =>
            p.name.toLowerCase().includes(lowerFilter) ||
            p.path.toLowerCase().includes(lowerFilter),
        )
      : recentProjects;

    // Sort by lastOpened descending
    const sorted = [...filtered].sort((a, b) => b.lastOpened - a.lastOpened);

    // Group by extracted org/owner
    const groups = new Map<string, RecentProject[]>();
    for (const p of sorted) {
      const group = extractGroup(p.path);
      const existing = groups.get(group);
      if (existing) {
        existing.push(p);
      } else {
        groups.set(group, [p]);
      }
    }

    return groups;
  }, [recentProjects, filter]);

  // ── Select a project ───────────────────────────────────────

  const selectProject = useCallback(
    async (p: RecentProject) => {
      setProject({ path: p.path, name: p.name });
      await app.projects.addRecent({ path: p.path, name: p.name });
      setIsOpen(false);
    },
    [setProject],
  );

  // ── Add existing repository ────────────────────────────────

  const handleAddExisting = useCallback(async () => {
    const result = await app.dialog.openDirectory();
    if (result.canceled || !result.directoryPath) return;
    const name = result.name ?? baseName(result.directoryPath);
    setProject({ path: result.directoryPath, name });
    await app.projects.addRecent({ path: result.directoryPath, name });
    await loadRecent();
    setIsOpen(false);
  }, [setProject, loadRecent]);

  // ── Clone callback ─────────────────────────────────────────

  const handleCloned = useCallback(
    async (path: string, name: string) => {
      setProject({ path, name });
      await app.projects.addRecent({ path, name });
      await loadRecent();
      setCloneDialogOpen(false);
      setIsOpen(false);
    },
    [setProject, loadRecent],
  );

  // ── Context menu handlers ──────────────────────────────────

  const handleContextMenu = useCallback((e: React.MouseEvent, p: RecentProject) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ visible: true, x: e.clientX, y: e.clientY, project: p });
  }, []);

  const closeContextMenu = useCallback(() => {
    setContextMenu((prev) => ({ ...prev, visible: false }));
  }, []);

  const handleRemoveRequest = useCallback((p: RecentProject) => {
    setRemoveTarget(p);
  }, []);

  const handleRemoveConfirm = useCallback(async () => {
    if (!removeTarget) return;
    await app.projects.removeRecent(removeTarget.path);
    setRemoveTarget(null);
    await loadRecent();
  }, [removeTarget, loadRecent]);

  const handleRemoveCancel = useCallback(() => {
    setRemoveTarget(null);
  }, []);

  // ── Render ─────────────────────────────────────────────────

  return (
    <div className="relative">
      {/* Trigger button */}
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setIsOpen((prev) => !prev)}
        className={cn(
          'flex w-full items-center gap-2 border-b border-border/50 px-3 py-2.5 text-left transition-colors',
          isOpen
            ? 'bg-muted/30'
            : 'hover:bg-muted/20',
        )}
      >
        <GitBranchIcon className="h-4 w-4 shrink-0 text-muted-foreground/60" />
        <div className="min-w-0 flex-1">
          <div className="text-[10px] text-muted-foreground/50 leading-tight">Current Repository</div>
          <div className="truncate text-xs font-semibold text-foreground">
            {project?.name ?? 'Select Repository'}
          </div>
        </div>
        <ChevronDownIcon
          className={cn(
            'h-3.5 w-3.5 shrink-0 text-muted-foreground/40 transition-transform',
            isOpen && 'rotate-180',
          )}
        />
      </button>

      {/* Dropdown panel — fixed position for reliable overlay */}
      {isOpen && (
        <div
          ref={dropdownRef}
          className="absolute left-0 right-0 top-full z-50 max-h-[70vh] overflow-hidden rounded-b-xl border border-t-0 border-border/60 bg-popover shadow-2xl animate-in fade-in-0 slide-in-from-top-2"
        >
          {/* Filter + Add row */}
          <div className="flex items-center gap-1.5 border-b border-border/40 px-3 py-2">
            <SearchIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground/40" />
            <input
              ref={filterInputRef}
              type="text"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter"
              className="h-6 min-w-0 flex-1 bg-transparent text-xs text-foreground placeholder:text-muted-foreground/40 focus:outline-none"
            />
            <div className="relative">
              <button
                ref={addButtonRef}
                type="button"
                onClick={(e) => { e.stopPropagation(); setAddMenuOpen((prev) => !prev); }}
                className={cn(
                  'flex h-6 shrink-0 items-center gap-1 rounded-md border border-border/50 bg-muted/10 px-2 text-[10px] font-medium text-muted-foreground transition-colors hover:bg-muted/30 hover:text-foreground',
                  addMenuOpen && 'bg-muted/30 text-foreground',
                )}
              >
                <PlusIcon className="h-3 w-3" />
                Add
                <ChevronDownIcon className="h-2.5 w-2.5" />
              </button>
              {/* Inline add menu */}
              {addMenuOpen && (
                <div className="absolute right-0 top-full z-[60] mt-1 min-w-48 rounded-lg border border-border/60 bg-popover py-1 shadow-xl animate-in fade-in-0 zoom-in-95">
                  <button
                    type="button"
                    onClick={() => { setAddMenuOpen(false); setCloneDialogOpen(true); }}
                    className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-[11px] text-muted-foreground transition-colors hover:bg-muted/30 hover:text-foreground"
                  >
                    <DownloadCloudIcon className="h-3.5 w-3.5 shrink-0" />
                    Clone Repository...
                  </button>
                  <button
                    type="button"
                    onClick={() => { setAddMenuOpen(false); handleAddExisting(); }}
                    className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-[11px] text-muted-foreground transition-colors hover:bg-muted/30 hover:text-foreground"
                  >
                    <FolderOpenIcon className="h-3.5 w-3.5 shrink-0" />
                    Add Existing Repository...
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* Repo list */}
          <div className="max-h-[calc(70vh-44px)] overflow-y-auto">
            {loadingRecent && recentProjects.length === 0 ? (
              <div className="flex items-center justify-center py-8">
                <LoaderIcon className="h-4 w-4 animate-spin text-muted-foreground/40" />
              </div>
            ) : recentProjects.length === 0 ? (
              <div className="px-4 py-8 text-center">
                <GitBranchIcon className="mx-auto h-8 w-8 text-muted-foreground/20" />
                <p className="mt-2 text-xs text-muted-foreground/50">No recent repositories</p>
                <p className="mt-0.5 text-[10px] text-muted-foreground/30">
                  Clone a repository or add an existing one to get started.
                </p>
              </div>
            ) : groupedRepos.size === 0 ? (
              <div className="px-4 py-6 text-center">
                <p className="text-xs text-muted-foreground/50">No repositories match &ldquo;{filter}&rdquo;</p>
              </div>
            ) : (
              Array.from(groupedRepos.entries()).map(([group, projects]) => (
                <div key={group}>
                  {/* Group header */}
                  <div className="sticky top-0 bg-popover/95 px-3 py-1.5 text-[9px] font-semibold uppercase tracking-wider text-muted-foreground/40 backdrop-blur-sm">
                    {group}
                  </div>
                  {/* Repos in group */}
                  {projects.map((p) => {
                    const isCurrent = project?.path === p.path;
                    return (
                      <button
                        key={p.path}
                        type="button"
                        onClick={() => selectProject(p)}
                        onContextMenu={(e) => handleContextMenu(e, p)}
                        className={cn(
                          'flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors',
                          isCurrent
                            ? 'bg-primary/8 text-primary'
                            : 'text-muted-foreground hover:bg-muted/20 hover:text-foreground',
                        )}
                      >
                        <GitBranchIcon className={cn('h-4 w-4 shrink-0', isCurrent ? 'text-primary/60' : 'text-muted-foreground/30')} />
                        <div className="min-w-0 flex-1">
                          <div className={cn('truncate text-xs font-medium', isCurrent && 'font-semibold')}>
                            {p.name}
                          </div>
                          <div className="truncate text-[10px] text-muted-foreground/40">
                            {p.path}
                          </div>
                        </div>
                        {isCurrent && (
                          <div className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
                        )}
                      </button>
                    );
                  })}
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {/* Context Menu */}
      <RepoContextMenu
        state={contextMenu}
        onClose={closeContextMenu}
        onRemoveRequest={handleRemoveRequest}
      />

      {/* Remove Confirmation Dialog */}
      <RemoveDialog
        project={removeTarget}
        onCancel={handleRemoveCancel}
        onConfirm={handleRemoveConfirm}
      />

      {/* Clone Repository Dialog */}
      <CloneDialog
        open={cloneDialogOpen}
        onClose={() => setCloneDialogOpen(false)}
        onCloned={handleCloned}
      />
    </div>
  );
};
