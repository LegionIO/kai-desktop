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
  /**
   * True when the feature is available but UNPROVEN on this OS — wired up so
   * users can try it and give feedback, but not yet validated on real hardware.
   * The UI should surface an "Experimental" label + the `reason` string.
   */
  experimental?: boolean;
  /** Human-readable explanation shown in the UI: why it's unavailable
   *  (`supported:false`) or why it's flagged (`experimental:true`). */
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

/**
 * A feature that's available for the user to try on this OS but NOT yet
 * validated on real hardware. Surfaced with an "Experimental" label so users
 * understand it's unproven and their use is the feedback signal. Kept
 * `supported: true` so the feature is selectable/live rather than disabled.
 */
const EXPERIMENTAL_ON = (feature: string, os: string): CapabilityResult => ({
  supported: true,
  experimental: true,
  reason: `${feature} is experimental on ${os} — please report how it behaves.`,
});

/**
 * A feature that genuinely does NOT work on this OS yet (no implementation
 * exists), as opposed to EXPERIMENTAL_ON (works but unvalidated). The UI shows a
 * "Coming soon" state and disables the control, rather than offering an
 * experimental toggle that would silently no-op.
 */
const COMING_SOON = (feature: string, os: string): CapabilityResult => ({
  supported: false,
  reason: `${feature} is not available on ${os} yet.`,
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
        // Local computer use genuinely runs (nut-js) on this OS → experimental.
        computerUseLocal: EXPERIMENTAL_ON('Local computer use', 'Windows'),
        computerUseBrowser: supported(),
        dictationCapture: supported(),
        // Dictation-anywhere + dock badges have NO Windows implementation yet
        // (native AX insertion / taskbar badges are macOS-only). Offering them as
        // "experimental" would present a toggle that silently no-ops, so they
        // stay "coming soon" until the native path is built.
        dictationAnywhere: COMING_SOON('Dictation anywhere', 'Windows'),
        dockIcon: COMING_SOON('Taskbar icon badges', 'Windows'),
      };
    case 'linux':
      return {
        computerUseLocal: EXPERIMENTAL_ON('Local computer use', 'Linux'),
        computerUseBrowser: supported(),
        dictationCapture: supported(),
        dictationAnywhere: COMING_SOON('Dictation anywhere', 'Linux'),
        dockIcon: COMING_SOON('Dock icon badges', 'Linux'),
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
