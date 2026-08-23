import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type FC,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  ArrowDownIcon,
  ArrowUpIcon,
  BookmarkIcon,
  BotIcon,
  CameraIcon,
  CheckIcon,
  CopyIcon,
  DownloadIcon,
  ExternalLinkIcon,
  EyeIcon,
  GlobeIcon,
  HistoryIcon,
  KeyRoundIcon,
  Loader2Icon,
  MoreHorizontalIcon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  SearchIcon,
  ShieldAlertIcon,
  ShieldCheckIcon,
  StarIcon,
  Trash2Icon,
  Volume2Icon,
  XIcon,
} from 'lucide-react';
import type {
  BrowserActionEvent,
  BrowserAuthPrompt,
  BrowserBookmark,
  BrowserCredentialPrompt,
  BrowserCredentialSummary,
  BrowserDownload,
  BrowserEvent,
  BrowserFindResult,
  BrowserHistoryEntry,
  BrowserManagerState,
  BrowserPermissionPrompt,
  BrowserSitePermission,
  BrowserTab,
} from '../../../shared/browser';
import { BROWSER_PANEL_TAB_ID } from '../../../shared/browser';
import { useConfig } from '@/providers/ConfigProvider';
import { useSidePanel } from '@/components/side-panel';
import { app } from '@/lib/ipc-client';
import { cn } from '@/lib/utils';
import {
  collectRendererOverlayCandidates,
  hasIntersectingRendererOverlay,
  isRendererOverlayMotionTarget,
  refreshRendererOverlayCandidates,
  rendererOverlayObservationRoots,
  subscribeRendererDeclarativeShadowChanges,
  subscribeRendererShadowRoots,
  subscribeRendererStylesheetChanges,
  updateRendererOverlayCandidates,
} from './native-overlay';

type ManagerView = 'history' | 'bookmarks' | 'downloads' | 'passwords' | null;
type BrowserAttention = { panelTabIds: Set<string>; promptIds: Set<string> };
type TabContextAction =
  | 'duplicate'
  | 'close'
  | 'close-others'
  | 'close-right'
  | 'keep-open'
  | 'toggle-mute'
  | 'move-left'
  | 'move-right';

function appendPromptOnce<T extends { id: string }>(current: T[], prompt: T): T[] {
  const index = current.findIndex((item) => item.id === prompt.id);
  if (index < 0) return [...current, prompt];
  if (current[index] === prompt) return current;
  const next = [...current];
  next[index] = prompt;
  return next;
}

type BrowserPromptSnapshotDelta<T extends { id: string }> = {
  revision: number;
  prompt: T | null;
};

export function retainBrowserSnapshotDelta<T>(
  snapshotRequest: number | null,
  deltas: Map<string, T>,
  id: string,
  delta: T,
): void {
  if (snapshotRequest !== null) deltas.set(id, delta);
}

export function clearBrowserSnapshotDeltas(...deltas: Array<{ clear(): void }>): void {
  for (const delta of deltas) delta.clear();
}

function reconcileBrowserPromptSnapshot<T extends { id: string }>(
  snapshot: T[] | undefined,
  snapshotRevision: number,
  appliedRevision: number,
  deltas: Map<string, BrowserPromptSnapshotDelta<T>>,
): T[] {
  const reconciled = new Map((snapshot ?? []).map((prompt) => [prompt.id, prompt]));
  for (const [promptId, delta] of deltas) {
    if (delta.revision <= snapshotRevision) continue;
    if (delta.prompt) reconciled.set(promptId, delta.prompt);
    else reconciled.delete(promptId);
  }
  for (const [promptId, delta] of deltas) {
    if (delta.revision <= appliedRevision && deltas.get(promptId) === delta) deltas.delete(promptId);
  }
  return [...reconciled.values()];
}

function browserPermissionOrigin(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : null;
  } catch {
    return null;
  }
}

function browserPanelMayClaimFocus(panel: HTMLElement | null): boolean {
  if (!panel?.isConnected) return false;
  const activeElement = panel.ownerDocument.activeElement;
  // Never pull focus out of chat input, Settings, or another modal. Native page
  // focus is represented by body (or a previously focused Browser control) in
  // the host renderer, so prompts from the visible page still receive their
  // fail-closed default focus.
  if (activeElement && activeElement !== panel.ownerDocument.body && !panel.contains(activeElement)) return false;
  return !hasIntersectingRendererOverlay(panel);
}

function isEditableBrowserChromeTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target.matches('input, textarea, select')) return true;
  if (target instanceof HTMLElement && target.isContentEditable) return true;
  return target.closest('[contenteditable]:not([contenteditable="false"])') !== null;
}

// Main bounds sensitivity probing and capture to five seconds; decoding is
// separately bounded to two seconds. Keep the real page mounted throughout
// that legitimate work instead of replacing it with a dark placeholder after
// an arbitrary UI-frame delay.
const BROWSER_MENU_PREVIEW_FALLBACK_MS = 7_500;
const BROWSER_MENU_PREVIEW_DECODE_TIMEOUT_MS = 2_000;

async function decodeBrowserMenuPreview(dataUrl: string, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return false;
  if (typeof Image === 'undefined') return true;
  const image = new Image();
  image.src = dataUrl;
  if (typeof image.decode !== 'function') return !signal.aborted;
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (decoded: boolean) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      signal.removeEventListener('abort', abort);
      if (!decoded) image.src = '';
      resolve(decoded && !signal.aborted);
    };
    const abort = () => finish(false);
    const timeout = window.setTimeout(() => finish(false), BROWSER_MENU_PREVIEW_DECODE_TIMEOUT_MS);
    signal.addEventListener('abort', abort, { once: true });
    void image.decode().then(
      () => finish(true),
      () => finish(false),
    );
  });
}

function clearPanelTabAttention(
  current: Map<string, BrowserAttention>,
  conversationId: string,
): Map<string, BrowserAttention> {
  const previous = current.get(conversationId);
  if (!previous || previous.panelTabIds.size === 0) return current;
  const next = new Map(current);
  if (previous.promptIds.size === 0) next.delete(conversationId);
  else next.set(conversationId, { ...previous, panelTabIds: new Set() });
  return next;
}

function menuItems(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>('[role="menuitem"]')].filter(
    (item) => !item.hasAttribute('disabled') && item.getAttribute('aria-disabled') !== 'true',
  );
}

function handleMenuNavigation(event: ReactKeyboardEvent<HTMLElement>, onDismiss: () => void): void {
  if (event.key === 'Escape' || event.key === 'Tab') {
    event.preventDefault();
    event.stopPropagation();
    onDismiss();
    return;
  }
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
  const items = menuItems(event.currentTarget);
  if (items.length === 0) return;
  event.preventDefault();
  const current = items.indexOf(document.activeElement as HTMLElement);
  const next =
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? items.length - 1
        : event.key === 'ArrowDown'
          ? (current + 1 + items.length) % items.length
          : (current - 1 + items.length) % items.length;
  items[next]?.focus();
}

const iconButton =
  'titlebar-no-drag inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-35';

