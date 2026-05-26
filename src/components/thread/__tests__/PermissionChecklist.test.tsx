/**
 * Component test — `PermissionChecklist`.
 *
 * The component renders a fixed set of macOS-permission rows, but the
 * rendering branches heavily on per-row grant status and the number of
 * still-missing rows. Refactors that touch the row template or the
 * "all granted" collapse-state have historically dropped the visible
 * Grant buttons or shown a stale missing count — this suite pins those
 * branches with explicit assertions.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { screen, fireEvent, within } from '@testing-library/react';

/**
 * Walks up from a label `<span>` (e.g. "Accessibility") to the row
 * container `<div>` that wraps both the label and the action button.
 * The row layout in PermissionChecklist is:
 *   row > [left half (icon + label/description), right half (action btn)]
 * so we climb until we find a parent that contains both halves.
 */
function findRow(label: string): HTMLElement {
  const labelEl = screen.getByText(label);
  let node: HTMLElement | null = labelEl;
  while (node) {
    // The row container has gap-2 and justify-between; identify it by
    // the presence of *both* the label and a sibling action area.
    if (node.className.includes('justify-between')) return node;
    node = node.parentElement;
  }
  throw new Error(`Could not locate row for label "${label}"`);
}
import { renderWithProviders } from '../../../../test-utils/render';
import { installAppBridgeStub, uninstallAppBridgeStub } from '../../../../test-utils/app-bridge-stub';
import { PermissionChecklist } from '../PermissionChecklist';
import type { ComputerUsePermissions } from '../../../../shared/computer-use';

function makePermissions(overrides: Partial<ComputerUsePermissions> = {}): ComputerUsePermissions {
  return {
    target: 'local-macos',
    accessibilityTrusted: false,
    screenRecordingGranted: false,
    automationGranted: false,
    inputMonitoringGranted: false,
    helperReady: true,
    ...overrides,
  };
}

function makeProps(overrides: Partial<Parameters<typeof PermissionChecklist>[0]> = {}) {
  return {
    permissions: makePermissions(),
    isRequestingAll: false,
    isProbingInputMonitoring: false,
    inputMonitoringProbeAttempts: 0,
    onRequestAll: vi.fn(),
    onRequestSingle: vi.fn().mockResolvedValue(undefined),
    onProbeInputMonitoring: vi.fn(),
    onOpenSettings: vi.fn(),
    ...overrides,
  };
}

describe('PermissionChecklist', () => {
  beforeEach(() => {
    installAppBridgeStub();
  });

  afterEach(() => {
    uninstallAppBridgeStub();
  });

  it('renders the collapsed "all granted" affordance when every permission is granted', () => {
    const props = makeProps({
      permissions: makePermissions({
        accessibilityTrusted: true,
        screenRecordingGranted: true,
        automationGranted: true,
        inputMonitoringGranted: true,
      }),
    });
    renderWithProviders(<PermissionChecklist {...props} />);

    expect(screen.getByText('Local Mac permissions granted')).toBeInTheDocument();
    // The expanded list should not render — the Grant button is collapsed away.
    expect(screen.queryByRole('button', { name: /^Grant$/ })).not.toBeInTheDocument();
  });

  it('renders one Grant button per missing permission and a remaining count', () => {
    const props = makeProps({
      permissions: makePermissions({
        accessibilityTrusted: true,
      }),
    });
    renderWithProviders(<PermissionChecklist {...props} />);

    // Accessibility is granted, so 3 remain: screen-recording, automation,
    // and input-monitoring. Input-monitoring uses a "Verify" button instead
    // of "Grant", so we expect 2 plain Grant buttons.
    expect(screen.getByText(/\(3 remaining\)/)).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /^Grant$/ })).toHaveLength(2);
    expect(screen.getByRole('button', { name: /Verify/i })).toBeInTheDocument();
  });

  it('shows "Granted" beside permissions that are already trusted', () => {
    const props = makeProps({
      permissions: makePermissions({
        accessibilityTrusted: true,
      }),
    });
    renderWithProviders(<PermissionChecklist {...props} />);

    // The Accessibility row should show a "Granted" pill.
    const accessibilityRow = findRow('Accessibility');
    expect(within(accessibilityRow).getByText('Granted')).toBeInTheDocument();
  });

  it('shows the "Grant All Missing" button only when more than one row is missing', () => {
    const onRequestAll = vi.fn();
    const props = makeProps({
      permissions: makePermissions({
        accessibilityTrusted: true,
        // 3 missing: screen-recording, automation, input-monitoring
      }),
      onRequestAll,
    });
    const { rerender } = renderWithProviders(<PermissionChecklist {...props} />);

    const grantAll = screen.getByRole('button', { name: /Grant All Missing/i });
    fireEvent.click(grantAll);
    expect(onRequestAll).toHaveBeenCalledTimes(1);

    // Now collapse to a single missing row: only input-monitoring is missing.
    rerender(
      <PermissionChecklist
        {...makeProps({
          permissions: makePermissions({
            accessibilityTrusted: true,
            screenRecordingGranted: true,
            automationGranted: true,
          }),
          onRequestAll,
        })}
      />,
    );

    expect(screen.queryByRole('button', { name: /Grant All Missing/i })).not.toBeInTheDocument();
  });

  it('invokes onRequestSingle with the matching section when a Grant button is clicked', () => {
    const onRequestSingle = vi.fn().mockResolvedValue(undefined);
    const props = makeProps({ onRequestSingle });
    renderWithProviders(<PermissionChecklist {...props} />);

    // Click the Grant button on the Screen Recording row.
    const screenRecRow = findRow('Screen Recording');
    const grantBtn = within(screenRecRow).getByRole('button', { name: /^Grant$/ });
    fireEvent.click(grantBtn);

    expect(onRequestSingle).toHaveBeenCalledTimes(1);
    expect(onRequestSingle).toHaveBeenCalledWith('screen-recording');
  });

  it('shows the input-monitoring listening hint while a probe is in flight', () => {
    const props = makeProps({ isProbingInputMonitoring: true });
    renderWithProviders(<PermissionChecklist {...props} />);

    expect(
      screen.getByText(/Move your mouse or press any key to verify/i),
    ).toBeInTheDocument();
    // While probing, the Verify button surfaces a "Listening..." label.
    expect(screen.getByRole('button', { name: /Listening/i })).toBeInTheDocument();
  });
});
