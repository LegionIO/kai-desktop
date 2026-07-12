/**
 * Tests for auth-secret-bound session invalidation in web-server.ts. Persisted
 * web-session cookies (token -> expiry) must NOT survive a credential change:
 * rotating the password, or switching between anonymous and password mode, has
 * to invalidate every previously-issued cookie so a leaked/stale token can't
 * outlive the secret it was minted under. The decision is `sessionsCarryOver`,
 * keyed on `authFingerprint`.
 *
 * SESSIONS_PATH is derived from homedir() at module load, so HOME is repointed
 * to a throwaway dir before import. `electron` (pulled in transitively via
 * ipc-bridge) is mocked so the module can load in a plain Node test.
 */
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), on: vi.fn(), emit: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] },
  app: { getPath: () => tmpdir(), on: vi.fn(), whenReady: () => Promise.resolve() },
}));

process.env.HOME = mkdtempSync(join(tmpdir(), 'kai-websession-'));

const { authFingerprint, sessionsCarryOver } = await import('../web-server.js');

type Cfg = Parameters<typeof authFingerprint>[0];
const pwCfg = (password: string): Cfg =>
  ({
    enabled: true,
    port: 0,
    bindAddress: '127.0.0.1',
    tls: { enabled: false, mode: 'self-signed', certPath: '', keyPath: '' },
    auth: { mode: 'password', username: 'kai', password },
  }) as Cfg;
const anonCfg = (): Cfg => ({ ...pwCfg(''), auth: { mode: 'anonymous', username: '', password: '' } }) as Cfg;

describe('authFingerprint', () => {
  it('is stable for the same password', () => {
    expect(authFingerprint(pwCfg('hunter2'))).toBe(authFingerprint(pwCfg('hunter2')));
  });

  it('changes when the password changes', () => {
    expect(authFingerprint(pwCfg('hunter2'))).not.toBe(authFingerprint(pwCfg('hunter3')));
  });

  it('distinguishes anonymous mode from a literal "anonymous" password (domain-separated)', () => {
    expect(authFingerprint(anonCfg())).not.toBe(authFingerprint(pwCfg('anonymous')));
    expect(authFingerprint(anonCfg())).not.toBe(authFingerprint(pwCfg('anon')));
  });

  it('does not leak the plaintext password (it is a SHA-256 hex digest)', () => {
    const fp = authFingerprint(pwCfg('super-secret'));
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
    expect(fp).not.toContain('super-secret');
  });
});

describe('sessionsCarryOver', () => {
  it('carries sessions over when the fingerprint is unchanged', () => {
    const fp = authFingerprint(pwCfg('hunter2'));
    expect(sessionsCarryOver(fp, fp)).toBe(true);
  });

  it('discards sessions when the password rotated (fingerprint changed)', () => {
    const oldFp = authFingerprint(pwCfg('hunter2'));
    const newFp = authFingerprint(pwCfg('hunter3'));
    expect(sessionsCarryOver(oldFp, newFp)).toBe(false);
  });

  it('discards sessions on an anonymous<->password switch', () => {
    const anon = authFingerprint(anonCfg());
    const pw = authFingerprint(pwCfg('hunter2'));
    expect(sessionsCarryOver(anon, pw)).toBe(false);
    expect(sessionsCarryOver(pw, anon)).toBe(false);
  });

  it('discards legacy/absent sessions (null loaded fingerprint never carries over)', () => {
    expect(sessionsCarryOver(null, authFingerprint(pwCfg('hunter2')))).toBe(false);
    expect(sessionsCarryOver(null, authFingerprint(anonCfg()))).toBe(false);
  });
});
