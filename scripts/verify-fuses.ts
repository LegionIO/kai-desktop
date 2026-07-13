/**
 * Verifies that the packaged macOS .app bundle has the expected Electron
 * Fuses set. Fuses are bits flipped into the Electron binary at build time
 * that disable risky runtime escape hatches; this script reads the fuse
 * wire from the signed .app via `@electron/fuses` and asserts the six we
 * consider load-bearing for the security posture of the shipped binary.
 *
 * Used as the `pnpm verify:fuses` step in CI, run after `pnpm build:mac`.
 * If any required fuse is not at its expected value, the script exits with
 * code 1 and prints the offending fuse name so the build fails loudly.
 *
 * Fuse expectations (all must hold for the script to pass):
 *
 *   - RunAsNode = false
 *       Disables the ELECTRON_RUN_AS_NODE escape hatch, which would
 *       otherwise let an attacker re-launch our binary as a plain Node.js
 *       interpreter and bypass every renderer / sandbox restriction.
 *
 *   - EnableCookieEncryption = true
 *       Encrypts the on-disk Chromium cookie store using OS-level
 *       primitives (Keychain on macOS), so cookies cannot be read by other
 *       local processes that don't have our app's keychain entitlement.
 *
 *   - EnableNodeOptionsEnvironmentVariable = false
 *       Disables NODE_OPTIONS, which would otherwise let a parent process
 *       inject `--require <attacker.js>` and execute arbitrary code in our
 *       main process before our own bootstrap runs.
 *
 *   - EnableNodeCliInspectArguments = false
 *       Disables `--inspect` / `--inspect-brk` flags, blocking a local
 *       attacker from attaching a debugger to a running production
 *       instance and dumping in-memory secrets or hijacking execution.
 *
 *   - EnableEmbeddedAsarIntegrityValidation = true
 *       Forces Electron to validate the embedded SHA-256 hash of our asar
 *       archive against a signature in the app binary at load time, so
 *       any tampered asar fails fast instead of running.
 *
 *   - OnlyLoadAppFromAsar = true
 *       Refuses to load app code from a loose filesystem path; only the
 *       signed asar is acceptable. Closes a `--app=/tmp/evil` style swap.
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getCurrentFuseWire, FuseV1Options } from '@electron/fuses';
import type { FuseConfig } from '@electron/fuses';

// Mirrors the FuseState enum from @electron/fuses' `dist/constants` (not
// re-exported from the package root, so we duplicate the literal byte
// values that Electron writes into the fuse wire). These are stable
// across Electron releases — they are the on-disk encoding of each fuse.
const FUSE_DISABLE = 48;
const FUSE_ENABLE = 49;
const FUSE_INHERIT = 144;
const FUSE_REMOVED = 114;
type FuseStateByte = typeof FUSE_DISABLE | typeof FUSE_ENABLE | typeof FUSE_INHERIT | typeof FUSE_REMOVED;

/**
 * Runtime sanity check: any byte we read out of the fuse wire must be one
 * of the four documented FuseState values. A future @electron/fuses major
 * version that adds a fifth FuseState (e.g. for FuseV2) would otherwise
 * fall through `stateToBoolean` returning `null` and produce a confusing
 * "got null wanted true/false" diagnostic. Failing explicitly here keeps
 * the maintenance pressure on the upgrade rather than on the operator
 * reading the verifier output.
 */
const KNOWN_FUSE_STATE_BYTES = new Set<number>([FUSE_DISABLE, FUSE_ENABLE, FUSE_INHERIT, FUSE_REMOVED]);

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = dirname(__dirname);
const DIST_MAC = join(REPO_ROOT, 'dist', 'mac-universal');

