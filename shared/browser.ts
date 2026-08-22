/** Shared contracts for Kai's conversation-owned in-app browser. */

export const BROWSER_PANEL_TAB_ID = 'browser';

export type BrowserDataScope = 'global' | 'conversation';
export type BrowserControlPolicy = 'allow' | 'ask' | 'deny';
export type BrowserPasswordAccess = 'user-only' | 'ask' | 'automatic';
export type BrowserSearchProvider = 'duckduckgo' | 'google' | 'bing';
export type BrowserTabOwner = 'user' | 'assistant';

export type BrowserTab = {
  id: string;
  conversationId: string;
  owner: BrowserTabOwner;
  keepOpen: boolean;
  title: string;
  url: string;
  favicon?: string;
  loading: boolean;
  audible: boolean;
  muted: boolean;
  discarded: boolean;
  /** Kai evaluated caller-provided JavaScript in the current document. The
   * native page stays detached until a new top-level document commits. */
  reloadRequired: boolean;
  active: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  zoomLevel: number;
  createdAt: string;
  updatedAt: string;
  error?: string;
  security: 'secure' | 'insecure' | 'internal' | 'unknown';
  sensitive: boolean;
};

export type BrowserBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type BrowserActionKind =
  | 'navigate'
  | 'back'
  | 'forward'
  | 'reload'
  | 'stop'
  | 'click'
  | 'doubleClick'
  | 'hover'
  | 'focus'
  | 'type'
  | 'press'
  | 'scroll'
  | 'drag'
  | 'wait'
  | 'bookmark'
  | 'unbookmark';

export type BrowserActionRequest = {
  tabId?: string;
  kind: BrowserActionKind;
  url?: string;
  selector?: string;
  role?: string;
  name?: string;
  text?: string;
  keys?: string[];
  x?: number;
  y?: number;
  endX?: number;
  endY?: number;
  deltaX?: number;
  deltaY?: number;
  waitMs?: number;
  value?: string;
};

const BROWSER_TOOL_NAMES = [
  'browser_tabs',
  'browser_inspect',
  'browser_network',
  'browser_action',
  'browser_screenshot',
  'browser_evaluate',
  'browser_autofill',
] as const;

const BROWSER_TAB_ACTION_NAMES = new Set([
  'list',
  'open',
  'close',
  'duplicate',
  'reopen_closed',
  'keep_open',
  'close_others',
  'close_right',
]);
const BROWSER_ACTION_KIND_NAMES = new Set<BrowserActionKind>([
  'navigate',
  'back',
  'forward',
  'reload',
  'stop',
  'click',
  'doubleClick',
  'hover',
  'focus',
  'type',
  'press',
  'scroll',
  'drag',
  'wait',
  'bookmark',
  'unbookmark',
]);
const BROWSER_SCREENSHOT_MODES = new Set(['viewport', 'full-page', 'element']);
const BROWSER_NETWORK_WAIT_MODES = new Set(['none', 'load', 'network-idle']);
const BROWSER_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function invalidBrowserToolArguments(): { redacted: true; reason: string } {
  return { redacted: true, reason: 'Invalid Browser tool arguments.' };
}

function matchesBrowserToolName(toolName: string | undefined, name: string): boolean {
  return toolName === name || toolName?.endsWith(`/${name}`) === true || toolName?.endsWith(`__${name}`) === true;
}

function browserErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') {
    const detail = error as { data?: { message?: string }; message?: string; responseBody?: string };
    if (typeof detail.data?.message === 'string') return detail.data.message;
    if (typeof detail.message === 'string') return detail.message;
    if (typeof detail.responseBody === 'string' && detail.responseBody.length > 0) return detail.responseBody;
  }
  return String(error);
}

/** Stream-level provider errors can lose the originating tool name after a
 * Browser action rejects. Redact page-controlled locations before those errors
 * reach renderer events, persistence, fallback metadata, or logs. */
