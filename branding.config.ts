/**
 * Central branding configuration for white-labeling.
 *
 * Every user-visible name, ID, slug, and string the app uses is defined here.
 * To rebrand the app, change the values below and rebuild.
 *
 * String values support `{{key}}` tokens that reference other branding keys.
 * For example, `appId: 'com.{{appSlug}}.desktop'` resolves to `'com.kai.desktop'`.
 * Tokens are resolved at the call site (Vite config, builder script) so this
 * file stays pure data with no imports or logic.
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
  /** Short wordmark shown in the sidebar title bar (typically uppercased). */
  wordmark: 'KAI',
  /** macOS bundle identifier / Windows app user model ID. */
  appId: 'com.{{appSlug}}.desktop',
  /** Executable / binary name on disk. */
  executableName: '{{productName}}',
  /** One-line description for package.json and store listings. */
  description: '{{productName}} - Local AI Assistant',

  // ── User-facing strings ───────────────────────────────────────────────
  /** Name used in the default system prompt: "You are {assistantName}, a powerful…" */
  assistantName: '{{productName}}',
  /** Placeholder inside the message composer. */
  composerPlaceholder: 'How can I help you today?',
  /** Text shown in the file drop zone overlay. */
  dropZoneText: 'Drop files for {{productName}}',
  /** Heading shown in the error boundary fallback UI. */
  errorBoundaryText: '{{productName}} encountered an error',
  /** Sidebar section label for the chats/conversations tab. */
  sidebarSectionThreads: 'Chats',
  /** Sidebar section label for the plugins/extensions tab. */
  sidebarSectionPlugins: 'Plugins',

  // ── Protocol & machine IDs ────────────────────────────────────────────
  /** Custom Electron protocol scheme for serving generated media (e.g. "kai-media://"). */
  mediaProtocol: '{{appSlug}}-media',
  /** MCP client name sent during MCP handshake. */
  mcpClientName: '{{appSlug}}',
  /**
   * HTTP User-Agent template.
   * Supported variables include:
   * {productName}, {productToken}, {assistantName}, {appSlug}, {appId}, {executableName},
   * {version}, {platform}, {osName}, {osVersion}, {arch},
   * {electronVersion}, {chromeVersion}, {nodeVersion}, {locale}
   */
  userAgent: '{productToken}/{version} ({osName} {osVersion}; {arch}) Electron/{electronVersion}',
  /** Agent identifier sent to providers and local services. */
  agentId: '{{appSlug}}',
  /** Mastra memory resource ID. */
  resourceId: '{{appSlug}}-local-user',
  /** `iss` claim in any locally issued JWTs. */
  jwtIssuer: '{{appSlug}}',

  // ── Build / packaging ─────────────────────────────────────────────────
  /** Prefix for installer artifact filenames (e.g. "Kai-1.0.0-arm64.dmg"). */
  artifactPrefix: '{{productName}}',
  /** macOS app category. */
  macCategory: 'public.app-category.developer-tools',

  // ── Theme / visual identity ──────────────────────────────────────────
  /** OKLCh hue angle (0-360) used for the brand accent across the UI. */
  themeHue: '85',
  /** Fallback light-mode accent for contexts that need a hex color. */
  themeAccentLight: '#a8860f',
  /** Fallback dark-mode accent for contexts that need a hex color. */
  themeAccentDark: '#e8c94a',
  /** Whether to use the animated gradient wordmark text. */
  themeGradientText: 'true',

  // ── macOS permission-usage strings (shown in system dialogs) ──────────
  microphoneUsage:
    '{{productName}} uses the microphone for voice dictation (speech-to-text).',
  appleEventsUsage:
    '{{productName}} uses Apple Events to activate apps and inspect focused windows during local Mac computer control.',
  screenCaptureUsage:
    '{{productName}} captures your screen to enable local Mac computer control and allow the AI to see what\'s on your display.',
  localNetworkUsage:
    '{{productName}} connects to services on your local network (e.g. MCP servers, APIs, and plugins).',

  // ── Required Plugins ──────────────────────────────────────────────────
  /** Plugins that must be installed for this branded deployment. */
  requiredPlugins: [] as ReadonlyArray<string>,

  // ── Marketplace ───────────────────────────────────────────────────────
  /** Raw JSON URLs for plugin marketplace catalogs. Enterprise URLs listed first win on name collisions. */
  marketplaceUrls: [
    'https://raw.githubusercontent.com/LegionIO/kai-plugin-marketplace/refs/heads/main/marketplace.json',
  ] as ReadonlyArray<string>,
} as const;

export type Branding = typeof branding;
