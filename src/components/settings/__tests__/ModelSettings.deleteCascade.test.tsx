import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installAppBridgeStub, uninstallAppBridgeStub } from '../../../../test-utils/app-bridge-stub';
import { ModelSettings } from '../ModelSettings';

afterEach(() => {
  uninstallAppBridgeStub();
  vi.restoreAllMocks();
});

function baseConfig(overrides: Record<string, unknown> = {}) {
  return {
    models: {
      providers: { openai: { type: 'openai-compatible', enabled: true } },
      catalog: [
        { key: 'opus', displayName: 'Opus', provider: 'openai', modelName: 'opus' },
        { key: 'gpt', displayName: 'GPT', provider: 'openai', modelName: 'gpt' },
        { key: 'gemini', displayName: 'Gemini', provider: 'openai', modelName: 'gemini' },
      ],
      defaultModelKey: 'opus',
    },
    profiles: [],
    defaultProfileKey: undefined,
    advanced: { temperature: 0.4, maxSteps: 25, maxRetries: 4, useResponsesApi: false },
    ...overrides,
  } as unknown as Record<string, unknown>;
}

/** Open the Catalog tab and delete the row whose display name is `name`. */
function deleteCatalogRow(name: string) {
  fireEvent.click(screen.getByRole('button', { name: 'Catalog' }));
  // Walk up to the bordered row container that holds the action buttons.
  let row = screen.getByText(name).parentElement as HTMLElement | null;
  while (row && !row.className.includes('rounded-lg border')) row = row.parentElement;
  if (!row) throw new Error(`catalog row for "${name}" not found`);
  fireEvent.click(within(row).getByTitle('Delete'));
  fireEvent.click(within(row).getByRole('button', { name: 'Delete' }));
}

describe('deleting a catalog model scrubs references to its key', () => {
  it('removes the key from every profile fallback chain', () => {
    const updateConfig = vi.fn();
    installAppBridgeStub({});
    const config = baseConfig({
      profiles: [
        { key: 'p1', name: 'P1', primaryModelKey: 'opus', fallbackModelKeys: ['gpt', 'gemini'] },
        { key: 'p2', name: 'P2', primaryModelKey: 'gemini', fallbackModelKeys: ['gpt'] },
      ],
      defaultProfileKey: 'p1',
    });
    render(<ModelSettings config={config} updateConfig={updateConfig} />);

    deleteCatalogRow('GPT');

    // A dangling fallback key is silently dropped at resolution time, so the
    // user's failover chain would quietly shrink with nothing explaining it.
    const profileWrite = updateConfig.mock.calls.find((c) => c[0] === 'profiles');
    expect(profileWrite).toBeDefined();
    const profiles = profileWrite![1] as Array<{ key: string; primaryModelKey: string; fallbackModelKeys: string[] }>;
    expect(profiles[0]).toMatchObject({ primaryModelKey: 'opus', fallbackModelKeys: ['gemini'] });
    expect(profiles[1]).toMatchObject({ primaryModelKey: 'gemini', fallbackModelKeys: [] });
  });

  it('promotes the first surviving fallback when the deleted model was the primary', () => {
    const updateConfig = vi.fn();
    installAppBridgeStub({});
    const config = baseConfig({
      profiles: [{ key: 'p1', name: 'P1', primaryModelKey: 'opus', fallbackModelKeys: ['gpt', 'gemini'] }],
      defaultProfileKey: 'p1',
    });
    render(<ModelSettings config={config} updateConfig={updateConfig} />);

    deleteCatalogRow('Opus');

    const profiles = updateConfig.mock.calls.find((c) => c[0] === 'profiles')![1] as Array<{
      primaryModelKey: string;
      fallbackModelKeys: string[];
    }>;
    // Keeps the user's own ordering rather than reaching for an arbitrary entry.
    expect(profiles[0]!.primaryModelKey).toBe('gpt');
    expect(profiles[0]!.fallbackModelKeys).toEqual(['gemini']);
  });

  it('repoints models.defaultModelKey when it named the deleted model', () => {
    const updateConfig = vi.fn();
    installAppBridgeStub({});
    render(<ModelSettings config={baseConfig()} updateConfig={updateConfig} />);

    deleteCatalogRow('Opus');

    const write = updateConfig.mock.calls.find((c) => c[0] === 'models.defaultModelKey');
    expect(write).toBeDefined();
    expect(write![1]).not.toBe('opus');
    expect(['gpt', 'gemini']).toContain(write![1]);
  });

  it('leaves unrelated profiles untouched', () => {
    const updateConfig = vi.fn();
    installAppBridgeStub({});
    const config = baseConfig({
      profiles: [{ key: 'p1', name: 'P1', primaryModelKey: 'opus', fallbackModelKeys: ['gpt'] }],
      defaultProfileKey: 'p1',
    });
    render(<ModelSettings config={config} updateConfig={updateConfig} />);

    // 'gemini' is referenced by nobody — no profiles write should be needed.
    deleteCatalogRow('Gemini');

    expect(updateConfig).toHaveBeenCalledWith('models.catalog', [
      expect.objectContaining({ key: 'opus' }),
      expect.objectContaining({ key: 'gpt' }),
    ]);
    expect(updateConfig.mock.calls.find((c) => c[0] === 'profiles')).toBeUndefined();
  });
});
