/**
 * Component test — `ElapsedBadge`.
 *
 * Covers the three colour bands (running / error / success) and the two
 * timing-source code paths the badge supports: the server-computed
 * `durationMs` (preferred for sub-second tools) and the
 * finishedAt − startedAt fallback. The system clock is frozen by
 * `vitest.setup.ts`, so timestamp inputs deterministically resolve.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '../../../../test-utils/render';
import { installAppBridgeStub, uninstallAppBridgeStub } from '../../../../test-utils/app-bridge-stub';
import { ElapsedBadge } from '../ElapsedBadge';

// vitest.setup.ts pins the system clock to 2026-01-01T00:00:00.000Z.
const FROZEN_NOW_ISO = '2026-01-01T00:00:00.000Z';

describe('ElapsedBadge', () => {
  beforeEach(() => {
    installAppBridgeStub();
  });

  afterEach(() => {
    uninstallAppBridgeStub();
  });

  it('renders the server-computed duration when finished and not running', () => {
    renderWithProviders(
      <ElapsedBadge
        startedAt={FROZEN_NOW_ISO}
        finishedAt="2026-01-01T00:00:05.000Z"
        durationMs={5000}
        isRunning={false}
      />,
    );

    // formatElapsed(5000) → "5s"
    const badge = screen.getByText('5s');
    expect(badge).toBeInTheDocument();
    // Success state uses the green palette.
    expect(badge.className).toMatch(/green-/);
  });

  it('falls back to finishedAt − startedAt when durationMs is omitted', () => {
    renderWithProviders(
      <ElapsedBadge
        startedAt={FROZEN_NOW_ISO}
        finishedAt="2026-01-01T00:01:30.000Z"
        isRunning={false}
      />,
    );

    // (90_000 ms) → "1m30s"
    expect(screen.getByText('1m30s')).toBeInTheDocument();
  });

  it('uses the destructive palette when isError is set on a finished badge', () => {
    renderWithProviders(
      <ElapsedBadge
        startedAt={FROZEN_NOW_ISO}
        finishedAt="2026-01-01T00:00:02.000Z"
        durationMs={2000}
        isRunning={false}
        isError
      />,
    );

    const badge = screen.getByText('2s');
    expect(badge.className).toMatch(/destructive/);
    // Sanity: it must NOT carry the success-state green class while in
    // error mode, otherwise the colour bands have collided.
    expect(badge.className).not.toMatch(/green-/);
  });

  it('renders the running palette and a 0ms placeholder when isRunning is true at t=0', () => {
    renderWithProviders(
      <ElapsedBadge startedAt={FROZEN_NOW_ISO} isRunning />,
    );

    // System clock is pinned to FROZEN_NOW_ISO and startedMs equals Date.now(),
    // so the displayed elapsed is 0ms before the ticker fires.
    const badge = screen.getByText('0ms');
    expect(badge.className).toMatch(/blue-/);
  });

  it('renders the running palette even when isError is set, because running wins', () => {
    renderWithProviders(
      <ElapsedBadge startedAt={FROZEN_NOW_ISO} isRunning isError />,
    );

    const badge = screen.getByText('0ms');
    // The running palette must take precedence over the error palette;
    // a refactor that re-orders the className branch would otherwise
    // surface a destructive-coloured "running" indicator.
    expect(badge.className).toMatch(/blue-/);
    expect(badge.className).not.toMatch(/destructive/);
  });
});
