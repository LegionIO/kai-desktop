import { describe, expect, it } from 'vitest';
import {
  assistantMayControlTab,
  assistantPopupOwner,
  browserActionHasTarget,
  browserActionRequiresTarget,
  hasBrowserPromptCapacity,
  shouldCleanupAssistantTab,
  shouldCloseDestroyedPopupTab,
  shouldCloseIdleAssistantTab,
  shouldDiscardBrowserTab,
  shouldFocusAttachedBrowserView,
  isTrustedUserNavigationCommit,
  isTrustedUserNavigationTarget,
  shouldRestrictPopupNetwork,
  shouldReleaseAiNetworkRestriction,
  shouldSerializeBrowserTabCommand,
  shouldBypassAiPolicyForTrustedUserNavigation,
  retainClosedTabsOutsideScopes,
} from '../lifecycle.js';

describe('browser lifecycle policy', () => {
  it('cleans assistant tabs at turn end unless the user keeps them open', () => {
    expect(shouldCleanupAssistantTab({ owner: 'assistant', keepOpen: false })).toBe(true);
    expect(shouldCleanupAssistantTab({ owner: 'assistant', keepOpen: true })).toBe(false);
    expect(shouldCleanupAssistantTab({ owner: 'user', keepOpen: false })).toBe(false);
    expect(shouldCleanupAssistantTab({ owner: 'assistant', keepOpen: false }, 'text-run', 'realtime-run')).toBe(false);
    expect(shouldCleanupAssistantTab({ owner: 'assistant', keepOpen: false }, 'text-run', 'text-run')).toBe(true);
  });

  it('retains the AI network guard for the full serialized operation and grace window', () => {
    expect(shouldReleaseAiNetworkRestriction(1, 0, 100, false)).toBe(false);
    expect(shouldReleaseAiNetworkRestriction(0, 200, 100, false)).toBe(false);
    expect(shouldReleaseAiNetworkRestriction(0, 100, 100, false)).toBe(true);
    expect(shouldReleaseAiNetworkRestriction(0, 100, 100, true)).toBe(false);
  });

  it('keeps temporary assistant tabs isolated to their owning run', () => {
    expect(assistantMayControlTab('user', null, 'run-b')).toBe(true);
    expect(assistantMayControlTab('assistant', 'run-a', 'run-a')).toBe(true);
    expect(assistantMayControlTab('assistant', 'run-a', 'run-b')).toBe(false);
    expect(assistantMayControlTab('assistant', 'run-a', 'run-b', true, true)).toBe(false);
    expect(assistantMayControlTab('assistant', 'run-a', 'run-b', true, false)).toBe(true);
    expect(assistantPopupOwner('assistant', 'run-a', 'run-a')).toBe('run-a');
    expect(assistantPopupOwner('user', null, 'run-a')).toBe('run-a');
    expect(assistantPopupOwner('user', null, 'run-a', 'assistant', 'run-a')).toBe('run-a');
    expect(assistantPopupOwner('user', null, 'run-a', 'user', null, true)).toBe('run-a');
    expect(assistantPopupOwner('user', null, 'run-a', null, null, true)).toBe('run-a');
    expect(assistantPopupOwner('user', null, 'run-a', null, null, false)).toBe('run-a');
    expect(assistantPopupOwner('assistant', 'run-a', 'run-a', 'user')).toBeNull();
    expect(assistantPopupOwner('assistant', 'run-a', 'run-a', 'assistant', 'stale-run')).toBeNull();
  });

  it('keeps every popup from an assistant-selected document network-restricted', () => {
    expect(shouldRestrictPopupNetwork(true, true, 'user')).toBe(true);
    expect(shouldRestrictPopupNetwork(true, false, 'user')).toBe(true);
    expect(shouldRestrictPopupNetwork(true, false, 'assistant')).toBe(true);
    expect(shouldRestrictPopupNetwork(false, true, 'user')).toBe(false);
  });

  it('binds a trusted user-navigation bypass to its intended main-frame request chain', () => {
    expect(
      shouldBypassAiPolicyForTrustedUserNavigation(
        true,
        'mainFrame',
        'https://example.com',
        'https://example.com/',
        null,
        7,
      ),
    ).toBe(true);
    expect(
      shouldBypassAiPolicyForTrustedUserNavigation(
        true,
        'mainFrame',
        'https://example.com/',
        'http://127.0.0.1/admin',
        null,
        8,
      ),
    ).toBe(false);
    expect(
      shouldBypassAiPolicyForTrustedUserNavigation(
        true,
        'mainFrame',
        'https://example.com/',
        'http://127.0.0.1/redirect-target',
        7,
        7,
      ),
    ).toBe(true);
    expect(
      shouldBypassAiPolicyForTrustedUserNavigation(
        true,
        'mainFrame',
        'https://example.com/',
        'http://127.0.0.1/raced-navigation',
        7,
        9,
      ),
    ).toBe(false);
    expect(
      shouldBypassAiPolicyForTrustedUserNavigation(
        true,
        'xhr',
        'https://example.com/',
        'https://example.com/',
        null,
        7,
      ),
    ).toBe(false);
    expect(isTrustedUserNavigationTarget(false, 'https://example.com/', 'https://example.com/')).toBe(false);
  });

  it('matches a trusted navigation when Chromium omits its fragment', () => {
    expect(
      isTrustedUserNavigationTarget(
        true,
        'https://example.com/callback?code=ok#complete',
        'https://example.com/callback?code=ok',
      ),
    ).toBe(true);
    expect(
      isTrustedUserNavigationTarget(
        true,
        'https://example.com/callback?code=ok',
        'https://example.com/callback?code=ok#complete',
      ),
    ).toBe(true);
    expect(
      isTrustedUserNavigationTarget(
        true,
        'https://example.com/callback?code=ok#complete',
        'https://example.com/other?code=ok',
      ),
    ).toBe(false);
    expect(
      isTrustedUserNavigationTarget(
        true,
        'https://example.com/callback?code=ok#complete',
        'https://example.com/callback?code=different',
      ),
    ).toBe(false);
  });

  it('requires a requested fragment to match the committed user navigation', () => {
    expect(isTrustedUserNavigationCommit(true, 'https://example.com/app#next', 'https://example.com/app#next')).toBe(
      true,
    );
    expect(isTrustedUserNavigationCommit(true, 'https://example.com/app#next', 'https://example.com/app#stale')).toBe(
      false,
    );
    expect(isTrustedUserNavigationCommit(true, 'https://example.com/app', 'https://example.com/app#next')).toBe(true);
  });

  it('removes only closed tabs backed by a cleared profile', () => {
    const tabs = [
      { id: 'global', scopeKey: 'global' },
      { id: 'chat', scopeKey: 'conversation-aaaaaaaaaaaaaaaaaaaaaaaa' },
    ];
    expect(retainClosedTabsOutsideScopes(tabs, new Set(['global']))).toEqual([tabs[1]]);
  });

  it('focuses an attached native page only when the caller explicitly requests it', () => {
    expect(shouldFocusAttachedBrowserView(true)).toBe(true);
    expect(shouldFocusAttachedBrowserView(false)).toBe(false);
  });

  it('discards idle user/kept tabs but never the mounted active tab', () => {
    const tab = { id: 'tab-1', conversationId: 'chat-1', owner: 'user' as const, keepOpen: false, audible: false };
    expect(shouldDiscardBrowserTab(tab, 100, 200, 'tab-2', 'chat-1')).toBe(true);
    expect(shouldDiscardBrowserTab(tab, 100, 200, 'tab-1', 'chat-1')).toBe(false);
    expect(shouldDiscardBrowserTab(tab, 300, 200, 'tab-2', 'chat-1')).toBe(false);
    expect(shouldDiscardBrowserTab({ ...tab, owner: 'assistant', keepOpen: false }, 100, 200, 'tab-2', 'chat-1')).toBe(
      false,
    );
    expect(shouldDiscardBrowserTab(tab, 100, 200, 'tab-2', 'chat-1', true)).toBe(false);
  });

  it('closes forgotten assistant tabs after the idle limit', () => {
    const tab = {
      id: 'tab-1',
      conversationId: 'chat-1',
      owner: 'assistant' as const,
      keepOpen: false,
      audible: false,
    };
    expect(shouldCloseIdleAssistantTab(tab, 100, 200, 'tab-2', 'chat-1')).toBe(true);
    expect(shouldCloseIdleAssistantTab(tab, 100, 200, 'tab-1', 'chat-1')).toBe(false);
    expect(shouldCloseIdleAssistantTab({ ...tab, keepOpen: true }, 100, 200, 'tab-2', 'chat-1')).toBe(false);
    expect(shouldCloseIdleAssistantTab(tab, 100, 200, 'tab-2', 'chat-1', true)).toBe(false);
  });

  it('keeps audible background tabs rendered regardless of ownership', () => {
    const userTab = {
      id: 'tab-1',
      conversationId: 'chat-1',
      owner: 'user' as const,
      keepOpen: false,
      audible: true,
    };
    expect(shouldDiscardBrowserTab(userTab, 100, 200, 'tab-2', 'chat-1')).toBe(false);
    expect(shouldCloseIdleAssistantTab({ ...userTab, owner: 'assistant' as const }, 100, 200, 'tab-2', 'chat-1')).toBe(
      false,
    );
  });

  it('closes only unexpectedly destroyed popup shells', () => {
    expect(shouldCloseDestroyedPopupTab(true, true)).toBe(true);
    expect(shouldCloseDestroyedPopupTab(true, false)).toBe(false);
    expect(shouldCloseDestroyedPopupTab(false, true)).toBe(false);
  });

  it('serializes assistant tab commands while leaving direct user input concurrent', () => {
    expect(shouldSerializeBrowserTabCommand('assistant')).toBe(true);
    expect(shouldSerializeBrowserTabCommand('user')).toBe(false);
  });

  it('bounds outstanding browser prompts globally and per tab', () => {
    expect(hasBrowserPromptCapacity(['tab-1', 'tab-2'], 'tab-1', 2, 4)).toBe(true);
    expect(hasBrowserPromptCapacity(['tab-1', 'tab-1'], 'tab-1', 2, 4)).toBe(false);
    expect(hasBrowserPromptCapacity(['tab-1', 'tab-2', 'tab-3', 'tab-4'], 'tab-5', 2, 4)).toBe(false);
  });

  it('requires an explicit nonempty target for element actions', () => {
    expect(browserActionRequiresTarget('click')).toBe(true);
    expect(browserActionRequiresTarget('focus')).toBe(true);
    expect(browserActionRequiresTarget('type')).toBe(true);
    expect(browserActionRequiresTarget('scroll')).toBe(false);
    expect(browserActionHasTarget({ kind: 'click' })).toBe(false);
    expect(browserActionHasTarget({ kind: 'click', selector: '   ', name: '' })).toBe(false);
    expect(browserActionHasTarget({ kind: 'click', x: 0, y: 0 })).toBe(true);
    expect(browserActionHasTarget({ kind: 'click', role: 'button' })).toBe(true);
    expect(browserActionHasTarget({ kind: 'click', text: 'Save' })).toBe(true);
    expect(browserActionHasTarget({ kind: 'type', text: 'legacy typed value' })).toBe(false);
    expect(browserActionHasTarget({ kind: 'type', role: 'textbox', text: 'legacy typed value' })).toBe(true);
  });
});
