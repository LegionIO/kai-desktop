import crypto from 'crypto';
import http from 'http';
import https from 'https';
import net from 'net';
import { join, extname, sep } from 'path';
import { homedir } from 'os';
import {
  readFileSync,
  writeFileSync,
  existsSync,
  statSync,
  mkdirSync,
  realpathSync,
  openSync,
  fstatSync,
  readSync,
  closeSync,
  constants,
  chmodSync,
} from 'fs';
import type { Duplex } from 'stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { webClients } from './web-clients.js';
import { notifyClientCountChanged } from '../local-bridge/local-server.js';
import { invokeHandler } from './ipc-bridge.js';
import { ensureSelfSignedCert } from './self-signed.js';
import { getLoginPageHtml } from './login-page.js';

interface WebServerConfig {
  enabled: boolean;
  port: number;
  bindAddress: string;
  tls: {
    enabled: boolean;
    mode: 'self-signed' | 'custom';
    certPath: string;
    keyPath: string;
  };
  auth: {
    mode: 'anonymous' | 'password';
    username: string;
    password: string;
  };
}

let httpServer: http.Server | https.Server | null = null;
let netServer: net.Server | null = null;
let redirectServer: http.Server | null = null;
let wss: WebSocketServer | null = null;

/** Cached favicon PNG read from build/icon.png at module load. */
const APP_ICON_PATH = join(import.meta.dirname, '../../build/icon.png');
let faviconBuffer: Buffer | null = null;
try {
  if (existsSync(APP_ICON_PATH)) {
    faviconBuffer = readFileSync(APP_ICON_PATH);
  }
} catch {
  // Favicon not available — non-fatal.
}

/** Session cookie / token lifetime: 24 hours. */
const SESSION_LIFETIME_MS = 24 * 60 * 60 * 1000;
const SESSION_MAX_AGE_SECS = SESSION_LIFETIME_MS / 1000;

/** Hard cap on the /api/login request body (bytes). Login is a tiny JSON blob;
 *  this stops an unauthenticated client from exhausting memory pre-rate-limit. */
const MAX_LOGIN_BODY_BYTES = 64 * 1024;

/** One-time login-token lifetime (QR codes): 5 minutes. */
const LOGIN_TOKEN_LIFETIME_MS = 5 * 60 * 1000;

/** Cap on a single inbound WebSocket message. Each frame is UTF-8 decoded +
 *  JSON.parsed on the main process; an unbounded frame is a DoS vector. */
const MAX_WS_MESSAGE_BYTES = 4 * 1024 * 1024; // 4 MiB

/** How long the TLS/plain pre-read may wait for the first byte before the raw
 *  socket is destroyed (slowloris guard). A real client sends its ClientHello /
 *  request line immediately. */
const PRE_READ_TIMEOUT_MS = 10_000;

/* ── File-backed session store ─────────────────────────────────────── */

const SESSIONS_DIR = join(homedir(), '.' + __BRAND_APP_SLUG, 'data');
const SESSIONS_PATH = join(SESSIONS_DIR, 'web-sessions.json');

/** token -> expiry epoch ms. Map (not plain object) so prototype keys like '__proto__' can't poison lookups. */
type SessionStore = Map<string, number>;

/**
 * Fingerprint of the auth secret a session set was issued under. Sessions are
 * discarded when it changes so a password rotation (or an anonymous↔password
 * switch) invalidates every previously-issued cookie — a leaked/stale token
 * must not survive a credential change. Inputs are domain-separated so a literal
 * password of "anonymous" can't collide with anonymous mode.
 */
export function authFingerprint(config: WebServerConfig): string {
  const input = config.auth.mode === 'password' ? `pw ${config.auth.password}` : 'anon';
  return crypto.createHash('sha256').update(input, 'utf-8').digest('hex');
}

/**
 * Decide whether previously-issued sessions survive a (re)start. They carry over
 * only when the auth secret is unchanged from what they were issued under. A
 * null loaded fingerprint (legacy bare-map file, or absent file) never matches,
 * so those sessions are always discarded once. Pure so it can be unit-tested
 * without standing up the HTTPS server.
 */
export function sessionsCarryOver(loadedFingerprint: string | null, currentFingerprint: string): boolean {
  return loadedFingerprint !== null && loadedFingerprint === currentFingerprint;
}

/** Load the persisted `{ fingerprint, sessions }`. Tolerates the legacy
 *  bare-map format (no fingerprint) by returning a null fingerprint so the
 *  caller discards those sessions once and rewrites in the new format. */
function loadSessions(): { fingerprint: string | null; store: SessionStore } {
  try {
    if (!existsSync(SESSIONS_PATH)) return { fingerprint: null, store: new Map() };
    const parsed = JSON.parse(readFileSync(SESSIONS_PATH, 'utf-8')) as unknown;
    // New format: { fingerprint: string, sessions: Record<token, expiry> }
    if (
      parsed &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed) &&
      typeof (parsed as { fingerprint?: unknown }).fingerprint === 'string' &&
      (parsed as { sessions?: unknown }).sessions &&
      typeof (parsed as { sessions?: unknown }).sessions === 'object'
    ) {
      const p = parsed as { fingerprint: string; sessions: Record<string, number> };
      return { fingerprint: p.fingerprint, store: new Map(Object.entries(p.sessions)) };
    }
    // Legacy bare-map format → discard once (null fingerprint never matches).
    return { fingerprint: null, store: new Map(Object.entries(parsed as Record<string, number>)) };
  } catch {
    return { fingerprint: null, store: new Map() };
  }
}

function saveSessions(store: SessionStore): void {
  try {
    mkdirSync(SESSIONS_DIR, { recursive: true });
    writeFileSync(
      SESSIONS_PATH,
      JSON.stringify({ fingerprint: currentAuthFingerprint, sessions: Object.fromEntries(store) }),
      {
        encoding: 'utf-8',
        mode: 0o600,
      },
    );
    // writeFileSync's mode only applies on create; tighten a pre-existing file
    // that an older build may have written with looser perms (session tokens).
    try {
      chmodSync(SESSIONS_PATH, 0o600);
    } catch {
      /* best-effort */
    }
  } catch {
    // Non-fatal — sessions degrade to in-memory-only.
  }
}

/** Prune expired entries and return the cleaned store. */
function pruneExpired(store: SessionStore): SessionStore {
  const now = Date.now();
  const pruned: SessionStore = new Map();
  for (const [token, expiry] of store.entries()) {
    if (expiry > now) pruned.set(token, expiry);
  }
  return pruned;
}

/** In-memory mirror of the on-disk store, loaded once at startup. */
const _loaded = loadSessions();
let sessions: SessionStore = pruneExpired(_loaded.store);
/** Fingerprint the loaded sessions were issued under (null for legacy/absent). */
let loadedFingerprint: string | null = _loaded.fingerprint;
/**
 * Fingerprint of the auth secret currently in force. Written into every
 * persisted session set so a later load can detect a credential change.
 * Populated in startWebServer; empty until the first server start.
 */
let currentAuthFingerprint = loadedFingerprint ?? '';
saveSessions(sessions); // persist any pruning (rewrites legacy format)

/**
 * One-time QR login tokens, kept separate from `sessions` so they cannot be
 * used directly as session cookies and are guaranteed single-use via the
 * /api/token-login exchange. In-memory only; not persisted.
 */
