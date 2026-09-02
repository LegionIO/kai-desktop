import { app } from 'electron';
import { openSync, readSync, fstatSync, closeSync, renameSync, constants as fsConstants } from 'fs';
import { join } from 'path';
import { atomicWriteFileSync } from '../utils/atomic-write.js';

/**
 * Attempt-scoped, per-plugin post-update cleanup ledger (R35P1).
 *
 * REPLACES the old single `.update-completed` marker. That marker recorded only
 * one attempt's `{version}` and had two structural gaps: (1) a second update
 * could overwrite it while an earlier attempt's cleanup was still owed, losing
 * that debt; (2) retry re-ran EVERY active post-update hook (not just the ones
 * that hadn't completed), duplicating already-done cleanup even though the plugin
 * API doesn't require idempotence.
 *
 * The ledger fixes both: it holds a LIST of attempts, each keyed by a unique id
 * and carrying the set of plugins whose cleanup is still owed. Reconciliation
 * runs only the owed hooks and clears each plugin individually; an attempt record
 * is removed only once all its plugins are done. Multiple unreconciled attempts
 * coexist without clobbering each other.
 *
 * On-disk format (single JSON file, atomically replaced):
 *   { v: 1, attempts: [ { id, version, fromVersion, ts, owed: string[] } ] }
 *
 * The file is validated defensively on read (single-fd O_NOFOLLOW|O_NONBLOCK,
 * size cap) the same way the legacy marker was — it lives in userData but a
 * planted symlink/FIFO/oversized file must never hang or mislead startup.
 */

export interface LedgerAttempt {
  /** Unique per-attempt id (so a later attempt never overwrites an earlier one). */
  id: string;
  /** Version this attempt was installing. */
  version: string;
  /** Version the app was running when the attempt started. */
  fromVersion: string;
  /** Epoch ms the attempt was recorded. */
  ts: number;
  /** Names of plugins whose post-update cleanup is still OWED for this attempt. */
  owed: string[];
  /** ALL plugins that PARTICIPATED in this attempt's pre-update hooks (a superset
   *  of `owed` — includes participants that were HOOKLESS at commit). This is
   *  FAILURE-ONLY metadata: the success-path reconciler ignores it (only `owed`
   *  drives cleanup, so a hookless participant never blocks a successful install).
   *  It exists so the committed-FAILURE teardown has a DURABLE participant list even
   *  if its own later ledger-widening write fails — a hookless-at-commit participant
   *  that registered cleanup after commit can then still be reconciled (R28P38).
   *  Optional/absent on legacy + success-only attempts. */
  participants?: string[];
  /** Whether the install SUCCEEDED, once known. Determined ONCE (the failed-install
   *  teardown records `false`; the first successful relaunch records `true`) and
   *  then PERSISTED, so a retry across a later update doesn't recompute a stale
   *  answer from the then-current version (R35P1). `undefined` = not yet known. */
  success?: boolean;
  /** How many launches have ATTEMPTED to reconcile this entry without fully
   *  clearing it. Bumped once per launch that still finds it owed; when it exceeds
   *  a cap the reconciler GIVES UP (drops the attempt + lifts its deferral) so a
   *  permanently-unrunnable cleanup — a plugin gone missing, incompatible, or whose
   *  hook keeps failing — can't block installs forever (R8P1). `undefined` = 0. */
  tries?: number;
}

interface LedgerFile {
  v: 1;
  attempts: LedgerAttempt[];
}

const LEDGER_MAX_BYTES = 4 * 1024 * 1024; // generous but bounded

/** Resolve the ledger path LAZILY (per call). It must NOT be captured at module
 *  import: static imports evaluate before `app.setPath('userData', …)` runs, so a
 *  captured path would point at the DEFAULT userData even when a KAI_USER_DATA
 *  isolation home is set later — letting two instances share one ledger and clobber
 *  each other's owed cleanup (R28P16). Resolving on each call always reflects the
 *  finalized userData. `app.getPath` is cheap.
 *
 *  ACCEPTED RESIDUAL (do NOT auto-migrate — codex re-raises this as "migrate the
 *  pre-remap marker", R14/R16): a build PRIOR to this lazy-path fix, launched under
 *  KAI_USER_DATA, wrote its marker to the DEFAULT (pre-remap) userData; this
 *  resolver reads only the remapped dir, so on the first upgraded launch it misses
 *  that one legacy attempt. We deliberately DO NOT migrate it: the default-path
 *  ledger is UNATTRIBUTABLE — it may belong to a NORMAL (non-isolated) instance, and
 *  any automatic move/copy either destroys that instance's real cleanup debt or
 *  imports someone else's (R28-R15 showed the migration was net-harmful; it was
 *  reverted). The affected scenario is only the dev/headless KAI_USER_DATA isolation
 *  path crossing this one-time fix boundary — narrow enough to accept over a
 *  cross-profile data-loss vector. Production installs (no KAI_USER_DATA) are
 *  unaffected: their userData never remaps, so the marker is always at this path. */
