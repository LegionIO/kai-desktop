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

const { consumePostUpdateMarker } = await import('../auto-update.js');

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
