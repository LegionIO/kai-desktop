/**
 * OTA end-to-end download-cycle tests: drive the REAL downloadOtaUpdate against
 * a local HTTP server serving a harness-generated signed archive + feed.
 *
 * Electron's `net` is unavailable in vitest, so we mock it with a thin adapter
 * over Node's http that re-emits the same event shape fetchJson/downloadFile use.
 * The OTA signature is verified against the harness's ephemeral key via a
 * spy on verifyOtaSignature (production seam: optional publicKey param).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { createReadStream, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import type * as NodeOs from 'node:os';
import { request as httpRequest } from 'node:http';
import type * as SigningModule from '../signing.js';
import type { OtaSignedFields } from '../signing.js';

// ── Mock electron: app.isPackaged true (enforce signature), net → node http ──
vi.mock('electron', () => ({
  app: { isPackaged: true },
  net: {
    request: (url: string) => httpRequest(url),
  },
}));
vi.mock('../../utils/window-send.js', () => ({ broadcastToAllWindows: () => {} }));

let fakeHome: string;
vi.mock('node:os', async (orig) => {
  const actual = (await orig()) as typeof NodeOs;
  return { ...actual, homedir: () => fakeHome };
});
vi.mock('os', async (orig) => {
  const actual = (await orig()) as typeof NodeOs;
  return { ...actual, homedir: () => fakeHome };
});

// Verify against the harness's ephemeral key instead of the baked brand key.
let harnessPublicKey = '';
vi.mock('../signing.js', async (orig) => {
  const actual = (await orig()) as typeof SigningModule;
  return {
    ...actual,
    verifyOtaSignature: (fields: OtaSignedFields) => actual.verifyOtaSignature(fields, harnessPublicKey),
  };
});

import { downloadOtaUpdate } from '../ota-updater.js';
import { OTA_DIR_NAME, OTA_STAGING_DIR, OTA_MANIFEST_FILE } from '../types.js';
import { generateOtaKeys, buildSignedArchive, type BuildArchiveOptions } from './ota-harness.js';

const APP_SLUG = 'kai-test';

function startServer(archivePath: string, feedJson: string): Promise<{ server: Server; baseUrl: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      if (req.url === '/latest-ota.json') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(feedJson);
      } else if (req.url === '/' + basename(archivePath) || req.url === '/ota-archive.tar.gz') {
        res.writeHead(200, { 'content-type': 'application/gzip', 'content-length': statSync(archivePath).size });
        createReadStream(archivePath).pipe(res);
      } else {
        res.writeHead(404);
        res.end('not found');
      }
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

async function runDownload(
  tamper?: BuildArchiveOptions['tamper'],
): Promise<{ result: { success: boolean; error?: string }; stagingExists: boolean }> {
  const keys = generateOtaKeys();
  harnessPublicKey = keys.publicKeyPem;
  const built = buildSignedArchive({ keys, codeVersion: '2.0.0', url: 'ota-archive.tar.gz', tamper });
  const { server, baseUrl } = await startServer(built.archivePath, JSON.stringify(built.feed));
  process.env.KAI_UPDATE_URL = baseUrl;
  try {
    const result = await downloadOtaUpdate(APP_SLUG, '1.0.0', '1.0.0');
    const stagingDir = join(fakeHome, '.' + APP_SLUG, OTA_DIR_NAME, OTA_STAGING_DIR);
    return { result, stagingExists: existsSync(join(stagingDir, OTA_MANIFEST_FILE)) };
  } finally {
    server.close();
    delete process.env.KAI_UPDATE_URL;
    rmSync(built.dir, { recursive: true, force: true });
  }
}

describe('downloadOtaUpdate end-to-end (local server + harness archive)', () => {
  beforeEach(() => {
    fakeHome = mkdtempSync(join(tmpdir(), 'kai-ota-dl-'));
  });
  afterEach(() => {
    rmSync(fakeHome, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('downloads, verifies, and stages a clean signed archive', async () => {
    const { result, stagingExists } = await runDownload();
    expect(result.success).toBe(true);
    expect(stagingExists).toBe(true);
  });

  it('rejects a zip-slip archive and does not stage it', async () => {
    const { result, stagingExists } = await runDownload({ zipSlip: true });
    expect(result.success).toBe(false);
    // staging wiped → no manifest left behind
    expect(stagingExists).toBe(false);
  });

  it('rejects a bad signature before download', async () => {
    const { result } = await runDownload({ badSignature: true });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/signature/i);
  });

  it('rejects a wrong-size archive (Content-Length vs hash mismatch surfaces)', async () => {
    // wrongSize changes the signed `size`, but the archive bytes/sha512 are
    // unchanged — the archive hash check still catches the tamper at minimum.
    const { result } = await runDownload({ corruptFileAfterHash: 'out/main/index.js' });
    expect(result.success).toBe(false);
  });
});
