/**
 * Unit tests for the in-app "Install `kai` command" logic (POSIX path).
 * Mocks electron `app` + os.homedir into a tmpdir so no real ~/.local/bin or
 * app bundle is touched. Windows-specific behavior (copy + PATH edit) isn't
 * exercised here — it's validated manually on Windows.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  lstatSync,
  readlinkSync,
  readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import type * as NodeOs from 'node:os';
import { join } from 'node:path';

let tmpHome: string;
let appRoot: string;

// electron `app`: unpackaged (dev), getAppPath → our fake repo root with bin/kai.
vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => appRoot,
  },
}));

// Redirect homedir → tmp so the install target (~/.local/bin) is sandboxed.
vi.mock('os', async () => {
  const actual = await vi.importActual<typeof NodeOs>('os');
  return { ...actual, homedir: () => tmpHome };
});
vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof NodeOs>('node:os');
  return { ...actual, homedir: () => tmpHome };
});

import { getCliInstallStatus, installCliCommand, uninstallCliCommand } from '../cli-install.js';

beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), 'kai-cli-install-'));
  tmpHome = join(base, 'home');
  appRoot = join(base, 'app');
  mkdirSync(tmpHome, { recursive: true });
  mkdirSync(join(appRoot, 'bin'), { recursive: true });
  // Fake shipped launcher in the (dev) repo bin/.
  writeFileSync(join(appRoot, 'bin', 'kai'), '#!/bin/sh\necho kai\n', { mode: 0o755 });
});

afterEach(() => {
  try {
    rmSync(join(tmpHome, '..'), { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('cli-install (POSIX)', () => {
  it('reports not-installed before install, with a resolvable source', () => {
    const status = getCliInstallStatus();
    expect(status.installed).toBe(false);
    expect(status.source).toBe(join(appRoot, 'bin', 'kai'));
  });

  it('install creates a symlink to the shipped shim and reports installed', () => {
    const status = installCliCommand();
    expect(status.installed).toBe(true);
    const dest = join(tmpHome, '.local', 'bin', 'kai');
    expect(existsSync(dest)).toBe(true);
    expect(lstatSync(dest).isSymbolicLink()).toBe(true);
    expect(readlinkSync(dest)).toBe(join(appRoot, 'bin', 'kai'));
    expect(getCliInstallStatus().installed).toBe(true);
  });

  it('install is idempotent (re-install replaces the link)', () => {
    installCliCommand();
    const second = installCliCommand();
    expect(second.installed).toBe(true);
  });

  it('appends a PATH line to a shell rc exactly once', () => {
    // Provide a .bashrc so ensurePosixPath has a target.
    writeFileSync(join(tmpHome, '.bashrc'), '# existing\n');
    installCliCommand();
    installCliCommand(); // second run must not double-append
    const rc = readFileSync(join(tmpHome, '.bashrc'), 'utf-8');
    const markerCount = (rc.match(/added by Kai/g) ?? []).length;
    expect(markerCount).toBe(1);
  });

  it('uninstall removes the command', () => {
    installCliCommand();
    const status = uninstallCliCommand();
    expect(status.installed).toBe(false);
    expect(existsSync(join(tmpHome, '.local', 'bin', 'kai'))).toBe(false);
  });

  it('install fails cleanly when the shim source is missing', () => {
    rmSync(join(appRoot, 'bin', 'kai'));
    const status = installCliCommand();
    expect(status.installed).toBe(false);
    expect(status.error).toMatch(/not found/i);
  });
});
