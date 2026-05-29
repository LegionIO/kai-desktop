/**
 * HumanReviewActions — inline approve/reject widget for tasks in human_review.
 *
 * Shows Approve + Request Changes buttons. When "Request Changes" is clicked,
 * expands an inline textarea for feedback (no window.prompt — Electron doesn't support it).
 * Usable in TaskDetailPanel, TaskDetailModal, and anywhere a task in human_review is shown.
 */

import { type FC, useState, useRef, useEffect } from 'react';
import { CheckIcon, RotateCcwIcon, SendHorizonalIcon, XIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { app } from '@/lib/ipc-client';

interface HumanReviewActionsProps {
  taskId: string;
  onApprove: () => void;
  /** Compact mode for modals/context menus — smaller spacing */
  compact?: boolean;
  className?: string;
}

export const HumanReviewActions: FC<HumanReviewActionsProps> = ({ taskId, onApprove, compact, className }) => {
  const [showFeedback, setShowFeedback] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (showFeedback) {
      setTimeout(() => textareaRef.current?.focus(), 50);
    }
  }, [showFeedback]);

  // Check for pending request-changes signal on mount (after first paint)
  useEffect(() => {
    const pending = (window as unknown as Record<string, unknown>).__pendingRequestChanges;
    if (pending === taskId) {
      (window as unknown as Record<string, unknown>).__pendingRequestChanges = undefined;
      setShowFeedback(true);
    }
  }, [taskId]);

  // Listen for auto-expand event (for already-mounted instances)
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as string;
      if (detail === taskId) {
        setShowFeedback(true);
      }
    };
    window.addEventListener('kai:request-changes-focus', handler);
    return () => window.removeEventListener('kai:request-changes-focus', handler);
  }, [taskId]);

  const handleRequestChanges = async () => {
    if (!feedback.trim()) return;
    setIsSubmitting(true);
    try {
      await app.tasks.kickBack(taskId, feedback.trim(), 'human');
      setFeedback('');
      setShowFeedback(false);
    } catch (err) {
      console.error('[HumanReviewActions] kickBack failed:', err);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className={cn('rounded-xl border border-purple-400/30 bg-purple-400/5 p-4', compact && 'p-3', className)}>
      {!compact && (
        <>
          <div className="mb-2 flex items-center gap-2">
            <span className="text-xs font-semibold uppercase tracking-wide text-purple-400">Human Review Required</span>
          </div>
          <p className="mb-3 text-sm text-muted-foreground">
            Review the agent&apos;s work. Approve to mark as done, or request changes with feedback.
          </p>
        </>
      )}

      {!showFeedback ? (
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onApprove}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 font-medium text-white transition-colors hover:bg-emerald-500',
              compact ? 'px-3 py-1.5 text-xs' : 'px-4 py-2 text-sm',
            )}
          >
            <CheckIcon className={cn(compact ? 'h-3 w-3' : 'h-4 w-4')} />
            Approve
          </button>
          <button
            type="button"
            onClick={() => setShowFeedback(true)}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-lg border border-border/60 bg-muted/40 font-medium text-foreground transition-colors hover:bg-muted/70',
              compact ? 'px-3 py-1.5 text-xs' : 'px-4 py-2 text-sm',
            )}
          >
            <RotateCcwIcon className={cn(compact ? 'h-3 w-3' : 'h-4 w-4')} />
            Request Changes
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <textarea
            ref={textareaRef}
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void handleRequestChanges();
              }
              if (e.key === 'Escape') {
                setShowFeedback(false);
                setFeedback('');
              }
            }}
            placeholder="What changes are needed?"
            rows={3}
            className={cn(
              'w-full resize-none rounded-lg border border-border/60 bg-background/80 px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/60 focus:border-purple-400/50 focus:outline-none focus:ring-1 focus:ring-purple-400/30',
            )}
          />
          <div className="flex items-center justify-between">
            <span className="text-[10px] text-muted-foreground/50">
              {navigator.platform.includes('Mac') ? '⌘' : 'Ctrl'}+Enter to submit
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  setShowFeedback(false);
                  setFeedback('');
                }}
                className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted/60"
              >
                <XIcon className="h-3 w-3" />
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handleRequestChanges()}
                disabled={!feedback.trim() || isSubmitting}
                className="inline-flex items-center gap-1 rounded-md bg-purple-500 px-3 py-1 text-xs font-medium text-white transition-colors hover:bg-purple-400 disabled:opacity-50"
              >
                <SendHorizonalIcon className="h-3 w-3" />
                {isSubmitting ? 'Sending...' : 'Send'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
