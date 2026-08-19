/**
 * Tests for resolveSafePartitionDir — the guard that decides whether a
 * renderer-supplied partition name is safe to rmSync as a direct child of the
 * Partitions dir. The dangerous case: '' and '.' both make join(dir, name)
 * resolve back to the Partitions dir itself, so an unguarded delete would
 * recursively wipe EVERY partition. This locks the reject-list ('', '.', '..',
 * traversal, separators, NUL) and the resolved-path strict-child containment.
 */
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { join, sep } from 'path';

const lifecycleMocks = vi.hoisted(() => ({
  beginClear: vi.fn(() => vi.fn()),
  clearCorruptMarkers: vi.fn(() => 0),
  completeClear: vi.fn(),
  quarantineSummary: vi.fn(() => ({
    partitionNames: [] as string[],
    corruptMarkerCount: 0,
    directoryUnreadable: false,
  })),
  knownNames: vi.fn<() => string[]>(() => []),
  waitForOperations: vi.fn(async () => undefined),
}));
const sessionMocks = vi.hoisted(() => ({
  fromPartition: vi.fn(),
  getAllRunning: vi.fn(() => ({})),
  closeAllConnections: vi.fn(async (): Promise<void> => undefined),
  clearStorageData: vi.fn(async (): Promise<void> => undefined),
  clearCache: vi.fn(async (): Promise<void> => undefined),
  clearAuthCache: vi.fn(async (): Promise<void> => undefined),
}));

// partitions.ts imports app/session from electron at module load.
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/kai-userdata' },
  session: {
    fromPartition: sessionMocks.fromPartition.mockImplementation(() => ({
      serviceWorkers: { getAllRunning: sessionMocks.getAllRunning },
      closeAllConnections: sessionMocks.closeAllConnections,
      clearStorageData: sessionMocks.clearStorageData,
      clearCache: sessionMocks.clearCache,
      clearAuthCache: sessionMocks.clearAuthCache,
    })),
  },
}));
vi.mock('../../plugins/browser-window/lifecycle.js', () => ({
  beginPluginBrowserPartitionClear: lifecycleMocks.beginClear,
  clearCorruptPluginBrowserQuarantineMarkers: lifecycleMocks.clearCorruptMarkers,
  completePluginBrowserPartitionClear: lifecycleMocks.completeClear,
  inspectQuarantinedPluginBrowserPartitions: lifecycleMocks.quarantineSummary,
  listKnownPluginBrowserPartitionNames: lifecycleMocks.knownNames,
  pluginBrowserRuntimePartitionsForStorageName: (name: string) =>
    name.startsWith('persist:') ? [`persist:${name}`] : [`persist:${name}`, name],
  waitForPluginBrowserPartitionOperations: lifecycleMocks.waitForOperations,
}));

import { registerPartitionHandlers, resolveSafePartitionDir } from '../partitions.js';

const DIR = join('/tmp', 'kai-userdata', 'Partitions');

beforeEach(() => {
  vi.clearAllMocks();
  lifecycleMocks.quarantineSummary.mockReturnValue({
    partitionNames: [],
    corruptMarkerCount: 0,
    directoryUnreadable: false,
  });
  lifecycleMocks.knownNames.mockReturnValue([]);
  lifecycleMocks.clearCorruptMarkers.mockReturnValue(0);
});

describe('resolveSafePartitionDir', () => {
  it('accepts a plain single-segment partition name (→ direct child path)', () => {
    expect(resolveSafePartitionDir('plugin-abc', DIR)).toBe(join(DIR, 'plugin-abc'));
    expect(resolveSafePartitionDir('persist_xyz', DIR)).toBe(join(DIR, 'persist_xyz'));
    expect(resolveSafePartitionDir('a.b.c', DIR)).toBe(join(DIR, 'a.b.c')); // dots inside are fine
  });

  it('rejects the whole-tree-wipe names (empty / . / ..)', () => {
    // These are the critical cases: '' and '.' resolve back to DIR itself.
    expect(resolveSafePartitionDir('', DIR)).toBeNull();
    expect(resolveSafePartitionDir('.', DIR)).toBeNull();
    expect(resolveSafePartitionDir('..', DIR)).toBeNull();
  });

  it('rejects traversal / separators / NUL', () => {
    for (const bad of ['../evil', 'a/b', 'a\\b', 'foo/../..', 'sub/child', 'x\0y', '..\\..\\windows', './x']) {
      expect(resolveSafePartitionDir(bad, DIR), bad).toBeNull();
    }
  });

  it('rejects a name that resolves outside / to the Partitions dir itself', () => {
    // Even without a literal '..', a name that resolves to DIR or an ancestor
    // must be rejected by the containment check.
    expect(resolveSafePartitionDir('.', DIR)).toBeNull();
    // A trailing-dot-only style can't escape the includes('..') guard, but verify
    // a legit-looking name still lands strictly under DIR.
    const ok = resolveSafePartitionDir('legit', DIR);
    expect(ok).not.toBeNull();
    expect(ok!.startsWith(DIR + sep)).toBe(true);
  });

  it('rejects non-string inputs', () => {
    for (const bad of [undefined, null, 42, {}, ['x'], true]) {
      expect(resolveSafePartitionDir(bad, DIR)).toBeNull();
    }
  });
});

