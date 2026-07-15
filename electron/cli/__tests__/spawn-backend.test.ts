/**
 * Tests for checkVersionMismatch (electron/cli/spawn-backend.ts) — the CLI↔backend
 * version-mismatch diagnostic. When a freshly-updated CLI attaches to a STALE
 * backend (an old headless leader still running after an app update), this returns
 * a "Restart Kai" warning so the user isn't silently served old code. __APP_VERSION
 * is the CLI's build version (a Vite/vitest define = the real package version here);
 * client.serverVersion is what the backend reported in the auth handshake.
 *
 * Also covers spawnHeadlessBackend's async fail-fast contract: it resolves once
 * the child actually spawns, and resolves FALSE on an 'error' (ENOENT/EACCES) so
 * a failed launch doesn't leave the caller burning the full boot timeout.
 */
import { EventEmitter } from 'node:events';
import { describe, it, expect, vi } from 'vitest';

// Controllable fake child: a spawn() that returns an EventEmitter we drive.
let lastChild: (EventEmitter & { unref?: () => void }) | null = null;
vi.mock('node:child_process', () => ({
  spawn: () => {
    const child = new EventEmitter() as EventEmitter & { unref: () => void };
    child.unref = () => {};
    lastChild = child;
    return child;
  },
}));
vi.mock('child_process', () => ({
  spawn: () => {
    const child = new EventEmitter() as EventEmitter & { unref: () => void };
    child.unref = () => {};
    lastChild = child;
    return child;
  },
}));

import { checkVersionMismatch, spawnHeadlessBackend } from '../spawn-backend.js';
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

describe('spawnHeadlessBackend (async fail-fast)', () => {
  it('resolves true once the child emits "spawn"', async () => {
    const p = spawnHeadlessBackend(true);
    lastChild!.emit('spawn');
    await expect(p).resolves.toBe(true);
  });

  it('resolves FALSE on a spawn "error" (ENOENT) — no full boot-timeout wait', async () => {
    const p = spawnHeadlessBackend(true);
    lastChild!.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }));
    await expect(p).resolves.toBe(false);
  });

  it('settles only once (a later error after spawn does not flip the result)', async () => {
    const p = spawnHeadlessBackend(true);
    lastChild!.emit('spawn');
    lastChild!.emit('error', new Error('late'));
    await expect(p).resolves.toBe(true);
  });
});
