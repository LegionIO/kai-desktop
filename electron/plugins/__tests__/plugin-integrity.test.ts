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
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync, truncateSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  hashPluginDirectory,
  hashPluginFile,
  getPluginIntegrity,
  arePermissionSetsEqual,
  approvalPermissionsMatch,
  isLegacyInferredBrowserPermissionSnapshot,
  MAX_PLUGIN_DIRECTORY_DEPTH,
  MAX_PLUGIN_FILE_BYTES,
  MAX_PLUGIN_RENDERER_ASSET_BYTES,
  readPluginManifest,
  snapshotPluginDirectory,
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

describe('hashPluginFile', () => {
  it('hashes exactly the backend bytes, independently of directory metadata', () => {
    write('backend.js', 'export function activate() {}');
    write('plugin.json', '{"name":"p"}');
    const backendHash = hashPluginFile(join(dir, 'backend.js'));
    expect(backendHash).toMatch(/^[0-9a-f]{64}$/);
    expect(backendHash).not.toBe(hashPluginDirectory(dir));
    write('plugin.json', '{"name":"p","version":"2"}');
    expect(hashPluginFile(join(dir, 'backend.js'))).toBe(backendHash);
  });

  it('rejects symbolic links and oversized files at the final file-open boundary', () => {
    const target = join(dir, 'target.js');
    writeFileSync(target, 'host data');
    const linked = join(dir, 'linked.js');
    try {
      symlinkSync(target, linked);
    } catch {
      return;
    }
    expect(() => hashPluginFile(linked)).toThrow(/regular file|symbolic links/i);

    const oversized = join(dir, 'oversized.js');
    writeFileSync(oversized, '');
    truncateSync(oversized, MAX_PLUGIN_FILE_BYTES + 1);
    expect(() => hashPluginFile(oversized)).toThrow(/file exceeds/i);
  });
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

  it('bounds directory depth and rejects oversized files before reading them', () => {
    let nested = dir;
    for (let index = 0; index <= MAX_PLUGIN_DIRECTORY_DEPTH; index++) {
      nested = join(nested, `d${index}`);
      mkdirSync(nested);
    }
    writeFileSync(join(nested, 'too-deep.js'), 'x');
    expect(() => hashPluginDirectory(dir)).toThrow(/maximum depth/i);

    rmSync(join(dir, 'd0'), { recursive: true, force: true });
    const oversized = join(dir, 'oversized.bin');
    writeFileSync(oversized, '');
    truncateSync(oversized, MAX_PLUGIN_FILE_BYTES + 1);
    expect(() => hashPluginDirectory(dir)).toThrow(/file exceeds/i);
  });
});

describe('snapshotPluginDirectory', () => {
  it('does not apply renderer capture limits to backend-only plugin assets', () => {
    write('backend.js', 'export function activate() {}');
    write('plugin.json', JSON.stringify({ name: 'backend-only-plugin' }));
    const backendAsset = join(dir, 'backend-model.bin');
    writeFileSync(backendAsset, '');
    truncateSync(backendAsset, MAX_PLUGIN_RENDERER_ASSET_BYTES + 1);

    const snapshot = snapshotPluginDirectory(dir);

    expect(snapshot.fileHash).toBe(hashPluginDirectory(dir));
    expect([...snapshot.files]).toEqual([]);
  });

  it('hashes the complete plugin and retains renderer-safe plugin-local dependencies', () => {
    write('frontend.js', "import './render.js';");
    write('render.js', 'export const render = true;');
    write('styles/panel.css', '.panel {}');
    write('assets/report.csv', 'name,value');
    write('assets/catalog', 'extensionless-data');
    write('backend.js', 'export const secretBackend = true;');
    write('plugin.json', JSON.stringify({ name: 'bounded-plugin' }));
    write('frontend.js.map', '{}');
    write('node_modules/dependency/index.js', 'export const dependency = true;');

    const snapshot = snapshotPluginDirectory(dir);

    expect(snapshot.fileHash).toBe(hashPluginDirectory(dir));
    expect([...snapshot.files.keys()]).toEqual([
      'assets/catalog',
      'assets/report.csv',
      'frontend.js',
      'frontend.js.map',
      'node_modules/dependency/index.js',
      'render.js',
      'styles/panel.css',
    ]);
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

describe('approvalPermissionsMatch', () => {
  it('requires explicit re-consent when a legacy approval gains authenticated Browser access', () => {
    expect(approvalPermissionsMatch(undefined, ['browser:authenticated-session'])).toBe(false);
    expect(approvalPermissionsMatch(undefined, ['config:read'])).toBe(true);
    expect(
      approvalPermissionsMatch(
        ['config:read', 'browser:authenticated-session'],
        ['browser:authenticated-session', 'config:read'],
      ),
    ).toBe(true);
  });
});

describe('isLegacyInferredBrowserPermissionSnapshot', () => {
  it('accepts only the exact host-inferred Browser permission delta', () => {
    const current = ['ui:panel', 'browser:authenticated-session'];
    expect(isLegacyInferredBrowserPermissionSnapshot(['ui:panel'], current)).toBe(true);
    expect(isLegacyInferredBrowserPermissionSnapshot(undefined, current)).toBe(false);
    expect(isLegacyInferredBrowserPermissionSnapshot(['ui:panel', 'config:read'], current)).toBe(false);
    expect(isLegacyInferredBrowserPermissionSnapshot(current, current)).toBe(false);
    expect(isLegacyInferredBrowserPermissionSnapshot(['ui:panel'], ['ui:panel'])).toBe(false);
  });
});

describe('readPluginManifest execScope parsing', () => {
  it('does not follow a symbolic-link manifest', () => {
    const target = join(dir, 'manifest-target.json');
    writeFileSync(target, JSON.stringify({ name: 'outside' }));
    try {
      symlinkSync(target, join(dir, 'plugin.json'));
    } catch {
      return;
    }
    expect(() => readPluginManifest(dir)).toThrow(/regular file|symbolic links/i);
  });

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

  it('requires elevated consent for frontend modules that share the privileged renderer', () => {
    write('plugin.json', JSON.stringify({ name: 'p', version: '1.0.0', permissions: ['ui:panel'] }));
    write('frontend.js', 'export const panel = true;');

    expect(readPluginManifest(dir).permissions).toEqual(['ui:panel']);
    expect(getPluginIntegrity(dir).permissions).toEqual(['ui:panel', 'browser:authenticated-session']);
  });
});