describe('legacy partition deletion lifecycle', () => {
  it('lists a quarantined profile whose Chromium directory was already deleted', async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    lifecycleMocks.quarantineSummary.mockReturnValueOnce({
      partitionNames: ['plugin-orphaned-after-delete'],
      corruptMarkerCount: 0,
      directoryUnreadable: false,
    });
    registerPartitionHandlers({
      handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
        handlers.set(channel, handler);
      },
    } as never);

    await expect(handlers.get('partitions:list')?.({})).resolves.toEqual([
      { name: 'plugin-orphaned-after-delete', sizeBytes: 0, quarantined: true },
    ]);
  });

  it('keeps valid rows visible and offers recover-all for corrupt quarantine markers', async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    lifecycleMocks.quarantineSummary.mockReturnValue({
      partitionNames: ['plugin-valid-quarantine'],
      corruptMarkerCount: 1,
      directoryUnreadable: false,
    });
    lifecycleMocks.knownNames.mockReturnValue(['plugin-live-runtime']);
    lifecycleMocks.clearCorruptMarkers.mockReturnValue(1);
    registerPartitionHandlers({
      handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
        handlers.set(channel, handler);
      },
    } as never);

    const listed = (await handlers.get('partitions:list')?.({})) as Array<Record<string, unknown>>;
    expect(listed).toContainEqual({
      name: 'plugin-valid-quarantine',
      sizeBytes: 0,
      quarantined: true,
    });
    const recovery = listed.find((entry) => entry.recoveryRequired === 'all-plugin-partitions');
    expect(recovery).toMatchObject({
      displayName: 'Unreadable plugin Browser cleanup state',
      corruptMarkerCount: 1,
      quarantined: true,
    });

    await expect(handlers.get('partitions:delete')?.({}, [recovery?.name])).resolves.toEqual({
      success: true,
      deleted: ['plugin-valid-quarantine', 'plugin-live-runtime'],
      recoveredCorruptMarkers: 1,
    });
    expect(lifecycleMocks.clearCorruptMarkers).toHaveBeenCalledOnce();
    expect(sessionMocks.fromPartition).toHaveBeenCalledWith('persist:plugin-valid-quarantine');
    expect(sessionMocks.fromPartition).toHaveBeenCalledWith('persist:plugin-live-runtime');
  });

  it('holds the plugin-window creation fence across the complete clear', async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const release = vi.fn();
    lifecycleMocks.beginClear.mockReturnValueOnce(release);
    registerPartitionHandlers({
      handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
        handlers.set(channel, handler);
      },
    } as never);

    await expect(
      handlers.get('partitions:delete')?.({}, [
        'plugin-auth',
        '../invalid',
        'kai-browser-global',
        'persist:kai-browser-global',
      ]),
    ).resolves.toEqual({ success: true, deleted: ['plugin-auth'] });
    expect(lifecycleMocks.beginClear).toHaveBeenCalledWith(['plugin-auth']);
    expect(sessionMocks.fromPartition).toHaveBeenCalledWith('persist:plugin-auth');
    expect(sessionMocks.fromPartition).toHaveBeenCalledWith('plugin-auth');
    expect(sessionMocks.closeAllConnections).toHaveBeenCalledTimes(2);
    expect(sessionMocks.clearStorageData).toHaveBeenCalledTimes(2);
    expect(sessionMocks.clearCache).toHaveBeenCalledTimes(2);
    expect(sessionMocks.clearAuthCache).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledOnce();
  });

  it('does not release the creation fence between Chromium clearing and deletion', async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const release = vi.fn();
    lifecycleMocks.beginClear.mockReturnValueOnce(release);
    let finishStorageClear!: () => void;
    sessionMocks.clearStorageData.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishStorageClear = resolve;
        }),
    );
    registerPartitionHandlers({
      handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
        handlers.set(channel, handler);
      },
    } as never);

    const deletion = handlers.get('partitions:delete')?.({}, ['plugin-auth']) as Promise<unknown>;
    await vi.waitFor(() => expect(sessionMocks.clearStorageData).toHaveBeenCalledOnce());
    expect(release).not.toHaveBeenCalled();

    finishStorageClear();
    await expect(deletion).resolves.toEqual({ success: true, deleted: ['plugin-auth'] });
    expect(sessionMocks.clearAuthCache).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledOnce();
  });
});
