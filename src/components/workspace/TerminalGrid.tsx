import { useState, useCallback, useMemo, type FC } from 'react';
import { PlusIcon, TerminalIcon, PlayIcon } from 'lucide-react';
import { generateId } from '@/lib/utils';
import { useWorkspace } from '@/providers/WorkspaceProvider';
import { app } from '@/lib/ipc-client';
import type { WorkspaceTerminal, TerminalStatus, WorkspaceTerminalInfo } from '../../../shared/workspace-types';
import { TerminalPanel } from './TerminalPanel';

export const TerminalGrid: FC = () => {
  const { project, tasks, workspaceTerminals } = useWorkspace();
  const [terminals, setTerminals] = useState<WorkspaceTerminal[]>([]);
  const [showTaskPicker, setShowTaskPicker] = useState(false);

  // Convert workspace (task-spawned) terminals into WorkspaceTerminal shape for display
  const taskSpawnedTerminals = useMemo<WorkspaceTerminal[]>(() => {
    return workspaceTerminals.map((wt: WorkspaceTerminalInfo) => ({
      id: wt.id,
      title: wt.taskTitle,
      taskId: wt.taskId,
      status: wt.status === 'running' ? 'running' as const : wt.status === 'completed' ? 'completed' as const : 'failed' as const,
      output: [],
      createdAt: Date.now(),
    }));
  }, [workspaceTerminals]);

  // Merge local terminals with task-spawned terminals (task-spawned first, deduplicate by id)
  const allTerminals = useMemo(() => {
    const localIds = new Set(terminals.map((t) => t.id));
    const taskTerminals = taskSpawnedTerminals.filter((t) => !localIds.has(t.id));
    return [...taskTerminals, ...terminals];
  }, [terminals, taskSpawnedTerminals]);

  // Track which terminal IDs were pre-spawned by task execution
  const preSpawnedIds = useMemo(() => {
    return new Set(workspaceTerminals.map((wt: WorkspaceTerminalInfo) => wt.id));
  }, [workspaceTerminals]);

  const addTerminal = useCallback((taskId?: string, taskTitle?: string) => {
    const idx = terminals.length + 1;
    const title = taskTitle ? `${taskTitle}` : `Terminal ${idx}`;
    const id = generateId();
    setTerminals((prev) => [
      ...prev,
      {
        id,
        title,
        taskId,
        status: 'idle' as const,
        output: [],
        createdAt: Date.now(),
      },
    ]);
    setShowTaskPicker(false);
  }, [terminals.length]);

  const removeTerminal = useCallback((id: string) => {
    setTerminals((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const updateStatus = useCallback((id: string, status: TerminalStatus) => {
    setTerminals((prev) =>
      prev.map((t) => (t.id === id ? { ...t, status } : t)),
    );

    // When a task-linked terminal starts running, send the task info after PTY spawns
    if (status === 'running') {
      setTerminals((prev) => {
        const terminal = prev.find((t) => t.id === id);
        if (terminal?.taskId) {
          const task = tasks.find((t) => t.id === terminal.taskId);
          if (task) {
            // Send task context to the PTY after it has time to spawn
            setTimeout(() => {
              app.pty.write(id, `echo "Task: ${task.title.replace(/"/g, '\\"')}"\r`);
            }, 600);
          }
        }
        return prev;
      });
    }
  }, [tasks]);

  const updateOutput = useCallback((id: string, output: string[]) => {
    setTerminals((prev) =>
      prev.map((t) => (t.id === id ? { ...t, output } : t)),
    );
  }, []);

  // Terminal counts
  const terminalCounts = useMemo(() => {
    const running = allTerminals.filter((t) => t.status === 'running').length;
    const total = allTerminals.length;
    const idle = allTerminals.filter((t) => t.status === 'idle').length;
    return { running, total, idle };
  }, [allTerminals]);

  // Run All idle terminals
  const handleRunAll = useCallback(() => {
    setTerminals((prev) =>
      prev.map((t) => (t.status === 'idle' ? { ...t, status: 'running' as const } : t)),
    );
  }, []);

  // Determine grid layout columns based on terminal count
  const gridColumns = useMemo(() => {
    const count = allTerminals.length;
    if (count <= 1) return 'repeat(1, 1fr)';
    if (count <= 2) return 'repeat(2, 1fr)';
    if (count <= 4) return 'repeat(2, 1fr)';
    if (count <= 6) return 'repeat(3, 1fr)';
    return 'repeat(auto-fill, minmax(400px, 1fr))';
  }, [allTerminals.length]);

  const activeTasks = tasks.filter((t) => t.status !== 'done');

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border/70 px-5 py-3">
        <div className="flex items-center gap-3">
          <h2 className="text-sm font-semibold text-foreground">Terminals</h2>
          {allTerminals.length > 0 && (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-border/40 bg-muted/20 px-2.5 py-0.5 text-[10px] font-medium text-muted-foreground">
              <span className="font-mono text-blue-400">{terminalCounts.running}</span>
              <span className="text-muted-foreground/40">running</span>
              <span className="text-muted-foreground/20">/</span>
              <span className="font-mono">{terminalCounts.total}</span>
              <span className="text-muted-foreground/40">total</span>
            </span>
          )}
        </div>
        <div className="relative flex items-center gap-2">
          {/* Run All button */}
          {terminalCounts.idle > 0 && (
            <button
              type="button"
              onClick={handleRunAll}
              className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-3 py-1.5 text-xs font-medium text-emerald-400 transition-colors hover:bg-emerald-500/15"
            >
              <PlayIcon className="h-3.5 w-3.5" />
              Run All ({terminalCounts.idle})
            </button>
          )}

          {activeTasks.length > 0 && (
            <div className="relative">
              <button
                type="button"
                onClick={() => setShowTaskPicker((prev) => !prev)}
                className="inline-flex items-center gap-1.5 rounded-lg border border-border/60 px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/30 hover:text-foreground"
              >
                <PlusIcon className="h-3.5 w-3.5" />
                From Task
              </button>
              {showTaskPicker && (
                <div className="absolute right-0 top-full z-20 mt-1 w-64 rounded-lg border border-border/60 bg-card shadow-lg">
                  <div className="border-b border-border/40 px-3 py-2">
                    <span className="text-[10px] font-medium text-muted-foreground">Link to task</span>
                  </div>
                  <div className="max-h-48 overflow-y-auto p-1">
                    {activeTasks.map((task) => (
                      <button
                        key={task.id}
                        type="button"
                        onClick={() => addTerminal(task.id, task.title)}
                        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-foreground transition-colors hover:bg-muted/20"
                      >
                        <span className="truncate">{task.title}</span>
                        <span className="shrink-0 text-[9px] text-muted-foreground/40">{task.status}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
          <button
            type="button"
            onClick={() => addTerminal()}
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            <PlusIcon className="h-3.5 w-3.5" />
            New Terminal
          </button>
        </div>
      </div>

      {/* Content */}
      {allTerminals.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
          <TerminalIcon className="h-10 w-10 text-muted-foreground/40" />
          <div>
            <p className="text-sm font-medium text-muted-foreground">No terminals running</p>
            <p className="mt-1 text-xs text-muted-foreground/60">
              Start a terminal to execute tasks
            </p>
          </div>
        </div>
      ) : (
        <div
          className="flex-1 overflow-y-auto p-4"
          style={{ display: 'grid', gridTemplateColumns: gridColumns, gap: '1rem', alignContent: 'start' }}
        >
          {allTerminals.map((terminal) => (
            <TerminalPanel
              key={terminal.id}
              terminal={terminal}
              projectPath={project?.path}
              preSpawned={preSpawnedIds.has(terminal.id)}
              onClose={() => removeTerminal(terminal.id)}
              onStatusChange={(status) => updateStatus(terminal.id, status)}
              onOutputUpdate={(lines) => updateOutput(terminal.id, lines)}
            />
          ))}
        </div>
      )}
    </div>
  );
};
