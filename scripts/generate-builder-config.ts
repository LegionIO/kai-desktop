/**
 * Pre-build script that generates `electron-builder.yml` from the template
 * and branding config.
 *
 * Usage:  node --import tsx scripts/generate-builder-config.ts
 *         (automatically called by `pnpm build:mac`)
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { branding } from '../branding.config.js';
import { resolveBranding } from './resolve-branding.js';
import { stripTopLevelBlock, toYamlSingleQuotedPath, shouldStripWindowsTargets } from './builder-config-strip.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const templatePath = resolve(root, 'electron-builder.template.yml');
const outputPath = resolve(root, 'electron-builder.yml');
const require = createRequire(import.meta.url);

let content = readFileSync(templatePath, 'utf-8');

function getEsbuildBinaryPackageName(): string | null {
  if (process.platform === 'darwin' && process.arch === 'arm64') return '@esbuild/darwin-arm64';
  if (process.platform === 'darwin' && process.arch === 'x64') return '@esbuild/darwin-x64';
  if (process.platform === 'linux' && process.arch === 'arm64') return '@esbuild/linux-arm64';
  if (process.platform === 'linux' && process.arch === 'x64') return '@esbuild/linux-x64';
  if (process.platform === 'win32' && process.arch === 'arm64') return '@esbuild/win32-arm64';
  if (process.platform === 'win32' && process.arch === 'x64') return '@esbuild/win32-x64';
  return null;
}

function buildEsbuildExtraResourcesBlock(): string {
  const packageName = getEsbuildBinaryPackageName();
  if (!packageName) {
    console.warn(
      `[generate-builder-config] No packaged esbuild binary mapping for ${process.platform}/${process.arch}`,
    );
    return '';
  }

  try {
    const packageJsonPath = require.resolve(`${packageName}/package.json`);
    const binaryName = process.platform === 'win32' ? 'esbuild.exe' : 'esbuild';
    const binaryPath = join(dirname(packageJsonPath), 'bin', binaryName);

    if (!existsSync(binaryPath)) {
      console.warn(`[generate-builder-config] esbuild binary not found at ${binaryPath}`);
      return '';
    }

    return [`  - from: ${toYamlSingleQuotedPath(binaryPath)}`, `    to: esbuild/bin/${binaryName}`].join('\n');
  } catch (error) {
    console.warn('[generate-builder-config] Failed to resolve packaged esbuild binary:', error);
    return '';
  }
}

// Replace all {{key}} placeholders with values from branding config
const resolved = resolveBranding(branding);
for (const [key, value] of Object.entries(resolved)) {
  content = content.replaceAll(`{{${key}}}`, String(value));
}

content = content.replace('{{esbuildExtraResources}}', buildEsbuildExtraResourcesBlock());

// Windows build gate (#82 / ADR-0005): Windows targets (`win`/`nsis`) are now
// built BY DEFAULT (experimental-on posture — the app ships win/linux features
// as experimental for feedback). Set KAI_DISABLE_WIN_BUILD to strip them (e.g.
// a mac-only release). The legacy KAI_ENABLE_WIN_BUILD is still honored as an
// explicit include, but is no longer required.
if (shouldStripWindowsTargets()) {
  content = stripTopLevelBlock(content, 'win');
  content = stripTopLevelBlock(content, 'nsis');
  console.info('[generate-builder-config] Windows target stripped (KAI_DISABLE_WIN_BUILD set). See ADR-0005.');
} else {
  console.info('[generate-builder-config] Windows target INCLUDED (default; set KAI_DISABLE_WIN_BUILD to strip).');
}

// Warn about any remaining un-replaced placeholders
const remaining = content.match(/\{\{[a-zA-Z]+\}\}/g);
if (remaining) {
  console.warn(`[generate-builder-config] Warning: un-replaced placeholders: ${remaining.join(', ')}`);
}

writeFileSync(outputPath, content, 'utf-8');
console.info(`[generate-builder-config] Generated ${outputPath} from template.`);
