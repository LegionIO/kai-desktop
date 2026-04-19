import { useState, useEffect, type FC } from 'react';
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
  onClose: () => void;
  onStatusChange: (status: TerminalStatus) => void;
}

export const TerminalPanel: FC<TerminalPanelProps> = ({ terminal, onClose, onStatusChange }) => {
  const cfg = STATUS_CONFIG[terminal.status];
  const [uptime, setUptime] = useState(() => formatUptime(terminal.createdAt));

  // Tick uptime every second while running
  useEffect(() => {
    if (terminal.status !== 'running') {
      setUptime(formatUptime(terminal.createdAt));
      return;
    }
    const interval = setInterval(() => setUptime(formatUptime(terminal.createdAt)), 1000);
    return () => clearInterval(interval);
  }, [terminal.status, terminal.createdAt]);

  return (
    <div className="flex flex-col overflow-hidden rounded-xl border border-border/60 bg-card/80">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border/40 px-3 py-2">
        <div className="flex items-center gap-2 min-w-0">
          <TerminalIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
          <span className="truncate text-xs font-medium text-foreground">{terminal.title}</span>
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
      <div className="relative flex min-h-[180px] flex-1 flex-col bg-black/40 p-3 font-mono text-xs">
        {terminal.status === 'idle' ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3">
            <span className="text-muted-foreground/50">Ready</span>
            <button
              type="button"
              onClick={() => onStatusChange('running')}
              className="inline-flex items-center gap-1.5 rounded-lg bg-primary/10 px-3 py-1.5 text-[11px] font-medium text-primary transition-colors hover:bg-primary/20"
            >
              <PlayIcon className="h-3 w-3" />
              Run
            </button>
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto whitespace-pre-wrap text-muted-foreground/80 leading-relaxed">
            {terminal.output.join('\n')}
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
