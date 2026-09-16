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
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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

  /**
   * A retry notice is emitted MID-turn, while the re-sent request is still streaming.
   * The spinner-hiding rule in globals.css keys off "is there a sibling content part
   * before the dots", so without an explicit exemption the chip counted as content and
   * hid the thinking spinner for the rest of the turn — Kai looked idle while the model
   * was still generating. The between-tools spinner cannot cover the gap either: it
   * requires `hasContent`, which deliberately excludes notices.
   *
   * jsdom does not evaluate the stylesheet's sibling selector, so this pins the two
   * halves of the contract separately: the marker class on the element, and the
   * exemption inside the rule that consumes it.
   */
  it('carries the spinner-exemption marker class so a mid-turn notice cannot hide the spinner', () => {
    renderWithProviders(
      <NoticeTextPart text="This model rejected the temperature setting, so Kai re-sent the request without it." />,
    );
    expect(screen.getByTestId('assistant-notice')).toHaveClass('aui-assistant-notice');
  });

  it('globals.css exempts the notice class from the typing-dots hide rule', () => {
    const css = readFileSync(resolve(__dirname, '../../../styles/globals.css'), 'utf-8');
    // Locate the rule that hides the spinner once a preceding sibling exists.
    const rule = css
      .split('}')
      .map((block) => block.trim())
      .find((block) => block.includes('~ .aui-typing-dots') && block.includes('display: none'));
    expect(rule, 'typing-dots hide rule not found in globals.css').toBeDefined();
    expect(rule).toContain(':not(.aui-assistant-notice)');
  });

  /**
   * The icon sat visibly high in the chip. It is `items-start`-aligned (so that expanding
   * "Details" grows the text column downward without dragging the icon along), which means
   * its offset must be set explicitly to optically center it on the FIRST text line:
   * text is `leading-5` (20px), icon is `h-3` (12px) → (20-12)/2 = 4px = `mt-1`.
   * The old `mt-[1px]` was 3px short.
   */
  it('optically centers the info icon on the first text line', () => {
    const { container } = renderWithProviders(
      <NoticeTextPart text="This model rejected the temperature setting, so Kai re-sent the request without it." />,
    );
    const icon = container.querySelector('svg');
    expect(icon, 'info icon not rendered').not.toBeNull();
    // 4px top offset == half the 8px difference between the line box and the icon.
    expect(icon).toHaveClass('mt-1');
    expect(icon).toHaveClass('h-3');
    // Guard the regression specifically: any hand-tuned near-zero offset is wrong here.
    // (`svg.className` is an SVGAnimatedString, so read the attribute as a string.)
    expect(icon?.getAttribute('class') ?? '').not.toMatch(/mt-\[1px\]/);
    // The container must stay items-start for the Details-expansion behavior above.
    expect(screen.getByTestId('assistant-notice')).toHaveClass('items-start');
  });
});
