/**
 * Demo property test exercising the plugin manifest permission containment
 * invariant. Pattern: an adversarial arbitrary biases toward inputs that
 * have historically broken similar parsers (case variants, padded strings,
 * duplicates, unknown capabilities).
 *
 * Invariant under test
 * --------------------
 *   parseManifest(input).permissions  ⊆  input.permissions
 *
 * The parser may normalise, dedupe, or reject permissions, but it MUST
 * NOT fabricate a permission that was not present in the input. This is
 * the canonical security invariant for plugin sandboxing — a violation
 * here is the parser silently granting capabilities the plugin manifest
 * never asked for, which is RCE-shaped (e.g. surprise `exec:whitelisted`
 * or `safe-storage`).
 *
 * Target function
 * ---------------
 * The repo's manifest parser is `readPluginManifest(pluginDir, fallbackName)`
 * in `electron/plugins/plugin-integrity.ts`. It reads `plugin.json` from
 * disk and returns a normalised `PluginManifest`. We write the generated
 * input to a temp directory per property iteration and invoke the real
 * parser — no test double, no shim. (No exported pure `parseManifest`
 * variant exists; the disk-read version is what production uses, so it
 * is what we test.)
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import fc from 'fast-check';
import { describe, it } from 'vitest';

import { readPluginManifest } from '../plugin-integrity.js';

// ── Adversarial permission arbitrary ──────────────────────────────────────
//
// We deliberately bias the generator toward inputs that have historically
// broken permission parsers in plugin systems:
//
//   • CASE VARIANTS — `"Filesystem:Read"`, `"NETWORK:FETCH"`. A correct
//     allowlist parser keeps the exact bytes (or rejects); a buggy one
//     might `.toLowerCase()` the input then match against the canonical
//     enum, silently escalating an invalid string to a granted permission.
//
//   • WHITESPACE PADDING — `"  config:read"`, `"\tui:modal\n"`. A buggy
//     `.trim().includes()` check can fabricate a granted permission from
//     padded junk.
//
//   • DUPLICATES — `["network:fetch", "network:fetch"]`. The output set
//     must still be a subset of the input set; dedup is fine, fabrication
//     is not. (Tests the "no permissions added" half of the invariant.)
//
//   • UNKNOWN CAPABILITIES — `"filesystem:write"`, `"kernel:patch"`. A
//     buggy "map unknown → nearest known" parser would invent permissions.
//
//   • NON-STRINGS — `null`, `42`, `{ kind: "all" }`. A buggy parser that
//     fails open ("Array but I can't read it, default to admin") would
//     show up here.
//
// fast-check's shrinker will whittle any failing input down to the
// minimal counterexample, which is the whole point of property testing.

const KNOWN_PERMISSIONS = [
  'config:read',
  'config:write',
  'tools:register',
  'ui:banner',
  'ui:modal',
  'ui:settings',
  'ui:panel',
  'ui:navigation',
  'messages:hook',
  'network:fetch',
  'auth:window',
  'http:listen',
  'notifications:send',
  'conversations:read',
  'conversations:write',
  'navigation:open',
  'state:publish',
  'agent:generate',
  'agent:inference-provider',
  'agent:register-runtime',
  'agent:register-cli-tool',
  'safe-storage',
  'browser:window',
  'exec:whitelisted',
  'tools:detect',
  'system:env',
  'audit:log',
  'lifecycle:hook',
] as const;

const knownPermissionArb = fc.constantFrom(...KNOWN_PERMISSIONS);

// Padded version of a known permission — catches `.trim().includes()` bugs.
const paddedKnownPermissionArb = fc
  .tuple(
    fc.constantFrom('', ' ', '  ', '\t', '\n', ' \t '),
    knownPermissionArb,
    fc.constantFrom('', ' ', '  ', '\t', '\n', ' \t '),
  )
  .map(([lead, perm, tail]) => `${lead}${perm}${tail}`);

// Case-permuted version — catches `.toLowerCase()` allowlist bugs.
const caseVariantPermissionArb = knownPermissionArb.map((perm) =>
  perm
    .split('')
    .map((ch, i) => (i % 2 === 0 ? ch.toUpperCase() : ch))
    .join(''),
);

// Locale-sensitive Unicode mutations of known permissions. A parser that
// uses `.toLocaleLowerCase()` (or any locale-sensitive Intl operation)
// will produce surprising allowlist mismatches in non-default locales.
// Pin the four classic foot-guns:
//   • Turkish dotless-i: `i` ↔ `İ` and `I` ↔ `ı`
//   • Greek final sigma: `Σ` lowercases to `σ` normally and `ς` at word-end
//   • German sharp s: `ß` vs `ẞ` (uppercase eszett, U+1E9E)
const localeVariantPermissionArb = knownPermissionArb.map((perm) => {
  // Inject one of the foot-gun characters into the middle of the permission
  // so the bytes differ from the known form but the parser may still match
  // under naive case-folding.
  const middle = Math.floor(perm.length / 2);
  return perm.slice(0, middle) + 'İıςẞß' + perm.slice(middle);
});

// Made-up but plausibly-shaped capability strings.
const unknownPermissionArb = fc.constantFrom(
  'filesystem:read',
  'filesystem:write',
  'kernel:patch',
  'root:everything',
  'admin',
  '*',
  'ui:*',
  'tools:register:write',
  '',
);

// Non-string garbage that a buggy parser might somehow coerce.
const nonStringPermissionArb = fc.oneof(
  fc.constant(null),
  fc.constant(undefined),
  fc.integer(),
  fc.boolean(),
  fc.record({ kind: fc.string() }),
  fc.array(fc.string(), { maxLength: 3 }),
);

// The union, with case/padding/unknown deliberately upweighted because
// those are the historical bug magnets. fast-check uses these weights
// when generating; the shrinker is unaffected.
const permissionEntryArb = fc.oneof(
  { arbitrary: knownPermissionArb, weight: 4 },
  { arbitrary: paddedKnownPermissionArb, weight: 3 },
  { arbitrary: caseVariantPermissionArb, weight: 3 },
  { arbitrary: localeVariantPermissionArb, weight: 2 },
  { arbitrary: unknownPermissionArb, weight: 3 },
  { arbitrary: nonStringPermissionArb, weight: 2 },
);

// The permissions array generator deliberately allows duplicates and
// short-to-medium lengths (production manifests are typically 0–10
// permissions; we exercise up to 20 to stress dedup behaviour).
const permissionsArrayArb = fc.array(permissionEntryArb, { minLength: 0, maxLength: 20 });

// ── Filesystem scaffolding ────────────────────────────────────────────────
//
// fast-check runs the property body 200 times per test. Each iteration
// writes a manifest fixture under `tmpdir()`. We clean up in a try/finally
// inside the body rather than in an `afterEach` drain — the latter would
// keep ~200 directories live until the test ends, inflating tmpdir usage
// on slower runners and making any drift in disk-space reporting confusing.

function withManifestFixture<T>(permissions: unknown, body: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'kai-manifest-property-'));
  const manifest = {
    name: 'property-test-plugin',
    displayName: 'Property Test Plugin',
    version: '0.0.0',
    description: 'fixture for permission containment property test',
    permissions,
  };
  writeFileSync(join(dir, 'plugin.json'), JSON.stringify(manifest), 'utf8');
  try {
    return body(dir);
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup; vitest workers tear down anyway.
    }
  }
}

// ── The property ──────────────────────────────────────────────────────────

describe('plugin manifest parser — permission containment property', () => {
  // 200 runs × per-run mkdtemp + writeFile + readFile + cleanup easily
  // crosses the default 5s vitest budget on a cold cache. Give it room.
  it('parsed permissions are always a subset of input permissions', { timeout: 30_000 }, () => {
    fc.assert(
      fc.property(permissionsArrayArb, (rawPermissions) => {
        withManifestFixture(rawPermissions, (dir) => {
          const result = readPluginManifest(dir, 'property-test-plugin');

          // Reference set = the EXACT strings that appeared in the input
          // array. Anything in `result.permissions` that is not in this
          // set is fabricated — the bug we're hunting.
          const inputAsStrings = new Set<string>();
          for (const entry of rawPermissions) {
            if (typeof entry === 'string') inputAsStrings.add(entry);
          }

          for (const granted of result.permissions) {
            // Belt-and-braces: the type system says these are strings, but
            // a buggy parser might still slip something else in.
            if (typeof granted !== 'string') {
              throw new Error(
                `parser returned non-string permission entry: ${JSON.stringify(granted)} (full result: ${JSON.stringify(result.permissions)})`,
              );
            }
            if (!inputAsStrings.has(granted)) {
              throw new Error(
                `parser fabricated permission "${granted}" — not present in input ${JSON.stringify(rawPermissions)}`,
              );
            }
          }
        });
      }),
      { numRuns: 200 },
    );
  });
});