export const BrowserPanelAutoOpen: FC<{
  conversationId: string | null;
  chatViewActive?: boolean;
  onRevealChat?: () => void;
  onOpenConversation?: (conversationId: string) => boolean | void | Promise<boolean | void>;
}> = ({ conversationId, chatViewActive = true, onRevealChat, onOpenConversation }) => {
  const { openPanel, state: sidePanelState, activeTabId } = useSidePanel();
  const [attentionByConversation, setAttentionByConversation] = useState<Map<string, BrowserAttention>>(
    () => new Map(),
  );
  // Browser events can arrive between a render that switches chats and the
  // passive-effect cleanup for the previous render. Keep one subscription and
  // classify every event against the latest committed render inputs.
  const conversationIdRef = useRef(conversationId);
  const browserPanelVisibleRef = useRef(false);
  const browserPanelVisible = chatViewActive && sidePanelState === 'open' && activeTabId === BROWSER_PANEL_TAB_ID;
  useLayoutEffect(() => {
    conversationIdRef.current = conversationId;
    browserPanelVisibleRef.current = browserPanelVisible;
  }, [browserPanelVisible, chatViewActive, conversationId]);
  useLayoutEffect(() => {
    if (!browserPanelVisible || !conversationId) return;
    setAttentionByConversation((current) => clearPanelTabAttention(current, conversationId));
  }, [browserPanelVisible, conversationId]);
  const attentionConversationId =
    [...attentionByConversation.keys()].find((candidate) => candidate !== conversationId || !browserPanelVisible) ??
    null;
  const visibleAttention = attentionConversationId ? attentionByConversation.get(attentionConversationId) : undefined;
  useEffect(() => {
    const browser = window.app?.browser;
    if (!browser) return;
    let disposed = false;
    let attentionRevision = 0;
    const unsubscribe = browser.onEvent((event) => {
      if (
        event.type === 'auth-prompt' ||
        event.type === 'permission-prompt' ||
        event.type === 'credential-prompt' ||
        event.type === 'prompt-dismissed'
      ) {
        attentionRevision += 1;
      }
      if (event.type === 'open-panel') {
        // This legacy event is attention only. Browser automation is a native
        // main-process capability and must never mount, reveal, or focus the
        // sidebar; only the user's explicit Open action may do that.
        if (event.conversationId === conversationIdRef.current && browserPanelVisibleRef.current) {
          setAttentionByConversation((current) => clearPanelTabAttention(current, event.conversationId));
        } else {
          setAttentionByConversation((current) => {
            const next = new Map(current);
            const previous = next.get(event.conversationId);
            const panelTabIds = new Set(previous?.panelTabIds ?? []);
            panelTabIds.add(event.tabId);
            next.set(event.conversationId, {
              panelTabIds,
              promptIds: new Set(previous?.promptIds ?? []),
            });
            return next;
          });
        }
      } else if (
        event.type === 'auth-prompt' ||
        event.type === 'permission-prompt' ||
        event.type === 'credential-prompt'
      ) {
        setAttentionByConversation((current) => {
          const next = new Map(current);
          const previous = next.get(event.conversationId);
          const promptIds = new Set(previous?.promptIds ?? []);
          promptIds.add(event.prompt.id);
          next.set(event.conversationId, {
            panelTabIds: new Set(previous?.panelTabIds ?? []),
            promptIds,
          });
          return next;
        });
        // Prompts are attention only. A delayed page request can arrive after
        // the user has hidden the Browser, and background AI work must never
        // mount or focus the sidebar. The user explicitly reveals the prompt
        // through the attention affordance when they are ready to respond.
      } else if (event.type === 'tabs-changed') {
        setAttentionByConversation((current) => {
          const previous = current.get(event.conversationId);
          if (!previous || previous.panelTabIds.size === 0) return current;
          const liveTabIds = new Set(event.tabs.map((tab) => tab.id));
          const panelTabIds = new Set([...previous.panelTabIds].filter((tabId) => liveTabIds.has(tabId)));
          if (panelTabIds.size === previous.panelTabIds.size) return current;
          const next = new Map(current);
          if (panelTabIds.size === 0 && previous.promptIds.size === 0) next.delete(event.conversationId);
          else next.set(event.conversationId, { ...previous, panelTabIds });
          return next;
        });
      } else if (event.type === 'prompt-dismissed') {
        setAttentionByConversation((current) => {
          const previous = current.get(event.conversationId);
          if (!previous?.promptIds.has(event.promptId)) return current;
          const next = new Map(current);
          const promptIds = new Set(previous.promptIds);
          promptIds.delete(event.promptId);
          if (previous.panelTabIds.size === 0 && promptIds.size === 0) next.delete(event.conversationId);
          else next.set(event.conversationId, { ...previous, promptIds });
          return next;
        });
      }
    });
    const hydrateRetainedAttention = async (): Promise<void> => {
      const requestedRevision = attentionRevision;
      try {
        const retained = await browser.getAttentionState();
        if (disposed) return;
        // An event raced the snapshot. Retry so a dismissed prompt cannot be
        // resurrected and a newly-created prompt cannot be lost on reload.
        if (requestedRevision !== attentionRevision) {
          void hydrateRetainedAttention();
          return;
        }
        setAttentionByConversation((current) => {
          const next = new Map<string, BrowserAttention>();
          for (const [id, attention] of current) {
            if (attention.panelTabIds.size > 0) {
              next.set(id, { panelTabIds: new Set(attention.panelTabIds), promptIds: new Set() });
            }
          }
          for (const attention of retained) {
            if (attention.promptIds.length === 0) continue;
            const previous = next.get(attention.conversationId);
            next.set(attention.conversationId, {
              panelTabIds: new Set(previous?.panelTabIds ?? []),
              promptIds: new Set(attention.promptIds),
            });
          }
          return next;
        });
      } catch {
        // Future live events still surface attention if retained-state hydration fails.
      }
    };
    void hydrateRetainedAttention();
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [openPanel]);

  if (!attentionConversationId) return null;
  return (
    <div
      role="alert"
      className="fixed bottom-5 left-5 z-[10001] flex max-w-[min(24rem,calc(100vw-2.5rem))] items-center gap-2 rounded-xl border border-amber-500/40 bg-popover px-3 py-2.5 text-xs text-foreground shadow-xl"
    >
      <ShieldAlertIcon className="h-4 w-4 shrink-0 text-amber-500" />
      <span className="flex-1">
        {attentionConversationId === conversationId
          ? 'The Browser needs attention.'
          : 'The Browser needs attention in another chat or app view.'}
      </span>
      <button
        type="button"
        className="rounded bg-primary px-2 py-1 text-primary-foreground"
        onClick={() => {
          const target = attentionConversationId;
          void Promise.resolve()
            .then(async () => {
              const opened = onOpenConversation
                ? await onOpenConversation(target)
                : (await app.conversations.setActiveId(target)).ok;
              if (opened === false) return false;
              return true;
            })
            .then((opened) => {
              if (!opened) return;
              setAttentionByConversation((current) => clearPanelTabAttention(current, target));
              onRevealChat?.();
              openPanel(BROWSER_PANEL_TAB_ID);
            })
            .catch(() => undefined);
        }}
      >
        Open
      </button>
      {visibleAttention?.promptIds.size === 0 && (
        <button
          type="button"
          className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label="Dismiss Browser attention"
          onClick={() =>
            setAttentionByConversation((current) => {
              const next = new Map(current);
              next.delete(attentionConversationId);
              return next;
            })
          }
        >
          <XIcon className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
};

export const BrowserPanel: FC<{ conversationId: string | null }> = ({ conversationId }) => (
  <BrowserPanelContent key={conversationId ?? 'no-conversation'} conversationId={conversationId} />
);

const BrowserPanelContent: FC<{ conversationId: string | null }> = ({ conversationId }) => {
  const browser = window.app?.browser;
  const { config } = useConfig();
  const [available, setAvailable] = useState<boolean | null>(null);
  const [state, setState] = useState<BrowserManagerState | null>(null);
  const [urlDraft, setUrlDraft] = useState('');
  const [urlFocused, setUrlFocused] = useState(false);
  const [suggestions, setSuggestions] = useState<Array<{ title: string; url: string; type: 'history' | 'bookmark' }>>(
    [],
  );
  const [activeSuggestionIndex, setActiveSuggestionIndex] = useState(-1);
  const [findOpen, setFindOpen] = useState(false);
  const [findText, setFindText] = useState('');
  const [findResult, setFindResult] = useState<BrowserFindResult | null>(null);
  const [managerView, setManagerView] = useState<ManagerView>(null);
  const [managerRevision, setManagerRevision] = useState(0);
  const [appliedDataScope, setAppliedDataScope] = useState(
    () => (config?.browser as { dataScope?: 'global' | 'conversation' } | undefined)?.dataScope ?? 'global',
  );
  const [bookmarkRevision, setBookmarkRevision] = useState(0);
  const [downloadRevision, setDownloadRevision] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);
  const [browserMenuPreview, setBrowserMenuPreview] = useState<string | null>(null);
  const [browserMenuPreviewPending, setBrowserMenuPreviewPending] = useState(false);
  const [siteInfoOpen, setSiteInfoOpen] = useState(false);
  const [tabMenu, setTabMenu] = useState<{
    tabId: string;
    x: number;
    y: number;
  } | null>(null);
  const [draggedTabId, setDraggedTabId] = useState<string | null>(null);
  const [bookmarks, setBookmarks] = useState<BrowserBookmark[]>([]);
  const [sitePermissions, setSitePermissions] = useState<BrowserSitePermission[]>([]);
  const [latestDownload, setLatestDownload] = useState<BrowserDownload | null>(null);
  const [runningActions, setRunningActions] = useState<Map<string, BrowserActionEvent>>(() => new Map());
  const [credentialPrompts, setCredentialPrompts] = useState<BrowserCredentialPrompt[]>([]);
  const [permissionPrompts, setPermissionPrompts] = useState<BrowserPermissionPrompt[]>([]);
  const [authPrompts, setAuthPrompts] = useState<BrowserAuthPrompt[]>([]);
  const [error, setError] = useState<string | null>(null);
  const managerViewRef = useRef<ManagerView>(managerView);
  const panelRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const urlRef = useRef<HTMLInputElement>(null);
  const findRef = useRef<HTMLInputElement>(null);
  const menuContainerRef = useRef<HTMLDivElement>(null);
  const browserMenuRef = useRef<HTMLDivElement>(null);
  const siteInfoTriggerRef = useRef<HTMLButtonElement>(null);
  const siteInfoPopoverRef = useRef<HTMLDivElement>(null);
  const tabContextMenuRef = useRef<HTMLDivElement>(null);
  const menuTriggerRef = useRef<HTMLButtonElement>(null);
  const tabButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const emptyNewTabButtonRef = useRef<HTMLButtonElement>(null);
  const pendingClosedTabFocusRef = useRef<{ closedTabId: string; preferredTabIds: string[] } | null>(null);
  const suggestionRequestRef = useRef(0);
  const navigationRequestRef = useRef(0);
  const browserMenuPreviewRequestRef = useRef(0);
  const browserMenuPreviewAbortRef = useRef<AbortController | null>(null);
  const browserMenuPageRef = useRef<string | null>(null);
  const stateRequestRef = useRef(0);
  const stateSnapshotInFlightRef = useRef<number | null>(null);
  const tabSnapshotRevisionRef = useRef(0);
  const auxiliarySnapshotRevisionRef = useRef({
    actions: 0,
    credentialPrompts: 0,
    permissionPrompts: 0,
    authPrompts: 0,
  });
  const actionEventRevisionRef = useRef(0);
  const actionSnapshotDeltasRef = useRef(new Map<string, { revision: number; action: BrowserActionEvent }>());
  const credentialPromptSnapshotDeltasRef = useRef(
    new Map<string, BrowserPromptSnapshotDelta<BrowserCredentialPrompt>>(),
  );
  const permissionPromptSnapshotDeltasRef = useRef(
    new Map<string, BrowserPromptSnapshotDelta<BrowserPermissionPrompt>>(),
  );
  const authPromptSnapshotDeltasRef = useRef(new Map<string, BrowserPromptSnapshotDelta<BrowserAuthPrompt>>());
  const stateRef = useRef<BrowserManagerState | null>(null);
  const pendingFaviconsRef = useRef(new Map<string, string | null>());
  const bookmarkRequestRef = useRef(0);
  const sitePermissionRequestRef = useRef(0);
  const activePermissionOriginRef = useRef<string | null>(null);
  const conversationIdRef = useRef(conversationId);
  const lastNativeMountRef = useRef<string | null | undefined>(undefined);
  const nativeMountPromiseRef = useRef<Promise<void>>(Promise.resolve());
  const refreshNativeMountRef = useRef<() => Promise<void>>(async () => {
    lastNativeMountRef.current = undefined;
  });
  const activeTabIdRef = useRef<string | null>(null);
  const findTextRef = useRef('');
  const findTabIdRef = useRef<string | null>(null);
  const findRequestRef = useRef(0);
  const activeFindRequestRef = useRef<{ tabId: string; requestId: number } | null>(null);
  const zoomTargetsRef = useRef(new Map<string, number>());
  const panelDomId = useId();
  const suggestionListId = `${panelDomId}-omnibox-suggestions`;
  const viewportId = `${panelDomId}-viewport`;
  conversationIdRef.current = conversationId;
  managerViewRef.current = managerView;
  const reportError = useCallback((reason: unknown) => {
    setError(reason instanceof Error ? reason.message : String(reason));
  }, []);
  const focusOmnibox = useCallback(() => {
    requestAnimationFrame(() => {
      urlRef.current?.focus();
      urlRef.current?.select();
    });
  }, []);
  const restoreBrowserChromeFocus = useCallback(() => {
    requestAnimationFrame(() => {
      const activeTabButton = activeTabIdRef.current ? tabButtonRefs.current.get(activeTabIdRef.current) : undefined;
      (activeTabButton ?? urlRef.current ?? emptyNewTabButtonRef.current)?.focus();
    });
  }, []);
  const restorePromptOrBrowserChromeFocus = useCallback(() => {
    requestAnimationFrame(() => {
      const panel = panelRef.current;
      if (!browserPanelMayClaimFocus(panel)) return;
      const promptPrimary =
        panel?.querySelector<HTMLElement>('[data-browser-prompt-kind="auth"] [data-browser-prompt-primary]') ??
        panel?.querySelector<HTMLElement>('[data-browser-prompt-kind="permission"] [data-browser-prompt-primary]') ??
        panel?.querySelector<HTMLElement>('[data-browser-prompt-kind="credential"] [data-browser-prompt-primary]');
      if (promptPrimary) {
        promptPrimary.focus();
        return;
      }
      const activeTabButton = activeTabIdRef.current ? tabButtonRefs.current.get(activeTabIdRef.current) : undefined;
      (activeTabButton ?? urlRef.current ?? emptyNewTabButtonRef.current)?.focus();
    });
  }, []);
  const canFocusBrowserPrompt = useCallback(() => browserPanelMayClaimFocus(panelRef.current), []);
  const closeManagerView = useCallback(() => {
    managerViewRef.current = null;
    setManagerView(null);
    requestAnimationFrame(() => {
      const activeTabButton = activeTabIdRef.current ? tabButtonRefs.current.get(activeTabIdRef.current) : undefined;
      (menuTriggerRef.current ?? activeTabButton ?? urlRef.current ?? emptyNewTabButtonRef.current)?.focus();
    });
  }, []);
  const openFind = useCallback(() => {
    setFindOpen(true);
    requestAnimationFrame(() => {
      findRef.current?.focus();
      findRef.current?.select();
    });
  }, []);

  const active = state?.tabs.find((tab) => tab.active) ?? null;
  const activeRunningActions = active
    ? [...runningActions.values()].filter((action) => action.tabId === active.id)
    : [];
  const activePermissionOrigin = active ? browserPermissionOrigin(active.url) : null;
  activePermissionOriginRef.current = activePermissionOrigin;
  const browserConfig = (config?.browser ?? {}) as {
    enabled?: boolean;
    showBookmarksBar?: boolean;
  };
  const browserEnabled = browserConfig.enabled ?? true;
  const overlayOpen = menuOpen || siteInfoOpen || !!tabMenu || (urlFocused && suggestions.length > 0);
  const nativeVisible =
    browserEnabled &&
    managerView === null &&
    !overlayOpen &&
    !!active &&
    !active?.reloadRequired &&
    available === true &&
    !!conversationId;

  const dismissBrowserMenu = useCallback(() => {
    browserMenuPreviewRequestRef.current += 1;
    browserMenuPreviewAbortRef.current?.abort();
    browserMenuPreviewAbortRef.current = null;
    setMenuOpen(false);
    setBrowserMenuPreview(null);
    setBrowserMenuPreviewPending(false);
  }, []);

  const toggleBrowserMenu = useCallback(() => {
    if (menuOpen || browserMenuPreviewPending) {
      dismissBrowserMenu();
      return;
    }
    setSiteInfoOpen(false);
    setTabMenu(null);
    setBrowserMenuPreview(null);
    const request = ++browserMenuPreviewRequestRef.current;
    if (!browser || !conversationId || !active) {
      setBrowserMenuPreviewPending(false);
      setMenuOpen(true);
      return;
    }
    const pageIdentity = `${conversationId}\u0000${active.id}\u0000${active.url}\u0000${active.updatedAt}`;
    const requestIsCurrent = (): boolean => {
      const current = stateRef.current?.tabs.find((tab) => tab.active);
      return (
        browserMenuPreviewRequestRef.current === request &&
        browserMenuPageRef.current === pageIdentity &&
        !!current &&
        `${conversationId}\u0000${current.id}\u0000${current.url}\u0000${current.updatedAt}` === pageIdentity
      );
    };
    const revealProtectedMenu = async (preview: string | null): Promise<void> => {
      if (!requestIsCurrent()) return;
      try {
        // Native child views paint above React. Do not commit Browser chrome
        // until main has synchronously hidden/rebounded the real page view.
        await browser.mount(conversationId, null);
      } catch (reason) {
        if (requestIsCurrent()) {
          reportError(reason);
          setBrowserMenuPreviewPending(false);
        } else void refreshNativeMountRef.current();
        return;
      }
      if (!requestIsCurrent()) {
        // A dismissal or document change can supersede this request while main
        // is still detaching the native child view. That late detach wins over
        // an intervening bounds report, so force the current layout effect to
        // publish its bounds again instead of trusting the cached signature.
        void refreshNativeMountRef.current();
        return;
      }
      lastNativeMountRef.current = null;
      setBrowserMenuPreview(preview);
      setMenuOpen(true);
      setBrowserMenuPreviewPending(false);
    };
    setBrowserMenuPreviewPending(true);
    if (active.sensitive) {
      void revealProtectedMenu(null);
      return;
    }
    const controller = new AbortController();
    const previewRequestId = window.crypto.randomUUID();
    const cancelNativePreview = () => {
      void browser.cancelMenuPreview(previewRequestId).catch(() => undefined);
    };
    controller.signal.addEventListener('abort', cancelNativePreview, { once: true });
    browserMenuPreviewAbortRef.current?.abort();
    browserMenuPreviewAbortRef.current = controller;
    let revealPromise: Promise<void> | null = null;
    const startProtectedReveal = (preview: string | null): Promise<void> => {
      revealPromise ??= revealProtectedMenu(preview);
      return revealPromise;
    };
    // Main admits this presentation-only capture only when the tab is idle.
    // Its capture and our decode both have explicit deadlines. Leave the real
    // page mounted until those bounds expire; only then fall back to a protected
    // placeholder and cancel native work so it cannot block later operations.
    const fallback = window.setTimeout(() => {
      if (
        !controller.signal.aborted &&
        browserMenuPreviewRequestRef.current === request &&
        browserMenuPageRef.current === pageIdentity
      ) {
        controller.abort();
        void startProtectedReveal(null);
      }
    }, BROWSER_MENU_PREVIEW_FALLBACK_MS);
    void browser
      .captureMenuPreview(conversationId, active.id, previewRequestId)
      .then(async (capture) => {
        if (!requestIsCurrent()) return;
        const decoded = capture.dataUrl ? await decodeBrowserMenuPreview(capture.dataUrl, controller.signal) : false;
        if (!requestIsCurrent()) return;
        if (controller.signal.aborted) return;
        await startProtectedReveal(decoded ? (capture.dataUrl ?? null) : null);
      })
      .catch(async () => {
        if (
          !controller.signal.aborted &&
          browserMenuPreviewRequestRef.current === request &&
          browserMenuPageRef.current === pageIdentity
        ) {
          await startProtectedReveal(null);
        }
      })
      .finally(() => {
        window.clearTimeout(fallback);
        controller.signal.removeEventListener('abort', cancelNativePreview);
        if (browserMenuPreviewAbortRef.current === controller) browserMenuPreviewAbortRef.current = null;
        if (!revealPromise && browserMenuPreviewRequestRef.current === request) setBrowserMenuPreviewPending(false);
      });
  }, [active, browser, browserMenuPreviewPending, conversationId, dismissBrowserMenu, menuOpen, reportError]);

  useLayoutEffect(() => {
    const nextPage = active ? `${conversationId}\u0000${active.id}\u0000${active.url}\u0000${active.updatedAt}` : null;
    const pageChanged = browserMenuPageRef.current !== nextPage;
    browserMenuPageRef.current = nextPage;
    if ((menuOpen || browserMenuPreviewPending) && pageChanged) dismissBrowserMenu();
    // A captured frame belongs to one document only. Switching tabs must not
    // briefly display pixels from the previous tab beneath Browser chrome.
  }, [
    active?.id,
    active?.updatedAt,
    active?.url,
    browserMenuPreviewPending,
    conversationId,
    dismissBrowserMenu,
    menuOpen,
  ]);

  useEffect(
    () => () => {
      browserMenuPreviewRequestRef.current += 1;
      browserMenuPreviewAbortRef.current?.abort();
      browserMenuPreviewAbortRef.current = null;
    },
    [],
  );

  const refreshState = useCallback(async () => {
    if (!browser || !conversationId) return;
    const requestedConversationId = conversationId;
    const request = ++stateRequestRef.current;
    stateSnapshotInFlightRef.current = request;
    clearBrowserSnapshotDeltas(
      actionSnapshotDeltasRef.current,
      credentialPromptSnapshotDeltasRef.current,
      permissionPromptSnapshotDeltasRef.current,
      authPromptSnapshotDeltasRef.current,
    );
    const tabRevision = tabSnapshotRevisionRef.current;
    const auxiliaryRevision = { ...auxiliarySnapshotRevisionRef.current };
    const actionRevision = actionEventRevisionRef.current;
    try {
      const next = await browser.getState(conversationId);
      if (request !== stateRequestRef.current || conversationIdRef.current !== requestedConversationId) return;
      const reconciled = {
        ...next,
        tabs: next.tabs.map((tab) => {
          if (!pendingFaviconsRef.current.has(tab.id)) return tab;
          const favicon = pendingFaviconsRef.current.get(tab.id);
          return {
            ...tab,
            ...(favicon ? { favicon } : { favicon: undefined }),
          };
        }),
      };
      // Tab events are live deltas too, but they must not invalidate hydration
      // of retained native prompts/actions from this snapshot. Apply the tab
      // portion only if no newer tab/favicon event arrived while getState was
      // pending; the auxiliary portion is reconciled independently below.
      if (tabRevision === tabSnapshotRevisionRef.current) {
        activeTabIdRef.current = reconciled.activeTabId;
        stateRef.current = reconciled;
        setState(reconciled);
      }
      // Prompt/action events are independent live deltas. Reconcile each
      // snapshot domain separately so an action event cannot suppress retained
      // prompts, and one prompt kind cannot suppress another.
      setCredentialPrompts(
        reconcileBrowserPromptSnapshot(
          reconciled.credentialPrompts,
          auxiliaryRevision.credentialPrompts,
          auxiliarySnapshotRevisionRef.current.credentialPrompts,
          credentialPromptSnapshotDeltasRef.current,
        ),
      );
      setPermissionPrompts(
        reconcileBrowserPromptSnapshot(
          reconciled.permissionPrompts,
          auxiliaryRevision.permissionPrompts,
          auxiliarySnapshotRevisionRef.current.permissionPrompts,
          permissionPromptSnapshotDeltasRef.current,
        ),
      );
      setAuthPrompts(
        reconcileBrowserPromptSnapshot(
          reconciled.authPrompts,
          auxiliaryRevision.authPrompts,
          auxiliarySnapshotRevisionRef.current.authPrompts,
          authPromptSnapshotDeltasRef.current,
        ),
      );
      // A snapshot and live action events are two halves of one state stream.
      // Replaying per-id deltas over the snapshot preserves unrelated running
      // actions when (for example) action B completes while the snapshot still
      // contains both A and B. Dropping the whole snapshot on any event would
      // also drop A from an initially empty panel until its completion event.
      const reconciledActions = new Map((reconciled.runningActions ?? []).map((action) => [action.id, action]));
      const appliedActionRevision = actionEventRevisionRef.current;
      for (const [actionId, delta] of actionSnapshotDeltasRef.current) {
        if (delta.revision <= actionRevision) continue;
        if (delta.action.status === 'running') reconciledActions.set(actionId, delta.action);
        else reconciledActions.delete(actionId);
      }
      setRunningActions(reconciledActions);
      for (const [actionId, delta] of actionSnapshotDeltasRef.current) {
        if (delta.revision <= appliedActionRevision && actionSnapshotDeltasRef.current.get(actionId) === delta) {
          actionSnapshotDeltasRef.current.delete(actionId);
        }
      }
    } catch (reason) {
      if (request !== stateRequestRef.current || conversationIdRef.current !== requestedConversationId) return;
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (stateSnapshotInFlightRef.current === request) {
        stateSnapshotInFlightRef.current = null;
        clearBrowserSnapshotDeltas(
          actionSnapshotDeltasRef.current,
          credentialPromptSnapshotDeltasRef.current,
          permissionPromptSnapshotDeltasRef.current,
          authPromptSnapshotDeltasRef.current,
        );
      }
    }
  }, [browser, conversationId]);

  const refreshBookmarks = useCallback(async () => {
    if (!browser || !conversationId) return;
    const requestedConversationId = conversationId;
    const request = ++bookmarkRequestRef.current;
    try {
      const next = await browser.listBookmarks(conversationId);
      if (request !== bookmarkRequestRef.current || conversationIdRef.current !== requestedConversationId) return;
      setBookmarks(next);
    } catch (reason) {
      if (request !== bookmarkRequestRef.current || conversationIdRef.current !== requestedConversationId) return;
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, [browser, conversationId]);

  const resetDisplayedSitePermissions = useCallback(
    async (origin: string, permission?: string): Promise<void> => {
      if (!browser || !conversationId) return;
      const requestedConversationId = conversationId;
      // Supersede both an in-flight list and any older reset. A reset can pause
      // behind disk I/O while the user activates a different tab/origin.
      const request = ++sitePermissionRequestRef.current;
      try {
        if (permission) await browser.resetSitePermissions(conversationId, origin, permission);
        else await browser.resetSitePermissions(conversationId, origin);
        if (
          request !== sitePermissionRequestRef.current ||
          conversationIdRef.current !== requestedConversationId ||
          activePermissionOriginRef.current !== origin
        )
          return;
        setSitePermissions((current) => (permission ? current.filter((item) => item.permission !== permission) : []));
      } catch (reason) {
        if (
          request === sitePermissionRequestRef.current &&
          conversationIdRef.current === requestedConversationId &&
          activePermissionOriginRef.current === origin
        )
          reportError(reason);
      }
    },
    [browser, conversationId, reportError],
  );

  useEffect(() => {
    const request = ++sitePermissionRequestRef.current;
    if (!siteInfoOpen || !browser || !conversationId || !activePermissionOrigin) {
      setSitePermissions([]);
      return;
    }
    void browser
      .listSitePermissions(conversationId, activePermissionOrigin)
      .then((permissions) => {
        if (request === sitePermissionRequestRef.current) setSitePermissions(permissions);
      })
      .catch((reason) => {
        if (request === sitePermissionRequestRef.current) reportError(reason);
      });
    return () => {
      sitePermissionRequestRef.current++;
    };
  }, [activePermissionOrigin, appliedDataScope, browser, conversationId, reportError, siteInfoOpen]);

  useEffect(() => {
    if (!browser) {
      setAvailable(false);
      return;
    }
    setAvailable(null);
    void browser
      .available()
      .then(setAvailable)
      .catch(() => setAvailable(false));
  }, [browser, browserEnabled]);

  useEffect(() => {
    if (!siteInfoOpen) return;
    const frame = requestAnimationFrame(() => siteInfoPopoverRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [siteInfoOpen]);

  useEffect(() => {
    findTextRef.current = findText;
  }, [findText]);

  useEffect(() => {
    stateRequestRef.current++;
    tabSnapshotRevisionRef.current++;
    for (const domain of Object.keys(auxiliarySnapshotRevisionRef.current) as Array<
      keyof typeof auxiliarySnapshotRevisionRef.current
    >) {
      auxiliarySnapshotRevisionRef.current[domain]++;
    }
    actionEventRevisionRef.current++;
    stateSnapshotInFlightRef.current = null;
    clearBrowserSnapshotDeltas(
      actionSnapshotDeltasRef.current,
      credentialPromptSnapshotDeltasRef.current,
      permissionPromptSnapshotDeltasRef.current,
      authPromptSnapshotDeltasRef.current,
    );
    bookmarkRequestRef.current++;
    sitePermissionRequestRef.current++;
    suggestionRequestRef.current++;
    navigationRequestRef.current++;
    setState(null);
    stateRef.current = null;
    pendingFaviconsRef.current.clear();
    zoomTargetsRef.current.clear();
    activeTabIdRef.current = null;
    setManagerView(null);
    setManagerRevision(0);
    setDownloadRevision(0);
    setBookmarks([]);
    setSitePermissions([]);
    setSuggestions([]);
    setActiveSuggestionIndex(-1);
    setUrlDraft('');
    setUrlFocused(false);
    urlRef.current?.blur();
    setError(null);
    setLatestDownload(null);
    setRunningActions(new Map());
    activeFindRequestRef.current = null;
    findRequestRef.current++;
    setCredentialPrompts([]);
    setPermissionPrompts([]);
    setAuthPrompts([]);
    if (!browser || !conversationId) return;
    const unsubscribe = browser.onEvent((event: BrowserEvent) => {
      if (event.type === 'config-applied') {
        setAppliedDataScope(event.dataScope);
        if (event.enabled) {
          // Config persistence and React rendering intentionally do not wait
          // for serialized Chromium/profile work. A first mount can therefore
          // fail while the native manager is still disabled. The applied event
          // is the authoritative retry edge; do not require a resize, focus,
          // or sidebar remount to recover the retained tab surface.
          setAvailable(true);
          setError(null);
          void refreshNativeMountRef.current().catch(reportError);
          void refreshState();
          void refreshBookmarks();
        }
        return;
      }
      if (event.type === 'profile-scope-changed') {
        stateRequestRef.current++;
        tabSnapshotRevisionRef.current++;
        for (const domain of Object.keys(auxiliarySnapshotRevisionRef.current) as Array<
          keyof typeof auxiliarySnapshotRevisionRef.current
        >) {
          auxiliarySnapshotRevisionRef.current[domain]++;
        }
        actionEventRevisionRef.current++;
        stateSnapshotInFlightRef.current = null;
        clearBrowserSnapshotDeltas(
          actionSnapshotDeltasRef.current,
          credentialPromptSnapshotDeltasRef.current,
          permissionPromptSnapshotDeltasRef.current,
          authPromptSnapshotDeltasRef.current,
        );
        bookmarkRequestRef.current++;
        sitePermissionRequestRef.current++;
        suggestionRequestRef.current++;
        navigationRequestRef.current++;
        activeFindRequestRef.current = null;
        findTabIdRef.current = null;
        findTextRef.current = '';
        findRequestRef.current++;
        setAppliedDataScope(event.dataScope);
        setBookmarks([]);
        setSuggestions([]);
        setActiveSuggestionIndex(-1);
        setUrlDraft('');
        setUrlFocused(false);
        urlRef.current?.blur();
        setFindOpen(false);
        setFindText('');
        setFindResult(null);
        setError(null);
        setLatestDownload(null);
        setSitePermissions([]);
        setCredentialPrompts([]);
        setPermissionPrompts([]);
        setAuthPrompts([]);
        setManagerRevision((revision) => revision + 1);
        setBookmarkRevision((revision) => revision + 1);
        setDownloadRevision((revision) => revision + 1);
        void refreshState();
        void refreshBookmarks();
        return;
      }
      if (event.conversationId !== conversationId) return;
      if (event.type === 'tabs-changed') {
        tabSnapshotRevisionRef.current++;
        const activeTabId = event.tabs.find((tab) => tab.active)?.id ?? null;
        activeTabIdRef.current = activeTabId;
        const current = stateRef.current;
        const next = {
          conversationId,
          tabs: event.tabs.map((tab) => {
            const previous = current?.tabs.find((candidate) => candidate.id === tab.id);
            const hasPendingFavicon = pendingFaviconsRef.current.has(tab.id);
            const pendingFavicon = pendingFaviconsRef.current.get(tab.id);
            const reconciled = hasPendingFavicon
              ? {
                  ...tab,
                  ...(pendingFavicon ? { favicon: pendingFavicon } : { favicon: undefined }),
                }
              : tab;
            if (reconciled.zoomLevel === zoomTargetsRef.current.get(tab.id)) zoomTargetsRef.current.delete(tab.id);
            return !hasPendingFavicon && reconciled.favicon === undefined && previous?.favicon
              ? { ...reconciled, favicon: previous.favicon }
              : reconciled;
          }),
          activeTabId,
        };
        const liveTabIds = new Set(next.tabs.map((tab) => tab.id));
        for (const tabId of pendingFaviconsRef.current.keys()) {
          if (!liveTabIds.has(tabId)) pendingFaviconsRef.current.delete(tabId);
        }
        stateRef.current = next;
        setState(next);
      } else if (event.type === 'tab-favicon') {
        pendingFaviconsRef.current.set(event.tabId, event.favicon);
        const current = stateRef.current;
        if (current) {
          tabSnapshotRevisionRef.current++;
          const next = {
            ...current,
            tabs: current.tabs.map((tab) =>
              tab.id === event.tabId
                ? {
                    ...tab,
                    ...(event.favicon ? { favicon: event.favicon } : { favicon: undefined }),
                  }
                : tab,
            ),
          };
          stateRef.current = next;
          setState(next);
        }
      } else if (event.type === 'find-result' && event.tabId === activeTabIdRef.current) {
        const activeFindRequest = activeFindRequestRef.current;
        if (activeFindRequest?.tabId === event.tabId && activeFindRequest.requestId === event.result.requestId) {
          setFindResult(event.result);
        }
      } else if (event.type === 'shortcut') {
        if (event.action === 'focus-url') focusOmnibox();
        else if (event.action === 'find') openFind();
        else if (event.action === 'find-next' || event.action === 'find-previous') {
          const current = event.action === 'find-next';
          const selected = activeTabIdRef.current;
          const text = findTextRef.current;
          if (selected && text) {
            const requestId = ++findRequestRef.current;
            activeFindRequestRef.current = { tabId: selected, requestId };
            void browser
              .find(conversationId, selected, text, current, true, requestId)
              .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
          }
        }
      } else if (event.type === 'action') {
        auxiliarySnapshotRevisionRef.current.actions++;
        const actionRevision = ++actionEventRevisionRef.current;
        retainBrowserSnapshotDelta(stateSnapshotInFlightRef.current, actionSnapshotDeltasRef.current, event.action.id, {
          revision: actionRevision,
          action: event.action,
        });
        setRunningActions((current) => {
          const next = new Map(current);
          if (event.action.status === 'running') next.set(event.action.id, event.action);
          else next.delete(event.action.id);
          return next;
        });
      } else if (event.type === 'bookmarks-changed') {
        setBookmarkRevision((revision) => revision + 1);
        void refreshBookmarks();
      } else if (event.type === 'profile-error') {
        setError(event.message);
      } else if (event.type === 'profile-data-cleared') {
        // Clearing is authoritative for the live profile. Supersede page-data
        // lookups that started before the native clear so their stale results
        // cannot repopulate the omnibox or Site information afterward.
        suggestionRequestRef.current++;
        sitePermissionRequestRef.current++;
        setSuggestions([]);
        setActiveSuggestionIndex(-1);
        setSitePermissions([]);
        setLatestDownload(null);
        setManagerRevision((revision) => revision + 1);
        void refreshBookmarks();
      } else if (event.type === 'credential-prompt') {
        const revision = ++auxiliarySnapshotRevisionRef.current.credentialPrompts;
        retainBrowserSnapshotDelta(
          stateSnapshotInFlightRef.current,
          credentialPromptSnapshotDeltasRef.current,
          event.prompt.id,
          { revision, prompt: event.prompt },
        );
        setCredentialPrompts((current) => appendPromptOnce(current, event.prompt));
      } else if (event.type === 'permission-prompt') {
        const revision = ++auxiliarySnapshotRevisionRef.current.permissionPrompts;
        retainBrowserSnapshotDelta(
          stateSnapshotInFlightRef.current,
          permissionPromptSnapshotDeltasRef.current,
          event.prompt.id,
          { revision, prompt: event.prompt },
        );
        setPermissionPrompts((current) => appendPromptOnce(current, event.prompt));
      } else if (event.type === 'auth-prompt') {
        const revision = ++auxiliarySnapshotRevisionRef.current.authPrompts;
        retainBrowserSnapshotDelta(
          stateSnapshotInFlightRef.current,
          authPromptSnapshotDeltasRef.current,
          event.prompt.id,
          { revision, prompt: event.prompt },
        );
        setAuthPrompts((current) => appendPromptOnce(current, event.prompt));
      } else if (event.type === 'prompt-dismissed') {
        const remove = <T extends { id: string }>(current: T[]) =>
          current.filter((prompt) => prompt.id !== event.promptId);
        if (event.promptKind === 'credential') {
          const revision = ++auxiliarySnapshotRevisionRef.current.credentialPrompts;
          retainBrowserSnapshotDelta(
            stateSnapshotInFlightRef.current,
            credentialPromptSnapshotDeltasRef.current,
            event.promptId,
            { revision, prompt: null },
          );
          setCredentialPrompts(remove);
        } else if (event.promptKind === 'permission') {
          const revision = ++auxiliarySnapshotRevisionRef.current.permissionPrompts;
          retainBrowserSnapshotDelta(
            stateSnapshotInFlightRef.current,
            permissionPromptSnapshotDeltasRef.current,
            event.promptId,
            { revision, prompt: null },
          );
          setPermissionPrompts(remove);
        } else {
          const revision = ++auxiliarySnapshotRevisionRef.current.authPrompts;
          retainBrowserSnapshotDelta(
            stateSnapshotInFlightRef.current,
            authPromptSnapshotDeltasRef.current,
            event.promptId,
            { revision, prompt: null },
          );
          setAuthPrompts(remove);
        }
      } else if (event.type === 'download') {
        setLatestDownload(event.download);
        setDownloadRevision((revision) => revision + 1);
      } else if (event.type === 'download-history-changed') {
        setLatestDownload((current) => {
          if (current?.id !== event.downloadId) return current;
          if (event.change === 'deleted') return null;
          const unavailable = { ...current };
          delete unavailable.path;
          return unavailable;
        });
        setDownloadRevision((revision) => revision + 1);
      }
    });
    // Subscribe before hydrating. Native prompts/actions can be emitted between
    // the state request and its response; the revision guards in refreshState
    // then keep that live event from being replaced by a stale snapshot.
    void refreshState();
    void refreshBookmarks();
    return () => {
      stateRequestRef.current++;
      stateSnapshotInFlightRef.current = null;
      clearBrowserSnapshotDeltas(
        actionSnapshotDeltasRef.current,
        credentialPromptSnapshotDeltasRef.current,
        permissionPromptSnapshotDeltasRef.current,
        authPromptSnapshotDeltasRef.current,
      );
      bookmarkRequestRef.current++;
      suggestionRequestRef.current++;
      unsubscribe();
    };
  }, [browser, conversationId, focusOmnibox, openFind, refreshBookmarks, refreshState, reportError]);

  useEffect(() => {
    if (active && !urlFocused) setUrlDraft(active.url === 'about:blank' ? '' : active.url);
  }, [active, urlFocused]);

  useEffect(() => {
    if (!active?.id) return;
    const frame = requestAnimationFrame(() => {
      tabButtonRefs.current.get(active.id)?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    });
    return () => cancelAnimationFrame(frame);
  }, [active?.id]);

  useEffect(() => {
    const previousFindTabId = findTabIdRef.current;
    activeFindRequestRef.current = null;
    findRequestRef.current++;
    if (previousFindTabId && previousFindTabId !== active?.id) {
      findTabIdRef.current = null;
      if (browser && conversationId) void browser.stopFind(conversationId, previousFindTabId).catch(reportError);
    }
    setFindResult(null);
  }, [active?.id, browser, conversationId, reportError]);

  useEffect(
    () => () => {
      const findTabId = findTabIdRef.current;
      findTabIdRef.current = null;
      activeFindRequestRef.current = null;
      findRequestRef.current++;
      if (browser && conversationId && findTabId)
        void browser.stopFind(conversationId, findTabId).catch(() => undefined);
    },
    [browser, conversationId],
  );

  useEffect(() => {
    if (findOpen)
      requestAnimationFrame(() => {
        findRef.current?.focus();
        findRef.current?.select();
      });
  }, [findOpen]);

  useLayoutEffect(() => {
    if (!browser || !conversationId) return;
    const element = viewportRef.current;
    const mutationRoot = document.documentElement;
    const overlayCandidates = collectRendererOverlayCandidates(document.body, element);
    let raf = 0;
    let motionTimer: number | null = null;
    const activeMotionTargets = new Map<EventTarget, number>();
    const setMountedBounds = (bounds: { x: number; y: number; width: number; height: number } | null) => {
      const signature = bounds
        ? `${Math.round(bounds.x)}:${Math.round(bounds.y)}:${Math.round(bounds.width)}:${Math.round(bounds.height)}`
        : null;
      if (lastNativeMountRef.current === signature) return;
      lastNativeMountRef.current = signature;
      const mountPromise = browser.mount(conversationId, bounds);
      // Keep the original promise so screenshot and element-picker commands
      // fail closed when the native page could not be remounted. The detached
      // UI error handler is observed separately and must not turn that rejected
      // mount into an apparently successful one.
      void mountPromise.catch((reason) => {
        if (lastNativeMountRef.current !== signature) return;
        // Let a later resize or visibility change retry the same bounds instead
        // of permanently caching a failed native mount.
        lastNativeMountRef.current = undefined;
        setError(reason instanceof Error ? reason.message : String(reason));
      });
      nativeMountPromiseRef.current = mountPromise;
    };
    const report = () => {
      cancelAnimationFrame(raf);
      // Detach synchronously when an overlay appears. Native child views paint
      // above React, so waiting one animation frame leaves a real interval in
      // which input can land on the page behind a newly opened modal.
      if (!nativeVisible || !element || hasIntersectingRendererOverlay(element, overlayCandidates)) {
        setMountedBounds(null);
        return;
      }
      raf = requestAnimationFrame(() => {
        const rect = element.getBoundingClientRect();
        // Native child views always paint above renderer DOM. Detach while a
        // Kai modal/overlay covers the browser viewport so the overlay remains
        // visible and interactive regardless of CSS z-index.
        if (hasIntersectingRendererOverlay(element, overlayCandidates)) {
          setMountedBounds(null);
          return;
        }
        setMountedBounds({
          x: rect.left,
          y: rect.top,
          width: rect.width,
          height: rect.height,
        });
      });
    };
    const refreshNativeMount = async (): Promise<void> => {
      lastNativeMountRef.current = undefined;
      report();
      // report() publishes bounds in its animation-frame callback. Wait for that
      // callback to select the current mount promise, then join main's native
      // attach before starting any page interaction.
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      await nativeMountPromiseRef.current;
    };
    refreshNativeMountRef.current = refreshNativeMount;
    const observedGeometryTargets = new Set<Element>();
    const geometryObserver = new ResizeObserver((entries) => {
      // Ordinary layout elements are admitted as candidates only when their
      // geometry overlaps the native surface. A sidebar/surface resize can
      // create that overlap without mutating either element, so rebuild the
      // bounded candidate set before deciding whether Chromium may stay shown.
      if (element && entries.some((entry) => entry.target === element)) refreshCandidatesAndReport();
      else report();
    });
    const syncGeometryObservers = () => {
      const currentTargets = new Set<Element>(overlayCandidates);
      if (element) currentTargets.add(element);
      for (const target of observedGeometryTargets) {
        if (currentTargets.has(target)) continue;
        geometryObserver.unobserve(target);
        observedGeometryTargets.delete(target);
      }
      for (const target of currentTargets) {
        if (observedGeometryTargets.has(target)) continue;
        geometryObserver.observe(target);
        observedGeometryTargets.add(target);
      }
    };
    const refreshCandidatesAndReport = () => {
      refreshRendererOverlayCandidates(overlayCandidates);
      syncGeometryObservers();
      observeShadowRoots();
      report();
    };
    const startMotionTracking = (event: Event) => {
      if (!isRendererOverlayMotionTarget(event.target, overlayCandidates)) return;
      activeMotionTargets.set(event.target!, (activeMotionTargets.get(event.target!) ?? 0) + 1);
      report();
      if (motionTimer === null) motionTimer = window.setInterval(report, 50);
    };
    const stopMotionTracking = (event: Event) => {
      if (!event.target) return;
      const count = activeMotionTargets.get(event.target);
      if (!count) return;
      if (count === 1) activeMotionTargets.delete(event.target);
      else activeMotionTargets.set(event.target, count - 1);
      report();
      if (activeMotionTargets.size === 0 && motionTimer !== null) {
        window.clearInterval(motionTimer);
        motionTimer = null;
      }
    };
    const observerOptions: MutationObserverInit = {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
    };
    const observedShadowRoots = new Set<ShadowRoot>();
    const observeShadowRoots = () => {
      const currentRoots = new Set(rendererOverlayObservationRoots(overlayCandidates));
      // MutationObserver has no per-target unobserve API. If a shadow host was
      // detached, reset the observer before re-registering current roots so the
      // observer itself cannot retain the removed subtree indefinitely.
      if ([...observedShadowRoots].some((root) => !currentRoots.has(root))) {
        mutationObserver.disconnect();
        mutationObserver.observe(mutationRoot, observerOptions);
        observedShadowRoots.clear();
      }
      for (const root of currentRoots) {
        if (observedShadowRoots.has(root)) continue;
        mutationObserver.observe(root, observerOptions);
        observedShadowRoots.add(root);
      }
    };
    const mutationObserver = new MutationObserver((records) => {
      const overlayMayHaveChanged = updateRendererOverlayCandidates(overlayCandidates, records);
      syncGeometryObservers();
      observeShadowRoots();
      if (overlayMayHaveChanged) report();
    });
    syncGeometryObservers();
    // Head mutations can restyle existing body elements without changing their
    // DOM. Observe the full document element while keeping candidate traversal
    // scoped to body so stylesheet metadata itself is never treated as UI.
    mutationObserver.observe(mutationRoot, observerOptions);
    observeShadowRoots();
    const unsubscribeShadowRoots = subscribeRendererShadowRoots(overlayCandidates, document.body, () => {
      // This runs synchronously inside attachShadow(), before the caller can
      // append children, so the MutationObserver cannot miss the first overlay.
      observeShadowRoots();
      report();
    });
    const unsubscribeDeclarativeShadowChanges = subscribeRendererDeclarativeShadowChanges(
      overlayCandidates,
      document,
      refreshCandidatesAndReport,
    );
    const unsubscribeStylesheetChanges = subscribeRendererStylesheetChanges(
      overlayCandidates,
      document,
      refreshCandidatesAndReport,
    );
    const handleLayoutLoad = (event: Event) => {
      const target = event.target;
      if (target instanceof Element) refreshCandidatesAndReport();
    };
    const handleBeforeToggle = (event: Event) => {
      const toggle = event as Event & { newState?: string };
      if (toggle.newState === 'open' && event.target instanceof Element && event.target.matches('[popover], dialog')) {
        // Top-layer paint state changes before a DOM mutation is observable,
        // and `toggle` may be queued. Detach before the UI opens so the native
        // child cannot cover it or receive the first click.
        setMountedBounds(null);
        return;
      }
      report();
    };
    window.addEventListener('resize', refreshCandidatesAndReport);
    document.addEventListener('load', handleLayoutLoad, true);
    document.addEventListener('loadedmetadata', handleLayoutLoad, true);
    document.addEventListener('beforetoggle', handleBeforeToggle, true);
    document.addEventListener('toggle', refreshCandidatesAndReport, true);
    document.addEventListener('scroll', report, true);
    document.addEventListener('transitionrun', startMotionTracking, true);
    document.addEventListener('transitionend', stopMotionTracking, true);
    document.addEventListener('transitioncancel', stopMotionTracking, true);
    document.addEventListener('animationstart', startMotionTracking, true);
    document.addEventListener('animationend', stopMotionTracking, true);
    document.addEventListener('animationcancel', stopMotionTracking, true);
    window.visualViewport?.addEventListener('scroll', report);
    window.visualViewport?.addEventListener('resize', refreshCandidatesAndReport);
    document.fonts?.addEventListener('loadingdone', refreshCandidatesAndReport);
    report();
    return () => {
      cancelAnimationFrame(raf);
      if (motionTimer !== null) window.clearInterval(motionTimer);
      geometryObserver.disconnect();
      unsubscribeShadowRoots();
      unsubscribeDeclarativeShadowChanges();
      unsubscribeStylesheetChanges();
      mutationObserver.disconnect();
      window.removeEventListener('resize', refreshCandidatesAndReport);
      document.removeEventListener('load', handleLayoutLoad, true);
      document.removeEventListener('loadedmetadata', handleLayoutLoad, true);
      document.removeEventListener('beforetoggle', handleBeforeToggle, true);
      document.removeEventListener('toggle', refreshCandidatesAndReport, true);
      document.removeEventListener('scroll', report, true);
      document.removeEventListener('transitionrun', startMotionTracking, true);
      document.removeEventListener('transitionend', stopMotionTracking, true);
      document.removeEventListener('transitioncancel', stopMotionTracking, true);
      document.removeEventListener('animationstart', startMotionTracking, true);
      document.removeEventListener('animationend', stopMotionTracking, true);
      document.removeEventListener('animationcancel', stopMotionTracking, true);
      window.visualViewport?.removeEventListener('scroll', report);
      window.visualViewport?.removeEventListener('resize', refreshCandidatesAndReport);
      document.fonts?.removeEventListener('loadingdone', refreshCandidatesAndReport);
      if (refreshNativeMountRef.current === refreshNativeMount) {
        refreshNativeMountRef.current = async () => {
          lastNativeMountRef.current = undefined;
        };
      }
      lastNativeMountRef.current = undefined;
      void browser.mount(conversationId, null).catch(() => undefined);
    };
  }, [browser, conversationId, nativeVisible, managerRevision]);

  const createTab = useCallback(
    async (url?: string) => {
      if (!browser || !conversationId) return;
      const requestedConversationId = conversationId;
      const request = ++navigationRequestRef.current;
      setManagerView(null);
      setError(null);
      try {
        await browser.createTab({ conversationId, url, owner: 'user' });
        if (!url || url === 'about:blank') focusOmnibox();
      } catch (reason) {
        if (request !== navigationRequestRef.current || conversationIdRef.current !== requestedConversationId) return;
        setError(String(reason));
      }
    },
    [browser, conversationId, focusOmnibox],
  );

  const command = useCallback(
    async (tab: BrowserTab, action: Parameters<NonNullable<typeof browser>['commandTab']>[2]) => {
      if (!browser || !conversationId) return;
      navigationRequestRef.current++;
      setError(null);
      await browser.commandTab(conversationId, tab.id, action).catch((reason) => setError(String(reason)));
    },
    [browser, conversationId],
  );

  const closeTab = useCallback(
    (tab: BrowserTab, restoreFocus: boolean) => {
      if (!browser || !conversationId) return;
      if (restoreFocus) {
        const tabs = stateRef.current?.tabs ?? [];
        const index = tabs.findIndex((candidate) => candidate.id === tab.id);
        pendingClosedTabFocusRef.current = {
          closedTabId: tab.id,
          preferredTabIds: [tabs[index + 1]?.id, tabs[index - 1]?.id].filter(
            (tabId): tabId is string => typeof tabId === 'string',
          ),
        };
      }
      setError(null);
      void browser.commandTab(conversationId, tab.id, 'close').catch((reason) => {
        if (pendingClosedTabFocusRef.current?.closedTabId === tab.id) pendingClosedTabFocusRef.current = null;
        setError(String(reason));
        requestAnimationFrame(() => tabButtonRefs.current.get(tab.id)?.focus());
      });
    },
    [browser, conversationId],
  );

  const reorderTabByOffset = useCallback(
    async (tab: BrowserTab, offset: -1 | 1): Promise<void> => {
      if (!browser || !conversationId) return;
      const tabs = stateRef.current?.tabs ?? [];
      const from = tabs.findIndex((candidate) => candidate.id === tab.id);
      const to = from + offset;
      if (from < 0 || to < 0 || to >= tabs.length) return;
      const ids = tabs.map((candidate) => candidate.id);
      ids.splice(to, 0, ids.splice(from, 1)[0]);
      setError(null);
      await browser.reorderTabs(conversationId, ids).catch(reportError);
    },
    [browser, conversationId, reportError],
  );

  useLayoutEffect(() => {
    const pending = pendingClosedTabFocusRef.current;
    if (!pending || !state || state.tabs.some((tab) => tab.id === pending.closedTabId)) return;
    pendingClosedTabFocusRef.current = null;
    const adjacent = pending.preferredTabIds
      .map((tabId) => tabButtonRefs.current.get(tabId))
      .find((button): button is HTMLButtonElement => !!button);
    (adjacent ?? emptyNewTabButtonRef.current)?.focus();
  }, [state]);

  const updateZoom = useCallback(
    (tab: BrowserTab, delta: number | 'reset') => {
      if (!browser || !conversationId) return;
      const base = zoomTargetsRef.current.get(tab.id) ?? tab.zoomLevel;
      const target = delta === 'reset' ? 0 : Math.max(-5, Math.min(5, Math.round((base + delta) * 2) / 2));
      zoomTargetsRef.current.set(tab.id, target);
      void browser
        .setZoom(conversationId, tab.id, target)
        .then((applied) => {
          if (zoomTargetsRef.current.get(tab.id) === target && applied === target)
            zoomTargetsRef.current.delete(tab.id);
        })
        .catch((reason) => {
          if (zoomTargetsRef.current.get(tab.id) === target) zoomTargetsRef.current.delete(tab.id);
          reportError(reason);
        });
    },
    [browser, conversationId, reportError],
  );

  useEffect(() => {
    if (!browser || !conversationId) return;
    const clearChromeFocus = () => {
      void browser.setChromeFocus(conversationId, false).catch(() => undefined);
    };
    window.addEventListener('blur', clearChromeFocus);
    return () => {
      window.removeEventListener('blur', clearChromeFocus);
      clearChromeFocus();
    };
  }, [browser, conversationId]);

  const navigate = async (value = urlDraft) => {
    if (!browser || !conversationId) return;
    const requestedConversationId = conversationId;
    const requestedTabId = active?.id ?? null;
    const request = ++navigationRequestRef.current;
    setUrlFocused(false);
    setSuggestions([]);
    setActiveSuggestionIndex(-1);
    setError(null);
    if (!active) {
      await createTab(value);
      return;
    }
    await browser.navigate(conversationId, active.id, value).catch((reason) => {
      if (
        request !== navigationRequestRef.current ||
        conversationIdRef.current !== requestedConversationId ||
        activeTabIdRef.current !== requestedTabId
      ) {
        return;
      }
      setError(String(reason));
    });
  };

  const loadSuggestions = async (query = urlDraft) => {
    if (!browser || !conversationId) return;
    const requestedConversationId = conversationId;
    const request = ++suggestionRequestRef.current;
    try {
      const [history, saved] = await Promise.all([
        browser.listHistory(conversationId, query),
        browser.listBookmarks(conversationId, query),
      ]);
      if (request !== suggestionRequestRef.current || conversationIdRef.current !== requestedConversationId) return;
      setSuggestions([
        ...saved.slice(0, 5).map((item) => ({
          title: item.title,
          url: item.url,
          type: 'bookmark' as const,
        })),
        ...history.slice(0, 7).map((item) => ({
          title: item.title,
          url: item.url,
          type: 'history' as const,
        })),
      ]);
      setActiveSuggestionIndex(-1);
    } catch (reason) {
      if (request !== suggestionRequestRef.current || conversationIdRef.current !== requestedConversationId) return;
      setSuggestions([]);
      setActiveSuggestionIndex(-1);
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const toggleBookmark = async () => {
    if (!browser || !conversationId || !active) return;
    try {
      const existing = bookmarks.find((item) => item.url === active.url);
      if (existing) await browser.removeBookmark(conversationId, existing.id);
      else await browser.addBookmark(conversationId, active.title, active.url);
      await refreshBookmarks();
    } catch (reason) {
      reportError(reason);
    }
  };

  const runFind = (forward: boolean, findNext: boolean, text = findText) => {
    if (browser && conversationId && active) {
      const previousFindTabId = findTabIdRef.current;
      if (previousFindTabId && previousFindTabId !== active.id) {
        void browser.stopFind(conversationId, previousFindTabId).catch(reportError);
      }
      findTabIdRef.current = active.id;
      const requestId = ++findRequestRef.current;
      activeFindRequestRef.current = { tabId: active.id, requestId };
      void browser
        .find(conversationId, active.id, text, forward, findNext, requestId)
        .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
    }
  };

  const closeFind = () => {
    const findTabId = findTabIdRef.current ?? active?.id;
    findTabIdRef.current = null;
    activeFindRequestRef.current = null;
    findRequestRef.current++;
    if (browser && conversationId && findTabId) void browser.stopFind(conversationId, findTabId).catch(reportError);
    setFindOpen(false);
    setFindResult(null);
    restoreBrowserChromeFocus();
  };

  useEffect(() => {
    if (!menuOpen && !browserMenuPreviewPending && !siteInfoOpen && !tabMenu) return;
    const dismissOutside = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (
        (menuOpen || browserMenuPreviewPending) &&
        !menuContainerRef.current?.contains(target) &&
        !browserMenuRef.current?.contains(target)
      )
        dismissBrowserMenu();
      if (
        siteInfoOpen &&
        !siteInfoTriggerRef.current?.contains(target) &&
        !siteInfoPopoverRef.current?.contains(target)
      ) {
        setSiteInfoOpen(false);
      }
      if (tabMenu && !tabContextMenuRef.current?.contains(target)) setTabMenu(null);
    };
    document.addEventListener('pointerdown', dismissOutside, true);
    return () => document.removeEventListener('pointerdown', dismissOutside, true);
  }, [browserMenuPreviewPending, dismissBrowserMenu, menuOpen, siteInfoOpen, tabMenu]);

  const screenshot = async (mode: 'viewport' | 'full-page' | 'element') => {
    if (!browser || !conversationId || !active) return;
    dismissBrowserMenu();
    setError(null);
    try {
      // Menu dismissal is a React commit, while the native Chromium view is
      // mounted by the following layout/animation-frame pass. Join that mount
      // before capture or element picking so these commands never race the
      // protected menu-preview surface.
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      await refreshNativeMountRef.current();
      let selector: string | undefined;
      let documentToken: string | undefined;
      if (mode === 'element') {
        const picked = await browser.pickElement(conversationId, active.id);
        selector = picked.selector;
        documentToken = picked.documentToken;
      }
      await browser.screenshot(conversationId, {
        tabId: active.id,
        mode,
        selector,
        documentToken,
        exportToFile: true,
      });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  useEffect(() => {
    if (!browser || !conversationId) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && (menuOpen || browserMenuPreviewPending || siteInfoOpen || tabMenu)) {
        event.preventDefault();
        const restoreSiteInfoTrigger = siteInfoOpen;
        dismissBrowserMenu();
        setSiteInfoOpen(false);
        setTabMenu(null);
        if (restoreSiteInfoTrigger) requestAnimationFrame(() => siteInfoTriggerRef.current?.focus());
        return;
      }
      const target = event.target;
      if (!(target instanceof Node) || !panelRef.current?.contains(target)) return;
      const isMac = app.platform.os === 'darwin';
      const mod = isMac ? event.metaKey : event.ctrlKey;
      if (event.key === 'Escape') {
        if (findOpen) closeFind();
        else if (active?.loading) void command(active, 'stop');
        return;
      }
      if (
        !isMac &&
        event.altKey &&
        !event.shiftKey &&
        active &&
        (event.key === 'ArrowLeft' || event.key === 'ArrowRight')
      ) {
        event.preventDefault();
        void command(active, event.key === 'ArrowLeft' ? 'back' : 'forward');
        return;
      }
      if (!mod) return;
      const key = event.key.toLowerCase();
      if (key === 't' && event.shiftKey) {
        event.preventDefault();
        void browser.menuAction(conversationId, 'reopen-closed-tab').catch(reportError);
      } else if (key === 't') {
        event.preventDefault();
        void createTab();
      } else if (key === 'w' && active) {
        event.preventDefault();
        const activeTabButton = tabButtonRefs.current.get(active.id);
        closeTab(active, !!activeTabButton?.parentElement?.contains(document.activeElement));
      } else if (key === 'l') {
        event.preventDefault();
        focusOmnibox();
      } else if (key === 'f') {
        event.preventDefault();
        openFind();
      } else if (key === 'r' && active) {
        event.preventDefault();
        void command(active, event.shiftKey ? 'hard-reload' : 'reload');
      } else if (
        active &&
        (key === '[' ||
          key === ']' ||
          (!isEditableBrowserChromeTarget(event.target) && (key === 'arrowleft' || key === 'arrowright')))
      ) {
        event.preventDefault();
        void command(active, key === '[' || key === 'arrowleft' ? 'back' : 'forward');
      } else if (key === 'g' && findText) {
        event.preventDefault();
        runFind(!event.shiftKey, true);
      } else if ((key === '=' || key === '+' || key === '-' || key === '0') && active) {
        event.preventDefault();
        updateZoom(active, key === '0' ? 'reset' : key === '-' ? -0.5 : 0.5);
      } else if (/^[1-9]$/.test(key) && state?.tabs.length) {
        event.preventDefault();
        const index = key === '9' ? state.tabs.length - 1 : Number(key) - 1;
        const target = state.tabs[index];
        if (target) void command(target, 'activate');
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [
    active,
    browser,
    browserMenuPreviewPending,
    command,
    closeTab,
    conversationId,
    createTab,
    dismissBrowserMenu,
    findOpen,
    findText,
    menuOpen,
    openFind,
    reportError,
    siteInfoOpen,
    state?.tabs,
    tabMenu,
    updateZoom,
  ]);

  if (!conversationId) return <EmptyState title="No active chat" detail="Browser tabs belong to a chat." />;
  if (!browserEnabled) {
    return <EmptyState title="Browser disabled" detail="Enable the in-app browser in Kai Settings → Browser." />;
  }
  if (available === false || !browser) {
    return (
      <EmptyState
        title="Desktop browser unavailable"
        detail="The native browser is available in the Kai desktop app only."
      />
    );
  }
  if (available === null)
    return <EmptyState title="Starting browser…" detail="Connecting to Electron Chromium." loading />;

  const currentBookmarked = !!active && bookmarks.some((item) => item.url === active.url);

  return (
    <div
      ref={panelRef}
      data-kai-browser-panel
      className="relative flex h-full min-h-0 flex-col bg-background text-foreground"
      onClick={() => setTabMenu(null)}
      onFocusCapture={() => void browser.setChromeFocus(conversationId, true).catch(() => undefined)}
      onBlurCapture={(event) => {
        const next = event.relatedTarget;
        if (!(next instanceof Node) || !event.currentTarget.contains(next)) {
          void browser.setChromeFocus(conversationId, false).catch(() => undefined);
        }
      }}
    >
      <div
        className="titlebar-no-drag flex h-9 shrink-0 items-end gap-0.5 overflow-x-auto border-b border-border/60 bg-muted/30 px-1 pt-1"
        role="tablist"
        aria-label="Browser tabs"
      >
        {(state?.tabs ?? []).map((tab, tabIndex) => (
          <div
            key={tab.id}
            draggable
            onDragStart={() => setDraggedTabId(tab.id)}
            onDragOver={(event) => event.preventDefault()}
            onDrop={() => {
              if (!draggedTabId || draggedTabId === tab.id || !browser) return;
              const ids = state!.tabs.map((item) => item.id);
              const from = ids.indexOf(draggedTabId);
              const to = ids.indexOf(tab.id);
              if (from < 0 || to < 0) {
                setDraggedTabId(null);
                return;
              }
              ids.splice(to, 0, ids.splice(from, 1)[0]);
              void browser.reorderTabs(conversationId, ids).catch(reportError);
              setDraggedTabId(null);
            }}
            onDragEnd={() => setDraggedTabId(null)}
            onAuxClick={(event) => {
              if (event.button === 1) {
                const tabButton = tabButtonRefs.current.get(tab.id);
                closeTab(tab, !!tabButton?.parentElement?.contains(document.activeElement));
              }
            }}
            onContextMenu={(event) => {
              event.preventDefault();
              event.stopPropagation();
              dismissBrowserMenu();
              setSiteInfoOpen(false);
              setTabMenu({ tabId: tab.id, x: event.clientX, y: event.clientY });
            }}
            className={cn(
              'group titlebar-no-drag relative h-8 min-w-[92px] max-w-[180px] flex-1 rounded-t-lg border border-transparent text-[11px]',
              tab.active
                ? 'border-border/70 border-b-background bg-background'
                : 'text-muted-foreground hover:bg-muted/70',
            )}
          >
            <button
              ref={(element) => {
                if (element) tabButtonRefs.current.set(tab.id, element);
                else tabButtonRefs.current.delete(tab.id);
              }}
              type="button"
              role="tab"
              aria-label={tab.title || 'New Tab'}
              aria-selected={tab.active}
              aria-controls={viewportId}
              tabIndex={tab.active ? 0 : -1}
              onClick={() => void command(tab, 'activate')}
              onKeyDown={(event) => {
                if (event.altKey && event.shiftKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
                  event.preventDefault();
                  event.stopPropagation();
                  void reorderTabByOffset(tab, event.key === 'ArrowLeft' ? -1 : 1);
                  return;
                }
                if (!state?.tabs.length || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
                event.preventDefault();
                const targetIndex =
                  event.key === 'Home'
                    ? 0
                    : event.key === 'End'
                      ? state.tabs.length - 1
                      : (tabIndex + (event.key === 'ArrowRight' ? 1 : -1) + state.tabs.length) % state.tabs.length;
                const target = state.tabs[targetIndex];
                if (!target) return;
                void command(target, 'activate');
                requestAnimationFrame(() => tabButtonRefs.current.get(target.id)?.focus());
              }}
              className="flex h-full w-full items-center gap-1.5 rounded-t-lg px-2 pr-7 outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
              title={tab.title}
            >
              {tab.loading ? (
                <Loader2Icon className="h-3 w-3 shrink-0 animate-spin" />
              ) : tab.favicon ? (
                <img src={tab.favicon} className="h-3 w-3 shrink-0" alt="" />
              ) : (
                <GlobeIcon className="h-3 w-3 shrink-0" />
              )}
              <span className="min-w-0 flex-1 truncate text-left">{tab.title || 'New Tab'}</span>
              {tab.owner === 'assistant' && (
                <BotIcon className="h-3 w-3 shrink-0 text-violet-500" aria-label="AI-created" />
              )}
              {tab.audible && <Volume2Icon className="h-3 w-3 shrink-0" />}
              {tab.discarded && (
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-muted-foreground/50" title="Unloaded" />
              )}
            </button>
            <button
              type="button"
              aria-label={`Close ${tab.title || 'New Tab'}`}
              title={`Close ${tab.title || 'New Tab'}`}
              onClick={(event) => {
                event.stopPropagation();
                const tabButton = tabButtonRefs.current.get(tab.id);
                closeTab(tab, !!tabButton?.parentElement?.contains(document.activeElement));
              }}
              className="invisible absolute right-1 top-1/2 -translate-y-1/2 rounded p-0.5 hover:bg-muted focus:visible focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 group-hover:visible group-focus-within:visible"
            >
              <XIcon className="h-3 w-3" />
            </button>
          </div>
        ))}
        <button
          type="button"
          className={cn(iconButton, 'mb-0.5')}
          onClick={() => void createTab()}
          title="New tab (⌘/Ctrl+T)"
        >
          <PlusIcon className="h-4 w-4" />
        </button>
      </div>

      <div className="titlebar-no-drag relative z-10 flex min-h-10 shrink-0 flex-wrap items-center gap-1 border-b border-border/60 bg-background px-1.5 py-1">
        <button
          className={iconButton}
          disabled={!active?.canGoBack}
          onClick={() => active && void command(active, 'back')}
          title="Back"
        >
          <ArrowLeftIcon className="h-4 w-4" />
        </button>
        <button
          className={iconButton}
          disabled={!active?.canGoForward}
          onClick={() => active && void command(active, 'forward')}
          title="Forward"
        >
          <ArrowRightIcon className="h-4 w-4" />
        </button>
        <button
          className={iconButton}
          disabled={!active}
          onClick={() => active && void command(active, active.loading ? 'stop' : 'reload')}
          title={active?.loading ? 'Stop' : 'Reload'}
        >
          {active?.loading ? <XIcon className="h-4 w-4" /> : <RefreshCwIcon className="h-3.5 w-3.5" />}
        </button>
        <div className="relative min-w-36 flex-[1_1_12rem]">
          <div className="flex h-7 items-center rounded-full border border-border/70 bg-muted/35 px-2 focus-within:border-primary/50 focus-within:bg-background">
            <button
              ref={siteInfoTriggerRef}
              type="button"
              onClick={() => {
                dismissBrowserMenu();
                setTabMenu(null);
                setSiteInfoOpen((open) => !open);
              }}
              className="mr-1.5 shrink-0"
              title="Site information"
              aria-haspopup="dialog"
              aria-expanded={siteInfoOpen}
            >
              {active?.security === 'secure' ? (
                <ShieldCheckIcon className="h-3.5 w-3.5 text-emerald-500" />
              ) : active?.security === 'insecure' ? (
                <ShieldAlertIcon className="h-3.5 w-3.5 text-amber-500" />
              ) : (
                <GlobeIcon className="h-3.5 w-3.5 text-muted-foreground" />
              )}
            </button>
            <input
              ref={urlRef}
              value={urlDraft}
              onChange={(event) => {
                setUrlDraft(event.target.value);
                setActiveSuggestionIndex(-1);
                void loadSuggestions(event.target.value);
              }}
              onFocus={() => {
                setUrlFocused(true);
                void loadSuggestions();
              }}
              onBlur={() => setTimeout(() => setUrlFocused(false), 150)}
              onKeyDown={(event) => {
                if (event.key === 'ArrowDown' && suggestions.length > 0) {
                  event.preventDefault();
                  setActiveSuggestionIndex((index) => (index + 1) % suggestions.length);
                } else if (event.key === 'ArrowUp' && suggestions.length > 0) {
                  event.preventDefault();
                  setActiveSuggestionIndex((index) => (index <= 0 ? suggestions.length - 1 : index - 1));
                } else if (event.key === 'Enter') {
                  event.preventDefault();
                  const suggestion = suggestions[activeSuggestionIndex];
                  if (suggestion) {
                    setUrlDraft(suggestion.url);
                    void navigate(suggestion.url);
                  } else void navigate();
                } else if (event.key === 'Escape') {
                  event.preventDefault();
                  suggestionRequestRef.current++;
                  if (suggestions.length > 0) {
                    setSuggestions([]);
                    setActiveSuggestionIndex(-1);
                    event.currentTarget.focus();
                  } else {
                    setUrlDraft(active?.url ?? '');
                    event.currentTarget.blur();
                  }
                }
              }}
              className="min-w-0 flex-1 bg-transparent text-[11px] outline-none"
              placeholder="Search or enter address"
              aria-label="Address and search bar"
              role="combobox"
              aria-autocomplete="list"
              aria-expanded={urlFocused && suggestions.length > 0}
              aria-controls={suggestionListId}
              aria-activedescendant={
                activeSuggestionIndex >= 0 ? `${suggestionListId}-option-${activeSuggestionIndex}` : undefined
              }
            />
            <button
              type="button"
              onClick={() => void toggleBookmark()}
              className="ml-1 text-muted-foreground hover:text-foreground"
              title={currentBookmarked ? 'Remove bookmark' : 'Bookmark this tab'}
            >
              <StarIcon className={cn('h-3.5 w-3.5', currentBookmarked && 'fill-amber-400 text-amber-400')} />
            </button>
          </div>
          {urlFocused && suggestions.length > 0 && (
            <div
              id={suggestionListId}
              role="listbox"
              className="absolute left-0 right-0 top-8 z-50 max-h-72 overflow-y-auto rounded-lg border border-border bg-popover p-1 shadow-xl"
            >
              {suggestions.map((item, index) => (
                <button
                  key={`${item.type}-${item.url}-${index}`}
                  id={`${suggestionListId}-option-${index}`}
                  type="button"
                  role="option"
                  aria-selected={activeSuggestionIndex === index}
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => setActiveSuggestionIndex(index)}
                  onClick={() => {
                    setUrlDraft(item.url);
                    void navigate(item.url);
                  }}
                  className={cn(
                    'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-accent',
                    activeSuggestionIndex === index && 'bg-accent',
                  )}
                >
                  {item.type === 'bookmark' ? (
                    <StarIcon className="h-3.5 w-3.5 text-amber-500" />
                  ) : (
                    <HistoryIcon className="h-3.5 w-3.5 text-muted-foreground" />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs">{item.title}</span>
                    <span className="block truncate text-[10px] text-muted-foreground">{item.url}</span>
                  </span>
                </button>
              ))}
            </div>
          )}
          {siteInfoOpen && active && (
            <div
              ref={siteInfoPopoverRef}
              role="dialog"
              tabIndex={-1}
              aria-label="Site information"
              className="absolute left-0 right-0 top-8 z-50 max-h-[calc(100vh-1rem)] min-w-0 overflow-y-auto rounded-lg border border-border bg-popover p-3 text-xs shadow-xl"
            >
              <div className="mb-2 flex items-center gap-2">
                {active.security === 'secure' ? (
                  <ShieldCheckIcon className="h-5 w-5 text-emerald-500" />
                ) : (
                  <ShieldAlertIcon className="h-5 w-5 text-amber-500" />
                )}
                <div className="min-w-0 flex-1">
                  <p className="font-medium">
                    {active.security === 'secure'
                      ? 'Connection is secure'
                      : active.security === 'insecure'
                        ? 'Connection is not secure'
                        : active.security === 'internal'
                          ? 'Internal browser page'
                          : 'Security status unavailable'}
                  </p>
                  <p dir="ltr" className="max-w-full break-all text-left text-[10px] text-muted-foreground">
                    {activePermissionOrigin ?? active.url}
                  </p>
                </div>
              </div>
              <p className="text-[10px] text-muted-foreground">
                Cookies and site storage use the{' '}
                {(config?.browser as { dataScope?: string } | undefined)?.dataScope === 'conversation'
                  ? 'conversation'
                  : 'app-wide'}{' '}
                browser profile. Site permissions are remembered per profile.
              </p>
              {activePermissionOrigin ? (
                <div className="mt-2 border-t border-border/60 pt-2">
                  <div className="mb-1.5 flex items-center justify-between gap-2">
                    <p className="font-medium">Site permissions</p>
                    {sitePermissions.length > 0 && (
                      <button
                        type="button"
                        className="rounded px-1.5 py-0.5 text-[10px] hover:bg-accent"
                        onClick={() => void resetDisplayedSitePermissions(activePermissionOrigin)}
                      >
                        Reset all
                      </button>
                    )}
                  </div>
                  {sitePermissions.length === 0 ? (
                    <p className="text-[10px] text-muted-foreground">No remembered decisions for this site.</p>
                  ) : (
                    <div className="space-y-1">
                      {sitePermissions.map((permission) => (
                        <div
                          key={permission.permission}
                          className="flex min-w-0 items-center gap-2 rounded bg-muted/40 px-1.5 py-1"
                        >
                          <span className="min-w-0 flex-1 break-all text-[10px]">{permission.permission}</span>
                          <span className="text-[10px] capitalize text-muted-foreground">{permission.decision}</span>
                          <button
                            type="button"
                            className="rounded px-1.5 py-0.5 text-[10px] hover:bg-accent"
                            aria-label={`Reset ${permission.permission} permission`}
                            onClick={() =>
                              void resetDisplayedSitePermissions(activePermissionOrigin, permission.permission)
                            }
                          >
                            Reset
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ) : (
                <p className="mt-2 text-[10px] text-muted-foreground">
                  Site permissions are unavailable for this internal page.
                </p>
              )}
            </div>
          )}
        </div>
        {activeRunningActions.length > 0 && (
          <span
            role="status"
            aria-live="polite"
            className="max-w-24 truncate rounded-full bg-violet-500/15 px-2 py-1 text-[9px] text-violet-600"
          >
            {activeRunningActions.length === 1
              ? `Kai · ${activeRunningActions[0]?.summary ?? 'working'}`
              : `Kai · ${activeRunningActions.length} actions`}
          </span>
        )}
        <button
          className={iconButton}
          disabled={!active}
          onClick={() => void screenshot('viewport')}
          title="Capture viewport"
        >
          <CameraIcon className="h-3.5 w-3.5" />
        </button>
        <div ref={menuContainerRef} className="relative">
          <button
            ref={menuTriggerRef}
            className={iconButton}
            onClick={toggleBrowserMenu}
            title="Browser menu"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
          >
            <MoreHorizontalIcon className="h-4 w-4" />
          </button>
          {menuOpen && (
            <BrowserMenu
              anchor={menuTriggerRef.current}
              menuRef={(element) => {
                browserMenuRef.current = element;
              }}
              onSelect={(action) => void handleMenuAction(action).catch(reportError)}
              onDismiss={() => {
                dismissBrowserMenu();
                requestAnimationFrame(() => {
                  if (managerViewRef.current === null) menuTriggerRef.current?.focus();
                });
              }}
            />
          )}
        </div>
      </div>

      {browserConfig.showBookmarksBar && bookmarks.length > 0 && (
        <div className="flex h-7 shrink-0 items-center gap-1 overflow-x-auto border-b border-border/50 bg-muted/20 px-2">
          {bookmarks.slice(0, 20).map((bookmark) => (
            <button
              key={bookmark.id}
              type="button"
              onClick={() => void navigate(bookmark.url)}
              className="flex max-w-36 shrink-0 items-center gap-1 rounded px-1.5 py-1 text-[10px] hover:bg-accent"
              title={bookmark.url}
            >
              <BookmarkIcon className="h-3 w-3" />
              <span className="truncate">{bookmark.title}</span>
            </button>
          ))}
        </div>
      )}

      {findOpen && (
        <div
          data-testid="browser-find-bar"
          className="flex min-h-9 shrink-0 flex-wrap items-center justify-end gap-1 border-b border-border/50 bg-background px-2 py-1"
        >
          <SearchIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <input
            ref={findRef}
            value={findText}
            onChange={(event) => {
              setFindText(event.target.value);
              if (!event.target.value) setFindResult(null);
              runFind(true, false, event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') runFind(!event.shiftKey, true);
              else if (event.key === 'Escape') closeFind();
            }}
            className="h-6 min-w-24 flex-1 rounded border border-border bg-muted/30 px-2 text-[11px] outline-none focus:border-primary/50"
            placeholder="Find in page"
            aria-label="Find in page"
          />
          <span className="w-12 shrink-0 text-center text-[10px] text-muted-foreground" aria-live="polite">
            {findResult ? `${findResult.activeMatchOrdinal}/${findResult.matches}` : '0/0'}
          </span>
          <button
            type="button"
            className={iconButton}
            onClick={() => runFind(false, true)}
            title="Previous match"
            aria-label="Previous match"
          >
            ↑
          </button>
          <button
            type="button"
            className={iconButton}
            onClick={() => runFind(true, true)}
            title="Next match"
            aria-label="Next match"
          >
            ↓
          </button>
          <button type="button" className={iconButton} onClick={closeFind} title="Close find" aria-label="Close find">
            <XIcon className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {error && (
        <div
          role="alert"
          className="flex shrink-0 items-center justify-between gap-2 border-b border-destructive/30 bg-destructive/10 px-2 py-1 text-[10px] text-destructive"
        >
          <span className="truncate">{error}</span>
          <button type="button" aria-label="Dismiss browser error" onClick={() => setError(null)}>
            <XIcon className="h-3 w-3" />
          </button>
        </div>
      )}
      {active?.error && (
        <div
          role="alert"
          className="flex shrink-0 items-center justify-between gap-2 border-b border-destructive/30 bg-destructive/10 px-2 py-1 text-[10px] text-destructive"
        >
          <span className="truncate">Could not load this page: {active.error}</span>
          <button
            type="button"
            className="rounded px-2 py-1 hover:bg-destructive/10"
            onClick={() => void command(active, 'reload')}
          >
            Retry
          </button>
        </div>
      )}
      {credentialPrompts[0] && (
        <CredentialSavePrompt
          key={credentialPrompts[0].id}
          prompt={credentialPrompts[0]}
          shouldFocus={!permissionPrompts[0] && !authPrompts[0]}
          canFocus={canFocusBrowserPrompt}
          onError={(message) => setError(message)}
          onSaved={() => setManagerRevision((revision) => revision + 1)}
          onClose={() => {
            const promptId = credentialPrompts[0]?.id;
            setCredentialPrompts((current) => current.filter((prompt) => prompt.id !== promptId));
            restorePromptOrBrowserChromeFocus();
          }}
        />
      )}
      {permissionPrompts[0] && (
        <PermissionPrompt
          key={permissionPrompts[0].id}
          prompt={permissionPrompts[0]}
          shouldFocus={!authPrompts[0] && !permissionPrompts[0].assistantTriggered}
          canFocus={canFocusBrowserPrompt}
          onError={(message) => setError(message)}
          onClose={() => {
            const promptId = permissionPrompts[0]?.id;
            setPermissionPrompts((current) => current.filter((prompt) => prompt.id !== promptId));
            restorePromptOrBrowserChromeFocus();
          }}
        />
      )}
      {authPrompts[0] && (
        <AuthPrompt
          key={authPrompts[0].id}
          prompt={authPrompts[0]}
          shouldFocus={!authPrompts[0].assistantTriggered}
          canFocus={canFocusBrowserPrompt}
          onError={(message) => setError(message)}
          onClose={() => {
            const promptId = authPrompts[0]?.id;
            setAuthPrompts((current) => current.filter((prompt) => prompt.id !== promptId));
            restorePromptOrBrowserChromeFocus();
          }}
        />
      )}
      {latestDownload && (
        <div className="flex shrink-0 items-center gap-2 border-b border-border bg-muted/30 px-2 py-1.5 text-[10px]">
          <DownloadIcon className="h-3.5 w-3.5" />
          {latestDownload.path ? (
            <button
              type="button"
              className="min-w-0 flex-1 truncate text-left hover:underline"
              onClick={() =>
                void (
                  latestDownload.quarantined
                    ? browser.exportDownload(conversationId, latestDownload.id)
                    : browser.showDownload(conversationId, latestDownload.id)
                ).catch(reportError)
              }
            >
              {latestDownload.filename} · {latestDownload.state}
              {latestDownload.quarantined && latestDownload.state === 'completed' ? ' · export to use' : ''}
            </button>
          ) : (
            <span className="min-w-0 flex-1 truncate text-left text-muted-foreground">
              {latestDownload.filename} · {latestDownload.state} · file unavailable
            </span>
          )}
          {latestDownload.state === 'progressing' && (
            <button
              type="button"
              className={iconButton}
              title="Cancel download"
              onClick={() => void browser.cancelDownload(conversationId, latestDownload.id).catch(reportError)}
            >
              <XIcon className="h-3 w-3" />
            </button>
          )}
          <button
            type="button"
            className={iconButton}
            title="Open downloads"
            onClick={() => setManagerView('downloads')}
          >
            <ExternalLinkIcon className="h-3 w-3" />
          </button>
          <button type="button" className={iconButton} title="Dismiss download" onClick={() => setLatestDownload(null)}>
            <XIcon className="h-3 w-3" />
          </button>
        </div>
      )}

      <div
        id={viewportId}
        ref={viewportRef}
        data-browser-native-surface
        className="relative min-h-0 flex-1 bg-white dark:bg-neutral-950"
      >
        {menuOpen && !managerView && active && (
          <div
            data-testid="browser-menu-page-preview"
            className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center overflow-hidden bg-background"
          >
            {browserMenuPreview ? (
              <img
                src={browserMenuPreview}
                alt=""
                draggable={false}
                className="h-full w-full select-none object-fill"
              />
            ) : (
              <div className="flex max-w-64 flex-col items-center gap-2 px-4 text-center text-muted-foreground">
                {browserMenuPreviewPending ? (
                  <Loader2Icon className="h-5 w-5 animate-spin" />
                ) : (
                  <ShieldCheckIcon className="h-5 w-5" />
                )}
                <p className="text-xs">
                  {active.sensitive
                    ? 'Sensitive page hidden while Browser controls are open.'
                    : browserMenuPreviewPending
                      ? 'Preserving the current page…'
                      : 'Page preview unavailable while Browser controls are open.'}
                </p>
              </div>
            )}
          </div>
        )}
        {managerView && (
          <BrowserManagerView
            key={`${conversationId}:${appliedDataScope}:${managerView}:${managerRevision}`}
            kind={managerView}
            conversationId={conversationId}
            refreshRevision={
              managerView === 'bookmarks' ? bookmarkRevision : managerView === 'downloads' ? downloadRevision : 0
            }
            onClose={closeManagerView}
            onNavigate={(url) => {
              setManagerView(null);
              void navigate(url);
            }}
            onBookmarksChanged={() => void refreshBookmarks()}
            onError={reportError}
          />
        )}
        {!managerView && (state?.tabs.length ?? 0) === 0 && (
          <div className="flex h-full items-center justify-center">
            <button
              ref={emptyNewTabButtonRef}
              type="button"
              onClick={() => void createTab()}
              className="rounded-lg border border-border bg-background px-3 py-2 text-xs shadow-sm hover:bg-accent"
            >
              Open a new tab
            </button>
          </div>
        )}
        {!managerView && active?.reloadRequired && (
          <div
            role="alert"
            className="flex h-full flex-col items-center justify-center gap-3 bg-background p-6 text-center"
          >
            <ShieldAlertIcon className="h-7 w-7 text-amber-500" />
            <div>
              <p className="text-sm font-medium">Reload required</p>
              <p className="mt-1 max-w-sm text-xs text-muted-foreground">
                Kai ran JavaScript in this page. Reload it or navigate to a new URL before interacting with it.
              </p>
            </div>
            <div className="flex flex-wrap items-center justify-center gap-2">
              <button
                type="button"
                className="rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground hover:bg-primary/90"
                onClick={() => void command(active, 'reload')}
              >
                Reload page
              </button>
              <button
                type="button"
                className="rounded-md border border-border bg-background px-3 py-1.5 text-xs hover:bg-accent"
                onClick={focusOmnibox}
              >
                Enter another URL
              </button>
            </div>
          </div>
        )}
      </div>

      {tabMenu && (
        <TabContextMenu
          position={tabMenu}
          tab={state?.tabs.find((tab) => tab.id === tabMenu.tabId) ?? null}
          canMoveLeft={(state?.tabs.findIndex((tab) => tab.id === tabMenu.tabId) ?? -1) > 0}
          canMoveRight={
            (state?.tabs.findIndex((tab) => tab.id === tabMenu.tabId) ?? -1) >= 0 &&
            (state?.tabs.findIndex((tab) => tab.id === tabMenu.tabId) ?? -1) < (state?.tabs.length ?? 0) - 1
          }
          menuRef={(element) => {
            tabContextMenuRef.current = element;
          }}
          onAction={(tab, action) => {
            const originalTabId = tab.id;
            setTabMenu(null);
            const operation =
              action === 'move-left'
                ? reorderTabByOffset(tab, -1)
                : action === 'move-right'
                  ? reorderTabByOffset(tab, 1)
                  : command(tab, action);
            void operation.finally(() => {
              requestAnimationFrame(() => {
                const currentActiveId = activeTabIdRef.current;
                const target =
                  (currentActiveId ? tabButtonRefs.current.get(currentActiveId) : undefined) ??
                  tabButtonRefs.current.get(originalTabId);
                target?.focus();
              });
            });
          }}
          onDismiss={() => {
            const tabId = tabMenu.tabId;
            setTabMenu(null);
            requestAnimationFrame(() => tabButtonRefs.current.get(tabId)?.focus());
          }}
        />
      )}
    </div>
  );

  async function handleMenuAction(action: string) {
    dismissBrowserMenu();
    if (!browser || !conversationId) return;
    const movesFocus =
      action === 'new-tab' ||
      action === 'find' ||
      action === 'history' ||
      action === 'bookmarks' ||
      action === 'downloads' ||
      action === 'passwords' ||
      action === 'settings' ||
      action === 'devtools';
    try {
      if (action === 'new-tab') await createTab();
      else if (action === 'reopen') await browser.menuAction(conversationId, 'reopen-closed-tab');
      else if (action === 'find') openFind();
      else if (action === 'copy-url' && active) await navigator.clipboard.writeText(active.url);
      else if (action === 'paste-go') await navigate(await navigator.clipboard.readText());
      else if (action === 'history' || action === 'bookmarks' || action === 'downloads' || action === 'passwords') {
        managerViewRef.current = action;
        setManagerView(action);
      } else if (action === 'print') await browser.menuAction(conversationId, 'print');
      else if (action === 'zoom-in' && active) updateZoom(active, 0.5);
      else if (action === 'zoom-out' && active) updateZoom(active, -0.5);
      else if (action === 'zoom-reset' && active) updateZoom(active, 'reset');
      else if (action === 'viewport') await screenshot('viewport');
      else if (action === 'full-page') await screenshot('full-page');
      else if (action === 'element') await screenshot('element');
      else if (
        action === 'clear' &&
        window.confirm(
          'Clear browser cookies, storage, history, bookmarks, permissions, saved passwords, retained Browser screenshots, and unexported assistant download quarantine copies for the current browser profile? Files you already exported or saved remain on disk.',
        )
      ) {
        setError(null);
        try {
          await browser.clearData({ conversationId });
        } catch (reason) {
          setError(reason instanceof Error ? reason.message : String(reason));
        }
      } else if (action === 'settings') {
        window.dispatchEvent(
          new CustomEvent('kai:navigate-settings', {
            detail: { section: 'browser' },
          }),
        );
        window.dispatchEvent(new CustomEvent('kai:open-settings'));
      } else if (action === 'devtools') await browser.menuAction(conversationId, 'devtools');
    } finally {
      if (!movesFocus)
        requestAnimationFrame(() => {
          if (managerViewRef.current === null) menuTriggerRef.current?.focus();
        });
    }
  }
};

const EmptyState: FC<{ title: string; detail: string; loading?: boolean }> = ({ title, detail, loading }) => (
  <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
    {loading ? (
      <Loader2Icon className="h-5 w-5 animate-spin text-muted-foreground" />
    ) : (
      <GlobeIcon className="h-6 w-6 text-muted-foreground" />
    )}
    <p className="text-sm font-medium">{title}</p>
    <p className="max-w-xs text-xs text-muted-foreground">{detail}</p>
  </div>
);

const BrowserMenu: FC<{
  anchor: HTMLElement | null;
  menuRef: (element: HTMLDivElement | null) => void;
  onSelect: (action: string) => void;
  onDismiss: () => void;
}> = ({ anchor, menuRef, onSelect, onDismiss }) => {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: 8, top: 8, width: 224, maxHeight: 320 });
  useLayoutEffect(() => {
    const update = () => {
      const element = ref.current;
      if (!element || !anchor) return;
      const margin = 8;
      const gap = 4;
      const anchorRect = anchor.getBoundingClientRect();
      const menuRect = element.getBoundingClientRect();
      const viewportWidth = window.visualViewport?.width ?? window.innerWidth;
      const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
      const width = Math.max(0, Math.min(224, viewportWidth - margin * 2));
      const measuredHeight = Math.min(menuRect.height, viewportHeight - margin * 2);
      const preferredTop = anchorRect.bottom + gap;
      const top = Math.max(margin, Math.min(preferredTop, viewportHeight - measuredHeight - margin));
      setPosition({
        left: Math.max(margin, Math.min(anchorRect.right - width, viewportWidth - width - margin)),
        top,
        width,
        maxHeight: Math.max(0, viewportHeight - top - margin),
      });
    };
    update();
    window.addEventListener('resize', update);
    window.visualViewport?.addEventListener('resize', update);
    return () => {
      window.removeEventListener('resize', update);
      window.visualViewport?.removeEventListener('resize', update);
    };
  }, [anchor]);
  useEffect(() => {
    requestAnimationFrame(() => menuItems(ref.current ?? document.body)[0]?.focus());
  }, []);
  return createPortal(
    <div
      ref={(element) => {
        ref.current = element;
        menuRef(element);
      }}
      role="menu"
      aria-label="Browser menu"
      onKeyDown={(event) => handleMenuNavigation(event, onDismiss)}
      className="fixed z-[100] overflow-y-auto rounded-lg border border-border bg-popover p-1 text-xs shadow-xl"
      style={position}
    >
      {[
        ['new-tab', 'New tab'],
        ['reopen', 'Reopen closed tab'],
        ['find', 'Find in page'],
        ['copy-url', 'Copy page URL'],
        ['paste-go', 'Paste and go / search'],
        ['history', 'History'],
        ['bookmarks', 'Bookmarks'],
        ['downloads', 'Downloads'],
        ['passwords', 'Passwords'],
        ['zoom-in', 'Zoom in'],
        ['zoom-out', 'Zoom out'],
        ['zoom-reset', 'Reset zoom'],
        ['viewport', 'Screenshot viewport'],
        ['full-page', 'Screenshot full page'],
        ['element', 'Screenshot component'],
        ['print', 'Print…'],
        ['clear', 'Clear browser data…'],
        ['settings', 'Browser settings'],
        ['devtools', 'Developer tools'],
      ].map(([value, label]) => (
        <button
          key={value}
          type="button"
          role="menuitem"
          onClick={() => onSelect(value)}
          className="block w-full rounded px-2 py-1.5 text-left hover:bg-accent focus:bg-accent focus:outline-none"
        >
          {label}
        </button>
      ))}
    </div>,
    document.body,
  );
};

const TabContextMenu: FC<{
  position: { tabId: string; x: number; y: number };
  tab: BrowserTab | null;
  canMoveLeft: boolean;
  canMoveRight: boolean;
  onAction: (tab: BrowserTab, action: TabContextAction) => void;
  menuRef: (element: HTMLDivElement | null) => void;
  onDismiss: () => void;
}> = ({ position, tab, canMoveLeft, canMoveRight, onAction, menuRef, onDismiss }) => {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [clampedPosition, setClampedPosition] = useState({
    left: position.x,
    top: position.y,
  });
  useLayoutEffect(() => {
    const update = () => {
      const element = rootRef.current;
      if (!element) return;
      const rect = element.getBoundingClientRect();
      const margin = 8;
      setClampedPosition({
        left: Math.max(margin, Math.min(position.x, window.innerWidth - rect.width - margin)),
        top: Math.max(margin, Math.min(position.y, window.innerHeight - rect.height - margin)),
      });
    };
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, [position.x, position.y]);
  useEffect(() => {
    requestAnimationFrame(() => menuItems(rootRef.current ?? document.body)[0]?.focus());
  }, []);
  if (!tab) return null;
  return (
    <div
      ref={(element) => {
        rootRef.current = element;
        menuRef(element);
      }}
      role="menu"
      aria-label={`Tab menu for ${tab.title || 'New Tab'}`}
      className="fixed z-[100] max-h-[calc(100vh-1rem)] w-44 max-w-[calc(100vw-1rem)] overflow-y-auto rounded-lg border border-border bg-popover p-1 text-xs shadow-xl"
      style={clampedPosition}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => handleMenuNavigation(event, onDismiss)}
    >
      <button
        type="button"
        role="menuitem"
        className="block w-full rounded px-2 py-1.5 text-left hover:bg-accent focus:bg-accent focus:outline-none"
        onClick={() => onAction(tab, 'duplicate')}
      >
        Duplicate
      </button>
      <button
        type="button"
        role="menuitem"
        disabled={!canMoveLeft}
        className="block w-full rounded px-2 py-1.5 text-left hover:bg-accent focus:bg-accent focus:outline-none disabled:opacity-40"
        onClick={() => onAction(tab, 'move-left')}
      >
        Move tab left
      </button>
      <button
        type="button"
        role="menuitem"
        disabled={!canMoveRight}
        className="block w-full rounded px-2 py-1.5 text-left hover:bg-accent focus:bg-accent focus:outline-none disabled:opacity-40"
        onClick={() => onAction(tab, 'move-right')}
      >
        Move tab right
      </button>
      <button
        type="button"
        role="menuitem"
        className="block w-full rounded px-2 py-1.5 text-left hover:bg-accent focus:bg-accent focus:outline-none"
        onClick={() => onAction(tab, 'toggle-mute')}
      >
        {tab.muted ? 'Unmute site' : 'Mute site'}
      </button>
      <button
        type="button"
        role="menuitem"
        className="block w-full rounded px-2 py-1.5 text-left hover:bg-accent focus:bg-accent focus:outline-none"
        onClick={() => onAction(tab, 'keep-open')}
      >
        {tab.keepOpen ? 'Use automatic cleanup' : 'Keep open'}
      </button>
      <div className="my-1 border-t border-border" />
      <button
        type="button"
        role="menuitem"
        className="block w-full rounded px-2 py-1.5 text-left hover:bg-accent focus:bg-accent focus:outline-none"
        onClick={() => onAction(tab, 'close')}
      >
        Close
      </button>
      <button
        type="button"
        role="menuitem"
        className="block w-full rounded px-2 py-1.5 text-left hover:bg-accent focus:bg-accent focus:outline-none"
        onClick={() => onAction(tab, 'close-others')}
      >
        Close other tabs
      </button>
      <button
        type="button"
        role="menuitem"
        className="block w-full rounded px-2 py-1.5 text-left hover:bg-accent focus:bg-accent focus:outline-none"
        onClick={() => onAction(tab, 'close-right')}
      >
        Close tabs to the right
      </button>
    </div>
  );
};

const CredentialSavePrompt: FC<{
  prompt: BrowserCredentialPrompt;
  shouldFocus: boolean;
  canFocus: () => boolean;
  onClose: () => void;
  onSaved: () => void;
  onError: (message: string) => void;
}> = ({ prompt, shouldFocus, canFocus, onClose, onSaved, onError }) => {
  const [saving, setSaving] = useState(false);
  const safeActionRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!shouldFocus) return;
    // Credential prompts can appear while the user is typing in the page.
    // Focus the fail-closed action so a carried Enter/Space cannot save a
    // password without a deliberate confirmation click.
    const frame = requestAnimationFrame(() => {
      if (canFocus()) safeActionRef.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [canFocus, prompt.id, shouldFocus]);
  const respond = async (save: boolean) => {
    setSaving(true);
    try {
      await app.browser.respondCredentialPrompt(prompt.id, save);
      if (save) onSaved();
      onClose();
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : String(reason));
      setSaving(false);
    }
  };
  return (
    <div
      role="alertdialog"
      aria-label={`${prompt.update ? 'Update' : 'Save'} browser password`}
      data-browser-prompt-kind="credential"
      className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-muted/30 px-2 py-1.5 text-[11px]"
    >
      <KeyRoundIcon className="h-3.5 w-3.5" />
      <span className="min-w-0 flex-[1_1_12rem] break-all">
        {prompt.update ? 'Update' : 'Save'} password for {prompt.username || 'an account'} at {prompt.origin}?
      </span>
      <button
        type="button"
        className="rounded bg-primary px-2 py-1 text-primary-foreground disabled:opacity-50"
        disabled={saving}
        onClick={() => void respond(true)}
      >
        Save
      </button>
      <button
        ref={safeActionRef}
        data-browser-prompt-primary
        type="button"
        className="rounded px-2 py-1 hover:bg-accent disabled:opacity-50"
        disabled={saving}
        onClick={() => void respond(false)}
      >
        Not now
      </button>
    </div>
  );
};

const PermissionPrompt: FC<{
  prompt: BrowserPermissionPrompt;
  shouldFocus: boolean;
  canFocus: () => boolean;
  onClose: () => void;
  onError: (message: string) => void;
}> = ({ prompt, shouldFocus, canFocus, onClose, onError }) => {
  const [submitting, setSubmitting] = useState(false);
  const canPersist = prompt.canPersist !== false && !prompt.assistantTriggered;
  const safeActionRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!shouldFocus) return;
    // Permission prompts can appear while the user is typing elsewhere. Focus
    // the fail-closed action so a carried Enter/Space cannot grant access.
    const frame = requestAnimationFrame(() => {
      if (canFocus()) safeActionRef.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [canFocus, prompt.id, shouldFocus]);
  const decide = async (decision: 'allow-once' | 'allow' | 'deny') => {
    setSubmitting(true);
    try {
      await app.browser.respondPermissionPrompt(prompt.id, decision);
      onClose();
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : String(reason));
      setSubmitting(false);
    }
  };
  return (
    <div
      role="alertdialog"
      aria-label={`Browser permission request for ${prompt.permission}${prompt.target ? `, ${prompt.target}` : ''}`}
      data-browser-prompt-kind="permission"
      className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-muted/30 px-2 py-1.5 text-[11px]"
    >
      <ShieldCheckIcon className="h-3.5 w-3.5" />
      <span className="min-w-0 flex-[1_1_12rem] break-all">
        {prompt.assistantTriggered ? 'AI requested: ' : ''}Allow {prompt.origin} to use {prompt.permission}?
        {prompt.target && (
          <span dir="ltr" className="mt-0.5 block break-all text-left font-medium text-foreground">
            {prompt.target}
          </span>
        )}
        {prompt.assistantTriggered && (
          <span className="mt-0.5 block text-destructive">
            This approval applies to this request. Future AI requests will ask again.
          </span>
        )}
      </span>
      {canPersist && (
        <button
          type="button"
          className="rounded bg-primary px-2 py-1 text-primary-foreground disabled:opacity-50"
          disabled={submitting}
          onClick={() => void decide('allow')}
        >
          Allow
        </button>
      )}
      <button
        type="button"
        className={cn(
          'rounded px-2 py-1 disabled:opacity-50',
          canPersist ? 'hover:bg-accent' : 'bg-primary text-primary-foreground',
        )}
        disabled={submitting}
        onClick={() => void decide('allow-once')}
      >
        Allow once
      </button>
      <button
        ref={safeActionRef}
        data-browser-prompt-primary
        type="button"
        className="rounded px-2 py-1 hover:bg-accent disabled:opacity-50"
        disabled={submitting}
        onClick={() => void decide('deny')}
      >
        Block
      </button>
    </div>
  );
};

const AuthPrompt: FC<{
  prompt: BrowserAuthPrompt;
  shouldFocus: boolean;
  canFocus: () => boolean;
  onClose: () => void;
  onError: (message: string) => void;
}> = ({ prompt, shouldFocus, canFocus, onClose, onError }) => {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [credentialsArmed, setCredentialsArmed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const usernameRef = useRef<HTMLInputElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    setUsername('');
    setPassword('');
    setCredentialsArmed(false);
    setSubmitting(false);
  }, [prompt.id]);
  useEffect(() => {
    if (!shouldFocus) return;
    const frame = requestAnimationFrame(() => {
      if (canFocus()) cancelRef.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [canFocus, prompt.id, shouldFocus]);
  const respond = async (credentials?: { username: string; password: string }) => {
    setSubmitting(true);
    try {
      await app.browser.respondAuthPrompt(prompt.id, credentials?.username, credentials?.password);
      setUsername('');
      setPassword('');
      onClose();
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : String(reason));
      setSubmitting(false);
    }
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!credentialsArmed) return;
    void respond({ username, password });
  };
  const armCredentials = () => {
    setCredentialsArmed(true);
    requestAnimationFrame(() => usernameRef.current?.focus());
  };
  return (
    <form
      role="alertdialog"
      aria-label="Browser authentication required"
      data-browser-prompt-kind="auth"
      onSubmit={submit}
      className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-border bg-muted/30 px-2 py-1.5 text-[11px]"
    >
      <KeyRoundIcon className="h-3.5 w-3.5" />
      <span className="min-w-0 max-w-full break-all [overflow-wrap:anywhere]" dir="ltr">
        {prompt.assistantTriggered ? 'AI requested · ' : ''}
        {prompt.isProxy ? 'Proxy authentication · ' : ''}
        {prompt.endpoint}
        {prompt.authScheme ? ` · ${prompt.authScheme}` : ''}
        {prompt.realm ? ` · ${prompt.realm}` : ''}
      </span>
      {prompt.assistantTriggered && (
        <span className="font-medium text-amber-700 dark:text-amber-300">
          Verify this endpoint before sending credentials to the AI-controlled page.
        </span>
      )}
      {credentialsArmed ? (
        <>
          <input
            ref={usernameRef}
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            className="h-6 w-24 rounded border bg-background px-1.5"
            placeholder="Username"
            autoComplete="username"
          />
          <input
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            className="h-6 w-24 rounded border bg-background px-1.5"
            placeholder="Password"
            type="password"
            autoComplete="current-password"
          />
          <button
            disabled={submitting}
            className="rounded bg-primary px-2 py-1 text-primary-foreground disabled:opacity-50"
          >
            Sign in
          </button>
        </>
      ) : (
        <button
          type="button"
          disabled={submitting}
          className="rounded bg-primary px-2 py-1 text-primary-foreground disabled:opacity-50"
          onClick={armCredentials}
        >
          Enter credentials
        </button>
      )}
      <button
        ref={cancelRef}
        data-browser-prompt-primary
        type="button"
        className="rounded px-2 py-1 hover:bg-accent disabled:opacity-50"
        disabled={submitting}
        onClick={() => void respond()}
      >
        Cancel
      </button>
    </form>
  );
};

const BrowserManagerView: FC<{
  kind: Exclude<ManagerView, null>;
  conversationId: string;
  refreshRevision: number;
  onClose: () => void;
  onNavigate: (url: string) => void;
  onBookmarksChanged: () => void;
  onError: (reason: unknown) => void;
}> = ({ kind, conversationId, refreshRevision, onClose, onNavigate, onBookmarksChanged, onError }) => {
  const [query, setQuery] = useState('');
  const [history, setHistory] = useState<BrowserHistoryEntry[]>([]);
  const [bookmarks, setBookmarks] = useState<BrowserBookmark[]>([]);
  const [downloads, setDownloads] = useState<BrowserDownload[]>([]);
  const [credentials, setCredentials] = useState<BrowserCredentialSummary[]>([]);
  const [credentialAuthenticationAvailable, setCredentialAuthenticationAvailable] = useState<boolean | null>(null);
  const [revealed, setRevealed] = useState<{
    id: string;
    value: string;
  } | null>(null);
  const [editing, setEditing] = useState<{
    credential: BrowserCredentialSummary;
    username: string;
    password: string;
  } | null>(null);
  const [draggedBookmark, setDraggedBookmark] = useState<string | null>(null);
  const reloadRequestRef = useRef(0);
  const credentialSecretRequestRef = useRef(0);
  const queryRef = useRef(query);
  const backButtonRef = useRef<HTMLButtonElement>(null);
  const credentialEditUsernameRef = useRef<HTMLInputElement>(null);
  const credentialEditButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  queryRef.current = query;
  const perform = useCallback(
    async (operation: () => Promise<void>): Promise<boolean> => {
      try {
        await operation();
        return true;
      } catch (reason) {
        onError(reason);
        return false;
      }
    },
    [onError],
  );
  const reload = useCallback(async () => {
    const request = ++reloadRequestRef.current;
    // A profile/list refresh invalidates any native-authentication completion
    // that was started for the previous credential set.
    credentialSecretRequestRef.current++;
    // Mutation handlers can await native authentication while search changes.
    // Read the query at reload time instead of retaining the handler's old render.
    const requestedQuery = queryRef.current;
    if (kind === 'history') {
      const next = await app.browser.listHistory(conversationId, requestedQuery);
      if (request === reloadRequestRef.current) setHistory(next);
    } else if (kind === 'bookmarks') {
      const next = await app.browser.listBookmarks(conversationId, requestedQuery);
      if (request === reloadRequestRef.current) setBookmarks(next);
    } else if (kind === 'downloads') {
      const next = await app.browser.listDownloads(conversationId);
      if (request === reloadRequestRef.current) setDownloads(next);
    } else {
      const [next, authenticationAvailable] = await Promise.all([
        app.browser.listCredentials(conversationId, requestedQuery),
        app.browser.credentialAuthenticationAvailable(),
      ]);
      if (request === reloadRequestRef.current) {
        setCredentials(next);
        setCredentialAuthenticationAvailable(authenticationAvailable);
      }
    }
  }, [conversationId, kind]);
  const persistBookmarkOrder = useCallback(
    async (next: BrowserBookmark[]): Promise<void> => {
      const reordered = await perform(async () => {
        await app.browser.reorderBookmarks(
          conversationId,
          next.map((entry) => entry.id),
        );
      });
      if (reordered) {
        setBookmarks(next);
        onBookmarksChanged();
      }
    },
    [conversationId, onBookmarksChanged, perform],
  );
  const closeCredentialEditor = useCallback((credentialId: string) => {
    credentialSecretRequestRef.current++;
    setEditing(null);
    requestAnimationFrame(() => {
      (credentialEditButtonRefs.current.get(credentialId) ?? backButtonRef.current)?.focus();
    });
  }, []);
  const requestCredentialSecret = useCallback(
    async (credential: BrowserCredentialSummary, destination: 'edit' | 'reveal'): Promise<void> => {
      const request = ++credentialSecretRequestRef.current;
      try {
        const password = await app.browser.revealCredential(conversationId, credential.id);
        if (request !== credentialSecretRequestRef.current) return;
        if (destination === 'edit') {
          setRevealed(null);
          setEditing({ credential, username: credential.username, password });
        } else {
          setEditing(null);
          setRevealed({ id: credential.id, value: password });
        }
      } catch (reason) {
        if (request === credentialSecretRequestRef.current) onError(reason);
      }
    },
    [conversationId, onError],
  );
  useEffect(() => {
    void perform(reload);
    return () => {
      reloadRequestRef.current++;
      credentialSecretRequestRef.current++;
    };
  }, [perform, query, reload, refreshRevision]);
  useLayoutEffect(() => {
    backButtonRef.current?.focus();
  }, []);
  useLayoutEffect(() => {
    if (editing) credentialEditUsernameRef.current?.focus();
  }, [editing?.credential.id]);
  useEffect(() => {
    if (!revealed) return;
    const timer = setTimeout(() => setRevealed(null), 10_000);
    return () => clearTimeout(timer);
  }, [revealed]);
  const title = kind[0].toUpperCase() + kind.slice(1);
  return (
    <div className="absolute inset-0 overflow-y-auto bg-background p-3 text-xs">
      <div className="mb-3 flex min-w-0 flex-wrap items-center gap-2">
        <button ref={backButtonRef} className={iconButton} onClick={onClose} title="Back to browser">
          <ArrowLeftIcon className="h-4 w-4" />
        </button>
        <h3 className="text-sm font-semibold">{title}</h3>
        <div className="flex-1" />
        {(kind === 'history' || kind === 'bookmarks' || kind === 'passwords') && (
          <div className="flex min-w-0 flex-[1_1_9rem] items-center rounded border border-border px-2">
            <SearchIcon className="h-3 w-3" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              className="h-7 min-w-0 w-full bg-transparent px-1.5 outline-none"
              placeholder={`Search ${kind}`}
            />
          </div>
        )}
        {kind === 'bookmarks' && (
          <>
            <button
              className="rounded border px-2 py-1 hover:bg-accent"
              onClick={async () => {
                await perform(async () => {
                  await app.browser.importBookmarks(conversationId);
                  await reload();
                  onBookmarksChanged();
                });
              }}
            >
              Import
            </button>
            <button
              className="rounded border px-2 py-1 hover:bg-accent"
              onClick={() =>
                void perform(async () => {
                  await app.browser.exportBookmarks(conversationId);
                })
              }
            >
              Export
            </button>
          </>
        )}
        {kind === 'history' && (
          <button
            className="rounded border px-2 py-1 hover:bg-accent"
            onClick={async () => {
              if (!window.confirm('Clear all browsing history for this browser profile? This cannot be undone.'))
                return;
              await perform(async () => {
                await app.browser.clearHistory(conversationId);
                await reload();
              });
            }}
          >
            Clear
          </button>
        )}
      </div>
      {editing && (
        <form
          className="mb-3 grid gap-2 rounded-lg border border-border bg-card p-3"
          onSubmit={async (event) => {
            event.preventDefault();
            const saved = await perform(async () => {
              await app.browser.updateCredential(
                conversationId,
                editing.credential.id,
                editing.username,
                editing.password,
              );
              await reload();
            });
            if (saved) closeCredentialEditor(editing.credential.id);
          }}
          onKeyDown={(event) => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            closeCredentialEditor(editing.credential.id);
          }}
        >
          <p className="font-medium">Edit password for {editing.credential.origin}</p>
          <input
            ref={credentialEditUsernameRef}
            className="h-8 rounded border bg-background px-2"
            aria-label="Saved username"
            value={editing.username}
            onChange={(event) => setEditing({ ...editing, username: event.target.value })}
            autoComplete="username"
          />
          <input
            className="h-8 rounded border bg-background px-2"
            aria-label="Saved password"
            type="password"
            value={editing.password}
            onChange={(event) => setEditing({ ...editing, password: event.target.value })}
            autoComplete="current-password"
          />
          <div className="flex justify-end gap-2">
            <button
              type="button"
              className="rounded px-2 py-1 hover:bg-accent"
              onClick={() => closeCredentialEditor(editing.credential.id)}
            >
              Cancel
            </button>
            <button className="rounded bg-primary px-2 py-1 text-primary-foreground">Save</button>
          </div>
        </form>
      )}
      {kind === 'passwords' && credentialAuthenticationAvailable === false && (
        <p role="status" className="mb-3 rounded border border-amber-500/40 bg-amber-500/10 p-2 text-amber-700">
          Touch ID is unavailable on this Mac. Saved passwords can still be autofilled, but editing, revealing, copying,
          and deleting stay locked.
        </p>
      )}
      <div className="space-y-1">
        {kind === 'history' &&
          history.map((item) => (
            <LibraryRow
              key={item.id}
              title={item.title}
              detail={item.url}
              icon={<HistoryIcon className="h-4 w-4" />}
              onOpen={() => onNavigate(item.url)}
            />
          ))}
        {kind === 'bookmarks' &&
          bookmarks.map((item) => (
            <div
              key={item.id}
              draggable={!query.trim()}
              onDragStart={() => setDraggedBookmark(item.id)}
              onDragOver={(event) => event.preventDefault()}
              onDrop={async () => {
                if (query.trim()) return;
                if (!draggedBookmark || draggedBookmark === item.id) return;
                const next = [...bookmarks];
                const from = next.findIndex((entry) => entry.id === draggedBookmark);
                const to = next.findIndex((entry) => entry.id === item.id);
                if (from < 0 || to < 0) {
                  setDraggedBookmark(null);
                  return;
                }
                next.splice(to, 0, next.splice(from, 1)[0]);
                setDraggedBookmark(null);
                await persistBookmarkOrder(next);
              }}
              onDragEnd={() => setDraggedBookmark(null)}
            >
              <LibraryRow
                title={item.title}
                detail={item.folder ? `${item.folder} · ${item.url}` : item.url}
                icon={<StarIcon className="h-4 w-4 text-amber-500" />}
                onOpen={() => onNavigate(item.url)}
                action={
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      className={iconButton}
                      title={`Move ${item.title} up`}
                      disabled={!!query.trim() || bookmarks.indexOf(item) === 0}
                      onClick={() => {
                        const index = bookmarks.indexOf(item);
                        if (index <= 0) return;
                        const next = [...bookmarks];
                        next.splice(index - 1, 0, next.splice(index, 1)[0]);
                        void persistBookmarkOrder(next);
                      }}
                    >
                      <ArrowUpIcon className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      className={iconButton}
                      title={`Move ${item.title} down`}
                      disabled={!!query.trim() || bookmarks.indexOf(item) === bookmarks.length - 1}
                      onClick={() => {
                        const index = bookmarks.indexOf(item);
                        if (index < 0 || index >= bookmarks.length - 1) return;
                        const next = [...bookmarks];
                        next.splice(index + 1, 0, next.splice(index, 1)[0]);
                        void persistBookmarkOrder(next);
                      }}
                    >
                      <ArrowDownIcon className="h-3.5 w-3.5" />
                    </button>
                    <button
                      className={iconButton}
                      title="Open in new tab"
                      onClick={() =>
                        void perform(async () => {
                          await app.browser.createTab({
                            conversationId,
                            url: item.url,
                            owner: 'user',
                          });
                        })
                      }
                    >
                      <PlusIcon className="h-3.5 w-3.5" />
                    </button>
                    <button
                      className={iconButton}
                      title="Edit bookmark"
                      onClick={async () => {
                        const title = window.prompt('Bookmark title', item.title);
                        if (title === null) return;
                        const url = window.prompt('Bookmark URL', item.url);
                        if (url === null) return;
                        const folder = window.prompt('Folder', item.folder);
                        if (folder === null) return;
                        await perform(async () => {
                          await app.browser.updateBookmark(conversationId, {
                            ...item,
                            title,
                            url,
                            folder,
                          });
                          await reload();
                          onBookmarksChanged();
                        });
                      }}
                    >
                      <PencilIcon className="h-3.5 w-3.5" />
                    </button>
                    <button
                      className={iconButton}
                      title="Delete bookmark"
                      onClick={async () => {
                        await perform(async () => {
                          await app.browser.removeBookmark(conversationId, item.id);
                          await reload();
                          onBookmarksChanged();
                        });
                      }}
                    >
                      <Trash2Icon className="h-3.5 w-3.5" />
                    </button>
                  </div>
                }
              />
            </div>
          ))}
        {kind === 'downloads' &&
          downloads.map((item) => (
            <LibraryRow
              key={item.id}
              title={item.filename}
              detail={`${item.state} · ${item.receivedBytes.toLocaleString()} / ${item.totalBytes.toLocaleString()} bytes${
                item.path ? '' : ' · file unavailable'
              }`}
              icon={<DownloadIcon className="h-4 w-4" />}
              onOpen={
                item.path
                  ? () =>
                      void perform(() =>
                        item.quarantined
                          ? app.browser.exportDownload(conversationId, item.id).then(() => undefined)
                          : app.browser.showDownload(conversationId, item.id),
                      )
                  : undefined
              }
              action={
                item.state === 'progressing' ? (
                  <button
                    type="button"
                    className={iconButton}
                    title={`Cancel ${item.filename}`}
                    onClick={() =>
                      void perform(async () => {
                        await app.browser.cancelDownload(conversationId, item.id);
                        await reload();
                      })
                    }
                  >
                    <XIcon className="h-3.5 w-3.5" />
                  </button>
                ) : item.quarantined ? (
                  <div className="flex items-center gap-1">
                    {item.path && item.state === 'completed' && (
                      <button
                        type="button"
                        className={iconButton}
                        title={`Export ${item.filename}`}
                        onClick={() =>
                          void perform(() => app.browser.exportDownload(conversationId, item.id).then(() => undefined))
                        }
                      >
                        <DownloadIcon className="h-3.5 w-3.5" />
                      </button>
                    )}
                    <button
                      type="button"
                      className={iconButton}
                      title={`Delete ${item.filename}`}
                      onClick={() =>
                        void perform(async () => {
                          await app.browser.deleteDownload(conversationId, item.id);
                          await reload();
                        })
                      }
                    >
                      <Trash2Icon className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ) : undefined
              }
            />
          ))}
        {kind === 'passwords' &&
          credentials.map((item) => (
            <LibraryRow
              key={item.id}
              title={item.username || '(no username)'}
              detail={item.origin}
              securityDetail
              icon={<KeyRoundIcon className="h-4 w-4" />}
              action={
                <div className="ml-auto flex max-w-full flex-wrap items-center justify-end gap-1">
                  {revealed?.id === item.id && (
                    <code
                      aria-label="Revealed password"
                      className="max-h-24 max-w-full overflow-auto whitespace-pre-wrap break-all rounded bg-muted px-1.5 py-1"
                    >
                      {revealed.value}
                    </code>
                  )}
                  <button
                    className={iconButton}
                    title="Autofill in active tab"
                    onClick={async () => {
                      const filled = await perform(async () => {
                        const current = await app.browser.getState(conversationId);
                        if (!current.activeTabId) {
                          throw new Error('Open a browser tab before autofilling a saved password.');
                        }
                        await app.browser.autofill(conversationId, current.activeTabId, item.id);
                      });
                      if (filled) onClose();
                    }}
                  >
                    <CheckIcon className="h-3.5 w-3.5" />
                  </button>
                  <button
                    ref={(element) => {
                      if (element) credentialEditButtonRefs.current.set(item.id, element);
                      else credentialEditButtonRefs.current.delete(item.id);
                    }}
                    className={`${iconButton} disabled:cursor-not-allowed disabled:opacity-40`}
                    disabled={credentialAuthenticationAvailable !== true}
                    title={
                      credentialAuthenticationAvailable === false
                        ? 'Edit unavailable — Touch ID is not available'
                        : 'Edit with Touch ID'
                    }
                    onClick={() => void requestCredentialSecret(item, 'edit')}
                  >
                    <PencilIcon className="h-3.5 w-3.5" />
                  </button>
                  <button
                    className={`${iconButton} disabled:cursor-not-allowed disabled:opacity-40`}
                    disabled={credentialAuthenticationAvailable !== true}
                    title={
                      credentialAuthenticationAvailable === false
                        ? 'Reveal unavailable — Touch ID is not available'
                        : 'Reveal with Touch ID'
                    }
                    onClick={() => void requestCredentialSecret(item, 'reveal')}
                  >
                    <EyeIcon className="h-3.5 w-3.5" />
                  </button>
                  <button
                    className={`${iconButton} disabled:cursor-not-allowed disabled:opacity-40`}
                    disabled={credentialAuthenticationAvailable !== true}
                    title={
                      credentialAuthenticationAvailable === false
                        ? 'Copy unavailable — Touch ID is not available'
                        : 'Copy with Touch ID'
                    }
                    onClick={() => void perform(() => app.browser.copyCredential(conversationId, item.id))}
                  >
                    <CopyIcon className="h-3.5 w-3.5" />
                  </button>
                  <button
                    className={`${iconButton} disabled:cursor-not-allowed disabled:opacity-40`}
                    disabled={credentialAuthenticationAvailable !== true}
                    title={
                      credentialAuthenticationAvailable === false
                        ? 'Delete unavailable — Touch ID is not available'
                        : 'Delete with Touch ID'
                    }
                    onClick={async () => {
                      if (
                        !window.confirm(
                          `Delete the saved password for ${item.username || 'this account'} at ${item.origin}? This cannot be undone.`,
                        )
                      )
                        return;
                      await perform(async () => {
                        await app.browser.deleteCredential(conversationId, item.id);
                        // Native authentication can remain pending while another
                        // credential is opened. Remove plaintext only when this
                        // completed deletion still owns the matching editor.
                        setEditing((current) => (current?.credential.id === item.id ? null : current));
                        setRevealed((current) => (current?.id === item.id ? null : current));
                        await reload();
                      });
                    }}
                  >
                    <Trash2Icon className="h-3.5 w-3.5" />
                  </button>
                </div>
              }
            />
          ))}
        {((kind === 'history' && history.length === 0) ||
          (kind === 'bookmarks' && bookmarks.length === 0) ||
          (kind === 'downloads' && downloads.length === 0) ||
          (kind === 'passwords' && credentials.length === 0)) && (
          <p className="py-12 text-center text-muted-foreground">Nothing here yet.</p>
        )}
      </div>
    </div>
  );
};

const LibraryRow: FC<{
  title: string;
  detail: string;
  icon: ReactNode;
  onOpen?: () => void;
  action?: ReactNode;
  securityDetail?: boolean;
}> = ({ title, detail, icon, onOpen, action, securityDetail = false }) => (
  <div className="flex min-w-0 flex-wrap items-center gap-2 rounded-lg border border-border/60 bg-card p-2 hover:bg-muted/30">
    <span className="text-muted-foreground">{icon}</span>
    <button type="button" disabled={!onOpen} onClick={onOpen} className="min-w-0 flex-1 text-left">
      <span className="block truncate font-medium">{title}</span>
      <span
        dir={securityDetail ? 'ltr' : undefined}
        className={
          securityDetail
            ? 'block whitespace-normal break-all text-[10px] text-muted-foreground [unicode-bidi:isolate]'
            : 'block truncate text-[10px] text-muted-foreground'
        }
      >
        {detail}
      </span>
    </button>
    {onOpen && <ExternalLinkIcon className="h-3 w-3 text-muted-foreground" />}
    {action}
  </div>
);
