import { useState, useEffect, useRef, type FC } from 'react';
import { XIcon, PlayIcon, TerminalIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { WorkspaceTerminal, TerminalStatus } from '../../../shared/workspace-types';

/* ── Status badge config ────────────────────────────────────── */

const STATUS_CONFIG: Record<TerminalStatus, { label: string; dotClass: string; textClass: string }> = {
  idle:      { label: 'Idle',      dotClass: 'bg-muted-foreground/50',           textClass: 'text-muted-foreground' },
  running:   { label: 'Running',   dotClass: 'bg-blue-400 animate-pulse',       textClass: 'text-blue-400' },
  completed: { label: 'Completed', dotClass: 'bg-emerald-400',                  textClass: 'text-emerald-400' },
  failed:    { label: 'Failed',    dotClass: 'bg-red-400',                      textClass: 'text-red-400' },
};

/* ── Simulated build output ─────────────────────────────────── */

function getSimulatedOutput(projectPath: string): string[] {
  const dir = projectPath || '~/project';
  return [
    `$ cd ${dir}`,
    '$ npm run build',
    '',
    '> building...',
    '> Compiling TypeScript...',
    '> Processing 47 source files...',
    '> Resolving module dependencies...',
    '> Bundling with tree-shaking enabled...',
    `> ✓ 234 modules compiled successfully`,
    '> Bundle size: 1.2MB (gzipped: 380KB)',
    '> Build completed in 3.2s',
  ];
}

/* ── Uptime helper ──────────────────────────────────────────── */

function formatUptime(createdAt: number): string {
  const diff = Math.max(0, Math.floor((Date.now() - createdAt) / 1000));
  const mins = Math.floor(diff / 60);
  const secs = diff % 60;
  if (mins < 1) return `${secs}s`;
  if (mins < 60) return `${mins}m ${secs}s`;
  const hours = Math.floor(mins / 60);
  return `${hours}h ${mins % 60}m`;
}

/* ── Component ──────────────────────────────────────────────── */

interface TerminalPanelProps {
  terminal: WorkspaceTerminal;
  projectPath?: string;
  onClose: () => void;
  onStatusChange: (status: TerminalStatus) => void;
  onOutputUpdate: (lines: string[]) => void;
}

export const TerminalPanel: FC<TerminalPanelProps> = ({
  terminal,
  projectPath,
  onClose,
  onStatusChange,
  onOutputUpdate,
}) => {
  const cfg = STATUS_CONFIG[terminal.status];
  const [uptime, setUptime] = useState(() => formatUptime(terminal.createdAt));
  const outputRef = useRef<HTMLDivElement>(null);

  // Tick uptime every second while running
  useEffect(() => {
    if (terminal.status !== 'running') {
      setUptime(formatUptime(terminal.createdAt));
      return;
    }
    const interval = setInterval(() => setUptime(formatUptime(terminal.createdAt)), 1000);
    return () => clearInterval(interval);
  }, [terminal.status, terminal.createdAt]);

  // Simulate build output when status becomes 'running'
  useEffect(() => {
    if (terminal.status !== 'running') return;

    const lines = getSimulatedOutput(projectPath ?? '');
    let lineIndex = 0;

    // Start with an empty output
    onOutputUpdate([]);

    const interval = setInterval(() => {
      if (lineIndex < lines.length) {
        const nextLine = lines[lineIndex];
        lineIndex++;
        onOutputUpdate(lines.slice(0, lineIndex));

        // Auto-scroll
        requestAnimationFrame(() => {
          if (outputRef.current) {
            outputRef.current.scrollTop = outputRef.current.scrollHeight;
          }
        });
      } else {
        clearInterval(interval);
        onStatusChange('completed');
      }
    }, 500);

    return () => clearInterval(interval);
    // Only trigger on status change to running, not on every render
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminal.status === 'running' ? 'running' : 'other']);

  const handleRun = () => {
    onStatusChange('running');
  };

  return (
    <div className="flex flex-col overflow-hidden rounded-xl border border-border/60 bg-card/80">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border/40 px-3 py-2">
        <div className="flex items-center gap-2 min-w-0">
          <TerminalIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
          <span className="truncate text-xs font-medium text-foreground">{terminal.title}</span>
          {terminal.taskId && (
            <span className="truncate rounded bg-primary/10 px-1.5 py-0.5 text-[9px] font-medium text-primary">
              Task linked
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {/* Status badge */}
          <span className={cn('inline-flex items-center gap-1.5 text-[10px] font-medium', cfg.textClass)}>
            <span className={cn('h-1.5 w-1.5 rounded-full', cfg.dotClass)} />
            {cfg.label}
          </span>
          {/* Close button */}
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-0.5 text-muted-foreground/40 transition-colors hover:bg-muted/30 hover:text-muted-foreground"
          >
            <XIcon className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* Body */}
      <div ref={outputRef} className="relative flex min-h-[180px] flex-1 flex-col bg-black/40 p-3 font-mono text-xs">
        {terminal.status === 'idle' ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3">
            <span className="text-muted-foreground/50">Ready</span>
            <button
              type="button"
              onClick={handleRun}
              className="inline-flex items-center gap-1.5 rounded-lg bg-primary/10 px-3 py-1.5 text-[11px] font-medium text-primary transition-colors hover:bg-primary/20"
            >
              <PlayIcon className="h-3 w-3" />
              Run
            </button>
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto whitespace-pre-wrap text-muted-foreground/80 leading-relaxed">
            {terminal.output.map((line, i) => (
              <div key={i} className={cn(
                line.startsWith('> ✓') ? 'text-emerald-400' :
                line.startsWith('$') ? 'text-primary' :
                line.startsWith('> Bundle') || line.startsWith('> Build completed') ? 'text-emerald-400/80' :
                undefined
              )}>
                {line}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Status bar */}
      <div className="flex items-center justify-between border-t border-border/30 bg-muted/5 px-3 py-1">
        <span className="text-[9px] font-mono text-muted-foreground/40">{terminal.id}</span>
        <span className="text-[9px] font-mono text-muted-foreground/40">{uptime}</span>
      </div>
    </div>
  );
};
