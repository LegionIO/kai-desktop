/**
 * Tests for checkVersionMismatch (electron/cli/spawn-backend.ts) — the CLI↔backend
 * version-mismatch diagnostic. When a freshly-updated CLI attaches to a STALE
 * backend (an old headless leader still running after an app update), this returns
 * a "Restart Kai" warning so the user isn't silently served old code. __APP_VERSION
 * is the CLI's build version (a Vite/vitest define = the real package version here);
 * client.serverVersion is what the backend reported in the auth handshake.
 */
import { describe, it, expect } from 'vitest';
import { checkVersionMismatch } from '../spawn-backend.js';
import type { LocalBridgeClient } from '../client.js';

const clientWith = (serverVersion: string): LocalBridgeClient => ({ serverVersion }) as unknown as LocalBridgeClient;

describe('checkVersionMismatch', () => {
  it('returns null when the backend version matches the CLI build', () => {
    expect(checkVersionMismatch(clientWith(__APP_VERSION))).toBeNull();
  });

  it('returns null when the backend reported NO version (older backend predating the field)', () => {
    expect(checkVersionMismatch(clientWith(''))).toBeNull();
  });

  it('warns when the backend version differs from the CLI build', () => {
    const msg = checkVersionMismatch(clientWith('0.0.1-old'));
    expect(msg).not.toBeNull();
    expect(msg).toMatch(/version mismatch/i);
    expect(msg).toContain('0.0.1-old'); // names the stale backend version
    expect(msg).toContain(__APP_VERSION); // names the CLI version
    expect(msg).toMatch(/restart/i); // tells the user what to do
  });
});
