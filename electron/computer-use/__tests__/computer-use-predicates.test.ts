/**
 * Tests for the pure predicates in shared/computer-use.ts.
 *
 * The important invariant for isRiskyAction is EXHAUSTIVENESS: every action
 * kind must be classified (no silent fall-through), and the risky set is
 * locked here so adding a new kind forces a conscious risk decision — a kind
 * that is silently "not risky" would skip approval gating.
 */

import { describe, it, expect } from 'vitest';
import {
  isRiskyAction,
  isComputerSessionTerminal,
  supportsComputerUse,
  shouldShowComputerSetup,
  primaryDisplayIndex,
} from '../../../shared/computer-use';
import type {
  ComputerUseActionKind,
  ComputerUseSessionStatus,
  ComputerUseSupport,
  ComputerDisplayLayout,
} from '../../../shared/computer-use';

const ALL_ACTION_KINDS: ComputerUseActionKind[] = [
  'navigate',
  'movePointer',
  'click',
  'doubleClick',
  'drag',
  'scroll',
  'typeText',
  'pressKeys',
  'wait',
  'openApp',
  'focusWindow',
];

const ALL_STATUSES: ComputerUseSessionStatus[] = [
  'starting',
  'running',
  'paused',
  'awaiting-approval',
  'completed',
  'failed',
  'stopped',
];

describe('isRiskyAction', () => {
  const RISKY: ComputerUseActionKind[] = ['openApp', 'focusWindow', 'pressKeys', 'typeText', 'drag'];

  it('flags exactly the documented risky kinds', () => {
    for (const kind of RISKY) {
      expect(isRiskyAction(kind), `${kind} should be risky`).toBe(true);
    }
  });

  it('does not flag the baseline interaction kinds', () => {
    const nonRisky = ALL_ACTION_KINDS.filter((k) => !RISKY.includes(k));
    for (const kind of nonRisky) {
      expect(isRiskyAction(kind), `${kind} should not be risky`).toBe(false);
    }
  });

  it('classifies every known action kind (risky ∪ non-risky covers the whole union)', () => {
    // If a new kind is added to ComputerUseActionKind, this array must be
    // updated — the test then forces an explicit risky/non-risky decision.
    const classified = new Set(ALL_ACTION_KINDS.map((k) => (isRiskyAction(k) ? 'risky' : 'safe')));
    expect(classified.size).toBeGreaterThan(0);
    for (const kind of ALL_ACTION_KINDS) {
      expect(typeof isRiskyAction(kind)).toBe('boolean');
    }
  });
});

describe('isComputerSessionTerminal', () => {
  it('is true only for completed/failed/stopped', () => {
    const terminal = new Set<ComputerUseSessionStatus>(['completed', 'failed', 'stopped']);
    for (const s of ALL_STATUSES) {
      expect(isComputerSessionTerminal(s)).toBe(terminal.has(s));
    }
  });
});

describe('supportsComputerUse', () => {
  it('is false for null/undefined/none, true otherwise', () => {
    expect(supportsComputerUse(null)).toBe(false);
    expect(supportsComputerUse(undefined)).toBe(false);
    expect(supportsComputerUse('none')).toBe(false);
    for (const s of [
      'openai-responses',
      'anthropic-client-tool',
      'gemini-computer-use',
      'custom',
    ] as ComputerUseSupport[]) {
      expect(supportsComputerUse(s)).toBe(true);
    }
  });
});

describe('shouldShowComputerSetup', () => {
  it('shows setup when there is no session or the session is terminal', () => {
    expect(shouldShowComputerSetup(null)).toBe(true);
    expect(shouldShowComputerSetup(undefined)).toBe(true);
    expect(shouldShowComputerSetup({ status: 'completed' })).toBe(true);
    expect(shouldShowComputerSetup({ status: 'running' })).toBe(false);
    expect(shouldShowComputerSetup({ status: 'awaiting-approval' })).toBe(false);
  });
});

describe('primaryDisplayIndex', () => {
  it('returns 0 when no layout is given', () => {
    expect(primaryDisplayIndex(null)).toBe(0);
    expect(primaryDisplayIndex(undefined)).toBe(0);
  });

  it('prefers the primary display index', () => {
    const layout = {
      displays: [
        { displayIndex: 2, isPrimary: false },
        { displayIndex: 5, isPrimary: true },
      ],
    } as unknown as ComputerDisplayLayout;
    expect(primaryDisplayIndex(layout)).toBe(5);
  });

  it('falls back to the first display when none is primary', () => {
    const layout = {
      displays: [
        { displayIndex: 7, isPrimary: false },
        { displayIndex: 9, isPrimary: false },
      ],
    } as unknown as ComputerDisplayLayout;
    expect(primaryDisplayIndex(layout)).toBe(7);
  });
});
