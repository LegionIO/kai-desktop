/**
 * Component test — `NoticeTextPart`.
 *
 * This part renders Kai's OWN notices about a request (a retry, a compact-and-resend).
 * Its whole reason for existing is to look nothing like assistant output: the retry note
 * used to render as ordinary assistant prose and read as though the model had said it.
 *
 * So these tests pin the two properties that keep that distinction true:
 *   • the notice carries its own container (`assistant-notice`) and NOT the assistant
 *     text treatment (`timeline-item` + `timeline-dot`)
 *   • the provider's raw error is hidden until the user asks for it
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { renderWithProviders } from '../../../../test-utils/render';
import { installAppBridgeStub, uninstallAppBridgeStub } from '../../../../test-utils/app-bridge-stub';
import { NoticeTextPart } from '../NoticeTextPart';

describe('NoticeTextPart', () => {
  beforeEach(() => {
    installAppBridgeStub();
  });

  afterEach(() => {
    uninstallAppBridgeStub();
  });

  it('renders the summary inside a notice container, not as assistant text', () => {
    const { container } = renderWithProviders(
      <NoticeTextPart text="This model rejected the temperature setting, so Kai re-sent the request without it." />,
    );

    const notice = screen.getByTestId('assistant-notice');
    expect(notice).toBeInTheDocument();
    expect(notice).toHaveTextContent('rejected the temperature setting');
    // Must NOT borrow the assistant-message timeline treatment — that visual is what
    // made the old retry line indistinguishable from model output.
    expect(container.querySelector('.timeline-item')).toBeNull();
    expect(container.querySelector('.timeline-dot')).toBeNull();
  });

  it('renders nothing for empty text', () => {
    renderWithProviders(<NoticeTextPart text="" />);
    expect(screen.queryByTestId('assistant-notice')).toBeNull();
  });

  it('hides the provider detail behind a disclosure and toggles it', () => {
    renderWithProviders(
      <NoticeTextPart
        text="This model rejected the temperature setting, so Kai re-sent the request without it."
        detail="Unsupported parameter: 'temperature' is not supported with this model."
      />,
    );

    // Collapsed by default — raw provider wording must not crowd the reply.
    expect(screen.queryByText(/Unsupported parameter/)).toBeNull();
    const toggle = screen.getByRole('button', { name: 'Details' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(toggle);
    expect(screen.getByText(/Unsupported parameter/)).toBeInTheDocument();
    const collapse = screen.getByRole('button', { name: 'Hide details' });
    expect(collapse).toHaveAttribute('aria-expanded', 'true');

    fireEvent.click(collapse);
    expect(screen.queryByText(/Unsupported parameter/)).toBeNull();
  });

  it('omits the disclosure entirely when there is no detail', () => {
    renderWithProviders(<NoticeTextPart text="The request exceeded the context window." />);
    expect(screen.queryByRole('button', { name: 'Details' })).toBeNull();
  });
});