const loginTokens = new Map<string, number>();

/** Delete entries whose expiry (ms epoch) is strictly before `now`. Shared by
 *  the login-token sweep; exported for unit testing. */
export function pruneExpiredTokens(map: Map<string, number>, now: number): void {
  for (const [key, expiresAt] of map) {
    if (expiresAt < now) map.delete(key);
  }
}

function addSession(token: string, expiresAt: number): void {
  sessions.set(token, expiresAt);
  saveSessions(sessions);
}

function hasSession(token: string): boolean {
  const expiry = sessions.get(token);
  if (typeof expiry !== 'number') return false;
  if (Date.now() > expiry) {
    sessions.delete(token);
    saveSessions(sessions);
    return false;
  }
  return true;
}

/* ── Login rate limiting ───────────────────────────────────────────── */

const LOGIN_RATE_WINDOW_MS = 60 * 1000;
const LOGIN_RATE_MAX_ATTEMPTS = 5;
const loginAttempts = new Map<string, { count: number; resetAt: number }>();

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry || now > entry.resetAt) return false;
  return entry.count >= LOGIN_RATE_MAX_ATTEMPTS;
}

function recordFailedLogin(ip: string): void {
  const now = Date.now();
  // Prune expired entries so the map can't grow unbounded across many distinct
  // source IPs (each failed login from a new IP would otherwise leak an entry).
  if (loginAttempts.size > 256) {
    for (const [k, v] of loginAttempts) {
      if (now > v.resetAt) loginAttempts.delete(k);
    }
  }
  const entry = loginAttempts.get(ip);
  if (!entry || now > entry.resetAt) {
    loginAttempts.set(ip, { count: 1, resetAt: now + LOGIN_RATE_WINDOW_MS });
  } else {
    entry.count += 1;
  }
}

/** Constant-time string equality. Hashes both sides first so length differences don't leak. */
function safeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/** Serialization guard — only one restart runs at a time; late callers get the latest config. */
let pendingRestart: { promise: Promise<void>; config: WebServerConfig } | null = null;

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.ts': 'application/javascript; charset=utf-8',
  '.tsx': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.flac': 'audio/flac',
  '.opus': 'audio/opus',
  '.ogg': 'audio/ogg',
};

/** Base directory where generated media files are stored. */
const MEDIA_DIR = join(homedir(), '.' + __BRAND_APP_SLUG, 'media');

/** Base directory where compiled plugin renderer bundles are cached. */
const PLUGINS_DIR = join(homedir(), '.' + __BRAND_APP_SLUG, 'plugins');

/**
 * Client-side bridge script injected into the HTML served to web clients.
 * Defines `window.app` backed by a WebSocket connection instead of Electron IPC.
 */
