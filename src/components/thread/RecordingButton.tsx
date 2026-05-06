/**
 * RecordingButton — Simple mic-icon button that starts voice recording.
 *
 * All recording lifecycle management lives in the useVoiceRecording hook;
 * this component is just the trigger button shown in the composer toolbar.
 */

import type { FC } from 'react';
import { Tooltip } from '@/components/ui/Tooltip';
import { MicIcon } from 'lucide-react';

export interface RecordingButtonProps {
  onStart: () => void;
}

export const RecordingButton: FC<RecordingButtonProps> = ({ onStart }) => {
  return (
    <Tooltip content="Voice recording" side="top" sideOffset={8}>
      <button
        type="button"
        onClick={onStart}
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-border/50 bg-muted/40 transition-colors hover:bg-muted/60 text-muted-foreground"
      >
        <MicIcon className="h-4 w-4" />
      </button>
    </Tooltip>
  );
};
