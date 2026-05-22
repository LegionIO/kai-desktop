/**
 * Classify Release Script
 *
 * Determines whether a release is OTA-eligible by comparing the current
 * package.json against the previous git tag's package.json.
 *
 * A release is OTA-eligible when:
 * - Electron version has NOT changed
 * - Native dependencies have NOT changed (better-sqlite3, tiktoken, node-pty, libsql)
 * - Node engines requirement has NOT changed
 *
 * Usage:  node --import tsx scripts/classify-release.ts [--base-tag <tag>]
 *
 * Outputs to stdout:
 *   OTA_ELIGIBLE=true   or   OTA_ELIGIBLE=false
 *   MIN_BASE_VERSION=<version>
 *
 * Also writes to dist/ota-classification.json for CI consumption.
 */

import { execSync } from 'child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const distDir = resolve(root, 'dist');

// Native dependencies that require full updates when changed
const NATIVE_DEPS = [
  'better-sqlite3',
  'tiktoken',
  '@lydell/node-pty',
  'libsql',
  '@libsql/client',
  'esbuild',
];

// Parse command line args
const args = process.argv.slice(2);
let baseTag: string | undefined;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--base-tag' && args[i + 1]) {
    baseTag = args[i + 1];
    i++;
  }
}

// ── Find the previous tag ────────────────────────────────────────────────────

function getPreviousTag(): string | null {
  if (baseTag) return baseTag;
  try {
    // Get the most recent tag before HEAD
    const tag = execSync('git describe --tags --abbrev=0 HEAD~1 2>/dev/null', {
      cwd: root,
      encoding: 'utf-8',
    }).trim();
    return tag || null;
  } catch {
    // Try getting the latest tag overall
    try {
      const tags = execSync('git tag --sort=-v:refname', {
        cwd: root,
        encoding: 'utf-8',
      }).trim().split('\n');
      // Return the second tag (first is current)
      return tags[1] || tags[0] || null;
    } catch {
      return null;
    }
  }
}

// ── Get package.json from a git ref ──────────────────────────────────────────

function getPackageJsonAt(ref: string): Record<string, unknown> | null {
  try {
    const content = execSync(`git show ${ref}:package.json`, {
      cwd: root,
      encoding: 'utf-8',
    });
    return JSON.parse(content);
  } catch {
    return null;
  }
}

// ── Compare dependencies ─────────────────────────────────────────────────────

interface CompareResult {
  otaEligible: boolean;
  reasons: string[];
  minBaseVersion: string;
}

function classifyRelease(): CompareResult {
  const currentPkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf-8'));
  const currentVersion = currentPkg.version;

  const prevTag = getPreviousTag();
  if (!prevTag) {
    return {
      otaEligible: false,
      reasons: ['No previous tag found — first release requires full update'],
      minBaseVersion: currentVersion,
    };
  }

  const prevPkg = getPackageJsonAt(prevTag);
  if (!prevPkg) {
    return {
      otaEligible: false,
      reasons: [`Could not read package.json from tag ${prevTag}`],
      minBaseVersion: currentVersion,
    };
  }

  const reasons: string[] = [];
  const prevVersion = prevPkg.version as string;

  // Check Electron version
  const currentElectron = (currentPkg.devDependencies?.electron ?? currentPkg.dependencies?.electron) as string | undefined;
  const prevElectron = ((prevPkg.devDependencies as Record<string, unknown>)?.electron ?? (prevPkg.dependencies as Record<string, unknown>)?.electron) as string | undefined;

  if (currentElectron !== prevElectron) {
    reasons.push(`Electron version changed: ${prevElectron} → ${currentElectron}`);
  }

  // Check native dependencies
  const currentDeps = { ...currentPkg.dependencies, ...currentPkg.devDependencies } as Record<string, string>;
  const prevDeps = { ...(prevPkg.dependencies as Record<string, string>), ...(prevPkg.devDependencies as Record<string, string>) };

  for (const dep of NATIVE_DEPS) {
    const currentVer = currentDeps[dep];
    const prevVer = prevDeps[dep];
    if (currentVer !== prevVer) {
      reasons.push(`Native dep ${dep} changed: ${prevVer ?? '(none)'} → ${currentVer ?? '(none)'}`);
    }
  }

  // Check Node engines
  const currentEngines = currentPkg.engines?.node as string | undefined;
  const prevEngines = (prevPkg.engines as Record<string, unknown>)?.node as string | undefined;
  if (currentEngines !== prevEngines) {
    reasons.push(`Node engines changed: ${prevEngines} → ${currentEngines}`);
  }

  const otaEligible = reasons.length === 0;

  // minBaseVersion: if OTA-eligible, the previous version's shell is compatible
  // If not OTA-eligible, minBaseVersion equals current (requires fresh install)
  const minBaseVersion = otaEligible ? prevVersion : currentVersion;

  return { otaEligible, reasons, minBaseVersion };
}

// ── Run ──────────────────────────────────────────────────────────────────────

const result = classifyRelease();
const currentPkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf-8'));

console.info(`\n[classify-release] Version: ${currentPkg.version}`);
console.info(`[classify-release] OTA Eligible: ${result.otaEligible}`);
console.info(`[classify-release] Min Base Version: ${result.minBaseVersion}`);

if (result.reasons.length > 0) {
  console.info(`[classify-release] Reasons for full update:`);
  for (const reason of result.reasons) {
    console.info(`  - ${reason}`);
  }
}

// Output in GitHub Actions format
console.info(`\nOTA_ELIGIBLE=${result.otaEligible}`);
console.info(`MIN_BASE_VERSION=${result.minBaseVersion}`);

// Write classification to file for CI
mkdirSync(distDir, { recursive: true });
const output = {
  version: currentPkg.version,
  otaEligible: result.otaEligible,
  minBaseVersion: result.minBaseVersion,
  reasons: result.reasons,
  classifiedAt: new Date().toISOString(),
};
writeFileSync(resolve(distDir, 'ota-classification.json'), JSON.stringify(output, null, 2));
console.info(`\n[classify-release] Classification written to dist/ota-classification.json`);

// Exit with code 0 always — let CI read the output
process.exit(0);
