import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import type { Session, WebContents, WebPreferences } from 'electron';
import type {
  BrowserBounds,
  BrowserDataClearOptions,
  BrowserDataScope,
  BrowserSearchProvider,
} from '../../shared/browser.js';
import { MAX_BROWSER_URL_CHARS } from './metadata.js';

const MAX_VIEW_DIMENSION = 16_384;

function brandSlug(): string {
  return typeof __BRAND_APP_SLUG === 'string' && __BRAND_APP_SLUG ? __BRAND_APP_SLUG : 'kai';
}

export function browserScopeKey(scope: BrowserDataScope, conversationId?: string): string {
  if (scope === 'global') return 'global';
  if (!conversationId) throw new Error('A conversation id is required for conversation-scoped browser data.');
  const digest = createHash('sha256').update(conversationId).digest('hex').slice(0, 24);
  return `conversation-${digest}`;
}

export function browserPartition(scope: BrowserDataScope, conversationId?: string): string {
  return browserPartitionForScopeKey(browserScopeKey(scope, conversationId));
}

export function browserPartitionForScopeKey(scopeKey: string): string {
  if (!isBrowserScopeKey(scopeKey)) throw new Error('Invalid browser profile key.');
  return `persist:${brandSlug()}-browser-${scopeKey}`;
}

/** Ephemeral Chromium network context used only to resolve the host operating
 * system's current direct/PAC/proxy route. Browser data sessions are pointed at
 * Kai's validating proxy, so asking one of them would recursively resolve back
 * to the local guard instead of preserving the upstream system route. */
export function browserSystemProxyResolverPartition(): string {
  return `${brandSlug()}-browser-system-proxy-resolver`;
}

/** True only for Chromium partition directories owned by the in-app Browser. */
export function isInAppBrowserPartitionName(value: string): boolean {
  const normalized = value.toLowerCase();
  const prefix = `${brandSlug()}-browser-`.toLowerCase();
  return normalized.startsWith(prefix) && isBrowserScopeKey(normalized.slice(prefix.length));
}

/** Match the Electron partition identifier used at runtime as well as its
 * on-disk directory name. Plugin APIs must never attach to these reserved
 * profiles because they contain the user's authenticated in-app sessions. */
export function isInAppBrowserPartition(value: string): boolean {
  const normalized = value.toLowerCase();
  const name = normalized.startsWith('persist:') ? normalized.slice('persist:'.length) : normalized;
  return isInAppBrowserPartitionName(name);
}

export function isBrowserScopeKey(value: string): boolean {
  return /^(global|conversation-[a-f0-9]{24})$/.test(value);
}

export function resolveBrowserDataScopeKeys(options: BrowserDataClearOptions, currentScopeKey?: string): string[] {
  const keys = new Set<string>();
  for (const scopeKey of options.scopeKeys ?? []) {
    if (!isBrowserScopeKey(scopeKey)) throw new Error('Invalid browser profile key.');
    keys.add(scopeKey);
  }
  if (options.includeGlobal) keys.add('global');
  if (options.includeConversation && options.conversationId) {
    keys.add(browserScopeKey('conversation', options.conversationId));
  }
  if (keys.size === 0 && currentScopeKey) keys.add(currentScopeKey);
  return [...keys];
}

export function validatePluginPartitionClearNames(values: string[] | undefined): string[] {
  const result: string[] = [];
  for (const partitionName of values ?? []) {
    // Keep this aligned with partitions:delete: plugin partition directories
    // may contain spaces or Unicode, but must remain a single direct child of
    // Chromium's Partitions directory.
    if (
      typeof partitionName !== 'string' ||
      partitionName === '' ||
      partitionName === '.' ||
      partitionName === '..' ||
      partitionName.includes('..') ||
      partitionName.includes('/') ||
      partitionName.includes('\\') ||
      partitionName.includes('\0')
    ) {
      throw new Error('Invalid plugin browser partition name.');
    }
    if (isInAppBrowserPartition(partitionName)) {
      throw new Error('In-app Browser profiles cannot be cleared through plugin partition management.');
    }
    result.push(partitionName);
  }
  return result;
}

