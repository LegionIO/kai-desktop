/**
 * Tests for plugin-compat.ts — gates whether a plugin's declared engines.kai
 * semver range + required capabilities are satisfied by this host. A regression
 * either loads an incompatible plugin (crash/undefined-behavior) or rejects a
 * valid one. The host version is build-injected, so tests read it at runtime via
 * getHostPluginApiVersion() and build ranges relative to it (brand-agnostic).
 */
import { describe, it, expect } from 'vitest';
import { major, coerce } from 'semver';
import { checkPluginCompatibility, getHostPluginApiVersion, getHostCapabilities } from '../plugin-compat.js';
import type { PluginManifest } from '../types.js';

const HOST = getHostPluginApiVersion();
const HOST_MAJOR = major(coerce(HOST) ?? '0.0.0');
const CAPS = getHostCapabilities();

function manifest(overrides: Partial<PluginManifest> = {}): PluginManifest {
  return {
    name: 'p',
    displayName: 'P',
    version: '1.0.0',
    description: '',
    permissions: [],
    ...overrides,
  } as PluginManifest;
}

describe('checkPluginCompatibility', () => {
  it('treats a plugin with no engines and no capabilities as compatible', () => {
    const r = checkPluginCompatibility(manifest());
    expect(r.compatible).toBe(true);
    expect(r.errors).toEqual([]);
    expect(r.missingCapabilities).toEqual([]);
    expect(r.versionMismatch).toBeUndefined();
  });

  it('is compatible when the engines.kai range is satisfied', () => {
    const r = checkPluginCompatibility(manifest({ engines: { kai: `>=${HOST}` } }));
    expect(r.compatible).toBe(true);
    expect(r.versionMismatch).toBeUndefined();
  });

  it('accepts a caret range matching the host major', () => {
    const r = checkPluginCompatibility(manifest({ engines: { kai: `^${HOST_MAJOR}.0.0` } }));
    expect(r.compatible).toBe(true);
  });

  it('is incompatible when the engines.kai range cannot be satisfied', () => {
    const unreachable = `>=${HOST_MAJOR + 1}.0.0`;
    const r = checkPluginCompatibility(manifest({ engines: { kai: unreachable } }));
    expect(r.compatible).toBe(false);
    expect(r.versionMismatch).toEqual({ required: unreachable, actual: HOST });
    expect(r.errors.some((e) => e.includes('plugin API'))).toBe(true);
  });

  it('fails closed on an invalid semver range (semver.satisfies returns false, never throws)', () => {
    // NOTE: the module has a try/catch intending to downgrade an invalid range to
    // a warning, but semver.satisfies() returns false for garbage rather than
    // throwing — so an unparseable range is treated as an unsatisfiable constraint
    // (fail-closed). This test pins that actual behavior; the catch branch is
    // effectively dead with the current semver. If semver ever throws again, the
    // warning path revives and this test should flip to the warning assertion.
    const r = checkPluginCompatibility(manifest({ engines: { kai: 'not-a-range' } }));
    expect(r.compatible).toBe(false);
    expect(r.versionMismatch).toEqual({ required: 'not-a-range', actual: HOST });
  });

  it('is compatible when all required capabilities are present', () => {
    const r = checkPluginCompatibility(manifest({ capabilities: [CAPS[0], CAPS[1]] }));
    expect(r.compatible).toBe(true);
    expect(r.missingCapabilities).toEqual([]);
  });

  it('is incompatible when a required capability is missing', () => {
    const r = checkPluginCompatibility(manifest({ capabilities: [CAPS[0], 'totally:made-up'] }));
    expect(r.compatible).toBe(false);
    expect(r.missingCapabilities).toEqual(['totally:made-up']);
    expect(r.errors.some((e) => e.includes('Missing host capabilities'))).toBe(true);
  });

  it('accumulates both a version mismatch and a missing capability', () => {
    const unreachable = `>=${HOST_MAJOR + 1}.0.0`;
    const r = checkPluginCompatibility(manifest({ engines: { kai: unreachable }, capabilities: ['nope:cap'] }));
    expect(r.compatible).toBe(false);
    expect(r.versionMismatch?.required).toBe(unreachable);
    expect(r.missingCapabilities).toEqual(['nope:cap']);
    expect(r.errors.length).toBe(2);
  });

  it('ignores an empty capabilities array', () => {
    const r = checkPluginCompatibility(manifest({ capabilities: [] }));
    expect(r.compatible).toBe(true);
  });
});

describe('host introspection', () => {
  it('reports a non-empty plugin API version', () => {
    expect(typeof HOST).toBe('string');
    expect(HOST.length).toBeGreaterThan(0);
  });

  it('returns a non-empty capabilities list as a fresh array copy', () => {
    expect(CAPS.length).toBeGreaterThan(0);
    expect(getHostCapabilities()).not.toBe(getHostCapabilities()); // new array each call
    expect(CAPS).toContain('config:read');
  });
});