export function getBridgeScript(): string {
  return `<script>
(function() {
  var ws, msgId = 0, pending = {}, listeners = {};
  var reconnectDelay = 2000;

  function connect() {
    var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(proto + '//' + location.host + '/ws');

    ws.onopen = function() {
      reconnectDelay = 2000;
    };

    ws.onmessage = function(evt) {
      var msg;
      try { msg = JSON.parse(evt.data); } catch(e) { return; }

      if (msg.type === 'result' || msg.type === 'error') {
        var cb = pending[msg.id];
        if (cb) {
          delete pending[msg.id];
          if (msg.type === 'error') cb.reject(new Error(msg.message));
          else cb.resolve(msg.data);
        }
      } else if (msg.type === 'event') {
        var cbs = listeners[msg.channel];
        if (cbs) {
          for (var i = 0; i < cbs.length; i++) {
            try { cbs[i](msg.data); } catch(e) { console.error('[WsBridge] Event handler error:', e); }
          }
        }
      }
    };

    ws.onclose = function() {
      setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 1.5, 10000);
    };
  }

  function invoke(channel) {
    var args = Array.prototype.slice.call(arguments, 1);
    var id = String(++msgId);
    return new Promise(function(resolve, reject) {
      pending[id] = { resolve: resolve, reject: reject };
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        delete pending[id];
        reject(new Error('WebSocket not connected'));
        return;
      }
      ws.send(JSON.stringify({ id: id, type: 'invoke', channel: channel, args: args }));
      setTimeout(function() {
        if (pending[id]) {
          delete pending[id];
          reject(new Error('Timeout waiting for ' + channel));
        }
      }, 60000);
    });
  }

  function on(channel, callback) {
    if (!listeners[channel]) listeners[channel] = [];
    listeners[channel].push(callback);
    return function() {
      listeners[channel] = (listeners[channel] || []).filter(function(cb) { return cb !== callback; });
    };
  }

  function noop() { return Promise.resolve(); }
  function noopObj(v) { return Promise.resolve(v || {}); }

  window.app = {
    __isWebBridge: true,
    config: {
      get: function() { return invoke('config:get'); },
      set: function(path, value) { return invoke('config:set', path, value); },
      onChanged: function(cb) { return on('config:changed', cb); }
    },
    agent: {
      stream: function(cId, msgs, mk, re, pk, fb, cwd, em) { return invoke('agent:stream', cId, msgs, mk, re, pk, fb, cwd, em); },
      cancelStream: function(cId) { return invoke('agent:cancel-stream', cId); },
      inFlight: function(cId) { return invoke('agent:in-flight', cId); },
      injectMidTurn: function(cId, text) { return invoke('agent:inject-mid-turn', cId, text); },
      listInjects: function(cId) { return invoke('agent:list-injects', cId); },
      cancelInject: function(cId, id) { return invoke('agent:cancel-inject', cId, id); },
      approveToolCall: function(id) { return invoke('agent:approve-tool', id); },
      rejectToolCall: function(id) { return invoke('agent:reject-tool', id); },
      dismissToolCall: function(id) { return invoke('agent:dismiss-tool', id); },
      answerToolQuestion: function(id, answers) { return invoke('agent:answer-tool-question', id, answers); },
      generateTitle: function(msgs, mk, hint) { return invoke('agent:generate-title', msgs, mk, hint); },
      onStreamEvent: function(cb) { return on('agent:stream-event', cb); },
      sendSubAgentMessage: function(cId, msg) { return invoke('agent:sub-agent-message', cId, msg); },
      stopSubAgent: function(cId) { return invoke('agent:sub-agent-stop', cId); },
      listSubAgents: function() { return invoke('agent:sub-agent-list'); },
      getAvailableRuntimes: function() { return invoke('agent:get-available-runtimes'); },
      getActiveRuntime: function() { return invoke('agent:get-active-runtime'); }
    },
    conversations: {
      list: function() { return invoke('conversations:list'); },
      search: function(term) { return invoke('conversations:search', term); },
      get: function(id) { return invoke('conversations:get', id); },
      put: function(c) { return invoke('conversations:put', c); },
      delete: function(id) { return invoke('conversations:delete', id); },
      clear: function() { return invoke('conversations:clear'); },
      getActiveId: function() { return invoke('conversations:get-active-id'); },
      setActiveId: function(id) { return invoke('conversations:set-active-id', id); },
      fork: function(id, upTo) { return invoke('conversations:fork', id, upTo); },
      export: function(id, fmt) { return invoke('conversations:export', id, fmt); },
      onChanged: function(cb) { return on('conversations:changed', cb); }
    },
    alerts: {
      list: function(openOnly) { return invoke('alerts:list', openOnly); },
      get: function(id) { return invoke('alerts:get', id); },
      unreadCount: function() { return invoke('alerts:unreadCount'); },
      answer: function(id, answer) { return invoke('alerts:answer', id, answer); },
      decide: function(id, decision, note) { return invoke('alerts:decide', id, decision, note); },
      dismiss: function(id) { return invoke('alerts:dismiss', id); },
      onChanged: function(cb) { return on('alerts:changed', cb); },
      onNavigate: function(cb) { return on('alerts:navigate', cb); }
    },
    diffs: {
      listForConversation: function(id) { return invoke('diffs:list', id); },
      get: function(id, path) { return invoke('diffs:get', id, path); },
      revert: function(id, path) { return invoke('diffs:revert', id, path); },
      revertAll: function(id) { return invoke('diffs:revertAll', id); },
      revertHunk: function(id, path, hunkIndex) { return invoke('diffs:revertHunk', id, path, hunkIndex); },
      revertToOp: function(id, path, opIndex) { return invoke('diffs:revertToOp', id, path, opIndex); },
      clear: function(id) { return invoke('diffs:clear', id); },
      onChange: function(cb) { return on('diffs:changed', cb); }
    },
    artifacts: {
      bundleReact: function(source) { return invoke('artifact:bundle-react', { source: source }); }
    },
    memory: {
      clear: function(opts) { return invoke('memory:clear', opts); },
      testEmbedding: function() { return invoke('memory:test-embedding'); }
    },
    mcp: {
      testConnection: function(server) { return invoke('mcp:test-connection', server); }
    },
    cliTools: {
      checkBinaries: function(names) { return invoke('cli-tools:check-binaries', names); }
    },
    skills: {
      list: function() { return invoke('skills:list'); },
      get: function(name) { return invoke('skills:get', name); },
      delete: function(name) { return invoke('skills:delete', name); },
      toggle: function(name, enable) { return invoke('skills:toggle', name, enable); }
    },
    plugins: {
      getUIState: function() { return invoke('plugin:get-ui-state'); },
      list: function() { return invoke('plugin:list'); },
      getConfig: function(pn) { return invoke('plugin:get-config', pn); },
      setConfig: function(pn, path, value) { return invoke('plugin:set-config', pn, path, value); },
      modalAction: function(pn, mid, act, data) { return invoke('plugin:modal-action', pn, mid, act, data); },
      bannerAction: function(pn, bid, act, data) { return invoke('plugin:banner-action', pn, bid, act, data); },
      action: function(pn, tid, act, data) { return invoke('plugin:action', pn, tid, act, data); },
      marketplaceCatalog: function() { return invoke('plugin:marketplace-catalog'); },
      marketplaceInstall: function(pn) { return invoke('plugin:marketplace-install', pn); },
      marketplaceInstallUnverified: function(pn) { return invoke('plugin:marketplace-install-unverified', pn); },
      marketplaceUninstall: function(pn) { return invoke('plugin:marketplace-uninstall', pn); },
      disable: function(pn, opts) { return invoke('plugin:disable', pn, opts); },
      enable: function(pn) { return invoke('plugin:enable', pn); },
      marketplaceRefresh: function() { return invoke('plugin:marketplace-refresh'); },
      getAvailableUpdateCount: function() { return invoke('plugin:available-update-count'); },
      getPendingRestart: function() { return invoke('plugin:pending-restart'); },
      restartApp: function() { return invoke('plugin:restart-app'); },
      getFailedUpdates: function() { return invoke('plugin:failed-updates'); },
      approveConsent: function(pn) { return invoke('plugin:approve-consent', pn); },
      denyConsent: function(pn) { return invoke('plugin:deny-consent', pn); },
      getPendingConsent: function() { return invoke('plugin:pending-consent'); },
      onUIStateChanged: function(cb) { return on('plugin:ui-state-changed', cb); },
      onEvent: function(cb) { return on('plugin:event', cb); },
      onNavigationRequest: function(cb) { return on('plugin:navigation-request', cb); },
      onNavigateDirect: function(cb) { return on('plugin:navigate-direct', cb); },
      onModalCallback: function(cb) { return on('plugin:modal-callback', cb); },
      onUpdatesAvailable: function(cb) { return on('plugin:updates-available', cb); },
      onPendingRestartChanged: function(cb) { return on('plugin:pending-restart-changed', cb); },
      onFailedUpdatesChanged: function(cb) { return on('plugin:failed-updates-changed', cb); },
      onConsentRequired: function(cb) { return on('plugin:consent-required', cb); }
    },
    automations: {
      catalog: function() { return invoke('automations:catalog'); },
      log: function() { return invoke('automations:log'); },
      test: function(ruleId, payload) { return invoke('automations:test', ruleId, payload); },
      emit: function(source, event, payload) { return invoke('automations:emit', source, event, payload); },
      inFlight: function(conversationId) { return invoke('automations:in-flight', conversationId); },
      abort: function(conversationId) { return invoke('automations:abort', conversationId); },
      onRun: function(cb) { return on('automations:run', cb); },
      onCatalogChanged: function(cb) { return on('automations:catalog-changed', cb); }
    },
    modelCatalog: function() { return invoke('agent:model-catalog'); },
    realtime: {
      startSession: function(cId) { return invoke('realtime:start-session', cId); },
      endSession: function() { return invoke('realtime:end-session'); },
      sendAudio: function(pcm) { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'send', channel: 'realtime:send-audio', data: pcm })); },
      getStatus: function() { return invoke('realtime:get-status'); },
      onEvent: function(cb) { return on('realtime:event', cb); }
    },
    profileCatalog: function() { return invoke('agent:profiles'); },
    dialog: {
      openFile: function() { return Promise.resolve({ canceled: true, files: [] }); },
      openDirectory: function() { return Promise.resolve({ canceled: true }); },
      openDirectoryFiles: function() { return Promise.resolve({ canceled: true, filePaths: [] }); },
      openPath: function() { return Promise.resolve({ canceled: true }); }
    },
    fileAccess: {
      previewPath: function(entry) { return invoke('fileAccess:preview-path', entry); }
    },
    clipboard: {
      writeText: function(text) { try { navigator.clipboard.writeText(text); return Promise.resolve({ ok: true }); } catch(e) { return Promise.resolve({ ok: false, error: String(e) }); } }
    },
    image: {
      fetch: function() { return Promise.resolve({ error: 'Not supported in web mode' }); },
      save: function() { return Promise.resolve({ canceled: true }); }
    },
    platform: {
      os: '${process.platform}',
      homedir: function() { return invoke('platform:homedir'); },
      getCapabilities: function() { return invoke('platform:get-capabilities'); },
      getPermissions: function() { return invoke('platform:get-permissions'); },
      getFeatureCapabilities: function() { return invoke('platform:get-feature-capabilities'); }
    },
    appShots: {
      capture: function() { return invoke('app-shots:capture'); },
      suspendHotkey: function() { return invoke('app-shots:suspend-hotkey'); },
      resumeHotkey: function() { return invoke('app-shots:resume-hotkey'); },
      resolveRef: function(refId) { return invoke('app-shots:resolve-ref', refId); },
      onCaptured: function(cb) { return on('app-shots:captured', cb); }
    },
    appshots: {
      list: function() { return invoke('appshots:list'); },
      get: function(id) { return invoke('appshots:get', id); },
      getImage: function(id) { return invoke('appshots:get-image', id); },
      delete: function(id) { return invoke('appshots:delete', id); },
      deleteAll: function() { return invoke('appshots:delete-all'); },
      update: function(id, patch) { return invoke('appshots:update', id, patch); },
      onChanged: function(cb) { return on('appshots:changed', cb); }
    },
    webServer: {
      getLanAddresses: function() { return invoke('webServer:lan-addresses'); },
      createToken: function() { return invoke('webServer:create-token'); }
    },
    fs: {
      listDirectory: function(dirPath) { return invoke('fs:list-directory', dirPath); }
    },
    computerUse: {
      startSession: function(goal, opts) { return invoke('computer-use:start-session', goal, opts); },
      pauseSession: function(sId) { return invoke('computer-use:pause-session', sId); },
      resumeSession: function(sId) { return invoke('computer-use:resume-session', sId); },
      stopSession: function(sId) { return invoke('computer-use:stop-session', sId); },
      approveAction: function(sId, aId) { return invoke('computer-use:approve-action', sId, aId); },
      rejectAction: function(sId, aId, r) { return invoke('computer-use:reject-action', sId, aId, r); },
      listSessions: function() { return invoke('computer-use:list-sessions'); },
      getSession: function(sId) { return invoke('computer-use:get-session', sId); },
      setSurface: function(sId, s) { return invoke('computer-use:set-surface', sId, s); },
      sendGuidance: function(sId, t) { return invoke('computer-use:send-guidance', sId, t); },
      updateSessionSettings: function(sId, s) { return invoke('computer-use:update-session-settings', sId, s); },
      continueSession: function(sId, g) { return invoke('computer-use:continue-session', sId, g); },
      markSessionsSeen: function(cId) { return invoke('computer-use:mark-sessions-seen', cId); },
      openSetupWindow: function() { return Promise.resolve(); },
      getLocalMacosPermissions: function() { return invoke('computer-use:get-local-macos-permissions'); },
      requestLocalMacosPermissions: function() { return invoke('computer-use:request-local-macos-permissions'); },
      requestSingleLocalMacosPermission: function(s) { return invoke('computer-use:request-single-local-macos-permission', s); },
      openLocalMacosPrivacySettings: function(s) { return invoke('computer-use:open-local-macos-privacy-settings', s); },
      probeInputMonitoring: function(t) { return invoke('computer-use:probe-input-monitoring', t); },
      checkFullScreenApps: function() { return invoke('computer-use:check-fullscreen-apps'); },
      exitFullScreenApps: function(a) { return invoke('computer-use:exit-fullscreen-apps', a); },
      listRunningApps: function() { return invoke('computer-use:list-running-apps'); },
      listDisplays: function() { return invoke('computer-use:list-displays'); },
      focusSession: function(sId) { return invoke('computer-use:focus-session', sId); },
      overlayMouseEnter: noop,
      overlayMouseLeave: noop,
      onEvent: function(cb) { return on('computer-use:event', cb); },
      onOverlayState: function(cb) { return on('computer-use:overlay-state', cb); },
      onFocusThread: function(cb) { return on('computer-use:focus-thread', cb); }
    },
    mic: {
      listDevices: function() { return Promise.resolve([]); },
      startRecording: function() { return Promise.resolve({ error: 'Not supported in web mode' }); },
      stopRecording: function() { return Promise.resolve({ error: 'Not supported in web mode' }); },
      cancelRecording: function() { return Promise.resolve({ ok: true }); },
      startMonitor: function() { return Promise.resolve({}); },
      getLevel: function() { return Promise.resolve({}); },
      stopMonitor: function() { return Promise.resolve({ ok: true }); },
      liveStart: function() { return Promise.resolve({ error: 'Not supported in web mode' }); },
      liveMicStart: function() { return Promise.resolve({ error: 'Not supported in web mode' }); },
      liveMicDrain: function() { return Promise.resolve([]); },
      liveMicStop: function() { return Promise.resolve({ ok: true }); },
      liveAudio: noop,
      liveStop: function() { return Promise.resolve({ ok: true }); },
      onPartial: function(cb) { return on('stt:partial', cb); },
      onFinal: function(cb) { return on('stt:final', cb); },
      onSttError: function(cb) { return on('stt:error', cb); }
    },
    usage: {
      summary: function() { return invoke('usage:summary'); },
      byConversation: function(p) { return invoke('usage:by-conversation', p); },
      byModel: function() { return invoke('usage:by-model'); },
      timeSeries: function(p) { return invoke('usage:time-series', p); },
      nonLlmEvents: function(p) { return invoke('usage:non-llm-events', p); },
      recordEvent: function(e) { return invoke('usage:record-event', e); },
      exportCsv: function() { return invoke('usage:export-csv'); }
    },
    workspaces: {
      create: function(args) { return invoke('workspaces:create', args); },
      rename: function(args) { return invoke('workspaces:rename', args); },
      delete: function(args) { return invoke('workspaces:delete', args); },
      setActive: function(args) { return invoke('workspaces:set-active', args); },
      saveLastConversation: function(args) { return invoke('workspaces:save-last-conversation', args); },
      browseDirectory: function() { return invoke('workspaces:browse-directory'); }
    },
    tasks: {
      list: function() { return invoke('tasks:list'); },
      listAll: function() { return invoke('tasks:list-all'); },
      get: function(id) { return invoke('tasks:get', id); },
      create: function(taskData) { return invoke('tasks:create', taskData); },
      update: function(id, updates) { return invoke('tasks:update', id, updates); },
      delete: function(id) { return invoke('tasks:delete', id); },
      unarchive: function(id) { return invoke('tasks:unarchive', id); },
      kickBack: function(id, reason, source) { return invoke('tasks:kick-back', id, reason, source); },
      getOrder: function() { return invoke('tasks:get-order'); },
      saveOrder: function(order) { return invoke('tasks:save-order', order); },
      onChanged: function(cb) { return on('tasks:changed', cb); },
      terminalCreate: function(taskId, options) { return invoke('tasks:terminal-create', taskId, options); },
      terminalWrite: function(sessionId, data) { return invoke('tasks:terminal-write', sessionId, data); },
      terminalResize: function(sessionId, cols, rows) { return invoke('tasks:terminal-resize', sessionId, cols, rows); },
      terminalKill: function(sessionId) { return invoke('tasks:terminal-kill', sessionId); },
      terminalGetBuffer: function(sessionId) { return invoke('tasks:terminal-get-buffer', sessionId); },
      onTerminalData: function(cb) { return on('tasks:terminal-data', cb); },
      onTerminalExit: function(cb) { return on('tasks:terminal-exit', cb); },
      streamPlan: function(taskId, userMessage, history) { return invoke('tasks:stream-plan', taskId, userMessage, history); },
      cancelPlanStream: function(taskId) { return invoke('tasks:cancel-stream', taskId); },
      generateTitle: function(userMessage) { return invoke('tasks:generate-title', userMessage); },
      onStreamEvent: function(cb) { return on('tasks:stream-event', cb); }
    },
    agents: {
      list: function() { return invoke('agents:list'); },
      get: function(id) { return invoke('agents:get', id); },
      create: function(payload) { return invoke('agents:create', payload); },
      update: function(id, updates) { return invoke('agents:update', id, updates); },
      delete: function(id) { return invoke('agents:delete', id); },
      assignTask: function(agentId, taskId) { return invoke('agents:assign-task', agentId, taskId); },
      unassignTask: function(agentId) { return invoke('agents:unassign-task', agentId); },
      start: function(agentId) { return invoke('agents:start', agentId); },
      stop: function(agentId) { return invoke('agents:stop', agentId); },
      synthesizePrompt: function(agentId, userDescription) { return invoke('agents:synthesize-prompt', agentId, userDescription); },
      onChanged: function(cb) { return on('agents:changed', cb); }
    },
    shell: {
      openPath: function(filePath) { return invoke('shell:open-path', filePath); }
    },
    partitions: {
      list: function() { return invoke('partitions:list'); },
      delete: function(names) { return invoke('partitions:delete', names); }
    },
    cli: {
      installStatus: function() { return invoke('cli:install-status'); },
      install: function() { return invoke('cli:install'); },
      uninstall: function() { return invoke('cli:uninstall'); }
    },
    autoUpdate: {
      check: function() { return invoke('auto-update:check'); },
      install: function() { return invoke('auto-update:install'); },
      onStatus: function(cb) { return on('auto-update:status', cb); }
    },
    dictation: {
      toggle: function() { return invoke('dictation:toggle'); },
      stop: function() { return invoke('dictation:stop'); },
      getState: function() { return invoke('dictation:get-state'); },
      getTypingMode: function() { return invoke('dictation:get-typing-mode'); },
      setDevice: function(deviceId) { return invoke('dictation:set-device', deviceId); },
      suspendHotkey: function() { return invoke('dictation:suspend-hotkey'); },
      resumeHotkey: function() { return invoke('dictation:resume-hotkey'); },
      setOverlayInteractive: function(interactive) { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'send', channel: 'dictation:overlay-set-interactive', data: interactive })); },
      resizeOverlay: function(height) { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'send', channel: 'dictation:overlay-resize', data: height })); },
      restoreOverlayFocus: function() { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'send', channel: 'dictation:overlay-restore-focus' })); },
      onStateChange: function(cb) { return on('dictation:state', cb); },
      onLevel: function(cb) { return on('dictation:level', cb); },
      onPartial: function(cb) { return on('dictation:partial', cb); },
      onFinal: function(cb) { return on('dictation:final', cb); },
      onError: function(cb) { return on('dictation:error', cb); },
      onTypingMode: function(cb) { return on('dictation:typing-mode', cb); }
    },
    onMenuOpenSettings: function(cb) { return on('menu:open-settings', cb); },
    onFind: function(cb) { return on('menu:find', cb); },
    onModelSwitched: function(cb) { return on('agent:model-switched', cb); },
    onExecutionModeChanged: function(cb) { return on('agent:execution-mode-changed', cb); }
  };

  connect();
})();
</script>
<link rel="icon" type="image/png" href="/favicon.png">`;
}

