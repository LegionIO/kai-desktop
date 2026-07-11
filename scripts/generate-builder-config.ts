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

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const templatePath = resolve(root, 'electron-builder.template.yml');
const outputPath = resolve(root, 'electron-builder.yml');
const require = createRequire(import.meta.url);

let content = readFileSync(templatePath, 'utf-8');

function toYamlSingleQuotedPath(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

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

// Windows build gate (#82 / ADR-0005): the `win`/`nsis` targets are NOT
// production-ready (no native Windows automation, unvalidated on real Windows
// hardware) and must not ship by default. Strip both top-level blocks unless
// KAI_ENABLE_WIN_BUILD is explicitly set, so CI publishes no Windows artifact.
if (!process.env.KAI_ENABLE_WIN_BUILD) {
  // Remove a top-level YAML block (`key:` at column 0 through the line before
  // the next column-0 key). A block line is either indented content or a blank
  // line; both are consumed so an interior blank line doesn't truncate the block.
  const stripTopLevelBlock = (yaml: string, key: string): string =>
    yaml.replace(new RegExp(`(^|\\n)${key}:[^\\n]*\\n(?:[ \\t]+[^\\n]*\\n|[ \\t]*\\n)*`, 'g'), '$1');
  content = stripTopLevelBlock(content, 'win');
  content = stripTopLevelBlock(content, 'nsis');
  console.info(
    '[generate-builder-config] Windows target stripped (set KAI_ENABLE_WIN_BUILD to include it). See ADR-0005.',
  );
}

// Warn about any remaining un-replaced placeholders
const remaining = content.match(/\{\{[a-zA-Z]+\}\}/g);
if (remaining) {
  console.warn(`[generate-builder-config] Warning: un-replaced placeholders: ${remaining.join(', ')}`);
}

writeFileSync(outputPath, content, 'utf-8');
console.info(`[generate-builder-config] Generated ${outputPath} from template.`);
