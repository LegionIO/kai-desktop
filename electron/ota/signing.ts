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
export const OTA_PUBLIC_KEY: string = typeof __BRAND_OTA_PUBLIC_KEY !== 'undefined' ? __BRAND_OTA_PUBLIC_KEY : '';

/** True when no real public key was injected at build time. */
export const OTA_PUBLIC_KEY_IS_PLACEHOLDER = !OTA_PUBLIC_KEY || !OTA_PUBLIC_KEY.includes('BEGIN PUBLIC KEY');

/**
 * Build the canonical byte string that is signed / verified.
 * MUST match scripts/build-ota-archive.ts exactly.
 *
 * v1 (legacy): `${sha512}\n${codeVersion}\n${minBaseVersion}\n${filesHash}`
 * v2: appends `\n${url}\n${size}` so the download TARGET (archive url + byte
 * size) is authenticated, not just its post-download hash. When url/size are
 * omitted this produces the v1 string, so old signers/verifiers interoperate.
 */
export function buildSignedPayload(
  sha512: string,
  codeVersion: string,
  minBaseVersion: string,
  filesHash: string,
  url?: string,
  size?: number,
): Buffer {
  const base = `${sha512}\n${codeVersion}\n${minBaseVersion}\n${filesHash}`;
  if (url != null && size != null) {
    return Buffer.from(`${base}\n${url}\n${size}`, 'utf8');
  }
  return Buffer.from(base, 'utf8');
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
  /** v2: archive download URL, bound into the signature. Optional for v1 feeds. */
  url?: string;
  /** v2: archive byte size, bound into the signature. Optional for v1 feeds. */
  size?: number;
}

/**
 * Verify an Ed25519 signature over the canonical OTA payload.
 *
 * Backward-compatible: when url+size are present it tries the v2 payload first
 * (url/size bound); on failure — or when url/size are absent (legacy feed) — it
 * falls back to the v1 4-field payload. An old field install (v1 verifier)
 * accepts a v1 archive; a new install accepts both a v2 archive AND a still-in-
 * flight v1 archive → NO signer/verifier skew window. Drop the v1 fallback only
 * once all field installs are v2-aware.
 *
 * @param publicKey - PEM SPKI key to verify against. Defaults to the build-baked
 *   OTA_PUBLIC_KEY; production callers never pass this (the OTA test harness does).
 */
export function verifyOtaSignature(fields: OtaSignedFields, publicKey: string = OTA_PUBLIC_KEY): boolean {
  if (!fields.signature || !fields.sha512 || !fields.codeVersion || !fields.minBaseVersion || !fields.filesHash) {
    return false;
  }
  try {
    const sigBuf = Buffer.from(fields.signature, 'base64');
    // v2 first when url/size are available (Ed25519 → algorithm must be null).
    if (fields.url != null && fields.size != null) {
      const v2 = buildSignedPayload(
        fields.sha512,
        fields.codeVersion,
        fields.minBaseVersion,
        fields.filesHash,
        fields.url,
        fields.size,
      );
      if (cryptoVerify(null, v2, publicKey, sigBuf)) return true;
    }
    // v1 fallback (legacy 4-field payload).
    const v1 = buildSignedPayload(fields.sha512, fields.codeVersion, fields.minBaseVersion, fields.filesHash);
    return cryptoVerify(null, v1, publicKey, sigBuf);
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