export function redactBrowserErrorForExposure(error: unknown): string {
  const message = browserErrorMessage(error);
  return message.replace(/\b(?:https?|file|data|blob):[^\s'"<>]+/gi, (rawUrl, offset: number, source: string) => {
    // This sanitizer is intentionally used at several independent trust
    // boundaries. Preserve only an already-redacted bare HTTP(S) origin so a
    // second pass stays idempotent; a forged marker containing a path, query,
    // credentials, or malformed URL still falls through and is sanitized.
    if (source.slice(0, offset).endsWith('[redacted browser URL: ') && rawUrl.endsWith(']')) {
      try {
        const prior = new URL(rawUrl.slice(0, -1));
        if (
          (prior.protocol === 'http:' || prior.protocol === 'https:') &&
          !prior.username &&
          !prior.password &&
          prior.pathname === '/' &&
          !prior.search &&
          !prior.hash &&
          prior.origin === rawUrl.slice(0, -1)
        ) {
          return rawUrl;
        }
      } catch {
        // A forged or malformed marker must be redacted below.
      }
    }
    try {
      const parsed = new URL(rawUrl);
      if (
        (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
        !parsed.username &&
        !parsed.password &&
        parsed.pathname === '/' &&
        !parsed.search &&
        !parsed.hash
      ) {
        return parsed.origin;
      }
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        return `[redacted browser URL: ${parsed.origin}]`;
      }
    } catch {
      // A malformed location is still page-controlled Browser data.
    }
    return '[redacted browser URL]';
  });
}

export function redactBrowserToolErrorForExposure(toolName: string | undefined, error: unknown): string {
  const message = browserErrorMessage(error);
  if (!BROWSER_TOOL_NAMES.some((name) => matchesBrowserToolName(toolName, name))) return message;
  return redactBrowserErrorForExposure(error);
}

function isCanonicalRedactedBrowserLocation(value: string): boolean {
  const addressMarker = /^\[redacted browser address or search: (0|[1-9]\d*) characters\]$/.exec(value);
  if (addressMarker) return Number.isSafeInteger(Number(addressMarker[1]));
  const prefix = '[redacted browser URL: ';
  if (!value.startsWith(prefix) || !value.endsWith(']')) return false;
  const serializedOrigin = value.slice(prefix.length, -1);
  try {
    const parsed = new URL(serializedOrigin);
    return (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      !parsed.username &&
      !parsed.password &&
      parsed.pathname === '/' &&
      !parsed.search &&
      !parsed.hash &&
      parsed.origin === serializedOrigin
    );
  } catch {
    return false;
  }
}

/** Return a copy safe for renderer events, persistence, logs, and secondary
 * observer models. The real action input remains available only to the Browser
 * executor; typed text may be a password, OTP, recovery code, or token. */
