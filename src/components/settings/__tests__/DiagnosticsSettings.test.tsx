import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DiagnosticsSettings } from '../DiagnosticsSettings';

const mocks = vi.hoisted(() => ({
  getSummary: vi.fn(),
  listPlugins: vi.fn(),
  pause: vi.fn(),
  resume: vi.fn(),
  kill: vi.fn(),
  disable: vi.fn(),
  enable: vi.fn(),
}));

const summary = {
  logPath: '/tmp/main.log',
  logSizeBytes: 1024,
  sinceBoot: '2026-07-20T12:00:00.000Z',
  totalErrors: 0,
  counters: [],
  pluginProcesses: [
    {
      pluginName: 'calendar',
      displayName: 'Calendar',
      pid: 4242,
      status: 'running' as const,
      canPause: true,
      startedAt: '2026-07-20T12:00:00.000Z',
      crashCount: 0,
      lastExitCode: null,
      lastError: null,
      cpuPercent: 12.5,
      cumulativeCpuSeconds: 4.2,
      privateMemoryBytes: 64 * 1024 * 1024,
      residentSetBytes: 70 * 1024 * 1024,
    },
  ],
};
const plugins = [
  {
    name: 'calendar',
    displayName: 'Calendar',
    version: '1.0.0',
    description: 'Calendar plugin',
    state: 'active',
    brandRequired: false,
  },
  {
    name: 'disabled-plugin',
    displayName: 'Disabled Plugin',
    version: '1.0.0',
    description: 'Disabled plugin',
    state: 'disabled',
    brandRequired: false,
  },
];

vi.mock('@/lib/ipc-client', () => ({
  app: {
    diagnostics: {
      getSummary: mocks.getSummary,
      tailLog: vi.fn(),
      clearLog: vi.fn(),
      resetCounters: vi.fn(),
    },
    plugins: {
      list: mocks.listPlugins,
      pause: mocks.pause,
      resume: mocks.resume,
      kill: mocks.kill,
      disable: mocks.disable,
      enable: mocks.enable,
    },
  },
}));

describe('DiagnosticsSettings plugin process controls', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSummary.mockResolvedValue(summary);
    mocks.listPlugins.mockResolvedValue(plugins);
    mocks.pause.mockResolvedValue({ success: true });
    mocks.resume.mockResolvedValue({ success: true });
    mocks.kill.mockResolvedValue({ success: true });
    mocks.disable.mockResolvedValue({ success: true });
    mocks.enable.mockResolvedValue({ success: true });
  });

  it('shows per-plugin CPU/memory and exposes pause, kill, disable, and enable controls', async () => {
    render(<DiagnosticsSettings config={{}} updateConfig={vi.fn()} />);

    expect(await screen.findByText('12.5%')).toBeTruthy();
    expect(screen.getByText('4.2s total')).toBeTruthy();
    expect(screen.getByText('64.0 MB')).toBeTruthy();
    expect(screen.getByText('RSS 70.0 MB')).toBeTruthy();
    expect(screen.getByText('4242')).toBeTruthy();
    expect(screen.getByRole('button', { name: /pause/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /kill/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /disable/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /enable/i })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /pause/i }));
    await waitFor(() => expect(mocks.pause).toHaveBeenCalledWith('calendar'));

    fireEvent.click(screen.getByRole('button', { name: /kill/i }));
    await waitFor(() => expect(mocks.kill).toHaveBeenCalledWith('calendar'));

    fireEvent.click(screen.getByRole('button', { name: /^disable$/i }));
    await waitFor(() => expect(mocks.disable).toHaveBeenCalledWith('calendar', { persist: true }));

    fireEvent.click(screen.getByRole('button', { name: /enable/i }));
    await waitFor(() => expect(mocks.enable).toHaveBeenCalledWith('disabled-plugin'));
  });

  it('offers resume for a paused plugin process', async () => {
    mocks.getSummary.mockResolvedValue({
      ...summary,
      pluginProcesses: [{ ...summary.pluginProcesses[0], status: 'paused' as const }],
    });
    render(<DiagnosticsSettings config={{}} updateConfig={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: /resume/i }));
    await waitFor(() => expect(mocks.resume).toHaveBeenCalledWith('calendar'));
  });
});
