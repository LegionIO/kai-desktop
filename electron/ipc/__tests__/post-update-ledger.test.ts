/**
 * Tests for the attempt-scoped, per-plugin post-update cleanup ledger (R35P1).
 *
 * The ledger replaces the old single `.update-completed` marker. Its two
 * safety-critical properties over the marker:
 *   (1) a second attempt NEVER overwrites an earlier attempt's still-owed
 *       cleanup (each attempt is keyed by a unique id, appended not replaced);
 *   (2) reconciliation clears cleanup PER PLUGIN, so a retry re-runs only the
 *       plugins that haven't finished — never re-running already-done cleanup.
 *
 * LEDGER_PATH = join(app.getPath('userData'), '.update-completed') is a
 * module-level const, so electron is mocked and KAI_USER_DATA repointed before
 * import. It reuses the marker's path so a legacy marker is migrated on read.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync, readdirSync, chmodSync, symlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const USERDATA = mkdtempSync(join(tmpdir(), 'kai-ledger-'));
process.env.KAI_USER_DATA = USERDATA;

vi.mock('electron', () => ({
  app: { getPath: () => USERDATA, getVersion: () => '2.5.0' },
}));

const {
  readLedger,
  readLedgerResult,
  recordAttempt,
  markPluginsDone,
  removeAttempt,
  hasOutstandingDebt,
  setAttemptSuccess,
  isLedgerCorrupt,
  isLedgerUnavailable,
  isLedgerUnreadable,
  bumpAttemptTries,
  getAttemptTries,
  quarantineCorruptLedger,
} = await import('../post-update-ledger.js');

const LEDGER = join(USERDATA, '.update-completed');

beforeEach(() => {
  rmSync(LEDGER, { force: true });
});
afterEach(() => vi.clearAllMocks());

describe('post-update ledger', () => {
  it('starts empty', () => {
    expect(readLedger()).toEqual([]);
    expect(hasOutstandingDebt()).toBe(false);
  });

  it('records an attempt and reads it back with owed plugins', () => {
    expect(recordAttempt({ id: 'a1', version: '2.5.0', fromVersion: '2.4.0', owed: ['p', 'q'] })).toBe(true);
    const led = readLedger();
    expect(led).toHaveLength(1);
    expect(led[0]).toMatchObject({ id: 'a1', version: '2.5.0', fromVersion: '2.4.0', owed: ['p', 'q'] });
    expect(typeof led[0].ts).toBe('number');
    expect(hasOutstandingDebt()).toBe(true);
  });

  it('a SECOND attempt does not overwrite the first (R35P1 core property)', () => {
    recordAttempt({ id: 'a1', version: '2.5.0', fromVersion: '2.4.0', owed: ['p'] });
    recordAttempt({ id: 'a2', version: '2.6.0', fromVersion: '2.5.0', owed: ['q'] });
    const led = readLedger();
    expect(led.map((a) => a.id).sort()).toEqual(['a1', 'a2']);
    expect(led.find((a) => a.id === 'a1')?.owed).toEqual(['p']);
    expect(led.find((a) => a.id === 'a2')?.owed).toEqual(['q']);
  });

  it('re-recording the SAME id replaces (idempotent), does not duplicate', () => {
    recordAttempt({ id: 'a1', version: '2.5.0', fromVersion: '2.4.0', owed: ['p'] });
    recordAttempt({ id: 'a1', version: '2.5.0', fromVersion: '2.4.0', owed: ['p', 'q'] });
    const led = readLedger();
    expect(led).toHaveLength(1);
    expect(led[0].owed).toEqual(['p', 'q']);
  });

  it('markPluginsDone clears only the named plugins; attempt survives with the rest', () => {
    recordAttempt({ id: 'a1', version: '2.5.0', fromVersion: '2.4.0', owed: ['p', 'q', 'r'] });
    markPluginsDone('a1', ['q']);
    const led = readLedger();
    expect(led).toHaveLength(1);
    expect(led[0].owed).toEqual(['p', 'r']);
  });

  it('markPluginsDone drops the attempt once nothing remains owed', () => {
    recordAttempt({ id: 'a1', version: '2.5.0', fromVersion: '2.4.0', owed: ['p', 'q'] });
    markPluginsDone('a1', ['p', 'q']);
    expect(readLedger()).toEqual([]);
    expect(existsSync(LEDGER)).toBe(true); // file remains (empty attempts), still valid
  });

  it('persists + validates the failure-only `participants` field (R28P38)', () => {
    recordAttempt({
      id: 'a1',
      version: '2.5.0',
      fromVersion: '2.4.0',
      owed: [],
      participants: ['p', 'q'],
      success: false,
    });
    const led = readLedger();
    expect(led[0].owed).toEqual([]);
    expect(led[0].participants).toEqual(['p', 'q']);
    expect(led[0].success).toBe(false);
  });

  it('markPluginsDone prunes `participants` too and drops only when BOTH are empty (R28P38)', () => {
    recordAttempt({
      id: 'a1',
      version: '2.5.0',
      fromVersion: '2.4.0',
      owed: ['p'],
      participants: ['p', 'q'],
      success: false,
    });
    // Clear q (a participant, not owed) → attempt survives (p still owed, q pruned from participants).
    markPluginsDone('a1', ['q']);
    let led = readLedger();
    expect(led).toHaveLength(1);
    expect(led[0].owed).toEqual(['p']);
    expect(led[0].participants).toEqual(['p']);
    // Clear p → both owed AND participants empty → attempt dropped.
    markPluginsDone('a1', ['p']);
    expect(readLedger()).toEqual([]);
  });

  it('a participants-only attempt (owed:[]) survives until its participants are cleared (R28P38)', () => {
    recordAttempt({ id: 'a1', version: '2.5.0', fromVersion: '2.4.0', owed: [], participants: ['p'], success: false });
    expect(readLedger()).toHaveLength(1); // not dropped despite empty owed — participants remain
    markPluginsDone('a1', ['p']);
    expect(readLedger()).toEqual([]);
  });

  it('rejects a non-string-array `participants` as corrupt (R28P38)', () => {
    writeFileSync(
      LEDGER,
      JSON.stringify({ v: 1, attempts: [{ id: 'a', version: '2.5.0', owed: [], participants: [42] }] }),
    );
    expect(readLedger()).toEqual([]); // corrupt → empty read
    expect(isLedgerCorrupt()).toBe(true);
  });

  it('markPluginsDone leaves OTHER attempts untouched', () => {
    recordAttempt({ id: 'a1', version: '2.5.0', fromVersion: '2.4.0', owed: ['p'] });
    recordAttempt({ id: 'a2', version: '2.6.0', fromVersion: '2.5.0', owed: ['q'] });
    markPluginsDone('a1', ['p']);
    const led = readLedger();
    expect(led.map((a) => a.id)).toEqual(['a2']);
  });

  it('removeAttempt drops the whole attempt regardless of owed', () => {
    recordAttempt({ id: 'a1', version: '2.5.0', fromVersion: '2.4.0', owed: ['p', 'q'] });
    removeAttempt('a1');
    expect(readLedger()).toEqual([]);
  });

  it('migrates a LEGACY single-marker into one attempt with empty owed', () => {
    writeFileSync(LEDGER, JSON.stringify({ version: '2.5.0', fromVersion: '2.4.0', timestamp: 111 }));
    const led = readLedger();
    expect(led).toHaveLength(1);
    expect(led[0]).toMatchObject({ id: 'legacy-111', version: '2.5.0', fromVersion: '2.4.0', owed: [] });
  });

  it('gives a timestamp-less legacy marker a STABLE id across reads (removable)', () => {
    writeFileSync(LEDGER, JSON.stringify({ version: '2.5.0', fromVersion: '2.4.0' })); // no timestamp
    const id1 = readLedger()[0].id;
    const id2 = readLedger()[0].id;
    expect(id1).toBe('legacy-marker');
    expect(id2).toBe(id1); // deterministic — not Date.now()
    // Because the id is stable, removeAttempt actually clears it.
    expect(removeAttempt(id1)).toBe(true);
    expect(readLedger()).toEqual([]);
  });

  it('returns [] (never throws) on corrupt JSON', () => {
    writeFileSync(LEDGER, '{ not json ');
    expect(readLedger()).toEqual([]);
  });

  it('REFUSES to mutate a corrupt ledger (never clobbers unparseable debt)', () => {
    // A present-but-unparseable file could be real debt we just can't read; a
    // mutation must refuse rather than overwrite it (R35P1).
    writeFileSync(LEDGER, '{ not json ');
    expect(recordAttempt({ id: 'a1', version: '2.5.0', fromVersion: '2.4.0', owed: ['p'] })).toBe(false);
    expect(markPluginsDone('a1', ['p'])).toBe(false);
    expect(removeAttempt('a1')).toBe(false);
    expect(setAttemptSuccess('a1', true)).toBe(false);
    // The corrupt file is left untouched (not overwritten with a valid-but-empty ledger).
    expect(readFileSync(LEDGER, 'utf-8')).toBe('{ not json ');
  });

  it('isLedgerCorrupt reflects readability (garbage/empty=true, absent/valid=false)', () => {
    expect(isLedgerCorrupt()).toBe(false); // absent (ENOENT)
    writeFileSync(LEDGER, '{ not json ');
    expect(isLedgerCorrupt()).toBe(true);
    rmSync(LEDGER, { force: true });
    writeFileSync(LEDGER, ''); // present but empty → corrupt (could be an interrupted legacy write)
    expect(isLedgerCorrupt()).toBe(true);
    rmSync(LEDGER, { force: true });
    writeFileSync(LEDGER, JSON.stringify({ v: 1, attempts: [{ id: 'a', version: '2.5.0', owed: [] }] }));
    expect(isLedgerCorrupt()).toBe(false);
  });

  it('readLedgerResult returns ONE consistent status + attempts (R28P32)', () => {
    // Absent → ok/[]
    rmSync(LEDGER, { force: true });
    expect(readLedgerResult()).toEqual({ status: 'ok', attempts: [] });
    // Valid → ok with the attempts
    recordAttempt({ id: 'a', version: '2.5.0', fromVersion: '2.4.0', owed: ['p'] });
    const ok = readLedgerResult();
    expect(ok.status).toBe('ok');
    expect(ok.attempts[0].id).toBe('a');
    // Corrupt content → corrupt/[]
    rmSync(LEDGER, { force: true });
    writeFileSync(LEDGER, '{ not json ');
    expect(readLedgerResult()).toEqual({ status: 'corrupt', attempts: [] });
    rmSync(LEDGER, { force: true });
  });

  it('a TRANSIENT read failure is UNAVAILABLE (not corrupt) so it is never quarantined (R28P31)', () => {
    // chmod 000 makes open() fail with EACCES — a transient/environmental failure,
    // NOT content corruption. Skip if running as root (can't be denied).
    if (typeof process.getuid === 'function' && process.getuid() === 0) return;
    writeFileSync(LEDGER, JSON.stringify({ v: 1, attempts: [{ id: 'a', version: '2.5.0', owed: ['p'] }] }));
    chmodSync(LEDGER, 0o000);
    try {
      expect(isLedgerUnavailable()).toBe(true);
      expect(isLedgerCorrupt()).toBe(false); // NOT corrupt → NOT quarantinable
      expect(isLedgerUnreadable()).toBe(true); // still blocks installs
      expect(readLedgerResult().status).toBe('unavailable');
      // A mutation must REFUSE (never clobber a possibly-valid ledger).
      expect(recordAttempt({ id: 'b', version: '2.5.0', fromVersion: '2.4.0', owed: [] })).toBe(false);
    } finally {
      chmodSync(LEDGER, 0o600);
      rmSync(LEDGER, { force: true });
    }
  });

  it('quarantineCorruptLedger renames the corrupt file aside so the next launch is clean (R28P19)', () => {
    writeFileSync(LEDGER, '{ not json ');
    expect(isLedgerCorrupt()).toBe(true);
    expect(quarantineCorruptLedger()).toBe(true);
    // Original path is now ABSENT (not corrupt) → next launch reads clean.
    expect(existsSync(LEDGER)).toBe(false);
    expect(isLedgerCorrupt()).toBe(false);
    // A quarantined sibling exists.
    const siblings = readdirSync(USERDATA).filter((f) => f.startsWith('.update-completed.corrupt-'));
    expect(siblings.length).toBe(1);
    // Clean up the quarantined file.
    for (const s of siblings) rmSync(join(USERDATA, s), { force: true });
  });

  it('quarantineCorruptLedger is a no-op (returns false) when the file is absent', () => {
    rmSync(LEDGER, { force: true });
    expect(quarantineCorruptLedger()).toBe(false);
  });

  it('a PRESENT empty (0-byte) file is treated as CORRUPT, not overwritable (R5P2)', () => {
    writeFileSync(LEDGER, '');
    expect(readLedger()).toEqual([]); // corrupt reads as empty for the reconciler…
    // …but a mutation REFUSES rather than overwriting it (it may be an interrupted
    // legacy write that followed real setup).
    expect(recordAttempt({ id: 'a1', version: '2.5.0', fromVersion: '2.4.0', owed: ['p'] })).toBe(false);
    expect(readFileSync(LEDGER, 'utf-8')).toBe(''); // left untouched
  });

  it('treats a ledger with ANY structurally-invalid attempt as corrupt (does not partially salvage)', () => {
    // Partial salvage would let the next mutation rewrite the file MINUS the
    // dropped entries, deleting potentially-real debt — so the whole file is
    // rejected as corrupt instead (R35P1).
    writeFileSync(
      LEDGER,
      JSON.stringify({ v: 1, attempts: [{ id: 'ok', version: '2.5.0', owed: [] }, { nope: true }, 42] }),
    );
    expect(readLedger()).toEqual([]); // corrupt → empty read
    // …and a mutation refuses rather than clobbering the (unparseable) 'ok' entry.
    expect(recordAttempt({ id: 'new', version: '3.0.0', fromVersion: '2.5.0', owed: [] })).toBe(false);
  });

  it('treats non-string owed entries as corrupt', () => {
    writeFileSync(LEDGER, JSON.stringify({ v: 1, attempts: [{ id: 'a', version: '2.5.0', owed: ['p', 5, null] }] }));
    expect(readLedger()).toEqual([]);
    expect(markPluginsDone('a', ['p'])).toBe(false);
  });

  it('treats duplicate attempt ids as corrupt', () => {
    writeFileSync(
      LEDGER,
      JSON.stringify({
        v: 1,
        attempts: [
          { id: 'dup', version: '2.5.0', owed: [] },
          { id: 'dup', version: '2.6.0', owed: ['p'] },
        ],
      }),
    );
    expect(readLedger()).toEqual([]);
    expect(removeAttempt('dup')).toBe(false);
  });

  it('does NOT follow a symlink (O_NOFOLLOW) — returns []', () => {
    const secret = join(USERDATA, 'secret.json');
    writeFileSync(secret, JSON.stringify({ v: 1, attempts: [{ id: 'x', version: '9', owed: [] }] }));
    symlinkSync(secret, LEDGER);
    expect(readLedger()).toEqual([]);
    rmSync(LEDGER, { force: true });
  });

  it('setAttemptSuccess persists the outcome ONCE (first determination wins)', () => {
    recordAttempt({ id: 'a1', version: '2.5.0', fromVersion: '2.4.0', owed: ['p'] });
    expect(readLedger()[0].success).toBeUndefined();
    setAttemptSuccess('a1', true);
    expect(readLedger()[0].success).toBe(true);
    // A later attempt to flip it is a no-op — the first determination is stable
    // across retries even after the running version changes.
    setAttemptSuccess('a1', false);
    expect(readLedger()[0].success).toBe(true);
  });

  it('recordAttempt can carry an initial success outcome', () => {
    recordAttempt({ id: 'a1', version: '2.5.0', fromVersion: '2.4.0', owed: ['p'], success: false });
    const led = readLedger();
    expect(led[0].success).toBe(false);
    // and it survives a markPluginsDone that leaves the attempt alive
    markPluginsDone('a1', []);
    expect(readLedger()[0].success).toBe(false);
  });

  it('bumpAttemptTries increments + persists the retry counter (R8P1)', () => {
    recordAttempt({ id: 'a1', version: '2.5.0', fromVersion: '2.4.0', owed: ['p'] });
    expect(bumpAttemptTries('a1')).toBe(1);
    expect(bumpAttemptTries('a1')).toBe(2);
    expect(readLedger()[0].tries).toBe(2); // persisted
    expect(bumpAttemptTries('missing')).toBe(0); // absent attempt → 0, no throw
  });

  it('getAttemptTries READS the counter without mutating it (R28P5)', () => {
    recordAttempt({ id: 'a1', version: '2.5.0', fromVersion: '2.4.0', owed: ['p'] });
    expect(getAttemptTries('a1')).toBe(0); // fresh
    expect(getAttemptTries('a1')).toBe(0); // still 0 — read is non-mutating
    bumpAttemptTries('a1');
    expect(getAttemptTries('a1')).toBe(1); // reflects the bump
    expect(readLedger()[0].tries).toBe(1); // getAttemptTries did NOT double-count
    expect(getAttemptTries('missing')).toBe(0); // absent → 0
  });

  it('treats a FRACTIONAL tries counter as corrupt (must be a non-negative integer, R8P2)', () => {
    writeFileSync(LEDGER, JSON.stringify({ v: 1, attempts: [{ id: 'a', version: '2.5.0', owed: ['p'], tries: 5.1 }] }));
    expect(readLedger()).toEqual([]); // corrupt → empty read
    expect(recordAttempt({ id: 'b', version: '2.5.0', fromVersion: '2.4.0', owed: [] })).toBe(false); // mutations refuse
  });

  it('writes with 0600 mode', () => {
    recordAttempt({ id: 'a1', version: '2.5.0', fromVersion: '2.4.0', owed: ['p'] });
    // Round-trips as valid on-disk JSON with the v:1 envelope.
    const raw = JSON.parse(readFileSync(LEDGER, 'utf-8'));
    expect(raw.v).toBe(1);
    expect(Array.isArray(raw.attempts)).toBe(true);
  });
});
