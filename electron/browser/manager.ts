import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { join } from 'node:path';
import {
  app,
  type BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  MenuItem,
  screen,
  session,
  shell,
  WebContentsView,
  type IpcMainEvent,
  type DownloadItem,
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
import { BrowserAssistantRunRegistry, type BrowserAssistantModality } from './assistant-runs.js';
import { parseBookmarksHtml, readBoundedBookmarksHtmlFileSync, renderBookmarksHtml } from './bookmarks-html.js';
import {
  BrowserCredentialVault,
  listStoredCredentialScopeKeys,
  readStoredCredentialCountAsync,
} from './credential-vault.js';
import { runBrowserDataClearOperations } from './data-clear.js';
import { clearPluginBrowserPartitions } from './plugin-partitions.js';
import { browserAutofillProbeScript, browserAutofillScript } from './credential-dom.js';
import {
  BROWSER_PRIVATE_NETWORK_GUARD_ACTIVATION_PROBE,
  BROWSER_PRIVATE_NETWORK_NEW_DOCUMENT_GUARD,
  boundedBrowserEvaluationExpression,
} from './evaluation.js';
import {
  MAX_BROWSER_TYPED_VALUE_CHARS,
  parseBrowserActionRequest,
  parseBrowserPermissionDecision,
  parseBrowserScreenshotRequest,
} from './input-validation.js';
import { browserInspectionExpression, MAX_BROWSER_INSPECTION_OCCLUSION_POINTS } from './inspection.js';
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
  browserScreenshotTiles,
  elementCaptureRect,
  validateScreenshotEncodedBytes,
  validateScreenshotSize,
} from './screenshots.js';
import {
  prepareBrowserScreenshotRetention,
  removeBrowserScreenshotsForConversation,
  removeBrowserScreenshotsForScopeKey,
} from './screenshot-store.js';
import { BrowserProfileStore, listStoredBrowserScopeKeys, readStoredBrowserProfileCountsAsync } from './store.js';
import { boundedBrowserTitle, boundedBrowserUrl } from './metadata.js';
import { stopRunningBrowserServiceWorkers } from './service-workers.js';
import {
  aiRequestPolicyUrl,
  assertAiNavigationAllowed,
  browserPartition,
  browserPartitionForScopeKey,
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
const AUTOMATION_GESTURE_ARM_MS = 1_000;
const POPUP_GESTURE_PROVENANCE_MS = 5_000;
const EVALUATE_TIMEOUT_MS = 15_000;
const INSPECT_TIMEOUT_MS = 15_000;
const TARGET_LOCATION_TIMEOUT_MS = 15_000;
const AUTOMATION_OVERLAY_TIMEOUT_MS = 5_000;
const ASSISTANT_VIEW_ATTACH_TIMEOUT_MS = 10_000;
const ELEMENT_PICKER_TIMEOUT_MS = 60_000;
const ASSISTANT_PAGE_LOAD_TIMEOUT_MS = 30_000;
const PRELOAD_PRIVATE_NETWORK_GUARD_PENDING_IDENTIFIER = 'preload-pending';
const UNSAFE_ORIGIN_STORAGE_TYPES: NonNullable<Electron.ClearStorageDataOptions['storages']> = [
  'filesystem',
  'indexdb',
  'localstorage',
  'websql',
  'serviceworkers',
  'cachestorage',
];
const SCRIPTED_ORIGIN_STORAGE_TYPES: NonNullable<Electron.ClearStorageDataOptions['storages']> = ['serviceworkers'];

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
const SCREENSHOT_TIMEOUT_MS = 60_000;
const DNS_RESOLUTION_TIMEOUT_MS = 10_000;
const FAVICON_FETCH_TIMEOUT_MS = 10_000;
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

type InternalTab = {
  shell: BrowserTab;
  view: WebContentsView | null;
  viewLoadPromise: Promise<WebContentsView> | null;
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
  popupGesture: {
    source: 'assistant' | 'user';
    assistantOwnerId: string | null;
    expiresAt: number;
    frameTreeNodeId?: number;
    kind?: 'pointerdown' | 'keydown' | 'wheel' | 'input' | 'touchstart';
  } | null;
  scriptTainted: boolean;
  privateNetworkNewDocumentGuard?: { contentsId: number; identifier: string };
  trustedUserNavigation: boolean;
  trustedUserNavigationTarget: string | null;
  trustedUserNavigationRequestId: number | null;
  trustedUserNavigationLease: number;
  trustedGestureGeneration: number;
  visibleAssistantGeneration: number;
  unrestrictedNetworkGeneration: number;
  unrestrictedNetworkValidations: Map<string, Promise<void>>;
  unrestrictedNetworkUnsafe: boolean;
  queue: BrowserActionQueue;
  overlayGeneration: number;
  overlayTimer: ReturnType<typeof setTimeout> | null;
  overlayCssKey: string | null;
  overlayCssText: string | null;
  isPopup: boolean;
};

type BrowserAutomationInputArm = {
  token: string;
  kind: 'pointerdown' | 'keydown' | 'wheel' | 'input';
  expiresAt: number;
  x?: number;
  y?: number;
  screenX?: number;
  screenY?: number;
  key?: string;
  inputType?: string;
  data?: string;
};

type PendingAutomationGesture = {
  tabId: string;
  assistantOwnerId: string;
  expiresAt: number;
  inputData?: string;
};

type PendingSyntheticInput = {
  tabId: string;
  arm: BrowserAutomationInputArm;
  expectedType: Electron.InputEvent['type'];
  error?: Error;
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
  detachDebugger: boolean;
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
  | 'activate'
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
  item: DownloadItem;
  done: Promise<void>;
  cancel: () => Promise<void>;
};

type BrowserConfigPreemption = {
  scopeKeys: ReadonlySet<string>;
  scopeChanged: boolean;
  disabling: boolean;
  controlPolicyTightened: boolean;
  privateNetworkTightened: boolean;
  connectionDrain: Promise<void>;
  downloadDrain: Promise<void>;
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
  prompt: BrowserAuthPrompt;
  callback: (username?: string, password?: string) => void;
  timer: ReturnType<typeof setTimeout>;
};

function now(): string {
  return new Date().toISOString();
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
  private readonly vaults = new Map<string, BrowserCredentialVault>();
  private readonly wiredSessions = new WeakSet<Session>();
  private readonly wiredSessionsByScope = new Map<string, Session>();
  private readonly wiredSessionCleanups = new Map<string, () => void>();
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
  private readonly faviconFetches = new Map<string, PendingFaviconFetch>();
  private readonly webContentsToTab = new Map<number, string>();
  private readonly pendingTabCreations = new Map<string, number>();
  private readonly removedConversations = new Set<string>();
  private readonly assistantRuns = new BrowserAssistantRunRegistry();
  private readonly pendingAssistantContinuations = new Map<string, PendingAssistantContinuation>();
  private assistantTabCleanups?: Map<string, Set<Promise<void>>>;
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
  private readonly pendingSyntheticInputs = new Map<number, PendingSyntheticInput>();
  private readonly panelAuthorityGenerations = new Map<string, number>();
  /** Host bounds and page zoom both change the coordinate space used by
   * Chromium input events. Physical assistant actions capture this generation
   * before queueing and must re-resolve their target after either changes. */
  private readonly panelLayoutGenerations = new Map<string, number>();
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
  /** Screenshot capture and encoding can each hold buffers near the global
   * pixel ceiling. Serialize them across tabs to cap process-wide peak memory
   * while each tab's own action queue still preserves document ordering. */
  private readonly screenshotQueue = new BrowserActionQueue();
  /** Only one native Browser page can be attached to the primary window at a
   * time. Serialize every assistant operation that must become visible so a
   * parallel call cannot switch tabs underneath another call's document lease. */
  private readonly visibleAssistantQueue = new BrowserActionQueue();
  private shutdownPromise: Promise<void> | null = null;
  private attachedView: WebContentsView | null = null;
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
    this.refreshPendingCleanupQuarantine();
    ipcMain.on('browser-page:sensitive', this.handleSensitiveEvent);
    ipcMain.on('browser-page:login-submitted', this.handleLoginSubmitted);
    ipcMain.on('browser-page:activity', this.handlePageActivity);
    ipcMain.on('browser-page:gesture', this.handlePageGesture);
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
        this.invalidatePhysicalAssistantActions(this.tabs.get(this.activeTabs.get(conversationId) ?? ''));
        if (previousConversationId) this.notifyPanelStateChanged(previousConversationId);
        this.notifyPanelStateChanged(conversationId);
      }
      const win = this.getWindow();
      if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.focus();
    } else if (this.chromeFocusConversationId === conversationId) {
      this.chromeFocusConversationId = null;
      this.invalidatePhysicalAssistantActions(this.tabs.get(this.activeTabs.get(conversationId) ?? ''));
      this.notifyPanelStateChanged(conversationId);
    }
  }

  /** BrowserWindow focus and visibility are native state, so React bounds
   * updates cannot wake operations waiting for them. Main forwards the native
   * window lifecycle events here. Losing foreground authority revokes queued
   * physical input; hiding/minimizing also revokes operations whose output or
   * credential fill was promised to be visible. */
  handleHostWindowVisibilityChanged(): void {
    if (this.disposed || this.shuttingDown) return;
    const shown = this.isHostWindowShown();
    const interactive = shown && this.isHostWindowInteractive();
    const lostShown = this.hostWindowShown && !shown;
    const lostInteraction = this.hostWindowInteractive && !interactive;
    this.hostWindowShown = shown;
    this.hostWindowInteractive = interactive;

    if (lostShown || lostInteraction) {
      for (const tab of this.tabs.values()) {
        if (lostShown) this.invalidateVisibleAssistantOperations(tab);
        if (lostInteraction) this.invalidatePhysicalAssistantActions(tab);
      }
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
    void this.cancelActiveAssistantDownloads();
    void this.cancelAssistantContinuations();
    this.assistantRuns.clear();
    this.automationGestureTokens.clear();

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
      await Promise.all([this.visibleAssistantQueue.whenIdle(), ...affectedTabs.map((tab) => tab.queue.whenIdle())]);
      await Promise.all([downloadDrain, preemption?.downloadDrain]);
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

  private assertConversationAvailable(conversationId: string): void {
    if (this.isConversationAvailable(conversationId)) return;
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

  private storeForScope(scopeKey: string): BrowserProfileStore {
    let store = this.stores.get(scopeKey);
    if (!store) {
      store = new BrowserProfileStore(this.appHome, scopeKey, undefined, (area, error) => {
        this.emitProfileErrorForScope(scopeKey, area, error);
      });
      this.stores.set(scopeKey, store);
    }
    return store;
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
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) {
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
    const requests = this.scopeRequestActivities.get(scopeKey);
    const finish = requests?.get(requestId);
    if (!finish) return;
    requests!.delete(requestId);
    if (requests!.size === 0) this.scopeRequestActivities.delete(scopeKey);
    finish();
  }

  private finishAllScopeRequestActivities(scopeKey: string): void {
    const requests = this.scopeRequestActivities.get(scopeKey);
    if (!requests) return;
    this.scopeRequestActivities.delete(scopeKey);
    for (const finish of requests.values()) finish();
  }

  private runTabOperation<T>(tab: InternalTab, operation: () => Promise<T>): Promise<T> {
    return tab.queue.run(() => this.withScopeActivity(tab.scopeKey, operation));
  }

  private assistantDownloadOwner(tab: InternalTab): string | null {
    if (tab.shell.owner !== 'assistant') return null;
    if (tab.aiControlOwnerId) return tab.aiControlOwnerId;
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
        void this.expireAssistantContinuation(key, pending);
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
        if (gesture.assistantOwnerId === predecessorRunId) this.automationGestureTokens.delete(token);
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
      }
      for (const download of this.activeDownloads.values()) {
        if (download.conversationId !== conversationId || download.assistantOwnerId !== predecessorRunId) continue;
        download.assistantOwnerId = runId;
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
      await Promise.allSettled([
        this.cleanupAssistantStateOwnedByRun(conversationId, predecessorRunId),
        this.cleanupAssistantStateOwnedByRun(conversationId, runId),
      ]);
      this.emitTabs(conversationId);
      throw error;
    } finally {
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
    try {
      await Promise.all(pendingContinuations.map((pending) => pending.drain));
      if (!closeTabs || this.disposed) return;
      const conversations = new Set<string>();
      await Promise.all(
        pendingContinuations.map(async (pending) => {
          await this.cleanupAssistantStateOwnedByRun(pending.conversationId, pending.runId);
          conversations.add(pending.conversationId);
        }),
      );
      for (const conversationId of conversations) this.emitTabs(conversationId);
    } finally {
      for (const pending of pendingContinuations) {
        this.assistantContinuationLeases.delete(assistantContinuationKey(pending.conversationId, pending.runId));
      }
    }
  }

  private async expireAssistantContinuation(key: string, pending: PendingAssistantContinuation): Promise<void> {
    if (this.pendingAssistantContinuations.get(key) !== pending) return;
    this.pendingAssistantContinuations.delete(key);
    await this.finishAssistantContinuations([pending], true);
  }

  private async cleanupAssistantStateOwnedByRun(conversationId: string, runId: string): Promise<void> {
    for (const [token, gesture] of this.automationGestureTokens) {
      if (gesture.assistantOwnerId === runId) this.automationGestureTokens.delete(token);
    }
    let guardedActiveTabToRestore: string | null = null;
    for (const id of [...(this.tabOrder.get(conversationId) ?? [])]) {
      const tab = this.tabs.get(id);
      if (!tab) continue;
      if (shouldCleanupAssistantTab(tab.shell, tab.assistantOwnerId, runId)) {
        this.closeTab(tab, false);
        continue;
      }
      if (tab.popupGesture?.assistantOwnerId === runId) tab.popupGesture = null;
      // User-owned and explicitly kept-open tabs survive the run, but their
      // document may still contain AI-scheduled work. Revoke the expired run's
      // control capability while retaining the private-network restriction
      // until a verified user navigation replaces or reloads that document.
      if (tab.aiControlOwnerId === runId) {
        tab.aiControlOwnerId = null;
        tab.aiControlGeneration = null;
        if ((tab.scriptTainted || tab.privateNetworkNewDocumentGuard) && tab.view) {
          const guardedOnly = !tab.scriptTainted && !!tab.privateNetworkNewDocumentGuard;
          // Arbitrary evaluation can leave timers, dedicated workers, event
          // listeners, and authenticated fetches alive in the page. A
          // structured action also installs an irreversible WebRTC membrane.
          // Retained user/kept-open tabs preserve only their shell and profile;
          // destroy either renderer at the run boundary. Script-evaluated pages
          // still require an explicit user reload, while guard-only pages can be
          // restored immediately under the retained strict network policy.
          tab.generation++;
          this.destroyView(tab);
          tab.shell.discarded = true;
          tab.shell.sensitive = false;
          if (guardedOnly && this.activeTabs.get(conversationId) === tab.shell.id) {
            guardedActiveTabToRestore = tab.shell.id;
          }
        }
      }
    }
    // Chromium downloads can survive their initiating WebContents, including a
    // tab closed before turn cleanup begins. Cancel by captured run ownership,
    // not by rediscovering the download through the current tab list.
    await this.cancelActiveDownloadsForAssistantRun(conversationId, runId);
    if (guardedActiveTabToRestore) {
      this.restoreActiveViewAfterClose(conversationId, guardedActiveTabToRestore);
    }
  }

  assertAssistantRun(conversationId: string, run: BrowserAssistantRun): void {
    throwIfBrowserAborted(run.abortSignal);
    this.assistantRuns.assertActive(conversationId, run.id);
  }

  private assistantGeneration(conversationId: string, runId: string): number {
    return this.assistantRuns.assertActive(conversationId, runId);
  }

  private async withAssistantControl<T>(
    tab: InternalTab,
    run: BrowserAssistantRun,
    operation: (documentLease: AssistantDocumentLease) => Promise<T>,
  ): Promise<T> {
    throwIfBrowserAborted(run.abortSignal);
    const ownerRunActive = tab.assistantOwnerId
      ? this.assistantRuns.generationIfActive(tab.shell.conversationId, tab.assistantOwnerId) !== null
      : false;
    if (!assistantMayControlTab(tab.shell.owner, tab.assistantOwnerId, run.id, tab.shell.keepOpen, ownerRunActive)) {
      throw new Error('This temporary browser tab belongs to another active assistant run.');
    }
    const lease = this.assistantRuns.acquire(tab.shell.conversationId, run.id);
    tab.aiActionDepth++;
    try {
      const documentLease = await this.guardAssistantTab(tab, run, lease.generation);
      throwIfBrowserAborted(run.abortSignal);
      return await operation(documentLease);
    } finally {
      tab.aiActionDepth = Math.max(0, tab.aiActionDepth - 1);
      tab.aiActionUntil = Date.now() + AUTOMATION_ACTIVITY_GRACE_MS;
      lease.release();
      if (tab.aiNetworkReleaseRequested) this.releaseAiNetworkRestrictionForUser(tab);
    }
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

  private browserPageLeaseToken(lease: BrowserPageLease): string {
    return [lease.tabId, lease.tabGeneration, lease.userNavigationLease, lease.contents.id].join(':');
  }

  private async ensureAssistantView(
    tab: InternalTab,
    run: BrowserAssistantRun,
    lease: AssistantDocumentLease,
    timeoutMs = ASSISTANT_PAGE_LOAD_TIMEOUT_MS,
  ): Promise<WebContentsView> {
    const hadReadyView = !!tab.view && !tab.view.webContents.isDestroyed() && !tab.viewLoadPromise;
    const view = await this.ensureView(tab, run.abortSignal, timeoutMs);
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
        await this.installPrivateNetworkNewDocumentGuard(tab, view.webContents);
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
    return view;
  }

  private async withAssistantScriptPopupAttribution<T>(tab: InternalTab, operation: () => Promise<T>): Promise<T> {
    tab.assistantScriptDepth++;
    try {
      return await operation();
    } finally {
      tab.assistantScriptDepth = Math.max(0, tab.assistantScriptDepth - 1);
    }
  }

  private createAutomationGestureArm(
    tab: InternalTab,
    contents: WebContents,
    input: Omit<BrowserAutomationInputArm, 'token' | 'expiresAt'>,
  ): BrowserAutomationInputArm {
    const assistantOwnerId = tab.aiControlOwnerId;
    if (!assistantOwnerId) throw new Error('Assistant input lost ownership of this browser tab.');
    const token = randomUUID();
    const expiresAt = Date.now() + AUTOMATION_GESTURE_ARM_MS;
    this.automationGestureTokens.set(token, {
      tabId: tab.shell.id,
      assistantOwnerId,
      expiresAt,
      ...(input.data !== undefined ? { inputData: input.data } : {}),
    });
    // Attribute the input in main before Chromium dispatches it. A page-level
    // window capture handler can synchronously call window.open() before the
    // preload's document listener reports the one-shot token; without this
    // early marker that popup could inherit a stale real-user gesture.
    tab.popupGesture = {
      source: 'assistant',
      assistantOwnerId,
      expiresAt,
      kind: input.kind,
    };
    // Text is retained only in main for a one-shot comparison when the target
    // frame reports the trusted input event. Broadcasting it to every preload
    // would disclose typed secrets to every unrelated cross-origin frame.
    const { data: _privateInputData, ...publicInput } = input;
    const arm: BrowserAutomationInputArm = { ...publicInput, token, expiresAt };
    const win = this.getWindow();
    // A detached page cannot receive real pointer input from the user. Match
    // its synthetic event by kind only so clicks delivered inside an OOPIF do
    // not fail on frame-local client coordinates while React mounts the panel.
    if (input.x !== undefined && input.y !== undefined && this.attachedView !== tab.view) {
      delete arm.x;
      delete arm.y;
    }
    if (
      input.x !== undefined &&
      input.y !== undefined &&
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
    const expiry = setTimeout(() => this.automationGestureTokens.delete(token), AUTOMATION_GESTURE_ARM_MS);
    expiry.unref?.();
    return arm;
  }

  private publishAutomationGestureArm(contents: WebContents, arm: BrowserAutomationInputArm): void {
    try {
      for (const frame of contents.mainFrame.framesInSubtree) {
        if (!frame.detached && !frame.isDestroyed()) frame.send('browser-page:arm-automation-input', arm);
      }
    } catch {
      this.automationGestureTokens.delete(arm.token);
      throw new Error('The browser page changed before assistant input could be attributed.');
    }
  }

  private armAutomationGesture(
    tab: InternalTab,
    contents: WebContents,
    input: Omit<BrowserAutomationInputArm, 'token' | 'expiresAt'>,
  ): void {
    const arm = this.createAutomationGestureArm(tab, contents, input);
    this.publishAutomationGestureArm(contents, arm);
  }

  /** Electron emits before-mouse-event / before-input-event synchronously inside
   * sendInputEvent(). Arm the page only from that exact callback, so a physical
   * user event at the same coordinates/key cannot consume a shape-matched token
   * while the synthetic event is still queued. */
  private sendAttributedInputEvent(
    tab: InternalTab,
    contents: WebContents,
    input: Omit<BrowserAutomationInputArm, 'token' | 'expiresAt'>,
    event: Electron.MouseInputEvent | Electron.MouseWheelInputEvent | Electron.KeyboardInputEvent,
  ): void {
    if (this.pendingSyntheticInputs.has(contents.id)) {
      throw new Error('Another attributed browser input is already being dispatched.');
    }
    const previousGesture = tab.popupGesture;
    const arm = this.createAutomationGestureArm(tab, contents, input);
    const pending: PendingSyntheticInput = {
      tabId: tab.shell.id,
      arm,
      expectedType: event.type,
    };
    this.pendingSyntheticInputs.set(contents.id, pending);
    try {
      contents.sendInputEvent(event);
      if (pending.error) throw pending.error;
      if (this.pendingSyntheticInputs.get(contents.id) === pending) {
        throw new Error('Chromium did not confirm the attributed browser input before dispatch.');
      }
    } catch (error) {
      this.automationGestureTokens.delete(arm.token);
      tab.popupGesture = previousGesture;
      throw error;
    } finally {
      if (this.pendingSyntheticInputs.get(contents.id) === pending) {
        this.pendingSyntheticInputs.delete(contents.id);
      }
    }
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
    if (tab.scriptTainted || tab.privateNetworkNewDocumentGuard) {
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
    tab.trustedUserNavigationLease = lease;
    tab.trustedUserNavigation = true;
    tab.trustedUserNavigationTarget = targetUrl;
    tab.trustedUserNavigationRequestId = null;
    return lease;
  }

  private clearTrustedUserNavigation(tab: InternalTab, lease?: number): boolean {
    if (lease !== undefined && tab.trustedUserNavigationLease !== lease) return false;
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

  private isHostWindowInteractive(): boolean {
    const win = this.getWindow();
    return !!win && !win.isDestroyed() && win.isVisible() && !win.isMinimized() && win.isFocused();
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

  private notifyPanelStateChanged(conversationId: string): void {
    for (const waiter of [...(this.panelStateWaiters.get(conversationId) ?? [])]) waiter();
  }

  private async waitForAssistantView(
    tab: InternalTab,
    view: WebContentsView,
    abortSignal: AbortSignal | undefined,
    documentLease: AssistantDocumentLease,
    assertOperationAuthority: () => void,
    requireInteraction: boolean,
  ): Promise<void> {
    const conversationId = tab.shell.conversationId;
    const attachIfVisible = (): boolean => {
      if (this.disposed || this.shuttingDown) throw new Error('The in-app browser is unavailable.');
      throwIfBrowserAborted(abortSignal);
      this.assertAssistantDocumentLease(tab, documentLease);
      assertOperationAuthority();
      if (!this.isHostWindowShown()) return false;
      if (
        requireInteraction &&
        (!this.isHostWindowInteractive() || this.chromeFocusConversationId === conversationId)
      ) {
        return false;
      }
      this.attachActiveView(conversationId, requireInteraction);
      return (
        this.isHostWindowShown() &&
        (!requireInteraction ||
          (this.isHostWindowInteractive() && this.chromeFocusConversationId !== conversationId)) &&
        this.mountedConversationId === conversationId &&
        this.mountedBounds !== null &&
        this.activeTabs.get(conversationId) === tab.shell.id &&
        tab.view === view &&
        !view.webContents.isDestroyed() &&
        this.attachedView === view
      );
    };

    if (attachIfVisible()) return;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const waiters = this.panelStateWaiters.get(conversationId) ?? new Set<() => void>();
      this.panelStateWaiters.set(conversationId, waiters);
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        abortSignal?.removeEventListener('abort', onAbort);
        waiters.delete(check);
        if (waiters.size === 0) this.panelStateWaiters.delete(conversationId);
      };
      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error);
        else resolve();
      };
      const check = () => {
        try {
          if (attachIfVisible()) finish();
        } catch (error) {
          finish(error);
        }
      };
      const onAbort = () => finish(new Error('Browser action was cancelled.'));
      timer = setTimeout(
        () =>
          finish(
            new Error(
              requireInteraction
                ? 'The Browser page did not become visible and interactive before assistant input was ready. Focus Browser and retry.'
                : 'The Browser page did not become visible before the assistant operation was ready. Reopen Browser and retry.',
            ),
          ),
        ASSISTANT_VIEW_ATTACH_TIMEOUT_MS,
      );
      timer.unref?.();
      abortSignal?.addEventListener('abort', onAbort, { once: true });
      waiters.add(check);
      check();
    });
  }

  private waitForPhysicalActionView(
    tab: InternalTab,
    view: WebContentsView,
    abortSignal: AbortSignal | undefined,
    documentLease: AssistantDocumentLease,
    assertPhysicalActionAuthority: () => void,
  ): Promise<void> {
    return this.waitForAssistantView(tab, view, abortSignal, documentLease, assertPhysicalActionAuthority, true);
  }

  private waitForVisibleAssistantOperationView(
    tab: InternalTab,
    view: WebContentsView,
    abortSignal: AbortSignal | undefined,
    documentLease: AssistantDocumentLease,
  ): Promise<void> {
    return this.waitForAssistantView(tab, view, abortSignal, documentLease, () => undefined, false);
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
  ): Promise<void> {
    if (tab.shell.sensitive) {
      throw new Error(`${operation} is blocked while this tab contains password data.`);
    }
    let sensitive = (await this.evaluateWithDeadline(
      tab,
      contents,
      SENSITIVE_SCAN_SCRIPT,
      abortSignal,
      documentLease,
    )) as boolean;
    if (!sensitive) {
      sensitive = await this.runRendererOperationWithDeadline(
        tab,
        contents,
        'Browser password-field scan',
        EVALUATE_TIMEOUT_MS,
        async () =>
          (await this.hasPopulatedPasswordFieldInChildFrames(contents)) ||
          (await this.hasPopulatedPasswordFieldViaCdp(contents)),
        abortSignal,
        documentLease,
      );
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
  private async hasPopulatedPasswordFieldViaCdp(contents: WebContents): Promise<boolean> {
    const wasAttached = contents.debugger.isAttached();
    if (!wasAttached) contents.debugger.attach('1.3');
    const budget: CdpSensitiveScanBudget = {
      elementsRemaining: MAX_DOM_ELEMENTS_FOR_CDP_SENSITIVE_SCAN,
      nodesRemaining: MAX_DOM_NODES_FOR_CDP_SENSITIVE_SCAN,
      inputsRemaining: MAX_INPUT_FIELDS_FOR_CDP_SCAN,
    };
    try {
      if (await this.scanSensitiveCdpSession(contents, budget)) return true;

      const oopifFrameTreeNodeIds = this.liveOopifFrameTreeNodeIds(contents);
      if (oopifFrameTreeNodeIds === null) return true;
      if (oopifFrameTreeNodeIds.size === 0) return false;
      if (oopifFrameTreeNodeIds.size > MAX_CDP_SENSITIVE_SCAN_TARGETS) return true;
      return await this.hasSensitiveRelatedOopifTarget(contents, budget, oopifFrameTreeNodeIds);
    } finally {
      if (!wasAttached && !contents.isDestroyed() && contents.debugger.isAttached()) contents.debugger.detach();
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

  captureDocumentApproval(conversationId: string, tabId?: string): BrowserDocumentApproval {
    const tab = this.requireTab(conversationId, tabId);
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
    const tab = this.requireTab(conversationId, tabId);
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

  captureTabsApproval(conversationId: string, action: BrowserTabsMutationAction, tabId?: string): BrowserTabsApproval {
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

    const tab = this.requireTab(conversationId, tabId);
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
            popupGesture: null,
            scriptTainted: false,
            trustedUserNavigation: false,
            trustedUserNavigationTarget: null,
            trustedUserNavigationRequestId: null,
            trustedUserNavigationLease: 0,
            trustedGestureGeneration: 0,
            visibleAssistantGeneration: 0,
            unrestrictedNetworkGeneration: 0,
            unrestrictedNetworkValidations: new Map(),
            unrestrictedNetworkUnsafe: false,
            queue: new BrowserActionQueue(),
            overlayGeneration: 0,
            overlayTimer: null,
            overlayCssKey: null,
            overlayCssText: null,
            isPopup: false,
          };
          createdTab = tab;
          this.tabs.set(id, tab);
          this.tabOrder.set(request.conversationId, [...order, id]);
          releaseSlot();
          slotReserved = false;
          if (!request.background || !this.activeTabs.has(request.conversationId)) {
            const previousActiveId = this.activeTabs.get(request.conversationId);
            if (previousActiveId && previousActiveId !== id) {
              this.invalidateVisibleAssistantOperations(this.tabs.get(previousActiveId));
              if (owner === 'user') {
                this.invalidatePhysicalAssistantActions(this.tabs.get(previousActiveId));
              }
            }
            this.activeTabs.set(request.conversationId, id);
            this.notifyPanelStateChanged(request.conversationId);
          }

          // Start view creation synchronously so the tab owns its WebContents before
          // the panel mounts, but publish the tab/panel before awaiting loadURL. HTTP
          // auth and permission prompts can pause that load and need a mounted prompt
          // surface to resolve it.
          // Assistant tabs are first published as shells when their chat's
          // Browser panel is not mounted. A restricted WebContents must verify
          // its current-frame network membrane before loading, and Chromium
          // does not reliably schedule that initial document while the native
          // view is detached. The open-panel event below lets mount() create
          // and attach the renderer before joining its load. User foreground
          // tabs retain their existing detached-navigation behavior for direct
          // toolbar/IPC calls made just before a panel mount.
          const canCreateBeforePanelMount = owner === 'user' && !request.background;
          const viewReady =
            canCreateBeforePanelMount || this.mountedConversationId === request.conversationId
              ? this.ensureView(
                  tab,
                  assistantRun?.abortSignal,
                  owner === 'assistant' ? ASSISTANT_PAGE_LOAD_TIMEOUT_MS : 0,
                )
              : null;
          // A background shell can exist before the Browser panel ever mounts.
          // Publish that state as discarded so an ask-policy approval captured
          // now explicitly authorizes the shell's one internal renderer restore.
          if (!viewReady) shell.discarded = true;
          this.emitTabs(request.conversationId);
          published = true;
          if (shell.owner === 'assistant') {
            this.emit({
              type: 'open-panel',
              conversationId: request.conversationId,
              tabId: id,
            });
          }
          if (viewReady) {
            await viewReady;
            if (!request.background) this.attachActiveView(request.conversationId);
          }
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
    if (source === 'assistant') {
      this.emit({ type: 'open-panel', conversationId, tabId });
    }
    if (source === 'assistant' && (command === 'close-others' || command === 'close-right')) {
      return this.commandAssistantMultiTabClose(tab, command, assistantRun!, approvedTabs);
    }
    const operation = () =>
      source === 'assistant'
        ? this.withAssistantControl(tab, assistantRun!, (documentLease) =>
            this.commandTabWithinOperation(tab, command, source, assistantRun, documentLease, approvedTabs),
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
    return this.runTabOperation(tab, () =>
      this.withAssistantControl(tab, assistantRun, async (documentLease) => {
        this.assertAssistantDocumentLease(tab, documentLease);
        this.assertBrowserTabsTargetApproval(conversationId, 'duplicate', tab, approvedTabs);
        if (this.tabs.get(tabId) !== tab) throw new Error('This browser tab has been closed.');
        if (tab.shell.sensitive) {
          throw new Error('Duplicating a tab is blocked while it contains password data.');
        }
        return this.createTab({ conversationId, url: tab.shell.url, owner: 'assistant' }, assistantRun);
      }),
    );
  }

  private async commandAssistantMultiTabClose(
    tab: InternalTab,
    command: 'close-others' | 'close-right',
    assistantRun: BrowserAssistantRun,
    approvedTabs?: BrowserTabsApproval,
  ): Promise<void> {
    const { conversationId, id: tabId } = tab.shell;
    const lease = this.assistantRuns.acquire(conversationId, assistantRun.id);
    try {
      // Validate and serialize against work on the retained target, then release
      // its queue before waiting on other tab queues to avoid cross-tab deadlocks.
      await this.runTabOperation(tab, () =>
        this.withAssistantControl(tab, assistantRun, async () => {
          if (approvedTabs) {
            this.assertBrowserMultiTabApproval(
              conversationId,
              command === 'close-others' ? 'close_others' : 'close_right',
              tab,
              approvedTabs,
            );
          }
        }),
      );
      const order = approvedTabs?.tabOrder ?? [...(this.tabOrder.get(conversationId) ?? [])];
      const targetIds =
        approvedTabs?.affectedTabIds ??
        (command === 'close-others' ? order.filter((id) => id !== tabId) : order.slice(order.indexOf(tabId) + 1));
      const targets = targetIds.map((id) => ({ id, tab: this.tabs.get(id) }));
      for (const { tab: target } of targets) {
        const ownerRunActive = target?.assistantOwnerId
          ? this.assistantRuns.generationIfActive(conversationId, target.assistantOwnerId) !== null
          : false;
        if (
          target &&
          !assistantMayControlTab(
            target.shell.owner,
            target.assistantOwnerId,
            assistantRun.id,
            target.shell.keepOpen,
            ownerRunActive,
          )
        ) {
          throw new Error('A temporary browser tab in this range belongs to another active assistant run.');
        }
      }
      await Promise.all(
        targets.map(async ({ tab: other }) => {
          if (!other) return;
          await this.runTabOperation(other, () =>
            this.withAssistantControl(other, assistantRun, async () => {
              throwIfBrowserAborted(assistantRun.abortSignal);
              if (lease.generation !== this.assistantGeneration(conversationId, assistantRun.id)) {
                throw new Error('The assistant browser turn ended before tabs could be closed.');
              }
            }),
          );
        }),
      );
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
      for (const { id, tab: other } of targets) {
        if (!other || this.tabs.get(id) !== other) {
          throw new Error('A browser tab changed while the close operation was waiting.');
        }
      }
      // All affected queues have drained and the approved order is still exact.
      // Close the captured identities synchronously so a newly opened or moved
      // tab can never be swept into the operation.
      for (const { tab: other } of targets) this.closeTab(other!, false);
      this.emitTabs(conversationId);
    } finally {
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
      if (action !== 'activate' && action !== 'close' && action !== 'keep_open') {
        throw new Error('The approved browser tab command no longer matches this operation.');
      }
      this.assertBrowserTabsTargetApproval(conversationId, action, tab, approvedTabs);
    }
    if (source === 'user' && command === 'stop') this.clearTrustedUserNavigation(tab);
    const ensureCommandView = () =>
      source === 'assistant' ? this.ensureAssistantView(tab, assistantRun!, documentLease!) : this.ensureView(tab);
    const recreateScriptedViewForUser = async (): Promise<boolean> => {
      if (source !== 'user' || (!tab.scriptTainted && !tab.privateNetworkNewDocumentGuard)) return false;
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
        this.cancelElementPickersForConversation(conversationId);
        {
          const previousActiveId = this.activeTabs.get(conversationId);
          if (previousActiveId && previousActiveId !== tabId) {
            this.invalidateVisibleAssistantOperations(this.tabs.get(previousActiveId));
            if (source === 'user') {
              this.invalidatePhysicalAssistantActions(this.tabs.get(previousActiveId));
            }
          }
        }
        this.activeTabs.set(conversationId, tabId);
        tab.lastUsedAt = Date.now();
        // Publish the new active shell before a discarded tab begins its
        // potentially slow renderer/load restoration. The sidebar must switch
        // its toolbar state immediately even if that load later pauses on auth.
        this.emitTabs(conversationId);
        this.notifyPanelStateChanged(conversationId);
        await ensureCommandView();
        this.attachActiveView(conversationId, true);
        this.notifyPanelStateChanged(conversationId);
        break;
      case 'close':
        this.closeTab(tab);
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
          await this.reloadAssistantTab(tab, contents, false, abortSignal);
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
          await this.reloadAssistantTab(tab, contents, true, abortSignal);
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
        if (source === 'assistant') await this.navigateAssistantHistory(tab, contents, -1, abortSignal);
        else if (contents.navigationHistory.canGoBack()) {
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
        if (source === 'assistant') await this.navigateAssistantHistory(tab, contents, 1, abortSignal);
        else if (contents.navigationHistory.canGoForward()) {
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
    this.emitTabs(conversationId);
  }

  private closeTab(tab: InternalTab, emit = true, recordClosed = true): void {
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
    this.destroyView(tab);
    this.tabs.delete(id);
    this.releaseScopeRuntimeWhenIdle(tab.scopeKey);
    const nextOrder = previousOrder.filter((candidate) => candidate !== id);
    this.tabOrder.set(conversationId, nextOrder);
    if (this.activeTabs.get(conversationId) === id) {
      const next = nextOrder[Math.min(Math.max(0, closedIndex), nextOrder.length - 1)];
      if (next) this.activeTabs.set(conversationId, next);
      else this.activeTabs.delete(conversationId);
      this.restoreActiveViewAfterClose(conversationId, next);
    }
    if (emit) this.emitTabs(conversationId);
  }

  /** Closing the active tab can select an idle-discarded neighbor whose renderer
   * no longer exists. Recreate that visible page before attaching it; otherwise
   * the native surface stays blank until the user activates the tab a second
   * time. Hidden panels defer restoration to mount(), preserving idle memory. */
  private restoreActiveViewAfterClose(conversationId: string, tabId: string | undefined): void {
    const tab = tabId ? this.tabs.get(tabId) : undefined;
    if (
      !tab ||
      this.mountedConversationId !== conversationId ||
      !this.mountedBounds ||
      !this.browserEnabled ||
      tab.scriptTainted ||
      tab.shell.reloadRequired
    ) {
      this.attachActiveView(conversationId);
      return;
    }

    void this.ensureView(tab)
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
    const operation = async (documentLease?: AssistantDocumentLease) => {
      const url = normalizeOmniboxInput(input, this.config().searchProvider);
      const abortSignal = assistantRun?.abortSignal;
      if (documentLease && visibleAssistantGeneration !== undefined) {
        documentLease.visibleAssistantGeneration = visibleAssistantGeneration;
        this.assertAssistantDocumentLease(tab, documentLease);
      }
      throwIfBrowserAborted(abortSignal);
      if (source === 'user' && (tab.scriptTainted || tab.privateNetworkNewDocumentGuard)) {
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
        await this.runRendererOperationWithDeadline(
          tab,
          contents,
          'Browser page load',
          ASSISTANT_PAGE_LOAD_TIMEOUT_MS,
          () => contents.loadURL(url).then(() => undefined),
          abortSignal,
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
    if (this.config().aiAllowPrivateNetwork) return documentLease;
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
    allowPrivateNetwork = this.config().aiAllowPrivateNetwork,
  ): Promise<void> {
    const targetSession = session.fromPartition(partition);
    await assertAiNavigationAllowed(url, allowPrivateNetwork, async (hostname) => {
      // Do not authorize from a stale host-cache entry. HTTPS authentication
      // below protects the subsequent connection from a DNS rebind, while this
      // fresh lookup still rejects destinations that are already private.
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
      // no visible input authority to revoke; the action remains gated on the
      // subsequent non-null mount (or times out if the panel stays closed).
      if (this.mountedConversationId === null) {
        this.notifyPanelStateChanged(conversationId);
        return;
      }
      if (this.mountedConversationId !== conversationId) return;
      this.invalidatePanelAuthority(conversationId);
      const activeTab = this.tabs.get(this.activeTabs.get(conversationId) ?? '');
      this.invalidateVisibleAssistantOperations(activeTab);
      this.invalidatePhysicalAssistantActions(activeTab);
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
    if (!this.isConversationAvailable(conversationId)) {
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
      const previousActiveTab = this.tabs.get(this.activeTabs.get(previousMountedConversationId) ?? '');
      this.invalidateVisibleAssistantOperations(previousActiveTab);
      this.invalidatePhysicalAssistantActions(previousActiveTab);
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
    // An assistant-created tab can begin loading before its open-panel event
    // reaches React. If mount joins that in-flight load without attaching the
    // already-created native view, Chromium may never schedule the detached
    // initial document and both sides wait until the assistant deadline. Attach
    // whatever ensureView created synchronously, then attach again after any
    // asynchronous cleanup/restoration finished.
    const viewReady = this.ensureView(tab);
    this.attachActiveView(conversationId);
    await viewReady;
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
    const viewChanged = this.attachedView !== tab.view;
    if (viewChanged) {
      this.detachAttachedView();
      win.contentView.addChildView(tab.view);
      this.attachedView = tab.view;
    }
    tab.view.setBounds(this.mountedBounds);
    if (shouldFocusAttachedBrowserView(focusRequested)) tab.view.webContents.focus();
  }

  private detachAttachedView(): void {
    if (!this.attachedView) return;
    const win = this.getWindow();
    try {
      if (win && !win.isDestroyed()) win.contentView.removeChildView(this.attachedView);
    } catch {
      // Already detached during window teardown.
    }
    this.attachedView = null;
  }

  private async ensureView(
    tab: InternalTab,
    abortSignal?: AbortSignal,
    timeoutMs = abortSignal ? ASSISTANT_PAGE_LOAD_TIMEOUT_MS : 0,
  ): Promise<WebContentsView> {
    this.assertHostRendererOperationCurrent();
    if (this.disposed) throw new Error('The in-app browser has been disposed.');
    if (!this.config().enabled) throw new Error('The in-app browser is disabled in Settings.');
    this.requireLiveWindow();
    this.assertScopeAvailable(tab.scopeKey);
    if (this.tabs.get(tab.shell.id) !== tab) throw new Error('This browser tab has been closed.');
    const origin = normalizedOrigin(tab.shell.url);
    const originClearOwner = this.clearingOrigins.get(`${tab.scopeKey}\u0000${origin}`);
    if (originClearOwner && originClearOwner !== tab.shell.id) {
      throw new Error('This Browser origin is being prepared for assistant control.');
    }
    if (tab.view && !tab.view.webContents.isDestroyed()) {
      if (!tab.viewLoadPromise) return tab.view;
      // A user may have started this restoration without a deadline. An
      // assistant joining that shared load still needs its own abort/deadline;
      // cancellation reclaims the renderer so the original load and its queue
      // cannot retain the finished run indefinitely.
      return await this.runRendererOperationWithDeadline(
        tab,
        tab.view.webContents,
        'Browser page load',
        timeoutMs,
        () => tab.viewLoadPromise!,
        abortSignal,
      );
    }
    throwIfBrowserAborted(abortSignal);
    const pendingScriptCleanup = this.clearPendingScriptedOriginsBeforeRenderer(tab);
    if (pendingScriptCleanup) {
      await pendingScriptCleanup;
      throwIfBrowserAborted(abortSignal);
      this.assertScopeAvailable(tab.scopeKey);
      if (this.tabs.get(tab.shell.id) !== tab) throw new Error('This browser tab has been closed.');
    }
    const view = this.createView(tab);
    // createView installs the native surface synchronously. Attach an active
    // restored tab before waiting for a slow or auth-blocked load so the user
    // can see and stop it instead of staring at an empty Browser viewport.
    this.attachActiveView(tab.shell.conversationId);
    const guardInitialLoad =
      tab.aiNetworkRestricted && !tab.trustedUserNavigation && this.aiAllowPrivateNetwork === false;
    let initialGuardReady = !guardInitialLoad;
    const loadPromise = (async () => {
      try {
        await this.runRendererOperationWithDeadline(
          tab,
          view.webContents,
          'Browser page load',
          timeoutMs,
          async () => {
            if (guardInitialLoad) {
              await this.installPrivateNetworkNewDocumentGuard(tab, view.webContents);
              initialGuardReady = true;
            }
            await view.webContents.loadURL(tab.shell.url || 'about:blank');
          },
          abortSignal,
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
      if (this.tabs.get(tab.shell.id) !== tab || tab.view !== view || view.webContents.isDestroyed()) {
        throw new Error('The browser page was closed while it was loading.');
      }
      this.assertHostRendererOperationCurrent();
      return view;
    })();
    tab.viewLoadPromise = loadPromise;
    try {
      return await loadPromise;
    } finally {
      if (tab.viewLoadPromise === loadPromise) tab.viewLoadPromise = null;
    }
  }

  private createView(tab: InternalTab, inheritedOptions?: Electron.BrowserWindowConstructorOptions): WebContentsView {
    this.requireLiveWindow();
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
    // The opener already uses this profile, but explicitly pin the popup to the
    // tab's partition and Kai's sandboxed page preload instead of trusting any
    // window-feature preferences supplied by remote content.
    delete webPreferences.session;
    // The session-level frame preload runs in main and cross-origin child
    // frames without granting those pages Node integration.
    const activatePrivateNetworkGuard =
      tab.aiNetworkRestricted && !tab.trustedUserNavigation && this.aiAllowPrivateNetwork === false;
    Object.assign(webPreferences, browserWebPreferences(tab.partition, undefined, activatePrivateNetworkGuard));
    viewOptions.webPreferences = webPreferences as Electron.WebPreferences;
    const view = new WebContentsView(viewOptions);
    configureBrowserWebContents(view.webContents, !activatePrivateNetworkGuard);
    view.setBounds(
      this.mountedConversationId === tab.shell.conversationId && this.mountedBounds
        ? this.mountedBounds
        : DEFAULT_DETACHED_VIEW_BOUNDS,
    );
    tab.view = view;
    if (activatePrivateNetworkGuard) {
      // WebPreferences requested an already-restricted preload. This marker is
      // deliberately only "pending": installPrivateNetworkNewDocumentGuard()
      // must verify every live frame's main-world membrane before assistant
      // control can treat the renderer as guarded.
      tab.privateNetworkNewDocumentGuard = {
        contentsId: view.webContents.id,
        identifier: PRELOAD_PRIVATE_NETWORK_GUARD_PENDING_IDENTIFIER,
      };
    }
    tab.shell.discarded = false;
    tab.lastUsedAt = Date.now();
    this.webContentsToTab.set(view.webContents.id, tab.shell.id);
    this.wireWebContents(tab, view.webContents);
    view.webContents.setUserAgent(getChromeUserAgent());
    view.webContents.setZoomLevel(tab.shell.zoomLevel);
    view.webContents.setAudioMuted(tab.shell.muted);
    return view;
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
    const popupGesture =
      candidatePopupGesture?.source !== 'user' ||
      (initiatorFrameTreeNodeId !== null && candidatePopupGesture.frameTreeNodeId === initiatorFrameTreeNodeId)
        ? candidatePopupGesture
        : null;
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
      (!/^https?:|^about:blank$/i.test(popupUrl) ||
        (!this.config().aiAllowPrivateNetwork && isPrivateNetworkUrl(popupUrl)))
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
      aiActionDepth: 0,
      aiActionUntil: 0,
      aiNetworkReleaseRequested: false,
      aiNetworkReleaseTimer: null,
      assistantScriptDepth: 0,
      popupGesture: null,
      scriptTainted: scriptCreatedPopup,
      trustedUserNavigation: false,
      trustedUserNavigationTarget: null,
      trustedUserNavigationRequestId: null,
      trustedUserNavigationLease: 0,
      trustedGestureGeneration: 0,
      visibleAssistantGeneration: 0,
      unrestrictedNetworkGeneration: 0,
      unrestrictedNetworkValidations: new Map(),
      unrestrictedNetworkUnsafe: false,
      queue: new BrowserActionQueue(),
      overlayGeneration: 0,
      overlayTimer: null,
      overlayCssKey: null,
      overlayCssText: null,
      isPopup: true,
    };
    this.tabs.set(id, tab);
    this.tabOrder.set(conversationId, [...order, id]);
    const background = disposition === 'background-tab';
    if (!background) {
      const previousActiveId = this.activeTabs.get(conversationId);
      if (previousActiveId && previousActiveId !== id) {
        this.invalidateVisibleAssistantOperations(this.tabs.get(previousActiveId));
      }
      this.activeTabs.set(conversationId, id);
    }
    this.emitTabs(conversationId);
    if (shell.owner === 'assistant') this.emit({ type: 'open-panel', conversationId, tabId: id });
    return (options) => {
      try {
        const view = this.createView(tab, options);
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
    // Page.addScriptToEvaluateOnNewDocument registrations are target-scoped and
    // disappear with the WebContents. Clear the bookkeeping before close so a
    // later clean renderer never inherits the quarantined target identity.
    tab.privateNetworkNewDocumentGuard = undefined;
    tab.viewLoadPromise = null;
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
    tab.overlayCssKey = null;
    tab.overlayCssText = null;
    this.dropPendingForTab(tab.shell.id);
    tab.popupGesture = null;
    if (view) this.pendingSyntheticInputs.delete(view.webContents.id);
    for (const [token, pending] of this.automationGestureTokens) {
      if (pending.tabId === tab.shell.id) this.automationGestureTokens.delete(token);
    }
    if (!view) return;
    if (this.attachedView === view) this.detachAttachedView();
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
    contents.on('did-stop-loading', () => {
      if (!ownsContents()) return;
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
    contents.on('did-navigate', (_event, url) => {
      if (!ownsContents()) return;
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
      if (isTrustedUserNavigationTarget(tab.trustedUserNavigation, tab.trustedUserNavigationTarget, validatedURL)) {
        this.clearTrustedUserNavigation(tab, tab.trustedUserNavigationLease);
      }
      if (errorCode === -3) return; // ERR_ABORTED during normal navigation/stop.
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
      const stillOwnsContents = tab.view?.webContents === contents;
      if (!stillOwnsContents) return;
      this.dropPendingForTab(tab.shell.id);
      if (this.attachedView === tab.view) this.detachAttachedView();
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
    await stopRunningBrowserServiceWorkers(scopedSession, contents, requireSuccess);
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
      const scopeGeneration = this.currentScopeGeneration(scopeKey);
      let completed = false;
      const complete = (result: Electron.CallbackResponse): void => {
        if (completed) return;
        completed = true;
        const stale = this.scopeUnavailable(scopeKey) || this.currentScopeGeneration(scopeKey) !== scopeGeneration;
        const response = stale ? { cancel: true } : result;
        callback(response);
        // An admitted request owns its scope activity until Chromium reports a
        // terminal network event. Cancelled/stale requests never enter the
        // network stack, so release those immediately.
        if (response.cancel) this.finishScopeRequestActivity(scopeKey, details.id);
      };
      const tabId = details.webContentsId === undefined ? undefined : this.webContentsToTab.get(details.webContentsId);
      const tab = tabId ? this.tabs.get(tabId) : undefined;
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
        if (tab.trustedUserNavigationRequestId === null) tab.trustedUserNavigationRequestId = details.id;
        else tab.trustedUserNavigationTarget = details.url;
        complete({});
        return;
      }
      const unattributedScopeRestricted = tab
        ? false
        : this.scopeHasActiveAiNetworkRestriction(scopeKey) ||
          this.restrictedBackgroundScopes.has(scopeKey) ||
          this.storeForScope(scopeKey).isBackgroundNetworkRestricted();
      if (!shouldApplyAiRequestPolicy(tab?.aiNetworkRestricted, unattributedScopeRestricted)) {
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
      void this.assertAssistantNavigationAllowed(aiRequestPolicyUrl(details.url), partition).then(
        () => complete({}),
        (error: unknown) => {
          if (tab && this.tabs.get(tab.shell.id) === tab) {
            tab.shell.loading = false;
            tab.shell.error = error instanceof Error ? error.message : String(error);
            this.emitTabs(tab.shell.conversationId);
          }
          complete({ cancel: true });
        },
      );
    });
    const finishRequest = (details: { id: number }): void => {
      this.finishScopeRequestActivity(scopeKey, details.id);
    };
    ses.webRequest.onCompleted(requestFilter, finishRequest);
    ses.webRequest.onErrorOccurred(requestFilter, finishRequest);
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
      if (
        !assistantTriggered &&
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
      // its original creator. User-owned tabs always retain their downloads,
      // even while the assistant concurrently operates the page.
      const assistantOwnerId = this.assistantDownloadOwner(tab);
      const scopeGeneration = this.currentScopeGeneration(scopeKey);
      let lastPublishedAt = 0;
      let pendingPublish: ReturnType<typeof setTimeout> | null = null;
      let terminalWrite: Promise<void> | null = null;
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
      item.setSaveDialogOptions({
        defaultPath: join(app.getPath('downloads'), item.getFilename()),
      });
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
          path: item.getSavePath() || undefined,
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
      const onUpdated = () => {
        void publish('progressing');
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
        terminalWrite = publish(state, true, allowStaleGeneration).finally(() => {
          this.activeDownloads.delete(item);
          this.releaseScopeRuntimeWhenIdle(scopeKey);
          resolveDone();
        });
        return terminalWrite;
      };
      const onDone = (_doneEvent: Electron.Event, state: 'completed' | 'cancelled' | 'interrupted'): void => {
        void finish(state);
      };
      const activeDownload: ActiveBrowserDownload = {
        id,
        scopeKey,
        conversationId,
        tabId: originatingTabId,
        assistantOwnerId,
        keepOpen: tab.shell.keepOpen,
        item,
        done,
        cancel: () => {
          if (terminalWrite) return terminalWrite;
          removeListeners();
          try {
            item.cancel();
          } catch {
            // Persist the terminal intent even if Chromium raced the cancellation.
          }
          return finish('cancelled', true);
        },
      };
      this.activeDownloads.set(item, activeDownload);
      item.on('updated', onUpdated);
      item.on('done', onDone);
      void publish('progressing', true);
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
                contents.downloadURL(params.srcURL);
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
              mode: 'viewport',
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

  private handlePageGesture = (
    event: IpcMainEvent,
    payload?: { token?: unknown; kind?: unknown; data?: unknown },
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
      if (
        !pending ||
        pending.expiresAt < at ||
        pending.tabId !== tab.shell.id ||
        pending.assistantOwnerId !== tab.aiControlOwnerId ||
        (pending.inputData !== undefined &&
          (typeof payload.data !== 'string' ||
            payload.data.length > MAX_BROWSER_TYPED_VALUE_CHARS ||
            payload.data !== pending.inputData))
      ) {
        if (pending?.expiresAt !== undefined && pending.expiresAt < at) {
          this.automationGestureTokens.delete(payload.token);
        }
        event.returnValue = false;
        return;
      }
      this.automationGestureTokens.delete(payload.token);
      tab.popupGesture = {
        source: 'assistant',
        assistantOwnerId: pending.assistantOwnerId,
        expiresAt: at + POPUP_GESTURE_PROVENANCE_MS,
        frameTreeNodeId: event.senderFrame?.frameTreeNodeId,
        kind,
      };
    } else {
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
    if (!tab) return;
    event.preventDefault();
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
      assistantTriggered: tab.aiNetworkRestricted,
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
    if (!contents || contents.isDestroyed()) return;
    const payload = action
      ? {
          status: action.status,
          summary: action.summary ?? action.kind,
          x: action.x,
          y: action.y,
        }
      : null;
    const previousKey = tab.overlayCssKey;
    const previousCssText = tab.overlayCssText;
    tab.overlayCssKey = null;
    tab.overlayCssText = null;
    let previousOverlayRemoved = false;
    try {
      if (previousKey) {
        await this.runRendererOperationWithDeadline(
          tab,
          contents,
          'Browser automation overlay',
          AUTOMATION_OVERLAY_TIMEOUT_MS,
          () => contents.removeInsertedCSS(previousKey),
          abortSignal,
          documentLease,
        );
        previousOverlayRemoved = true;
      }
      if (payload) {
        const label = JSON.stringify(`Kai · ${String(payload.summary).slice(0, 256)}`);
        const cursorVisible = Number.isFinite(payload.x) && Number.isFinite(payload.y);
        const css = `
html::before {
  content: ${label} !important;
  display: block !important;
  position: fixed !important;
  z-index: 2147483647 !important;
  pointer-events: none !important;
  right: 10px !important;
  bottom: 10px !important;
  max-width: 75% !important;
  padding: 6px 9px !important;
  border-radius: 8px !important;
  color: white !important;
  background: rgba(28,25,23,.88) !important;
  box-shadow: 0 4px 18px rgba(0,0,0,.25) !important;
  font: 12px -apple-system,BlinkMacSystemFont,sans-serif !important;
  white-space: pre-wrap !important;
}
html::after {
  content: '' !important;
  display: ${cursorVisible ? 'block' : 'none'} !important;
  position: fixed !important;
  z-index: 2147483647 !important;
  pointer-events: none !important;
  left: ${cursorVisible ? payload.x : 0}px !important;
  top: ${cursorVisible ? payload.y : 0}px !important;
  width: 18px !important;
  height: 18px !important;
  border: 2px solid #8b5cf6 !important;
  border-radius: 50% !important;
  background: rgba(139,92,246,.18) !important;
  transform: translate(-50%,-50%) !important;
  transition: left 120ms linear, top 120ms linear !important;
}`;
        const key = await this.runRendererOperationWithDeadline(
          tab,
          contents,
          'Browser automation overlay',
          AUTOMATION_OVERLAY_TIMEOUT_MS,
          () => contents.insertCSS(css, { cssOrigin: 'user' }),
          abortSignal,
          documentLease,
        );
        if (
          typeof key !== 'string' ||
          tab.overlayGeneration !== overlayGeneration ||
          this.tabs.get(tab.shell.id) !== tab ||
          tab.view?.webContents !== contents
        ) {
          if (typeof key === 'string') await contents.removeInsertedCSS(key).catch(() => undefined);
          return;
        }
        tab.overlayCssKey = key;
        tab.overlayCssText = css;
      }
    } catch (error) {
      if (
        previousKey &&
        !previousOverlayRemoved &&
        tab.overlayGeneration === overlayGeneration &&
        this.tabs.get(tab.shell.id) === tab &&
        tab.view?.webContents === contents &&
        !tab.overlayCssKey
      ) {
        tab.overlayCssKey = previousKey;
        tab.overlayCssText = previousCssText;
      }
      // Running automation must never continue invisibly. Completion/failure
      // labels and timer cleanup remain best-effort after the action has ended.
      if (action?.status === 'running') throw error;
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

  private serializeVisibleAssistantOperation<T>(
    conversationId: string,
    tab: InternalTab,
    assistantRun: BrowserAssistantRun,
    operation: () => Promise<T>,
  ): Promise<T> {
    return this.visibleAssistantQueue.run(() => {
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
    kind: Extract<BrowserActionEvent['kind'], 'inspect' | 'evaluate' | 'screenshot' | 'autofill'>,
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
    kind: Extract<BrowserActionEvent['kind'], 'inspect' | 'evaluate' | 'screenshot' | 'autofill'>,
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
    const previousActiveId = this.activeTabs.get(conversationId);
    if (previousActiveId && previousActiveId !== tab.shell.id) {
      this.invalidateVisibleAssistantOperations(this.tabs.get(previousActiveId));
    }
    this.activeTabs.set(conversationId, tab.shell.id);
    tab.lastUsedAt = Date.now();
    this.emitTabs(conversationId);
    this.emit({ type: 'open-panel', conversationId, tabId: tab.shell.id });
    this.emit({ type: 'action', conversationId, action: { ...action } });

    const reveal = async (contents: WebContents, documentLease: AssistantDocumentLease): Promise<void> => {
      throwIfBrowserAborted(abortSignal);
      this.assertAssistantDocumentLease(tab, documentLease);
      if (tab.view?.webContents !== contents || contents.isDestroyed()) {
        throw new Error('The browser page changed before the assistant operation became visible.');
      }
      await this.waitForVisibleAssistantOperationView(tab, tab.view, abortSignal, documentLease);
      documentLease.visibleAssistantGeneration = tab.visibleAssistantGeneration ?? 0;
      this.assertAssistantDocumentLease(tab, documentLease);
      await this.setAutomationOverlay(tab, action, abortSignal, documentLease);
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
        const wasAttached = contents.debugger.isAttached();
        if (!wasAttached) contents.debugger.attach('1.3');
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
              detachDebugger: !wasAttached,
            },
          };
        } finally {
          if (!retained && !wasAttached && !contents.isDestroyed() && contents.debugger.isAttached()) {
            contents.debugger.detach();
          }
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
    const wasAttached = contents.debugger.isAttached();
    if (!wasAttached) contents.debugger.attach('1.3');
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
      if (!wasAttached && !contents.isDestroyed() && contents.debugger.isAttached()) contents.debugger.detach();
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
      if (lease.detachDebugger && !contents.isDestroyed() && contents.debugger.isAttached()) {
        contents.debugger.detach();
      }
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
    const tab = this.requireTab(conversationId, request.tabId);
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
    // Physical actions are intentionally allowed to run while the user can
    // still interact with the page. Treat any trusted user gesture after this
    // operation is requested as invalidating coordinates/focus that were
    // resolved while waiting for the tab queue, renderer, or overlay.
    const physicalActionGestureGeneration = [
      'click',
      'doubleClick',
      'hover',
      'focus',
      'type',
      'press',
      'scroll',
      'drag',
    ].includes(request.kind)
      ? tab.trustedGestureGeneration
      : null;
    const physicalActionPanelGeneration =
      physicalActionGestureGeneration === null ? null : this.panelAuthorityGeneration(conversationId);
    const physicalActionLayoutGeneration =
      physicalActionGestureGeneration === null ? null : this.panelLayoutGeneration(conversationId);
    const assertPhysicalActionGestureLease = (): void => {
      if (
        physicalActionPanelGeneration !== null &&
        this.panelAuthorityGeneration(conversationId) !== physicalActionPanelGeneration
      ) {
        throw new Error(
          'The Browser panel visibility changed while the assistant action was waiting. Retry the action.',
        );
      }
      if (
        physicalActionLayoutGeneration !== null &&
        this.panelLayoutGeneration(conversationId) !== physicalActionLayoutGeneration
      ) {
        throw new Error(
          'The Browser panel layout or page zoom changed while the assistant action was waiting. Retry the action.',
        );
      }
      if (
        physicalActionGestureGeneration !== null &&
        tab.trustedGestureGeneration !== physicalActionGestureGeneration
      ) {
        throw new Error(
          request.kind === 'type'
            ? 'The user changed browser focus while assistant typing was waiting. Retry the action.'
            : 'The user interacted with the browser while the assistant action was waiting. Retry the action.',
        );
      }
    };
    this.runningActions.set(action.id, { conversationId, action });
    try {
      await this.serializeVisibleAssistantOperation(conversationId, tab, assistantRun, () =>
        this.runTabOperation(tab, () =>
          this.withAssistantControl(tab, assistantRun, async (documentLease) => {
            throwIfBrowserAborted(abortSignal);
            this.assertBrowserDocumentApproval(tab, approvedDocument);
            assertPhysicalActionGestureLease();
            // AI actions always become the visible tab before their running event,
            // so cursor, typing, scrolling, and status updates are observable live.
            const previousActiveId = this.activeTabs.get(conversationId);
            if (previousActiveId && previousActiveId !== tab.shell.id) {
              this.invalidateVisibleAssistantOperations(this.tabs.get(previousActiveId));
            }
            this.activeTabs.set(conversationId, tab.shell.id);
            tab.lastUsedAt = Date.now();
            this.emitTabs(conversationId);
            this.emit({
              type: 'open-panel',
              conversationId,
              tabId: tab.shell.id,
            });
            this.emit({ type: 'action', conversationId, action });
            const view = await this.ensureAssistantView(tab, assistantRun, documentLease);
            this.assertBrowserDocumentApproval(tab, approvedDocument);
            assertPhysicalActionGestureLease();
            if (physicalActionGestureGeneration !== null) {
              await this.waitForPhysicalActionView(
                tab,
                view,
                abortSignal,
                documentLease,
                assertPhysicalActionGestureLease,
              );
            } else {
              await this.waitForVisibleAssistantOperationView(tab, view, abortSignal, documentLease);
            }
            documentLease.visibleAssistantGeneration = tab.visibleAssistantGeneration ?? 0;
            this.assertAssistantDocumentLease(tab, documentLease);
            const contents = view.webContents;
            let point: {
              x: number;
              y: number;
              width: number;
              height: number;
              semanticLease?: BrowserSemanticTargetLease;
            } | null = null;
            try {
              const hasTarget = browserActionHasTarget(request);
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
                await this.setAutomationOverlay(tab, action, abortSignal, documentLease);
              }
              throwIfBrowserAborted(abortSignal);
              this.assertAssistantDocumentLease(tab, documentLease);
              assertPhysicalActionGestureLease();
              const zoomFactor = contents.getZoomFactor();
              if (point) {
                point = await this.validateLocatedTarget(tab, contents, point, {}, abortSignal, documentLease);
                action.x = point.x;
                action.y = point.y;
              }
              let inputPoint = point ? scaleBrowserPointForZoom(point, zoomFactor) : null;
              const refreshLocatedTarget = async (options: { focus?: boolean; requireFocused?: boolean } = {}) => {
                if (!point) return;
                point = await this.validateLocatedTarget(tab, contents, point, options, abortSignal, documentLease);
                inputPoint = scaleBrowserPointForZoom(point, zoomFactor);
                action.x = point.x;
                action.y = point.y;
                this.assertAssistantDocumentLease(tab, documentLease);
                assertPhysicalActionGestureLease();
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
                  contents.sendInputEvent({
                    type: 'mouseMove',
                    x: Math.round(inputPoint!.x),
                    y: Math.round(inputPoint!.y),
                  });
                  const clicks = request.kind === 'doubleClick' ? [1, 2] : [1];
                  for (const clickCount of clicks) {
                    await refreshLocatedTarget();
                    this.sendAttributedInputEvent(
                      tab,
                      contents,
                      { kind: 'pointerdown', x: point!.x, y: point!.y },
                      {
                        type: 'mouseDown',
                        button: 'left',
                        x: Math.round(inputPoint!.x),
                        y: Math.round(inputPoint!.y),
                        clickCount,
                      },
                    );
                    contents.sendInputEvent({
                      type: 'mouseUp',
                      button: 'left',
                      x: Math.round(inputPoint!.x),
                      y: Math.round(inputPoint!.y),
                      clickCount,
                    });
                  }
                  break;
                }
                case 'hover':
                  await refreshLocatedTarget();
                  contents.sendInputEvent({
                    type: 'mouseMove',
                    x: Math.round(inputPoint!.x),
                    y: Math.round(inputPoint!.y),
                  });
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
                  assertPhysicalActionGestureLease();
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
                  assertPhysicalActionGestureLease();
                  const insertedText = request.value ?? request.text ?? '';
                  await refreshLocatedTarget({ requireFocused: true });
                  this.armAutomationGesture(tab, contents, {
                    kind: 'input',
                    inputType: 'insertText',
                    data: insertedText,
                  });
                  await this.runRendererOperationWithDeadline(
                    tab,
                    contents,
                    'Browser typing',
                    TARGET_LOCATION_TIMEOUT_MS,
                    () => {
                      assertPhysicalActionGestureLease();
                      return contents.insertText(insertedText);
                    },
                    abortSignal,
                    documentLease,
                  );
                  break;
                }
                case 'press': {
                  const keys = request.keys?.length ? request.keys : [request.text ?? 'Enter'];
                  const modifiers = keys
                    .slice(0, -1)
                    .map((key) => key.toLowerCase())
                    .filter((key) => ['shift', 'control', 'ctrl', 'alt', 'meta', 'command'].includes(key))
                    .map((key) => (key === 'ctrl' ? 'control' : key === 'command' ? 'meta' : key)) as Array<
                    'shift' | 'control' | 'alt' | 'meta'
                  >;
                  const keyCode = keys.at(-1) ?? 'Enter';
                  this.sendAttributedInputEvent(
                    tab,
                    contents,
                    { kind: 'keydown', key: keyCode },
                    { type: 'keyDown', keyCode, modifiers },
                  );
                  contents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
                  break;
                }
                case 'scroll': {
                  await refreshLocatedTarget();
                  const scrollPoint = scaleBrowserPointForZoom({ x: point?.x ?? 10, y: point?.y ?? 10 }, zoomFactor);
                  this.sendAttributedInputEvent(
                    tab,
                    contents,
                    { kind: 'wheel', x: point?.x ?? 10, y: point?.y ?? 10 },
                    {
                      type: 'mouseWheel',
                      x: Math.round(scrollPoint.x),
                      y: Math.round(scrollPoint.y),
                      deltaX: request.deltaX ?? 0,
                      deltaY: request.deltaY ?? 500,
                    },
                  );
                  break;
                }
                case 'drag': {
                  contents.sendInputEvent({
                    type: 'mouseMove',
                    x: Math.round(inputPoint!.x),
                    y: Math.round(inputPoint!.y),
                  });
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
                  const endPoint = scaleBrowserPointForZoom({ x: endX, y: endY }, zoomFactor);
                  this.sendAttributedInputEvent(
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
                  );
                  contents.sendInputEvent({
                    type: 'mouseMove',
                    button: 'left',
                    x: Math.round(endPoint.x),
                    y: Math.round(endPoint.y),
                  });
                  contents.sendInputEvent({
                    type: 'mouseUp',
                    button: 'left',
                    x: Math.round(endPoint.x),
                    y: Math.round(endPoint.y),
                    clickCount: 1,
                  });
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
              await this.releaseLocatedTarget(contents, point);
            }
          }),
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
    const tab = this.requireTab(conversationId, tabId);
    return this.withVisibleAssistantOperation(
      conversationId,
      tab,
      assistantRun,
      'inspect',
      'inspecting page',
      (reveal) =>
        this.runTabOperation(tab, () =>
          this.withAssistantControl(tab, assistantRun, async (documentLease) => {
            throwIfBrowserAborted(abortSignal);
            this.assertBrowserDocumentApproval(tab, approvedDocument);
            const contents = (await this.ensureAssistantView(tab, assistantRun, documentLease)).webContents;
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
          }),
        ),
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
  ): Promise<T> {
    if (abortSignal?.aborted) throw new Error(`${operation} was cancelled.`);
    if (documentLease) this.assertAssistantDocumentLease(tab, documentLease);
    let cancellation: 'timeout' | 'abort' | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abortListener: (() => void) | undefined;
    const cancelled = new Promise<never>((_resolve, reject) => {
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          cancellation = 'timeout';
          reject(new Error(`${operation} exceeded ${timeoutMs / 1_000} seconds.`));
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
      if (cancellation) {
        // The Electron executeJavaScript/capture APIs have no cancellation
        // primitive. Terminate target-scoped script execution when CDP is
        // available, then reclaim only this WebContentsView so the queue and
        // profile-clear barrier cannot remain hostage to a wedged page. Never
        // call forcefullyCrashRenderer(): Chromium may place sibling tabs in
        // the same renderer process, and crashing it would discard unrelated
        // user page state.
        if (contents.debugger.isAttached()) {
          void contents.debugger.sendCommand('Runtime.terminateExecution').catch(() => undefined);
        }
        if (this.tabs.get(tab.shell.id) === tab) {
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
  ): Promise<unknown> {
    return this.runRendererOperationWithDeadline(
      tab,
      contents,
      'Browser script evaluation',
      EVALUATE_TIMEOUT_MS,
      async () => {
        const wasAttached = contents.debugger.isAttached();
        if (!wasAttached) contents.debugger.attach('1.3');
        try {
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
          if (!wasAttached && !contents.isDestroyed() && contents.debugger.isAttached()) {
            contents.debugger.detach();
          }
        }
      },
      abortSignal,
      documentLease,
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
    if (!tab.scriptTainted && !tab.privateNetworkNewDocumentGuard) return false;
    tab.generation++;
    this.destroyView(tab);
    tab.shell.discarded = true;
    tab.shell.sensitive = false;
    return true;
  }

  private async installPrivateNetworkNewDocumentGuard(tab: InternalTab, contents: WebContents): Promise<void> {
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
    const wasAttached = contents.debugger.isAttached();
    try {
      if (!wasAttached) contents.debugger.attach('1.3');
      const result = (await contents.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', {
        source: BROWSER_PRIVATE_NETWORK_NEW_DOCUMENT_GUARD,
        runImmediately: true,
      })) as { identifier?: unknown };
      if (typeof result.identifier !== 'string' || result.identifier.length === 0) {
        throw new Error('Chromium did not return a private-network script guard identifier.');
      }
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
    } catch (error) {
      throw new Error(
        `Browser script evaluation could not guard newly navigated frames: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    } finally {
      if (!wasAttached && !contents.isDestroyed() && contents.debugger.isAttached()) {
        try {
          contents.debugger.detach();
        } catch {
          // The target may have closed while the guard was being installed.
        }
      }
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
    const tab = this.requireTab(conversationId, tabId);
    return this.withVisibleAssistantOperation(
      conversationId,
      tab,
      assistantRun,
      'evaluate',
      'evaluating script',
      (reveal) =>
        this.runTabOperation(tab, () =>
          this.withAssistantControl(tab, assistantRun, async (documentLease) => {
            this.assertBrowserDocumentApproval(tab, approvedDocument);
            const contents = (await this.ensureAssistantView(tab, assistantRun, documentLease)).webContents;
            this.assertBrowserDocumentApproval(tab, approvedDocument);
            await reveal(contents, documentLease);
            await this.assertTabNotSensitive(tab, contents, 'Script evaluation', abortSignal, documentLease);
            // Arbitrary page JS can install long-lived input listeners. Detach the
            // native page before executing it so those listeners cannot observe
            // secrets typed by the user. A committed navigation/reload clears the
            // quarantine; failures leave it in place.
            await this.installPrivateNetworkNewDocumentGuard(tab, contents);
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
          }),
        ),
    );
  }

  private async hideAutomationOverlay(
    tab: InternalTab,
    contents: WebContents,
  ): Promise<{ cssText: string; generation: number } | null> {
    const key = tab.overlayCssKey;
    const cssText = tab.overlayCssText;
    if (!key || !cssText) return null;
    const generation = tab.overlayGeneration;
    tab.overlayCssKey = null;
    tab.overlayCssText = null;
    try {
      await contents.removeInsertedCSS(key);
    } catch (error) {
      if (tab.overlayGeneration === generation && tab.view?.webContents === contents) {
        tab.overlayCssKey = key;
        tab.overlayCssText = cssText;
      }
      throw error;
    }
    return { cssText, generation };
  }

  private async restoreAutomationOverlay(
    tab: InternalTab,
    contents: WebContents,
    hidden: { cssText: string; generation: number } | null,
  ): Promise<void> {
    if (
      !hidden ||
      contents.isDestroyed() ||
      tab.overlayGeneration !== hidden.generation ||
      tab.view?.webContents !== contents ||
      tab.overlayCssKey
    )
      return;
    const key = await contents.insertCSS(hidden.cssText, { cssOrigin: 'user' });
    if (tab.overlayGeneration === hidden.generation && tab.view?.webContents === contents && !tab.overlayCssKey) {
      tab.overlayCssKey = key;
      tab.overlayCssText = hidden.cssText;
    } else {
      await contents.removeInsertedCSS(key).catch(() => undefined);
    }
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
    const tab = this.requireTab(conversationId, request.tabId);
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
            ? await this.ensureAssistantView(tab, assistantRun!, documentLease!)
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
          ? this.withAssistantControl(tab, assistantRun!, captureExportPageLease)
          : captureExportPageLease(),
      );
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
          ? await this.ensureAssistantView(tab, assistantRun!, documentLease!)
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
          let capturedPng: Buffer;
          let capturedWidth: number;
          let capturedHeight: number;
          let capturedEncodedBytes = 0;
          const decodeCapture = (data: string): Buffer => {
            capturedEncodedBytes += Buffer.byteLength(data, 'base64');
            validateScreenshotEncodedBytes(capturedEncodedBytes);
            return Buffer.from(data, 'base64');
          };
          try {
            if (request.mode === 'full-page' || request.mode === 'element') {
              const attached = contents.debugger.isAttached();
              if (!attached) contents.debugger.attach('1.3');
              try {
                if (request.mode === 'element') {
                  if (!request.selector) throw new Error('A CSS selector is required for component screenshots.');
                  const rect = (await contents.executeJavaScript(`(() => {
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
            })()`)) as {
                    x: number;
                    y: number;
                    width: number;
                    height: number;
                  } | null;
                  if (!rect) throw new Error('No visible element matched the screenshot selector.');
                  const metrics = (await contents.debugger.sendCommand('Page.getLayoutMetrics')) as {
                    cssContentSize?: { width: number; height: number };
                    contentSize?: { width: number; height: number };
                  };
                  const documentSize = metrics.cssContentSize ?? metrics.contentSize;
                  const clip = elementCaptureRect(rect, {
                    width: documentSize?.width ?? 0,
                    height: documentSize?.height ?? 0,
                  });
                  capturedWidth = clip.width;
                  capturedHeight = clip.height;
                  const capture = (await contents.debugger.sendCommand('Page.captureScreenshot', {
                    format: 'png',
                    captureBeyondViewport: true,
                    fromSurface: true,
                    clip: { ...clip, scale: 1 },
                  })) as { data: string };
                  capturedPng = decodeCapture(capture.data);
                } else {
                  const metrics = (await contents.debugger.sendCommand('Page.getLayoutMetrics')) as {
                    cssContentSize?: { width: number; height: number };
                    contentSize?: { width: number; height: number };
                  };
                  const size = metrics.cssContentSize ?? metrics.contentSize;
                  ({ width: capturedWidth, height: capturedHeight } = validateScreenshotSize(
                    size?.width ?? 0,
                    size?.height ?? 0,
                  ));
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
                      clip: { ...tile, scale: 1 },
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
                if (!attached && contents.debugger.isAttached()) contents.debugger.detach();
              }
            } else {
              // capturePage() allocates the NativeImage before returning it.
              // Reject an oversized/spanned sidebar surface from its native
              // view bounds first so validation cannot happen only after the
              // dangerous allocation has already occurred.
              const viewportBounds = tab.view?.getBounds?.() ?? this.mountedBounds ?? DEFAULT_DETACHED_VIEW_BOUNDS;
              let displayScaleFactor = 1;
              try {
                // WebContentsView bounds are device-independent pixels, while
                // capturePage() allocates its NativeImage at the display's
                // device scale. Use the largest attached-display scale so a
                // spanned/moving window cannot exceed the pixel ceiling before
                // the returned NativeImage is available for post-validation.
                displayScaleFactor = Math.max(
                  1,
                  ...screen
                    .getAllDisplays()
                    .map((display) => display.scaleFactor)
                    .filter((scaleFactor) => Number.isFinite(scaleFactor) && scaleFactor > 0),
                );
              } catch {
                // Unit-test and early-shutdown Electron shims may not expose
                // display metadata. The returned NativeImage is still checked
                // below; production capture paths always have an initialized
                // screen module.
              }
              validateScreenshotSize(
                viewportBounds.width * displayScaleFactor,
                viewportBounds.height * displayScaleFactor,
              );
              const image = await contents.capturePage();
              const size = image.getSize();
              ({ width: capturedWidth, height: capturedHeight } = validateScreenshotSize(size.width, size.height));
              capturedPng = image.toPNG();
            }
            validateScreenshotEncodedBytes(capturedPng.byteLength);
          } finally {
            // Never run overlay restoration in a replacement document that
            // happened to reuse Kai's internal element id.
            if (this.isBrowserPageLeaseCurrent(tab, pageLease)) {
              await this.restoreAutomationOverlay(tab, contents, hidden);
            }
          }
          assertPageCurrent();
          await this.assertTabNotSensitive(tab, contents, 'Screenshots', abortSignal, documentLease);
          assertPageCurrent();
          return {
            png: capturedPng,
            width: capturedWidth,
            height: capturedHeight,
          };
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
            this.screenshotQueue.run(() =>
              this.withAssistantControl(tab, assistantRun!, (documentLease) =>
                captureAndProcess(documentLease, reveal),
              ),
            ),
          );
        },
      );
    }
    if (await prepareExportSelection()) return finishCanceledExport();
    return this.runTabOperation(tab, () => this.screenshotQueue.run(() => captureAndProcess()));
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

  private purgeCachedDownloadsForScope(scopeKey: string): void {
    for (const [id, download] of this.downloads) {
      if (download.scopeKey === scopeKey) this.downloads.delete(id);
    }
  }

  private cancelActiveDownloadsForScopes(scopeKeys: ReadonlySet<string>): Promise<void> {
    const cancellations = [...(this.activeDownloads?.values() ?? [])]
      .filter((download) => scopeKeys.has(download.scopeKey))
      .map((download) => download.cancel());
    return Promise.allSettled(cancellations).then(() => undefined);
  }

  private cancelActiveDownloadsForAssistantRun(conversationId: string, runId: string): Promise<void> {
    const cancellations = [...(this.activeDownloads?.values() ?? [])]
      .filter(
        (download) =>
          download.conversationId === conversationId && download.assistantOwnerId === runId && !download.keepOpen,
      )
      .map((download) => download.cancel());
    return Promise.allSettled(cancellations).then(() => undefined);
  }

  private cancelActiveAssistantDownloads(): Promise<void> {
    const cancellations = [...(this.activeDownloads?.values() ?? [])]
      .filter((download) => download.assistantOwnerId !== null && !download.keepOpen)
      .map((download) => download.cancel());
    return Promise.allSettled(cancellations).then(() => undefined);
  }

  private cancelActiveDownloadsForConversation(conversationId: string): Promise<void> {
    const cancellations = [...(this.activeDownloads?.values() ?? [])]
      .filter((download) => download.conversationId === conversationId)
      .map((download) => download.cancel());
    return Promise.allSettled(cancellations).then(() => undefined);
  }

  private waitForActiveDownloads(scopeKeys?: ReadonlySet<string>): Promise<void> {
    const downloads = [...(this.activeDownloads?.values() ?? [])].filter(
      (download) => !scopeKeys || scopeKeys.has(download.scopeKey),
    );
    return Promise.allSettled(downloads.map((download) => download.done)).then(() => undefined);
  }

  showDownload(conversationId: string, downloadId: string): void {
    const scopeKey = this.scopeKey(conversationId);
    this.assertScopeAvailable(scopeKey);
    const download =
      ([...this.downloads.values()].find((item) => item.id === downloadId && item.scopeKey === scopeKey) as
        | CachedBrowserDownload
        | undefined) ??
      this.storeForScope(scopeKey)
        .listDownloads()
        .find((item) => item.id === downloadId);
    if (!download) throw new Error('This download is no longer available.');
    if (!download.path) throw new Error('The downloaded file is unavailable because no saved path was recorded.');
    shell.showItemInFolder(download.path);
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
    for (const [promptId, pending] of this.pendingPermissions) {
      if (pending.tabId === tabId) this.finishPendingPermission(promptId, false);
    }
  }

  private dismissPendingAuthForTab(tabId: string): void {
    for (const [promptId, pending] of this.pendingAuth) {
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
      tab.shell.conversationId !== pending.conversationId
    ) {
      this.finishPendingAuth(id);
      throw new Error('This HTTP authentication prompt expired after the page navigated.');
    }
    const submittingCredentials = username !== undefined || password !== undefined;
    if (submittingCredentials && !pending.prompt.assistantTriggered && tab.aiNetworkRestricted) {
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
    tabId: string,
    credentialId?: string,
    source: 'user' | 'assistant' = 'user',
    assistantRun?: BrowserAssistantRun,
    approvedDocument?: BrowserDocumentApproval,
  ): Promise<void> {
    if (source === 'assistant' && !assistantRun) throw new Error('Assistant autofill requires turn ownership.');
    const abortSignal = assistantRun?.abortSignal;
    throwIfBrowserAborted(abortSignal);
    const tab = this.requireTab(conversationId, tabId);
    const operation = async (
      documentLease?: AssistantDocumentLease,
      reveal?: (contents: WebContents, documentLease: AssistantDocumentLease) => Promise<void>,
    ): Promise<void> => {
      throwIfBrowserAborted(abortSignal);
      this.assertBrowserDocumentApproval(tab, approvedDocument);
      const contents = (
        source === 'assistant'
          ? await this.ensureAssistantView(tab, assistantRun!, documentLease!)
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
            this.withAssistantControl(tab, assistantRun!, (documentLease) => operation(documentLease, reveal)),
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
      await this.runTabOperation(tab, async () => {
        const contents = (await this.ensureView(tab)).webContents;
        const pageLease = this.captureBrowserPageLease(tab, contents);
        this.assertBrowserPageLease(tab, pageLease, 'printing');
        await this.assertTabNotSensitive(tab, contents, 'Printing');
        this.assertBrowserPageLease(tab, pageLease, 'printing');
        await this.printPage(contents);
      });
    } else if (action === 'devtools') (await this.ensureView(tab)).webContents.openDevTools({ mode: 'detach' });
    else if (action === 'find') this.emit({ type: 'shortcut', conversationId, action: 'find' });
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
    } catch {
      pendingCleanupRecoveryRequired = true;
      this.pendingCleanupQuarantineUnreadable = true;
      enumerationWarnings.push('Pending cleanup metadata could not be enumerated; some recovery rows may be missing.');
      pendingCleanupScopeKeys = new Set();
    }
    const keys = new Set([
      ...readScopeKeys('Browser profile metadata', () => listStoredBrowserScopeKeys(this.appHome)),
      ...readScopeKeys('Saved-password metadata', () => listStoredCredentialScopeKeys(this.appHome)),
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
      // Tear down live renderers first to abort navigations/cookie writes, then
      // drain every queued/active tool operation before clearing persistent
      // storage. New activity fails at the scope gate until the clear completes.
      for (const tab of affectedTabs) {
        this.destroyView(tab);
        tab.shell.discarded = true;
        tab.shell.sensitive = false;
      }
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
                  this.visibleAssistantQueue.whenIdle(),
                  ...tabsForScope.map((tab) => tab.queue.whenIdle()),
                ]);
              },
            },
            { label: 'active downloads', run: () => downloadDrain },
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
                await getBrowserSession(scopeKey).clearStorageData();
                chromiumStorageClearedScopeKeys.add(scopeKey);
              },
            },
            {
              label: 'Chromium cache',
              run: () => {
                requireNetworkQuiescence();
                return getBrowserSession(scopeKey).clearCache();
              },
            },
            {
              label: 'HTTP authentication cache',
              run: () => {
                requireNetworkQuiescence();
                return getBrowserSession(scopeKey).clearAuthCache();
              },
            },
            {
              label: 'download path cache',
              run: () => {
                this.purgeCachedDownloadsForScope(scopeKey);
              },
            },
            {
              label: 'history, bookmarks, permissions, and downloads',
              run: () => this.storeForScope(scopeKey).clear(),
            },
            {
              label: 'retained Browser screenshots',
              run: () => removeBrowserScreenshotsForScopeKey(this.appHome, scopeKey),
            },
            {
              label: 'runtime profile state',
              run: () => {
                // Keep the in-process request guard and worker provenance when
                // Chromium could not prove that persistent workers/storage are
                // gone. The catch path below restores the durable store bit.
                if (!chromiumStorageClearedScopeKeys.has(scopeKey)) return;
                this.restrictedBackgroundScopes.delete(scopeKey);
                this.assistantControlledOrigins.delete(scopeKey);
              },
            },
            { label: 'saved passwords', run: () => this.vaultForScope(scopeKey).clear() },
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
    // cleanupAssistantTabsNow executes synchronously through assistantRuns.end,
    // revoking new work before this method returns. Track the resulting drain
    // without deferring that revocation behind a promise microtask.
    const cleanup = this.cleanupAssistantTabsNow(conversationId, runId);
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
      this.assistantContinuationLeases.delete(key);
      clearTimeout(pending.timer);
      await pending.drain;
    } else await this.assistantRuns.end(conversationId, runId);
    await this.cleanupAssistantStateOwnedByRun(conversationId, runId);
    this.emitTabs(conversationId);
  }

  async removeConversation(conversationId: string): Promise<void> {
    // Fence stale renderer work before publishing the terminal empty state.
    // Conversation ids are immutable, so this remains valid for the manager's
    // lifetime and also blocks tab creations already waiting on DNS/scope I/O.
    this.fenceRemovedConversation(conversationId);
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
    void this.cancelAssistantContinuations();
    this.assistantRuns.clear();
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
      if (
        !shouldDiscardBrowserTab(
          tab.shell,
          tab.lastUsedAt,
          cutoff,
          this.activeTabs.get(tab.shell.conversationId),
          this.mountedConversationId,
          assistantActivityActive,
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
    ipcMain.off('browser-page:sensitive', this.handleSensitiveEvent);
    ipcMain.off('browser-page:login-submitted', this.handleLoginSubmitted);
    ipcMain.off('browser-page:activity', this.handlePageActivity);
    ipcMain.off('browser-page:gesture', this.handlePageGesture);
    ipcMain.off('browser-page:element-picker-click', this.handleElementPickerClick);
    ipcMain.off('browser-page:element-picker-result', this.handleElementPickerResult);
    ipcMain.off('browser-page:element-picker-cancel', this.handleElementPickerCancel);
    app.off('login', this.handleLogin);
    app.off('select-client-certificate', this.handleSelectClientCertificate);
    for (const cleanupSession of this.wiredSessionCleanups.values()) cleanupSession();
    this.wiredSessionCleanups.clear();
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
    for (const tab of this.tabs.values()) this.destroyView(tab);
    this.assistantRuns.clear();
    this.automationGestureTokens.clear();
    this.pendingSyntheticInputs.clear();
    for (const tabId of this.faviconFetches.keys()) this.cancelFaviconFetch(tabId);
    this.detachAttachedView();
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
      await Promise.allSettled([this.profileMutationTail]);
      if (this.disposed) return;
      const tabs = [...this.tabs.values()];
      const queues = [this.visibleAssistantQueue.whenIdle(), ...tabs.map((tab) => tab.queue.whenIdle())];
      const scopeKeys = new Set([
        ...tabs.map((tab) => tab.scopeKey),
        ...[...this.activeDownloads.values()].map((download) => download.scopeKey),
        ...this.wiredSessionsByScope.keys(),
      ]);
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
      if (!this.beginTeardown()) return;
      try {
        await Promise.allSettled(queues);
        await downloadDrain;
        await this.waitForActiveDownloads(scopeKeys);
        await Promise.all([...scopeKeys].map((scopeKey) => this.waitForScopeIdle(scopeKey)));
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
