import { describe, it, expect, vi } from 'vitest';

// Mock the model factory + config accessors so the helper runs without Electron.
const createModelMock = vi.fn(async (cfg: { modelName: string }) => ({ __model: cfg.modelName }));
vi.mock('../language-model.js', () => ({
  createLanguageModelFromConfig: (cfg: { modelName: string }) => createModelMock(cfg),
}));
vi.mock('../../ipc/config.js', () => ({ readEffectiveConfig: vi.fn(() => ({})) }));
vi.mock('../../local-bridge/paths.js', () => ({ getAppHome: () => '/tmp' }));

import { runWithModelFallback } from '../generate-fallback.js';
import type { ModelCatalogEntry } from '../model-catalog.js';

const entry = (key: string): ModelCatalogEntry =>
  ({ key, displayName: key, modelConfig: { modelName: key } }) as unknown as ModelCatalogEntry;

const transient = () => Object.assign(new Error('overloaded'), { status: 529 });
const permanent = () => Object.assign(new Error('bad request'), { status: 400 });

describe('runWithModelFallback', () => {
  it('returns the first success without advancing', async () => {
    const fn = vi.fn(async () => 'ok');
    const out = await runWithModelFallback([entry('a'), entry('b')], fn);
    expect(out).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('advances to the next model on a transient error', async () => {
    const fn = vi.fn().mockRejectedValueOnce(transient()).mockResolvedValueOnce('from-b');
    const onFallback = vi.fn();
    const out = await runWithModelFallback([entry('a'), entry('b')], fn, {
      maxRetriesPerModel: 0,
      onFallback,
    });
    expect(out).toBe('from-b');
    expect(fn).toHaveBeenCalledTimes(2);
    expect(onFallback).toHaveBeenCalledWith('a', 'b', expect.any(String));
  });

  it('retries the SAME model before advancing when retries remain', async () => {
    const fn = vi.fn().mockRejectedValueOnce(transient()).mockResolvedValueOnce('ok');
    const out = await runWithModelFallback([entry('a'), entry('b')], fn, { maxRetriesPerModel: 1 });
    expect(out).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2); // both on model a; never reached b
  });

  it('stops retrying when the abort signal fires during the backoff', async () => {
    const controller = new AbortController();
    // Every attempt is transient; abort shortly after the first failure so the
    // backoff sleep resolves as aborted and no further attempts run.
    const fn = vi.fn().mockRejectedValue(transient());
    setTimeout(() => controller.abort(), 10);
    await expect(
      runWithModelFallback([entry('a'), entry('b')], fn, {
        maxRetriesPerModel: 5,
        abortSignal: controller.signal,
      }),
    ).rejects.toBeDefined();
    // Aborted mid-backoff → far fewer than (2 models * 6 attempts) calls.
    expect(fn.mock.calls.length).toBeLessThan(4);
  });

  it('throws immediately on a non-transient error (no fallback)', async () => {
    const fn = vi.fn().mockRejectedValue(permanent());
    await expect(runWithModelFallback([entry('a'), entry('b')], fn)).rejects.toThrow('bad request');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('throws the last error when the whole chain is exhausted by transient errors', async () => {
    const fn = vi.fn().mockRejectedValue(transient());
    await expect(runWithModelFallback([entry('a'), entry('b')], fn, { maxRetriesPerModel: 0 })).rejects.toThrow(
      'overloaded',
    );
    expect(fn).toHaveBeenCalledTimes(2); // one per model
  });

  it('does not attempt when aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const fn = vi.fn(async () => 'ok');
    await expect(runWithModelFallback([entry('a')], fn, { abortSignal: controller.signal })).rejects.toThrow();
    expect(fn).not.toHaveBeenCalled();
  });

  it('throws on an empty chain', async () => {
    await expect(runWithModelFallback([], vi.fn())).rejects.toThrow('empty model chain');
  });
});
