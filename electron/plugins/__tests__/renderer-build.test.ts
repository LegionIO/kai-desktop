/**
 * Tests for renderer-build.ts (electron/plugins/renderer-build.ts) — builds the
 * plugin-renderer:// URLs + descriptor served to the renderer for a plugin's
 * frontend entry. The URL encoding is security-relevant: a plugin name or path
 * segment must be percent-encoded so it can't manipulate the served URL. (The
 * full esbuild compile lives elsewhere; this module points at the entry file.)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  assertActivePluginRendererBudget,
  buildPluginRendererBundle,
  MAX_ACTIVE_PLUGIN_RENDERER_BYTES,
  resolvePluginRendererRequest,
  PLUGIN_RENDERER_PROTOCOL,
} from '../renderer-build.js';
import type { PluginRendererBuild } from '../types.js';
import { snapshotPluginDirectory } from '../plugin-integrity.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kai-renderer-build-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const writeEntry = (rel: string) => {
  const full = join(dir, rel);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, 'export default {}');
  return full;
};

describe('buildPluginRendererBundle', () => {
  it('enforces a process-wide budget across active immutable renderer assets', () => {
    const fakeBuild = (bytes: number) =>
      ({ assets: new Map([['asset.bin', { byteLength: bytes } as Uint8Array]]) }) as unknown as PluginRendererBuild;
    const active = [fakeBuild(MAX_ACTIVE_PLUGIN_RENDERER_BYTES / 2), fakeBuild(MAX_ACTIVE_PLUGIN_RENDERER_BYTES / 4)];

    expect(() =>
      assertActivePluginRendererBudget(active, fakeBuild(MAX_ACTIVE_PLUGIN_RENDERER_BYTES / 4)),
    ).not.toThrow();
    expect(() => assertActivePluginRendererBudget(active, fakeBuild(MAX_ACTIVE_PLUGIN_RENDERER_BYTES / 4 + 1))).toThrow(
      /process limit/,
    );
    expect(() =>
      assertActivePluginRendererBudget(
        [fakeBuild(MAX_ACTIVE_PLUGIN_RENDERER_BYTES / 2)],
        fakeBuild(MAX_ACTIVE_PLUGIN_RENDERER_BYTES / 4),
        MAX_ACTIVE_PLUGIN_RENDERER_BYTES / 4 + 1,
      ),
    ).toThrow(/process limit/);
  });

  it('throws when the renderer entry point does not exist', () => {
    expect(() =>
      buildPluginRendererBundle({
        pluginName: 'p',
        pluginDir: dir,
        rendererPath: 'missing/entry.js',
        snapshot: snapshotPluginDirectory(dir, 'missing/entry.js'),
      }),
    ).toThrow(/renderer entry point not found/i);
  });

  it('returns the expected descriptor shape for a valid entry', () => {
    const full = writeEntry('dist/frontend.js');
    const build = buildPluginRendererBundle({
      pluginName: 'my-plugin',
      pluginDir: dir,
      rendererPath: 'dist/frontend.js',
      snapshot: snapshotPluginDirectory(dir, 'dist/frontend.js'),
    });
    expect(build.pluginName).toBe('my-plugin');
    expect(build.pluginDir).toBe(dir);
    expect(build.entryPath).toBe('dist/frontend.js');
    expect(build.scripts).toHaveLength(1);
    expect(build.scripts[0].scriptPath).toBe(full);
    expect(build.scripts[0].entryUrl).toBe(build.entryUrl);
    expect(build.mimeTypes['dist/frontend.js']).toMatch(/text\/javascript/);
    expect(build.styles).toEqual([]);
    expect(Buffer.from(build.assets.get('dist/frontend.js') ?? []).toString('utf8')).toBe('export default {}');
  });

  it('builds a plugin-renderer:// entryUrl with the plugin name + path segments encoded', () => {
    writeEntry('dist/frontend.js');
    const build = buildPluginRendererBundle({
      pluginName: 'my-plugin',
      pluginDir: dir,
      rendererPath: 'dist/frontend.js',
      snapshot: snapshotPluginDirectory(dir, 'dist/frontend.js'),
    });
    expect(build.entryUrl).toBe(`${PLUGIN_RENDERER_PROTOCOL}://my-plugin/dist/frontend.js`);
  });

  it('percent-encodes a plugin name / path segment with special chars (no URL manipulation)', () => {
    writeEntry('a b/c#d.js');
    const build = buildPluginRendererBundle({
      pluginName: 'weird name',
      pluginDir: dir,
      rendererPath: 'a b/c#d.js',
      snapshot: snapshotPluginDirectory(dir, 'a b/c#d.js'),
    });
    // Space in the name → %20; '#' in a segment → %23; the '/' separator is preserved.
    expect(build.entryUrl).toBe(`${PLUGIN_RENDERER_PROTOCOL}://weird%20name/a%20b/c%23d.js`);
    expect(build.entryUrl).not.toContain('#'); // the fragment char is encoded, can't split the URL
    expect(build.entryUrl).not.toContain(' ');
  });

  it('serves only the immutable bytes captured before backend activation', () => {
    const full = writeEntry('frontend.js');
    const snapshot = snapshotPluginDirectory(dir);
    writeFileSync(full, 'export default { compromised: true }');

    const build = buildPluginRendererBundle({
      pluginName: 'approved-plugin',
      pluginDir: dir,
      rendererPath: 'frontend.js',
      snapshot,
    });

    expect(Buffer.from(build.assets.get('frontend.js') ?? []).toString('utf8')).toBe('export default {}');
  });

  it('serves immutable plugin-local renderer dependencies from node_modules', () => {
    const dependencyPath = writeEntry('node_modules/dependency/index.js');
    writeFileSync(join(dir, 'frontend.js'), "import './node_modules/dependency/index.js';");
    const snapshot = snapshotPluginDirectory(dir);
    writeFileSync(dependencyPath, 'export default { compromised: true }');

    const build = buildPluginRendererBundle({
      pluginName: 'dependency-plugin',
      pluginDir: dir,
      rendererPath: 'frontend.js',
      snapshot,
    });

    expect(build.mimeTypes['node_modules/dependency/index.js']).toBe('text/javascript; charset=utf-8');
    expect(Buffer.from(build.assets.get('node_modules/dependency/index.js') ?? []).toString('utf8')).toBe(
      'export default {}',
    );
  });

  it('records browser-compatible MIME types for every captured asset class', () => {
    writeEntry('frontend.js');
    for (const asset of [
      'chunk.mjs',
      'module.wasm',
      'icon.svg',
      'font.woff2',
      'image.avif',
      'copy.txt',
      'report.csv',
      'catalog',
    ]) {
      writeFileSync(join(dir, asset), 'asset');
    }

    const build = buildPluginRendererBundle({
      pluginName: 'asset-plugin',
      pluginDir: dir,
      rendererPath: 'frontend.js',
      snapshot: snapshotPluginDirectory(dir),
    });

    expect(build.mimeTypes).toMatchObject({
      'frontend.js': 'text/javascript; charset=utf-8',
      'chunk.mjs': 'text/javascript; charset=utf-8',
      'module.wasm': 'application/wasm',
      'icon.svg': 'image/svg+xml',
      'font.woff2': 'font/woff2',
      'image.avif': 'image/avif',
      'copy.txt': 'text/plain; charset=utf-8',
      'report.csv': 'application/octet-stream',
      catalog: 'application/octet-stream',
    });
  });

  it('does not accept a frontend created after the approved snapshot', () => {
    const snapshot = snapshotPluginDirectory(dir);
    writeEntry('frontend.js');

    expect(() =>
      buildPluginRendererBundle({
        pluginName: 'backend-created-frontend',
        pluginDir: dir,
        rendererPath: 'frontend.js',
        snapshot,
      }),
    ).toThrow(/renderer entry point not found/i);
  });
});

describe('resolvePluginRendererRequest', () => {
  it('is a stub that returns null', () => {
    expect(resolvePluginRendererRequest({})).toBeNull();
    expect(resolvePluginRendererRequest(undefined)).toBeNull();
  });
});