export function redactBrowserToolArgsForExposure(toolName: string | undefined, args: unknown): unknown {
  const matchesBrowserTool = (name: string): boolean => matchesBrowserToolName(toolName, name);
  if (!BROWSER_TOOL_NAMES.some((name) => matchesBrowserTool(name))) return args;
  // Browser tool schemas are objects. A malformed provider payload may still
  // contain a partially streamed password or script; never echo that primitive
  // through logs/UI merely because it cannot be parsed into the expected shape.
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return invalidBrowserToolArguments();
  }
  const record = args as Record<string, unknown>;
  const redactLocation = (value: unknown): unknown => {
    if (typeof value !== 'string' || isCanonicalRedactedBrowserLocation(value)) return value;
    if (value === 'about:blank') return value;
    try {
      const parsed = new URL(value);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        if (!parsed.username && !parsed.password && parsed.pathname === '/' && !parsed.search && !parsed.hash) {
          return parsed.origin;
        }
        return `[redacted browser URL: ${parsed.origin}]`;
      }
    } catch {
      // Omnibox input can be a search query or a URL without a scheme. Neither
      // is safe to persist because it may contain a token or recovery code.
    }
    return `[redacted browser address or search: ${value.length} characters]`;
  };

  const includeUuid = (output: Record<string, unknown>, key: 'tabId' | 'credentialId'): boolean => {
    const value = record[key];
    if (value === undefined) return true;
    if (typeof value !== 'string' || !BROWSER_UUID_PATTERN.test(value)) return false;
    output[key] = value;
    return true;
  };
  const includeBoolean = (output: Record<string, unknown>, key: string): void => {
    if (typeof record[key] === 'boolean') output[key] = record[key];
  };
  const includeNumber = (output: Record<string, unknown>, key: string): void => {
    if (typeof record[key] === 'number' && Number.isFinite(record[key])) output[key] = record[key];
  };
  const redactedString = (value: unknown, label: string): unknown => {
    if (typeof value !== 'string' || /^\[redacted browser [^\]]+: \d+ characters\]$/.test(value)) return value;
    return `[redacted browser ${label}: ${value.length} characters]`;
  };

  if (matchesBrowserTool('browser_tabs')) {
    if (typeof record.action !== 'string' || !BROWSER_TAB_ACTION_NAMES.has(record.action)) {
      return invalidBrowserToolArguments();
    }
    const output: Record<string, unknown> = {};
    output.action = record.action;
    switch (record.action) {
      case 'open':
        if (typeof record.url === 'string') output.url = redactLocation(record.url);
        includeBoolean(output, 'background');
        break;
      case 'close':
      case 'duplicate':
      case 'keep_open':
      case 'close_others':
      case 'close_right':
        if (!includeUuid(output, 'tabId')) return invalidBrowserToolArguments();
        break;
    }
    return output;
  }

  if (matchesBrowserTool('browser_inspect')) {
    const output: Record<string, unknown> = {};
    if (!includeUuid(output, 'tabId')) return invalidBrowserToolArguments();
    return output;
  }

  if (matchesBrowserTool('browser_network')) {
    const output: Record<string, unknown> = {};
    if (!includeUuid(output, 'tabId')) return invalidBrowserToolArguments();
    if (
      record.waitFor !== undefined &&
      (typeof record.waitFor !== 'string' || !BROWSER_NETWORK_WAIT_MODES.has(record.waitFor))
    ) {
      return invalidBrowserToolArguments();
    }
    if (record.waitFor !== undefined) output.waitFor = record.waitFor;
    includeNumber(output, 'limit');
    includeNumber(output, 'timeoutMs');
    includeNumber(output, 'idleMs');
    return output;
  }

  if (matchesBrowserTool('browser_screenshot')) {
    const output: Record<string, unknown> = {};
    if (!includeUuid(output, 'tabId')) return invalidBrowserToolArguments();
    if (record.mode !== undefined && (typeof record.mode !== 'string' || !BROWSER_SCREENSHOT_MODES.has(record.mode))) {
      return invalidBrowserToolArguments();
    }
    if (record.mode !== undefined) output.mode = record.mode;
    if (typeof record.selector === 'string') {
      output.selector = redactedString(record.selector, 'screenshot selector');
    }
    includeBoolean(output, 'saveToFile');
    return output;
  }

  if (matchesBrowserTool('browser_evaluate')) {
    const output: Record<string, unknown> = {};
    if (!includeUuid(output, 'tabId')) return invalidBrowserToolArguments();
    if (typeof record.script === 'string') {
      output.script = /^\[redacted browser script: \d+ characters\]$/.test(record.script)
        ? record.script
        : `[redacted browser script: ${record.script.length} characters]`;
    }
    return output;
  }

  if (matchesBrowserTool('browser_autofill')) {
    const output: Record<string, unknown> = {};
    if (!includeUuid(output, 'tabId') || !includeUuid(output, 'credentialId')) {
      return invalidBrowserToolArguments();
    }
    return output;
  }

  if (typeof record.kind !== 'string' || !BROWSER_ACTION_KIND_NAMES.has(record.kind as BrowserActionKind)) {
    return invalidBrowserToolArguments();
  }
  const redacted: Record<string, unknown> = {};
  if (!includeUuid(redacted, 'tabId')) return invalidBrowserToolArguments();
  redacted.kind = record.kind;
  if (record.kind === 'navigate') {
    if (typeof record.url === 'string') redacted.url = redactLocation(record.url);
    if (typeof record.text === 'string') redacted.text = redactLocation(record.text);
    return redacted;
  }
  const includeTarget = (): void => {
    if (typeof record.selector === 'string') redacted.selector = redactedString(record.selector, 'selector');
    if (typeof record.role === 'string') redacted.role = redactedString(record.role, 'target role');
    if (typeof record.name === 'string') redacted.name = redactedString(record.name, 'target name');
    if (typeof record.text === 'string') redacted.text = redactedString(record.text, 'target text');
    includeNumber(redacted, 'x');
    includeNumber(redacted, 'y');
  };
  // Selectors, accessible names, and semantic text can contain account ids,
  // recovery codes, or other page/user-controlled secrets. They leave the
  // executor through approval cards, persistence, and observer events, so keep
  // only their lengths just like typed text and injected scripts.
  if (record.kind === 'press') {
    const safeNonTextKey =
      /^(?:alt|backspace|cmd|command|control|ctrl|delete|end|enter|esc|escape|f(?:[1-9]|1\d|2[0-4])|home|insert|meta|page(?:down|up)|shift|tab|arrow(?:down|left|right|up))$/i;
    if (Array.isArray(record.keys)) {
      if (!record.keys.every((key): key is string => typeof key === 'string')) {
        return invalidBrowserToolArguments();
      }
      redacted.keys = record.keys.map((key: string) => {
        if (safeNonTextKey.test(key) || /^\[redacted key input: \d+ characters\]$/.test(key)) {
          return key;
        }
        return `[redacted key input: ${key.length} characters]`;
      });
    }
    const text = record.text;
    if (
      typeof text === 'string' &&
      !safeNonTextKey.test(text) &&
      !/^\[redacted key input: \d+ characters\]$/.test(text)
    ) {
      redacted.text = `[redacted key input: ${text.length} characters]`;
    }
    return redacted;
  }
  if (['click', 'doubleClick', 'hover', 'focus'].includes(String(record.kind))) {
    includeTarget();
    return redacted;
  }
  if (record.kind === 'type') {
    includeTarget();
    for (const key of ['value', 'text'] as const) {
      const value = record[key];
      if (typeof value === 'string') {
        redacted[key] = /^\[redacted typed text: \d+ characters\]$/.test(value)
          ? value
          : `[redacted typed text: ${value.length} characters]`;
      }
    }
    return redacted;
  }
  if (record.kind === 'scroll') {
    includeTarget();
    includeNumber(redacted, 'deltaX');
    includeNumber(redacted, 'deltaY');
    return redacted;
  }
  if (record.kind === 'drag') {
    includeTarget();
    includeNumber(redacted, 'endX');
    includeNumber(redacted, 'endY');
    return redacted;
  }
  if (record.kind === 'wait') {
    includeNumber(redacted, 'waitMs');
  }
  return redacted;
}

