/**
 * CallButton — Simple voice call button.
 *
 * Renders a phone icon button that starts a realtime voice call
 * on the active conversation. Device selection happens inside
 * the CallOverlay once the call is active, or in Audio Settings.
 */

import { useCallback, type FC } from 'react';
import { PhoneIcon } from 'lucide-react';
import { Tooltip } from '@/components/ui/Tooltip';
import { useRealtime } from '@/providers/RealtimeProvider';
import { app } from '@/lib/ipc-client';

export const CallButton: FC = () => {
  const { startCall } = useRealtime();

  const handleClick = useCallback(async () => {
    try {
      const id = await app.conversations.getActiveId() as string | null;
      if (id) {
        await startCall(id);
      }
    } catch (err) {
      console.error('[CallButton] Failed to start call:', err);
    }
  }, [startCall]);

  return (
    <Tooltip content="Voice call" side="top" sideOffset={8}>
      <button
        type="button"
        onClick={handleClick}
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-border/50 bg-muted/40 transition-colors hover:bg-muted/60 text-muted-foreground"
      >
        <PhoneIcon className="h-4 w-4" />
      </button>
    </Tooltip>
  );
};
