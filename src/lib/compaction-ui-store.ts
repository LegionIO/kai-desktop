import { useSyncExternalStore } from 'react';

/**
 * Module-level store of conversation ids with an in-flight on-demand `/compact`.
 *
 * Lives OUTSIDE the React tree so it survives ComposerInput unmount/remount — the
 * chat subtree (ArtifactProvider) is keyed by activeConversationId, so switching
 * A→B→A remounts the composer. A component-local `useState` would then be lost and the
 * remounted composer would accept a normal send while the backend still holds the
 * compaction lock, producing a spurious failed turn. Keyed by conversation id so
 * concurrent /compacts in different chats each block only their own chat.
 *
 * Two independent sources are unioned:
 *   - LOCAL: this client's own in-flight /compact calls, REF-COUNTED. Two overlapping
 *     runCompact calls for the same chat (one accepted, one busy-rejected) must not have
 *     the rejected call's clear cancel the accepted call's mark — so we count starts.
 *   - AUTHORITATIVE: the set the MAIN process reports (broadcast + resync). Replaced
 *     WHOLESALE on each resync so a missed `compacting:false` (e.g. dropped while a web
 *     socket was disconnected) self-heals instead of wedging the composer as blocked.
 * A chat is "compacting" iff it is in EITHER set.
 */
const localCounts = new Map<string, number>();
const authoritativeIds = new Set<string>();
const listeners = new Set<() => void>();
let snapshot: ReadonlySet<string> = new Set();
// Monotonic version bumped on EVERY authoritative mutation (per-event add/delete OR a resync
// replace). A resync fetch is async; a per-event `compacting:true/false` that lands DURING that
// fetch would be overwritten by the now-stale wholesale snapshot (leaving the composer wrong
// until the next poll). The resync captures this version before its await and only applies its
// result if no newer authoritative mutation happened meanwhile.
let authoritativeVersion = 0;

function currentUnion(): Set<string> {
  const u = new Set<string>(authoritativeIds);
  for (const id of localCounts.keys()) u.add(id);
  return u;
}

function emit(): void {
  const next = currentUnion();
  // Skip the re-render if the effective set is unchanged (resync replacing an
  // identical authoritative set, or a local ref-count bump that doesn't change membership).
  if (next.size === snapshot.size && [...next].every((id) => snapshot.has(id))) return;
  snapshot = next; // fresh identity so useSyncExternalStore re-renders
  for (const l of listeners) l();
}

/** Mark that THIS client started a /compact for `id` (ref-counted). */
export function markConversationCompacting(id: string): void {
  localCounts.set(id, (localCounts.get(id) ?? 0) + 1);
  emit();
}

/** Balance a prior local mark for `id` (ref-counted; only the last clear drops it). */
export function clearConversationCompacting(id: string): void {
  const n = localCounts.get(id);
  if (n === undefined) return;
  if (n <= 1) localCounts.delete(id);
  else localCounts.set(id, n - 1);
  emit();
}

export function isConversationCompacting(id: string | null | undefined): boolean {
  return id != null && snapshot.has(id);
}

/** Replace the authoritative set wholesale (resync / full snapshot from main). */
function setAuthoritativeIds(ids: Iterable<string>): void {
  authoritativeIds.clear();
  for (const id of ids) authoritativeIds.add(id);
  authoritativeVersion++;
  emit();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

// Sync from the MAIN process so a /compact started on ANY client (another window, the
// web bridge, a reloaded renderer) is reflected here — the local ref-count only tracks
// ids THIS client started, but a concurrent send from a client that didn't start it must
// still be blocked before it optimistically persists a user turn the backend would reject.
// Wired once, lazily, and guarded (window.app is absent in tests / non-Electron).
type CompactingBridge = {
  compactingIds?: () => Promise<string[]>;
  onCompactingChanged?: (cb: (p: { conversationId: string; compacting: boolean }) => void) => () => void;
};
let crossClientWired = false;
function resyncAuthoritative(conv: CompactingBridge): Promise<boolean> {
  // Replace the authoritative set from a full snapshot. A dropped `compacting:false`
  // (missed while a web socket was down) would otherwise leave a chat stuck-blocked;
  // replacing wholesale clears any id the main process no longer reports. Resolves
  // true on a successful snapshot, false on failure (so callers can retry).
  const p = conv.compactingIds?.();
  if (!p) return Promise.resolve(false);
  // Capture the version BEFORE the async fetch. If a per-event add/delete (or another resync)
  // mutates the authoritative set while this fetch is in flight, this snapshot is stale — DROP
  // it rather than overwrite the fresher state (the next poll/resync reconciles). Still resolve
  // true so the first-snapshot backstop stops retrying (we did observe a valid snapshot).
  const issuedAt = authoritativeVersion;
  return p.then(
    (ids) => {
      if (authoritativeVersion !== issuedAt) return true; // superseded by a newer mutation
      setAuthoritativeIds(Array.isArray(ids) ? ids : []);
      return true;
    },
    () => false,
  );
}
function ensureCrossClientSync(): void {
  if (crossClientWired) return;
  crossClientWired = true;
  const conv = (globalThis as { app?: { conversations?: unknown } }).app?.conversations as
    | CompactingBridge
    | undefined;
  if (!conv) return;
  try {
    conv.onCompactingChanged?.((p) => {
      if (p.compacting) authoritativeIds.add(p.conversationId);
      else authoritativeIds.delete(p.conversationId);
      authoritativeVersion++; // so an in-flight resync detects this newer mutation + drops its stale snapshot
      emit();
    });
    // Initial snapshot for a late-joining / reloaded client.
    void resyncAuthoritative(conv);
    // Re-snapshot when the window regains focus/visibility: covers a web-bridge socket
    // that reconnected (missing the `compacting:false` sent while it was down) — the
    // client-side event `listeners` map survives reconnect, but events fired during the
    // gap are lost, so we reconcile against the authoritative snapshot on return.
    const w = globalThis as unknown as {
      addEventListener?: (t: string, cb: () => void) => void;
      document?: { visibilityState?: string };
    };
    const onReturn = (): void => {
      if (w.document && w.document.visibilityState === 'hidden') return;
      void resyncAuthoritative(conv);
    };
    w.addEventListener?.('focus', onReturn);
    w.addEventListener?.('visibilitychange', onReturn);
    // Backstop poll — UNCONDITIONAL. It must run even when we currently believe nothing
    // is compacting: a web client that got an empty snapshot, then disconnected and missed
    // a later `compacting:true` while down, and reconnected WITHOUT a focus/visibility
    // event (e.g. it was already focused) would otherwise never learn about the in-flight
    // compaction and would let a send through that the backend rejects as busy. A periodic
    // full snapshot reconciles authoritatively in both directions (adds missed true,
    // clears missed false). Cheap invoke; interval kept modest.
    setInterval(() => {
      void resyncAuthoritative(conv);
    }, 5000);
  } catch {
    /* best-effort — the local store still works from this client's own /compact */
  }
}

/** Reactive set of conversation ids currently being compacted. Survives remounts. */
export function useCompactingIds(): ReadonlySet<string> {
  ensureCrossClientSync();
  return useSyncExternalStore(
    subscribe,
    () => snapshot,
    () => snapshot,
  );
}
