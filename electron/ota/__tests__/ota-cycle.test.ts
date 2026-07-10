/**
 * OTA end-to-end harness sanity + adversarial signature/verify coverage.
 *
 * Verifies the harness produces archives that pass the PRODUCTION signature +
 * filesHash checks, and that each tamper variant is rejected. This is the
 * foundation the download/apply hardening tests build on.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { verifyOtaSignature, computeFilesHash, type OtaSignedFields } from '../signing.js';
import { generateOtaKeys, buildSignedArchive } from './ota-harness.js';
import type { OtaFeedEntry } from '../types.js';

/** The harness always populates filesHash+signature, so this narrowing is safe in tests. */
function signedFields(latest: OtaFeedEntry): OtaSignedFields {
  return {
    sha512: latest.sha512,
    codeVersion: latest.codeVersion,
    minBaseVersion: latest.minBaseVersion,
    filesHash: latest.filesHash!,
    signature: latest.signature!,
    url: latest.url,
    size: latest.size,
  };
}

describe('OTA harness signature round-trip', () => {
  it('a clean signed archive verifies against its ephemeral public key', () => {
    const keys = generateOtaKeys();
    const { feed, archivePath } = buildSignedArchive({ keys, codeVersion: '1.1.0', url: 'ota.tar.gz' });
    const { latest } = feed;

    // Signature verifies with the harness key, and fails with the (wrong) baked key.
    expect(verifyOtaSignature(signedFields(latest), keys.publicKeyPem)).toBe(true);
    expect(verifyOtaSignature(signedFields(latest))).toBe(false);

    // The advertised archive sha512 matches the file on disk.
    const actual = createHash('sha512').update(readFileSync(archivePath)).digest('hex');
    expect(actual).toBe(latest.sha512);
  });

  it('a bad signature is rejected', () => {
    const keys = generateOtaKeys();
    const { feed } = buildSignedArchive({
      keys,
      codeVersion: '1.1.0',
      url: 'ota.tar.gz',
      tamper: { badSignature: true },
    });
    expect(verifyOtaSignature(signedFields(feed.latest), keys.publicKeyPem)).toBe(false);
  });

  it('a filesHash that does not match the files map is detected', () => {
    const keys = generateOtaKeys();
    const { feed } = buildSignedArchive({
      keys,
      codeVersion: '1.1.0',
      url: 'ota.tar.gz',
      files: { 'out/main/index.js': 'a', 'out/main/chunk.js': 'b' },
    });
    // Recompute over a DIFFERENT files map → mismatch (proves filesHash binds the set).
    const tampered = computeFilesHash({ 'out/main/index.js': { sha512: 'deadbeef' } });
    expect(tampered).not.toBe(feed.latest.filesHash);
  });

  it('v2 signature binds url+size (a url/size swap breaks verification)', () => {
    const keys = generateOtaKeys();
    const { feed } = buildSignedArchive({ keys, codeVersion: '1.1.0', url: 'ota.tar.gz' });
    // Correct url/size verifies…
    expect(verifyOtaSignature(signedFields(feed.latest), keys.publicKeyPem)).toBe(true);
    // …but tampering the url breaks it (v2 fails, and v1 fallback doesn't cover url).
    const swapped = { ...signedFields(feed.latest), url: 'evil.tar.gz' };
    expect(verifyOtaSignature(swapped, keys.publicKeyPem)).toBe(false);
    const resized = { ...signedFields(feed.latest), size: (feed.latest.size ?? 0) + 1 };
    expect(verifyOtaSignature(resized, keys.publicKeyPem)).toBe(false);
  });

  it('BACK-COMPAT: a legacy v1-signed archive still verifies (no brick window)', () => {
    const keys = generateOtaKeys();
    // Sign the old 4-field payload — an archive from a signer that predates v2.
    const { feed } = buildSignedArchive({ keys, codeVersion: '1.1.0', url: 'ota.tar.gz', signV1: true });
    // The new verifier (which prefers v2) must fall back to v1 and accept it.
    expect(verifyOtaSignature(signedFields(feed.latest), keys.publicKeyPem)).toBe(true);
  });
});
