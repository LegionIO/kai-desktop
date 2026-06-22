import type { ComputerDisplayLayout } from '../../shared/computer-use.js';

export type PlatformKind = 'darwin' | 'win32' | 'linux' | 'fallback';

export type Bounds = { x: number; y: number; width: number; height: number };

export type ActiveWindowInfo = {
  appName: string;
  windowTitle: string;
  /** macOS bundle identifier, Windows executable path, or Linux WM_CLASS. */
  ownerId: string | null;
  pid: number | null;
  bounds: Bounds | null;
  /** Browser tab URL when detectable (Chrome/Safari/Firefox via per-OS hooks). */
  url?: string | null;
  /** Native window handle: macOS CGWindowID, Windows HWND, X11 window id. */
  windowId?: string | null;
};

export type TextFieldSnapshot = {
  value: string;
  selectionStart: number;
  selectionEnd: number;
  /** Stable identifier for the focused element so callers can detect focus drift. */
  elementSignature: string;
  role?: string | null;
};

export type UiNode = {
  role: string;
  name?: string | null;
  value?: string | null;
  bounds?: Bounds | null;
  children?: UiNode[];
};

export type FocusSnapshot = {
  appName: string;
  ownerId: string | null;
  pid: number | null;
  windowId?: string | null;
  capturedAt: number;
};

export type RunningAppInfo = {
  name: string;
  ownerId: string | null;
  pid: number | null;
};

export type InputMonitorEvent = {
  kind: 'mouse' | 'keyboard' | 'other';
  eventType: string;
  x: number;
  y: number;
  keyCode?: number;
  deltaX?: number;
  deltaY?: number;
  timestampMs: number;
};

export type InputMonitorHandle = { stop: () => void };

export type ScreenshotResult = {
  /** PNG or JPEG bytes. */
  data: Buffer;
  width: number;
  height: number;
  mimeType: 'image/png' | 'image/jpeg';
};

export type PlatformPermissionSection =
  | 'accessibility'
  | 'screen-recording'
  | 'automation'
  | 'input-monitoring'
  | 'helper-available'
  | 'xdotool'
  | 'screenshot-tool'
  | 'at-spi';

export type PlatformPermissionState = {
  section: PlatformPermissionSection;
  granted: boolean;
  /** Human-readable label for the permission row. */
  label: string;
  /** Optional help text shown when not granted. */
  hint?: string;
};

export type PlatformPermissions = {
  platform: PlatformKind;
  helperReady: boolean;
  states: PlatformPermissionState[];
  message?: string;
};

export type AdapterCapabilities = {
  /** Can capture a screenshot of an arbitrary display. */
  screenshotDisplay: boolean;
  /** Can capture a screenshot scoped to a single window. */
  screenshotWindow: boolean;
  /** Can synthesize mouse / keyboard input. */
  input: boolean;
  /** Can read the focused text field's value & selection (AX / UIA / AT-SPI). */
  textIntrospection: boolean;
  /** Can dump a UI element tree for the focused application. */
  uiTree: boolean;
  /** Can observe physical input events for takeover detection. */
  inputMonitor: boolean;
};

/**
 * Cross-platform native-host abstraction.
 *
 * The macOS Swift helper, Windows PowerShell helper, Linux shell helper, and
 * the nut-js fallback all implement this interface. Callers obtain an instance
 * via `getPlatformAdapter()` and feature-detect via `capabilities` rather than
 * branching on `process.platform`.
 *
 * Methods that the active adapter cannot support return `null` (for reads) or
 * throw `HelperUnavailable` (for actions) so the caller can degrade gracefully.
 */
export interface NativePlatformAdapter {
  readonly kind: PlatformKind;
  readonly capabilities: AdapterCapabilities;

  // --- screen ---
  screenshotDisplay(displayIndex?: number): Promise<ScreenshotResult>;
  screenshotWindow(windowId?: string | null): Promise<ScreenshotResult>;
  listDisplays(): Promise<ComputerDisplayLayout | undefined>;

  // --- input ---
  movePointer(x: number, y: number, durationMs?: number): Promise<void>;
  click(x: number, y: number, button?: 'left' | 'right' | 'middle'): Promise<void>;
  doubleClick(x: number, y: number): Promise<void>;
  drag(startX: number, startY: number, endX: number, endY: number, durationMs?: number): Promise<void>;
  scroll(deltaX: number, deltaY: number): Promise<void>;
  typeText(text: string, delayMs?: number): Promise<void>;
  pressKeys(keys: string[], delayMs?: number): Promise<void>;
  getPointerPosition(): Promise<{ x: number; y: number } | null>;

  // --- window / app ---
  getActiveWindow(): Promise<ActiveWindowInfo | null>;
  listRunningApps(): Promise<RunningAppInfo[]>;
  isFullscreen(): Promise<boolean>;
  exitFullscreen(): Promise<void>;
  openApp(name: string): Promise<void>;
  focusApp(name: string): Promise<void>;
  openUrl(url: string): Promise<void>;

  // --- focus ---
  captureFocus(): Promise<FocusSnapshot | null>;
  restoreFocus(snapshot: FocusSnapshot): Promise<void>;

  // --- text introspection ---
  readFocusedTextField(): Promise<TextFieldSnapshot | null>;
  writeFocusedTextField(value: string, selectionStart?: number, selectionEnd?: number): Promise<boolean>;
  getSelectedText(): Promise<string | null>;
  dumpUiTree(maxDepth: number, target?: { pid?: number | null; windowId?: string | null }): Promise<UiNode | null>;

  // --- monitoring ---
  startInputMonitor(onEvent: (event: InputMonitorEvent) => void, onError?: (err: string) => void): InputMonitorHandle;

  // --- permissions ---
  checkPermissions(): Promise<PlatformPermissions>;
  openPermissionSettings(section: PlatformPermissionSection): Promise<void>;
}

export class HelperUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HelperUnavailable';
  }
}
