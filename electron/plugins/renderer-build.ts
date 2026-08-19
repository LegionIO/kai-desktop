import { createHash } from 'node:crypto';
import { extname, join } from 'path';
import type { PluginRendererBuild, PluginRendererScript } from './types.js';
import type { PluginDirectorySnapshot } from './plugin-integrity.js';

export const PLUGIN_RENDERER_PROTOCOL = 'plugin-renderer';
export const MAX_ACTIVE_PLUGIN_RENDERER_BYTES = 128 * 1024 * 1024;

export function pluginRendererBuildBytes(build: PluginRendererBuild): number {
  let total = 0;
  for (const asset of build.assets.values()) total += asset.byteLength;
  return total;
}

export function assertActivePluginRendererBudget(
  activeBuilds: Iterable<PluginRendererBuild>,
  candidate: PluginRendererBuild,
  reservedBytes = 0,
): void {
  let total = reservedBytes + pluginRendererBuildBytes(candidate);
  for (const build of activeBuilds) total += pluginRendererBuildBytes(build);
  if (total > MAX_ACTIVE_PLUGIN_RENDERER_BYTES) {
    throw new Error(
      `Active plugin renderer assets exceed the ${MAX_ACTIVE_PLUGIN_RENDERER_BYTES} byte process limit. Disable another frontend plugin and retry.`,
    );
  }
}

const PLUGIN_RENDERER_MIME_TYPES: Readonly<Record<string, string>> = {
  '.avif': 'image/avif',
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.htm': 'text/html; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.ogg': 'audio/ogg',
  '.otf': 'font/otf',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  '.webm': 'video/webm',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

export function pluginRendererContentType(relativePath: string): string {
  return PLUGIN_RENDERER_MIME_TYPES[extname(relativePath).toLowerCase()] ?? 'application/octet-stream';
}

function rendererBuildUrl(pluginName: string, relativePath: string): string {
  return `${PLUGIN_RENDERER_PROTOCOL}://${encodeURIComponent(pluginName)}/${relativePath.split('/').map(encodeURIComponent).join('/')}`;
}

export function buildPluginRendererBundle(options: {
  pluginName: string;
  pluginDir: string;
  rendererPath: string;
  snapshot: PluginDirectorySnapshot;
}): PluginRendererBuild {
  const entryFullPath = join(options.pluginDir, options.rendererPath);
  const entryBytes = options.snapshot.files.get(options.rendererPath);

  if (!entryBytes) {
    throw new Error(`Plugin renderer entry point not found: ${entryFullPath}`);
  }

  const entryUrl = rendererBuildUrl(options.pluginName, options.rendererPath);

  const scripts: PluginRendererScript[] = [
    {
      pluginName: options.pluginName,
      scriptPath: entryFullPath,
      scriptHash: createHash('sha256').update(entryBytes).digest('hex'),
      entryUrl,
    },
  ];

  return {
    pluginName: options.pluginName,
    pluginDir: options.pluginDir,
    fileHash: options.snapshot.fileHash,
    outDir: options.pluginDir,
    entryPath: options.rendererPath,
    entryUrl,
    scripts,
    styles: [],
    mimeTypes: Object.fromEntries(
      [...options.snapshot.files.keys()].map((relativePath) => [relativePath, pluginRendererContentType(relativePath)]),
    ),
    assets: options.snapshot.files,
  };
}

export function resolvePluginRendererRequest(_options: unknown): null {
  return null;
}
