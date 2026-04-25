import { existsSync } from 'fs';
import { join } from 'path';
import type { PluginRendererBuild, PluginRendererScript } from './types.js';

export const PLUGIN_RENDERER_PROTOCOL = 'plugin-renderer';

function rendererBuildUrl(pluginName: string, relativePath: string): string {
  return `${PLUGIN_RENDERER_PROTOCOL}://${encodeURIComponent(pluginName)}/${relativePath.split('/').map(encodeURIComponent).join('/')}`;
}

export function buildPluginRendererBundle(options: {
  pluginName: string;
  pluginDir: string;
  rendererPath: string;
}): PluginRendererBuild {
  const entryFullPath = join(options.pluginDir, options.rendererPath);

  if (!existsSync(entryFullPath)) {
    throw new Error(`Plugin renderer entry point not found: ${entryFullPath}`);
  }

  const entryUrl = rendererBuildUrl(options.pluginName, options.rendererPath);

  const scripts: PluginRendererScript[] = [{
    pluginName: options.pluginName,
    scriptPath: entryFullPath,
    scriptHash: '',
    entryUrl,
  }];

  return {
    pluginName: options.pluginName,
    pluginDir: options.pluginDir,
    fileHash: '',
    outDir: options.pluginDir,
    entryPath: options.rendererPath,
    entryUrl,
    scripts,
    styles: [],
    mimeTypes: { [options.rendererPath]: 'text/javascript; charset=utf-8' },
  };
}

export function resolvePluginRendererRequest(_options: unknown): null {
  return null;
}
