import { app } from '@/lib/ipc-client';

export const CONVERSATION_WRITE_WARNING_EVENT = 'kai:conversation-write-warning';
export const BROWSER_AUTHORITY_CONTINUATION_MESSAGE =
  'Continue this Browser-assisted turn from the active Kai desktop window.';

export type ConversationWriteWarningDetail = {
  message: string;
  rejected?: string;
};

export type CheckedConversationWriteResult = {
  persisted: boolean;
  rejected?: string;
  error?: unknown;
};

export function conversationWriteRejectionMessage(rejected: unknown): string | null {
  if (rejected === 'native-browser-authority-required' || rejected === 'native-browser-continuation-required') {
    return BROWSER_AUTHORITY_CONTINUATION_MESSAGE;
  }
  if (rejected === 'conversation-busy') return 'Compacting the conversation — wait for it to finish, then retry.';
  if (rejected === 'conversation-deleted') return 'This chat was deleted before the change could be saved.';
  return typeof rejected === 'string' && rejected ? `Kai could not save this chat change (${rejected}).` : null;
}

export function surfaceConversationWriteWarning(message: string, rejected?: string): void {
  window.dispatchEvent(
    new CustomEvent<ConversationWriteWarningDetail>(CONVERSATION_WRITE_WARNING_EVENT, {
      detail: { message, rejected },
    }),
  );
}

/** Surface failed conversation deletions through the same warning host used
 * for rejected writes. In particular, Browser-owned conversations must direct
 * the user back to the native desktop window instead of failing silently. */
export function surfaceConversationDeleteFailure(
  result: { ok?: boolean; error?: unknown } | null | undefined,
): boolean {
  if (result?.ok !== false) return false;
  const error = typeof result.error === 'string' ? result.error : undefined;
  const message =
    error === 'native-browser-authority-required'
      ? BROWSER_AUTHORITY_CONTINUATION_MESSAGE
      : 'Kai could not delete the requested chat.';
  surfaceConversationWriteWarning(message, error);
  return true;
}

/** Persist a full conversation record and explicitly distinguish a main-process
 * admission rejection from success. Metadata UI must not close, navigate, or
 * finalize optimistic state until this returns `persisted: true`. */
export async function putConversationChecked(
  conversation: unknown,
  options: { surfaceRejection?: boolean; surfaceError?: boolean } = {},
): Promise<CheckedConversationWriteResult> {
  try {
    const result = (await app.conversations.put(conversation)) as { rejected?: unknown; ok?: unknown } | null;
    const rejected = typeof result?.rejected === 'string' ? result.rejected : undefined;
    if (rejected) {
      const message = conversationWriteRejectionMessage(rejected);
      if (message && options.surfaceRejection !== false) surfaceConversationWriteWarning(message, rejected);
      return { persisted: false, rejected };
    }
    if (result?.ok === false) {
      const message = 'Kai could not save this chat change.';
      if (options.surfaceError !== false) surfaceConversationWriteWarning(message);
      return { persisted: false };
    }
    return { persisted: true };
  } catch (error) {
    if (options.surfaceError !== false) surfaceConversationWriteWarning('Kai could not save this chat change.');
    return { persisted: false, error };
  }
}
