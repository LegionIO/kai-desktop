import type { BrowserActionRequest, BrowserTab } from '../../shared/browser.js';

const TARGETED_BROWSER_ACTIONS = new Set<BrowserActionRequest['kind']>([
  'click',
  'doubleClick',
  'hover',
  'focus',
  'type',
  'drag',
]);

export function browserActionHasTarget(
  request: Pick<BrowserActionRequest, 'kind' | 'x' | 'y' | 'selector' | 'role' | 'name' | 'text'>,
): boolean {
  if (request.x !== undefined || request.y !== undefined) return true;
  // `text` is the backwards-compatible value payload for type actions. It
  // must not also satisfy the target requirement or filter the target element;
  // type still needs coordinates, a selector, role, or accessible name.
  const semanticText = request.kind === 'type' ? undefined : request.text;
  return [request.selector, request.role, request.name, semanticText].some(
    (value) => typeof value === 'string' && value.trim().length > 0,
  );
}

export function browserActionRequiresTarget(kind: BrowserActionRequest['kind']): boolean {
  return TARGETED_BROWSER_ACTIONS.has(kind);
}

export function shouldDiscardBrowserTab(
  tab: Pick<BrowserTab, 'id' | 'conversationId' | 'owner' | 'keepOpen' | 'audible'>,
  lastUsedAt: number,
  cutoff: number,
  activeTabId: string | undefined,
  mountedConversationId: string | null,
  assistantOperationActive = false,
): boolean {
  if (assistantOperationActive) return false;
  if (lastUsedAt >= cutoff) return false;
  if (tab.audible) return false;
  if (activeTabId === tab.id && mountedConversationId === tab.conversationId) return false;
  return tab.owner === 'user' || tab.keepOpen;
}

export function shouldCloseIdleAssistantTab(
  tab: Pick<BrowserTab, 'id' | 'conversationId' | 'owner' | 'keepOpen' | 'audible'>,
  lastUsedAt: number,
  cutoff: number,
  activeTabId: string | undefined,
  mountedConversationId: string | null,
  assistantOperationActive = false,
): boolean {
  if (assistantOperationActive) return false;
  if (lastUsedAt >= cutoff) return false;
  if (tab.audible) return false;
  if (activeTabId === tab.id && mountedConversationId === tab.conversationId) return false;
  return tab.owner === 'assistant' && !tab.keepOpen;
}

export function shouldCleanupAssistantTab(
  tab: Pick<BrowserTab, 'owner' | 'keepOpen'>,
  tabRunId?: string | null,
  cleanupRunId?: string,
): boolean {
  if (cleanupRunId && tabRunId !== cleanupRunId) return false;
  return tab.owner === 'assistant' && !tab.keepOpen;
}

export function shouldReleaseAiNetworkRestriction(
  actionDepth: number,
  actionUntil: number,
  at: number,
  scriptTainted: boolean,
): boolean {
  return !scriptTainted && actionDepth === 0 && at >= actionUntil;
}

export function assistantMayControlTab(
  owner: BrowserTab['owner'],
  assistantOwnerId: string | null,
  runId: string,
  keepOpen = false,
  ownerRunActive = assistantOwnerId !== null,
): boolean {
  return owner !== 'assistant' || assistantOwnerId === runId || (keepOpen && !ownerRunActive);
}

export function assistantPopupOwner(
  openerOwner: BrowserTab['owner'],
  openerAssistantOwnerId: string | null,
  activeControlOwnerId: string | null,
  gestureSource: 'assistant' | 'user' | null = null,
  gestureAssistantOwnerId: string | null = null,
  assistantScriptActive = false,
): string | null {
  // Evaluation is exact popup provenance and outranks a recently cached user
  // gesture. Otherwise script running during that gesture window could mint a
  // user-owned tab that survives assistant-run cleanup.
  if (assistantScriptActive) return activeControlOwnerId;
  // A concrete trusted gesture is stronger provenance than a concurrently
  // active AI operation. In particular, a real user click must not create a
  // cleanup-owned tab merely because an assistant is also inspecting the page.
  if (gestureSource === 'user') return null;
  if (gestureSource === 'assistant') {
    return gestureAssistantOwnerId && gestureAssistantOwnerId === activeControlOwnerId ? gestureAssistantOwnerId : null;
  }
  // While an assistant still controls the page, any popup without concrete
  // real-user provenance is part of that run. This also covers delayed
  // window.open calls scheduled by evaluated scripts after evaluation returns.
  if (activeControlOwnerId) return activeControlOwnerId;
  return openerOwner === 'assistant' && openerAssistantOwnerId === activeControlOwnerId ? openerAssistantOwnerId : null;
}

