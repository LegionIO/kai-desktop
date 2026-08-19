import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../../config/schema.js';
import { createBrowserConfigTransitionCoordinator } from '../config-transition.js';

type BrowserConfig = AppConfig['browser'];

function config(overrides: Partial<BrowserConfig> = {}): BrowserConfig {
  return {
    enabled: true,
    dataScope: 'global',
    readAccess: 'allow',
    structuredActions: 'allow',
    scriptInjection: 'allow',
    passwordAccess: 'user-only',
    offerToSavePasswords: true,
    searchProvider: 'duckduckgo',
    aiAllowPrivateNetwork: false,
    idleDiscardMinutes: 10,
    maxTabsPerConversation: 20,
    showBookmarksBar: false,
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('Browser config transition coordinator', () => {
  it('rolls persisted settings back to the last applied config when Chromium quiescence fails', async () => {
    const initial = config();
    const target = config({ dataScope: 'conversation', enabled: false });
    let persisted = target;
    const rollbackConfig = vi.fn((next: BrowserConfig) => {
      persisted = next;
    });
    const onAssistantAuthorityRevoked = vi.fn();
    const onError = vi.fn();
    const coordinator = createBrowserConfigTransitionCoordinator({
      initialConfig: initial,
      getManager: () => ({
        handleConfigChanged: vi.fn().mockRejectedValue(new Error('network quiescence failed')),
      }),
      getPersistedConfig: () => persisted,
      rollbackConfig,
      onAssistantAuthorityRevoked,
      onError,
    });

    coordinator.handle(target);

    await vi.waitFor(() => expect(rollbackConfig).toHaveBeenCalledWith(initial));
    expect(persisted).toEqual(initial);
    expect(onAssistantAuthorityRevoked).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'network quiescence failed' }));
  });

  it('rolls persisted settings back when Chromium transition setup throws synchronously', async () => {
    const initial = config();
    const target = config({ dataScope: 'conversation' });
    let persisted = target;
    const rollbackConfig = vi.fn((next: BrowserConfig) => {
      persisted = next;
    });
    const onError = vi.fn();
    const coordinator = createBrowserConfigTransitionCoordinator({
      initialConfig: initial,
      getManager: () => ({
        handleConfigChanged: vi.fn(() => {
          throw new Error('transition setup failed');
        }),
      }),
      getPersistedConfig: () => persisted,
      rollbackConfig,
      onAssistantAuthorityRevoked: vi.fn(),
      onError,
    });

    expect(() => coordinator.handle(target)).not.toThrow();
    expect(coordinator.isPending()).toBe(true);

    await vi.waitFor(() => expect(rollbackConfig).toHaveBeenCalledWith(initial));
    expect(persisted).toEqual(initial);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'transition setup failed' }));
  });

  it('retries recovery when the persisted Browser config is temporarily unreadable', async () => {
    vi.useFakeTimers();
    try {
      const initial = config();
      const target = config({ dataScope: 'conversation' });
      let persisted = target;
      const handleConfigChanged = vi
        .fn()
        .mockRejectedValueOnce(new Error('network quiescence failed'))
        .mockResolvedValueOnce({ committed: true });
      const getPersistedConfig = vi
        .fn<() => BrowserConfig>()
        .mockImplementationOnce(() => {
          throw new Error('desktop config temporarily unreadable');
        })
        .mockImplementation(() => persisted);
      const rollbackConfig = vi.fn((next: BrowserConfig) => {
        persisted = next;
      });
      const coordinator = createBrowserConfigTransitionCoordinator({
        initialConfig: initial,
        getManager: () => ({ handleConfigChanged }),
        getPersistedConfig,
        rollbackConfig,
        onAssistantAuthorityRevoked: vi.fn(),
        onError: vi.fn(),
      });

      coordinator.handle(target);
      await Promise.resolve();
      await Promise.resolve();
      expect(coordinator.isPending()).toBe(true);
      expect(rollbackConfig).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(250);
      await vi.waitFor(() => expect(rollbackConfig).toHaveBeenCalledWith(initial));
      expect(handleConfigChanged).toHaveBeenCalledTimes(1);
      expect(rollbackConfig).toHaveBeenCalledWith(initial);
      expect(coordinator.isPending()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries recovery when persisting the Browser rollback temporarily fails', async () => {
    vi.useFakeTimers();
    try {
      const initial = config();
      const target = config({ enabled: false });
      let persisted = target;
      const handleConfigChanged = vi
        .fn()
        .mockRejectedValueOnce(new Error('network quiescence failed'))
        .mockResolvedValueOnce({ committed: true });
      const rollbackConfig = vi
        .fn<(next: BrowserConfig) => void>()
        .mockImplementationOnce(() => {
          throw new Error('desktop config write failed');
        })
        .mockImplementation((next) => {
          persisted = next;
        });
      const coordinator = createBrowserConfigTransitionCoordinator({
        initialConfig: initial,
        getManager: () => ({ handleConfigChanged }),
        getPersistedConfig: () => persisted,
        rollbackConfig,
        onAssistantAuthorityRevoked: vi.fn(),
        onError: vi.fn(),
      });

      coordinator.handle(target);
      await vi.waitFor(() => expect(rollbackConfig).toHaveBeenCalledTimes(1));
      expect(coordinator.isPending()).toBe(true);

      await vi.advanceTimersByTimeAsync(250);
      await vi.waitFor(() => expect(rollbackConfig).toHaveBeenCalledTimes(2));
      expect(handleConfigChanged).toHaveBeenCalledTimes(1);
      expect(rollbackConfig).toHaveBeenCalledTimes(2);
      expect(coordinator.isPending()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not let an older failed transition roll back a newer settings write', async () => {
    const initial = config();
    const first = config({ dataScope: 'conversation' });
    const latest = config({ structuredActions: 'deny' });
    const firstTransition = deferred<void>();
    const latestTransition = deferred<void>();
    let persisted = first;
    const rollbackConfig = vi.fn();
    const handleConfigChanged = vi
      .fn()
      .mockReturnValueOnce(firstTransition.promise.then(() => ({ committed: true })))
      .mockReturnValueOnce(latestTransition.promise.then(() => ({ committed: true })));
    const coordinator = createBrowserConfigTransitionCoordinator({
      initialConfig: initial,
      getManager: () => ({ handleConfigChanged }),
      getPersistedConfig: () => persisted,
      rollbackConfig,
      onAssistantAuthorityRevoked: vi.fn(),
      onError: vi.fn(),
    });

    coordinator.handle(first);
    persisted = latest;
    coordinator.handle(latest);
    firstTransition.reject(new Error('old transition failed'));
    await Promise.resolve();
    expect(rollbackConfig).not.toHaveBeenCalled();

    latestTransition.resolve();
    await latestTransition.promise;
    expect(rollbackConfig).not.toHaveBeenCalled();
  });

  it('does not use a superseded no-op as the rollback base when the latest transition fails', async () => {
    const initial = config({ structuredActions: 'deny' });
    const stale = config({ structuredActions: 'allow' });
    const latest = config({ structuredActions: 'deny', scriptInjection: 'deny' });
    const staleTransition = deferred<{ committed: boolean }>();
    const latestTransition = deferred<{ committed: boolean }>();
    let persisted = stale;
    const rollbackConfig = vi.fn((next: BrowserConfig) => {
      persisted = next;
    });
    const handleConfigChanged = vi
      .fn()
      .mockReturnValueOnce(staleTransition.promise)
      .mockReturnValueOnce(latestTransition.promise);
    const coordinator = createBrowserConfigTransitionCoordinator({
      initialConfig: initial,
      getManager: () => ({ handleConfigChanged }),
      getPersistedConfig: () => persisted,
      rollbackConfig,
      onAssistantAuthorityRevoked: vi.fn(),
      onError: vi.fn(),
    });

    coordinator.handle(stale);
    persisted = latest;
    coordinator.handle(latest);

    staleTransition.resolve({ committed: false });
    await staleTransition.promise;
    latestTransition.reject(new Error('latest transition failed'));

    await vi.waitFor(() => expect(rollbackConfig).toHaveBeenCalledWith(initial));
    expect(persisted).toEqual(initial);
  });

  it('revokes live assistant authority when the authenticated data scope changes', async () => {
    const initial = config({ dataScope: 'conversation' });
    const target = config({ dataScope: 'global' });
    const onAssistantAuthorityRevoked = vi.fn();
    const handleConfigChanged = vi.fn(async () => ({ committed: true }));
    const coordinator = createBrowserConfigTransitionCoordinator({
      initialConfig: initial,
      getManager: () => ({ handleConfigChanged }),
      getPersistedConfig: () => target,
      rollbackConfig: vi.fn(),
      onAssistantAuthorityRevoked,
      onError: vi.fn(),
    });

    coordinator.handle(target);
    await vi.waitFor(() => expect(handleConfigChanged).toHaveBeenCalledWith(target));
    expect(onAssistantAuthorityRevoked).toHaveBeenCalledOnce();

    coordinator.handle(target);
    await vi.waitFor(() => expect(handleConfigChanged).toHaveBeenCalledTimes(2));
    expect(onAssistantAuthorityRevoked).toHaveBeenCalledOnce();
  });

  it.each([
    ['read access', { readAccess: 'ask' }],
    ['structured actions', { structuredActions: 'deny' }],
    ['script injection', { scriptInjection: 'ask' }],
    ['password access', { passwordAccess: 'ask' }],
  ] as const)('propagates %s tightening through app-wide assistant revocation', async (_label, overrides) => {
    const initial = config({ passwordAccess: 'automatic' });
    const target = config({ passwordAccess: 'automatic', ...overrides });
    const onAssistantAuthorityRevoked = vi.fn();
    const handleConfigChanged = vi.fn(async () => ({ committed: true }));
    const coordinator = createBrowserConfigTransitionCoordinator({
      initialConfig: initial,
      getManager: () => ({ handleConfigChanged }),
      getPersistedConfig: () => target,
      rollbackConfig: vi.fn(),
      onAssistantAuthorityRevoked,
      onError: vi.fn(),
    });

    coordinator.handle(target);
    await vi.waitFor(() => expect(handleConfigChanged).toHaveBeenCalledWith(target));
    expect(onAssistantAuthorityRevoked).toHaveBeenCalledOnce();

    coordinator.handle(target);
    coordinator.handle(initial);
    await vi.waitFor(() => expect(handleConfigChanged).toHaveBeenCalledTimes(3));
    expect(onAssistantAuthorityRevoked).toHaveBeenCalledOnce();
  });

  it('publishes Browser tools only after the latest transition commits', async () => {
    const initial = config();
    const first = config({ dataScope: 'conversation' });
    const latest = config({ dataScope: 'global', structuredActions: 'deny' });
    const firstTransition = deferred<{ committed: boolean }>();
    const latestTransition = deferred<{ committed: boolean }>();
    const onTransitionCommitted = vi.fn();
    const handleConfigChanged = vi
      .fn()
      .mockReturnValueOnce(firstTransition.promise)
      .mockReturnValueOnce(latestTransition.promise);
    const coordinator = createBrowserConfigTransitionCoordinator({
      initialConfig: initial,
      getManager: () => ({ handleConfigChanged }),
      getPersistedConfig: () => latest,
      rollbackConfig: vi.fn(),
      onAssistantAuthorityRevoked: vi.fn(),
      onTransitionCommitted,
      onError: vi.fn(),
    });

    coordinator.handle(first);
    expect(coordinator.isPending()).toBe(true);
    coordinator.handle(latest);
    firstTransition.resolve({ committed: true });
    await firstTransition.promise;
    expect(onTransitionCommitted).not.toHaveBeenCalled();
    expect(coordinator.isPending()).toBe(true);

    latestTransition.resolve({ committed: true });
    await vi.waitFor(() => expect(onTransitionCommitted).toHaveBeenCalledWith(latest));
    expect(coordinator.isPending()).toBe(false);
  });
});
