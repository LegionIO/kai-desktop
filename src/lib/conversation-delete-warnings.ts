import type { ConversationCleanupWarning } from '../../shared/conversation-delete';

export const CONVERSATION_CLEANUP_WARNING_EVENT = 'kai:conversation-cleanup-warning';

export type ConversationCleanupWarningDetail = {
  conversationIds: string[];
  browserScopeKeys: string[];
};

export function browserCleanupFailureIds(
  result: { warnings?: ConversationCleanupWarning[] } | null | undefined,
): string[] {
  return [
    ...new Set(
      (result?.warnings ?? [])
        .filter((warning) => warning.code === 'browser-cleanup-failed')
        .flatMap((warning) => warning.conversationIds)
        .filter(Boolean),
    ),
  ];
}

export function browserCleanupFailureScopeKeys(
  result: { warnings?: ConversationCleanupWarning[] } | null | undefined,
): string[] {
  return [
    ...new Set(
      (result?.warnings ?? [])
        .filter((warning) => warning.code === 'browser-cleanup-failed')
        .flatMap((warning) => warning.browserScopeKeys)
        .filter(Boolean),
    ),
  ];
}

export function surfaceConversationCleanupWarnings(
  result: { warnings?: ConversationCleanupWarning[] } | null | undefined,
): boolean {
  const conversationIds = browserCleanupFailureIds(result);
  const browserScopeKeys = browserCleanupFailureScopeKeys(result);
  if (conversationIds.length === 0) return false;
  window.dispatchEvent(
    new CustomEvent<ConversationCleanupWarningDetail>(CONVERSATION_CLEANUP_WARNING_EVENT, {
      detail: { conversationIds, browserScopeKeys },
    }),
  );
  return true;
}
