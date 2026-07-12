/**
 * Tests for the computer-use approval gate (orchestrator.approvalRequired),
 * focused on the experimental-on safety guard (ADR-0005 amendment): a LOCAL
 * desktop target on a platform where local computer use is only EXPERIMENTAL
 * (Windows/Linux) must force per-action approval even in autonomous/goal mode,
 * so unvalidated global synthetic input can't fire unattended. macOS (native,
 * non-experimental) and the cross-platform browser target keep configured mode.
 *
 * getPlatformCapabilities is driven by process.platform, so tests override it.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { on: vi.fn(), getPath: () => '/tmp' },
  BrowserWindow: { getAllWindows: () => [] },
  nativeImage: { createFromBuffer: () => ({}) },
}));

import { approvalRequired } from '../orchestrator.js';
import type { ComputerActionProposal, ComputerUseTarget } from '../../../shared/computer-use.js';
import type { AppConfig } from '../../config/schema.js';

const original = process.platform;
const setPlatform = (p: NodeJS.Platform) =>
  Object.defineProperty(process, 'platform', { value: p, configurable: true });
afterEach(() => Object.defineProperty(process, 'platform', { value: original, configurable: true }));

const config = { computerUse: { safety: { pauseOnTerminal: false } } } as unknown as AppConfig;
const action = (over: Partial<ComputerActionProposal> = {}): ComputerActionProposal =>
  ({ kind: 'click', risk: 'low', requiresApproval: false, ...over }) as ComputerActionProposal;

describe('approvalRequired — experimental-platform safety guard', () => {
  it('forces approval for a local target on win32 even in autonomous mode', () => {
    setPlatform('win32');
    for (const target of ['local-macos', 'local-windows'] as ComputerUseTarget[]) {
      expect(approvalRequired('autonomous', action(), config, target)).toBe(true);
    }
  });

  it('forces approval for a local target on linux even in autonomous mode', () => {
    setPlatform('linux');
    expect(approvalRequired('autonomous', action(), config, 'local-windows')).toBe(true);
  });

  it('does NOT force approval for the cross-platform browser target on win32 (unaffected)', () => {
    setPlatform('win32');
    // Browser target is not local desktop input → keeps autonomous = no approval.
    expect(approvalRequired('autonomous', action(), config, 'isolated-browser')).toBe(false);
  });

  it('on darwin (native, non-experimental) autonomous mode still skips approval for a local target', () => {
    setPlatform('darwin');
    expect(approvalRequired('autonomous', action(), config, 'local-macos')).toBe(false);
  });
});

describe('approvalRequired — configured modes on non-experimental platform (darwin)', () => {
  it('autonomous → no approval', () => {
    setPlatform('darwin');
    expect(approvalRequired('autonomous', action(), config, 'local-macos')).toBe(false);
  });

  it('goal → approval only for high-risk actions', () => {
    setPlatform('darwin');
    expect(approvalRequired('goal', action({ risk: 'low' }), config, 'local-macos')).toBe(false);
    expect(approvalRequired('goal', action({ risk: 'high' }), config, 'local-macos')).toBe(true);
  });

  it('step → follows the action.requiresApproval flag', () => {
    setPlatform('darwin');
    expect(approvalRequired('step', action({ requiresApproval: true }), config, 'local-macos')).toBe(true);
    expect(approvalRequired('step', action({ requiresApproval: false }), config, 'local-macos')).toBe(false);
  });

  it('pauseOnTerminal forces approval for a Terminal app action', () => {
    setPlatform('darwin');
    const termConfig = { computerUse: { safety: { pauseOnTerminal: true } } } as unknown as AppConfig;
    expect(approvalRequired('autonomous', action({ appName: 'Terminal' }), termConfig, 'local-macos')).toBe(false);
    // autonomous short-circuits before the terminal check on darwin; step surfaces it.
    expect(approvalRequired('step', action({ appName: 'Terminal' }), termConfig, 'local-macos')).toBe(true);
  });
});

describe('approvalRequired — server-side risk floor (model cannot downgrade)', () => {
  // The proposal's risk/requiresApproval come from the model's own output, so a
  // model must not be able to self-label an inherently risky action as low-risk
  // to skip approval. openApp/focusWindow/pressKeys/typeText/drag are risky kinds.
  const RISKY_KINDS = ['openApp', 'focusWindow', 'pressKeys', 'typeText', 'drag'] as const;

  it('forces approval for risky kinds in goal mode even when the model claims risk=low', () => {
    setPlatform('darwin');
    for (const kind of RISKY_KINDS) {
      expect(
        approvalRequired('goal', action({ kind, risk: 'low', requiresApproval: false }), config, 'isolated-browser'),
        `${kind} should require approval in goal mode`,
      ).toBe(true);
    }
  });

  it('forces approval for risky kinds in step mode even when the model sets requiresApproval=false', () => {
    setPlatform('darwin');
    for (const kind of RISKY_KINDS) {
      expect(
        approvalRequired('step', action({ kind, risk: 'low', requiresApproval: false }), config, 'isolated-browser'),
        `${kind} should require approval in step mode`,
      ).toBe(true);
    }
  });

  it('does NOT change autonomous mode — an explicit no-prompt opt-out still skips (browser/macOS)', () => {
    setPlatform('darwin');
    expect(approvalRequired('autonomous', action({ kind: 'openApp', risk: 'low' }), config, 'isolated-browser')).toBe(
      false,
    );
  });

  it('leaves non-risky kinds (click/scroll/navigate/wait) governed by the model risk in goal mode', () => {
    setPlatform('darwin');
    expect(approvalRequired('goal', action({ kind: 'click', risk: 'low' }), config, 'isolated-browser')).toBe(false);
    expect(approvalRequired('goal', action({ kind: 'scroll', risk: 'low' }), config, 'isolated-browser')).toBe(false);
    expect(approvalRequired('goal', action({ kind: 'navigate', risk: 'high' }), config, 'isolated-browser')).toBe(true);
  });
});