function parseCookies(req: http.IncomingMessage): Record<string, string> {
  const header = req.headers.cookie ?? '';
  const cookies = Object.create(null) as Record<string, string>;
  for (const pair of header.split(';')) {
    const [name, ...rest] = pair.trim().split('=');
    if (name) cookies[name] = rest.join('=');
  }
  return cookies;
}

function hasValidSession(req: http.IncomingMessage): boolean {
  const cookies = parseCookies(req);
  const token = cookies[__BRAND_APP_SLUG + '_session'];
  return Boolean(token && hasSession(token));
}

function isAuthenticated(req: http.IncomingMessage, config: WebServerConfig): boolean {
  if (config.auth.mode === 'anonymous') return true;
  return hasValidSession(req);
}

/** Routes that bypass auth so the login page and its API work. */
const AUTH_EXEMPT_PATHS = new Set([
  '/login',
  '/api/login',
  '/api/auth-status',
  '/api/token-login',
  '/favicon.ico',
  '/favicon.png',
]);

function getRendererDir(): string {
  return join(import.meta.dirname, '../renderer');
}

function serveStaticFile(filePath: string, res: http.ServerResponse, bridgeScript?: string): void {
  try {
    if (!existsSync(filePath) || !statSync(filePath).isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
      return;
    }

    const ext = extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    // Inject bridge script into HTML files
    if (ext === '.html' && bridgeScript) {
      let html = readFileSync(filePath, 'utf-8');
      html = html.replace('</head>', bridgeScript + '\n</head>');
      const buf = Buffer.from(html, 'utf-8');
      res.writeHead(200, {
        'Content-Type': contentType,
        'Content-Length': buf.byteLength,
        'Cache-Control': 'no-cache',
      });
      res.end(buf);
      return;
    }

    const data = readFileSync(filePath);
    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': data.byteLength,
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable',
    });
    res.end(data);
  } catch {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Internal Server Error');
  }
}

