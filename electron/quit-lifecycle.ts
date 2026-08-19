type PreventableUnloadEvent = {
  preventDefault: () => void;
};

/** Once irreversible quit cleanup has completed, no renderer beforeunload hook
 * may keep the half-disposed application alive. Electron treats preventDefault
 * on will-prevent-unload as permission to ignore the page veto and continue. */
export function overrideCommittedQuitUnloadVeto(
  event: PreventableUnloadEvent,
  quitCleanupStarted: boolean,
  browserShutdownComplete: boolean,
): boolean {
  if (!quitCleanupStarted || !browserShutdownComplete) return false;
  event.preventDefault();
  return true;
}
