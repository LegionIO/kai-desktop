/**
 * CI assertion (issue #17): the auto-update trust anchor must not regress.
 *
 * The update manifest (latest-mac.yml / latest.yml) is UNSIGNED YAML — the code
 * signature is the only real trust anchor. If the build config ever disables
 * update signature verification or accepts a wildcard/absent publisher, a
 * tampered manifest in the (semi-)public feed becomes a remote-code-execution
 * path. This locks that down so it cannot silently regress.
 *
 * Runs against the FINAL, post-generation electron-builder.yml (the file that
 * actually ships — after scripts/generate-builder-config.ts and, on the
 * platform overlay, its text-patching). Exits non-zero and prints each failure
 * so the build fails loudly.
 *
 * Checks:
 *   - Windows update signature verification is NOT explicitly disabled
 *     (`win.verifyUpdateCodeSignature: false` is the electron-updater kill
 *     switch — default true; an explicit false is the regression we block).
 *   - The Windows accepted publisher is PINNED: `win.publisherName` is present
 *     and non-empty and not a wildcard (`*`). Without it the NSIS updater's
 *     signature check accepts any publisher, weakening the anchor.
 *   - macOS signing is NOT disabled: `mac.hardenedRuntime` stays true and
 *     `mac.notarize`/`forceCodeSigning` aren't turned off — electron-updater's
 *     macOS path verifies the update is signed by the SAME identity, which
 *     only holds if the app is actually signed+notarized.
 *
 * Usage: `pnpm assert:update-verification` (after generate:builder).
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

type BuilderConfig = {
  win?: {
    verifyUpdateCodeSignature?: unknown;
    publisherName?: unknown;
  };
  mac?: {
    hardenedRuntime?: unknown;
    notarize?: unknown;
    forceCodeSigning?: unknown;
  };
};

/**
 * Return { failures, warnings } for a parsed builder config. `failures` is
 * empty when the update trust anchor is intact (build should pass); `warnings`
 * are non-fatal advisories. Pure — no I/O — so it's unit-tested.
 *
 * `winShipping` = whether a Windows artifact actually ships (KAI_ENABLE_WIN_BUILD).
 * The Windows publisher pin is REQUIRED (failure) only when Windows ships;
 * otherwise a missing pin is a warning (Windows builds are gated off by default
 * and the pin's value is the signing cert's CN, which must be set before the
 * first real Windows release).
 */
export function evaluateUpdateVerification(
  config: BuilderConfig,
  winShipping = false,
): { failures: string[]; warnings: string[] } {
  const failures: string[] = [];
  const warnings: string[] = [];
  const win = config.win ?? {};
  const mac = config.mac ?? {};

  // Windows: verifyUpdateCodeSignature must never be explicitly disabled —
  // that's the electron-updater kill switch, a regression regardless of whether
  // Windows currently ships.
  if (win.verifyUpdateCodeSignature === false) {
    failures.push('win.verifyUpdateCodeSignature is false — Windows update signature verification is DISABLED.');
  }

  // Windows: publisherName must be pinned (present, non-empty, non-wildcard).
  const publisher = win.publisherName;
  const publisherList = Array.isArray(publisher) ? publisher : publisher === undefined ? [] : [publisher];
  if (publisherList.length === 0) {
    const msg =
      'win.publisherName is missing — the Windows updater would accept an update from ANY publisher. ' +
      'Set it to the Windows signing certificate CN before shipping a Windows release.';
    (winShipping ? failures : warnings).push(msg);
  } else {
    for (const p of publisherList) {
      if (typeof p !== 'string' || p.trim() === '' || p.includes('*')) {
        failures.push(`win.publisherName entry is empty or wildcarded (${JSON.stringify(p)}) — not a valid pin.`);
      }
    }
  }

  // macOS: signing/notarization must not be disabled (the update path relies on
  // the app being signed by the pinned identity).
  if (mac.hardenedRuntime === false) {
    failures.push('mac.hardenedRuntime is false — the app is not hardened; update-signature trust is weakened.');
  }
  if (mac.notarize === false) {
    failures.push('mac.notarize is false — the app is not notarized; update-signature trust is weakened.');
  }
  if (mac.forceCodeSigning === false) {
    failures.push('mac.forceCodeSigning is false — an unsigned build could ship, breaking update verification.');
  }

  return { failures, warnings };
}

function main(): void {
  const configPath = join(__dirname, '..', 'electron-builder.yml');
  if (!existsSync(configPath)) {
    console.error(
      `[assert-update-verification] electron-builder.yml not found at ${configPath}. ` +
        'Run `pnpm generate:builder` first — this asserts the FINAL shipped config.',
    );
    process.exit(1);
  }
  let config: BuilderConfig;
  try {
    config = (yaml.load(readFileSync(configPath, 'utf8')) as BuilderConfig) ?? {};
  } catch (err) {
    console.error(`[assert-update-verification] failed to parse electron-builder.yml: ${(err as Error).message}`);
    process.exit(1);
    return;
  }

  const winShipping = process.env.KAI_ENABLE_WIN_BUILD === '1';
  const { failures, warnings } = evaluateUpdateVerification(config, winShipping);
  for (const w of warnings) console.warn(`[assert-update-verification] WARNING: ${w}`);
  if (failures.length > 0) {
    console.error('[assert-update-verification] update-signature trust anchor FAILED:');
    for (const f of failures) console.error(`  ✗ ${f}`);
    process.exit(1);
  }
  console.info('[assert-update-verification] OK — update signature verification + publisher pin intact.');
}

// Run only when invoked as a script (node/tsx), not when imported by a test.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main();
}
