/**
 * Tests for evaluateUpdateVerification (scripts/assert-update-verification.ts) —
 * the #17 guard that the auto-update trust anchor (code signature + publisher
 * pin) cannot silently regress in the shipped electron-builder config.
 */
import { describe, it, expect } from 'vitest';
import { evaluateUpdateVerification } from '../assert-update-verification.js';

// A config representing the intact posture: mac hardened+notarized, Windows
// publisher pinned, verification not disabled.
const GOOD = {
  mac: { hardenedRuntime: true, notarize: true },
  win: { publisherName: 'Some Publisher, Inc.' },
};

describe('evaluateUpdateVerification', () => {
  it('passes (no failures/warnings) for an intact config', () => {
    const { failures, warnings } = evaluateUpdateVerification(GOOD, true);
    expect(failures).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it('FAILS when Windows update signature verification is explicitly disabled', () => {
    const { failures } = evaluateUpdateVerification({
      ...GOOD,
      win: { ...GOOD.win, verifyUpdateCodeSignature: false },
    });
    expect(failures.join(' ')).toMatch(/verifyUpdateCodeSignature is false/);
  });

  it('FAILS a wildcarded or empty publisherName pin', () => {
    expect(evaluateUpdateVerification({ ...GOOD, win: { publisherName: '*' } }).failures.length).toBeGreaterThan(0);
    expect(evaluateUpdateVerification({ ...GOOD, win: { publisherName: '' } }).failures.length).toBeGreaterThan(0);
    expect(
      evaluateUpdateVerification({ ...GOOD, win: { publisherName: ['ok', '  '] } }).failures.length,
    ).toBeGreaterThan(0);
  });

  it('accepts a publisherName ARRAY of valid pins', () => {
    const { failures } = evaluateUpdateVerification({ ...GOOD, win: { publisherName: ['Pub A', 'Pub B'] } }, true);
    expect(failures).toEqual([]);
  });

  it('missing publisherName is a WARNING (not failure) when Windows is NOT shipping', () => {
    const { failures, warnings } = evaluateUpdateVerification({ mac: GOOD.mac, win: {} }, false);
    expect(failures).toEqual([]);
    expect(warnings.join(' ')).toMatch(/win\.publisherName is missing/);
  });

  it('missing publisherName is a FAILURE when Windows IS shipping', () => {
    const { failures } = evaluateUpdateVerification({ mac: GOOD.mac, win: {} }, true);
    expect(failures.join(' ')).toMatch(/win\.publisherName is missing/);
  });

  it('FAILS when macOS signing/notarization is disabled', () => {
    expect(evaluateUpdateVerification({ ...GOOD, mac: { hardenedRuntime: false } }).failures.join(' ')).toMatch(
      /hardenedRuntime is false/,
    );
    expect(evaluateUpdateVerification({ ...GOOD, mac: { ...GOOD.mac, notarize: false } }).failures.join(' ')).toMatch(
      /notarize is false/,
    );
    expect(
      evaluateUpdateVerification({ ...GOOD, mac: { ...GOOD.mac, forceCodeSigning: false } }).failures.join(' '),
    ).toMatch(/forceCodeSigning is false/);
  });

  it('does not fail on absent mac/win sections (treats undefined as not-disabled)', () => {
    // Only the publisher-missing warning (win off) — no signing failures from absent keys.
    const { failures } = evaluateUpdateVerification({}, false);
    expect(failures).toEqual([]);
  });
});
