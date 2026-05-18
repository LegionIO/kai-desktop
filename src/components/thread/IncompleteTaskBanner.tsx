import { useCallback, useEffect } from 'react';
import type { FC } from 'react';
import { AlertTriangleIcon, SettingsIcon, XIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Tooltip } from '@/components/ui/Tooltip';

export interface IncompleteTaskBannerProps {
  conversationId: string;
  currentStep: number;
  maxSteps: number;
  onContinue: () => void;
  onAdjustSettings: () => void;
  onDismiss: () => void;
  className?: string;
}

/**
 * IncompleteTaskBanner appears when the agent hits the maxSteps limit mid-task.
 * 
 * Features:
 * - Clear warning message explaining the situation
 * - [Continue Task] button to resume (Cmd/Ctrl + Enter)
 * - [Adjust Settings] button to open settings
 * - [Dismiss] button to hide banner
 * - Keyboard shortcut support
 */
export const IncompleteTaskBanner: FC<IncompleteTaskBannerProps> = ({
  conversationId,
  currentStep,
  maxSteps,
  onContinue,
  onAdjustSettings,
  onDismiss,
  className,
}) => {
  // Keyboard shortcut: Cmd/Ctrl + Enter to continue
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        onContinue();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onContinue]);

  const handleContinue = useCallback(() => {
    console.info(`[IncompleteTaskBanner] Continue clicked for conversation ${conversationId}`);
    onContinue();
  }, [conversationId, onContinue]);

  const handleAdjustSettings = useCallback(() => {
    console.info(`[IncompleteTaskBanner] Adjust settings clicked for conversation ${conversationId}`);
    onAdjustSettings();
  }, [conversationId, onAdjustSettings]);

  const handleDismiss = useCallback(() => {
    console.info(`[IncompleteTaskBanner] Dismissed for conversation ${conversationId}`);
    onDismiss();
  }, [conversationId, onDismiss]);

  return (
    <div
      className={cn(
        'animate-slideDown flex items-start gap-4 rounded-lg border border-amber-500/50 bg-amber-50 dark:bg-amber-950/30 p-4 shadow-sm',
        className
      )}
      role="alert"
      aria-live="polite"
    >
      {/* Warning Icon */}
      <div className="flex-shrink-0 mt-0.5">
        <AlertTriangleIcon className="h-5 w-5 text-amber-600 dark:text-amber-400" />
      </div>

      {/* Content */}
      <div className="flex-1 space-y-3">
        {/* Message */}
        <div className="space-y-1">
          <h3 className="text-sm font-semibold text-amber-900 dark:text-amber-100">
            Task incomplete - step limit reached
          </h3>
          <p className="text-sm text-amber-800 dark:text-amber-200">
            I reached the maximum number of steps ({currentStep}/{maxSteps}) before completing your request.
            You can continue where I left off or adjust the step limit in settings.
          </p>
        </div>

        {/* Actions */}
        <div className="flex flex-wrap gap-2">
          {/* Continue Button */}
          <Tooltip content="Press Cmd/Ctrl + Enter" side="bottom">
            <button
              onClick={handleContinue}
              className={cn(
                'inline-flex items-center justify-center gap-2 rounded-md px-4 py-2 text-sm font-medium',
                'bg-amber-600 text-white hover:bg-amber-700',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-2',
                'transition-colors duration-200'
              )}
            >
              Continue Task
            </button>
          </Tooltip>

          {/* Adjust Settings Button */}
          <button
            onClick={handleAdjustSettings}
            className={cn(
              'inline-flex items-center justify-center gap-2 rounded-md px-4 py-2 text-sm font-medium',
              'border border-amber-600 text-amber-700 dark:text-amber-300 hover:bg-amber-100 dark:hover:bg-amber-950/50',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-2',
              'transition-colors duration-200'
            )}
          >
            <SettingsIcon className="h-4 w-4" />
            Adjust Settings
          </button>

          {/* Dismiss Button */}
          <button
            onClick={handleDismiss}
            className={cn(
              'inline-flex items-center justify-center gap-2 rounded-md px-3 py-2 text-sm font-medium',
              'text-amber-700 dark:text-amber-300 hover:bg-amber-100 dark:hover:bg-amber-950/50',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-2',
              'transition-colors duration-200'
            )}
            aria-label="Dismiss"
          >
            <XIcon className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
};