export const BROWSER_PRIVATE_NETWORK_GUARD_ARGUMENT = '--kai-browser-private-network-guard';
export const BROWSER_NATIVE_UI_GUARD_ARGUMENT = '--kai-browser-native-ui-guard';
export const BROWSER_NATIVE_UI_GUARD_TOKEN_ARGUMENT_PREFIX = '--kai-browser-native-ui-token=';

export function browserWebPreferences(
  partition: string,
  preload?: string,
  activatePrivateNetworkGuard = false,
  activateNativeUiGuard = false,
  nativeUiGuardToken?: string,
): WebPreferences {
  const additionalArguments: string[] = [];
  if (activatePrivateNetworkGuard) additionalArguments.push(BROWSER_PRIVATE_NETWORK_GUARD_ARGUMENT);
  if (activateNativeUiGuard) additionalArguments.push(BROWSER_NATIVE_UI_GUARD_ARGUMENT);
  if (nativeUiGuardToken) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(nativeUiGuardToken)) {
      throw new Error('Invalid Browser native-UI guard token.');
    }
    additionalArguments.push(`${BROWSER_NATIVE_UI_GUARD_TOKEN_ARGUMENT_PREFIX}${nativeUiGuardToken.toLowerCase()}`);
  }
  return {
    partition,
    ...(preload ? { preload } : {}),
    // Electron exposes these only to the sandboxed preload's process.argv. Pin
    // the list instead of inheriting popup-supplied preferences so a restricted
    // renderer can activate its WebRTC membrane before the first page script.
    additionalArguments,
    nodeIntegration: false,
    nodeIntegrationInSubFrames: false,
    nodeIntegrationInWorker: false,
    contextIsolation: true,
    sandbox: true,
    webviewTag: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
    experimentalFeatures: false,
    // HTML fullscreen stays confined to the Browser page surface instead of
    // resizing Kai's native window. BrowserManager additionally reclaims an
    // assistant-controlled renderer if Chromium's UA controls enter fullscreen.
    disableHtmlFullscreenWindowResize: true,
    // Keep ordinary idle pages throttleable. BrowserManager disables
    // throttling only for the lifetime of an active assistant operation, then
    // restores it. Permanently disabling it on one child WebContents also keeps
    // the entire containing BrowserWindow drawing while minimized.
    backgroundThrottling: true,
    spellcheck: true,
  };
}

export function hardenRemoteWebPreferences(
  webPreferences: Record<string, unknown>,
  params?: Record<string, unknown>,
): void {
  delete webPreferences.preload;
  webPreferences.nodeIntegration = false;
  webPreferences.nodeIntegrationInSubFrames = false;
  webPreferences.nodeIntegrationInWorker = false;
  webPreferences.contextIsolation = true;
  webPreferences.sandbox = true;
  webPreferences.webviewTag = false;
  webPreferences.webSecurity = true;
  webPreferences.allowRunningInsecureContent = false;
  webPreferences.experimentalFeatures = false;
  webPreferences.disableHtmlFullscreenWindowResize = true;
  delete webPreferences.enableBlinkFeatures;
  if (params) {
    delete params.nodeintegration;
    delete params.nodeintegrationinsubframes;
    delete params.preload;
    delete params.webpreferences;
    delete params.enableblinkfeatures;
  }
}

/** A Chromium UA that intentionally omits Electron and Kai product tokens. */
export function getChromeUserAgent(chromeVersion = process.versions.chrome ?? '132.0.0.0'): string {
  const platform =
    process.platform === 'darwin'
      ? 'Macintosh; Intel Mac OS X 10_15_7'
      : process.platform === 'win32'
        ? 'Windows NT 10.0; Win64; x64'
        : 'X11; Linux x86_64';
  return `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`;
}

export function configureBrowserSession(target: Session): void {
  target.setUserAgent(getChromeUserAgent());
}

export function configureBrowserWebContents(
  target: Pick<WebContents, 'setWebRTCIPHandlingPolicy'>,
  allowPrivateNetwork = false,
): void {
  // webRequest does not observe WebRTC ICE traffic. When AI private-network
  // access is disabled, force WebRTC through the proxy-aware path instead of
  // allowing direct UDP/STUN/TURN sockets to bypass request policy.
  target.setWebRTCIPHandlingPolicy(allowPrivateNetwork ? 'default' : 'disable_non_proxied_udp');
}

/** Register the password/activity sensor for every frame in the isolated
 * browser session without enabling Node integration in remote subframes. */
