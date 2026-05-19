/**
 * Minimal `window.app` IPC bridge stub for component tests.
 *
 * The renderer providers (`ConfigProvider`, `RuntimeProvider`,
 * `AttachmentProvider`) read state through `window.app.*` on mount.
 * When tests render a component via `renderWithProviders` we don't
 * want those provider effects to crash because the IPC bridge isn't
 * installed. This module fills in just enough no-op methods to let
 * the providers boot, plus a small set of overrides callers can pass
 * to customise behaviour for a specific test.
 *
 * Usage:
 *
 *   import { installAppBridgeStub } from '../../../../test-utils/app-bridge-stub';
 *   beforeEach(() => { installAppBridgeStub(); });
 *   afterEach(() => { uninstallAppBridgeStub(); });
 *
 * Pass overrides to seed specific responses:
 *
 *   installAppBridgeStub({
 *     config: { get: async () => ({ ui: { theme: 'dark' } }) },
 *   });
 */

type UnsubFn = () => void;

interface AppLike {
  [key: string]: unknown;
}

let prevApp: unknown = undefined;
let installed = false;

function noopUnsub(): UnsubFn {
  return () => undefined;
}

/**
 * Construct a baseline `window.app` that satisfies the IPC surface area
 * the renderer providers exercise on mount. Anything not listed here
 * falls back to undefined and will throw if a component touches it —
 * which is exactly the signal we want for over-coupled tests.
 */
function buildDefaultStub(): AppLike {
  return {
    config: {
      get: async () => ({}),
      set: async (_path: string, value: unknown) => value,
      onChanged: (_cb: (cfg: unknown) => void): UnsubFn => noopUnsub(),
    },
    agent: {
      onStreamEvent: (_cb: (event: unknown) => void): UnsubFn => noopUnsub(),
      stream: async () => undefined,
      cancelStream: async () => undefined,
      sendSubAgentMessage: async () => ({ ok: true }),
      stopSubAgent: async () => ({ ok: true }),
      generateTitle: async () => ({ title: null }),
      approveToolCall: async () => ({ ok: true }),
      rejectToolCall: async () => ({ ok: true }),
      dismissToolCall: async () => ({ ok: true }),
      answerToolQuestion: async () => ({ ok: true }),
      listSubAgents: async () => ({ ids: [] }),
      getAvailableRuntimes: async () => [],
      getActiveRuntime: async () => 'mastra',
    },
    conversations: {
      list: async () => [],
      get: async () => null,
      put: async (c: unknown) => c,
      delete: async () => ({ ok: true }),
      clear: async () => ({ ok: true }),
      getActiveId: async () => null,
      setActiveId: async () => undefined,
      onChanged: (_cb: (s: unknown) => void): UnsubFn => noopUnsub(),
    },
    platform: {
      homedir: async () => '/home/test',
    },
    skills: {
      list: async () => [],
    },
    tasks: {
      list: async () => [],
      listAll: async () => [],
      onChanged: (_cb: (t: unknown) => void): UnsubFn => noopUnsub(),
      onStreamEvent: (_cb: (e: unknown) => void): UnsubFn => noopUnsub(),
      onTerminalData: (_cb: (e: unknown) => void): UnsubFn => noopUnsub(),
      onTerminalExit: (_cb: (e: unknown) => void): UnsubFn => noopUnsub(),
    },
    agents: {
      list: async () => [],
      onChanged: (_cb: (a: unknown) => void): UnsubFn => noopUnsub(),
    },
    plugins: {
      getUIState: async () => ({}),
      list: async () => [],
      onUIStateChanged: (_cb: (s: unknown) => void): UnsubFn => noopUnsub(),
      onEvent: (_cb: (e: unknown) => void): UnsubFn => noopUnsub(),
      onUpdatesAvailable: (_cb: (d: unknown) => void): UnsubFn => noopUnsub(),
      onNavigationRequest: (_cb: (r: unknown) => void): UnsubFn => noopUnsub(),
      onNavigateDirect: (_cb: (d: unknown) => void): UnsubFn => noopUnsub(),
      onModalCallback: (_cb: (d: unknown) => void): UnsubFn => noopUnsub(),
    },
    computerUse: {
      listSessions: async () => [],
      onEvent: (_cb: (e: unknown) => void): UnsubFn => noopUnsub(),
      onOverlayState: (_cb: (s: unknown) => void): UnsubFn => noopUnsub(),
      onFocusThread: (_cb: () => void): UnsubFn => noopUnsub(),
    },
    realtime: {
      getStatus: async () => ({ status: 'idle' }),
      onEvent: (_cb: (e: unknown) => void): UnsubFn => noopUnsub(),
    },
    dictation: {
      getState: async () => ({ state: 'idle', elapsed: 0 }),
      getTypingMode: async () => 'normal',
      onStateChange: (_cb: (s: unknown) => void): UnsubFn => noopUnsub(),
      onLevel: (_cb: (n: number) => void): UnsubFn => noopUnsub(),
      onPartial: (_cb: (s: string) => void): UnsubFn => noopUnsub(),
      onFinal: (_cb: (s: string) => void): UnsubFn => noopUnsub(),
      onError: (_cb: (s: string) => void): UnsubFn => noopUnsub(),
      onTypingMode: (_cb: (m: string) => void): UnsubFn => noopUnsub(),
    },
    autoUpdate: {
      onStatus: (_cb: (s: unknown) => void): UnsubFn => noopUnsub(),
    },
    mic: {
      onPartial: (_cb: (s: string) => void): UnsubFn => noopUnsub(),
      onFinal: (_cb: (s: string) => void): UnsubFn => noopUnsub(),
      onSttError: (_cb: (s: string) => void): UnsubFn => noopUnsub(),
    },
    onMenuOpenSettings: (_cb: () => void): UnsubFn => noopUnsub(),
    onFind: (_cb: () => void): UnsubFn => noopUnsub(),
    onModelSwitched: (_cb: (k: string) => void): UnsubFn => noopUnsub(),
    onExecutionModeChanged: (_cb: (m: string) => void): UnsubFn => noopUnsub(),
  };
}

/**
 * Deep-merge `overrides` onto the baseline stub at one level of namespace
 * granularity (config.*, agent.*, etc.). This is intentionally shallow:
 * deeper merging is rarely needed and harder to reason about.
 */
function mergeOverrides(base: AppLike, overrides: Partial<AppLike>): AppLike {
  const out: AppLike = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    const baseValue = base[key];
    if (
      baseValue &&
      typeof baseValue === 'object' &&
      !Array.isArray(baseValue) &&
      value &&
      typeof value === 'object' &&
      !Array.isArray(value)
    ) {
      out[key] = { ...(baseValue as Record<string, unknown>), ...(value as Record<string, unknown>) };
    } else {
      out[key] = value;
    }
  }
  return out;
}

export function installAppBridgeStub(overrides: Partial<AppLike> = {}): void {
  if (installed) {
    // Refresh in place so a second beforeEach gets a clean baseline.
    uninstallAppBridgeStub();
  }
  prevApp = (window as unknown as { app?: unknown }).app;
  const stub = mergeOverrides(buildDefaultStub(), overrides);
  (window as unknown as { app: unknown }).app = stub;
  installed = true;
}

export function uninstallAppBridgeStub(): void {
  if (!installed) return;
  if (prevApp === undefined) {
    delete (window as unknown as { app?: unknown }).app;
  } else {
    (window as unknown as { app: unknown }).app = prevApp;
  }
  installed = false;
  prevApp = undefined;
}
