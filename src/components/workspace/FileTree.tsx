import { useState, type FC } from 'react';
import { FolderIcon, FolderOpenIcon, FileIcon, Loader2Icon } from 'lucide-react';
import { cn } from '@/lib/utils';

/* ── Types ──────────────────────────────────────────────── */

export interface FileNode {
  name: string;
  type: 'file' | 'directory';
  children?: FileNode[];
  loaded?: boolean;
}

interface FileTreeProps {
  nodes: FileNode[];
  selectedPath?: string;
  onSelect: (path: string) => void;
  onExpandDirectory?: (path: string) => Promise<FileNode[]>;
  depth?: number;
  parentPath?: string;
}

/* ── Component ──────────────────────────────────────────── */

export const FileTree: FC<FileTreeProps> = ({
  nodes,
  selectedPath,
  onSelect,
  onExpandDirectory,
  depth = 0,
  parentPath = '',
}) => {
  return (
    <div className="flex flex-col">
      {nodes.map((node) => {
        const fullPath = parentPath ? `${parentPath}/${node.name}` : node.name;
        return node.type === 'directory' ? (
          <DirectoryNode
            key={fullPath}
            node={node}
            fullPath={fullPath}
            depth={depth}
            selectedPath={selectedPath}
            onSelect={onSelect}
            onExpandDirectory={onExpandDirectory}
          />
        ) : (
          <button
            key={fullPath}
            type="button"
            onClick={() => onSelect(fullPath)}
            className={cn(
              'flex items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-xs transition-colors',
              selectedPath === fullPath
                ? 'bg-primary/10 text-primary'
                : 'text-muted-foreground hover:bg-muted/40 hover:text-foreground',
            )}
            style={{ paddingLeft: `${depth * 12 + 6}px` }}
          >
            <FileIcon className="h-3.5 w-3.5 shrink-0 opacity-60" />
            <span className="truncate">{node.name}</span>
          </button>
        );
      })}
    </div>
  );
};

/* ── Directory node (manages own expand state + lazy loading) */

interface DirectoryNodeProps {
  node: FileNode;
  fullPath: string;
  depth: number;
  selectedPath?: string;
  onSelect: (path: string) => void;
  onExpandDirectory?: (path: string) => Promise<FileNode[]>;
}

const DirectoryNode: FC<DirectoryNodeProps> = ({
  node,
  fullPath,
  depth,
  selectedPath,
  onSelect,
  onExpandDirectory,
}) => {
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<FileNode[]>(node.children ?? []);
  const [loaded, setLoaded] = useState(node.loaded ?? false);
  const [loading, setLoading] = useState(false);

  const handleToggle = async () => {
    const willExpand = !expanded;
    setExpanded(willExpand);

    // Lazy-load children on first expand
    if (willExpand && !loaded && onExpandDirectory) {
      setLoading(true);
      try {
        const loadedChildren = await onExpandDirectory(fullPath);
        setChildren(loadedChildren);
        setLoaded(true);
      } catch {
        setChildren([]);
      } finally {
        setLoading(false);
      }
    }
  };

  return (
    <div>
      <button
        type="button"
        onClick={handleToggle}
        className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-xs font-medium text-foreground/80 transition-colors hover:bg-muted/40 hover:text-foreground"
        style={{ paddingLeft: `${depth * 12 + 6}px` }}
      >
        {loading ? (
          <Loader2Icon className="h-3.5 w-3.5 shrink-0 animate-spin text-primary/70" />
        ) : expanded ? (
          <FolderOpenIcon className="h-3.5 w-3.5 shrink-0 text-primary/70" />
        ) : (
          <FolderIcon className="h-3.5 w-3.5 shrink-0 text-primary/70" />
        )}
        <span className="truncate">{node.name}</span>
      </button>
      {expanded && children.length > 0 && (
        <FileTree
          nodes={children}
          selectedPath={selectedPath}
          onSelect={onSelect}
          onExpandDirectory={onExpandDirectory}
          depth={depth + 1}
          parentPath={fullPath}
        />
      )}
      {expanded && !loading && loaded && children.length === 0 && (
        <div
          className="text-[10px] text-muted-foreground/30 italic"
          style={{ paddingLeft: `${(depth + 1) * 12 + 6}px` }}
        >
          Empty
        </div>
      )}
    </div>
  );
};
