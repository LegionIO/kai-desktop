/**
 * Tests for the post-update marker lifecycle in auto-update.ts. The marker is
 * written before quitAndInstall() and consumed after relaunch to fire
 * post-update hooks (e.g. revoking admin granted by a pre-update hook). The
 * safety-critical property: a stale/failed-install marker must NOT cause
 * success post-hooks to fire for a version we're not running — that gate lives
 * in the main.ts consumer (marker.version === app.getVersion()), and these tests
 * document + lock the marker's own read/delete/self-heal behavior.
 *
 * POST_UPDATE_MARKER = join(app.getPath('userData'), '.update-completed') is a
 * module-level const, so electron (getPath/getVersion), electron-updater, and
 * window-send are mocked and KAI_USER_DATA is repointed before import.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const USERDATA = mkdtempSync(join(tmpdir(), 'kai-autoupdate-'));
process.env.KAI_USER_DATA = USERDATA;
const CURRENT_VERSION = '2.5.0';

vi.mock('electron', () => ({
  app: { getPath: () => USERDATA, getVersion: () => CURRENT_VERSION },
  dialog: { showMessageBox: vi.fn() },
}));
vi.mock('electron-updater', () => ({
  default: { autoUpdater: { on: vi.fn(), logger: null, autoDownload: false } },
}));
vi.mock('../../utils/window-send.js', () => ({ broadcastToAllWindows: vi.fn() }));

const {
  consumePostUpdateMarker,
  withTimeout,
  PRE_UPDATE_HOOK_TIMEOUT_MS,
  resolveDownloadMode,
  shouldForceSingleRange,
  parseUpdateConfigFields,
} = await import('../auto-update.js');

const MARKER = join(USERDATA, '.update-completed');
const writeMarker = (obj: unknown) => writeFileSync(MARKER, JSON.stringify(obj));

beforeEach(() => {
  rmSync(MARKER, { force: true });
});
afterEach(() => vi.clearAllMocks());

describe('consumePostUpdateMarker', () => {
  it('returns null when no marker exists', () => {
    expect(consumePostUpdateMarker()).toBeNull();
  });

  it('reads a valid marker and deletes it (consumed exactly once)', () => {
    writeMarker({ version: '2.5.0', fromVersion: '2.4.0', timestamp: Date.now() });
    const first = consumePostUpdateMarker();
    expect(first).toMatchObject({ version: '2.5.0', fromVersion: '2.4.0' });
    // The marker file is removed on read → a second consume returns null.
    expect(existsSync(MARKER)).toBe(false);
    expect(consumePostUpdateMarker()).toBeNull();
  });

  it('self-heals: deletes the marker and returns null on corrupt JSON', () => {
    writeFileSync(MARKER, '{ not valid json ');
    expect(consumePostUpdateMarker()).toBeNull();
    expect(existsSync(MARKER)).toBe(false); // corrupt marker cleaned up
  });

  it('returns a malformed-but-valid-JSON marker as-is (shape safety is the consumer’s job)', () => {
    // The main.ts consumer gates success on marker.version === app.getVersion(),
    // so a marker with a wrong/absent version fails safe (success=false) even
    // though consume() itself does not validate the shape.
    writeMarker({});
    const r = consumePostUpdateMarker() as { version?: string } | null;
    expect(r).toEqual({});
    // Simulate the consumer's fail-safe gate: version !== current → not a success.
    expect(r?.version === CURRENT_VERSION).toBe(false);
  });

  it('a stale marker for a DIFFERENT version does not equal the running version (fail-safe)', () => {
    writeMarker({ version: '9.9.9', fromVersion: '2.4.0' });
    const r = consumePostUpdateMarker();
    expect(r?.version).toBe('9.9.9');
    // The consumer would compute success = ('9.9.9' === '2.5.0') === false.
    expect(r?.version === CURRENT_VERSION).toBe(false);
  });

  it('a marker matching the running version is treated as a successful update', () => {
    writeMarker({ version: CURRENT_VERSION, fromVersion: '2.4.0' });
    const r = consumePostUpdateMarker();
    expect(r?.version === CURRENT_VERSION).toBe(true);
  });
});

describe('withTimeout (pre-update-hook bound)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('resolves { timedOut:false, value } when the promise settles before the deadline', async () => {
    const p = withTimeout(Promise.resolve('ok'), 1000);
    await vi.advanceTimersByTimeAsync(0);
    await expect(p).resolves.toEqual({ timedOut: false, value: 'ok' });
  });

  it('resolves { timedOut:true } when the promise never settles before the deadline', async () => {
    const never = new Promise<string>(() => {}); // never resolves
    const p = withTimeout(never, 5000);
    await vi.advanceTimersByTimeAsync(5000);
    await expect(p).resolves.toEqual({ timedOut: true });
  });

  it('does not time out a promise that settles just under the deadline', async () => {
    let resolveFn!: (v: string) => void;
    const slow = new Promise<string>((r) => (resolveFn = r));
    const p = withTimeout(slow, 5000);
    await vi.advanceTimersByTimeAsync(4999);
    resolveFn('done');
    await expect(p).resolves.toEqual({ timedOut: false, value: 'done' });
  });

  it('propagates a rejection from the raced promise (not swallowed by the timeout)', async () => {
    // Reject inside an executor so the rejection isn't a floating unhandled
    // promise before withTimeout attaches its handler.
    const failing = new Promise<string>((_resolve, reject) => reject(new Error('hook failed')));
    const p = withTimeout(failing, 1000);
    await expect(p).rejects.toThrow('hook failed');
    await vi.advanceTimersByTimeAsync(0);
  });

  it('PRE_UPDATE_HOOK_TIMEOUT_MS is a sane positive bound (5 min)', () => {
    expect(PRE_UPDATE_HOOK_TIMEOUT_MS).toBe(5 * 60 * 1000);
  });
});

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
