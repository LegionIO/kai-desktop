/**
 * Install guard (electron/local-bridge/install-guard.ts): the marker that makes
 * every Kai launch exit while ShipIt swaps the bundle, plus the ps parser that
 * picks which processes "Install and restart" terminates.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

let kaiHome: string;

beforeEach(() => {
  kaiHome = mkdtempSync(join(tmpdir(), 'kai-installguard-'));
  process.env.KAI_USER_DATA = kaiHome;
  vi.resetModules();
});
afterEach(() => {
  delete process.env.KAI_USER_DATA;
  rmSync(kaiHome, { recursive: true, force: true });
});

const load = () => import('../install-guard.js');

describe('install guard marker', () => {
  it('blocks other versions while fresh, never the version being installed', async () => {
    const g = await load();
    expect(g.isInstallGuardActive('1.0.0')).toBe(false);
    g.beginInstallGuard('1.0.1');
    expect(g.isInstallGuardActive('1.0.0')).toBe(true);
    expect(g.isInstallGuardActive('1.0.1')).toBe(false);
  });

  it('expires after the TTL so a failed install cannot lock Kai out', async () => {
    const g = await load();
    g.beginInstallGuard('1.0.1');
    expect(g.isInstallGuardActive('1.0.0', Date.now() + g.INSTALL_GUARD_TTL_MS + 1)).toBe(false);
  });

  it('clear removes it; a corrupt marker fails open', async () => {
    const g = await load();
    g.beginInstallGuard('1.0.1');
    g.clearInstallGuard();
    expect(g.isInstallGuardActive('1.0.0')).toBe(false);
    mkdirSync(join(kaiHome, 'run'), { recursive: true });
    writeFileSync(join(kaiHome, 'run', 'installing.json'), '{not json');
    expect(g.isInstallGuardActive('1.0.0')).toBe(false);
  });
});

describe('listOtherAppPids', () => {
  const exe = '/Applications/Kai.app/Contents/MacOS/Kai';
  const ps = [
    `  100 ${exe}`,
    `  200 ${exe}`,
    '  300 /Applications/Kai.app/Contents/Frameworks/Kai Helper (Renderer).app/Contents/MacOS/Kai Helper (Renderer)',
    '  400 /Applications/Kai Other.app/Contents/MacOS/Kai',
    '  500 /usr/bin/node',
    '',
  ].join('\n');

  it('matches only main processes of this exact executable, excluding itself', async () => {
    const g = await load();
    expect(g.listOtherAppPids(exe, 100, ps)).toEqual([200]);
  });
});
