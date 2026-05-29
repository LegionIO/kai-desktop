/**
 * BlockTaskActions — inline widget for blocking a task with a reason,
 * and for viewing/editing the current block reason.
 *
 * Two modes:
 * 1. "Block" mode: shown when a user wants to move a task to blocked (from context menu or button)
 * 2. "View/Edit" mode: shown in the detail panel when task is already blocked
 */

import { type FC, useState, useRef, useEffect } from 'react';
import { AlertTriangleIcon, SendHorizonalIcon, XIcon, PencilIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { app } from '@/lib/ipc-client';

interface BlockTaskActionsProps {
  taskId: string;
  /** Current block reason (for view/edit mode). */
  currentReason?: string;
  /** When true, shows the "block this task" prompt. When false, shows view/edit of existing reason. */
  mode: 'block' | 'view';
  /** Called after successfully blocking (so parent can close modal etc). */
  onBlocked?: () => void;
  className?: string;
}

export const BlockTaskActions: FC<BlockTaskActionsProps> = ({ taskId, currentReason, mode, onBlocked, className }) => {
  const [reason, setReason] = useState(currentReason ?? '');
  const [isEditing, setIsEditing] = useState(mode === 'block');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (isEditing) {
      setTimeout(() => textareaRef.current?.focus(), 50);
    }
  }, [isEditing]);

  const handleBlock = async () => {
    if (!reason.trim()) return;
    setIsSubmitting(true);
    try {
      // Use updateTask to set status + add review note with block reason
      await app.tasks.update(taskId, {
        status: 'blocked',
        reviewNotes: [
          ...((await app.tasks.get(taskId))?.reviewNotes ?? []),
          {
            source: 'human' as const,
            content: reason.trim(),
            timestamp: new Date().toISOString(),
            fromStatus: 'in_progress' as const,
          },
        ],
      });
      setIsEditing(false);
      onBlocked?.();
    } catch (err) {
      console.error('[BlockTaskActions] Failed to block task:', err);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleUpdateReason = async () => {
    if (!reason.trim()) return;
    setIsSubmitting(true);
    try {
      const task = await app.tasks.get(taskId);
      if (!task) return;
      // Replace the last block-related review note, or append a new one
      const notes = [...(task.reviewNotes ?? [])];
      const lastBlockNote = [...notes]
        .reverse()
        .find((n) => n.fromStatus === 'in_progress' || n.content.toLowerCase().includes('block'));
      if (lastBlockNote) {
        lastBlockNote.content = reason.trim();
        lastBlockNote.timestamp = new Date().toISOString();
      } else {
        notes.push({
          source: 'human' as const,
          content: reason.trim(),
          timestamp: new Date().toISOString(),
          fromStatus: 'blocked' as const,
        });
      }
      await app.tasks.update(taskId, { reviewNotes: notes });
      setIsEditing(false);
    } catch (err) {
      console.error('[BlockTaskActions] Failed to update block reason:', err);
    } finally {
      setIsSubmitting(false);
    }
  };

  // View mode — show current reason with edit button
  if (mode === 'view' && !isEditing) {
    return (
      <div className={cn('rounded-xl border border-amber-500/30 bg-amber-500/5 p-4', className)}>
        <div className="mb-2 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <AlertTriangleIcon className="h-4 w-4 text-amber-500" />
            <span className="text-xs font-semibold uppercase tracking-wide text-amber-500">Blocked</span>
          </div>
          <button
            type="button"
            onClick={() => setIsEditing(true)}
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
          >
            <PencilIcon className="h-3 w-3" />
            Edit
          </button>
        </div>
        <p className="text-sm text-foreground/80">{currentReason || 'No reason specified'}</p>
      </div>
    );
  }

  // Block/Edit mode — textarea for entering/editing reason
  return (
    <div className={cn('rounded-xl border border-amber-500/30 bg-amber-500/5 p-4', className)}>
      <div className="mb-2 flex items-center gap-2">
        <AlertTriangleIcon className="h-4 w-4 text-amber-500" />
        <span className="text-xs font-semibold uppercase tracking-wide text-amber-500">
          {mode === 'block' ? 'Block Task' : 'Edit Block Reason'}
        </span>
      </div>
      <div className="flex flex-col gap-2">
        <textarea
          ref={textareaRef}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void (mode === 'block' ? handleBlock() : handleUpdateReason());
            }
            if (e.key === 'Escape') {
              if (mode === 'view') setIsEditing(false);
              onBlocked?.();
            }
          }}
          placeholder="Why is this task blocked?"
          rows={2}
          className="w-full resize-none rounded-lg border border-border/60 bg-background/80 px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/60 focus:border-amber-400/50 focus:outline-none focus:ring-1 focus:ring-amber-400/30"
        />
        <div className="flex items-center justify-between">
          <span className="text-[10px] text-muted-foreground/50">
            {navigator.platform.includes('Mac') ? '⌘' : 'Ctrl'}+Enter to submit
          </span>
          <div className="flex items-center gap-2">
            {(mode === 'view' || onBlocked) && (
              <button
                type="button"
                onClick={() => {
                  if (mode === 'view') setIsEditing(false);
                  else onBlocked?.();
                }}
                className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted/60"
              >
                <XIcon className="h-3 w-3" />
                Cancel
              </button>
            )}
            <button
              type="button"
              onClick={() => void (mode === 'block' ? handleBlock() : handleUpdateReason())}
              disabled={!reason.trim() || isSubmitting}
              className="inline-flex items-center gap-1 rounded-md bg-amber-600 px-3 py-1 text-xs font-medium text-white transition-colors hover:bg-amber-500 disabled:opacity-50"
            >
              <SendHorizonalIcon className="h-3 w-3" />
              {isSubmitting ? 'Saving...' : mode === 'block' ? 'Block' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
