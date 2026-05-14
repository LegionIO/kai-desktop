import { FC } from 'react';
import { AlertTriangleIcon, CheckCircleIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface StepProgressProps {
  currentStep: number;
  maxSteps: number;
  hitLimit?: boolean;
  className?: string;
}

/**
 * StepProgress component displays the current step progress during agent execution.
 * 
 * Behavior:
 * - Below 80% threshold: Shows compact "Steps: 12/25 ✓" indicator
 * - At 80-99%: Shows progress bar with warning icon
 * - At 100%: Shows "limit reached" message with alert styling
 */
export const StepProgress: FC<StepProgressProps> = ({
  currentStep,
  maxSteps,
  hitLimit = false,
  className,
}) => {
  const percentage = Math.min((currentStep / maxSteps) * 100, 100);
  const isNearLimit = percentage >= 80 && !hitLimit;
  const showProgressBar = isNearLimit || hitLimit;

  if (hitLimit) {
    return (
      <div
        className={cn(
          'flex items-center gap-2 rounded-md border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-sm',
          className
        )}
      >
        <AlertTriangleIcon className="h-4 w-4 text-amber-500" />
        <span className="text-amber-700 dark:text-amber-300">
          Step limit reached ({currentStep}/{maxSteps})
        </span>
      </div>
    );
  }

  if (showProgressBar) {
    return (
      <div className={cn('space-y-1.5', className)}>
        <div className="flex items-center justify-between text-xs">
          <div className="flex items-center gap-1.5">
            <AlertTriangleIcon className="h-3.5 w-3.5 text-amber-500" />
            <span className="text-muted-foreground">
              Steps: {currentStep}/{maxSteps}
            </span>
          </div>
          <span className="text-amber-600 dark:text-amber-400 font-medium">
            {Math.round(percentage)}%
          </span>
        </div>
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
          <div
            className={cn(
              'h-full transition-all duration-300',
              percentage >= 90
                ? 'bg-amber-500'
                : 'bg-blue-500'
            )}
            style={{ width: `${percentage}%` }}
          />
        </div>
      </div>
    );
  }

  // Compact display for normal operation (< 80%)
  return (
    <div className={cn('flex items-center gap-1.5 text-xs text-muted-foreground', className)}>
      <CheckCircleIcon className="h-3.5 w-3.5 text-green-500" />
      <span>
        Steps: {currentStep}/{maxSteps}
      </span>
    </div>
  );
};