export function shouldRestrictPopupNetwork(
  openerRestricted: boolean,
  _openerScriptTainted: boolean,
  _gestureSource: 'assistant' | 'user' | null,
): boolean {
  // Tab ownership and network authority are separate. A real click may make
  // the popup user-owned, but content in an assistant-selected document cannot
  // use that click to mint a new unrestricted renderer/profile connection.
  return openerRestricted;
}

export function shouldBypassAiPolicyForTrustedUserNavigation(
  trustedUserNavigation: boolean,
  resourceType: string,
  intendedUrl: string | null,
  requestUrl: string,
  boundRequestId: number | null,
  requestId: number,
): boolean {
  if (!trustedUserNavigation || resourceType !== 'mainFrame') return false;
  if (boundRequestId !== null) return boundRequestId === requestId;
  return isTrustedUserNavigationTarget(trustedUserNavigation, intendedUrl, requestUrl);
}

export function isTrustedUserNavigationTarget(
  trustedUserNavigation: boolean,
  intendedUrl: string | null,
  requestUrl: string,
): boolean {
  if (!trustedUserNavigation || !intendedUrl) return false;
  try {
    const intended = new URL(intendedUrl);
    const requested = new URL(requestUrl);
    // URL fragments are renderer-only and are omitted from Chromium network
    // requests. Keep the exemption exact for origin/path/query while allowing
    // an omnibox target such as `/callback#done` to claim `/callback`.
    intended.hash = '';
    requested.hash = '';
    return intended.href === requested.href;
  } catch {
    return intendedUrl.split('#', 1)[0] === requestUrl.split('#', 1)[0];
  }
}

/** Match a committed document to the active user-navigation lease. Unlike a
 * network request, a same-document commit retains its fragment, so a requested
 * fragment must match and cannot be completed by an older hash navigation. */
export function isTrustedUserNavigationCommit(
  trustedUserNavigation: boolean,
  intendedUrl: string | null,
  committedUrl: string,
): boolean {
  if (!trustedUserNavigation || !intendedUrl) return false;
  try {
    const intended = new URL(intendedUrl);
    const committed = new URL(committedUrl);
    const intendedHash = intended.hash;
    const committedHash = committed.hash;
    intended.hash = '';
    committed.hash = '';
    return intended.href === committed.href && (!intendedHash || intendedHash === committedHash);
  } catch {
    return (
      intendedUrl === committedUrl || (!intendedUrl.includes('#') && intendedUrl === committedUrl.split('#', 1)[0])
    );
  }
}

export function retainClosedTabsOutsideScopes<T extends { scopeKey: string }>(
  tabs: T[],
  clearedScopeKeys: ReadonlySet<string>,
): T[] {
  return tabs.filter((tab) => !clearedScopeKeys.has(tab.scopeKey));
}

export function shouldFocusAttachedBrowserView(focusRequested: boolean): boolean {
  // A native view is also "newly attached" after React temporarily hides it
  // behind the omnibox suggestions, a menu, or another Browser-chrome overlay.
  // Treating attachment itself as focus intent steals focus back from the
  // restored React control. Callers that activate a tab or begin visible AI
  // input request page focus explicitly.
  return focusRequested;
}

/** A page-initiated `window.close()` should remove a popup's tab shell. Intentional
 * discards and renderer crashes clear view ownership before `destroyed`, so their
 * shells remain available for recreation and error display. */
export function shouldCloseDestroyedPopupTab(isPopup: boolean, stillOwnsContents: boolean): boolean {
  return isPopup && stillOwnsContents;
}

export function shouldSerializeBrowserTabCommand(source: 'user' | 'assistant'): boolean {
  return source === 'assistant';
}

export function hasBrowserPromptCapacity(
  pendingTabIds: Iterable<string>,
  tabId: string,
  perTabLimit: number,
  totalLimit: number,
): boolean {
  let total = 0;
  let forTab = 0;
  for (const pendingTabId of pendingTabIds) {
    total++;
    if (pendingTabId === tabId) forTab++;
  }
  return total < totalLimit && forTab < perTabLimit;
}
