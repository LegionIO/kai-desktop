import { useCallback, useEffect, useMemo, useState, type FC } from 'react';
import * as ScrollArea from '@radix-ui/react-scroll-area';
import {
  ChevronDown,
  ChevronRight,
  FileDiff as FileDiffIcon,
  FilePlus2,
  FileX2,
  FolderOpen,
  RotateCcw,
} from 'lucide-react';
import { app } from '@/lib/ipc-client';
import { cn } from '@/lib/utils';
import { FileDiffResult } from '@/components/thread/tool-results/FileDiffResult';
import type { FileDiff } from '../../../shared/diff-types';

export type DiffPanelProps = {
  conversationId: string;
  className?: string;
};

type TreeNode = {
  name: string;
  path: string;
  children: Map<string, TreeNode>;
  file?: FileDiff;
};

function buildTree(diffs: FileDiff[]): TreeNode {
  const root: TreeNode = { name: '', path: '', children: new Map() };
  for (const diff of diffs) {
    const segments = diff.path.split('/').filter(Boolean);
    let node = root;
    let acc = diff.path.startsWith('/') ? '' : '.';
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      acc = acc === '' ? '/' + seg : acc + '/' + seg;
      let child = node.children.get(seg);
      if (!child) {
        child = { name: seg, path: acc, children: new Map() };
        node.children.set(seg, child);
      }
      node = child;
    }
    node.file = diff;
  }
  return root;
}

const TreeDir: FC<{
  node: TreeNode;
  depth: number;
  selected: string | null;
  onSelect: (path: string) => void;
}> = ({ node, depth, selected, onSelect }) => {
  const [open, setOpen] = useState(true);
  const entries = useMemo(
    () =>
      Array.from(node.children.values()).sort((a, b) => {
        const aDir = a.children.size > 0 && !a.file;
        const bDir = b.children.size > 0 && !b.file;
        if (aDir !== bDir) return aDir ? -1 : 1;
        return a.name.localeCompare(b.name);
      }),
    [node.children],
  );

  return (
    <div>
      {depth > 0 && (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex w-full items-center gap-1.5 py-0.5 pr-2 hover:bg-muted/50 rounded text-left"
          style={{ paddingLeft: `${depth * 12}px` }}
        >
          {open ? (
            <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground/50" />
          ) : (
            <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground/50" />
          )}
          <FolderOpen className="h-3 w-3 shrink-0 text-muted-foreground/60" />
          <span className="truncate text-[11px] text-muted-foreground/80">{node.name}</span>
        </button>
      )}
      {open &&
        entries.map((child) =>
          child.file ? (
            <TreeFile
              key={child.path}
              diff={child.file}
              depth={depth + 1}
              selected={selected === child.path}
              onSelect={onSelect}
            />
          ) : (
            <TreeDir key={child.path} node={child} depth={depth + 1} selected={selected} onSelect={onSelect} />
          ),
        )}
    </div>
  );
};

const TreeFile: FC<{
  diff: FileDiff;
  depth: number;
  selected: boolean;
  onSelect: (path: string) => void;
}> = ({ diff, depth, selected, onSelect }) => {
  const Icon = diff.created ? FilePlus2 : diff.deleted ? FileX2 : FileDiffIcon;
  return (
    <button
      type="button"
      onClick={() => onSelect(diff.path)}
      className={cn(
        'flex w-full items-center gap-1.5 py-0.5 pr-2 rounded text-left hover:bg-muted/50',
        selected && 'bg-primary/10 hover:bg-primary/15',
      )}
      style={{ paddingLeft: `${depth * 12 + 14}px` }}
    >
      <Icon
        className={cn(
          'h-3 w-3 shrink-0',
          diff.created
            ? 'text-emerald-600 dark:text-emerald-400'
            : diff.deleted
              ? 'text-red-600 dark:text-red-400'
              : 'text-muted-foreground/60',
        )}
      />
      <span className="truncate text-[11px] text-foreground/90 flex-1 min-w-0">{diff.path.split('/').pop()}</span>
      <span className="shrink-0 text-[10px] tabular-nums">
        {diff.additions > 0 && <span className="text-emerald-600 dark:text-emerald-400">+{diff.additions}</span>}
        {diff.additions > 0 && diff.deletions > 0 && ' '}
        {diff.deletions > 0 && <span className="text-red-600 dark:text-red-400">−{diff.deletions}</span>}
      </span>
    </button>
  );
};

/**
 * Cumulative per-conversation Changes panel. Standalone — mounted by
 * `SidePanelHost` (built by a parallel agent) as the "Changes" tab.
 */