function ledgerPath(): string {
  return join(app.getPath('userData'), '.update-completed');
}

/**
 * Result of reading the ledger. Four states:
 *  - `ok`: read successfully; `attempts` is the validated content (possibly []).
 *  - `absent`: ENOENT — no file. Safe to write; nothing owed.
 *  - `corrupt`: the file was READ but its CONTENT is invalid (bad JSON / wrong
 *     shape / duplicate id / present-but-empty). A mutation must REFUSE (returning
 *     [] then writing would destroy real-but-unparseable debt). Only THIS state may
 *     be quarantined — the bytes are genuinely garbage.
 *  - `unavailable`: a TRANSIENT I/O failure (EMFILE/EIO/EBUSY/EACCES/…): the file
 *     likely exists and is fine, we just couldn't read it this instant. Treated
 *     like corrupt for SAFETY (mutations refuse, installs block) but MUST NOT be
 *     quarantined — renaming a valid ledger aside on a transient blip would
 *     permanently discard owed cleanup (R28P31).
 */
type LedgerState = { status: 'ok'; attempts: LedgerAttempt[] } | { status: 'corrupt' } | { status: 'unavailable' };

function readLedgerState(): LedgerState {
  let fd: number;
  try {
    fd = openSync(ledgerPath(), fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    // ENOENT = absent (a clean, empty ledger — safe to write).
    if (code === 'ENOENT') return { status: 'ok', attempts: [] };
    // ELOOP (a symlink, under O_NOFOLLOW) means something WRONG is planted at the
    // path — that's content-corruption territory (never our regular file), so
    // corrupt (and quarantinable). Everything else on open — EMFILE/ENFILE (fd
    // exhaustion), EIO, EBUSY, EACCES/EPERM, EAGAIN — is a TRANSIENT/environmental
    // failure to READ a file that may be perfectly valid: unavailable, NOT corrupt,
    // so we never quarantine a good ledger on a blip (R28P31).
    if (code === 'ELOOP') return { status: 'corrupt' };
    return { status: 'unavailable' };
  }
  let raw: string;
  try {
    const st = fstatSync(fd);
    // A non-regular file (dir/FIFO/device) or an oversized one is not our ledger
    // — but it IS present, so refuse to clobber it (corrupt), don't treat as empty.
    if (!st.isFile() || st.size > LEDGER_MAX_BYTES) return { status: 'corrupt' };
    const buf = Buffer.allocUnsafe(st.size);
    let off = 0;
    while (off < st.size) {
      const n = readSync(fd, buf, off, st.size - off, off);
      if (n === 0) break;
      off += n;
    }
    raw = buf.subarray(0, off).toString('utf-8');
  } catch {
    // We OPENED the file but couldn't fstat/read it — a transient I/O failure, not
    // proof of bad content. Unavailable (don't quarantine), R28P31.
    return { status: 'unavailable' };
  } finally {
    // A close failure must NEVER escape readLedgerState (R28P34): an uncaught throw
    // from finally would bypass the four-state return entirely, and at the commit
    // site an unguarded recordAttempt() exception would then escape without revert,
    // latching installInProgress + the plugin freeze. The read already succeeded, so
    // a failed close is harmless — swallow it.
    try {
      closeSync(fd);
    } catch {
      /* fd close failed after a successful read — nothing actionable */
    }
  }
  // A PRESENT empty/whitespace file is treated as CORRUPT, not empty: the old
  // (pre-atomic) marker wrote via a plain writeFileSync, so an interrupted write
  // could leave a 0-byte file AFTER privileged setup completed — overwriting it
  // would silently lose that debt (R5P2). Only a truly ABSENT file (ENOENT, which
  // returns ok/[] from the open catch above) counts as "nothing owed".
  if (raw.trim() === '') return { status: 'corrupt' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: 'corrupt' };
  }
  // Current ledger shape. Validate STRICTLY: if any attempt is malformed, any
  // `owed` entry is a non-string, or two attempts share an id, treat the WHOLE
  // file as corrupt rather than silently filtering. Filtering would let the next
  // mutation rewrite the ledger MINUS the dropped attempts, permanently deleting
  // potentially-real cleanup debt (R35P1). Corrupt → mutations refuse.
  if (
    parsed &&
    typeof parsed === 'object' &&
    (parsed as LedgerFile).v === 1 &&
    Array.isArray((parsed as LedgerFile).attempts)
  ) {
    const rawAttempts = (parsed as LedgerFile).attempts;
    if (!rawAttempts.every(isValidAttempt)) return { status: 'corrupt' };
    const attempts = rawAttempts.map(normalizeAttempt);
    const ids = new Set<string>();
    for (const a of attempts) {
      if (ids.has(a.id)) return { status: 'corrupt' }; // duplicate id — ambiguous
      ids.add(a.id);
    }
    return { status: 'ok', attempts };
  }
  // Legacy single-marker migration: `{version, fromVersion, timestamp}`.
  if (parsed && typeof parsed === 'object' && typeof (parsed as { version?: unknown }).version === 'string') {
    const legacy = parsed as { version: string; fromVersion?: string; timestamp?: number };
    return {
      status: 'ok',
      attempts: [
        {
          // DETERMINISTIC id: a timestamp-less legacy marker must migrate to the
          // SAME id on every read, or a mutation keyed on the id (removeAttempt /
          // markPluginsDone) would target a fresh `Date.now()` id that no longer
          // matches, leaving the legacy attempt on disk to re-run its hooks every
          // launch (R35P1). The on-disk timestamp (when present) is already stable;
          // fall back to a fixed constant, not Date.now().
          id: `legacy-${legacy.timestamp ?? 'marker'}`,
          version: legacy.version,
          fromVersion: typeof legacy.fromVersion === 'string' ? legacy.fromVersion : 'unknown',
          ts: typeof legacy.timestamp === 'number' ? legacy.timestamp : Date.now(),
          // The legacy marker had no per-plugin data, so treat ALL of the attempt's
          // cleanup as owed (empty owed = "all active plugins" at reconcile time).
          owed: [],
        },
      ],
    };
  }
  // Valid JSON but an unrecognized shape — present and not ours; refuse to clobber.
  return { status: 'corrupt' };
}

