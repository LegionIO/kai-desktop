import { useMemo, type FC } from 'react';
import { cn } from '@/lib/utils';

/* ── Types ──────────────────────────────────────────────── */

interface DiffLine {
  type: 'add' | 'remove' | 'context' | 'hunk-header';
  content: string;
  oldLineNum?: number;
  newLineNum?: number;
}

interface DiffViewProps {
  diff: string;
  filePath?: string;
}

/* ── Parser ─────────────────────────────────────────────── */

function parseDiff(raw: string): DiffLine[] {
  const lines: DiffLine[] = [];
  let oldLine = 0;
  let newLine = 0;

  for (const line of raw.split('\n')) {
    // Skip diff metadata lines
    if (line.startsWith('diff --git') || line.startsWith('index ') || line.startsWith('---') || line.startsWith('+++') || line.startsWith('new file') || line.startsWith('deleted file') || line.startsWith('old mode') || line.startsWith('new mode')) {
      continue;
    }

    // Hunk header
    const hunkMatch = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)/);
    if (hunkMatch) {
      oldLine = parseInt(hunkMatch[1], 10);
      newLine = parseInt(hunkMatch[2], 10);
      lines.push({ type: 'hunk-header', content: line });
      continue;
    }

    if (line.startsWith('+')) {
      lines.push({ type: 'add', content: line.slice(1), newLineNum: newLine });
      newLine++;
    } else if (line.startsWith('-')) {
      lines.push({ type: 'remove', content: line.slice(1), oldLineNum: oldLine });
      oldLine++;
    } else if (line.startsWith(' ') || line === '') {
      lines.push({ type: 'context', content: line.slice(1) || '', oldLineNum: oldLine, newLineNum: newLine });
      oldLine++;
      newLine++;
    }
  }

  return lines;
}

/* ── Styles per line type ───────────────────────────────── */

const LINE_STYLES: Record<DiffLine['type'], { bg: string; text: string; gutter: string; prefix: string }> = {
  add:           { bg: 'bg-emerald-500/8',  text: 'text-emerald-300', gutter: 'text-emerald-500/40', prefix: '+' },
  remove:        { bg: 'bg-red-500/8',      text: 'text-red-300',     gutter: 'text-red-500/40',     prefix: '-' },
  context:       { bg: '',                   text: 'text-foreground/70', gutter: 'text-muted-foreground/30', prefix: ' ' },
  'hunk-header': { bg: 'bg-blue-500/5',     text: 'text-blue-400/70', gutter: 'text-blue-400/30',    prefix: '' },
};

/* ── Component ──────────────────────────────────────────── */

export const DiffView: FC<DiffViewProps> = ({ diff, filePath }) => {
  const lines = useMemo(() => parseDiff(diff), [diff]);

  // Stats
  const additions = lines.filter((l) => l.type === 'add').length;
  const deletions = lines.filter((l) => l.type === 'remove').length;

  if (!diff.trim()) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground/50">
        No changes
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* File header */}
      {filePath && (
        <div className="flex items-center justify-between border-b border-border/40 bg-muted/10 px-4 py-2">
          <span className="font-mono text-xs text-foreground/80">{filePath}</span>
          <div className="flex items-center gap-2 text-[10px] font-mono">
            {additions > 0 && <span className="text-emerald-400">+{additions}</span>}
            {deletions > 0 && <span className="text-red-400">-{deletions}</span>}
          </div>
        </div>
      )}

      {/* Diff lines */}
      <div className="flex-1 overflow-auto">
        <table className="w-full border-collapse font-mono text-xs leading-[1.6]">
          <tbody>
            {lines.map((line, i) => {
              const style = LINE_STYLES[line.type];

              if (line.type === 'hunk-header') {
                return (
                  <tr key={i} className={style.bg}>
                    <td colSpan={4} className={cn('px-4 py-1 text-[10px]', style.text)}>
                      {line.content}
                    </td>
                  </tr>
                );
              }

              return (
                <tr key={i} className={cn(style.bg, 'hover:brightness-110')}>
                  {/* Old line number */}
                  <td className={cn('w-[1px] select-none whitespace-nowrap px-2 text-right text-[10px]', style.gutter)}>
                    {line.oldLineNum ?? ''}
                  </td>
                  {/* New line number */}
                  <td className={cn('w-[1px] select-none whitespace-nowrap px-2 text-right text-[10px] border-r border-border/20', style.gutter)}>
                    {line.newLineNum ?? ''}
                  </td>
                  {/* Prefix */}
                  <td className={cn('w-[1px] select-none whitespace-nowrap pl-3 pr-1', style.text)}>
                    {style.prefix}
                  </td>
                  {/* Content */}
                  <td className={cn('whitespace-pre-wrap break-all pr-4', style.text)}>
                    {line.content || '\u00A0'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
};
