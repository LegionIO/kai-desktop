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
  buildPluginRendererBundle,
  resolvePluginRendererRequest,
  PLUGIN_RENDERER_PROTOCOL,
} from '../renderer-build.js';

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
  it('throws when the renderer entry point does not exist', () => {
    expect(() =>
      buildPluginRendererBundle({ pluginName: 'p', pluginDir: dir, rendererPath: 'missing/entry.js' }),
    ).toThrow(/renderer entry point not found/i);
  });

  it('returns the expected descriptor shape for a valid entry', () => {
    const full = writeEntry('dist/frontend.js');
    const build = buildPluginRendererBundle({
      pluginName: 'my-plugin',
      pluginDir: dir,
      rendererPath: 'dist/frontend.js',
    });
    expect(build.pluginName).toBe('my-plugin');
    expect(build.pluginDir).toBe(dir);
    expect(build.entryPath).toBe('dist/frontend.js');
    expect(build.scripts).toHaveLength(1);
    expect(build.scripts[0].scriptPath).toBe(full);
    expect(build.scripts[0].entryUrl).toBe(build.entryUrl);
    expect(build.mimeTypes['dist/frontend.js']).toMatch(/text\/javascript/);
    expect(build.styles).toEqual([]);
  });

  it('builds a plugin-renderer:// entryUrl with the plugin name + path segments encoded', () => {
    writeEntry('dist/frontend.js');
    const build = buildPluginRendererBundle({
      pluginName: 'my-plugin',
      pluginDir: dir,
      rendererPath: 'dist/frontend.js',
    });
    expect(build.entryUrl).toBe(`${PLUGIN_RENDERER_PROTOCOL}://my-plugin/dist/frontend.js`);
  });

  it('percent-encodes a plugin name / path segment with special chars (no URL manipulation)', () => {
    writeEntry('a b/c#d.js');
    const build = buildPluginRendererBundle({ pluginName: 'weird name', pluginDir: dir, rendererPath: 'a b/c#d.js' });
    // Space in the name → %20; '#' in a segment → %23; the '/' separator is preserved.
    expect(build.entryUrl).toBe(`${PLUGIN_RENDERER_PROTOCOL}://weird%20name/a%20b/c%23d.js`);
    expect(build.entryUrl).not.toContain('#'); // the fragment char is encoded, can't split the URL
    expect(build.entryUrl).not.toContain(' ');
  });
});

describe('resolvePluginRendererRequest', () => {
  it('is a stub that returns null', () => {
    expect(resolvePluginRendererRequest({})).toBeNull();
    expect(resolvePluginRendererRequest(undefined)).toBeNull();
  });
});
