/**
 * Component test — `MaxTurnsContinueCard`.
 *
 * The card has two visual states gated by `part.status`:
 *   • 'pending'   — renders the prompt text and a "Continue" action button
 *   • 'continued' — collapses to a confirmation row with a check icon
 *
 * Both branches must keep rendering after refactors that touch the
 * conversation thread layout. The runtime `useMaxTurnsContinue` hook
 * defaults to `null` outside an explicit provider, which is exactly the
 * shape `renderWithProviders` produces — so clicking the button in
 * isolation must be a safe no-op (no provider, no crash).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { renderWithProviders } from '../../../../test-utils/render';
import { installAppBridgeStub, uninstallAppBridgeStub } from '../../../../test-utils/app-bridge-stub';
import { MaxTurnsContinueCard } from '../MaxTurnsContinueCard';

describe('MaxTurnsContinueCard', () => {
  beforeEach(() => {
    installAppBridgeStub();
  });

  afterEach(() => {
    uninstallAppBridgeStub();
  });

  it('renders the prompt text and a Continue button when status is pending', () => {
    renderWithProviders(
      <MaxTurnsContinueCard
        part={{ type: 'max-turns-reached', text: 'Reached max turns', status: 'pending' }}
        messageId="msg-1"
      />,
    );

    expect(screen.getByText('Reached max turns')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue' })).toBeInTheDocument();
    // The confirmation copy must NOT show in the pending state.
    expect(screen.queryByText('Continued')).not.toBeInTheDocument();
  });

  it('collapses to a Continued confirmation row when status is continued', () => {
    renderWithProviders(
      <MaxTurnsContinueCard
        part={{ type: 'max-turns-reached', text: 'Reached max turns', status: 'continued' }}
        messageId="msg-2"
      />,
    );

    expect(screen.getByText('Continued')).toBeInTheDocument();
    // The Continue button must not be re-renderable from this state — only
    // the runtime should move the part out of "continued".
    expect(screen.queryByRole('button', { name: 'Continue' })).not.toBeInTheDocument();
    // Nor should the original prompt text leak through.
    expect(screen.queryByText('Reached max turns')).not.toBeInTheDocument();
  });

  it('does not crash when the Continue button is clicked outside an explicit max-turns provider', () => {
    // Without a MaxTurnsContinueContext provider supplying a handler,
    // the hook returns null and the card's onClick is a safe no-op.
    renderWithProviders(
      <MaxTurnsContinueCard
        part={{ type: 'max-turns-reached', text: 'Reached max turns', status: 'pending' }}
        messageId="msg-3"
      />,
    );

    const button = screen.getByRole('button', { name: 'Continue' });
    // The click must not throw and the button must remain mounted.
    expect(() => fireEvent.click(button)).not.toThrow();
    expect(button).toBeInTheDocument();
  });
});
