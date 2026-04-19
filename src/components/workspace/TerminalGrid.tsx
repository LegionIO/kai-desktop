import { useState, useCallback, type FC } from 'react';
import { PlusIcon, TerminalIcon } from 'lucide-react';
import { generateId } from '@/lib/utils';
import type { WorkspaceTerminal, TerminalStatus } from '../../../shared/workspace-types';
import { TerminalPanel } from './TerminalPanel';

export const TerminalGrid: FC = () => {
  const [terminals, setTerminals] = useState<WorkspaceTerminal[]>([]);

  const addTerminal = useCallback(() => {
    const idx = terminals.length + 1;
    setTerminals((prev) => [
      ...prev,
      {
        id: generateId(),
        title: `Terminal ${idx}`,
        status: 'idle' as const,
        output: [],
        createdAt: Date.now(),
      },
    ]);
  }, [terminals.length]);

  const removeTerminal = useCallback((id: string) => {
    setTerminals((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const updateStatus = useCallback((id: string, status: TerminalStatus) => {
    setTerminals((prev) =>
      prev.map((t) =>
        t.id === id
          ? {
              ...t,
              status,
              output:
                status === 'running'
                  ? ['$ executing task...', '> Compiling workspace...', '> Running checks...']
                  : t.output,
            }
          : t,
      ),
    );
  }, []);

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border/70 px-5 py-3">
        <h2 className="text-sm font-semibold text-foreground">Terminals</h2>
        <button
          type="button"
          onClick={addTerminal}
          className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
        >
          <PlusIcon className="h-3.5 w-3.5" />
          New Terminal
        </button>
      </div>

      {/* Content */}
      {terminals.length === 0 ? (
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
          style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(400px, 1fr))', gap: '1rem', alignContent: 'start' }}
        >
          {terminals.map((terminal) => (
            <TerminalPanel
              key={terminal.id}
              terminal={terminal}
              onClose={() => removeTerminal(terminal.id)}
              onStatusChange={(status) => updateStatus(terminal.id, status)}
            />
          ))}
        </div>
      )}
    </div>
  );
};