/** Mirror of the table at the top of this file. */
const EXPECTED: ReadonlyArray<{ name: string; option: FuseV1Options; want: boolean }> = [
  { name: 'RunAsNode', option: FuseV1Options.RunAsNode, want: false },
  { name: 'EnableCookieEncryption', option: FuseV1Options.EnableCookieEncryption, want: true },
  {
    name: 'EnableNodeOptionsEnvironmentVariable',
    option: FuseV1Options.EnableNodeOptionsEnvironmentVariable,
    want: false,
  },
  {
    name: 'EnableNodeCliInspectArguments',
    option: FuseV1Options.EnableNodeCliInspectArguments,
    want: false,
  },
  {
    name: 'EnableEmbeddedAsarIntegrityValidation',
    option: FuseV1Options.EnableEmbeddedAsarIntegrityValidation,
    want: true,
  },
  { name: 'OnlyLoadAppFromAsar', option: FuseV1Options.OnlyLoadAppFromAsar, want: true },
];

function findAppBundle(): string {
  // Match the resolution used by the existing post-build verification:
  //   APP_PATH="$(find dist/mac-universal -maxdepth 1 -name '*.app' -type d | head -n 1)"
  if (!existsSync(DIST_MAC)) {
    console.error(`[fuses] expected build output directory not found: ${DIST_MAC}`);
    process.exit(1);
  }

  const matches: string[] = [];
  for (const name of readdirSync(DIST_MAC)) {
    if (!name.endsWith('.app')) continue;
    const full = join(DIST_MAC, name);
    if (statSync(full).isDirectory()) {
      matches.push(full);
    }
  }

  if (matches.length === 0) {
    console.error(`[fuses] no .app bundle found in ${DIST_MAC}`);
    process.exit(1);
  }

  matches.sort();
  const appPath = matches[0];
  if (!appPath) {
    // Defensive: should be unreachable given the length check above.
    console.error(`[fuses] no .app bundle resolved in ${DIST_MAC}`);
    process.exit(1);
  }
  return appPath;
}

function stateToBoolean(state: FuseStateByte): boolean | null {
  if (state === FUSE_ENABLE) return true;
  if (state === FUSE_DISABLE) return false;
  return null;
}

function describeState(state: FuseStateByte | undefined): string {
  if (state === undefined) return 'UNDEFINED';
  switch (state) {
    case FUSE_ENABLE:
      return 'ENABLE (true)';
    case FUSE_DISABLE:
      return 'DISABLE (false)';
    case FUSE_INHERIT:
      return 'INHERIT';
    case FUSE_REMOVED:
      return 'REMOVED';
    default:
      return `UNKNOWN(${String(state)})`;
  }
}

/**
 * Pure fuse-verification decision: given a read fuse wire (fuse option → byte)
 * and the expected table, return the human-readable failure lines. A fuse fails
 * when its byte is undefined, INHERIT/REMOVED (i.e. not a hard ENABLE/DISABLE),
 * or set to the opposite of `want`. This is the security-load-bearing bit — a
 * bug here would let an insecurely-fused build pass CI — so it's extracted from
 * main() to be testable without a packaged .app. Throws on an unrecognized byte
 * (so a new @electron/fuses FuseState fails loudly rather than silently passing).
 */
export function evaluateFuses(
  wire: Record<number, number | undefined>,
  expected: ReadonlyArray<{ name: string; option: FuseV1Options; want: boolean }> = EXPECTED,
): string[] {
  const failures: string[] = [];
  for (const { name, option, want } of expected) {
    const rawByte = wire[option as unknown as number];
    if (rawByte !== undefined && !KNOWN_FUSE_STATE_BYTES.has(rawByte)) {
      throw new Error(
        `fuse "${name}" reported unknown byte=${rawByte} (0x${rawByte.toString(16)}) — @electron/fuses may have a new FuseState`,
      );
    }
    const got = rawByte as FuseStateByte | undefined;
    const gotBool = got === undefined ? null : stateToBoolean(got);
    if (gotBool === null || gotBool !== want) {
      failures.push(`  - ${name}: expected ${want ? 'ENABLE (true)' : 'DISABLE (false)'}, got ${describeState(got)}`);
    }
  }
  return failures;
}