/** Read + validate the ledger file. Returns [] when absent/empty/corrupt (a
 *  corrupt file yields [] here because the reconciler can only run what it can
 *  read — MUTATIONS use `readLedgerState` and refuse to write over corruption).
 *  Never throws, never follows a symlink, never blocks on a FIFO. Migrates the
 *  LEGACY single-marker shape so an in-flight upgrade isn't lost. */
export function readLedger(): LedgerAttempt[] {
  const s = readLedgerState();
  return s.status === 'ok' ? s.attempts : [];
}

/** Single status-bearing read for callers (startup) that must branch on
 *  ok/absent/corrupt/unavailable AND use the attempts CONSISTENTLY — avoiding the
 *  TOCTOU of a separate `isLedgerCorrupt()` + `readLedger()` where the file could
 *  change (or a second read fail) between the two (R28P32). `attempts` is [] unless
 *  `status === 'ok'`. Note: `absent` is folded into `ok` with [] by readLedgerState
 *  (an absent ledger is a clean empty one). */
export function readLedgerResult(): { status: 'ok' | 'corrupt' | 'unavailable'; attempts: LedgerAttempt[] } {
  const s = readLedgerState();
  return s.status === 'ok' ? { status: 'ok', attempts: s.attempts } : { status: s.status, attempts: [] };
}

/** True if the on-disk ledger content is genuinely CORRUPT — successfully read but
 *  invalid (bad JSON / wrong shape / dup id / present-but-empty / planted symlink).
 *  Distinct from `isLedgerUnavailable` (a TRANSIENT read failure). ONLY a corrupt
 *  ledger may be quarantined; both states block installs (R28P31). */
export function isLedgerCorrupt(): boolean {
  return readLedgerState().status === 'corrupt';
}

/** True if the ledger could not be READ this instant due to a transient/environmental
 *  I/O failure (EMFILE/EIO/EBUSY/EACCES/…) — the file may be perfectly valid. Blocks
 *  installs (fail-safe) but must NOT be quarantined; a later launch retries the read
 *  (R28P31). */
export function isLedgerUnavailable(): boolean {
  return readLedgerState().status === 'unavailable';
}

/** True if the ledger is NOT cleanly readable — corrupt OR transiently unavailable.
 *  Startup uses this to BLOCK installs and defer-all (fail-safe): either state may
 *  hide real owed cleanup we can't currently read (R28P31). */
export function isLedgerUnreadable(): boolean {
  const s = readLedgerState().status;
  return s === 'corrupt' || s === 'unavailable';
}

