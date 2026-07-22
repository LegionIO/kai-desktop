import { describe, expect, it } from 'vitest';
import { appConfigSchema, resolvePersistedAppShotsConfig, type AppConfig } from '../schema';

describe('diagnostics debug trace schema', () => {
  it('defaults trace off with metadata-only bounded retention', () => {
    const diagnostics = appConfigSchema.shape.diagnostics.parse(undefined);
    expect(diagnostics.debugTrace).toEqual({
      enabled: false,
      includeContent: false,
      scopes: ['agent', 'automation', 'alert', 'plugin', 'renderer', 'window'],
      retention: { maxFileBytes: 10485760, maxFiles: 3, maxAgeDays: 7 },
    });
  });
});

describe('unified App Shots config', () => {
  it('prefers canonical appShots.persisted over the legacy lowercase section', () => {
    const config = {
      appShots: { persisted: { enabled: true, autoCapture: true } },
      appshots: { enabled: false, autoCapture: false },
    } as AppConfig;
    expect(resolvePersistedAppShotsConfig(config)).toMatchObject({ enabled: true, autoCapture: true });
  });

  it('falls back to legacy appshots for existing configs', () => {
    const config = { appShots: undefined, appshots: { enabled: true, autoCapture: true } } as AppConfig;
    expect(resolvePersistedAppShotsConfig(config)).toMatchObject({ enabled: true, autoCapture: true });
  });
});
