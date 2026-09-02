/**
 * Tests for auto-update.ts download-mode + config-path resolution helpers. The
 * post-update cleanup state now lives in the attempt-scoped ledger
 * (post-update-ledger.ts) and is covered by post-update-ledger.test.ts.
 *
 * electron (getPath/getVersion), electron-updater, and window-send are mocked and
 * KAI_USER_DATA is repointed before import.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const USERDATA = mkdtempSync(join(tmpdir(), 'kai-autoupdate-'));
process.env.KAI_USER_DATA = USERDATA;
const CURRENT_VERSION = '2.5.0';

vi.mock('electron', () => ({
  app: { getPath: () => USERDATA, getVersion: () => CURRENT_VERSION, isPackaged: false, getAppPath: () => '/app/path' },
  dialog: { showMessageBox: vi.fn() },
}));
vi.mock('electron-updater', () => ({
  default: { autoUpdater: { on: vi.fn(), logger: null, autoDownload: false } },
}));
vi.mock('../../utils/window-send.js', () => ({ broadcastToAllWindows: vi.fn() }));

const { resolveDownloadMode, shouldForceSingleRange, parseUpdateConfigFields, resolveUpdateConfigPath } =
  await import('../auto-update.js');

afterEach(() => vi.clearAllMocks());

describe('resolveDownloadMode — bytes are authoritative over the logger label', () => {
  const FULL = 559_300_000; // ~559 MB, the reported full size

  it('labels a true delta (total well under full) as differential', () => {
    // 12 MB of a 559 MB app → clearly a delta.
    expect(resolveDownloadMode(12_000_000, FULL, 'differential')).toBe('differential');
  });

  it('CORRECTS a "differential" logger label to full when the bytes are the whole file', () => {
    // The reported bug: logger said differential but the full file downloaded.
    expect(resolveDownloadMode(FULL, FULL, 'differential')).toBe('full');
    // Within 2% of full also counts as full.
    expect(resolveDownloadMode(Math.floor(FULL * 0.99), FULL, 'differential')).toBe('full');
  });

  it('labels a full download as full even when the logger never fired', () => {
    expect(resolveDownloadMode(FULL, FULL, undefined)).toBe('full');
  });

  it('uses the 98% threshold as the delta/full boundary', () => {
    expect(resolveDownloadMode(Math.floor(FULL * 0.97), FULL, undefined)).toBe('differential');
    expect(resolveDownloadMode(Math.floor(FULL * 0.98), FULL, undefined)).toBe('full');
  });

  it('falls back to the logger label when the full size is unknown', () => {
    expect(resolveDownloadMode(12_000_000, undefined, 'differential')).toBe('differential');
    expect(resolveDownloadMode(12_000_000, 0, 'full')).toBe('full');
    expect(resolveDownloadMode(12_000_000, undefined, undefined)).toBeUndefined();
  });
});

describe('shouldForceSingleRange — macOS delta over generic/S3 providers', () => {
  it("forces single-range for S3-looking hosts in 'auto' mode", () => {
    // The reported bug: kai-platform on Optum's on-prem S3 → multipart/byteranges
    // unsupported → full download every time. Host contains "s3" → force single.
    expect(shouldForceSingleRange('https://s3api-core.optum.com/kai/releases/latest', 'auto')).toBe(true);
    expect(shouldForceSingleRange('https://my-bucket.s3.amazonaws.com/app', 'auto')).toBe(true);
    expect(shouldForceSingleRange('https://s3.us-east-1.example.com/kai', 'auto')).toBe(true);
  });

  it("leaves non-S3 hosts alone in 'auto' mode (multi-range assumed OK)", () => {
    expect(shouldForceSingleRange('https://downloads.example.com/kai', 'auto')).toBe(false);
    expect(shouldForceSingleRange('https://github.com/owner/repo/releases', 'auto')).toBe(false);
  });

  it("'always' forces regardless of URL; 'never' never forces", () => {
    expect(shouldForceSingleRange('https://downloads.example.com/kai', 'always')).toBe(true);
    expect(shouldForceSingleRange(undefined, 'always')).toBe(true);
    expect(shouldForceSingleRange('https://s3api-core.optum.com/kai', 'never')).toBe(false);
  });

  it('handles a missing/malformed URL safely', () => {
    expect(shouldForceSingleRange(undefined, 'auto')).toBe(false);
    expect(shouldForceSingleRange('not a url with s3 in it', 'auto')).toBe(true); // substring fallback
  });

  it('does NOT throw when the __BRAND_UPDATE_FORCE_SINGLE_RANGE define is absent (default mode)', () => {
    // Regression: a bare `= __BRAND_UPDATE_FORCE_SINGLE_RANGE` default param threw
    // ReferenceError at runtime in downstream builds (kai-platform) whose branding
    // overlay lacked the key, silently disabling the S3 delta fix. Calling with no
    // `mode` must fall back to 'auto' (S3-host detection), never throw. This test
    // file has no Vite define, so the identifier is genuinely undefined here.
    expect(() => shouldForceSingleRange('https://s3api-core.optum.com/kai')).not.toThrow();
    expect(shouldForceSingleRange('https://s3api-core.optum.com/kai')).toBe(true);
    expect(shouldForceSingleRange('https://downloads.example.com/kai')).toBe(false);
  });
});

describe('parseUpdateConfigFields — dependency-free app-update.yml scan', () => {
  it('parses the real baked generic/S3 config', () => {
    const yaml = [
      'provider: generic',
      'url: https://s3api-core.optum.com/kai/releases/latest',
      'updaterCacheDirName: kai-updater',
    ].join('\n');
    expect(parseUpdateConfigFields(yaml)).toEqual({
      provider: 'generic',
      url: 'https://s3api-core.optum.com/kai/releases/latest',
    });
  });

  it('parses a github provider config', () => {
    const yaml = 'provider: github\nowner: LegionIO\nrepo: kai-desktop\n';
    const out = parseUpdateConfigFields(yaml);
    expect(out.provider).toBe('github');
    expect(out.url).toBeUndefined();
  });

  it('strips surrounding quotes and tolerates CRLF + comments + blank lines', () => {
    const yaml = '# feed\r\nprovider: "generic"\r\n\r\nurl: \'https://s3.example.com/x\'\r\n';
    expect(parseUpdateConfigFields(yaml)).toEqual({
      provider: 'generic',
      url: 'https://s3.example.com/x',
    });
  });

  it('ignores nested (indented) keys and list items', () => {
    const yaml =
      'provider: generic\nurl: https://s3api-core.optum.com/kai\nfiles:\n  - url: Kai.zip\n    provider: nested\n';
    expect(parseUpdateConfigFields(yaml)).toEqual({
      provider: 'generic',
      url: 'https://s3api-core.optum.com/kai',
    });
  });

  it('returns empty on garbage/empty input', () => {
    expect(parseUpdateConfigFields('')).toEqual({});
    expect(parseUpdateConfigFields('just some text\nno colons here')).toEqual({});
  });
});

describe('resolveUpdateConfigPath — matches electron-updater ElectronAppAdapter', () => {
  it('uses the app path + dev-app-update.yml when not packaged', () => {
    // The mock sets isPackaged:false + getAppPath:'/app/path'. The bug being
    // guarded against was reading app.appUpdateConfigPath (undefined on Electron's
    // global app) instead of deriving the path ourselves.
    expect(resolveUpdateConfigPath()).toBe('/app/path/dev-app-update.yml');
  });
});