export function registerBrowserFramePreload(target: Session, filePath: string): void {
  const id = `${brandSlug()}-browser-frame-sensor`;
  const registered = target.getPreloadScripts().some((script) => script.id === id);
  if (!registered) target.registerPreloadScript({ id, type: 'frame', filePath });
}

/** Requests with a known tab use that tab's policy. Worker/background traffic
 * has no reliable WebContents id, so the manager supplies the strictest active
 * or persistently recorded worker provenance for the profile. */
export function shouldApplyAiRequestPolicy(
  associatedTabRestricted: boolean | undefined,
  unattributedScopeRestricted = true,
): boolean {
  return associatedTabRestricted ?? unattributedScopeRestricted;
}

export function normalizeOmniboxInput(input: string, provider: BrowserSearchProvider): string {
  const value = input.trim();
  if (value.length > MAX_BROWSER_URL_CHARS) throw new Error('Browser addresses and searches are limited to 32 KB.');
  if (!value) return 'about:blank';
  if (/^(about|data|file|https?):/i.test(value)) return value;

  // localhost, IPv4/IPv6 literals, and dotted hostnames are navigation targets.
  if (/^(localhost|\[[0-9a-f:]+\]|\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?(?:[/?#]|$)/i.test(value)) {
    return `http://${value}`;
  }
  if (/^[\w-]+(?:\.[\w-]+)+(?:\:\d+)?(?:[/?#][^\s]*)?$/i.test(value)) return `https://${value}`;

  const query = encodeURIComponent(value);
  switch (provider) {
    case 'google':
      return `https://www.google.com/search?q=${query}`;
    case 'bing':
      return `https://www.bing.com/search?q=${query}`;
    default:
      return `https://duckduckgo.com/?q=${query}`;
  }
}

function isPrivateIpv4(host: string): boolean {
  const octets = host.split('.').map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  const [a, b] = octets;
  return (
    a === 0 ||
    a === 10 ||
    (a === 100 && b >= 64 && b <= 127) ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && ((b === 0 && (octets[2] === 0 || octets[2] === 2)) || b === 168)) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && octets[2] === 100))) ||
    (a === 203 && b === 0 && octets[2] === 113) ||
    a >= 224
  );
}

function parseIpv6(host: string): number[] | null {
  const value = host.toLowerCase().split('%')[0];
  const halves = value.split('::');
  if (halves.length > 2) return null;
  const parseHalf = (half: string): number[] | null => {
    if (!half) return [];
    const result: number[] = [];
    for (const part of half.split(':')) {
      if (part.includes('.')) {
        if (!isIP(part) || isIP(part) !== 4) return null;
        const octets = part.split('.').map(Number);
        result.push((octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]);
      } else {
        if (!/^[a-f0-9]{1,4}$/.test(part)) return null;
        result.push(Number.parseInt(part, 16));
      }
    }
    return result;
  };
  const left = parseHalf(halves[0]);
  const right = parseHalf(halves[1] ?? '');
  if (!left || !right) return null;
  if (halves.length === 1) return left.length === 8 ? left : null;
  const missing = 8 - left.length - right.length;
  if (missing < 1) return null;
  return [...left, ...Array.from({ length: missing }, () => 0), ...right];
}

function isPrivateIpv6(host: string): boolean {
  const parts = parseIpv6(host);
  if (!parts) return false;
  if (parts.every((part) => part === 0)) return true;
  if (parts.slice(0, 7).every((part) => part === 0) && parts[7] === 1) return true;
  // IPv4-compatible addresses are deprecated and depend on local transition
  // infrastructure. Unlike IPv4-mapped addresses, they do not have a stable
  // public routing interpretation, so fail closed for the whole ::/96 block.
  if (parts.slice(0, 6).every((part) => part === 0)) return true;
  // Both the well-known and local-use NAT64 prefixes are meaningful only in
  // the surrounding network. Treating either as a public literal would let an
  // AI bypass DNS validation and reach locally translated IPv4 destinations.
  if (parts[0] === 0x0064 && parts[1] === 0xff9b && (parts[2] === 1 || parts.slice(2, 6).every((part) => part === 0)))
    return true;
  if (parts[0] === 0x0100 && parts.slice(1, 4).every((part) => part === 0)) return true; // Discard-only 100::/64.
  if ((parts[0] & 0xfe00) === 0xfc00) return true; // Unique-local fc00::/7.
  if ((parts[0] & 0xffc0) === 0xfe80) return true; // Link-local fe80::/10.
  if ((parts[0] & 0xffc0) === 0xfec0) return true; // Deprecated site-local fec0::/10.
  if ((parts[0] & 0xff00) === 0xff00) return true; // Multicast ff00::/8.
  if (parts[0] === 0x2001 && parts[1] < 0x0200) return true; // IETF protocol assignments 2001::/23.
  if (parts[0] === 0x2001 && parts[1] === 0x0db8) return true; // Documentation range.
  if (parts[0] === 0x2002) return true; // Deprecated 6to4 transition space.
  if ((parts[0] & 0xfff0) === 0x3ff0) return true; // Documentation range 3fff::/20.
  if (parts[0] === 0x5f00) return true; // Segment-routing SIDs 5f00::/16.
  const mapped = parts.slice(0, 5).every((part) => part === 0) && parts[5] === 0xffff;
  if (mapped) {
    const ipv4 = `${parts[6] >> 8}.${parts[6] & 0xff}.${parts[7] >> 8}.${parts[7] & 0xff}`;
    return isPrivateIpv4(ipv4);
  }
  return false;
}

export function isPrivateResolvedAddress(address: string): boolean {
  const host = address
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  const version = isIP(host);
  if (version === 4) return isPrivateIpv4(host);
  if (version === 6) return isPrivateIpv6(host);
  // Electron's resolver contract should only return IP literals. Treat an
  // unexpected value as unverified instead of letting malformed output bypass
  // the private-network gate.
  return true;
}

export function isPrivateNetworkUrl(rawUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  const host = parsed.hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
  if (host === 'localhost' || host.endsWith('.local')) return true;
  if (isIP(host) === 4) return isPrivateIpv4(host);
  if (isIP(host) === 6) return isPrivateIpv6(host);
  return false;
}

type BrowserHostResolution = { addresses: string[]; errorCode: number };
type BrowserHostResolver = (hostname: string) => Promise<BrowserHostResolution>;

/**
 * Validate an AI-initiated top-level navigation before Chromium receives it.
 * Direct private/localhost targets are rejected first. Non-local hostnames may
 * legitimately use split DNS, so their fresh resolution verifies availability
 * but does not reclassify the authenticated HTTPS origin as a private target.
 */
export async function assertAiNavigationAllowed(
  rawUrl: string,
  allowPrivateNetwork: boolean,
  resolveHost: BrowserHostResolver,
): Promise<void> {
  if (rawUrl === 'about:blank') return;

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('AI navigation requires a valid HTTP(S) URL or about:blank.');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('AI navigation is limited to HTTP(S) pages and about:blank.');
  }
  if (allowPrivateNetwork) return;
  if (isPrivateNetworkUrl(rawUrl)) {
    throw new Error('AI navigation to private-network addresses is disabled in Browser Settings.');
  }

  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (isIP(hostname) !== 0) return;
  // This preflight provides an early, useful failure before Chromium starts a
  // navigation. BrowserValidatingProxy independently resolves and connects to
  // an exact IP at dispatch time. Hostname HTTP remains disallowed because it
  // has no authenticated origin; an HTTPS certificate keeps a public hostname
  // meaningful when enterprise split DNS intentionally resolves it privately.
  if (parsed.protocol !== 'https:') {
    throw new Error(
      'AI navigation to hostname-based HTTP pages is blocked while private-network access is disabled. Use HTTPS or enable private-network access in Browser Settings.',
    );
  }

  const resolution = await resolveHost(hostname);
  if (resolution.errorCode !== 0 || resolution.addresses.length === 0) {
    throw new Error('AI navigation was blocked because DNS resolution did not return a verified destination.');
  }
}

/** WebSocket handshakes carry the same private-network risk as HTTP fetches,
 * but the navigation validator intentionally accepts only HTTP(S) URLs. Map
 * their schemes to the equivalent handshake URL before applying that policy. */
export function aiRequestPolicyUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol === 'ws:') parsed.protocol = 'http:';
    else if (parsed.protocol === 'wss:') parsed.protocol = 'https:';
    return parsed.toString();
  } catch {
    return rawUrl;
  }
}

