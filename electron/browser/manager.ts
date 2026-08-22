import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { basename, join } from 'node:path';
import {
  app,
  BaseWindow,
  type BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  MenuItem,
  nativeImage,
  screen,
  session,
  shell,
  WebContentsView,
  type IpcMainEvent,
  type DownloadItem,
  type NativeImage,
  type Session,
  type WebContents,
  type WebFrameMain,
} from 'electron';
import type { AppConfig } from '../config/schema.js';
import type { BrowserConfigTransitionResult } from './config-transition.js';
import type {
  BrowserActionEvent,
  BrowserActionRequest,
  BrowserAttentionState,
  BrowserAuthPrompt,
  BrowserBookmark,
  BrowserBounds,
  BrowserCreateTabRequest,
  BrowserCredentialSummary,
  BrowserDataClearOptions,
  BrowserDataSummary,
  BrowserDownload,
  BrowserElementPickResult,
  BrowserEvent,
  BrowserHistoryEntry,
  BrowserInspection,
  BrowserManagerState,
  BrowserMenuAction,
  BrowserNetworkDiagnostics,
  BrowserNetworkDiagnosticsRequest,
  BrowserNetworkWaitMode,
  BrowserProfilePersistenceArea,
  BrowserScreenshotRequest,
  BrowserScreenshotResult,
  BrowserShortcutAction,
  BrowserSitePermission,
  BrowserTab,
  BrowserTabCommand,
  BrowserTabOwner,
} from '../../shared/browser.js';
import { redactBrowserErrorForExposure } from '../../shared/browser.js';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { BrowserActionQueue } from './action-queue.js';
import { BrowserValidatingProxy } from './validating-proxy.js';
import { BrowserAssistantRunRegistry, type BrowserAssistantModality } from './assistant-runs.js';
import { parseBookmarksHtml, readBoundedBookmarksHtmlFileSync, renderBookmarksHtml } from './bookmarks-html.js';
import {
  BrowserCredentialVault,
  listStoredCredentialScopeKeys,
  readStoredCredentialCountAsync,
} from './credential-vault.js';
import { runBrowserDataClearOperations } from './data-clear.js';
import {
  assistantDownloadQuarantinePath,
  exportAssistantDownloadFile,
  isAssistantDownloadQuarantineFileAvailable,
  isAssistantDownloadQuarantinePath,
  listAssistantDownloadQuarantineScopeKeys,
  MAX_ASSISTANT_DOWNLOAD_BYTES,
  prepareAssistantDownloadQuarantine,
  pruneAssistantDownloadQuarantine,
  reconcileAssistantDownloadExportJournal,
  removeAssistantDownloadFile,
  removeAssistantDownloadQuarantineForScope,
  secureAssistantDownloadFile,
  type PrunedAssistantDownload,
} from './download-quarantine.js';
import { clearPluginBrowserPartitions } from './plugin-partitions.js';
import { browserAutofillProbeScript, browserAutofillScript } from './credential-dom.js';
import {
  BROWSER_PRIVATE_NETWORK_GUARD_ACTIVATION_PROBE,
  BROWSER_PRIVATE_NETWORK_NEW_DOCUMENT_GUARD,
  boundedBrowserEvaluationExpression,
  browserNativeUiGuardActivationProbe,
  browserNativeUiNewDocumentGuard,
} from './evaluation.js';
import {
  MAX_BROWSER_TYPED_VALUE_CHARS,
  parseBrowserActionRequest,
  parseBrowserPermissionDecision,
  parseBrowserScreenshotRequest,
} from './input-validation.js';
import { browserInspectionExpression, MAX_BROWSER_INSPECTION_OCCLUSION_POINTS } from './inspection.js';
import {
  browserNetworkResourceBlocksIdle,
  browserLoadTimingFromNetworkRequests,
  browserNetworkPageIdentity,
  createBrowserNetworkRedactionKey,
  MAX_BROWSER_ACTIVE_NETWORK_REQUESTS_PER_TAB,
  MAX_BROWSER_NETWORK_DIAGNOSTIC_RESULTS,
  MAX_BROWSER_NETWORK_REQUESTS_PER_TAB,
  responseContentLength,
  sanitizeBrowserNetworkUrl,
  sanitizeBrowserNetworkError,
  snapshotBrowserNetworkRequests,
  type BrowserNetworkRedactionKey,
  type TrackedBrowserNetworkRequest,
} from './network-diagnostics.js';
import { browserSemanticHelpersExpression } from './semantics.js';
import { validatePickedElementSelector } from './element-picker.js';
import {
  isApplicationAcceleratorShortcutKeys,
  isClipboardShortcutKeys,
  isReservedBrowserShortcutKeys,
  resolveClipboardShortcutCommand,
  resolveBrowserShortcut,
  shouldFocusBrowserChrome,
} from './shortcuts.js';
import type { BrowserAwareApplicationMenuCommand, BrowserAwareEditCommand } from './edit-menu.js';
import {
  assistantMayControlTab,
  assistantPopupOwner,
  browserActionHasTarget,
  browserActionRequiresTarget,
  retainClosedTabsOutsideScopes,
  shouldCleanupAssistantTab,
  shouldCloseDestroyedPopupTab,
  shouldCloseIdleAssistantTab,
  shouldDiscardBrowserTab,
  shouldFocusAttachedBrowserView,
  hasBrowserPromptCapacity,
  shouldRestrictPopupNetwork,
  shouldReleaseAiNetworkRestriction,
  shouldSerializeBrowserTabCommand,
  shouldBypassAiPolicyForTrustedUserNavigation,
  isTrustedUserNavigationCommit,
  isTrustedUserNavigationTarget,
} from './lifecycle.js';
import {
  browserPermissionTargetLabel,
  browserPermissionStorageKeys,
  describeBrowserPermission,
  isPersistentBrowserPermissionOrigin,
  isPersistableBrowserPermission,
  normalizeBrowserPermissionOrigin,
  type BrowserPermissionDetails,
} from './permissions.js';
import {
  clearChromiumBrowserScopeCleared,
  clearPendingBrowserCleanupScopeKey,
  finalizePendingBrowserCleanupRecovery,
  hasStoredBrowserScopeData,
  listPendingBrowserCleanupMarkerScopeKeys,
  listPendingBrowserCleanupScopeKeys,
  listStoredChromiumBrowserScopeKeys,
  markChromiumBrowserScopeCleared,
  markPendingBrowserCleanupScopeKey,
} from './profile-data.js';
import {
  browserScreenshotCaptureGeometry,
  browserScreenshotTiles,
  browserScreenshotViewportGeometry,
  elementCaptureRect,
  validateMenuPreviewNativeSize,
  validateScreenshotEncodedBytes,
  validateScreenshotSize,
} from './screenshots.js';
import {
  prepareBrowserScreenshotRetention,
  removeBrowserScreenshotsForConversation,
  removeBrowserScreenshotsForScopeKey,
} from './screenshot-store.js';
import {
  BrowserProfileStore,
  listStoredBrowserScopeKeys,
  readStoredBrowserDownloadsAsync,
  readStoredBrowserProfileCountsAsync,
} from './store.js';
import { boundedBrowserTitle, boundedBrowserUrl } from './metadata.js';
import { stopRunningBrowserServiceWorkers } from './service-workers.js';
import {
  aiRequestPolicyUrl,
  assertAiNavigationAllowed,
  browserPartition,
  browserPartitionForScopeKey,
  browserSystemProxyResolverPartition,
  browserFocusTargetScript,
  browserScopeKey,
  browserWebPreferences,
  configureBrowserSession,
  configureBrowserWebContents,
  getChromeUserAgent,
  hardenRemoteWebPreferences,
  isBrowserScopeKey,
  isPrivateNetworkUrl,
  normalizeOmniboxInput,
  registerBrowserFramePreload,
  resolveBrowserDataScopeKeys,
  scaleBrowserPointForZoom,
  shouldApplyAiRequestPolicy,
  validatePluginPartitionClearNames,
  validateBrowserBounds,
} from './session.js';

const PROMPT_TIMEOUT_MS = 120_000;
const MAX_CREDENTIAL_ORIGIN_LENGTH = 2_048;
const MAX_CREDENTIAL_USERNAME_LENGTH = 1_024;
const MAX_CREDENTIAL_PASSWORD_LENGTH = 16_384;
const AUTOMATION_OVERLAY_CLEAR_MS = 900;
const AUTOMATION_ACTIVITY_GRACE_MS = 1_500;
const AUTOMATION_GESTURE_ARM_MS = 5_000;
const AUTOMATION_GESTURE_ACK_TIMEOUT_MS = 1_000;
// Presented text stays per-code-point for ordinary typing, preserving native
// key events and exact timestamps. Paste-sized values use one exact-data
// Input.insertText arm so large inputs do not perform thousands of IPC/CDP
// acknowledgement cycles.
const AUTOMATION_BULK_TEXT_THRESHOLD = 32;
const POPUP_GESTURE_PROVENANCE_MS = 5_000;
const TRUSTED_USER_NAVIGATION_AUTHORITY_MS = 30_000;
const CONTEXT_MENU_DOWNLOAD_AUTHORITY_MS = 30_000;
const EVALUATE_TIMEOUT_MS = 15_000;
const INSPECT_TIMEOUT_MS = 15_000;
const TARGET_LOCATION_TIMEOUT_MS = 15_000;
const BROWSER_INPUT_TIMEOUT_MS = 15_000;
const AUTOMATION_OVERLAY_TIMEOUT_MS = 5_000;
const ASSISTANT_DIALOG_CDP_TIMEOUT_MS = 5_000;
const ELEMENT_PICKER_TIMEOUT_MS = 60_000;
const ASSISTANT_PAGE_LOAD_TIMEOUT_MS = 30_000;
const MENU_PREVIEW_CAPTURE_TIMEOUT_MS = 5_000;
const MENU_PREVIEW_SENSITIVITY_PROBE_TIMEOUT_MS = 1_000;
const MENU_PREVIEW_CDP_SENSITIVITY_TIMEOUT_MS = 5_000;
const MENU_PREVIEW_MAX_WIDTH = 1_024;
const MENU_PREVIEW_MAX_HEIGHT = 768;
const MAX_SUPERSEDED_NETWORK_NAVIGATIONS = 32;
const PRELOAD_PRIVATE_NETWORK_GUARD_PENDING_IDENTIFIER = 'preload-pending';
const PRELOAD_NATIVE_UI_GUARD_PENDING_IDENTIFIER = 'preload-pending';
const UNSAFE_ORIGIN_STORAGE_TYPES: NonNullable<Electron.ClearStorageDataOptions['storages']> = [
  'filesystem',
  'indexdb',
  'localstorage',
  'websql',
  'serviceworkers',
  'cachestorage',
];
const SCRIPTED_ORIGIN_STORAGE_TYPES: NonNullable<Electron.ClearStorageDataOptions['storages']> = ['serviceworkers'];

class BrowserRendererDeadlineError extends Error {
  constructor(
    readonly operation: string,
    readonly timeoutMs: number,
  ) {
    super(`${operation} exceeded ${timeoutMs / 1_000} seconds.`);
    this.name = 'BrowserRendererDeadlineError';
  }
}

function comparablePopupReferrerUrl(value: string): string | null {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    parsed.hash = '';
    return parsed.href;
  } catch {
    return value.split('#', 1)[0] || null;
  }
}

function browserNetworkEventTime(timestamp: unknown): number {
  return typeof timestamp === 'number' && Number.isFinite(timestamp) && timestamp >= 0 ? timestamp : Date.now();
}

function waitForBrowserDownloadTerminal(done: Promise<void>, operation: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error !== undefined) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => {
      finish(
        new Error(
          `${operation} did not reach a terminal state within ${BROWSER_DOWNLOAD_TERMINAL_TIMEOUT_MS / 1_000} seconds.`,
        ),
      );
    }, BROWSER_DOWNLOAD_TERMINAL_TIMEOUT_MS);
    timer.unref?.();
    void done.then(
      () => finish(),
      (error: unknown) => finish(error),
    );
  });
}

/** Electron's window-open callback is WebContents-wide. Bind its referrer to a
 * single live frame before allowing that frame's recent user gesture to change
 * popup ownership. Ambiguous same-URL frames and stripped referrers fail closed. */
export function popupInitiatorFrameTreeNodeId(contents: WebContents, referrerUrl: string): number | null {
  const expected = comparablePopupReferrerUrl(referrerUrl);
  if (!expected) return null;
  try {
    const matches = contents.mainFrame.framesInSubtree.filter(
      (frame) => !frame.detached && !frame.isDestroyed() && comparablePopupReferrerUrl(frame.url) === expected,
    );
    return matches.length === 1 ? matches[0].frameTreeNodeId : null;
  } catch {
    return null;
  }
}

function browserAuthEndpoint(details: Electron.AuthenticationResponseDetails, authInfo: Electron.AuthInfo): string {
  let protocol = authInfo.isProxy ? 'proxy:' : authInfo.port === 443 ? 'https:' : 'http:';
  if (!authInfo.isProxy) {
    try {
      const parsed = new URL(details.url);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') protocol = parsed.protocol;
    } catch {
      // Keep the conservative port-derived protocol for malformed details.
    }
  }
  const normalizedHost = authInfo.host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  const displayHost = normalizedHost.includes(':') ? `[${normalizedHost}]` : normalizedHost;
  const port = authInfo.port > 0 ? authInfo.port : protocol === 'https:' ? 443 : 80;
  return `${protocol}//${displayHost}:${port}`;
}
// Renderer-driven max-turn continuations can wait behind conversation
// compaction for up to five minutes. Retain the logical turn's temporary tabs
// slightly longer, then reclaim them if no successor adopts the handoff.
export const ASSISTANT_CONTINUATION_HANDOFF_TIMEOUT_MS = 6 * 60_000;
const ASSISTANT_CONTINUATION_CLEANUP_RETRY_MS = 1_000;
const SCREENSHOT_TIMEOUT_MS = 60_000;
const BACKGROUND_VIEWPORT_TIMEOUT_MS = 5_000;
const BACKGROUND_VIEWPORT_RETRY_DELAYS_MS = [100, 250, 500, 1_000, 2_000, 4_000] as const;
const PRIVATE_NETWORK_GUARD_TIMEOUT_MS = 15_000;
const NATIVE_UI_GUARD_TIMEOUT_MS = 15_000;
const DNS_RESOLUTION_TIMEOUT_MS = 10_000;
const FAVICON_FETCH_TIMEOUT_MS = 10_000;
export const BROWSER_DOWNLOAD_TERMINAL_TIMEOUT_MS = 5_000;
const MAX_CONCURRENT_FAVICON_FETCHES = 8;
const MAX_FAVICON_BYTES = 64 * 1024;
const MAX_FAVICON_DATA_URL_CHARS = 96 * 1024;
const MAX_FAVICON_REDIRECTS = 5;
const MAX_INPUT_FIELDS_FOR_CDP_SCAN = 1_024;
const MAX_DOM_ELEMENTS_FOR_CDP_SENSITIVE_SCAN = 50_000;
const MAX_DOM_NODES_FOR_CDP_SENSITIVE_SCAN = 200_000;
const MAX_CDP_SENSITIVE_SCAN_TARGETS = 128;
const MAX_CDP_SENSITIVE_ATTACH_PASSES = 16;
const MAX_CACHED_DOWNLOADS_PER_SCOPE = 1_000;
const MAX_PENDING_PROMPTS_PER_TAB = 8;
const MAX_PENDING_PROMPTS_TOTAL = 64;
const MAX_UNRESTRICTED_DOCUMENT_ORIGINS = 256;
const MAX_CLIPBOARD_FOCUS_FINGERPRINT_CHARS = 4_096;
const DEFAULT_DETACHED_VIEW_BOUNDS: BrowserBounds = {
  x: 0,
  y: 0,
  width: 1_280,
  height: 800,
};
const INTERNAL_URLS = new Set(['about:blank']);

type CdpSensitiveScanBudget = {
  elementsRemaining: number;
  nodesRemaining: number;
  inputsRemaining: number;
};

const BROWSER_CONTROL_POLICY_RANK = { allow: 0, ask: 1, deny: 2 } as const;
const BROWSER_PASSWORD_POLICY_RANK = { automatic: 0, ask: 1, 'user-only': 2 } as const;

function browserControlPolicyTightened(
  previous: AppConfig['browser']['structuredActions'],
  next: AppConfig['browser']['structuredActions'],
): boolean {
  return BROWSER_CONTROL_POLICY_RANK[next] > BROWSER_CONTROL_POLICY_RANK[previous];
}

function browserPasswordPolicyTightened(
  previous: AppConfig['browser']['passwordAccess'],
  next: AppConfig['browser']['passwordAccess'],
): boolean {
  return BROWSER_PASSWORD_POLICY_RANK[next] > BROWSER_PASSWORD_POLICY_RANK[previous];
}

function isBoundedFaviconDataUrl(value: string): boolean {
  if (value.length > MAX_FAVICON_DATA_URL_CHARS) return false;
  const comma = value.indexOf(',');
  if (comma < 0) return false;
  const metadata = value.slice(0, comma);
  const payload = value.slice(comma + 1);
  try {
    const bytes = /;base64(?:;|$)/i.test(metadata)
      ? Buffer.from(payload, 'base64').byteLength
      : Buffer.byteLength(decodeURIComponent(payload), 'utf8');
    return bytes <= MAX_FAVICON_BYTES;
  } catch {
    return false;
  }
}

const SENSITIVE_SCAN_SCRIPT = `(() => {
  const visited = new Set();
  const scan = (root) => {
    if (!root || visited.has(root)) return false;
    visited.add(root);
    for (const field of root.querySelectorAll?.('input') ?? []) {
      if (field.type === 'password' && typeof field.value === 'string' && field.value.length > 0) return true;
    }
    for (const element of root.querySelectorAll?.('*') ?? []) {
      if (element.shadowRoot && scan(element.shadowRoot)) return true;
      if (element.localName === 'iframe' || element.localName === 'frame') {
        try { if (element.contentDocument && scan(element.contentDocument)) return true; } catch {}
      }
    }
    return false;
  };
  return scan(document);
})()`;

/** Capture or verify a page-local, opaque reference to the focused element and
 * a bounded structural fingerprint of its selection. No selected text, field
 * value, id, name, or other page-controlled string crosses into main. */
function browserClipboardFocusFingerprintScript(stateKey: string, token: string, verify: boolean): string {
  return `(() => {
    const stateKey=${JSON.stringify(stateKey)};
    const token=${JSON.stringify(token)};
    const verify=${verify};
    const maxDepth=64, maxSiblings=4096, maxRanges=8, maxChars=${MAX_CLIPBOARD_FOCUS_FINGERPRINT_CHARS};
    try {
      let active=document.activeElement;
      for(let depth=0;active&&depth<16;depth++){
        const nested=active.shadowRoot?.activeElement;
        if(!nested)break;
        active=nested;
      }
      if(!active)return null;
      if(verify){
        const state=globalThis[stateKey];
        try{delete globalThis[stateKey];}catch{}
        if(!state||state.token!==token||state.active!==active)return null;
      }else{
        try{
          Object.defineProperty(globalThis,stateKey,{
            configurable:true,
            enumerable:false,
            writable:false,
            value:{active,token},
          });
        }catch{return null;}
        const state=globalThis[stateKey];
        if(!state||state.token!==token||state.active!==active)return null;
      }
      const path=(node)=>{
        if(!node)return '-';
        const parts=[];
        let current=node;
        for(let depth=0;depth<maxDepth;depth++){
          if(current===document){
            let result='';
            for(let index=parts.length-1;index>=0;index--)result+=(result?'.':'')+parts[index];
            return result;
          }
          if(!current)return null;
          if(current.nodeType===11&&current.host){parts.push('s');current=current.host;continue;}
          const parent=current.parentNode;
          if(!parent)return null;
          const siblings=parent.childNodes;
          const length=siblings?.length;
          if(typeof length!=='number'||length<1||length>maxSiblings||(length>>>0)!==length)return null;
          let siblingIndex=-1;
          for(let index=0;index<length;index++)if(siblings[index]===current){siblingIndex=index;break;}
          if(siblingIndex<0)return null;
          const nodeType=current.nodeType;
          if(typeof nodeType!=='number'||nodeType<1||nodeType>12)return null;
          parts.push(nodeType+':'+siblingIndex);
          current=parent;
        }
        return null;
      };
      const offset=(value)=>
        typeof value==='number'&&value>=0&&value<=2147483647&&(value|0)===value ? value : null;
      const selection=document.getSelection();
      if(!selection)return null;
      const rangeCount=selection.rangeCount;
      if(typeof rangeCount!=='number'||rangeCount<0||rangeCount>maxRanges||(rangeCount>>>0)!==rangeCount)return null;
      const anchorPath=path(selection.anchorNode), focusPath=path(selection.focusNode);
      const anchorOffset=offset(selection.anchorOffset), focusOffset=offset(selection.focusOffset);
      if(anchorPath===null||focusPath===null||anchorOffset===null||focusOffset===null)return null;
      let result='a:'+token+';s:'+rangeCount+':'+anchorPath+':'+anchorOffset+':'+focusPath+':'+focusOffset;
      for(let index=0;index<rangeCount;index++){
        const range=selection.getRangeAt(index);
        const startPath=path(range.startContainer), endPath=path(range.endContainer);
        const startOffset=offset(range.startOffset), endOffset=offset(range.endOffset);
        if(startPath===null||endPath===null||startOffset===null||endOffset===null)return null;
        result+=';r:'+startPath+':'+startOffset+':'+endPath+':'+endOffset;
        if(result.length>maxChars)return null;
      }
      const selectionStart=active.selectionStart, selectionEnd=active.selectionEnd;
      if(typeof selectionStart==='number'||typeof selectionEnd==='number'){
        const start=offset(selectionStart), end=offset(selectionEnd);
        if(start===null||end===null)return null;
        const rawDirection=active.selectionDirection;
        const direction=rawDirection==='forward'?'f':rawDirection==='backward'?'b':rawDirection==='none'?'n':'-';
        result+=';i:'+start+':'+end+':'+direction;
      }
      return result.length<=maxChars?result:null;
    }catch{
      if(verify)try{delete globalThis[stateKey];}catch{}
      return null;
    }
  })()`;
}

type BrowserAutomationOverlay = {
  contents: WebContents;
  cancelDebugger: () => void;
  releaseDebugger: () => void;
  x: number;
  y: number;
};

type BrowserBackgroundCaptureLease = {
  view: WebContentsView;
  host: BaseWindow;
  returnedToMain: boolean;
};

type BrowserViewLoadState = {
  promise: Promise<WebContentsView> | null;
  /** Number of callers currently waiting for this shared restoration. Caller
   * cancellation may reclaim the shared target only after the last waiter has
   * left; one assistant deadline must never cancel a concurrent user mount. */
  waiters: number;
  /** Exact view created by this restoration, if native creation has started. */
  view?: WebContentsView;
  /** Reject the published barrier when every reclaiming caller has left. The
   * underlying cleanup may still be unwinding, but its state-identity checks
   * prevent it from creating or publishing a late renderer. */
  reject?: (error: unknown) => void;
  /** Generation produced only by manager-issued loadURL calls for this exact
   * renderer restoration. Every caller joining the shared load uses the same
   * value, regardless of whether Browser chrome or an assistant created it. */
  expectedInitialLoadGeneration?: number;
};

type InternalTab = {
  shell: BrowserTab;
  view: WebContentsView | null;
  viewLoadPromise: Promise<WebContentsView> | null;
  viewLoadState?: BrowserViewLoadState;
  partition: string;
  scopeKey: string;
  generation: number;
  lastUsedAt: number;
  assistantOwnerId: string | null;
  aiNetworkRestricted: boolean;
  aiControlOwnerId: string | null;
  aiControlGeneration: number | null;
  aiActionDepth: number;
  aiActionUntil: number;
  aiNetworkReleaseRequested: boolean;
  aiNetworkReleaseTimer: ReturnType<typeof setTimeout> | null;
  assistantScriptDepth: number;
  /** Exact run attribution for a programmatic operation that can synchronously
   * initiate a download (for example loadURL or injected evaluation). A real
   * user gesture increments trustedGestureGeneration and invalidates it. */
  assistantDownloadAttribution?: {
    assistantOwnerId: string;
    trustedGestureGeneration: number;
  };
  popupGesture: {
    source: 'assistant' | 'user';
    assistantOwnerId: string | null;
    expiresAt: number;
    frameTreeNodeId?: number;
    kind?: 'pointerdown' | 'keydown' | 'wheel' | 'input' | 'touchstart';
  } | null;
  /** Preserve recent assistant activation independently from the last real
   * user gesture. When both overlap, popup/download ownership fails closed to
   * the assistant instead of letting a delayed AI side effect escape cleanup. */
  assistantGesture: {
    assistantOwnerId: string;
    expiresAt: number;
    frameTreeNodeId?: number;
    kind?: 'pointerdown' | 'keydown' | 'wheel' | 'input' | 'touchstart';
  } | null;
  scriptTainted: boolean;
  privateNetworkNewDocumentGuard?: { contentsId: number; identifier: string };
  /** Irreversible document-start membrane that prevents a remote page from
   * opening native print UI while this renderer is assistant-controlled. */
  assistantNativeUiNewDocumentGuard?: { contentsId: number; identifier: string };
  /** Random per-WebContents capability used only to toggle preload-installed
   * native-UI trampolines from main. Remote pages can see the trampoline but
   * cannot activate or deactivate it without this token. */
  nativeUiGuardToken?: string;
  trustedUserNavigation: boolean;
  trustedUserNavigationTarget: string | null;
  trustedUserNavigationRequestId: number | null;
  trustedUserNavigationLease: number;
  trustedUserNavigationTimer: ReturnType<typeof setTimeout> | null;
  /** Browser-chrome selection/takeover is lifecycle intent, not trusted input
   * delivered to the remote page. Track it separately so assistant close
   * transactions can observe even a transient selection without invalidating
   * exact assistant download provenance. */
  userSelectionGeneration: number;
  trustedGestureGeneration: number;
  visibleAssistantGeneration: number;
  unrestrictedNetworkGeneration: number;
  unrestrictedNetworkValidations: Map<string, Promise<void>>;
  unrestrictedNetworkUnsafe: boolean;
  queue: BrowserActionQueue;
  overlayGeneration: number;
  overlayTimer: ReturnType<typeof setTimeout> | null;
  /** Chromium's compositor-owned DevTools highlight is outside the remote
   * document, so page CSS/script cannot conceal or counterfeit Kai's live
   * automation cursor. Retaining the debugger lease keeps it visible until
   * completion, capture, validation, or teardown explicitly clears it. */
  automationOverlay: BrowserAutomationOverlay | null;
  /** Random per-document key for correlating redacted request origins without
   * creating a cross-tab or cross-navigation hostname equality oracle. */
  networkRedactionKey: BrowserNetworkRedactionKey;
  networkRequests?: Map<number, TrackedBrowserNetworkRequest>;
  /** Exact identities for every admitted request, independently bounded from
   * the smaller diagnostic-history map. Requests beyond the hard admission cap
   * are cancelled before Chromium dispatches them. */
  activeNetworkRequests?: Map<number, string>;
  /** Exact in-process URL for each admitted request. This never crosses the
   * Browser tool boundary; it exists so native HTTP-auth callbacks, which omit
   * Chromium's request id, can fail closed when a same-URL subresource makes
   * the challenged request ambiguous. */
  activeNetworkRequestUrls?: Map<number, string>;
  /** Subset of activeNetworkRequests owned by the current document/navigation.
   * Older requests remain in the complete map until Chromium reports their
   * terminal event, but must not contaminate this document's idle/in-flight
   * diagnostics after the bounded history has evicted their metadata. */
  diagnosticActiveNetworkRequestIds?: Set<number>;
  networkRequestSequence?: number;
  /** Most recent start or completion of a request that participates in the
   * network-idle wait. Streaming media and WebSockets remain visible in the
   * diagnostic snapshot without keeping the page perpetually non-idle. */
  networkLastBlockingActivityAt?: number;
  /** Monotonic identity for main-frame navigation attempts in this renderer. */
  networkNavigationSequence?: number;
  /** The committed document's diagnostics while a replacement navigation is
   * provisional. A failed/aborted navigation restores this snapshot; a commit
   * discards it without ever mixing document-local redaction identities. */
  provisionalNetworkNavigation?: {
    requests?: Map<number, TrackedBrowserNetworkRequest>;
    activeRequestIds: Set<number>;
    requestSequence: number;
    lastBlockingActivityAt?: number;
    redactionKey: BrowserNetworkRedactionKey;
    generation: number;
    urls: Set<string>;
    superseded: Array<{ generation: number; urls: Set<string> }>;
  };
  /** Bounded terminal-event tombstones for attempts superseded before the
   * current document committed. Electron's did-fail-load event has no request
   * id, so these prevent a late failure from settling a newer navigation. */
  supersededNetworkNavigations?: Array<{ generation: number; urls: Set<string> }>;
  /** Renderers temporarily exempted from Chromium background throttling while
   * this tab has active assistant work. A tab can replace its renderer during
   * sanitization, so retain all live targets until the outermost action ends. */
  assistantRenderingContents?: Set<WebContents>;
  /** WebContents with the temporary deterministic CDP viewport used by hidden
   * assistant operations. A target already presented in the sidebar retains
   * its native bounds so automation remains observable live. */
  assistantBackgroundViewportContents?: Set<WebContents>;
  /** In-flight metric installation keyed by the exact renderer. Presentation
   * waits only for this short CDP transition before clearing it; it never waits
   * for the surrounding assistant operation or its per-tab action queue. */
  assistantBackgroundViewportSetups?: Map<WebContents, Promise<void>>;
  /** Coalesces a user-presentation clear with the assistant operation's own
   * finally cleanup so concurrent debugger attach/detach sequences cannot race. */
  assistantBackgroundViewportRestores?: Map<WebContents, Promise<void>>;
  /** Bounded autonomous retries for a transient failed metrics clear. These
   * never destroy the target; presentation remains quarantined until Chromium
   * confirms the viewport is ordinary again. */
  assistantBackgroundViewportRetries?: Map<
    WebContents,
    { timer: ReturnType<typeof setTimeout> | null; attempt: number }
  >;
  /** Prevents a newly created assistant WebContents from being mounted before
   * its deterministic hidden initial-load viewport has been installed. */
  assistantBackgroundInitialLoadPending?: boolean;
  /** Keeps a newly created assistant popup runnable while Chromium completes
   * its first hidden navigation. Popup targets are created outside the normal
   * withAssistantControl lifetime, so they need their own balanced exemption. */
  assistantPopupBootstrapPending?: boolean;
  /** Resolves when that first popup navigation reaches a terminal load event or
   * the owning run/renderer is torn down. User presentation waits for this
   * independently from the per-tab action queue so it cannot reclaim a target
   * whose popup bootstrap is still executing outside the queue. */
  assistantPopupBootstrapDrain?: Promise<void>;
  resolveAssistantPopupBootstrap?: () => void;
  /** Assistant popup targets can begin executing as soon as createWindow
   * returns, before asynchronous CDP interception is ready. This marker forces
   * Chromium's synchronous disableDialogs WebPreference for that renderer. */
  assistantPopupDialogsDisabled?: boolean;
  /** Existing user pages are recreated once per controlling run with Chromium's
   * immutable disableDialogs preference. This closes the interval before CDP's
   * Page domain can subscribe to dialog events without consulting Browser UI. */
  assistantDialogsDisabledRunId: string | null;
  /** Dialog suppression is capability-scoped rather than a permanent
   * WebPreferences flag so an ordinary user-owned tab retains Chromium's native
   * alert/confirm/prompt behavior as soon as assistant control ends. */
  assistantDialogGuard?: AssistantDialogGuard;
  /** Run-lifetime native-dialog guard for an assistant-created tab. This covers
   * its initial navigation and delayed page work between explicit tool calls. */
  assistantRunDialogGuardLease?: symbol;
  isPopup: boolean;
};

type BrowserAutomationInputArm = {
  token: string;
  kind: 'pointerdown' | 'keydown' | 'wheel' | 'input';
  expiresAt: number;
  /** CDP TimeSinceEpoch value, in seconds, for the exact dispatched event. */
  timestamp: number;
  /** Background-only Input.insertText has no CDP timestamp field. Its view is
   * quarantined from physical input, so allow delivery-time drift within the
   * same bounded arm while retaining exact text and frame validation. */
  timestampToleranceSeconds?: number;
  x?: number;
  y?: number;
  screenX?: number;
  screenY?: number;
  key?: string;
  inputType?: string;
  data?: string;
};

type AssistantDialogGuard = {
  runId: string;
  owners: Set<symbol>;
  protectedContents: Map<
    WebContents,
    {
      onMessage: (event: unknown, method: string, params: unknown) => void;
      ready: Promise<void>;
      releaseDebugger: () => void;
    }
  >;
  failure: Promise<never>;
  reject: (error: Error) => void;
  handlingDialog: boolean;
  settled: boolean;
};

type PendingAutomationGesture = {
  tabId: string;
  contentsId: number;
  assistantOwnerId: string;
  expiresAt: number;
  kind: BrowserAutomationInputArm['kind'];
  inputData?: string;
  /** Exact frame documents that acknowledged this arm. A replacement frame
   * must never inherit the old token's provenance, regardless of whether the
   * eventual input uses the visible native surface or hidden CDP dispatch. */
  armedFrames?: Map<number, string>;
  /** Detached arms are kind-bound and cannot coexist with an interactive page.
   * Visible insertText arms retain exact frame identity without hiding the page. */
  detachedArm?: boolean;
  /** Set only by the isolated frame preload after Chromium delivers the exact
   * trusted event. Keep the record until the dispatching operation consumes
   * this receipt so timer expiry can never be mistaken for attribution. */
  confirmed: boolean;
  /** Remains false while visible frames acknowledge the one-shot arm. A real
   * user event that races that setup must be rejected as automation and then
   * re-reported as user-owned before the page's own handler can open a popup. */
  dispatchStarted: boolean;
  /** Created with every real arm. Optional only so defensive cleanup remains
   * compatible with partially constructed records during teardown. */
  confirmation?: Promise<boolean>;
  settleConfirmation?: (confirmed: boolean) => void;
};

type PendingAutomationArmAcknowledgement = {
  tabId: string;
  contentsId: number;
  expectedFrames: Map<number, string>;
  acknowledgedFrames: Set<number>;
  settle: (error?: Error) => void;
};

type PendingSyntheticInput = {
  tabId: string;
  arm: BrowserAutomationInputArm;
  expectedType: Electron.InputEvent['type'];
  error?: Error;
};

type DispatchedSyntheticInput = {
  tabId: string;
  contents: WebContents;
  token: string;
  kind: BrowserAutomationInputArm['kind'];
  /** Kept as a provenance tombstone until the dispatching operation consumes
   * the exact preload receipt. Once confirmed, the destructive deadline is no
   * longer needed, but the record itself must survive until CDP returns so a
   * coincident real gesture cannot consume the token and make the later
   * assistant event look user-owned. */
  timer: ReturnType<typeof setTimeout> | null;
};

type BrowserMenuPreviewSubscriber = {
  promise: Promise<BrowserScreenshotResult>;
  resolve: (result: BrowserScreenshotResult) => void;
  reject: (error: Error) => void;
  settled: boolean;
};

type BrowserMenuPreviewCapture = {
  key: string;
  tabId: string;
  contentsId: number;
  scopeKey: string;
  controller: AbortController;
  /** Lifecycle cancellation is separate from ordinary presentation
   * cancellation so profile clear/shutdown can reclaim the exact target. */
  teardownController: AbortController;
  subscribers: Map<string, BrowserMenuPreviewSubscriber>;
  operation: Promise<BrowserScreenshotResult> | null;
  completion: Promise<void> | null;
  outcome?: { result: BrowserScreenshotResult } | { error: Error };
};

type PendingMenuSensitivityProbe = {
  contentsId: number;
  expectedFrames: Map<number, string>;
  responses: Map<number, { sensitive: boolean; complete: boolean }>;
  settle: () => void;
};

type BrowserCdpInputCommand = {
  method: 'Input.dispatchMouseEvent' | 'Input.dispatchKeyEvent' | 'Input.insertText';
  params: Record<string, unknown>;
};

type BrowserInputCoordinateLease = {
  bounds: BrowserBounds;
  zoomFactor: number;
  /** Raw coordinates bind to one exact zoom. Semantic targets may be
   * re-located after zoom, but still require stable native view bounds. */
  lockZoom: boolean;
};

type PendingElementPicker = {
  tab: InternalTab;
  contents: WebContents;
  pageLease: BrowserPageLease;
  frames: Map<string, { frame: WebFrameMain; isMainFrame: boolean }>;
  clickedToken: string | null;
  settled: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  cancel: (error?: Error) => void;
  resolve: (selector: string) => void;
  reject: (error: Error) => void;
};

type PendingElementPickerFrame = {
  picker: PendingElementPicker;
  frame: WebFrameMain;
  isMainFrame: boolean;
};

type PendingAssistantContinuation = {
  conversationId: string;
  runId: string;
  drain: Promise<void>;
  timer: ReturnType<typeof setTimeout>;
};

type PendingAssistantTabCleanupRetry = {
  conversationId: string;
  runId: string;
  completion: Promise<void>;
  resolve: () => void;
  timer: ReturnType<typeof setTimeout> | null;
};

type AssistantDocumentLease = {
  runId: string;
  runGeneration: number;
  hostRendererAuthorityGeneration: number;
  tabGeneration: number;
  userNavigationLease: number;
  url: string;
  /** Set only after an operation has proved that its page is mounted in the
   * visible Browser panel. Hiding that page revokes subsequent renderer work
   * without coupling script-quarantine detachment to panel visibility. */
  visibleAssistantGeneration?: number;
};

type BrowserSemanticTargetLease = {
  contextId: number;
  globalKey: string;
  releaseDebugger?: () => void;
};

type BrowserDebuggerOwnership = {
  leases: Set<BrowserDebuggerLeaseState>;
  detachWhenIdle: boolean;
};

type BrowserDebuggerLeaseState = {
  cancelled: boolean;
  released: boolean;
};

type BrowserDebuggerLease = {
  release: () => void;
  /** Detach only the debugger generation acquired by this lease. */
  cancel: () => void;
};

type BrowserLocatedTarget = {
  x: number;
  y: number;
  width: number;
  height: number;
  semanticLease?: BrowserSemanticTargetLease;
};

/** Identity of the live document whose pixels are being captured. User-driven
 * screenshots intentionally remain concurrent with page input/navigation, so
 * they need their own lease instead of relying on assistant turn ownership. */
type BrowserPageLease = {
  tabId: string;
  tabGeneration: number;
  userNavigationLease: number;
  contents: WebContents;
};

type BrowserContextMenuDownloadAuthority = {
  tabId: string;
  tabGeneration: number;
  userNavigationLease: number;
  contents: WebContents;
  url: string;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
};

type BrowserClipboardFocusLease = {
  frame: WebFrameMain;
  stateKey: string;
  token: string;
  fingerprint: Promise<string | null>;
};

type HostRendererOperationLease = {
  generation: number;
  abortSignal: AbortSignal;
};

/** Immutable page identity captured immediately before a user approval prompt.
 * The approved call must still target this tab/document when its serialized
 * browser operation begins. */
export type BrowserDocumentApproval = {
  tabId: string;
  tabGeneration: number;
  origin: string;
  /** Exact internal URL identity. Kept out of approval events so query tokens
   * are not persisted, but used to invalidate same-document SPA navigation. */
  url?: string;
  /** Main-process-only identity and navigation lease. They never cross IPC;
   * together they distinguish an idle renderer restoration from a replaced
   * tab or a concurrent user navigation to the same URL. */
  tabRef?: object;
  userNavigationLease?: number;
  allowInternalRestore?: boolean;
};

type BrowserApprovalWithDocument = BrowserDocumentApproval | BrowserTabsApproval;

/** One tool-approval object may cross exactly one manager-owned renderer
 * replacement. The lease is main-process-only and is created only after the
 * approved document has been revalidated inside the tab queue. */
type BrowserApprovalRendererResetLease = {
  approval: BrowserApprovalWithDocument;
  tab: InternalTab;
  runId: string;
  origin: string;
  url: string;
  userNavigationLease: number;
  sourceGeneration: number;
  sourceContents: WebContents | null;
  preparedGeneration?: number;
  replacementContents?: WebContents;
};

/** Password approval also binds the exact saved record and the frame origin
 * that will receive it. The top-level origin remains useful context, but is not
 * necessarily the credential destination when login UI lives in an OOPIF. */
export type BrowserAutofillApproval = BrowserDocumentApproval & {
  credentialId: string;
  credentialUpdatedAt: string;
  destinationOrigin: string;
};

function isBrowserAutofillApproval(value: BrowserDocumentApproval): value is BrowserAutofillApproval {
  const candidate = value as Partial<BrowserAutofillApproval>;
  return (
    typeof candidate.credentialId === 'string' &&
    typeof candidate.credentialUpdatedAt === 'string' &&
    typeof candidate.destinationOrigin === 'string'
  );
}

export type BrowserTabsMutationAction =
  | 'open'
  | 'close'
  | 'duplicate'
  | 'reopen_closed'
  | 'keep_open'
  | 'close_others'
  | 'close_right';

/** Immutable tab-list identity captured before an ask-policy prompt. Object
 * references never cross IPC; they let the manager distinguish the exact live
 * tab/closed-history entry even if a caller somehow reuses an id. */
export type BrowserTabsApproval = {
  action: BrowserTabsMutationAction;
  conversationId: string;
  tabId?: string;
  tabGeneration?: number;
  origin?: string;
  url?: string;
  tabRef?: object;
  userNavigationLease?: number;
  allowInternalRestore?: boolean;
  closedTabRef?: object | null;
  tabOrder?: string[];
  affectedTabIds?: string[];
  affectedTabRefs?: object[];
};

/** Exact tab-shell identity captured before an ask-policy tab-list read. The
 * snapshot stays main-process-only and prevents a user navigation, close, or
 * reorder while the prompt is open from being disclosed under stale consent. */
export type BrowserTabsReadApproval = {
  conversationId: string;
  activeTabId: string | null;
  tabOrder: string[];
  tabRefs: object[];
  tabGenerations: number[];
  tabUrls: string[];
  userNavigationLeases: number[];
};

type PendingFaviconFetch = {
  url: string;
  controller: AbortController;
};

type CachedBrowserDownload = BrowserDownload & { scopeKey: string };

type ActiveBrowserDownload = {
  id: string;
  scopeKey: string;
  conversationId: string;
  tabId: string;
  assistantOwnerId: string | null;
  keepOpen: boolean;
  quarantinePath?: string;
  item: DownloadItem;
  done: Promise<void>;
  cancel: (persistTerminalAcrossGeneration?: boolean) => Promise<void>;
};

type BrowserConfigPreemption = {
  scopeKeys: ReadonlySet<string>;
  scopeChanged: boolean;
  disabling: boolean;
  controlPolicyTightened: boolean;
  privateNetworkTightened: boolean;
  connectionDrain: Promise<void>;
  downloadDrain: Promise<void>;
  menuPreviewDrain: Promise<void>;
};

export type BrowserAssistantRun = {
  id: string;
  abortSignal?: AbortSignal;
};

type BrowserScreenshotPostprocessor<T> = (screenshot: BrowserScreenshotResult, abortSignal?: AbortSignal) => Promise<T>;

type PendingBrowserScreenshot = {
  result: BrowserScreenshotResult;
  persist: () => void;
};

type ClosedTab = Pick<BrowserTab, 'url' | 'title' | 'owner' | 'keepOpen' | 'sensitive'> & {
  id: string;
  scopeKey: string;
};
type PendingCredential = {
  tabId: string;
  conversationId: string;
  origin: string;
  username: string;
  password: string;
  update: boolean;
  scopeKey: string;
  timer: ReturnType<typeof setTimeout>;
  responding?: boolean;
};
type PendingPermission = {
  tabId: string;
  conversationId: string;
  scopeKey: string;
  tabGeneration: number;
  origin: string;
  permission: string;
  target?: string;
  canPersist: boolean;
  assistantTriggered: boolean;
  storageKeys: string[];
  callback: (allowed: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
};
type PendingAuth = {
  tabId: string;
  conversationId: string;
  scopeKey: string;
  tabGeneration: number;
  /** Present only when the challenge belongs to the exact main-frame request
   * claimed by an explicit user navigation through an AI-restricted tab. */
  trustedUserNavigationLease?: number;
  trustedUserNavigationRequestId?: number;
  trustedUserNavigationUrl?: string;
  prompt: BrowserAuthPrompt;
  callback: (username?: string, password?: string) => void;
  timer: ReturnType<typeof setTimeout>;
};

function now(): string {
  return new Date().toISOString();
}

function cdpKeyboardModifiers(modifiers: ReadonlyArray<'shift' | 'control' | 'alt' | 'meta'>): number {
  let result = 0;
  if (modifiers.includes('alt')) result |= 1;
  if (modifiers.includes('control')) result |= 2;
  if (modifiers.includes('meta')) result |= 4;
  if (modifiers.includes('shift')) result |= 8;
  return result;
}

function cdpKeyboardEventParams(
  type: 'keyDown' | 'keyUp',
  keyCode: string,
  modifiers: ReadonlyArray<'shift' | 'control' | 'alt' | 'meta'>,
): Record<string, unknown> {
  const aliases: Record<string, { key: string; code: string; virtualKeyCode: number }> = {
    enter: { key: 'Enter', code: 'Enter', virtualKeyCode: 13 },
    tab: { key: 'Tab', code: 'Tab', virtualKeyCode: 9 },
    alt: { key: 'Alt', code: 'AltLeft', virtualKeyCode: 18 },
    control: { key: 'Control', code: 'ControlLeft', virtualKeyCode: 17 },
    ctrl: { key: 'Control', code: 'ControlLeft', virtualKeyCode: 17 },
    shift: { key: 'Shift', code: 'ShiftLeft', virtualKeyCode: 16 },
    meta: { key: 'Meta', code: 'MetaLeft', virtualKeyCode: 91 },
    command: { key: 'Meta', code: 'MetaLeft', virtualKeyCode: 91 },
    cmd: { key: 'Meta', code: 'MetaLeft', virtualKeyCode: 91 },
    esc: { key: 'Escape', code: 'Escape', virtualKeyCode: 27 },
    escape: { key: 'Escape', code: 'Escape', virtualKeyCode: 27 },
    backspace: { key: 'Backspace', code: 'Backspace', virtualKeyCode: 8 },
    delete: { key: 'Delete', code: 'Delete', virtualKeyCode: 46 },
    insert: { key: 'Insert', code: 'Insert', virtualKeyCode: 45 },
    arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', virtualKeyCode: 37 },
    arrowup: { key: 'ArrowUp', code: 'ArrowUp', virtualKeyCode: 38 },
    arrowright: { key: 'ArrowRight', code: 'ArrowRight', virtualKeyCode: 39 },
    arrowdown: { key: 'ArrowDown', code: 'ArrowDown', virtualKeyCode: 40 },
    home: { key: 'Home', code: 'Home', virtualKeyCode: 36 },
    end: { key: 'End', code: 'End', virtualKeyCode: 35 },
    pageup: { key: 'PageUp', code: 'PageUp', virtualKeyCode: 33 },
    pagedown: { key: 'PageDown', code: 'PageDown', virtualKeyCode: 34 },
    space: { key: ' ', code: 'Space', virtualKeyCode: 32 },
    ' ': { key: ' ', code: 'Space', virtualKeyCode: 32 },
  };
  const shiftedDigits: Record<string, string> = {
    '0': ')',
    '1': '!',
    '2': '@',
    '3': '#',
    '4': '$',
    '5': '%',
    '6': '^',
    '7': '&',
    '8': '*',
    '9': '(',
  };
  const punctuation: Record<string, { shifted: string; code: string; virtualKeyCode: number }> = {
    '`': { shifted: '~', code: 'Backquote', virtualKeyCode: 192 },
    '-': { shifted: '_', code: 'Minus', virtualKeyCode: 189 },
    '=': { shifted: '+', code: 'Equal', virtualKeyCode: 187 },
    '[': { shifted: '{', code: 'BracketLeft', virtualKeyCode: 219 },
    ']': { shifted: '}', code: 'BracketRight', virtualKeyCode: 221 },
    '\\': { shifted: '|', code: 'Backslash', virtualKeyCode: 220 },
    ';': { shifted: ':', code: 'Semicolon', virtualKeyCode: 186 },
    "'": { shifted: '"', code: 'Quote', virtualKeyCode: 222 },
    ',': { shifted: '<', code: 'Comma', virtualKeyCode: 188 },
    '.': { shifted: '>', code: 'Period', virtualKeyCode: 190 },
    '/': { shifted: '?', code: 'Slash', virtualKeyCode: 191 },
  };
  const lowerKeyCode = keyCode.toLowerCase();
  const shifted = modifiers.includes('shift');
  const functionKey = /^f([1-9]|1\d|2[0-4])$/i.exec(keyCode);
  const punctuationKey = punctuation[keyCode];
  const normalized =
    aliases[lowerKeyCode] ??
    (functionKey
      ? {
          key: `F${functionKey[1]}`,
          code: `F${functionKey[1]}`,
          virtualKeyCode: 111 + Number(functionKey[1]),
        }
      : punctuationKey
        ? {
            key: shifted ? punctuationKey.shifted : keyCode,
            code: punctuationKey.code,
            virtualKeyCode: punctuationKey.virtualKeyCode,
          }
        : /^[a-z]$/i.test(keyCode)
          ? {
              key: shifted ? keyCode.toUpperCase() : keyCode.toLowerCase(),
              code: `Key${keyCode.toUpperCase()}`,
              virtualKeyCode: keyCode.toUpperCase().charCodeAt(0),
            }
          : /^\d$/.test(keyCode)
            ? {
                key: shifted ? shiftedDigits[keyCode] : keyCode,
                code: `Digit${keyCode}`,
                virtualKeyCode: keyCode.charCodeAt(0),
              }
            : { key: keyCode, code: keyCode, virtualKeyCode: 0 });
  const printable = normalized.key.length === 1 && !modifiers.some((modifier) => modifier !== 'shift');
  return {
    type,
    key: normalized.key,
    code: normalized.code,
    modifiers: cdpKeyboardModifiers(modifiers),
    windowsVirtualKeyCode: normalized.virtualKeyCode,
    nativeVirtualKeyCode: normalized.virtualKeyCode,
    ...(type === 'keyDown' && printable ? { text: normalized.key } : {}),
  };
}

function assistantContinuationKey(conversationId: string, runId: string): string {
  return `${conversationId}\u0000${runId}`;
}

function securityForUrl(url: string): BrowserTab['security'] {
  if (url.startsWith('https:')) return 'secure';
  if (url.startsWith('http:')) return 'insecure';
  if (INTERNAL_URLS.has(url)) return 'internal';
  return 'unknown';
}

function normalizedOrigin(value: string): string {
  try {
    return new URL(value).origin;
  } catch {
    return 'unknown';
  }
}

function permissionGrantKey(tabId: string, origin: string, permission: string): string {
  return `${tabId}\u0000${origin}\u0000${permission}`;
}

function throwIfBrowserAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('Browser action was cancelled.');
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  throwIfBrowserAborted(signal);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    timer.unref?.();
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('Browser action was cancelled.'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function resolveHostWithDeadline<T>(task: Promise<T>, signal?: AbortSignal): Promise<T> {
  throwIfBrowserAborted(signal);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (result: { value: T } | { error: unknown }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if ('error' in result) reject(result.error);
      else resolve(result.value);
    };
    const timer = setTimeout(
      () =>
        finish({
          error: new Error('Browser DNS resolution exceeded 10 seconds.'),
        }),
      DNS_RESOLUTION_TIMEOUT_MS,
    );
    timer.unref?.();
    const onAbort = () => finish({ error: new Error('Browser action was cancelled.') });
    signal?.addEventListener('abort', onAbort, { once: true });
    void task.then(
      (value) => finish({ value }),
      (error) => finish({ error }),
    );
  });
}

export class BrowserManager {
  private readonly tabs = new Map<string, InternalTab>();
  private readonly tabOrder = new Map<string, string[]>();
  private readonly activeTabs = new Map<string, string>();
  private readonly closedTabs = new Map<string, ClosedTab[]>();
  private readonly stores = new Map<string, BrowserProfileStore>();
  /** Stores created solely to repair persisted startup download metadata. A
   * normal runtime access removes its marker, preventing reconciliation from
   * evicting a store that UI/tool work began using concurrently. */
  private startupOnlyStores = new Map<string, BrowserProfileStore>();
  private readonly vaults = new Map<string, BrowserCredentialVault>();
  private readonly wiredSessions = new WeakSet<Session>();
  private readonly wiredSessionsByScope = new Map<string, Session>();
  private readonly wiredSessionCleanups = new Map<string, () => void>();
  /** All Browser sessions use one authenticated loopback proxy so DNS
   * validation is bound to the TCP destination. Restrictions are request- and
   * hostname-scoped, preserving unrelated user traffic in a global profile. */
  private readonly validatingProxy: BrowserValidatingProxy;
  private readonly pendingCredentials = new Map<string, PendingCredential>();
  private readonly pendingPermissions = new Map<string, PendingPermission>();
  private readonly pendingAuth = new Map<string, PendingAuth>();
  private readonly runningActions = new Map<string, { conversationId: string; action: BrowserActionEvent }>();
  private readonly pendingElementPickerCancels = new Map<string, (error?: Error) => void>();
  private readonly pendingElementPickerFrames = new Map<string, PendingElementPickerFrame>();
  private readonly activeFindRequests = new Map<string, { requestId: number; electronRequestId: number | null }>();
  private readonly oneTimePermissions = new Set<string>();
  private readonly downloads = new Map<string, CachedBrowserDownload>();
  private readonly activeDownloads = new Map<DownloadItem, ActiveBrowserDownload>();
  /** A native context-menu selection is itself a fresh, explicit user command.
   * Bind Save Image As to one exact document, WebContents, and URL instead of
   * depending on the earlier right-click's short popup provenance window. */
  private contextMenuDownloadAuthorities?: Map<number, BrowserContextMenuDownloadAuthority> = new Map();
  /** Completed quarantine files being exported through a native save dialog.
   * Ref counts cover duplicate concurrent exports of the same file. */
  private readonly downloadExportLeases = new Map<string, Map<string, number>>();
  private readonly faviconFetches = new Map<string, PendingFaviconFetch>();
  private readonly webContentsToTab = new Map<number, string>();
  private readonly pendingTabCreations = new Map<string, number>();
  /** Assistant bulk-close transactions synchronously fence every captured tab
   * before draining its already-admitted work. New work fails cleanly instead
   * of entering a sibling queue behind a partially acquired multi-queue lock. */
  private pendingAssistantTabClosures = new Map<string, symbol>();
  private readonly removedConversations = new Set<string>();
  private readonly assistantRuns = new BrowserAssistantRunRegistry();
  /** Automation selection is capability state, not presentation state. The
   * Browser panel's active tab remains user-owned while each assistant run
   * independently remembers the last tab it opened or explicitly targeted. */
  private assistantTargetTabs = new Map<string, string>();
  private readonly pendingAssistantContinuations = new Map<string, PendingAssistantContinuation>();
  private assistantTabCleanups?: Map<string, Set<Promise<void>>>;
  /** Failed ordinary turn cleanup stays owned here until a headless retry
   * succeeds. This is separate from continuation handoffs: a failed completed
   * run must never become adoptable by a future logical-turn continuation. */
  private assistantTabCleanupRetries?: Map<string, PendingAssistantTabCleanupRetry>;
  private assistantDownloadCleanupRetryTimer: ReturnType<typeof setTimeout> | null = null;
  /** Exact downloads captured at a global Browser-authority revocation. A retry
   * must never re-enumerate downloads that a later authorized run started. */
  private assistantDownloadCleanupRetryTargets?: Set<ActiveBrowserDownload>;
  /** Run ids whose temporary tabs are retained across the gap between a
   * completed stream and its authorized continuation. */
  private readonly assistantContinuationLeases = new Set<string>();
  private readonly clearingScopes = new Set<string>();
  /** Origin-scoped storage sanitization allows only the tab being prepared to
   * recreate its renderer. Same-profile sibling tabs fail closed until stale
   * workers, connections, and non-cookie storage are gone. */
  private readonly clearingOrigins = new Map<string, string>();
  private readonly scriptOriginCleanupTails = new Map<string, Promise<void>>();
  /** A failed clear may leave a service worker alive. Unlike the ordinary
   * private-network guard, this quarantine denies every request and profile
   * operation until a full clear retry succeeds. */
  private clearQuarantinedScopes = new Set<string>();
  /** A malformed/unreadable durable cleanup marker has unknown scope. Deny
   * every profile until an explicit clear repairs the marker. */
  private pendingCleanupQuarantineUnreadable = false;
  private readonly suspendedScopes = new Set<string>();
  private readonly scopeActivityCounts = new Map<string, number>();
  private readonly scopeIdleWaiters = new Map<string, Set<() => void>>();
  private readonly scopeGenerations = new Map<string, number>();
  private scopeGenerationSerial = 0;
  private readonly scopeRequestActivities = new Map<string, Map<number, () => void>>();
  private readonly scopeRuntimeReleaseTokens = new Map<string, object>();
  private readonly restrictedBackgroundScopes = new Set<string>();
  private readonly assistantControlledOrigins = new Map<string, Set<string>>();
  private readonly automationGestureTokens = new Map<string, PendingAutomationGesture>();
  private readonly pendingAutomationArmAcknowledgements = new Map<string, PendingAutomationArmAcknowledgement>();
  private readonly pendingMenuSensitivityProbes = new Map<string, PendingMenuSensitivityProbe>();
  private readonly pendingSyntheticInputs = new Map<number, PendingSyntheticInput>();
  private readonly dispatchedSyntheticInputs = new Map<number, DispatchedSyntheticInput>();
  /** Every manager-owned CDP operation participates in one synchronous,
   * per-WebContents reference count. Presentation can clear a hidden viewport
   * without joining the tab action queue, so a plain `wasAttached` check lets
   * either operation detach the debugger while the other still uses it. */
  private debuggerOwnership = new WeakMap<WebContents, BrowserDebuggerOwnership>();
  /** Ask-policy consent is document-bound, while the first assistant operation
   * must synchronously replace a user renderer to disable native dialogs. This
   * weak lease lets only that exact manager-owned replacement retain consent. */
  private approvalRendererResetLeases = new WeakMap<object, BrowserApprovalRendererResetLease>();
  /** Disabling file-chooser interception is asynchronous. A successor guard on
   * the same target must wait for that restore so an older disable command can
   * never overtake and silently remove the new assistant protection. */
  private assistantDialogProtectionRestores = new Map<number, Promise<void>>();
  private readonly panelAuthorityGenerations = new Map<string, number>();
  /** Host bounds and page zoom both change the coordinate space used by
   * Chromium input events. Physical assistant actions capture this generation
   * before queueing and must re-resolve their target after either changes. */
  private readonly panelLayoutGenerations = new Map<string, number>();
  /** Raw coordinates identify one exact rendered viewport. Presentation may be
   * hidden or switched while input is in flight, but it must not resize that
   * surface until the final input event has been dispatched. */
  private inputCoordinateSurfaceLeases?: WeakMap<WebContentsView, Set<BrowserInputCoordinateLease>>;
  private readonly panelStateWaiters = new Map<string, Set<() => void>>();
  private readonly hostRendererOperationContext = new AsyncLocalStorage<HostRendererOperationLease>();
  private readonly hostRendererOperationControllers = new Set<AbortController>();
  /** Browser profile mutations must not overlap. A scope transition can move
   * live tabs between profiles while clear-data is deciding which tabs to
   * reset, so both operations share one queue rather than independent tails. */
  private profileMutationTail: Promise<void> = Promise.resolve();
  /** Config notifications can arrive while an earlier profile mutation is
   * still draining. Only the newest notification may release profile gates or
   * remount a renderer; older queued transitions still update the internal
   * scope state so the newest transition can apply from a coherent baseline. */
  private browserConfigGeneration = 0;
  /** Real screenshot capture/encoding can hold buffers near the global pixel
   * ceiling, so serialize it across tabs. Menu previews use the opportunistic
   * path and a separate, much smaller pixel cap. */
  private readonly screenshotQueue = new BrowserActionQueue();
  /** Admit at most one bounded CDP menu preview process-wide and let duplicate
   * requests for the same document share it. */
  private menuPreviewCapture: BrowserMenuPreviewCapture | null = null;
  /** Crash recovery begins after construction so startup is not synchronously
   * blocked on profile I/O. It remains an explicit shutdown/profile-mutation
   * barrier so no recovery writer can outlive this manager. */
  private startupDownloadReconciliation: Promise<void> = Promise.resolve();
  private shutdownPromise: Promise<void> | null = null;
  private attachedView: WebContentsView | null = null;
  /** A minimized BrowserWindow stops producing compositor frames even while
   * background throttling is disabled. Hidden screenshots temporarily reparent
   * their existing WebContentsView into a non-focusable BaseWindow so Chromium
   * can paint without mounting, showing, restoring, or focusing Kai's UI. */
  private captureHostedView: WebContentsView | null = null;
  /** Operation-scoped ownership prevents a timed-out capture's late finalizer
   * from corrupting the returned-to-main state of a successor capture. */
  private captureHostedViewLease: BrowserBackgroundCaptureLease | null = null;
  /** Reusable renderer-free capture host. It is explicitly destroyed before
   * the primary window closes so it cannot suppress last-window shutdown. */
  private backgroundCaptureHost: BaseWindow | null = null;
  /** WebContentsViews survive primary-window recreation. Keep exact detached
   * ownership so a replacement window can host each retained renderer once,
   * without recreating authenticated DOM state or requiring a mounted panel. */
  private detachedHostViews = new Set<WebContentsView>();
  private closingHostWindow: BrowserWindow | null = null;
  private mountedConversationId: string | null = null;
  private mountedBounds: BrowserBounds | null = null;
  private disposed = false;
  private shuttingDown = false;
  private dataScope: AppConfig['browser']['dataScope'];
  private browserEnabled: boolean;
  private readAccessPolicy: AppConfig['browser']['readAccess'];
  private structuredActionsPolicy: AppConfig['browser']['structuredActions'];
  private scriptInjectionPolicy: AppConfig['browser']['scriptInjection'];
  private passwordAccessPolicy: AppConfig['browser']['passwordAccess'];
  private aiAllowPrivateNetwork: boolean;
  private hostRendererAuthorityGeneration = 0;
  private hostRendererAuthorityAvailable = false;
  private chromeFocusConversationId: string | null = null;
  private hostWindowShown = false;
  private hostWindowInteractive = false;
  private activeFaviconFetches = 0;
  private readonly idleTimer: ReturnType<typeof setInterval>;

  constructor(
    private readonly appHome: string,
    private readonly getConfig: () => AppConfig,
    private readonly getWindow: () => BrowserWindow | null,
    private readonly pagePreloadPath: string,
    private readonly conversationExists: (conversationId: string) => boolean = () => true,
  ) {
    const browserConfig = getConfig().browser;
    this.dataScope = browserConfig.dataScope;
    this.browserEnabled = browserConfig.enabled;
    this.readAccessPolicy = browserConfig.readAccess ?? 'allow';
    this.structuredActionsPolicy = browserConfig.structuredActions ?? 'allow';
    this.scriptInjectionPolicy = browserConfig.scriptInjection ?? 'allow';
    this.passwordAccessPolicy = browserConfig.passwordAccess ?? 'user-only';
    this.aiAllowPrivateNetwork = browserConfig.aiAllowPrivateNetwork ?? false;
    this.validatingProxy = new BrowserValidatingProxy((url) =>
      session.fromPartition(browserSystemProxyResolverPartition()).resolveProxy(url),
    );
    this.refreshPendingCleanupQuarantine();
    // Quarantined AI downloads are app-owned temporary artifacts, not files in
    // the user's Downloads folder. Expire them independently of whether the
    // Browser sidebar is ever mounted during this app session.
    this.startupDownloadReconciliation = new Promise<void>((resolve, reject) => {
      const immediate = setImmediate(() => {
        void this.reconcileAssistantDownloadQuarantineAtStartup().then(resolve, reject);
      });
      immediate.unref?.();
    });
    this.profileMutationTail = this.startupDownloadReconciliation.catch((error: unknown) => {
      console.warn('[Browser] Could not reconcile assistant download quarantine:', error);
    });
    ipcMain.on('browser-page:sensitive', this.handleSensitiveEvent);
    ipcMain.on('browser-page:login-submitted', this.handleLoginSubmitted);
    ipcMain.on('browser-page:activity', this.handlePageActivity);
    ipcMain.on('browser-page:gesture', this.handlePageGesture);
    ipcMain.on('browser-page:automation-input-armed', this.handleAutomationInputArmed);
    ipcMain.on('browser-page:sensitivity-probe-result', this.handleMenuSensitivityProbeResult);
    ipcMain.on('browser-page:element-picker-click', this.handleElementPickerClick);
    ipcMain.on('browser-page:element-picker-result', this.handleElementPickerResult);
    ipcMain.on('browser-page:element-picker-cancel', this.handleElementPickerCancel);
    app.on('login', this.handleLogin);
    app.on('select-client-certificate', this.handleSelectClientCertificate);
    this.idleTimer = setInterval(() => this.discardIdleTabs(), 60_000);
    this.idleTimer.unref?.();
  }

  handleConfigChanged(config: AppConfig['browser']): Promise<BrowserConfigTransitionResult> {
    if (this.disposed || this.shuttingDown) return Promise.resolve({ committed: false });
    const requestGeneration = (this.browserConfigGeneration ?? 0) + 1;
    this.browserConfigGeneration = requestGeneration;
    const preemption = this.preemptBrowserConfigTransition(config);
    const transition = this.profileMutationTail.then(() =>
      this.applyBrowserConfig(config, requestGeneration, preemption),
    );
    this.profileMutationTail = transition.then(
      () => undefined,
      () => undefined,
    );
    return transition;
  }

  /** Fail closed as soon as Settings publishes a lifecycle-changing Browser
   * configuration. The serialized mutation may be waiting behind an unrelated
   * profile clear, but the old renderer/session must not remain online or keep
   * writing under a setting the UI has already replaced. Persistent mutation
   * still happens in applyBrowserConfig once the shared queue reaches us. */
  private preemptBrowserConfigTransition(config: AppConfig['browser']): BrowserConfigPreemption | null {
    const scopeChanged = config.dataScope !== this.dataScope;
    const disabling = !config.enabled && this.browserEnabled;
    if (disabling) this.browserEnabled = false;
    const nextReadAccess = config.readAccess ?? this.readAccessPolicy;
    const nextStructuredActions = config.structuredActions ?? this.structuredActionsPolicy;
    const nextScriptInjection = config.scriptInjection ?? this.scriptInjectionPolicy;
    const nextPasswordAccess = config.passwordAccess ?? this.passwordAccessPolicy;
    const controlPolicyTightened =
      browserControlPolicyTightened(this.readAccessPolicy, nextReadAccess) ||
      browserControlPolicyTightened(this.structuredActionsPolicy, nextStructuredActions) ||
      browserControlPolicyTightened(this.scriptInjectionPolicy, nextScriptInjection) ||
      browserPasswordPolicyTightened(this.passwordAccessPolicy, nextPasswordAccess);
    const privateNetworkTightened = this.aiAllowPrivateNetwork && config.aiAllowPrivateNetwork === false;
    if (privateNetworkTightened) {
      // Publish the stricter cached policy before the serialized profile
      // transition can wait behind a clear. A tab created for a conversation
      // scope absent from this preemption snapshot must still install the
      // evaluation/WebRTC guards immediately.
      this.aiAllowPrivateNetwork = false;
    }
    // Approval-policy changes revoke capabilities minted under the old policy,
    // but they do not change the profile/session lifecycle. Keep user-owned
    // renderers, downloads, and ordinary browsing alive while cancelling the
    // assistant operations that were admitted under the looser setting.
    if (controlPolicyTightened) this.revokeAssistantAccess();
    if (!scopeChanged && !disabling && !privateNetworkTightened) return null;

    // A last-tab releaser may already be between worker shutdown, connection
    // close, and metadata flush. Revoke every token before publishing a scope
    // suspension so that stale work can never release (and historically
    // unsuspend) a profile selected by the previous configuration.
    const pendingReleaseScopeKeys = [...this.scopeRuntimeReleaseTokens.keys()];
    this.scopeRuntimeReleaseTokens.clear();

    const affectedTabs = [...this.tabs.values()];
    const oldScopeKeys = new Set([
      ...affectedTabs.map((tab) => tab.scopeKey),
      ...this.scopeActivityCounts.keys(),
      ...[...this.activeDownloads.values()].map((download) => download.scopeKey),
      ...this.wiredSessionsByScope.keys(),
      ...pendingReleaseScopeKeys,
    ]);
    const sessions = new Map<string, Session>();
    const serviceWorkerStops: Promise<void>[] = [];
    for (const scopeKey of oldScopeKeys) {
      this.suspendedScopes.add(scopeKey);
      this.bumpScopeGeneration(scopeKey);
      const scopedSession =
        this.wiredSessionsByScope.get(scopeKey) ?? session.fromPartition(browserPartitionForScopeKey(scopeKey));
      sessions.set(scopeKey, scopedSession);
      // The tabs below are destroyed immediately after this loop. Give worker
      // shutdown its own temporary CDP target so an async debugger command can
      // never race a renderer teardown.
      serviceWorkerStops.push(this.stopRunningServiceWorkers(scopedSession, undefined, true));
    }

    const downloadDrain = this.cancelActiveDownloadsForScopes(oldScopeKeys);
    void downloadDrain.catch(() => undefined);
    const changedConversations = new Set<string>();
    for (const tab of affectedTabs) {
      if (
        privateNetworkTightened &&
        tab.aiNetworkRestricted &&
        !tab.trustedUserNavigation &&
        tab.view &&
        !tab.view.webContents.isDestroyed()
      ) {
        configureBrowserWebContents(tab.view.webContents, false);
      }
      this.destroyView(tab);
      tab.shell.discarded = true;
      tab.shell.sensitive = false;
      changedConversations.add(tab.shell.conversationId);
    }
    for (const conversationId of changedConversations) this.emitTabs(conversationId);
    const menuPreviewDrain = this.drainMenuPreviewCapture(
      oldScopeKeys,
      new Error('Browser menu preview was cancelled because Browser settings changed.'),
    );
    void menuPreviewDrain.catch(() => undefined);

    // Start connection shutdown now rather than after the profile-mutation
    // queue. Request accounting is released only after Chromium has been asked
    // to close every connection, matching the normal transition barrier.
    const connectionDrain = Promise.allSettled([
      ...serviceWorkerStops,
      ...[...sessions.values()].map((scopedSession) => scopedSession.closeAllConnections()),
    ]).then((results) => {
      const failures = results
        .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        .map((result) => result.reason);
      if (failures.length > 0) {
        throw new AggregateError(failures, 'Browser network quiescence failed during a config transition.');
      }
      for (const scopeKey of oldScopeKeys) this.finishAllScopeRequestActivities(scopeKey);
    });
    // applyBrowserConfig joins this promise once the serialized profile queue
    // reaches the transition. Mark the rejection handled immediately so a fast
    // Chromium failure cannot surface as an unhandled rejection while an
    // unrelated profile mutation is still ahead of it.
    void connectionDrain.catch(() => undefined);
    return {
      scopeKeys: oldScopeKeys,
      scopeChanged,
      disabling,
      controlPolicyTightened,
      privateNetworkTightened,
      connectionDrain,
      downloadDrain,
      menuPreviewDrain,
    };
  }

  /** The primary renderer reports focus explicitly because Electron resolves
   * application-menu accelerators before a DOM keydown listener can cancel
   * them. Only Browser chrome may claim these shortcuts; chat/composer focus
   * remains governed by the normal application menu. */
  setChromeFocus(conversationId: string, focused: boolean): void {
    if (focused) {
      if (this.disposed || this.shuttingDown || this.removedConversations.has(conversationId)) return;
      if (this.chromeFocusConversationId !== conversationId) {
        const previousConversationId = this.chromeFocusConversationId;
        this.chromeFocusConversationId = conversationId;
        if (previousConversationId) this.notifyPanelStateChanged(previousConversationId);
        this.notifyPanelStateChanged(conversationId);
      }
      const win = this.getWindow();
      if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.focus();
    } else if (this.chromeFocusConversationId === conversationId) {
      this.chromeFocusConversationId = null;
      this.notifyPanelStateChanged(conversationId);
    }
  }

  /** BrowserWindow focus and visibility affect only presentation. Assistant
   * operations keep running against hidden hosted views when Kai is blurred,
   * minimized, or hidden. */
  handleHostWindowVisibilityChanged(): void {
    if (this.disposed || this.shuttingDown) return;
    this.handleHostWindowCreated();
    const wasShown = this.hostWindowShown;
    const wasInteractive = this.hostWindowInteractive;
    const shown = this.isHostWindowShown();
    const interactive = shown && this.isHostWindowInteractive();
    this.hostWindowShown = shown;
    this.hostWindowInteractive = interactive;
    // A menu preview is presentation-only. Cancel it when the host disappears;
    // manager-owned CDP work is detached without destroying live DOM/SPA state.
    const menuPreview = this.menuPreviewCapture;
    if (!shown && menuPreview && !menuPreview.teardownController.signal.aborted) {
      const tab = this.tabs.get(menuPreview.tabId);
      const recovery = tab
        ? this.preemptMenuPreviewForTab(tab, 'Browser menu preview was cancelled because Kai was hidden or minimized.')
        : null;
      if (!recovery) {
        menuPreview.controller.abort();
        this.settleMenuPreviewCapture(menuPreview, {
          error: new Error('Browser menu preview was cancelled because Kai was hidden or minimized.'),
        });
      } else {
        void recovery.catch((error: unknown) => {
          console.warn('[Browser] Could not cancel a hidden menu preview cleanly:', error);
        });
      }
    }
    // A background operation can select a different tab or detach the mounted
    // view while Kai is hidden/minimized. Native child views paint above React,
    // so restore the current mounted tab synchronously before the window can
    // expose a stale (and still clickable) page surface.
    if (shown && (!wasShown || (!wasInteractive && interactive)) && this.mountedConversationId && this.mountedBounds) {
      this.attachActiveView(this.mountedConversationId);
    }
    const conversations = new Set(this.panelStateWaiters.keys());
    if (this.mountedConversationId) conversations.add(this.mountedConversationId);
    for (const conversationId of conversations) this.notifyPanelStateChanged(conversationId);
  }

  handleChromeShortcut(event: Electron.Event, input: Electron.Input): boolean {
    const conversationId = this.chromeFocusConversationId;
    if (!conversationId || this.disposed || this.shuttingDown) return false;
    const shortcut = resolveBrowserShortcut(input);
    // Escape belongs to the focused React control first (dismiss a menu/find
    // bar, revert an omnibox edit). Native page focus handles stop separately.
    if (!shortcut || shortcut.action === 'stop') return false;
    const activeId = this.activeTabs.get(conversationId) ?? null;
    const canRunWithoutActiveTab =
      shortcut.action === 'new-tab' ||
      shortcut.action === 'reopen-tab' ||
      shortcut.action === 'focus-url' ||
      shortcut.action === 'find' ||
      shortcut.action === 'tab-number' ||
      shortcut.action === 'tab-last';
    if (!activeId && !canRunWithoutActiveTab) return false;
    event.preventDefault();
    void this.applyShortcut(conversationId, activeId ?? '', shortcut.action, shortcut.index).catch((error) => {
      const tab = activeId ? this.tabs.get(activeId) : undefined;
      if (!tab || tab.shell.conversationId !== conversationId) {
        console.warn('[Browser] Browser-chrome shortcut failed:', error);
        return;
      }
      tab.shell.error = error instanceof Error ? error.message : String(error);
      this.emitTabs(conversationId);
    });
    return true;
  }

  /** Claim managed Browser contents synchronously, then serialize the native
   * edit behind the tab's other privileged operations. The document lease is
   * captured before queueing so navigation cannot retarget a delayed command;
   * the full DOM + CDP scan also covers populated password fields in closed
   * author shadow roots. */
  dispatchClipboardCommand(contents: WebContents, command: BrowserAwareEditCommand): boolean {
    return this.dispatchGuardedClipboardOperation(contents, () => contents[command](), undefined, true);
  }

  private dispatchGuardedClipboardOperation(
    contents: WebContents,
    operation: () => void,
    existingPageLease?: BrowserPageLease,
    requireFocusLease = false,
  ): boolean {
    const tabId = this.webContentsToTab.get(contents.id);
    if (!tabId) return false;
    const tab = this.tabs.get(tabId);
    // A stale managed-content mapping is security-sensitive state. Fail closed
    // until teardown removes it instead of treating the page as ordinary UI.
    if (!tab || tab.view?.webContents !== contents || contents.isDestroyed()) return true;
    const pageLease = existingPageLease ?? this.captureBrowserPageLease(tab, contents);
    // Start capturing before the tab queue or sensitivity scan can yield. The
    // frame identity is synchronous; the page promise is immediately rejection-
    // handled so a long queue cannot create an unhandled rejection.
    const focusLease = requireFocusLease ? this.captureClipboardFocusLease(contents) : null;
    void this.runTabOperation(tab, async () => {
      this.assertBrowserPageLease(tab, pageLease);
      const initialFingerprint = focusLease ? await focusLease.fingerprint : null;
      if (
        requireFocusLease &&
        (!focusLease || !initialFingerprint || !this.clipboardFocusFrameMatches(contents, focusLease.frame))
      ) {
        throw new Error('Clipboard access was cancelled because the focused field or selection changed.');
      }
      await this.assertTabNotSensitive(tab, contents, 'Clipboard access');
      this.assertBrowserPageLease(tab, pageLease);
      if (focusLease && initialFingerprint) {
        const currentFingerprint = await focusLease.frame
          .executeJavaScript(browserClipboardFocusFingerprintScript(focusLease.stateKey, focusLease.token, true))
          .then(
            (value) =>
              typeof value === 'string' && value.length <= MAX_CLIPBOARD_FOCUS_FINGERPRINT_CHARS ? value : null,
            () => null,
          );
        if (currentFingerprint !== initialFingerprint || !this.clipboardFocusFrameMatches(contents, focusLease.frame)) {
          throw new Error('Clipboard access was cancelled because the focused field or selection changed.');
        }
      }
      operation();
    }).catch((error) => {
      if (this.tabs.get(tab.shell.id) !== tab) return;
      tab.shell.error = error instanceof Error ? error.message : String(error);
      this.emitTabs(tab.shell.conversationId);
    });
    return true;
  }

  private captureClipboardFocusLease(contents: WebContents): BrowserClipboardFocusLease | null {
    let frame: WebFrameMain | null;
    try {
      frame = contents.focusedFrame;
      if (!frame || frame.detached || frame.isDestroyed()) return null;
    } catch {
      return null;
    }
    const stateKey = `__kai_clipboard_focus_${randomUUID().replaceAll('-', '')}`;
    const token = randomUUID();
    const fingerprint = frame.executeJavaScript(browserClipboardFocusFingerprintScript(stateKey, token, false)).then(
      (value) => (typeof value === 'string' && value.length <= MAX_CLIPBOARD_FOCUS_FINGERPRINT_CHARS ? value : null),
      () => null,
    );
    return { frame, stateKey, token, fingerprint };
  }

  private clipboardFocusFrameMatches(contents: WebContents, expected: WebFrameMain): boolean {
    try {
      const current = contents.focusedFrame;
      return (
        !!current &&
        !current.detached &&
        !current.isDestroyed() &&
        !expected.detached &&
        !expected.isDestroyed() &&
        (current === expected ||
          (current.processId === expected.processId &&
            current.routingId === expected.routingId &&
            current.frameToken === expected.frameToken))
      );
    } catch {
      return false;
    }
  }

  /** Application-menu accelerators are resolved before renderer key handlers.
   * Route them to the active Browser tab when either its native page or the
   * React Browser chrome owns focus, and decline them everywhere else so Kai's
   * ordinary renderer behavior remains unchanged. */
  dispatchApplicationMenuCommand(contents: WebContents, command: BrowserAwareApplicationMenuCommand): boolean {
    const mappedTabId = this.webContentsToTab.get(contents.id);
    let tab: InternalTab | undefined;
    let conversationId: string | null = null;

    if (mappedTabId) {
      tab = this.tabs.get(mappedTabId);
      // As with clipboard commands, an identity that was once claimed as a
      // managed page must never fall through to an unguarded native role.
      if (!tab || tab.view?.webContents !== contents || contents.isDestroyed()) return true;
      conversationId = tab.shell.conversationId;
    } else {
      const win = this.getWindow();
      conversationId = this.chromeFocusConversationId;
      if (
        !conversationId ||
        this.disposed ||
        this.shuttingDown ||
        !win ||
        win.isDestroyed() ||
        win.webContents !== contents
      ) {
        return false;
      }
      const activeId = this.activeTabs.get(conversationId);
      tab = activeId ? this.tabs.get(activeId) : undefined;
      if (tab && tab.shell.conversationId !== conversationId) tab = undefined;
    }

    const targetTab = tab;
    const targetConversationId = conversationId;
    void (async () => {
      if (command === 'toggle-devtools') {
        if (!targetTab || this.tabs.get(targetTab.shell.id) !== targetTab) return;
        const view = await this.ensureView(targetTab);
        if (this.tabs.get(targetTab.shell.id) !== targetTab || targetTab.view !== view) return;
        targetTab.lastUsedAt = Date.now();
        view.webContents.toggleDevTools();
        return;
      }
      const shortcutAction = command === 'hard-reload' ? 'hard-reload' : command;
      if (!targetTab) {
        if (shortcutAction === 'find')
          this.emit({ type: 'shortcut', conversationId: targetConversationId, action: 'find' });
        return;
      }
      await this.applyShortcut(targetConversationId, targetTab.shell.id, shortcutAction);
    })().catch((error) => {
      if (!targetTab || this.tabs.get(targetTab.shell.id) !== targetTab) {
        console.warn('[Browser] Application-menu command failed:', error);
        return;
      }
      targetTab.shell.error = error instanceof Error ? error.message : String(error);
      this.emitTabs(targetTab.shell.conversationId);
    });
    return true;
  }

  /** Generation-bound proof that a stream was authorized by the current host
   * renderer. Renderer reload/crash teardown increments the generation before
   * destroying native views, invalidating delayed internal continuations. */
  getHostRendererAuthorityGeneration(): number {
    return this.hostRendererAuthorityGeneration;
  }

  isHostRendererAuthorityCurrent(generation: number): boolean {
    return (
      !this.disposed &&
      !this.shuttingDown &&
      this.hostRendererAuthorityAvailable &&
      generation === this.hostRendererAuthorityGeneration
    );
  }

  /** Permanently revoke every assistant capability minted under the current
   * Browser-enabled lifetime. Re-enabling keeps the user's tab shells/profile,
   * but a live text or Realtime run cannot regain authenticated Browser access
   * without a fresh admission against the new authority generation. */
  revokeAssistantAccess(): void {
    this.hostRendererAuthorityGeneration++;
    for (const controller of this.hostRendererOperationControllers) controller.abort();
    // DownloadItems outlive their initiating WebContents. Revoke temporary
    // assistant downloads directly instead of relying on their tabs still
    // being present in the live tab map below.
    const revokedDownloads = this.activeAssistantDownloads();
    void this.cancelActiveAssistantDownloads(revokedDownloads).catch((error: unknown) => {
      console.warn('[Browser] Assistant download cancellation did not reach a terminal state:', error);
      this.scheduleAssistantDownloadCleanupRetry(revokedDownloads);
    });
    void this.cancelAssistantContinuations().catch((error: unknown) => {
      console.warn('[Browser] Assistant continuation revocation will be retried:', error);
    });
    this.assistantRuns.clear();
    this.assistantTargetTabs?.clear();
    for (const token of [...this.automationGestureTokens.keys()]) this.revokeAutomationGestureToken(token);

    const focusedConversationId = this.chromeFocusConversationId;
    this.chromeFocusConversationId = null;
    if (focusedConversationId) {
      this.invalidatePhysicalAssistantActions(this.tabs.get(this.activeTabs.get(focusedConversationId) ?? ''));
      this.notifyPanelStateChanged(focusedConversationId);
    }

    const changedConversations = new Set<string>();
    for (const tab of [...this.tabs.values()]) {
      changedConversations.add(tab.shell.conversationId);
      this.invalidatePhysicalAssistantActions(tab);
      this.invalidateVisibleAssistantOperations(tab);
      if (tab.shell.owner === 'assistant' && !tab.shell.keepOpen) {
        this.closeTab(tab, false);
        continue;
      }
      void this.releaseAssistantRunDialogGuard(tab).catch(() => undefined);
      // A retained user/kept tab can still have an in-flight navigation,
      // evaluation, or page-scheduled work from the revoked assistant. Closing
      // its renderer is the only reliable cancellation primitive Electron
      // provides; preserve the shell/profile so the user can reload it later.
      if (tab.aiNetworkRestricted) {
        this.destroyView(tab);
        tab.shell.discarded = true;
        tab.shell.sensitive = false;
      }
      if (tab.popupGesture?.source === 'assistant') tab.popupGesture = null;
      tab.assistantGesture = null;
      tab.assistantDownloadAttribution = undefined;
      tab.aiControlOwnerId = null;
      tab.aiControlGeneration = null;
      tab.aiActionDepth = 0;
      tab.aiActionUntil = 0;
      tab.assistantScriptDepth = 0;
    }
    for (const conversationId of changedConversations) this.emitTabs(conversationId);
  }

  runHostRendererOperation<T>(generation: number, operation: () => T | Promise<T>): Promise<T> {
    if (!this.isHostRendererAuthorityCurrent(generation)) {
      return Promise.reject(new Error("The in-app browser's renderer authority has expired."));
    }
    const controller = new AbortController();
    this.hostRendererOperationControllers.add(controller);
    return this.hostRendererOperationContext
      .run({ generation, abortSignal: controller.signal }, async () => {
        this.assertHostRendererOperationCurrent();
        const result = await operation();
        this.assertHostRendererOperationCurrent();
        return result;
      })
      .finally(() => this.hostRendererOperationControllers.delete(controller));
  }

  private assertHostRendererOperationCurrent(): void {
    const lease = this.hostRendererOperationContext?.getStore();
    if (!lease) return;
    if (lease.abortSignal.aborted || !this.isHostRendererAuthorityCurrent(lease.generation)) {
      throw new Error('The Kai renderer changed while this browser operation was waiting.');
    }
  }

  /** The preload sends this only after the replacement realm has installed its
   * context bridge. Until then the persistent WebContents identity is not proof
   * that any Browser IPC originated from the new renderer realm. */
  handleHostRendererReady(): void {
    if (this.disposed || this.shuttingDown) return;
    this.hostRendererAuthorityAvailable = true;
  }

  private async applyBrowserConfig(
    config: AppConfig['browser'],
    requestGeneration: number,
    preemption: BrowserConfigPreemption | null,
  ): Promise<BrowserConfigTransitionResult> {
    if (this.disposed) return { committed: false };
    const scopeChanged = config.dataScope !== this.dataScope;
    const wasEnabled = this.browserEnabled;
    const nextReadAccess = config.readAccess ?? this.readAccessPolicy;
    const nextStructuredActions = config.structuredActions ?? this.structuredActionsPolicy;
    const nextScriptInjection = config.scriptInjection ?? this.scriptInjectionPolicy;
    const nextPasswordAccess = config.passwordAccess ?? this.passwordAccessPolicy;
    // A newer request can observe state already committed by a superseded
    // transition even though both requests targeted the same scope. Preserve
    // the enqueue-time lifecycle intent so the latest request still drains,
    // remaps, emits, and remounts what its preemption tore down.
    const scopeChangeRequested = scopeChanged || preemption?.scopeChanged === true;
    const disablingRequested = (!config.enabled && wasEnabled) || preemption?.disabling === true;
    const privateNetworkTighteningRequested =
      preemption?.privateNetworkTightened === true ||
      (this.aiAllowPrivateNetwork && config.aiAllowPrivateNetwork === false);
    const changedConversations = new Set<string>();
    const affectedTabs = [...this.tabs.values()];
    const oldScopeKeys = new Set([
      ...affectedTabs.map((tab) => tab.scopeKey),
      ...this.scopeActivityCounts.keys(),
      ...[...this.activeDownloads.values()].map((download) => download.scopeKey),
      ...this.wiredSessionsByScope.keys(),
    ]);
    if (scopeChangeRequested || disablingRequested || privateNetworkTighteningRequested || preemption) {
      const scopesToQuiesce = new Set([...oldScopeKeys].filter((scopeKey) => !preemption?.scopeKeys.has(scopeKey)));
      const sessions = new Map<string, Session>();
      const serviceWorkerStops: Promise<void>[] = [];
      for (const scopeKey of scopesToQuiesce) {
        this.suspendedScopes.add(scopeKey);
        this.bumpScopeGeneration(scopeKey);
        const scopedSession =
          this.wiredSessionsByScope.get(scopeKey) ?? session.fromPartition(browserPartitionForScopeKey(scopeKey));
        sessions.set(scopeKey, scopedSession);
        // applyBrowserConfig destroys every affected view before awaiting this
        // promise. Keep CDP lifetime independent from those renderers.
        serviceWorkerStops.push(this.stopRunningServiceWorkers(scopedSession, undefined, true));
      }
      const downloadDrain = this.cancelActiveDownloadsForScopes(scopesToQuiesce);
      void downloadDrain.catch(() => undefined);
      for (const tab of affectedTabs) {
        this.destroyView(tab);
        tab.shell.discarded = true;
        tab.shell.sensitive = false;
        changedConversations.add(tab.shell.conversationId);
      }
      const networkQuiescence = await Promise.allSettled([
        ...(preemption ? [preemption.connectionDrain] : []),
        ...serviceWorkerStops,
        ...[...sessions.values()].map((scopedSession) => scopedSession.closeAllConnections()),
      ]);
      const networkFailures = networkQuiescence
        .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        .map((result) => result.reason);
      if (networkFailures.length > 0) {
        // Do not publish stricter policy/scope settings or release request
        // guards unless Chromium's old profile has actually gone quiet.
        throw new AggregateError(networkFailures, 'Browser network quiescence failed during a config transition.');
      }
      for (const scopeKey of oldScopeKeys) this.finishAllScopeRequestActivities(scopeKey);
      await Promise.all(affectedTabs.map((tab) => tab.queue.whenIdle()));
      await Promise.all([
        downloadDrain,
        preemption?.downloadDrain,
        preemption?.menuPreviewDrain,
        this.drainMenuPreviewCapture(
          oldScopeKeys,
          new Error('Browser menu preview was cancelled because Browser settings changed.'),
        ),
      ]);
      await Promise.all([...oldScopeKeys].map((scopeKey) => this.waitForScopeIdle(scopeKey)));
    }

    // A newer Settings write may have arrived while this request waited in the
    // profile queue or drained Chromium. The superseded request still had to
    // finish any fail-closed preemption it started, but it must not publish its
    // stale scope, enabled state, or looser network/control policies. The latest
    // queued request owns the commit and will release/remount the selected
    // profile after every older barrier has completed.
    const isLatestRequest = requestGeneration === this.browserConfigGeneration;
    if (!isLatestRequest) return { committed: false };

    const privateNetworkLoosened = this.aiAllowPrivateNetwork === false && config.aiAllowPrivateNetwork === true;
    if (privateNetworkLoosened) {
      // The document-start WebRTC membrane is intentionally irreversible. A
      // native policy change alone cannot make an already-guarded renderer
      // honor the newly relaxed setting, so replace guarded targets at their
      // per-tab queue boundary before publishing the relaxed policy. Operations
      // admitted while this transition is pending continue to observe the last
      // committed, stricter setting; a failed or superseded transition can
      // therefore never expose private-network access early.
      const guardedTabs = [...this.tabs.values()].filter(
        (tab) => !!tab.privateNetworkNewDocumentGuard && !!tab.view && !tab.view.webContents.isDestroyed(),
      );
      await Promise.all(
        guardedTabs.map((tab) =>
          tab.queue.run(async () => {
            if (
              this.tabs.get(tab.shell.id) !== tab ||
              !tab.privateNetworkNewDocumentGuard ||
              !tab.view ||
              tab.view.webContents.isDestroyed()
            )
              return;
            tab.generation++;
            this.destroyView(tab);
            tab.shell.discarded = true;
            tab.shell.sensitive = false;
            changedConversations.add(tab.shell.conversationId);
          }),
        ),
      );
      await this.drainMenuPreviewCapture(
        new Set(guardedTabs.map((tab) => tab.scopeKey)),
        new Error('Browser menu preview was cancelled because Browser settings changed.'),
      );
      // A stricter Settings write can preempt while we wait for a live tab's
      // operation queue. Its preemption has already restored the deny policy;
      // the stale allow transition must not publish its old value or release
      // any profile gates after that point.
      if (requestGeneration !== this.browserConfigGeneration) return { committed: false };
    }

    if (scopeChangeRequested) {
      // A tab URL is profile data too: reloading an old shell in the newly
      // selected partition would copy secret-bearing paths, queries, or
      // fragments across the user's data-scope boundary. Preserve the tab
      // strip itself, but start each migrated shell from a clean new tab and
      // discard closed-tab entries belonging to any other profile.
      for (const [conversationId, closed] of this.closedTabs) {
        const nextScopeKey = browserScopeKey(config.dataScope, conversationId);
        const retained = closed.filter((entry) => entry.scopeKey === nextScopeKey);
        if (retained.length === closed.length) continue;
        changedConversations.add(conversationId);
        if (retained.length > 0) this.closedTabs.set(conversationId, retained);
        else this.closedTabs.delete(conversationId);
      }
      for (const tab of this.tabs.values()) {
        const hadFavicon = tab.shell.favicon !== undefined;
        this.dropPendingForTab(tab.shell.id);
        tab.generation++;
        tab.shell.title = 'New Tab';
        tab.shell.url = 'about:blank';
        tab.shell.favicon = undefined;
        tab.shell.loading = false;
        tab.shell.audible = false;
        tab.shell.discarded = true;
        tab.shell.canGoBack = false;
        tab.shell.canGoForward = false;
        tab.shell.security = securityForUrl('about:blank');
        tab.shell.sensitive = false;
        tab.scriptTainted = false;
        tab.shell.reloadRequired = false;
        tab.shell.error = undefined;
        tab.shell.updatedAt = now();
        tab.trustedUserNavigation = false;
        tab.trustedUserNavigationTarget = null;
        tab.trustedUserNavigationRequestId = null;
        tab.lastUsedAt = Date.now();
        if (hadFavicon) this.emitTabFavicon(tab);
      }
    }

    this.dataScope = config.dataScope;
    this.browserEnabled = config.enabled;
    this.readAccessPolicy = nextReadAccess;
    this.structuredActionsPolicy = nextStructuredActions;
    this.scriptInjectionPolicy = nextScriptInjection;
    this.passwordAccessPolicy = nextPasswordAccess;
    this.aiAllowPrivateNetwork = config.aiAllowPrivateNetwork ?? this.aiAllowPrivateNetwork;
    for (const tab of this.tabs.values()) {
      if (tab.view && !tab.view.webContents.isDestroyed()) {
        configureBrowserWebContents(
          tab.view.webContents,
          this.aiAllowPrivateNetwork || !tab.aiNetworkRestricted || tab.trustedUserNavigation,
        );
      }
    }
    if (config.enabled) {
      for (const scopeKey of this.suspendedScopes) {
        const belongsToSelectedScope =
          config.dataScope === 'global' ? scopeKey === 'global' : scopeKey.startsWith('conversation-');
        if (belongsToSelectedScope) this.suspendedScopes.delete(scopeKey);
      }
    }
    for (const tab of this.tabs.values()) {
      if (scopeChangeRequested) {
        tab.scopeKey = browserScopeKey(config.dataScope, tab.shell.conversationId);
        tab.partition = browserPartition(config.dataScope, tab.shell.conversationId);
        tab.shell.zoomLevel = this.storeForScope(tab.scopeKey).getZoomLevel();
      }
    }
    for (const conversationId of changedConversations) {
      this.emitTabs(conversationId);
      if (scopeChangeRequested) this.emitBookmarks(conversationId);
    }
    if (!config.enabled) {
      this.detachAttachedView();
      if (scopeChangeRequested) this.emit({ type: 'profile-scope-changed', dataScope: config.dataScope });
      return { committed: true };
    }
    const mountedActiveId = this.mountedConversationId ? this.activeTabs.get(this.mountedConversationId) : undefined;
    const mountedActiveTab = mountedActiveId ? this.tabs.get(mountedActiveId) : undefined;
    const mountedViewMissing =
      !!mountedActiveTab && (!mountedActiveTab.view || mountedActiveTab.view.webContents.isDestroyed());
    if (!scopeChangeRequested && wasEnabled && !preemption && !mountedViewMissing) return { committed: true };
    if (this.mountedConversationId) {
      const tab = mountedActiveTab;
      if (tab) {
        void this.ensureView(tab)
          .then(() => this.attachActiveView(tab.shell.conversationId))
          .catch((error) => {
            if (this.tabs.get(tab.shell.id) !== tab) return;
            tab.shell.error ??= error instanceof Error ? error.message : String(error);
            tab.shell.discarded = !tab.view || tab.view.webContents.isDestroyed();
            this.emitTabs(tab.shell.conversationId);
          });
      }
    }
    if (scopeChangeRequested) this.emit({ type: 'profile-scope-changed', dataScope: config.dataScope });
    return { committed: true };
  }

  private config(): AppConfig['browser'] {
    return this.getConfig().browser;
  }

  private isConversationAvailable(conversationId: string): boolean {
    if (this.removedConversations.has(conversationId)) return false;
    try {
      return this.conversationExists(conversationId);
    } catch {
      // Conversation-store read failures are an ownership ambiguity. Do not
      // create an ownerless authenticated Browser profile until the record can
      // be proven to exist again.
      return false;
    }
  }

  /** True ONLY when the conversation is DEFINITIVELY absent (deleted) — NOT on a transient read
   *  failure (R178/R179). Callers that would permanently FENCE a conversation must use this instead
   *  of `!isConversationAvailable`, or a transient EMFILE/EACCES would fence a still-live conversation
   *  until restart. `conversationExists` returns false only on 'absent' and THROWS on 'unknown'. */
  private isConversationDefinitivelyAbsent(conversationId: string): boolean {
    try {
      return !this.conversationExists(conversationId);
    } catch {
      return false; // transient/unknown → NOT definitively absent; don't fence
    }
  }

  private assertConversationAvailable(conversationId: string): void {
    if (this.removedConversations.has(conversationId)) {
      throw new Error('Browser data is unavailable because this conversation was deleted or no longer exists.');
    }
    let exists: boolean;
    try {
      exists = this.conversationExists(conversationId);
    } catch {
      // TRANSIENT read failure (EMFILE/EACCES / existence unknown): deny access THIS time but do NOT
      // fence — fencing permanently blocks a still-live conversation's Browser access until restart
      // (R178). A later successful check re-enables it.
      throw new Error('Browser data is temporarily unavailable (conversation record could not be read).');
    }
    if (exists) return;
    // Definitively absent → the conversation was deleted; fence it permanently.
    this.fenceRemovedConversation(conversationId);
    throw new Error('Browser data is unavailable because this conversation was deleted or no longer exists.');
  }

  private refreshPendingCleanupQuarantine(scopeOnReadFailure?: string): void {
    if (typeof this.appHome !== 'string') return;
    try {
      const pendingScopeKeys = listPendingBrowserCleanupScopeKeys(this.appHome);
      this.pendingCleanupQuarantineUnreadable = false;
      for (const pendingScopeKey of pendingScopeKeys) {
        this.restrictedBackgroundScopes.add(pendingScopeKey);
        this.clearQuarantinedScopes.add(pendingScopeKey);
      }
    } catch (error) {
      // The unreadable marker may contain any profile key, so metadata and
      // credential APIs must fail closed before a Session/view is ever wired.
      this.pendingCleanupQuarantineUnreadable = true;
      if (scopeOnReadFailure) this.restrictedBackgroundScopes.add(scopeOnReadFailure);
      console.warn('[Browser] Could not read pending profile cleanup state; restricting background network:', error);
    }
  }

  private scopeKey(conversationId: string): string {
    this.assertConversationAvailable(conversationId);
    return browserScopeKey(this.dataScope ?? this.config().dataScope, conversationId);
  }

  private storeForScope(scopeKey: string, startupRecovery = false): BrowserProfileStore {
    let store = this.stores.get(scopeKey);
    if (!store) {
      store = new BrowserProfileStore(this.appHome, scopeKey, undefined, (area, error) => {
        this.emitProfileErrorForScope(scopeKey, area, error);
      });
      this.stores.set(scopeKey, store);
      if (startupRecovery) (this.startupOnlyStores ??= new Map()).set(scopeKey, store);
    }
    if (!startupRecovery) this.startupOnlyStores?.delete(scopeKey);
    return store;
  }

  private releaseStartupOnlyStore(scopeKey: string, store: BrowserProfileStore): void {
    if (this.startupOnlyStores?.get(scopeKey) !== store || this.stores.get(scopeKey) !== store) return;
    this.startupOnlyStores.delete(scopeKey);
    this.stores.delete(scopeKey);
  }

  private store(conversationId: string): BrowserProfileStore {
    const scopeKey = this.scopeKey(conversationId);
    this.assertScopeAvailable(scopeKey);
    return this.storeForScope(scopeKey);
  }

  private vaultForScope(scopeKey: string): BrowserCredentialVault {
    let vault = this.vaults.get(scopeKey);
    if (!vault) {
      vault = new BrowserCredentialVault(scopeKey, this.appHome);
      this.vaults.set(scopeKey, vault);
    }
    return vault;
  }

  private vault(conversationId: string): BrowserCredentialVault {
    const scopeKey = this.scopeKey(conversationId);
    this.assertScopeAvailable(scopeKey);
    return this.vaultForScope(scopeKey);
  }

  private requireLiveWindow(): BrowserWindow {
    const win = this.getWindow();
    if (!win || win === this.closingHostWindow || win.isDestroyed() || win.webContents.isDestroyed()) {
      throw new Error('The in-app browser requires a live primary window.');
    }
    return win;
  }

  isEnabled(): boolean {
    return this.browserEnabled;
  }

  assertEnabled(): void {
    if (!this.isEnabled()) throw new Error('The in-app browser is disabled in Settings.');
  }

  private assertScopeAvailable(scopeKey: string): void {
    this.assertEnabled();
    if (this.disposed || this.shuttingDown) {
      throw new Error('The in-app browser is shutting down.');
    }
    if (this.clearingScopes.has(scopeKey)) {
      throw new Error('Browser data for this profile is currently being cleared.');
    }
    if (this.pendingCleanupQuarantineUnreadable || this.clearQuarantinedScopes?.has(scopeKey)) {
      throw new Error('Browser data for this profile is quarantined until its pending clear succeeds.');
    }
    if (this.suspendedScopes?.has(scopeKey)) {
      throw new Error('Browser data for this profile is currently unavailable.');
    }
  }

  private scopeUnavailable(scopeKey: string): boolean {
    return (
      !this.isEnabled() ||
      this.clearingScopes.has(scopeKey) ||
      this.pendingCleanupQuarantineUnreadable === true ||
      this.clearQuarantinedScopes?.has(scopeKey) === true ||
      this.suspendedScopes?.has(scopeKey) === true
    );
  }

  /** Scope generations are globally monotonic for this manager lifetime. A
   * released scope may drop its map entry, but recreating it must never return
   * to generation zero and make a delayed pre-clear callback look current. */
  private currentScopeGeneration(scopeKey: string): number {
    const current = this.scopeGenerations.get(scopeKey);
    if (current !== undefined) {
      this.scopeGenerationSerial = Math.max(this.scopeGenerationSerial, current);
      return current;
    }
    const generation = ++this.scopeGenerationSerial;
    this.scopeGenerations.set(scopeKey, generation);
    return generation;
  }

  private bumpScopeGeneration(scopeKey: string): number {
    const current = this.scopeGenerations.get(scopeKey) ?? 0;
    this.scopeGenerationSerial = Math.max(this.scopeGenerationSerial, current) + 1;
    this.scopeGenerations.set(scopeKey, this.scopeGenerationSerial);
    return this.scopeGenerationSerial;
  }

  private beginScopeActivity(scopeKey: string): () => void {
    this.assertScopeAvailable(scopeKey);
    // Any new profile operation cancels a pending last-tab release. The
    // releaser rechecks this token after each Chromium shutdown boundary.
    this.scopeRuntimeReleaseTokens.delete(scopeKey);
    this.scopeActivityCounts.set(scopeKey, (this.scopeActivityCounts.get(scopeKey) ?? 0) + 1);
    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      const remaining = (this.scopeActivityCounts.get(scopeKey) ?? 1) - 1;
      if (remaining > 0) {
        this.scopeActivityCounts.set(scopeKey, remaining);
        return;
      }
      this.scopeActivityCounts.delete(scopeKey);
      const waiters = this.scopeIdleWaiters.get(scopeKey);
      this.scopeIdleWaiters.delete(scopeKey);
      for (const resolve of waiters ?? []) resolve();
    };
  }

  private async withScopeActivity<T>(scopeKey: string, operation: () => Promise<T>): Promise<T> {
    this.assertHostRendererOperationCurrent();
    const finish = this.beginScopeActivity(scopeKey);
    try {
      const result = await operation();
      this.assertHostRendererOperationCurrent();
      return result;
    } finally {
      finish();
    }
  }

  private waitForScopeIdle(scopeKey: string): Promise<void> {
    if (!this.scopeActivityCounts.has(scopeKey)) return Promise.resolve();
    return new Promise((resolve) => {
      const waiters = this.scopeIdleWaiters.get(scopeKey) ?? new Set<() => void>();
      waiters.add(resolve);
      this.scopeIdleWaiters.set(scopeKey, waiters);
    });
  }

  private finishScopeRequestActivity(scopeKey: string, requestId: number): void {
    this.validatingProxy?.releaseRequest(scopeKey, requestId);
    const requests = this.scopeRequestActivities.get(scopeKey);
    const finish = requests?.get(requestId);
    if (!finish) return;
    requests!.delete(requestId);
    if (requests!.size === 0) this.scopeRequestActivities.delete(scopeKey);
    finish();
  }

  private finishAllScopeRequestActivities(scopeKey: string): void {
    this.validatingProxy?.releaseScope(scopeKey);
    const requests = this.scopeRequestActivities.get(scopeKey);
    if (!requests) return;
    this.scopeRequestActivities.delete(scopeKey);
    for (const finish of requests.values()) finish();
  }

  private runTabOperation<T>(tab: InternalTab, operation: () => Promise<T>): Promise<T> {
    if (this.pendingAssistantTabClosures?.has(tab.shell.id)) {
      return Promise.reject(new Error('This browser tab is being closed by another assistant operation.'));
    }
    return tab.queue.run(() => {
      // A close transaction can begin after this operation was admitted but
      // before its queue turn starts. Reject that not-yet-running work so the
      // transaction drains only operations that were already executing.
      if (this.pendingAssistantTabClosures?.has(tab.shell.id)) {
        throw new Error('This browser tab is being closed by another assistant operation.');
      }
      return this.withScopeActivity(tab.scopeKey, async () => {
        return operation();
      });
    });
  }

  /** Bound how long caller-facing work can wait to enter a busy tab queue.
   * Once the admission deadline wins, the queued wrapper remains as a cheap
   * ordering tombstone and must never start the renderer operation later. */
  private runTabOperationBeforeDeadline<T>(
    tab: InternalTab,
    deadlineAt: number,
    onDeadline: () => T | Promise<T>,
    operation: () => Promise<T>,
  ): Promise<T> {
    let deadlineReached = Date.now() >= deadlineAt;
    let queueTurnStarted = false;
    let deadlineResult: Promise<T> | undefined;
    const resolveDeadline = (): Promise<T> => (deadlineResult ??= Promise.resolve().then(() => onDeadline()));
    if (deadlineReached) return resolveDeadline();
    if (this.pendingAssistantTabClosures?.has(tab.shell.id)) {
      return Promise.reject(new Error('This browser tab is being closed by another assistant operation.'));
    }

    const queued = tab.queue.run(() => {
      queueTurnStarted = true;
      if (this.pendingAssistantTabClosures?.has(tab.shell.id)) {
        throw new Error('This browser tab is being closed by another assistant operation.');
      }
      if (deadlineReached || Date.now() >= deadlineAt) {
        deadlineReached = true;
        return resolveDeadline();
      }
      return this.withScopeActivity(tab.scopeKey, operation);
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const admissionDeadline = new Promise<T>((resolve, reject) => {
      timer = setTimeout(
        () => {
          // Once admitted, the operation's own remaining-budget checks own the
          // deadline. This timer exists only to bound a blocked queue entrance.
          if (queueTurnStarted) return;
          deadlineReached = true;
          void resolveDeadline().then(resolve, reject);
        },
        Math.max(0, Math.ceil(deadlineAt - Date.now())),
      );
      timer.unref?.();
    });
    return Promise.race([queued, admissionDeadline]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  }

  private assistantDownloadOwner(tab: InternalTab): string | null {
    const activeOwner = (ownerId: string | null | undefined): string | null =>
      ownerId && this.assistantRuns.generationIfActive(tab.shell.conversationId, ownerId) !== null ? ownerId : null;
    const operation = tab.assistantDownloadAttribution;
    // cleanupAssistantTabs stops accepting new work before already-acquired
    // operations drain. Preserve exact download provenance across that drain;
    // cleanup clears both this attribution and aiControlOwnerId before the tab
    // returns to ordinary user ownership.
    const retainedOperationOwner =
      operation &&
      operation.trustedGestureGeneration === (tab.trustedGestureGeneration ?? 0) &&
      tab.aiControlOwnerId === operation.assistantOwnerId &&
      tab.aiControlGeneration !== null
        ? operation.assistantOwnerId
        : null;
    const retainedAssistantGesture =
      tab.assistantGesture?.expiresAt && tab.assistantGesture.expiresAt >= Date.now() ? tab.assistantGesture : null;
    const assistantGestureOwner = activeOwner(retainedAssistantGesture?.assistantOwnerId);
    // A later user gesture cannot safely prove that a delayed download belongs
    // to it while the same document still has a live assistant activation.
    // Quarantine ambiguous overlap under the assistant run rather than opening
    // a native save dialog or retaining an AI-selected file as user-owned.
    if (assistantGestureOwner) return assistantGestureOwner;
    const gesture = tab.popupGesture?.expiresAt && tab.popupGesture.expiresAt >= Date.now() ? tab.popupGesture : null;
    // Exact real-user input wins even if it occurs while an assistant operation
    // is active on the same authenticated page.
    if (gesture?.source === 'user') return null;
    if (gesture?.source === 'assistant') {
      return (
        activeOwner(gesture.assistantOwnerId) ??
        (gesture.assistantOwnerId === retainedOperationOwner ? retainedOperationOwner : null)
      );
    }
    if (retainedOperationOwner) return retainedOperationOwner;
    if (operation) {
      const owner = activeOwner(operation.assistantOwnerId);
      if (owner && operation.trustedGestureGeneration === (tab.trustedGestureGeneration ?? 0)) return owner;
    }
    // Automatic downloads from a temporary assistant-created tab remain owned
    // by that run. User tabs require one of the exact provenances above.
    if (tab.shell.owner !== 'assistant') return null;
    const currentOwner = activeOwner(tab.aiControlOwnerId);
    if (currentOwner) return currentOwner;
    return tab.assistantOwnerId &&
      this.assistantRuns.generationIfActive(tab.shell.conversationId, tab.assistantOwnerId) !== null
      ? tab.assistantOwnerId
      : null;
  }

  beginAssistantRun(conversationId: string, runId: string, modality: BrowserAssistantModality = 'text'): void {
    if (this.disposed) throw new Error('The in-app browser is unavailable.');
    this.assistantRuns.begin(conversationId, runId, modality);
  }

  /** Stop a completed run from accepting new browser work while retaining its
   * temporary tabs for a renderer-driven successor in the same logical turn. */
  prepareAssistantContinuation(
    conversationId: string,
    runId: string,
    timeoutMs = ASSISTANT_CONTINUATION_HANDOFF_TIMEOUT_MS,
  ): boolean {
    if (this.disposed || this.shuttingDown) return false;
    const key = assistantContinuationKey(conversationId, runId);
    if (this.pendingAssistantContinuations.has(key)) return true;
    if (this.assistantRuns.generationIfActive(conversationId, runId) === null) return false;

    const pending = {
      conversationId,
      runId,
      drain: this.assistantRuns.end(conversationId, runId),
      timer: null as unknown as ReturnType<typeof setTimeout>,
    } satisfies PendingAssistantContinuation;
    pending.timer = setTimeout(
      () => {
        void this.expireAssistantContinuation(key, pending).catch((error: unknown) => {
          console.warn('[Browser] Assistant continuation cleanup will be retried:', error);
        });
      },
      Math.max(0, timeoutMs),
    );
    pending.timer.unref?.();
    this.pendingAssistantContinuations.set(key, pending);
    this.assistantContinuationLeases.add(key);
    return true;
  }

  /** True while a completed native Browser run is retaining its temporary
   * state for an authorized desktop-renderer successor. Web clients can render
   * the conversation, but must not win this continuation and adopt tabs they
   * are intentionally unable to control. */
  hasPendingAssistantContinuation(conversationId: string, runId: string): boolean {
    if (this.disposed || this.shuttingDown) return false;
    return this.pendingAssistantContinuations.has(assistantContinuationKey(conversationId, runId));
  }

  hasPendingAssistantContinuationForConversation(conversationId: string): boolean {
    if (this.disposed || this.shuttingDown) return false;
    for (const pending of this.pendingAssistantContinuations.values()) {
      if (pending.conversationId === conversationId) return true;
    }
    return false;
  }

  /** Begin a successor run and atomically adopt temporary tabs retained for its
   * predecessor. A stale/missing predecessor simply starts a normal run. */
  async beginAssistantContinuation(conversationId: string, runId: string, predecessorRunId: string): Promise<void> {
    if (this.disposed) throw new Error('The in-app browser is unavailable.');
    // A predecessor whose terminal cleanup is retrying is no longer adoptable.
    // Wait for that stable cleanup barrier, then begin a fresh run below.
    await this.waitForAssistantTabCleanup(conversationId);
    if (this.disposed) throw new Error('The in-app browser is unavailable.');
    const key = assistantContinuationKey(conversationId, predecessorRunId);
    const pending = this.pendingAssistantContinuations.get(key);

    const unrelated = this.takeAssistantContinuations(conversationId, key);
    if (!pending) {
      this.assistantContinuationLeases.delete(key);
      await this.finishAssistantContinuations(unrelated, true);
      this.beginAssistantRun(conversationId, runId);
      return;
    }

    this.pendingAssistantContinuations.delete(key);
    clearTimeout(pending.timer);
    const predecessorTargetId = this.assistantTargetTabs?.get(key);
    try {
      const generation = this.assistantRuns.begin(conversationId, runId);
      await Promise.all([pending.drain, this.finishAssistantContinuations(unrelated, true)]);

      // The successor may have been cancelled while the predecessor's last
      // operation drained. In that case reclaim the old tabs instead of reviving
      // them under a dead capability.
      if (this.assistantRuns.generationIfActive(conversationId, runId) !== generation) {
        await this.cleanupAssistantStateOwnedByRun(conversationId, predecessorRunId);
        this.emitTabs(conversationId);
        return;
      }

      for (const [token, gesture] of this.automationGestureTokens) {
        if (gesture.assistantOwnerId === predecessorRunId) this.revokeAutomationGestureToken(token);
      }
      let changed = false;
      for (const id of this.tabOrder.get(conversationId) ?? []) {
        const tab = this.tabs.get(id);
        if (!tab) continue;
        if (tab.assistantOwnerId === predecessorRunId) {
          tab.assistantOwnerId = runId;
          changed = true;
        }
        if (tab.aiControlOwnerId === predecessorRunId) {
          tab.aiControlOwnerId = runId;
          tab.aiControlGeneration = generation;
          changed = true;
        }
        if (tab.popupGesture?.assistantOwnerId === predecessorRunId) {
          tab.popupGesture.assistantOwnerId = runId;
          changed = true;
        }
        if (tab.assistantGesture?.assistantOwnerId === predecessorRunId) {
          tab.assistantGesture.assistantOwnerId = runId;
          changed = true;
        }
        if (tab.assistantDownloadAttribution?.assistantOwnerId === predecessorRunId) {
          tab.assistantDownloadAttribution.assistantOwnerId = runId;
          changed = true;
        }
        if (tab.assistantDialogGuard?.runId === predecessorRunId) {
          // A streaming assistant popup can retain a dialog-protection owner
          // beyond the predecessor's final action. Move that live capability
          // with the tab so the successor does not dispose it as foreign and
          // leave the still-loading hidden page able to block on native UI.
          tab.assistantDialogGuard.runId = runId;
          changed = true;
        }
        if (tab.assistantDialogsDisabledRunId === predecessorRunId) {
          tab.assistantDialogsDisabledRunId = runId;
          changed = true;
        }
      }
      for (const download of this.activeDownloads.values()) {
        if (download.conversationId !== conversationId || download.assistantOwnerId !== predecessorRunId) continue;
        download.assistantOwnerId = runId;
      }
      const predecessorTarget = predecessorTargetId ? this.tabs.get(predecessorTargetId) : undefined;
      if (predecessorTarget?.shell.conversationId === conversationId) {
        this.rememberAssistantTarget(conversationId, runId, predecessorTarget);
      } else if (predecessorTargetId) {
        // Preserve a closed-target tombstone across an automatic continuation;
        // the successor must explicitly select or open a replacement tab.
        this.assistantTargetTabs.set(assistantContinuationKey(conversationId, runId), predecessorTargetId);
      }
      if (changed) this.emitTabs(conversationId);
    } catch (error) {
      // Admission can fail if Realtime acquired Browser ownership while this
      // continuation was waiting to launch. The predecessor was already taken
      // out of the pending map above, so reclaim both identities explicitly;
      // otherwise its temporary tabs lose their timeout owner and leak.
      await Promise.allSettled([
        pending.drain,
        this.assistantRuns.end(conversationId, runId),
        this.finishAssistantContinuations(unrelated, true),
      ]);
      const cleanupResults = await Promise.allSettled([
        this.cleanupAssistantTabs(conversationId, predecessorRunId),
        this.cleanupAssistantTabs(conversationId, runId),
      ]);
      this.emitTabs(conversationId);
      const cleanupFailure = cleanupResults.find(
        (result): result is PromiseRejectedResult => result.status === 'rejected',
      );
      if (cleanupFailure) throw cleanupFailure.reason;
      throw error;
    } finally {
      this.forgetAssistantTarget(conversationId, predecessorRunId);
      this.assistantContinuationLeases.delete(key);
    }
  }

  /** Reclaim any deferred logical-turn handoffs, for example when a fresh user
   * turn supersedes an automatic continuation before it launches. */
  async cancelAssistantContinuations(conversationId?: string): Promise<void> {
    await this.finishAssistantContinuations(this.takeAssistantContinuations(conversationId), true);
  }

  private takeAssistantContinuations(conversationId?: string, exceptKey?: string): PendingAssistantContinuation[] {
    const taken: PendingAssistantContinuation[] = [];
    for (const [key, pending] of this.pendingAssistantContinuations ?? []) {
      if ((conversationId && pending.conversationId !== conversationId) || key === exceptKey) continue;
      this.pendingAssistantContinuations.delete(key);
      clearTimeout(pending.timer);
      taken.push(pending);
    }
    return taken;
  }

  private async finishAssistantContinuations(
    pendingContinuations: PendingAssistantContinuation[],
    closeTabs: boolean,
  ): Promise<void> {
    if (pendingContinuations.length === 0) return;
    const conversations = new Set<string>();
    const results = await Promise.allSettled(
      pendingContinuations.map(async (pending) => {
        if (closeTabs && !this.disposed) {
          await this.cleanupAssistantTabs(pending.conversationId, pending.runId);
          conversations.add(pending.conversationId);
        } else await pending.drain;
        this.assistantContinuationLeases.delete(assistantContinuationKey(pending.conversationId, pending.runId));
      }),
    );
    for (const conversationId of conversations) this.emitTabs(conversationId);
    const failures: unknown[] = [];
    for (let index = 0; index < results.length; index += 1) {
      const result = results[index]!;
      if (result.status === 'fulfilled') continue;
      failures.push(result.reason);
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, 'One or more Browser continuation cleanups failed.');
    }
  }

  private async expireAssistantContinuation(key: string, pending: PendingAssistantContinuation): Promise<void> {
    if (this.pendingAssistantContinuations.get(key) !== pending) return;
    this.pendingAssistantContinuations.delete(key);
    clearTimeout(pending.timer);
    await this.finishAssistantContinuations([pending], true);
  }

  private async cleanupAssistantStateOwnedByRun(conversationId: string, runId: string): Promise<void> {
    this.forgetAssistantTarget(conversationId, runId);
    for (const [token, gesture] of this.automationGestureTokens) {
      if (gesture.assistantOwnerId === runId) this.revokeAutomationGestureToken(token);
    }
    let guardedActiveTabToRestore: string | null = null;
    const dialogRestoreFailures: unknown[] = [];
    for (const id of [...(this.tabOrder.get(conversationId) ?? [])]) {
      const tab = this.tabs.get(id);
      if (!tab) continue;
      if (shouldCleanupAssistantTab(tab.shell, tab.assistantOwnerId, runId)) {
        this.closeTab(tab, false);
        continue;
      }
      // A retained or user-taken-over popup may stream forever and never emit a
      // load completion event. The creating run boundary is therefore the hard
      // upper bound for its bootstrap rendering/dialog lease.
      if (
        tab.assistantOwnerId === runId ||
        (tab.assistantPopupBootstrapPending && tab.assistantDialogGuard?.runId === runId)
      ) {
        this.finishAssistantPopupBootstrap(tab, tab.view?.webContents);
        if (tab.assistantOwnerId === runId && tab.assistantPopupDialogsDisabled) {
          // disableDialogs is immutable for a WebContents. A kept popup crosses
          // the run boundary by preserving its shell/profile but recreating a
          // normal renderer when the user next opens it.
          tab.assistantPopupDialogsDisabled = false;
          if (tab.view && !tab.view.webContents.isDestroyed()) {
            tab.generation++;
            this.destroyView(tab);
            tab.shell.discarded = true;
            tab.shell.sensitive = false;
          }
        }
      }
      if (tab.popupGesture?.assistantOwnerId === runId) tab.popupGesture = null;
      if (tab.assistantGesture?.assistantOwnerId === runId) tab.assistantGesture = null;
      if (tab.aiControlOwnerId === runId && tab.assistantNativeUiNewDocumentGuard) {
        try {
          await this.releaseAssistantNativeUiGuard(tab);
        } catch (error) {
          // Keep the irreversible marker set so the guarded renderer is
          // reclaimed below. A failed restoration must never make a partially
          // protected page interactive.
          dialogRestoreFailures.push(error);
        }
      }
      // User-owned and explicitly kept-open tabs survive the run, but their
      // document may still contain AI-scheduled work. Revoke the expired run's
      // control capability while retaining the private-network restriction
      // until a verified user navigation replaces or reloads that document.
      const dialogsDisabledForRun = tab.assistantDialogsDisabledRunId === runId;
      if (tab.aiControlOwnerId === runId) {
        tab.aiControlOwnerId = null;
        tab.aiControlGeneration = null;
        if ((tab.scriptTainted || tab.assistantNativeUiNewDocumentGuard || dialogsDisabledForRun) && tab.view) {
          const guardedOnly = !tab.scriptTainted && !!(tab.assistantNativeUiNewDocumentGuard || dialogsDisabledForRun);
          // Arbitrary evaluation can leave timers, dedicated workers, event
          // listeners, and authenticated fetches alive in the page. A
          // Script-evaluated pages can retain arbitrary timers, workers, and
          // listeners and therefore still require an explicit user reload. A
          // private-network membrane alone remains attached to the live user
          // document until a trusted user navigation replaces it; it must not
          // force a reload merely because an assistant inspected or clicked the
          // existing authenticated SPA.
          tab.generation++;
          this.destroyView(tab);
          tab.shell.discarded = true;
          tab.shell.sensitive = false;
          if (guardedOnly && this.activeTabs.get(conversationId) === tab.shell.id) {
            guardedActiveTabToRestore = tab.shell.id;
          }
        }
      }
      if (dialogsDisabledForRun) {
        tab.assistantDialogsDisabledRunId = null;
        if (tab.view && !tab.view.webContents.isDestroyed()) {
          tab.generation++;
          this.destroyView(tab);
          tab.shell.discarded = true;
          tab.shell.sensitive = false;
          if (this.activeTabs.get(conversationId) === tab.shell.id) guardedActiveTabToRestore = tab.shell.id;
        }
      }
      if (tab.assistantDialogGuard?.runId === runId) {
        try {
          // Reclaim any AI-mutated/guarded renderer above before releasing the
          // final dialog lease. Otherwise a delayed callback could open an
          // alert in the gap between removing the listener and closing the
          // target at this same run boundary.
          await this.releaseAssistantRunDialogGuard(tab);
        } catch (error) {
          // Continue reclaiming download authority even if Chromium could not
          // acknowledge file-chooser restoration on a retained clean target.
          dialogRestoreFailures.push(error);
        }
      }
      if (tab.assistantDownloadAttribution?.assistantOwnerId === runId) {
        tab.assistantDownloadAttribution = undefined;
      }
    }
    // Chromium downloads can survive their initiating WebContents, including a
    // tab closed before turn cleanup begins. Cancel by captured run ownership,
    // not by rediscovering the download through the current tab list.
    await this.cancelActiveDownloadsForAssistantRun(conversationId, runId);
    if (guardedActiveTabToRestore) {
      this.restoreActiveViewAfterClose(conversationId, guardedActiveTabToRestore);
    }
    if (dialogRestoreFailures.length > 0) {
      throw new AggregateError(dialogRestoreFailures, 'Browser native-dialog protection could not be fully restored.');
    }
  }

  assertAssistantRun(conversationId: string, run: BrowserAssistantRun): void {
    throwIfBrowserAborted(run.abortSignal);
    this.assistantRuns.assertActive(conversationId, run.id);
  }

  /** Resolve an automation target without consulting Browser chrome state after
   * the run has selected a tab. This is intentionally public so tool approval
   * capture and execution bind to the same hidden tab identity. */
  resolveAssistantTabId(conversationId: string, tabId: string | undefined, run: BrowserAssistantRun): string {
    return this.requireAssistantTab(conversationId, run, tabId).shell.id;
  }

  /** Resolve the exact tab displayed by an ask-policy prompt without changing
   * the run's implicit target. Only execution after approval may commit it. */
  previewAssistantTabId(conversationId: string, tabId: string | undefined, run: BrowserAssistantRun): string {
    return this.requireAssistantTab(conversationId, run, tabId, false).shell.id;
  }

  private rememberAssistantTarget(conversationId: string, runId: string, tab: InternalTab): void {
    if (tab.shell.conversationId !== conversationId || this.tabs.get(tab.shell.id) !== tab) {
      throw new Error('Browser tab not found in this chat.');
    }
    (this.assistantTargetTabs ??= new Map()).set(assistantContinuationKey(conversationId, runId), tab.shell.id);
  }

  private forgetAssistantTarget(conversationId: string, runId: string): void {
    this.assistantTargetTabs?.delete(assistantContinuationKey(conversationId, runId));
  }

  private forgetAssistantTargetsForConversation(conversationId: string): void {
    const prefix = `${conversationId}\u0000`;
    for (const key of this.assistantTargetTabs?.keys() ?? []) {
      if (key.startsWith(prefix)) this.assistantTargetTabs.delete(key);
    }
  }

  private assertAssistantMayControlTab(tab: InternalTab, run: BrowserAssistantRun): void {
    const ownerRunActive = tab.assistantOwnerId
      ? this.assistantRuns.generationIfActive(tab.shell.conversationId, tab.assistantOwnerId) !== null
      : false;
    if (!assistantMayControlTab(tab.shell.owner, tab.assistantOwnerId, run.id, tab.shell.keepOpen, ownerRunActive)) {
      throw new Error('This temporary browser tab belongs to another active assistant run.');
    }
  }

  private requireAssistantTab(
    conversationId: string,
    run: BrowserAssistantRun,
    tabId?: string,
    rememberTarget = true,
  ): InternalTab {
    this.assertAssistantRun(conversationId, run);
    const key = assistantContinuationKey(conversationId, run.id);
    const rememberedId = this.assistantTargetTabs?.get(key);
    let tab: InternalTab | undefined;
    if (tabId) {
      tab = this.requireTab(conversationId, tabId);
    } else if (rememberedId) {
      tab = this.tabs.get(rememberedId);
      if (!tab || tab.shell.conversationId !== conversationId) {
        // Retain the closed id as a run-local tombstone. Falling through to a
        // different user tab would turn an omitted tabId into an unintended
        // click, evaluation, or navigation target.
        throw new Error(
          "This assistant run's current Browser tab has closed. Specify another tabId or open a new tab.",
        );
      }
    }

    // Prefer the newest tab owned/controlled by this run. A fresh run may use a
    // sole eligible tab, but presentation-active state is never an automation
    // selector; multiple existing tabs require an explicit id.
    if (!tab) {
      const order = this.tabOrder.get(conversationId) ?? [];
      tab = [...order]
        .reverse()
        .map((id) => this.tabs.get(id))
        .find(
          (candidate): candidate is InternalTab =>
            !!candidate && (candidate.assistantOwnerId === run.id || candidate.aiControlOwnerId === run.id),
        );
      if (!tab) {
        const eligible = order
          .map((id) => this.tabs.get(id))
          .filter((candidate): candidate is InternalTab => {
            if (!candidate || candidate.shell.conversationId !== conversationId) return false;
            const ownerRunActive = candidate.assistantOwnerId
              ? this.assistantRuns.generationIfActive(conversationId, candidate.assistantOwnerId) !== null
              : false;
            return assistantMayControlTab(
              candidate.shell.owner,
              candidate.assistantOwnerId,
              run.id,
              candidate.shell.keepOpen,
              ownerRunActive,
            );
          });
        if (eligible.length > 1) {
          throw new Error('Multiple Browser tabs are available. Specify the tabId to control.');
        }
        tab = eligible[0];
      }
    }
    if (!tab || tab.shell.conversationId !== conversationId) {
      throw new Error('Browser tab not found in this chat.');
    }
    this.assertAssistantMayControlTab(tab, run);
    if (rememberTarget) this.rememberAssistantTarget(conversationId, run.id, tab);
    return tab;
  }

  private assistantGeneration(conversationId: string, runId: string): number {
    return this.assistantRuns.assertActive(conversationId, runId);
  }

  private async withAssistantControl<T>(
    tab: InternalTab,
    run: BrowserAssistantRun,
    operation: (documentLease: AssistantDocumentLease) => Promise<T>,
    approvedDocument?: BrowserApprovalWithDocument,
  ): Promise<T> {
    throwIfBrowserAborted(run.abortSignal);
    this.assertAssistantMayControlTab(tab, run);
    // Consent must be checked before any renderer or dialog-protection state is
    // changed. If run admission itself races cleanup, discard the unused weak
    // reset lease immediately.
    const approvalResetLease = this.beginBrowserApprovalRendererReset(tab, run, approvedDocument);
    const previousAssistantDownloadAttribution = tab.assistantDownloadAttribution;
    const previousDialogsDisabledRunId = tab.assistantDialogsDisabledRunId;
    const previousRunDialogGuardLease = tab.assistantRunDialogGuardLease;
    let lease: ReturnType<BrowserAssistantRunRegistry['acquire']>;
    try {
      lease = this.assistantRuns.acquire(tab.shell.conversationId, run.id);
    } catch (error) {
      this.finishBrowserApprovalRendererReset(approvedDocument);
      throw error;
    }
    // Native-dialog suppression and download ownership last for the complete
    // assistant run, not merely for the Promise returned by one tool call.
    // Page handlers/evaluated code can schedule delayed work after that Promise
    // resolves; cleanup releases these capabilities only after the run drains.
    let dialogSuppressionIntroduced = false;
    let dialogSafeRendererReclaimed = false;
    let runDialogGuardIntroduced = false;
    let dialogLease: ReturnType<BrowserManager['acquireAssistantDialogGuard']> | undefined;
    try {
      this.ensureAssistantRunDialogGuard(tab, run.id);
      runDialogGuardIntroduced = tab.assistantRunDialogGuardLease !== previousRunDialogGuardLease;
      dialogSafeRendererReclaimed = this.prepareAssistantDialogSafeRenderer(tab, run.id) === true;
      dialogSuppressionIntroduced =
        previousDialogsDisabledRunId !== tab.assistantDialogsDisabledRunId &&
        tab.assistantDialogsDisabledRunId === run.id;
      this.prepareBrowserApprovalRendererReset(tab, approvedDocument, approvalResetLease, dialogSafeRendererReclaimed);
      tab.assistantDownloadAttribution = {
        assistantOwnerId: run.id,
        trustedGestureGeneration: tab.trustedGestureGeneration ?? 0,
      };
      dialogLease = this.acquireAssistantDialogGuard(tab, run.id);
    } catch (error) {
      const cleanupFailures: unknown[] = [];
      const attemptCleanup = async (operation: () => void | Promise<void>): Promise<void> => {
        try {
          await operation();
        } catch (cleanupError) {
          cleanupFailures.push(cleanupError);
        }
      };
      await attemptCleanup(() => this.finishBrowserApprovalRendererReset(approvedDocument));
      if (dialogLease) {
        await attemptCleanup(() => this.releaseAssistantDialogGuard(tab, dialogLease!.token));
      }
      if (runDialogGuardIntroduced) {
        await attemptCleanup(() => this.releaseAssistantRunDialogGuard(tab));
      }
      tab.assistantDownloadAttribution = previousAssistantDownloadAttribution;
      let rendererReclaimed = dialogSafeRendererReclaimed;
      if (dialogSuppressionIntroduced && this.tabs.get(tab.shell.id) === tab) {
        tab.assistantDialogsDisabledRunId = previousDialogsDisabledRunId;
        const currentView = tab.view;
        if (currentView && !currentView.webContents.isDestroyed()) {
          tab.generation++;
          this.destroyView(tab);
          tab.shell.discarded = true;
          tab.shell.loading = false;
          tab.shell.sensitive = false;
          this.emitTabs(tab.shell.conversationId);
          rendererReclaimed = true;
        }
      }
      if ((rendererReclaimed || dialogSuppressionIntroduced) && this.tabs.get(tab.shell.id) === tab) {
        // A setup failure must restore an already-presented user tab. Hidden
        // tabs remain discarded and are not mounted or focused by this helper.
        this.restoreActiveViewAfterClose(tab.shell.conversationId, tab.shell.id);
      }
      lease.release();
      if (cleanupFailures.length > 0) {
        throw new AggregateError(
          [error, ...cleanupFailures],
          `Browser assistant control setup failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      throw error;
    }
    let actionDepthIncremented = false;
    let nativeUiGuardAttemptedContents: WebContents | null = null;
    let assistantAuthorizationCompleted = false;
    try {
      tab.aiActionDepth++;
      actionDepthIncremented = true;
      this.enableAssistantBackgroundRendering(tab, tab.view?.webContents);
      if (tab.view && !tab.view.webContents.isDestroyed()) {
        // Assistant-created pages and subsequent operations in this run are
        // already synchronously dialog-disabled. Keep the CDP file-chooser and
        // native-UI membranes verified before authorization can continue.
        nativeUiGuardAttemptedContents = tab.view.webContents;
        const dialogProtection = this.protectAssistantDialogs(tab, tab.view.webContents, dialogLease!.guard);
        const nativeUiProtection = this.installAssistantNativeUiGuard(tab, tab.view.webContents, run.abortSignal);
        await Promise.all([dialogProtection, nativeUiProtection]);
      }
      const documentLease = await this.awaitAssistantDialogProtectedOperation(
        this.guardAssistantTab(tab, run, lease.generation),
        dialogLease!.guard,
      );
      assistantAuthorizationCompleted = true;
      if (tab.view && !tab.view.webContents.isDestroyed()) {
        await this.protectAssistantDialogs(tab, tab.view.webContents, dialogLease!.guard);
      }
      this.enableAssistantBackgroundRendering(tab, tab.view?.webContents);
      throwIfBrowserAborted(run.abortSignal);
      return await this.awaitAssistantDialogProtectedOperation(
        Promise.resolve().then(() => operation(documentLease)),
        dialogLease!.guard,
      );
    } catch (error) {
      // If authorization rejects after the native-UI trampoline activated,
      // restore it in the same document. A partial/fallback installation cannot
      // prove restoration and is reclaimed fail-closed; neither path mounts or
      // focuses the Browser panel.
      let failedAuthorizationRendererReclaimed = false;
      if (
        !assistantAuthorizationCompleted &&
        nativeUiGuardAttemptedContents &&
        this.tabs.get(tab.shell.id) === tab &&
        tab.view?.webContents === nativeUiGuardAttemptedContents &&
        !nativeUiGuardAttemptedContents.isDestroyed()
      ) {
        try {
          await this.releaseAssistantNativeUiGuard(tab);
        } catch {
          tab.generation++;
          this.destroyView(tab);
          tab.shell.discarded = true;
          tab.shell.loading = false;
          tab.shell.sensitive = false;
          this.emitTabs(tab.shell.conversationId);
          failedAuthorizationRendererReclaimed = true;
        }
      }
      if (!assistantAuthorizationCompleted && dialogSuppressionIntroduced && this.tabs.get(tab.shell.id) === tab) {
        // This invocation introduced immutable dialog suppression even when the
        // tab started discarded. Roll the marker back on failed authorization,
        // and reclaim any renderer concurrently restored under that flag. A
        // pre-existing successful guard from the same run is never cleared.
        tab.assistantDialogsDisabledRunId = null;
        const currentView = tab.view;
        if (currentView && !currentView.webContents.isDestroyed()) {
          tab.generation++;
          this.destroyView(tab);
          tab.shell.discarded = true;
          tab.shell.loading = false;
          tab.shell.sensitive = false;
          this.emitTabs(tab.shell.conversationId);
          failedAuthorizationRendererReclaimed = true;
        }
      }
      if (
        !assistantAuthorizationCompleted &&
        (dialogSafeRendererReclaimed || dialogSuppressionIntroduced || failedAuthorizationRendererReclaimed) &&
        this.tabs.get(tab.shell.id) === tab
      ) {
        // Restore an already-presented user tab with ordinary dialog behavior;
        // hidden/discarded tabs remain presentation-independent.
        this.restoreActiveViewAfterClose(tab.shell.conversationId, tab.shell.id);
      }
      throw error;
    } finally {
      try {
        if (actionDepthIncremented) {
          try {
            await this.restoreAssistantBackgroundViewport(tab);
          } finally {
            tab.aiActionDepth = Math.max(0, tab.aiActionDepth - 1);
            if (tab.aiActionDepth === 0) this.restoreAssistantBackgroundRendering(tab);
          }
        }
      } finally {
        // Renderer/view cleanup is best-effort, but run ownership is not. A
        // failed CDP viewport restore must never strand the assistant-run
        // drain or keep temporary tabs alive indefinitely.
        tab.aiActionUntil = Date.now() + AUTOMATION_ACTIVITY_GRACE_MS;
        try {
          // A visible user-owned page must not become ordinary/interactive
          // again until Chromium has acknowledged that file-chooser
          // interception is disabled. A failed restore unloads the exact page
          // rather than returning it with stale assistant-only behavior.
          await this.releaseAssistantDialogGuard(tab, dialogLease!.token);
        } finally {
          this.finishBrowserApprovalRendererReset(approvedDocument);
          lease.release();
          if (tab.aiNetworkReleaseRequested) this.releaseAiNetworkRestrictionForUser(tab);
        }
      }
    }
  }

  /** A discarded target can be constructed under Chromium's immutable
   * disableDialogs preference. A live user document is instead preserved: its
   * preload-installed native-UI trampoline and CDP dialog/file-picker guard are
   * activated and awaited before assistant authorization continues. */
  private prepareAssistantDialogSafeRenderer(tab: InternalTab, runId: string): boolean {
    if (tab.assistantDialogsDisabledRunId === runId) return false;
    const view = tab.view;
    if (view && !view.webContents.isDestroyed()) return false;
    tab.assistantDialogsDisabledRunId = runId;
    return false;
  }

  /** If dialog protection fails first, keep the tab queue, renderer surface,
   * and assistant-run lease owned until the already-started work settles. The
   * dialog handler dismisses the modal (or reclaims the renderer), allowing
   * bounded navigation/input/evaluation operations to unwind without escaping
   * into later Browser work after this call has reported failure. */
  private async awaitAssistantDialogProtectedOperation<T>(
    operation: Promise<T>,
    guard: AssistantDialogGuard,
  ): Promise<T> {
    try {
      return await Promise.race([operation, guard.failure]);
    } catch (error) {
      await operation.catch(() => undefined);
      throw error;
    }
  }

  private enableAssistantBackgroundRendering(tab: InternalTab, contents?: WebContents | null): void {
    if (
      (tab.aiActionDepth ?? 0) <= 0 ||
      !contents ||
      (typeof contents.isDestroyed === 'function' && contents.isDestroyed()) ||
      typeof contents.setBackgroundThrottling !== 'function'
    )
      return;
    const active = (tab.assistantRenderingContents ??= new Set());
    if (active.has(contents)) return;
    // Electron otherwise lets one permanent exemption keep the entire
    // containing BrowserWindow drawing while it is minimized. Scope the
    // exemption to active work and restore it in the outermost finally block.
    contents.setBackgroundThrottling(false);
    active.add(contents);
  }

  private restoreAssistantBackgroundRendering(tab: InternalTab, only?: WebContents): void {
    const active = tab.assistantRenderingContents;
    if (!active) return;
    for (const contents of [...active]) {
      if (only && contents !== only) continue;
      active.delete(contents);
      try {
        if (
          typeof contents.setBackgroundThrottling === 'function' &&
          (typeof contents.isDestroyed !== 'function' || !contents.isDestroyed())
        ) {
          contents.setBackgroundThrottling(true);
        }
      } catch {
        // Renderer teardown can race the final assistant lease release.
      }
    }
    if (active.size === 0) tab.assistantRenderingContents = undefined;
  }

  private finishAssistantPopupBootstrap(tab: InternalTab, contents?: WebContents): void {
    if (!tab.assistantPopupBootstrapPending) return;
    tab.assistantPopupBootstrapPending = false;
    const resolveBootstrap = tab.resolveAssistantPopupBootstrap;
    tab.resolveAssistantPopupBootstrap = undefined;
    tab.assistantPopupBootstrapDrain = undefined;
    tab.aiActionDepth = Math.max(0, tab.aiActionDepth - 1);
    if (tab.aiActionDepth === 0) this.restoreAssistantBackgroundRendering(tab, contents);
    resolveBootstrap?.();
  }

  private releaseAssistantRunDialogGuard(tab: InternalTab): Promise<void> {
    const token = tab.assistantRunDialogGuardLease;
    if (!token) return Promise.resolve();
    tab.assistantRunDialogGuardLease = undefined;
    return this.releaseAssistantDialogGuard(tab, token);
  }

  private async enableAssistantBackgroundViewport(
    tab: InternalTab,
    contents: WebContents,
    abortSignal?: AbortSignal,
    documentLease?: AssistantDocumentLease,
    timeoutMs = BACKGROUND_VIEWPORT_TIMEOUT_MS,
  ): Promise<void> {
    const active = (tab.assistantBackgroundViewportContents ??= new Set());
    if (active.has(contents)) {
      // A new assistant action owns this deterministic viewport again. Cancel
      // any delayed cleanup from the previous action; the new outer finally
      // will make a fresh bounded restoration attempt.
      this.clearAssistantBackgroundViewportRetry(tab, contents);
      return;
    }
    // This set is also the native-mount quarantine. Publish membership before
    // the first asynchronous debugger step so a concurrent panel mount cannot
    // expose a view while its deterministic background viewport is only
    // partially installed.
    active.add(contents);
    const setup = this.runRendererOperationWithDeadline(
      tab,
      contents,
      'Browser background viewport setup',
      timeoutMs,
      async () => {
        const releaseDebugger = this.acquireBrowserDebugger(contents);
        try {
          await contents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', {
            width: DEFAULT_DETACHED_VIEW_BOUNDS.width,
            height: DEFAULT_DETACHED_VIEW_BOUNDS.height,
            deviceScaleFactor: 1,
            mobile: false,
          });
        } finally {
          releaseDebugger();
        }
      },
      abortSignal,
      documentLease,
    );
    const setups = (tab.assistantBackgroundViewportSetups ??= new Map());
    setups.set(contents, setup);
    try {
      await setup;
    } finally {
      if (setups.get(contents) === setup) setups.delete(contents);
      if (setups.size === 0) tab.assistantBackgroundViewportSetups = undefined;
    }
    if (tab.view?.webContents !== contents || contents.isDestroyed()) {
      throw new Error('The browser page changed while its background viewport was being prepared.');
    }
  }

  private clearAssistantBackgroundViewportRetry(tab: InternalTab, contents: WebContents): void {
    const retries = tab.assistantBackgroundViewportRetries;
    const retry = retries?.get(contents);
    if (retry?.timer) clearTimeout(retry.timer);
    retries?.delete(contents);
    if (retries?.size === 0) tab.assistantBackgroundViewportRetries = undefined;
  }

  private scheduleAssistantBackgroundViewportRetry(tab: InternalTab, contents: WebContents, immediately = false): void {
    if (
      this.disposed ||
      this.shuttingDown ||
      this.tabs.get(tab.shell.id) !== tab ||
      tab.view?.webContents !== contents ||
      contents.isDestroyed() ||
      !tab.assistantBackgroundViewportContents?.has(contents)
    ) {
      this.clearAssistantBackgroundViewportRetry(tab, contents);
      return;
    }
    const retries = (tab.assistantBackgroundViewportRetries ??= new Map());
    const retry = retries.get(contents) ?? { timer: null, attempt: 0 };
    retries.set(contents, retry);
    if (retry.timer || retry.attempt >= BACKGROUND_VIEWPORT_RETRY_DELAYS_MS.length) return;
    const delay = immediately ? 0 : BACKGROUND_VIEWPORT_RETRY_DELAYS_MS[retry.attempt];
    retry.attempt++;
    retry.timer = setTimeout(() => {
      retry.timer = null;
      if (
        this.tabs.get(tab.shell.id) !== tab ||
        tab.view?.webContents !== contents ||
        contents.isDestroyed() ||
        !tab.assistantBackgroundViewportContents?.has(contents)
      ) {
        this.clearAssistantBackgroundViewportRetry(tab, contents);
        return;
      }
      const retryOperation = tab.queue.runIfIdle(async () => {
        if (tab.assistantBackgroundViewportRetries?.get(contents) !== retry) return;
        // Never clear the deterministic viewport out from under a successor AI
        // action or an in-flight setup. Waiting here preserves the exact target
        // without making retry depend on the sidebar being mounted.
        if (
          tab.aiActionDepth > 0 ||
          tab.assistantBackgroundInitialLoadPending ||
          tab.assistantBackgroundViewportSetups?.has(contents)
        ) {
          retry.attempt = Math.max(0, retry.attempt - 1);
          this.scheduleAssistantBackgroundViewportRetry(tab, contents);
          return;
        }
        await this.restoreAssistantBackgroundViewport(tab, contents, BACKGROUND_VIEWPORT_TIMEOUT_MS, true);
      });
      if (!retryOperation) {
        retry.attempt = Math.max(0, retry.attempt - 1);
        this.scheduleAssistantBackgroundViewportRetry(tab, contents);
      }
      void retryOperation?.catch(() => {
        if (tab.assistantBackgroundViewportRetries?.get(contents) === retry) {
          this.scheduleAssistantBackgroundViewportRetry(tab, contents);
        }
      });
    }, delay);
    retry.timer.unref?.();
  }

  private async restoreAssistantBackgroundViewport(
    tab: InternalTab,
    only?: WebContents,
    timeoutMs = BACKGROUND_VIEWPORT_TIMEOUT_MS,
    retryAttempt = false,
  ): Promise<void> {
    const active = tab.assistantBackgroundViewportContents;
    if (!active) return;
    for (const contents of [...active]) {
      if (only && contents !== only) continue;
      if (!retryAttempt) this.clearAssistantBackgroundViewportRetry(tab, contents);
      const existingRestore = tab.assistantBackgroundViewportRestores?.get(contents);
      if (existingRestore) {
        await existingRestore;
        continue;
      }
      const restore = (async () => {
        // A user can request presentation while the metrics override is still
        // being installed. Serialize only those two short CDP transitions so a
        // late setDeviceMetricsOverride cannot land after the clear.
        const setup = tab.assistantBackgroundViewportSetups?.get(contents);
        if (setup) await setup.catch(() => undefined);
        if (contents.isDestroyed()) return;
        const targetWasCurrent = tab.view?.webContents === contents;
        let restored = false;
        let debuggerLease: BrowserDebuggerLease | undefined;
        try {
          await this.runRendererOperationWithDeadline(
            tab,
            contents,
            'Browser background viewport cleanup',
            timeoutMs,
            async () => {
              const lease = this.acquireBrowserDebuggerLease(contents);
              debuggerLease = lease;
              try {
                await contents.debugger.sendCommand('Emulation.clearDeviceMetricsOverride');
              } finally {
                lease.release();
              }
            },
            undefined,
            undefined,
            false,
          );
          restored = true;
          this.clearAssistantBackgroundViewportRetry(tab, contents);
          if (tab.shell.error === 'The background browser viewport could not be restored.') {
            tab.shell.error = undefined;
            this.emitTabs(tab.shell.conversationId);
          }
        } catch {
          // Cleanup deliberately preserves the authenticated page, so detach
          // only the exact manager-owned CDP generation whose native command
          // exceeded the deadline. A concurrent lease keeps the shared
          // transport alive until it drains.
          debuggerLease?.cancel();
          // Presentation must never destroy or cancel an assistant target. Keep
          // the native-mount quarantine so the operation's own finally path can
          // retry after concurrent CDP work settles.
          if (this.tabs.get(tab.shell.id) === tab && tab.view?.webContents === contents && !contents.isDestroyed()) {
            tab.shell.error = 'The background browser viewport could not be restored.';
            this.emitTabs(tab.shell.conversationId);
          }
          // Target teardown can race this cleanup independently. There is then
          // no stale viewport left to quarantine or retry. Cleanup itself is
          // non-destructive: presentation state may never reclaim an AI target.
          if (targetWasCurrent && (!tab.view || tab.view.webContents !== contents || contents.isDestroyed())) {
            restored = true;
            this.clearAssistantBackgroundViewportRetry(tab, contents);
          } else if (
            this.tabs.get(tab.shell.id) === tab &&
            tab.view?.webContents === contents &&
            !contents.isDestroyed()
          ) {
            this.scheduleAssistantBackgroundViewportRetry(tab, contents);
          }
        } finally {
          if (restored) active.delete(contents);
        }
      })();
      const restores = (tab.assistantBackgroundViewportRestores ??= new Map());
      restores.set(contents, restore);
      try {
        await restore;
      } finally {
        if (restores.get(contents) === restore) restores.delete(contents);
        if (restores.size === 0) tab.assistantBackgroundViewportRestores = undefined;
      }
    }
    if (active.size === 0) tab.assistantBackgroundViewportContents = undefined;
    if (this.tabs.get(tab.shell.id) === tab) this.attachActiveView(tab.shell.conversationId);
  }

  /** Record presentation intent independently from the per-tab AI action queue.
   * Only short target-state transitions needed to mount this exact view are
   * awaited; an already-running or later assistant action remains admitted and
   * continues against the same renderer. */
  private prepareTabForUserPresentation(tab: InternalTab): Promise<void> | null {
    const transitions: Promise<void>[] = [];
    const menuPreviewRecovery = this.preemptMenuPreviewForTab(
      tab,
      'Browser menu preview was cancelled because the user opened this tab.',
    );
    if (menuPreviewRecovery) transitions.push(menuPreviewRecovery);
    const contents = tab.view?.webContents;
    const dialogRestore = contents ? this.assistantDialogProtectionRestores?.get(contents.id) : undefined;
    if (dialogRestore) {
      // File-chooser interception is native target state. Keep this view
      // detached until Chromium confirms it has returned to ordinary user
      // behavior; merely removing the debugger listener is not sufficient.
      if (this.attachedView === tab.view) this.detachAttachedView();
      tab.view?.setVisible(false);
      tab.view?.setBounds(DEFAULT_DETACHED_VIEW_BOUNDS);
      transitions.push(dialogRestore);
    }
    const takingOverBackgroundInitialLoad = tab.assistantBackgroundInitialLoadPending === true;
    if (takingOverBackgroundInitialLoad) {
      // The initial hidden bootstrap is presentation-only setup, not an
      // assistant action. A user selecting the tab cancels any setup that has
      // not started and takes responsibility for clearing one already in
      // flight. The ordinary assistant-operation viewport remains quarantined
      // until that operation's own finally block restores it.
      tab.assistantBackgroundInitialLoadPending = false;
    }
    const backgroundViewportActive = !!contents && tab.assistantBackgroundViewportContents?.has(contents) === true;
    if (
      contents &&
      backgroundViewportActive &&
      tab.aiActionDepth === 0 &&
      tab.shell.error === 'The background browser viewport could not be restored.'
    ) {
      // A later explicit presentation gets a fresh immediate retry budget even
      // if the autonomous attempts were exhausted. This is non-destructive and
      // uses the queue only when idle, so it never reclaims or interrupts the AI
      // target and does not make Browser control depend on a mounted panel.
      this.clearAssistantBackgroundViewportRetry(tab, contents);
      this.scheduleAssistantBackgroundViewportRetry(tab, contents, true);
    }
    if (
      contents &&
      !contents.isDestroyed() &&
      (backgroundViewportActive ||
        takingOverBackgroundInitialLoad ||
        this.hasPendingBackgroundAutomationArm(tab, contents) ||
        this.hasDispatchedSyntheticInput(tab, contents))
    ) {
      if (this.attachedView === tab.view) this.detachAttachedView();
      tab.view?.setVisible(false);
      tab.view?.setBounds(DEFAULT_DETACHED_VIEW_BOUNDS);
      // The Browser panel is a passive mirror. It records presentation intent
      // and leaves the deterministic AI viewport untouched; the operation that
      // acquired that viewport restores it from its own `finally` path, then
      // attachActiveView() observes the pending mount and presents the page.
    }
    return transitions.length > 0 ? Promise.all(transitions).then(() => undefined) : null;
  }

  /** Selecting an assistant-created shell through Browser chrome transfers its
   * lifecycle to the user. Closing the active tab can select a neighboring
   * shell just as explicitly as clicking that tab, so both paths use the same
   * retention and download-ownership transition. */
  private takeOverTabForUser(tab: InternalTab): void {
    // This durable per-tab generation lets an assistant bulk-close detect even
    // a transient user selection (select, then switch back) while it drains
    // already admitted tab work. Browser chrome is not input to the remote page,
    // so it must not invalidate exact assistant download attribution.
    tab.userSelectionGeneration = (tab.userSelectionGeneration ?? 0) + 1;
    const assistantOwned = tab.shell.owner === 'assistant';
    if (assistantOwned && !tab.shell.keepOpen) {
      tab.shell.keepOpen = true;
      for (const download of this.activeDownloads.values()) {
        if (download.tabId === tab.shell.id) download.keepOpen = true;
      }
    }
    // Creator ownership is durable lifecycle/download metadata, not the active
    // AI control lease. Explicit user selection transfers the former while an
    // already-admitted assistant operation keeps aiControlOwnerId until its
    // normal run boundary, so concurrent background work does not get paused.
    tab.shell.owner = 'user';
    tab.assistantOwnerId = null;
    // Selection is presentation, not an action-queue or native-target-state
    // barrier. Keep the run-level dialog guard and irreversible document guards
    // intact until the run boundary so neither the current nor a later AI action
    // waits for Chromium restoration triggered only by opening the sidebar.
    if (tab.assistantPopupBootstrapPending) this.finishAssistantPopupBootstrap(tab, tab.view?.webContents);
    tab.lastUsedAt = Date.now();
  }

  private async takeOverActiveAssistantPresentation(conversationId: string): Promise<void> {
    const activeId = this.activeTabs.get(conversationId);
    const active = activeId ? this.tabs.get(activeId) : undefined;
    if (!active || active.shell.owner !== 'assistant') return;
    this.takeOverTabForUser(active);
    const presentationTransition = this.prepareTabForUserPresentation(active);
    if (presentationTransition) await presentationTransition;
    if (this.tabs.get(active.shell.id) !== active || this.activeTabs.get(conversationId) !== active.shell.id) return;
    this.attachActiveView(conversationId);
    this.notifyPanelStateChanged(conversationId);
  }

  private assertAssistantDocumentLease(tab: InternalTab, lease: AssistantDocumentLease): void {
    if (!this.isHostRendererAuthorityCurrent(lease.hostRendererAuthorityGeneration)) {
      throw new Error('The Kai renderer changed while this assistant browser operation was waiting.');
    }
    if (tab.aiControlOwnerId !== lease.runId || tab.aiControlGeneration !== lease.runGeneration) {
      throw new Error('The assistant browser turn ended while this operation was waiting.');
    }
    if (
      this.tabs.get(tab.shell.id) !== tab ||
      tab.generation !== lease.tabGeneration ||
      tab.trustedUserNavigationLease !== lease.userNavigationLease ||
      tab.shell.url !== lease.url
    ) {
      throw new Error('The page navigated while this assistant operation was waiting.');
    }
    if (
      lease.visibleAssistantGeneration !== undefined &&
      (tab.visibleAssistantGeneration ?? 0) !== lease.visibleAssistantGeneration
    ) {
      throw new Error('The Browser page stopped being visible while this assistant operation was waiting.');
    }
  }

  private assertBrowserDocumentApproval(tab: InternalTab, approval: BrowserDocumentApproval | undefined): void {
    if (!approval) return;
    const capturedIdentityMatches =
      approval.tabRef === undefined || (approval.tabRef === tab && this.tabs.get(approval.tabId) === tab);
    const capturedNavigationLeaseMatches =
      approval.userNavigationLease === undefined || approval.userNavigationLease === tab.trustedUserNavigationLease;
    const generationMatches =
      tab.generation === approval.tabGeneration ||
      (approval.allowInternalRestore === true &&
        approval.tabRef === tab &&
        approval.userNavigationLease !== undefined &&
        tab.generation === approval.tabGeneration + 1);
    if (
      tab.shell.id !== approval.tabId ||
      !capturedIdentityMatches ||
      !capturedNavigationLeaseMatches ||
      !generationMatches ||
      normalizedOrigin(tab.shell.url) !== approval.origin ||
      (approval.url !== undefined && tab.shell.url !== approval.url)
    ) {
      throw new Error('The browser page changed while approval was pending. Review the new page and try again.');
    }
  }

  private browserDocumentApprovalFrom(
    approval: BrowserApprovalWithDocument | undefined,
  ): BrowserDocumentApproval | undefined {
    if (
      !approval ||
      typeof approval.tabId !== 'string' ||
      typeof approval.tabGeneration !== 'number' ||
      typeof approval.origin !== 'string'
    ) {
      return undefined;
    }
    return approval as BrowserDocumentApproval;
  }

  /** Revalidate ask-policy consent before any dialog-safe renderer mutation.
   * The returned lease is intentionally not stored on the serializable approval
   * object, and therefore cannot be forged or replayed across tool calls. */
  private beginBrowserApprovalRendererReset(
    tab: InternalTab,
    run: BrowserAssistantRun,
    approval: BrowserApprovalWithDocument | undefined,
  ): BrowserApprovalRendererResetLease | undefined {
    const documentApproval = this.browserDocumentApprovalFrom(approval);
    if (!approval || !documentApproval) return undefined;
    this.assertBrowserDocumentApproval(tab, documentApproval);
    const sourceView = tab.view;
    const sourceContents = sourceView && !sourceView.webContents.isDestroyed() ? sourceView.webContents : null;
    const needsDialogSafeReplacement = sourceContents === null && tab.assistantDialogsDisabledRunId !== run.id;
    const needsDiscardedRestore = sourceContents === null && tab.shell.discarded;
    if (!needsDialogSafeReplacement && !needsDiscardedRestore) return undefined;
    const lease: BrowserApprovalRendererResetLease = {
      approval,
      tab,
      runId: run.id,
      origin: documentApproval.origin,
      url: documentApproval.url ?? tab.shell.url,
      userNavigationLease: documentApproval.userNavigationLease ?? tab.trustedUserNavigationLease,
      sourceGeneration: tab.generation,
      sourceContents,
    };
    this.approvalRendererResetLeases ??= new WeakMap<object, BrowserApprovalRendererResetLease>();
    this.approvalRendererResetLeases.set(approval, lease);
    return lease;
  }

  /** Bind consent to the exact post-reclamation shell state. No renderer load is
   * authorized here; ensureAssistantView must later consume the lease against
   * the exact replacement WebContents and completed URL. */
  private prepareBrowserApprovalRendererReset(
    tab: InternalTab,
    approval: BrowserApprovalWithDocument | undefined,
    lease: BrowserApprovalRendererResetLease | undefined,
    rendererReclaimed: boolean,
  ): void {
    if (!approval || !lease) return;
    const expectedGeneration = lease.sourceGeneration + (rendererReclaimed ? 1 : 0);
    const sourceStillCurrent =
      lease.tab === tab &&
      this.tabs.get(tab.shell.id) === tab &&
      tab.generation === expectedGeneration &&
      tab.trustedUserNavigationLease === lease.userNavigationLease &&
      tab.shell.url === lease.url &&
      normalizedOrigin(tab.shell.url) === lease.origin &&
      (lease.sourceContents === null || tab.view === null);
    if (!sourceStillCurrent) {
      this.approvalRendererResetLeases.delete(approval);
      throw new Error('The browser page changed while approval was pending. Review the new page and try again.');
    }
    approval.tabGeneration = tab.generation;
    approval.allowInternalRestore = true;
    lease.preparedGeneration = tab.generation;
  }

  /** A discarded tab restore advances generation from did-start-navigation,
   * potentially once for the inert about:blank bootstrap and again for the
   * requested page. Rebind the one-shot lease only after ensureView has
   * completed that exact replacement renderer and URL. Any subsequent
   * navigation still advances generation and is rejected by consume below. */
  private advanceBrowserApprovalRendererResetAfterRestore(
    tab: InternalTab,
    run: BrowserAssistantRun,
    approval: BrowserApprovalWithDocument | undefined,
    view: WebContentsView,
    expectedGeneration: number | undefined,
  ): void {
    if (!approval) return;
    const lease = this.approvalRendererResetLeases?.get(approval);
    if (!lease) return;
    const replacementIsExact =
      lease.preparedGeneration !== undefined &&
      lease.tab === tab &&
      lease.runId === run.id &&
      this.tabs.get(tab.shell.id) === tab &&
      expectedGeneration !== undefined &&
      expectedGeneration >= lease.preparedGeneration &&
      tab.generation === expectedGeneration &&
      tab.view === view &&
      !view.webContents.isDestroyed() &&
      view.webContents !== lease.sourceContents &&
      !tab.viewLoadPromise &&
      tab.trustedUserNavigationLease === lease.userNavigationLease &&
      tab.shell.url === lease.url &&
      normalizedOrigin(tab.shell.url) === lease.origin;
    if (!replacementIsExact) {
      this.approvalRendererResetLeases.delete(approval);
      throw new Error('The browser page changed while approval was pending. Review the new page and try again.');
    }
    lease.preparedGeneration = tab.generation;
    lease.replacementContents = view.webContents;
  }

  /** Consume the one-shot lease only after ensureView has completed the exact
   * replacement load. Redirects, user navigation, a reused tab id, or the old
   * renderer all invalidate consent instead of being papered over by a numeric
   * generation allowance. */
  private consumeBrowserApprovalRendererReset(
    tab: InternalTab,
    run: BrowserAssistantRun,
    approval: BrowserApprovalWithDocument | undefined,
    view: WebContentsView,
  ): void {
    if (!approval) return;
    const lease = this.approvalRendererResetLeases?.get(approval);
    if (!lease) return;
    const replacementIsExact =
      lease.preparedGeneration !== undefined &&
      lease.tab === tab &&
      lease.runId === run.id &&
      this.tabs.get(tab.shell.id) === tab &&
      tab.generation === lease.preparedGeneration &&
      tab.view === view &&
      !view.webContents.isDestroyed() &&
      view.webContents !== lease.sourceContents &&
      view.webContents === lease.replacementContents &&
      !tab.viewLoadPromise &&
      tab.trustedUserNavigationLease === lease.userNavigationLease &&
      tab.shell.url === lease.url &&
      normalizedOrigin(tab.shell.url) === lease.origin;
    this.approvalRendererResetLeases.delete(approval);
    if (!replacementIsExact) {
      throw new Error('The browser page changed while approval was pending. Review the new page and try again.');
    }
    approval.tabGeneration = tab.generation;
    approval.allowInternalRestore = false;
  }

  private finishBrowserApprovalRendererReset(approval: BrowserApprovalWithDocument | undefined): void {
    if (approval) this.approvalRendererResetLeases?.delete(approval);
  }

  private captureBrowserPageLease(tab: InternalTab, contents: WebContents): BrowserPageLease {
    return {
      tabId: tab.shell.id,
      tabGeneration: tab.generation,
      userNavigationLease: tab.trustedUserNavigationLease,
      contents,
    };
  }

  private isBrowserPageLeaseCurrent(tab: InternalTab, lease: BrowserPageLease): boolean {
    return (
      this.tabs.get(lease.tabId) === tab &&
      tab.view?.webContents === lease.contents &&
      !lease.contents.isDestroyed() &&
      tab.generation === lease.tabGeneration &&
      tab.trustedUserNavigationLease === lease.userNavigationLease
    );
  }

  private assertBrowserPageLease(tab: InternalTab, lease: BrowserPageLease, operation = 'operation'): void {
    if (!this.isBrowserPageLeaseCurrent(tab, lease)) {
      throw new Error(`The browser page changed while this ${operation} was in progress.`);
    }
  }

  private clearContextMenuDownloadAuthority(contentsId: number, expected?: BrowserContextMenuDownloadAuthority): void {
    const authorities = this.contextMenuDownloadAuthorities;
    const current = authorities?.get(contentsId);
    if (!current || (expected && current !== expected)) return;
    authorities?.delete(contentsId);
    clearTimeout(current.timer);
  }

  private authorizeContextMenuDownload(
    tab: InternalTab,
    contents: WebContents,
    url: string,
  ): BrowserContextMenuDownloadAuthority {
    this.clearContextMenuDownloadAuthority(contents.id);
    let authority: BrowserContextMenuDownloadAuthority;
    const timer = setTimeout(
      () => this.clearContextMenuDownloadAuthority(contents.id, authority),
      CONTEXT_MENU_DOWNLOAD_AUTHORITY_MS,
    );
    timer.unref?.();
    authority = {
      tabId: tab.shell.id,
      tabGeneration: tab.generation,
      userNavigationLease: tab.trustedUserNavigationLease,
      contents,
      url,
      expiresAt: Date.now() + CONTEXT_MENU_DOWNLOAD_AUTHORITY_MS,
      timer,
    };
    (this.contextMenuDownloadAuthorities ??= new Map()).set(contents.id, authority);
    return authority;
  }

  private consumeContextMenuDownloadAuthority(tab: InternalTab, contents: WebContents, url: string): boolean {
    const authority = this.contextMenuDownloadAuthorities?.get(contents.id);
    if (!authority) return false;
    const documentStillMatches =
      authority.tabId === tab.shell.id &&
      authority.tabGeneration === tab.generation &&
      authority.userNavigationLease === tab.trustedUserNavigationLease &&
      authority.contents === contents &&
      this.tabs.get(tab.shell.id) === tab &&
      tab.view?.webContents === contents &&
      !contents.isDestroyed();
    if (!documentStillMatches || authority.expiresAt < Date.now()) {
      this.clearContextMenuDownloadAuthority(contents.id, authority);
      return false;
    }
    // An unrelated timer/service download must not consume the explicit menu
    // command. Leave the authority available for only the exact requested URL.
    if (authority.url !== url) return false;
    this.clearContextMenuDownloadAuthority(contents.id, authority);
    return true;
  }

  private browserPageLeaseToken(lease: BrowserPageLease): string {
    return [lease.tabId, lease.tabGeneration, lease.userNavigationLease, lease.contents.id].join(':');
  }

  private browserMenuPreviewIdentity(tab: InternalTab): string {
    return [tab.shell.id, tab.generation, tab.trustedUserNavigationLease, tab.shell.url, tab.shell.updatedAt].join(
      '\u0000',
    );
  }

  private assertBrowserMenuPreviewIdentity(tab: InternalTab, identity: string): void {
    if (this.browserMenuPreviewIdentity(tab) !== identity) {
      throw new Error('The browser page changed while this Browser menu preview was in progress.');
    }
  }

  private async ensureAssistantView(
    tab: InternalTab,
    run: BrowserAssistantRun,
    lease: AssistantDocumentLease,
    timeoutMs = ASSISTANT_PAGE_LOAD_TIMEOUT_MS,
    approvedDocument?: BrowserApprovalWithDocument,
    preserveExistingLoadingViewOnTimeout = false,
  ): Promise<WebContentsView> {
    const hadReadyView = !!tab.view && !tab.view.webContents.isDestroyed() && !tab.viewLoadPromise;
    let expectedRestoreGeneration: number | undefined;
    // The shared restoration itself derives detached/presented behavior from
    // current tab ownership and presentation state. This caller contributes
    // only its own cancellation policy and provenance callback.
    const view = await this.ensureView(
      tab,
      run.abortSignal,
      timeoutMs,
      preserveExistingLoadingViewOnTimeout,
      (generation) => {
        expectedRestoreGeneration = generation;
      },
    );
    try {
      this.assertAssistantDocumentLease(tab, lease);
    } catch (error) {
      // Recreating an idle-discarded renderer performs an internal load after
      // the initial shell URL was authorized. It may normalize or redirect the
      // URL, so authorize that completed document once more. A real user
      // navigation increments its separate lease and must invalidate the AI
      // operation even when it races this first load.
      if (hadReadyView || tab.trustedUserNavigationLease !== lease.userNavigationLease) throw error;
      const refreshed = await this.guardAssistantTab(tab, run, lease.runGeneration);
      Object.assign(lease, refreshed);
      this.assertAssistantDocumentLease(tab, lease);
    }
    this.advanceBrowserApprovalRendererResetAfterRestore(tab, run, approvedDocument, view, expectedRestoreGeneration);
    // webRequest cannot observe WebRTC ICE/TURN traffic. Before any assistant
    // operation can inspect or dispatch input to the page, activate the
    // preload membrane in every existing frame and register the same guard for
    // every future document in this WebContents. This also closes peer
    // connections the user page opened before assistant control began.
    if (this.aiAllowPrivateNetwork === false) {
      try {
        // The native WebRTC policy is per-WebContents. Ordinary user tabs stay
        // unrestricted, then switch to the proxy-only path only while the
        // assistant owns this document.
        configureBrowserWebContents(view.webContents, false);
        await this.installPrivateNetworkNewDocumentGuard(tab, view.webContents, run.abortSignal, lease);
        this.assertAssistantDocumentLease(tab, lease);
      } catch (error) {
        // Changing the native policy or installing the document membrane can
        // race a user navigation. Reclaim the affected renderer so a later
        // user restore starts with Chromium's default WebRTC behavior.
        if (this.tabs.get(tab.shell.id) === tab && tab.view === view && !view.webContents.isDestroyed()) {
          tab.generation++;
          this.destroyView(tab);
          tab.shell.discarded = true;
          tab.shell.sensitive = false;
          this.emitTabs(tab.shell.conversationId);
        }
        throw error;
      }
    }
    if (tab.assistantDialogGuard) {
      await this.protectAssistantDialogs(tab, view.webContents, tab.assistantDialogGuard);
    }
    try {
      await this.installAssistantNativeUiGuard(tab, view.webContents, run.abortSignal, lease);
      this.assertAssistantDocumentLease(tab, lease);
    } catch (error) {
      // A page that cannot prove print suppression must never remain available
      // to hidden assistant work. Reclaim the exact renderer so no delayed
      // native sheet can outlive the failed operation.
      if (this.tabs.get(tab.shell.id) === tab && tab.view === view && !view.webContents.isDestroyed()) {
        tab.generation++;
        this.destroyView(tab);
        tab.shell.discarded = true;
        tab.shell.sensitive = false;
        this.emitTabs(tab.shell.conversationId);
      }
      throw error;
    }
    this.consumeBrowserApprovalRendererReset(tab, run, approvedDocument, view);
    return view;
  }

  private async withAssistantScriptPopupAttribution<T>(tab: InternalTab, operation: () => Promise<T>): Promise<T> {
    const previousDownloadAttribution = tab.assistantDownloadAttribution;
    if (tab.aiControlOwnerId) {
      tab.assistantDownloadAttribution = {
        assistantOwnerId: tab.aiControlOwnerId,
        trustedGestureGeneration: tab.trustedGestureGeneration ?? 0,
      };
    }
    tab.assistantScriptDepth++;
    try {
      return await operation();
    } finally {
      tab.assistantScriptDepth = Math.max(0, tab.assistantScriptDepth - 1);
      tab.assistantDownloadAttribution = previousDownloadAttribution;
    }
  }

  private async withAssistantDownloadAttribution<T>(
    tab: InternalTab,
    assistantOwnerId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = tab.assistantDownloadAttribution;
    tab.assistantDownloadAttribution = {
      assistantOwnerId,
      trustedGestureGeneration: tab.trustedGestureGeneration ?? 0,
    };
    try {
      return await operation();
    } finally {
      tab.assistantDownloadAttribution = previous;
    }
  }

  private rememberAssistantGesture(
    tab: InternalTab,
    assistantOwnerId: string,
    expiresAt: number,
    kind?: NonNullable<InternalTab['assistantGesture']>['kind'],
    frameTreeNodeId?: number,
  ): void {
    const assistantGesture = {
      assistantOwnerId,
      expiresAt,
      ...(frameTreeNodeId !== undefined ? { frameTreeNodeId } : {}),
      ...(kind !== undefined ? { kind } : {}),
    };
    tab.assistantGesture = assistantGesture;
    tab.popupGesture = { source: 'assistant', ...assistantGesture };
  }

  private timestampCdpInputCommand(command: BrowserCdpInputCommand): BrowserCdpInputCommand {
    if (command.method === 'Input.insertText') return command;
    const supplied = command.params.timestamp;
    if (typeof supplied === 'number' && Number.isFinite(supplied) && supplied > 0) return command;
    return {
      ...command,
      params: { ...command.params, timestamp: Date.now() / 1_000 },
    };
  }

  private createAutomationGestureArm(
    tab: InternalTab,
    contents: WebContents,
    input: Omit<BrowserAutomationInputArm, 'token' | 'expiresAt' | 'timestamp'>,
    background = this.attachedView !== tab.view,
    timestamp = Date.now() / 1_000,
  ): BrowserAutomationInputArm {
    const assistantOwnerId = tab.aiControlOwnerId;
    if (!assistantOwnerId) throw new Error('Assistant input lost ownership of this browser tab.');
    const token = randomUUID();
    const expiresAt = Date.now() + AUTOMATION_GESTURE_ARM_MS;
    let confirmationSettled = false;
    let resolveConfirmation!: (confirmed: boolean) => void;
    const confirmation = new Promise<boolean>((resolve) => {
      resolveConfirmation = resolve;
    });
    const settleConfirmation = (confirmed: boolean): void => {
      if (confirmationSettled) return;
      confirmationSettled = true;
      resolveConfirmation(confirmed);
    };
    this.automationGestureTokens.set(token, {
      tabId: tab.shell.id,
      contentsId: contents.id,
      assistantOwnerId,
      expiresAt,
      kind: input.kind,
      ...(input.data !== undefined ? { inputData: input.data } : {}),
      confirmed: false,
      dispatchStarted: false,
      confirmation,
      settleConfirmation,
    });
    // Attribute the input in main before Chromium dispatches it. A page-level
    // window capture handler can synchronously call window.open() before the
    // preload's document listener reports the one-shot token; without this
    // early marker that popup could inherit a stale real-user gesture.
    this.rememberAssistantGesture(tab, assistantOwnerId, expiresAt, input.kind);
    // Text is retained only in main for a one-shot comparison when the target
    // frame reports the trusted input event. Broadcasting it to every preload
    // would disclose typed secrets to every unrelated cross-origin frame.
    const { data: _privateInputData, ...publicInput } = input;
    const arm: BrowserAutomationInputArm = { ...publicInput, token, expiresAt, timestamp };
    const win = this.getWindow();
    // A detached page cannot receive real pointer input from the user. Match
    // its synthetic event by kind only so clicks delivered inside an OOPIF do
    // not fail on frame-local client coordinates while React mounts the panel.
    if (input.x !== undefined && input.y !== undefined && background) {
      delete arm.x;
      delete arm.y;
    }
    if (
      input.x !== undefined &&
      input.y !== undefined &&
      !background &&
      this.attachedView === tab.view &&
      tab.view &&
      win &&
      !win.isDestroyed() &&
      !win.webContents.isDestroyed()
    ) {
      const contentBounds = win.getContentBounds();
      const viewBounds = tab.view.getBounds();
      const inputPoint = scaleBrowserPointForZoom({ x: input.x, y: input.y }, contents.getZoomFactor());
      arm.screenX = contentBounds.x + viewBounds.x + Math.round(inputPoint.x);
      arm.screenY = contentBounds.y + viewBounds.y + Math.round(inputPoint.y);
    }
    const expiry = setTimeout(() => {
      const pending = this.automationGestureTokens.get(token);
      // A confirmed receipt remains available until the bounded input command
      // consumes it. Otherwise a slow CDP response could turn ordinary token
      // expiry into a false success.
      if (pending && !pending.confirmed) this.revokeAutomationGestureToken(token);
    }, AUTOMATION_GESTURE_ARM_MS);
    expiry.unref?.();
    return arm;
  }

  private publishAutomationGestureDisarm(contents: WebContents, token: string): void {
    try {
      for (const frame of contents.mainFrame.framesInSubtree) {
        if (!frame.detached && !frame.isDestroyed()) {
          frame.send('browser-page:disarm-automation-input', { token });
        }
      }
    } catch {
      // A closing/replaced frame has already discarded its isolated-world token.
    }
  }

  private revokeAutomationGestureToken(token: string): PendingAutomationGesture | undefined {
    const pending = this.automationGestureTokens.get(token);
    this.automationGestureTokens.delete(token);
    if (!pending) return undefined;
    pending.settleConfirmation?.(false);
    const tab = this.tabs.get(pending.tabId);
    const contents = tab?.view?.webContents;
    if (contents && !contents.isDestroyed() && contents.id === pending.contentsId) {
      this.publishAutomationGestureDisarm(contents, token);
    }
    return pending;
  }

  private hasPendingBackgroundAutomationArm(tab: InternalTab, contents: WebContents): boolean {
    for (const pending of this.automationGestureTokens.values()) {
      if (pending.tabId === tab.shell.id && pending.contentsId === contents.id && pending.detachedArm === true) {
        return true;
      }
    }
    return false;
  }

  private hasDispatchedSyntheticInput(tab: InternalTab, contents: WebContents): boolean {
    const dispatched = this.dispatchedSyntheticInputs.get(contents.id);
    return !!dispatched && dispatched.tabId === tab.shell?.id && dispatched.contents === contents;
  }

  private consumeAutomationGestureConfirmation(token: string): boolean {
    const pending = this.automationGestureTokens.get(token);
    if (pending?.confirmed) this.clearDispatchedSyntheticInput(pending.contentsId, token);
    this.revokeAutomationGestureToken(token);
    return pending?.confirmed === true;
  }

  private clearDispatchedSyntheticInput(contentsId: number, token?: string): DispatchedSyntheticInput | undefined {
    const dispatched = this.dispatchedSyntheticInputs.get(contentsId);
    if (!dispatched || (token !== undefined && dispatched.token !== token)) return undefined;
    this.dispatchedSyntheticInputs.delete(contentsId);
    if (dispatched.timer) clearTimeout(dispatched.timer);
    return dispatched;
  }

  private confirmDispatchedSyntheticInput(contentsId: number, token: string): void {
    const dispatched = this.dispatchedSyntheticInputs.get(contentsId);
    if (!dispatched || dispatched.token !== token || !dispatched.timer) return;
    clearTimeout(dispatched.timer);
    dispatched.timer = null;
  }

  private reclaimDispatchedSyntheticInput(contentsId: number, token: string, reason: string): void {
    const dispatched = this.dispatchedSyntheticInputs.get(contentsId);
    if (!dispatched || dispatched.token !== token) return;
    const tab = this.tabs.get(dispatched.tabId);
    if (tab && tab.view?.webContents === dispatched.contents && !dispatched.contents.isDestroyed()) {
      // Keep the attribution tombstone present until destroyView has detached
      // and closed the exact WebContents. A late trusted DOM event can then
      // never be reclassified as a real user gesture between timeout and close.
      tab.generation++;
      this.destroyView(tab);
      tab.shell.discarded = true;
      tab.shell.error = reason;
      this.emitTabs(tab.shell.conversationId);
      return;
    }
    // The original target is no longer reachable through its shell. Close that
    // exact orphan before dropping the tombstone; never touch a replacement.
    try {
      if (!dispatched.contents.isDestroyed()) dispatched.contents.close({ waitForBeforeUnload: false });
    } catch {
      // Best-effort reclamation of an already-tearing-down target.
    }
    this.clearDispatchedSyntheticInput(contentsId, token);
  }

  private trackDispatchedSyntheticInput(tab: InternalTab, contents: WebContents, arm: BrowserAutomationInputArm): void {
    if (this.dispatchedSyntheticInputs.has(contents.id)) {
      throw new Error('Another attributed browser input is still awaiting Chromium confirmation.');
    }
    let dispatched!: DispatchedSyntheticInput;
    const timer = setTimeout(
      () =>
        this.reclaimDispatchedSyntheticInput(
          contents.id,
          arm.token,
          'Attributed browser input expired before Chromium confirmed it.',
        ),
      Math.max(1, arm.expiresAt - Date.now()),
    );
    timer.unref?.();
    dispatched = {
      tabId: tab.shell.id,
      contents,
      token: arm.token,
      kind: arm.kind,
      timer,
    };
    this.dispatchedSyntheticInputs.set(contents.id, dispatched);
  }

  private async waitForAutomationGestureConfirmation(
    tab: InternalTab,
    contents: WebContents,
    token: string,
    abortSignal?: AbortSignal,
    documentLease?: AssistantDocumentLease,
  ): Promise<void> {
    const pending = this.automationGestureTokens.get(token);
    if (
      !pending ||
      pending.tabId !== tab.shell.id ||
      pending.contentsId !== contents.id ||
      (!pending.confirmed && !pending.confirmation)
    ) {
      throw new Error('Attributed browser input expired before Chromium confirmed it.');
    }
    throwIfBrowserAborted(abortSignal);
    const confirmed = pending.confirmed
      ? true
      : await new Promise<boolean>((resolve, reject) => {
          let settled = false;
          const finish = (result: { confirmed: boolean } | { error: Error }): void => {
            if (settled) return;
            settled = true;
            abortSignal?.removeEventListener('abort', onAbort);
            if ('error' in result) reject(result.error);
            else resolve(result.confirmed);
          };
          const onAbort = () => finish({ error: new Error('Browser action was cancelled.') });
          abortSignal?.addEventListener('abort', onAbort, { once: true });
          if (abortSignal?.aborted) onAbort();
          void pending.confirmation!.then((value) => finish({ confirmed: value }));
        });
    throwIfBrowserAborted(abortSignal);
    if (!confirmed || this.automationGestureTokens.get(token) !== pending || !pending.confirmed) {
      throw new Error('Chromium did not confirm the attributed browser input before its bounded arm expired.');
    }
    if (documentLease) this.assertAssistantDocumentLease(tab, documentLease);
  }

  private assertAutomationGestureReadyForDispatch(token: string): void {
    const pending = this.automationGestureTokens.get(token);
    if (!pending || pending.confirmed || pending.expiresAt < Date.now()) {
      this.revokeAutomationGestureToken(token);
      throw new Error('Attributed browser input expired before Chromium dispatch.');
    }
    if (pending.armedFrames) {
      const tab = this.tabs.get(pending.tabId);
      const contents = tab?.view?.webContents;
      if (!tab || !contents || contents.isDestroyed() || contents.id !== pending.contentsId) {
        this.revokeAutomationGestureToken(token);
        throw new Error('The browser page changed before attributed background input could be dispatched.');
      }
      if (pending.detachedArm && this.isTargetViewPresented(tab, contents)) {
        this.revokeAutomationGestureToken(token);
        throw new Error('The Browser became visible while background input was being armed. Retry the action.');
      }
      let currentFrames: Map<number, string>;
      try {
        currentFrames = this.snapshotAutomationFrames(contents).identities;
      } catch {
        this.revokeAutomationGestureToken(token);
        throw new Error('The browser page changed before attributed background input could be dispatched.');
      }
      if (
        currentFrames.size !== pending.armedFrames.size ||
        [...pending.armedFrames].some(([frameTreeNodeId, identity]) => currentFrames.get(frameTreeNodeId) !== identity)
      ) {
        this.revokeAutomationGestureToken(token);
        throw new Error('A browser frame changed before attributed background input could be dispatched.');
      }
    }
  }

  private publishAutomationGestureArm(contents: WebContents, arm: BrowserAutomationInputArm): void {
    try {
      for (const frame of contents.mainFrame.framesInSubtree) {
        if (!frame.detached && !frame.isDestroyed()) frame.send('browser-page:arm-automation-input', arm);
      }
    } catch {
      this.revokeAutomationGestureToken(arm.token);
      throw new Error('The browser page changed before assistant input could be attributed.');
    }
  }

  private automationFrameIdentity(frame: WebFrameMain): string {
    return `${frame.processId}:${frame.routingId}:${frame.frameToken}`;
  }

  private snapshotAutomationFrames(contents: WebContents): {
    frames: WebFrameMain[];
    identities: Map<number, string>;
  } {
    try {
      const seen = new Set<number>();
      const frames: WebFrameMain[] = [];
      const identities = new Map<number, string>();
      for (const frame of contents.mainFrame.framesInSubtree) {
        if (frame.detached || frame.isDestroyed() || seen.has(frame.frameTreeNodeId)) continue;
        const identity = this.automationFrameIdentity(frame);
        // Frame identity access can race OOPIF teardown. Exclude a frame that
        // disappeared during the read instead of publishing a partial lease.
        if (frame.detached || frame.isDestroyed()) continue;
        seen.add(frame.frameTreeNodeId);
        frames.push(frame);
        identities.set(frame.frameTreeNodeId, identity);
      }
      if (frames.length === 0) throw new Error('no live frames');
      return { frames, identities };
    } catch {
      throw new Error('The browser page changed before assistant input could be attributed.');
    }
  }

  /** Main-to-renderer frame.send() is asynchronous. CDP input and native
   * insertText can otherwise reach the page before its isolated preload has
   * installed the one-shot provenance token. Wait for every currently live
   * frame to confirm the exact document identity before either dispatch path. */
  private async publishAutomationGestureArmAndWait(
    tab: InternalTab,
    contents: WebContents,
    arm: BrowserAutomationInputArm,
    abortSignal?: AbortSignal,
    documentLease?: AssistantDocumentLease,
    detached = true,
  ): Promise<void> {
    throwIfBrowserAborted(abortSignal);
    if (documentLease) this.assertAssistantDocumentLease(tab, documentLease);
    let frames: WebFrameMain[];
    let expectedFrames: Map<number, string>;
    try {
      const snapshot = this.snapshotAutomationFrames(contents);
      frames = snapshot.frames;
      expectedFrames = snapshot.identities;
    } catch {
      this.revokeAutomationGestureToken(arm.token);
      throw new Error('The browser page changed before assistant input could be attributed.');
    }
    const pendingGesture = this.automationGestureTokens.get(arm.token);
    if (
      !pendingGesture ||
      pendingGesture.tabId !== tab.shell.id ||
      pendingGesture.contentsId !== contents.id ||
      pendingGesture.confirmed
    ) {
      this.revokeAutomationGestureToken(arm.token);
      throw new Error('Attributed background browser input expired before its frames were armed.');
    }
    pendingGesture.armedFrames = new Map(expectedFrames);
    pendingGesture.detachedArm = detached;
    // A background view may become presented while its kind-only arm is being
    // prepared. Hide it before publication and keep it hidden until the arm is
    // consumed/revoked so a later mount transition cannot let real user input
    // steal the token.
    if (detached && this.attachedView === tab.view) this.detachAttachedView();

    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abortListener: (() => void) | undefined;
    let resolveAcknowledgement!: () => void;
    let rejectAcknowledgement!: (error: Error) => void;
    const acknowledgement = new Promise<void>((resolve, reject) => {
      resolveAcknowledgement = resolve;
      rejectAcknowledgement = reject;
    });
    const pending: PendingAutomationArmAcknowledgement = {
      tabId: tab.shell.id,
      contentsId: contents.id,
      expectedFrames,
      acknowledgedFrames: new Set(),
      settle: (error?: Error) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (abortSignal && abortListener) abortSignal.removeEventListener('abort', abortListener);
        if (this.pendingAutomationArmAcknowledgements.get(arm.token) === pending) {
          this.pendingAutomationArmAcknowledgements.delete(arm.token);
        }
        if (error) rejectAcknowledgement(error);
        else resolveAcknowledgement();
      },
    };
    this.pendingAutomationArmAcknowledgements.set(arm.token, pending);
    timer = setTimeout(
      () => pending.settle(new Error('The browser page did not acknowledge attributed assistant input in time.')),
      AUTOMATION_GESTURE_ACK_TIMEOUT_MS,
    );
    timer.unref?.();
    if (abortSignal) {
      abortListener = () => pending.settle(new Error('Browser input was cancelled.'));
      abortSignal.addEventListener('abort', abortListener, { once: true });
      if (abortSignal.aborted) abortListener();
    }

    if (!settled) {
      try {
        for (const frame of frames) frame.send('browser-page:arm-automation-input', arm);
      } catch {
        pending.settle(new Error('The browser page changed before assistant input could be attributed.'));
      }
    }
    await acknowledgement;
    if (documentLease) this.assertAssistantDocumentLease(tab, documentLease);
  }

  private isNativeBrowserPageFocused(contents: WebContents): boolean {
    // Electron WebContents provides isFocused(). Keeping this probe tolerant of
    // older/mocked hosts preserves safe background behavior in compatibility
    // environments without making renderer focus a sidebar-mount dependency.
    const isFocused = (contents as WebContents & { isFocused?: () => boolean }).isFocused;
    return typeof isFocused !== 'function' || isFocused.call(contents);
  }

  private isTargetViewPresented(tab: InternalTab, contents: WebContents): boolean {
    // Presentation is visual state, not an authority or focus prerequisite. An
    // already-open sidebar may keep mirroring AI activity while Kai is blurred;
    // this predicate never focuses Kai/page chrome, and an unmounted/hidden tab
    // takes the deterministic background path in prepareAssistantOperationView.
    return (
      this.isHostWindowShown() &&
      this.mountedConversationId === tab.shell.conversationId &&
      this.mountedBounds !== null &&
      this.activeTabs.get(tab.shell.conversationId) === tab.shell.id &&
      this.attachedView === tab.view &&
      tab.view?.webContents === contents &&
      !contents.isDestroyed()
    );
  }

  private isTargetViewInteractive(tab: InternalTab, contents: WebContents): boolean {
    return (
      !this.hasDispatchedSyntheticInput(tab, contents) &&
      this.isHostWindowInteractive() &&
      this.isTargetViewPresented(tab, contents) &&
      this.isNativeBrowserPageFocused(contents)
    );
  }

  /** Attribute an assistant gesture before dispatching it through CDP. This is
   * deliberately the only automation input path, including when the sidebar is
   * mounted and focused. */
  private async sendAttributedInputEvent(
    tab: InternalTab,
    contents: WebContents,
    input: Omit<BrowserAutomationInputArm, 'token' | 'expiresAt' | 'timestamp'>,
    _event: Electron.MouseInputEvent | Electron.MouseWheelInputEvent | Electron.KeyboardInputEvent,
    cdpCommand: BrowserCdpInputCommand,
    abortSignal?: AbortSignal,
    documentLease?: AssistantDocumentLease,
    beforeBackgroundDispatch?: () => Promise<void>,
    onDispatchStarted?: () => void,
  ): Promise<void> {
    let dispatchStarted = false;
    const markDispatchStarted = (): void => {
      const assistantOwnerId = tab.aiControlOwnerId;
      if (!assistantOwnerId) throw new Error('Assistant input lost ownership of this browser tab.');
      const pending = this.automationGestureTokens.get(arm.token);
      if (!pending || pending.confirmed || pending.expiresAt < Date.now()) {
        throw new Error('Attributed browser input expired before Chromium dispatch.');
      }
      // This assignment is immediately adjacent to the CDP sendCommand call in
      // dispatchCdpInputCommand. Before it flips, a matching trusted event is a
      // concurrent user event and cannot consume the assistant's arm.
      pending.dispatchStarted = true;
      // Install the delayed-input tombstone before Chromium can deliver the
      // trusted DOM event. A rejected or timed-out CDP command may still have
      // reached the renderer, so only exact preload confirmation may clear it.
      this.trackDispatchedSyntheticInput(tab, contents, arm);
      dispatchStarted = true;
      // Overwrite any recent real-user popup provenance before Chromium can
      // invoke page handlers. Confirmation will refine this with the exact
      // target frame, but a post-dispatch failure must never restore the stale
      // user gesture and let a resulting popup escape assistant ownership.
      this.rememberAssistantGesture(tab, assistantOwnerId, Date.now() + POPUP_GESTURE_PROVENANCE_MS, input.kind);
    };
    const attributedCommand = this.timestampCdpInputCommand(cdpCommand);
    const timestamp = attributedCommand.params.timestamp;
    if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) {
      throw new Error('Assistant browser input could not acquire a dispatch timestamp.');
    }
    const previousGesture = tab.popupGesture;
    const previousAssistantGesture = tab.assistantGesture;
    const detached = !this.isTargetViewPresented(tab, contents);
    const arm = this.createAutomationGestureArm(tab, contents, input, detached, timestamp);
    try {
      await this.publishAutomationGestureArmAndWait(tab, contents, arm, abortSignal, documentLease, detached);
      await beforeBackgroundDispatch?.();
      if (documentLease) this.assertAssistantDocumentLease(tab, documentLease);
      this.assertAutomationGestureReadyForDispatch(arm.token);
      await this.dispatchCdpInputCommand(
        tab,
        contents,
        attributedCommand,
        abortSignal,
        documentLease,
        markDispatchStarted,
        onDispatchStarted,
      );
      await this.waitForAutomationGestureConfirmation(tab, contents, arm.token, abortSignal, documentLease);
      if (!this.consumeAutomationGestureConfirmation(arm.token)) {
        throw new Error('Chromium did not confirm the attributed background browser input.');
      }
    } catch (error) {
      if (this.automationGestureTokens.get(arm.token)?.confirmed) {
        this.clearDispatchedSyntheticInput(contents.id, arm.token);
      }
      this.revokeAutomationGestureToken(arm.token);
      if (!dispatchStarted) {
        tab.popupGesture = previousGesture;
        tab.assistantGesture = previousAssistantGesture;
      }
      throw error;
    } finally {
      this.revokeAutomationGestureToken(arm.token);
      if (this.tabs.get(tab.shell.id) === tab) this.attachActiveView(tab.shell.conversationId);
    }
  }

  private async dispatchInputEvent(
    tab: InternalTab,
    contents: WebContents,
    event: Electron.MouseInputEvent | Electron.MouseWheelInputEvent | Electron.KeyboardInputEvent,
    cdpCommand: BrowserCdpInputCommand,
    abortSignal?: AbortSignal,
    documentLease?: AssistantDocumentLease,
  ): Promise<void> {
    if (event.type === 'mouseMove' && tab.aiControlOwnerId) {
      // mousemove is not a transient-activation gesture, so the page preload
      // intentionally does not report it through the one-shot input-token path.
      // It can still synchronously call window.open() from a move handler. Mark
      // that popup as assistant-originated before CDP dispatch
      // so it cannot inherit a recent real-user click's cached provenance and
      // become a foreground, user-owned tab.
      this.rememberAssistantGesture(tab, tab.aiControlOwnerId, Date.now() + POPUP_GESTURE_PROVENANCE_MS);
    }
    await this.dispatchCdpInputCommand(tab, contents, cdpCommand, abortSignal, documentLease);
  }

  private async releaseInputIfDocumentCurrent(
    tab: InternalTab,
    contents: WebContents,
    event: Electron.MouseInputEvent | Electron.KeyboardInputEvent,
    cdpCommand: BrowserCdpInputCommand,
    documentLease: AssistantDocumentLease,
  ): Promise<void> {
    // A hash or History API transition changes shell.url but retains the exact
    // renderer document and its pressed-input state. Release into that document
    // even when the ordinary assistant lease was invalidated by the URL change
    // or turn cancellation. A replacement document increments tab.generation
    // synchronously at did-start-navigation and is never eligible.
    if (
      contents.isDestroyed() ||
      this.tabs.get(tab.shell.id) !== tab ||
      tab.view?.webContents !== contents ||
      tab.generation !== documentLease.tabGeneration
    )
      return;
    try {
      // Ignore the operation's cancelled signal: this is bounded cleanup for an
      // input-down event Chromium already accepted.
      await this.dispatchInputEvent(tab, contents, event, cdpCommand);
    } catch {
      // Renderer teardown or debugger loss is itself sufficient to clear the
      // target's input state.
    }
  }

  private async insertAttributedText(
    tab: InternalTab,
    contents: WebContents,
    text: string,
    abortSignal?: AbortSignal,
    documentLease?: AssistantDocumentLease,
    beforeDispatchAfterArm?: () => Promise<void>,
  ): Promise<void> {
    const detached = !this.isTargetViewPresented(tab, contents);
    // Input.insertText is the only Chromium primitive that inserts arbitrary
    // Unicode and paste-sized values atomically, but it has no timestamp
    // parameter. Hidden input is quarantined from physical events. Presented
    // paste-sized input is instead protected by exact full-value matching in
    // main; a coincident physical event cannot consume the arm unless it carries
    // the same complete payload. Ordinary visible typing retains timestamped
    // single-code-point key events so pages receive natural keyboard behavior.
    const textUnits = Array.from(text);
    const useInsertText = detached || textUnits.length >= AUTOMATION_BULK_TEXT_THRESHOLD;
    const units = useInsertText ? [text] : textUnits;
    for (const unit of units) {
      const input = useInsertText
        ? {
            kind: 'input' as const,
            inputType: 'insertText',
            data: unit,
            timestampToleranceSeconds: AUTOMATION_GESTURE_ARM_MS / 1_000,
          }
        : { kind: 'keydown' as const, data: unit };
      const attributedCommand: BrowserCdpInputCommand = useInsertText
        ? { method: 'Input.insertText', params: { text: unit } }
        : this.timestampCdpInputCommand({
            method: 'Input.dispatchKeyEvent',
            params: { type: 'keyDown', key: unit, text: unit, unmodifiedText: unit },
          });
      const releaseCommand: BrowserCdpInputCommand | null = useInsertText
        ? null
        : { method: 'Input.dispatchKeyEvent', params: { type: 'keyUp', key: unit } };
      const timestamp = useInsertText ? Date.now() / 1_000 : attributedCommand.params.timestamp;
      if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) {
        throw new Error('Assistant browser text input could not acquire a dispatch timestamp.');
      }
      let dispatchStarted = false;
      let keyPressed = false;
      const previousGesture = tab.popupGesture;
      const previousAssistantGesture = tab.assistantGesture;
      const arm = this.createAutomationGestureArm(tab, contents, input, detached, timestamp);
      const markDispatchStarted = (): void => {
        const assistantOwnerId = tab.aiControlOwnerId;
        if (!assistantOwnerId) throw new Error('Assistant input lost ownership of this browser tab.');
        const pending = this.automationGestureTokens.get(arm.token);
        if (!pending || pending.confirmed || pending.expiresAt < Date.now()) {
          throw new Error('Attributed browser input expired before Chromium dispatch.');
        }
        pending.dispatchStarted = true;
        // Either input primitive can mutate the page before its CDP promise
        // settles. Retain attribution until the exact preload receipt or the
        // bounded renderer-reclamation deadline.
        this.trackDispatchedSyntheticInput(tab, contents, arm);
        dispatchStarted = true;
        this.rememberAssistantGesture(tab, assistantOwnerId, Date.now() + POPUP_GESTURE_PROVENANCE_MS, input.kind);
      };
      try {
        await this.publishAutomationGestureArmAndWait(tab, contents, arm, abortSignal, documentLease, detached);
        await beforeDispatchAfterArm?.();
        if (documentLease) this.assertAssistantDocumentLease(tab, documentLease);
        this.assertAutomationGestureReadyForDispatch(arm.token);
        await this.dispatchCdpInputCommand(
          tab,
          contents,
          attributedCommand,
          abortSignal,
          documentLease,
          markDispatchStarted,
          () => {
            keyPressed = releaseCommand !== null;
          },
        );
        await this.waitForAutomationGestureConfirmation(tab, contents, arm.token, abortSignal, documentLease);
        if (!this.consumeAutomationGestureConfirmation(arm.token)) {
          throw new Error('Chromium did not confirm the attributed browser text input.');
        }
      } catch (error) {
        if (this.automationGestureTokens.get(arm.token)?.confirmed) {
          this.clearDispatchedSyntheticInput(contents.id, arm.token);
        }
        this.revokeAutomationGestureToken(arm.token);
        if (!dispatchStarted) {
          tab.popupGesture = previousGesture;
          tab.assistantGesture = previousAssistantGesture;
        }
        throw error;
      } finally {
        this.revokeAutomationGestureToken(arm.token);
        if (keyPressed && releaseCommand && documentLease) {
          await this.releaseInputIfDocumentCurrent(
            tab,
            contents,
            { type: 'keyUp', keyCode: unit },
            releaseCommand,
            documentLease,
          );
        }
        if (this.tabs.get(tab.shell.id) === tab) this.attachActiveView(tab.shell.conversationId);
      }
    }
  }

  private async dispatchCdpInputCommand(
    tab: InternalTab,
    contents: WebContents,
    command: BrowserCdpInputCommand,
    abortSignal?: AbortSignal,
    documentLease?: AssistantDocumentLease,
    beforeDispatch?: () => void,
    onDispatchStarted?: () => void,
  ): Promise<void> {
    const timestampedCommand = this.timestampCdpInputCommand(command);
    await this.runRendererOperationWithDeadline(
      tab,
      contents,
      'Browser input',
      BROWSER_INPUT_TIMEOUT_MS,
      async () => {
        const releaseDebugger = this.acquireBrowserDebugger(contents);
        try {
          beforeDispatch?.();
          // CDP can deliver a down event and still reject or time out its
          // Promise. Mark it as potentially pressed immediately before invoking
          // sendCommand so the caller's finally path always attempts the matching
          // release in the surviving document.
          onDispatchStarted?.();
          await contents.debugger.sendCommand(timestampedCommand.method, timestampedCommand.params);
        } finally {
          releaseDebugger();
        }
      },
      abortSignal,
      documentLease,
    );
  }

  private handlePendingSyntheticInput(
    tab: InternalTab,
    contents: WebContents,
    event: Electron.Event,
    inputType: Electron.InputEvent['type'],
  ): void {
    const pending = this.pendingSyntheticInputs.get(contents.id);
    if (!pending || pending.tabId !== tab.shell.id || pending.expectedType !== inputType) return;
    this.pendingSyntheticInputs.delete(contents.id);
    try {
      this.publishAutomationGestureArm(contents, pending.arm);
    } catch (error) {
      pending.error = error instanceof Error ? error : new Error(String(error));
      event.preventDefault();
    }
  }

  private releaseAiNetworkRestrictionForUser(tab: InternalTab): void {
    tab.aiNetworkReleaseRequested = true;
    if (tab.aiNetworkReleaseTimer) {
      clearTimeout(tab.aiNetworkReleaseTimer);
      tab.aiNetworkReleaseTimer = null;
    }
    if (
      tab.scriptTainted ||
      tab.privateNetworkNewDocumentGuard ||
      tab.assistantNativeUiNewDocumentGuard ||
      tab.assistantDialogsDisabledRunId
    ) {
      tab.aiNetworkReleaseRequested = false;
      return;
    }
    const current = Date.now();
    if (tab.aiActionDepth > 0) return;
    if (!shouldReleaseAiNetworkRestriction(tab.aiActionDepth, tab.aiActionUntil, current, false)) {
      tab.aiNetworkReleaseTimer = setTimeout(
        () => {
          tab.aiNetworkReleaseTimer = null;
          if (this.tabs.get(tab.shell.id) === tab) this.releaseAiNetworkRestrictionForUser(tab);
        },
        Math.max(1, tab.aiActionUntil - current),
      );
      tab.aiNetworkReleaseTimer.unref?.();
      return;
    }
    tab.aiNetworkReleaseRequested = false;
    tab.aiNetworkRestricted = false;
    tab.aiControlOwnerId = null;
    tab.aiControlGeneration = null;
  }

  private beginTrustedUserNavigation(tab: InternalTab, targetUrl: string): number {
    const lease = tab.trustedUserNavigationLease + 1;
    if (tab.trustedUserNavigationTimer) clearTimeout(tab.trustedUserNavigationTimer);
    tab.trustedUserNavigationLease = lease;
    tab.trustedUserNavigation = true;
    tab.trustedUserNavigationTarget = targetUrl;
    tab.trustedUserNavigationRequestId = null;
    tab.trustedUserNavigationTimer = setTimeout(() => {
      if (this.tabs.get(tab.shell.id) !== tab || tab.trustedUserNavigationLease !== lease) return;
      tab.trustedUserNavigationTimer = null;
      // The deadline only bounds a chrome command that Chromium never claimed.
      // Once the exact main-frame request exists, redirects/authentication can
      // legitimately remain pending for much longer. Its commit, failure, or
      // conversion into a download owns the remaining authority lifetime.
      if (tab.trustedUserNavigationRequestId === null) this.clearTrustedUserNavigation(tab, lease);
    }, TRUSTED_USER_NAVIGATION_AUTHORITY_MS);
    tab.trustedUserNavigationTimer.unref?.();
    return lease;
  }

  private clearTrustedUserNavigation(tab: InternalTab, lease?: number): boolean {
    if (lease !== undefined && tab.trustedUserNavigationLease !== lease) return false;
    if (tab.trustedUserNavigationTimer) clearTimeout(tab.trustedUserNavigationTimer);
    tab.trustedUserNavigationTimer = null;
    tab.trustedUserNavigation = false;
    tab.trustedUserNavigationTarget = null;
    tab.trustedUserNavigationRequestId = null;
    return true;
  }

  private completeTrustedUserNavigation(tab: InternalTab, committedUrl: string, replacesDocument = true): void {
    if (!isTrustedUserNavigationCommit(tab.trustedUserNavigation, tab.trustedUserNavigationTarget, committedUrl))
      return;
    const lease = tab.trustedUserNavigationLease;
    if (!this.clearTrustedUserNavigation(tab, lease)) return;
    // A same-document hash/history commit leaves every script from the
    // assistant-selected document alive. It proves a real user gesture, but it
    // is not a safe authority boundary for private-network access. Only a
    // committed replacement document (`did-navigate`) may release the guard.
    if (replacesDocument) this.releaseAiNetworkRestrictionForUser(tab);
  }

  private invalidatePhysicalAssistantActions(tab: InternalTab | undefined): void {
    if (!tab) return;
    tab.trustedGestureGeneration = (tab.trustedGestureGeneration ?? 0) + 1;
  }

  private invalidateVisibleAssistantOperations(tab: InternalTab | undefined): void {
    if (!tab) return;
    tab.visibleAssistantGeneration = (tab.visibleAssistantGeneration ?? 0) + 1;
  }

  private isHostWindowShown(): boolean {
    const win = this.getWindow();
    return !!win && !win.isDestroyed() && win.isVisible() && !win.isMinimized();
  }

  /** `activeTabs` is a remembered chrome selection, not proof that the user is
   * currently viewing that tab. Headless/background automation must not be
   * blocked by stale presentation state from an unmounted panel, another chat,
   * or a minimized Kai window. */
  private isTabPresentedToUser(tab: InternalTab): boolean {
    return (
      this.mountedConversationId === tab.shell.conversationId &&
      this.mountedBounds !== null &&
      this.activeTabs.get(tab.shell.conversationId) === tab.shell.id &&
      this.isHostWindowShown()
    );
  }

  private isHostWindowInteractive(): boolean {
    const win = this.getWindow();
    return !!win && !win.isDestroyed() && win.isVisible() && !win.isMinimized() && win.isFocused();
  }

  /** Native dialogs are user presentation, never background Browser work.
   * Revalidate the exact tab and panel generation after every asynchronous
   * preparation step so a stale click cannot surface UI over another chat or
   * after the Browser panel or window has gone away. */
  private hasBrowserNativeDialogAuthority(
    tab: InternalTab,
    contents: WebContents,
    panelAuthorityGeneration: number,
  ): boolean {
    const conversationId = tab.shell.conversationId;
    if (
      panelAuthorityGeneration !== this.panelAuthorityGeneration(conversationId) ||
      this.activeTabs.get(conversationId) !== tab.shell.id ||
      !this.isHostWindowInteractive()
    ) {
      return false;
    }
    if (this.chromeFocusConversationId === conversationId) return true;
    return this.isTargetViewPresented(tab, contents) && this.isNativeBrowserPageFocused(contents);
  }

  /** Acquire manager ownership of the target debugger until the returned
   * one-shot release is called. All manager CDP users share this lease set so a
   * panel mount may restore viewport metrics concurrently without detaching an
   * assistant action, screenshot, sensitivity scan, or document guard. */
  private acquireBrowserDebuggerLease(contents: WebContents): BrowserDebuggerLease {
    // Unit fixtures construct BrowserManager without its constructor. Lazily
    // initialize this field as well as declaring it above so those focused
    // tests exercise the same ownership behavior.
    this.debuggerOwnership ??= new WeakMap<WebContents, BrowserDebuggerOwnership>();
    let ownership = this.debuggerOwnership.get(contents);
    if (ownership && !contents.debugger.isAttached()) {
      // The old transport was detached externally or by cancellation, so every
      // command from that generation has already failed. Give new work an
      // independent ownership object; stale releases must not affect it.
      this.debuggerOwnership.delete(contents);
      ownership = undefined;
    }
    if (!ownership) {
      const detachWhenIdle = !contents.debugger.isAttached();
      if (detachWhenIdle) contents.debugger.attach('1.3');
      ownership = { leases: new Set(), detachWhenIdle };
      this.debuggerOwnership.set(contents, ownership);
    }
    const state: BrowserDebuggerLeaseState = { cancelled: false, released: false };
    ownership.leases.add(state);
    const release = () => {
      if (state.released) return;
      state.released = true;
      ownership!.leases.delete(state);
      this.settleBrowserDebuggerOwnership(contents, ownership!);
    };
    return {
      release,
      cancel: () => {
        if (state.released || this.debuggerOwnership.get(contents) !== ownership) return;
        state.cancelled = true;
        this.settleBrowserDebuggerOwnership(contents, ownership!);
      },
    };
  }

  private acquireBrowserDebugger(contents: WebContents): () => void {
    return this.acquireBrowserDebuggerLease(contents).release;
  }

  /** Release an idle manager transport, or cancel it once every remaining lease
   * belongs to bounded work that has requested cancellation. Electron exposes
   * one debugger transport per WebContents, so a cancelled lease must remain
   * pending while any unrelated command still owns the shared session. */
  private settleBrowserDebuggerOwnership(contents: WebContents, ownership: BrowserDebuggerOwnership): void {
    if (this.debuggerOwnership.get(contents) !== ownership) return;
    const idle = ownership.leases.size === 0;
    const onlyCancelledLeasesRemain =
      ownership.detachWhenIdle && !idle && [...ownership.leases].every((lease) => lease.cancelled);
    if (!idle && !onlyCancelledLeasesRemain) return;
    this.debuggerOwnership.delete(contents);
    if (!ownership.detachWhenIdle) return;
    try {
      if (!contents.isDestroyed() && contents.debugger.isAttached()) contents.debugger.detach();
    } catch {
      // The target may have closed concurrently with debugger cleanup.
    }
  }

  /** JavaScript dialogs are native, modal UI and can otherwise make a hidden
   * automation target wait for user intervention. Keep suppression scoped to
   * assistant capability leases; releasing the final lease removes the CDP
   * listener and restores ordinary Chromium behavior without recreating the
   * user's page. Dialog text is deliberately never copied into errors or logs. */
  private ensureAssistantRunDialogGuard(tab: InternalTab, runId: string): AssistantDialogGuard {
    const existingToken = tab.assistantRunDialogGuardLease;
    const existingGuard = tab.assistantDialogGuard;
    if (
      existingToken &&
      existingGuard?.runId === runId &&
      !existingGuard.settled &&
      existingGuard.owners.has(existingToken)
    ) {
      return existingGuard;
    }
    // A settled/replaced guard disposes its own target registrations in
    // acquireAssistantDialogGuard. Do not let a stale token masquerade as the
    // new run-lifetime owner.
    tab.assistantRunDialogGuardLease = undefined;
    const lease = this.acquireAssistantDialogGuard(tab, runId);
    tab.assistantRunDialogGuardLease = lease.token;
    return lease.guard;
  }

  private acquireAssistantDialogGuard(tab: InternalTab, runId: string): { guard: AssistantDialogGuard; token: symbol } {
    let guard = tab.assistantDialogGuard;
    if (guard && (guard.runId !== runId || guard.settled)) {
      // A replacement guard waits on the per-WebContents restoration promise
      // before installing interception again. Observe the aggregate here; the
      // restore path itself unloads a target that cannot be made safe.
      void this.disposeAssistantDialogGuard(tab, guard).catch(() => undefined);
      guard = undefined;
    }
    if (!guard) {
      let reject!: (error: Error) => void;
      const failure = new Promise<never>((_resolve, rejectPromise) => {
        reject = rejectPromise;
      });
      // A popup bootstrap guard has no direct caller awaiting the failure. Keep
      // its rejection observed while still returning the original promise to
      // active assistant operations through Promise.race().
      void failure.catch(() => undefined);
      guard = {
        runId,
        owners: new Set(),
        protectedContents: new Map(),
        failure,
        reject,
        handlingDialog: false,
        settled: false,
      };
      tab.assistantDialogGuard = guard;
    }
    const token = Symbol('assistant-dialog-guard');
    guard.owners.add(token);
    return { guard, token };
  }

  private failAssistantDialogGuard(tab: InternalTab, guard: AssistantDialogGuard, error: Error): void {
    if (tab.assistantDialogGuard !== guard || guard.settled) return;
    guard.settled = true;
    tab.shell.error = error.message;
    this.emitTabs(tab.shell.conversationId);
    guard.reject(error);
  }

  private async protectAssistantDialogs(
    tab: InternalTab,
    contents: WebContents,
    expectedGuard: AssistantDialogGuard = tab.assistantDialogGuard!,
  ): Promise<void> {
    const guard = tab.assistantDialogGuard;
    if (guard === expectedGuard && guard.settled) return guard.failure;
    if (!guard || guard !== expectedGuard) {
      throw new Error('Assistant dialog protection expired before Browser control began.');
    }
    const existing = guard.protectedContents.get(contents);
    if (existing) return existing.ready;
    if (contents.isDestroyed()) throw new Error('The browser page closed before dialog protection began.');

    const priorRestore = this.assistantDialogProtectionRestores?.get(contents.id);
    const releaseDebugger = this.acquireBrowserDebugger(contents);
    const onMessage = (_event: unknown, method: string, params: unknown): void => {
      if (
        method === 'Page.fileChooserOpened' &&
        tab.assistantDialogGuard === guard &&
        !guard.settled &&
        !guard.handlingDialog
      ) {
        guard.handlingDialog = true;
        this.failAssistantDialogGuard(
          tab,
          guard,
          new Error('The page opened a native file chooser during assistant control; Kai cancelled it.'),
        );
        return;
      }
      if (
        method !== 'Page.javascriptDialogOpening' ||
        tab.assistantDialogGuard !== guard ||
        guard.settled ||
        guard.handlingDialog
      )
        return;
      guard.handlingDialog = true;
      const reportedType =
        params && typeof params === 'object' && typeof (params as { type?: unknown }).type === 'string'
          ? (params as { type: string }).type
          : '';
      const dialogType = ['alert', 'confirm', 'prompt', 'beforeunload'].includes(reportedType)
        ? reportedType
        : 'JavaScript';
      const blocked = new Error(
        `The page opened a blocking ${dialogType} dialog during assistant control; Kai blocked it and attempted to dismiss it.`,
      );
      // Revoke the operation synchronously. Waiting for the asynchronous CDP
      // acknowledgement creates a window in which a fast operation can report
      // success after the page has already opened modal native UI.
      this.failAssistantDialogGuard(tab, guard, blocked);
      void this.runRendererOperationWithDeadline(
        tab,
        contents,
        'Browser JavaScript dialog dismissal',
        ASSISTANT_DIALOG_CDP_TIMEOUT_MS,
        () => contents.debugger.sendCommand('Page.handleJavaScriptDialog', { accept: false }).then(() => undefined),
      ).then(
        () => undefined,
        () => {
          if (this.tabs.get(tab.shell.id) === tab && tab.view?.webContents === contents && !contents.isDestroyed()) {
            tab.generation++;
            this.destroyView(tab);
            tab.shell.discarded = true;
            tab.shell.sensitive = false;
            this.emitTabs(tab.shell.conversationId);
          }
        },
      );
    };
    const protectedContents = {
      onMessage,
      ready: Promise.resolve(),
      releaseDebugger,
    };
    guard.protectedContents.set(contents, protectedContents);
    contents.debugger.on('message', onMessage);
    protectedContents.ready = (async () => {
      try {
        if (priorRestore) await priorRestore;
        if (tab.assistantDialogGuard !== guard || !guard.owners.size || contents.isDestroyed()) {
          throw new Error('Assistant dialog protection expired while Browser control was being prepared.');
        }
        await this.runRendererOperationWithDeadline(
          tab,
          contents,
          'Browser JavaScript dialog protection',
          ASSISTANT_DIALOG_CDP_TIMEOUT_MS,
          () => contents.debugger.sendCommand('Page.enable').then(() => undefined),
        );
        if (tab.assistantDialogGuard !== guard || !guard.owners.size || contents.isDestroyed()) {
          throw new Error('Assistant dialog protection expired while Browser control was being prepared.');
        }
        await this.runRendererOperationWithDeadline(
          tab,
          contents,
          'Browser native file chooser protection',
          ASSISTANT_DIALOG_CDP_TIMEOUT_MS,
          () =>
            contents.debugger
              .sendCommand('Page.setInterceptFileChooserDialog', { enabled: true, cancel: true })
              .then(() => undefined),
        );
        if (guard.settled) return guard.failure;
        if (tab.assistantDialogGuard !== guard || !guard.owners.size || contents.isDestroyed()) {
          throw new Error('Assistant dialog protection expired while Browser control was being prepared.');
        }
      } catch (error) {
        if (guard.protectedContents.get(contents) === protectedContents) {
          guard.protectedContents.delete(contents);
          try {
            contents.debugger.off('message', onMessage);
          } catch {
            // The target may have closed while Page.enable was pending.
          }
          releaseDebugger();
        }
        if (error instanceof Error && /^Assistant dialog protection expired/.test(error.message)) throw error;
        if (guard.settled) return guard.failure;
        throw new Error('Kai could not enable fail-closed native dialog handling for this browser page.', {
          cause: error,
        });
      }
    })();
    void protectedContents.ready.catch(() => undefined);
    return protectedContents.ready;
  }

  private unprotectAssistantDialogs(tab: InternalTab, contents: WebContents): void {
    const guard = tab.assistantDialogGuard;
    const protectedContents = guard?.protectedContents.get(contents);
    if (!guard || !protectedContents) return;
    guard.protectedContents.delete(contents);
    try {
      contents.debugger.off('message', protectedContents.onMessage);
    } catch {
      // A destroyed WebContents may reject listener mutation during teardown.
    }
    void this.restoreAssistantDialogBehavior(tab, contents, protectedContents.releaseDebugger).catch(() => undefined);
  }

  private restoreAssistantDialogBehavior(
    tab: InternalTab,
    contents: WebContents,
    releaseDebugger: () => void,
  ): Promise<void> {
    if (contents.isDestroyed()) {
      releaseDebugger();
      return Promise.resolve();
    }
    const restores = (this.assistantDialogProtectionRestores ??= new Map());
    const previous = restores.get(contents.id) ?? Promise.resolve();
    const restore = previous
      .catch(() => undefined)
      .then(() =>
        this.runRendererOperationWithDeadline(
          tab,
          contents,
          'Browser native file chooser restoration',
          ASSISTANT_DIALOG_CDP_TIMEOUT_MS,
          () =>
            contents.debugger
              .sendCommand('Page.setInterceptFileChooserDialog', { enabled: false })
              .then(() => undefined),
        ),
      )
      .catch((error: unknown) => {
        if (this.tabs.get(tab.shell.id) === tab && tab.view?.webContents === contents && !contents.isDestroyed()) {
          tab.generation++;
          this.destroyView(tab);
          tab.shell.discarded = true;
          tab.shell.sensitive = false;
          tab.shell.error = 'Kai could not restore native file chooser behavior, so the page was unloaded.';
          this.emitTabs(tab.shell.conversationId);
        }
        throw error;
      })
      .finally(() => {
        releaseDebugger();
        if (restores.get(contents.id) === restore) restores.delete(contents.id);
      });
    restores.set(contents.id, restore);
    void restore.catch(() => undefined);
    return restore;
  }

  private releaseAssistantDialogGuard(tab: InternalTab, token: symbol): Promise<void> {
    const guard = tab.assistantDialogGuard;
    if (!guard) return Promise.resolve();
    guard.owners.delete(token);
    return guard.owners.size === 0 ? this.disposeAssistantDialogGuard(tab, guard) : Promise.resolve();
  }

  private disposeAssistantDialogGuard(tab: InternalTab, guard: AssistantDialogGuard): Promise<void> {
    if (tab.assistantDialogGuard === guard) tab.assistantDialogGuard = undefined;
    guard.owners.clear();
    const restores: Promise<void>[] = [];
    for (const [contents, protectedContents] of guard.protectedContents) {
      try {
        contents.debugger.off('message', protectedContents.onMessage);
      } catch {
        // Best-effort cleanup during renderer teardown.
      }
      restores.push(this.restoreAssistantDialogBehavior(tab, contents, protectedContents.releaseDebugger));
    }
    guard.protectedContents.clear();
    return Promise.all(restores).then(() => undefined);
  }

  private panelAuthorityGeneration(conversationId: string): number {
    return this.panelAuthorityGenerations.get(conversationId) ?? 0;
  }

  private invalidatePanelAuthority(conversationId: string): void {
    this.panelAuthorityGenerations.set(conversationId, this.panelAuthorityGeneration(conversationId) + 1);
  }

  private panelLayoutGeneration(conversationId: string): number {
    return this.panelLayoutGenerations.get(conversationId) ?? 0;
  }

  private invalidatePanelLayout(conversationId: string): void {
    this.panelLayoutGenerations.set(conversationId, this.panelLayoutGeneration(conversationId) + 1);
  }

  private captureInputCoordinateLease(view: WebContentsView, lockZoom = true): BrowserInputCoordinateLease {
    const lease = {
      bounds: view.getBounds(),
      zoomFactor: view.webContents.getZoomFactor(),
      lockZoom,
    };
    const leases =
      (this.inputCoordinateSurfaceLeases ??= new WeakMap<WebContentsView, Set<BrowserInputCoordinateLease>>()).get(
        view,
      ) ?? new Set<BrowserInputCoordinateLease>();
    leases.add(lease);
    this.inputCoordinateSurfaceLeases.set(view, leases);
    return lease;
  }

  private assertInputCoordinateLease(view: WebContentsView, lease: BrowserInputCoordinateLease): void {
    const bounds = view.getBounds();
    if (
      !this.inputCoordinateSurfaceLeases?.get(view)?.has(lease) ||
      bounds.x !== lease.bounds.x ||
      bounds.y !== lease.bounds.y ||
      bounds.width !== lease.bounds.width ||
      bounds.height !== lease.bounds.height ||
      (lease.lockZoom && view.webContents.getZoomFactor() !== lease.zoomFactor)
    ) {
      // Raw coordinates name one exact viewport surface. Retargeting them after
      // a real resize or zoom change could click an unrelated control. Pure
      // presentation detach/switch transitions preserve the leased surface.
      throw new Error('The Browser viewport or zoom changed before coordinate input. Retry the action.');
    }
  }

  private hasInputCoordinateSurfaceLease(view: WebContentsView): boolean {
    return (this.inputCoordinateSurfaceLeases?.get(view)?.size ?? 0) > 0;
  }

  private hasStableNativeSurfaceLease(view: WebContentsView): boolean {
    return this.hasInputCoordinateSurfaceLease(view);
  }

  private releaseInputCoordinateLease(view: WebContentsView, lease: BrowserInputCoordinateLease | null): void {
    if (!lease) return;
    const leases = this.inputCoordinateSurfaceLeases?.get(view);
    if (!leases?.delete(lease)) return;
    if (leases.size > 0) return;
    this.inputCoordinateSurfaceLeases?.delete(view);

    const mappedTabId = this.webContentsToTab?.get(view.webContents.id);
    const tab =
      (mappedTabId ? this.tabs.get(mappedTabId) : undefined) ??
      [...(this.tabs?.values() ?? [])].find((candidate) => candidate.view === view);
    if (!tab || tab.view !== view || view.webContents.isDestroyed()) return;
    const shouldPresent =
      this.mountedConversationId === tab.shell.conversationId &&
      this.mountedBounds !== null &&
      this.activeTabs.get(tab.shell.conversationId) === tab.shell.id;
    if (shouldPresent) {
      this.attachActiveView(tab.shell.conversationId);
      return;
    }
    if (this.attachedView === view) this.attachedView = null;
    try {
      view.setVisible(false);
      view.setBounds(DEFAULT_DETACHED_VIEW_BOUNDS);
    } catch {
      // The target can close while its final attributed input is unwinding.
    }
  }

  private notifyPanelStateChanged(conversationId: string): void {
    for (const waiter of [...(this.panelStateWaiters.get(conversationId) ?? [])]) waiter();
  }

  private async prepareAssistantOperationView(
    tab: InternalTab,
    view: WebContentsView,
    abortSignal: AbortSignal | undefined,
    documentLease: AssistantDocumentLease,
    assertOperationAuthority: () => void = () => undefined,
  ): Promise<boolean> {
    if (this.disposed || this.shuttingDown) throw new Error('The in-app browser is unavailable.');
    throwIfBrowserAborted(abortSignal);
    this.assertAssistantDocumentLease(tab, documentLease);
    assertOperationAuthority();
    // Presentation never gates assistant work. Preserve an already-presented
    // target so the user can watch its cursor, typing, and scrolling live; every
    // hidden, unmounted, inactive, or never-mounted target instead uses the same
    // deterministic background surface below.
    const presented = this.isTargetViewPresented(tab, view.webContents);
    if (presented) {
      view.setBounds(this.mountedBounds!);
      view.setVisible(true);
      return true;
    }
    if (this.attachedView === view) this.detachAttachedView();
    view.setVisible(false);
    view.setBounds(DEFAULT_DETACHED_VIEW_BOUNDS);
    await this.enableAssistantBackgroundViewport(tab, view.webContents, abortSignal, documentLease);
    return false;
  }

  private emit(event: BrowserEvent): void {
    const win = this.getWindow();
    if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send('browser:event', event);
  }

  private emitTabs(conversationId: string): void {
    // Favicons are bounded but still much larger than ordinary tab metadata.
    // Preserve them in getState(), while sending them through a dedicated event
    // so title/loading churn cannot retransmit every icon in the tab strip.
    const tabs = this.listTabs(conversationId).map((tab) => {
      const { favicon: _favicon, ...metadata } = tab;
      return metadata;
    });
    this.emit({ type: 'tabs-changed', conversationId, tabs });
  }

  private emitTabFavicon(tab: InternalTab): void {
    this.emit({
      type: 'tab-favicon',
      conversationId: tab.shell.conversationId,
      tabId: tab.shell.id,
      favicon: tab.shell.favicon ?? null,
    });
  }

  private emitBookmarks(conversationId: string): void {
    this.emit({ type: 'bookmarks-changed', conversationId });
  }

  private conversationsForScope(scopeKey: string, originatingConversationId?: string): Set<string> {
    const conversations = new Set<string>();
    if (originatingConversationId) conversations.add(originatingConversationId);
    for (const candidate of this.tabOrder?.keys() ?? []) {
      if (this.removedConversations.has(candidate)) continue;
      if (this.scopeKey(candidate) === scopeKey) conversations.add(candidate);
    }
    if (
      this.mountedConversationId &&
      !this.removedConversations.has(this.mountedConversationId) &&
      this.scopeKey(this.mountedConversationId) === scopeKey
    ) {
      conversations.add(this.mountedConversationId);
    }
    return conversations;
  }

  private emitBookmarksForScope(conversationId: string): void {
    const scopeKey = this.scopeKey(conversationId);
    for (const candidate of this.conversationsForScope(scopeKey, conversationId)) this.emitBookmarks(candidate);
  }

  private emitDownloadForScope(scopeKey: string, conversationId: string, download: BrowserDownload): void {
    for (const candidate of this.conversationsForScope(scopeKey, conversationId)) {
      this.emit({ type: 'download', conversationId: candidate, download });
    }
  }

  private emitDownloadHistoryChangedForScope(
    scopeKey: string,
    conversationId: string | undefined,
    downloadId: string,
    change: 'deleted' | 'unavailable',
  ): void {
    for (const candidate of this.conversationsForScope(scopeKey, conversationId)) {
      this.emit({ type: 'download-history-changed', conversationId: candidate, downloadId, change });
    }
  }

  private emitProfileErrorForScope(scopeKey: string, area: BrowserProfilePersistenceArea, error: Error): void {
    const label =
      area === 'history' ? 'Browsing history' : area === 'downloads' ? 'Download history' : 'Browser profile';
    const message = `${label} could not be saved: ${error.message}`;
    for (const conversationId of this.conversationsForScope(scopeKey)) {
      this.emit({ type: 'profile-error', conversationId, area, message });
    }
  }

  private emitPromptDismissed(
    conversationId: string,
    promptId: string,
    promptKind: 'credential' | 'permission' | 'auth',
  ): void {
    this.emit({
      type: 'prompt-dismissed',
      conversationId,
      promptId,
      promptKind,
    });
  }

  private canQueuePrompt(tabId: string): boolean {
    return hasBrowserPromptCapacity(
      [
        ...[...this.pendingCredentials.values()].map((pending) => pending.tabId),
        ...[...this.pendingPermissions.values()].map((pending) => pending.tabId),
        ...[...this.pendingAuth.values()].map((pending) => pending.tabId),
      ],
      tabId,
      MAX_PENDING_PROMPTS_PER_TAB,
      MAX_PENDING_PROMPTS_TOTAL,
    );
  }

  private setTabSensitive(tab: InternalTab, sensitive: boolean): void {
    if (tab.shell.sensitive === sensitive) return;
    tab.shell.sensitive = sensitive;
    this.emit({
      type: 'credential-sensitive',
      conversationId: tab.shell.conversationId,
      tabId: tab.shell.id,
      sensitive,
    });
    this.emitTabs(tab.shell.conversationId);
  }

  private async assertTabNotSensitive(
    tab: InternalTab,
    contents: WebContents,
    operation: string,
    abortSignal?: AbortSignal,
    documentLease?: AssistantDocumentLease,
    totalTimeoutMs?: number,
    reclaimTargetOnCancellation = true,
    captureDebuggerLease?: (lease: BrowserDebuggerLease) => void,
  ): Promise<void> {
    if (tab.shell.sensitive) {
      throw new Error(`${operation} is blocked while this tab contains password data.`);
    }
    const deadlineAt = totalTimeoutMs === undefined ? null : Date.now() + Math.max(1, totalTimeoutMs);
    const remainingTimeout = (): number => {
      if (deadlineAt === null) return EVALUATE_TIMEOUT_MS;
      const remaining = Math.ceil(deadlineAt - Date.now());
      if (remaining <= 0) throw new BrowserRendererDeadlineError(operation, totalTimeoutMs!);
      return remaining;
    };
    let sensitive = (await this.evaluateWithDeadline(
      tab,
      contents,
      SENSITIVE_SCAN_SCRIPT,
      abortSignal,
      documentLease,
      remainingTimeout(),
      reclaimTargetOnCancellation,
      captureDebuggerLease,
    )) as boolean;
    if (!sensitive) {
      // executeJavaScript has no cancellation primitive. If the enclosing
      // deadline wins while a child-frame probe is pending, that abandoned
      // continuation must not subsequently acquire a fresh debugger lease and
      // start an OOPIF scan after its caller has already returned.
      let passwordFieldScanCurrent = true;
      try {
        sensitive = await this.runRendererOperationWithDeadline(
          tab,
          contents,
          'Browser password-field scan',
          remainingTimeout(),
          async () => {
            if (await this.hasPopulatedPasswordFieldInChildFrames(contents)) return true;
            if (!passwordFieldScanCurrent) return true;
            return this.hasPopulatedPasswordFieldViaCdp(contents, captureDebuggerLease);
          },
          abortSignal,
          documentLease,
          reclaimTargetOnCancellation,
        );
      } finally {
        passwordFieldScanCurrent = false;
      }
    }
    if (sensitive) this.setTabSensitive(tab, true);
    if (tab.shell.sensitive) throw new Error(`${operation} is blocked while this tab contains password data.`);
  }

  /** `webContents.executeJavaScript` evaluates only the top document. Execute
   * the value-only probe in every live child WebFrameMain as well, including
   * cross-origin OOPIFs. Any frame-enumeration/evaluation ambiguity fails closed;
   * no field value or page-controlled string crosses into main. */
  private async hasPopulatedPasswordFieldInChildFrames(contents: WebContents): Promise<boolean> {
    let childFrames: WebFrameMain[];
    try {
      const mainFrameTreeNodeId = contents.mainFrame.frameTreeNodeId;
      const seen = new Set<number>();
      childFrames = contents.mainFrame.framesInSubtree.filter((frame) => {
        if (
          frame.detached ||
          frame.isDestroyed() ||
          frame.frameTreeNodeId === mainFrameTreeNodeId ||
          seen.has(frame.frameTreeNodeId)
        ) {
          return false;
        }
        seen.add(frame.frameTreeNodeId);
        return true;
      });
    } catch {
      return true;
    }
    if (childFrames.length > MAX_CDP_SENSITIVE_SCAN_TARGETS) return true;
    const results = await Promise.all(
      childFrames.map((frame) =>
        frame.executeJavaScript(SENSITIVE_SCAN_SCRIPT).then(
          (value) => (typeof value === 'boolean' ? value : true),
          () => true,
        ),
      ),
    );
    return results.some(Boolean);
  }

  /** CDP pierces closed author shadow roots, unlike page-world
   * `element.shadowRoot`. Treat the presence of any author closed root as
   * sensitive (including empty/declarative roots), then separately catch
   * populated password fields and show-password controls. Values never cross
   * into main. Both document size and operation time are bounded; oversized or
   * malformed results fail closed. */
  private async hasPopulatedPasswordFieldViaCdp(
    contents: WebContents,
    captureDebuggerLease?: (lease: BrowserDebuggerLease) => void,
  ): Promise<boolean> {
    const debuggerLease = this.acquireBrowserDebuggerLease(contents);
    const budget: CdpSensitiveScanBudget = {
      elementsRemaining: MAX_DOM_ELEMENTS_FOR_CDP_SENSITIVE_SCAN,
      nodesRemaining: MAX_DOM_NODES_FOR_CDP_SENSITIVE_SCAN,
      inputsRemaining: MAX_INPUT_FIELDS_FOR_CDP_SCAN,
    };
    try {
      captureDebuggerLease?.(debuggerLease);
      if (await this.scanSensitiveCdpSession(contents, budget)) return true;

      const oopifFrameTreeNodeIds = this.liveOopifFrameTreeNodeIds(contents);
      if (oopifFrameTreeNodeIds === null) return true;
      if (oopifFrameTreeNodeIds.size === 0) return false;
      if (oopifFrameTreeNodeIds.size > MAX_CDP_SENSITIVE_SCAN_TARGETS) return true;
      return await this.hasSensitiveRelatedOopifTarget(contents, budget, oopifFrameTreeNodeIds);
    } finally {
      debuggerLease.release();
    }
  }

  private liveOopifFrameTreeNodeIds(contents: WebContents): Set<number> | null {
    try {
      const mainProcessId = contents.mainFrame.processId;
      return new Set(
        contents.mainFrame.framesInSubtree
          .filter((frame) => !frame.detached && !frame.isDestroyed() && frame.processId !== mainProcessId)
          .map((frame) => frame.frameTreeNodeId),
      );
    } catch {
      return null;
    }
  }

  private async scanSensitiveCdpSession(
    contents: WebContents,
    budget: CdpSensitiveScanBudget,
    sessionId?: string,
  ): Promise<boolean> {
    const searchIds = new Set<string>();
    const objectGroup = `kai-sensitive-${randomUUID()}`;
    const send = (method: string, params?: Record<string, unknown>): Promise<unknown> =>
      sessionId
        ? contents.debugger.sendCommand(method, params, sessionId)
        : contents.debugger.sendCommand(method, params);
    try {
      await send('DOM.enable');
      // Count author elements before asking CDP for the flattened tree. This
      // avoids materializing an adversarially large document merely to discover
      // that it exceeds the safety budget. User-agent roots are excluded from
      // the count and ignored below; native controls commonly use closed UA
      // shadows and do not imply author-hidden credential state.
      const documentSearch = (await send('DOM.performSearch', {
        query: '*',
        includeUserAgentShadowDOM: false,
      })) as { searchId?: string; resultCount?: number };
      if (documentSearch.searchId) searchIds.add(documentSearch.searchId);
      const documentElementCount = documentSearch.resultCount ?? 0;
      if (!Number.isSafeInteger(documentElementCount) || documentElementCount < 0) {
        throw new Error('Browser closed-shadow scan returned an invalid element count.');
      }
      if (documentElementCount > budget.elementsRemaining) return true;
      budget.elementsRemaining -= documentElementCount;
      if (documentElementCount > 0 && !documentSearch.searchId) {
        throw new Error('Browser closed-shadow scan did not return a search handle.');
      }
      const flattened = (await send('DOM.getFlattenedDocument', {
        depth: -1,
        pierce: true,
      })) as { nodes?: Array<{ shadowRootType?: string }> };
      if (!Array.isArray(flattened.nodes)) {
        throw new Error('Browser closed-shadow scan returned an invalid document.');
      }
      if (flattened.nodes.length > budget.nodesRemaining) return true;
      budget.nodesRemaining -= flattened.nodes.length;
      if (flattened.nodes.some((node) => node.shadowRootType === 'closed')) return true;

      const search = (await send('DOM.performSearch', {
        query: 'input',
        includeUserAgentShadowDOM: true,
      })) as { searchId?: string; resultCount?: number };
      if (search.searchId) searchIds.add(search.searchId);
      const resultCount = search.resultCount ?? 0;
      if (!Number.isSafeInteger(resultCount) || resultCount < 0) {
        throw new Error('Browser password-field scan returned an invalid result count.');
      }
      if (resultCount <= 0) return false;
      if (!search.searchId) throw new Error('Browser password-field scan did not return a search handle.');
      // A normal page has at most a handful. Fail closed on an adversarially
      // large result rather than issuing unbounded synchronous debugger calls.
      if (resultCount > budget.inputsRemaining) return true;
      budget.inputsRemaining -= resultCount;
      const results = (await send('DOM.getSearchResults', {
        searchId: search.searchId,
        fromIndex: 0,
        toIndex: resultCount,
      })) as { nodeIds?: number[] };
      if (!Array.isArray(results.nodeIds) || results.nodeIds.length !== resultCount) {
        throw new Error('Browser password-field scan returned incomplete results.');
      }
      for (const nodeId of results.nodeIds) {
        const resolved = (await send('DOM.resolveNode', {
          nodeId,
          objectGroup,
        })) as { object?: { objectId?: string } };
        const objectId = resolved.object?.objectId;
        if (!objectId) throw new Error('Browser password-field scan could not resolve a field.');
        const checked = (await send('Runtime.callFunctionOn', {
          objectId,
          functionDeclaration:
            "function () { try { if (typeof this.value !== 'string' || this.value.length === 0) return false; const root = this.getRootNode(); return String(this.type || '').toLowerCase() === 'password' || (root && root.nodeType === 11 && root.mode === 'closed'); } catch { return true; } }",
          returnByValue: true,
          silent: true,
        })) as { result?: { value?: unknown }; exceptionDetails?: unknown };
        if (checked.exceptionDetails) return true;
        if (typeof checked.result?.value !== 'boolean') {
          throw new Error('Browser password-field scan returned an invalid field state.');
        }
        if (checked.result.value) return true;
      }
      return false;
    } finally {
      for (const searchId of searchIds) {
        await send('DOM.discardSearchResults', { searchId }).catch(() => undefined);
      }
      await send('Runtime.releaseObjectGroup', { objectGroup }).catch(() => undefined);
    }
  }

  /** OOPIF documents have independent CDP targets, so the top page's flattened
   * DOM cannot prove that their closed author roots are safe. Temporarily
   * auto-attach only related iframe targets, recurse through nested targets, and
   * scan every session under one aggregate budget. Missing/late targets fail
   * closed; unrelated tabs/workers are never attached. */
  private async hasSensitiveRelatedOopifTarget(
    contents: WebContents,
    budget: CdpSensitiveScanBudget,
    expectedFrameTreeNodeIds: ReadonlySet<number>,
  ): Promise<boolean> {
    const sessions = new Set<string>();
    const configuredParents = new Set<string>();
    const filter = [{ type: 'iframe', exclude: false }, { exclude: true }];
    const onMessage = (_event: unknown, method: string, params: unknown): void => {
      if (method !== 'Target.attachedToTarget' || !params || typeof params !== 'object') return;
      const attached = params as { sessionId?: unknown; targetInfo?: { type?: unknown } };
      if (attached.targetInfo?.type !== 'iframe' || typeof attached.sessionId !== 'string') return;
      sessions.add(attached.sessionId);
    };
    const setAutoAttach = (autoAttach: boolean, parentSessionId?: string): Promise<unknown> => {
      const params = {
        autoAttach,
        waitForDebuggerOnStart: false,
        flatten: true,
        ...(autoAttach ? { filter } : {}),
      };
      return parentSessionId
        ? contents.debugger.sendCommand('Target.setAutoAttach', params, parentSessionId)
        : contents.debugger.sendCommand('Target.setAutoAttach', params);
    };
    const nextEventLoopTurn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

    contents.debugger.on('message', onMessage);
    try {
      await setAutoAttach(true);
      configuredParents.add('');
      let stablePasses = 0;
      for (let pass = 0; pass < MAX_CDP_SENSITIVE_ATTACH_PASSES; pass++) {
        await nextEventLoopTurn();
        if (sessions.size > MAX_CDP_SENSITIVE_SCAN_TARGETS) return true;
        const unconfigured = [...sessions].filter((sessionId) => !configuredParents.has(sessionId));
        if (unconfigured.length === 0) {
          stablePasses += 1;
          if (stablePasses >= 2) break;
          continue;
        }
        stablePasses = 0;
        for (const sessionId of unconfigured) {
          await setAutoAttach(true, sessionId);
          configuredParents.add(sessionId);
        }
      }

      if (
        sessions.size < expectedFrameTreeNodeIds.size ||
        [...sessions].some((sessionId) => !configuredParents.has(sessionId))
      ) {
        return true;
      }
      const attachedSnapshot = [...sessions];
      for (const sessionId of attachedSnapshot) {
        if (await this.scanSensitiveCdpSession(contents, budget, sessionId)) return true;
      }
      await nextEventLoopTurn();
      if (sessions.size !== attachedSnapshot.length) return true;
      const currentFrameTreeNodeIds = this.liveOopifFrameTreeNodeIds(contents);
      if (
        currentFrameTreeNodeIds === null ||
        currentFrameTreeNodeIds.size !== expectedFrameTreeNodeIds.size ||
        [...currentFrameTreeNodeIds].some((id) => !expectedFrameTreeNodeIds.has(id))
      ) {
        return true;
      }
      return false;
    } finally {
      const childParents = [...configuredParents].filter(Boolean).reverse();
      for (const sessionId of childParents) {
        await setAutoAttach(false, sessionId).catch(() => undefined);
      }
      if (configuredParents.has('')) await setAutoAttach(false).catch(() => undefined);
      contents.debugger.off('message', onMessage);
    }
  }

  private listTabs(conversationId: string): BrowserTab[] {
    const activeId = this.activeTabs.get(conversationId);
    return (this.tabOrder.get(conversationId) ?? [])
      .map((id) => this.tabs.get(id))
      .filter((tab): tab is InternalTab => !!tab)
      .map((tab) => this.snapshotTab(tab, tab.shell.id === activeId));
  }

  /** Keep the live shell's complete URL as document identity. Only bounded
   * copies may cross IPC/model boundaries; truncating the internal value lets
   * two long same-document routes share an approval/operation lease. */
  private snapshotTab(tab: InternalTab, active: boolean): BrowserTab {
    return {
      ...tab.shell,
      url: boundedBrowserUrl(tab.shell.url),
      active,
    };
  }

  getState(conversationId: string): BrowserManagerState {
    return {
      conversationId,
      tabs: this.listTabs(conversationId),
      activeTabId: this.activeTabs.get(conversationId) ?? null,
      credentialPrompts: [...this.pendingCredentials.entries()]
        .filter(([, pending]) => pending.conversationId === conversationId)
        .map(([id, pending]) => ({
          id,
          tabId: pending.tabId,
          origin: pending.origin,
          username: pending.username,
          update: pending.update,
        })),
      permissionPrompts: [...this.pendingPermissions.entries()]
        .filter(([, pending]) => pending.conversationId === conversationId)
        .map(([id, pending]) => ({
          id,
          tabId: pending.tabId,
          origin: pending.origin,
          permission: pending.permission,
          ...(pending.target ? { target: pending.target } : {}),
          canPersist: pending.canPersist && !pending.assistantTriggered,
          assistantTriggered: pending.assistantTriggered,
        })),
      authPrompts: [...this.pendingAuth.values()]
        .filter((pending) => pending.conversationId === conversationId)
        .map((pending) => ({ ...pending.prompt })),
      runningActions: [...this.runningActions.values()]
        .filter((entry) => entry.conversationId === conversationId)
        .map((entry) => ({ ...entry.action })),
    };
  }

  getAttentionState(): BrowserAttentionState[] {
    const promptIdsByConversation = new Map<string, string[]>();
    const add = (conversationId: string, promptId: string): void => {
      const promptIds = promptIdsByConversation.get(conversationId) ?? [];
      promptIds.push(promptId);
      promptIdsByConversation.set(conversationId, promptIds);
    };
    for (const [promptId, prompt] of this.pendingCredentials) add(prompt.conversationId, promptId);
    for (const [promptId, prompt] of this.pendingPermissions) add(prompt.conversationId, promptId);
    for (const [promptId, prompt] of this.pendingAuth) add(prompt.conversationId, promptId);
    return [...promptIdsByConversation].map(([conversationId, promptIds]) => ({ conversationId, promptIds }));
  }

  captureDocumentApproval(
    conversationId: string,
    tabId?: string,
    assistantRun?: BrowserAssistantRun,
  ): BrowserDocumentApproval {
    const tab = assistantRun
      ? this.requireAssistantTab(conversationId, assistantRun, tabId, false)
      : this.requireTab(conversationId, tabId);
    return {
      tabId: tab.shell.id,
      tabGeneration: tab.generation,
      origin: normalizedOrigin(tab.shell.url),
      url: tab.shell.url,
      tabRef: tab,
      userNavigationLease: tab.trustedUserNavigationLease,
      allowInternalRestore: tab.view === null && tab.shell.discarded,
    };
  }

  captureTabsReadApproval(conversationId: string): BrowserTabsReadApproval {
    const tabOrder = [...(this.tabOrder.get(conversationId) ?? [])];
    const tabs = tabOrder.map((id) => this.tabs.get(id));
    if (tabs.some((tab) => !tab || tab.shell.conversationId !== conversationId)) {
      throw new Error('The browser tab list changed before approval could be requested.');
    }
    const exactTabs = tabs as InternalTab[];
    return {
      conversationId,
      activeTabId: this.activeTabs.get(conversationId) ?? null,
      tabOrder,
      tabRefs: exactTabs,
      tabGenerations: exactTabs.map((tab) => tab.generation),
      tabUrls: exactTabs.map((tab) => tab.shell.url),
      userNavigationLeases: exactTabs.map((tab) => tab.trustedUserNavigationLease),
    };
  }

  assertTabsReadApproval(conversationId: string, approval: BrowserTabsReadApproval): void {
    const currentOrder = this.tabOrder.get(conversationId) ?? [];
    const unchanged =
      approval.conversationId === conversationId &&
      approval.activeTabId === (this.activeTabs.get(conversationId) ?? null) &&
      currentOrder.length === approval.tabOrder.length &&
      currentOrder.every(
        (id, index) =>
          id === approval.tabOrder[index] &&
          this.tabs.get(id) === approval.tabRefs[index] &&
          this.tabs.get(id)?.generation === approval.tabGenerations[index] &&
          this.tabs.get(id)?.shell.url === approval.tabUrls[index] &&
          this.tabs.get(id)?.trustedUserNavigationLease === approval.userNavigationLeases[index],
      );
    if (!unchanged) {
      throw new Error('The browser tab list changed while approval was pending. Review it and try again.');
    }
  }

  async captureAutofillApproval(
    conversationId: string,
    tabId: string | undefined,
    credentialId: string | undefined,
    assistantRun: BrowserAssistantRun,
  ): Promise<BrowserAutofillApproval> {
    const tab = this.requireAssistantTab(conversationId, assistantRun, tabId, false);
    let approval: BrowserAutofillApproval | undefined;
    await this.runTabOperation(tab, async () => {
      throwIfBrowserAborted(assistantRun.abortSignal);
      this.assertAssistantRun(conversationId, assistantRun);
      if (tab.scriptTainted) {
        throw new Error('Saved-password autofill is blocked until this page is reloaded or navigated.');
      }
      // Approval capture is descriptive only. Never recreate/reload the page or
      // acquire assistant control before the user answers the prompt. Vault
      // autofill is deliberately top-level-only, including for live views.
      const contents =
        tab.view && !tab.view.webContents.isDestroyed() && !tab.viewLoadPromise ? tab.view.webContents : null;
      const pageLease = contents ? this.captureBrowserPageLease(tab, contents) : null;
      const match = contents
        ? this.resolveAutofillCredentialTarget(tab, contents, credentialId).match
        : this.resolveAutofillCredentialForOrigins(tab, new Set([normalizedOrigin(tab.shell.url)]), credentialId);
      if (pageLease) this.assertBrowserPageLease(tab, pageLease, 'saved-password approval');
      throwIfBrowserAborted(assistantRun.abortSignal);
      this.assertAssistantRun(conversationId, assistantRun);
      approval = {
        tabId: tab.shell.id,
        tabGeneration: tab.generation,
        origin: normalizedOrigin(tab.shell.url),
        url: tab.shell.url,
        tabRef: tab,
        userNavigationLease: tab.trustedUserNavigationLease,
        allowInternalRestore: tab.view === null && tab.shell.discarded,
        credentialId: match.id,
        credentialUpdatedAt: match.updatedAt,
        destinationOrigin: match.origin,
      };
    });
    if (!approval) throw new Error('The saved-password approval target is unavailable.');
    return approval;
  }

  captureTabsApproval(
    conversationId: string,
    action: BrowserTabsMutationAction,
    tabId?: string,
    assistantRun?: BrowserAssistantRun,
  ): BrowserTabsApproval {
    if (action === 'open') return { action, conversationId };
    if (action === 'reopen_closed') {
      const closedTab = this.closedTabs.get(conversationId)?.[0] ?? null;
      return {
        action,
        conversationId,
        closedTabRef: closedTab,
        ...(closedTab
          ? {
              tabId: closedTab.id,
              origin: normalizedOrigin(closedTab.url),
              url: closedTab.url,
            }
          : {}),
      };
    }

    const tab = assistantRun
      ? this.requireAssistantTab(conversationId, assistantRun, tabId, false)
      : this.requireTab(conversationId, tabId);
    const document = this.captureDocumentApproval(conversationId, tab.shell.id);
    const approval: BrowserTabsApproval = {
      action,
      conversationId,
      ...document,
      tabRef: tab,
    };
    if (action === 'close_others' || action === 'close_right') {
      const tabOrder = [...(this.tabOrder.get(conversationId) ?? [])];
      const targetIndex = tabOrder.indexOf(tab.shell.id);
      if (targetIndex < 0) throw new Error('The browser tab order changed before approval could be requested.');
      const affectedTabIds =
        action === 'close_others'
          ? tabOrder.filter((candidate) => candidate !== tab.shell.id)
          : tabOrder.slice(targetIndex + 1);
      approval.tabOrder = tabOrder;
      approval.affectedTabIds = affectedTabIds;
      const affectedTabRefs = affectedTabIds.map((id) => this.tabs.get(id));
      if (affectedTabRefs.some((candidate) => !candidate)) {
        throw new Error('The browser tab list changed before approval could be requested.');
      }
      approval.affectedTabRefs = affectedTabRefs as InternalTab[];
    }
    return approval;
  }

  private assertBrowserTabsTargetApproval(
    conversationId: string,
    action: BrowserTabsMutationAction,
    tab: InternalTab,
    approval: BrowserTabsApproval | undefined,
  ): void {
    if (!approval) return;
    if (approval.action !== action || approval.conversationId !== conversationId || approval.tabRef !== tab) {
      throw new Error('The browser tab selection changed while approval was pending. Review it and try again.');
    }
    if (
      typeof approval.tabId !== 'string' ||
      typeof approval.tabGeneration !== 'number' ||
      typeof approval.origin !== 'string'
    ) {
      throw new Error('The approved browser tab target is no longer available.');
    }
    this.assertBrowserDocumentApproval(tab, {
      tabId: approval.tabId,
      tabGeneration: approval.tabGeneration,
      origin: approval.origin,
      ...(approval.url !== undefined ? { url: approval.url } : {}),
      ...(approval.tabRef !== undefined ? { tabRef: approval.tabRef } : {}),
      ...(approval.userNavigationLease !== undefined ? { userNavigationLease: approval.userNavigationLease } : {}),
      ...(approval.allowInternalRestore !== undefined ? { allowInternalRestore: approval.allowInternalRestore } : {}),
    });
  }

  private assertBrowserMultiTabApproval(
    conversationId: string,
    action: 'close_others' | 'close_right',
    tab: InternalTab,
    approval: BrowserTabsApproval,
  ): void {
    this.assertBrowserTabsTargetApproval(conversationId, action, tab, approval);
    const currentOrder = this.tabOrder.get(conversationId) ?? [];
    if (
      !approval.tabOrder ||
      !approval.affectedTabIds ||
      !approval.affectedTabRefs ||
      currentOrder.length !== approval.tabOrder.length ||
      currentOrder.some((id, index) => id !== approval.tabOrder![index]) ||
      approval.affectedTabIds.some((id, index) => this.tabs.get(id) !== approval.affectedTabRefs![index])
    ) {
      throw new Error('The browser tab order changed while approval was pending. Review it and try again.');
    }
    const targetIndex = currentOrder.indexOf(tab.shell.id);
    const currentAffected =
      action === 'close_others'
        ? currentOrder.filter((candidate) => candidate !== tab.shell.id)
        : currentOrder.slice(targetIndex + 1);
    if (
      currentAffected.length !== approval.affectedTabIds.length ||
      currentAffected.some((id, index) => id !== approval.affectedTabIds![index])
    ) {
      throw new Error('The set of browser tabs approved for closing changed. Review it and try again.');
    }
  }

  private reserveTabSlot(conversationId: string): () => void {
    const pending = this.pendingTabCreations.get(conversationId) ?? 0;
    const open = this.tabOrder.get(conversationId)?.length ?? 0;
    const limit = this.config().maxTabsPerConversation;
    if (open + pending >= limit) {
      throw new Error(`This chat has reached its ${limit}-tab limit.`);
    }
    this.pendingTabCreations.set(conversationId, pending + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = (this.pendingTabCreations.get(conversationId) ?? 1) - 1;
      if (remaining > 0) this.pendingTabCreations.set(conversationId, remaining);
      else this.pendingTabCreations.delete(conversationId);
    };
  }

  async createTab(request: BrowserCreateTabRequest, assistantRun?: BrowserAssistantRun): Promise<BrowserTab> {
    if (!this.config().enabled) throw new Error('The in-app browser is disabled in Settings.');
    this.assertConversationAvailable(request.conversationId);
    if (assistantRun?.abortSignal?.aborted) throw new Error('Browser tab creation was cancelled.');
    this.requireLiveWindow();
    const dataScope = this.config().dataScope;
    const scopeKey = browserScopeKey(dataScope, request.conversationId);
    const owner = request.owner ?? 'user';
    if (owner === 'assistant' && !assistantRun) {
      throw new Error('Assistant-created browser tabs require turn ownership.');
    }
    const assistantLease =
      owner === 'assistant' ? this.assistantRuns.acquire(request.conversationId, assistantRun!.id) : null;
    const assistantGeneration = assistantLease?.generation ?? null;
    try {
      return await this.withScopeActivity(scopeKey, async () => {
        const releaseSlot = this.reserveTabSlot(request.conversationId);
        let slotReserved = true;
        let createdTab: InternalTab | null = null;
        let published = false;
        let assistantRenderingActive = false;
        let initialDialogGuard: AssistantDialogGuard | null = null;
        try {
          const createdAt = now();
          const partition = browserPartition(dataScope, request.conversationId);
          const id = randomUUID();
          const url = normalizeOmniboxInput(request.url ?? 'about:blank', this.config().searchProvider);
          if (owner === 'assistant')
            await this.assertAssistantNavigationAllowed(url, partition, assistantRun?.abortSignal);

          // Re-read after async DNS validation. Parallel AI tab creations must append
          // to the current order rather than publishing stale snapshots over one another.
          if (assistantRun?.abortSignal?.aborted) throw new Error('Browser tab creation was cancelled.');
          if (!this.config().enabled) throw new Error('The in-app browser is disabled in Settings.');
          this.assertConversationAvailable(request.conversationId);
          if (this.config().dataScope !== dataScope || this.scopeKey(request.conversationId) !== scopeKey) {
            throw new Error('The browser data profile changed while the tab was opening. Please retry.');
          }
          if (
            assistantGeneration !== null &&
            assistantGeneration !== this.assistantGeneration(request.conversationId, assistantRun!.id)
          ) {
            throw new Error('The assistant browser turn ended before the tab opened.');
          }
          this.assertScopeAvailable(scopeKey);
          const order = this.tabOrder.get(request.conversationId) ?? [];
          if (order.length >= this.config().maxTabsPerConversation) {
            throw new Error(`This chat has reached its ${this.config().maxTabsPerConversation}-tab limit.`);
          }
          const shell: BrowserTab = {
            id,
            conversationId: request.conversationId,
            owner,
            keepOpen: false,
            title: url === 'about:blank' ? 'New Tab' : boundedBrowserTitle(url),
            url,
            loading: false,
            audible: false,
            muted: false,
            discarded: false,
            reloadRequired: false,
            active: false,
            canGoBack: false,
            canGoForward: false,
            zoomLevel: this.storeForScope(scopeKey).getZoomLevel(),
            createdAt,
            updatedAt: createdAt,
            security: securityForUrl(url),
            sensitive: false,
          };
          const tab: InternalTab = {
            shell,
            view: null,
            viewLoadPromise: null,
            partition,
            scopeKey,
            generation: 0,
            lastUsedAt: Date.now(),
            assistantOwnerId: owner === 'assistant' ? assistantRun!.id : null,
            aiNetworkRestricted: shell.owner === 'assistant',
            aiControlOwnerId: owner === 'assistant' ? assistantRun!.id : null,
            aiControlGeneration: assistantGeneration,
            aiActionDepth: 0,
            aiActionUntil: 0,
            aiNetworkReleaseRequested: false,
            aiNetworkReleaseTimer: null,
            assistantScriptDepth: 0,
            assistantDialogsDisabledRunId: owner === 'assistant' ? assistantRun!.id : null,
            popupGesture: null,
            assistantGesture: null,
            scriptTainted: false,
            trustedUserNavigation: false,
            trustedUserNavigationTarget: null,
            trustedUserNavigationRequestId: null,
            trustedUserNavigationLease: 0,
            trustedUserNavigationTimer: null,
            userSelectionGeneration: 0,
            trustedGestureGeneration: 0,
            visibleAssistantGeneration: 0,
            unrestrictedNetworkGeneration: 0,
            unrestrictedNetworkValidations: new Map(),
            unrestrictedNetworkUnsafe: false,
            queue: new BrowserActionQueue(),
            overlayGeneration: 0,
            overlayTimer: null,
            automationOverlay: null,
            networkRedactionKey: createBrowserNetworkRedactionKey(),
            isPopup: false,
          };
          createdTab = tab;
          this.tabs.set(id, tab);
          this.tabOrder.set(request.conversationId, [...order, id]);
          if (owner === 'assistant') this.rememberAssistantTarget(request.conversationId, assistantRun!.id, tab);
          releaseSlot();
          slotReserved = false;
          // Presentation selection is user-owned. Assistant tabs are fully
          // usable through their returned ids and hidden native surfaces, but
          // they must never replace (or manufacture) the tab shown in the
          // sidebar merely because the tool omitted `background: true`.
          const shouldPresentTab =
            owner === 'user' && (!request.background || !this.activeTabs.has(request.conversationId));
          if (shouldPresentTab) {
            this.activeTabs.set(request.conversationId, id);
            this.notifyPanelStateChanged(request.conversationId);
          }

          // Create every tab's hidden native child immediately. Assistant tab
          // creation temporarily disables Chromium throttling for the initial
          // load; ordinary idle tabs return to the default throttleable state.
          if (owner === 'assistant') {
            tab.aiActionDepth++;
            assistantRenderingActive = true;
            initialDialogGuard = this.ensureAssistantRunDialogGuard(tab, assistantRun!.id);
            tab.assistantDownloadAttribution = {
              assistantOwnerId: assistantRun!.id,
              trustedGestureGeneration: tab.trustedGestureGeneration,
            };
          }
          const viewReady = this.ensureView(
            tab,
            assistantRun?.abortSignal,
            owner === 'assistant' ? ASSISTANT_PAGE_LOAD_TIMEOUT_MS : 0,
          );
          this.emitTabs(request.conversationId);
          published = true;
          if (initialDialogGuard) {
            await this.awaitAssistantDialogProtectedOperation(viewReady, initialDialogGuard);
          } else {
            await viewReady;
          }
          if (shouldPresentTab) this.attachActiveView(request.conversationId);
          return this.snapshotTab(tab, this.activeTabs.get(request.conversationId) === id);
        } catch (error) {
          // Roll back only failures that happen before the shell is visible. Once
          // published, retain the tab and surface its navigation error so DNS
          // failures and a user pressing Stop do not make the tab disappear.
          if (createdTab && !published && this.tabs.get(createdTab.shell.id) === createdTab) {
            this.closeTab(createdTab, false, false);
            this.emitTabs(request.conversationId);
          } else if (createdTab && this.tabs.get(createdTab.shell.id) === createdTab) {
            createdTab.shell.loading = false;
            createdTab.shell.discarded = !createdTab.view || createdTab.view.webContents.isDestroyed();
            createdTab.shell.error ??= error instanceof Error ? error.message : String(error);
            this.emitTabs(request.conversationId);
          }
          throw error;
        } finally {
          if (assistantRenderingActive && createdTab) {
            createdTab.aiActionDepth = Math.max(0, createdTab.aiActionDepth - 1);
            if (createdTab.aiActionDepth === 0) this.restoreAssistantBackgroundRendering(createdTab);
          }
          if (slotReserved) releaseSlot();
        }
      });
    } finally {
      assistantLease?.release();
    }
  }

  private requireTab(conversationId: string, tabId?: string): InternalTab {
    const resolvedId = tabId ?? this.activeTabs.get(conversationId);
    const tab = resolvedId ? this.tabs.get(resolvedId) : undefined;
    if (!tab || tab.shell.conversationId !== conversationId) throw new Error('Browser tab not found in this chat.');
    return tab;
  }

  async commandTab(
    conversationId: string,
    tabId: string,
    command: BrowserTabCommand,
    source: 'user' | 'assistant' = 'user',
    assistantRun?: BrowserAssistantRun,
    approvedTabs?: BrowserTabsApproval,
  ): Promise<void> {
    const tab = this.requireTab(conversationId, tabId);
    if (source === 'assistant' && !assistantRun) throw new Error('Assistant browser commands require turn ownership.');
    if (source === 'assistant' && command === 'activate') {
      throw new Error('Assistant browser tabs remain in the background until the user selects one.');
    }
    if (source === 'assistant' && (command === 'close-others' || command === 'close-right')) {
      return this.commandAssistantMultiTabClose(tab, command, assistantRun!, approvedTabs);
    }
    if (source === 'assistant' && command === 'close') {
      return this.commandAssistantSingleTabClose(tab, assistantRun!, approvedTabs);
    }
    if (
      source === 'user' &&
      ['activate', 'close', 'reload', 'hard-reload', 'stop', 'back', 'forward'].includes(command)
    ) {
      const previewPreemption = this.preemptMenuPreviewForTab(
        tab,
        command === 'activate'
          ? 'Browser menu preview was cancelled because the user opened this tab.'
          : 'Browser menu preview was cancelled because the user navigated this tab.',
      );
      if (previewPreemption) await previewPreemption;
    }
    const operation = () =>
      source === 'assistant'
        ? this.withAssistantControl(
            tab,
            assistantRun!,
            (documentLease) =>
              this.commandTabWithinOperation(tab, command, source, assistantRun, documentLease, approvedTabs),
            approvedTabs,
          )
        : this.commandTabWithinOperation(tab, command, source);
    // User input remains concurrent by design, while assistant commands join
    // the same per-tab queue as inspect/action/screenshot/autofill operations.
    return shouldSerializeBrowserTabCommand(source)
      ? this.runTabOperation(tab, operation)
      : this.withScopeActivity(tab.scopeKey, operation);
  }

  async duplicateAssistantTab(
    conversationId: string,
    tabId: string,
    assistantRun: BrowserAssistantRun,
    approvedTabs?: BrowserTabsApproval,
  ): Promise<BrowserTab> {
    const tab = this.requireTab(conversationId, tabId);
    const sourceUrl = await this.runTabOperation(tab, () =>
      this.withAssistantControl(
        tab,
        assistantRun,
        async (documentLease) => {
          this.assertAssistantDocumentLease(tab, documentLease);
          this.assertBrowserTabsTargetApproval(conversationId, 'duplicate', tab, approvedTabs);
          if (this.tabs.get(tabId) !== tab) throw new Error('This browser tab has been closed.');
          if (tab.shell.sensitive) {
            throw new Error('Duplicating a tab is blocked while it contains password data.');
          }
          return tab.shell.url;
        },
        approvedTabs,
      ),
    );
    // Creating the destination may sanitize a script-tainted profile origin.
    // That cleanup drains every same-origin tab queue, including the source.
    // Leave the source queue before creating the new renderer so duplication
    // cannot wait on the queue operation that is currently performing it.
    return this.createTab({ conversationId, url: sourceUrl, owner: 'assistant' }, assistantRun);
  }

  private async commandAssistantSingleTabClose(
    tab: InternalTab,
    assistantRun: BrowserAssistantRun,
    approvedTabs?: BrowserTabsApproval,
  ): Promise<void> {
    const { conversationId, id: tabId } = tab.shell;
    this.assertAssistantRun(conversationId, assistantRun);
    this.assertAssistantMayControlTab(tab, assistantRun);
    const captured = {
      generation: tab.generation,
      userNavigationLease: tab.trustedUserNavigationLease,
      userSelectionGeneration: tab.userSelectionGeneration ?? 0,
      trustedGestureGeneration: tab.trustedGestureGeneration ?? 0,
      url: tab.shell.url,
      keepOpen: tab.shell.keepOpen,
    };
    const lease = this.assistantRuns.acquire(conversationId, assistantRun.id);
    const closureToken = Symbol('assistant-close');
    const pendingClosures = (this.pendingAssistantTabClosures ??= new Map<string, symbol>());
    if (pendingClosures.has(tabId)) {
      lease.release();
      throw new Error('This browser tab is already being closed by another assistant operation.');
    }
    // Fence successor work before draining already-admitted operations. Closing
    // a shell never needs DNS authorization, renderer creation, or native page
    // guards, and therefore must remain possible for a broken/background page.
    pendingClosures.set(tabId, closureToken);
    try {
      await this.withScopeActivity(tab.scopeKey, async () => {
        await tab.queue.whenIdle();
        if (
          this.tabs.get(tabId) !== tab ||
          tab.generation !== captured.generation ||
          tab.trustedUserNavigationLease !== captured.userNavigationLease ||
          (tab.userSelectionGeneration ?? 0) !== captured.userSelectionGeneration ||
          (tab.trustedGestureGeneration ?? 0) !== captured.trustedGestureGeneration ||
          tab.shell.url !== captured.url ||
          tab.shell.keepOpen !== captured.keepOpen
        ) {
          throw new Error('The browser tab changed while the close operation was waiting.');
        }
        if (!this.config().enabled) throw new Error('The in-app browser is disabled in Settings.');
        this.assertScopeAvailable(tab.scopeKey);
        this.assertAssistantMayControlTab(tab, assistantRun);
        throwIfBrowserAborted(assistantRun.abortSignal);
        if (lease.generation !== this.assistantGeneration(conversationId, assistantRun.id)) {
          throw new Error('The assistant browser turn ended before the tab could be closed.');
        }
        if (approvedTabs) this.assertBrowserTabsTargetApproval(conversationId, 'close', tab, approvedTabs);
        throwIfBrowserAborted(assistantRun.abortSignal);
        if (lease.generation !== this.assistantGeneration(conversationId, assistantRun.id)) {
          throw new Error('The assistant browser turn ended before the tab could be closed.');
        }
        if (approvedTabs) this.assertBrowserTabsTargetApproval(conversationId, 'close', tab, approvedTabs);
        this.closeTab(tab, true, true, false);
      });
    } finally {
      if (pendingClosures.get(tabId) === closureToken) pendingClosures.delete(tabId);
      lease.release();
    }
  }

  private async commandAssistantMultiTabClose(
    tab: InternalTab,
    command: 'close-others' | 'close-right',
    assistantRun: BrowserAssistantRun,
    approvedTabs?: BrowserTabsApproval,
  ): Promise<void> {
    const { conversationId, id: tabId } = tab.shell;
    const capturedOrder = [...(this.tabOrder.get(conversationId) ?? [])];
    const order = approvedTabs?.tabOrder ?? capturedOrder;
    const targetIds =
      approvedTabs?.affectedTabIds ??
      (command === 'close-others' ? order.filter((id) => id !== tabId) : order.slice(order.indexOf(tabId) + 1));
    const lease = this.assistantRuns.acquire(conversationId, assistantRun.id);
    const targets = targetIds.map((id) => ({ id, tab: this.tabs.get(id) }));
    const queueTabs = [tab, ...targets.flatMap(({ tab: target }) => (target ? [target] : []))]
      .filter((candidate, index, all) => all.indexOf(candidate) === index)
      .sort((left, right) => left.shell.id.localeCompare(right.shell.id));
    const capturedTabs = queueTabs.map((captured) => ({
      tab: captured,
      generation: captured.generation,
      userNavigationLease: captured.trustedUserNavigationLease,
      userSelectionGeneration: captured.userSelectionGeneration ?? 0,
      trustedGestureGeneration: captured.trustedGestureGeneration ?? 0,
      url: captured.shell.url,
      keepOpen: captured.shell.keepOpen,
    }));
    const assertCapturedTabsUnchanged = (): void => {
      const currentOrder = this.tabOrder.get(conversationId) ?? [];
      if (
        currentOrder.length !== capturedOrder.length ||
        currentOrder.some((id, index) => id !== capturedOrder[index])
      ) {
        throw new Error('The browser tab order changed while the close operation was waiting.');
      }
      for (const captured of capturedTabs) {
        if (
          this.tabs.get(captured.tab.shell.id) !== captured.tab ||
          captured.tab.generation !== captured.generation ||
          captured.tab.trustedUserNavigationLease !== captured.userNavigationLease ||
          (captured.tab.userSelectionGeneration ?? 0) !== captured.userSelectionGeneration ||
          (captured.tab.trustedGestureGeneration ?? 0) !== captured.trustedGestureGeneration ||
          captured.tab.shell.url !== captured.url ||
          captured.tab.shell.keepOpen !== captured.keepOpen
        ) {
          throw new Error('A browser tab changed while the close operation was waiting.');
        }
      }
    };
    const closureToken = Symbol(`assistant-${command}`);
    const pendingClosures = (this.pendingAssistantTabClosures ??= new Map<string, symbol>());
    try {
      await this.withScopeActivity(tab.scopeKey, async () => {
        for (const controlled of queueTabs) {
          if (pendingClosures.has(controlled.shell.id)) {
            throw new Error('A browser tab is already being closed by another assistant operation.');
          }
        }
        // Fence all captured identities synchronously, then drain only work that
        // was already admitted. Holding an idle sibling queue while waiting for
        // a busy same-origin operation can deadlock when that operation waits
        // for the sibling to become idle during storage sanitization.
        for (const controlled of queueTabs) pendingClosures.set(controlled.shell.id, closureToken);
        await Promise.all(queueTabs.map((controlled) => controlled.queue.whenIdle()));
        if (this.tabs.get(tabId) !== tab) throw new Error('This browser tab has been closed.');
        for (const { id, tab: target } of targets) {
          if (!target || this.tabs.get(id) !== target) {
            throw new Error('A browser tab changed while the close operation was waiting.');
          }
        }
        assertCapturedTabsUnchanged();
        // Closing shells does not read, script, navigate, or dispatch input into
        // any document. Validate the same run/tab capabilities directly instead
        // of entering document control after every affected queue has drained.
        if (!this.config().enabled) throw new Error('The in-app browser is disabled in Settings.');
        for (const controlled of queueTabs) {
          this.assertScopeAvailable(controlled.scopeKey);
          this.assertAssistantMayControlTab(controlled, assistantRun);
        }
        throwIfBrowserAborted(assistantRun.abortSignal);
        if (lease.generation !== this.assistantGeneration(conversationId, assistantRun.id)) {
          throw new Error('The assistant browser turn ended before tabs could be closed.');
        }
        if (approvedTabs) {
          this.assertBrowserMultiTabApproval(
            conversationId,
            command === 'close-others' ? 'close_others' : 'close_right',
            tab,
            approvedTabs,
          );
        }
        throwIfBrowserAborted(assistantRun.abortSignal);
        if (lease.generation !== this.assistantGeneration(conversationId, assistantRun.id)) {
          throw new Error('The assistant browser turn ended before tabs could be closed.');
        }
        if (approvedTabs) {
          this.assertBrowserMultiTabApproval(
            conversationId,
            command === 'close-others' ? 'close_others' : 'close_right',
            tab,
            approvedTabs,
          );
        }
        assertCapturedTabsUnchanged();
        for (const { id, tab: target } of targets) {
          if (!target || this.tabs.get(id) !== target) {
            throw new Error('A browser tab changed while the close operation was waiting.');
          }
        }
        // All queue leases remain held through this synchronous commit. Only
        // after every captured identity has been destroyed may successor work
        // wake and observe that its tab is closed.
        for (const { tab: target } of targets) this.closeTab(target!, false);
        this.emitTabs(conversationId);
      });
    } finally {
      for (const controlled of queueTabs) {
        if (pendingClosures.get(controlled.shell.id) === closureToken) pendingClosures.delete(controlled.shell.id);
      }
      lease.release();
    }
  }

  private async navigateAssistantHistory(
    tab: InternalTab,
    contents: WebContents,
    offset: -1 | 1,
    abortSignal?: AbortSignal,
  ): Promise<void> {
    const navigation = contents.navigationHistory;
    if (!navigation.canGoToOffset(offset)) return;
    const initialIndex = navigation.getActiveIndex();
    const targetIndex = initialIndex + offset;
    const target = navigation.getEntryAtIndex(targetIndex);
    if (!target?.url) throw new Error('The requested browser history entry is unavailable.');

    await this.assertAssistantNavigationAllowed(target.url, tab.partition, abortSignal);
    throwIfBrowserAborted(abortSignal);
    const currentTarget = navigation.getEntryAtIndex(targetIndex);
    if (navigation.getActiveIndex() !== initialIndex || currentTarget?.url !== target.url) {
      throw new Error('The browser history changed while navigation was being authorized.');
    }

    await this.runRendererOperationWithDeadline(
      tab,
      contents,
      'Browser history navigation',
      ASSISTANT_PAGE_LOAD_TIMEOUT_MS,
      () =>
        new Promise<void>((resolve, reject) => {
          let settled = false;
          const cleanup = () => {
            contents.removeListener('did-navigate', onDidNavigate);
            contents.removeListener('did-navigate-in-page', onDidNavigateInPage);
            contents.removeListener('did-stop-loading', onDidStopLoading);
            contents.removeListener('did-fail-load', onDidFailLoad);
            contents.removeListener('destroyed', onDestroyed);
          };
          const finish = (error?: Error) => {
            if (settled) return;
            settled = true;
            cleanup();
            if (error) reject(error);
            else resolve();
          };
          const reachedTarget = () => navigation.getActiveIndex() === targetIndex || contents.getURL() === target.url;
          const onDidNavigate = () => {
            if (reachedTarget() && !contents.isLoadingMainFrame()) finish();
          };
          const onDidNavigateInPage = (_event: Electron.Event, _url: string, isMainFrame: boolean) => {
            if (isMainFrame && reachedTarget()) finish();
          };
          const onDidStopLoading = () => {
            if (reachedTarget()) finish();
          };
          const onDidFailLoad = (
            _event: Electron.Event,
            errorCode: number,
            errorDescription: string,
            _validatedUrl: string,
            isMainFrame: boolean,
          ) => {
            if (isMainFrame) finish(new Error(`Browser history navigation failed (${errorCode}): ${errorDescription}`));
          };
          const onDestroyed = () => finish(new Error('The browser page closed during history navigation.'));

          contents.on('did-navigate', onDidNavigate);
          contents.on('did-navigate-in-page', onDidNavigateInPage);
          contents.on('did-stop-loading', onDidStopLoading);
          contents.on('did-fail-load', onDidFailLoad);
          contents.on('destroyed', onDestroyed);
          try {
            navigation.goToIndex(targetIndex);
          } catch (error) {
            finish(error instanceof Error ? error : new Error(String(error)));
          }
        }),
      abortSignal,
    );
    throwIfBrowserAborted(abortSignal);
    await this.assertAssistantNavigationAllowed(contents.getURL(), tab.partition, abortSignal);
  }

  private async reloadAssistantTab(
    tab: InternalTab,
    contents: WebContents,
    ignoreCache: boolean,
    abortSignal?: AbortSignal,
  ): Promise<void> {
    await this.runRendererOperationWithDeadline(
      tab,
      contents,
      'Browser page reload',
      ASSISTANT_PAGE_LOAD_TIMEOUT_MS,
      () =>
        new Promise<void>((resolve, reject) => {
          let settled = false;
          let reloadStarted = false;
          const cleanup = () => {
            contents.removeListener('did-start-navigation', onDidStartNavigation);
            contents.removeListener('did-start-loading', onDidStartLoading);
            contents.removeListener('did-stop-loading', onDidStopLoading);
            contents.removeListener('did-fail-load', onDidFailLoad);
            contents.removeListener('destroyed', onDestroyed);
          };
          const finish = (error?: Error) => {
            if (settled) return;
            settled = true;
            cleanup();
            if (error) reject(error);
            else resolve();
          };
          const onDidStartNavigation = (
            _event: Electron.Event,
            _url: string,
            _isInPlace: boolean,
            isMainFrame: boolean,
          ) => {
            if (isMainFrame) reloadStarted = true;
          };
          const onDidStartLoading = () => {
            reloadStarted = true;
          };
          const onDidStopLoading = () => {
            if (reloadStarted) finish();
          };
          const onDidFailLoad = (
            _event: Electron.Event,
            errorCode: number,
            errorDescription: string,
            _validatedUrl: string,
            isMainFrame: boolean,
          ) => {
            if (reloadStarted && isMainFrame) {
              finish(new Error(`Browser page reload failed (${errorCode}): ${errorDescription}`));
            }
          };
          const onDestroyed = () => finish(new Error('The browser page closed during reload.'));

          contents.on('did-start-navigation', onDidStartNavigation);
          contents.on('did-start-loading', onDidStartLoading);
          contents.on('did-stop-loading', onDidStopLoading);
          contents.on('did-fail-load', onDidFailLoad);
          contents.on('destroyed', onDestroyed);
          try {
            if (ignoreCache) contents.reloadIgnoringCache();
            else contents.reload();
          } catch (error) {
            finish(error instanceof Error ? error : new Error(String(error)));
          }
        }),
      abortSignal,
    );
    throwIfBrowserAborted(abortSignal);
    await this.assertAssistantNavigationAllowed(contents.getURL(), tab.partition, abortSignal);
    this.markAssistantControlledOrigin(tab.scopeKey, contents.getURL());
  }

  private async commandTabWithinOperation(
    tab: InternalTab,
    command: BrowserTabCommand,
    source: 'user' | 'assistant',
    assistantRun?: BrowserAssistantRun,
    documentLease?: AssistantDocumentLease,
    approvedTabs?: BrowserTabsApproval,
  ): Promise<void> {
    const abortSignal = assistantRun?.abortSignal;
    const { conversationId, id: tabId } = tab.shell;
    if (this.tabs.get(tabId) !== tab) throw new Error('This browser tab has been closed.');
    if (approvedTabs) {
      const action = command === 'keep-open' ? 'keep_open' : command;
      if (action !== 'close' && action !== 'keep_open') {
        throw new Error('The approved browser tab command no longer matches this operation.');
      }
      this.assertBrowserTabsTargetApproval(conversationId, action, tab, approvedTabs);
    }
    if (source === 'user' && command === 'stop') this.clearTrustedUserNavigation(tab);
    const ensureCommandView = () =>
      source === 'assistant' ? this.ensureAssistantView(tab, assistantRun!, documentLease!) : this.ensureView(tab);
    const recreateScriptedViewForUser = async (): Promise<boolean> => {
      if (
        source !== 'user' ||
        (!tab.scriptTainted &&
          !tab.privateNetworkNewDocumentGuard &&
          !tab.assistantNativeUiNewDocumentGuard &&
          !tab.assistantDialogsDisabledRunId)
      )
        return false;
      const trustedNavigationLease = this.beginTrustedUserNavigation(tab, tab.shell.url);
      this.resetScriptedRendererForUser(tab);
      this.emitTabs(conversationId);
      try {
        await ensureCommandView();
        return true;
      } catch (error) {
        this.clearTrustedUserNavigation(tab, trustedNavigationLease);
        throw error;
      }
    };
    switch (command) {
      case 'activate':
        if (source === 'assistant') {
          throw new Error('Assistant browser tabs remain in the background until the user selects one.');
        }
        this.cancelElementPickersForConversation(conversationId);
        this.activeTabs.set(conversationId, tabId);
        // Selecting a temporary AI tab is an explicit user takeover. Retain its
        // shell at turn cleanup, then let the normal idle policy unload only
        // the renderer if it is later hidden.
        this.takeOverTabForUser(tab);
        // Publish the new active shell before a discarded tab begins its
        // potentially slow renderer/load restoration. The sidebar must switch
        // its toolbar state immediately even if that load later pauses on auth.
        this.emitTabs(conversationId);
        this.notifyPanelStateChanged(conversationId);
        const takeoverTransition = this.prepareTabForUserPresentation(tab);
        if (takeoverTransition) {
          // Do not leave the previously selected page visible under the new
          // tab chrome while the selected assistant target crosses its native
          // authority boundary.
          this.detachAttachedView();
          await takeoverTransition;
        }
        const viewReady = ensureCommandView();
        if (tab.view && !tab.view.webContents.isDestroyed()) {
          const presentationTransition = this.prepareTabForUserPresentation(tab);
          if (presentationTransition) await presentationTransition;
          this.attachActiveView(conversationId, true);
          this.notifyPanelStateChanged(conversationId);
        }
        await viewReady;
        const presentationTransition = this.prepareTabForUserPresentation(tab);
        if (presentationTransition) await presentationTransition;
        this.attachActiveView(conversationId, source === 'user');
        this.notifyPanelStateChanged(conversationId);
        break;
      case 'close':
        this.closeTab(tab, true, true, source === 'user');
        break;
      case 'duplicate':
        if (source === 'assistant' && tab.shell.sensitive) {
          throw new Error('Duplicating a tab is blocked while it contains password data.');
        }
        await this.createTab(
          {
            conversationId,
            url: tab.shell.url,
            owner: source === 'assistant' ? 'assistant' : 'user',
          },
          source === 'assistant' ? assistantRun : undefined,
        );
        break;
      case 'reload': {
        if (await recreateScriptedViewForUser()) break;
        const contents = (await ensureCommandView()).webContents;
        if (source === 'assistant') {
          await this.withAssistantDownloadAttribution(tab, assistantRun!.id, () =>
            this.reloadAssistantTab(tab, contents, false, abortSignal),
          );
          break;
        }
        const trustedNavigationLease = this.beginTrustedUserNavigation(tab, contents.getURL());
        try {
          contents.reload();
        } catch (error) {
          this.clearTrustedUserNavigation(tab, trustedNavigationLease);
          throw error;
        }
        break;
      }
      case 'hard-reload': {
        if (await recreateScriptedViewForUser()) break;
        const contents = (await ensureCommandView()).webContents;
        if (source === 'assistant') {
          await this.withAssistantDownloadAttribution(tab, assistantRun!.id, () =>
            this.reloadAssistantTab(tab, contents, true, abortSignal),
          );
          break;
        }
        const trustedNavigationLease = this.beginTrustedUserNavigation(tab, contents.getURL());
        try {
          contents.reloadIgnoringCache();
        } catch (error) {
          this.clearTrustedUserNavigation(tab, trustedNavigationLease);
          throw error;
        }
        break;
      }
      case 'stop':
        // Stop must remain usable while an existing loadURL promise is stalled.
        // Awaiting ensureView here would make the control wait for the very
        // navigation it is intended to cancel, and a discarded tab has no live
        // navigation to stop (nor any reason to recreate its renderer).
        if (tab.view && !tab.view.webContents.isDestroyed()) tab.view.webContents.stop();
        break;
      case 'back': {
        if (await recreateScriptedViewForUser()) break;
        const contents = (await ensureCommandView()).webContents;
        if (source === 'assistant') {
          await this.withAssistantDownloadAttribution(tab, assistantRun!.id, () =>
            this.navigateAssistantHistory(tab, contents, -1, abortSignal),
          );
        } else if (contents.navigationHistory.canGoBack()) {
          const target = contents.navigationHistory.getEntryAtIndex(contents.navigationHistory.getActiveIndex() - 1);
          if (!target?.url) throw new Error('The previous browser history entry is unavailable.');
          const trustedNavigationLease = this.beginTrustedUserNavigation(tab, target.url);
          try {
            contents.navigationHistory.goBack();
          } catch (error) {
            this.clearTrustedUserNavigation(tab, trustedNavigationLease);
            throw error;
          }
        } else this.clearTrustedUserNavigation(tab);
        break;
      }
      case 'forward': {
        if (await recreateScriptedViewForUser()) break;
        const contents = (await ensureCommandView()).webContents;
        if (source === 'assistant') {
          await this.withAssistantDownloadAttribution(tab, assistantRun!.id, () =>
            this.navigateAssistantHistory(tab, contents, 1, abortSignal),
          );
        } else if (contents.navigationHistory.canGoForward()) {
          const target = contents.navigationHistory.getEntryAtIndex(contents.navigationHistory.getActiveIndex() + 1);
          if (!target?.url) throw new Error('The next browser history entry is unavailable.');
          const trustedNavigationLease = this.beginTrustedUserNavigation(tab, target.url);
          try {
            contents.navigationHistory.goForward();
          } catch (error) {
            this.clearTrustedUserNavigation(tab, trustedNavigationLease);
            throw error;
          }
        } else this.clearTrustedUserNavigation(tab);
        break;
      }
      case 'toggle-mute': {
        const contents = (await ensureCommandView()).webContents;
        contents.setAudioMuted(!contents.isAudioMuted());
        tab.shell.muted = contents.isAudioMuted();
        break;
      }
      case 'keep-open':
        tab.shell.keepOpen = source === 'assistant' ? true : !tab.shell.keepOpen;
        for (const download of this.activeDownloads.values()) {
          if (download.tabId === tab.shell.id) download.keepOpen = tab.shell.keepOpen;
        }
        break;
      case 'close-others':
        for (const id of [...(this.tabOrder.get(conversationId) ?? [])]) {
          if (id !== tabId) {
            const other = this.tabs.get(id);
            if (other) this.closeTab(other, false);
          }
        }
        break;
      case 'close-right': {
        const order = this.tabOrder.get(conversationId) ?? [];
        const index = order.indexOf(tabId);
        for (const id of order.slice(index + 1)) {
          const other = this.tabs.get(id);
          if (other) this.closeTab(other, false);
        }
        break;
      }
    }
    if (source === 'user' && (command === 'close-others' || command === 'close-right')) {
      // A bulk close can remove the previously active user tab and expose an
      // assistant-created neighbor. Treat that resulting presentation exactly
      // like a direct user selection so turn cleanup cannot close what the user
      // is now looking at.
      await this.takeOverActiveAssistantPresentation(conversationId);
    }
    this.emitTabs(conversationId);
  }

  private closeTab(tab: InternalTab, emit = true, recordClosed = true, userSelectedFallback = false): void {
    const { conversationId, id } = tab.shell;
    const previousOrder = this.tabOrder.get(conversationId) ?? [];
    const closedIndex = previousOrder.indexOf(id);
    this.dropPendingForTab(id);
    if (recordClosed) {
      const closed = this.closedTabs.get(conversationId) ?? [];
      this.closedTabs.set(
        conversationId,
        [
          {
            id: randomUUID(),
            url: tab.shell.url,
            title: tab.shell.title,
            owner: tab.shell.owner,
            keepOpen: tab.shell.keepOpen,
            sensitive: tab.shell.sensitive,
            scopeKey: tab.scopeKey,
          },
          ...closed,
        ].slice(0, 20),
      );
    }
    // Closing destroys the target immediately, so no user interaction can race
    // the best-effort CDP restoration. Keep its rejection observed.
    void this.releaseAssistantRunDialogGuard(tab).catch(() => undefined);
    this.destroyView(tab);
    this.tabs.delete(id);
    // Run-local target mappings intentionally outlive the shell as tombstones.
    // An omitted tabId must fail after close instead of selecting another tab.
    this.releaseScopeRuntimeWhenIdle(tab.scopeKey);
    const nextOrder = previousOrder.filter((candidate) => candidate !== id);
    this.tabOrder.set(conversationId, nextOrder);
    if (this.activeTabs.get(conversationId) === id) {
      const next = nextOrder[Math.min(Math.max(0, closedIndex), nextOrder.length - 1)];
      if (next) {
        this.activeTabs.set(conversationId, next);
        const fallback = this.tabs.get(next);
        if (fallback && userSelectedFallback) this.takeOverTabForUser(fallback);
      } else this.activeTabs.delete(conversationId);
      this.restoreActiveViewAfterClose(conversationId, next, userSelectedFallback);
    }
    if (emit) this.emitTabs(conversationId);
  }

  /** Closing the active tab can select an idle-discarded neighbor whose renderer
   * no longer exists. Recreate that visible page before attaching it; otherwise
   * the native surface stays blank until the user activates the tab a second
   * time. Hidden panels defer restoration to mount(), preserving idle memory. */
  private restoreActiveViewAfterClose(
    conversationId: string,
    tabId: string | undefined,
    userSelectedFallback = false,
  ): void {
    const tab = tabId ? this.tabs.get(tabId) : undefined;
    if (
      !tab ||
      this.mountedConversationId !== conversationId ||
      !this.mountedBounds ||
      !this.browserEnabled ||
      tab.scriptTainted ||
      tab.shell.reloadRequired
    ) {
      const presentationTransition = tab && userSelectedFallback ? this.prepareTabForUserPresentation(tab) : null;
      if (presentationTransition) {
        void presentationTransition.then(
          () => this.attachActiveView(conversationId),
          (error: unknown) => {
            if (tab && this.tabs.get(tab.shell.id) === tab) {
              tab.shell.error ??= error instanceof Error ? error.message : String(error);
              tab.shell.discarded = !tab.view || tab.view.webContents.isDestroyed();
              this.emitTabs(conversationId);
            }
            this.attachActiveView(conversationId);
          },
        );
      } else {
        this.attachActiveView(conversationId);
      }
      return;
    }

    const restore = (async () => {
      if (userSelectedFallback) {
        const presentationTransition = this.prepareTabForUserPresentation(tab);
        if (presentationTransition) await presentationTransition;
      }
      await this.ensureView(tab);
      if (userSelectedFallback) {
        const presentationTransition = this.prepareTabForUserPresentation(tab);
        if (presentationTransition) await presentationTransition;
      }
    })();
    void restore
      .then(() => {
        if (this.tabs.get(tabId!) !== tab || this.activeTabs.get(conversationId) !== tabId) return;
        this.attachActiveView(conversationId);
        this.notifyPanelStateChanged(conversationId);
      })
      .catch((error) => {
        if (this.tabs.get(tabId!) !== tab || this.activeTabs.get(conversationId) !== tabId) return;
        tab.shell.error ??= error instanceof Error ? error.message : String(error);
        tab.shell.discarded = !tab.view || tab.view.webContents.isDestroyed();
        this.emitTabs(conversationId);
        this.notifyPanelStateChanged(conversationId);
      });
  }

  private dropPendingForTab(tabId: string): void {
    this.activeFindRequests.delete(tabId);
    this.pendingElementPickerCancels.get(tabId)?.(new Error('Element picking cancelled because the tab closed.'));
    for (const [promptId, pending] of this.pendingCredentials) {
      if (pending.tabId === tabId) this.dropPendingCredential(promptId);
    }
    for (const [promptId, pending] of this.pendingPermissions) {
      if (pending.tabId !== tabId) continue;
      this.finishPendingPermission(promptId, false);
    }
    for (const [promptId, pending] of this.pendingAuth) {
      if (pending.tabId !== tabId) continue;
      this.finishPendingAuth(promptId);
    }
    this.clearOneTimePermissionsForTab(tabId);
  }

  private cancelElementPickersForConversation(conversationId: string): void {
    for (const tabId of this.tabOrder.get(conversationId) ?? []) {
      this.pendingElementPickerCancels.get(tabId)?.();
    }
  }

  private clearOneTimePermissionsForTab(tabId: string): void {
    for (const key of this.oneTimePermissions) {
      if (key.startsWith(`${tabId}\u0000`)) this.oneTimePermissions.delete(key);
    }
  }

  async reopenClosedTab(
    conversationId: string,
    owner?: BrowserTabOwner,
    assistantRun?: BrowserAssistantRun,
    approvedTabs?: BrowserTabsApproval,
  ): Promise<BrowserTab | null> {
    const [closed, ...rest] = this.closedTabs.get(conversationId) ?? [];
    if (approvedTabs) {
      if (
        approvedTabs.action !== 'reopen_closed' ||
        approvedTabs.conversationId !== conversationId ||
        approvedTabs.closedTabRef !== (closed ?? null)
      ) {
        throw new Error('The closed-tab history changed while approval was pending. Review it and try again.');
      }
    }
    if (!closed) return null;
    if (owner === 'assistant' && closed.sensitive) {
      throw new Error('Reopening a tab is blocked because it contained password data when it was closed.');
    }
    this.closedTabs.set(conversationId, rest);
    let tab: BrowserTab;
    try {
      tab = await this.createTab({ conversationId, url: closed.url, owner: owner ?? 'user' }, assistantRun);
    } catch (error) {
      // Popping the entry is transactional: a profile change, tab-limit race,
      // cancellation, or failed navigation must not silently lose reopen history.
      this.closedTabs.set(conversationId, [closed, ...(this.closedTabs.get(conversationId) ?? [])].slice(0, 20));
      throw error;
    }
    if (closed.keepOpen) await this.commandTab(conversationId, tab.id, 'keep-open');
    return tab;
  }

  reorderTabs(conversationId: string, orderedTabIds: string[]): void {
    const current = this.tabOrder.get(conversationId) ?? [];
    if (
      orderedTabIds.length !== current.length ||
      new Set(orderedTabIds).size !== current.length ||
      orderedTabIds.some((id) => !current.includes(id))
    ) {
      throw new Error('Tab reorder must include every tab in this chat exactly once.');
    }
    this.tabOrder.set(conversationId, [...orderedTabIds]);
    this.emitTabs(conversationId);
  }

  async navigate(
    conversationId: string,
    tabId: string,
    input: string,
    source: 'user' | 'assistant' = 'user',
    assistantRun?: BrowserAssistantRun,
    visibleAssistantGeneration?: number,
  ): Promise<void> {
    const tab = this.requireTab(conversationId, tabId);
    if (source === 'assistant' && !assistantRun) throw new Error('Assistant navigation requires turn ownership.');
    if (source === 'user') {
      const previewPreemption = this.preemptMenuPreviewForTab(
        tab,
        'Browser menu preview was cancelled because the user navigated this tab.',
      );
      if (previewPreemption) await previewPreemption;
    }
    const operation = async (documentLease?: AssistantDocumentLease) => {
      const url = normalizeOmniboxInput(input, this.config().searchProvider);
      const abortSignal = assistantRun?.abortSignal;
      if (documentLease && visibleAssistantGeneration !== undefined) {
        documentLease.visibleAssistantGeneration = visibleAssistantGeneration;
        this.assertAssistantDocumentLease(tab, documentLease);
      }
      throwIfBrowserAborted(abortSignal);
      if (
        source === 'user' &&
        (tab.scriptTainted ||
          tab.privateNetworkNewDocumentGuard ||
          tab.assistantNativeUiNewDocumentGuard ||
          tab.assistantDialogsDisabledRunId)
      ) {
        const trustedNavigationLease = this.beginTrustedUserNavigation(tab, url);
        this.resetScriptedRendererForUser(tab);
        tab.shell.url = url;
        this.emitTabs(conversationId);
        try {
          await this.ensureView(tab);
        } catch (error) {
          this.clearTrustedUserNavigation(tab, trustedNavigationLease);
          throw error;
        }
        return;
      }
      if (source === 'assistant') {
        this.clearTrustedUserNavigation(tab);
        tab.aiNetworkRestricted = true;
        tab.aiControlOwnerId = assistantRun!.id;
        tab.aiControlGeneration = null;
      }
      if (source === 'assistant') {
        const generation = this.assistantGeneration(conversationId, assistantRun!.id);
        tab.aiControlGeneration = generation;
        await this.assertAssistantNavigationAllowed(url, tab.partition, abortSignal);
        throwIfBrowserAborted(abortSignal);
        this.assertAssistantDocumentLease(tab, documentLease!);
        if (generation !== this.assistantGeneration(conversationId, assistantRun!.id)) {
          throw new Error('The assistant browser turn ended before navigation began.');
        }
        tab.aiNetworkRestricted = true;
        this.markAssistantControlledOrigin(tab.scopeKey, url);
      }
      throwIfBrowserAborted(abortSignal);
      const contents = (
        source === 'assistant'
          ? await this.ensureAssistantView(tab, assistantRun!, documentLease!)
          : await this.ensureView(tab)
      ).webContents;
      if (source === 'assistant') {
        this.assertAssistantDocumentLease(tab, documentLease!);
        await this.withAssistantDownloadAttribution(tab, assistantRun!.id, () =>
          this.runRendererOperationWithDeadline(
            tab,
            contents,
            'Browser page load',
            ASSISTANT_PAGE_LOAD_TIMEOUT_MS,
            () => contents.loadURL(url).then(() => undefined),
            abortSignal,
          ),
        );
        return;
      }
      const trustedNavigationLease = this.beginTrustedUserNavigation(tab, url);
      try {
        await contents.loadURL(url);
      } finally {
        this.clearTrustedUserNavigation(tab, trustedNavigationLease);
      }
    };
    return this.withScopeActivity(tab.scopeKey, () =>
      source === 'assistant' ? this.withAssistantControl(tab, assistantRun!, operation) : operation(),
    );
  }

  private async guardAssistantTab(
    tab: InternalTab,
    run: BrowserAssistantRun,
    generation: number,
  ): Promise<AssistantDocumentLease> {
    if (!this.config().enabled) throw new Error('The in-app browser is disabled in Settings.');
    throwIfBrowserAborted(run.abortSignal);
    const wasRestricted = tab.aiNetworkRestricted;
    const previousControlOwnerId = tab.aiControlOwnerId;
    const previousControlGeneration = tab.aiControlGeneration;
    if (generation !== this.assistantGeneration(tab.shell.conversationId, run.id)) {
      throw new Error('The assistant browser turn ended before control began.');
    }
    tab.aiNetworkRestricted = true;
    this.clearTrustedUserNavigation(tab);
    tab.aiControlOwnerId = run.id;
    tab.aiControlGeneration = generation;
    // A page load or promise that is already blocked on native UI must not make
    // assistant control depend on mounting the Browser sidebar. Once AI control
    // begins, fail every outstanding interactive permission/auth challenge for
    // this tab closed; user browsing can request it again after control ends.
    this.dismissPendingPermissionsForTab(tab.shell.id);
    this.dismissPendingAuthForTab(tab.shell.id);
    let documentLease: AssistantDocumentLease = {
      runId: run.id,
      runGeneration: generation,
      hostRendererAuthorityGeneration: this.hostRendererAuthorityGeneration,
      tabGeneration: tab.generation,
      userNavigationLease: tab.trustedUserNavigationLease,
      url: tab.shell.url,
    };
    try {
      if (!INTERNAL_URLS.has(documentLease.url))
        await this.assertAssistantNavigationAllowed(documentLease.url, tab.partition, run.abortSignal);
      throwIfBrowserAborted(run.abortSignal);
      if (generation !== this.assistantGeneration(tab.shell.conversationId, run.id)) {
        throw new Error('The assistant browser turn ended while control was waiting.');
      }
      if (!this.config().enabled) throw new Error('The in-app browser is disabled in Settings.');
      this.assertAssistantDocumentLease(tab, documentLease);
      documentLease = await this.sanitizeUnrestrictedDocumentForAssistant(tab, run, documentLease);
      this.assertAssistantDocumentLease(tab, documentLease);
      this.markAssistantControlledOrigin(tab.scopeKey, documentLease.url);
      // A worker registered before this turn has no registration event from
      // which to recover assistant provenance. Persist the conservative profile
      // latch as soon as control succeeds so delayed worker traffic remains
      // private-network guarded after the tab or assistant run disappears.
      this.restrictBackgroundNetworkForScope(tab.scopeKey);
      // User activity can occur concurrently, including while DNS resolution is
      // pending. The operation-depth lease prevents that activity from dropping
      // the policy; reassert it before any page script/input is dispatched.
      tab.aiNetworkRestricted = true;
      tab.aiControlOwnerId = run.id;
      tab.aiControlGeneration = generation;
      return documentLease;
    } catch (error) {
      // A rejected attempt to control a user-owned private-network tab must not
      // leave that tab under the AI navigation policy after control returns to
      // the user.
      tab.aiNetworkRestricted = wasRestricted;
      tab.aiControlOwnerId = previousControlOwnerId;
      tab.aiControlGeneration = previousControlGeneration;
      throw error;
    }
  }

  private resetUnrestrictedDocumentNetworkState(tab: InternalTab): void {
    tab.unrestrictedNetworkGeneration = tab.generation;
    tab.unrestrictedNetworkValidations = new Map();
    tab.unrestrictedNetworkUnsafe = false;
  }

  private retainUnsafeOriginProvenance(scopeKey: string, origin: string): void {
    if (/^https?:\/\//i.test(origin)) {
      try {
        this.storeForScope(scopeKey).markUnsafeOrigin(origin);
        return;
      } catch (error) {
        console.warn('[Browser] Could not persist unsafe-origin network provenance:', error);
      }
    }

    // Without a durable, canonical origin marker a reload or app restart could
    // expose surviving local/Cache Storage to the assistant. Quarantine the
    // whole profile until Browser Data clearing proves Chromium state is gone.
    this.clearQuarantinedScopes.add(scopeKey);
    this.restrictedBackgroundScopes.add(scopeKey);
    try {
      if (!markPendingBrowserCleanupScopeKey(this.appHome, scopeKey)) {
        this.pendingCleanupQuarantineUnreadable = true;
      }
    } catch (error) {
      this.pendingCleanupQuarantineUnreadable = true;
      console.error('[Browser] Could not retain unsafe-origin cleanup metadata:', error);
    }
  }

  /** User browsing is intentionally unrestricted, but a later assistant must
   * not inherit pixels or DOM state fetched from a private-network origin. Keep
   * a bounded, document-generation-scoped set of strict-policy validations
   * without delaying the user's request. */
  private trackUnrestrictedDocumentRequest(
    tab: InternalTab,
    url: string,
    partition: string,
    documentUrl = tab.shell.url,
  ): void {
    if (tab.aiNetworkRestricted) return;
    if (tab.unrestrictedNetworkGeneration !== tab.generation || !(tab.unrestrictedNetworkValidations instanceof Map)) {
      this.resetUnrestrictedDocumentNetworkState(tab);
    }
    const validations = tab.unrestrictedNetworkValidations;
    const documentOrigin = normalizedOrigin(documentUrl);
    const scopeGeneration = this.currentScopeGeneration(tab.scopeKey);
    const retainUnsafe = () => {
      if (this.currentScopeGeneration(tab.scopeKey) === scopeGeneration) {
        this.retainUnsafeOriginProvenance(tab.scopeKey, documentOrigin);
      }
    };
    const markUnsafe = () => {
      tab.unrestrictedNetworkUnsafe = true;
      retainUnsafe();
    };
    let origin: string;
    const policyUrl = aiRequestPolicyUrl(url);
    try {
      origin = new URL(policyUrl).origin;
    } catch {
      markUnsafe();
      return;
    }
    if (validations.has(origin)) return;
    if (validations.size >= MAX_UNRESTRICTED_DOCUMENT_ORIGINS) {
      markUnsafe();
      return;
    }
    const documentGeneration = tab.generation;
    const validation = Promise.resolve()
      // Always classify against the strict policy. If the user temporarily
      // allows assistant private-network access we retain provenance but defer
      // sanitation; tightening the setting later must not forget stored data.
      .then(() => this.assertAssistantNavigationAllowed(policyUrl, partition, undefined, false))
      .catch(() => {
        // Navigation/view teardown may have replaced the generation before DNS
        // finishes, but storage written by the old document still survives.
        // Retain profile provenance independently of the generation-local flag.
        retainUnsafe();
        if (
          this.tabs.get(tab.shell.id) === tab &&
          tab.generation === documentGeneration &&
          tab.unrestrictedNetworkValidations === validations
        ) {
          tab.unrestrictedNetworkUnsafe = true;
        }
      });
    validations.set(origin, validation);
  }

  /** Service-worker and other session-owned requests have no WebContents id.
   * Attribute them only to unrestricted documents whose origin matches the
   * browser-supplied referrer. Binding a worker from origin A to an unrelated
   * open tab at origin B would sanitize B while leaving A's Cache Storage
   * available to a later assistant. If the origin cannot be matched, callers
   * validate the destination under the strict policy before admitting it. */
  private trackUnrestrictedScopeRequest(scopeKey: string, url: string, partition: string, referrer: string): boolean {
    const referrerOrigin = normalizedOrigin(referrer);
    if (!/^https?:\/\//i.test(referrerOrigin)) return false;
    let tracked = false;
    for (const tab of this.tabs.values()) {
      if (tab.scopeKey !== scopeKey || tab.aiNetworkRestricted || normalizedOrigin(tab.shell.url) !== referrerOrigin)
        continue;
      tracked = true;
      this.trackUnrestrictedDocumentRequest(tab, url, partition, referrer);
    }
    return tracked;
  }

  private async sanitizeUnrestrictedDocumentForAssistant(
    tab: InternalTab,
    run: BrowserAssistantRun,
    documentLease: AssistantDocumentLease,
  ): Promise<AssistantDocumentLease> {
    if (this.aiAllowPrivateNetwork) return documentLease;
    const currentDocumentValidationAvailable =
      tab.unrestrictedNetworkGeneration === documentLease.tabGeneration &&
      tab.unrestrictedNetworkValidations instanceof Map;
    if (currentDocumentValidationAvailable) {
      await Promise.all(tab.unrestrictedNetworkValidations.values());
      throwIfBrowserAborted(run.abortSignal);
      this.assertAssistantDocumentLease(tab, documentLease);
    }
    const origin = normalizedOrigin(documentLease.url);
    const persistedUnsafe = /^https?:\/\//i.test(origin) && this.storeForScope(tab.scopeKey).isUnsafeOrigin(origin);
    if (!tab.unrestrictedNetworkUnsafe && !persistedUnsafe) return documentLease;
    if (tab.shell.sensitive) {
      throw new Error(
        'Assistant control is blocked because this page combined password data with resources that are unavailable under the AI private-network policy. Navigate or reload the page manually first.',
      );
    }
    return this.clearUnsafeOriginStateForAssistant(tab, run, documentLease);
  }

  /** An unrestricted page can persist a private-network response outside the
   * HTTP cache and rehydrate it after a hard reload. Tear down every idle
   * same-origin renderer, stop workers/connections, and clear only non-cookie
   * origin storage before recreating the controlled tab under strict policy.
   * Cookies intentionally survive so the user's authenticated session remains
   * available to the assistant. */
  private async clearUnsafeOriginStateForAssistant(
    tab: InternalTab,
    run: BrowserAssistantRun,
    documentLease: AssistantDocumentLease,
  ): Promise<AssistantDocumentLease> {
    const origin = normalizedOrigin(documentLease.url);
    if (origin === 'unknown') {
      throw new Error('The page origin could not be sanitized for assistant control.');
    }
    const originKey = `${tab.scopeKey}\u0000${origin}`;
    const existingOwner = this.clearingOrigins.get(originKey);
    if (existingOwner && existingOwner !== tab.shell.id) {
      throw new Error('Another Browser tab is already preparing this origin for assistant control.');
    }
    this.clearingOrigins.set(originKey, tab.shell.id);
    const targetHadLiveView = !!tab.view && !tab.view.webContents.isDestroyed();
    const trustedUserNavigationLease = tab.trustedUserNavigationLease;
    const affectedTabs = [...this.tabs.values()].filter(
      (candidate) => candidate.scopeKey === tab.scopeKey && normalizedOrigin(candidate.shell.url) === origin,
    );
    const changedConversations = new Set(affectedTabs.map((candidate) => candidate.shell.conversationId));
    let storageCleared = false;
    const assertControlCurrent = (): void => {
      throwIfBrowserAborted(run.abortSignal);
      if (
        this.tabs.get(tab.shell.id) !== tab ||
        tab.trustedUserNavigationLease !== trustedUserNavigationLease ||
        documentLease.runGeneration !== this.assistantGeneration(tab.shell.conversationId, run.id) ||
        tab.aiControlOwnerId !== run.id ||
        tab.aiControlGeneration !== documentLease.runGeneration ||
        this.scopeUnavailable(tab.scopeKey)
      ) {
        throw new Error('The page changed while its stored network state was being prepared for assistant control.');
      }
    };

    try {
      assertControlCurrent();
      const competingAction = affectedTabs.find((candidate) => candidate !== tab && candidate.aiActionDepth > 0);
      if (competingAction) {
        throw new Error('Another Browser tab is actively using this origin; retry assistant control when it is idle.');
      }

      // Install both process-local and durable background guards before the
      // first await. A worker may otherwise write another private response into
      // Cache Storage while its old renderer is being reclaimed.
      this.markAssistantControlledOrigin(tab.scopeKey, documentLease.url);
      this.restrictBackgroundNetworkForScope(tab.scopeKey);
      for (const candidate of affectedTabs) {
        candidate.aiNetworkRestricted = true;
        this.clearTrustedUserNavigation(candidate);
        if (candidate.view && !candidate.view.webContents.isDestroyed()) {
          candidate.generation++;
          this.destroyView(candidate);
          candidate.shell.discarded = true;
          candidate.shell.sensitive = false;
        }
      }
      for (const conversationId of changedConversations) this.emitTabs(conversationId);
      await Promise.all(
        affectedTabs.filter((candidate) => candidate !== tab).map((candidate) => candidate.queue.whenIdle()),
      );
      assertControlCurrent();

      const scopedSession = session.fromPartition(tab.partition);
      await this.stopRunningServiceWorkers(scopedSession, undefined, true);
      assertControlCurrent();
      await scopedSession.closeAllConnections();
      assertControlCurrent();
      await scopedSession.clearStorageData({
        origin,
        storages: UNSAFE_ORIGIN_STORAGE_TYPES,
      });
      storageCleared = true;
      // Commit the durable provenance removal only after Chromium confirms that
      // every non-cookie storage category for this origin was cleared.
      this.storeForScope(tab.scopeKey).clearUnsafeOrigin(origin);
      assertControlCurrent();
      for (const candidate of affectedTabs) this.resetUnrestrictedDocumentNetworkState(candidate);

      if (targetHadLiveView) {
        await this.ensureView(tab, run.abortSignal, ASSISTANT_PAGE_LOAD_TIMEOUT_MS);
        assertControlCurrent();
      }
      return {
        ...documentLease,
        tabGeneration: tab.generation,
        userNavigationLease: tab.trustedUserNavigationLease,
        url: tab.shell.url,
      };
    } catch (error) {
      if (!storageCleared) {
        for (const candidate of affectedTabs) {
          candidate.unrestrictedNetworkGeneration = candidate.generation;
          candidate.unrestrictedNetworkValidations = new Map();
          candidate.unrestrictedNetworkUnsafe = true;
        }
      }
      throw error;
    } finally {
      if (this.clearingOrigins.get(originKey) === tab.shell.id) this.clearingOrigins.delete(originKey);
      for (const conversationId of changedConversations) this.emitTabs(conversationId);
    }
  }

  /** Arbitrary evaluation can register an origin-persistent service worker that
   * survives WebContents teardown and an app restart. The profile store latches
   * that origin before evaluation begins. Before any clean renderer is created,
   * destroy same-origin pages, stop running versions, close pooled requests, and
   * remove the registration. The durable latch is cleared last, so every
   * failure keeps future renderers quarantined until a retry succeeds. */
  private async clearScriptedOriginBeforeRenderer(tab: InternalTab, origin: string): Promise<void> {
    const originKey = `${tab.scopeKey}\u0000${origin}`;
    const existing = this.scriptOriginCleanupTails.get(originKey);
    if (existing) {
      await existing;
      return;
    }
    const cleanup = (async () => {
      const store = this.storeForScope(tab.scopeKey);
      if (!store.listScriptCleanupOrigins().includes(origin)) return;
      this.assertScopeAvailable(tab.scopeKey);
      const existingOwner = this.clearingOrigins.get(originKey);
      if (existingOwner && existingOwner !== tab.shell.id) {
        throw new Error('This Browser origin is already being sanitized.');
      }
      this.clearingOrigins.set(originKey, tab.shell.id);
      const affectedTabs = [...this.tabs.values()].filter(
        (candidate) => candidate.scopeKey === tab.scopeKey && normalizedOrigin(candidate.shell.url) === origin,
      );
      const changedConversations = new Set(affectedTabs.map((candidate) => candidate.shell.conversationId));
      try {
        for (const candidate of affectedTabs) {
          if (candidate.view && !candidate.view.webContents.isDestroyed()) {
            candidate.generation++;
            this.destroyView(candidate);
          }
          candidate.shell.discarded = true;
          candidate.shell.sensitive = false;
        }
        for (const conversationId of changedConversations) this.emitTabs(conversationId);
        await Promise.all(
          affectedTabs.filter((candidate) => candidate !== tab).map((candidate) => candidate.queue.whenIdle()),
        );
        this.assertScopeAvailable(tab.scopeKey);
        const scopedSession = session.fromPartition(tab.partition);
        await this.stopRunningServiceWorkers(scopedSession, undefined, true);
        this.assertScopeAvailable(tab.scopeKey);
        await scopedSession.closeAllConnections();
        this.assertScopeAvailable(tab.scopeKey);
        await scopedSession.clearStorageData({
          origin,
          storages: SCRIPTED_ORIGIN_STORAGE_TYPES,
        });
        // Commit the provenance removal only after Chromium confirms that the
        // persistent registration is gone. A metadata write failure therefore
        // remains fail closed even though the native cleanup already succeeded.
        store.clearScriptCleanupOrigin(origin);
        for (const candidate of affectedTabs) {
          candidate.scriptTainted = false;
          candidate.shell.reloadRequired = false;
        }
      } finally {
        if (this.clearingOrigins.get(originKey) === tab.shell.id) this.clearingOrigins.delete(originKey);
        for (const conversationId of changedConversations) this.emitTabs(conversationId);
      }
    })();
    this.scriptOriginCleanupTails.set(originKey, cleanup);
    try {
      await cleanup;
    } finally {
      if (this.scriptOriginCleanupTails.get(originKey) === cleanup) this.scriptOriginCleanupTails.delete(originKey);
    }
  }

  private clearPendingScriptedOriginsBeforeRenderer(tab: InternalTab): Promise<void> | null {
    const origins = this.storeForScope(tab.scopeKey).listScriptCleanupOrigins();
    if (origins.length === 0) return null;
    return (async () => {
      for (const origin of origins) await this.clearScriptedOriginBeforeRenderer(tab, origin);
    })();
  }

  private async assertAssistantNavigationAllowed(
    url: string,
    partition: string,
    abortSignal?: AbortSignal,
    allowPrivateNetwork = this.aiAllowPrivateNetwork,
  ): Promise<void> {
    const targetSession = session.fromPartition(partition);
    await assertAiNavigationAllowed(url, allowPrivateNetwork, async (hostname) => {
      // Do not authorize from a stale host-cache entry. HTTPS authentication
      // keeps a split-DNS hostname meaningful even when this fresh lookup
      // intentionally returns an enterprise-private destination.
      const resolved = await resolveHostWithDeadline(
        targetSession.resolveHost(hostname, { cacheUsage: 'disallowed' }),
        abortSignal,
      );
      const errorCode = (resolved as typeof resolved & { errorCode?: number }).errorCode ?? 0;
      return {
        addresses: resolved.endpoints.map((endpoint) => endpoint.address),
        errorCode,
      };
    });
  }

  async mount(conversationId: string, bounds: BrowserBounds | null): Promise<void> {
    if (!this.config().enabled) {
      const mountedConversationId = this.mountedConversationId;
      if (mountedConversationId) {
        this.invalidatePanelAuthority(mountedConversationId);
        const activeTab = this.tabs.get(this.activeTabs.get(mountedConversationId) ?? '');
        this.invalidateVisibleAssistantOperations(activeTab);
        this.invalidatePhysicalAssistantActions(activeTab);
      }
      this.mountedConversationId = null;
      this.mountedBounds = null;
      this.detachAttachedView();
      if (mountedConversationId) this.notifyPanelStateChanged(mountedConversationId);
      return;
    }
    if (!bounds) {
      // A stale React-effect cleanup from a previous chat must not detach the
      // newer chat's native view. The incoming non-null mount owns that switch.
      // React StrictMode also performs setup -> cleanup -> setup before the
      // first animation-frame bounds report. With no native mount yet there is
      // no presentation state to tear down; background operations are
      // independent of the later bounds report.
      if (this.mountedConversationId === null) {
        this.notifyPanelStateChanged(conversationId);
        return;
      }
      if (this.mountedConversationId !== conversationId) return;
      this.invalidatePanelAuthority(conversationId);
      this.mountedConversationId = null;
      this.mountedBounds = null;
      this.cancelElementPickersForConversation(conversationId);
      this.detachAttachedView();
      this.notifyPanelStateChanged(conversationId);
      return;
    }
    // A tabs-changed(empty) event emitted during conversation deletion can
    // re-run the BrowserPanel mount effect before React switches chats. Keep a
    // durable in-process fence so that stale effect cannot auto-create a tab.
    // Fence ONLY on a DEFINITIVE absence (R179): a transient read failure must not permanently fence
    // a still-live conversation. A not-yet-fenced, present-or-unknown conversation falls through and
    // its actual availability is enforced downstream (assertConversationAvailable) where a transient
    // failure yields a temporary error rather than a permanent fence.
    if (this.removedConversations.has(conversationId) || this.isConversationDefinitivelyAbsent(conversationId)) {
      this.fenceRemovedConversation(conversationId);
      if (this.mountedConversationId === conversationId) {
        this.mountedConversationId = null;
        this.mountedBounds = null;
        this.detachAttachedView();
      }
      return;
    }
    const win = this.getWindow();
    if (!win || win.isDestroyed()) return;
    // Validate before publishing either field. A transient invalid resize must
    // not leave raw rejected bounds available to attachActiveView().
    const validatedBounds = validateBrowserBounds(bounds, win.getContentBounds());
    const previousMountedConversationId = this.mountedConversationId;
    if (previousMountedConversationId && previousMountedConversationId !== conversationId) {
      this.invalidatePanelAuthority(previousMountedConversationId);
      this.notifyPanelStateChanged(previousMountedConversationId);
    }
    if (
      previousMountedConversationId === conversationId &&
      this.mountedBounds !== null &&
      (this.mountedBounds.x !== validatedBounds.x ||
        this.mountedBounds.y !== validatedBounds.y ||
        this.mountedBounds.width !== validatedBounds.width ||
        this.mountedBounds.height !== validatedBounds.height)
    ) {
      this.invalidatePanelLayout(conversationId);
    }
    this.mountedConversationId = conversationId;
    this.mountedBounds = validatedBounds;
    this.emitPendingPrompts(conversationId);
    const active = this.activeTabs.get(conversationId);
    if (!active) {
      this.detachAttachedView();
      this.notifyPanelStateChanged(conversationId);
      return;
    }
    const tab = this.tabs.get(active);
    if (!tab) {
      this.detachAttachedView();
      this.notifyPanelStateChanged(conversationId);
      return;
    }
    // A menu preview is opportunistic and never changes renderer lifecycle.
    // Preempt its short queue task before ensureView captures the same target;
    // any uncancellable native image drain remains independently tracked.
    const previewPreemption = this.preemptMenuPreviewForTab(
      tab,
      'Browser menu preview was cancelled because the user opened this tab.',
    );
    if (previewPreemption) await previewPreemption;
    // Attach whatever ensureView created synchronously, then attach again after
    // any asynchronous cleanup/restoration finished.
    const viewReady = this.ensureView(tab);
    if (tab.view && !tab.view.webContents.isDestroyed()) {
      const presentationTransition = this.prepareTabForUserPresentation(tab);
      if (presentationTransition) await presentationTransition;
    }
    this.attachActiveView(conversationId);
    await viewReady;
    const presentationTransition = this.prepareTabForUserPresentation(tab);
    if (presentationTransition) await presentationTransition;
    this.attachActiveView(conversationId);
    this.notifyPanelStateChanged(conversationId);
  }

  private attachActiveView(conversationId: string, focusRequested = false): void {
    if (this.mountedConversationId !== conversationId || !this.mountedBounds) return;
    const win = this.getWindow();
    if (!win || win.isDestroyed()) return;
    const active = this.activeTabs.get(conversationId);
    const tab = active ? this.tabs.get(active) : null;
    if (!tab?.view || tab.scriptTainted || tab.shell.reloadRequired) {
      this.detachAttachedView();
      return;
    }
    // A background screenshot owns this native view tree entry briefly. User
    // presentation preempts that temporary ownership synchronously: CDP capture
    // can finish against the now-visible compositor, while Browser chrome must
    // never display a blank surface until the screenshot deadline expires.
    if (this.captureHostedView === tab.view) {
      const captureLease = this.captureHostedViewLease?.view === tab.view ? this.captureHostedViewLease : null;
      if (this.attachedView === tab.view) this.attachedView = null;
      this.releaseBackgroundCaptureHostedView(tab.view);
      try {
        win.contentView.addChildView(tab.view);
        if (captureLease) captureLease.returnedToMain = true;
      } catch (error) {
        tab.shell.error = `Browser screenshot presentation recovery failed: ${
          error instanceof Error ? error.message : String(error)
        }`;
        this.emitTabs(conversationId);
        return;
      }
    }
    if (
      tab.assistantBackgroundInitialLoadPending ||
      tab.assistantBackgroundViewportContents?.has(tab.view.webContents) ||
      this.hasPendingBackgroundAutomationArm(tab, tab.view.webContents) ||
      this.hasDispatchedSyntheticInput(tab, tab.view.webContents)
    ) {
      // Authority, background viewport, and input-provenance transitions are
      // intentionally hidden from real input. Mounting remains recorded and
      // their cleanup paths retry attachment after the quarantine is removed.
      this.detachAttachedView();
      tab.view.setVisible(false);
      if (!this.hasStableNativeSurfaceLease(tab.view)) {
        tab.view.setBounds(DEFAULT_DETACHED_VIEW_BOUNDS);
      }
      return;
    }
    if (this.hasInputCoordinateSurfaceLease(tab.view)) {
      const currentBounds = tab.view.getBounds();
      const requestedBounds = this.mountedBounds;
      if (
        currentBounds.x !== requestedBounds.x ||
        currentBounds.y !== requestedBounds.y ||
        currentBounds.width !== requestedBounds.width ||
        currentBounds.height !== requestedBounds.height
      ) {
        // Keep the exact input surface alive but hidden until dispatch finishes.
        // The lease release remounts it at the latest sidebar bounds.
        if (this.attachedView === tab.view) this.attachedView = null;
        tab.view.setVisible(false);
        return;
      }
    }
    const viewChanged = this.attachedView !== tab.view;
    if (viewChanged) {
      this.detachAttachedView();
      // createView hosts every live view exactly once. Attaching only changes
      // presentation; re-adding an existing child can reorder or duplicate it
      // in Electron's native view tree.
      this.attachedView = tab.view;
    }
    tab.view.setBounds(this.mountedBounds);
    tab.view.setVisible(true);
    if (shouldFocusAttachedBrowserView(focusRequested)) tab.view.webContents.focus();
  }

  private detachAttachedView(): void {
    if (!this.attachedView) return;
    try {
      // Keep the renderer hosted but hidden so background loading, automation,
      // and capture continue without painting over React Browser chrome.
      this.attachedView.setVisible(false);
      if (!this.hasStableNativeSurfaceLease(this.attachedView)) {
        this.attachedView.setBounds(DEFAULT_DETACHED_VIEW_BOUNDS);
      }
    } catch {
      // The native view may already be tearing down with its window.
    }
    this.attachedView = null;
  }

  /** Release native ownership synchronously even when the screenshot Promise
   * that moved this view never settles. Renderer deadlines reclaim the exact
   * target without awaiting native/CDP work, so `destroyView()` must be able to
   * clear this global slot independently from the operation's `finally`. */
  private releaseBackgroundCaptureHostedView(view: WebContentsView): void {
    if (this.captureHostedView !== view) return;
    const lease = this.captureHostedViewLease?.view === view ? this.captureHostedViewLease : null;
    // Publish availability before invoking Electron. A native removal failure
    // must not permanently block unrelated hidden screenshots.
    this.captureHostedView = null;
    this.captureHostedViewLease = null;
    try {
      view.setVisible(false);
    } catch {
      // The renderer/native view may already be tearing down.
    }
    const captureHost = lease?.host ?? this.backgroundCaptureHost;
    if (!captureHost || captureHost.isDestroyed()) return;
    try {
      captureHost.contentView.removeChildView(view);
    } catch {
      // Best effort after target loss or BaseWindow teardown.
    }
  }

  private async withBackgroundCaptureHost<T>(
    tab: InternalTab,
    contents: WebContents,
    operation: () => Promise<T>,
  ): Promise<T> {
    const view = tab.view;
    if (!view || view.webContents !== contents || contents.isDestroyed()) {
      throw new Error('The browser page changed before its background screenshot could start.');
    }
    if (this.captureHostedView) {
      throw new Error('Another background browser screenshot is already rendering.');
    }
    const mainWindow = this.requireLiveWindow();
    const bounds = view.getBounds();
    const captureBounds = {
      x: 0,
      y: 0,
      width: Math.max(1, Math.round(bounds.width || DEFAULT_DETACHED_VIEW_BOUNDS.width)),
      height: Math.max(1, Math.round(bounds.height || DEFAULT_DETACHED_VIEW_BOUNDS.height)),
    };
    let displayScaleFactor = 1;
    try {
      // BaseWindow and WebContentsView bounds are device-independent pixels,
      // while Chromium allocates the hidden compositor surface in physical
      // pixels. Use the largest attached-display scale before creating or
      // resizing the host so a high-DPI/spanned target cannot exceed the same
      // native allocation ceiling enforced for visible capturePage().
      displayScaleFactor = Math.max(
        1,
        ...screen
          .getAllDisplays()
          .map((display) => display.scaleFactor)
          .filter((scaleFactor) => Number.isFinite(scaleFactor) && scaleFactor > 0),
      );
    } catch {
      // Production screenshot work runs after Electron's screen module is
      // initialized. Unit-test and late-shutdown shims may not expose it; the
      // capture itself retains its independent geometry/image validation.
    }
    validateScreenshotSize(captureBounds.width * displayScaleFactor, captureBounds.height * displayScaleFactor);
    let captureHost = this.backgroundCaptureHost;
    if (!captureHost || captureHost.isDestroyed()) {
      captureHost = new BaseWindow({
        show: false,
        width: captureBounds.width,
        height: captureBounds.height,
        frame: false,
        focusable: false,
        skipTaskbar: true,
        resizable: false,
        minimizable: false,
        maximizable: false,
        backgroundColor: '#ffffff',
      });
      this.backgroundCaptureHost = captureHost;
    } else {
      captureHost.setContentSize(captureBounds.width, captureBounds.height);
    }
    const captureLease: BrowserBackgroundCaptureLease = {
      view,
      host: captureHost,
      returnedToMain: false,
    };
    this.backgroundCaptureHost = captureHost;
    this.captureHostedView = view;
    this.captureHostedViewLease = captureLease;
    if (this.attachedView === view) this.attachedView = null;
    let removedFromMainHost = false;
    try {
      view.setVisible(false);
      mainWindow.contentView.removeChildView(view);
      removedFromMainHost = true;
      captureHost.contentView.addChildView(view);
      view.setBounds(captureBounds);
      view.setVisible(true);
      return await operation();
    } finally {
      // Publish the global capture slot on every failure path, including a
      // successful main-host removal followed by a throwing capture-host add.
      this.releaseBackgroundCaptureHostedView(view);
      try {
        const currentWindow = this.getWindow();
        if (
          this.tabs.get(tab.shell.id) === tab &&
          tab.view === view &&
          !contents.isDestroyed() &&
          currentWindow &&
          currentWindow !== this.closingHostWindow &&
          !currentWindow.isDestroyed()
        ) {
          try {
            if (!captureLease.returnedToMain) {
              // Re-add only after the matching removal succeeded. If removal
              // itself threw, Electron still owns the original main-tree child
              // and adding it again can reorder or duplicate the native view.
              if (removedFromMainHost && (currentWindow === mainWindow || this.detachedHostViews?.has(view))) {
                currentWindow.contentView.addChildView(view);
                this.detachedHostViews?.delete(view);
              }
              view.setBounds(DEFAULT_DETACHED_VIEW_BOUNDS);
              view.setVisible(false);
            }
          } finally {
            this.attachActiveView(tab.shell.conversationId);
          }
        }
      } finally {
        // No global returned-to-main flag is reset here: a late finalizer owns
        // only captureLease and cannot alter a successor capture.
      }
    }
  }

  /** BaseWindow participates in Electron's application-window count. Tear the
   * hidden capture host down synchronously from the primary window's `close`
   * event so `window-all-closed` remains reachable on Windows and Linux. */
  handleHostWindowWillClose(): void {
    const closingWindow = this.getWindow();
    if (closingWindow && !closingWindow.isDestroyed()) this.closingHostWindow = closingWindow;
    const mountedConversationId = this.mountedConversationId;
    if (mountedConversationId) {
      this.invalidatePanelAuthority(mountedConversationId);
      this.invalidatePanelLayout(mountedConversationId);
      this.cancelElementPickersForConversation(mountedConversationId);
    }
    this.mountedConversationId = null;
    this.mountedBounds = null;
    this.chromeFocusConversationId = null;
    this.hostWindowShown = false;
    this.hostWindowInteractive = false;
    this.attachedView = null;
    const view = this.captureHostedView;
    const host = this.backgroundCaptureHost;
    this.captureHostedView = null;
    this.captureHostedViewLease = null;
    this.backgroundCaptureHost = null;
    if (view) {
      try {
        view.setVisible(false);
      } catch {
        // The view may already be tearing down with the primary window.
      }
      try {
        if (host && !host.isDestroyed()) host.contentView.removeChildView(view);
      } catch {
        // Best effort during native window teardown.
      }
    }
    if (host && !host.isDestroyed()) host.destroy();
    const detached = (this.detachedHostViews ??= new Set<WebContentsView>());
    for (const tab of this.tabs.values()) {
      const retainedView = tab.view;
      if (!retainedView || retainedView.webContents.isDestroyed()) continue;
      try {
        retainedView.setVisible(false);
        if (!this.hasStableNativeSurfaceLease(retainedView)) retainedView.setBounds(DEFAULT_DETACHED_VIEW_BOUNDS);
      } catch {
        // Native teardown can race the close event; ownership is still recorded
        // so the replacement window can either rehost or discard it safely.
      }
      if (closingWindow && !closingWindow.isDestroyed()) {
        try {
          closingWindow.contentView.removeChildView(retainedView);
        } catch {
          // A capture-hosted view was already removed above.
        }
      }
      detached.add(retainedView);
    }
    if (mountedConversationId) this.notifyPanelStateChanged(mountedConversationId);
  }

  /** Reparent retained renderers into a replacement primary BrowserWindow. This
   * is presentation/lifecycle repair only: it never mounts, selects, focuses,
   * reveals, or creates a tab, so headless assistant work remains independent
   * from the React sidebar. */
  handleHostWindowCreated(): void {
    if (this.disposed || this.shuttingDown) return;
    const win = this.getWindow();
    if (!win || win.isDestroyed() || win.webContents?.isDestroyed?.()) return;
    if (this.closingHostWindow === win) return;
    this.closingHostWindow = null;
    const detached = (this.detachedHostViews ??= new Set<WebContentsView>());
    for (const retainedView of [...detached]) {
      const tab = [...this.tabs.values()].find((candidate) => candidate.view === retainedView);
      if (!tab || retainedView.webContents.isDestroyed()) {
        detached.delete(retainedView);
        continue;
      }
      try {
        retainedView.setVisible(false);
        if (!this.hasStableNativeSurfaceLease(retainedView)) retainedView.setBounds(DEFAULT_DETACHED_VIEW_BOUNDS);
        win.contentView.addChildView(retainedView);
        detached.delete(retainedView);
      } catch (error) {
        tab.shell.error = `Browser renderer rehosting failed: ${error instanceof Error ? error.message : String(error)}`;
        this.emitTabs(tab.shell.conversationId);
      }
    }
  }

  private async ensureView(
    tab: InternalTab,
    abortSignal?: AbortSignal,
    timeoutMs = abortSignal ? ASSISTANT_PAGE_LOAD_TIMEOUT_MS : 0,
    preserveExistingLoadingViewOnTimeout = false,
    recordExpectedInitialLoadGeneration?: (generation: number) => void,
  ): Promise<WebContentsView> {
    const deadlineAt = timeoutMs > 0 ? Date.now() + timeoutMs : null;
    const remainingRendererTimeout = (operation: string): number => {
      if (deadlineAt === null) return 0;
      const remaining = Math.ceil(deadlineAt - Date.now());
      if (remaining <= 0) throw new BrowserRendererDeadlineError(operation, timeoutMs);
      return remaining;
    };
    const joinSharedLoad = async (
      sharedLoadPromise: Promise<WebContentsView>,
      sharedLoadState: BrowserViewLoadState | undefined,
      preservePreexistingLoadOnCancellation: boolean,
    ): Promise<WebContentsView> => {
      let cancellation: 'timeout' | 'abort' | null = null;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let abortListener: (() => void) | undefined;
      let waiterReleased = false;
      if (sharedLoadState) sharedLoadState.waiters++;
      const releaseWaiter = (): void => {
        if (!sharedLoadState || waiterReleased) return;
        waiterReleased = true;
        sharedLoadState.waiters = Math.max(0, sharedLoadState.waiters - 1);
      };
      const cancelled = new Promise<never>((_resolve, reject) => {
        const remaining = deadlineAt === null ? 0 : remainingRendererTimeout('Browser page load');
        if (remaining > 0) {
          timer = setTimeout(() => {
            cancellation = 'timeout';
            reject(new BrowserRendererDeadlineError('Browser page load', timeoutMs));
          }, remaining);
          timer.unref?.();
        }
        if (abortSignal) {
          abortListener = () => {
            cancellation = 'abort';
            reject(new Error('Browser page load was cancelled.'));
          };
          abortSignal.addEventListener('abort', abortListener, { once: true });
          if (abortSignal.aborted) abortListener();
        }
      });
      try {
        const restoredView = await Promise.race([sharedLoadPromise, cancelled]);
        if (sharedLoadState?.expectedInitialLoadGeneration !== undefined) {
          recordExpectedInitialLoadGeneration?.(sharedLoadState.expectedInitialLoadGeneration);
        }
        return restoredView;
      } catch (error) {
        if (cancellation && !preservePreexistingLoadOnCancellation) {
          releaseWaiter();
          const mayReclaimSharedRestoration =
            !sharedLoadState ||
            (sharedLoadState.waiters === 0 &&
              sharedLoadState.promise === sharedLoadPromise &&
              tab.viewLoadState === sharedLoadState);
          if (mayReclaimSharedRestoration && tab.viewLoadPromise === sharedLoadPromise) {
            const loadingView = sharedLoadState?.view ?? tab.view;
            if (loadingView && tab.view === loadingView && !loadingView.webContents.isDestroyed()) {
              this.destroyView(tab);
            }
            tab.shell.discarded = true;
            tab.shell.error =
              cancellation === 'timeout' ? 'Browser page load timed out.' : 'Browser page load was cancelled.';
            this.emitTabs(tab.shell.conversationId);
            if (sharedLoadState) {
              sharedLoadState.reject?.(error);
            }
          }
        }
        throw error;
      } finally {
        releaseWaiter();
        if (timer) clearTimeout(timer);
        if (abortSignal && abortListener) abortSignal.removeEventListener('abort', abortListener);
      }
    };
    this.assertHostRendererOperationCurrent();
    if (this.disposed) throw new Error('The in-app browser has been disposed.');
    if (!this.config().enabled) throw new Error('The in-app browser is disabled in Settings.');
    this.requireLiveWindow();
    this.assertScopeAvailable(tab.scopeKey);
    if (this.tabs.get(tab.shell.id) !== tab) throw new Error('This browser tab has been closed.');
    throwIfBrowserAborted(abortSignal);
    const origin = normalizedOrigin(tab.shell.url);
    const originClearOwner = this.clearingOrigins.get(`${tab.scopeKey}\u0000${origin}`);
    if (originClearOwner && originClearOwner !== tab.shell.id) {
      throw new Error('This Browser origin is being prepared for assistant control.');
    }
    if (tab.view && !tab.view.webContents.isDestroyed()) {
      const previewRecovery = this.preemptMenuPreviewForTab(tab, 'Browser menu preview was preempted by Browser work.');
      if (previewRecovery) {
        await previewRecovery;
        throwIfBrowserAborted(abortSignal);
        if (this.tabs.get(tab.shell.id) !== tab) throw new Error('This browser tab has been closed.');
      }
    }
    if (tab.viewLoadPromise) {
      // A user may have started this restoration without a deadline. An
      // assistant joining that shared load still needs its own abort/deadline.
      // Most operations reclaim a wedged target; bounded network observation
      // can instead leave an already-guarded user renderer loading and return a
      // content-free timeout result.
      const sharedLoadPromise = tab.viewLoadPromise;
      const sharedLoadState = tab.viewLoadState?.promise === sharedLoadPromise ? tab.viewLoadState : undefined;
      return joinSharedLoad(sharedLoadPromise, sharedLoadState, preserveExistingLoadingViewOnTimeout);
    }
    if (tab.view && !tab.view.webContents.isDestroyed()) return tab.view;
    throwIfBrowserAborted(abortSignal);
    // Only manager-issued loadURL calls may advance an approved discarded-tab
    // restoration lease. A page/user navigation interleaved with those calls
    // produces an extra generation and is rejected after ensureView returns.
    let expectedInitialLoadGeneration = tab.generation;
    const loadState: BrowserViewLoadState = { promise: null, waiters: 0 };
    // Publish the per-tab barrier before scripted-origin cleanup, proxy setup,
    // or native view creation can yield. Every concurrent caller therefore
    // joins this exact restoration instead of observing a blank renderer as
    // ready or creating a competing WebContentsView.
    const restoreView = async (): Promise<WebContentsView> => {
      const pendingScriptCleanup = this.clearPendingScriptedOriginsBeforeRenderer(tab);
      if (pendingScriptCleanup) {
        await pendingScriptCleanup;
      }
      this.assertScopeAvailable(tab.scopeKey);
      if (this.tabs.get(tab.shell.id) !== tab) throw new Error('This browser tab has been closed.');
      if (tab.viewLoadState !== loadState) {
        throw new Error('The browser page changed while its renderer was being restored.');
      }
      // A hidden renderer bootstrap navigates through about:blank and therefore
      // updates shell metadata before the requested navigation begins. Preserve
      // the caller's target independently of those intermediate events.
      const requestedInitialUrl = tab.shell.url || 'about:blank';
      // Initial-load presentation is shared tab state, not policy inherited
      // from whichever caller happened to publish the restoration barrier.
      // Assistant-owned/control renderers use a deterministic detached viewport
      // only when the page is not actually presented to the user.
      const backgroundInitialLoad =
        requestedInitialUrl !== 'about:blank' &&
        (tab.shell.owner === 'assistant' ||
          typeof tab.assistantOwnerId === 'string' ||
          typeof tab.aiControlOwnerId === 'string') &&
        !this.isTabPresentedToUser(tab);
      if (backgroundInitialLoad) tab.assistantBackgroundInitialLoadPending = true;
      let view: WebContentsView;
      try {
        view = this.createView(tab);
        loadState.view = view;
      } catch (error) {
        if (backgroundInitialLoad) tab.assistantBackgroundInitialLoadPending = false;
        throw error;
      }
      try {
        if (this.validatingProxy) {
          const scopedSession = session.fromPartition(tab.partition);
          try {
            await this.validatingProxy.configureSession(scopedSession);
          } catch (error) {
            if (this.tabs.get(tab.shell.id) === tab && tab.view === view) {
              this.destroyView(tab);
              tab.shell.discarded = true;
            }
            throw new Error('The Browser connection-validation proxy could not start.', { cause: error });
          }
          this.assertScopeAvailable(tab.scopeKey);
          if (
            this.tabs.get(tab.shell.id) !== tab ||
            tab.view !== view ||
            view.webContents.isDestroyed() ||
            tab.viewLoadState !== loadState
          ) {
            throw new Error('The browser page was closed while it was loading.');
          }
        }
        // createView installs the native surface synchronously. Attach an
        // active restored tab before waiting for a slow or auth-blocked load so
        // the user can see and stop it instead of staring at an empty viewport.
        this.attachActiveView(tab.shell.conversationId);
        const guardInitialLoad =
          tab.aiNetworkRestricted && !tab.trustedUserNavigation && this.aiAllowPrivateNetwork === false;
        let initialGuardReady = !guardInitialLoad;
        try {
          const initialUrl = typeof view.webContents.getURL === 'function' ? view.webContents.getURL() : undefined;
          const activeDialogGuard =
            tab.aiControlOwnerId && tab.assistantDialogGuard?.runId === tab.aiControlOwnerId
              ? tab.assistantDialogGuard
              : undefined;
          if ((backgroundInitialLoad || activeDialogGuard) && initialUrl === '') {
            // Electron 41 can crash if a debugger domain is enabled before a
            // new WebContents owns its first renderer target. Bootstrap an
            // inert, preload-restricted blank document before installing either
            // hidden metrics or assistant dialog handling.
            await this.runRendererOperationWithDeadline(
              tab,
              view.webContents,
              'Browser background renderer bootstrap',
              BACKGROUND_VIEWPORT_TIMEOUT_MS,
              () => {
                expectedInitialLoadGeneration += 1;
                return view.webContents.loadURL('about:blank');
              },
            );
          }
          const dialogGuard = activeDialogGuard;
          if (dialogGuard) {
            await this.protectAssistantDialogs(tab, view.webContents, dialogGuard);
          }
          if (backgroundInitialLoad) {
            // The user may take over this tab while the inert bootstrap load is
            // awaiting Chromium. Recheck the takeover marker immediately
            // before installing hidden metrics so a late 1280x800 override can
            // never replace the user's mounted sidebar viewport.
            if (tab.assistantBackgroundInitialLoadPending) {
              await this.enableAssistantBackgroundViewport(
                tab,
                view.webContents,
                undefined,
                undefined,
                BACKGROUND_VIEWPORT_TIMEOUT_MS,
              );
            }
          }
          await this.runRendererOperationWithDeadline(
            tab,
            view.webContents,
            'Browser page load',
            0,
            async () => {
              const initialUrl = typeof view.webContents.getURL === 'function' ? view.webContents.getURL() : undefined;
              const guardAfterInitialLoad = guardInitialLoad && initialUrl === '';
              if (guardInitialLoad && !guardAfterInitialLoad) {
                await this.installPrivateNetworkNewDocumentGuard(tab, view.webContents);
                initialGuardReady = true;
              }
              // A new restricted WebContents already owns an initial blank
              // target, but Chromium does not expose its execution context or
              // accept Page.addScriptToEvaluateOnNewDocument until the first
              // navigation starts. The hardened frame preload is already
              // configured with the blocking flag, so that first document is
              // protected before page script; register and verify the durable
              // CDP guard immediately after it becomes live.
              const initialBlankReady =
                guardInitialLoad && requestedInitialUrl === 'about:blank' && initialUrl === 'about:blank';
              if (!initialBlankReady) {
                expectedInitialLoadGeneration += 1;
                await view.webContents.loadURL(requestedInitialUrl);
              }
              if (guardAfterInitialLoad) {
                await this.installPrivateNetworkNewDocumentGuard(tab, view.webContents);
                initialGuardReady = true;
              }
            },
            undefined,
          );
        } catch (error) {
          // A preload-restricted renderer is safe but unusable if main could not
          // verify its membrane and register the same guard for every future
          // document. Reclaim it before exposing the failed shell so a retry
          // starts from a known clean target.
          if (!initialGuardReady && this.tabs.get(tab.shell.id) === tab && tab.view === view) {
            this.destroyView(tab);
            tab.shell.discarded = true;
          }
          throw error;
        }
      } finally {
        if (backgroundInitialLoad) {
          await this.restoreAssistantBackgroundViewport(
            tab,
            view.webContents,
            // Cleanup is a separate bounded renderer transition. Do not inherit
            // a nearly exhausted page-load budget: a 1 ms clear-metrics timeout
            // would leave the successful page permanently quarantined from a
            // later user mount even though background loading itself completed.
            BACKGROUND_VIEWPORT_TIMEOUT_MS,
          );
          tab.assistantBackgroundInitialLoadPending = false;
          if (this.tabs.get(tab.shell.id) === tab) this.attachActiveView(tab.shell.conversationId);
        }
      }
      if (this.tabs.get(tab.shell.id) !== tab || tab.view !== view || view.webContents.isDestroyed()) {
        throw new Error('The browser page was closed while it was loading.');
      }
      this.assertHostRendererOperationCurrent();
      loadState.expectedInitialLoadGeneration = expectedInitialLoadGeneration;
      return view;
    };
    let resolveLoad!: (view: WebContentsView) => void;
    let rejectLoad!: (error: unknown) => void;
    const loadPromise = new Promise<WebContentsView>((resolve, reject) => {
      resolveLoad = resolve;
      rejectLoad = reject;
    });
    loadState.promise = loadPromise;
    loadState.reject = rejectLoad;
    tab.viewLoadPromise = loadPromise;
    tab.viewLoadState = loadState;
    // `preserveExistingLoadingViewOnTimeout` protects a restoration that this
    // observer merely joined. This call published the restoration itself, so a
    // timeout must reclaim it when no other waiter has since joined.
    const joinedLoad = joinSharedLoad(loadPromise, loadState, false);
    // Start only after the shared state is visible. restoreView still runs
    // synchronously through native creation until its first real await, which
    // keeps active-tab attachment responsive while closing the publication gap.
    const clearSharedLoad = (): void => {
      if (tab.viewLoadPromise === loadPromise) tab.viewLoadPromise = null;
      if (tab.viewLoadState === loadState) tab.viewLoadState = undefined;
    };
    void loadPromise.then(clearSharedLoad, clearSharedLoad);
    // The shared restoration must not inherit the publishing renderer IPC's
    // AsyncLocalStorage lease. Each caller—including the publisher—waits through
    // its own wrapper above, while the core is governed only by tab/profile
    // identity and fixed internal safety deadlines.
    const startSharedRestore = (): void => {
      void restoreView().then(resolveLoad, rejectLoad);
    };
    if (this.hostRendererOperationContext) this.hostRendererOperationContext.exit(startSharedRestore);
    else startSharedRestore();
    return joinedLoad;
  }

  private createView(tab: InternalTab, inheritedOptions?: Electron.BrowserWindowConstructorOptions): WebContentsView {
    const win = this.requireLiveWindow();
    this.assertScopeAvailable(tab.scopeKey);
    const ses = session.fromPartition(tab.partition);
    configureBrowserSession(ses);
    this.wireSession(ses, tab.partition, tab.scopeKey);
    // Electron adds private opener/guest linkage to the exact options object
    // passed to createWindow. Reusing that object is required for window.opener
    // and prevents Chromium from creating a second, unmanaged popup contents.
    const viewOptions = inheritedOptions ?? {};
    const webPreferences = { ...(viewOptions.webPreferences ?? {}) } as Record<string, unknown>;
    hardenRemoteWebPreferences(webPreferences);
    if (tab.assistantPopupDialogsDisabled || tab.assistantDialogsDisabledRunId) webPreferences.disableDialogs = true;
    // The opener already uses this profile, but explicitly pin the popup to the
    // tab's partition and Kai's sandboxed page preload instead of trusting any
    // window-feature preferences supplied by remote content.
    delete webPreferences.session;
    // The session-level frame preload runs in main and cross-origin child
    // frames without granting those pages Node integration.
    const activatePrivateNetworkGuard =
      tab.aiNetworkRestricted && !tab.trustedUserNavigation && this.aiAllowPrivateNetwork === false;
    // Historical creator ownership may survive after a kept assistant tab has
    // crossed its run boundary. Only live control authority may activate this
    // irreversible renderer guard; ensureAssistantView installs it before every
    // assistant operation even when a retained shell is restored later.
    const activateNativeUiGuard = !!tab.aiControlOwnerId;
    const nativeUiGuardToken = randomUUID();
    tab.nativeUiGuardToken = nativeUiGuardToken;
    Object.assign(
      webPreferences,
      browserWebPreferences(
        tab.partition,
        undefined,
        activatePrivateNetworkGuard,
        activateNativeUiGuard,
        nativeUiGuardToken,
      ),
    );
    viewOptions.webPreferences = webPreferences as Electron.WebPreferences;
    const view = new WebContentsView(viewOptions);
    let hosted = false;
    try {
      configureBrowserWebContents(view.webContents, !activatePrivateNetworkGuard);
      view.setBounds(DEFAULT_DETACHED_VIEW_BOUNDS);
      view.setVisible(false);
      // A WebContentsView that is not in a native view tree may not schedule its
      // first navigation or paint consistently. Host every live tab as a hidden
      // child, then make only the active mounted tab visible.
      win.contentView.addChildView(view);
      hosted = true;
      this.detachedHostViews?.delete(view);
      tab.view = view;
      this.enableAssistantBackgroundRendering(tab, view.webContents);
      this.webContentsToTab.set(view.webContents.id, tab.shell.id);
      this.wireWebContents(tab, view.webContents);
      view.webContents.setUserAgent(getChromeUserAgent());
      view.webContents.setZoomLevel(tab.shell.zoomLevel);
      view.webContents.setAudioMuted(tab.shell.muted);
      if (activatePrivateNetworkGuard) {
        // WebPreferences requested an already-restricted preload. This marker
        // remains pending until the current-frame membrane is verified.
        tab.privateNetworkNewDocumentGuard = {
          contentsId: view.webContents.id,
          identifier: PRELOAD_PRIVATE_NETWORK_GUARD_PENDING_IDENTIFIER,
        };
      }
      if (activateNativeUiGuard) {
        // The frame preload blocks printing synchronously before the first page
        // script. This pending marker is replaced after CDP registers the same
        // guard for every future document and verifies each live frame.
        tab.assistantNativeUiNewDocumentGuard = {
          contentsId: view.webContents.id,
          identifier: PRELOAD_NATIVE_UI_GUARD_PENDING_IDENTIFIER,
        };
      }
      tab.shell.discarded = false;
      tab.lastUsedAt = Date.now();
      return view;
    } catch (error) {
      this.restoreAssistantBackgroundRendering(tab, view.webContents);
      this.webContentsToTab.delete(view.webContents.id);
      if (tab.view === view) tab.view = null;
      if (tab.privateNetworkNewDocumentGuard?.contentsId === view.webContents.id) {
        tab.privateNetworkNewDocumentGuard = undefined;
      }
      if (tab.assistantNativeUiNewDocumentGuard?.contentsId === view.webContents.id) {
        tab.assistantNativeUiNewDocumentGuard = undefined;
      }
      if (tab.nativeUiGuardToken === nativeUiGuardToken) tab.nativeUiGuardToken = undefined;
      if (hosted) {
        try {
          if (!win.isDestroyed()) win.contentView.removeChildView(view);
        } catch {
          // Best-effort rollback of a partially initialized native child.
        }
      }
      try {
        if (!view.webContents.isDestroyed()) view.webContents.close({ waitForBeforeUnload: false });
      } catch {
        // Preserve the initialization failure after best-effort renderer cleanup.
      }
      throw error;
    }
  }

  private createPopupTab(
    opener: InternalTab,
    url: string,
    disposition: Electron.HandlerDetails['disposition'],
    initiatorFrameTreeNodeId: number | null = null,
  ): ((options: Electron.BrowserWindowConstructorOptions) => WebContents) | null {
    if (!this.config().enabled) return null;
    try {
      this.assertConversationAvailable(opener.shell.conversationId);
      this.requireLiveWindow();
      this.assertScopeAvailable(opener.scopeKey);
    } catch {
      return null;
    }
    const conversationId = opener.shell.conversationId;
    const activeControlOwnerId = opener.aiNetworkRestricted ? opener.aiControlOwnerId : null;
    const assistantGeneration = activeControlOwnerId
      ? this.assistantRuns.generationIfActive(conversationId, activeControlOwnerId)
      : null;
    const candidatePopupGesture =
      opener.popupGesture?.expiresAt && opener.popupGesture.expiresAt >= Date.now() ? opener.popupGesture : null;
    const candidateAssistantGesture =
      opener.assistantGesture?.expiresAt && opener.assistantGesture.expiresAt >= Date.now()
        ? opener.assistantGesture
        : null;
    const overlappingAssistantGesture =
      candidateAssistantGesture?.assistantOwnerId === activeControlOwnerId &&
      (initiatorFrameTreeNodeId === null ||
        candidateAssistantGesture.frameTreeNodeId === undefined ||
        candidateAssistantGesture.frameTreeNodeId === initiatorFrameTreeNodeId)
        ? ({ source: 'assistant' as const, ...candidateAssistantGesture } satisfies InternalTab['popupGesture'])
        : null;
    const lastMatchingGesture =
      candidatePopupGesture?.source !== 'user' ||
      (initiatorFrameTreeNodeId !== null && candidatePopupGesture.frameTreeNodeId === initiatorFrameTreeNodeId)
        ? candidatePopupGesture
        : null;
    // If an exact (or conservatively ambiguous) assistant activation overlaps a
    // later real-user gesture, assistant ownership wins. A single mutable
    // last-gesture record would otherwise let delayed AI window.open work mint
    // a foreground, user-retained popup.
    const popupGesture = overlappingAssistantGesture ?? lastMatchingGesture;
    if (
      opener.aiNetworkRestricted &&
      (!activeControlOwnerId || opener.aiControlGeneration !== assistantGeneration) &&
      popupGesture?.source !== 'user'
    ) {
      return null;
    }
    // Chromium grants transient activation to one popup. Consume the matching
    // provenance too so a later timer-driven window.open cannot inherit it.
    opener.popupGesture = null;
    opener.assistantGesture = null;
    // Arbitrary evaluated code can open about:blank synchronously or from a
    // retained timer. A new popup target would not inherit the opener's
    // target-scoped document-start WebRTC guard before script can run, so deny
    // every popup from a quarantined/evaluating renderer. The assistant can
    // still open a guarded tab through the structured browser_tabs tool.
    const scriptCreatedPopup = opener.assistantScriptDepth > 0 || opener.scriptTainted;
    if (scriptCreatedPopup) return null;
    // Network restriction and tab ownership are distinct. Exact trusted-input
    // provenance wins over operation timing so a concurrent user click remains
    // user-owned. Script evaluation is tracked separately because it can call
    // window.open without producing an input event.
    const assistantOwnerId = assistantPopupOwner(
      opener.shell.owner,
      opener.assistantOwnerId,
      activeControlOwnerId,
      popupGesture?.source ?? null,
      popupGesture?.assistantOwnerId ?? null,
      scriptCreatedPopup,
    );
    const popupAiNetworkRestricted = shouldRestrictPopupNetwork(
      opener.aiNetworkRestricted,
      opener.scriptTainted,
      popupGesture?.source ?? null,
    );
    const order = this.tabOrder.get(conversationId) ?? [];
    if (order.length + (this.pendingTabCreations.get(conversationId) ?? 0) >= this.config().maxTabsPerConversation)
      return null;
    const createdAt = now();
    const id = randomUUID();
    const popupUrl = url || 'about:blank';
    if (
      popupAiNetworkRestricted &&
      (!/^https?:|^about:blank$/i.test(popupUrl) || (!this.aiAllowPrivateNetwork && isPrivateNetworkUrl(popupUrl)))
    ) {
      return null;
    }
    const shell: BrowserTab = {
      id,
      conversationId,
      owner: assistantOwnerId ? 'assistant' : 'user',
      keepOpen: false,
      title: popupUrl === 'about:blank' ? 'New Tab' : boundedBrowserTitle(popupUrl),
      url: popupUrl,
      loading: true,
      audible: false,
      muted: false,
      discarded: false,
      // An evaluated script can install timers/listeners in about:blank before
      // this callback returns. Keep that renderer detached and make turn
      // cleanup reclaim it even if the shell is later marked Keep open.
      reloadRequired: scriptCreatedPopup,
      active: false,
      canGoBack: false,
      canGoForward: false,
      zoomLevel: this.storeForScope(opener.scopeKey).getZoomLevel(),
      createdAt,
      updatedAt: createdAt,
      security: securityForUrl(popupUrl),
      sensitive: false,
    };
    let resolveAssistantPopupBootstrap: (() => void) | undefined;
    const assistantPopupBootstrapDrain = assistantOwnerId
      ? new Promise<void>((resolve) => {
          resolveAssistantPopupBootstrap = resolve;
        })
      : undefined;
    const tab: InternalTab = {
      shell,
      view: null,
      viewLoadPromise: null,
      partition: opener.partition,
      scopeKey: opener.scopeKey,
      generation: 0,
      lastUsedAt: Date.now(),
      assistantOwnerId,
      aiNetworkRestricted: popupAiNetworkRestricted,
      aiControlOwnerId: popupAiNetworkRestricted ? activeControlOwnerId : null,
      aiControlGeneration: popupAiNetworkRestricted ? assistantGeneration : null,
      aiActionDepth: assistantOwnerId ? 1 : 0,
      aiActionUntil: 0,
      aiNetworkReleaseRequested: false,
      aiNetworkReleaseTimer: null,
      assistantScriptDepth: 0,
      popupGesture: null,
      assistantGesture: null,
      scriptTainted: scriptCreatedPopup,
      trustedUserNavigation: false,
      trustedUserNavigationTarget: null,
      trustedUserNavigationRequestId: null,
      trustedUserNavigationLease: 0,
      trustedUserNavigationTimer: null,
      userSelectionGeneration: 0,
      trustedGestureGeneration: 0,
      visibleAssistantGeneration: 0,
      unrestrictedNetworkGeneration: 0,
      unrestrictedNetworkValidations: new Map(),
      unrestrictedNetworkUnsafe: false,
      queue: new BrowserActionQueue(),
      overlayGeneration: 0,
      overlayTimer: null,
      automationOverlay: null,
      networkRedactionKey: createBrowserNetworkRedactionKey(),
      assistantPopupBootstrapPending: assistantOwnerId !== null,
      assistantPopupBootstrapDrain,
      resolveAssistantPopupBootstrap,
      assistantPopupDialogsDisabled: assistantOwnerId !== null,
      assistantDialogsDisabledRunId: assistantOwnerId,
      isPopup: true,
    };
    this.tabs.set(id, tab);
    this.tabOrder.set(conversationId, [...order, id]);
    if (assistantOwnerId) this.rememberAssistantTarget(conversationId, assistantOwnerId, tab);
    // Popup disposition is presentation state, not an automation capability.
    // Chromium may label a trusted synthetic click's popup as foreground-tab,
    // but assistant-attributed targets must remain fully operable offscreen and
    // must never replace the tab the user chose to present.
    const background = assistantOwnerId !== null || disposition === 'background-tab';
    if (!background) {
      this.activeTabs.set(conversationId, id);
    }
    this.emitTabs(conversationId);
    return (options) => {
      try {
        if (assistantOwnerId) {
          // This preference is applied before WebContents construction, closing
          // the interval in which popup script could open native UI before the
          // asynchronous CDP dialog/file-chooser interceptor becomes ready.
          options.webPreferences = { ...(options.webPreferences ?? {}), disableDialogs: true };
        }
        const view = this.createView(tab, options);
        if (assistantOwnerId) {
          const dialogGuard = this.ensureAssistantRunDialogGuard(tab, assistantOwnerId);
          tab.assistantDownloadAttribution = {
            assistantOwnerId,
            trustedGestureGeneration: tab.trustedGestureGeneration,
          };
          void this.protectAssistantDialogs(tab, view.webContents, dialogGuard).catch((error: unknown) => {
            if (
              this.tabs.get(tab.shell.id) !== tab ||
              tab.view?.webContents !== view.webContents ||
              tab.assistantDialogGuard !== dialogGuard ||
              !tab.assistantRunDialogGuardLease ||
              !dialogGuard.owners.has(tab.assistantRunDialogGuardLease)
            )
              return;
            this.failAssistantDialogGuard(tab, dialogGuard, error instanceof Error ? error : new Error(String(error)));
            if (!view.webContents.isDestroyed()) {
              tab.generation++;
              this.destroyView(tab);
              tab.shell.discarded = true;
              tab.shell.sensitive = false;
              this.emitTabs(tab.shell.conversationId);
            }
          });
        }
        // attachActiveView also checks the quarantine, but avoiding this call
        // keeps an evaluation-created popup from flashing privileged pixels.
        if (!background && !scriptCreatedPopup) this.attachActiveView(conversationId);
        return view.webContents;
      } catch (error) {
        // The shell is published before Electron invokes createWindow. If
        // native view creation fails, roll that provisional tab back instead
        // of leaving an unopenable phantom in the strip.
        if (this.tabs.get(id) === tab) {
          this.closeTab(tab, false, false);
          this.emitTabs(conversationId);
        }
        throw error;
      }
    };
  }

  private destroyView(tab: InternalTab): void {
    const view = tab.view;
    if (view) {
      this.rejectMenuPreviewForContents(
        view.webContents.id,
        new Error('Browser menu preview was cancelled because the page closed.'),
      );
      this.clearContextMenuDownloadAuthority(view.webContents.id);
    }
    // Page.addScriptToEvaluateOnNewDocument registrations are target-scoped and
    // disappear with the WebContents. Clear the bookkeeping before close so a
    // later clean renderer never inherits the quarantined target identity.
    tab.privateNetworkNewDocumentGuard = undefined;
    tab.assistantNativeUiNewDocumentGuard = undefined;
    tab.nativeUiGuardToken = undefined;
    tab.viewLoadPromise = null;
    tab.viewLoadState = undefined;
    tab.assistantBackgroundInitialLoadPending = false;
    if (view) this.finishAssistantPopupBootstrap(tab, view.webContents);
    if (view) this.unprotectAssistantDialogs(tab, view.webContents);
    this.cancelFaviconFetch(tab.shell.id);
    if (tab.overlayTimer) {
      clearTimeout(tab.overlayTimer);
      tab.overlayTimer = null;
    }
    if (tab.aiNetworkReleaseTimer) {
      clearTimeout(tab.aiNetworkReleaseTimer);
      tab.aiNetworkReleaseTimer = null;
    }
    tab.aiNetworkReleaseRequested = false;
    this.resetUnrestrictedDocumentNetworkState(tab);
    tab.overlayGeneration++;
    tab.automationOverlay?.releaseDebugger();
    tab.automationOverlay = null;
    this.dropPendingForTab(tab.shell.id);
    tab.popupGesture = null;
    tab.assistantGesture = null;
    if (view) this.restoreAssistantBackgroundRendering(tab, view.webContents);
    if (view) {
      this.clearAssistantBackgroundViewportRetry(tab, view.webContents);
      tab.assistantBackgroundViewportContents?.delete(view.webContents);
      if (tab.assistantBackgroundViewportContents?.size === 0) {
        tab.assistantBackgroundViewportContents = undefined;
      }
      tab.assistantBackgroundViewportSetups?.delete(view.webContents);
      if (tab.assistantBackgroundViewportSetups?.size === 0) {
        tab.assistantBackgroundViewportSetups = undefined;
      }
      tab.assistantBackgroundViewportRestores?.delete(view.webContents);
      if (tab.assistantBackgroundViewportRestores?.size === 0) {
        tab.assistantBackgroundViewportRestores = undefined;
      }
    }
    this.resetBrowserNetworkDiagnostics(tab);
    if (view) {
      this.pendingSyntheticInputs.delete(view.webContents.id);
      this.clearDispatchedSyntheticInput(view.webContents.id);
    }
    for (const pending of this.pendingAutomationArmAcknowledgements.values()) {
      if (pending.tabId === tab.shell.id) {
        pending.settle(new Error('The browser page changed before assistant input could be attributed.'));
      }
    }
    for (const [token, pending] of this.automationGestureTokens) {
      if (pending.tabId === tab.shell.id) this.revokeAutomationGestureToken(token);
    }
    if (!view) return;
    // A renderer deadline can reach this path while the uninterruptible
    // screenshot Promise is still pending. Remove it from the renderer-free
    // capture host and release the process-wide capture slot synchronously;
    // the operation's eventual `finally` is idempotent.
    this.releaseBackgroundCaptureHostedView(view);
    this.detachedHostViews?.delete(view);
    if (this.attachedView === view) this.detachAttachedView();
    const win = this.getWindow();
    try {
      if (win && !win.isDestroyed()) win.contentView.removeChildView(view);
    } catch {
      // Best-effort removal while the native window is tearing down.
    }
    this.webContentsToTab.delete(view.webContents.id);
    // Clear our ownership before close() so the destroyed event can
    // distinguish an intentional teardown from an unexpected renderer loss.
    tab.view = null;
    try {
      if (!view.webContents.isDestroyed()) view.webContents.close({ waitForBeforeUnload: false });
    } catch {
      // Best-effort renderer reclamation.
    }
  }

  private wireWebContents(tab: InternalTab, contents: WebContents): void {
    const ownsContents = (): boolean => tab.view?.webContents === contents;
    contents.on('content-bounds-updated', (event) => {
      // A remote page must never move or resize Kai's containing window. The
      // BrowserPanel alone owns the child view's validated bounds.
      event.preventDefault();
    });
    contents.on('enter-html-full-screen', () => {
      if (!ownsContents() || (tab.aiActionDepth <= 0 && !tab.aiControlOwnerId)) return;
      // Built-in Chromium media controls can enter HTML fullscreen without
      // calling the page-visible requestFullscreen methods blocked by the
      // preload membrane. The immutable WebPreference keeps Kai's window from
      // resizing; reclaim the exact assistant-controlled document immediately
      // so no browser-owned fullscreen surface survives hidden automation.
      const win = this.getWindow();
      try {
        if (win && !win.isDestroyed() && win.isFullScreen()) win.setFullScreen(false);
      } catch {
        // Closing the offending WebContents below also exits HTML fullscreen.
      }
      if (!ownsContents()) return;
      tab.generation++;
      this.destroyView(tab);
      tab.shell.discarded = true;
      tab.shell.loading = false;
      tab.shell.sensitive = false;
      tab.shell.error = 'Browser fullscreen was blocked during assistant control.';
      this.emitTabs(tab.shell.conversationId);
    });
    const updateNavigation = (): void => {
      if (!ownsContents() || contents.isDestroyed()) return;
      const navigation = contents.navigationHistory;
      tab.shell.canGoBack = navigation.canGoBack();
      tab.shell.canGoForward = navigation.canGoForward();
      tab.shell.url = contents.getURL() || tab.shell.url;
      tab.shell.security = securityForUrl(tab.shell.url);
      tab.shell.updatedAt = now();
      this.emitTabs(tab.shell.conversationId);
    };
    const recordHistory = (): void => {
      if (!ownsContents() || this.disposed || this.scopeUnavailable(tab.scopeKey) || !/^https?:/i.test(tab.shell.url))
        return;
      try {
        this.storeForScope(tab.scopeKey).addHistory(tab.shell.title, tab.shell.url);
      } catch (error) {
        // Navigation events are emitted by Electron rather than awaited by a
        // caller. Never let profile I/O failures escape as uncaught exceptions.
        tab.shell.error = `Browsing history could not be saved: ${
          error instanceof Error ? error.message : String(error)
        }`;
        this.emitTabs(tab.shell.conversationId);
      }
    };

    contents.on('did-start-loading', () => {
      if (!ownsContents()) return;
      tab.shell.loading = true;
      tab.shell.error = undefined;
      this.emitTabs(tab.shell.conversationId);
    });
    const recordDevToolsActivity = (): void => {
      if (ownsContents()) tab.lastUsedAt = Date.now();
    };
    contents.on('devtools-opened', recordDevToolsActivity);
    contents.on('devtools-closed', recordDevToolsActivity);
    contents.on('did-stop-loading', () => {
      if (!ownsContents()) return;
      this.finishAssistantPopupBootstrap(tab, contents);
      tab.shell.loading = false;
      tab.shell.title = boundedBrowserTitle(contents.getTitle(), tab.shell.url || 'New Tab');
      updateNavigation();
      recordHistory();
    });
    contents.on('did-start-navigation', (_event, url, isInPlace, isMain) => {
      if (!ownsContents()) return;
      // Hash changes and History API transitions keep the current document
      // alive. Preserve its generation-bound prompts, allow-once grants, and
      // favicon; did-navigate-in-page updates the shell URL/history separately.
      if (!isMain || isInPlace) return;
      this.pendingElementPickerCancels.get(tab.shell.id)?.(
        new Error('Element picking cancelled because the page navigated.'),
      );
      this.activeFindRequests.delete(tab.shell.id);
      // Revoke document-bound capabilities before any renderer or filesystem
      // side effect. Navigation continues even if those later operations fail.
      tab.generation++;
      // The immutable preload will arm the replacement document before its page
      // script, but a later assistant operation must verify that document's own
      // non-callable marker instead of trusting the previous frame snapshot.
      tab.assistantNativeUiNewDocumentGuard = undefined;
      // Rotate document-visible diagnostics without forgetting requests that
      // Chromium has already admitted. Keep the committed document snapshot
      // until this provisional navigation commits or fails; an aborted
      // navigation leaves the original page alive and must not erase its
      // diagnostics.
      this.beginBrowserNetworkNavigation(tab, url);
      this.resetUnrestrictedDocumentNetworkState(tab);
      this.clearOneTimePermissionsForTab(tab.shell.id);
      this.dismissPendingPermissionsForTab(tab.shell.id);
      this.dismissPendingAuthForTab(tab.shell.id);
      this.cancelFaviconFetch(tab.shell.id);
      if (tab.shell.favicon !== undefined) {
        tab.shell.favicon = undefined;
        this.emitTabFavicon(tab);
      }
      if (/^https?:/i.test(url)) {
        try {
          clearChromiumBrowserScopeCleared(this.appHome, tab.scopeKey);
        } catch (error) {
          // Electron does not await navigation listeners. A read-only/full disk
          // must not escape this callback as an uncaught main-process exception.
          const profileError = error instanceof Error ? error : new Error(String(error));
          console.warn('[Browser] Could not update the cleared-profile marker:', profileError);
          try {
            this.emitProfileErrorForScope(tab.scopeKey, 'profile', profileError);
          } catch {
            // Error reporting is best-effort; document authority is already gone.
          }
        }
      }
    });
    contents.on('did-redirect-navigation', (_event, url, isInPlace, isMain) => {
      if (!ownsContents() || !isMain || isInPlace) return;
      this.recordBrowserNetworkNavigationUrl(tab, url);
    });
    contents.on('did-navigate', (_event, url) => {
      if (!ownsContents()) return;
      this.commitBrowserNetworkNavigation(tab);
      // Only a committed new document clears password-sensitive state. Starting
      // a navigation is insufficient: it can fail or be cancelled while the old
      // DOM (and its password value) remains live.
      this.setTabSensitive(tab, false);
      let scriptedHistoryEvicted = true;
      if (tab.scriptTainted || tab.shell.reloadRequired) {
        try {
          // Chromium may place the document being replaced into BFCache. It
          // retains AI-installed listeners and can later be restored by Back or
          // Forward without creating a fresh document. Remove every reachable
          // history entry before allowing user input back into this view.
          contents.navigationHistory.clear();
        } catch (error) {
          scriptedHistoryEvicted = false;
          tab.shell.error = `Browser history could not be cleared after script evaluation: ${
            error instanceof Error ? error.message : String(error)
          }`;
        }
      }
      if (scriptedHistoryEvicted && !tab.privateNetworkNewDocumentGuard) {
        tab.scriptTainted = false;
        tab.shell.reloadRequired = false;
      }
      tab.popupGesture = null;
      tab.assistantGesture = null;
      this.completeTrustedUserNavigation(tab, url);
      updateNavigation();
    });
    contents.on('did-navigate-in-page', (_event, url, isMainFrame) => {
      if (!ownsContents()) return;
      if (!isMainFrame) return;
      // The old document (including any AI-injected listeners) survives a
      // same-document commit, so completing a user history action must never
      // release its private-network guard.
      this.completeTrustedUserNavigation(tab, url, false);
      updateNavigation();
      recordHistory();
    });
    contents.on('page-title-updated', (_event, title) => {
      if (!ownsContents()) return;
      tab.shell.title = boundedBrowserTitle(title, tab.shell.url);
      this.emitTabs(tab.shell.conversationId);
    });
    contents.on('page-favicon-updated', (_event, favicons) => {
      if (!ownsContents()) return;
      this.updateFavicon(tab, contents, favicons);
    });
    contents.on('media-started-playing', () => {
      if (!ownsContents()) return;
      tab.shell.audible = true;
      this.emitTabs(tab.shell.conversationId);
    });
    contents.on('media-paused', () => {
      if (!ownsContents()) return;
      tab.shell.audible = contents.isCurrentlyAudible();
      this.emitTabs(tab.shell.conversationId);
    });
    contents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMain) => {
      if (!ownsContents()) return;
      if (!isMain) return;
      this.finishAssistantPopupBootstrap(tab, contents);
      if (isTrustedUserNavigationTarget(tab.trustedUserNavigation, tab.trustedUserNavigationTarget, validatedURL)) {
        this.clearTrustedUserNavigation(tab, tab.trustedUserNavigationLease);
      }
      // A superseded main-frame request may report its terminal failure after a
      // newer attempt has already started (or even committed). Electron does
      // not expose a request id on did-fail-load, so consume the generation/url
      // tombstone instead of rolling back or failing the newer document.
      if (this.consumeSupersededBrowserNetworkNavigationFailure(tab, validatedURL)) return;
      if (errorCode === -3) {
        // ERR_ABORTED leaves the previously committed document alive. Restore
        // its diagnostics and retain the failed attempt as additional bounded
        // request history.
        this.rollbackBrowserNetworkNavigation(tab);
        return;
      }
      // A terminal navigation failure represents the attempted replacement
      // (typically Chromium's error document), not the departed page.
      this.commitBrowserNetworkNavigation(tab);
      tab.shell.loading = false;
      tab.shell.error = `${errorDescription} (${errorCode})`;
      tab.shell.url = validatedURL || tab.shell.url;
      tab.shell.security = 'unknown';
      this.emitTabs(tab.shell.conversationId);
    });
    contents.on('render-process-gone', (_event, details) => {
      this.webContentsToTab.delete(contents.id);
      if (tab.view?.webContents !== contents) return;
      // A gone renderer does not guarantee that Electron destroys the owning
      // WebContentsView. Reclaim it through the normal teardown path before
      // dropping our reference so repeated crashes cannot orphan native state.
      this.destroyView(tab);
      tab.shell.error = `Page renderer exited: ${details.reason}`;
      tab.shell.discarded = true;
      this.emitTabs(tab.shell.conversationId);
    });
    contents.on('destroyed', () => {
      this.webContentsToTab.delete(contents.id);
      this.finishAssistantPopupBootstrap(tab, contents);
      // Electron can destroy a popup or crashed target without routing through
      // destroyView(). Native capture promises may never settle after that
      // loss, so release both capture paths from the destruction event instead
      // of waiting forever on an orphaned promise.
      this.rejectMenuPreviewForContents(
        contents.id,
        new Error('Browser menu preview was cancelled because the page closed.'),
      );
      const stillOwnsContents = tab.view?.webContents === contents;
      if (!stillOwnsContents) return;
      // A stale destroyed event from a renderer replaced during navigation or
      // sanitization must not erase diagnostics collected by the replacement.
      this.resetBrowserNetworkDiagnostics(tab);
      const destroyedView = tab.view;
      if (!destroyedView) return;
      this.releaseBackgroundCaptureHostedView(destroyedView);
      this.detachedHostViews?.delete(destroyedView);
      this.dropPendingForTab(tab.shell.id);
      if (this.attachedView === tab.view) this.detachAttachedView();
      const win = this.getWindow();
      try {
        if (win && !win.isDestroyed()) win.contentView.removeChildView(destroyedView);
      } catch {
        // Best-effort native child cleanup after an unexpected renderer loss.
      }
      tab.view = null;
      if (shouldCloseDestroyedPopupTab(tab.isPopup, stillOwnsContents) && this.tabs.get(tab.shell.id) === tab) {
        this.closeTab(tab);
        return;
      }
      tab.shell.discarded = true;
      if (this.tabs.has(tab.shell.id)) this.emitTabs(tab.shell.conversationId);
    });
    contents.on('found-in-page', (_event, result) => {
      if (!ownsContents()) return;
      const activeFind = this.activeFindRequests.get(tab.shell.id);
      if (!activeFind || activeFind.electronRequestId !== result.requestId) return;
      this.emit({
        type: 'find-result',
        conversationId: tab.shell.conversationId,
        tabId: tab.shell.id,
        result: {
          requestId: activeFind.requestId,
          activeMatchOrdinal: result.activeMatchOrdinal,
          matches: result.matches,
          finalUpdate: result.finalUpdate,
        },
      });
    });

    const blockRestrictedNonHttpNavigation = (event: Electron.Event, url: string): void => {
      if (!ownsContents()) {
        event.preventDefault();
        return;
      }
      if (
        isTrustedUserNavigationTarget(tab.trustedUserNavigation, tab.trustedUserNavigationTarget, url) ||
        !tab.aiNetworkRestricted ||
        /^https?:/i.test(url) ||
        INTERNAL_URLS.has(url)
      )
        return;
      event.preventDefault();
      tab.shell.loading = false;
      tab.shell.error = 'AI navigation is limited to HTTP(S) pages and about:blank.';
      this.emitTabs(tab.shell.conversationId);
    };
    // webRequest below performs the asynchronous DNS/private-address check for
    // HTTP(S). These synchronous guards cover injected/custom-scheme navigation,
    // which does not necessarily pass through that HTTP(S)-only request filter.
    contents.on('will-navigate', blockRestrictedNonHttpNavigation);
    contents.on('will-redirect', blockRestrictedNonHttpNavigation);

    contents.setWindowOpenHandler(({ url, disposition, referrer }) => {
      if (!ownsContents()) return { action: 'deny' };
      const initiatorFrameTreeNodeId = popupInitiatorFrameTreeNodeId(contents, referrer?.url ?? '');
      const createWindow = this.createPopupTab(tab, url, disposition, initiatorFrameTreeNodeId);
      if (!createWindow) return { action: 'deny' };
      return {
        action: 'allow',
        createWindow,
        // Popup pages become peer tabs in Kai's strip. Their lifetime is
        // managed by closeTab/turn cleanup, not by Electron's opener window.
        outlivesOpener: true,
      };
    });
    contents.on('context-menu', (_event, params) => {
      if (!ownsContents()) return;
      const menu = this.buildContextMenu(tab, contents, params);
      if (ownsContents()) menu.popup();
    });
    contents.on('before-mouse-event', (event, input) => {
      if (!ownsContents()) {
        event.preventDefault();
        return;
      }
      this.handlePendingSyntheticInput(tab, contents, event, input.type);
    });
    contents.on('before-input-event', (event, input) => {
      if (!ownsContents()) {
        event.preventDefault();
        return;
      }
      this.handlePendingSyntheticInput(tab, contents, event, input.type as Electron.InputEvent['type']);
      this.handlePageShortcut(tab, contents, event, input);
    });
  }

  private updateFavicon(tab: InternalTab, contents: WebContents, favicons: string[]): void {
    const candidate = favicons.find((url) => /^https?:|^data:image\//i.test(url));
    if (!candidate) return;
    const navigationGeneration = tab.generation;
    if (/^data:image\//i.test(candidate)) {
      if (!isBoundedFaviconDataUrl(candidate)) return;
      this.cancelFaviconFetch(tab.shell.id);
      tab.shell.favicon = candidate;
      this.emitTabFavicon(tab);
      return;
    }

    let pageOrigin: string;
    try {
      pageOrigin = new URL(contents.getURL()).origin;
      if (new URL(candidate).origin !== pageOrigin) return;
    } catch {
      return;
    }

    const existing = this.faviconFetches.get(tab.shell.id);
    if (existing?.url === candidate) return;
    this.cancelFaviconFetch(tab.shell.id);
    if (this.activeFaviconFetches >= MAX_CONCURRENT_FAVICON_FETCHES) return;

    const scopedSession = session.fromPartition(tab.partition);
    const pending: PendingFaviconFetch = {
      url: candidate,
      controller: new AbortController(),
    };
    const timeout = setTimeout(() => pending.controller.abort(), FAVICON_FETCH_TIMEOUT_MS);
    timeout.unref?.();
    this.faviconFetches.set(tab.shell.id, pending);
    this.activeFaviconFetches++;
    void this.withScopeActivity(tab.scopeKey, () =>
      this.fetchScopedFavicon(tab, scopedSession, candidate, pageOrigin, pending.controller.signal),
    )
      .then((dataUrl) => {
        if (!dataUrl || this.tabs.get(tab.shell.id) !== tab || contents.isDestroyed()) return;
        if (tab.view?.webContents !== contents || tab.generation !== navigationGeneration) return;
        tab.shell.favicon = dataUrl;
        this.emitTabFavicon(tab);
      })
      .catch(() => undefined)
      .finally(() => {
        clearTimeout(timeout);
        this.activeFaviconFetches = Math.max(0, this.activeFaviconFetches - 1);
        if (this.faviconFetches.get(tab.shell.id) === pending) this.faviconFetches.delete(tab.shell.id);
      });
  }

  private cancelFaviconFetch(tabId: string): void {
    const pending = this.faviconFetches?.get(tabId);
    if (!pending) return;
    this.faviconFetches.delete(tabId);
    pending.controller.abort();
  }

  private async fetchScopedFavicon(
    tab: InternalTab,
    scopedSession: Session,
    initialUrl: string,
    pageOrigin: string,
    signal: AbortSignal,
  ): Promise<string | null> {
    let url = initialUrl;
    for (let redirectCount = 0; redirectCount <= MAX_FAVICON_REDIRECTS; redirectCount++) {
      if (signal.aborted || !this.config().enabled || this.scopeUnavailable(tab.scopeKey)) return null;
      try {
        if (new URL(url).origin !== pageOrigin) return null;
      } catch {
        return null;
      }
      if (tab.aiNetworkRestricted) {
        await this.assertAssistantNavigationAllowed(aiRequestPolicyUrl(url), tab.partition, signal);
      }
      const response = await scopedSession.fetch(url, {
        credentials: 'include',
        redirect: 'manual',
        signal,
        headers: {
          Accept: 'image/avif,image/webp,image/png,image/svg+xml,image/*;q=0.8',
        },
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location || redirectCount === MAX_FAVICON_REDIRECTS) return null;
        url = new URL(location, url).toString();
        continue;
      }
      if (!response.ok) return null;
      const mediaType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
      if (!mediaType?.startsWith('image/')) return null;
      const declaredLength = Number(response.headers.get('content-length'));
      if (Number.isFinite(declaredLength) && declaredLength > MAX_FAVICON_BYTES) return null;
      if (!response.body) return null;

      const reader = response.body.getReader();
      const chunks: Buffer[] = [];
      let total = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > MAX_FAVICON_BYTES) {
            await reader.cancel();
            return null;
          }
          chunks.push(Buffer.from(value));
        }
      } finally {
        reader.releaseLock();
      }
      return `data:${mediaType};base64,${Buffer.concat(chunks, total).toString('base64')}`;
    }
    return null;
  }

  private async stopRunningServiceWorkers(
    scopedSession: Session,
    contents?: WebContents,
    requireSuccess = false,
  ): Promise<void> {
    // Shutdown and profile clearing may reuse a tab target while bounded page
    // work has a deferred debugger cancellation. Join the same lease set so the
    // transport cannot detach between ServiceWorker.enable and stopWorker.
    await stopRunningBrowserServiceWorkers(scopedSession, contents, requireSuccess, undefined, (target) =>
      this.acquireBrowserDebuggerLease(target),
    );
  }

  private scopeHasActiveAiNetworkRestriction(scopeKey: string): boolean {
    return [...this.tabs.values()].some((tab) => tab.scopeKey === scopeKey && tab.aiNetworkRestricted);
  }

  private markAssistantControlledOrigin(scopeKey: string, url: string): void {
    const origin = normalizedOrigin(url);
    if (origin === 'unknown') return;
    const origins = this.assistantControlledOrigins.get(scopeKey) ?? new Set<string>();
    origins.add(origin);
    this.assistantControlledOrigins.set(scopeKey, origins);
  }

  private restrictBackgroundNetworkForScope(scopeKey: string): void {
    this.restrictedBackgroundScopes.add(scopeKey);
    try {
      this.storeForScope(scopeKey).restrictBackgroundNetwork();
    } catch (error) {
      // The in-memory latch fails closed for this process. Retain the same
      // durable recovery marker used after an interrupted profile clear so a
      // surviving Chromium worker is restricted again before its session can
      // issue requests after restart. Clearing the profile is the explicit
      // recovery path for either kind of persistence failure.
      let retainedError: unknown = error;
      try {
        if (!markPendingBrowserCleanupScopeKey(this.appHome, scopeKey)) {
          this.pendingCleanupQuarantineUnreadable = true;
        }
      } catch (markerError) {
        retainedError = new AggregateError(
          [error, markerError],
          `Browser profile ${scopeKey} could not retain background-network provenance.`,
        );
      }
      console.warn('[Browser] Could not persist service-worker network provenance:', error);
      if (retainedError !== error) {
        console.error('[Browser] Could not retain service-worker network recovery marker:', retainedError);
      }
    }
  }

  private serviceWorkerRegistrationRequiresRestriction(scopeKey: string, workerScope: string): boolean {
    const origin = normalizedOrigin(workerScope);
    if (origin === 'unknown') return true;
    if (this.assistantControlledOrigins.get(scopeKey)?.has(origin)) return true;
    const candidates = [...this.tabs.values()].filter(
      (tab) => tab.scopeKey === scopeKey && normalizedOrigin(tab.shell.url) === origin,
    );
    // If the registering document disappeared before Chromium emitted the
    // event, provenance cannot be proven. Preserve the fail-closed behavior.
    if (candidates.length === 0) return true;
    return candidates.some((tab) => tab.shell.owner === 'assistant' || tab.aiNetworkRestricted || tab.scriptTainted);
  }

  /** Synchronously deny new Browser/profile work for a conversation. The
   * service calls this before publishing a manager created during a headless
   * profile deletion, while removeConversation performs the full teardown. */
  fenceRemovedConversation(conversationId: string): void {
    // Conversation ids are immutable. Retain every tombstone for this manager
    // lifetime so a stale mounted renderer can never recreate an older deleted
    // chat after a large bulk deletion.
    this.removedConversations.add(conversationId);
  }

  private releaseScopeRuntime(scopeKey: string, preserveSessionGuards = false): void {
    if ([...this.tabs.values()].some((tab) => tab.scopeKey === scopeKey)) return;
    if (!preserveSessionGuards) {
      const wiredSession = this.wiredSessionsByScope.get(scopeKey);
      const cleanupSession = this.wiredSessionCleanups.get(scopeKey);
      try {
        cleanupSession?.();
      } finally {
        this.wiredSessionCleanups.delete(scopeKey);
      }
      this.wiredSessionsByScope.delete(scopeKey);
      if (wiredSession) this.wiredSessions.delete(wiredSession);
    }
    this.stores.delete(scopeKey);
    const vault = this.vaults.get(scopeKey);
    vault?.dispose();
    this.vaults.delete(scopeKey);
    // Persistent service workers can restart after every currently running
    // version was stopped. Idle release may discard Kai metadata/vault state,
    // but must retain the Session request guard and its durable AI provenance.
    if (!preserveSessionGuards) {
      this.restrictedBackgroundScopes.delete(scopeKey);
      this.assistantControlledOrigins.delete(scopeKey);
    }
    this.scopeActivityCounts.delete(scopeKey);
    this.scopeIdleWaiters.delete(scopeKey);
    this.scopeGenerations.delete(scopeKey);
    this.scopeRequestActivities.delete(scopeKey);
    this.scopeRuntimeReleaseTokens.delete(scopeKey);
    if (!preserveSessionGuards) this.suspendedScopes.delete(scopeKey);
  }

  private releaseScopeRuntimeWhenIdle(scopeKey: string): void {
    if ([...this.tabs.values()].some((tab) => tab.scopeKey === scopeKey)) return;
    const token = {};
    this.scopeRuntimeReleaseTokens.set(scopeKey, token);
    const remainsReleasable = (): boolean => {
      const config = this.config();
      const belongsToSelectedScope =
        config.dataScope === 'global' ? scopeKey === 'global' : scopeKey.startsWith('conversation-');
      return (
        !this.disposed &&
        !this.shuttingDown &&
        config.enabled &&
        belongsToSelectedScope &&
        !this.clearingScopes.has(scopeKey) &&
        !this.suspendedScopes.has(scopeKey) &&
        this.scopeRuntimeReleaseTokens.get(scopeKey) === token &&
        ![...this.activeDownloads.values()].some((download) => download.scopeKey === scopeKey) &&
        ![...this.tabs.values()].some((tab) => tab.scopeKey === scopeKey)
      );
    };
    void (async () => {
      try {
        if (!remainsReleasable()) return;
        const scopedSession = this.wiredSessionsByScope.get(scopeKey);
        if (scopedSession) {
          // Service workers outlive their last WebContents. Stop them and close
          // pooled requests before removing the webRequest policy handlers;
          // otherwise a worker-held streaming request can keep the activity
          // count nonzero forever and prevent the cleanup needed to terminate it.
          await this.stopRunningServiceWorkers(scopedSession, undefined, true);
          if (!remainsReleasable()) return;
          await scopedSession.closeAllConnections();
          this.finishAllScopeRequestActivities(scopeKey);
        }
        await this.waitForScopeIdle(scopeKey);
        if (!remainsReleasable()) return;
        const store = this.stores.get(scopeKey);
        if (store) {
          await store.flush();
          if (!remainsReleasable()) return;
        }
        if (remainsReleasable()) this.releaseScopeRuntime(scopeKey, true);
      } catch (error) {
        // Keep the Session wired on failure so any surviving worker remains
        // under the Browser request policy. A later tab close or shutdown can
        // retry reclamation.
        console.warn('[Browser] Could not release an idle Browser profile:', error);
      } finally {
        if (this.scopeRuntimeReleaseTokens.get(scopeKey) === token) {
          this.scopeRuntimeReleaseTokens.delete(scopeKey);
        }
      }
    })();
  }

  private trackBrowserNetworkRequest(
    tab: InternalTab,
    details: Pick<Electron.OnBeforeRequestListenerDetails, 'id' | 'method' | 'resourceType' | 'url'> & {
      timestamp?: number;
    },
  ): boolean {
    if (this.tabs.get(tab.shell.id) !== tab) return false;
    const currentTime = browserNetworkEventTime(details.timestamp);
    const requests = (tab.networkRequests ??= new Map());
    const activeRequests = (tab.activeNetworkRequests ??= new Map());
    const activeRequestUrls = (tab.activeNetworkRequestUrls ??= new Map());
    const existing = requests.get(details.id) ?? tab.provisionalNetworkNavigation?.requests?.get(details.id);
    const existingActive = activeRequests.has(details.id);
    if (existingActive) {
      // Chromium retains an admitted request id across redirects.
      activeRequests.set(details.id, details.resourceType);
      activeRequestUrls.set(details.id, details.url);
    } else if (activeRequests.size >= MAX_BROWSER_ACTIVE_NETWORK_REQUESTS_PER_TAB) {
      // Preserve exact identity for every admitted request. A hostile page that
      // exceeds the cap is cancelled at onBeforeRequest rather than making an
      // older request impossible to complete later.
      const sequence = (tab.networkRequestSequence ?? 0) + 1;
      tab.networkRequestSequence = sequence;
      const sanitizedUrl = sanitizeBrowserNetworkUrl(details.url, this.networkRedactionKeyForTab(tab));
      requests.delete(details.id);
      requests.set(details.id, {
        id: details.id,
        sequence,
        url: sanitizedUrl.url,
        urlRedacted: sanitizedUrl.redacted,
        method: details.method,
        resourceType: details.resourceType,
        startedAt: currentTime,
        completedAt: currentTime,
        error: 'Request cancelled because this tab reached its active-request limit.',
      });
      while (requests.size > MAX_BROWSER_NETWORK_REQUESTS_PER_TAB) {
        const oldest = requests.keys().next().value;
        if (oldest === undefined) break;
        requests.delete(oldest);
      }
      return false;
    } else {
      activeRequests.set(details.id, details.resourceType);
      activeRequestUrls.set(details.id, details.url);
      (tab.diagnosticActiveNetworkRequestIds ??= new Set()).add(details.id);
    }
    const sanitizedUrl = sanitizeBrowserNetworkUrl(details.url, this.networkRedactionKeyForTab(tab));
    if (existingActive && existing && existing.completedAt === undefined) {
      // Chromium retains a request id across redirects. Preserve the original
      // start time while recording only the final, query-free destination.
      existing.url = sanitizedUrl.url;
      existing.urlRedacted = existing.urlRedacted === true || sanitizedUrl.redacted;
      existing.method = details.method;
      existing.resourceType = details.resourceType;
    } else if (!existingActive) {
      const sequence = (tab.networkRequestSequence ?? 0) + 1;
      tab.networkRequestSequence = sequence;
      if (existing) requests.delete(details.id);
      requests.set(details.id, {
        id: details.id,
        sequence,
        url: sanitizedUrl.url,
        urlRedacted: sanitizedUrl.redacted,
        method: details.method,
        resourceType: details.resourceType,
        startedAt: currentTime,
      });
    }
    if (
      browserNetworkResourceBlocksIdle(details.resourceType) &&
      (tab.diagnosticActiveNetworkRequestIds?.has(details.id) ?? true)
    ) {
      tab.networkLastBlockingActivityAt = currentTime;
    }
    // Diagnostic history is independently bounded. An active request can be
    // absent here and still complete exactly through activeNetworkRequests.
    while (requests.size > MAX_BROWSER_NETWORK_REQUESTS_PER_TAB) {
      const oldest = requests.keys().next().value;
      if (oldest === undefined) break;
      requests.delete(oldest);
    }
    return true;
  }

  private trackBrowserNetworkResponseStarted(
    tab: InternalTab,
    details: Pick<Electron.OnResponseStartedListenerDetails, 'id' | 'timestamp'>,
  ): void {
    if (this.tabs.get(tab.shell.id) !== tab) return;
    const request = tab.networkRequests?.get(details.id) ?? tab.provisionalNetworkNavigation?.requests?.get(details.id);
    if (!request || request.completedAt !== undefined) return;
    const responseStartedAt = browserNetworkEventTime(details.timestamp);
    request.responseStartedAt = Math.max(request.startedAt, responseStartedAt);
  }

  private networkRedactionKeyForTab(tab: InternalTab): BrowserNetworkRedactionKey {
    return (tab.networkRedactionKey ??= createBrowserNetworkRedactionKey());
  }

  private currentDocumentActiveNetworkRequests(tab: InternalTab): Array<[number, string]> {
    const activeRequests = tab.activeNetworkRequests;
    if (!activeRequests) return [];
    const currentIds = tab.diagnosticActiveNetworkRequestIds;
    // Existing tabs/tests created before the navigation-scoped set is needed
    // treat every exact active identity as belonging to their current document.
    if (!currentIds) return [...activeRequests];
    const current: Array<[number, string]> = [];
    for (const requestId of currentIds) {
      const resourceType = activeRequests.get(requestId);
      if (resourceType !== undefined) current.push([requestId, resourceType]);
    }
    return current;
  }

  private resetBrowserNetworkDiagnostics(tab: InternalTab, preserveActiveRequests = false): void {
    tab.networkRequests?.clear();
    tab.networkRequests = undefined;
    tab.provisionalNetworkNavigation?.requests?.clear();
    tab.provisionalNetworkNavigation?.activeRequestIds.clear();
    tab.provisionalNetworkNavigation = undefined;
    if (!preserveActiveRequests) {
      tab.activeNetworkRequests?.clear();
      tab.activeNetworkRequests = undefined;
      tab.activeNetworkRequestUrls?.clear();
      tab.activeNetworkRequestUrls = undefined;
      tab.diagnosticActiveNetworkRequestIds = undefined;
    } else {
      // The surviving exact identities belong to a renderer/document that was
      // just discarded. Keep them finishable, but invisible to any replacement.
      tab.diagnosticActiveNetworkRequestIds = new Set();
    }
    tab.networkRequestSequence = 0;
    tab.networkLastBlockingActivityAt = undefined;
    tab.networkNavigationSequence = 0;
    tab.supersededNetworkNavigations = undefined;
    // A replacement document must not be comparable with origins observed by
    // the previous document, even when it lives in the same tab shell.
    tab.networkRedactionKey = createBrowserNetworkRedactionKey();
  }

  private beginBrowserNetworkNavigation(tab: InternalTab, url: string): void {
    const previousProvisional = tab.provisionalNetworkNavigation;
    const currentRedactionKey = this.networkRedactionKeyForTab(tab);
    const currentRequests = new Map(tab.networkRequests ?? []);
    const currentActiveRequestIds = new Set(
      tab.diagnosticActiveNetworkRequestIds ?? tab.activeNetworkRequests?.keys() ?? [],
    );
    const expectedNavigationUrl = sanitizeBrowserNetworkUrl(url, currentRedactionKey).url;
    const navigationRequest = [...currentRequests.values()]
      .filter(
        (request) =>
          request.completedAt === undefined &&
          tab.activeNetworkRequests?.get(request.id) === 'mainFrame' &&
          sanitizeBrowserNetworkUrl(request.url, currentRedactionKey).url === expectedNavigationUrl,
      )
      .sort((left, right) => right.sequence - left.sequence)[0];
    const generation = (tab.networkNavigationSequence ?? 0) + 1;
    tab.networkNavigationSequence = generation;
    const comparableUrl = comparablePopupReferrerUrl(url);
    const superseded = previousProvisional
      ? [
          ...previousProvisional.superseded,
          {
            generation: previousProvisional.generation,
            urls: new Set(previousProvisional.urls),
          },
        ].slice(-MAX_SUPERSEDED_NETWORK_NAVIGATIONS)
      : [];
    const committedRequests = previousProvisional
      ? new Map(previousProvisional.requests ?? [])
      : new Map(currentRequests);
    if (!previousProvisional && navigationRequest) committedRequests.delete(navigationRequest.id);
    const committedActiveRequestIds = previousProvisional
      ? new Set(previousProvisional.activeRequestIds)
      : new Set([...currentActiveRequestIds].filter((requestId) => requestId !== navigationRequest?.id));
    const committedLastBlockingActivityAt = previousProvisional
      ? previousProvisional.lastBlockingActivityAt
      : tab.networkLastBlockingActivityAt;
    tab.provisionalNetworkNavigation = {
      ...(committedRequests.size > 0 ? { requests: committedRequests } : {}),
      activeRequestIds: committedActiveRequestIds,
      requestSequence: previousProvisional?.requestSequence ?? tab.networkRequestSequence ?? 0,
      ...(committedLastBlockingActivityAt !== undefined
        ? { lastBlockingActivityAt: committedLastBlockingActivityAt }
        : {}),
      redactionKey: previousProvisional?.redactionKey ?? currentRedactionKey,
      generation,
      urls: new Set(comparableUrl ? [comparableUrl] : []),
      superseded,
    };
    // Rotate the diagnostic subset immediately. Exact identities from the
    // previous document stay in activeNetworkRequests until their real terminal
    // events arrive, including identities whose metadata was already evicted.
    tab.diagnosticActiveNetworkRequestIds = new Set(navigationRequest ? [navigationRequest.id] : []);
    const nextRedactionKey = createBrowserNetworkRedactionKey();
    tab.networkRedactionKey = nextRedactionKey;
    if (navigationRequest) {
      const sanitized = sanitizeBrowserNetworkUrl(url, nextRedactionKey);
      tab.networkRequests = new Map([
        [
          navigationRequest.id,
          {
            ...navigationRequest,
            sequence: 1,
            url: sanitized.url,
            urlRedacted: navigationRequest.urlRedacted === true || sanitized.redacted,
          },
        ],
      ]);
      tab.networkRequestSequence = 1;
      tab.networkLastBlockingActivityAt = navigationRequest.startedAt;
    } else {
      tab.networkRequests = undefined;
      tab.networkRequestSequence = 0;
      tab.networkLastBlockingActivityAt = undefined;
    }
  }

  private recordBrowserNetworkNavigationUrl(tab: InternalTab, url: string): void {
    const comparableUrl = comparablePopupReferrerUrl(url);
    if (comparableUrl) tab.provisionalNetworkNavigation?.urls.add(comparableUrl);
  }

  private retainSupersededBrowserNetworkNavigations(
    tab: InternalTab,
    attempts: Array<{ generation: number; urls: Set<string> }>,
  ): void {
    if (attempts.length === 0) return;
    tab.supersededNetworkNavigations = [
      ...(tab.supersededNetworkNavigations ?? []),
      ...attempts.map((attempt) => ({ generation: attempt.generation, urls: new Set(attempt.urls) })),
    ].slice(-MAX_SUPERSEDED_NETWORK_NAVIGATIONS);
  }

  private consumeSupersededBrowserNetworkNavigationFailure(tab: InternalTab, url: string): boolean {
    const comparableUrl = comparablePopupReferrerUrl(url);
    const provisional = tab.provisionalNetworkNavigation;
    const consumeMatching = (attempts: Array<{ generation: number; urls: Set<string> }>): boolean => {
      const matchingIndex = comparableUrl ? attempts.findIndex((attempt) => attempt.urls.has(comparableUrl)) : -1;
      if (matchingIndex < 0) return false;
      attempts.splice(matchingIndex, 1);
      return true;
    };
    // Prefer the oldest still-pending generation when two rapid attempts use
    // the same URL. Chromium reports the superseded attempt's abort first.
    if (provisional && consumeMatching(provisional.superseded)) return true;
    if (tab.supersededNetworkNavigations && consumeMatching(tab.supersededNetworkNavigations)) {
      if (tab.supersededNetworkNavigations.length === 0) tab.supersededNetworkNavigations = undefined;
      return true;
    }
    const currentMatches = !!comparableUrl && provisional?.urls.has(comparableUrl) === true;
    if (!currentMatches && provisional?.superseded.length) {
      // Some Chromium failures omit or normalize validatedURL differently from
      // did-start-navigation. Terminal events remain ordered, so consume the
      // oldest superseded generation before allowing an unknown event to
      // settle the current attempt.
      provisional.superseded.shift();
      return true;
    }
    return false;
  }

  private commitBrowserNetworkNavigation(tab: InternalTab): void {
    if (tab.provisionalNetworkNavigation) {
      this.retainSupersededBrowserNetworkNavigations(tab, tab.provisionalNetworkNavigation.superseded);
    }
    tab.provisionalNetworkNavigation = undefined;
  }

  private rollbackBrowserNetworkNavigation(tab: InternalTab): void {
    const provisional = tab.provisionalNetworkNavigation;
    if (!provisional) return;
    const restored = new Map(provisional.requests ?? []);
    let restoredSequence = provisional.requestSequence;
    const attemptedRequests = [...(tab.networkRequests?.values() ?? [])].sort(
      (left, right) => left.sequence - right.sequence,
    );
    for (const request of attemptedRequests) {
      // ERR_ABORTED leaves the committed document alive, but the failed
      // navigation is still useful request history. Its diagnostics were
      // sanitized with the attempted document's independent redaction key, so
      // retain that already-redacted value while rebasing its display sequence
      // after the restored document's requests.
      const retained = { ...request, sequence: ++restoredSequence };
      restored.delete(retained.id);
      restored.set(retained.id, retained);
    }
    while (restored.size > MAX_BROWSER_NETWORK_REQUESTS_PER_TAB) {
      const oldest = restored.keys().next().value;
      if (oldest === undefined) break;
      restored.delete(oldest);
    }
    tab.networkRequests = restored.size > 0 ? restored : undefined;
    tab.networkRequestSequence = restoredSequence;
    const blockingActivity = [provisional.lastBlockingActivityAt, tab.networkLastBlockingActivityAt].filter(
      (value): value is number => value !== undefined,
    );
    tab.networkLastBlockingActivityAt = blockingActivity.length > 0 ? Math.max(...blockingActivity) : undefined;
    tab.networkRedactionKey = provisional.redactionKey;
    tab.diagnosticActiveNetworkRequestIds = new Set(
      [...provisional.activeRequestIds, ...attemptedRequests.map((request) => request.id)].filter((requestId) =>
        tab.activeNetworkRequests?.has(requestId),
      ),
    );
    this.retainSupersededBrowserNetworkNavigations(tab, provisional.superseded);
    tab.provisionalNetworkNavigation = undefined;
  }

  private finishBrowserNetworkRequest(
    tab: InternalTab,
    details: {
      id: number;
      statusCode?: number;
      fromCache?: boolean;
      responseHeaders?: Record<string, string[]>;
      resourceType?: string;
      error?: unknown;
      timestamp?: number;
    },
  ): void {
    if (this.tabs.get(tab.shell.id) !== tab) return;
    const request = tab.networkRequests?.get(details.id) ?? tab.provisionalNetworkNavigation?.requests?.get(details.id);
    const activeResourceType = tab.activeNetworkRequests?.get(details.id);
    const wasActive = tab.activeNetworkRequests?.delete(details.id) ?? false;
    tab.activeNetworkRequestUrls?.delete(details.id);
    const wasDiagnosticActive = tab.diagnosticActiveNetworkRequestIds?.delete(details.id) ?? wasActive;
    const completedResourceType = activeResourceType ?? details.resourceType ?? request?.resourceType;
    const completedBlockingRequest =
      wasActive &&
      wasDiagnosticActive &&
      completedResourceType !== undefined &&
      browserNetworkResourceBlocksIdle(completedResourceType);
    if (!request || request.completedAt !== undefined) {
      if (completedBlockingRequest) tab.networkLastBlockingActivityAt = browserNetworkEventTime(details.timestamp);
      return;
    }
    request.completedAt = Math.max(request.startedAt, browserNetworkEventTime(details.timestamp));
    if (Number.isInteger(details.statusCode) && details.statusCode! >= 0 && details.statusCode! <= 999) {
      request.statusCode = details.statusCode;
    }
    if (typeof details.fromCache === 'boolean') request.fromCache = details.fromCache;
    const responseBytes = responseContentLength(details.responseHeaders);
    if (responseBytes !== undefined) request.responseBytes = responseBytes;
    request.error = sanitizeBrowserNetworkError(details.error);
    if (completedBlockingRequest) tab.networkLastBlockingActivityAt = request.completedAt;
  }

  private wireSession(ses: Session, partition: string, scopeKey: string): void {
    this.wiredSessionsByScope?.set(scopeKey, ses);
    // A failed profile clear can leave a persistent service worker alive after
    // the process exits. Its retry marker is also durable fail-closed network
    // provenance: reinstall the private-network guard before this session can
    // issue background requests, even if resetting the main profile file was
    // one of the cleanup operations that succeeded before Chromium failed.
    this.refreshPendingCleanupQuarantine(scopeKey);
    if (this.wiredSessions.has(ses)) return;
    this.wiredSessions.add(ses);
    registerBrowserFramePreload(ses, this.pagePreloadPath);
    const configureProxy = (): Promise<void> =>
      this.validatingProxy &&
      typeof (ses as Session & { setProxy?: unknown }).setProxy === 'function' &&
      typeof (ses as Session & { closeAllConnections?: unknown }).closeAllConnections === 'function'
        ? this.validatingProxy.configureSession(ses)
        : Promise.resolve();
    // Start eagerly so the first navigation normally finds a ready session.
    // BrowserValidatingProxy evicts a rejected attempt, so request admission
    // below must call this helper again rather than retaining that rejection.
    void configureProxy().catch(() => undefined);
    const handleServiceWorkerRegistration = (
      _event: Electron.Event,
      details: Electron.RegistrationCompletedDetails,
    ): void => {
      if (!this.serviceWorkerRegistrationRequiresRestriction(scopeKey, details.scope)) return;
      // Persist this provenance because the worker can outlive every tab and
      // the app process, while its later webRequest events have no tab id.
      this.restrictBackgroundNetworkForScope(scopeKey);
    };
    ses.serviceWorkers?.on?.('registration-completed', handleServiceWorkerRegistration);
    const requestFilter = {
      urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'],
    };
    ses.webRequest.onBeforeRequest(requestFilter, (details, callback) => {
      let requests = this.scopeRequestActivities.get(scopeKey);
      if (!requests) {
        requests = new Map();
        this.scopeRequestActivities.set(scopeKey, requests);
      }
      if (!requests.has(details.id)) {
        try {
          requests.set(details.id, this.beginScopeActivity(scopeKey));
        } catch {
          if (requests.size === 0) this.scopeRequestActivities.delete(scopeKey);
          callback({ cancel: true });
          return;
        }
      }
      const tabId = details.webContentsId === undefined ? undefined : this.webContentsToTab.get(details.webContentsId);
      const tab = tabId ? this.tabs.get(tabId) : undefined;
      const scopeGeneration = this.currentScopeGeneration(scopeKey);
      let completed = false;
      const complete = (result: Electron.CallbackResponse): void => {
        if (completed) return;
        completed = true;
        const publishResponse = (): void => {
          const stale = this.scopeUnavailable(scopeKey) || this.currentScopeGeneration(scopeKey) !== scopeGeneration;
          const response = stale ? { cancel: true } : result;
          callback(response);
          // An admitted request owns its scope activity until Chromium reports
          // a terminal network event. Cancelled/stale requests never enter the
          // network stack, so release those immediately.
          if (response.cancel) {
            if (tab) {
              this.finishBrowserNetworkRequest(tab, {
                id: details.id,
                resourceType: details.resourceType,
                error: 'Request canceled before dispatch.',
              });
            }
            this.finishScopeRequestActivity(scopeKey, details.id);
          }
        };
        if (!this.validatingProxy) {
          // Focused unit fixtures intentionally construct the manager without
          // its constructor. Preserve their synchronous Electron callback seam
          // while production always joins the real proxy readiness barrier.
          publishResponse();
          return;
        }
        void configureProxy().then(publishResponse, (error: unknown) => {
          if (tab) {
            this.finishBrowserNetworkRequest(tab, {
              id: details.id,
              resourceType: details.resourceType,
              error: 'Browser connection validation is unavailable.',
            });
            if (details.resourceType === 'mainFrame') {
              tab.shell.loading = false;
              tab.shell.error = error instanceof Error ? error.message : String(error);
              this.emitTabs(tab.shell.conversationId);
            }
          }
          callback({ cancel: true });
          this.finishScopeRequestActivity(scopeKey, details.id);
        });
      };
      if (tab && !this.trackBrowserNetworkRequest(tab, details)) {
        complete({ cancel: true });
        return;
      }
      if (
        tab &&
        shouldBypassAiPolicyForTrustedUserNavigation(
          tab.trustedUserNavigation,
          details.resourceType,
          tab.trustedUserNavigationTarget,
          details.url,
          tab.trustedUserNavigationRequestId,
          details.id,
        )
      ) {
        // The first exact target match claims Chromium's request id. Redirects
        // retain that id; unrelated main-frame requests from surviving
        // AI-injected scripts cannot reuse the user-navigation exemption.
        if (tab.trustedUserNavigationRequestId === null) {
          tab.trustedUserNavigationRequestId = details.id;
          if (tab.trustedUserNavigationTimer) clearTimeout(tab.trustedUserNavigationTimer);
          tab.trustedUserNavigationTimer = null;
        } else tab.trustedUserNavigationTarget = details.url;
        this.validatingProxy?.releaseRequest(scopeKey, details.id);
        complete({});
        return;
      }
      const unattributedScopeRestricted = tab
        ? false
        : this.scopeHasActiveAiNetworkRestriction(scopeKey) ||
          this.restrictedBackgroundScopes.has(scopeKey) ||
          this.storeForScope(scopeKey).isBackgroundNetworkRestricted();
      if (!shouldApplyAiRequestPolicy(tab?.aiNetworkRestricted, unattributedScopeRestricted)) {
        this.validatingProxy?.releaseRequest(scopeKey, details.id);
        if (tab) {
          let documentUrl = tab.shell.url;
          if (details.resourceType === 'mainFrame') documentUrl = details.url;
          else {
            try {
              documentUrl = tab.view?.webContents.getURL() || documentUrl;
            } catch {
              // Keep the last committed shell URL if Chromium is tearing down.
            }
          }
          this.trackUnrestrictedDocumentRequest(tab, details.url, partition, documentUrl);
        } else if (!this.trackUnrestrictedScopeRequest(scopeKey, details.url, partition, details.referrer)) {
          // Persistent workers can outlive their own tab while an unrelated
          // origin remains open in the same profile. With no matching document
          // origin to sanitize later, classify the request before Chromium can
          // cache a private-network response. User-owned worker traffic to a
          // verified public destination remains available in the background.
          void this.assertAssistantNavigationAllowed(aiRequestPolicyUrl(details.url), partition, undefined, false).then(
            () => complete({}),
            () => complete({ cancel: true }),
          );
          return;
        }
        complete({});
        return;
      }
      if (this.aiAllowPrivateNetwork === false) {
        try {
          this.validatingProxy?.restrictRequest(scopeKey, details.id, details.url);
        } catch (error) {
          if (tab) this.finishBrowserNetworkRequest(tab, { id: details.id, resourceType: details.resourceType, error });
          complete({ cancel: true });
          return;
        }
      }
      void this.assertAssistantNavigationAllowed(aiRequestPolicyUrl(details.url), partition).then(
        () => complete({}),
        (error: unknown) => {
          if (tab && this.tabs.get(tab.shell.id) === tab) {
            this.finishBrowserNetworkRequest(tab, { id: details.id, resourceType: details.resourceType, error });
            // A blocked image/XHR/font is diagnostic request data, not a failed
            // top-level navigation. Keep it in browser_network without replacing
            // a successfully rendered page with the tab-wide error surface.
            if (details.resourceType === 'mainFrame') {
              tab.shell.loading = false;
              tab.shell.error = error instanceof Error ? error.message : String(error);
              this.emitTabs(tab.shell.conversationId);
            }
          }
          complete({ cancel: true });
        },
      );
    });
    const finishCompletedRequest = (details: Electron.OnCompletedListenerDetails): void => {
      this.finishScopeRequestActivity(scopeKey, details.id);
      const tabId = details.webContentsId === undefined ? undefined : this.webContentsToTab.get(details.webContentsId);
      const tab = tabId ? this.tabs.get(tabId) : undefined;
      // Electron's successful completion payload also has an `error` field
      // (commonly "net::OK"). Do not report that as a failed request.
      if (tab) {
        this.finishBrowserNetworkRequest(tab, {
          id: details.id,
          statusCode: details.statusCode,
          fromCache: details.fromCache,
          responseHeaders: details.responseHeaders,
          resourceType: details.resourceType,
        });
      }
    };
    const recordResponseStarted = (details: Electron.OnResponseStartedListenerDetails): void => {
      const tabId = details.webContentsId === undefined ? undefined : this.webContentsToTab.get(details.webContentsId);
      const tab = tabId ? this.tabs.get(tabId) : undefined;
      if (tab) this.trackBrowserNetworkResponseStarted(tab, details);
    };
    const finishFailedRequest = (details: Electron.OnErrorOccurredListenerDetails): void => {
      this.finishScopeRequestActivity(scopeKey, details.id);
      const tabId = details.webContentsId === undefined ? undefined : this.webContentsToTab.get(details.webContentsId);
      const tab = tabId ? this.tabs.get(tabId) : undefined;
      if (tab) {
        this.finishBrowserNetworkRequest(tab, details);
        // did-fail-load normally consumes this lease too, but webRequest is the
        // authoritative terminal event for the exact request. Clear it here so
        // an unusual Chromium failure path cannot leave an unbounded bypass.
        if (details.resourceType === 'mainFrame' && tab.trustedUserNavigationRequestId === details.id) {
          this.clearTrustedUserNavigation(tab, tab.trustedUserNavigationLease);
        }
      }
    };
    ses.webRequest.onResponseStarted?.(requestFilter, recordResponseStarted);
    ses.webRequest.onCompleted(requestFilter, finishCompletedRequest);
    ses.webRequest.onErrorOccurred(requestFilter, finishFailedRequest);
    ses.setPermissionCheckHandler((contents, permission, requestingOrigin, details) => {
      const tabId = contents ? this.webContentsToTab.get(contents.id) : undefined;
      const tab = tabId ? this.tabs.get(tabId) : undefined;
      if (!tab || this.scopeUnavailable(tab.scopeKey)) return false;
      const permissionDetails = details as BrowserPermissionDetails;
      const origin = normalizeBrowserPermissionOrigin(
        requestingOrigin || details.securityOrigin || details.requestingUrl || contents?.getURL() || '',
      );
      const storageKeys = browserPermissionStorageKeys(permission, permissionDetails);
      if (storageKeys.length === 0) return false;
      const canPersist = isPersistableBrowserPermission(permission);
      // A user grant is not consent for an assistant-controlled page. Chromium
      // may call this synchronous check without following it with a request
      // callback, so fail closed and require a fresh, attributable prompt.
      if (tab.aiNetworkRestricted) return false;
      return storageKeys.every(
        (storageKey) =>
          this.oneTimePermissions.has(permissionGrantKey(tab.shell.id, origin, storageKey)) ||
          (canPersist &&
            isPersistentBrowserPermissionOrigin(origin) &&
            this.storeForScope(tab.scopeKey).getPermission(origin, storageKey) === 'allow'),
      );
    });
    ses.setPermissionRequestHandler((contents, permission, callback, details) => {
      const tabId = this.webContentsToTab.get(contents.id);
      const tab = tabId ? this.tabs.get(tabId) : undefined;
      if (!tab || this.scopeUnavailable(tab.scopeKey)) {
        callback(false);
        return;
      }
      const permissionDetails = details as BrowserPermissionDetails & {
        requestingUrl?: string;
        securityOrigin?: string;
      };
      const origin = normalizeBrowserPermissionOrigin(
        permissionDetails.securityOrigin || permissionDetails.requestingUrl || contents.getURL(),
      );
      const storageKeys = browserPermissionStorageKeys(permission, permissionDetails);
      if (storageKeys.length === 0) {
        callback(false);
        return;
      }
      const persistentOrigin = isPersistentBrowserPermissionOrigin(origin);
      const canPersist = persistentOrigin && isPersistableBrowserPermission(permission);
      const stored = storageKeys.map((storageKey) =>
        canPersist ? this.storeForScope(tab.scopeKey).getPermission(origin, storageKey) : undefined,
      );
      if (stored.some((decision) => decision === 'deny')) {
        callback(false);
        return;
      }
      const assistantTriggered = tab.aiNetworkRestricted;
      if (assistantTriggered) {
        // Native permission callbacks can suspend page promises indefinitely.
        // Background assistant work has no presentation dependency, so it must
        // fail closed immediately instead of waiting for the sidebar or a user.
        callback(false);
        return;
      }
      if (
        storageKeys.every(
          (storageKey, index) =>
            stored[index] === 'allow' ||
            this.oneTimePermissions.has(permissionGrantKey(tab.shell.id, origin, storageKey)),
        )
      ) {
        callback(true);
        return;
      }
      const duplicate = [...this.pendingPermissions.values()].some(
        (pending) =>
          pending.tabId === tab.shell.id &&
          pending.origin === origin &&
          pending.storageKeys.length === storageKeys.length &&
          pending.storageKeys.every((storageKey) => storageKeys.includes(storageKey)),
      );
      if (duplicate || !this.canQueuePrompt(tab.shell.id)) {
        callback(false);
        return;
      }
      const id = randomUUID();
      const permissionDescription = describeBrowserPermission(permission, permissionDetails);
      const target = browserPermissionTargetLabel(permission, permissionDetails);
      const timer = setTimeout(() => {
        this.finishPendingPermission(id, false);
      }, PROMPT_TIMEOUT_MS);
      timer.unref?.();
      this.pendingPermissions.set(id, {
        tabId: tab.shell.id,
        conversationId: tab.shell.conversationId,
        scopeKey: tab.scopeKey,
        tabGeneration: tab.generation,
        origin,
        permission: permissionDescription,
        ...(target ? { target } : {}),
        canPersist,
        assistantTriggered,
        storageKeys,
        callback,
        timer,
      });
      this.emit({
        type: 'permission-prompt',
        conversationId: tab.shell.conversationId,
        prompt: {
          id,
          tabId: tab.shell.id,
          origin,
          permission: permissionDescription,
          ...(target ? { target } : {}),
          canPersist: canPersist && !assistantTriggered,
          assistantTriggered,
        },
      });
    });
    const sessionScopeKey = scopeKey;
    const handleWillDownload = (_event: Electron.Event, item: DownloadItem, contents: WebContents): void => {
      const tabId = this.webContentsToTab.get(contents.id);
      const tab = tabId ? this.tabs.get(tabId) : undefined;
      // Session events can arrive after a view was detached or while profile
      // clearing/disable is draining the previous snapshot. Never allow such a
      // download to continue outside Kai's tracking and persistence barriers.
      if (!tab || tab.scopeKey !== sessionScopeKey || this.scopeUnavailable(sessionScopeKey)) {
        try {
          item.cancel();
        } catch {
          // The item may already have reached a terminal state.
        }
        return;
      }
      const id = randomUUID();
      const scopeKey = tab.scopeKey;
      const conversationId = tab.shell.conversationId;
      const originatingTabId = tab.shell.id;
      // Only assistant-created tabs have turn-scoped downloads. A kept tab may
      // be controlled by a later run, so prefer that current control lease over
      // its original creator. User-owned tabs may retain a download only when
      // current interactive user provenance is verified below.
      const assistantOwnerId = this.assistantDownloadOwner(tab);
      const assistantTriggered = assistantOwnerId !== null;
      if (assistantTriggered) this.clearContextMenuDownloadAuthority(contents.id);
      if (!assistantTriggered) {
        const current = Date.now();
        const userGesture =
          tab.popupGesture?.source === 'user' && tab.popupGesture.expiresAt >= current ? tab.popupGesture : null;
        let trustedChromeNavigation = false;
        let trustedContextMenuDownload = false;
        try {
          const downloadUrl = item.getURL();
          trustedChromeNavigation =
            tab.trustedUserNavigationRequestId !== null &&
            isTrustedUserNavigationTarget(tab.trustedUserNavigation, tab.trustedUserNavigationTarget, downloadUrl);
          trustedContextMenuDownload = this.consumeContextMenuDownloadAuthority(tab, contents, downloadUrl);
        } catch {
          // A missing/tearing-down DownloadItem URL cannot inherit broad
          // Browser-chrome navigation or context-menu authority.
        }
        const trustedInteractiveGesture = !!userGesture && this.isTargetViewInteractive(tab, contents);
        if (!trustedContextMenuDownload && !trustedChromeNavigation && !trustedInteractiveGesture) {
          // A hidden/background user-owned page can start downloads without an
          // assistant lease (for example from a timer or service callback).
          // Never let that surface an unseen native dialog. Assistant-owned
          // downloads take the quarantine branch above; unattributed user-tab
          // downloads fail closed until a fresh visible interaction retries.
          try {
            item.cancel();
          } catch {
            // The item may already have reached a terminal state.
          }
          tab.shell.error = 'Download blocked because it was not started by an active Browser interaction.';
          this.emitTabs(tab.shell.conversationId);
          return;
        }
        // Chromium transient activation is single-use. Consume Kai's matching
        // provenance as well so one click cannot authorize later timer-driven
        // downloads after this dialog has opened.
        if (userGesture) tab.popupGesture = null;
        // A Browser-chrome navigation may produce a download instead of a
        // committed document. Consume its exact request-bound lease here so it
        // cannot authorize an unrelated later page/timer download.
        if (trustedChromeNavigation) this.clearTrustedUserNavigation(tab, tab.trustedUserNavigationLease);
      }
      const scopeGeneration = this.currentScopeGeneration(scopeKey);
      let quarantinePath: string | undefined;
      let lastPublishedAt = 0;
      let pendingPublish: ReturnType<typeof setTimeout> | null = null;
      let terminalWrite: Promise<void> | null = null;
      let cancellationRequested = false;
      let resolveDone!: () => void;
      const done = new Promise<void>((resolve) => {
        resolveDone = resolve;
      });
      const reportPersistenceFailure = (error: unknown): void => {
        if (this.tabs.get(originatingTabId) !== tab) return;
        tab.shell.error = `Download history could not be saved: ${
          error instanceof Error ? error.message : String(error)
        }`;
        this.emitTabs(conversationId);
      };
      try {
        if (assistantTriggered) {
          const declaredBytes = item.getTotalBytes();
          const receivedBytes = item.getReceivedBytes();
          if (
            !Number.isSafeInteger(declaredBytes) ||
            declaredBytes <= 0 ||
            declaredBytes > MAX_ASSISTANT_DOWNLOAD_BYTES ||
            !Number.isSafeInteger(receivedBytes) ||
            receivedBytes < 0 ||
            receivedBytes > declaredBytes
          ) {
            throw new Error(
              declaredBytes <= 0
                ? 'Assistant downloads require a declared positive content length so Kai can enforce its disk quota.'
                : `Assistant download exceeds the ${MAX_ASSISTANT_DOWNLOAD_BYTES / (1024 * 1024)} MB limit.`,
            );
          }
          // Background automation must never block on an unseen native dialog
          // or place page-selected executable content in the user's Downloads
          // folder. Use a private, bounded app-owned quarantine with a generated
          // extension that the OS will not treat as the remote file type.
          const protectedPaths = this.protectedAssistantDownloadPaths(scopeKey);
          quarantinePath = prepareAssistantDownloadQuarantine(this.appHome, scopeKey, id, protectedPaths, (pruned) => {
            void this.reconcilePrunedAssistantDownloads(scopeKey, pruned, conversationId).catch((error: unknown) => {
              console.warn('[Browser] Could not reconcile pruned assistant downloads:', error);
            });
          });
          item.setSavePath(quarantinePath);
        } else {
          item.setSaveDialogOptions({
            defaultPath: join(app.getPath('downloads'), basename(item.getFilename())),
          });
        }
      } catch (error) {
        try {
          item.cancel();
        } catch {
          // A synchronous path-selection failure may race a terminal item.
        }
        tab.shell.error = `Download could not start: ${error instanceof Error ? error.message : String(error)}`;
        this.emitTabs(conversationId);
        return;
      }
      const publish = (state: BrowserDownload['state'], force = false, allowStaleGeneration = false): Promise<void> => {
        if (!allowStaleGeneration && this.currentScopeGeneration(scopeKey) !== scopeGeneration) {
          return Promise.resolve();
        }
        const current = Date.now();
        if (!force && current - lastPublishedAt < 250) {
          if (!pendingPublish) {
            pendingPublish = setTimeout(
              () => {
                pendingPublish = null;
                publish('progressing', true);
              },
              250 - (current - lastPublishedAt),
            );
            pendingPublish.unref?.();
          }
          return Promise.resolve();
        }
        lastPublishedAt = current;
        const download: BrowserDownload = {
          id,
          tabId: originatingTabId,
          filename: item.getFilename(),
          receivedBytes: item.getReceivedBytes(),
          totalBytes: item.getTotalBytes(),
          state,
          ...(assistantTriggered ? { quarantined: true } : {}),
          path: assistantTriggered && state !== 'completed' ? undefined : item.getSavePath() || undefined,
          url: item.getURL() ? boundedBrowserUrl(item.getURL()) : undefined,
        };
        this.cacheDownload(scopeKey, download);
        try {
          const store = this.storeForScope(scopeKey);
          for (const evictedId of store.addDownload(download) ?? []) {
            if (this.downloads.get(evictedId)?.scopeKey === scopeKey) this.downloads.delete(evictedId);
          }
          // Progress events update the in-memory shelf immediately but their
          // profile write is debounced and performed with async filesystem I/O.
          // Flush a terminal state promptly without blocking Electron's event.
          if (state !== 'progressing') {
            const persistence = store.flushDownloads().catch(reportPersistenceFailure);
            this.emitDownloadForScope(scopeKey, conversationId, download);
            return persistence;
          }
        } catch (error) {
          // Keep the live download usable even when its profile metadata cannot
          // be persisted, and never throw from Electron's download callback.
          reportPersistenceFailure(error);
        }
        this.emitDownloadForScope(scopeKey, conversationId, download);
        return Promise.resolve();
      };
      const removeListeners = (): void => {
        item.off('updated', onUpdated);
        item.off('done', onDone);
      };
      const finish = (state: BrowserDownload['state'], allowStaleGeneration = false): Promise<void> => {
        if (terminalWrite) return terminalWrite;
        if (pendingPublish) clearTimeout(pendingPublish);
        pendingPublish = null;
        removeListeners();
        terminalWrite = (async () => {
          let terminalState = state;
          if (quarantinePath) {
            try {
              if (state === 'completed') secureAssistantDownloadFile(quarantinePath);
              else removeAssistantDownloadFile(quarantinePath);
            } catch (error) {
              terminalState = 'interrupted';
              try {
                removeAssistantDownloadFile(quarantinePath);
              } catch {
                // Preserve the first quarantine failure for the tab status.
              }
              if (this.tabs.get(originatingTabId) === tab) {
                tab.shell.error = `Assistant download quarantine failed: ${
                  error instanceof Error ? error.message : String(error)
                }`;
                this.emitTabs(conversationId);
              }
            }
          }
          await publish(terminalState, true, allowStaleGeneration);
        })().finally(async () => {
          this.activeDownloads.delete(item);
          if (assistantTriggered) {
            try {
              const protectedPaths = this.protectedAssistantDownloadPaths(scopeKey);
              const reserveFiles = protectedPaths.size;
              const pruned = pruneAssistantDownloadQuarantine(this.appHome, scopeKey, protectedPaths, {
                reserveFiles,
                reserveBytes: reserveFiles * MAX_ASSISTANT_DOWNLOAD_BYTES,
                reservationsIncludeProtectedPaths: true,
              });
              await this.reconcilePrunedAssistantDownloads(scopeKey, pruned, conversationId);
            } catch (error) {
              console.warn('[Browser] Could not enforce assistant download retention:', error);
            }
          }
          this.releaseScopeRuntimeWhenIdle(scopeKey);
          resolveDone();
        });
        return terminalWrite;
      };
      const onUpdated = () => {
        if (
          assistantTriggered &&
          (item.getReceivedBytes() > MAX_ASSISTANT_DOWNLOAD_BYTES ||
            item.getTotalBytes() > MAX_ASSISTANT_DOWNLOAD_BYTES)
        ) {
          if (this.tabs.get(originatingTabId) === tab) {
            tab.shell.error = `Assistant download exceeded the ${MAX_ASSISTANT_DOWNLOAD_BYTES / (1024 * 1024)} MB limit.`;
            this.emitTabs(conversationId);
          }
          if (!cancellationRequested) {
            cancellationRequested = true;
            try {
              item.cancel();
            } catch {
              // Keep the terminal listener installed. If Chromium had already
              // stopped the item, its queued `done` event still owns cleanup;
              // otherwise a later update/lifecycle cancellation can retry.
              cancellationRequested = false;
            }
          }
          return;
        }
        void publish('progressing');
      };
      let persistTerminalAcrossGeneration = false;
      const onDone = (_doneEvent: Electron.Event, state: 'completed' | 'cancelled' | 'interrupted'): void => {
        void finish(state, persistTerminalAcrossGeneration);
      };
      const activeDownload: ActiveBrowserDownload = {
        id,
        scopeKey,
        conversationId,
        tabId: originatingTabId,
        assistantOwnerId,
        keepOpen: tab.shell.keepOpen,
        quarantinePath,
        item,
        done,
        cancel: (persistAcrossGeneration = false) => {
          // Settings changes, data clearing, and shutdown intentionally bump a
          // profile generation before they ask Chromium to cancel. Latch that
          // lifecycle authority before item.cancel(), which may synchronously
          // emit `done`, so its terminal shelf state is still durably written.
          if (persistAcrossGeneration) persistTerminalAcrossGeneration = true;
          const waitForTerminal = (): Promise<void> =>
            waitForBrowserDownloadTerminal(done, `Browser download ${id} cancellation`);
          if (terminalWrite) return waitForTerminal();
          if (!cancellationRequested) {
            cancellationRequested = true;
            try {
              item.cancel();
            } catch (error) {
              // Do not release the profile barrier without Electron's terminal
              // event. A still-progressing item may continue to own its partial
              // file even when the cancellation request itself throws. Leave the
              // listeners, quarantine, and active-download entry intact so a later
              // lifecycle retry can request cancellation again.
              cancellationRequested = false;
              return Promise.reject(new Error(`Browser download ${id} could not be cancelled.`, { cause: error }));
            }
          }
          return waitForTerminal().catch((error: unknown) => {
            // Electron accepted cancel() but did not publish `done` inside the
            // bounded lifecycle deadline. Do not synthesize a terminal state or
            // release profile guards; make a subsequent lifecycle call retryable.
            if (!terminalWrite) cancellationRequested = false;
            throw error;
          });
        },
      };
      this.activeDownloads.set(item, activeDownload);
      item.on('updated', onUpdated);
      item.on('done', onDone);
      void publish('progressing', true);
      if (
        assistantTriggered &&
        (item.getReceivedBytes() > MAX_ASSISTANT_DOWNLOAD_BYTES || item.getTotalBytes() > MAX_ASSISTANT_DOWNLOAD_BYTES)
      ) {
        onUpdated();
      }
    };
    ses.on('will-download', handleWillDownload);
    this.wiredSessionCleanups.set(scopeKey, () => {
      const safely = (operation: () => void): void => {
        try {
          operation();
        } catch {
          // Session teardown is best-effort after the scope has already been
          // drained and cleared. Continue removing every manager-owned hook.
        }
      };
      safely(() => ses.serviceWorkers?.off?.('registration-completed', handleServiceWorkerRegistration));
      safely(() => ses.webRequest.onBeforeRequest(null));
      safely(() => ses.webRequest.onResponseStarted?.(null));
      safely(() => ses.webRequest.onCompleted(null));
      safely(() => ses.webRequest.onErrorOccurred(null));
      safely(() => ses.setPermissionCheckHandler(null));
      safely(() => ses.setPermissionRequestHandler(null));
      safely(() => ses.off('will-download', handleWillDownload));
      this.finishAllScopeRequestActivities(scopeKey);
      this.wiredSessions.delete(ses);
      if (this.wiredSessionsByScope.get(scopeKey) === ses) this.wiredSessionsByScope.delete(scopeKey);
    });
  }

  private handlePageShortcut(
    tab: InternalTab,
    contents: WebContents,
    event: Electron.Event,
    input: Electron.Input,
  ): void {
    const shortcutKeys = [
      ...(input.meta ? ['meta'] : []),
      ...(input.control ? ['control'] : []),
      ...(input.shift ? ['shift'] : []),
      ...(input.alt ? ['alt'] : []),
      input.key,
    ];
    // Electron emits before-input-event for both halves of a keystroke. Native
    // edit commands belong to keyDown; dispatching again on keyUp duplicates
    // paste/cut/copy side effects.
    const clipboardCommand = input.type === 'keyDown' ? resolveClipboardShortcutCommand(shortcutKeys) : null;
    if (clipboardCommand) {
      event.preventDefault();
      // The event belongs to a manager-created page, so failure to claim it is
      // treated as a stale identity and remains blocked rather than falling
      // through to Chromium's unguarded native shortcut.
      this.dispatchClipboardCommand(contents, clipboardCommand);
      return;
    }
    const shortcut = resolveBrowserShortcut(input);
    if (!shortcut) return;
    if (tab.aiActionDepth > 0) {
      event.preventDefault();
      return;
    }
    if (shortcut.action === 'stop' && !tab.shell.loading) return;
    event.preventDefault();
    void this.applyShortcut(tab.shell.conversationId, tab.shell.id, shortcut.action, shortcut.index, true).catch(
      (error) => {
        if (this.tabs.get(tab.shell.id) !== tab) return;
        tab.shell.error = error instanceof Error ? error.message : String(error);
        this.emitTabs(tab.shell.conversationId);
      },
    );
  }

  private async applyShortcut(
    conversationId: string,
    tabId: string,
    action: BrowserShortcutAction,
    index?: number,
    focusPageAfterTabMutation = false,
  ): Promise<void> {
    // Electron resolves the accelerator before React receives the synthetic
    // focus event. Claim Browser chrome synchronously so another application
    // menu command cannot be routed to the page during that IPC round trip.
    if (shouldFocusBrowserChrome(action)) this.setChromeFocus(conversationId, true);

    if (action === 'new-tab') {
      await this.createTab({ conversationId, owner: 'user' });
      this.emit({ type: 'shortcut', conversationId, action: 'focus-url' });
    } else if (action === 'close-tab') {
      await this.commandTab(conversationId, tabId, 'close');
      if (focusPageAfterTabMutation) await this.focusActiveViewAfterNativeShortcut(conversationId);
    } else if (action === 'reopen-tab') {
      const reopened = await this.reopenClosedTab(conversationId);
      if (reopened && focusPageAfterTabMutation) await this.focusActiveViewAfterNativeShortcut(conversationId);
    } else if (action === 'reload') await this.commandTab(conversationId, tabId, 'reload');
    else if (action === 'hard-reload') await this.commandTab(conversationId, tabId, 'hard-reload');
    else if (action === 'stop') await this.commandTab(conversationId, tabId, 'stop');
    else if (action === 'back') await this.commandTab(conversationId, tabId, 'back');
    else if (action === 'forward') await this.commandTab(conversationId, tabId, 'forward');
    else if (action === 'zoom-in')
      await this.setZoom(conversationId, tabId, this.requireTab(conversationId, tabId).shell.zoomLevel + 0.5);
    else if (action === 'zoom-out')
      await this.setZoom(conversationId, tabId, this.requireTab(conversationId, tabId).shell.zoomLevel - 0.5);
    else if (action === 'zoom-reset') await this.setZoom(conversationId, tabId, 0);
    else if (action === 'tab-number' || action === 'tab-last') {
      const order = this.tabOrder.get(conversationId) ?? [];
      const target = action === 'tab-last' ? order.at(-1) : order[index ?? 0];
      if (target) await this.commandTab(conversationId, target, 'activate');
    } else {
      this.emit({ type: 'shortcut', conversationId, action, index });
    }
  }

  private async focusActiveViewAfterNativeShortcut(conversationId: string): Promise<void> {
    const activeId = this.activeTabs.get(conversationId);
    const tab = activeId ? this.tabs.get(activeId) : undefined;
    if (!tab) return;
    await this.ensureView(tab);
    this.attachActiveView(conversationId, true);
  }

  private printPage(contents: WebContents): Promise<void> {
    return new Promise((resolve, reject) => {
      contents.print({ printBackground: true }, (success, failureReason) => {
        if (success) resolve();
        else reject(new Error(failureReason || 'The browser page could not be printed.'));
      });
    });
  }

  private buildContextMenu(tab: InternalTab, contents: WebContents, params: Electron.ContextMenuParams): Menu {
    const menu = new Menu();
    const navigation = contents.navigationHistory;
    const pageLease = this.captureBrowserPageLease(tab, contents);
    const pageToken = this.browserPageLeaseToken(pageLease);
    const nativeDialogPanelGeneration = this.panelAuthorityGeneration(tab.shell.conversationId);
    const contextPageTitle = tab.shell.title;
    const contextPageUrl = contents.getURL();
    const assertContextPageCurrent = (): void => this.assertBrowserPageLease(tab, pageLease, 'context-menu action');
    const reportContextMenuFailure = (error: unknown): void => {
      if (this.tabs.get(tab.shell.id) !== tab || tab.view?.webContents !== contents) return;
      tab.shell.error = error instanceof Error ? error.message : String(error);
      this.emitTabs(tab.shell.conversationId);
    };
    const runContextMenuTask = (task: () => void | Promise<unknown>): void => {
      void Promise.resolve()
        .then(() => {
          assertContextPageCurrent();
          return task();
        })
        .catch(reportContextMenuFailure);
    };
    const runContextMenuPageTask = (task: () => void | Promise<unknown>): void => {
      runContextMenuTask(async () => {
        assertContextPageCurrent();
        await task();
        assertContextPageCurrent();
      });
    };
    const runUserCommand = (command: 'back' | 'forward' | 'reload') => {
      runContextMenuTask(() => {
        assertContextPageCurrent();
        return this.commandTab(tab.shell.conversationId, tab.shell.id, command, 'user');
      });
    };
    const runClipboardCommand = (command: BrowserAwareEditCommand) => {
      this.dispatchGuardedClipboardOperation(contents, () => contents[command](), pageLease, true);
    };
    menu.append(
      new MenuItem({
        label: 'Back',
        enabled: navigation.canGoBack(),
        click: () => runUserCommand('back'),
      }),
    );
    menu.append(
      new MenuItem({
        label: 'Forward',
        enabled: navigation.canGoForward(),
        click: () => runUserCommand('forward'),
      }),
    );
    menu.append(new MenuItem({ label: 'Reload', click: () => runUserCommand('reload') }));
    menu.append(
      new MenuItem({
        label: 'Copy Page URL',
        click: () => runContextMenuTask(() => clipboard.writeText(contextPageUrl)),
      }),
    );
    menu.append(
      new MenuItem({
        label: 'Save Page As…',
        click: () =>
          runContextMenuTask(async () => {
            assertContextPageCurrent();
            const win = this.getWindow();
            const options = {
              title: 'Save web page',
              defaultPath: join(
                app.getPath('documents'),
                `${contextPageTitle.replace(/[^a-z0-9._-]+/gi, '-').slice(0, 80) || 'page'}.html`,
              ),
              filters: [{ name: 'Web Page', extensions: ['html'] }],
            };
            const result =
              win && !win.isDestroyed()
                ? await dialog.showSaveDialog(win, options)
                : await dialog.showSaveDialog(options);
            assertContextPageCurrent();
            if (!result.canceled && result.filePath) {
              await this.runTabOperation(tab, async () => {
                assertContextPageCurrent();
                await this.assertTabNotSensitive(tab, contents, 'Saving the page');
                assertContextPageCurrent();
                await contents.savePage(result.filePath!, 'HTMLComplete');
                assertContextPageCurrent();
              });
            }
          }),
      }),
    );
    menu.append(new MenuItem({ type: 'separator' }));
    if (params.linkURL) {
      menu.append(
        new MenuItem({
          label: 'Open Link in New Tab',
          click: () =>
            runContextMenuTask(() =>
              this.createTab({
                conversationId: tab.shell.conversationId,
                url: params.linkURL,
              }),
            ),
        }),
      );
      menu.append(
        new MenuItem({
          label: 'Open Link in Default Browser',
          enabled: /^https?:\/\//i.test(params.linkURL),
          click: () => {
            if (/^https?:\/\//i.test(params.linkURL)) runContextMenuTask(() => shell.openExternal(params.linkURL));
          },
        }),
      );
      menu.append(
        new MenuItem({
          label: 'Copy Link Address',
          click: () => runContextMenuTask(() => clipboard.writeText(params.linkURL)),
        }),
      );
      menu.append(new MenuItem({ type: 'separator' }));
    }
    if (params.mediaType === 'image' && params.srcURL) {
      menu.append(
        new MenuItem({
          label: 'Copy Image',
          click: () => {
            this.dispatchGuardedClipboardOperation(contents, () => contents.copyImageAt(params.x, params.y), pageLease);
          },
        }),
      );
      menu.append(
        new MenuItem({
          label: 'Save Image As…',
          click: () =>
            runContextMenuPageTask(() =>
              this.runTabOperation(tab, async () => {
                assertContextPageCurrent();
                await this.assertTabNotSensitive(tab, contents, 'Saving the image');
                assertContextPageCurrent();
                const authority = this.authorizeContextMenuDownload(tab, contents, params.srcURL);
                try {
                  contents.downloadURL(params.srcURL);
                } catch (error) {
                  this.clearContextMenuDownloadAuthority(contents.id, authority);
                  throw error;
                }
              }),
            ),
        }),
      );
      menu.append(new MenuItem({ type: 'separator' }));
    }
    if (params.isEditable) {
      menu.append(
        new MenuItem({
          label: 'Cut',
          enabled: params.editFlags.canCut && !tab.shell.sensitive,
          click: () => runClipboardCommand('cut'),
        }),
      );
      menu.append(
        new MenuItem({
          label: 'Copy',
          enabled: params.editFlags.canCopy && !tab.shell.sensitive,
          click: () => runClipboardCommand('copy'),
        }),
      );
      menu.append(
        new MenuItem({
          label: 'Paste',
          enabled: params.editFlags.canPaste && !tab.shell.sensitive,
          click: () => runClipboardCommand('paste'),
        }),
      );
      menu.append(
        new MenuItem({ label: 'Select All', click: () => runContextMenuPageTask(() => contents.selectAll()) }),
      );
      menu.append(new MenuItem({ type: 'separator' }));
    } else if (params.selectionText) {
      menu.append(
        new MenuItem({
          label: 'Copy',
          enabled: !tab.shell.sensitive,
          click: () => runClipboardCommand('copy'),
        }),
      );
      menu.append(new MenuItem({ type: 'separator' }));
    }
    menu.append(
      new MenuItem({
        label: 'Capture Viewport',
        enabled: !tab.shell.sensitive,
        click: () =>
          runContextMenuTask(() =>
            this.screenshot(tab.shell.conversationId, {
              tabId: tab.shell.id,
              mode: 'viewport' as const,
              documentToken: pageToken,
              exportToFile: true,
            }),
          ),
      }),
    );
    menu.append(
      new MenuItem({
        label: 'Print…',
        click: () =>
          runContextMenuPageTask(() =>
            this.runTabOperation(tab, async () => {
              await this.assertTabNotSensitive(tab, contents, 'Printing');
              assertContextPageCurrent();
              if (!this.hasBrowserNativeDialogAuthority(tab, contents, nativeDialogPanelGeneration)) return;
              await this.printPage(contents);
            }),
          ),
      }),
    );
    menu.append(new MenuItem({ type: 'separator' }));
    menu.append(
      new MenuItem({
        label: 'Inspect Element',
        click: () => runContextMenuPageTask(() => contents.inspectElement(params.x, params.y)),
      }),
    );
    return menu;
  }

  private handleSensitiveEvent = (event: IpcMainEvent, sensitive: unknown): void => {
    const tabId = this.webContentsToTab.get(event.sender.id);
    const tab = tabId ? this.tabs.get(tabId) : undefined;
    if (!tab || sensitive !== true) return;
    // Password state is intentionally one-way for a document. A page can clear
    // or type-toggle the input immediately after reporting it; only a committed
    // top-level navigation may declassify the tab.
    this.setTabSensitive(tab, true);
  };

  private handleMenuSensitivityProbeResult = (
    event: IpcMainEvent,
    payload?: { token?: unknown; sensitive?: unknown; complete?: unknown },
  ): void => {
    if (
      typeof payload?.token !== 'string' ||
      payload.token.length === 0 ||
      payload.token.length > 128 ||
      typeof payload.sensitive !== 'boolean' ||
      typeof payload.complete !== 'boolean'
    )
      return;
    const pending = this.pendingMenuSensitivityProbes.get(payload.token);
    const frame = event.senderFrame;
    if (!pending || event.sender.id !== pending.contentsId || !frame || frame.detached || frame.isDestroyed()) return;
    const expectedIdentity = pending.expectedFrames.get(frame.frameTreeNodeId);
    if (!expectedIdentity || expectedIdentity !== this.automationFrameIdentity(frame)) return;
    pending.responses.set(frame.frameTreeNodeId, {
      sensitive: payload.sensitive,
      complete: payload.complete,
    });
    if (pending.responses.size === pending.expectedFrames.size) pending.settle();
  };

  private handlePageActivity = (event: IpcMainEvent): void => {
    const tabId = this.webContentsToTab.get(event.sender.id);
    const tab = tabId ? this.tabs.get(tabId) : undefined;
    if (!tab) return;
    tab.lastUsedAt = Date.now();
  };

  private elementPickerFrameForEvent(event: IpcMainEvent, token: unknown): PendingElementPickerFrame | null {
    if (typeof token !== 'string' || token.length === 0 || token.length > 128) return null;
    const binding = this.pendingElementPickerFrames.get(token);
    if (!binding) return null;
    const { picker, frame } = binding;
    if (
      picker.settled ||
      event.sender !== picker.contents ||
      event.sender.id !== picker.contents.id ||
      event.senderFrame !== frame ||
      event.senderFrame?.frameTreeNodeId !== frame.frameTreeNodeId
    ) {
      return null;
    }
    if (!this.isBrowserPageLeaseCurrent(picker.tab, picker.pageLease)) {
      picker.cancel(new Error('Element picking cancelled because the page changed.'));
      return null;
    }
    return binding;
  }

  private finishElementPicker(picker: PendingElementPicker, result: { selector: string } | { error: Error }): void {
    if (picker.settled) return;
    picker.settled = true;
    if (picker.timer) clearTimeout(picker.timer);
    picker.timer = null;
    if (this.pendingElementPickerCancels.get(picker.tab.shell.id) === picker.cancel) {
      this.pendingElementPickerCancels.delete(picker.tab.shell.id);
    }
    for (const [token, { frame }] of picker.frames) {
      this.pendingElementPickerFrames.delete(token);
      try {
        if (!frame.detached && !frame.isDestroyed()) frame.send('browser-page:element-picker-disarm', { token });
      } catch {
        // The frame may have disappeared between validation and cleanup.
      }
    }
    picker.frames.clear();
    if ('error' in result) picker.reject(result.error);
    else picker.resolve(result.selector);
  }

  private handleElementPickerClick = (
    event: IpcMainEvent,
    payload?: { token?: unknown; x?: unknown; y?: unknown },
  ): void => {
    const binding = this.elementPickerFrameForEvent(event, payload?.token);
    if (!binding) return;
    const { picker, frame, isMainFrame } = binding;
    if (picker.clickedToken !== null) return;
    if (!isMainFrame) {
      this.finishElementPicker(picker, {
        error: new Error('Elements inside embedded frames cannot currently be selected.'),
      });
      return;
    }
    if (typeof payload?.x !== 'number' || typeof payload.y !== 'number') return;
    const x = payload.x;
    const y = payload.y;
    let bounds: BrowserBounds;
    let zoomFactor: number;
    try {
      bounds = picker.tab.view?.getBounds() ?? DEFAULT_DETACHED_VIEW_BOUNDS;
      zoomFactor = picker.contents.getZoomFactor();
    } catch {
      picker.cancel(new Error('Element picking cancelled because the page changed.'));
      return;
    }
    if (
      !Number.isFinite(x) ||
      !Number.isFinite(y) ||
      !Number.isFinite(zoomFactor) ||
      zoomFactor <= 0 ||
      x < 0 ||
      y < 0 ||
      x > bounds.width / zoomFactor + 2 ||
      y > bounds.height / zoomFactor + 2
    ) {
      picker.cancel(new Error('Element picking received an invalid click location.'));
      return;
    }
    picker.clickedToken = payload.token as string;
    try {
      frame.send('browser-page:element-picker-select-at', { token: payload.token });
    } catch {
      picker.cancel(new Error('Element picking cancelled because the page changed.'));
    }
  };

  private handleElementPickerResult = (
    event: IpcMainEvent,
    payload?: { token?: unknown; selector?: unknown; error?: unknown },
  ): void => {
    const binding = this.elementPickerFrameForEvent(event, payload?.token);
    if (!binding || binding.picker.clickedToken !== payload?.token) return;
    if (payload?.error === 'not-unique') {
      this.finishElementPicker(binding.picker, {
        error: new Error('The selected element could not be identified uniquely.'),
      });
      return;
    }
    try {
      this.finishElementPicker(binding.picker, { selector: validatePickedElementSelector(payload?.selector) });
    } catch (error) {
      this.finishElementPicker(binding.picker, {
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  };

  private handleElementPickerCancel = (event: IpcMainEvent, payload?: { token?: unknown; reason?: unknown }): void => {
    const binding = this.elementPickerFrameForEvent(event, payload?.token);
    if (!binding) return;
    const reason =
      payload?.reason === 'timeout'
        ? 'Element picking timed out.'
        : payload?.reason === 'navigation'
          ? 'Element picking cancelled because the page navigated.'
          : 'Element picking cancelled.';
    this.finishElementPicker(binding.picker, { error: new Error(reason) });
  };

  private acknowledgeAutomationInputArm(event: IpcMainEvent, payload?: { token?: unknown }): void {
    if (typeof payload?.token !== 'string' || payload.token.length === 0 || payload.token.length > 128) return;
    const pending = this.pendingAutomationArmAcknowledgements.get(payload.token);
    if (!pending || event.sender.id !== pending.contentsId) return;
    const tab = this.tabs.get(pending.tabId);
    const frame = event.senderFrame;
    if (!tab || tab.view?.webContents !== event.sender || !frame || frame.detached || frame.isDestroyed()) return;
    const expectedIdentity = pending.expectedFrames.get(frame.frameTreeNodeId);
    if (!expectedIdentity || expectedIdentity !== this.automationFrameIdentity(frame)) return;
    pending.acknowledgedFrames.add(frame.frameTreeNodeId);
    if (pending.acknowledgedFrames.size === pending.expectedFrames.size) pending.settle();
  }

  private handleAutomationInputArmed = (event: IpcMainEvent, payload?: { token?: unknown }): void => {
    this.acknowledgeAutomationInputArm(event, payload);
  };

  private handlePageGesture = (
    event: IpcMainEvent,
    payload?: { token?: unknown; kind?: unknown; data?: unknown; key?: unknown },
  ): void => {
    const tabId = this.webContentsToTab.get(event.sender.id);
    const tab = tabId ? this.tabs.get(tabId) : undefined;
    if (!tab) {
      event.returnValue = false;
      return;
    }
    const at = Date.now();
    const kind =
      typeof payload?.kind === 'string' &&
      ['pointerdown', 'keydown', 'wheel', 'input', 'touchstart'].includes(payload.kind)
        ? (payload.kind as 'pointerdown' | 'keydown' | 'wheel' | 'input' | 'touchstart')
        : undefined;
    if (typeof payload?.token === 'string') {
      const pending = this.automationGestureTokens.get(payload.token);
      if (!pending) {
        this.publishAutomationGestureDisarm(event.sender, payload.token);
        event.returnValue = false;
        return;
      }
      if (
        pending.confirmed ||
        pending.dispatchStarted === false ||
        pending.expiresAt < at ||
        pending.tabId !== tab.shell.id ||
        pending.contentsId !== event.sender.id ||
        pending.assistantOwnerId !== tab.aiControlOwnerId
      ) {
        if (pending.expiresAt < at) this.revokeAutomationGestureToken(payload.token);
        else if (pending.dispatchStarted) this.publishAutomationGestureDisarm(event.sender, payload.token);
        event.returnValue = false;
        return;
      }
      if (
        pending.inputData !== undefined &&
        (pending.kind === 'keydown'
          ? typeof payload.key !== 'string' ||
            payload.key.length > MAX_BROWSER_TYPED_VALUE_CHARS ||
            payload.key !== pending.inputData
          : typeof payload.data !== 'string' ||
            payload.data.length > MAX_BROWSER_TYPED_VALUE_CHARS ||
            payload.data !== pending.inputData)
      ) {
        event.returnValue = false;
        return;
      }
      if (pending.armedFrames) {
        const frame = event.senderFrame;
        const expectedIdentity = frame ? pending.armedFrames.get(frame.frameTreeNodeId) : undefined;
        if (
          !frame ||
          frame.detached ||
          frame.isDestroyed() ||
          !expectedIdentity ||
          expectedIdentity !== this.automationFrameIdentity(frame)
        ) {
          // Keep the main token until the dispatching operation observes the
          // missing confirmation. The preload immediately re-reports the event
          // without a token; retaining this background marker makes that second
          // report fail closed instead of manufacturing real-user provenance.
          event.returnValue = false;
          return;
        }
      }
      pending.confirmed = true;
      pending.settleConfirmation?.(true);
      // The exact preload acknowledgement is authoritative even if the CDP
      // command promise is slow to settle. Cancel the destructive attribution
      // deadline now; otherwise its timer could reclaim a healthy hidden page
      // after Chromium already delivered and attributed the input correctly.
      this.confirmDispatchedSyntheticInput(event.sender.id, payload.token);
      // Every frame receives a copy because Chromium chooses the eventual input
      // target. Once the exact target confirms, revoke sibling copies before a
      // later real gesture can mistake one for a current automation arm.
      this.publishAutomationGestureDisarm(event.sender, payload.token);
      this.rememberAssistantGesture(
        tab,
        pending.assistantOwnerId,
        at + POPUP_GESTURE_PROVENANCE_MS,
        kind,
        event.senderFrame?.frameTreeNodeId,
      );
    } else {
      const dispatchedSyntheticInput = this.dispatchedSyntheticInputs.get(event.sender.id);
      if (
        dispatchedSyntheticInput?.tabId === tab.shell.id &&
        (kind === undefined || dispatchedSyntheticInput.kind === kind)
      ) {
        // A foreground sendInputEvent can reach the trusted DOM listener after
        // its one-shot page token expires or after cancellation has begun.
        // Preserve the tombstone until confirmation or WebContents teardown so
        // that delayed automation can never manufacture user popup provenance.
        event.returnValue = false;
        return;
      }
      const unattributedBackgroundDispatch = [...this.automationGestureTokens.values()].some(
        (pending) =>
          pending.tabId === tab.shell.id &&
          pending.contentsId === event.sender.id &&
          pending.detachedArm === true &&
          !pending.confirmed &&
          pending.expiresAt >= at &&
          (kind === undefined || pending.kind === kind),
      );
      if (unattributedBackgroundDispatch) {
        // A detached page cannot receive genuine user input. This is an armed
        // CDP event that landed in an unacknowledged replacement frame (or failed
        // exact-data validation), so never upgrade it to user provenance.
        event.returnValue = false;
        return;
      }
      if (!this.isTargetViewInteractive(tab, event.sender)) {
        // A detached, hidden, blurred, or background-throttled page cannot be
        // the target of genuine user input. An expired automation token may be
        // omitted by the preload's follow-up report, so surface interactivity
        // is the final provenance boundary rather than absence of a live token.
        event.returnValue = false;
        return;
      }
      // Exact automation events carry their one-shot token. Any other trusted
      // pointer/key/wheel/touch gesture is real user input, including input
      // concurrent with an active assistant operation. (The page preload
      // suppresses unmatched derived `input` events so checkbox/radio follow-up
      // does not overwrite the initiating assistant provenance.)
      tab.trustedGestureGeneration = (tab.trustedGestureGeneration ?? 0) + 1;
      tab.popupGesture = {
        source: 'user',
        assistantOwnerId: null,
        expiresAt: at + POPUP_GESTURE_PROVENANCE_MS,
        frameTreeNodeId: event.senderFrame?.frameTreeNodeId,
        kind,
      };
    }
    tab.lastUsedAt = at;
    event.returnValue = true;
  };

  private handleLoginSubmitted = (
    event: IpcMainEvent,
    payload: { origin?: unknown; username?: unknown; password?: unknown },
  ): void => {
    const tabId = this.webContentsToTab.get(event.sender.id);
    const tab = tabId ? this.tabs.get(tabId) : undefined;
    if (!tab || this.scopeUnavailable(tab.scopeKey) || !this.config().offerToSavePasswords) return;
    const frame = event.senderFrame;
    const activation = tab.popupGesture;
    const submittedAt = Date.now();
    if (
      !frame ||
      frame.detached ||
      frame.isDestroyed() ||
      !activation ||
      activation.source !== 'user' ||
      activation.expiresAt < submittedAt ||
      activation.frameTreeNodeId !== frame.frameTreeNodeId ||
      !activation.kind ||
      !['pointerdown', 'keydown', 'input', 'touchstart'].includes(activation.kind)
    ) {
      return;
    }
    if (
      typeof payload?.origin !== 'string' ||
      typeof payload.username !== 'string' ||
      typeof payload.password !== 'string' ||
      !payload.password ||
      payload.origin.length > MAX_CREDENTIAL_ORIGIN_LENGTH ||
      payload.username.length > MAX_CREDENTIAL_USERNAME_LENGTH ||
      payload.password.length > MAX_CREDENTIAL_PASSWORD_LENGTH
    ) {
      return;
    }
    let origin: string;
    try {
      const frameOrigin = new URL(frame.origin);
      const reportedOrigin = new URL(payload.origin);
      if (!['http:', 'https:'].includes(frameOrigin.protocol) || reportedOrigin.origin !== frameOrigin.origin) return;
      origin = frameOrigin.origin;
    } catch {
      return;
    }
    if (origin.length > MAX_CREDENTIAL_ORIGIN_LENGTH) return;
    // Consume the exact recent frame-local user activation. A page cannot
    // repeatedly replace the prompt without another real user gesture.
    tab.popupGesture = null;
    // A failed login can be submitted again before the first save prompt is
    // answered. Keep only the newest username/password for this tab and origin;
    // dropping the old entry also wipes its plaintext immediately and tells the
    // renderer to remove the stale prompt before publishing the replacement.
    for (const [pendingId, pending] of this.pendingCredentials) {
      if (pending.tabId === tab.shell.id && pending.origin === origin) this.dropPendingCredential(pendingId);
    }
    if (!this.canQueuePrompt(tab.shell.id)) return;
    const id = randomUUID();
    const timer = setTimeout(() => this.dropPendingCredential(id), PROMPT_TIMEOUT_MS);
    timer.unref?.();
    const update = this.vaultForScope(tab.scopeKey).has(origin, payload.username);
    this.pendingCredentials.set(id, {
      tabId: tab.shell.id,
      conversationId: tab.shell.conversationId,
      origin,
      username: payload.username,
      password: payload.password,
      update,
      scopeKey: tab.scopeKey,
      timer,
    });
    this.emit({
      type: 'credential-prompt',
      conversationId: tab.shell.conversationId,
      prompt: {
        id,
        tabId: tab.shell.id,
        origin,
        username: payload.username,
        update,
      },
    });
  };

  private handleLogin = (
    event: Electron.Event,
    contents: WebContents,
    details: Electron.AuthenticationResponseDetails,
    authInfo: Electron.AuthInfo,
    callback: (username?: string, password?: string) => void,
  ): void => {
    const tabId = this.webContentsToTab.get(contents.id);
    const tab = tabId ? this.tabs.get(tabId) : undefined;
    if (this.validatingProxy?.isAuthenticationChallenge(authInfo)) {
      event.preventDefault();
      const trustedUserNavigationAuth = tab ? this.trustedUserNavigationAuthRequest(tab, details.url) : false;
      // Proxy credentials are one-shot connection capabilities. A restricted
      // credential marks the exact request, while BrowserValidatingProxy also
      // elevates every same-host connection for the restriction's lifetime so
      // an older unrestricted credential cannot reuse a tunnel around it.
      const restrictPrivateNetwork =
        this.aiAllowPrivateNetwork === false && (!tab || (tab.aiNetworkRestricted && !trustedUserNavigationAuth));
      const credentials = this.validatingProxy.credentials(restrictPrivateNetwork);
      callback(credentials.username, credentials.password);
      return;
    }
    const upstreamProxyAuthentication = this.validatingProxy?.isUpstreamAuthenticationChallenge(authInfo) === true;
    if (!tab) return;
    event.preventDefault();
    const trustedUserNavigationAuth = this.trustedUserNavigationAuthRequest(tab, details.url);
    if (tab.aiNetworkRestricted && !trustedUserNavigationAuth && !upstreamProxyAuthentication) {
      // HTTP-auth callbacks block navigation itself. Assistant-controlled loads
      // must terminate without waiting for Browser chrome to mount; the user can
      // authenticate only when this challenge belongs to the exact main-frame
      // target (or redirect) claimed by an explicit user navigation. Relayed
      // enterprise-proxy challenges are different: the local validating proxy
      // has already bound them to this request/connection, and the bounded
      // prompt can remain pending while the Browser sidebar is hidden.
      callback();
      return;
    }
    const endpoint = browserAuthEndpoint(details, authInfo);
    const duplicate = [...this.pendingAuth.values()].some(
      (pending) =>
        pending.tabId === tab.shell.id &&
        pending.prompt.endpoint === endpoint &&
        pending.prompt.authScheme === authInfo.scheme &&
        pending.prompt.realm === authInfo.realm &&
        pending.prompt.isProxy === authInfo.isProxy,
    );
    if (duplicate || !this.canQueuePrompt(tab.shell.id)) {
      callback();
      return;
    }
    const id = randomUUID();
    const prompt: BrowserAuthPrompt = {
      id,
      tabId: tab.shell.id,
      host: authInfo.host,
      endpoint,
      authScheme: authInfo.scheme,
      realm: authInfo.realm,
      isProxy: authInfo.isProxy,
      assistantTriggered: tab.aiNetworkRestricted && !trustedUserNavigationAuth,
    };
    const timer = setTimeout(() => {
      this.finishPendingAuth(id);
    }, PROMPT_TIMEOUT_MS);
    timer.unref?.();
    this.pendingAuth.set(id, {
      tabId: tab.shell.id,
      conversationId: tab.shell.conversationId,
      scopeKey: tab.scopeKey,
      tabGeneration: tab.generation,
      ...(trustedUserNavigationAuth
        ? {
            trustedUserNavigationLease: tab.trustedUserNavigationLease,
            trustedUserNavigationRequestId: trustedUserNavigationAuth.requestId,
            trustedUserNavigationUrl: trustedUserNavigationAuth.url,
          }
        : {}),
      prompt,
      callback,
      timer,
    });
    this.emit({
      type: 'auth-prompt',
      conversationId: tab.shell.conversationId,
      prompt,
    });
  };

  /** Electron's app-level login event exposes a WebContents and URL but not the
   * network request id. Admit the ordinary user-auth prompt only when the exact
   * request claimed by Browser chrome is still the sole active request for that
   * URL and is still a main-frame navigation. A delayed fetch from the previous
   * document to the same URL therefore cannot inherit the user's credentials. */
  private trustedUserNavigationAuthRequest(
    tab: InternalTab,
    challengedUrl: string,
  ): { requestId: number; url: string } | null {
    const requestId = tab.trustedUserNavigationRequestId;
    if (
      requestId === null ||
      !isTrustedUserNavigationTarget(tab.trustedUserNavigation, tab.trustedUserNavigationTarget, challengedUrl) ||
      tab.activeNetworkRequests?.get(requestId) !== 'mainFrame'
    ) {
      return null;
    }
    const activeUrl = tab.activeNetworkRequestUrls?.get(requestId);
    const comparableChallenge = comparablePopupReferrerUrl(challengedUrl);
    if (!activeUrl || !comparableChallenge || comparablePopupReferrerUrl(activeUrl) !== comparableChallenge) {
      return null;
    }
    for (const [candidateId, candidateUrl] of tab.activeNetworkRequestUrls ?? []) {
      if (candidateId !== requestId && comparablePopupReferrerUrl(candidateUrl) === comparableChallenge) return null;
    }
    return { requestId, url: activeUrl };
  }

  private handleSelectClientCertificate = (
    event: Electron.Event,
    contents: WebContents,
    _url: string,
    _certificateList: Electron.Certificate[],
    callback: (certificate?: Electron.Certificate) => void,
  ): void => {
    const managedTab = this.webContentsToTab.has(contents.id);
    const managedSession = this.wiredSessions.has(contents.session);
    if (!managedTab && !managedSession) return;
    // Electron otherwise chooses the first matching certificate silently,
    // disclosing an OS/enterprise identity and proof of key possession to a
    // remote site. Session ownership also covers service-worker/background
    // requests and the short interval after a renderer mapping is torn down.
    event.preventDefault();
    callback();
  };

  private emitPendingPrompts(conversationId: string): void {
    for (const [id, pending] of this.pendingCredentials) {
      if (pending.conversationId !== conversationId) continue;
      this.emit({
        type: 'credential-prompt',
        conversationId,
        prompt: {
          id,
          tabId: pending.tabId,
          origin: pending.origin,
          username: pending.username,
          update: this.vaultForScope(pending.scopeKey).has(pending.origin, pending.username),
        },
      });
    }
    for (const [id, pending] of this.pendingPermissions) {
      if (pending.conversationId !== conversationId) continue;
      this.emit({
        type: 'permission-prompt',
        conversationId,
        prompt: {
          id,
          tabId: pending.tabId,
          origin: pending.origin,
          permission: pending.permission,
          ...(pending.target ? { target: pending.target } : {}),
          canPersist: pending.canPersist && !pending.assistantTriggered,
          assistantTriggered: pending.assistantTriggered,
        },
      });
    }
    for (const pending of this.pendingAuth.values()) {
      if (pending.conversationId === conversationId) {
        this.emit({
          type: 'auth-prompt',
          conversationId,
          prompt: pending.prompt,
        });
      }
    }
  }

  private async setAutomationOverlay(
    tab: InternalTab,
    action: BrowserActionEvent | null,
    abortSignal?: AbortSignal,
    documentLease?: AssistantDocumentLease,
  ): Promise<void> {
    if (tab.overlayTimer) {
      clearTimeout(tab.overlayTimer);
      tab.overlayTimer = null;
    }
    const overlayGeneration = ++tab.overlayGeneration;
    const contents = tab.view?.webContents;
    const previousOverlay = tab.automationOverlay;
    tab.automationOverlay = null;
    try {
      if (previousOverlay) {
        try {
          if (
            !previousOverlay.contents.isDestroyed() &&
            previousOverlay.contents.debugger.isAttached() &&
            tab.view?.webContents === previousOverlay.contents
          ) {
            await this.runRendererOperationWithDeadline(
              tab,
              previousOverlay.contents,
              'Browser automation overlay',
              AUTOMATION_OVERLAY_TIMEOUT_MS,
              () => previousOverlay.contents.debugger.sendCommand('Overlay.hideHighlight'),
              abortSignal,
              documentLease,
              false,
            );
          }
        } finally {
          previousOverlay.releaseDebugger();
        }
      }
      if (!contents || contents.isDestroyed()) return;
      const renderCursor =
        !!action &&
        this.attachedView === tab.view &&
        this.isHostWindowShown() &&
        Number.isFinite(action.x) &&
        Number.isFinite(action.y);
      if (renderCursor) {
        const debuggerLease = this.acquireBrowserDebuggerLease(contents);
        const overlay: BrowserAutomationOverlay = {
          contents,
          cancelDebugger: debuggerLease.cancel,
          releaseDebugger: debuggerLease.release,
          x: action.x!,
          y: action.y!,
        };
        let retained = false;
        try {
          await this.runRendererOperationWithDeadline(
            tab,
            contents,
            'Browser automation overlay',
            AUTOMATION_OVERLAY_TIMEOUT_MS,
            async () => {
              await contents.debugger.sendCommand('DOM.enable');
              await contents.debugger.sendCommand('Overlay.enable');
              await this.showAutomationCursor(overlay);
            },
            abortSignal,
            documentLease,
            false,
          );
          if (
            tab.overlayGeneration !== overlayGeneration ||
            this.tabs.get(tab.shell.id) !== tab ||
            tab.view?.webContents !== contents
          ) {
            if (!contents.isDestroyed() && contents.debugger.isAttached()) {
              try {
                await this.runRendererOperationWithDeadline(
                  tab,
                  contents,
                  'Browser automation overlay cleanup',
                  AUTOMATION_OVERLAY_TIMEOUT_MS,
                  () => contents.debugger.sendCommand('Overlay.hideHighlight'),
                  undefined,
                  undefined,
                  false,
                );
              } catch {
                // Detach only the exact manager-owned overlay lease. The stale
                // cleanup is presentation-only and must not withhold an action
                // result or reclaim an otherwise healthy authenticated page.
                overlay.cancelDebugger();
              }
            }
            return;
          }
          tab.automationOverlay = overlay;
          retained = true;
        } finally {
          if (!retained) overlay.releaseDebugger();
        }
      }
    } catch {
      // The compositor cursor is presentation only. A stalled or unavailable
      // DevTools overlay must never fail automation or reclaim its healthy page;
      // the Browser toolbar still carries the live action status.
    }
    if (action && action.status !== 'running' && this.tabs.get(tab.shell.id) === tab) {
      tab.overlayTimer = setTimeout(() => {
        if (tab.overlayGeneration !== overlayGeneration || this.tabs.get(tab.shell.id) !== tab) return;
        tab.overlayTimer = null;
        void this.setAutomationOverlay(tab, null);
      }, AUTOMATION_OVERLAY_CLEAR_MS);
      tab.overlayTimer.unref?.();
    }
  }

  private showAutomationCursor(overlay: BrowserAutomationOverlay): Promise<unknown> {
    return overlay.contents.debugger.sendCommand('Overlay.highlightRect', {
      x: Math.round(overlay.x - 9),
      y: Math.round(overlay.y - 9),
      width: 18,
      height: 18,
      color: { r: 139, g: 92, b: 246, a: 0.18 },
      outlineColor: { r: 139, g: 92, b: 246, a: 1 },
    });
  }

  private serializeVisibleAssistantOperation<T>(
    conversationId: string,
    tab: InternalTab,
    assistantRun: BrowserAssistantRun,
    operation: () => Promise<T>,
  ): Promise<T> {
    return Promise.resolve().then(() => {
      throwIfBrowserAborted(assistantRun.abortSignal);
      this.assertHostRendererOperationCurrent();
      this.assertScopeAvailable(tab.scopeKey);
      if (
        this.removedConversations.has(conversationId) ||
        tab.shell.conversationId !== conversationId ||
        this.tabs.get(tab.shell.id) !== tab
      ) {
        throw new Error('The browser tab closed while this assistant operation was waiting.');
      }
      return operation();
    });
  }

  private withVisibleAssistantOperation<T>(
    conversationId: string,
    tab: InternalTab,
    assistantRun: BrowserAssistantRun,
    kind: Extract<BrowserActionEvent['kind'], 'inspect' | 'network' | 'evaluate' | 'screenshot' | 'autofill'>,
    summary: string,
    operation: (reveal: (contents: WebContents, documentLease: AssistantDocumentLease) => Promise<void>) => Promise<T>,
  ): Promise<T> {
    return this.serializeVisibleAssistantOperation(conversationId, tab, assistantRun, () =>
      this.performVisibleAssistantOperation(conversationId, tab, assistantRun, kind, summary, operation),
    );
  }

  private async performVisibleAssistantOperation<T>(
    conversationId: string,
    tab: InternalTab,
    assistantRun: BrowserAssistantRun,
    kind: Extract<BrowserActionEvent['kind'], 'inspect' | 'network' | 'evaluate' | 'screenshot' | 'autofill'>,
    summary: string,
    operation: (reveal: (contents: WebContents, documentLease: AssistantDocumentLease) => Promise<void>) => Promise<T>,
  ): Promise<T> {
    const abortSignal = assistantRun.abortSignal;
    throwIfBrowserAborted(abortSignal);
    const action: BrowserActionEvent = {
      id: randomUUID(),
      tabId: tab.shell.id,
      kind,
      status: 'running',
      startedAt: now(),
      summary,
    };
    this.runningActions.set(action.id, { conversationId, action });
    tab.lastUsedAt = Date.now();
    this.emitTabs(conversationId);
    this.emit({ type: 'action', conversationId, action: { ...action } });

    const reveal = async (contents: WebContents, documentLease: AssistantDocumentLease): Promise<void> => {
      throwIfBrowserAborted(abortSignal);
      this.assertAssistantDocumentLease(tab, documentLease);
      if (tab.view?.webContents !== contents || contents.isDestroyed()) {
        throw new Error('The browser page changed before the assistant operation was ready.');
      }
      const presented = await this.prepareAssistantOperationView(tab, tab.view, abortSignal, documentLease);
      this.assertAssistantDocumentLease(tab, documentLease);
      if (presented) await this.setAutomationOverlay(tab, action, abortSignal, documentLease);
    };

    try {
      const result = await operation(reveal);
      action.status = 'completed';
      action.completedAt = now();
      this.runningActions.delete(action.id);
      this.emit({ type: 'action', conversationId, action: { ...action } });
      await this.setAutomationOverlay(tab, action);
      return result;
    } catch (error) {
      action.status = 'failed';
      action.completedAt = now();
      action.error = redactBrowserErrorForExposure(error);
      this.runningActions.delete(action.id);
      this.emit({ type: 'action', conversationId, action: { ...action } });
      await this.setAutomationOverlay(tab, action);
      throw error;
    }
  }

  private async locate(
    tab: InternalTab,
    contents: WebContents,
    request: BrowserActionRequest,
    abortSignal?: AbortSignal,
    documentLease?: AssistantDocumentLease,
  ): Promise<BrowserLocatedTarget> {
    return this.runRendererOperationWithDeadline(
      tab,
      contents,
      'Browser target location',
      TARGET_LOCATION_TIMEOUT_MS,
      async () => {
        if ((request.x === undefined) !== (request.y === undefined)) {
          throw new Error('Coordinate targets require both x and y.');
        }
        if (request.x !== undefined && request.y !== undefined) {
          if (!Number.isFinite(request.x) || !Number.isFinite(request.y)) {
            throw new Error('Target coordinates must be finite.');
          }
          const viewport = (await this.evaluateWithDeadline(
            tab,
            contents,
            `({ width: innerWidth, height: innerHeight })`,
            abortSignal,
            documentLease,
          )) as {
            width: number;
            height: number;
          };
          if (request.x < 0 || request.y < 0 || request.x >= viewport.width || request.y >= viewport.height) {
            throw new Error('Target coordinates are outside the page viewport.');
          }
          return { x: request.x, y: request.y, width: 1, height: 1 };
        }
        const selector = request.selector ?? null;
        const role = request.role ?? null;
        const name = request.name ?? null;
        const text = request.kind === 'type' ? null : (request.text ?? null);
        const globalKey = `__kai_browser_target_${randomUUID().replaceAll('-', '')}`;
        const releaseDebugger = this.acquireBrowserDebugger(contents);
        let retained = false;
        try {
          const frameTree = (await contents.debugger.sendCommand('Page.getFrameTree')) as {
            frameTree?: { frame?: { id?: string } };
          };
          const frameId = frameTree.frameTree?.frame?.id;
          if (!frameId) throw new Error('The browser page has no main execution frame.');
          const isolatedWorld = (await contents.debugger.sendCommand('Page.createIsolatedWorld', {
            frameId,
            worldName: `__kai_browser_target_world_${randomUUID().replaceAll('-', '')}`,
            grantUniveralAccess: false,
          })) as { executionContextId?: number };
          if (!Number.isInteger(isolatedWorld.executionContextId)) {
            throw new Error('The browser page has no isolated target context.');
          }
          const response = (await contents.debugger.sendCommand('Runtime.evaluate', {
            expression: `(() => {
      const selector = ${JSON.stringify(selector)};
      const role = ${JSON.stringify(role)};
      const name = ${JSON.stringify(name)};
      const text = ${JSON.stringify(text)};
      const globalKey = ${JSON.stringify(globalKey)};
      ${browserSemanticHelpersExpression()}
      const visible = (el) => {
        const r=el.getBoundingClientRect(), targetStyle=getComputedStyle(el);
        if (r.width<=0 || r.height<=0 || targetStyle.pointerEvents==='none') return false;
        for (let current=el; current && current.nodeType===1; current=current.parentElement) {
          const style=getComputedStyle(current), opacity=Number(style.opacity||1);
          if (
            current.hidden || current.inert || current.getAttribute('aria-hidden')==='true' ||
            style.visibility==='hidden' || style.visibility==='collapse' || style.display==='none' ||
            style.contentVisibility==='hidden' || !Number.isFinite(opacity) || opacity<=0
          ) return false;
        }
        return true;
      };
      let matches = [];
      if (selector) { try { matches = Array.from(document.querySelectorAll(selector)); } catch { throw new Error('Invalid CSS selector'); } }
      else {
        matches = Array.from(document.querySelectorAll('a,button,input,select,textarea,[role],[tabindex]'));
        if (role) matches = matches.filter(el => roleFor(el) === normalizeSemanticText(role).toLowerCase());
        if (name) matches = matches.filter(el => accessibleNameFor(el).toLowerCase().includes(normalizeSemanticText(name).toLowerCase()));
        if (text) matches = matches.filter(el => ((el.innerText || el.textContent || '')).trim().toLowerCase().includes(text.toLowerCase()));
      }
      const visibleMatches = matches.filter(visible);
      if (visibleMatches.length > 1) {
        delete globalThis[globalKey];
        throw new Error('Target matched multiple visible elements; provide a more specific selector, role, name, or text.');
      }
      const el = visibleMatches[0];
      if (!el) { delete globalThis[globalKey]; return null; }
      el.scrollIntoView({ block:'center', inline:'center', behavior:'instant' });
      const r = el.getBoundingClientRect();
      const left=Math.max(0,r.left), top=Math.max(0,r.top), right=Math.min(innerWidth,r.right), bottom=Math.min(innerHeight,r.bottom);
      if (right<=left || bottom<=top) { delete globalThis[globalKey]; return null; }
      const x=(left+right)/2, y=(top+bottom)/2;
      const hit=document.elementFromPoint(x,y);
      if (!hit || !(hit===el || el.contains(hit) || hit.contains(el))) { delete globalThis[globalKey]; return null; }
      globalThis[globalKey]=el;
      return { x, y, width:r.width, height:r.height };
    })()`,
            awaitPromise: true,
            returnByValue: true,
            userGesture: false,
            contextId: isolatedWorld.executionContextId,
          })) as {
            result?: { value?: BrowserLocatedTarget; description?: string };
            exceptionDetails?: { text?: string; exception?: { description?: string } };
          };
          if (response.exceptionDetails) {
            throw new Error(
              response.exceptionDetails.exception?.description ??
                response.exceptionDetails.text ??
                'Browser target location failed.',
            );
          }
          const result = response.result?.value;
          if (
            !result ||
            !Number.isFinite(result.x) ||
            !Number.isFinite(result.y) ||
            !Number.isFinite(result.width) ||
            !Number.isFinite(result.height)
          ) {
            throw new Error('No visible, unobscured element matched the requested target.');
          }
          retained = true;
          return {
            ...result,
            semanticLease: {
              contextId: isolatedWorld.executionContextId!,
              globalKey,
              releaseDebugger,
            },
          };
        } finally {
          if (!retained) releaseDebugger();
        }
      },
      abortSignal,
      documentLease,
    );
  }

  /** DOM hit-testing intentionally skips pointer-events:none elements. CDP can
   * repeat the same hit test while ignoring that CSS rule; a different top
   * node means pixels are visibly covered even though Chromium would dispatch
   * input through the overlay. */
  private async assertNoClickThroughOverlayAtPoints(
    contents: WebContents,
    points: ReadonlyArray<{ x: number; y: number }>,
  ): Promise<void> {
    if (points.length > MAX_BROWSER_INSPECTION_OCCLUSION_POINTS) {
      throw new Error('Browser occlusion validation exceeded its safe point limit.');
    }
    const releaseDebugger = this.acquireBrowserDebugger(contents);
    try {
      for (const point of points) {
        if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || point.x < 0 || point.y < 0) {
          throw new Error('Browser occlusion validation received an invalid viewport point.');
        }
        const location = { x: Math.round(point.x), y: Math.round(point.y), includeUserAgentShadowDOM: true };
        const [normal, includingClickThrough] = (await Promise.all([
          contents.debugger.sendCommand('DOM.getNodeForLocation', location),
          contents.debugger.sendCommand('DOM.getNodeForLocation', {
            ...location,
            ignorePointerEventsNone: true,
          }),
        ])) as Array<{ backendNodeId?: number; frameId?: string }>;
        if (!Number.isInteger(normal.backendNodeId) || !Number.isInteger(includingClickThrough.backendNodeId)) {
          throw new Error('Browser occlusion validation could not resolve the visible page node.');
        }
        let relatedClickThroughDescendant = false;
        if (
          normal.backendNodeId !== includingClickThrough.backendNodeId &&
          normal.frameId &&
          normal.frameId === includingClickThrough.frameId
        ) {
          // Icons and labels inside a control commonly use
          // pointer-events:none. They do not visually conceal their own
          // ancestor target, so compare the two nodes in a pristine isolated
          // world before treating a different hit as an overlay.
          const objectGroup = `kai-occlusion-${randomUUID()}`;
          try {
            const world = (await contents.debugger.sendCommand('Page.createIsolatedWorld', {
              frameId: normal.frameId,
              worldName: `__kai_browser_occlusion_${randomUUID().replaceAll('-', '')}`,
              grantUniveralAccess: false,
            })) as { executionContextId?: number };
            if (Number.isInteger(world.executionContextId)) {
              const [normalNode, clickThroughNode] = (await Promise.all([
                contents.debugger.sendCommand('DOM.resolveNode', {
                  backendNodeId: normal.backendNodeId,
                  executionContextId: world.executionContextId,
                  objectGroup,
                }),
                contents.debugger.sendCommand('DOM.resolveNode', {
                  backendNodeId: includingClickThrough.backendNodeId,
                  executionContextId: world.executionContextId,
                  objectGroup,
                }),
              ])) as Array<{ object?: { objectId?: string } }>;
              const normalObjectId = normalNode?.object?.objectId;
              const clickThroughObjectId = clickThroughNode?.object?.objectId;
              if (normalObjectId && clickThroughObjectId) {
                const relation = (await contents.debugger.sendCommand('Runtime.callFunctionOn', {
                  objectId: normalObjectId,
                  functionDeclaration:
                    'function(other){try{return this===other||Node.prototype.contains.call(this,other)||Node.prototype.contains.call(other,this);}catch{return false;}}',
                  arguments: [{ objectId: clickThroughObjectId }],
                  returnByValue: true,
                  silent: true,
                })) as { result?: { value?: unknown }; exceptionDetails?: unknown };
                relatedClickThroughDescendant = !relation.exceptionDetails && relation.result?.value === true;
              }
            }
          } finally {
            await contents.debugger.sendCommand('Runtime.releaseObjectGroup', { objectGroup }).catch(() => undefined);
          }
        }
        if (
          (normal.backendNodeId !== includingClickThrough.backendNodeId ||
            normal.frameId !== includingClickThrough.frameId) &&
          !relatedClickThroughDescendant
        ) {
          throw new Error(
            'The browser target is covered by a visible click-through overlay. Remove the overlay or choose another target.',
          );
        }
      }
    } finally {
      releaseDebugger();
    }
  }

  private async validateLocatedTarget(
    tab: InternalTab,
    contents: WebContents,
    target: BrowserLocatedTarget,
    options: { focus?: boolean; requireFocused?: boolean } = {},
    abortSignal?: AbortSignal,
    documentLease?: AssistantDocumentLease,
  ): Promise<BrowserLocatedTarget> {
    const lease = target.semanticLease;
    if (!lease) {
      await this.runRendererOperationWithDeadline(
        tab,
        contents,
        'Browser target occlusion validation',
        TARGET_LOCATION_TIMEOUT_MS,
        () => this.assertNoClickThroughOverlayAtPoints(contents, [target]),
        abortSignal,
        documentLease,
      );
      return target;
    }
    const result = await this.runRendererOperationWithDeadline(
      tab,
      contents,
      'Browser target validation',
      TARGET_LOCATION_TIMEOUT_MS,
      async () => {
        if (!contents.debugger.isAttached()) throw new Error('The browser target context is no longer available.');
        const response = (await contents.debugger.sendCommand('Runtime.evaluate', {
          expression: `(() => {
            const target=globalThis[${JSON.stringify(lease.globalKey)}];
            if (!target || !target.isConnected) return null;
            const visible=(el)=>{
              const r=el.getBoundingClientRect(), targetStyle=getComputedStyle(el);
              if (r.width<=0 || r.height<=0 || targetStyle.pointerEvents==='none') return false;
              for (let current=el; current && current.nodeType===1; current=current.parentElement) {
                const style=getComputedStyle(current), opacity=Number(style.opacity||1);
                if (
                  current.hidden || current.inert || current.getAttribute('aria-hidden')==='true' ||
                  style.visibility==='hidden' || style.visibility==='collapse' || style.display==='none' ||
                  style.contentVisibility==='hidden' || !Number.isFinite(opacity) || opacity<=0
                ) return false;
              }
              return true;
            };
            if (!visible(target)) return null;
            const r=target.getBoundingClientRect();
            const left=Math.max(0,r.left), top=Math.max(0,r.top), right=Math.min(innerWidth,r.right), bottom=Math.min(innerHeight,r.bottom);
            if (right<=left || bottom<=top) return null;
            const x=(left+right)/2, y=(top+bottom)/2, hit=document.elementFromPoint(x,y);
            if (!hit || !(hit===target || target.contains(hit) || hit.contains(target))) return null;
            const focusable='input:not([disabled]),textarea:not([disabled]),select:not([disabled]),button:not([disabled]),a[href],summary,[contenteditable="true"],[tabindex]:not([tabindex="-1"])';
            const focusTarget=target.matches?.(focusable) ? target : target.closest?.(focusable);
            if (${options.focus === true} && (!focusTarget || typeof focusTarget.focus!=='function')) return null;
            if (${options.focus === true}) focusTarget.focus({preventScroll:true});
            if (${options.requireFocused === true} && (!focusTarget || document.activeElement!==focusTarget)) return null;
            return {x,y,width:r.width,height:r.height};
          })()`,
          awaitPromise: true,
          returnByValue: true,
          userGesture: false,
          contextId: lease.contextId,
        })) as {
          result?: { value?: Omit<BrowserLocatedTarget, 'semanticLease'>; description?: string };
          exceptionDetails?: { text?: string; exception?: { description?: string } };
        };
        if (response.exceptionDetails) {
          throw new Error(
            response.exceptionDetails.exception?.description ??
              response.exceptionDetails.text ??
              'Browser target validation failed.',
          );
        }
        return response.result?.value ?? null;
      },
      abortSignal,
      documentLease,
    );
    if (!result) {
      throw new Error(
        'The requested browser target moved, was replaced, or became obscured before input. Retry the action.',
      );
    }
    await this.runRendererOperationWithDeadline(
      tab,
      contents,
      'Browser target occlusion validation',
      TARGET_LOCATION_TIMEOUT_MS,
      () => this.assertNoClickThroughOverlayAtPoints(contents, [result]),
      abortSignal,
      documentLease,
    );
    return { ...result, semanticLease: lease };
  }

  private async releaseLocatedTarget(contents: WebContents, target: BrowserLocatedTarget | null): Promise<void> {
    const lease = target?.semanticLease;
    if (!lease) return;
    try {
      if (!contents.isDestroyed() && contents.debugger.isAttached()) {
        await contents.debugger
          .sendCommand('Runtime.evaluate', {
            expression: `delete globalThis[${JSON.stringify(lease.globalKey)}]`,
            returnByValue: true,
            contextId: lease.contextId,
          })
          .catch(() => undefined);
      }
    } finally {
      lease.releaseDebugger?.();
    }
  }

  async action(
    conversationId: string,
    request: BrowserActionRequest,
    assistantRun: BrowserAssistantRun,
    approvedDocument?: BrowserDocumentApproval,
  ): Promise<{ ok: true; tab: BrowserTab }> {
    request = parseBrowserActionRequest(request);
    const abortSignal = assistantRun.abortSignal;
    throwIfBrowserAborted(abortSignal);
    const tab = this.requireAssistantTab(conversationId, assistantRun, request.tabId);
    if (request.kind === 'press') {
      const keys = (request.keys?.length ? request.keys : [request.text ?? 'Enter']).map((key) => key.toLowerCase());
      if (isClipboardShortcutKeys(keys)) {
        throw new Error('AI browser actions cannot access the system clipboard.');
      }
      if (isReservedBrowserShortcutKeys(keys)) {
        throw new Error('AI browser actions cannot invoke Browser chrome keyboard shortcuts.');
      }
      if (isApplicationAcceleratorShortcutKeys(keys)) {
        throw new Error('AI browser actions cannot invoke application keyboard shortcuts.');
      }
    }
    const action: BrowserActionEvent = {
      id: randomUUID(),
      tabId: tab.shell.id,
      kind: request.kind,
      status: 'running',
      startedAt: now(),
      summary: request.kind,
    };
    const emptyTypeAction = request.kind === 'type' && (request.value ?? request.text ?? '').length === 0;
    const hasRawCoordinates =
      request.x !== undefined || request.y !== undefined || request.endX !== undefined || request.endY !== undefined;
    const hasTarget = browserActionHasTarget(request);
    const needsStableTargetSurface =
      hasTarget && ['click', 'doubleClick', 'hover', 'focus', 'type', 'drag', 'scroll'].includes(request.kind);
    this.runningActions.set(action.id, { conversationId, action });
    if (emptyTypeAction) {
      // Chromium does not emit an input event for an empty insertText payload.
      // Treat it as a true no-op before resolving, focusing, arming, or mounting
      // a target so background automation cannot wait forever for an event that
      // will never exist.
      this.emit({ type: 'action', conversationId, action: { ...action } });
      action.status = 'completed';
      action.completedAt = now();
      this.runningActions.delete(action.id);
      this.emit({ type: 'action', conversationId, action: { ...action } });
      return {
        ok: true,
        tab: this.snapshotTab(tab, this.activeTabs.get(conversationId) === tab.shell.id),
      };
    }
    try {
      await this.serializeVisibleAssistantOperation(conversationId, tab, assistantRun, () =>
        this.runTabOperation(tab, () =>
          this.withAssistantControl(
            tab,
            assistantRun,
            async (documentLease) => {
              throwIfBrowserAborted(abortSignal);
              this.assertBrowserDocumentApproval(tab, approvedDocument);
              // Action events identify their target tab without changing the
              // user's presentation-active tab. If the user is already watching
              // this tab the input remains live; otherwise it uses the hidden
              // deterministic surface and the tab strip shows its action status.
              tab.lastUsedAt = Date.now();
              this.emitTabs(conversationId);
              this.emit({ type: 'action', conversationId, action });
              const view = await this.ensureAssistantView(
                tab,
                assistantRun,
                documentLease,
                undefined,
                approvedDocument,
              );
              this.assertBrowserDocumentApproval(tab, approvedDocument);
              const presented = await this.prepareAssistantOperationView(tab, view, abortSignal, documentLease);
              this.assertAssistantDocumentLease(tab, documentLease);
              const contents = view.webContents;
              // Locate and dispatch against one native surface. Semantic targets
              // can be revalidated after zoom, but sidebar unmount/minimize must
              // not resize their viewport between location and attributed input.
              const coordinateLease: BrowserInputCoordinateLease | null = needsStableTargetSurface
                ? this.captureInputCoordinateLease(view, hasRawCoordinates)
                : null;
              const assertCoordinateLease = (): void => {
                if (!coordinateLease) return;
                this.assertInputCoordinateLease(view, coordinateLease);
              };
              const assertInputContinuation = (): void => {
                throwIfBrowserAborted(abortSignal);
                this.assertAssistantDocumentLease(tab, documentLease);
                assertCoordinateLease();
              };
              let point: {
                x: number;
                y: number;
                width: number;
                height: number;
                semanticLease?: BrowserSemanticTargetLease;
              } | null = null;
              try {
                assertCoordinateLease();
                if (browserActionRequiresTarget(request.kind) && !hasTarget) {
                  throw new Error(`${request.kind} requires coordinates or a semantic target.`);
                }
                if (
                  ['click', 'doubleClick', 'hover', 'focus', 'type', 'drag'].includes(request.kind) ||
                  (request.kind === 'scroll' && hasTarget)
                ) {
                  point = await this.locate(tab, contents, request, abortSignal, documentLease);
                  action.x = point.x;
                  action.y = point.y;
                  if (presented) await this.setAutomationOverlay(tab, action, abortSignal, documentLease);
                }
                throwIfBrowserAborted(abortSignal);
                this.assertAssistantDocumentLease(tab, documentLease);
                assertCoordinateLease();
                const validateInputTarget = async (
                  target: BrowserLocatedTarget,
                  options: { focus?: boolean; requireFocused?: boolean } = {},
                ): Promise<BrowserLocatedTarget> =>
                  // The live cursor is a compositor-owned DevTools highlight, not
                  // a DOM hit-test participant. Author overlays remain visible to
                  // the validation probes and are still rejected.
                  this.validateLocatedTarget(tab, contents, target, options, abortSignal, documentLease);
                if (point) {
                  point = await validateInputTarget(point);
                  action.x = point.x;
                  action.y = point.y;
                }
                assertCoordinateLease();
                let inputPoint = point ? scaleBrowserPointForZoom(point, contents.getZoomFactor()) : null;
                const refreshLocatedTarget = async (options: { focus?: boolean; requireFocused?: boolean } = {}) => {
                  if (!point) return;
                  point = await validateInputTarget(point, options);
                  assertCoordinateLease();
                  inputPoint = scaleBrowserPointForZoom(point, contents.getZoomFactor());
                  action.x = point.x;
                  action.y = point.y;
                  this.assertAssistantDocumentLease(tab, documentLease);
                };
                const refreshStationaryLocatedTarget = async (
                  options: { focus?: boolean; requireFocused?: boolean } = {},
                ): Promise<void> => {
                  if (!point) {
                    assertInputContinuation();
                    return;
                  }
                  const armedGeometry = {
                    x: point.x,
                    y: point.y,
                    width: point.width,
                    height: point.height,
                  };
                  await refreshLocatedTarget(options);
                  if (
                    point.x !== armedGeometry.x ||
                    point.y !== armedGeometry.y ||
                    point.width !== armedGeometry.width ||
                    point.height !== armedGeometry.height
                  ) {
                    throw new Error(
                      'The requested browser target moved while background input was being armed. Retry the action.',
                    );
                  }
                  assertInputContinuation();
                };

                switch (request.kind) {
                  case 'navigate':
                    await this.navigate(
                      conversationId,
                      tab.shell.id,
                      request.url ?? request.text ?? '',
                      'assistant',
                      assistantRun,
                      documentLease.visibleAssistantGeneration,
                    );
                    break;
                  case 'back':
                  case 'forward':
                  case 'reload':
                  case 'stop':
                    await this.commandTabWithinOperation(tab, request.kind, 'assistant', assistantRun, documentLease);
                    break;
                  case 'click':
                  case 'doubleClick': {
                    assertCoordinateLease();
                    await this.dispatchInputEvent(
                      tab,
                      contents,
                      {
                        type: 'mouseMove',
                        x: Math.round(inputPoint!.x),
                        y: Math.round(inputPoint!.y),
                      },
                      {
                        method: 'Input.dispatchMouseEvent',
                        params: { type: 'mouseMoved', x: point!.x, y: point!.y },
                      },
                      abortSignal,
                      documentLease,
                    );
                    const clicks = request.kind === 'doubleClick' ? [1, 2] : [1];
                    for (const clickCount of clicks) {
                      await refreshLocatedTarget();
                      const pressedPoint = { x: point!.x, y: point!.y };
                      const releasePoint = scaleBrowserPointForZoom(pressedPoint, contents.getZoomFactor());
                      const releaseEvent: Electron.MouseInputEvent = {
                        type: 'mouseUp',
                        button: 'left',
                        x: Math.round(releasePoint.x),
                        y: Math.round(releasePoint.y),
                        clickCount,
                      };
                      const releaseCommand: BrowserCdpInputCommand = {
                        method: 'Input.dispatchMouseEvent',
                        params: {
                          type: 'mouseReleased',
                          button: 'left',
                          buttons: 0,
                          x: pressedPoint.x,
                          y: pressedPoint.y,
                          clickCount,
                        },
                      };
                      let pressed = false;
                      try {
                        await this.sendAttributedInputEvent(
                          tab,
                          contents,
                          { kind: 'pointerdown', x: pressedPoint.x, y: pressedPoint.y },
                          {
                            type: 'mouseDown',
                            button: 'left',
                            x: Math.round(inputPoint!.x),
                            y: Math.round(inputPoint!.y),
                            clickCount,
                          },
                          {
                            method: 'Input.dispatchMouseEvent',
                            params: {
                              type: 'mousePressed',
                              button: 'left',
                              buttons: 1,
                              x: pressedPoint.x,
                              y: pressedPoint.y,
                              clickCount,
                            },
                          },
                          abortSignal,
                          documentLease,
                          () => refreshStationaryLocatedTarget(),
                          () => {
                            pressed = true;
                          },
                        );
                        // Page handlers run before CDP resolves and may navigate or
                        // accept concurrent user input. Never release into a
                        // replacement document or a changed coordinate surface.
                        assertInputContinuation();
                        await this.dispatchInputEvent(
                          tab,
                          contents,
                          releaseEvent,
                          releaseCommand,
                          abortSignal,
                          documentLease,
                        );
                        pressed = false;
                      } finally {
                        if (pressed) {
                          await this.releaseInputIfDocumentCurrent(
                            tab,
                            contents,
                            releaseEvent,
                            releaseCommand,
                            documentLease,
                          );
                        }
                      }
                    }
                    break;
                  }
                  case 'hover':
                    await refreshLocatedTarget();
                    await this.dispatchInputEvent(
                      tab,
                      contents,
                      {
                        type: 'mouseMove',
                        x: Math.round(inputPoint!.x),
                        y: Math.round(inputPoint!.y),
                      },
                      {
                        method: 'Input.dispatchMouseEvent',
                        params: { type: 'mouseMoved', x: point!.x, y: point!.y },
                      },
                      abortSignal,
                      documentLease,
                    );
                    break;
                  case 'focus': {
                    if (point!.semanticLease) {
                      await refreshLocatedTarget({ focus: true, requireFocused: true });
                    } else {
                      const focused = await this.withAssistantScriptPopupAttribution(tab, () =>
                        this.evaluateWithDeadline(
                          tab,
                          contents,
                          browserFocusTargetScript(point!),
                          abortSignal,
                          documentLease,
                        ),
                      );
                      if (!focused) {
                        throw new Error('The requested browser target cannot receive focus.');
                      }
                    }
                    break;
                  }
                  case 'type': {
                    // Focus inside the document-bound isolated world. A synthetic
                    // click can itself navigate, leaving a later insertText call to
                    // target the replacement document before the final lease check.
                    if (point!.semanticLease) {
                      await refreshLocatedTarget({ focus: true, requireFocused: true });
                    } else {
                      const focused = await this.withAssistantScriptPopupAttribution(tab, () =>
                        this.evaluateWithDeadline(
                          tab,
                          contents,
                          browserFocusTargetScript(point!),
                          abortSignal,
                          documentLease,
                        ),
                      );
                      if (!focused) throw new Error('The requested browser target cannot receive focus.');
                    }
                    this.assertAssistantDocumentLease(tab, documentLease);
                    const insertedText = request.value ?? request.text ?? '';
                    await refreshLocatedTarget({ requireFocused: true });
                    assertInputContinuation();
                    // A presented page remains open to concurrent user typing.
                    // Bind the one-shot arm to the current trusted-input
                    // generation and recheck it after every frame acknowledges
                    // the arm, immediately before CDP inserts text. Hidden work
                    // deliberately stays independent of foreground activity.
                    const presentedGestureGeneration = this.isTargetViewPresented(tab, contents)
                      ? (tab.trustedGestureGeneration ?? 0)
                      : null;
                    // Hidden text dispatch waits for every frame preload to arm.
                    // Re-check the exact focused semantic target after that wait
                    // so focus changes cannot redirect typed data.
                    await this.insertAttributedText(
                      tab,
                      contents,
                      insertedText,
                      abortSignal,
                      documentLease,
                      async () => {
                        if (
                          presentedGestureGeneration !== null &&
                          (tab.trustedGestureGeneration ?? 0) !== presentedGestureGeneration
                        ) {
                          throw new Error(
                            'Browser input changed while assistant text input was being armed. Retry the action.',
                          );
                        }
                        await refreshLocatedTarget({ requireFocused: true });
                        assertInputContinuation();
                      },
                    );
                    break;
                  }
                  case 'press': {
                    const keys = request.keys?.length ? request.keys : [request.text ?? 'Enter'];
                    const modifiers = keys
                      .slice(0, -1)
                      .map((key) => key.toLowerCase())
                      .filter((key) => ['shift', 'control', 'ctrl', 'alt', 'meta', 'command', 'cmd'].includes(key))
                      .map((key) =>
                        key === 'ctrl' ? 'control' : key === 'command' || key === 'cmd' ? 'meta' : key,
                      ) as Array<'shift' | 'control' | 'alt' | 'meta'>;
                    const keyCode = keys.at(-1) ?? 'Enter';
                    const keyDownParams = cdpKeyboardEventParams('keyDown', keyCode, modifiers);
                    const attributedKey = typeof keyDownParams.key === 'string' ? keyDownParams.key : keyCode;
                    const releaseEvent: Electron.KeyboardInputEvent = { type: 'keyUp', keyCode, modifiers };
                    const releaseCommand: BrowserCdpInputCommand = {
                      method: 'Input.dispatchKeyEvent',
                      params: cdpKeyboardEventParams('keyUp', keyCode, modifiers),
                    };
                    // A key has no semantic/coordinate target to revalidate. If
                    // this page is currently presented, bind the arm to the
                    // real-user gesture generation immediately before arming so
                    // a concurrent click/focus change cannot redirect the key to
                    // a different control. Hidden work deliberately has no such
                    // dependency: unrelated foreground activity must not cancel
                    // a fully backgrounded browser operation.
                    const presentedGestureGeneration = this.isTargetViewPresented(tab, contents)
                      ? (tab.trustedGestureGeneration ?? 0)
                      : null;
                    let pressed = false;
                    try {
                      await this.sendAttributedInputEvent(
                        tab,
                        contents,
                        // DOM KeyboardEvent.key reflects Chromium's normalized
                        // value (for example Shift+1 => "!" and esc => "Escape").
                        { kind: 'keydown', key: attributedKey },
                        { type: 'keyDown', keyCode, modifiers },
                        {
                          method: 'Input.dispatchKeyEvent',
                          params: keyDownParams,
                        },
                        abortSignal,
                        documentLease,
                        async () => {
                          assertInputContinuation();
                          if (
                            presentedGestureGeneration !== null &&
                            (tab.trustedGestureGeneration ?? 0) !== presentedGestureGeneration
                          ) {
                            throw new Error(
                              'Browser focus changed while assistant keyboard input was being armed. Retry the action.',
                            );
                          }
                        },
                        () => {
                          pressed = true;
                        },
                      );
                      assertInputContinuation();
                      await this.dispatchInputEvent(
                        tab,
                        contents,
                        releaseEvent,
                        releaseCommand,
                        abortSignal,
                        documentLease,
                      );
                      pressed = false;
                    } finally {
                      if (pressed) {
                        await this.releaseInputIfDocumentCurrent(
                          tab,
                          contents,
                          releaseEvent,
                          releaseCommand,
                          documentLease,
                        );
                      }
                    }
                    break;
                  }
                  case 'scroll': {
                    await refreshLocatedTarget();
                    assertCoordinateLease();
                    const logicalScrollPoint = { x: point?.x ?? 10, y: point?.y ?? 10 };
                    const scrollPoint = scaleBrowserPointForZoom(logicalScrollPoint, contents.getZoomFactor());
                    await this.sendAttributedInputEvent(
                      tab,
                      contents,
                      { kind: 'wheel', x: logicalScrollPoint.x, y: logicalScrollPoint.y },
                      {
                        type: 'mouseWheel',
                        x: Math.round(scrollPoint.x),
                        y: Math.round(scrollPoint.y),
                        deltaX: request.deltaX ?? 0,
                        deltaY: request.deltaY ?? 500,
                      },
                      {
                        method: 'Input.dispatchMouseEvent',
                        params: {
                          type: 'mouseWheel',
                          x: logicalScrollPoint.x,
                          y: logicalScrollPoint.y,
                          deltaX: request.deltaX ?? 0,
                          deltaY: request.deltaY ?? 500,
                        },
                      },
                      abortSignal,
                      documentLease,
                      () => refreshStationaryLocatedTarget(),
                    );
                    break;
                  }
                  case 'drag': {
                    assertCoordinateLease();
                    await this.dispatchInputEvent(
                      tab,
                      contents,
                      {
                        type: 'mouseMove',
                        x: Math.round(inputPoint!.x),
                        y: Math.round(inputPoint!.y),
                      },
                      {
                        method: 'Input.dispatchMouseEvent',
                        params: { type: 'mouseMoved', x: point!.x, y: point!.y },
                      },
                      abortSignal,
                      documentLease,
                    );
                    await refreshLocatedTarget();
                    const endX = request.endX ?? point!.x;
                    const endY = request.endY ?? point!.y;
                    if (!Number.isFinite(endX) || !Number.isFinite(endY)) {
                      throw new Error('Drag endpoint coordinates must be finite.');
                    }
                    await this.validateLocatedTarget(
                      tab,
                      contents,
                      { x: endX, y: endY, width: 1, height: 1 },
                      {},
                      abortSignal,
                      documentLease,
                    );
                    assertCoordinateLease();
                    let releaseLogicalPoint = { x: point!.x, y: point!.y };
                    let pressed = false;
                    const releaseDrag = async (cleanup: boolean): Promise<void> => {
                      const releasePoint = scaleBrowserPointForZoom(releaseLogicalPoint, contents.getZoomFactor());
                      const releaseEvent: Electron.MouseInputEvent = {
                        type: 'mouseUp',
                        button: 'left',
                        x: Math.round(releasePoint.x),
                        y: Math.round(releasePoint.y),
                        clickCount: 1,
                      };
                      const releaseCommand: BrowserCdpInputCommand = {
                        method: 'Input.dispatchMouseEvent',
                        params: {
                          type: 'mouseReleased',
                          button: 'left',
                          buttons: 0,
                          x: releaseLogicalPoint.x,
                          y: releaseLogicalPoint.y,
                          clickCount: 1,
                        },
                      };
                      if (cleanup) {
                        await this.releaseInputIfDocumentCurrent(
                          tab,
                          contents,
                          releaseEvent,
                          releaseCommand,
                          documentLease,
                        );
                      } else {
                        await this.dispatchInputEvent(
                          tab,
                          contents,
                          releaseEvent,
                          releaseCommand,
                          abortSignal,
                          documentLease,
                        );
                      }
                    };
                    try {
                      await this.sendAttributedInputEvent(
                        tab,
                        contents,
                        { kind: 'pointerdown', x: point!.x, y: point!.y },
                        {
                          type: 'mouseDown',
                          button: 'left',
                          x: Math.round(inputPoint!.x),
                          y: Math.round(inputPoint!.y),
                          clickCount: 1,
                        },
                        {
                          method: 'Input.dispatchMouseEvent',
                          params: {
                            type: 'mousePressed',
                            button: 'left',
                            buttons: 1,
                            x: point!.x,
                            y: point!.y,
                            clickCount: 1,
                          },
                        },
                        abortSignal,
                        documentLease,
                        () => refreshStationaryLocatedTarget(),
                        () => {
                          pressed = true;
                        },
                      );
                      assertInputContinuation();
                      const endPoint = scaleBrowserPointForZoom({ x: endX, y: endY }, contents.getZoomFactor());
                      await this.dispatchInputEvent(
                        tab,
                        contents,
                        {
                          type: 'mouseMove',
                          button: 'left',
                          x: Math.round(endPoint.x),
                          y: Math.round(endPoint.y),
                        },
                        {
                          method: 'Input.dispatchMouseEvent',
                          params: { type: 'mouseMoved', button: 'left', buttons: 1, x: endX, y: endY },
                        },
                        abortSignal,
                        documentLease,
                      );
                      releaseLogicalPoint = { x: endX, y: endY };
                      assertInputContinuation();
                      await releaseDrag(false);
                      pressed = false;
                    } finally {
                      if (pressed) await releaseDrag(true);
                    }
                    break;
                  }
                  case 'wait':
                    await abortableDelay(Math.max(0, Math.min(30_000, request.waitMs ?? 1_000)), abortSignal);
                    break;
                  case 'bookmark':
                    this.addBookmark(conversationId, tab.shell.title, tab.shell.url);
                    break;
                  case 'unbookmark': {
                    const match = this.storeForScope(tab.scopeKey)
                      .listBookmarks()
                      .find((item) => item.url === tab.shell.url);
                    if (match) this.removeBookmark(conversationId, match.id);
                    break;
                  }
                }
                if (!['navigate', 'back', 'forward', 'reload'].includes(request.kind)) {
                  this.assertAssistantDocumentLease(tab, documentLease);
                }
              } finally {
                try {
                  await this.releaseLocatedTarget(contents, point);
                } finally {
                  this.releaseInputCoordinateLease(view, coordinateLease);
                }
              }
            },
            approvedDocument,
          ),
        ),
      );
      action.status = 'completed';
      action.completedAt = now();
      this.runningActions.delete(action.id);
      this.emit({ type: 'action', conversationId, action: { ...action } });
      await this.setAutomationOverlay(tab, action);
      return {
        ok: true,
        tab: this.snapshotTab(tab, this.activeTabs.get(conversationId) === tab.shell.id),
      };
    } catch (error) {
      action.status = 'failed';
      action.completedAt = now();
      action.error = redactBrowserErrorForExposure(error);
      this.runningActions.delete(action.id);
      this.emit({ type: 'action', conversationId, action: { ...action } });
      await this.setAutomationOverlay(tab, action);
      throw error;
    }
  }

  async inspect(
    conversationId: string,
    tabId: string | undefined,
    assistantRun: BrowserAssistantRun,
    approvedDocument?: BrowserDocumentApproval,
  ): Promise<BrowserInspection> {
    const abortSignal = assistantRun.abortSignal;
    throwIfBrowserAborted(abortSignal);
    const tab = this.requireAssistantTab(conversationId, assistantRun, tabId);
    return this.withVisibleAssistantOperation(
      conversationId,
      tab,
      assistantRun,
      'inspect',
      'inspecting page',
      (reveal) =>
        this.runTabOperation(tab, () =>
          this.withAssistantControl(
            tab,
            assistantRun,
            async (documentLease) => {
              throwIfBrowserAborted(abortSignal);
              this.assertBrowserDocumentApproval(tab, approvedDocument);
              const contents = (
                await this.ensureAssistantView(tab, assistantRun, documentLease, undefined, approvedDocument)
              ).webContents;
              this.assertBrowserDocumentApproval(tab, approvedDocument);
              await reveal(contents, documentLease);
              const result = await this.runRendererOperationWithDeadline(
                tab,
                contents,
                'Browser inspection',
                INSPECT_TIMEOUT_MS,
                async () => {
                  await this.assertTabNotSensitive(tab, contents, 'Inspection', abortSignal, documentLease);
                  const inspectedWithOcclusionPoints = (await this.evaluateWithDeadline(
                    tab,
                    contents,
                    browserInspectionExpression(),
                    abortSignal,
                    documentLease,
                  )) as Omit<BrowserInspection, 'tabId' | 'url' | 'title'> & {
                    __kaiOcclusionPoints?: Array<{ x: number; y: number }>;
                  };
                  const occlusionPoints = inspectedWithOcclusionPoints.__kaiOcclusionPoints;
                  if (!Array.isArray(occlusionPoints)) {
                    throw new Error('Browser inspection did not return occlusion evidence.');
                  }
                  await this.assertNoClickThroughOverlayAtPoints(contents, occlusionPoints);
                  const { __kaiOcclusionPoints: _privateOcclusionPoints, ...inspected } = inspectedWithOcclusionPoints;
                  await this.assertTabNotSensitive(tab, contents, 'Inspection', abortSignal, documentLease);
                  return inspected;
                },
                abortSignal,
                documentLease,
              );
              throwIfBrowserAborted(abortSignal);
              this.assertBrowserDocumentApproval(tab, approvedDocument);
              this.assertAssistantDocumentLease(tab, documentLease);
              return {
                tabId: tab.shell.id,
                url: boundedBrowserUrl(tab.shell.url),
                title: tab.shell.title,
                ...result,
              };
            },
            approvedDocument,
          ),
        ),
    );
  }

  async networkDiagnostics(
    conversationId: string,
    request: BrowserNetworkDiagnosticsRequest,
    assistantRun: BrowserAssistantRun,
    approvedDocument?: BrowserDocumentApproval,
  ): Promise<BrowserNetworkDiagnostics> {
    const abortSignal = assistantRun.abortSignal;
    throwIfBrowserAborted(abortSignal);
    const tab = this.requireAssistantTab(conversationId, assistantRun, request.tabId);
    if (tab.shell.sensitive) {
      throw new Error('Network diagnostics is blocked while this tab contains password data.');
    }
    const waitFor: BrowserNetworkWaitMode =
      request.waitFor === 'load' || request.waitFor === 'network-idle' ? request.waitFor : 'none';
    const limit = Math.max(1, Math.min(MAX_BROWSER_NETWORK_DIAGNOSTIC_RESULTS, Math.floor(request.limit ?? 50)));
    const timeoutMs = Math.max(100, Math.min(30_000, Math.floor(request.timeoutMs ?? 10_000)));
    const idleMs = Math.max(100, Math.min(5_000, Math.floor(request.idleMs ?? 500)));
    // Start the caller's wait budget before action publication or hidden page
    // preparation. Private-network sanitation and password scans are bounded,
    // sidebar-independent work and count against the requested wait deadline.
    const startedAt = Date.now();
    const deadlineAt = waitFor === 'none' ? Number.POSITIVE_INFINITY : startedAt + timeoutMs;
    const timedOutBeforeInspection = (documentLease?: AssistantDocumentLease): BrowserNetworkDiagnostics => {
      throwIfBrowserAborted(abortSignal);
      this.assertAssistantRun(conversationId, assistantRun);
      this.assertBrowserDocumentApproval(tab, approvedDocument);
      if (documentLease) this.assertAssistantDocumentLease(tab, documentLease);
      if (
        this.removedConversations.has(conversationId) ||
        tab.shell.conversationId !== conversationId ||
        this.tabs.get(tab.shell.id) !== tab
      ) {
        throw new Error('The browser tab closed while network diagnostics were waiting.');
      }
      if (tab.shell.sensitive) {
        throw new Error('Network diagnostics is blocked while this tab contains password data.');
      }
      const redactionKey = this.networkRedactionKeyForTab(tab);
      const requestCount = Math.max(tab.networkRequests?.size ?? 0, tab.networkRequestSequence ?? 0);
      const inFlight = this.currentDocumentActiveNetworkRequests(tab).length;
      // No renderer inspection is allowed after the caller's budget expires.
      // Return only manager-owned, content-free state; exact request metadata
      // remains withheld until a later successful sensitivity scan.
      return {
        tabId: tab.shell.id,
        url: browserNetworkPageIdentity(tab.shell.url, redactionKey),
        loading: tab.shell.loading,
        waitFor,
        waitTimedOut: true,
        inFlight,
        requestCount,
        requestsTruncated: requestCount > 0,
        loadTiming: {},
        requests: [],
      };
    };
    return this.withVisibleAssistantOperation(
      conversationId,
      tab,
      assistantRun,
      'network',
      waitFor === 'none' ? 'checking network activity' : `waiting for ${waitFor}`,
      () => {
        const operation = () =>
          this.withAssistantControl(
            tab,
            assistantRun,
            async (documentLease) => {
              throwIfBrowserAborted(abortSignal);
              this.assertBrowserDocumentApproval(tab, approvedDocument);
              const remainingBeforeView = Math.ceil(deadlineAt - Date.now());
              if (waitFor !== 'none' && remainingBeforeView <= 0) return timedOutBeforeInspection(documentLease);
              let contents: WebContents;
              try {
                contents = (
                  await this.ensureAssistantView(
                    tab,
                    assistantRun,
                    documentLease,
                    waitFor === 'none' ? undefined : remainingBeforeView,
                    approvedDocument,
                    true,
                  )
                ).webContents;
              } catch (error) {
                if (waitFor !== 'none' && error instanceof BrowserRendererDeadlineError) {
                  return timedOutBeforeInspection(documentLease);
                }
                throw error;
              }
              this.assertBrowserDocumentApproval(tab, approvedDocument);
              const target = {
                tabGeneration: tab.generation,
                userNavigationLease: tab.trustedUserNavigationLease,
                networkNavigationSequence: tab.networkNavigationSequence ?? 0,
                redactionKey: this.networkRedactionKeyForTab(tab),
                scopeGeneration: this.currentScopeGeneration(tab.scopeKey),
                scopeKey: tab.scopeKey,
                url: tab.shell.url,
              };
              const assertNotSensitiveWithinBudget = async (): Promise<boolean> => {
                if (waitFor !== 'none' && Date.now() >= deadlineAt) return false;
                const remaining = waitFor === 'none' ? undefined : Math.max(1, Math.ceil(deadlineAt - Date.now()));
                let debuggerLease: BrowserDebuggerLease | undefined;
                try {
                  await this.assertTabNotSensitive(
                    tab,
                    contents,
                    'Network diagnostics',
                    abortSignal,
                    documentLease,
                    remaining,
                    false,
                    (lease) => {
                      debuggerLease = lease;
                    },
                  );
                } catch (error) {
                  // Abort and deadline paths both leave native CDP promises
                  // running. Cancel the exact captured lease before returning
                  // or rethrowing; the scan-level fence prevents a late child
                  // frame continuation from acquiring a replacement lease.
                  debuggerLease?.cancel();
                  if (waitFor === 'none' || !(error instanceof BrowserRendererDeadlineError)) throw error;
                  // A diagnostic timeout must not discard an authenticated user
                  // page. Detach only a debugger connection that BrowserManager
                  // itself owns so its late CDP command cannot block later work.
                  return false;
                }
                return waitFor === 'none' || Date.now() < deadlineAt;
              };
              const assertTargetCurrent = (): void => {
                throwIfBrowserAborted(abortSignal);
                this.assertAssistantRun(conversationId, assistantRun);
                this.assertAssistantDocumentLease(tab, documentLease);
                this.assertBrowserDocumentApproval(tab, approvedDocument);
                if (tab.shell.sensitive) {
                  throw new Error('Network diagnostics is blocked while this tab contains password data.');
                }
                if (
                  this.tabs.get(tab.shell.id) !== tab ||
                  tab.shell.conversationId !== conversationId ||
                  tab.generation !== target.tabGeneration ||
                  tab.trustedUserNavigationLease !== target.userNavigationLease ||
                  (tab.networkNavigationSequence ?? 0) !== target.networkNavigationSequence ||
                  tab.networkRedactionKey !== target.redactionKey ||
                  tab.shell.url !== target.url
                ) {
                  throw new Error('The page navigated while Browser network diagnostics were waiting.');
                }
                if (
                  tab.scopeKey !== target.scopeKey ||
                  this.currentScopeGeneration(target.scopeKey) !== target.scopeGeneration ||
                  this.scopeUnavailable(target.scopeKey)
                ) {
                  throw new Error('The Browser profile changed while network diagnostics were waiting.');
                }
              };

              assertTargetCurrent();
              let waitTimedOut = waitFor !== 'none' && Date.now() >= deadlineAt;
              let idleSince: number | null = null;
              while (waitFor !== 'none' && !waitTimedOut) {
                assertTargetCurrent();
                const currentTime = Date.now();
                const loaded = !tab.shell.loading;
                const currentActiveRequests = this.currentDocumentActiveNetworkRequests(tab);
                const hasBlockingRequests = tab.activeNetworkRequests
                  ? currentActiveRequests.some(([, resourceType]) => browserNetworkResourceBlocksIdle(resourceType))
                  : [...(tab.networkRequests?.values() ?? [])].some(
                      (tracked) =>
                        tracked.completedAt === undefined && browserNetworkResourceBlocksIdle(tracked.resourceType),
                    );
                if (waitFor === 'load' ? loaded : !hasBlockingRequests) {
                  if (waitFor === 'load') break;
                  idleSince = Math.max(idleSince ?? startedAt, tab.networkLastBlockingActivityAt ?? startedAt);
                  if (currentTime - idleSince >= idleMs) break;
                } else {
                  idleSince = null;
                }
                if (currentTime >= deadlineAt) {
                  waitTimedOut = true;
                  break;
                }
                // This cancellable main-process poll reads manager-owned request
                // bookkeeping. It never mounts, selects, focuses, or evaluates the
                // Browser page, and a concurrent user navigation invalidates it.
                await abortableDelay(Math.min(50, Math.max(1, deadlineAt - currentTime)), abortSignal);
              }

              assertTargetCurrent();
              if (waitFor !== 'none' && (waitTimedOut || Date.now() >= deadlineAt)) {
                return timedOutBeforeInspection(documentLease);
              }
              if (!(await assertNotSensitiveWithinBudget())) return timedOutBeforeInspection(documentLease);
              assertTargetCurrent();
              const trackedRequests = [...(tab.networkRequests?.values() ?? [])];
              const network = snapshotBrowserNetworkRequests(trackedRequests, limit, target.redactionKey);
              const activeRequestCount = tab.activeNetworkRequests
                ? this.currentDocumentActiveNetworkRequests(tab).length
                : network.inFlight;
              const requestCount = Math.max(network.requestCount, tab.networkRequestSequence ?? 0);
              const result = {
                tabId: tab.shell.id,
                url: browserNetworkPageIdentity(tab.shell.url, target.redactionKey),
                loading: tab.shell.loading,
                waitFor,
                waitTimedOut,
                inFlight: activeRequestCount,
                requestCount,
                requestsTruncated: network.truncated || requestCount > network.requestCount,
                loadTiming: browserLoadTimingFromNetworkRequests(trackedRequests),
                requests: network.entries,
              } satisfies BrowserNetworkDiagnostics;
              if (!(await assertNotSensitiveWithinBudget())) return timedOutBeforeInspection(documentLease);
              assertTargetCurrent();
              return result;
            },
            approvedDocument,
          );
        return waitFor === 'none'
          ? this.runTabOperation(tab, operation)
          : this.runTabOperationBeforeDeadline(tab, deadlineAt, timedOutBeforeInspection, operation);
      },
    );
  }

  private async runRendererOperationWithDeadline<T>(
    tab: InternalTab,
    contents: WebContents,
    operation: string,
    timeoutMs: number,
    task: () => Promise<T>,
    abortSignal?: AbortSignal,
    documentLease?: AssistantDocumentLease,
    reclaimTargetOnCancellation = true,
  ): Promise<T> {
    if (abortSignal?.aborted) throw new Error(`${operation} was cancelled.`);
    if (documentLease) this.assertAssistantDocumentLease(tab, documentLease);
    const targetGeneration = tab.generation;
    const targetUserNavigationLease = tab.trustedUserNavigationLease;
    const targetDocumentIsCurrent = (): boolean =>
      this.tabs.get(tab.shell.id) === tab &&
      tab.view?.webContents === contents &&
      !contents.isDestroyed() &&
      tab.generation === targetGeneration &&
      tab.trustedUserNavigationLease === targetUserNavigationLease;
    let cancellation: 'timeout' | 'abort' | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abortListener: (() => void) | undefined;
    const cancelled = new Promise<never>((_resolve, reject) => {
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          cancellation = 'timeout';
          reject(new BrowserRendererDeadlineError(operation, timeoutMs));
        }, timeoutMs);
        timer.unref?.();
      }
      if (abortSignal) {
        abortListener = () => {
          cancellation = 'abort';
          reject(new Error(`${operation} was cancelled.`));
        };
        abortSignal.addEventListener('abort', abortListener, { once: true });
      }
    });
    try {
      const result = await Promise.race([task(), cancelled]);
      if (documentLease) this.assertAssistantDocumentLease(tab, documentLease);
      return result;
    } catch (error) {
      if (cancellation && reclaimTargetOnCancellation) {
        // The Electron executeJavaScript/capture APIs have no cancellation
        // primitive. Terminate target-scoped script execution when CDP is
        // available, then reclaim only this WebContentsView so the queue and
        // profile-clear barrier cannot remain hostage to a wedged page. Never
        // call forcefullyCrashRenderer(): Chromium may place sibling tabs in
        // the same renderer process, and crashing it would discard unrelated
        // user page state.
        try {
          if (targetDocumentIsCurrent() && contents.debugger.isAttached()) {
            void contents.debugger.sendCommand('Runtime.terminateExecution').catch(() => undefined);
          }
        } catch {
          // The timed-out target may already be tearing down.
        }
        // The tab shell can survive a concurrent user navigation that replaces
        // its WebContents. Reclaim only the exact target whose operation timed
        // out; destroying a replacement would discard unrelated user state.
        if (targetDocumentIsCurrent()) {
          this.destroyView(tab);
          tab.shell.discarded = true;
          tab.shell.error = cancellation === 'timeout' ? `${operation} timed out.` : `${operation} was cancelled.`;
          this.emitTabs(tab.shell.conversationId);
        }
      }
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
      if (abortSignal && abortListener) abortSignal.removeEventListener('abort', abortListener);
    }
  }

  private async evaluateWithDeadline(
    tab: InternalTab,
    contents: WebContents,
    script: string,
    abortSignal?: AbortSignal,
    documentLease?: AssistantDocumentLease,
    timeoutMs = EVALUATE_TIMEOUT_MS,
    reclaimTargetOnCancellation = true,
    captureDebuggerLease?: (lease: BrowserDebuggerLease) => void,
  ): Promise<unknown> {
    return this.runRendererOperationWithDeadline(
      tab,
      contents,
      'Browser script evaluation',
      timeoutMs,
      async () => {
        const debuggerLease = this.acquireBrowserDebuggerLease(contents);
        try {
          captureDebuggerLease?.(debuggerLease);
          const frameTree = (await contents.debugger.sendCommand('Page.getFrameTree')) as {
            frameTree?: { frame?: { id?: string } };
          };
          const frameId = frameTree.frameTree?.frame?.id;
          if (!frameId) throw new Error('The browser page has no main execution frame.');
          // Run both the caller script and its bounding serializer in a fresh
          // isolated world. Remote pages can replace main-world intrinsics long
          // before Kai evaluates a script; a unique isolated world provides
          // pristine JSON/String/Reflect implementations while retaining DOM
          // access and exposes no Kai APIs to the page.
          const isolatedWorld = (await contents.debugger.sendCommand('Page.createIsolatedWorld', {
            frameId,
            worldName: `__kai_browser_evaluation_${randomUUID().replaceAll('-', '')}`,
            grantUniveralAccess: false,
          })) as { executionContextId?: number };
          if (!Number.isInteger(isolatedWorld.executionContextId)) {
            throw new Error('The browser page has no isolated execution context.');
          }
          const response = (await contents.debugger.sendCommand('Runtime.evaluate', {
            expression: script,
            awaitPromise: true,
            returnByValue: true,
            userGesture: false,
            contextId: isolatedWorld.executionContextId,
          })) as {
            result?: { value?: unknown; description?: string };
            exceptionDetails?: {
              text?: string;
              exception?: { description?: string };
            };
          };
          if (response.exceptionDetails) {
            throw new Error(
              response.exceptionDetails.exception?.description ??
                response.exceptionDetails.text ??
                'Browser script evaluation failed.',
            );
          }
          return response.result?.value;
        } finally {
          debuggerLease.release();
        }
      },
      abortSignal,
      documentLease,
      reclaimTargetOnCancellation,
    );
  }

  private quarantineScriptedTab(tab: InternalTab): void {
    tab.scriptTainted = true;
    tab.shell.reloadRequired = true;
    if (this.attachedView === tab.view) this.detachAttachedView();
    this.emitTabs(tab.shell.conversationId);
  }

  /** A document-start CDP guard is deliberately target-scoped and cannot be
   * safely removed while arbitrary evaluated work may still be scheduled.
   * User navigation therefore crosses the authority boundary by destroying the
   * entire scripted renderer. The taint remains latched until ensureView has
   * removed every durable service-worker registration and a new document
   * commits successfully. */
  private resetScriptedRendererForUser(tab: InternalTab): boolean {
    if (
      !tab.scriptTainted &&
      !tab.privateNetworkNewDocumentGuard &&
      !tab.assistantNativeUiNewDocumentGuard &&
      !tab.assistantDialogsDisabledRunId
    ) {
      return false;
    }
    // Explicit user navigation replaces the assistant-controlled document.
    // Revoke active control before createView() inspects the shell so the fresh
    // renderer cannot inherit assistant-only preload/native-UI restrictions.
    // The run-lifetime dialog guard may remain dormant for later AI work, but
    // ensureView only applies it while this control capability is live.
    tab.aiControlOwnerId = null;
    tab.aiControlGeneration = null;
    tab.assistantDialogsDisabledRunId = null;
    tab.assistantDownloadAttribution = undefined;
    tab.generation++;
    this.destroyView(tab);
    tab.shell.discarded = true;
    tab.shell.sensitive = false;
    return true;
  }

  private async installPrivateNetworkNewDocumentGuard(
    tab: InternalTab,
    contents: WebContents,
    abortSignal?: AbortSignal,
    documentLease?: AssistantDocumentLease,
  ): Promise<void> {
    if (this.aiAllowPrivateNetwork ?? false) return;
    const existing = tab.privateNetworkNewDocumentGuard;
    if (
      existing?.contentsId === contents.id &&
      existing.identifier !== PRELOAD_PRIVATE_NETWORK_GUARD_PENDING_IDENTIFIER
    )
      return;
    if (existing && existing.contentsId !== contents.id) {
      throw new Error('The browser page changed before its private-network script guard could be installed.');
    }
    // Chromium has no page execution context before a new WebContents begins
    // its first navigation. CDP's Page.addScriptToEvaluateOnNewDocument can
    // remain pending forever in that state, especially for a hidden target.
    // The restricted frame preload is already armed in WebPreferences; defer
    // this durable CDP registration until ensureView has made the first
    // document live.
    if (typeof contents.getURL === 'function' && contents.getURL() === '') return;
    // Publish a fail-closed marker before the first asynchronous CDP step. A
    // concurrent Settings transition that relaxes private-network access must
    // enqueue behind this tab and reclaim the renderer after installation;
    // otherwise this operation could finish installing the irreversible old
    // membrane after the relaxed policy had already committed.
    tab.privateNetworkNewDocumentGuard = {
      contentsId: contents.id,
      identifier: PRELOAD_PRIVATE_NETWORK_GUARD_PENDING_IDENTIFIER,
    };
    await this.runRendererOperationWithDeadline(
      tab,
      contents,
      'Browser private-network guard installation',
      PRIVATE_NETWORK_GUARD_TIMEOUT_MS,
      async () => {
        const releaseDebugger = this.acquireBrowserDebugger(contents);
        try {
          const result = (await contents.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', {
            source: BROWSER_PRIVATE_NETWORK_NEW_DOCUMENT_GUARD,
            runImmediately: true,
          })) as { identifier?: unknown };
          if (typeof result.identifier !== 'string' || result.identifier.length === 0) {
            throw new Error('Chromium did not return a private-network script guard identifier.');
          }
          // A brand-new WebContents has an internal empty document whose sandboxed
          // preload realm is not scheduled until its first navigation. It contains
          // no remote/page script, and the document-start CDP registration above is
          // already installed for that first navigation, so there is no live
          // untrusted realm to activate yet. Waiting on executeJavaScript here can
          // deadlock a completely hidden target and make background tab creation
          // depend on mounting the sidebar.
          const frames = [contents.mainFrame, ...contents.mainFrame.framesInSubtree];
          const verifiedFrames = new Set<number>();
          for (const frame of frames) {
            if (frame.detached || frame.isDestroyed() || verifiedFrames.has(frame.frameTreeNodeId)) continue;
            const activated = await frame.executeJavaScript(BROWSER_PRIVATE_NETWORK_GUARD_ACTIVATION_PROBE);
            if (activated !== true) {
              throw new Error('The browser page preload could not install its private-network WebRTC guard.');
            }
            verifiedFrames.add(frame.frameTreeNodeId);
          }
          if (verifiedFrames.size === 0) {
            throw new Error('The browser page had no live frame in which to verify its private-network WebRTC guard.');
          }
          tab.privateNetworkNewDocumentGuard = {
            contentsId: contents.id,
            identifier: result.identifier,
          };
        } finally {
          try {
            releaseDebugger();
          } catch {
            // The target may have closed while the guard was being installed.
          }
        }
      },
      abortSignal,
      documentLease,
    ).catch((error: unknown) => {
      throw new Error(
        `Browser script evaluation could not guard newly navigated frames: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
  }

  /** Prevent remote content from opening native UI while the assistant owns
   * this renderer. Every Browser frame installs inert preload trampolines at
   * document start; main activates them with a per-renderer capability and
   * registers the same activation for future documents. */
  private async installAssistantNativeUiGuard(
    tab: InternalTab,
    contents: WebContents,
    abortSignal?: AbortSignal,
    documentLease?: AssistantDocumentLease,
  ): Promise<void> {
    const existing = tab.assistantNativeUiNewDocumentGuard;
    if (existing?.contentsId === contents.id && existing.identifier !== PRELOAD_NATIVE_UI_GUARD_PENDING_IDENTIFIER)
      return;
    if (existing && existing.contentsId !== contents.id) {
      throw new Error('The browser page changed before its native-UI guard could be installed.');
    }
    const token = tab.nativeUiGuardToken;
    if (!token) throw new Error('The browser page has no native-UI guard capability.');
    // A brand-new WebContents has no renderer execution context. createView
    // arms its preload with the guard argument, and ensureView performs an inert
    // first load before assistant work reaches this method.
    if (typeof contents.getURL === 'function' && contents.getURL() === '') return;
    // Publish target-scoped pending state before the first asynchronous frame
    // probe. User navigation treats even this marker as irreversible and
    // reclaims the renderer, so a late verification cannot bless a replacement.
    tab.assistantNativeUiNewDocumentGuard = {
      contentsId: contents.id,
      identifier: PRELOAD_NATIVE_UI_GUARD_PENDING_IDENTIFIER,
    };
    await this.runRendererOperationWithDeadline(
      tab,
      contents,
      'Browser native-UI guard installation',
      NATIVE_UI_GUARD_TIMEOUT_MS,
      async () => {
        const releaseDebugger = this.acquireBrowserDebugger(contents);
        try {
          const result = (await contents.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', {
            source: browserNativeUiNewDocumentGuard(token),
            runImmediately: false,
          })) as { identifier?: unknown };
          if (typeof result.identifier !== 'string' || result.identifier.length === 0) {
            throw new Error('Chromium did not return a native-UI script guard identifier.');
          }
          const frames = [contents.mainFrame, ...contents.mainFrame.framesInSubtree];
          const verifiedFrames = new Set<number>();
          for (const frame of frames) {
            if (frame.detached || frame.isDestroyed() || verifiedFrames.has(frame.frameTreeNodeId)) continue;
            const installed = await frame.executeJavaScript(browserNativeUiGuardActivationProbe(token, true));
            if (installed !== true) {
              throw new Error('The browser page preload could not activate its native-UI guard.');
            }
            verifiedFrames.add(frame.frameTreeNodeId);
          }
          if (verifiedFrames.size === 0) {
            throw new Error('The browser page had no live frame in which to verify its native-UI guard.');
          }
          tab.assistantNativeUiNewDocumentGuard = {
            contentsId: contents.id,
            identifier: result.identifier,
          };
        } finally {
          try {
            releaseDebugger();
          } catch {
            // The target may have closed while the guard was being installed.
          }
        }
      },
      abortSignal,
      documentLease,
    ).catch((error: unknown) => {
      throw new Error(
        `Browser control could not block native page UI safely: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }

  /** Remove future-document activation and return the current live document's
   * preload trampolines to pass-through behavior. If CDP's fail-closed fallback
   * ever ran, the deactivation probe rejects and cleanup unloads that renderer
   * rather than exposing a partially guarded page to the user. */
  private async releaseAssistantNativeUiGuard(tab: InternalTab): Promise<void> {
    const guard = tab.assistantNativeUiNewDocumentGuard;
    const view = tab.view;
    const contents = view?.webContents;
    const token = tab.nativeUiGuardToken;
    if (!guard) return;
    if (!contents || contents.isDestroyed() || guard.contentsId !== contents.id || !token) {
      throw new Error('The browser page changed before its native-UI guard could be restored.');
    }
    if (guard.identifier === PRELOAD_NATIVE_UI_GUARD_PENDING_IDENTIFIER) {
      throw new Error('The browser native-UI guard was still being installed during cleanup.');
    }
    await this.runRendererOperationWithDeadline(
      tab,
      contents,
      'Browser native-UI guard restoration',
      NATIVE_UI_GUARD_TIMEOUT_MS,
      async () => {
        const releaseDebugger = this.acquireBrowserDebugger(contents);
        try {
          // Stop arming replacement documents before inspecting the live frame
          // tree. Any document that already ran the guard has an execution
          // context and is included below; a document created after this CDP
          // acknowledgement is never guarded. Reversing this order leaves a
          // navigation/frame-creation window in which a newly guarded document
          // is absent from the restoration snapshot.
          await contents.debugger.sendCommand('Page.removeScriptToEvaluateOnNewDocument', {
            identifier: guard.identifier,
          });
          const frames = [contents.mainFrame, ...contents.mainFrame.framesInSubtree];
          const restoredFrames = new Set<number>();
          for (const frame of frames) {
            if (frame.detached || frame.isDestroyed() || restoredFrames.has(frame.frameTreeNodeId)) continue;
            const restored = await frame.executeJavaScript(browserNativeUiGuardActivationProbe(token, false));
            if (restored !== true) {
              throw new Error('The browser page preload could not restore ordinary native-UI behavior.');
            }
            restoredFrames.add(frame.frameTreeNodeId);
          }
          if (restoredFrames.size === 0) {
            throw new Error('The browser page had no live frame in which to restore native-UI behavior.');
          }
        } finally {
          releaseDebugger();
        }
      },
    );
    if (tab.view?.webContents === contents && tab.assistantNativeUiNewDocumentGuard === guard) {
      tab.assistantNativeUiNewDocumentGuard = undefined;
    }
  }

  async evaluate(
    conversationId: string,
    script: string,
    tabId: string | undefined,
    assistantRun: BrowserAssistantRun,
    approvedDocument?: BrowserDocumentApproval,
  ): Promise<unknown> {
    const abortSignal = assistantRun.abortSignal;
    const tab = this.requireAssistantTab(conversationId, assistantRun, tabId);
    return this.withVisibleAssistantOperation(
      conversationId,
      tab,
      assistantRun,
      'evaluate',
      'evaluating script',
      (reveal) =>
        this.runTabOperation(tab, () =>
          this.withAssistantControl(
            tab,
            assistantRun,
            async (documentLease) => {
              this.assertBrowserDocumentApproval(tab, approvedDocument);
              const contents = (
                await this.ensureAssistantView(tab, assistantRun, documentLease, undefined, approvedDocument)
              ).webContents;
              this.assertBrowserDocumentApproval(tab, approvedDocument);
              await reveal(contents, documentLease);
              await this.assertTabNotSensitive(tab, contents, 'Script evaluation', abortSignal, documentLease);
              // Arbitrary page JS can install long-lived input listeners. Detach the
              // native page before executing it so those listeners cannot observe
              // secrets typed by the user. A committed navigation/reload clears the
              // quarantine; failures leave it in place.
              await this.installPrivateNetworkNewDocumentGuard(tab, contents, abortSignal, documentLease);
              const evaluationOrigin = normalizedOrigin(tab.shell.url);
              if (evaluationOrigin === 'unknown') {
                throw new Error('Browser script evaluation requires an HTTP(S) page origin.');
              }
              this.storeForScope(tab.scopeKey).markScriptCleanupOrigin(evaluationOrigin);
              this.quarantineScriptedTab(tab);
              const serialized = await this.withAssistantScriptPopupAttribution(tab, () =>
                this.evaluateWithDeadline(
                  tab,
                  contents,
                  boundedBrowserEvaluationExpression(script, undefined, this.aiAllowPrivateNetwork ?? false),
                  abortSignal,
                  documentLease,
                ),
              );
              await this.assertTabNotSensitive(tab, contents, 'Script evaluation', abortSignal, documentLease);
              this.assertAssistantDocumentLease(tab, documentLease);
              if (typeof serialized !== 'string') throw new Error('The script result was not serialized safely.');
              return JSON.parse(serialized) as unknown;
            },
            approvedDocument,
          ),
        ),
    );
  }

  private async hideAutomationOverlay(
    tab: InternalTab,
    contents: WebContents,
    abortSignal?: AbortSignal,
    documentLease?: AssistantDocumentLease,
  ): Promise<{ overlay: BrowserAutomationOverlay; generation: number } | null> {
    const overlay = tab.automationOverlay;
    if (!overlay || overlay.contents !== contents) return null;
    const generation = tab.overlayGeneration;
    tab.automationOverlay = null;
    try {
      await this.runRendererOperationWithDeadline(
        tab,
        contents,
        'Browser automation overlay',
        AUTOMATION_OVERLAY_TIMEOUT_MS,
        () => contents.debugger.sendCommand('Overlay.hideHighlight'),
        abortSignal,
        documentLease,
      );
    } catch (error) {
      if (
        tab.overlayGeneration === generation &&
        tab.view?.webContents === contents &&
        !contents.isDestroyed() &&
        !tab.automationOverlay
      ) {
        tab.automationOverlay = overlay;
      } else {
        overlay.releaseDebugger();
      }
      throw error;
    }
    return { overlay, generation };
  }

  private async restoreAutomationOverlay(
    tab: InternalTab,
    contents: WebContents,
    hidden: { overlay: BrowserAutomationOverlay; generation: number } | null,
    abortSignal?: AbortSignal,
    documentLease?: AssistantDocumentLease,
  ): Promise<void> {
    if (!hidden) return;
    if (
      contents.isDestroyed() ||
      tab.overlayGeneration !== hidden.generation ||
      tab.view?.webContents !== contents ||
      tab.automationOverlay
    ) {
      hidden.overlay.releaseDebugger();
      return;
    }
    let retained = false;
    try {
      await this.runRendererOperationWithDeadline(
        tab,
        contents,
        'Browser automation overlay',
        AUTOMATION_OVERLAY_TIMEOUT_MS,
        () => this.showAutomationCursor(hidden.overlay),
        abortSignal,
        documentLease,
      );
      if (tab.overlayGeneration === hidden.generation && tab.view?.webContents === contents && !tab.automationOverlay) {
        tab.automationOverlay = hidden.overlay;
        retained = true;
      } else if (!contents.isDestroyed() && contents.debugger.isAttached()) {
        try {
          await this.runRendererOperationWithDeadline(
            tab,
            contents,
            'Browser automation overlay cleanup',
            AUTOMATION_OVERLAY_TIMEOUT_MS,
            () => contents.debugger.sendCommand('Overlay.hideHighlight'),
            undefined,
            undefined,
            false,
          );
        } catch {
          // Screenshot restoration raced a newer overlay/document. Cancel only
          // this hidden overlay's lease so cleanup cannot retain the screenshot
          // queue or the stale compositor command indefinitely.
          hidden.overlay.cancelDebugger();
        }
      }
    } finally {
      if (!retained) hidden.overlay.releaseDebugger();
    }
  }

  cancelMenuPreview(requestId: string): void {
    if (typeof requestId !== 'string' || requestId.length === 0 || requestId.length > 128) return;
    const active = this.menuPreviewCapture;
    const subscriber = active?.subscribers.get(requestId);
    if (!active || !subscriber) return;
    active.subscribers.delete(requestId);
    if (!subscriber.settled) {
      subscriber.settled = true;
      subscriber.reject(new Error('Browser menu preview was cancelled.'));
    }
    // The preview uses manager-owned CDP work. Aborting the final subscriber
    // detaches that private debugger lease, so no hidden native capture can keep
    // the global slot or renderer alive indefinitely.
    if (active.subscribers.size === 0) active.controller.abort();
  }

  private settleMenuPreviewCapture(
    active: BrowserMenuPreviewCapture,
    outcome: { result: BrowserScreenshotResult } | { error: Error },
  ): void {
    if (active.outcome) return;
    active.outcome = outcome;
    for (const subscriber of active.subscribers.values()) {
      if (subscriber.settled) continue;
      subscriber.settled = true;
      if ('error' in outcome) subscriber.reject(outcome.error);
      else subscriber.resolve(outcome.result);
    }
    active.subscribers.clear();
  }

  private rejectMenuPreviewForContents(contentsId: number, error: Error): void {
    const active = this.menuPreviewCapture;
    if (!active || active.contentsId !== contentsId) return;
    active.controller.abort();
    this.settleMenuPreviewCapture(active, { error });
    // The WebContents is already being destroyed, so release lifecycle waiters.
    active.teardownController.abort();
  }

  /** Destroy a preview target only as part of an explicit lifecycle teardown.
   * Ordinary cancellation preserves the user's unsaved DOM/SPA state. */
  private reclaimMenuPreviewTarget(active: BrowserMenuPreviewCapture, error?: string): void {
    const tab = this.tabs.get(active.tabId);
    if (!tab || tab.view?.webContents.id !== active.contentsId) {
      active.teardownController.abort();
      return;
    }
    this.destroyView(tab);
    tab.shell.discarded = true;
    tab.shell.loading = false;
    if (error) tab.shell.error = error;
    this.emitTabs(tab.shell.conversationId);
    active.teardownController.abort();
  }

  /** User navigation/presentation is concurrent with assistant work. A menu
   * preview never freezes or mutates the target, so preemption only needs to
   * abort its caller-facing work and drain the short opportunistic queue task. */
  private preemptMenuPreviewForTab(tab: InternalTab, reason: string): Promise<void> | null {
    const active = this.menuPreviewCapture;
    if (
      !active ||
      active.tabId !== tab.shell.id ||
      tab.view?.webContents.id !== active.contentsId ||
      active.teardownController.signal.aborted
    ) {
      return null;
    }
    this.settleMenuPreviewCapture(active, { error: new Error(reason) });
    active.controller.abort();
    const operationSettled = active.operation
      ? active.operation.then(
          () => undefined,
          () => undefined,
        )
      : Promise.resolve();
    return operationSettled.then(
      () => undefined,
      () => undefined,
    );
  }

  private async drainMenuPreviewCapture(
    scopeKeys?: ReadonlySet<string>,
    error?: Error,
    surfaceTargetError = true,
  ): Promise<void> {
    const active = this.menuPreviewCapture;
    if (!active || (scopeKeys && !scopeKeys.has(active.scopeKey))) return;
    const failure = error ?? new Error('Browser menu preview was cancelled because its profile is closing.');
    active.controller.abort();
    this.settleMenuPreviewCapture(active, { error: failure });
    // capturePage has no cancellation API. Destroy the exact target before
    // releasing the barrier so no late native work can access a clearing or
    // closing Chromium profile, or retain resources after its host disappears.
    this.reclaimMenuPreviewTarget(active, surfaceTargetError ? failure.message : undefined);
    await active.completion?.catch(() => undefined);
  }

  private addMenuPreviewSubscriber(
    active: BrowserMenuPreviewCapture,
    requestId: string,
  ): Promise<BrowserScreenshotResult> {
    const existing = active.subscribers.get(requestId);
    if (existing) return existing.promise;
    if (active.outcome) {
      const settled =
        'error' in active.outcome
          ? Promise.reject<BrowserScreenshotResult>(active.outcome.error)
          : Promise.resolve(active.outcome.result);
      void settled.catch(() => undefined);
      return settled;
    }
    let resolve!: (result: BrowserScreenshotResult) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<BrowserScreenshotResult>((subscriberResolve, subscriberReject) => {
      resolve = subscriberResolve;
      reject = subscriberReject;
    });
    // Cancellation can race IPC promise adoption. Attach a handler now while
    // returning the original rejecting promise to the requesting renderer.
    void promise.catch(() => undefined);
    active.subscribers.set(requestId, { promise, resolve, reject, settled: false });
    return promise;
  }

  private sameMenuSensitivityFrameSnapshot(
    contents: WebContents,
    expectedFrames: ReadonlyMap<number, string>,
  ): boolean {
    try {
      const current = this.snapshotAutomationFrames(contents).identities;
      if (current.size !== expectedFrames.size) return false;
      for (const [frameTreeNodeId, identity] of expectedFrames) {
        if (current.get(frameTreeNodeId) !== identity) return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  /** Ask every exact live preload realm for a bounded boolean-only sensitivity
   * result. Missing, malformed, incomplete, or frame-raced responses are unsafe
   * for presentation but never destroy or reload the page. */
  private async probeMenuPreviewSensitivity(
    tab: InternalTab,
    contents: WebContents,
    abortSignal: AbortSignal,
  ): Promise<{ sensitive: boolean; complete: boolean }> {
    throwIfBrowserAborted(abortSignal);
    let frames: WebFrameMain[];
    let expectedFrames: Map<number, string>;
    try {
      const snapshot = this.snapshotAutomationFrames(contents);
      frames = snapshot.frames;
      expectedFrames = snapshot.identities;
    } catch {
      return { sensitive: false, complete: false };
    }
    if (frames.length > MAX_CDP_SENSITIVE_SCAN_TARGETS) return { sensitive: false, complete: false };

    const token = randomUUID();
    let settled = false;
    let receivedEveryResponse = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abortListener: (() => void) | undefined;
    let resolveProbe!: () => void;
    let rejectProbe!: (error: Error) => void;
    const probe = new Promise<void>((resolve, reject) => {
      resolveProbe = resolve;
      rejectProbe = reject;
    });
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      abortSignal.removeEventListener('abort', abortListener!);
      this.pendingMenuSensitivityProbes.delete(token);
      if (error) rejectProbe(error);
      else resolveProbe();
    };
    const pending: PendingMenuSensitivityProbe = {
      contentsId: contents.id,
      expectedFrames,
      responses: new Map(),
      settle: () => {
        receivedEveryResponse = true;
        finish();
      },
    };
    this.pendingMenuSensitivityProbes.set(token, pending);
    timer = setTimeout(() => finish(), MENU_PREVIEW_SENSITIVITY_PROBE_TIMEOUT_MS);
    timer.unref?.();
    abortListener = () => finish(new Error('Browser menu preview was cancelled.'));
    abortSignal.addEventListener('abort', abortListener, { once: true });
    if (abortSignal.aborted) abortListener();

    if (!settled) {
      try {
        for (const frame of frames) frame.send('browser-page:probe-sensitive', { token });
      } catch {
        finish();
      }
    }
    await probe;
    throwIfBrowserAborted(abortSignal);
    if (
      !receivedEveryResponse ||
      pending.responses.size !== expectedFrames.size ||
      tab.view?.webContents !== contents ||
      contents.isDestroyed() ||
      !this.sameMenuSensitivityFrameSnapshot(contents, expectedFrames)
    ) {
      return { sensitive: false, complete: false };
    }
    const sensitive = [...pending.responses.values()].some((response) => response.sensitive);
    const complete = [...pending.responses.values()].every((response) => response.complete);
    if (sensitive) this.setTabSensitive(tab, true);
    return { sensitive, complete };
  }

  private async assertMenuPreviewNotSensitive(
    active: BrowserMenuPreviewCapture,
    tab: InternalTab,
    readyView: WebContentsView,
    pageLease: BrowserPageLease,
    pageIdentity: string,
    abortSignal: AbortSignal,
  ): Promise<void> {
    throwIfBrowserAborted(abortSignal);
    if (tab.view !== readyView || readyView.webContents.isDestroyed() || tab.viewLoadPromise || tab.shell.loading) {
      throw new Error('Browser menu preview is unavailable because the page changed or began loading.');
    }
    this.assertBrowserPageLease(tab, pageLease, 'Browser menu preview');
    this.assertBrowserMenuPreviewIdentity(tab, pageIdentity);
    const sensitivity = await this.probeMenuPreviewSensitivity(tab, readyView.webContents, abortSignal);
    throwIfBrowserAborted(abortSignal);
    if (sensitivity.sensitive || tab.shell.sensitive) {
      throw new Error('Browser menu previews are blocked while this tab contains password data.');
    }
    if (!sensitivity.complete) {
      throw new Error('Browser menu preview is unavailable because page sensitivity could not be verified.');
    }
    // The isolated preload cannot discover parser-created declarative closed
    // shadow roots because attachShadow is never called and shadowRoot stays
    // null. CDP's flattened, piercing scan covers those roots and related
    // OOPIF targets without returning DOM values to main.
    let cdpSensitive: boolean;
    try {
      cdpSensitive = await this.waitForMenuPreviewTarget(
        active,
        this.scanMenuPreviewSensitivityViaCdp(active, tab, readyView.webContents),
      );
    } catch (error) {
      if (active.teardownController.signal.aborted) throw error;
      throw new Error('Browser menu preview is unavailable because page sensitivity could not be verified.');
    }
    throwIfBrowserAborted(abortSignal);
    if (cdpSensitive) this.setTabSensitive(tab, true);
    if (cdpSensitive || tab.shell.sensitive) {
      throw new Error('Browser menu previews are blocked while this tab contains password data.');
    }
    this.assertBrowserPageLease(tab, pageLease, 'Browser menu preview');
    this.assertBrowserMenuPreviewIdentity(tab, pageIdentity);
  }

  private waitForMenuPreviewTarget<T>(active: BrowserMenuPreviewCapture, operation: Promise<T>): Promise<T> {
    if (active.teardownController.signal.aborted) {
      return Promise.reject(new Error('Browser menu preview target was reclaimed.'));
    }
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (result: { value: T } | { error: unknown }): void => {
        if (settled) return;
        settled = true;
        active.teardownController.signal.removeEventListener('abort', onTeardown);
        if ('error' in result) reject(result.error);
        else resolve(result.value);
      };
      const onTeardown = () => finish({ error: new Error('Browser menu preview target was reclaimed.') });
      active.teardownController.signal.addEventListener('abort', onTeardown, { once: true });
      void operation.then(
        (value) => finish({ value }),
        (error: unknown) => finish({ error }),
      );
      if (active.teardownController.signal.aborted) onTeardown();
    });
  }

  /** Stop awaiting a bounded preview probe/capture as soon as presentation is
   * cancelled. The caller separately detaches manager-owned CDP work. */
  private waitForMenuPreviewCancellation<T>(operation: Promise<T>, abortSignal: AbortSignal): Promise<T> {
    if (abortSignal.aborted) return Promise.reject(new Error('Browser menu preview was cancelled.'));
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (result: { value: T } | { error: unknown }): void => {
        if (settled) return;
        settled = true;
        abortSignal.removeEventListener('abort', onAbort);
        if ('error' in result) reject(result.error);
        else resolve(result.value);
      };
      const onAbort = () => finish({ error: new Error('Browser menu preview was cancelled.') });
      abortSignal.addEventListener('abort', onAbort, { once: true });
      void operation.then(
        (value) => finish({ value }),
        (error: unknown) => finish({ error }),
      );
      if (abortSignal.aborted) onAbort();
    });
  }

  /** CDP sensitivity scans have no cancellation primitive. Bound every menu
   * preview scan independently from presentation cancellation and fail the
   * preview closed without reclaiming a live user page on timeout. */
  private scanMenuPreviewSensitivityViaCdp(
    active: BrowserMenuPreviewCapture,
    tab: InternalTab,
    contents: WebContents,
  ): Promise<boolean> {
    const signal = AbortSignal.any([active.controller.signal, active.teardownController.signal]);
    let debuggerLease: BrowserDebuggerLease | undefined;
    return this.runRendererOperationWithDeadline(
      tab,
      contents,
      'Browser menu preview password-field scan',
      MENU_PREVIEW_CDP_SENSITIVITY_TIMEOUT_MS,
      () =>
        this.hasPopulatedPasswordFieldViaCdp(contents, (lease) => {
          debuggerLease = lease;
        }),
      signal,
      undefined,
      false,
    ).catch((error: unknown) => {
      // The preview is admitted only when the tab queue is idle and refuses a
      // pre-existing external debugger. Detach our private target connection to
      // make the native command deadline real without discarding page state.
      debuggerLease?.cancel();
      throw error;
    });
  }

  /** Capture a presentation-only viewport through a manager-owned CDP lease.
   * Detaching that lease is the cancellation primitive Chromium's native
   * capturePage API does not provide, so a wedged compositor cannot retain the
   * global preview slot or force us to destroy the user's live page. */
  private async captureMenuPreviewImage(
    active: BrowserMenuPreviewCapture,
    contents: WebContents,
    abortSignal: AbortSignal,
  ): Promise<NativeImage> {
    let debuggerLease: BrowserDebuggerLease | undefined;
    const onCancelled = () => debuggerLease?.cancel();
    abortSignal.addEventListener('abort', onCancelled, { once: true });
    try {
      throwIfBrowserAborted(abortSignal);
      debuggerLease = this.acquireBrowserDebuggerLease(contents);
      let encoded: string;
      try {
        const metrics = (await this.waitForMenuPreviewCancellation(
          this.waitForMenuPreviewTarget(active, contents.debugger.sendCommand('Page.getLayoutMetrics')),
          abortSignal,
        )) as Parameters<typeof browserScreenshotViewportGeometry>[0];
        const clip = browserScreenshotViewportGeometry(metrics);
        validateMenuPreviewNativeSize(clip.width, clip.height);
        const capture = (await this.waitForMenuPreviewCancellation(
          this.waitForMenuPreviewTarget(
            active,
            contents.debugger.sendCommand('Page.captureScreenshot', {
              format: 'png',
              captureBeyondViewport: true,
              fromSurface: true,
              optimizeForSpeed: true,
              clip,
            }),
          ),
          abortSignal,
        )) as { data?: unknown };
        if (typeof capture.data !== 'string') throw new Error('Browser menu preview did not produce an image.');
        encoded = capture.data;
      } finally {
        debuggerLease.release();
      }
      throwIfBrowserAborted(abortSignal);
      const capturedPng = Buffer.from(encoded, 'base64');
      validateScreenshotEncodedBytes(capturedPng.byteLength);
      const image = nativeImage.createFromBuffer(capturedPng);
      if (image.isEmpty()) throw new Error('Browser menu preview did not produce a valid image.');
      return image;
    } catch (error) {
      if (abortSignal.aborted) debuggerLease?.cancel();
      throw error;
    } finally {
      abortSignal.removeEventListener('abort', onCancelled);
    }
  }

  async captureMenuPreview(
    conversationId: string,
    tabId: string,
    requestId: string = randomUUID(),
  ): Promise<BrowserScreenshotResult> {
    if (typeof requestId !== 'string' || requestId.length === 0 || requestId.length > 128) {
      throw new Error('Browser menu preview request id is invalid.');
    }
    const tab = this.requireTab(conversationId, tabId);
    if (tab.shell.sensitive) {
      throw new Error('Browser menu previews are blocked while this tab contains password data.');
    }
    const pageIdentity = this.browserMenuPreviewIdentity(tab);
    const key = pageIdentity;
    if (this.menuPreviewCapture) {
      if (this.menuPreviewCapture.key === key) {
        if (
          this.menuPreviewCapture.controller.signal.aborted ||
          this.menuPreviewCapture.teardownController.signal.aborted
        ) {
          throw new Error('Browser menu preview is unavailable while a cancelled capture finishes.');
        }
        return this.addMenuPreviewSubscriber(this.menuPreviewCapture, requestId);
      }
      throw new Error('Another Browser menu preview is already being captured.');
    }

    // A chrome-only preview must never restore a discarded/auth-blocked page or
    // queue behind real tab work. The menu can show its protected placeholder
    // immediately when no already-ready renderer is opportunistically available.
    const readyView = tab.view;
    if (!readyView || readyView.webContents.isDestroyed() || tab.viewLoadPromise || tab.shell.loading) {
      throw new Error('Browser menu preview is unavailable while the page is loading or discarded.');
    }

    const contents = readyView.webContents;
    if (contents.debugger?.isAttached?.()) {
      throw new Error('Browser menu preview is unavailable while page debugging or automation overlay is active.');
    }
    const pageLease = this.captureBrowserPageLease(tab, contents);
    const active: BrowserMenuPreviewCapture = {
      key,
      tabId: tab.shell.id,
      contentsId: contents.id,
      scopeKey: tab.scopeKey,
      controller: new AbortController(),
      teardownController: new AbortController(),
      subscribers: new Map(),
      operation: null,
      completion: null,
    };
    this.menuPreviewCapture = active;
    const subscriberPromise = this.addMenuPreviewSubscriber(active, requestId);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const admitted = tab.queue.runOpportunistic(async (preemptionSignal): Promise<BrowserScreenshotResult> => {
      const signal = AbortSignal.any([active.controller.signal, active.teardownController.signal, preemptionSignal]);
      const onPreempted = () => {
        const failure = new Error('Browser menu preview was preempted by Browser work.');
        this.settleMenuPreviewCapture(active, { error: failure });
        active.controller.abort();
      };
      preemptionSignal.addEventListener('abort', onPreempted, { once: true });
      if (preemptionSignal.aborted) onPreempted();
      try {
        await this.waitForMenuPreviewCancellation(
          this.waitForMenuPreviewTarget(
            active,
            this.assertMenuPreviewNotSensitive(active, tab, readyView, pageLease, pageIdentity, signal),
          ),
          signal,
        );
        const allocation = this.screenshotQueue.runOpportunistic(async (allocationPreemptionSignal) => {
          const captureSignal = AbortSignal.any([signal, allocationPreemptionSignal]);
          const onAllocationPreempted = () => {
            const failure = new Error('Browser menu preview was preempted by screenshot work.');
            this.settleMenuPreviewCapture(active, { error: failure });
            active.controller.abort();
          };
          allocationPreemptionSignal.addEventListener('abort', onAllocationPreempted, { once: true });
          if (allocationPreemptionSignal.aborted) onAllocationPreempted();
          try {
            throwIfBrowserAborted(captureSignal);
            const image = await this.waitForMenuPreviewCancellation(
              this.waitForMenuPreviewTarget(active, this.captureMenuPreviewImage(active, contents, captureSignal)),
              captureSignal,
            );
            const capturedSize = validateMenuPreviewNativeSize(image.getSize().width, image.getSize().height);
            const previewScale = Math.min(
              1,
              MENU_PREVIEW_MAX_WIDTH / capturedSize.width,
              MENU_PREVIEW_MAX_HEIGHT / capturedSize.height,
            );
            const previewImage =
              previewScale < 1
                ? image.resize({
                    width: Math.max(1, Math.round(capturedSize.width * previewScale)),
                    height: Math.max(1, Math.round(capturedSize.height * previewScale)),
                    quality: 'good',
                  })
                : image;
            const { width, height } = validateScreenshotSize(
              previewImage.getSize().width,
              previewImage.getSize().height,
            );
            await this.waitForMenuPreviewCancellation(
              this.assertMenuPreviewNotSensitive(active, tab, readyView, pageLease, pageIdentity, captureSignal),
              captureSignal,
            );
            const png = previewImage.toPNG();
            validateScreenshotEncodedBytes(png.byteLength);
            return {
              tabId: tab.shell.id,
              mode: 'viewport' as const,
              mimeType: 'image/png' as const,
              dataUrl: `data:image/png;base64,${png.toString('base64')}`,
              width,
              height,
            };
          } finally {
            allocationPreemptionSignal.removeEventListener('abort', onAllocationPreempted);
          }
        });
        if (!allocation) {
          throw new Error('Browser menu preview is unavailable while screenshot capture is busy.');
        }
        return await this.waitForMenuPreviewCancellation(this.waitForMenuPreviewTarget(active, allocation), signal);
      } finally {
        preemptionSignal.removeEventListener('abort', onPreempted);
      }
    });
    const operation =
      admitted ??
      Promise.reject<BrowserScreenshotResult>(new Error('Browser menu preview is unavailable while this tab is busy.'));
    active.operation = operation;
    void operation.catch(() => undefined);
    timeout = setTimeout(() => {
      if (this.menuPreviewCapture !== active || active.teardownController.signal.aborted) return;
      const failure = new Error(
        `Browser menu preview capture exceeded ${MENU_PREVIEW_CAPTURE_TIMEOUT_MS / 1_000} seconds.`,
      );
      this.settleMenuPreviewCapture(active, { error: failure });
      active.controller.abort();
      // The abort listener detaches only BrowserManager's private debugger
      // connection. CDP capture is cancelled without reclaiming the user's page
      // or retaining this global preview slot.
    }, MENU_PREVIEW_CAPTURE_TIMEOUT_MS);
    timeout.unref?.();
    const teardown = new Promise<void>((resolve) => {
      const onTeardown = () => resolve();
      active.teardownController.signal.addEventListener('abort', onTeardown, { once: true });
      if (active.teardownController.signal.aborted) onTeardown();
    });
    const operationSettled = operation
      .then(
        (result) => {
          this.settleMenuPreviewCapture(active, { result });
        },
        (error: unknown) => {
          const failure = error instanceof Error ? error : new Error(String(error));
          this.settleMenuPreviewCapture(active, { error: failure });
        },
      )
      .then(() => undefined);
    active.completion = Promise.race([operationSettled, teardown])
      .finally(() => {
        if (timeout) clearTimeout(timeout);
        if (this.menuPreviewCapture === active) this.menuPreviewCapture = null;
      })
      .then(
        () => undefined,
        () => undefined,
      );
    return subscriberPromise;
  }

  async screenshot(
    conversationId: string,
    request: BrowserScreenshotRequest,
    source?: 'user' | 'assistant',
    assistantRun?: BrowserAssistantRun,
  ): Promise<BrowserScreenshotResult>;
  async screenshot<T>(
    conversationId: string,
    request: BrowserScreenshotRequest,
    source: 'user' | 'assistant',
    assistantRun: BrowserAssistantRun | undefined,
    postprocess: BrowserScreenshotPostprocessor<T>,
    approvedDocument?: BrowserDocumentApproval,
  ): Promise<T>;
  async screenshot<T>(
    conversationId: string,
    request: BrowserScreenshotRequest,
    source: 'user' | 'assistant' = 'user',
    assistantRun?: BrowserAssistantRun,
    postprocess?: BrowserScreenshotPostprocessor<T>,
    approvedDocument?: BrowserDocumentApproval,
  ): Promise<BrowserScreenshotResult | T> {
    request = parseBrowserScreenshotRequest(request);
    if (source === 'assistant' && !assistantRun) throw new Error('Assistant screenshots require turn ownership.');
    const abortSignal = assistantRun?.abortSignal;
    throwIfBrowserAborted(abortSignal);
    const tab =
      source === 'assistant'
        ? this.requireAssistantTab(conversationId, assistantRun!, request.tabId)
        : this.requireTab(conversationId, request.tabId);
    const nativeDialogPanelGeneration = this.panelAuthorityGeneration(conversationId);
    let exportFilePath: string | undefined;
    let exportPageLease: BrowserPageLease | undefined;
    const prepareExportSelection = async (
      reveal?: (contents: WebContents, documentLease: AssistantDocumentLease) => Promise<void>,
    ): Promise<boolean> => {
      if (!request.exportToFile) return false;
      const captureExportPageLease = async (documentLease?: AssistantDocumentLease): Promise<BrowserPageLease> => {
        if (documentLease) this.assertBrowserDocumentApproval(tab, approvedDocument);
        const contents = (
          source === 'assistant'
            ? await this.ensureAssistantView(tab, assistantRun!, documentLease!, undefined, approvedDocument)
            : await this.ensureView(tab)
        ).webContents;
        if (documentLease) this.assertBrowserDocumentApproval(tab, approvedDocument);
        if (reveal && documentLease) await reveal(contents, documentLease);
        if (documentLease) this.assertAssistantDocumentLease(tab, documentLease);
        return this.captureBrowserPageLease(tab, contents);
      };
      // Bind the native path chooser to the document visible when it opened.
      // Neither the per-tab operation queue nor the global screenshot queue is
      // held while the user interacts with the dialog, but any navigation,
      // discard, or renderer replacement invalidates the retained page lease.
      exportPageLease = await this.runTabOperation(tab, () =>
        source === 'assistant'
          ? this.withAssistantControl(tab, assistantRun!, captureExportPageLease, approvedDocument)
          : captureExportPageLease(),
      );
      this.assertHostRendererOperationCurrent();
      this.assertBrowserPageLease(tab, exportPageLease, 'screenshot export selection');
      const exportContents = tab.view?.webContents;
      if (!exportContents || !this.hasBrowserNativeDialogAuthority(tab, exportContents, nativeDialogPanelGeneration)) {
        return true;
      }
      const win = this.getWindow();
      const options = {
        title: 'Save browser screenshot',
        defaultPath: join(app.getPath('pictures'), `browser-${Date.now()}.png`),
        filters: [{ name: 'PNG Image', extensions: ['png'] }],
      };
      const chosen =
        win && !win.isDestroyed() ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options);
      throwIfBrowserAborted(abortSignal);
      this.assertHostRendererOperationCurrent();
      if (this.tabs.get(tab.shell.id) !== tab) throw new Error('The browser tab closed while choosing an export path.');
      this.assertBrowserPageLease(tab, exportPageLease, 'screenshot export selection');
      if (chosen.canceled || !chosen.filePath) {
        return true;
      }
      exportFilePath = chosen.filePath;
      return false;
    };
    const finishCanceledExport = (): Promise<BrowserScreenshotResult | T> | BrowserScreenshotResult | T => {
      const canceled: BrowserScreenshotResult = {
        tabId: tab.shell.id,
        mode: request.mode,
        mimeType: 'image/png',
        width: 0,
        height: 0,
        canceled: true,
      };
      return postprocess ? postprocess(canceled, abortSignal) : canceled;
    };
    const operation = async (
      documentLease?: AssistantDocumentLease,
      reveal?: (contents: WebContents, documentLease: AssistantDocumentLease) => Promise<void>,
    ): Promise<PendingBrowserScreenshot> => {
      throwIfBrowserAborted(abortSignal);
      if (documentLease) this.assertBrowserDocumentApproval(tab, approvedDocument);
      const contents = (
        source === 'assistant'
          ? await this.ensureAssistantView(tab, assistantRun!, documentLease!, undefined, approvedDocument)
          : await this.ensureView(tab)
      ).webContents;
      if (documentLease) this.assertBrowserDocumentApproval(tab, approvedDocument);
      if (reveal && documentLease) await reveal(contents, documentLease);
      if (exportPageLease) this.assertBrowserPageLease(tab, exportPageLease, 'screenshot export selection');
      const pageLease = exportPageLease ?? this.captureBrowserPageLease(tab, contents);
      if (request.documentToken && request.documentToken !== this.browserPageLeaseToken(pageLease)) {
        throw new Error('The browser page changed after the element was picked. Pick the element again.');
      }
      const assertPageCurrent = (): void => this.assertBrowserPageLease(tab, pageLease, 'screenshot');
      const { png, width, height } = await this.runRendererOperationWithDeadline(
        tab,
        contents,
        'Browser screenshot',
        SCREENSHOT_TIMEOUT_MS,
        async () => {
          assertPageCurrent();
          await this.assertTabNotSensitive(tab, contents, 'Screenshots', abortSignal, documentLease);
          assertPageCurrent();
          const hidden = await this.hideAutomationOverlay(tab, contents);
          assertPageCurrent();
          let capturedPng: Buffer | undefined;
          let capturedWidth: number | undefined;
          let capturedHeight: number | undefined;
          let capturedEncodedBytes = 0;
          const decodeCapture = (data: string): Buffer => {
            capturedEncodedBytes += Buffer.byteLength(data, 'base64');
            validateScreenshotEncodedBytes(capturedEncodedBytes);
            return Buffer.from(data, 'base64');
          };
          try {
            // Resolve element geometry against the live page. Screenshot work
            // never changes the renderer lifecycle state: a user may select and
            // interact with this tab while a hidden/background capture runs.
            let elementRect: { x: number; y: number; width: number; height: number } | null | undefined;
            if (request.mode === 'element') {
              if (!request.selector) throw new Error('A CSS selector is required for component screenshots.');
              elementRect = (await contents.executeJavaScript(`(() => {
              let element;
              try { element = document.querySelector(${JSON.stringify(request.selector)}); }
              catch { throw new Error('Invalid CSS selector'); }
              if (!element) return null;
              const r = element.getBoundingClientRect();
              const style = getComputedStyle(element);
              if (r.width <= 0 || r.height <= 0 || style.display === 'none' || style.visibility === 'hidden') return null;
              // Preserve negative origins here. elementCaptureRect intersects
              // every edge against the document; clamping first would retain
              // the original width/height and capture neighboring pixels.
              return { x: r.left + scrollX, y: r.top + scrollY, width: r.width, height: r.height };
            })()`)) as typeof elementRect;
              if (!elementRect) throw new Error('No visible element matched the screenshot selector.');
            }
            assertPageCurrent();
            const captureHidden = this.attachedView !== tab.view || !this.isHostWindowShown();
            const capturePixels = async (): Promise<void> => {
              if (request.mode === 'full-page' || request.mode === 'element') {
                const releaseDebugger = this.acquireBrowserDebugger(contents);
                try {
                  if (request.mode === 'element') {
                    if (!elementRect) throw new Error('No visible element matched the screenshot selector.');
                    const metrics = (await contents.debugger.sendCommand('Page.getLayoutMetrics')) as {
                      cssContentSize?: { width: number; height: number };
                      contentSize?: { width: number; height: number };
                    };
                    const captureGeometry = browserScreenshotCaptureGeometry(metrics);
                    const clip = elementCaptureRect(elementRect, {
                      width: captureGeometry.width,
                      height: captureGeometry.height,
                    });
                    capturedWidth = clip.width;
                    capturedHeight = clip.height;
                    const capture = (await contents.debugger.sendCommand('Page.captureScreenshot', {
                      format: 'png',
                      captureBeyondViewport: true,
                      fromSurface: true,
                      clip: { ...clip, scale: captureGeometry.scale },
                    })) as { data: string };
                    capturedPng = decodeCapture(capture.data);
                  } else {
                    const metrics = (await contents.debugger.sendCommand('Page.getLayoutMetrics')) as {
                      cssContentSize?: { width: number; height: number };
                      contentSize?: { width: number; height: number };
                    };
                    const captureGeometry = browserScreenshotCaptureGeometry(metrics);
                    ({ width: capturedWidth, height: capturedHeight } = captureGeometry);
                    const tiles = browserScreenshotTiles(capturedWidth, capturedHeight);
                    const captured: Array<{
                      input: Buffer;
                      left: number;
                      top: number;
                    }> = [];
                    for (const tile of tiles) {
                      const capture = (await contents.debugger.sendCommand('Page.captureScreenshot', {
                        format: 'png',
                        captureBeyondViewport: true,
                        fromSurface: true,
                        clip: { ...tile, scale: captureGeometry.scale },
                      })) as { data: string };
                      captured.push({
                        input: decodeCapture(capture.data),
                        left: tile.x,
                        top: tile.y,
                      });
                    }
                    if (captured.length === 1) capturedPng = captured[0].input;
                    else {
                      const sharp = (await import('sharp')).default;
                      capturedPng = await sharp({
                        create: {
                          width: capturedWidth,
                          height: capturedHeight,
                          channels: 4,
                          background: { r: 255, g: 255, b: 255, alpha: 0 },
                        },
                      })
                        .composite(captured)
                        .png()
                        .toBuffer();
                    }
                  }
                } finally {
                  releaseDebugger();
                }
              } else {
                // Always use the cancellable debugger path for viewport capture.
                // Native capturePage() can remain pending when a visible Kai
                // window is minimized or hidden mid-capture, forcing the generic
                // renderer deadline to reclaim a live user page. CDP works for
                // both presented and fully headless/background tabs; the hidden
                // capture host below is only a compositor host, never an
                // authority or sidebar-mount prerequisite.
                const releaseDebugger = this.acquireBrowserDebugger(contents);
                try {
                  const metrics = (await contents.debugger.sendCommand('Page.getLayoutMetrics')) as Parameters<
                    typeof browserScreenshotViewportGeometry
                  >[0];
                  const clip = browserScreenshotViewportGeometry(metrics);
                  capturedWidth = clip.width;
                  capturedHeight = clip.height;
                  const capture = (await contents.debugger.sendCommand('Page.captureScreenshot', {
                    format: 'png',
                    captureBeyondViewport: true,
                    fromSurface: true,
                    clip,
                  })) as { data: string };
                  capturedPng = decodeCapture(capture.data);
                } finally {
                  releaseDebugger();
                }
              }
              if (!capturedPng || capturedWidth === undefined || capturedHeight === undefined) {
                throw new Error('The browser screenshot did not produce an image.');
              }
              validateScreenshotEncodedBytes(capturedPng.byteLength);
            };
            if (captureHidden) await this.withBackgroundCaptureHost(tab, contents, capturePixels);
            else await capturePixels();
            if (!capturedPng || capturedWidth === undefined || capturedHeight === undefined) {
              throw new Error('The browser screenshot did not produce an image.');
            }
            assertPageCurrent();
            // Re-run both the preload and piercing CDP sensitivity checks after
            // pixels are captured. The sensitive latch is monotonic for the
            // document, so user-entered/vault-filled password data that appears
            // while capture is in flight causes the pixels to be discarded.
            await this.assertTabNotSensitive(tab, contents, 'Screenshots', abortSignal, documentLease);
            assertPageCurrent();
            return {
              png: capturedPng,
              width: capturedWidth,
              height: capturedHeight,
            };
          } finally {
            // Never run overlay restoration in a replacement document that
            // happened to reuse Kai's internal element id.
            if (this.isBrowserPageLeaseCurrent(tab, pageLease)) {
              await this.restoreAutomationOverlay(tab, contents, hidden);
            }
          }
        },
        abortSignal,
        documentLease,
      );
      throwIfBrowserAborted(abortSignal);
      assertPageCurrent();
      if (documentLease) {
        this.assertBrowserDocumentApproval(tab, approvedDocument);
        this.assertAssistantDocumentLease(tab, documentLease);
      }

      const retainedScreenshot = request.saveToFile
        ? prepareBrowserScreenshotRetention(this.appHome, conversationId, tab.scopeKey)
        : undefined;
      const retainedFilePath = retainedScreenshot?.filePath;
      const filePath = exportFilePath ?? retainedFilePath;
      const result: BrowserScreenshotResult = {
        tabId: tab.shell.id,
        mode: request.mode,
        mimeType: 'image/png',
        // Native exports need only the selected file path. Avoid allocating and
        // structured-cloning a second base64 copy that can be hundreds of MB at
        // the full-page pixel ceiling.
        ...(request.exportToFile ? {} : { dataUrl: `data:image/png;base64,${png.toString('base64')}` }),
        width,
        height,
        filePath,
      };
      let persisted = false;
      return {
        result,
        persist: () => {
          if (persisted) return;
          throwIfBrowserAborted(abortSignal);
          this.assertHostRendererOperationCurrent();
          assertPageCurrent();
          if (documentLease) this.assertAssistantDocumentLease(tab, documentLease);
          retainedScreenshot?.persist(png);
          if (exportFilePath) atomicWriteFileSync(exportFilePath, png, { mode: 0o600 });
          persisted = true;
        },
      };
    };
    const captureAndProcess = async (
      documentLease?: AssistantDocumentLease,
      reveal?: (contents: WebContents, documentLease: AssistantDocumentLease) => Promise<void>,
    ): Promise<BrowserScreenshotResult | T> => {
      const pending = await operation(documentLease, reveal);
      throwIfBrowserAborted(abortSignal);
      const processed = postprocess ? await postprocess(pending.result, abortSignal) : pending.result;
      throwIfBrowserAborted(abortSignal);
      this.assertHostRendererOperationCurrent();
      pending.persist();
      return processed;
    };
    const queueCapture = () => this.runScreenshotAllocation(() => captureAndProcess());
    if (source === 'assistant') {
      return this.withVisibleAssistantOperation(
        conversationId,
        tab,
        assistantRun!,
        'screenshot',
        `capturing ${request.mode}`,
        async (reveal) => {
          if (await prepareExportSelection(reveal)) return finishCanceledExport();
          return this.runTabOperation(tab, () =>
            this.runScreenshotAllocation(() =>
              this.withAssistantControl(
                tab,
                assistantRun!,
                (documentLease) => captureAndProcess(documentLease, reveal),
                approvedDocument,
              ),
            ),
          );
        },
      );
    }
    if (await prepareExportSelection()) return finishCanceledExport();
    return this.runTabOperation(tab, queueCapture);
  }

  private runScreenshotAllocation<T>(operation: () => Promise<T>): Promise<T> {
    const preview = this.menuPreviewCapture;
    if (!preview) return this.screenshotQueue.run(operation);

    const failure = new Error('Browser menu preview was preempted by screenshot work.');
    this.settleMenuPreviewCapture(preview, { error: failure });
    preview.controller.abort();
    // The preview's abort listener detaches manager-owned CDP work, releasing
    // the opportunistic permit without discarding unsaved DOM/SPA state.
    return this.screenshotQueue.run(operation);
  }

  async pickElement(conversationId: string, tabId: string): Promise<BrowserElementPickResult> {
    const tab = this.requireTab(conversationId, tabId);
    return this.runTabOperation(tab, async () => {
      const contents = (await this.ensureView(tab)).webContents;
      const pageLease = this.captureBrowserPageLease(tab, contents);
      const assertPageCurrent = (): void => this.assertBrowserPageLease(tab, pageLease, 'element picking');
      assertPageCurrent();
      await this.assertTabNotSensitive(tab, contents, 'Element picking');
      assertPageCurrent();
      const pickedValue = await new Promise<string>((resolve, reject) => {
        const picker: PendingElementPicker = {
          tab,
          contents,
          pageLease,
          frames: new Map(),
          clickedToken: null,
          settled: false,
          timer: null,
          cancel: () => undefined,
          resolve,
          reject,
        };
        picker.cancel = (error = new Error('Element picking cancelled.')) =>
          this.finishElementPicker(picker, { error });
        this.pendingElementPickerCancels.get(tab.shell.id)?.();
        this.pendingElementPickerCancels.set(tab.shell.id, picker.cancel);

        const frames = [contents.mainFrame, ...contents.mainFrame.framesInSubtree];
        const seenFrameTreeNodeIds = new Set<number>();
        let armedMainFrame = false;
        for (const frame of frames) {
          if (frame.detached || frame.isDestroyed() || seenFrameTreeNodeIds.has(frame.frameTreeNodeId)) {
            continue;
          }
          seenFrameTreeNodeIds.add(frame.frameTreeNodeId);
          const token = randomUUID();
          const isMainFrame = frame.frameTreeNodeId === contents.mainFrame.frameTreeNodeId;
          try {
            frame.send('browser-page:element-picker-arm', {
              token,
              timeoutMs: ELEMENT_PICKER_TIMEOUT_MS,
            });
          } catch {
            continue;
          }
          picker.frames.set(token, { frame, isMainFrame });
          this.pendingElementPickerFrames.set(token, { picker, frame, isMainFrame });
          if (isMainFrame) armedMainFrame = true;
        }
        if (!armedMainFrame) {
          picker.cancel(new Error('The browser page changed before element picking could start.'));
          return;
        }
        picker.timer = setTimeout(
          () => picker.cancel(new Error('Element picking timed out.')),
          ELEMENT_PICKER_TIMEOUT_MS,
        );
        picker.timer.unref?.();
      });
      const selector = validatePickedElementSelector(pickedValue);
      assertPageCurrent();
      await this.assertTabNotSensitive(tab, contents, 'Element picking');
      assertPageCurrent();
      return { selector, documentToken: this.browserPageLeaseToken(pageLease) };
    });
  }

  async find(
    conversationId: string,
    tabId: string,
    text: string,
    forward = true,
    findNext = false,
    requestId?: number,
  ): Promise<void> {
    if (!Number.isSafeInteger(requestId) || requestId! < 1) {
      throw new Error('Browser find request id must be a positive safe integer.');
    }
    const tab = this.requireTab(conversationId, tabId);
    this.activeFindRequests.set(tab.shell.id, { requestId: requestId!, electronRequestId: null });
    if (!text) {
      tab.view?.webContents.stopFindInPage('clearSelection');
      return;
    }
    const view = await this.ensureView(tab);
    const activeFind = this.activeFindRequests.get(tab.shell.id);
    if (!activeFind || activeFind.requestId !== requestId) return;
    activeFind.electronRequestId = view.webContents.findInPage(text, { forward, findNext });
    this.attachActiveView(conversationId);
  }

  stopFind(conversationId: string, tabId: string): void {
    const tab = this.requireTab(conversationId, tabId);
    this.activeFindRequests.delete(tab.shell.id);
    tab.view?.webContents.stopFindInPage('clearSelection');
  }

  async setZoom(conversationId: string, tabId: string, level: number): Promise<number> {
    if (!Number.isFinite(level)) throw new Error('Browser zoom must be a finite number.');
    const tab = this.requireTab(conversationId, tabId);
    return this.withScopeActivity(tab.scopeKey, async () => {
      const normalized = Math.max(-5, Math.min(5, Math.round(level * 2) / 2));
      const previous = tab.shell.zoomLevel;
      const view = await this.ensureView(tab);
      view.webContents.setZoomLevel(normalized);
      try {
        this.storeForScope(tab.scopeKey).setZoomLevel(normalized);
      } catch (error) {
        try {
          view.webContents.setZoomLevel(previous);
        } catch {
          if (tab.view === view) {
            this.destroyView(tab);
            tab.shell.discarded = true;
            this.emitTabs(conversationId);
          }
        }
        throw error;
      }
      if (normalized !== previous) this.invalidatePanelLayout(conversationId);
      tab.shell.zoomLevel = normalized;
      this.emitTabs(conversationId);
      return normalized;
    });
  }

  listHistory(conversationId: string, query?: string): BrowserHistoryEntry[] {
    return this.store(conversationId).listHistory(query);
  }

  clearHistory(conversationId: string): Promise<void> {
    return this.store(conversationId).clearHistory();
  }

  listBookmarks(conversationId: string, query?: string): BrowserBookmark[] {
    return this.store(conversationId).listBookmarks(query);
  }

  addBookmark(conversationId: string, title: string, url: string, folder?: string): BrowserBookmark {
    const bookmark = this.store(conversationId).addBookmark(title, url, folder);
    this.emitBookmarksForScope(conversationId);
    return bookmark;
  }

  updateBookmark(conversationId: string, bookmark: BrowserBookmark): BrowserBookmark {
    const updated = this.store(conversationId).updateBookmark(bookmark);
    this.emitBookmarksForScope(conversationId);
    return updated;
  }

  removeBookmark(conversationId: string, id: string): void {
    this.store(conversationId).removeBookmark(id);
    this.emitBookmarksForScope(conversationId);
  }

  reorderBookmarks(conversationId: string, ids: string[]): void {
    this.store(conversationId).reorderBookmarks(ids);
    this.emitBookmarksForScope(conversationId);
  }

  async importBookmarks(conversationId: string): Promise<{ imported: number; canceled?: boolean }> {
    const scopeKey = this.scopeKey(conversationId);
    return this.withScopeActivity(scopeKey, async () => {
      const win = this.getWindow();
      const options: Electron.OpenDialogOptions = {
        title: 'Import bookmarks',
        properties: ['openFile'],
        filters: [{ name: 'HTML', extensions: ['html', 'htm'] }],
      };
      const selected =
        win && !win.isDestroyed() ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
      this.assertHostRendererOperationCurrent();
      if (selected.canceled || !selected.filePaths[0]) return { imported: 0, canceled: true };
      const filePath = selected.filePaths[0];
      const html = readBoundedBookmarksHtmlFileSync(filePath);
      this.assertScopeAvailable(scopeKey);
      const imported = this.storeForScope(scopeKey).replaceBookmarks(parseBookmarksHtml(html));
      this.emitBookmarksForScope(conversationId);
      return { imported };
    });
  }

  async exportBookmarks(conversationId: string): Promise<{ exported: number; canceled?: boolean; filePath?: string }> {
    const scopeKey = this.scopeKey(conversationId);
    return this.withScopeActivity(scopeKey, async () => {
      const bookmarks = this.storeForScope(scopeKey).listBookmarks();
      const win = this.getWindow();
      const options = {
        title: 'Export bookmarks',
        defaultPath: join(app.getPath('documents'), 'kai-bookmarks.html'),
        filters: [{ name: 'HTML', extensions: ['html'] }],
      };
      const selected =
        win && !win.isDestroyed() ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options);
      this.assertHostRendererOperationCurrent();
      if (selected.canceled || !selected.filePath) return { exported: 0, canceled: true };
      atomicWriteFileSync(selected.filePath, renderBookmarksHtml(bookmarks), {
        mode: 0o600,
      });
      return { exported: bookmarks.length, filePath: selected.filePath };
    });
  }

  listDownloads(conversationId: string): BrowserDownload[] {
    return this.store(conversationId).listDownloads();
  }

  private cacheDownload(scopeKey: string, download: BrowserDownload): void {
    this.downloads.delete(download.id);
    this.downloads.set(download.id, { ...download, scopeKey });
    const scopeIds = [...this.downloads].filter(([, cached]) => cached.scopeKey === scopeKey).map(([id]) => id);
    for (const staleId of scopeIds.slice(0, -MAX_CACHED_DOWNLOADS_PER_SCOPE)) this.downloads.delete(staleId);
  }

  private protectedAssistantDownloadPaths(scopeKey: string): Set<string> {
    const protectedPaths = new Set(
      [...this.activeDownloads.values()]
        .filter((download) => download.scopeKey === scopeKey && download.quarantinePath)
        .map((download) => download.quarantinePath!),
    );
    for (const [path, leases] of this.downloadExportLeases.get(scopeKey) ?? []) {
      if (leases > 0) protectedPaths.add(path);
    }
    return protectedPaths;
  }

  private acquireDownloadExportLease(scopeKey: string, path: string): () => void {
    const leases = this.downloadExportLeases.get(scopeKey) ?? new Map<string, number>();
    leases.set(path, (leases.get(path) ?? 0) + 1);
    this.downloadExportLeases.set(scopeKey, leases);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const current = this.downloadExportLeases.get(scopeKey);
      if (!current) return;
      const remaining = (current.get(path) ?? 1) - 1;
      if (remaining > 0) current.set(path, remaining);
      else current.delete(path);
      if (current.size === 0) this.downloadExportLeases.delete(scopeKey);
    };
  }

  private isDownloadExportLeased(scopeKey: string, path: string): boolean {
    return (this.downloadExportLeases.get(scopeKey)?.get(path) ?? 0) > 0;
  }

  private purgeCachedDownloadsForScope(scopeKey: string): void {
    for (const [id, download] of this.downloads) {
      if (download.scopeKey === scopeKey) this.downloads.delete(id);
    }
  }

  private async reconcilePrunedAssistantDownloads(
    scopeKey: string,
    pruned: readonly PrunedAssistantDownload[],
    conversationId?: string,
  ): Promise<void> {
    if (pruned.length === 0) return;
    const store = this.storeForScope(scopeKey);
    const changedIds: string[] = [];
    for (const download of pruned) {
      const updated = store.clearQuarantinedDownloadPath(download.id, download.path);
      if (!updated) continue;
      if (this.downloads.get(download.id)?.scopeKey === scopeKey) this.downloads.delete(download.id);
      changedIds.push(download.id);
    }
    if (changedIds.length === 0) return;
    try {
      await store.flushDownloads();
    } finally {
      // A persistence failure is reported separately by BrowserProfileStore,
      // but the current app session must immediately stop advertising a file
      // that the quarantine has already removed.
      for (const downloadId of changedIds) {
        this.emitDownloadHistoryChangedForScope(scopeKey, conversationId, downloadId, 'unavailable');
      }
    }
  }

  /** Prune physical artifacts and audit every persisted quarantined shelf
   * entry. The latter catches a crash after an earlier process removed the
   * file but before it flushed the matching metadata mutation. */
  private async reconcileAssistantDownloadQuarantineAtStartup(): Promise<void> {
    const scopeKeys = new Set<string>();
    const failures: unknown[] = [];
    try {
      await reconcileAssistantDownloadExportJournal(this.appHome);
    } catch (error) {
      failures.push(new Error('Assistant download export recovery failed.', { cause: error }));
    }
    for (const discover of [
      () => listStoredBrowserScopeKeys(this.appHome),
      () => listAssistantDownloadQuarantineScopeKeys(this.appHome),
    ]) {
      try {
        for (const scopeKey of discover()) scopeKeys.add(scopeKey);
      } catch (error) {
        failures.push(error);
      }
    }
    for (const scopeKey of scopeKeys) {
      try {
        const pruned = pruneAssistantDownloadQuarantine(
          this.appHome,
          scopeKey,
          this.protectedAssistantDownloadPaths(scopeKey),
        );
        const persistedDownloads = await readStoredBrowserDownloadsAsync(this.appHome, scopeKey);
        const activeIds = new Set(
          [...this.activeDownloads.values()]
            .filter((download) => download.scopeKey === scopeKey)
            .map((download) => download.id),
        );
        const prunedById = new Map(pruned.map((download) => [download.id, download]));
        const needsMetadataRepair = persistedDownloads.some((download) => {
          if (!download.quarantined) return false;
          if (download.state === 'progressing' && !activeIds.has(download.id)) return true;
          const prunedDownload = prunedById.get(download.id);
          if (prunedDownload && (!download.path || download.path === prunedDownload.path)) return true;
          return !!(
            download.path &&
            !isAssistantDownloadQuarantineFileAvailable(this.appHome, scopeKey, download.id, download.path)
          );
        });
        // Most historical profiles have no quarantined shelf entries. Avoid
        // synchronously constructing and permanently caching their complete
        // history/bookmark/permission stores during app startup.
        if (!needsMetadataRepair) continue;

        const store = this.storeForScope(scopeKey, true);
        const unavailable = new Map<string, PrunedAssistantDownload>();
        const changedIds = new Set<string>();
        try {
          for (const download of pruned) unavailable.set(download.id, download);
          for (const download of store.listDownloads()) {
            if (!download.quarantined) continue;
            if (download.state === 'progressing') {
              const active = [...this.activeDownloads.values()].some(
                (candidate) => candidate.scopeKey === scopeKey && candidate.id === download.id,
              );
              if (active) continue;
              let partialPath: string | null = null;
              try {
                partialPath = assistantDownloadQuarantinePath(this.appHome, scopeKey, download.id);
              } catch {
                // Persisted metadata may predate strict UUID validation. No file
                // in the owned quarantine can correspond to an invalid id.
              }
              if (partialPath) removeAssistantDownloadFile(partialPath);
              const updated = store.markQuarantinedDownloadInterrupted(download.id);
              if (updated) changedIds.add(download.id);
              continue;
            }
            if (
              download.path &&
              !isAssistantDownloadQuarantineFileAvailable(this.appHome, scopeKey, download.id, download.path)
            ) {
              unavailable.set(download.id, { id: download.id, path: download.path });
            }
          }
          for (const download of unavailable.values()) {
            const updated = store.clearQuarantinedDownloadPath(download.id, download.path);
            if (updated) changedIds.add(download.id);
          }
          if (changedIds.size > 0) {
            try {
              await store.flushDownloads();
            } finally {
              for (const downloadId of changedIds) {
                if (this.downloads.get(downloadId)?.scopeKey === scopeKey) this.downloads.delete(downloadId);
                this.emitDownloadHistoryChangedForScope(scopeKey, undefined, downloadId, 'unavailable');
              }
            }
          }
        } finally {
          this.releaseStartupOnlyStore(scopeKey, store);
        }
      } catch (error) {
        failures.push(
          new Error(`Assistant download recovery failed for Browser profile ${scopeKey}.`, { cause: error }),
        );
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, 'One or more Browser profiles could not reconcile assistant downloads.');
    }
  }

  private cancelActiveDownloadsForScopes(scopeKeys: ReadonlySet<string>): Promise<void> {
    const cancellations = [...(this.activeDownloads?.values() ?? [])]
      .filter((download) => scopeKeys.has(download.scopeKey))
      .map((download) => download.cancel(true));
    return Promise.all(cancellations).then(() => undefined);
  }

  private cancelActiveDownloadsForAssistantRun(conversationId: string, runId: string): Promise<void> {
    const cancellations = [...(this.activeDownloads?.values() ?? [])]
      .filter(
        (download) =>
          download.conversationId === conversationId && download.assistantOwnerId === runId && !download.keepOpen,
      )
      .map((download) => download.cancel());
    return Promise.all(cancellations).then(() => undefined);
  }

  private activeAssistantDownloads(): ActiveBrowserDownload[] {
    return [...(this.activeDownloads?.values() ?? [])].filter(
      (download) => download.assistantOwnerId !== null && !download.keepOpen,
    );
  }

  private cancelActiveAssistantDownloads(downloads = this.activeAssistantDownloads()): Promise<void> {
    const cancellations = downloads.map((download) => download.cancel());
    return Promise.all(cancellations).then(() => undefined);
  }

  private scheduleAssistantDownloadCleanupRetry(downloads: Iterable<ActiveBrowserDownload> = []): void {
    const active = new Set(this.activeDownloads?.values() ?? []);
    const targets = (this.assistantDownloadCleanupRetryTargets ??= new Set());
    for (const download of downloads) {
      if (active.has(download) && download.assistantOwnerId !== null && !download.keepOpen) targets.add(download);
    }
    for (const download of targets) {
      if (!active.has(download) || download.assistantOwnerId === null || download.keepOpen) targets.delete(download);
    }
    if (this.disposed || this.shuttingDown || this.assistantDownloadCleanupRetryTimer || targets.size === 0) return;
    this.assistantDownloadCleanupRetryTimer = setTimeout(() => {
      this.assistantDownloadCleanupRetryTimer = null;
      if (this.disposed || this.shuttingDown) return;
      const activeAtRetry = new Set(this.activeDownloads?.values() ?? []);
      const retryTargets = [...targets].filter((download) => {
        const stillRevoked = activeAtRetry.has(download) && download.assistantOwnerId !== null && !download.keepOpen;
        if (!stillRevoked) targets.delete(download);
        return stillRevoked;
      });
      if (retryTargets.length === 0) return;
      void this.cancelActiveAssistantDownloads(retryTargets).then(
        () => {
          for (const download of retryTargets) targets.delete(download);
        },
        (error: unknown) => {
          console.warn('[Browser] Assistant download cancellation will be retried:', error);
          this.scheduleAssistantDownloadCleanupRetry();
        },
      );
    }, ASSISTANT_CONTINUATION_CLEANUP_RETRY_MS);
    this.assistantDownloadCleanupRetryTimer.unref?.();
  }

  private cancelActiveDownloadsForConversation(conversationId: string): Promise<void> {
    const cancellations = [...(this.activeDownloads?.values() ?? [])]
      .filter((download) => download.conversationId === conversationId)
      .map((download) => download.cancel());
    return Promise.all(cancellations).then(() => undefined);
  }

  private waitForActiveDownloads(scopeKeys?: ReadonlySet<string>): Promise<void> {
    const downloads = [...(this.activeDownloads?.values() ?? [])].filter(
      (download) => !scopeKeys || scopeKeys.has(download.scopeKey),
    );
    return Promise.all(
      downloads.map((download) =>
        waitForBrowserDownloadTerminal(download.done, `Browser download ${download.id} completion`),
      ),
    ).then(() => undefined);
  }

  private requireDownloadForScope(scopeKey: string, downloadId: string): BrowserDownload {
    const download =
      ([...this.downloads.values()].find((item) => item.id === downloadId && item.scopeKey === scopeKey) as
        | CachedBrowserDownload
        | undefined) ??
      this.storeForScope(scopeKey)
        .listDownloads()
        .find((item) => item.id === downloadId);
    if (!download) throw new Error('This download is no longer available.');
    return download;
  }

  showDownload(conversationId: string, downloadId: string): void {
    const scopeKey = this.scopeKey(conversationId);
    this.assertScopeAvailable(scopeKey);
    const download = this.requireDownloadForScope(scopeKey, downloadId);
    if (!download.path) throw new Error('The downloaded file is unavailable because no saved path was recorded.');
    if (download.quarantined) {
      throw new Error('Assistant downloads must be explicitly exported before they can be opened.');
    }
    shell.showItemInFolder(download.path);
  }

  async exportDownload(conversationId: string, downloadId: string): Promise<{ canceled?: boolean; filePath?: string }> {
    const scopeKey = this.scopeKey(conversationId);
    return this.withScopeActivity(scopeKey, async () => {
      // Startup reconciliation owns every crash-left export journal until it
      // completes. Do not let a fresh export race that recovery pass.
      // Recovery is best-effort: a malformed or temporarily unreadable
      // crash-left journal must not permanently poison every later export in
      // this app process. The constructor already reports the failure through
      // profileMutationTail; wait for settlement here, then validate the exact
      // requested quarantine file independently below.
      await this.startupDownloadReconciliation.catch(() => undefined);
      const download = this.requireDownloadForScope(scopeKey, downloadId);
      if (!download.quarantined || download.state !== 'completed' || !download.path) {
        throw new Error('Only completed assistant downloads can be exported.');
      }
      if (!isAssistantDownloadQuarantinePath(this.appHome, scopeKey, download.id, download.path)) {
        throw new Error('The assistant download quarantine path is invalid.');
      }
      // Startup reconciliation may have delayed this click long enough for Kai
      // to become hidden/minimized, lose focus, or switch away from this
      // Browser panel. Native dialogs require fresh focused Browser-chrome
      // authority; background automation never opens one. The Downloads
      // manager deliberately detaches the page WebContentsView, so its focused
      // Browser chrome -- not mounted page bounds -- is the authority signal.
      this.assertHostRendererOperationCurrent();
      if (!this.isHostWindowInteractive() || this.chromeFocusConversationId !== conversationId) {
        return { canceled: true };
      }
      // The save dialog can remain open while another download completes and
      // enforces quarantine quotas. Protect this exact source until copying (or
      // cancellation/failure) finishes so pruning cannot invalidate the user's
      // already-visible export operation.
      const releaseExportLease = this.acquireDownloadExportLease(scopeKey, download.path);
      try {
        const win = this.getWindow();
        const options: Electron.SaveDialogOptions = {
          title: 'Export assistant download',
          defaultPath: join(app.getPath('downloads'), basename(download.filename) || 'Kai-download'),
        };
        const selected =
          win && !win.isDestroyed() ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options);
        this.assertHostRendererOperationCurrent();
        this.assertScopeAvailable(scopeKey);
        if (selected.canceled || !selected.filePath) return { canceled: true };
        await exportAssistantDownloadFile(this.appHome, download.path, selected.filePath);
        return { filePath: selected.filePath };
      } finally {
        releaseExportLease();
      }
    });
  }

  async deleteDownload(conversationId: string, downloadId: string): Promise<void> {
    const scopeKey = this.scopeKey(conversationId);
    await this.withScopeActivity(scopeKey, async () => {
      this.requireDownloadForScope(scopeKey, downloadId);
      const active = [...this.activeDownloads.values()].find(
        (candidate) => candidate.id === downloadId && candidate.scopeKey === scopeKey,
      );
      if (active) await active.cancel();
      // Cancellation can synchronously publish a terminal DownloadItem update,
      // including the final quarantine path. Re-read after it settles so a
      // completion/cancel race cannot orphan the physical file while deleting
      // only its shelf metadata.
      const download = this.requireDownloadForScope(scopeKey, downloadId);
      if (
        download.quarantined &&
        download.path &&
        isAssistantDownloadQuarantinePath(this.appHome, scopeKey, download.id, download.path)
      ) {
        if (this.isDownloadExportLeased(scopeKey, download.path)) {
          throw new Error('This assistant download is currently being exported.');
        }
        removeAssistantDownloadFile(download.path);
      }
      this.downloads.delete(downloadId);
      const store = this.storeForScope(scopeKey);
      store.removeDownload(downloadId);
      await store.flushDownloads();
      this.emitDownloadHistoryChangedForScope(scopeKey, conversationId, downloadId, 'deleted');
    });
  }

  async cancelDownload(conversationId: string, downloadId: string): Promise<void> {
    const scopeKey = this.scopeKey(conversationId);
    this.assertScopeAvailable(scopeKey);
    const active = [...this.activeDownloads.values()].find(
      (download) => download.id === downloadId && download.scopeKey === scopeKey,
    );
    if (!active) throw new Error('This download is no longer active.');
    await active.cancel();
  }

  listSitePermissions(conversationId: string, origin: string): BrowserSitePermission[] {
    if (!isPersistentBrowserPermissionOrigin(origin)) return [];
    return this.store(conversationId)
      .listPermissions(origin)
      .filter((permission) => !permission.permission.startsWith('fileSystem:'));
  }

  resetSitePermissions(conversationId: string, origin: string, permission?: string): void {
    if (!isPersistentBrowserPermissionOrigin(origin)) throw new Error('Site permissions require an HTTP(S) origin.');
    const scopeKey = this.scopeKey(conversationId);
    this.store(conversationId).clearPermissions(origin, permission);
    for (const tab of this.tabs.values()) {
      if (tab.scopeKey !== scopeKey) continue;
      const prefix = `${tab.shell.id}\u0000${origin}\u0000`;
      for (const key of this.oneTimePermissions) {
        if (key.startsWith(prefix) && (permission === undefined || key === `${prefix}${permission}`)) {
          this.oneTimePermissions.delete(key);
        }
      }
    }
  }

  listCredentials(conversationId: string, query?: string) {
    return this.vault(conversationId).list(query);
  }

  async saveCredential(conversationId: string, origin: string, username: string, password: string): Promise<void> {
    if (
      typeof origin !== 'string' ||
      typeof username !== 'string' ||
      typeof password !== 'string' ||
      origin.length > MAX_CREDENTIAL_ORIGIN_LENGTH ||
      username.length > MAX_CREDENTIAL_USERNAME_LENGTH ||
      password.length === 0 ||
      password.length > MAX_CREDENTIAL_PASSWORD_LENGTH
    ) {
      throw new Error('Saved credential fields are invalid or exceed the allowed size.');
    }
    const parsed = new URL(origin);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('Saved browser passwords require an HTTP(S) origin.');
    }
    const scopeKey = this.scopeKey(conversationId);
    await this.withScopeActivity(scopeKey, () =>
      this.vaultForScope(scopeKey).upsertWithAuthentication(parsed.origin, username, password, () =>
        this.assertHostRendererOperationCurrent(),
      ),
    );
  }

  async updateCredential(
    conversationId: string,
    credentialId: string,
    username: string,
    password: string,
  ): Promise<void> {
    if (
      typeof credentialId !== 'string' ||
      typeof username !== 'string' ||
      typeof password !== 'string' ||
      username.length > MAX_CREDENTIAL_USERNAME_LENGTH ||
      password.length === 0 ||
      password.length > MAX_CREDENTIAL_PASSWORD_LENGTH
    ) {
      throw new Error('Saved credential fields are invalid or exceed the allowed size.');
    }
    const scopeKey = this.scopeKey(conversationId);
    await this.withScopeActivity(scopeKey, () =>
      this.vaultForScope(scopeKey).updateWithAuthentication(credentialId, username, password, () =>
        this.assertHostRendererOperationCurrent(),
      ),
    );
  }

  async deleteCredential(conversationId: string, credentialId: string): Promise<void> {
    const scopeKey = this.scopeKey(conversationId);
    await this.withScopeActivity(scopeKey, () =>
      this.vaultForScope(scopeKey).delete(credentialId, () => this.assertHostRendererOperationCurrent()),
    );
  }

  revealCredential(conversationId: string, credentialId: string): Promise<string> {
    const scopeKey = this.scopeKey(conversationId);
    return this.withScopeActivity(scopeKey, () =>
      this.vaultForScope(scopeKey).reveal(credentialId, () => this.assertHostRendererOperationCurrent()),
    );
  }

  copyCredential(conversationId: string, credentialId: string): Promise<void> {
    const scopeKey = this.scopeKey(conversationId);
    return this.withScopeActivity(scopeKey, () =>
      this.vaultForScope(scopeKey).copy(credentialId, () => this.assertHostRendererOperationCurrent()),
    );
  }

  private dropPendingCredential(id: string): void {
    const pending = this.pendingCredentials.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    pending.password = '';
    this.pendingCredentials.delete(id);
    this.emitPromptDismissed(pending.conversationId, id, 'credential');
  }

  private finishPendingPermission(id: string, allowed: boolean): void {
    const pending = this.pendingPermissions.get(id);
    if (!pending) return;
    this.pendingPermissions.delete(id);
    clearTimeout(pending.timer);
    this.emitPromptDismissed(pending.conversationId, id, 'permission');
    pending.callback(allowed);
  }

  private dismissPendingPermissionsForTab(tabId: string): void {
    for (const [promptId, pending] of this.pendingPermissions ?? []) {
      if (pending.tabId === tabId) this.finishPendingPermission(promptId, false);
    }
  }

  private dismissPendingAuthForTab(tabId: string): void {
    for (const [promptId, pending] of this.pendingAuth ?? []) {
      if (pending.tabId === tabId) this.finishPendingAuth(promptId);
    }
  }

  private finishPendingAuth(id: string, username?: string, password?: string): void {
    const pending = this.pendingAuth.get(id);
    if (!pending) return;
    this.pendingAuth.delete(id);
    clearTimeout(pending.timer);
    this.emitPromptDismissed(pending.conversationId, id, 'auth');
    pending.callback(username, password);
  }

  async respondCredentialPrompt(id: string, save: boolean): Promise<void> {
    const pending = this.pendingCredentials.get(id);
    if (!pending) throw new Error('This password prompt has expired.');
    if (pending.responding) throw new Error('This password prompt is already being handled.');
    this.assertScopeAvailable(pending.scopeKey);
    if (!save) {
      this.dropPendingCredential(id);
      return;
    }
    const tab = this.tabs.get(pending.tabId);
    if (!tab || tab.scopeKey !== pending.scopeKey || tab.shell.conversationId !== pending.conversationId) {
      this.dropPendingCredential(id);
      throw new Error('This password prompt expired after its browser tab closed.');
    }
    const responseGeneration = tab.generation;
    let responseLeaseInvalid = false;
    const assertResponseLeaseCurrent = (): void => {
      this.assertHostRendererOperationCurrent();
      if (
        this.pendingCredentials.get(id) !== pending ||
        this.tabs.get(pending.tabId) !== tab ||
        tab.generation !== responseGeneration ||
        tab.scopeKey !== pending.scopeKey ||
        tab.shell.conversationId !== pending.conversationId
      ) {
        responseLeaseInvalid = true;
        throw new Error('The page changed while the password replacement was being authenticated.');
      }
    };
    // Keep the prompt and its pending secret alive if secure storage rejects
    // the write; the renderer can report the failure and let the user retry or
    // explicitly decline. Dismiss only after the chosen action succeeds.
    pending.responding = true;
    clearTimeout(pending.timer);
    try {
      await this.withScopeActivity(pending.scopeKey, () =>
        this.vaultForScope(pending.scopeKey).upsertWithAuthentication(
          pending.origin,
          pending.username,
          pending.password,
          assertResponseLeaseCurrent,
        ),
      );
      if (this.pendingCredentials.get(id) === pending) this.dropPendingCredential(id);
    } catch (error) {
      // Native authentication can be cancelled. Restore the prompt timeout only
      // while this exact pending secret still belongs to the prompt; tab/profile
      // teardown may have dismissed and wiped it while authentication was open.
      if (responseLeaseInvalid && this.pendingCredentials.get(id) === pending) {
        this.dropPendingCredential(id);
      } else if (this.pendingCredentials.get(id) === pending) {
        pending.responding = false;
        pending.timer = setTimeout(() => this.dropPendingCredential(id), PROMPT_TIMEOUT_MS);
        pending.timer.unref?.();
      }
      throw error;
    }
  }

  respondAuthPrompt(id: string, username?: string, password?: string): void {
    const pending = this.pendingAuth.get(id);
    if (!pending) throw new Error('This HTTP authentication prompt has expired.');
    if (
      (username !== undefined && (typeof username !== 'string' || username.length > MAX_CREDENTIAL_USERNAME_LENGTH)) ||
      (password !== undefined && (typeof password !== 'string' || password.length > MAX_CREDENTIAL_PASSWORD_LENGTH))
    ) {
      throw new Error('HTTP authentication credentials exceed the allowed size.');
    }
    const tab = this.tabs.get(pending.tabId);
    if (
      !tab ||
      tab.generation !== pending.tabGeneration ||
      tab.scopeKey !== pending.scopeKey ||
      tab.shell.conversationId !== pending.conversationId ||
      (pending.trustedUserNavigationLease !== undefined &&
        (!tab.trustedUserNavigation ||
          tab.trustedUserNavigationLease !== pending.trustedUserNavigationLease ||
          pending.trustedUserNavigationRequestId === undefined ||
          pending.trustedUserNavigationUrl === undefined ||
          this.trustedUserNavigationAuthRequest(tab, pending.trustedUserNavigationUrl)?.requestId !==
            pending.trustedUserNavigationRequestId))
    ) {
      this.finishPendingAuth(id);
      throw new Error('This HTTP authentication prompt expired after the page navigated.');
    }
    const submittingCredentials = username !== undefined || password !== undefined;
    if (
      submittingCredentials &&
      !pending.prompt.assistantTriggered &&
      tab.aiNetworkRestricted &&
      pending.trustedUserNavigationLease === undefined
    ) {
      // The page entered assistant control after this prompt first appeared.
      // Keep Chromium's callback pending and require a second decision made
      // with the AI-specific credential warning visible.
      pending.prompt = { ...pending.prompt, assistantTriggered: true };
      this.emit({
        type: 'auth-prompt',
        conversationId: pending.conversationId,
        prompt: pending.prompt,
      });
      throw new Error('AI control began while this authentication prompt was open. Review the updated warning.');
    }
    this.finishPendingAuth(id, username, password);
  }

  respondPermissionPrompt(id: string, decisionInput: unknown): void {
    // IPC types disappear at runtime. Parse defensively here as well as at the
    // IPC boundary so no alternate caller can turn an unknown value into the
    // fail-open `decision !== 'deny'` path below.
    const decision = parseBrowserPermissionDecision(decisionInput);
    const pending = this.pendingPermissions.get(id);
    if (!pending) throw new Error('This site-permission prompt has expired.');
    const tab = this.tabs.get(pending.tabId);
    if (
      !tab ||
      tab.generation !== pending.tabGeneration ||
      tab.scopeKey !== pending.scopeKey ||
      tab.shell.conversationId !== pending.conversationId
    ) {
      this.finishPendingPermission(id, false);
      throw new Error('This site-permission prompt expired after the page navigated.');
    }
    if (decision !== 'deny' && !pending.assistantTriggered && tab.aiNetworkRestricted) {
      // The page entered assistant control after this request was first shown.
      // The user's click was made without the AI-specific warning, so keep the
      // Chromium callback pending and require a second, informed decision.
      pending.assistantTriggered = true;
      this.emit({
        type: 'permission-prompt',
        conversationId: pending.conversationId,
        prompt: {
          id,
          tabId: pending.tabId,
          origin: pending.origin,
          permission: pending.permission,
          ...(pending.target ? { target: pending.target } : {}),
          canPersist: false,
          assistantTriggered: true,
        },
      });
      throw new Error('AI control began while this permission prompt was open. Review the updated warning.');
    }
    const assistantTriggered = pending.assistantTriggered || tab.aiNetworkRestricted;
    if (decision === 'allow' && (assistantTriggered || !pending.canPersist)) {
      throw new Error('This permission can be allowed for the current request only.');
    }
    const persistentOrigin = isPersistentBrowserPermissionOrigin(pending.origin);
    if (decision === 'allow-once' && persistentOrigin) {
      for (const storageKey of pending.storageKeys) {
        this.oneTimePermissions.add(permissionGrantKey(tab.shell.id, pending.origin, storageKey));
      }
    } else if (!assistantTriggered && persistentOrigin && pending.canPersist) {
      this.storeForScope(tab.scopeKey).setPermissions(
        pending.origin,
        pending.storageKeys,
        decision === 'allow' ? 'allow' : 'deny',
      );
    }
    // Opaque origins have no stable frame identity in Electron's permission
    // callback. Grant only this exact pending request; never cache it under the
    // shared display label, where an unrelated sandboxed frame could reuse it.
    this.finishPendingPermission(id, decision !== 'deny');
  }

  private resolveAutofillCredentialTarget(
    tab: InternalTab,
    contents: WebContents,
    credentialId?: string,
  ): { frameOrigins: Map<WebFrameMain, string>; match: BrowserCredentialSummary } {
    const frameOrigins = new Map<WebFrameMain, string>();
    try {
      // Cross-origin child frames cannot prove that their embedding iframe and
      // every ancestor are visible from inside their own viewport. Restrict
      // vault autofill to the top-level page; embedded sign-in can be opened in
      // its own tab, where normal viewport and occlusion checks apply.
      const frame = contents.mainFrame;
      if (!frame.detached && !frame.isDestroyed()) {
        const parsed = new URL(frame.origin);
        if (parsed.protocol === 'http:' || parsed.protocol === 'https:') frameOrigins.set(frame, parsed.origin);
      }
    } catch {
      throw new Error('The page changed before saved-password autofill could inspect its frames.');
    }
    const match = this.resolveAutofillCredentialForOrigins(tab, new Set(frameOrigins.values()), credentialId);
    return { frameOrigins, match };
  }

  private resolveAutofillCredentialForOrigins(
    tab: InternalTab,
    destinations: ReadonlySet<string>,
    credentialId?: string,
  ): BrowserCredentialSummary {
    const available = this.vaultForScope(tab.scopeKey)
      .list()
      .filter((item) => destinations.has(item.origin));
    const match = credentialId ? available.find((item) => item.id === credentialId) : available[0];
    if (!match) throw new Error('No saved credential matches this top-level page.');
    if (!credentialId && available.length > 1) {
      throw new Error('Multiple saved credentials match this page. Choose a specific account.');
    }
    return match;
  }

  async autofill(
    conversationId: string,
    tabId: string | undefined,
    credentialId?: string,
    source: 'user' | 'assistant' = 'user',
    assistantRun?: BrowserAssistantRun,
    approvedDocument?: BrowserDocumentApproval,
  ): Promise<void> {
    if (source === 'assistant' && !assistantRun) throw new Error('Assistant autofill requires turn ownership.');
    const abortSignal = assistantRun?.abortSignal;
    throwIfBrowserAborted(abortSignal);
    const tab =
      source === 'assistant'
        ? this.requireAssistantTab(conversationId, assistantRun!, tabId)
        : this.requireTab(conversationId, tabId);
    const operation = async (
      documentLease?: AssistantDocumentLease,
      reveal?: (contents: WebContents, documentLease: AssistantDocumentLease) => Promise<void>,
    ): Promise<void> => {
      throwIfBrowserAborted(abortSignal);
      this.assertBrowserDocumentApproval(tab, approvedDocument);
      const contents = (
        source === 'assistant'
          ? await this.ensureAssistantView(tab, assistantRun!, documentLease!, undefined, approvedDocument)
          : await this.ensureView(tab)
      ).webContents;
      this.assertBrowserDocumentApproval(tab, approvedDocument);
      if (reveal && documentLease) await reveal(contents, documentLease);
      throwIfBrowserAborted(abortSignal);
      if (tab.scriptTainted) {
        throw new Error('Saved-password autofill is blocked until this page is reloaded or navigated.');
      }
      const generation = documentLease?.tabGeneration ?? tab.generation;
      const topLevelOrigin = normalizedOrigin(tab.shell.url);
      const { frameOrigins, match } = this.resolveAutofillCredentialTarget(tab, contents, credentialId);
      const vault = this.vaultForScope(tab.scopeKey);
      if (
        approvedDocument &&
        isBrowserAutofillApproval(approvedDocument) &&
        (approvedDocument.destinationOrigin !== match.origin ||
          approvedDocument.credentialId !== match.id ||
          approvedDocument.credentialUpdatedAt !== match.updatedAt)
      ) {
        throw new Error(
          'The saved credential or destination changed while approval was pending. Review it and try again.',
        );
      }
      const origin = match.origin;
      const matchingFrames = [...frameOrigins]
        .filter(([, frameOrigin]) => frameOrigin === origin)
        .map(([frame]) => frame);
      const autofillPage = async () => {
        throwIfBrowserAborted(abortSignal);
        if (tab.scriptTainted || generation !== tab.generation || normalizedOrigin(tab.shell.url) !== topLevelOrigin) {
          throw new Error('The page changed before saved-password autofill could begin.');
        }
        const targetFrames = await this.runRendererOperationWithDeadline(
          tab,
          contents,
          'Browser saved-password target discovery',
          EVALUATE_TIMEOUT_MS,
          async () => {
            const probes = await Promise.all(
              matchingFrames.map(async (frame) => {
                try {
                  if (frame.detached || frame.isDestroyed() || frame.origin !== origin) return null;
                  return (await frame.executeJavaScript(browserAutofillProbeScript(origin))) === true ? frame : null;
                } catch {
                  return null;
                }
              }),
            );
            return probes.filter((frame): frame is WebFrameMain => frame !== null);
          },
          abortSignal,
          documentLease,
        );
        if (targetFrames.length !== 1) {
          throw new Error('Saved-password autofill requires one unambiguous matching login frame.');
        }
        const targetFrame = targetFrames[0];
        throwIfBrowserAborted(abortSignal);
        if (
          targetFrame.detached ||
          targetFrame.isDestroyed() ||
          targetFrame.origin !== origin ||
          tab.scriptTainted ||
          generation !== tab.generation ||
          normalizedOrigin(tab.shell.url) !== topLevelOrigin
        ) {
          throw new Error('The page changed before saved-password autofill could begin.');
        }
        // Frame probing executes page-controlled code and may take long enough
        // for Settings to update the selected vault record. Re-read its
        // version immediately before the synchronous decrypt so an approval
        // for the old password can never fill a replacement password.
        const currentMatch = vault.findForOrigin(origin, match.id);
        if (
          !currentMatch ||
          currentMatch.updatedAt !== match.updatedAt ||
          (approvedDocument &&
            isBrowserAutofillApproval(approvedDocument) &&
            approvedDocument.credentialUpdatedAt !== currentMatch.updatedAt)
        ) {
          throw new Error(
            'The saved credential or destination changed while autofill was waiting. Review it and try again.',
          );
        }
        const credential = vault.decrypt(match.id);
        try {
          this.setTabSensitive(tab, true);
          const filled = await this.runRendererOperationWithDeadline(
            tab,
            contents,
            'Browser saved-password autofill',
            EVALUATE_TIMEOUT_MS,
            () =>
              targetFrame
                .executeJavaScript(browserAutofillScript(credential.username, credential.password, origin), false)
                .catch(() => false),
            abortSignal,
            documentLease,
          );
          if (filled !== true) {
            throw new Error('Saved-password autofill could not fill the selected login form.');
          }
          if (documentLease) this.assertAssistantDocumentLease(tab, documentLease);
        } finally {
          credential.password = '';
        }
      };
      await (source === 'assistant' ? this.withAssistantScriptPopupAttribution(tab, autofillPage) : autofillPage());
    };
    if (source === 'assistant') {
      await this.withVisibleAssistantOperation(
        conversationId,
        tab,
        assistantRun!,
        'autofill',
        'autofilling saved password',
        (reveal) =>
          this.runTabOperation(tab, () =>
            this.withAssistantControl(
              tab,
              assistantRun!,
              (documentLease) => operation(documentLease, reveal),
              approvedDocument,
            ),
          ),
      );
      return;
    }
    await this.runTabOperation(tab, () => operation());
  }

  async menuAction(conversationId: string, action: BrowserMenuAction): Promise<void> {
    const activeId = this.activeTabs.get(conversationId);
    if (action === 'new-tab') {
      await this.createTab({ conversationId, owner: 'user' });
      return;
    }
    if (action === 'reopen-closed-tab') {
      await this.reopenClosedTab(conversationId);
      return;
    }
    if (!activeId) return;
    const tab = this.requireTab(conversationId, activeId);
    if (action === 'print') {
      const nativeDialogPanelGeneration = this.panelAuthorityGeneration(conversationId);
      await this.runTabOperation(tab, async () => {
        const contents = (await this.ensureView(tab)).webContents;
        const pageLease = this.captureBrowserPageLease(tab, contents);
        this.assertBrowserPageLease(tab, pageLease, 'printing');
        await this.assertTabNotSensitive(tab, contents, 'Printing');
        this.assertBrowserPageLease(tab, pageLease, 'printing');
        if (!this.hasBrowserNativeDialogAuthority(tab, contents, nativeDialogPanelGeneration)) return;
        await this.printPage(contents);
      });
    } else if (action === 'devtools') {
      const view = await this.ensureView(tab);
      tab.lastUsedAt = Date.now();
      view.webContents.openDevTools({ mode: 'detach' });
    } else if (action === 'find') this.emit({ type: 'shortcut', conversationId, action: 'find' });
  }

  async dataSummary(conversationId?: string): Promise<BrowserDataSummary[]> {
    const enumerationWarnings: string[] = [];
    const readScopeKeys = (label: string, read: () => string[]): string[] => {
      try {
        return read();
      } catch {
        enumerationWarnings.push(`${label} could not be enumerated; some recovery rows may be missing.`);
        return [];
      }
    };
    let pendingCleanupRecoveryRequired = false;
    let pendingCleanupScopeKeys: Set<string>;
    try {
      pendingCleanupScopeKeys = new Set(listPendingBrowserCleanupScopeKeys(this.appHome));
      // A later successful read proves the aggregate cleanup metadata is
      // readable again. Do not leave every profile process-wide quarantined
      // merely because an earlier Settings refresh observed a transient error.
      this.pendingCleanupQuarantineUnreadable = false;
      // Re-quarantine the discovered pending-cleanup scopes (R179): clearing the process-wide
      // unreadable flag WITHOUT re-adding the specific pending scopes to the restricted/quarantined
      // sets would expose residual history/bookmarks/credential metadata from a not-yet-completed
      // clear until cleanup succeeds. Mirror refreshPendingCleanupQuarantine.
      for (const pendingScopeKey of pendingCleanupScopeKeys) {
        this.restrictedBackgroundScopes.add(pendingScopeKey);
        this.clearQuarantinedScopes.add(pendingScopeKey);
      }
    } catch {
      pendingCleanupRecoveryRequired = true;
      this.pendingCleanupQuarantineUnreadable = true;
      enumerationWarnings.push('Pending cleanup metadata could not be enumerated; some recovery rows may be missing.');
      pendingCleanupScopeKeys = new Set();
    }
    const keys = new Set([
      ...readScopeKeys('Browser profile metadata', () => listStoredBrowserScopeKeys(this.appHome)),
      ...readScopeKeys('Saved-password metadata', () => listStoredCredentialScopeKeys(this.appHome)),
      ...readScopeKeys('Assistant download quarantine', () => listAssistantDownloadQuarantineScopeKeys(this.appHome)),
      ...pendingCleanupScopeKeys,
      ...readScopeKeys('Chromium Browser profiles', () =>
        listStoredChromiumBrowserScopeKeys(this.appHome, app.getPath('sessionData')),
      ),
    ]);
    keys.add('global');
    if (conversationId) keys.add(browserScopeKey('conversation', conversationId));
    const activeTabCounts = new Map<string, number>();
    for (const tab of this.tabs.values()) {
      activeTabCounts.set(tab.scopeKey, (activeTabCounts.get(tab.scopeKey) ?? 0) + 1);
    }
    const scopeKeys = [...keys];
    const summaries: BrowserDataSummary[] = [];
    for (const [index, scopeKey] of scopeKeys.entries()) {
      const store = this.stores.get(scopeKey);
      const warnings: string[] = [];
      const recoveryRequired = scopeKey === 'global' && pendingCleanupRecoveryRequired;
      if (scopeKey === 'global') warnings.push(...enumerationWarnings);
      let counts = { historyCount: 0, bookmarkCount: 0, downloadCount: 0 };
      try {
        counts = store ? store.counts() : await readStoredBrowserProfileCountsAsync(this.appHome, scopeKey);
      } catch {
        warnings.push('Browser profile metadata is unreadable; history and bookmark counts may be incomplete.');
      }
      const vault = this.vaults.get(scopeKey);
      let credentialCount = 0;
      try {
        credentialCount = vault ? vault.count() : await readStoredCredentialCountAsync(this.appHome, scopeKey);
      } catch {
        warnings.push('Saved-password metadata is unreadable; the password count may be incomplete.');
      }
      summaries.push({
        scopeKey,
        partition: browserPartitionForScopeKey(scopeKey),
        cleanupPending: pendingCleanupScopeKeys.has(scopeKey),
        ...(recoveryRequired ? { recoveryRequired: true } : {}),
        historyCount: counts.historyCount,
        bookmarkCount: counts.bookmarkCount,
        credentialCount,
        activeTabCount: activeTabCounts.get(scopeKey) ?? 0,
        ...(warnings.length > 0
          ? {
              warning: `${warnings.join(' ')} ${
                recoveryRequired
                  ? 'Recover by clearing every discoverable Browser profile.'
                  : 'Clear this profile to recover.'
              }`,
            }
          : {}),
      });
      if (index + 1 < scopeKeys.length) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }
    return summaries;
  }

  private discoverBrowserProfileScopeKeysForRecovery(): Set<string> {
    const scopeKeys = new Set<string>(['global']);
    const add = (values: Iterable<string>): void => {
      for (const scopeKey of values) {
        if (!isBrowserScopeKey(scopeKey)) throw new Error('Invalid browser profile key discovered during recovery.');
        scopeKeys.add(scopeKey);
      }
    };
    add(listStoredBrowserScopeKeys(this.appHome));
    add(listStoredCredentialScopeKeys(this.appHome));
    add(listAssistantDownloadQuarantineScopeKeys(this.appHome));
    add(listStoredChromiumBrowserScopeKeys(this.appHome, app.getPath('sessionData')));
    try {
      add(listPendingBrowserCleanupScopeKeys(this.appHome));
    } catch {
      // A corrupt legacy aggregate has unknown scope. Sidecar markers remain
      // independently enumerable and must still participate in the full clear.
      add(listPendingBrowserCleanupMarkerScopeKeys(this.appHome));
    }
    add([...this.tabs.values()].map((tab) => tab.scopeKey));
    add([...this.closedTabs.values()].flatMap((tabs) => tabs.map((tab) => tab.scopeKey)));
    add(this.stores.keys());
    add(this.vaults.keys());
    add(this.wiredSessionsByScope.keys());
    add(this.scopeActivityCounts.keys());
    add([...this.activeDownloads.values()].map((download) => download.scopeKey));
    add(this.restrictedBackgroundScopes);
    add(this.clearQuarantinedScopes);
    add(this.assistantControlledOrigins.keys());
    return scopeKeys;
  }

  clearData(options: BrowserDataClearOptions): Promise<void> {
    if (this.disposed || this.shuttingDown) {
      return Promise.reject(new Error('The in-app browser is shutting down.'));
    }
    // Serialize clear operations so overlapping scope requests cannot release
    // one another's locks early. Unrelated browsing stays available; only the
    // scope keys held by the active clear are blocked.
    const run = this.profileMutationTail.then(() => this.clearDataLocked(options));
    this.profileMutationTail = run.catch(() => undefined);
    return run;
  }

  private async clearDataLocked(options: BrowserDataClearOptions): Promise<void> {
    this.assertHostRendererOperationCurrent();
    const pluginPartitions = validatePluginPartitionClearNames(options.includePluginPartitions);
    // Data maintenance must remain available after removeConversation installs
    // its public-API fence; use the immutable scope derivation directly instead
    // of scopeKey(), which intentionally rejects stale renderer calls.
    const maintenanceScopeKey = options.conversationId
      ? browserScopeKey(this.dataScope ?? this.config().dataScope, options.conversationId)
      : undefined;
    const fullCleanupRecovery = options.recoverUnreadableCleanup === true;
    const scopeKeys = fullCleanupRecovery
      ? this.discoverBrowserProfileScopeKeysForRecovery()
      : new Set(resolveBrowserDataScopeKeys(options, maintenanceScopeKey));
    let affectedTabs: InternalTab[] = [];
    const affectedConversations = new Set<string>();
    const browserSessions = new Map<string, Session>();
    const networkQuiescedScopeKeys = new Set<string>();
    const downloadQuiescedScopeKeys = new Set<string>();
    const chromiumStorageClearedScopeKeys = new Set<string>();
    const clearedScopeKeys = new Set<string>();
    let shellStateFinalized = false;
    const getBrowserSession = (scopeKey: string): Session => {
      const existing = browserSessions.get(scopeKey);
      if (existing) return existing;
      const partition = browserPartitionForScopeKey(scopeKey);
      const scopedSession = session.fromPartition(partition);
      this.wireSession(scopedSession, partition, scopeKey);
      browserSessions.set(scopeKey, scopedSession);
      return scopedSession;
    };
    for (const scopeKey of scopeKeys) {
      // A final-tab close may still be asynchronously releasing this runtime.
      // Revoke that lease before the clear starts mutating the same Session,
      // store, vault, and generation state.
      this.scopeRuntimeReleaseTokens.delete(scopeKey);
      this.clearingScopes.add(scopeKey);
      this.bumpScopeGeneration(scopeKey);
    }
    try {
      affectedTabs = [...this.tabs.values()].filter((tab) => scopeKeys.has(tab.scopeKey));
      for (const tab of affectedTabs) affectedConversations.add(tab.shell.conversationId);
      if (options.conversationId && maintenanceScopeKey && scopeKeys.has(maintenanceScopeKey)) {
        affectedConversations.add(options.conversationId);
      }
      const downloadDrain = this.cancelActiveDownloadsForScopes(scopeKeys);
      void downloadDrain.catch(() => undefined);
      // Tear down live renderers first to abort navigations/cookie writes, then
      // drain every queued/active tool operation before clearing persistent
      // storage. New activity fails at the scope gate until the clear completes.
      for (const tab of affectedTabs) {
        this.destroyView(tab);
        tab.shell.discarded = true;
        tab.shell.sensitive = false;
      }
      const menuPreviewDrain = this.drainMenuPreviewCapture(
        scopeKeys,
        new Error('Browser menu preview was cancelled because its Browser data is being cleared.'),
      );
      // Fail closed before any asynchronous storage operation can reject. Once
      // Chromium data clearing begins, neither a live shell nor reopen-closed
      // history may retain a URL that could silently repopulate that profile.
      // The renderer notification below is likewise tied to this irreversible
      // shell reset, not to unrelated metadata/plugin-partition cleanup.
      for (const [conversationId, closed] of this.closedTabs) {
        const retained = retainClosedTabsOutsideScopes(closed, scopeKeys);
        if (retained.length === closed.length) continue;
        affectedConversations.add(conversationId);
        if (retained.length > 0) this.closedTabs.set(conversationId, retained);
        else this.closedTabs.delete(conversationId);
      }
      for (const tab of affectedTabs) {
        const hadFavicon = tab.shell.favicon !== undefined;
        tab.generation++;
        tab.shell.title = 'New Tab';
        tab.shell.url = 'about:blank';
        tab.shell.favicon = undefined;
        tab.shell.loading = false;
        tab.shell.audible = false;
        tab.shell.discarded = true;
        tab.shell.canGoBack = false;
        tab.shell.canGoForward = false;
        tab.shell.zoomLevel = 0;
        tab.shell.security = securityForUrl('about:blank');
        tab.shell.sensitive = false;
        tab.scriptTainted = false;
        tab.shell.reloadRequired = false;
        tab.shell.error = undefined;
        tab.shell.updatedAt = now();
        tab.trustedUserNavigation = false;
        tab.trustedUserNavigationTarget = null;
        tab.trustedUserNavigationRequestId = null;
        tab.lastUsedAt = Date.now();
        if (hadFavicon) this.emitTabFavicon(tab);
      }
      shellStateFinalized = true;
      // Closing the pool terminates requests that began before the clear lock,
      // including worker/background traffic without a WebContents. The request
      // tracker above keeps the scope busy through completion/error; any policy
      // callback still awaiting DNS is generation-stale and cannot admit traffic.
      const clearFailures: unknown[] = [];
      for (const scopeKey of scopeKeys) {
        const tabsForScope = affectedTabs.filter((tab) => tab.scopeKey === scopeKey);
        const requireNetworkQuiescence = (): void => {
          if (!networkQuiescedScopeKeys.has(scopeKey)) {
            throw new Error('Chromium clearing was skipped because background network activity could not be stopped.');
          }
        };
        const requireDownloadQuiescence = (): void => {
          if (!downloadQuiescedScopeKeys.has(scopeKey)) {
            throw new Error('Browser profile clearing was skipped because an active download could not be stopped.');
          }
        };
        try {
          await runBrowserDataClearOperations(`Browser profile ${scopeKey}`, [
            {
              label: 'Browser session initialization',
              run: () => {
                getBrowserSession(scopeKey);
              },
            },
            {
              label: 'background network quiescence',
              run: async () => {
                const failures: unknown[] = [];
                try {
                  // Start worker shutdown only when this scope reaches the
                  // sequential clear loop. Eager promises for every selected
                  // profile can otherwise create an unbounded number of CDP
                  // targets and surface later rejections before they are joined.
                  await this.stopRunningServiceWorkers(getBrowserSession(scopeKey), undefined, true);
                } catch (error) {
                  failures.push(error);
                }
                try {
                  await getBrowserSession(scopeKey).closeAllConnections();
                } catch (error) {
                  failures.push(error);
                }
                if (failures.length > 0) {
                  throw new AggregateError(failures, 'Browser background network activity could not be stopped.');
                }
                this.finishAllScopeRequestActivities(scopeKey);
                networkQuiescedScopeKeys.add(scopeKey);
              },
            },
            {
              label: 'queued browser operations',
              run: async () => {
                await Promise.all([
                  ...tabsForScope.map((tab) => tab.queue.whenIdle()),
                  this.screenshotQueue.whenIdle(),
                  menuPreviewDrain,
                ]);
              },
            },
            {
              label: 'active downloads',
              run: async () => {
                await downloadDrain;
                if ([...this.activeDownloads.values()].some((download) => download.scopeKey === scopeKey)) {
                  throw new Error('An active Browser download remained after cancellation completed.');
                }
                downloadQuiescedScopeKeys.add(scopeKey);
              },
            },
            {
              label: 'active profile operations',
              run: () => {
                requireNetworkQuiescence();
                return this.waitForScopeIdle(scopeKey);
              },
            },
            {
              label: 'Chromium storage',
              run: async () => {
                requireNetworkQuiescence();
                requireDownloadQuiescence();
                await getBrowserSession(scopeKey).clearStorageData();
                chromiumStorageClearedScopeKeys.add(scopeKey);
              },
            },
            {
              label: 'Chromium cache',
              run: () => {
                requireNetworkQuiescence();
                requireDownloadQuiescence();
                return getBrowserSession(scopeKey).clearCache();
              },
            },
            {
              label: 'HTTP authentication cache',
              run: () => {
                requireNetworkQuiescence();
                requireDownloadQuiescence();
                return getBrowserSession(scopeKey).clearAuthCache();
              },
            },
            {
              label: 'download path cache',
              run: () => {
                requireDownloadQuiescence();
                this.purgeCachedDownloadsForScope(scopeKey);
              },
            },
            {
              label: 'assistant download quarantine',
              run: () => {
                requireDownloadQuiescence();
                removeAssistantDownloadQuarantineForScope(this.appHome, scopeKey);
              },
            },
            {
              label: 'history, bookmarks, permissions, and downloads',
              run: () => {
                requireDownloadQuiescence();
                return this.storeForScope(scopeKey).clear();
              },
            },
            {
              label: 'retained Browser screenshots',
              run: () => {
                requireDownloadQuiescence();
                removeBrowserScreenshotsForScopeKey(this.appHome, scopeKey);
              },
            },
            {
              label: 'runtime profile state',
              run: () => {
                requireDownloadQuiescence();
                // Keep the in-process request guard and worker provenance when
                // Chromium could not prove that persistent workers/storage are
                // gone. The catch path below restores the durable store bit.
                if (!chromiumStorageClearedScopeKeys.has(scopeKey)) return;
                this.restrictedBackgroundScopes.delete(scopeKey);
                this.assistantControlledOrigins.delete(scopeKey);
              },
            },
            {
              label: 'saved passwords',
              run: () => {
                requireDownloadQuiescence();
                return this.vaultForScope(scopeKey).clear();
              },
            },
          ]);
          // A Chromium tombstone and removal of the retry marker are commit
          // records, not cleanup categories. Publish them only after every
          // category above succeeded.
          markChromiumBrowserScopeCleared(this.appHome, scopeKey);
          if (!fullCleanupRecovery) {
            if (!clearPendingBrowserCleanupScopeKey(this.appHome, scopeKey)) {
              this.pendingCleanupQuarantineUnreadable = true;
              throw new Error(
                'Pending Browser-profile cleanup metadata remains unreadable; use full-profile recovery in Browser Data settings.',
              );
            }
            this.pendingCleanupQuarantineUnreadable = false;
            this.clearQuarantinedScopes?.delete(scopeKey);
          }
          clearedScopeKeys.add(scopeKey);
        } catch (error) {
          // Do not downgrade a failed clear to the ordinary private-network
          // restriction. A surviving worker must remain completely offline,
          // including public HTTPS, until a full retry succeeds.
          (this.clearQuarantinedScopes ??= new Set()).add(scopeKey);
          let retainedError = error;
          if (!chromiumStorageClearedScopeKeys.has(scopeKey)) {
            this.restrictedBackgroundScopes.add(scopeKey);
            try {
              this.storeForScope(scopeKey).restrictBackgroundNetwork();
            } catch (restrictionError) {
              retainedError = new AggregateError(
                [error, restrictionError],
                `Browser profile ${scopeKey} failed and its background-network restriction could not be persisted.`,
              );
            }
          }
          try {
            if (!markPendingBrowserCleanupScopeKey(this.appHome, scopeKey)) {
              this.pendingCleanupQuarantineUnreadable = true;
            }
            clearFailures.push(retainedError);
          } catch (markerError) {
            clearFailures.push(
              new AggregateError(
                [retainedError, markerError],
                `Browser profile ${scopeKey} failed and its pending-cleanup marker could not be retained.`,
              ),
            );
          }
        }
      }
      if (fullCleanupRecovery && clearFailures.length === 0) {
        try {
          finalizePendingBrowserCleanupRecovery(this.appHome, clearedScopeKeys);
          this.pendingCleanupQuarantineUnreadable = false;
          for (const scopeKey of clearedScopeKeys) this.clearQuarantinedScopes?.delete(scopeKey);
        } catch (error) {
          this.pendingCleanupQuarantineUnreadable = true;
          clearFailures.push(error);
        }
      }
      try {
        await clearPluginBrowserPartitions(pluginPartitions);
      } catch (error) {
        clearFailures.push(error);
      }
      if (clearFailures.length > 0) {
        throw new AggregateError(
          clearFailures,
          `One or more Browser data profiles could not be completely cleared: ${clearFailures
            .map((error) => (error instanceof Error ? error.message : String(error)))
            .join('; ')}`,
        );
      }
    } finally {
      for (const scopeKey of scopeKeys) this.clearingScopes.delete(scopeKey);
      for (const conversation of new Set([...this.tabs.values()].map((tab) => tab.shell.conversationId))) {
        this.emitTabs(conversation);
      }
      if (shellStateFinalized && clearedScopeKeys.size > 0) {
        // An explicit scope-key retry may belong to an already-deleted chat and
        // therefore have no live tab/closed-tab owner. Still broadcast the
        // successful keys so the global cleanup-warning host can dismiss them;
        // use the Settings caller's active chat only as an optional panel hint.
        const notificationTargets: Array<string | undefined> =
          affectedConversations.size > 0 ? [...affectedConversations] : [options.conversationId];
        for (const conversationId of notificationTargets) {
          this.emit({
            type: 'profile-data-cleared',
            ...(conversationId ? { conversationId } : {}),
            scopeKeys: [...clearedScopeKeys],
          });
        }
      }
      // Settings may clear profiles that have no live tabs. Session wiring and
      // bounded store/vault instances created solely for that clear must not
      // accumulate until app shutdown. Live-tab scopes are retained by the
      // helper and keep their freshly cleared runtime available.
      for (const scopeKey of scopeKeys) {
        // A failed Chromium clear may have left an AI-created service worker
        // alive. Keep this session wired so its unattributed requests remain
        // subject to the private-network policy until a retry succeeds.
        if (clearedScopeKeys.has(scopeKey)) this.releaseScopeRuntime(scopeKey);
      }
    }
  }

  cleanupAssistantTabs(conversationId: string, runId: string): Promise<void> {
    const key = assistantContinuationKey(conversationId, runId);
    const retainedRetry = this.assistantTabCleanupRetries?.get(key);
    if (retainedRetry) return retainedRetry.completion;
    let resolve!: () => void;
    const completion = new Promise<void>((settled) => {
      resolve = settled;
    });
    const pending: PendingAssistantTabCleanupRetry = {
      conversationId,
      runId,
      completion,
      resolve,
      timer: null,
    };
    (this.assistantTabCleanupRetries ??= new Map()).set(key, pending);
    this.trackAssistantTabCleanup(conversationId, completion);
    // cleanupAssistantTabsNow executes synchronously through assistantRuns.end,
    // revoking new work before this method returns. Expose one stable promise
    // before starting the attempt so existing waiters remain pending across a
    // transient failure and every retry.
    void this.cleanupAssistantTabsNow(conversationId, runId).then(
      () => this.finishAssistantTabCleanupRetry(key, pending),
      () => this.armAssistantTabCleanupRetry(key, pending),
    );
    return completion;
  }

  private trackAssistantTabCleanup(conversationId: string, cleanup: Promise<void>): Promise<void> {
    const cleanupsByConversation = (this.assistantTabCleanups ??= new Map());
    const pending = cleanupsByConversation.get(conversationId) ?? new Set<Promise<void>>();
    pending.add(cleanup);
    cleanupsByConversation.set(conversationId, pending);
    void cleanup
      .finally(() => {
        pending.delete(cleanup);
        if (pending.size === 0 && cleanupsByConversation.get(conversationId) === pending) {
          cleanupsByConversation.delete(conversationId);
        }
      })
      .catch(() => undefined);
    return cleanup;
  }

  private armAssistantTabCleanupRetry(key: string, pending: PendingAssistantTabCleanupRetry): void {
    if (this.disposed || this.shuttingDown || this.assistantTabCleanupRetries?.get(key) !== pending) {
      this.finishAssistantTabCleanupRetry(key, pending);
      return;
    }
    if (pending.timer) clearTimeout(pending.timer);
    pending.timer = setTimeout(() => {
      pending.timer = null;
      void this.retryAssistantTabCleanup(key, pending);
    }, ASSISTANT_CONTINUATION_CLEANUP_RETRY_MS);
    pending.timer.unref?.();
  }

  private async retryAssistantTabCleanup(key: string, pending: PendingAssistantTabCleanupRetry): Promise<void> {
    if (this.assistantTabCleanupRetries?.get(key) !== pending) return;
    if (this.disposed || this.shuttingDown) {
      this.finishAssistantTabCleanupRetry(key, pending);
      return;
    }
    try {
      await this.cleanupAssistantTabsNow(pending.conversationId, pending.runId);
      this.finishAssistantTabCleanupRetry(key, pending);
    } catch (error) {
      if (this.assistantTabCleanupRetries?.get(key) !== pending) return;
      console.warn('[Browser] Assistant tab/download cleanup will be retried:', error);
      this.armAssistantTabCleanupRetry(key, pending);
    }
  }

  private finishAssistantTabCleanupRetry(key: string, expected?: PendingAssistantTabCleanupRetry): void {
    const pending = this.assistantTabCleanupRetries?.get(key);
    if (!pending || (expected && pending !== expected)) return;
    if (pending.timer) clearTimeout(pending.timer);
    this.assistantTabCleanupRetries?.delete(key);
    this.assistantContinuationLeases?.delete(key);
    pending.resolve();
  }

  waitForAssistantTabCleanup(conversationId: string): Promise<void> {
    const pending = this.assistantTabCleanups?.get(conversationId);
    return pending && pending.size > 0 ? Promise.all([...pending]).then(() => undefined) : Promise.resolve();
  }

  private async cleanupAssistantTabsNow(conversationId: string, runId: string): Promise<void> {
    // Stop accepting work synchronously, then let already-acquired operations
    // drain before closing their temporary tabs and deleting the capability.
    const key = assistantContinuationKey(conversationId, runId);
    const pending = this.pendingAssistantContinuations?.get(key);
    if (pending) {
      this.pendingAssistantContinuations.delete(key);
      clearTimeout(pending.timer);
      await pending.drain;
      await this.cleanupAssistantStateOwnedByRun(conversationId, runId);
      this.assistantContinuationLeases.delete(key);
      this.emitTabs(conversationId);
      return;
    }
    await this.assistantRuns.end(conversationId, runId);
    await this.cleanupAssistantStateOwnedByRun(conversationId, runId);
    this.emitTabs(conversationId);
  }

  async removeConversation(conversationId: string): Promise<void> {
    // Fence stale renderer work before publishing the terminal empty state.
    // Conversation ids are immutable, so this remains valid for the manager's
    // lifetime and also blocks tab creations already waiting on DNS/scope I/O.
    this.fenceRemovedConversation(conversationId);
    this.forgetAssistantTargetsForConversation(conversationId);
    this.invalidatePanelAuthority(conversationId);
    this.invalidatePhysicalAssistantActions(this.tabs.get(this.activeTabs.get(conversationId) ?? ''));
    this.notifyPanelStateChanged(conversationId);
    if (this.mountedConversationId === conversationId) {
      this.mountedConversationId = null;
      this.mountedBounds = null;
      this.detachAttachedView();
    }
    const continuationCleanup = this.cancelAssistantContinuations(conversationId);
    const runsEnded = this.assistantRuns.endConversation(conversationId);
    const conversationScopeKey = browserScopeKey('conversation', conversationId);
    const hadRuntimeConversationProfile =
      [...(this.tabOrder.get(conversationId) ?? [])]
        .map((id) => this.tabs.get(id))
        .some((tab) => tab?.scopeKey === conversationScopeKey) ||
      (this.closedTabs.get(conversationId) ?? []).some((tab) => tab.scopeKey === conversationScopeKey);
    const conversationTabIds = new Set(this.tabOrder.get(conversationId) ?? []);
    for (const id of conversationTabIds) {
      const tab = this.tabs.get(id);
      if (tab) this.closeTab(tab, false);
    }
    // DownloadItems can outlive their initiating WebContents, including tabs
    // the user closed before deleting the conversation. A global-profile
    // deletion intentionally does not clear the shared scope, so use the
    // immutable conversation ownership captured at download start rather than
    // rediscovering ownership from live tabs. Already-saved files remain
    // untouched.
    const downloadCleanup = this.cancelActiveDownloadsForConversation(conversationId);
    this.tabOrder.delete(conversationId);
    this.activeTabs.delete(conversationId);
    this.closedTabs.delete(conversationId);
    // BrowserPanelAutoOpen keeps cross-chat attention by tab id. Publish the
    // terminal empty state before the deleted conversation becomes unreachable.
    this.emitTabs(conversationId);
    await Promise.all([runsEnded, continuationCleanup, downloadCleanup]);
    this.panelAuthorityGenerations.delete(conversationId);
    this.panelLayoutGenerations.delete(conversationId);
    this.panelStateWaiters.delete(conversationId);
    // A chat-scoped profile may exist even if the user later switched the
    // default back to global. Avoid creating/clearing an Electron Session for
    // the common global-only case while still removing every profile that was
    // live in this process or has persistent data on disk.
    if (
      hadRuntimeConversationProfile ||
      this.stores.has(conversationScopeKey) ||
      this.vaults.has(conversationScopeKey) ||
      this.wiredSessionsByScope.has(conversationScopeKey) ||
      hasStoredBrowserScopeData(this.appHome, app.getPath('sessionData'), conversationScopeKey)
    ) {
      await this.clearData({ conversationId, includeConversation: true });
    }
    // Retained screenshots are conversation-owned even when cookies and
    // storage use the global Browser profile.
    removeBrowserScreenshotsForConversation(this.appHome, conversationId);
    this.releaseScopeRuntime(conversationScopeKey);
  }

  /** Drop native page renderers when their host renderer is replaced or lost.
   * Tab shells remain conversation-owned so a new BrowserPanel can recreate
   * each view from its profile and last URL. */
  handleHostRendererUnavailable(): void {
    // Browser tools are capabilities tied to the host renderer's current
    // lifetime. A reload/crash must revoke them synchronously so an already
    // selected realtime/tool call cannot recreate an authenticated page view.
    this.hostRendererAuthorityAvailable = false;
    this.hostRendererAuthorityGeneration++;
    for (const controller of this.hostRendererOperationControllers ?? []) controller.abort();
    this.chromeFocusConversationId = null;
    void this.cancelAssistantContinuations().catch((error: unknown) => {
      console.warn('[Browser] Assistant continuation renderer teardown will be retried:', error);
    });
    // DownloadItems outlive their initiating WebContents. Invoke every
    // non-retained assistant cancellation synchronously while its run ownership
    // is still intact, before clearing leases and destroying page renderers.
    const revokedDownloads = this.activeAssistantDownloads();
    void this.cancelActiveAssistantDownloads(revokedDownloads).catch((error: unknown) => {
      console.warn('[Browser] Assistant download cancellation did not reach a terminal state:', error);
      this.scheduleAssistantDownloadCleanupRetry(revokedDownloads);
    });
    this.assistantRuns.clear();
    this.assistantTargetTabs?.clear();
    this.mountedConversationId = null;
    this.mountedBounds = null;
    this.detachAttachedView();
    const conversations = new Set<string>();
    for (const tab of this.tabs.values()) {
      // Renderer teardown is a document-authority boundary even when the page
      // URL itself is retained for a later idle-style restore.
      tab.generation++;
      this.destroyView(tab);
      tab.shell.discarded = true;
      tab.shell.sensitive = false;
      // Preserve the private-network restriction on the retained shell. A
      // recreated AI-originated document must remain fail-closed until an
      // explicit trusted user navigation/activation releases the policy.
      tab.aiControlOwnerId = null;
      tab.aiControlGeneration = null;
      tab.aiActionDepth = 0;
      tab.aiActionUntil = 0;
      tab.assistantScriptDepth = 0;
      conversations.add(tab.shell.conversationId);
    }
    for (const conversationId of conversations) {
      this.invalidatePanelAuthority(conversationId);
      this.notifyPanelStateChanged(conversationId);
      this.emitTabs(conversationId);
    }
  }

  private discardIdleTabs(): void {
    const cutoff = Date.now() - this.config().idleDiscardMinutes * 60_000;
    for (const tab of this.tabs.values()) {
      const assistantRunActive = [...new Set([tab.assistantOwnerId, tab.aiControlOwnerId])].some((runId) => {
        if (runId === null) return false;
        return (
          this.assistantRuns.generationIfActive(tab.shell.conversationId, runId) !== null ||
          this.assistantContinuationLeases.has(assistantContinuationKey(tab.shell.conversationId, runId))
        );
      });
      // The idle timer is a forgotten-resource backstop, not a turn timeout.
      // Keep both assistant-owned tabs and user tabs currently leased to a live
      // run available while that run pauses between Browser calls.
      const assistantActivityActive = tab.aiActionDepth > 0 || assistantRunActive;
      if (
        shouldCloseIdleAssistantTab(
          tab.shell,
          tab.lastUsedAt,
          cutoff,
          this.activeTabs.get(tab.shell.conversationId),
          this.mountedConversationId,
          assistantActivityActive,
        )
      ) {
        this.closeTab(tab);
        continue;
      }
      if (!tab.view) continue;
      let devToolsOpen = false;
      try {
        devToolsOpen =
          !tab.view.webContents.isDestroyed() &&
          typeof tab.view.webContents.isDevToolsOpened === 'function' &&
          tab.view.webContents.isDevToolsOpened();
      } catch {
        // A renderer can disappear between the liveness probe and Electron's
        // DevTools query. The ordinary discard path below owns that cleanup.
      }
      if (
        !shouldDiscardBrowserTab(
          tab.shell,
          tab.lastUsedAt,
          cutoff,
          this.activeTabs.get(tab.shell.conversationId),
          this.mountedConversationId,
          assistantActivityActive || devToolsOpen,
        )
      )
        continue;
      this.destroyView(tab);
      tab.shell.discarded = true;
      this.emitTabs(tab.shell.conversationId);
    }
  }

  async flushProfileData(): Promise<void> {
    const results = await Promise.allSettled([...this.stores.values()].map((store) => store.flush()));
    const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failure) throw failure.reason;
  }

  private beginTeardown(): boolean {
    if (this.disposed) return false;
    this.shuttingDown = true;
    this.disposed = true;
    clearInterval(this.idleTimer);
    for (const vault of this.vaults.values()) vault.dispose();
    for (const pending of this.pendingAssistantContinuations?.values() ?? []) clearTimeout(pending.timer);
    this.pendingAssistantContinuations?.clear();
    this.assistantContinuationLeases?.clear();
    for (const [key, pending] of this.assistantTabCleanupRetries ?? []) {
      this.finishAssistantTabCleanupRetry(key, pending);
    }
    if (this.assistantDownloadCleanupRetryTimer) {
      clearTimeout(this.assistantDownloadCleanupRetryTimer);
      this.assistantDownloadCleanupRetryTimer = null;
    }
    this.assistantDownloadCleanupRetryTargets?.clear();
    ipcMain.off('browser-page:sensitive', this.handleSensitiveEvent);
    ipcMain.off('browser-page:login-submitted', this.handleLoginSubmitted);
    ipcMain.off('browser-page:activity', this.handlePageActivity);
    ipcMain.off('browser-page:gesture', this.handlePageGesture);
    ipcMain.off('browser-page:automation-input-armed', this.handleAutomationInputArmed);
    ipcMain.off('browser-page:sensitivity-probe-result', this.handleMenuSensitivityProbeResult);
    ipcMain.off('browser-page:element-picker-click', this.handleElementPickerClick);
    ipcMain.off('browser-page:element-picker-result', this.handleElementPickerResult);
    ipcMain.off('browser-page:element-picker-cancel', this.handleElementPickerCancel);
    app.off('login', this.handleLogin);
    app.off('select-client-certificate', this.handleSelectClientCertificate);
    for (const pending of this.pendingCredentials.values()) {
      clearTimeout(pending.timer);
      pending.password = '';
    }
    this.pendingCredentials.clear();
    for (const pending of this.pendingPermissions.values()) {
      clearTimeout(pending.timer);
      pending.callback(false);
    }
    this.pendingPermissions.clear();
    for (const pending of this.pendingAuth.values()) {
      clearTimeout(pending.timer);
      pending.callback();
    }
    this.pendingAuth.clear();
    this.runningActions.clear();
    for (const conversationId of [...this.panelStateWaiters.keys()]) this.notifyPanelStateChanged(conversationId);
    // Persistent-session request guards remain authoritative until every live
    // remote renderer has been destroyed. Removing them first creates a small
    // but real interval in which page script can dispatch an unfiltered request
    // (including to a private-network destination) while shutdown is closing
    // sibling views.
    for (const tab of this.tabs.values()) this.destroyView(tab);
    for (const contentsId of [...(this.contextMenuDownloadAuthorities?.keys() ?? [])]) {
      this.clearContextMenuDownloadAuthority(contentsId);
    }
    for (const cleanupSession of this.wiredSessionCleanups.values()) cleanupSession();
    this.wiredSessionCleanups.clear();
    this.assistantRuns.clear();
    this.assistantTargetTabs?.clear();
    for (const pending of this.pendingAutomationArmAcknowledgements.values()) {
      pending.settle(new Error('The in-app browser is shutting down.'));
    }
    this.pendingAutomationArmAcknowledgements.clear();
    for (const pending of this.pendingMenuSensitivityProbes.values()) pending.settle();
    this.pendingMenuSensitivityProbes.clear();
    for (const token of [...this.automationGestureTokens.keys()]) this.revokeAutomationGestureToken(token);
    this.pendingSyntheticInputs.clear();
    for (const contentsId of [...this.dispatchedSyntheticInputs.keys()]) {
      this.clearDispatchedSyntheticInput(contentsId);
    }
    for (const tabId of this.faviconFetches.keys()) this.cancelFaviconFetch(tabId);
    this.detachAttachedView();
    const backgroundCaptureHost = this.backgroundCaptureHost;
    this.backgroundCaptureHost = null;
    this.captureHostedView = null;
    this.captureHostedViewLease = null;
    this.detachedHostViews?.clear();
    this.closingHostWindow = null;
    if (backgroundCaptureHost && !backgroundCaptureHost.isDestroyed()) backgroundCaptureHost.destroy();
    return true;
  }

  private finishTeardown(): void {
    this.tabs.clear();
    this.tabOrder.clear();
    this.activeTabs.clear();
    this.activeDownloads.clear();
    this.removedConversations.clear();
    this.scopeGenerations.clear();
    this.scopeRuntimeReleaseTokens.clear();
    this.pendingAssistantTabClosures.clear();
    this.assistantTabCleanups?.clear();
    this.assistantTabCleanupRetries?.clear();
    this.clearingOrigins.clear();
    this.panelAuthorityGenerations.clear();
    this.panelLayoutGenerations.clear();
    this.panelStateWaiters.clear();
    this.wiredSessionsByScope.clear();
    this.stores.clear();
    this.vaults.clear();
  }

  async shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shuttingDown = true;
    const suspendedByAttempt = new Set<string>();
    const attempt = (async () => {
      // A user may quit while a data clear or settings-driven scope transition
      // is already running. Stop admitting new work, then join the shared
      // mutation tail before destroying sessions or performing the final flush.
      await Promise.allSettled([this.startupDownloadReconciliation, this.profileMutationTail]);
      if (this.disposed) return;
      const tabs = [...this.tabs.values()];
      const queues = tabs.map((tab) => tab.queue.whenIdle());
      const screenshotDrain = this.screenshotQueue.whenIdle();
      const scopeKeys = new Set([
        ...tabs.map((tab) => tab.scopeKey),
        ...[...this.activeDownloads.values()].map((download) => download.scopeKey),
        ...this.wiredSessionsByScope.keys(),
      ]);
      const menuPreviewDrain = this.drainMenuPreviewCapture(
        scopeKeys,
        new Error('Browser menu preview was cancelled because the in-app browser is shutting down.'),
      );
      const sessions = new Map(this.wiredSessionsByScope);
      for (const scopeKey of scopeKeys) {
        if (!this.suspendedScopes.has(scopeKey)) suspendedByAttempt.add(scopeKey);
        this.suspendedScopes.add(scopeKey);
        this.bumpScopeGeneration(scopeKey);
        if (!sessions.has(scopeKey))
          sessions.set(scopeKey, session.fromPartition(browserPartitionForScopeKey(scopeKey)));
      }
      const serviceWorkerStops = [...sessions].map(([scopeKey, scopedSession]) =>
        this.stopRunningServiceWorkers(
          scopedSession,
          tabs.find((tab) => tab.scopeKey === scopeKey && tab.view)?.view?.webContents,
          true,
        ),
      );
      const downloadDrain = this.cancelActiveDownloadsForScopes(scopeKeys);
      void downloadDrain.catch(() => undefined);
      // Keep the scoped request guards and any live CDP targets installed until
      // workers have stopped and existing connections are closed. Removing the
      // hooks or destroying the views first creates a shutdown window in which
      // a worker can continue under the unguarded persistent session.
      const networkQuiescence = await Promise.allSettled([
        ...serviceWorkerStops,
        ...[...sessions.values()].map((scopedSession) => scopedSession.closeAllConnections()),
      ]);
      const networkFailures = networkQuiescence
        .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        .map((result) => result.reason);
      if (networkFailures.length > 0) {
        // Removing the request hooks after a failed worker/connection drain can
        // leave a persistent-session worker live without the private-network
        // guard while Electron is still flushing on quit. Fail closed: retain
        // every session cleanup and native view until the process exits. Start a
        // profile flush immediately so the outer shutdown deadline cannot lose
        // already-debounced metadata behind a stuck page queue. If the queues and
        // downloads do drain, flush once more to include their final callbacks.
        const earlyFlush = Promise.allSettled([this.flushProfileData()]);
        const drainResults = await Promise.allSettled([
          ...queues,
          screenshotDrain,
          menuPreviewDrain,
          downloadDrain,
          this.waitForActiveDownloads(scopeKeys),
        ]);
        const earlyFlushResults = await earlyFlush;
        const finalFlushResults = await Promise.allSettled([this.flushProfileData()]);
        const persistenceFailures = [...drainResults, ...earlyFlushResults, ...finalFlushResults]
          .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
          .map((result) => result.reason);
        throw new AggregateError(
          [...networkFailures, ...persistenceFailures],
          'Browser network quiescence failed during shutdown.',
        );
      }
      for (const scopeKey of scopeKeys) this.finishAllScopeRequestActivities(scopeKey);
      // A dismissed menu can release its tab queue while Chromium's native
      // capturePage call is still using the renderer and profile. Join both
      // process-wide allocations before removing session hooks or live views.
      await Promise.all([screenshotDrain, menuPreviewDrain]);
      // Keep every request guard and native view owned until all work admitted
      // before the shutdown fence has drained. A page operation can execute
      // renderer script or dispatch input after network quiescence; tearing down
      // the session hooks before that queue settles would make its final network
      // side effects unfiltered.
      await Promise.allSettled(queues);
      await downloadDrain;
      await this.waitForActiveDownloads(scopeKeys);
      await Promise.all([...scopeKeys].map((scopeKey) => this.waitForScopeIdle(scopeKey)));
      await (this.validatingProxy?.close() ?? Promise.resolve());
      if (!this.beginTeardown()) return;
      try {
        // No renderer, download, request, or profile callback can enqueue a write
        // after this point, so this is the final durable shutdown barrier.
        await this.flushProfileData();
      } finally {
        this.finishTeardown();
      }
    })();
    this.shutdownPromise = attempt;
    try {
      await attempt;
    } catch (error) {
      // A quiescence failure occurs before beginTeardown(), while the manager
      // deliberately still owns its guards, views, sessions, and stores. Make
      // that fail-closed state retryable: a transient service-worker or network
      // drain error must not permanently pin the rejected promise or leave every
      // scope suspended until process exit. Once teardown has begun, state is no
      // longer reconstructable and the failed terminal promise remains final.
      if (!this.disposed) {
        for (const scopeKey of suspendedByAttempt) this.suspendedScopes.delete(scopeKey);
        this.shuttingDown = false;
        if (this.shutdownPromise === attempt) this.shutdownPromise = null;
      }
      throw error;
    }
  }

  dispose(): void {
    // There is no safe synchronous teardown for a persistent Chromium Session:
    // service workers and pooled requests can outlive every WebContents. Keep
    // guards/views owned until the same quiescence and profile-mutation barrier
    // used by app shutdown succeeds. Callers needing completion await shutdown().
    void this.shutdown().catch((error) => {
      console.warn('[Browser] Graceful disposal could not quiesce the Browser; guards remain installed:', error);
    });
  }
}
