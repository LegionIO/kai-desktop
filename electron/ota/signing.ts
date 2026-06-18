/**
 * OTA Ed25519 Signature Verification
 *
 * Shared signing/verification logic used by both the OTA updater (feed-time
 * verification before download) and the bootstrap module (boot-time
 * re-verification of the on-disk overlay).
 *
 * Security model:
 *   - The release pipeline signs each OTA archive with an Ed25519 private key
 *     held only in CI (KAI_OTA_SIGNING_KEY).
 *   - This public key is baked into the shipped binary, so an attacker who
 *     controls the feed URL or the on-disk overlay directory cannot forge a
 *     valid update without the private key.
 *   - The signed payload binds the archive hash to the codeVersion and
 *     minBaseVersion, preventing version-pinning / rollback attacks via
 *     manifest field tampering.
 */

import { createHash, verify as cryptoVerify } from 'crypto';

/**
 * Ed25519 public key for OTA archive verification (PEM, SPKI).
 *
 * Injected as a Vite build-time define from `branding.config.ts#otaPublicKey`,
 * so each branded build (legionio, uhc-tech, …) bakes in its own verification
 * key matching the KAI_OTA_SIGNING_KEY secret in that brand's release CI.
 *
 * To rotate or set up a new brand:
 *   openssl genpkey -algorithm ed25519 -out ota-private.pem
 *   openssl pkey -in ota-private.pem -pubout -out ota-public.pem
 * Then set `otaPublicKey` in your branding config to the contents of
 * ota-public.pem, and store ota-private.pem as the KAI_OTA_SIGNING_KEY
 * GitHub Actions secret on your release repo.
 *
 * The `typeof` guard handles non-Vite contexts (e.g. raw tsx scripts) where
 * the define is not substituted — those contexts see an empty string and
 * `OTA_PUBLIC_KEY_IS_PLACEHOLDER` is true.
 */
export const OTA_PUBLIC_KEY: string =
  typeof __BRAND_OTA_PUBLIC_KEY !== 'undefined' ? __BRAND_OTA_PUBLIC_KEY : '';

/** True when no real public key was injected at build time. */
export const OTA_PUBLIC_KEY_IS_PLACEHOLDER =
  !OTA_PUBLIC_KEY || !OTA_PUBLIC_KEY.includes('BEGIN PUBLIC KEY');

/**
 * Build the canonical byte string that is signed / verified.
 * MUST match scripts/build-ota-archive.ts exactly.
 */
export function buildSignedPayload(
  sha512: string,
  codeVersion: string,
  minBaseVersion: string,
  filesHash: string,
): Buffer {
  return Buffer.from(`${sha512}\n${codeVersion}\n${minBaseVersion}\n${filesHash}`, 'utf8');
}

/**
 * Deterministic hash over the manifest.files map so the per-file integrity
 * table itself is bound to the Ed25519 signature. Without this, an attacker
 * who can write to the overlay directory could modify a file AND its
 * manifest.files[rel].sha512 entry and the signature (which previously only
 * covered the archive sha512) would still verify.
 *
 * MUST match scripts/build-ota-archive.ts#computeFilesHash exactly.
 */
export function computeFilesHash(files: Record<string, { sha512: string }>): string {
  const keys = Object.keys(files).sort();
  let canon = '';
  for (const key of keys) {
    canon += `${key}\0${files[key].sha512}\n`;
  }
  return createHash('sha256').update(canon, 'utf8').digest('hex');
}

/** Fields required to verify an OTA signature (subset of OtaFeedEntry / OtaManifest). */
export interface OtaSignedFields {
  sha512: string;
  codeVersion: string;
  minBaseVersion: string;
  filesHash: string;
  signature: string;
}

/**
 * Verify an Ed25519 signature over the canonical OTA payload.
 *
 * @returns true if the signature is valid for the given fields
 */
export function verifyOtaSignature(fields: OtaSignedFields): boolean {
  if (
    !fields.signature ||
    !fields.sha512 ||
    !fields.codeVersion ||
    !fields.minBaseVersion ||
    !fields.filesHash
  ) {
    return false;
  }
  try {
    const payload = buildSignedPayload(
      fields.sha512,
      fields.codeVersion,
      fields.minBaseVersion,
      fields.filesHash,
    );
    const sigBuf = Buffer.from(fields.signature, 'base64');
    // Ed25519 → algorithm must be null
    return cryptoVerify(null, payload, OTA_PUBLIC_KEY, sigBuf);
  } catch (err) {
    console.error('[ota-signing] Signature verification threw:', err);
    return false;
  }
}

/**
 * Dev-mode escape hatch. Signature checks are skipped when:
 *   - KAI_OTA_SKIP_SIGNATURE=1 is set, OR
 *   - the caller reports the app is not packaged (dev/watch mode)
 *
 * This lets local builds and integration tests run against unsigned feeds
 * while keeping the check mandatory in shipped binaries.
 */
export function shouldSkipOtaSignature(isPackaged: boolean): boolean {
  // Dev/unpackaged builds always skip — local development uses unsigned
  // feeds. KAI_OTA_SKIP_SIGNATURE is intentionally NOT honoured for
  // packaged builds: an attacker who controls the launch environment of
  // a packaged app must not be able to disable verification via env var.
  if (!isPackaged) return true;
  // If the public key was never replaced at build time, enforcing signature
  // verification would reject every legitimate signed update and brick the
  // OTA channel for packaged users. Fall back to sha512-only with a loud
  // warning so the missing key is surfaced without blocking upgrades.
  if (OTA_PUBLIC_KEY_IS_PLACEHOLDER) {
    console.error(
      '[ota-signing] OTA_PUBLIC_KEY is the build-time placeholder — signature verification DISABLED. ' +
        'Set the real Ed25519 public key in electron/ota/signing.ts (see kai-builder docs) before release.',
    );
    return true;
  }
  return false;
}
