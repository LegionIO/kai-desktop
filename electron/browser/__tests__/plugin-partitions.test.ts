import type { Session } from 'electron';
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  session: { fromPartition: vi.fn() },
}));

const { clearPluginBrowserPartitions } = await import('../plugin-partitions.js');
const { beginPluginBrowserPartitionOperation, trackPluginBrowserWindow } =
  await import('../../plugins/browser-window/lifecycle.js');

function pluginSession() {
  return {
    clearAuthCache: vi.fn(async () => undefined),
    clearCache: vi.fn(async () => undefined),
    clearStorageData: vi.fn(async () => undefined),
    closeAllConnections: vi.fn(async () => undefined),
  };
}

describe('plugin browser partition clearing', () => {
  it('waits for an admitted plugin session operation before constructing clear sessions', async () => {
    const partitionName = 'plugin-active-operation';
    const releaseOperation = beginPluginBrowserPartitionOperation(`persist:${partitionName}`);
    const scopedSessions = new Map<string, ReturnType<typeof pluginSession>>([
      [`persist:${partitionName}`, pluginSession()],
      [partitionName, pluginSession()],
    ]);
    const getSession = vi.fn((partition: string) => scopedSessions.get(partition)! as unknown as Session);
    const clear = clearPluginBrowserPartitions([partitionName], {
      getSession,
      stopServiceWorkers: async () => undefined,
    });
    try {
      await Promise.resolve();
      expect(getSession).not.toHaveBeenCalled();

      releaseOperation();
      await clear;
      expect(getSession).toHaveBeenCalledTimes(2);
    } finally {
      releaseOperation();
    }
  });

  it('does not clear the colliding profile for a persist-prefixed storage directory name', async () => {
    const target = pluginSession();
    const collidingProfile = pluginSession();
    const getSession = vi.fn((partition: string) => {
      if (partition === 'persist:persist:foo') return target as unknown as Session;
      if (partition === 'persist:foo') return collidingProfile as unknown as Session;
      throw new Error(`Unexpected partition: ${partition}`);
    });
    const stopServiceWorkers = vi.fn(async (_scopedSession: Session) => undefined);
    const removePersistentData = vi.fn(async () => undefined);

    await clearPluginBrowserPartitions(['persist:foo'], {
      getSession,
      stopServiceWorkers,
      removePersistentData,
    });

    expect(getSession).toHaveBeenCalledOnce();
    expect(getSession).toHaveBeenCalledWith('persist:persist:foo');
    expect(stopServiceWorkers).toHaveBeenCalledOnce();
    expect(stopServiceWorkers).toHaveBeenCalledWith(target);
    expect(target.clearStorageData).toHaveBeenCalledOnce();
    expect(target.clearCache).toHaveBeenCalledOnce();
    expect(target.clearAuthCache).toHaveBeenCalledOnce();
    expect(collidingProfile.clearStorageData).not.toHaveBeenCalled();
    expect(collidingProfile.clearCache).not.toHaveBeenCalled();
    expect(collidingProfile.clearAuthCache).not.toHaveBeenCalled();
    expect(removePersistentData).toHaveBeenCalledWith('persist:foo');
  });

  it('serializes overlapping successful clears and releases every partition quarantine', async () => {
    const partitionNames = ['plugin-overlap-a', 'plugin-overlap-b'];
    const sessions = new Map<string, ReturnType<typeof pluginSession>>();
    for (const partitionName of partitionNames) {
      sessions.set(`persist:${partitionName}`, pluginSession());
      sessions.set(partitionName, pluginSession());
    }
    const options = {
      getSession: (partition: string) => sessions.get(partition)! as unknown as Session,
      stopServiceWorkers: async (_scopedSession: Session) => undefined,
      removePersistentData: async (_partitionName: string) => undefined,
    };

    await Promise.all([
      clearPluginBrowserPartitions(partitionNames, options),
      clearPluginBrowserPartitions(partitionNames, options),
    ]);

    for (const partitionName of partitionNames) {
      const window = { isDestroyed: () => false, destroy: vi.fn() };
      const stopTracking = trackPluginBrowserWindow(window, `persist:${partitionName}`);
      stopTracking();
      expect(window.destroy).not.toHaveBeenCalled();
      expect(sessions.get(`persist:${partitionName}`)?.clearStorageData).toHaveBeenCalledTimes(2);
      expect(sessions.get(partitionName)?.clearStorageData).toHaveBeenCalledTimes(2);
    }
  });

  it.each(['service workers', 'network connections'] as const)(
    'quarantines a partition after failed %s and only reopens it after a complete retry',
    async (failedStep) => {
      const partitionName =
        failedStep === 'service workers' ? 'plugin-quiescence-workers' : 'plugin-quiescence-connections';
      const persistent = pluginSession();
      const inMemory = pluginSession();
      const sessions = new Map<string, ReturnType<typeof pluginSession>>([
        [`persist:${partitionName}`, persistent],
        [partitionName, inMemory],
      ]);
      const stopServiceWorkers = vi.fn(async (_scopedSession: Session) => undefined);
      if (failedStep === 'service workers')
        stopServiceWorkers.mockRejectedValueOnce(new Error('worker shutdown failed'));
      else persistent.closeAllConnections.mockRejectedValueOnce(new Error('connection shutdown failed'));
      const removePersistentData = vi.fn(async () => undefined);
      const options = {
        getSession: (partition: string) => sessions.get(partition)! as unknown as Session,
        stopServiceWorkers,
        removePersistentData,
      };

      await expect(clearPluginBrowserPartitions([partitionName], options)).rejects.toThrow(
        /could not be completely cleared/,
      );

      for (const scopedSession of [persistent, inMemory]) {
        expect(scopedSession.clearStorageData).not.toHaveBeenCalled();
        expect(scopedSession.clearCache).not.toHaveBeenCalled();
        expect(scopedSession.clearAuthCache).not.toHaveBeenCalled();
      }
      expect(removePersistentData).not.toHaveBeenCalled();

      const blockedWindow = {
        isDestroyed: () => false,
        destroy: vi.fn(),
      };
      expect(() => trackPluginBrowserWindow(blockedWindow, `persist:${partitionName}`)).toThrow(/quarantined/);
      expect(blockedWindow.destroy).toHaveBeenCalledOnce();

      await clearPluginBrowserPartitions([partitionName], options);

      for (const scopedSession of [persistent, inMemory]) {
        expect(scopedSession.clearStorageData).toHaveBeenCalledOnce();
        expect(scopedSession.clearCache).toHaveBeenCalledOnce();
        expect(scopedSession.clearAuthCache).toHaveBeenCalledOnce();
      }
      expect(removePersistentData).toHaveBeenCalledOnce();

      const reopenedWindow = {
        isDestroyed: () => false,
        destroy: vi.fn(),
      };
      const stopTracking = trackPluginBrowserWindow(reopenedWindow, `persist:${partitionName}`);
      stopTracking();
      expect(reopenedWindow.destroy).not.toHaveBeenCalled();
    },
  );
});
