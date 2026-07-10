/**
 * OTA test harness — generates validly-signed (or deliberately-broken) OTA
 * archives + feed entries for exercising the real download→verify→extract→
 * stage→apply→bootstrap cycle in tests. Test-only; not shipped.
 *
 * Reuses the PRODUCTION signing primitives (buildSignedPayload / computeFilesHash)
 * so a "valid" archive here is valid by the exact same rules the app enforces.
 */
import { generateKeyPairSync, createHash, sign as cryptoSign, type KeyObject } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildSignedPayload, computeFilesHash } from '../signing.js';
import type { OtaFeed, OtaManifest } from '../types.js';

export interface HarnessKeys {
  privateKey: KeyObject;
  /** PEM SPKI public key — pass to verifyOtaSignature(fields, publicKeyPem). */
  publicKeyPem: string;
}

export function generateOtaKeys(): HarnessKeys {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { privateKey, publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }) as string };
}

function sha512File(path: string): string {
  return createHash('sha512').update(readFileSync(path)).digest('hex');
}

export interface BuildArchiveOptions {
  keys: HarnessKeys;
  codeVersion: string;
  baseVersion?: string;
  minBaseVersion?: string;
  /** relative-path → file contents for the overlay (default: a minimal main bundle). */
  files?: Record<string, string>;
  /** URL the feed will advertise (default filled in by the server helper). */
  url: string;
  /** Tamper hooks for adversarial cases. */
  tamper?: {
    /** Corrupt one file's on-disk bytes AFTER hashing (filesHash mismatch on extract). */
    corruptFileAfterHash?: string;
    /** Break the Ed25519 signature. */
    badSignature?: boolean;
    /** Add a `../escape` member to the tar (zip-slip). */
    zipSlip?: boolean;
    /** Report a wrong size in the feed. */
    wrongSize?: number;
  };
}

export interface BuiltArchive {
  archivePath: string;
  feed: OtaFeed;
  /** dir holding archive + feed json; serve this over http. */
  dir: string;
}

/**
 * Build a .tar.gz OTA archive + a matching signed feed entry on disk.
 * Returns the archive path + feed object (write the feed as latest-ota.json
 * when serving).
 */
export function buildSignedArchive(opts: BuildArchiveOptions): BuiltArchive {
  const dir = mkdtempSync(join(tmpdir(), 'kai-ota-build-'));
  const src = join(dir, 'src');
  mkdirSync(src, { recursive: true });

  const files = opts.files ?? { 'out/main/index.js': "console.log('ota overlay');\n" };
  const fileEntries: Record<string, { sha512: string; size: number }> = {};
  for (const [rel, contents] of Object.entries(files)) {
    const full = join(src, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, contents, 'utf-8');
    fileEntries[rel] = { sha512: sha512File(full), size: Buffer.byteLength(contents) };
  }

  const filesHash = computeFilesHash(fileEntries);
  const manifest: OtaManifest = {
    codeVersion: opts.codeVersion,
    baseVersion: opts.baseVersion ?? '1.0.0',
    minBaseVersion: opts.minBaseVersion ?? '1.0.0',
    files: fileEntries,
    createdAt: new Date().toISOString(),
    filesHash,
  };
  writeFileSync(join(src, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8');

  // Optional zip-slip: stage an escape file OUTSIDE src and add it by relative
  // `../` path so the tar contains a traversal member.
  const tarArgs = ['-czf'];
  const archivePath = join(dir, 'ota-archive.tar.gz');
  if (opts.tamper?.zipSlip) {
    writeFileSync(join(dir, 'escape.txt'), 'pwned', 'utf-8');
    // Build the tar from `dir` so we can reference ../ escape members.
    execFileSync('/usr/bin/tar', [
      '-czf',
      archivePath,
      '-C',
      src,
      '.',
      '-C',
      dir,
      // add an entry that extracts to ../escape.txt relative to extract root
      '--transform',
      's,^escape.txt,../escape.txt,',
      'escape.txt',
    ]);
  } else {
    execFileSync('/usr/bin/tar', [...tarArgs, archivePath, '-C', src, '.']);
  }

  // Corrupt a file AFTER it was hashed into the manifest → extract-time filesHash/hash mismatch.
  if (opts.tamper?.corruptFileAfterHash) {
    // Rebuild the archive with the corrupted content but the ORIGINAL manifest.
    const rel = opts.tamper.corruptFileAfterHash;
    writeFileSync(join(src, rel), 'CORRUPTED-AFTER-HASH\n', 'utf-8');
    execFileSync('/usr/bin/tar', ['-czf', archivePath, '-C', src, '.']);
  }

  const archiveSha512 = sha512File(archivePath);
  const size = opts.tamper?.wrongSize ?? readFileSync(archivePath).byteLength;

  // Sign the (v1) payload with the ephemeral private key.
  const payload = buildSignedPayload(archiveSha512, opts.codeVersion, manifest.minBaseVersion, filesHash);
  let signature = cryptoSign(null, payload, opts.keys.privateKey).toString('base64');
  if (opts.tamper?.badSignature) {
    signature = Buffer.from('not-a-valid-signature').toString('base64');
  }

  const feed: OtaFeed = {
    latest: {
      codeVersion: opts.codeVersion,
      minBaseVersion: manifest.minBaseVersion,
      url: opts.url,
      sha512: archiveSha512,
      size,
      releaseDate: new Date().toISOString(),
      filesHash,
      signature,
    },
  };

  writeFileSync(join(dir, 'latest-ota.json'), JSON.stringify(feed, null, 2), 'utf-8');
  return { archivePath, feed, dir };
}
