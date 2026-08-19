export type ConversationCleanupWarning = {
  code: 'browser-cleanup-failed';
  conversationIds: string[];
  browserScopeKeys: string[];
};

export type ConversationDeleteResult = {
  ok: boolean;
  error?: 'delete-failed' | 'native-browser-authority-required';
  warnings?: ConversationCleanupWarning[];
};

export type ConversationDeleteManyResult = ConversationDeleteResult & {
  deleted?: number;
  removedIds?: string[];
};

export type ConversationClearResult = ConversationDeleteResult;
