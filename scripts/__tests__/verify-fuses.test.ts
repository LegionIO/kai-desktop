/**
 * Tests for evaluateFuses() in scripts/verify-fuses.ts — the pure, security-
 * load-bearing decision extracted from the Electron-fuses CI gate. Fuses are
 * bits flipped into the shipped binary that disable runtime escape hatches
 * (RunAsNode, NODE_OPTIONS injection, --inspect, loose-asar load, etc.). This
 * gate must FAIL the build when any required fuse is at the wrong value; a bug
 * that let a mis-fused (insecure) binary pass CI is exactly what these tests
 * guard. Byte values mirror @electron/fuses' FuseState: DISABLE=48, ENABLE=49,
 * INHERIT=144, REMOVED=114.
 */
import { describe, it, expect } from 'vitest';
import { FuseV1Options } from '@electron/fuses';
import { evaluateFuses } from '../verify-fuses.js';

const DISABLE = 48;
const ENABLE = 49;
const INHERIT = 144;
const REMOVED = 114;

// A fully-correct wire per the EXPECTED table: the two "must be true" fuses
// ENABLED, the four "must be false" fuses DISABLED.
const goodWire = (): Record<number, number | undefined> => ({
  [FuseV1Options.RunAsNode]: DISABLE, // want false
  [FuseV1Options.EnableCookieEncryption]: ENABLE, // want true
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: DISABLE, // want false
  [FuseV1Options.EnableNodeCliInspectArguments]: DISABLE, // want false
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: ENABLE, // want true
  [FuseV1Options.OnlyLoadAppFromAsar]: ENABLE, // want true
});

describe('evaluateFuses — passes only a fully-correct wire', () => {
  it('returns no failures when every required fuse is at its expected value', () => {
    expect(evaluateFuses(goodWire())).toEqual([]);
  });
});

describe('evaluateFuses — fails an insecure fuse', () => {
  it('flags RunAsNode when it is ENABLED (the ELECTRON_RUN_AS_NODE escape hatch left open)', () => {
    const wire = goodWire();
    wire[FuseV1Options.RunAsNode] = ENABLE; // wrong: should be DISABLE
    const failures = evaluateFuses(wire);
    expect(failures.length).toBe(1);
    expect(failures[0]).toMatch(/RunAsNode: expected DISABLE \(false\), got ENABLE \(true\)/);
  });

  it('flags cookie encryption when it is DISABLED', () => {
    const wire = goodWire();
    wire[FuseV1Options.EnableCookieEncryption] = DISABLE; // wrong: should be ENABLE
    expect(evaluateFuses(wire).some((f) => /EnableCookieEncryption: expected ENABLE/.test(f))).toBe(true);
  });

  it('treats a MISSING fuse (undefined) as a failure, not a pass', () => {
    const wire = goodWire();
    delete wire[FuseV1Options.OnlyLoadAppFromAsar];
    expect(evaluateFuses(wire).some((f) => /OnlyLoadAppFromAsar.*UNDEFINED/.test(f))).toBe(true);
  });

  it('treats INHERIT / REMOVED as a failure (not a hard ENABLE/DISABLE)', () => {
    const inheritWire = goodWire();
    inheritWire[FuseV1Options.EnableEmbeddedAsarIntegrityValidation] = INHERIT;
    expect(evaluateFuses(inheritWire).some((f) => /INHERIT/.test(f))).toBe(true);

    const removedWire = goodWire();
    removedWire[FuseV1Options.RunAsNode] = REMOVED;
    expect(evaluateFuses(removedWire).some((f) => /REMOVED/.test(f))).toBe(true);
  });

  it('accumulates one failure line per wrong fuse', () => {
    const wire = goodWire();
    wire[FuseV1Options.RunAsNode] = ENABLE;
    wire[FuseV1Options.EnableNodeCliInspectArguments] = ENABLE;
    delete wire[FuseV1Options.EnableCookieEncryption];
    expect(evaluateFuses(wire).length).toBe(3);
  });
});

describe('evaluateFuses — fails loud on an unrecognized byte', () => {
  it('throws when a fuse reports a byte outside the known FuseState set', () => {
    const wire = goodWire();
    wire[FuseV1Options.RunAsNode] = 0x7f; // not DISABLE/ENABLE/INHERIT/REMOVED
    expect(() => evaluateFuses(wire)).toThrow(/unknown byte/i);
  });
});
