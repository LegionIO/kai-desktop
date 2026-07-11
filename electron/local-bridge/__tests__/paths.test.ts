/**
 * Tests for local-bridge/paths.ts — resolves the leader socket path + the
 * per-install bridge auth token. Security-relevant: the token gates the win32
 * named pipe (no owner-only ACL) and is defense-in-depth on POSIX, so its
 * generation / reuse / regeneration and file mode matter. KAI_USER_DATA is
 * pointed at a temp dir so tests never touch the real ~/.kai.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, statSync, writeFileSync, mkdirSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { getAppHome, getRunDir, getSocketPath, getBridgeToken } from '../paths.js';

let home: string;
let prevUserData: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'kai-bridge-paths-'));
  prevUserData = process.env.KAI_USER_DATA;
  process.env.KAI_USER_DATA = home;
});
afterEach(() => {
  if (prevUserData === undefined) delete process.env.KAI_USER_DATA;
  else process.env.KAI_USER_DATA = prevUserData;
  rmSync(home, { recursive: true, force: true });
});

describe('getAppHome', () => {
  it('honors the KAI_USER_DATA override', () => {
    expect(getAppHome()).toBe(home);
  });

  it('falls back to ~/.{slug} when the override is empty', () => {
    process.env.KAI_USER_DATA = '';
    const fallback = getAppHome();
    expect(fallback).not.toBe(home);
    expect(fallback).toContain('.'); // ~/.<slug>
  });
});

describe('getRunDir', () => {
  it('is the run/ subdirectory of the app home', () => {
    expect(getRunDir()).toBe(join(home, 'run'));
  });
});

describe('getSocketPath', () => {
  it('returns run/kai.sock on POSIX', () => {
    if (process.platform === 'win32') return; // POSIX-only assertion
    expect(getSocketPath()).toBe(join(home, 'run', 'kai.sock'));
  });
});

describe('getBridgeToken', () => {
  it('generates a 64-char hex token and persists it', () => {
    const token = getBridgeToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/); // 32 random bytes → 64 hex
    expect(existsSync(join(home, 'run', 'bridge.token'))).toBe(true);
  });

  it('reuses the same token on subsequent calls', () => {
    const first = getBridgeToken();
    const second = getBridgeToken();
    expect(second).toBe(first);
  });

  it('reads the token back from disk (persisted, not regenerated)', () => {
    const token = getBridgeToken();
    const onDisk = readFileSync(join(home, 'run', 'bridge.token'), 'utf-8').trim();
    expect(onDisk).toBe(token);
  });

  it('regenerates when the token file is empty or whitespace', () => {
    const first = getBridgeToken();
    writeFileSync(join(home, 'run', 'bridge.token'), '   ', 'utf-8');
    const regenerated = getBridgeToken();
    expect(regenerated).toMatch(/^[0-9a-f]{64}$/);
    expect(regenerated).not.toBe(first);
  });

  it('creates the run dir when absent', () => {
    expect(existsSync(join(home, 'run'))).toBe(false);
    getBridgeToken();
    expect(existsSync(join(home, 'run'))).toBe(true);
  });

  it('writes the token file with owner-only (0o600) permissions on POSIX', () => {
    if (process.platform === 'win32') return; // no POSIX modes on win32
    getBridgeToken();
    const mode = statSync(join(home, 'run', 'bridge.token')).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('reuses a token that already exists in a pre-created run dir', () => {
    mkdirSync(join(home, 'run'), { recursive: true, mode: 0o700 });
    writeFileSync(join(home, 'run', 'bridge.token'), 'preexisting-token-value', 'utf-8');
    expect(getBridgeToken()).toBe('preexisting-token-value');
  });
});
