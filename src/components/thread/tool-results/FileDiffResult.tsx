import { useMemo, useState, type FC } from 'react';
import * as Collapsible from '@radix-ui/react-collapsible';
import { ChevronDown, ChevronRight, FileDiff as FileDiffIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { DiffEvent } from '../../../../shared/diff-types';

type ParsedHunk = {
  header: string;
  lines: Array<{ type: 'add' | 'del' | 'context'; text: string }>;
};

function parseHunks(unified: string): ParsedHunk[] {
  if (!unified) return [];
  const hunks: ParsedHunk[] = [];
  let current: ParsedHunk | null = null;
  for (const raw of unified.split('\n')) {
    // File headers only appear before the first @@ hunk. Once inside a hunk,
    // a line like `+++ x` / `--- x` is real content (an added/removed line whose
    // text begins with `++ `/`-- `), so don't drop it.
    if (!current && (raw.startsWith('--- ') || raw.startsWith('+++ '))) continue;
    if (raw.startsWith('@@')) {
      current = { header: raw, lines: [] };
      hunks.push(current);
      continue;
    }
    if (!current) continue;
    if (raw.startsWith('+')) current.lines.push({ type: 'add', text: raw.slice(1) });
    else if (raw.startsWith('-')) current.lines.push({ type: 'del', text: raw.slice(1) });
    else current.lines.push({ type: 'context', text: raw.startsWith(' ') ? raw.slice(1) : raw });
  }
  return hunks;
}

export type FileDiffResultProps = {
  path: string;
  unifiedDiff: string;
  additions: number;
  deletions: number;
  source?: DiffEvent['source'];
  created?: boolean;
  deleted?: boolean;
  defaultOpen?: boolean;
  className?: string;
  /** Classes for the inner scroll container that holds the hunks. Defaults to a
   *  capped both-axis scroller for inline (in-thread) use. The Changes panel
   *  overrides this so its own wrapper owns vertical scroll and only long lines
   *  scroll horizontally here (no 24rem cap). */
  scrollClassName?: string;
  /** When provided, each hunk header shows a revert-hunk button. */
  onRevertHunk?: (hunkIndex: number) => void;
};

/**
 * Collapsible git-style unified diff. Rendered as the tool-result body for
 * file write/edit calls, and appended under shell calls that produced diffs.
 */
export const FileDiffResult: FC<FileDiffResultProps> = ({
  path,
  unifiedDiff,
  additions,
  deletions,
  source,
  created,
  deleted,
  defaultOpen = false,
  className,
  scrollClassName = 'max-h-96 overflow-auto',
  onRevertHunk,
}) => {
  const [open, setOpen] = useState(defaultOpen);
  const hunks = useMemo(() => parseHunks(unifiedDiff), [unifiedDiff]);
  const fileName = path.split('/').pop() ?? path;

  return (
    <Collapsible.Root
      open={open}
      onOpenChange={setOpen}
      className={cn(
        'rounded-md border border-border/60 bg-muted/30 dark:bg-white/[0.02] overflow-hidden text-xs font-mono',
        className,
      )}
    >
      <Collapsible.Trigger asChild>
        <button
          type="button"
          className="flex w-full items-center gap-2 px-3 py-1.5 hover:bg-muted/50 dark:hover:bg-white/[0.04] transition-colors text-left"
        >
          {open ? (
            <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground/60" />
          ) : (
            <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground/60" />
          )}
          <FileDiffIcon className="h-3 w-3 shrink-0 text-muted-foreground/60" />
          <span className="text-foreground/90 font-semibold truncate min-w-0 flex-1" title={path}>
            {fileName}
          </span>
          {created && (
            <span className="shrink-0 rounded px-1 text-[9px] font-semibold uppercase tracking-wide text-emerald-600 dark:text-emerald-400 bg-emerald-500/10">
              new
            </span>
          )}
          {deleted && (
            <span className="shrink-0 rounded px-1 text-[9px] font-semibold uppercase tracking-wide text-red-600 dark:text-red-400 bg-red-500/10">
              deleted
            </span>
          )}
          {source && source !== 'file-tool' && (
            <span className="shrink-0 text-[9px] text-muted-foreground/50 uppercase tracking-wide">
              {source === 'shell-ai' ? 'inferred' : 'detected'}
            </span>
          )}
          <span className="shrink-0 text-[11px] tabular-nums">
            {additions > 0 && <span className="text-emerald-600 dark:text-emerald-400">+{additions}</span>}
            {additions > 0 && deletions > 0 && <span className="text-muted-foreground/30"> </span>}
            {deletions > 0 && <span className="text-red-600 dark:text-red-400">−{deletions}</span>}
            {additions === 0 && deletions === 0 && <span className="text-muted-foreground/40">±0</span>}
          </span>
        </button>
      </Collapsible.Trigger>

      <Collapsible.Content>
        <div className={cn('border-t border-border/40 dark:border-white/[0.06]', scrollClassName)}>
          {hunks.length === 0 ? (
            <div className="px-3 py-2 text-[11px] text-muted-foreground/60 italic">
              {created ? 'File created (no previous content).' : 'No textual changes.'}
            </div>
          ) : (
            hunks.map((hunk, hi) => (
              <div key={hi} className="border-b border-border/30 dark:border-white/[0.04] last:border-b-0">
                <div className="flex items-center gap-2 px-3 py-0.5 text-[10px] text-sky-700 dark:text-sky-400 bg-sky-500/5 select-none">
                  <span className="truncate">{hunk.header}</span>
                  {onRevertHunk && (
                    <button
                      type="button"
                      onClick={() => onRevertHunk(hi)}
                      className="ml-auto shrink-0 rounded px-1 text-[9px] font-medium text-muted-foreground/70 transition-colors hover:bg-destructive/10 hover:text-destructive"
                      title="Revert just this hunk"
                    >
                      revert hunk
                    </button>
                  )}
                </div>
                <pre className="text-[11px] leading-[1.35rem]">
                  {hunk.lines.map((line, li) => (
                    <div
                      key={li}
                      className={cn(
                        'px-3 whitespace-pre',
                        line.type === 'add' && 'text-emerald-600 dark:text-emerald-400 bg-emerald-500/5',
                        line.type === 'del' && 'text-red-600 dark:text-red-400 bg-red-500/5',
                        line.type === 'context' && 'text-muted-foreground/60',
                      )}
                    >
                      <span className="select-none inline-block w-3 text-muted-foreground/40">
                        {line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' '}
                      </span>
                      {line.text || ' '}
                    </div>
                  ))}
                </pre>
              </div>
            ))
          )}
        </div>
        <div className="px-3 py-1 text-[10px] text-muted-foreground/40 border-t border-border/30 dark:border-white/[0.04] truncate">
          {path}
        </div>
      </Collapsible.Content>
    </Collapsible.Root>
  );
};

/** Render every diff attached to a tool result's `_diffTracking` payload. */
export const ToolDiffList: FC<{ diffs: DiffEvent[]; className?: string }> = ({ diffs, className }) => {
  if (diffs.length === 0) return null;
  return (
    <div className={cn('space-y-1.5', className)}>
      {diffs.map((d) => (
        <FileDiffResult
          key={d.path}
          path={d.path}
          unifiedDiff={d.unifiedDiff}
          additions={d.additions}
          deletions={d.deletions}
          source={d.source}
          created={d.created}
          deleted={d.deleted}
        />
      ))}
    </div>
  );
};

/** Type guard for the `_diffTracking` field embedded on tool-result payloads. */
export function extractDiffTracking(result: unknown): DiffEvent[] {
  if (!result || typeof result !== 'object') return [];
  const meta = (result as { _diffTracking?: { diffs?: unknown } })._diffTracking;
  if (!meta || !Array.isArray(meta.diffs)) return [];
  return meta.diffs.filter(
    (d): d is DiffEvent => d != null && typeof d === 'object' && typeof (d as DiffEvent).path === 'string',
  );
}
