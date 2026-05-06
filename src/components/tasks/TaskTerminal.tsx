/**
 * TaskTerminal — renders an xterm.js terminal for a task's agent session.
 */

import { type FC } from 'react';
import { useTaskTerminal } from '@/hooks/useTaskTerminal';

interface TaskTerminalProps {
  sessionId: string;
  onExit?: (exitCode: number) => void;
}

export const TaskTerminal: FC<TaskTerminalProps> = ({ sessionId, onExit }) => {
  const { containerRef } = useTaskTerminal({ sessionId, onExit });

  return (
    <div className="h-64 w-full overflow-hidden rounded-lg border border-border/50 bg-[#1a1a2e]">
      <div ref={containerRef} className="h-full w-full" />
    </div>
  );
};
