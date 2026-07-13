/**
 * Focused unit tests for the pure signing primitives in signing.ts. The full
 * crypto round-trip + tamper matrix is already exercised by ota-cycle.test.ts
 * (via the harness keypair); this file locks the pieces that file does not:
 *
 *  - buildSignedPayload's EXACT canonical byte string (v1 4-field / v2 6-field).
 *    The doc-comment says it "MUST match scripts/build-ota-archive.ts exactly" —
 *    a drift between signer and verifier silently breaks every update, so the
 *    format is pinned here as an explicit contract.
 *  - computeFilesHash determinism (key-sort independence) — the guarantee that
 *    binds the per-file integrity table to the signature.
 *  - verifyOtaSignature's missing-field short-circuit (no throw, returns false).
 *
 * A locally generated Ed25519 keypair backs the positive round-trip + v1/v2
 * fallback assertions (no dependency on the build-baked key).
 */
import { describe, it, expect } from 'vitest';
import { generateKeyPairSync, sign as cryptoSign } from 'crypto';
import { buildSignedPayload, computeFilesHash, verifyOtaSignature, type OtaSignedFields } from '../signing.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();

function signPayload(payload: Buffer): string {
  return cryptoSign(null, payload, privateKey).toString('base64');
}

describe('buildSignedPayload', () => {
  it('produces the exact v1 4-field newline-joined string when url/size are absent', () => {
    const buf = buildSignedPayload('SHA', '1.2.3', '1.0.0', 'FILESHASH');
    expect(buf.toString('utf8')).toBe('SHA\n1.2.3\n1.0.0\nFILESHASH');
  });

  it('appends url + size for the v2 payload', () => {
    const buf = buildSignedPayload('SHA', '1.2.3', '1.0.0', 'FILESHASH', 'https://cdn/x.zip', 4096);
    expect(buf.toString('utf8')).toBe('SHA\n1.2.3\n1.0.0\nFILESHASH\nhttps://cdn/x.zip\n4096');
  });

  it('falls back to v1 when only one of url/size is supplied', () => {
    // url without size and size without url must NOT produce a partial v2 string.
    expect(buildSignedPayload('S', 'c', 'm', 'f', 'https://u').toString('utf8')).toBe('S\nc\nm\nf');
    expect(buildSignedPayload('S', 'c', 'm', 'f', undefined, 10).toString('utf8')).toBe('S\nc\nm\nf');
  });

  it('treats size 0 as present (v2), not absent', () => {
    // size != null admits 0 — a zero-byte archive is still authenticated.
    expect(buildSignedPayload('S', 'c', 'm', 'f', 'https://u', 0).toString('utf8')).toBe('S\nc\nm\nf\nhttps://u\n0');
  });
});

describe('computeFilesHash', () => {
  it('is independent of insertion order (keys are sorted)', () => {
    const a = computeFilesHash({ 'b.js': { sha512: '2' }, 'a.js': { sha512: '1' } });
    const b = computeFilesHash({ 'a.js': { sha512: '1' }, 'b.js': { sha512: '2' } });
    expect(a).toBe(b);
  });

  it('changes when any file hash changes', () => {
    const base = computeFilesHash({ 'a.js': { sha512: '1' } });
    const changed = computeFilesHash({ 'a.js': { sha512: '2' } });
    expect(changed).not.toBe(base);
  });

  it('changes when a file is added', () => {
    const one = computeFilesHash({ 'a.js': { sha512: '1' } });
    const two = computeFilesHash({ 'a.js': { sha512: '1' }, 'b.js': { sha512: '2' } });
    expect(two).not.toBe(one);
  });

  it('returns a stable hex digest for the empty map', () => {
    const h = computeFilesHash({});
    expect(h).toMatch(/^[0-9a-f]{64}$/); // sha256 hex
  });

  it('pins the EXACT digest for a known map (golden value anchors the canonical byte format)', () => {
    // The relative properties above hold for ANY self-consistent canonicalization,
    // so they would NOT catch a delimiter/format change. This golden value pins
    // the exact canon (`${key}\0${sha512}\n`, keys sorted, sha256-hex) that BOTH
    // signing.ts AND scripts/build-ota-archive.ts#computeFilesHash must emit — a
    // drift between signer and verifier silently breaks every OTA update, so if
    // either copy's format changes, this assertion (and thus CI) fails.
    expect(computeFilesHash({ 'a.js': { sha512: '1' }, 'b.js': { sha512: '2' } })).toBe(
      '9fa1b4823f049731ec6128f8d2acfb3f968f3998252aa7ae85dc08f6b05dd629',
    );
    // Empty map → sha256 of the empty string.
    expect(computeFilesHash({})).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });
});