export type BrowserActionEvent = {
  id: string;
  tabId: string;
  kind: BrowserActionKind | 'evaluate' | 'inspect' | 'network' | 'screenshot' | 'autofill';
  status: 'running' | 'completed' | 'failed';
  startedAt: string;
  completedAt?: string;
  x?: number;
  y?: number;
  summary?: string;
  error?: string;
};

export type BrowserInteractiveElement = {
  id: string;
  selector?: string;
  role?: string;
  name?: string;
  text?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  disabled?: boolean;
};

export type BrowserInspection = {
  tabId: string;
  url: string;
  title: string;
  visibleText: string;
  scrollX: number;
  scrollY: number;
  viewportWidth: number;
  viewportHeight: number;
  elements: BrowserInteractiveElement[];
};

export type BrowserNetworkWaitMode = 'none' | 'load' | 'network-idle';

export type BrowserNetworkDiagnosticsRequest = {
  tabId?: string;
  waitFor?: BrowserNetworkWaitMode;
  /** Maximum recent requests returned, newest first. */
  limit?: number;
  /** Maximum time spent waiting for load or idle state. */
  timeoutMs?: number;
  /** Quiet period required by network-idle. */
  idleMs?: number;
};

export type BrowserLoadTiming = {
  navigationType?: 'navigate' | 'reload' | 'back_forward' | 'prerender' | 'unknown';
  timeToFirstByteMs?: number;
  responseEndMs?: number;
  domContentLoadedMs?: number;
  loadEventMs?: number;
  durationMs?: number;
  firstContentfulPaintMs?: number;
  transferSizeBytes?: number;
  encodedBodySizeBytes?: number;
  decodedBodySizeBytes?: number;
};

export type BrowserNetworkEntry = {
  sequence: number;
  /** A stable per-process opaque origin token; hostnames, credentials, paths,
   * queries, and fragments are removed. */
  url: string;
  urlRedacted: boolean;
  method: string;
  resourceType: string;
  statusCode?: number;
  fromCache?: boolean;
  responseBytes?: number;
  error?: string;
  durationMs: number;
  pending: boolean;
};

