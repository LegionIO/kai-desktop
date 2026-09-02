import { describe, it, expect } from 'vitest';
import { assertPluginLifecycleConfigWriteAllowed } from '../plugin-lifecycle-config-guard.js';

// R28P54: a plugin's generic config:write must NOT reach the lifecycle-control
// config that decides which plugin generations load — enable/disable must go
// through the freeze-aware lifecycle API. Otherwise a plugin could disable itself
// mid-freeze and strand its owed post-update cleanup.
describe('assertPluginLifecycleConfigWriteAllowed (R28P54)', () => {
  it('REJECTS writing pluginSystem.disabledPlugins (and the parent / nested paths)', () => {
    for (const p of [
      'pluginSystem',
      'pluginSystem.disabledPlugins',
      'pluginSystem.disabledPlugins.0',
      'pluginSystem.disabledPlugins.my-plugin',
      // path-normalization evasion attempts
      '.pluginSystem.disabledPlugins',
      '..pluginSystem..disabledPlugins',
    ]) {
      expect(() => assertPluginLifecycleConfigWriteAllowed(p)).toThrow(/lifecycle/i);
    }
  });

  it('ALLOWS unrelated config paths, including other pluginSystem sub-keys', () => {
    for (const p of ['ui.theme', 'models.catalog', 'pluginSystem.someOtherSetting', 'compaction.media.maxImageBytes']) {
      expect(() => assertPluginLifecycleConfigWriteAllowed(p)).not.toThrow();
    }
  });
});
