/**
 * Component test — `FallbackToggle`.
 *
 * Why this is high-value: the toggle's visible label, accessible title,
 * and click handler all branch off a single `enabled` prop. Refactoring
 * the wrapping markup or swapping the icon library is the kind of change
 * that has historically broken auto-routing controls in this app, so we
 * pin the user-visible behaviour here.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { renderWithProviders } from '../../../../test-utils/render';
import { installAppBridgeStub, uninstallAppBridgeStub } from '../../../../test-utils/app-bridge-stub';
import { FallbackToggle } from '../FallbackToggle';

describe('FallbackToggle', () => {
  beforeEach(() => {
    installAppBridgeStub();
  });

  afterEach(() => {
    uninstallAppBridgeStub();
  });

  it('renders the "Auto" label and the auto-routing tooltip title when enabled', () => {
    renderWithProviders(<FallbackToggle enabled={true} onToggle={() => undefined} />);

    // Use `toHaveAccessibleDescription` rather than `getAttribute('title')`
    // — the assertion stays correct if the component swaps the native
    // `title` attribute for `aria-describedby` (e.g. Radix Tooltip).
    const button = screen.getByRole('button');
    expect(button).toBeInTheDocument();
    expect(button).toHaveTextContent('Auto');
    expect(button).toHaveAccessibleDescription(/Auto-routing enabled/i);
  });

  it('renders the "Manual" label and the enable-tooltip title when disabled', () => {
    renderWithProviders(<FallbackToggle enabled={false} onToggle={() => undefined} />);

    const button = screen.getByRole('button');
    expect(button).toBeInTheDocument();
    expect(button).toHaveTextContent('Manual');
    expect(button).toHaveAccessibleDescription(/Enable auto-routing/i);
  });

  it('calls onToggle with the inverted value on click', () => {
    const onToggle = vi.fn();
    renderWithProviders(<FallbackToggle enabled={false} onToggle={onToggle} />);

    const button = screen.getByRole('button');
    fireEvent.click(button);

    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(onToggle).toHaveBeenCalledWith(true);
  });

  it('calls onToggle with false when clicked while enabled', () => {
    const onToggle = vi.fn();
    renderWithProviders(<FallbackToggle enabled={true} onToggle={onToggle} />);

    fireEvent.click(screen.getByRole('button'));

    expect(onToggle).toHaveBeenCalledWith(false);
  });
});