export function validateBrowserBounds(
  bounds: BrowserBounds,
  windowBounds: { width: number; height: number },
): BrowserBounds {
  const values = [bounds.x, bounds.y, bounds.width, bounds.height];
  if (!values.every(Number.isFinite)) throw new Error('Browser bounds must contain finite numbers.');
  const normalized = {
    x: Math.max(0, Math.round(bounds.x)),
    y: Math.max(0, Math.round(bounds.y)),
    width: Math.max(0, Math.round(bounds.width)),
    height: Math.max(0, Math.round(bounds.height)),
  };
  if (normalized.width === 0 || normalized.height === 0) {
    throw new Error('Browser bounds must have a positive width and height.');
  }
  if (
    normalized.width > Math.min(MAX_VIEW_DIMENSION, windowBounds.width) ||
    normalized.height > Math.min(MAX_VIEW_DIMENSION, windowBounds.height) ||
    normalized.x + normalized.width > windowBounds.width + 1 ||
    normalized.y + normalized.height > windowBounds.height + 1
  ) {
    throw new Error('Browser bounds must fit inside the application window.');
  }
  return normalized;
}

/** Renderer DOM rectangles are expressed in CSS pixels, while
 * WebContentsView.setBounds expects window device-independent pixels. Electron
 * scales the renderer's CSS coordinate space when its zoom factor changes, so
 * convert at the trusted IPC boundary before validating against the window. */
