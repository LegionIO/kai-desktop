/**
 * Example-based tests for plugin-integrity.ts. manifest.property.test.ts already
 * covers readPluginManifest with fast-check invariants; this file locks the
 * security-relevant behaviors it does not exercise:
 *   - hashPluginDirectory: determinism, settings.json exclusion, symlink refusal
 *     (a plugin dir must not follow a symlink out of its tree), change detection.
 *   - arePermissionSetsEqual: order independence + the duplicate-in-left edge.
 *   - parseExecScope (via readPluginManifest): binary allowlist filtering.
 *   - getPluginIntegrity: the hash + permissions + version combination.
 * Real temp dirs back the fs layer.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  hashPluginDirectory,
  getPluginIntegrity,
  arePermissionSetsEqual,
  readPluginManifest,
} from '../plugin-integrity.js';

let dir: string;
const write = (rel: string, content: string) => {
  const full = join(dir, rel);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content, 'utf-8');
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kai-pintegrity-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('hashPluginDirectory', () => {
  it('is deterministic for identical content', () => {
    write('plugin.json', '{"name":"p"}');
    write('index.js', 'console.log(1)');
    const h1 = hashPluginDirectory(dir);
    const h2 = hashPluginDirectory(dir);
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });

  it('excludes settings.json from the hash (user config must not affect integrity)', () => {
    write('plugin.json', '{"name":"p"}');
    const before = hashPluginDirectory(dir);
    write('settings.json', '{"userKey":"secret"}');
    expect(hashPluginDirectory(dir)).toBe(before);
  });

  it('changes when a hashed file’s content changes', () => {
    write('plugin.json', '{"name":"p"}');
    write('index.js', 'v1');
    const before = hashPluginDirectory(dir);
    write('index.js', 'v2');
    expect(hashPluginDirectory(dir)).not.toBe(before);
  });

  it('changes when a file is renamed (path is folded into the hash)', () => {
    write('plugin.json', '{"name":"p"}');
    write('a.js', 'same');
    const withA = hashPluginDirectory(dir);
    rmSync(join(dir, 'a.js'));
    write('b.js', 'same');
    expect(hashPluginDirectory(dir)).not.toBe(withA);
  });

  it('recurses into subdirectories', () => {
    write('plugin.json', '{"name":"p"}');
    const before = hashPluginDirectory(dir);
    write('nested/deep/file.js', 'x');
    expect(hashPluginDirectory(dir)).not.toBe(before);
  });

  it('throws when the directory contains a symbolic link', () => {
    write('plugin.json', '{"name":"p"}');
    const target = mkdtempSync(join(tmpdir(), 'kai-pintegrity-target-'));
    try {
      symlinkSync(target, join(dir, 'link'));
    } catch {
      // Some CI environments disallow symlink creation; skip if so.
      return;
    }
    expect(() => hashPluginDirectory(dir)).toThrow(/Symbolic links are not allowed/);
    rmSync(target, { recursive: true, force: true });
  });
});

describe('arePermissionSetsEqual', () => {
  it('is true for the same permissions in any order', () => {
    expect(arePermissionSetsEqual(['a', 'b', 'c'], ['c', 'a', 'b'])).toBe(true);
  });

  it('is false for different permissions', () => {
    expect(arePermissionSetsEqual(['a', 'b'], ['a', 'c'])).toBe(false);
  });

  it('is false when lengths differ', () => {
    expect(arePermissionSetsEqual(['a'], ['a', 'b'])).toBe(false);
  });

  it('handles the duplicate-in-left edge: same length but left has a repeat', () => {
    // left=[a,a] right=[a,b]: lengths match (2), but leftSet size (1) !== right.length (2) → false.
    expect(arePermissionSetsEqual(['a', 'a'], ['a', 'b'])).toBe(false);
  });

  it('treats missing arguments as empty sets (equal)', () => {
    expect(arePermissionSetsEqual()).toBe(true);
    expect(arePermissionSetsEqual([], [])).toBe(true);
    expect(arePermissionSetsEqual(['a'], [])).toBe(false);
  });
});

describe('readPluginManifest execScope parsing', () => {
  it('keeps only allowlisted binaries and drops unknown ones', () => {
    write('plugin.json', JSON.stringify({ name: 'p', execScope: { binaries: ['node', 'rm', 'git', 'curl'] } }));
    const manifest = readPluginManifest(dir);
    expect(manifest.execScope?.binaries).toEqual(['node', 'git']); // rm, curl rejected
  });

  it('returns undefined execScope when no valid binary remains', () => {
    write('plugin.json', JSON.stringify({ name: 'p', execScope: { binaries: ['rm', 'curl'] } }));
    expect(readPluginManifest(dir).execScope).toBeUndefined();
  });

  it('coerces argPatterns and drops empty pattern lists', () => {
    write(
      'plugin.json',
      JSON.stringify({
        name: 'p',
        execScope: { binaries: ['git'], argPatterns: { git: ['^status$', 123], node: [] } },
      }),
    );
    const scope = readPluginManifest(dir).execScope;
    expect(scope?.argPatterns).toEqual({ git: ['^status$'] }); // non-string filtered, empty 'node' dropped
  });

  it('filters permissions to strings and defaults version', () => {
    write('plugin.json', JSON.stringify({ name: 'p', permissions: ['fs', 42, 'net'] }));
    const m = readPluginManifest(dir);
    expect(m.permissions).toEqual(['fs', 'net']);
    expect(m.version).toBe('0.0.0'); // default
  });
});

describe('getPluginIntegrity', () => {
  it('combines the directory hash, manifest permissions, and version', () => {
    write('plugin.json', JSON.stringify({ name: 'p', version: '1.4.2', permissions: ['fs', 'net'] }));
    write('index.js', 'code');
    const integrity = getPluginIntegrity(dir);
    expect(integrity.fileHash).toBe(hashPluginDirectory(dir));
    expect(integrity.permissions).toEqual(['fs', 'net']);
    expect(integrity.version).toBe('1.4.2');
  });
});
