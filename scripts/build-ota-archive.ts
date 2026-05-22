/**
 * Build OTA Archive Script
 *
 * Packages the `out/` directory (main + preload + renderer) into a compressed
 * tar.gz archive with an accompanying manifest containing per-file SHA-512 hashes.
 *
 * Usage:  node --import tsx scripts/build-ota-archive.ts
 *
 * Outputs to `dist/`:
 *   - kai-ota-{version}.tar.gz    — The OTA archive
 *   - latest-ota.json             — The OTA feed manifest for the updater
 */

import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'fs';
import { resolve, dirname, relative, join } from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';
import { branding } from '../branding.config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const outDir = resolve(root, 'out');
const distDir = resolve(root, 'dist');

// Read version from package.json
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf-8'));
const version: string = pkg.version;
const appSlug: string = branding.appSlug as string;

// Validate that the out/ directory exists and has content
if (!existsSync(outDir)) {
  console.error('Error: out/ directory not found. Run `pnpm build` first.');
  process.exit(1);
}

const mainIndex = resolve(outDir, 'main', 'index.js');
const preloadIndex = resolve(outDir, 'preload', 'index.mjs');
const rendererIndex = resolve(outDir, 'renderer', 'index.html');

if (!existsSync(mainIndex) || !existsSync(preloadIndex) || !existsSync(rendererIndex)) {
  console.error('Error: out/ directory is missing expected files (main/index.js, preload/index.mjs, renderer/index.html).');
  console.error('Run `pnpm build` first.');
  process.exit(1);
}

// ── Collect all files and compute hashes ─────────────────────────────────────

interface FileEntry {
  sha512: string;
  size: number;
}

function hashFileSync(filePath: string): string {
  const hash = createHash('sha512');
  const content = readFileSync(filePath);
  hash.update(content);
  return hash.digest('hex');
}

function collectFiles(dir: string, baseDir: string): Map<string, FileEntry> {
  const result = new Map<string, FileEntry>();

  function walk(current: string): void {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const fullPath = join(current, entry.name);
      if (entry.isDirectory()) {
        // Skip .map files directory or hidden directories
        if (entry.name.startsWith('.')) continue;
        walk(fullPath);
      } else {
        // Skip source maps
        if (entry.name.endsWith('.map')) continue;

        const relativePath = relative(baseDir, fullPath);
        const stat = statSync(fullPath);
        const sha512 = hashFileSync(fullPath);
        result.set(relativePath, { sha512, size: stat.size });
      }
    }
  }

  walk(dir);
  return result;
}

console.info(`[build-ota] Collecting files from out/ for v${version}...`);
const files = collectFiles(outDir, resolve(outDir, '..'));

console.info(`[build-ota] Found ${files.size} files`);

// ── Generate manifest ────────────────────────────────────────────────────────

const manifest = {
  codeVersion: version,
  baseVersion: version, // The base version this was built against (same version for now)
  minBaseVersion: version, // Will be overridden by classify-release in CI
  files: Object.fromEntries(files),
  createdAt: new Date().toISOString(),
};

// Write manifest into out/ so it gets included in the archive
const manifestPath = resolve(outDir, '..', 'ota-manifest.json');
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
console.info(`[build-ota] Manifest written with ${files.size} file entries`);

// ── Create tar.gz archive ────────────────────────────────────────────────────

mkdirSync(distDir, { recursive: true });

const archiveName = `${appSlug}-ota-${version}.tar.gz`;
const archivePath = resolve(distDir, archiveName);

// Create a temporary staging directory with the expected structure:
// manifest.json + out/ (the code directories)
const stagingDir = resolve(distDir, '.ota-staging');
if (existsSync(stagingDir)) {
  execFileSync('rm', ['-rf', stagingDir]);
}
mkdirSync(stagingDir, { recursive: true });

// Copy manifest to staging root
writeFileSync(resolve(stagingDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

// Copy out/ to staging/out/
execFileSync('cp', ['-R', outDir, resolve(stagingDir, 'out')]);

// Remove .map files from the staging copy
execFileSync('/usr/bin/find', [resolve(stagingDir, 'out'), '-name', '*.map', '-delete']);

// Create the tar.gz
execFileSync('/usr/bin/tar', [
  '-czf', archivePath,
  '-C', stagingDir,
  '.',
]);

// Clean up staging
execFileSync('rm', ['-rf', stagingDir]);

// ── Compute archive hash ─────────────────────────────────────────────────────

const archiveHash = hashFileSync(archivePath);
const archiveStat = statSync(archivePath);

console.info(`[build-ota] Archive created: ${archiveName}`);
console.info(`[build-ota] Size: ${(archiveStat.size / 1024 / 1024).toFixed(2)} MB`);
console.info(`[build-ota] SHA-512: ${archiveHash.slice(0, 16)}...`);

// ── Generate latest-ota.json feed ────────────────────────────────────────────

const feed = {
  latest: {
    codeVersion: version,
    minBaseVersion: manifest.minBaseVersion,
    url: archiveName,
    sha512: archiveHash,
    size: archiveStat.size,
    releaseDate: new Date().toISOString(),
  },
};

const feedPath = resolve(distDir, 'latest-ota.json');
writeFileSync(feedPath, JSON.stringify(feed, null, 2));
console.info(`[build-ota] Feed written: latest-ota.json`);

// ── Summary ──────────────────────────────────────────────────────────────────

console.info('\n[build-ota] OTA archive build complete:');
console.info(`  Archive: dist/${archiveName} (${(archiveStat.size / 1024 / 1024).toFixed(2)} MB)`);
console.info(`  Feed:    dist/latest-ota.json`);
console.info(`  Version: ${version}`);
console.info(`  Files:   ${files.size}`);
