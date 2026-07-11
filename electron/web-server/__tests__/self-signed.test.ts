/**
 * Tests for the web-bridge self-signed TLS cert generator (self-signed.ts). This
 * cert secures the authenticated web mirror over HTTPS/WSS on the LAN, so the
 * security-relevant properties are pinned here: it must be a server LEAF (cA:false,
 * serverAuth), cover localhost + local IPs with correctly-typed SAN entries, use
 * a real RSA key, and store the private key 0o600 in a 0o700 dir. Reuse must be
 * gated on expiry + address coverage.
 *
 * CERT_DIR is derived from homedir() at MODULE LOAD, so HOME is repointed at a
 * temp dir BEFORE importing the module.
 */
import { describe, it, expect } from 'vitest';
import forge from 'node-forge';
import { mkdtempSync, existsSync, statSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Repoint HOME before importing so CERT_DIR lands in a throwaway dir.
const HOME = mkdtempSync(join(tmpdir(), 'kai-selfsigned-'));
process.env.HOME = HOME;

const { ensureSelfSignedCert } = await import('../self-signed.js');

const isWin = process.platform === 'win32';

describe('ensureSelfSignedCert', () => {
  it('produces a parseable RSA server-leaf certificate', () => {
    const { cert, key } = ensureSelfSignedCert();
    expect(cert).toContain('BEGIN CERTIFICATE');
    expect(key).toContain('PRIVATE KEY');

    const parsed = forge.pki.certificateFromPem(cert);
    // RSA public key.
    expect((parsed.publicKey as forge.pki.rsa.PublicKey).n).toBeDefined();

    // basicConstraints: NOT a CA (server leaf).
    const bc = parsed.getExtension('basicConstraints') as { cA?: boolean } | undefined;
    expect(bc).toBeDefined();
    expect(bc?.cA).toBe(false);

    // extKeyUsage: serverAuth.
    const eku = parsed.getExtension('extKeyUsage') as { serverAuth?: boolean } | undefined;
    expect(eku?.serverAuth).toBe(true);

    // keyUsage: digitalSignature + keyEncipherment, and NOT keyCertSign.
    const ku = parsed.getExtension('keyUsage') as
      | { digitalSignature?: boolean; keyEncipherment?: boolean; keyCertSign?: boolean }
      | undefined;
    expect(ku?.digitalSignature).toBe(true);
    expect(ku?.keyEncipherment).toBe(true);
    expect(ku?.keyCertSign).toBeFalsy();
  });

  it('includes SAN entries for localhost + loopback with correct types', () => {
    const { cert } = ensureSelfSignedCert();
    const parsed = forge.pki.certificateFromPem(cert);
    const san = parsed.getExtension('subjectAltName') as
      | { altNames: Array<{ type: number; value?: string; ip?: string }> }
      | undefined;
    expect(san).toBeDefined();
    const names = san!.altNames;
    // localhost → DNS (type 2)
    expect(names.some((n) => n.type === 2 && n.value === 'localhost')).toBe(true);
    // 127.0.0.1 → IP (type 7)
    expect(names.some((n) => n.type === 7 && n.ip === '127.0.0.1')).toBe(true);
    // ::1 → IP (type 7). node-forge normalizes the IPv6 string; just assert an IP-type ::1-ish entry exists.
    expect(names.some((n) => n.type === 7 && (n.ip === '::1' || n.ip?.includes(':')))).toBe(true);
  });

  it('sets a ~1-year validity window', () => {
    const { cert } = ensureSelfSignedCert();
    const parsed = forge.pki.certificateFromPem(cert);
    const spanMs = parsed.validity.notAfter.getTime() - parsed.validity.notBefore.getTime();
    const oneYear = 365 * 24 * 60 * 60 * 1000;
    // Within a day of a year (leap-year / setFullYear slack).
    expect(Math.abs(spanMs - oneYear)).toBeLessThan(2 * 24 * 60 * 60 * 1000);
  });

  it('reuses the cached cert on a second call (valid + covers addresses)', () => {
    const first = ensureSelfSignedCert();
    const second = ensureSelfSignedCert();
    expect(second.cert).toBe(first.cert);
    expect(second.key).toBe(first.key);
  });

  it('stores the private key 0o600 inside a 0o700 certs dir (POSIX)', () => {
    if (isWin) return;
    ensureSelfSignedCert();
    // The module writes ~/.<slug>/certs/{web-ui.crt,web-ui.key,web-ui.json}.
    // Locate the certs dir under HOME without hardcoding the brand slug.
    const dotDir = readdirSync(HOME).find((d) => d.startsWith('.'));
    expect(dotDir).toBeDefined();
    const dir = join(HOME, dotDir!, 'certs');
    expect(existsSync(join(dir, 'web-ui.key'))).toBe(true);
    expect(statSync(join(dir, 'web-ui.key')).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });
});
