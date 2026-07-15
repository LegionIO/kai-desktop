#!/usr/bin/env node
/**
 * Guard: the committed pnpm-lock.yaml must be REGISTRY-AGNOSTIC.
 *
 * The lockfile is shared across environments that resolve packages through
 * DIFFERENT registries — public npm (hosted CI) and the on-prem Optum jfrog
 * mirror (kai-platform's self-hosted runners). pnpm normally records only a
 * content-addressable `integrity:` hash in each `resolution:` (no host), so the
 * same lockfile works everywhere. But a lockfile generated against a custom
 * registry can bake an absolute tarball/registry URL into resolutions — which
 * would then pin every consumer to ONE environment's host and break the other
 * (and could leak an internal hostname into git).
 *
 * This script fails if the lockfile embeds any registry URL. The registry
 * host(s) are read from the live pnpm config (`registry` + any `@scope:registry`)
 * — NOT hardcoded — so it adapts to whatever mirror the committing machine uses.
 *
 * Exit 0 = clean, 1 = a baked-in registry URL was found (or the lockfile/config
 * couldn't be read).
 */
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const LOCKFILE = join(repoRoot, 'pnpm-lock.yaml');

function fail(msg) {
  console.error(`\n[check-lockfile-registry] ${msg}\n`);
  process.exit(1);
}

if (!existsSync(LOCKFILE)) {
  // Nothing to check (fresh clone before install, etc.) — not an error.
  process.exit(0);
}

/** Extract the host from a registry URL (or '' if unparseable/empty). */
function hostOf(url) {
  try {
    return new URL(url.trim()).host.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * Collect registry hosts from the live pnpm config, host-agnostic:
 *   - the default `registry`
 *   - every `@scope:registry` line (scoped registries)
 * `pnpm config get registry` resolves .npmrc + env, so this reflects the real
 * mirror this machine used to build the lockfile.
 */
function configuredRegistryHosts() {
  const hosts = new Set();
  try {
    hosts.add(hostOf(execFileSync('pnpm', ['config', 'get', 'registry'], { encoding: 'utf8' })));
  } catch {
    /* pnpm not on PATH in this hook context — fall through to the generic scan */
  }
  try {
    const list = execFileSync('pnpm', ['config', 'list'], { encoding: 'utf8' });
    for (const line of list.split('\n')) {
      // `@scope:registry = "https://host/..."` (or `registry=...`)
      const m = line.match(/(?:^|[":])registry\s*=\s*["']?(https?:\/\/[^"'\s]+)/i);
      if (m) hosts.add(hostOf(m[1]));
    }
  } catch {
    /* ignore */
  }
  hosts.delete('');
  return hosts;
}

const lock = readFileSync(LOCKFILE, 'utf8');
const lines = lock.split('\n');
const hits = [];

// 1) A `tarball:` field only appears in a resolution when a concrete download
//    URL was baked in — the registry-agnostic shape uses integrity only. Match
//    it whether it's on its own line or inline in `resolution: {tarball: ...}`.
lines.forEach((line, i) => {
  if (/\btarball:\s*['"]?https?:\/\//i.test(line)) hits.push({ n: i + 1, why: 'tarball URL', line: line.trim() });
});

// 2) Any configured registry host appearing anywhere in the lockfile means a
//    host was baked in (deprecated:-message npmjs.com/support links are NOT a
//    registry host, so they won't match a real mirror host).
const hosts = configuredRegistryHosts();
if (hosts.size > 0) {
  const hostRe = new RegExp(`https?://(?:[^/\\s]+\\.)?(${[...hosts].map((h) => h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'i');
  lines.forEach((line, i) => {
    if (hostRe.test(line)) hits.push({ n: i + 1, why: 'registry host', line: line.trim() });
  });
}

if (hits.length > 0) {
  const sample = hits.slice(0, 8).map((h) => `  L${h.n} (${h.why}): ${h.line.slice(0, 120)}`).join('\n');
  fail(
    `pnpm-lock.yaml contains ${hits.length} baked-in registry URL(s):\n${sample}\n\n` +
      `The lockfile must be registry-agnostic (integrity-only) so it works across public npm\n` +
      `AND the on-prem mirror. Regenerate it without pinning a registry into resolutions —\n` +
      `e.g. \`pnpm install --lockfile-only\` with a clean registry config, or strip the URLs.`,
  );
}

console.log('[check-lockfile-registry] OK — lockfile is registry-agnostic');
