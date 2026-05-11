/**
 * TaskTerminal — renders an xterm.js terminal for a task's agent session.
 */

import { type FC } from 'react';
import { cn } from '@/lib/utils';
import { useTaskTerminal } from '@/hooks/useTaskTerminal';

interface TaskTerminalProps {
  sessionId: string;
  onExit?: (exitCode: number) => void;
  /** Override container classes (default: fixed h-64) */
  className?: string;
}

export const TaskTerminal: FC<TaskTerminalProps> = ({ sessionId, onExit, className }) => {
  const { containerRef } = useTaskTerminal({ sessionId, onExit });

  return (
    <div className={cn('h-64 w-full overflow-hidden rounded-lg border border-border/50 bg-[#1a1a2e]', className)}>
      <div ref={containerRef} className="h-full w-full" />
    </div>
  );
};