function isValidAttempt(a: unknown): a is LedgerAttempt {
  if (!a || typeof a !== 'object') return false;
  const at = a as Partial<LedgerAttempt>;
  if (typeof at.id !== 'string' || typeof at.version !== 'string') return false;
  if (!Array.isArray(at.owed) || !at.owed.every((n) => typeof n === 'string')) return false;
  // `participants`, if present, must be a string[] (failure-only metadata, R28P38).
  if (
    at.participants !== undefined &&
    (!Array.isArray(at.participants) || !at.participants.every((n) => typeof n === 'string'))
  )
    return false;
  // `fromVersion`/`ts` are normalized (best-effort) but `success`, if present,
  // must be a real boolean — a non-boolean means the file was tampered/garbled.
  if (at.success !== undefined && typeof at.success !== 'boolean') return false;
  if (at.tries !== undefined && (typeof at.tries !== 'number' || !Number.isInteger(at.tries) || at.tries < 0))
    return false;
  return true;
}

function normalizeAttempt(a: LedgerAttempt): LedgerAttempt {
  return {
    id: a.id,
    version: a.version,
    fromVersion: typeof a.fromVersion === 'string' ? a.fromVersion : 'unknown',
    ts: typeof a.ts === 'number' ? a.ts : Date.now(),
    owed: a.owed.filter((n): n is string => typeof n === 'string'),
    ...(Array.isArray(a.participants)
      ? { participants: a.participants.filter((n): n is string => typeof n === 'string') }
      : {}),
    ...(typeof a.success === 'boolean' ? { success: a.success } : {}),
    ...(typeof a.tries === 'number' && a.tries > 0 ? { tries: a.tries } : {}),
  };
}

/** Atomically write the ledger. Uses the shared atomic writer (unique-temp +
 *  O_EXCL|O_NOFOLLOW + rename, mode 0600) so a planted symlink/FIFO at the temp
 *  path can't redirect or hang the write, and a crash mid-write can't tear the
 *  file. Returns false on failure. */
function writeLedger(attempts: LedgerAttempt[]): boolean {
  try {
    const data: LedgerFile = { v: 1, attempts };
    atomicWriteFileSync(ledgerPath(), JSON.stringify(data), { mode: 0o600, fsync: true });
    return true;
  } catch (err) {
    console.error('[auto-update] Failed to write post-update ledger:', err);
    return false;
  }
}

/**
 * Record a NEW attempt (append — never overwrites an existing attempt's owed
 * cleanup, R35P1). `owed` is the plugins whose post-update work is owed; an empty
 * array means "no per-plugin data — reconcile all active plugins" (the
 * legacy/participant-less path). REFUSES (returns false) if the existing ledger
 * is CORRUPT: overwriting it would silently destroy real-but-unparseable debt
 * (P1). Returns false if the read is corrupt or the write failed.
 */
export function recordAttempt(attempt: Omit<LedgerAttempt, 'ts'>): boolean {
  const s = readLedgerState();
  if (s.status !== 'ok') {
    console.error(
      '[auto-update] Post-update ledger is unreadable — refusing to record an attempt (would clobber existing debt).',
    );
    return false;
  }
  // Replace any existing entry with the same id (idempotent re-record), else append.
  const next = s.attempts.filter((a) => a.id !== attempt.id);
  next.push({ ...attempt, ts: Date.now() });
  return writeLedger(next);
}

/** Persist an attempt's determined install outcome ONCE. If it is already set,
 *  this is a no-op (the first determination wins — the failed-install teardown
 *  records `false`, or the first successful relaunch records `true`), so a retry
 *  across a later update never recomputes a stale value (R35P1). No-op if the
 *  attempt is gone. Refuses on a corrupt ledger. Returns false on read-corrupt or
 *  write fail. */
export function setAttemptSuccess(attemptId: string, success: boolean): boolean {
  const s = readLedgerState();
  if (s.status !== 'ok') return false;
  let changed = false;
  const next = s.attempts.map((a) => {
    if (a.id !== attemptId || typeof a.success === 'boolean') return a;
    changed = true;
    return { ...a, success };
  });
  if (!changed) return true;
  return writeLedger(next);
}

/** Max launches that may attempt to reconcile a single owed entry before the
 *  reconciler gives up and drops it — bounds a permanently-unrunnable cleanup
 *  (plugin gone / incompatible / hook always fails) so it can't block installs
 *  forever (R8P1). */
export const MAX_RECONCILE_TRIES = 5;

