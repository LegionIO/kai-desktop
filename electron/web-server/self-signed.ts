import forge from 'node-forge';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { networkInterfaces } from 'os';

const CERT_DIR = join(homedir(), '.' + __BRAND_APP_SLUG, 'certs');
const CERT_PATH = join(CERT_DIR, 'web-ui.crt');
const KEY_PATH = join(CERT_DIR, 'web-ui.key');
const META_PATH = join(CERT_DIR, 'web-ui.json');

/** Collect all local IP addresses + localhost names for SAN entries. */
function getLocalAddresses(): string[] {
  const addresses = new Set<string>(['127.0.0.1', '::1', 'localhost']);
  const ifaces = networkInterfaces();
  for (const entries of Object.values(ifaces)) {
    if (!entries) continue;
    for (const entry of entries) {
      if (!entry.internal) {
        addresses.add(entry.address);
      }
    }
  }
  return [...addresses].sort();
}

type CertMeta = {
  addresses: string[];
  notAfter: string;
};

function readMeta(): CertMeta | null {
  try {
    if (!existsSync(META_PATH)) return null;
    return JSON.parse(readFileSync(META_PATH, 'utf-8')) as CertMeta;
  } catch {
    return null;
  }
}

function isCertValid(meta: CertMeta, currentAddresses: string[]): boolean {
  // Check expiry (must have > 7 days remaining)
  const notAfter = new Date(meta.notAfter);
  const sevenDaysFromNow = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  if (notAfter < sevenDaysFromNow) return false;

  // Check that all current addresses are covered
  const covered = new Set(meta.addresses);
  for (const addr of currentAddresses) {
    if (!covered.has(addr)) return false;
  }

  // Check files exist
  if (!existsSync(CERT_PATH) || !existsSync(KEY_PATH)) return false;

  return true;
}

function generateSelfSignedCert(addresses: string[]): { cert: string; key: string } {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();

  cert.publicKey = keys.publicKey;
  cert.serialNumber = Date.now().toString(16);
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notAfter.getFullYear() + 1);

  const attrs = [
    { name: 'commonName', value: 'Kai Web UI' },
    { name: 'organizationName', value: 'Kai Desktop' },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);

  // Build SAN entries
  const altNames: Array<{ type: number; value?: string; ip?: string }> = [];
  for (const addr of addresses) {
    if (addr === 'localhost') {
      altNames.push({ type: 2, value: 'localhost' }); // DNS
    } else if (addr.includes(':')) {
      altNames.push({ type: 7, ip: addr }); // IPv6
    } else if (/^\d+\.\d+\.\d+\.\d+$/.test(addr)) {
      altNames.push({ type: 7, ip: addr }); // IPv4
    } else {
      altNames.push({ type: 2, value: addr }); // DNS
    }
  }

  cert.setExtensions([
    { name: 'basicConstraints', cA: true },
    { name: 'keyUsage', keyCertSign: true, digitalSignature: true, keyEncipherment: true },
    { name: 'extKeyUsage', serverAuth: true },
    { name: 'subjectAltName', altNames },
  ]);

  cert.sign(keys.privateKey, forge.md.sha256.create());

  return {
    cert: forge.pki.certificateToPem(cert),
    key: forge.pki.privateKeyToPem(keys.privateKey),
  };
}

/**
 * Get or create a self-signed TLS certificate.
 * Reuses an existing cert if it's non-expired and covers all current IPs.
 */
export function ensureSelfSignedCert(): { cert: string; key: string } {
  mkdirSync(CERT_DIR, { recursive: true });
  const addresses = getLocalAddresses();
  const meta = readMeta();

  if (meta && isCertValid(meta, addresses)) {
    return {
      cert: readFileSync(CERT_PATH, 'utf-8'),
      key: readFileSync(KEY_PATH, 'utf-8'),
    };
  }

  // Generate new cert
  console.info(`[WebServer] Generating self-signed certificate for: ${addresses.join(', ')}`);
  const { cert, key } = generateSelfSignedCert(addresses);

  writeFileSync(CERT_PATH, cert, 'utf-8');
  writeFileSync(KEY_PATH, key, 'utf-8');
  writeFileSync(META_PATH, JSON.stringify({
    addresses,
    notAfter: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
  } satisfies CertMeta), 'utf-8');

  return { cert, key };
}
