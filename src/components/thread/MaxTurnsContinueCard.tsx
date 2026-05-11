import { type FC, useCallback } from 'react';
import { PlayIcon, CheckIcon } from 'lucide-react';
import { useMaxTurnsContinue } from '@/providers/RuntimeProvider';

interface MaxTurnsContinueCardProps {
  part: { type: 'max-turns-reached'; text: string; status: 'pending' | 'continued' };
  messageId: string;
}

export const MaxTurnsContinueCard: FC<MaxTurnsContinueCardProps> = ({ part, messageId }) => {
  const handleContinue = useMaxTurnsContinue();

  const onContinue = useCallback(() => {
    handleContinue?.(messageId);
  }, [handleContinue, messageId]);

  if (part.status === 'continued') {
    return (
      <div className="ml-1 mt-2 rounded-xl border border-border/50 bg-muted/20 p-3">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <CheckIcon className="h-3 w-3" />
          <span>Continued</span>
        </div>
      </div>
    );
  }

  return (
    <div className="ml-1 mt-2 rounded-xl border border-primary/30 bg-primary/5 p-3 space-y-2">
      <div className="flex items-center gap-2">
        <PlayIcon className="h-3.5 w-3.5 shrink-0 text-primary" />
        <span className="text-[11px] text-muted-foreground">{part.text}</span>
      </div>
      <button
        type="button"
        onClick={onContinue}
        className="rounded-lg bg-primary px-3 py-1.5 text-[11px] font-medium text-primary-foreground transition-colors hover:bg-primary/90"
      >
        Continue
      </button>
    </div>
  );
};
