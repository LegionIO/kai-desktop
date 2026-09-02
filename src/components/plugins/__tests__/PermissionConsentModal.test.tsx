import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { installAppBridgeStub, uninstallAppBridgeStub } from '../../../../test-utils/app-bridge-stub';
import { PermissionConsentModal } from '../PermissionConsentModal';

afterEach(() => {
  cleanup();
  uninstallAppBridgeStub();
});

describe('PermissionConsentModal', () => {
  it('discloses Browser control by both plugin UI code and a plugin-provided AI backend', async () => {
    installAppBridgeStub({
      plugins: {
        getPendingConsent: async () => [
          {
            pluginName: 'browser-provider',
            displayName: 'Browser Provider',
            permissions: ['browser:authenticated-session'],
            dangerousPermissions: ['browser:authenticated-session'],
            fileHash: 'approved-hash',
          },
        ],
        onConsentRequired: () => () => undefined,
        approveConsent: async () => ({ success: true }),
        denyConsent: async () => ({ success: true }),
      },
    });

    render(<PermissionConsentModal />);

    expect(
      await screen.findByText(
        'Run trusted plugin interface code that can access Kai desktop data and API keys and inspect or control authenticated Browser pages; a plugin-provided AI backend may also control those pages',
      ),
    ).toBeInTheDocument();
  });

  it('KEEPS the prompt visible when a denial is REFUSED (success:false, e.g. an app update is finishing) (R28P21)', async () => {
    installAppBridgeStub({
      plugins: {
        getPendingConsent: async () => [
          {
            pluginName: 'blocked-deny',
            displayName: 'Blocked Deny',
            permissions: ['fs:read'],
            dangerousPermissions: [],
            fileHash: 'h',
          },
        ],
        onConsentRequired: () => () => undefined,
        approveConsent: async () => ({ success: true }),
        // Denial is refused (freeze) — the request is still pending in main.
        denyConsent: async () => ({ success: false, error: 'finishing a previous update' }),
      },
    });

    render(<PermissionConsentModal />);
    const denyBtn = await screen.findByRole('button', { name: /deny/i });
    fireEvent.click(denyBtn);
    // The prompt must NOT disappear — it's still pending until the freeze clears.
    await waitFor(() => expect(screen.getByText('Blocked Deny')).toBeInTheDocument());
    // And the rejection reason must be SURFACED, not silently discarded (R42P2) —
    // otherwise the button re-enables with no explanation and looks ineffective.
    await waitFor(() => expect(screen.getByText(/finishing a previous update/i)).toBeInTheDocument());
  });

  it('after a successful deny, RE-SYNCS the prompt list from main rather than blindly dropping by name (R28P52)', async () => {
    let pendingReturns = 0;
    installAppBridgeStub({
      plugins: {
        // First call (mount) returns the request; second call (post-deny re-sync)
        // returns EMPTY — the denial cleared it, so the prompt must disappear.
        getPendingConsent: async () => {
          pendingReturns += 1;
          return pendingReturns <= 1
            ? [
                {
                  pluginName: 'clean-deny',
                  displayName: 'Clean Deny',
                  permissions: ['fs:read'],
                  dangerousPermissions: [],
                  fileHash: 'h',
                },
              ]
            : [];
        },
        onConsentRequired: () => () => undefined,
        approveConsent: async () => ({ success: true }),
        denyConsent: async () => ({ success: true }),
      },
    });

    render(<PermissionConsentModal />);
    const denyBtn = await screen.findByRole('button', { name: /deny/i });
    fireEvent.click(denyBtn);
    // Re-sync returned empty → prompt gone (and NOT via a blind by-name filter).
    await waitFor(() => expect(screen.queryByText('Clean Deny')).not.toBeInTheDocument());
  });

  it('after APPROVE, RE-SYNCS from main — a stale-rejected approval leaves the live request visible (R29P1)', async () => {
    installAppBridgeStub({
      plugins: {
        getPendingConsent: async () => [
          {
            pluginName: 'stale-approve',
            displayName: 'Stale Approve',
            permissions: ['fs:read'],
            dangerousPermissions: [],
            fileHash: 'H2',
          },
        ],
        onConsentRequired: () => () => undefined,
        // Approval is REJECTED (client held stale H1; live request is H2).
        approveConsent: async () => ({ success: false }),
        denyConsent: async () => ({ success: true }),
      },
    });

    render(<PermissionConsentModal />);
    const approveBtn = await screen.findByRole('button', { name: /approve/i });
    fireEvent.click(approveBtn);
    // Rejected approval → the live H2 request must REMAIN visible (not dropped).
    await waitFor(() => expect(screen.getByText('Stale Approve')).toBeInTheDocument());
  });

  it('surfaces the error when an APPROVE is refused with a message (R42P2)', async () => {
    installAppBridgeStub({
      plugins: {
        getPendingConsent: async () => [
          {
            pluginName: 'frozen-approve',
            displayName: 'Frozen Approve',
            permissions: ['fs:read'],
            dangerousPermissions: [],
            fileHash: 'h',
          },
        ],
        onConsentRequired: () => () => undefined,
        // Approval refused by an app-update freeze, WITH an explanatory message.
        approveConsent: async () => ({ success: false, error: 'A plugin update is finishing; try again shortly' }),
        denyConsent: async () => ({ success: true }),
      },
    });

    render(<PermissionConsentModal />);
    const approveBtn = await screen.findByRole('button', { name: /approve/i });
    fireEvent.click(approveBtn);
    // The refusal reason must be shown to the user (R42P2), and the request stays.
    await waitFor(() => expect(screen.getByText(/a plugin update is finishing/i)).toBeInTheDocument());
    expect(screen.getByText('Frozen Approve')).toBeInTheDocument();
  });

  it('does NOT show a failed H1 approval error on the same-name H2 generation after resync (R44P3)', async () => {
    let pendingReturns = 0;
    installAppBridgeStub({
      plugins: {
        // Mount → H1; post-approve resync → same-name H2 (different hash) — a rollback/
        // reinstall replaced the generation. The H1 failure error must NOT carry over.
        getPendingConsent: async () => {
          pendingReturns += 1;
          const fileHash = pendingReturns <= 1 ? 'H1' : 'H2';
          const displayName = pendingReturns <= 1 ? 'Gen One' : 'Gen Two';
          return [{ pluginName: 'gen', displayName, permissions: ['fs:read'], dangerousPermissions: [], fileHash }];
        },
        onConsentRequired: () => () => undefined,
        // The stale H1 approval is refused with an explanatory error.
        approveConsent: async () => ({ success: false, error: 'STALE-H1-ERROR' }),
        denyConsent: async () => ({ success: true }),
      },
    });

    render(<PermissionConsentModal />);
    const approveBtn = await screen.findByRole('button', { name: /approve/i });
    fireEvent.click(approveBtn);
    // Resync swaps in H2 (Gen Two). The H1 error must NOT appear on it — it belongs to
    // a generation the user never acted on (R44P3, generation-scoped error key).
    await waitFor(() => expect(screen.getByText('Gen Two')).toBeInTheDocument());
    expect(screen.queryByText('STALE-H1-ERROR')).not.toBeInTheDocument();
  });
});
