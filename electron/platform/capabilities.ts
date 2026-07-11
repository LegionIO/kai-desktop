/**
 * High-level platform-capability model (#82, ADR-0005).
 *
 * Distinct from the low-level `NativePlatformAdapter` / `AdapterCapabilities`
 * in `./types.ts` (which describe what a native host CAN do at runtime). This
 * seam answers a coarser product question — "is this user-facing feature
 * available on this OS yet?" — so the UI can render an honest "Coming to
 * Windows" state instead of surfacing a control that silently fails.
 *
 * `getPlatformCapabilities` is PURE: it takes a platform string and returns
 * only booleans + static reason strings. It reads no fs/config/env, so it is
 * trivially testable per injected platform and safe to call from any context.
 */

export type SupportedPlatform = 'darwin' | 'win32' | 'linux';

export type CapabilityResult = {
  supported: boolean;
  /** Human-readable explanation shown in the UI when `supported` is false. */
  reason?: string;
};

export type PlatformCapabilities = {
  /** Local desktop automation (screenshot + synthetic input on the real OS). */
  computerUseLocal: CapabilityResult;
  /** Automation of an isolated in-app browser window (already cross-platform). */
  computerUseBrowser: CapabilityResult;
  /** Speech-to-text capture into the app composer (already cross-platform). */
  dictationCapture: CapabilityResult;
  /** "Dictation anywhere" — inserting transcribed text into the focused
   *  native field of ANY app via accessibility APIs. */
  dictationAnywhere: CapabilityResult;
  /** Dock/taskbar icon badges + ordering (macOS dock today). */
  dockIcon: CapabilityResult;
};

const supported = (): CapabilityResult => ({ supported: true });

const COMING_TO_WINDOWS = (feature: string): CapabilityResult => ({
  supported: false,
  reason: `${feature} is not available on Windows yet.`,
});

const COMING_TO_LINUX = (feature: string): CapabilityResult => ({
  supported: false,
  reason: `${feature} is not available on Linux yet.`,
});

/**
 * Resolve the capability set for a platform. Pure — no side effects, no
 * environment reads, and every call returns fresh objects so a caller mutating
 * one result cannot affect another. Unknown platforms are treated
 * conservatively as the most-restricted (nothing OS-specific supported).
 */
export function getPlatformCapabilities(platform: NodeJS.Platform = process.platform): PlatformCapabilities {
  switch (platform) {
    case 'darwin':
      return {
        computerUseLocal: supported(),
        computerUseBrowser: supported(),
        dictationCapture: supported(),
        dictationAnywhere: supported(),
        dockIcon: supported(),
      };
    case 'win32':
      return {
        computerUseLocal: COMING_TO_WINDOWS('Local computer use'),
        computerUseBrowser: supported(),
        dictationCapture: supported(),
        dictationAnywhere: COMING_TO_WINDOWS('Dictation anywhere'),
        dockIcon: COMING_TO_WINDOWS('Dock icon badges'),
      };
    case 'linux':
      return {
        computerUseLocal: COMING_TO_LINUX('Local computer use'),
        computerUseBrowser: supported(),
        dictationCapture: supported(),
        dictationAnywhere: COMING_TO_LINUX('Dictation anywhere'),
        dockIcon: COMING_TO_LINUX('Dock icon badges'),
      };
    default:
      return {
        computerUseLocal: { supported: false, reason: 'Local computer use is not available on this platform.' },
        computerUseBrowser: supported(),
        dictationCapture: supported(),
        dictationAnywhere: { supported: false, reason: 'Dictation anywhere is not available on this platform.' },
        dockIcon: { supported: false, reason: 'Dock icon badges are not available on this platform.' },
      };
  }
}
