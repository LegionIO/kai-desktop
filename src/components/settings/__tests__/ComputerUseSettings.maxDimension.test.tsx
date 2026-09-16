import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installAppBridgeStub, uninstallAppBridgeStub } from '../../../../test-utils/app-bridge-stub';
import { ComputerUseSettings } from '../ComputerUseSettings';

afterEach(() => {
  uninstallAppBridgeStub();
  vi.restoreAllMocks();
});

const DISPLAYS = [
  { name: 'Built-in Retina Display', displayId: '1', pixelWidth: 3456, pixelHeight: 2234, isPrimary: true },
  { name: 'Studio Display', displayId: '2', pixelWidth: 5120, pixelHeight: 2880, isPrimary: false },
];

function configWith(maxDimension: number, allowedDisplays: string[]) {
  return {
    computerUse: {
      enabled: true,
      showStepLog: true,
      toolSurface: 'both',
      defaultSurface: 'docked',
      defaultTarget: 'local-macos',
      approvalModeDefault: 'step',
      idleTimeoutSec: 180,
      postActionDelayMs: 300,
      maxSessionDurationMin: 45,
      models: {},
      capture: { maxDimension, jpegQuality: 0.8, modelFrame: { mode: 'canonical', width: 1366, height: 768 } },
      safety: { pauseOnTerminal: true, manualTakeoverPauses: true, experimentalScreenCaptureConsent: false },
      localMacos: {
        autoRequestPermissions: true,
        autoOpenPrivacySettings: true,
        allowedDisplays,
        captureExcludedApps: [],
      },
      overlay: { enabled: true, position: 'top', heightPx: 120, opacity: 0.75 },
    },
    // The panel renders model pickers from the catalog.
    models: { providers: {}, catalog: [], defaultModelKey: '' },
  } as unknown as Record<string, unknown>;
}

async function renderWithDisplays(
  config: Record<string, unknown>,
  updateConfig: (path: string, value: unknown) => Promise<void>,
) {
  installAppBridgeStub({
    computerUse: {
      listDisplays: async () => ({ displays: DISPLAYS }),
      // Sibling AppListPicker in the same fieldset.
      listRunningApps: async () => ({ apps: [] }),
    },
    platform: {
      // The "Local Mac" fieldset (which owns the display picker) is gated on
      // `app.platform.os === 'darwin'`.
      os: 'darwin',
      homedir: async () => '/home/test',
      getFeatureCapabilities: async () => ({ computerUseLocal: { supported: true } }),
    },
  } as unknown as Parameters<typeof installAppBridgeStub>[0]);
  render(<ComputerUseSettings config={config} updateConfig={updateConfig} />);
  // Wait for the async display discovery to settle.
  await waitFor(() => expect(screen.getByText('Studio Display')).toBeInTheDocument());
}

describe('capture.maxDimension is not clobbered by display toggles', () => {
  it('leaves a user-tuned value alone when a display is toggled', async () => {
    const updateConfig = vi.fn();
    // 1024 = deliberately lowered from the 1920 default to cut screenshot tokens.
    await renderWithDisplays(configWith(1024, ['Built-in Retina Display']), updateConfig);

    fireEvent.click(screen.getByText('Studio Display'));

    // The toggle itself must persist...
    expect(updateConfig).toHaveBeenCalledWith(
      'computerUse.localMacos.allowedDisplays',
      expect.arrayContaining(['Studio Display']),
    );
    // ...but the hand-tuned capture ceiling must NOT be rewritten to 5120.
    expect(updateConfig).not.toHaveBeenCalledWith('computerUse.capture.maxDimension', expect.anything());
  });

  it('still auto-fits upward from the untouched default', async () => {
    const updateConfig = vi.fn();
    await renderWithDisplays(configWith(1920, ['Built-in Retina Display']), updateConfig);

    fireEvent.click(screen.getByText('Studio Display'));

    // Default (1920) is treated as "not chosen by the user", so a 5K panel may
    // raise it — preserving the original fresh-install intent.
    expect(updateConfig).toHaveBeenCalledWith('computerUse.capture.maxDimension', 5120);
  });

  it('never lowers the ceiling when a large display is removed', async () => {
    const updateConfig = vi.fn();
    await renderWithDisplays(configWith(1920, ['Built-in Retina Display', 'Studio Display']), updateConfig);

    // Unchecking the 5K display leaves only a 3456-wide panel; the ceiling must
    // not be dragged down as a side effect.
    fireEvent.click(screen.getByText('Studio Display'));

    const dimensionWrites = updateConfig.mock.calls.filter((c) => c[0] === 'computerUse.capture.maxDimension');
    expect(dimensionWrites.every(([, v]) => (v as number) >= 1920)).toBe(true);
  });
});