export type BrowserNetworkDiagnostics = {
  tabId: string;
  /** Opaque current-page origin identity. */
  url: string;
  loading: boolean;
  waitFor: BrowserNetworkWaitMode;
  waitTimedOut: boolean;
  inFlight: number;
  requestCount: number;
  requestsTruncated: boolean;
  loadTiming: BrowserLoadTiming;
  requests: BrowserNetworkEntry[];
};

export type BrowserScreenshotMode = 'viewport' | 'full-page' | 'element';
export type BrowserScreenshotRequest = {
  tabId?: string;
  mode: BrowserScreenshotMode;
  selector?: string;
  /** Opaque identity of the document in which an interactive element was
   * picked. When present, capture fails if that document has since changed. */
  documentToken?: string;
  saveToFile?: boolean;
  exportToFile?: boolean;
};

export type BrowserElementPickResult = {
  selector: string;
  documentToken: string;
};

export type BrowserScreenshotResult = {
  tabId: string;
  mode: BrowserScreenshotMode;
  mimeType: 'image/png';
  /** Present for model/preview captures; omitted for native file exports to
   * avoid cloning a potentially very large PNG through renderer IPC. */
  dataUrl?: string;
  width: number;
  height: number;
  filePath?: string;
  /** Native export was dismissed before capture began. */
  canceled?: boolean;
};

export type BrowserBookmark = {
  id: string;
  scopeKey: string;
  title: string;
  url: string;
  folder: string;
  createdAt: string;
  updatedAt: string;
};

export type BrowserHistoryEntry = {
  id: string;
  scopeKey: string;
  title: string;
  url: string;
  visitedAt: string;
};

export type BrowserCredentialSummary = {
  id: string;
  scopeKey: string;
  origin: string;
  username: string;
  createdAt: string;
  updatedAt: string;
};

export type BrowserDownload = {
  id: string;
  tabId: string;
  filename: string;
  receivedBytes: number;
  totalBytes: number;
  state: 'progressing' | 'completed' | 'cancelled' | 'interrupted';
  /** App-owned, bounded assistant download that must be explicitly exported
   * before another application can use the remote file type. */
  quarantined?: boolean;
  path?: string;
  url?: string;
};

export type BrowserFindResult = {
  /** Renderer-issued identity for the exact query/navigation request. */
  requestId: number;
  activeMatchOrdinal: number;
  matches: number;
  finalUpdate: boolean;
};

export type BrowserAuthPrompt = {
  id: string;
  tabId: string;
  host: string;
  endpoint: string;
  authScheme: string;
  realm?: string;
  isProxy: boolean;
  assistantTriggered: boolean;
};

export type BrowserPermissionPrompt = {
  id: string;
  tabId: string;
  origin: string;
  permission: string;
  target?: string;
  canPersist?: boolean;
  assistantTriggered: boolean;
};

export type BrowserSitePermission = {
  origin: string;
  permission: string;
  decision: 'allow' | 'deny';
};

export type BrowserCredentialPrompt = {
  id: string;
  tabId: string;
  origin: string;
  username: string;
  update: boolean;
};

export type BrowserPromptKind = 'credential' | 'permission' | 'auth';
export type BrowserProfilePersistenceArea = 'history' | 'downloads' | 'profile';

export type BrowserShortcutAction =
  | 'new-tab'
  | 'close-tab'
  | 'reopen-tab'
  | 'focus-url'
  | 'find'
  | 'find-next'
  | 'find-previous'
  | 'reload'
  | 'hard-reload'
  | 'back'
  | 'forward'
  | 'stop'
  | 'zoom-in'
  | 'zoom-out'
  | 'zoom-reset'
  | 'tab-first'
  | 'tab-last'
  | 'tab-number';

