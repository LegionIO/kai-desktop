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
});
