import { describe, it, expect, vi } from 'vitest';
vi.mock('../../browser/plugin-partitions.js', () => ({ clearPluginBrowserPartitions: vi.fn(async () => undefined) }));
import { clearPluginBrowserPartitions } from '../../browser/plugin-partitions.js';
import { pluginResetStorageName, resetPluginSession } from '../session-reset.js';

describe('plugin session reset', () => {
  it('delegates complete clearing to the existing lifecycle-fenced reset', async () => {
    await resetPluginSession('pim', 'persist:kai-pim-servicenow');
    expect(clearPluginBrowserPartitions).toHaveBeenCalledWith(['kai-pim-servicenow']);
  });
  it.each([
    '',
    'persist:kai-pim',
    'persist:kai-other-servicenow',
    'persist:kai-browser-global',
    'persist:kai-pim-../other',
    'persist:persist:kai-pim-servicenow',
    'kai-pim-servicenow',
  ])('rejects %s', (partition) => {
    expect(() => pluginResetStorageName('pim', partition)).toThrow(/owned by this plugin/);
  });
});