export type BrowserEvent =
  | {
      type: 'profile-scope-changed';
      dataScope: BrowserDataScope;
    }
  | { type: 'tabs-changed'; conversationId: string; tabs: BrowserTab[] }
  | {
      type: 'tab-favicon';
      conversationId: string;
      tabId: string;
      favicon: string | null;
    }
  | { type: 'bookmarks-changed'; conversationId: string }
  | {
      type: 'profile-error';
      conversationId: string;
      area: BrowserProfilePersistenceArea;
      message: string;
    }
  | {
      type: 'profile-data-cleared';
      /** Routing hint for mounted Browser panels. Explicit profile cleanup can
       * target data for a deleted chat, in which case no owning chat remains. */
      conversationId?: string;
      scopeKeys: string[];
    }
  | { type: 'action'; conversationId: string; action: BrowserActionEvent }
  | {
      type: 'find-result';
      conversationId: string;
      tabId: string;
      result: BrowserFindResult;
    }
  | { type: 'download'; conversationId: string; download: BrowserDownload }
  | {
      type: 'download-history-changed';
      conversationId: string;
      downloadId: string;
      change: 'deleted' | 'unavailable';
    }
  | { type: 'auth-prompt'; conversationId: string; prompt: BrowserAuthPrompt }
  | {
      type: 'permission-prompt';
      conversationId: string;
      prompt: BrowserPermissionPrompt;
    }
  | {
      type: 'credential-prompt';
      conversationId: string;
      prompt: BrowserCredentialPrompt;
    }
  | {
      type: 'prompt-dismissed';
      conversationId: string;
      promptId: string;
      promptKind: BrowserPromptKind;
    }
  | {
      type: 'shortcut';
      conversationId: string;
      action: BrowserShortcutAction;
      index?: number;
    }
  | { type: 'open-panel'; conversationId: string; tabId: string }
  | {
      type: 'credential-sensitive';
      conversationId: string;
      tabId: string;
      sensitive: boolean;
    };

export type BrowserManagerState = {
  conversationId: string;
  tabs: BrowserTab[];
  activeTabId: string | null;
  /** Pending native prompts are included so a Browser panel mounted after the
   * event was emitted can still render and resolve them. */
  credentialPrompts?: BrowserCredentialPrompt[];
  permissionPrompts?: BrowserPermissionPrompt[];
  authPrompts?: BrowserAuthPrompt[];
  /** In-flight actions let a newly mounted sidebar immediately show live AI
   * activity instead of waiting for the next action event. */
  runningActions?: BrowserActionEvent[];
};

/** Batched retained prompt identity used by the app shell after a renderer
 * reload. It intentionally omits origins, usernames, and prompt payloads; the
 * owning Browser panel hydrates those only after the user opens that chat. */
export type BrowserAttentionState = {
  conversationId: string;
  promptIds: string[];
};

export type BrowserCreateTabRequest = {
  conversationId: string;
  url?: string;
  background?: boolean;
  owner?: BrowserTabOwner;
};

export type BrowserTabCommand =
  | 'activate'
  | 'close'
  | 'duplicate'
  | 'reload'
  | 'hard-reload'
  | 'stop'
  | 'back'
  | 'forward'
  | 'toggle-mute'
  | 'keep-open'
  | 'close-others'
  | 'close-right';

export type BrowserMenuAction =
  | 'new-tab'
  | 'reopen-closed-tab'
  | 'find'
  | 'history'
  | 'bookmarks'
  | 'downloads'
  | 'passwords'
  | 'print'
  | 'screenshot-viewport'
  | 'screenshot-full-page'
  | 'clear-data'
  | 'settings'
  | 'devtools';

export type BrowserDataSummary = {
  scopeKey: string;
  partition: string;
  cleanupPending: boolean;
  recoveryRequired?: boolean;
  warning?: string;
  historyCount: number;
  bookmarkCount: number;
  downloadCount: number;
  credentialCount: number;
  activeTabCount: number;
};

export type BrowserDataClearOptions = {
  conversationId?: string;
  /** Explicit persisted profile keys, used by Settings when clearing an older chat profile. */
  scopeKeys?: string[];
  includeGlobal?: boolean;
  includeConversation?: boolean;
  includePluginPartitions?: string[];
  /** Explicitly recover unreadable cleanup metadata by clearing every discoverable Browser profile. */
  recoverUnreadableCleanup?: boolean;
};

