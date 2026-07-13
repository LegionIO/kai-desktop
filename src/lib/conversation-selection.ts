/**
 * Pure decision for the sidebar's active-conversation sync.
 *
 * "Active conversation" is a single GLOBAL value on the backend, so any client
 * (the GUI, another GUI window, or the `kai` CLI) flipping it broadcasts a
 * change to everyone. A window must NOT blindly adopt that broadcast's active-id
 * as its own selection — otherwise the CLI creating/selecting a chat yanks the
 * GUI user's selection outline onto a different conversation (the reported bug).
 *
 * This encodes when a window SHOULD follow a broadcast `upsert` that carries a
 * new active-id: only when the window has no selection yet (initial load) or the
 * new active-id already matches its own. A cross-client switch to a DIFFERENT
 * conversation leaves the window's selection put (the list still refreshes to
 * surface the new chat elsewhere).
 */
export function shouldAdoptBroadcastActiveId(
  /** This window's current selection (null when nothing is selected yet). */
  mySelection: string | null,
  /** The active-id carried by the broadcast (the new global active). */
  broadcastActiveId: string | null,
): boolean {
  if (broadcastActiveId == null) return false; // no active to adopt
  // Adopt only on first selection, or when it's already ours (idempotent refresh).
  return mySelection == null || mySelection === broadcastActiveId;
}