/** Read an attempt's persisted reconcile-try count WITHOUT mutating it (0 if the
 *  attempt is gone or the ledger is corrupt). Used to check the give-up cap BEFORE
 *  a reconciliation pass, so the counter is only spent by a completed-but-failed
 *  pass — never by a crash that happens before cleanup even runs (R28P5). */
export function getAttemptTries(attemptId: string): number {
  const s = readLedgerState();
  if (s.status !== 'ok') return 0;
  const a = s.attempts.find((x) => x.id === attemptId);
  return a?.tries ?? 0;
}

/** Increment an attempt's reconcile-try counter and return the NEW count (0 if
 *  the attempt is gone / ledger corrupt — caller treats that as "don't give up
 *  spuriously"). Persisted so the cap survives relaunches. */
export function bumpAttemptTries(attemptId: string): number {
  const s = readLedgerState();
  if (s.status !== 'ok') return 0;
  let newCount = 0;
  const next = s.attempts.map((a) => {
    if (a.id !== attemptId) return a;
    newCount = (a.tries ?? 0) + 1;
    return { ...a, tries: newCount };
  });
  if (newCount === 0) return 0; // attempt not found
  writeLedger(next);
  return newCount;
}

/** Mark specific plugins done for an attempt; drop the attempt when none remain
 *  owed. `doneNames` empty with an attempt that had empty `owed` clears it (the
 *  "all done" signal for the participant-less path). Refuses on a corrupt ledger.
 *  Returns false on read-corrupt or write fail. */
export function markPluginsDone(attemptId: string, doneNames: readonly string[]): boolean {
  const s = readLedgerState();
  if (s.status !== 'ok') return false;
  const done = new Set(doneNames);
  const next: LedgerAttempt[] = [];
  for (const a of s.attempts) {
    if (a.id !== attemptId) {
      next.push(a);
      continue;
    }
    const remaining = a.owed.filter((n) => !done.has(n));
    // `participants` is FAILURE-ONLY metadata (folded into effective owed only when
    // success===false). For a SUCCEEDED attempt it's irrelevant, so it must NOT keep
    // the attempt alive once `owed` is cleared — otherwise a successful update with a
    // hookless participant would retain an empty-owed attempt and block later
    // installs until another relaunch (R28P39). Only retain participants for a
    // FAILED (success===false) or still-UNKNOWN (success===undefined) attempt.
    const keepParticipants = a.success !== true;
    const remainingParticipants =
      keepParticipants && Array.isArray(a.participants) ? a.participants.filter((n) => !done.has(n)) : undefined;
    if (remaining.length > 0 || (remainingParticipants && remainingParticipants.length > 0)) {
      next.push({
        ...a,
        owed: remaining,
        ...(remainingParticipants && remainingParticipants.length > 0
          ? { participants: remainingParticipants }
          : { participants: undefined }),
      });
    }
    // else: fully reconciled (owed empty AND no retained participants) → drop.
  }
  return writeLedger(next);
}

/** Remove an entire attempt (fully reconciled or being discarded). Refuses on a
 *  corrupt ledger. Returns false on read-corrupt or write fail. */
export function removeAttempt(attemptId: string): boolean {
  const s = readLedgerState();
  if (s.status !== 'ok') return false;
  const next = s.attempts.filter((a) => a.id !== attemptId);
  return writeLedger(next);
}

/** True if ANY attempt has outstanding cleanup debt. */
export function hasOutstandingDebt(): boolean {
  return readLedger().length > 0;
}

/** QUARANTINE a corrupt ledger: rename the unreadable file aside so the NEXT
 *  launch starts from a clean (absent) ledger instead of wedging installs forever
 *  (R28P19). This is the bounded recovery for an unparseable/garbled file — we
 *  accept that its unreadable owed cleanup is stranded (it's unrecoverable anyway,
 *  and a corrupt ledger blocks everything otherwise). Only call this AFTER blocking
 *  installs for the CURRENT session (we don't lose data mid-session); recovery
 *  takes effect on the following launch. Best-effort: a failure just leaves the
 *  corrupt file in place (still blocked, retried next launch). Returns true if the
 *  file was moved aside. */
export function quarantineCorruptLedger(): boolean {
  const src = ledgerPath();
  const dest = `${src}.corrupt-${Date.now()}`;
  try {
    // O_NOFOLLOW-safe: rename operates on the path entry itself, not a followed
    // symlink target. If the source is gone (ENOENT) there's nothing to quarantine.
    renameSync(src, dest);
    console.error(`[auto-update] Quarantined corrupt post-update ledger → ${dest}`);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code !== 'ENOENT') {
      console.error('[auto-update] Could not quarantine corrupt post-update ledger:', err);
    }
    return false;
  }
}