export type BrowserBridge = {
  available: () => Promise<boolean>;
  getState: (conversationId: string) => Promise<BrowserManagerState>;
  getAttentionState: () => Promise<BrowserAttentionState[]>;
  createTab: (request: BrowserCreateTabRequest) => Promise<BrowserTab>;
  commandTab: (conversationId: string, tabId: string, command: BrowserTabCommand) => Promise<void>;
  menuAction: (conversationId: string, action: BrowserMenuAction) => Promise<void>;
  reorderTabs: (conversationId: string, orderedTabIds: string[]) => Promise<void>;
  navigate: (conversationId: string, tabId: string, input: string) => Promise<void>;
  mount: (conversationId: string, bounds: BrowserBounds | null) => Promise<void>;
  setChromeFocus: (conversationId: string, focused: boolean) => Promise<void>;
  find: (
    conversationId: string,
    tabId: string,
    text: string,
    forward: boolean | undefined,
    findNext: boolean | undefined,
    requestId: number,
  ) => Promise<void>;
  stopFind: (conversationId: string, tabId: string) => Promise<void>;
  setZoom: (conversationId: string, tabId: string, level: number) => Promise<number>;
  /** Presentation-only capture used to preserve the native page behind Browser
   * chrome. It shares the bounded screenshot allocation queue and is coalesced
   * per document in main. */
  captureMenuPreview: (conversationId: string, tabId: string, requestId: string) => Promise<BrowserScreenshotResult>;
  cancelMenuPreview: (requestId: string) => Promise<void>;
  screenshot: (conversationId: string, request: BrowserScreenshotRequest) => Promise<BrowserScreenshotResult>;
  pickElement: (conversationId: string, tabId: string) => Promise<BrowserElementPickResult>;
  listHistory: (conversationId: string, query?: string) => Promise<BrowserHistoryEntry[]>;
  clearHistory: (conversationId: string) => Promise<void>;
  listBookmarks: (conversationId: string, query?: string) => Promise<BrowserBookmark[]>;
  addBookmark: (conversationId: string, title: string, url: string, folder?: string) => Promise<BrowserBookmark>;
  updateBookmark: (conversationId: string, bookmark: BrowserBookmark) => Promise<BrowserBookmark>;
  removeBookmark: (conversationId: string, bookmarkId: string) => Promise<void>;
  reorderBookmarks: (conversationId: string, orderedBookmarkIds: string[]) => Promise<void>;
  importBookmarks: (conversationId: string) => Promise<{ imported: number; canceled?: boolean }>;
  exportBookmarks: (conversationId: string) => Promise<{ exported: number; canceled?: boolean; filePath?: string }>;
  listDownloads: (conversationId: string) => Promise<BrowserDownload[]>;
  showDownload: (conversationId: string, downloadId: string) => Promise<void>;
  exportDownload: (conversationId: string, downloadId: string) => Promise<{ canceled?: boolean; filePath?: string }>;
  deleteDownload: (conversationId: string, downloadId: string) => Promise<void>;
  cancelDownload: (conversationId: string, downloadId: string) => Promise<void>;
  listSitePermissions: (conversationId: string, origin: string) => Promise<BrowserSitePermission[]>;
  resetSitePermissions: (conversationId: string, origin: string, permission?: string) => Promise<void>;
  listCredentials: (conversationId: string, query?: string) => Promise<BrowserCredentialSummary[]>;
  credentialAuthenticationAvailable: () => Promise<boolean>;
  saveCredential: (conversationId: string, origin: string, username: string, password: string) => Promise<void>;
  updateCredential: (conversationId: string, credentialId: string, username: string, password: string) => Promise<void>;
  deleteCredential: (conversationId: string, credentialId: string) => Promise<void>;
  revealCredential: (conversationId: string, credentialId: string) => Promise<string>;
  copyCredential: (conversationId: string, credentialId: string) => Promise<void>;
  respondCredentialPrompt: (promptId: string, save: boolean) => Promise<void>;
  respondAuthPrompt: (promptId: string, username?: string, password?: string) => Promise<void>;
  respondPermissionPrompt: (promptId: string, decision: 'allow-once' | 'allow' | 'deny') => Promise<void>;
  autofill: (conversationId: string, tabId: string, credentialId?: string) => Promise<void>;
  dataSummary: (conversationId?: string) => Promise<BrowserDataSummary[]>;
  clearData: (options: BrowserDataClearOptions) => Promise<void>;
  onEvent: (callback: (event: BrowserEvent) => void) => () => void;
};
