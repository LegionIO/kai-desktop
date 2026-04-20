import { useState, useEffect, useCallback, type FC } from 'react';
import { XIcon, PlayIcon, TerminalIcon, WrenchIcon, BotIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useWorkspace } from '@/providers/WorkspaceProvider';
import { app } from '@/lib/ipc-client';
import { XTerminal } from './XTerminal';
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
  projectPath?: string;
  /** When true, the PTY was already created externally (task execution) — XTerminal will attach instead of creating. */
  preSpawned?: boolean;
  onClose: () => void;
  onStatusChange: (status: TerminalStatus) => void;
  onOutputUpdate: (lines: string[]) => void;
}

export const TerminalPanel: FC<TerminalPanelProps> = ({
  terminal,
  projectPath,
  preSpawned,
  onClose,
  onStatusChange,
  onOutputUpdate,
}) => {
  const cfg = STATUS_CONFIG[terminal.status];
  const [uptime, setUptime] = useState(() => formatUptime(terminal.createdAt));
  const { tasks } = useWorkspace();

  // Resolve the task linked to this terminal (if any)
  const linkedTask = terminal.taskId ? tasks.find((t) => t.id === terminal.taskId) : undefined;

  // Tick uptime every second while running
  useEffect(() => {
    if (terminal.status !== 'running') {
      setUptime(formatUptime(terminal.createdAt));
      return;
    }
    const interval = setInterval(() => setUptime(formatUptime(terminal.createdAt)), 1000);
    return () => clearInterval(interval);
  }, [terminal.status, terminal.createdAt]);

  const handleRun = useCallback(() => {
    onStatusChange('running');
  }, [onStatusChange]);

  const handleRunWithAI = useCallback(() => {
    if (!linkedTask) return;
    onStatusChange('running');
    // After a short delay to let the PTY spawn, send the claude command
    setTimeout(() => {
      const escapedDesc = linkedTask.description.replace(/'/g, "'\\''");
      app.pty.write(terminal.id, `claude --print --task '${escapedDesc}'\r`);
    }, 500);
  }, [linkedTask, onStatusChange, terminal.id]);

  const handlePtyExit = useCallback((exitCode: number) => {
    onStatusChange(exitCode === 0 ? 'completed' : 'failed');
  }, [onStatusChange]);

  const handleClose = useCallback(() => {
    // Destroy PTY if running, then close
    if (terminal.status === 'running') {
      app.pty.destroy(terminal.id).catch(() => { /* ignore */ });
    }
    onClose();
  }, [terminal.status, terminal.id, onClose]);

  const effectiveCwd = projectPath || process.env.HOME || '/tmp';

  return (
    <div className="flex flex-col overflow-hidden rounded-xl border border-border/60 bg-card/80" style={{ minHeight: '240px' }}>
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
          {/* Run with AI button (only when idle and task is linked) */}
          {terminal.status === 'idle' && linkedTask && (
            <button
              type="button"
              onClick={handleRunWithAI}
              className="inline-flex items-center gap-1 rounded-md bg-purple-500/10 px-2 py-1 text-[10px] font-medium text-purple-400 transition-colors hover:bg-purple-500/20"
              title="Run with Claude AI"
            >
              <BotIcon className="h-3 w-3" />
              AI
            </button>
          )}
          {/* Status badge */}
          <span className={cn('inline-flex items-center gap-1.5 text-[10px] font-medium', cfg.textClass)}>
            <span className={cn('h-1.5 w-1.5 rounded-full', cfg.dotClass)} />
            {cfg.label}
          </span>
          {/* Close button */}
          <button
            type="button"
            onClick={handleClose}
            className="rounded-md p-0.5 text-muted-foreground/40 transition-colors hover:bg-muted/30 hover:text-muted-foreground"
          >
            <XIcon className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="relative flex min-h-0 flex-1 flex-col bg-[#0a0a0a]">
        {terminal.status === 'idle' ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 p-3">
            <span className="text-xs text-muted-foreground/50">Ready</span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleRun}
                className="inline-flex items-center gap-1.5 rounded-lg bg-primary/10 px-3 py-1.5 text-[11px] font-medium text-primary transition-colors hover:bg-primary/20"
              >
                <PlayIcon className="h-3 w-3" />
                Run
              </button>
              {linkedTask && (
                <button
                  type="button"
                  onClick={handleRunWithAI}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-purple-500/10 px-3 py-1.5 text-[11px] font-medium text-purple-400 transition-colors hover:bg-purple-500/20"
                >
                  <BotIcon className="h-3 w-3" />
                  Run with AI
                </button>
              )}
            </div>
          </div>
        ) : (
          <div className="flex-1" style={{ minHeight: '180px' }}>
            <XTerminal
              sessionId={terminal.id}
              cwd={effectiveCwd}
              preSpawned={preSpawned}
              onExit={handlePtyExit}
            />
          </div>
        )}
      </div>

      {/* Status bar */}
      <div className="flex items-center justify-between border-t border-border/30 bg-muted/5 px-3 py-1">
        <span className="text-[9px] font-mono text-muted-foreground/40">{terminal.id.slice(0, 8)}</span>
        <span className="text-[9px] font-mono text-muted-foreground/40">{uptime}</span>
      </div>
    </div>
  );
};
