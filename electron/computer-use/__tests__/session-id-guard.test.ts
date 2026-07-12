/**
 * Tests for SESSION_ID_RE (session-manager.ts) — the shape guard applied at the
 * sessionPath chokepoint before a computer-use session id becomes a filesystem
 * path (persistSession write, removeSession recursive rmSync). It must accept
 * only the exact makeComputerUseId('cs') shape and reject traversal / tampered
 * ids so a corrupt session.json read during hydrate() can't redirect a later
 * write or delete outside sessionsDir.
 *
 * `electron` and the heavy window/orchestrator deps are mocked so the module
 * loads in a plain-node test.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', on: vi.fn() },
  BrowserWindow: class {},
  Notification: class {
    static isSupported() {
      return false;
    }
  },
  screen: { getAllDisplays: () => [], getPrimaryDisplay: () => ({ bounds: {}, workArea: {} }) },
}));
vi.mock('../orchestrator.js', () => ({ ComputerUseOrchestrator: class {} }));
vi.mock('../operator-window.js', () => ({
  closeOperatorWindow: vi.fn(),
  openComputerSetupWindow: vi.fn(),
  openOperatorWindow: vi.fn(),
}));
vi.mock('../overlay-window.js', () => ({
  closeOverlayWindow: vi.fn(),
  createOverlayWindow: vi.fn(),
  updateOverlayState: vi.fn(),
}));

const { SESSION_ID_RE } = await import('../session-manager.js');
const { makeComputerUseId } = await import('../../../shared/computer-use.js');

describe('SESSION_ID_RE', () => {
  it('accepts the exact makeComputerUseId("cs") shape', () => {
    for (let i = 0; i < 20; i++) {
      expect(SESSION_ID_RE.test(makeComputerUseId('cs'))).toBe(true);
    }
  });

  it('accepts a hand-written well-formed id', () => {
    expect(SESSION_ID_RE.test('cs-1783835655123-0a1b2c3d')).toBe(true);
  });

  it('rejects path-traversal ids', () => {
    for (const bad of [
      '../etc',
      'cs-1-0a1b2c3d/../../evil',
      '../../../../tmp/x',
      'cs-1-0a1b2c3d/..',
      'cs/../cs-1-0a1b2c3d',
    ]) {
      expect(SESSION_ID_RE.test(bad)).toBe(false);
    }
  });

  it('rejects wrong prefix / shape', () => {
    for (const bad of [
      'guide-1-0a1b2c3d', // guidance id prefix, not a session
      'cs-0a1b2c3d', // missing timestamp
      'cs-1-0A1B2C3D', // uppercase hex
      'cs-1-0a1b2c3', // 7 hex chars
      'cs-1-0a1b2c3de', // 9 hex chars
      'cs--0a1b2c3d', // empty timestamp
      '', // empty
      'cs-1-0a1b2c3d ', // trailing space
    ]) {
      expect(SESSION_ID_RE.test(bad)).toBe(false);
    }
  });
});
