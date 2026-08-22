import { session, type Session } from 'electron';
import {
  beginPluginBrowserPartitionClear,
  completePluginBrowserPartitionClear,
  pluginBrowserRuntimePartitionsForStorageName,
  waitForPluginBrowserPartitionOperations,
} from '../plugins/browser-window/lifecycle.js';
import { runBrowserDataClearOperations } from './data-clear.js';
import { runBrowserSessionOperation, waitForBrowserSessionOperations } from './session-operations.js';
import { stopRunningBrowserServiceWorkers } from './service-workers.js';

export type PluginPartitionClearOptions = {
  getSession?: (electronPartition: string) => Session;
  stopServiceWorkers?: (scopedSession: Session) => Promise<void>;
  removePersistentData?: (partitionName: string) => void | Promise<void>;
};

const pluginPartitionClearTails = new Map<string, Promise<void>>();

/** Queue clear bodies per storage partition while callers retain the lifecycle
 * fence they installed before enqueueing. The last overlapping successful
 * caller can therefore commit quarantine removal; a later queued failure keeps
 * the partition fenced instead of inheriting an earlier caller's success. */
function enqueuePluginPartitionClear(partitionName: string, task: () => Promise<void>): Promise<void> {
  const previous = pluginPartitionClearTails.get(partitionName) ?? Promise.resolve();
  const operation = previous.then(task);
  let tail: Promise<void>;
  tail = operation.then(
    () => {
      if (pluginPartitionClearTails.get(partitionName) === tail) pluginPartitionClearTails.delete(partitionName);
    },
    () => {
      if (pluginPartitionClearTails.get(partitionName) === tail) pluginPartitionClearTails.delete(partitionName);
    },
  );
  pluginPartitionClearTails.set(partitionName, tail);
  return operation;
}

/** Quiesce every Chromium runtime for plugin-owned partitions while holding
 * the plugin-window creation fence. Optional on-disk deletion runs under that
 * same fence, so no renderer can recreate auth, workers, or storage between
 * the in-memory clear and removal of the persistent partition directory. */
export async function clearPluginBrowserPartitions(
  partitionNames: readonly string[],
  options: PluginPartitionClearOptions = {},
): Promise<void> {
  const names = [...new Set(partitionNames)];
  if (names.length === 0) return;
  const getSession = options.getSession ?? ((electronPartition: string) => session.fromPartition(electronPartition));
  const stopServiceWorkers =
    options.stopServiceWorkers ??
    ((scopedSession: Session) => stopRunningBrowserServiceWorkers(scopedSession, undefined, true));
  const operations: Promise<void>[] = [];
  let previousInCall = Promise.resolve();
  for (const partitionName of names) {
    let releasePartitionClear: () => void;
    try {
      // Install every requested fence synchronously before this call yields.
      // Queued overlapping callers remain fenced while the earlier clear runs.
      releasePartitionClear = beginPluginBrowserPartitionClear([partitionName]);
    } catch (error) {
      operations.push(Promise.reject(error));
      continue;
    }
    const priorPartitionInCall = previousInCall;
    const operation = enqueuePluginPartitionClear(partitionName, async () => {
      // Preserve the previous implementation's per-call ordering while the
      // partition queue serializes overlapping calls for the same profile.
      await priorPartitionInCall.catch(() => undefined);
      const sessions = new Map<string, Session>();
      let releaseAfterNativeDrain = false;
      try {
        // The fence above rejects new Session users. Drain operations admitted
        // before it before constructing a Session or mutating Chromium state.
        await waitForPluginBrowserPartitionOperations([partitionName]);
        const scopedSession = (electronPartition: string): Session => {
          let current = sessions.get(electronPartition);
          if (!current) {
            current = getSession(electronPartition);
            sessions.set(electronPartition, current);
          }
          return current;
        };
        const variants = pluginBrowserRuntimePartitionsForStorageName(partitionName).map((electronPartition) => ({
          label: electronPartition === partitionName ? 'in-memory' : 'persistent',
          electronPartition,
        }));
        // Storage mutation and on-disk deletion are only safe after every
        // persistent and in-memory runtime has stopped its service workers and
        // pooled connections. The generic category clearer intentionally keeps
        // going after errors, so quiescence must be a distinct commit barrier.
        await runBrowserDataClearOperations(
          `Plugin browser partition ${partitionName} background network shutdown`,
          variants.flatMap(({ label, electronPartition }) => [
            {
              label: `${label} service workers`,
              run: () => stopServiceWorkers(scopedSession(electronPartition)),
            },
            {
              label: `${label} network connections`,
              run: () => {
                const current = scopedSession(electronPartition);
                return runBrowserSessionOperation(current, `${label} plugin Browser connection reset`, () =>
                  current.closeAllConnections(),
                );
              },
            },
          ]),
        );
        await runBrowserDataClearOperations(`Plugin browser partition ${partitionName}`, [
          ...variants.flatMap(({ label, electronPartition }) => [
            {
              label: `${label} Chromium storage`,
              run: () => {
                const current = scopedSession(electronPartition);
                return runBrowserSessionOperation(current, `${label} plugin Browser Chromium storage clear`, () =>
                  current.clearStorageData(),
                );
              },
            },
            {
              label: `${label} Chromium cache`,
              run: () => {
                const current = scopedSession(electronPartition);
                return runBrowserSessionOperation(current, `${label} plugin Browser Chromium cache clear`, () =>
                  current.clearCache(),
                );
              },
            },
            {
              label: `${label} HTTP authentication cache`,
              run: () => {
                const current = scopedSession(electronPartition);
                return runBrowserSessionOperation(
                  current,
                  `${label} plugin Browser HTTP authentication cache clear`,
                  () => current.clearAuthCache(),
                );
              },
            },
          ]),
          ...(options.removePersistentData
            ? [
                {
                  label: 'persistent partition directory',
                  run: () => options.removePersistentData!(partitionName),
                },
              ]
            : []),
        ]);
        completePluginBrowserPartitionClear(partitionName);
      } catch (error) {
        // A timed-out Electron mutation still owns the native Session queue.
        // Return the error to Settings now, but keep the plugin creation fence
        // until every already-admitted native mutation has really settled.
        if (sessions.size > 0) {
          releaseAfterNativeDrain = true;
          void Promise.allSettled([...sessions.values()].map(waitForBrowserSessionOperations)).finally(() =>
            releasePartitionClear(),
          );
        }
        throw error;
      } finally {
        if (!releaseAfterNativeDrain) releasePartitionClear();
      }
    });
    operations.push(operation);
    previousInCall = operation;
  }
  const results = await Promise.allSettled(operations);
  const failures = results
    .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    .map((result) => result.reason);
  if (failures.length > 0) {
    throw new AggregateError(failures, 'One or more plugin browser partitions could not be completely cleared.');
  }
}
