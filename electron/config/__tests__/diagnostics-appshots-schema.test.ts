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

  it('defaults in-depth memory & crash diagnostics off with a 10 MiB window-health cap', () => {
    const diagnostics = appConfigSchema.shape.diagnostics.parse(undefined);
    expect(diagnostics.memoryDiagnostics).toEqual({
      enabled: false,
      windowHealthLogMaxBytes: 10485760,
      heapSnapshot: { enabled: false, thresholdPct: 85, maxCount: 3, maxTotalBytes: 6442450944 },
    });
  });

  it('defaults heap-snapshot capture off with keep-3 / 6 GiB retention', () => {
    const diagnostics = appConfigSchema.shape.diagnostics.parse({ memoryDiagnostics: { enabled: true } });
    expect(diagnostics.memoryDiagnostics.heapSnapshot).toEqual({
      enabled: false,
      thresholdPct: 85,
      maxCount: 3,
      maxTotalBytes: 6442450944,
    });
  });

  it('rejects an out-of-range heap-snapshot threshold', () => {
    expect(() =>
      appConfigSchema.shape.diagnostics.parse({ memoryDiagnostics: { heapSnapshot: { thresholdPct: 40 } } }),
    ).toThrow();
    expect(() =>
      appConfigSchema.shape.diagnostics.parse({ memoryDiagnostics: { heapSnapshot: { thresholdPct: 100 } } }),
    ).toThrow();
  });

  it('accepts memoryDiagnostics enabled', () => {
    const diagnostics = appConfigSchema.shape.diagnostics.parse({ memoryDiagnostics: { enabled: true } });
    expect(diagnostics.memoryDiagnostics.enabled).toBe(true);
    // windowHealthLogMaxBytes fills its default when only enabled is provided.
    expect(diagnostics.memoryDiagnostics.windowHealthLogMaxBytes).toBe(10485760);
    // debugTrace still fills its own defaults independently.
    expect(diagnostics.debugTrace.enabled).toBe(false);
  });

  it('clamps an out-of-range window-health cap', () => {
    expect(() =>
      appConfigSchema.shape.diagnostics.parse({ memoryDiagnostics: { enabled: true, windowHealthLogMaxBytes: 999 } }),
    ).toThrow();
    const ok = appConfigSchema.shape.diagnostics.parse({
      memoryDiagnostics: { enabled: true, windowHealthLogMaxBytes: 20971520 },
    });
    expect(ok.memoryDiagnostics.windowHealthLogMaxBytes).toBe(20971520);
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
