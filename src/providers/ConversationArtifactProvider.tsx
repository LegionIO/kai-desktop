import type { FC, PropsWithChildren } from 'react';
import { ArtifactProvider } from './ArtifactProvider';
import { useRuntimeConversationId } from './RuntimeProvider';

/** Keep artifact-producing message cards aligned with the selected conversation. */
export const ConversationArtifactProvider: FC<PropsWithChildren<{ conversationId: string | null }>> = ({
  conversationId,
  children,
}) => {
  const loadedConversationId = useRuntimeConversationId();

  // Selection changes before the async message load completes. Mounting the new
  // artifact store with the old message tree would copy old previews into it.
  if (loadedConversationId !== conversationId) {
    return (
      <div role="status" className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Loading chat…
      </div>
    );
  }

  return <ArtifactProvider key={conversationId}>{children}</ArtifactProvider>;
};
