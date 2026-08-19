import { afterEach, describe, expect, it, vi } from 'vitest';
import { installAppBridgeStub, uninstallAppBridgeStub } from '../../../test-utils/app-bridge-stub';
import {
  BROWSER_AUTHORITY_CONTINUATION_MESSAGE,
  CONVERSATION_WRITE_WARNING_EVENT,
  putConversationChecked,
  surfaceConversationDeleteFailure,
  type ConversationWriteWarningDetail,
} from '../conversation-writes';

afterEach(() => uninstallAppBridgeStub());

describe('putConversationChecked', () => {
  it('distinguishes Browser-authority rejection from persistence and surfaces desktop guidance', async () => {
    const put = vi.fn(async () => ({ rejected: 'native-browser-authority-required' }));
    installAppBridgeStub({ conversations: { put } });
    const warnings: ConversationWriteWarningDetail[] = [];
    const listener = (event: Event) => warnings.push((event as CustomEvent<ConversationWriteWarningDetail>).detail);
    window.addEventListener(CONVERSATION_WRITE_WARNING_EVENT, listener);

    try {
      const result = await putConversationChecked({ id: 'browser-owned' });
      expect(result).toEqual({ persisted: false, rejected: 'native-browser-authority-required' });
      expect(put).toHaveBeenCalledWith({ id: 'browser-owned' });
      expect(warnings).toEqual([
        {
          message: BROWSER_AUTHORITY_CONTINUATION_MESSAGE,
          rejected: 'native-browser-authority-required',
        },
      ]);
    } finally {
      window.removeEventListener(CONVERSATION_WRITE_WARNING_EVENT, listener);
    }
  });

  it('reports an admitted write as persisted without surfacing a warning', async () => {
    installAppBridgeStub({ conversations: { put: vi.fn(async () => ({ ok: true })) } });
    const listener = vi.fn();
    window.addEventListener(CONVERSATION_WRITE_WARNING_EVENT, listener);
    try {
      await expect(putConversationChecked({ id: 'chat' })).resolves.toEqual({ persisted: true });
      expect(listener).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener(CONVERSATION_WRITE_WARNING_EVENT, listener);
    }
  });
});

describe('surfaceConversationDeleteFailure', () => {
  it('surfaces Browser-authority failures with native desktop continuation guidance', () => {
    const warnings: ConversationWriteWarningDetail[] = [];
    const listener = (event: Event) => warnings.push((event as CustomEvent<ConversationWriteWarningDetail>).detail);
    window.addEventListener(CONVERSATION_WRITE_WARNING_EVENT, listener);

    try {
      expect(surfaceConversationDeleteFailure({ ok: false, error: 'native-browser-authority-required' })).toBe(true);
      expect(warnings).toEqual([
        {
          message: BROWSER_AUTHORITY_CONTINUATION_MESSAGE,
          rejected: 'native-browser-authority-required',
        },
      ]);
      expect(surfaceConversationDeleteFailure({ ok: true })).toBe(false);
      expect(warnings).toHaveLength(1);
    } finally {
      window.removeEventListener(CONVERSATION_WRITE_WARNING_EVENT, listener);
    }
  });
});
