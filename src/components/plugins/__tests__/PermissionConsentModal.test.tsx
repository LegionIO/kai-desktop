import { cleanup, render, screen } from '@testing-library/react';
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
});