function proxyToViteDev(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  viteUrl: string,
  bridgeScript: string,
): void {
  const targetUrl = new URL(req.url ?? '/', viteUrl);

  const proxyReq = http.request(
    targetUrl,
    { method: req.method, headers: { ...req.headers, host: targetUrl.host } },
    (proxyRes) => {
      const ct = proxyRes.headers['content-type'] ?? '';
      const isHtml = ct.includes('text/html');

      if (isHtml) {
        // Collect HTML, inject bridge script
        const chunks: Buffer[] = [];
        proxyRes.on('data', (chunk: Buffer) => chunks.push(chunk));
        proxyRes.on('end', () => {
          let html = Buffer.concat(chunks).toString('utf-8');
          html = html.replace('</head>', bridgeScript + '\n</head>');
          const buf = Buffer.from(html, 'utf-8');
          const headers = { ...proxyRes.headers };
          delete headers['content-length'];
          delete headers['content-encoding'];
          headers['content-length'] = String(buf.byteLength);
          res.writeHead(proxyRes.statusCode ?? 200, headers);
          res.end(buf);
        });
      } else {
        res.writeHead(proxyRes.statusCode ?? 200, proxyRes.headers);
        proxyRes.pipe(res);
      }
    },
  );

  proxyReq.on('error', () => {
    res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end('Vite dev server not reachable');
  });

  req.pipe(proxyReq);
}