export function scaleBrowserBoundsForZoom(bounds: BrowserBounds | null, zoomFactor: number): BrowserBounds | null {
  if (bounds === null) return null;
  if (!Number.isFinite(zoomFactor) || zoomFactor <= 0) throw new Error('Browser zoom factor must be positive.');
  return {
    x: bounds.x * zoomFactor,
    y: bounds.y * zoomFactor,
    width: bounds.width * zoomFactor,
    height: bounds.height * zoomFactor,
  };
}

/** DOM target coordinates are CSS pixels, while WebContents.sendInputEvent()
 * consumes view-relative device-independent pixels. Page zoom changes that
 * relationship, so automation must convert immediately before dispatch while
 * keeping the unscaled point for the in-page cursor overlay. */
export function scaleBrowserPointForZoom(
  point: { x: number; y: number },
  zoomFactor: number,
): { x: number; y: number } {
  if (!Number.isFinite(zoomFactor) || zoomFactor <= 0) throw new Error('Browser zoom factor must be positive.');
  return { x: point.x * zoomFactor, y: point.y * zoomFactor };
}

/** Focus the nearest focusable element at a CSS-pixel target without
 * synthesizing pointer input. Mouse down/up would activate links, buttons, and
 * page handlers, which violates the side-effect-free semantics of `focus`. */
export function browserFocusTargetScript(point: { x: number; y: number }): string {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) throw new Error('Focus coordinates must be finite.');
  return `(() => {
    const hit = document.elementFromPoint(${JSON.stringify(point.x)}, ${JSON.stringify(point.y)});
    const target = hit?.closest?.('input:not([disabled]),textarea:not([disabled]),select:not([disabled]),button:not([disabled]),a[href],summary,[contenteditable="true"],[tabindex]:not([tabindex="-1"])');
    if (!target || typeof target.focus !== 'function') return false;
    target.focus({ preventScroll: true });
    return document.activeElement === target;
  })()`;
}

/** Copy cookies without ever serializing values to logs or renderer IPC. */
export async function copySessionCookies(source: Session, destination: Session): Promise<number> {
  const cookies = await source.cookies.get({});
  let copied = 0;
  for (const cookie of cookies) {
    const protocol = cookie.secure ? 'https:' : 'http:';
    const domain = cookie.domain?.replace(/^\./, '') || 'localhost';
    try {
      await destination.cookies.set({
        url: `${protocol}//${domain}${cookie.path || '/'}`,
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain,
        path: cookie.path,
        secure: cookie.secure,
        httpOnly: cookie.httpOnly,
        sameSite: cookie.sameSite,
        expirationDate: cookie.session ? undefined : cookie.expirationDate,
      });
      copied++;
    } catch {
      // A malformed/expired source cookie should not block the remaining copy.
    }
  }
  return copied;
}
