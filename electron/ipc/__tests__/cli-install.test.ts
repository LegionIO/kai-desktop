/**
 * Unit tests for the in-app "Install `kai` command" logic (POSIX path).
 * Mocks electron `app` (packaged) + os.homedir into a tmpdir so no real
 * ~/.local/bin is touched. Windows copy+PATH is validated manually, not here.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, lstatSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type * as NodeOs from 'node:os';
import { join } from 'node:path';

let tmpHome: string;

// electron `app`: packaged so appBinaryPath() resolves to process.execPath.
vi.mock('electron', () => ({ app: { isPackaged: true, getAppPath: () => '/unused' } }));

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof NodeOs>('os');
  return { ...actual, homedir: () => tmpHome };
});
vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof NodeOs>('node:os');
  return { ...actual, homedir: () => tmpHome };
});

import { getCliInstallStatus, installCliCommand, uninstallCliCommand } from '../cli-install.js';

const DEST = () => join(tmpHome, '.local', 'bin', 'kai');

beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), 'kai-cli-install-'));
  tmpHome = join(base, 'home');
  mkdirSync(tmpHome, { recursive: true });
});

afterEach(() => {
  try {
    rmSync(join(tmpHome, '..'), { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('cli-install (POSIX)', () => {
  it('reports not-installed before install', () => {
    const status = getCliInstallStatus();
    expect(status.installed).toBe(false);
    expect(status.conflict).toBeUndefined();
  });

  it('install writes a managed wrapper that bakes in the app binary path', () => {
    const status = installCliCommand();
    expect(status.installed).toBe(true);
    expect(existsSync(DEST())).toBe(true);
    // It's a regular file (wrapper), executable, carrying the managed marker +
    // the app binary path (process.execPath under the test runner).
    expect(lstatSync(DEST()).isFile()).toBe(true);
    const body = readFileSync(DEST(), 'utf-8');
    expect(body).toContain('KAI_MANAGED_CLI_WRAPPER');
    expect(body).toContain(process.execPath);
    expect(body).toContain('--kai-cli');
    expect(getCliInstallStatus().installed).toBe(true);
  });

  it('refuses to overwrite / claim an unrelated non-Kai file (conflict)', () => {
    mkdirSync(join(tmpHome, '.local', 'bin'), { recursive: true });
    writeFileSync(DEST(), '#!/bin/sh\necho not kai\n');
    expect(getCliInstallStatus().conflict).toBe(true);
    expect(getCliInstallStatus().installed).toBe(false);
    const res = installCliCommand();
    expect(res.installed).toBe(false);
    expect(res.conflict).toBe(true);
    // The foreign file must be untouched.
    expect(readFileSync(DEST(), 'utf-8')).toContain('not kai');
  });

  it('install is idempotent (rewrites the managed wrapper)', () => {
    installCliCommand();
    const second = installCliCommand();
    expect(second.installed).toBe(true);
  });

  it('appends a managed PATH block to a shell rc exactly once, removed on uninstall', () => {
    process.env.SHELL = '/bin/zsh';
    installCliCommand();
    installCliCommand();
    const rc = join(tmpHome, '.zshrc');
    const body = readFileSync(rc, 'utf-8');
    expect((body.match(/added by Kai/g) ?? []).length).toBe(1);
    uninstallCliCommand();
    expect(readFileSync(rc, 'utf-8')).not.toContain('added by Kai');
  });

  it('uninstall removes only a managed wrapper', () => {
    installCliCommand();
    const status = uninstallCliCommand();
    expect(status.installed).toBe(false);
    expect(existsSync(DEST())).toBe(false);
  });

  it('uninstall refuses to remove an unrelated file', () => {
    mkdirSync(join(tmpHome, '.local', 'bin'), { recursive: true });
    writeFileSync(DEST(), 'foreign\n');
    const res = uninstallCliCommand();
    expect(res.conflict).toBe(true);
    expect(existsSync(DEST())).toBe(true);
  });
});