export const DiffPanel: FC<DiffPanelProps> = ({ conversationId, className }) => {
  const [diffs, setDiffs] = useState<FileDiff[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [reverting, setReverting] = useState(false);
  const [revertingAll, setRevertingAll] = useState(false);
  const [revertError, setRevertError] = useState<string | null>(null);

  const reload = useCallback(() => {
    if (!conversationId) {
      setDiffs([]);
      return;
    }
    void app.diffs.listForConversation(conversationId).then((list) => {
      setDiffs(list);
      setSelected((prev) => (prev && list.some((d) => d.path === prev) ? prev : (list[0]?.path ?? null)));
    });
  }, [conversationId]);

  useEffect(() => {
    reload();
    const off = app.diffs.onChange((ev) => {
      if (ev.conversationId !== conversationId) return;
      reload();
    });
    return off;
  }, [conversationId, reload]);

  useEffect(() => {
    setRevertError(null);
  }, [selected]);

  const tree = useMemo(() => buildTree(diffs), [diffs]);
  const active = useMemo(() => diffs.find((d) => d.path === selected) ?? null, [diffs, selected]);
  const totals = useMemo(
    () => diffs.reduce((acc, d) => ({ add: acc.add + d.additions, del: acc.del + d.deletions }), { add: 0, del: 0 }),
    [diffs],
  );

  const handleRevert = useCallback(async () => {
    if (!active) return;
    setReverting(true);
    setRevertError(null);
    try {
      const r = await app.diffs.revert(conversationId, active.path);
      if (!r.success && r.error) setRevertError(r.error);
    } finally {
      setReverting(false);
      reload();
    }
  }, [active, conversationId, reload]);

  const handleRevertHunk = useCallback(
    async (hunkIndex: number) => {
      if (!active) return;
      setRevertError(null);
      const r = await app.diffs.revertHunk(conversationId, active.path, hunkIndex);
      if (!r.success && r.error) setRevertError(r.error);
      reload();
    },
    [active, conversationId, reload],
  );

  const revertableCount = useMemo(() => diffs.filter((d) => d.revertable).length, [diffs]);

  const handleRevertAll = useCallback(async () => {
    if (revertableCount === 0) return;
    setRevertingAll(true);
    try {
      await app.diffs.revertAll(conversationId);
    } finally {
      setRevertingAll(false);
      reload();
    }
  }, [revertableCount, conversationId, reload]);

  return (
    <div className={cn('flex h-full min-h-0 flex-col', className)}>
      <div className="flex items-center justify-between border-b border-border/60 px-3 py-2">
        <div className="flex items-baseline gap-2">
          <span className="text-xs font-semibold text-foreground">Changes</span>
          <span className="text-[11px] text-muted-foreground/60">
            {diffs.length} file{diffs.length === 1 ? '' : 's'}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[11px] tabular-nums">
            {totals.add > 0 && <span className="text-emerald-600 dark:text-emerald-400">+{totals.add}</span>}
            {totals.add > 0 && totals.del > 0 && <span className="text-muted-foreground/30"> </span>}
            {totals.del > 0 && <span className="text-red-600 dark:text-red-400">−{totals.del}</span>}
          </span>
          {revertableCount > 0 && (
            <button
              type="button"
              onClick={handleRevertAll}
              disabled={revertingAll}
              className="flex items-center gap-1 rounded border border-border/70 px-2 py-0.5 text-[10px] font-medium text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:opacity-40"
              title={`Revert all ${revertableCount} revertable file${revertableCount === 1 ? '' : 's'} to their originals`}
            >
              <RotateCcw className="h-3 w-3" />
              Revert all
            </button>
          )}
        </div>
      </div>

      {diffs.length === 0 ? (
        <div className="flex flex-1 items-center justify-center p-6 text-center text-[11px] text-muted-foreground/50">
          No file changes tracked in this chat yet.
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          {/* File tree */}
          <ScrollArea.Root className="w-56 shrink-0 border-r border-border/60">
            <ScrollArea.Viewport className="h-full w-full py-1">
              <TreeDir node={tree} depth={0} selected={selected} onSelect={setSelected} />
            </ScrollArea.Viewport>
            <ScrollArea.Scrollbar orientation="vertical" className="w-1.5">
              <ScrollArea.Thumb className="rounded bg-muted-foreground/30" />
            </ScrollArea.Scrollbar>
          </ScrollArea.Root>

          {/* Diff view */}
          <div className="flex min-w-0 flex-1 flex-col">
            {active ? (
              <>
                <div className="flex items-center gap-2 border-b border-border/60 px-3 py-1.5">
                  <span className="truncate text-[11px] font-mono text-muted-foreground/80" title={active.path}>
                    {active.path}
                  </span>
                  <span className="flex-1" />
                  <span className="text-[10px] text-muted-foreground/50">
                    {active.ops.length} edit{active.ops.length === 1 ? '' : 's'}
                  </span>
                  <button
                    type="button"
                    onClick={handleRevert}
                    disabled={reverting || !active.revertable}
                    className="flex items-center gap-1 rounded border border-border/70 px-2 py-0.5 text-[10px] font-medium text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted-foreground"
                    title={
                      active.revertable
                        ? 'Restore original content'
                        : 'Original content was not captured (shell/AI-detected change) — revert unavailable'
                    }
                  >
                    <RotateCcw className="h-3 w-3" />
                    Revert
                  </button>
                </div>
                {/* Plain scroller (both axes): the diff's minified/long lines
                    must scroll horizontally, not overflow the panel off-screen.
                    min-w-0 lets the flex child shrink so the inner overflow-auto
                    engages instead of the content pushing layout past the edge.
                    Wrapping it in a vertical-only Radix ScrollArea clipped x. */}
                <div className="min-h-0 min-w-0 flex-1 overflow-y-auto p-2">
                  <FileDiffResult
                    path={active.path}
                    unifiedDiff={active.unifiedDiff}
                    additions={active.additions}
                    deletions={active.deletions}
                    source={active.source}
                    created={active.created}
                    deleted={active.deleted}
                    defaultOpen
                    scrollClassName="overflow-x-auto"
                    onRevertHunk={active.revertable ? handleRevertHunk : undefined}
                  />
                  {revertError && (
                    <div className="mx-2 mt-2 rounded border border-destructive/40 bg-destructive/10 px-2 py-1 text-[11px] text-destructive">
                      {revertError}
                    </div>
                  )}
                </div>
              </>
            ) : (
              <div className="flex flex-1 items-center justify-center text-[11px] text-muted-foreground/50">
                Select a file
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
