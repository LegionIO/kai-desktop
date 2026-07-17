/**
 * Presence detection for approval/question routing.
 *
 * When a headless-ish tool gate (`ask_user`, `exit_plan_mode`, generic tool
 * approval) needs an answer, WHERE we surface it depends on whether the user is
 * actually on Kai right now:
 *
 *   - Kai GUI focused, OR the Kai CLI is attached and recently active
 *       → the user is looking at Kai → render the request INLINE (in-thread
 *         card / CLI prompt). Popping a separate window would be noise.
 *   - The user is NOT on Kai (some other app is frontmost, no live CLI)
 *       → they won't see an inline card → POP OUT a dedicated always-on-top
 *         window (and the OS notification) so the run isn't stuck invisibly.
 *
 * The static `ui.approvals.dedicatedWindow` flag still overrides this: `true`
 * forces the window always, and an explicit `false` forces inline-only. When
 * the flag is unset we fall back to this presence-aware decision.
 */
import { app, BrowserWindow } from 'electron';
import { localClients, msSinceActivity } from '../local-bridge/local-clients.js';

/** A CLI client is "present" if it saw traffic within this window. Streaming to
 *  the client refreshes its activity, so an actively-attended `kai` session
 *  stays well under this even between keystrokes. */
export const CLI_PRESENCE_MS = 60_000;

/** True if the Kai GUI currently has OS focus (app-level on macOS, or any of
 *  our BrowserWindows is the focused window on all platforms). */
export function isGuiFocused(): boolean {
  try {
    // macOS: app.isActive() reflects whether Kai is the frontmost app even when
    // focus is on a child/frameless window. Not present on all platforms/typedefs.
    const active = (app as { isActive?: () => boolean }).isActive?.();
    if (active) return true;
  } catch {
    // ignore — fall through to the window check
  }
  try {
    return BrowserWindow.getFocusedWindow() !== null;
  } catch {
    return false;
  }
}

/** True if at least one Kai CLI client is attached and was active recently. */
export function isCliPresent(nowMs: number = Date.now()): boolean {
  try {
    for (const socket of localClients) {
      if (msSinceActivity(socket) < CLI_PRESENCE_MS) return true;
    }
  } catch {
    // ignore
  }
  void nowMs; // msSinceActivity uses Date.now() internally; param kept for tests
  return false;
}

/** The user is on Kai right now (GUI focused OR CLI recently active). */
export function isKaiPresent(): boolean {
  return isGuiFocused() || isCliPresent();
}

/**
 * Decide whether a tool-approval / question gate should open the dedicated
 * pop-out window. `flag` is the resolved `ui.approvals.dedicatedWindow` config
 * value: `true`/`false` force the decision, `undefined` → presence-aware.
 */
export function shouldPopOutApproval(flag: boolean | undefined): boolean {
  if (flag === true) return true;
  if (flag === false) return false;
  // Unset → pop out only when the user is NOT on Kai.
  return !isKaiPresent();
}

/** The dedicated-window mode as authored in config.
 *  - `'auto'`  → presence-aware (pop out only when the user isn't on Kai)
 *  - `'always'`→ always pop out
 *  - `'never'` → never pop out (inline only)
 *  Legacy boolean `dedicatedWindow` maps: `true`→'always', `false`→'auto'
 *  (the old default was inline+notification, which 'auto' subsumes). */
export type ApprovalWindowMode = 'auto' | 'always' | 'never';

/** Normalize the raw config value (new 3-way string or legacy boolean) to a
 *  concrete pop-out decision, applying presence when the mode is 'auto'. */
export function resolveApprovalPopOut(raw: unknown): boolean {
  const mode = normalizeApprovalWindowMode(raw);
  if (mode === 'always') return shouldPopOutApproval(true);
  if (mode === 'never') return shouldPopOutApproval(false);
  return shouldPopOutApproval(undefined);
}

export function normalizeApprovalWindowMode(raw: unknown): ApprovalWindowMode {
  if (raw === 'always' || raw === 'never' || raw === 'auto') return raw;
  if (raw === true) return 'always';
  // undefined / false / anything else → presence-aware default
  return 'auto';
}
