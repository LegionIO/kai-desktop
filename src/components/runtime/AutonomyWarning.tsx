import type { FC } from 'react';
import { TriangleAlertIcon } from 'lucide-react';

/**
 * Shown wherever a runtime that lacks per-action approval
 * (`RuntimeCapabilities.perActionApproval === false`) can be selected. Such a
 * runtime executes shell commands and file edits autonomously — Kai cannot
 * interpose an approval prompt per action — so the warning is derived from the
 * capability flag rather than special-cased per runtime id (keeps every
 * selection surface consistent and rot-free).
 */
export const AutonomyWarning: FC<{ className?: string }> = ({ className }) => (
  <p
    role="note"
    className={`flex items-start gap-1.5 rounded-md border border-amber-500/30 bg-amber-500/5 px-2 py-1.5 text-[10px] text-amber-700 dark:text-amber-400 ${className ?? ''}`}
  >
    <TriangleAlertIcon size={12} className="mt-px shrink-0" />
    <span>
      Runs autonomously: it executes shell commands and edits files in your working directory{' '}
      <strong>without per-action approval</strong>.
    </span>
  </p>
);