async function main(): Promise<void> {
  const appPath = findAppBundle();
  console.info(`[fuses] reading fuse wire from ${appPath}`);

  let wire: FuseConfig<FuseStateByte>;
  try {
    // The runtime payload is `FuseConfig<FuseState>` where `FuseState` is a
    // numeric enum sharing the same byte values declared at the top of this
    // file; cast through `unknown` so we don't pull the unexported enum.
    wire = (await getCurrentFuseWire(appPath)) as unknown as FuseConfig<FuseStateByte>;
  } catch (err) {
    console.error(`[fuses] failed to read fuse wire: ${(err as Error).message}`);
    process.exit(1);
  }

  let failures: string[];
  try {
    failures = evaluateFuses(wire as unknown as Record<number, number | undefined>);
  } catch (err) {
    // An unrecognized fuse byte — fail loud with the guidance the assert used to print.
    console.error(`[fuses] FATAL: ${(err as Error).message}. Update scripts/verify-fuses.ts.`);
    process.exit(1);
  }

  if (failures.length > 0) {
    console.error('[fuses] verification FAILED:');
    for (const line of failures) {
      console.error(line);
    }
    process.exit(1);
  }

  console.info(`[fuses] OK — all ${EXPECTED.length} required fuses match expected values`);

  // ── OTA public-key release gate ───────────────────────────────────────────
  // The runtime intentionally falls open (sha512-only) when the baked-in
  // OTA_PUBLIC_KEY is still the placeholder, so that a build shipped without
  // a real key can still receive its next OTA update instead of being
  // bricked. That fail-open is acceptable ONLY if it never reaches users —
  // so this release gate fails CI builds loudly when the placeholder is
  // still present. Local developer runs (CI unset) are exempt.
  //
  // signing.ts only depends on `crypto`, so it is safe to import from a
  // plain Node/tsx script (no `electron` import is pulled in).
  // Read the branding config directly rather than importing signing.ts —
  // signing.ts now reads __BRAND_OTA_PUBLIC_KEY which is a Vite define and
  // not available in raw tsx execution.
  const { branding } = await import('../branding.config.js');
  let mergedBranding: Record<string, unknown> = { ...branding };
  try {
    const local = await import('../branding.config.local.js');
    mergedBranding = { ...mergedBranding, ...(local.brandingLocal ?? local.default ?? {}) };
  } catch {
    // No local override — fine.
  }
  const otaPublicKey = String(mergedBranding.otaPublicKey ?? '');
  const OTA_PUBLIC_KEY_IS_PLACEHOLDER = !otaPublicKey || !otaPublicKey.includes('BEGIN PUBLIC KEY');
  if (OTA_PUBLIC_KEY_IS_PLACEHOLDER) {
    // Only fail RELEASE builds — PR/branch CI runs verify:fuses too and
    // shouldn't be blocked while the kai-builder signing-key rollout is
    // in progress. release.yml sets KAI_RELEASE_BUILD=1.
    if (process.env.KAI_RELEASE_BUILD === '1') {
      console.error(
        '[fuses] FATAL: OTA public key is missing — set `otaPublicKey` in branding.config.ts ' +
          '(or your brand override) to the Ed25519 public PEM matching KAI_OTA_SIGNING_KEY. ' +
          'Packaged binaries built without it fall back to sha512-only OTA verification.',
      );
      process.exit(1);
    }
    console.warn(
      '[fuses] WARNING: branding.otaPublicKey is missing. ' +
        'This is allowed for local/PR builds but will fail release builds (KAI_RELEASE_BUILD=1).',
    );
  } else {
    console.info('[fuses] OK — OTA public key is set in branding config');
  }
}

// Run only when invoked as a script (node/tsx), not when imported by a test.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((err: unknown) => {
    console.error(`[fuses] unexpected error: ${(err as Error).message}`);
    process.exit(1);
  });
}