export async function startWebServer(config: WebServerConfig): Promise<void> {
  if (httpServer) await stopWebServer();

  // Defense in depth: refuse to start in password mode with an empty password.
  // The config layer auto-generates one on first enable, but if that path is
  // ever bypassed (manual config edit, migration bug) we fail closed here
  // rather than silently accepting an empty-string credential.
  if (config.auth.mode === 'password' && !config.auth.password) {
    throw new Error('[WebServer] Refusing to start: auth mode is "password" but no password is set.');
  }

  // Invalidate all previously-issued session cookies if the auth secret changed
  // since they were persisted (password rotation, or an anon↔password switch).
  // A leaked/stale token must not survive a credential change. restartWebServer
  // (stop→start) runs on every config change, so this is the rotation trigger.
  const fingerprint = authFingerprint(config);
  currentAuthFingerprint = fingerprint;
  if (!sessionsCarryOver(loadedFingerprint, fingerprint)) {
    sessions.clear();
    loadedFingerprint = fingerprint;
    saveSessions(sessions);
  } else {
    loadedFingerprint = fingerprint;
  }

  const bridgeScript = getBridgeScript();
  const rendererDir = getRendererDir();
  const viteDevUrl = process.env.ELECTRON_RENDERER_URL;

  // Resolve TLS options
  let tlsOptions: { cert: string; key: string } | null = null;
  if (config.tls?.enabled) {
    if (config.tls.mode === 'custom' && config.tls.certPath && config.tls.keyPath) {
      tlsOptions = {
        cert: readFileSync(config.tls.certPath, 'utf-8'),
        key: readFileSync(config.tls.keyPath, 'utf-8'),
      };
    } else {
      tlsOptions = ensureSelfSignedCert();
    }
  }

  const requestHandler = (req: http.IncomingMessage, res: http.ServerResponse) => {
    const urlPath = (req.url ?? '/').split('?')[0];

    // --- Auth-exempt API endpoints ---

    if (urlPath === '/api/login' && req.method === 'POST') {
      const ip = req.socket.remoteAddress ?? 'unknown';
      if (isRateLimited(ip)) {
        res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '60' });
        res.end(JSON.stringify({ ok: false, error: 'Too many attempts' }));
        return;
      }
      const chunks: Buffer[] = [];
      let received = 0;
      let aborted = false;
      req.on('data', (chunk: Buffer) => {
        if (aborted) return;
        received += chunk.length;
        // Login bodies are tiny JSON; cap hard so an unauthenticated client
        // cannot exhaust memory before rate limiting kicks in.
        if (received > MAX_LOGIN_BODY_BYTES) {
          aborted = true;
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'Request too large' }));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        if (aborted) return;
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
          const userOk = safeEqual(String(body.username ?? '').toLowerCase(), config.auth.username.toLowerCase());
          const passOk = safeEqual(String(body.password ?? ''), config.auth.password);
          if (userOk && passOk) {
            const token = crypto.randomUUID();
            addSession(token, Date.now() + SESSION_LIFETIME_MS);
            const secure = config.tls?.enabled ? '; Secure' : '';
            res.writeHead(200, {
              'Content-Type': 'application/json',
              'Set-Cookie': `${__BRAND_APP_SLUG}_session=${token}; HttpOnly; Path=/; SameSite=Strict; Max-Age=${SESSION_MAX_AGE_SECS}${secure}`,
            });
            res.end(JSON.stringify({ ok: true }));
          } else {
            recordFailedLogin(ip);
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'Invalid credentials' }));
          }
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'Bad request' }));
        }
      });
      return;
    }

    if (urlPath === '/api/auth-status') {
      const authed = isAuthenticated(req, config);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ authenticated: authed, mode: config.auth.mode }));
      return;
    }

    // Token-based auto-login (for QR code scanning)
    if (urlPath === '/api/token-login') {
      // Parse against a FIXED base (not the client Host header, which can be
      // malformed and make `new URL` throw on this auth-exempt route). We only
      // need the query string, so the base host is irrelevant.
      let loginToken: string | null = null;
      try {
        loginToken = new URL(req.url ?? '/', 'http://localhost').searchParams.get('token');
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Bad request' }));
        return;
      }
      const loginTokenExpiry = loginToken ? loginTokens.get(loginToken) : undefined;
      if (loginToken && typeof loginTokenExpiry === 'number' && Date.now() <= loginTokenExpiry) {
        // Consume the token (one-time use)
        loginTokens.delete(loginToken);
        // Issue a fresh session cookie
        const sessionToken = crypto.randomUUID();
        addSession(sessionToken, Date.now() + SESSION_LIFETIME_MS);
        const secure = config.tls?.enabled ? '; Secure' : '';
        res.writeHead(302, {
          Location: '/',
          'Set-Cookie': `${__BRAND_APP_SLUG}_session=${sessionToken}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${SESSION_MAX_AGE_SECS}${secure}`,
        });
        res.end();
      } else {
        // Reject: delete a presented-but-expired token so it doesn't linger in
        // the map (createLoginToken also sweeps, but deleting on presentation
        // reclaims it immediately).
        if (loginToken) loginTokens.delete(loginToken);
        res.writeHead(302, { Location: '/login' });
        res.end();
      }
      return;
    }

    // --- Favicon ---

    if ((urlPath === '/favicon.ico' || urlPath === '/favicon.png') && faviconBuffer) {
      res.writeHead(200, {
        'Content-Type': 'image/png',
        'Content-Length': faviconBuffer.byteLength,
        'Cache-Control': 'public, max-age=86400',
      });
      res.end(faviconBuffer);
      return;
    }

    // --- Auth check (skip for login page) ---

    if (!AUTH_EXEMPT_PATHS.has(urlPath) && !isAuthenticated(req, config)) {
      res.writeHead(302, { Location: '/login' });
      res.end();
      return;
    }

    // --- Login page ---

    if (urlPath === '/login') {
      if (config.auth.mode === 'anonymous' || isAuthenticated(req, config)) {
        res.writeHead(302, { Location: '/' });
        res.end();
        return;
      }
      const html = getLoginPageHtml();
      const buf = Buffer.from(html, 'utf-8');
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': buf.byteLength,
        'Cache-Control': 'no-cache',
      });
      res.end(buf);
      return;
    }

    // --- Serve generated media files (images, videos, audio) ---
    if (urlPath.startsWith('/media/')) {
      const relativePath = decodeURIComponent(urlPath.slice('/media/'.length));
      const filePath = join(MEDIA_DIR, relativePath);

      // Security: ensure the resolved path is under the media directory
      if (!filePath.startsWith(MEDIA_DIR + sep) && filePath !== MEDIA_DIR) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('Forbidden');
        return;
      }

      if (!existsSync(filePath) || !statSync(filePath).isFile()) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
        return;
      }

      // Re-check containment on the canonical path so a symlink inside
      // MEDIA_DIR cannot escape the directory (lexical check above only
      // guards the request path, not the on-disk link target). Resolve
      // MEDIA_DIR too, so a legitimately symlinked media root still matches.
      let realMediaPath: string;
      let realMediaRoot: string;
      try {
        realMediaPath = realpathSync(filePath);
        realMediaRoot = realpathSync(MEDIA_DIR);
      } catch {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
        return;
      }
      if (!realMediaPath.startsWith(realMediaRoot + sep) && realMediaPath !== realMediaRoot) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('Forbidden');
        return;
      }

      // Open + validate + read through a single fd to close the TOCTOU gap:
      // the fd is bound to the inode at open time, so a symlink/file swap after
      // the realpath check above cannot redirect the read to another target.
      const ext = extname(realMediaPath).toLowerCase();
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';
      let data: Buffer;
      let fd: number | null = null;
      try {
        // O_NOFOLLOW: after realpathSync every ancestor is already canonical, so
        // this makes the open fail if the final node was swapped to a symlink
        // between the check and the open — closing the TOCTOU window without a
        // hand-rolled openat path walk. (constants.O_RDONLY | O_NOFOLLOW.)
        fd = openSync(realMediaPath, constants.O_RDONLY | constants.O_NOFOLLOW);
        const st = fstatSync(fd);
        if (!st.isFile()) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Not Found');
          return;
        }
        data = Buffer.allocUnsafe(st.size);
        let offset = 0;
        while (offset < st.size) {
          const bytesRead = readSync(fd, data, offset, st.size - offset, offset);
          if (bytesRead <= 0) break;
          offset += bytesRead;
        }
        if (offset !== st.size) data = data.subarray(0, offset);
      } catch {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
        return;
      } finally {
        if (fd !== null) {
          try {
            closeSync(fd);
          } catch {
            /* ignore */
          }
        }
      }
      res.writeHead(200, {
        'Content-Type': contentType,
        'Content-Length': data.byteLength,
        'Cache-Control': 'no-cache',
      });
      res.end(data);
      return;
    }

    // --- Serve plugin frontend files directly from plugin directory ---
    if (urlPath.startsWith('/plugin-renderer/')) {
      // URL format: /plugin-renderer/<pluginName>/<assetPath>
      const segments = urlPath.slice('/plugin-renderer/'.length).split('/').map(decodeURIComponent);
      const [pluginName, ...assetParts] = segments;
      const assetPath = assetParts.join('/');

      if (
        !pluginName ||
        !assetPath ||
        pluginName.includes('/') ||
        pluginName.includes('\\') ||
        pluginName === '.' ||
        pluginName === '..'
      ) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Bad Request');
        return;
      }

      const pluginDir = join(PLUGINS_DIR, pluginName);
      const filePath = join(pluginDir, assetPath);

      // Security: ensure the resolved path stays within THIS plugin's directory.
      // `pluginName` is validated above (no `..` / separators), so `pluginDir`
      // is a trustworthy anchor; anchoring only to PLUGINS_DIR would allow
      // `../other-plugin/...` traversal between plugins.
      if (!filePath.startsWith(pluginDir + sep) && filePath !== pluginDir) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('Forbidden');
        return;
      }

      if (!existsSync(filePath) || !statSync(filePath).isFile()) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
        return;
      }

      // Symlink defence: resolve the canonical path AND the plugin root, then
      // re-check containment so a symlink inside the plugin dir (or a symlinked
      // plugin root) cannot escape it. (statSync follows links, so isFile()
      // above doesn't catch this.)
      let realPath: string;
      let realPluginDir: string;
      try {
        realPath = realpathSync(filePath);
        realPluginDir = realpathSync(pluginDir);
      } catch {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
        return;
      }
      if (!realPath.startsWith(realPluginDir + sep) && realPath !== realPluginDir) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('Forbidden');
        return;
      }

      // Read through a validated fd (O_NOFOLLOW) so a symlink swap after the
      // realpath check can't redirect the read outside the plugin dir (mirrors
      // the /media route).
      const ext = extname(realPath).toLowerCase();
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';
      let data: Buffer;
      let fd: number | null = null;
      try {
        fd = openSync(realPath, constants.O_RDONLY | constants.O_NOFOLLOW);
        const st = fstatSync(fd);
        if (!st.isFile()) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Not Found');
          return;
        }
        data = Buffer.allocUnsafe(st.size);
        let offset = 0;
        while (offset < st.size) {
          const bytesRead = readSync(fd, data, offset, st.size - offset, offset);
          if (bytesRead <= 0) break;
          offset += bytesRead;
        }
        if (offset !== st.size) data = data.subarray(0, offset);
      } catch {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
        return;
      } finally {
        if (fd !== null) {
          try {
            closeSync(fd);
          } catch {
            /* ignore */
          }
        }
      }
      res.writeHead(200, {
        'Content-Type': contentType,
        'Content-Length': data.byteLength,
        'Cache-Control': 'no-cache',
      });
      res.end(data);
      return;
    }

    // Dev mode: proxy to Vite
    if (viteDevUrl) {
      proxyToViteDev(req, res, viteDevUrl, bridgeScript);
      return;
    }

    // Production: serve static files
    if (urlPath === '/' || urlPath === '/index.html') {
      serveStaticFile(join(rendererDir, 'index.html'), res, bridgeScript);
      return;
    }

    const filePath = join(rendererDir, urlPath);
    // Security: prevent path traversal
    if (!filePath.startsWith(rendererDir + sep) && filePath !== rendererDir) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Forbidden');
      return;
    }

    if (existsSync(filePath) && statSync(filePath).isFile()) {
      serveStaticFile(filePath, res);
    } else {
      // SPA fallback
      serveStaticFile(join(rendererDir, 'index.html'), res, bridgeScript);
    }
  };

  // Create HTTP or HTTPS server
  httpServer = tlsOptions
    ? https.createServer({ cert: tlsOptions.cert, key: tlsOptions.key }, requestHandler)
    : http.createServer(requestHandler);

  // WebSocket server. Cap frame size — every message is UTF-8 decoded and
  // JSON.parsed on the main process, so an unbounded frame is a DoS vector
  // (especially in anonymous mode). `ws` closes oversized frames with 1009.
  wss = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_MESSAGE_BYTES });

  const handleUpgrade = (req: http.IncomingMessage, socket: Duplex, head: Buffer) => {
    const upgradePath = (req.url ?? '/').split('?')[0];

    if (upgradePath !== '/ws') {
      // In dev mode, proxy non-app WebSocket upgrades (e.g. Vite HMR) to
      // the Vite dev server so hot-reload works through the web UI.
      if (viteDevUrl) {
        const viteTarget = new URL(req.url ?? '/', viteDevUrl);
        const viteReq = http.request({
          hostname: viteTarget.hostname,
          port: viteTarget.port,
          path: viteTarget.pathname + viteTarget.search,
          method: 'GET',
          headers: {
            ...req.headers,
            host: viteTarget.host,
          },
        });
        viteReq.on('upgrade', (_res, viteSocket, viteHead) => {
          // Forward any leading bytes from Vite
          if (viteHead.length) socket.write(viteHead);
          // Replay the 101 response back to the client — Vite's response is
          // already sitting in viteSocket's internal buffer, but the HTTP
          // upgrade event fires *after* the 101 has been consumed. We need to
          // reconstruct the 101 Switching Protocols response for the client.
          // The simplest way: build it from _res headers.
          const statusLine = `HTTP/1.1 ${_res.statusCode} ${_res.statusMessage}\r\n`;
          const headers = Object.entries(_res.headers)
            .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`)
            .join('\r\n');
          socket.write(statusLine + headers + '\r\n\r\n');
          // Bi-directional pipe
          socket.pipe(viteSocket);
          viteSocket.pipe(socket);
          socket.on('error', () => viteSocket.destroy());
          viteSocket.on('error', () => socket.destroy());
          socket.on('close', () => viteSocket.destroy());
          viteSocket.on('close', () => socket.destroy());
        });
        viteReq.on('error', () => socket.destroy());
        viteReq.end();
      } else {
        socket.destroy();
      }
      return;
    }

    // Origin check — block cross-site WebSocket hijacking. Browsers always
    // send Origin on WS upgrades; non-browser clients may omit it (allowed).
    const origin = req.headers.origin;
    if (origin) {
      try {
        const o = new URL(origin);
        const expectedHost = req.headers.host;
        if (o.host !== expectedHost) {
          socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
          socket.destroy();
          return;
        }
      } catch {
        socket.destroy();
        return;
      }
    }

    // Auth check for WebSocket (cookies)
    if (config.auth.mode === 'password') {
      if (!hasValidSession(req)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
    }

    wss!.handleUpgrade(req, socket, head, (ws) => {
      wss!.emit('connection', ws, req);
    });
  };

  httpServer.on('upgrade', handleUpgrade);

  wss.on('connection', (ws: WebSocket) => {
    webClients.add(ws);

    // Per-connection in-flight cap: each WS message spawns an independent async
    // invoke (the EventEmitter doesn't await the prior one), so an authenticated
    // client could otherwise fire thousands of concurrent expensive invokes.
    // Cap concurrency and reject past it rather than queueing unbounded.
    const MAX_IN_FLIGHT = 32;
    let inFlight = 0;

    // Heartbeat: ping every 30s, terminate if no pong within 10s
    let alive = true;
    ws.on('pong', () => {
      alive = true;
    });
    const heartbeat = setInterval(() => {
      if (!alive) {
        clearInterval(heartbeat);
        ws.terminate();
        return;
      }
      alive = false;
      ws.ping();
    }, 30000);

    ws.on('message', async (raw: Buffer | string) => {
      let msg: { id?: string; type?: string; channel?: string; args?: unknown[]; data?: unknown };
      try {
        const parsed: unknown = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf-8'));
        // A literal `null`/array/primitive parses fine but reading `.type` off a
        // non-object throws OUTSIDE this catch — guard for a plain object.
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return;
        msg = parsed as typeof msg;
      } catch {
        return;
      }

      if (msg.type === 'invoke' && msg.channel && msg.id) {
        const id = msg.id;
        // Reject past the per-connection concurrency cap rather than piling on.
        if (inFlight >= MAX_IN_FLIGHT) {
          ws.send(JSON.stringify({ id, type: 'error', message: 'Too many concurrent requests' }));
          return;
        }
        // args must be an array — a malformed frame with a non-array `args`
        // would otherwise spread a string into char-args or throw on a
        // non-iterable. Coerce defensively.
        const invokeArgs = Array.isArray(msg.args) ? msg.args : [];
        inFlight += 1;
        try {
          const result = await invokeHandler(msg.channel, ...invokeArgs);
          ws.send(JSON.stringify({ id, type: 'result', data: result }));
        } catch (err) {
          ws.send(
            JSON.stringify({
              id,
              type: 'error',
              message: err instanceof Error ? err.message : String(err),
            }),
          );
        } finally {
          inFlight -= 1;
        }
      }

      // Fire-and-forget sends (like realtime:send-audio)
      if (msg.type === 'send' && msg.channel) {
        try {
          await invokeHandler(msg.channel, msg.data);
        } catch {
          // Ignore errors on fire-and-forget
        }
      }
    });

    ws.on('close', () => {
      clearInterval(heartbeat);
      webClients.delete(ws);
      notifyClientCountChanged(); // a demoted headless backend may now be idle
    });

    ws.on('error', () => {
      clearInterval(heartbeat);
      webClients.delete(ws);
      notifyClientCountChanged();
    });
  });

  const bindAddress = config.bindAddress || '0.0.0.0';

  if (tlsOptions) {
    // TLS mode: listen the HTTPS and a redirect HTTP server on ephemeral
    // loopback ports, then front them with a net.Server on the real port
    // that peeks the first byte to decide which one gets the connection.
    redirectServer = http.createServer((req, res) => {
      const host = (req.headers.host ?? 'localhost').replace(/:\d+$/, '');
      const location = `https://${host}:${config.port}${req.url ?? '/'}`;
      res.writeHead(301, { Location: location });
      res.end();
    });

    await Promise.all([
      new Promise<void>((r) => httpServer!.listen(0, '127.0.0.1', r)),
      new Promise<void>((r) => redirectServer!.listen(0, '127.0.0.1', r)),
    ]);

    netServer = net.createServer((socket) => {
      // Slowloris guard: this pre-read waits for the first byte to sniff TLS vs
      // plain HTTP, but socket.once('readable') alone waits forever — an unauth
      // client could hold many idle sockets before Node's HTTP timeouts apply.
      // Bound the wait; a real client sends its ClientHello / request line at once.
      const preReadTimer = setTimeout(() => {
        socket.destroy();
      }, PRE_READ_TIMEOUT_MS);
      preReadTimer.unref?.();
      socket.once('error', () => {
        clearTimeout(preReadTimer);
        socket.destroy();
      });
      socket.once('readable', () => {
        clearTimeout(preReadTimer);
        const buf: Buffer | null = socket.read(1);
        if (!buf || buf.length === 0) {
          socket.destroy();
          return;
        }
        socket.unshift(buf);
        // 0x16 = TLS ClientHello
        const target = buf[0] === 0x16 ? httpServer! : redirectServer!;
        target.emit('connection', socket);
      });
    });

    return new Promise<void>((resolve, reject) => {
      netServer!.on('error', reject);
      netServer!.listen(config.port, bindAddress, () => resolve());
    });
  }

  return new Promise<void>((resolve, reject) => {
    httpServer!.on('error', reject);
    httpServer!.listen(config.port, bindAddress, () => resolve());
  });
}

export async function stopWebServer(): Promise<void> {
  // Close all web client connections
  for (const ws of webClients) {
    try {
      ws.close();
    } catch {
      /* ignore */
    }
  }
  webClients.clear();

  if (wss) {
    wss.close();
    wss = null;
  }

  const closers: Promise<void>[] = [];

  if (netServer) {
    const s = netServer;
    netServer = null;
    closers.push(
      new Promise<void>((r) => {
        s.close(() => r());
      }),
    );
  }

  if (redirectServer) {
    const s = redirectServer;
    redirectServer = null;
    closers.push(
      new Promise<void>((r) => {
        s.close(() => r());
        s.closeAllConnections();
      }),
    );
  }

  if (httpServer) {
    const s = httpServer;
    httpServer = null;
    closers.push(
      new Promise<void>((r) => {
        s.close(() => r());
        s.closeAllConnections();
      }),
    );
  }

  await Promise.all(closers);
}

/**
 * Create a one-time-use login token for QR code auto-login.
 * The token expires after 5 minutes.
 * Returns the token string, or null if the server isn't running.
 */
export function createLoginToken(): string | null {
  if (!httpServer) return null;
  const now = Date.now();
  // Sweep expired-but-never-presented tokens before issuing. loginTokens is
  // otherwise only cleaned when a token is consumed/presented, so an abandoned
  // QR token (dialog opened but never scanned, or regenerated) would linger
  // indefinitely. The map stays tiny, so an unconditional sweep is fine.
  pruneExpiredTokens(loginTokens, now);
  const token = crypto.randomUUID();
  loginTokens.set(token, now + LOGIN_TOKEN_LIFETIME_MS);
  return token;
}

export async function restartWebServer(config: WebServerConfig): Promise<void> {
  // If a restart is already in-flight, update its target config and return
  // the same promise — this coalesces rapid successive restarts.
  if (pendingRestart) {
    pendingRestart.config = config;
    return pendingRestart.promise;
  }

  // Assign pendingRestart BEFORE calling doRestart so the async function
  // can read it synchronously on its first iteration.
  const entry: { promise: Promise<void>; config: WebServerConfig } = {
    promise: null as unknown as Promise<void>,
    config,
  };
  pendingRestart = entry;

  entry.promise = (async () => {
    try {
      // Loop until the queued config is stable (no new config arrived during restart)
      while (true) {
        const target = entry.config;
        await stopWebServer();
        await startWebServer(target);
        // If config hasn't changed while we were restarting, we're done
        if (entry.config === target) break;
      }
    } finally {
      pendingRestart = null;
    }
  })();

  return entry.promise;
}
