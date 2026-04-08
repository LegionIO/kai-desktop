/**
 * Central branding configuration for white-labeling.
 *
 * Every user-visible name, ID, slug, and string the app uses is defined here.
 * To rebrand the app, change the values below and rebuild.
 *
 * Values are injected at **build time** via Vite `define()` as compile-time
 * constants (e.g. `__BRAND_PRODUCT_NAME`). They are also used by the
 * `scripts/generate-builder-config.ts` pre-build step to template
 * `electron-builder.yml`.
 *
 * NOTE: Also update `name`, `productName`, and `description` in package.json
 * to match — those fields are not auto-generated from this config.
 */
export const branding = {
  // ── Identity ──────────────────────────────────────────────────────────
  /** Window title, macOS menu bar, dock name, and general display name. */
  productName: 'Kai',
  /** Lowercase slug used for the config directory (~/.kai/), localStorage keys, temp dirs, etc. */
  appSlug: 'kai',
  /** macOS bundle identifier / Windows app user model ID. */
  appId: 'com.kai.desktop',
  /** Executable / binary name on disk. */
  executableName: 'Kai',
  /** Short wordmark shown in the sidebar title bar (typically uppercased). */
  wordmark: 'KAI',
  /** One-line description for package.json and store listings. */
  description: 'Kai - Local AI Assistant',

  // ── User-facing strings ───────────────────────────────────────────────
  /** Name used in the default system prompt: "You are {assistantName}, a powerful…" */
  assistantName: 'Kai',
  /** Placeholder inside the message composer. */
  composerPlaceholder: 'Message Kai...',
  /** Text shown in the file drop zone overlay. */
  dropZoneText: 'Drop files for Kai',
  /** Heading shown in the error boundary fallback UI. */
  errorBoundaryText: 'Kai encountered an error',

  // ── Protocol & machine IDs ────────────────────────────────────────────
  /** Custom Electron protocol scheme for serving generated media (e.g. "kai-media://"). */
  mediaProtocol: 'kai-media',
  /** MCP client name sent during MCP handshake. */
  mcpClientName: 'kai',
  /**
   * HTTP User-Agent template.
   * Supported variables include:
   * {productName}, {productToken}, {assistantName}, {appSlug}, {appId}, {executableName},
   * {version}, {platform}, {osName}, {osVersion}, {arch},
   * {electronVersion}, {chromeVersion}, {nodeVersion}, {locale}
   */
  userAgent: '{productToken}/{version} ({osName} {osVersion}; {arch}) Electron/{electronVersion}',
  /** Agent identifier sent to providers and local services. */
  agentId: 'kai',
  /** Mastra memory resource ID. */
  resourceId: 'kai-local-user',
  /** `iss` claim in any locally issued JWTs. */
  jwtIssuer: 'kai',

  // ── Build / packaging ─────────────────────────────────────────────────
  /** Prefix for installer artifact filenames (e.g. "Kai-1.0.0-arm64.dmg"). */
  artifactPrefix: 'Kai',
  /** macOS app category. */
  macCategory: 'public.app-category.developer-tools',

  // ── Theme / visual identity ──────────────────────────────────────────
  /** OKLCh hue angle (0-360) used for the brand accent across the UI. */
  themeHue: '85',
  /** Fallback light-mode accent for contexts that need a hex color. */
  themeAccentLight: '#b8960f',
  /** Fallback dark-mode accent for contexts that need a hex color. */
  themeAccentDark: '#e8c94a',
  /** Empty-thread background treatment. */
  themeBackground: 'constellation',
  /** Whether to use the animated gradient wordmark text. */
  themeGradientText: 'true',

  // ── macOS permission-usage strings (shown in system dialogs) ──────────
  microphoneUsage:
    'Kai uses the microphone for voice dictation (speech-to-text).',
  appleEventsUsage:
    'Kai uses Apple Events to activate apps and inspect focused windows during local Mac computer control.',
  screenCaptureUsage:
    'Kai captures your screen to enable local Mac computer control and allow the AI to see what\'s on your display.',

  // ── Required Plugins ──────────────────────────────────────────────────
  /** Plugins that must be installed for this branded deployment. */
  requiredPlugins: [] as ReadonlyArray<string>,
} as const;

export type Branding = typeof branding;