describe('computeFilesHash — signer↔verifier source parity', () => {
  // signing.ts (verifier) and scripts/build-ota-archive.ts (signer) each carry a
  // duplicated computeFilesHash whose header says "MUST match ... exactly". A
  // divergence silently breaks every OTA update. Enforce it here: extract each
  // function body and assert they are byte-identical (modulo the param name +
  // whitespace), so editing one without the other fails CI.
  const extractBody = (src: string): string => {
    const start = src.indexOf('function computeFilesHash');
    expect(start, 'computeFilesHash not found').toBeGreaterThanOrEqual(0);
    // Grab from the opening brace to its matching close via a simple depth scan.
    let i = src.indexOf('{', start);
    let depth = 0;
    const from = i;
    for (; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}' && --depth === 0) break;
    }
    return src
      .slice(from + 1, i)
      .replace(/\bfiles\b/g, 'f') // signing.ts uses `files`, build script uses `f`
      .replace(/\s+/g, ' ')
      .trim();
  };

  it('the two copies compute the identical canonical hash body', () => {
    const verifier = readFileSync(resolve(__dirname, '../signing.ts'), 'utf-8');
    const signer = readFileSync(resolve(__dirname, '../../../scripts/build-ota-archive.ts'), 'utf-8');
    expect(extractBody(signer)).toBe(extractBody(verifier));
  });
});

describe('verifyOtaSignature', () => {
  const base: Omit<OtaSignedFields, 'signature'> = {
    sha512: 'archsha',
    codeVersion: '2.0.0',
    minBaseVersion: '1.0.0',
    filesHash: computeFilesHash({ 'out/main/index.js': { sha512: 'abc' } }),
  };

  it('verifies a valid v1 signature', () => {
    const sig = signPayload(buildSignedPayload(base.sha512, base.codeVersion, base.minBaseVersion, base.filesHash));
    expect(verifyOtaSignature({ ...base, signature: sig }, publicKeyPem)).toBe(true);
  });

  it('verifies a valid v2 signature (url + size bound)', () => {
    const url = 'https://cdn/app-2.0.0.zip';
    const size = 123456;
    const sig = signPayload(
      buildSignedPayload(base.sha512, base.codeVersion, base.minBaseVersion, base.filesHash, url, size),
    );
    expect(verifyOtaSignature({ ...base, url, size, signature: sig }, publicKeyPem)).toBe(true);
  });

  it('accepts a v1 signature even when url/size are present (v1 fallback path)', () => {
    // A still-in-flight v1 archive verified by a v2-aware install: url/size are on
    // the fields but the signature only covers the v1 payload → fallback accepts.
    const v1sig = signPayload(buildSignedPayload(base.sha512, base.codeVersion, base.minBaseVersion, base.filesHash));
    expect(verifyOtaSignature({ ...base, url: 'https://cdn/x.zip', size: 999, signature: v1sig }, publicKeyPem)).toBe(
      true,
    );
  });

  it('rejects when the url is tampered under a v2 signature', () => {
    const sig = signPayload(
      buildSignedPayload(base.sha512, base.codeVersion, base.minBaseVersion, base.filesHash, 'https://good', 100),
    );
    // Swap the url; neither v2 (url differs) nor v1 (signature covers 6 fields) verifies.
    expect(verifyOtaSignature({ ...base, url: 'https://evil', size: 100, signature: sig }, publicKeyPem)).toBe(false);
  });

  it('rejects an empty or missing required field without throwing', () => {
    const sig = signPayload(buildSignedPayload(base.sha512, base.codeVersion, base.minBaseVersion, base.filesHash));
    expect(verifyOtaSignature({ ...base, signature: '' }, publicKeyPem)).toBe(false);
    expect(verifyOtaSignature({ ...base, sha512: '', signature: sig }, publicKeyPem)).toBe(false);
    expect(verifyOtaSignature({ ...base, codeVersion: '', signature: sig }, publicKeyPem)).toBe(false);
    expect(verifyOtaSignature({ ...base, minBaseVersion: '', signature: sig }, publicKeyPem)).toBe(false);
    expect(verifyOtaSignature({ ...base, filesHash: '', signature: sig }, publicKeyPem)).toBe(false);
  });

  it('returns false (no throw) on a malformed signature / key', () => {
    expect(verifyOtaSignature({ ...base, signature: 'not-base64-!!!' }, publicKeyPem)).toBe(false);
    expect(verifyOtaSignature({ ...base, signature: 'AAAA' }, 'not-a-pem-key')).toBe(false);
  });

  it('rejects a signature made by a different key', () => {
    const other = generateKeyPairSync('ed25519').privateKey;
    const sig = cryptoSign(
      null,
      buildSignedPayload(base.sha512, base.codeVersion, base.minBaseVersion, base.filesHash),
      other,
    ).toString('base64');
    expect(verifyOtaSignature({ ...base, signature: sig }, publicKeyPem)).toBe(false);
  });
});
