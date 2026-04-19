import { useState, type FC } from 'react';
import { FolderIcon, FolderOpenIcon, FileIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

/* ── Types ──────────────────────────────────────────────── */

export interface FileNode {
  name: string;
  type: 'file' | 'directory';
  children?: FileNode[];
}

interface FileTreeProps {
  nodes: FileNode[];
  selectedPath?: string;
  onSelect: (path: string) => void;
  depth?: number;
  parentPath?: string;
}

/* ── Sample data ────────────────────────────────────────── */

export const SAMPLE_TREE: FileNode[] = [
  {
    name: 'src',
    type: 'directory',
    children: [
      {
        name: 'components',
        type: 'directory',
        children: [
          { name: 'App.tsx', type: 'file' },
          { name: 'Header.tsx', type: 'file' },
          { name: 'Sidebar.tsx', type: 'file' },
        ],
      },
      {
        name: 'hooks',
        type: 'directory',
        children: [
          { name: 'useAuth.ts', type: 'file' },
          { name: 'useTheme.ts', type: 'file' },
        ],
      },
      {
        name: 'utils',
        type: 'directory',
        children: [
          { name: 'cn.ts', type: 'file' },
          { name: 'api.ts', type: 'file' },
        ],
      },
      { name: 'main.tsx', type: 'file' },
      { name: 'index.css', type: 'file' },
    ],
  },
  {
    name: 'public',
    type: 'directory',
    children: [
      { name: 'favicon.ico', type: 'file' },
      { name: 'index.html', type: 'file' },
    ],
  },
  { name: 'package.json', type: 'file' },
  { name: 'tsconfig.json', type: 'file' },
  { name: 'README.md', type: 'file' },
];

/* ── Component ──────────────────────────────────────────── */

export const FileTree: FC<FileTreeProps> = ({
  nodes,
  selectedPath,
  onSelect,
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

/* ── Directory node (manages own expand state) ──────────── */

interface DirectoryNodeProps {
  node: FileNode;
  fullPath: string;
  depth: number;
  selectedPath?: string;
  onSelect: (path: string) => void;
}

const DirectoryNode: FC<DirectoryNodeProps> = ({
  node,
  fullPath,
  depth,
  selectedPath,
  onSelect,
}) => {
  const [expanded, setExpanded] = useState(depth < 1);

  return (
    <div>
      <button
        type="button"
        onClick={() => setExpanded((prev) => !prev)}
        className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-xs font-medium text-foreground/80 transition-colors hover:bg-muted/40 hover:text-foreground"
        style={{ paddingLeft: `${depth * 12 + 6}px` }}
      >
        {expanded ? (
          <FolderOpenIcon className="h-3.5 w-3.5 shrink-0 text-primary/70" />
        ) : (
          <FolderIcon className="h-3.5 w-3.5 shrink-0 text-primary/70" />
        )}
        <span className="truncate">{node.name}</span>
      </button>
      {expanded && node.children && (
        <FileTree
          nodes={node.children}
          selectedPath={selectedPath}
          onSelect={onSelect}
          depth={depth + 1}
          parentPath={fullPath}
        />
      )}
    </div>
  );
};
