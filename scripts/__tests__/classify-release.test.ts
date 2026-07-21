/**
 * Tests for comparePackages() in scripts/classify-release.ts — the pure OTA-
 * eligibility decision extracted from the release-classification script. It's
 * release-critical: a delta (OTA) update reuses the previously-shipped shell's
 * prebuilt native modules, so it is safe ONLY when Electron, every native dep,
 * and the Node engines requirement are unchanged. Misclassifying an Electron or
 * native-ABI bump as OTA-eligible would ship a bricked delta update. This locks
 * the rules + the minBaseVersion semantics (prev when eligible, current when a
 * full install is required).
 */
import { describe, it, expect } from 'vitest';
import { comparePackages } from '../classify-release.js';

type Pkg = Record<string, unknown>;
const pkg = (over: Pkg = {}): Pkg => ({
  version: '1.2.0',
  pluginProcessProtocolVersion: 1,
  dependencies: { 'better-sqlite3': '11.0.0', tiktoken: '1.0.0', '@lydell/node-pty': '1.0.0' },
  devDependencies: { electron: '32.0.0', esbuild: '0.23.0' },
  engines: { node: '>=22' },
  ...over,
});

describe('comparePackages — OTA eligible when nothing ABI-relevant changed', () => {
  it('identical native/electron/engines → OTA eligible, minBaseVersion = previous', () => {
    const prev = pkg({ version: '1.1.0' });
    const cur = pkg({ version: '1.2.0' });
    const r = comparePackages(cur, prev);
    expect(r.otaEligible).toBe(true);
    expect(r.reasons).toEqual([]);
    expect(r.minBaseVersion).toBe('1.1.0'); // prev shell is compatible
  });

  it('a pure JS-dependency change (non-native) stays OTA eligible', () => {
    const prev = pkg({ version: '1.1.0', dependencies: { ...(pkg().dependencies as Pkg), zod: '3.0.0' } });
    const cur = pkg({ version: '1.2.0', dependencies: { ...(pkg().dependencies as Pkg), zod: '3.1.0' } });
    const r = comparePackages(cur, prev);
    expect(r.otaEligible).toBe(true);
  });
});

describe('comparePackages — full update required (NOT OTA) when ABI changes', () => {
  it('Electron bump → not eligible, reason names Electron, minBaseVersion = current', () => {
    const prev = pkg({ version: '1.1.0' });
    const cur = pkg({ version: '1.2.0', devDependencies: { electron: '33.0.0', esbuild: '0.23.0' } });
    const r = comparePackages(cur, prev);
    expect(r.otaEligible).toBe(false);
    expect(r.reasons.some((x) => /Electron version changed/.test(x))).toBe(true);
    expect(r.minBaseVersion).toBe('1.2.0'); // requires a fresh install
  });

  it('a native dep bump (better-sqlite3) → not eligible', () => {
    const prev = pkg({ version: '1.1.0' });
    const cur = pkg({
      version: '1.2.0',
      dependencies: { 'better-sqlite3': '12.0.0', tiktoken: '1.0.0', '@lydell/node-pty': '1.0.0' },
    });
    const r = comparePackages(cur, prev);
    expect(r.otaEligible).toBe(false);
    expect(r.reasons.some((x) => /better-sqlite3 changed/.test(x))).toBe(true);
  });

  it('esbuild (listed native dep) bump → not eligible', () => {
    const prev = pkg({ version: '1.1.0' });
    const cur = pkg({ version: '1.2.0', devDependencies: { electron: '32.0.0', esbuild: '0.24.0' } });
    expect(comparePackages(cur, prev).otaEligible).toBe(false);
  });

  it('Node engines change → not eligible', () => {
    const prev = pkg({ version: '1.1.0' });
    const cur = pkg({ version: '1.2.0', engines: { node: '>=24' } });
    const r = comparePackages(cur, prev);
    expect(r.otaEligible).toBe(false);
    expect(r.reasons.some((x) => /Node engines changed/.test(x))).toBe(true);
  });

  it('plugin utility-process protocol change → not eligible', () => {
    const prev = pkg({ version: '1.1.0', pluginProcessProtocolVersion: undefined });
    const cur = pkg({ version: '1.2.0', pluginProcessProtocolVersion: 1 });
    const r = comparePackages(cur, prev);
    expect(r.otaEligible).toBe(false);
    expect(r.reasons.some((x) => /Plugin process protocol changed/.test(x))).toBe(true);
  });

  it('a native dep newly added (absent → present) → not eligible', () => {
    const prev = pkg({ version: '1.1.0', dependencies: { tiktoken: '1.0.0', '@lydell/node-pty': '1.0.0' } }); // no better-sqlite3
    const cur = pkg({ version: '1.2.0' });
    const r = comparePackages(cur, prev);
    expect(r.otaEligible).toBe(false);
    expect(r.reasons.some((x) => /better-sqlite3 changed.*\(none\)/.test(x))).toBe(true);
  });

  it('accumulates MULTIPLE reasons when several things change at once', () => {
    const prev = pkg({ version: '1.1.0' });
    const cur = pkg({
      version: '2.0.0',
      devDependencies: { electron: '33.0.0', esbuild: '0.24.0' },
      engines: { node: '>=24' },
    });
    const r = comparePackages(cur, prev);
    expect(r.otaEligible).toBe(false);
    expect(r.reasons.length).toBeGreaterThanOrEqual(3); // electron + esbuild + engines
  });
});

describe('comparePackages — resolves electron from either dep section', () => {
  it('treats electron in dependencies vs devDependencies equivalently (no false positive)', () => {
    const prev = pkg({
      version: '1.1.0',
      devDependencies: { esbuild: '0.23.0' },
      dependencies: { ...(pkg().dependencies as Pkg), electron: '32.0.0' },
    });
    const cur = pkg({
      version: '1.2.0',
      devDependencies: { esbuild: '0.23.0' },
      dependencies: { ...(pkg().dependencies as Pkg), electron: '32.0.0' },
    });
    expect(comparePackages(cur, prev).otaEligible).toBe(true);
  });
});
