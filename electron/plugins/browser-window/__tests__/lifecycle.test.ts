import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertPluginBrowserPartitionAvailable,
  beginPluginBrowserPartitionOperation,
  beginPluginBrowserPartitionClear,
  clearCorruptPluginBrowserQuarantineMarkers,
  completePluginBrowserPartitionClear,
  destroyPluginBrowserWindowsForPartitions,
  initializePluginBrowserPartitionLifecycle,
  inspectQuarantinedPluginBrowserPartitions,
  listQuarantinedPluginBrowserPartitionNames,
  trackPluginBrowserWindow,
  waitForPluginBrowserPartitionOperations,
} from '../lifecycle.js';

let appHome: string;

beforeEach(() => {
  appHome = mkdtempSync(join(tmpdir(), 'kai-plugin-browser-lifecycle-'));
  initializePluginBrowserPartitionLifecycle(appHome);
});

afterEach(() => {
  rmSync(appHome, { recursive: true, force: true });
});

function fakeWindow() {
  return {
    isDestroyed: () => false,
    destroy: vi.fn<() => void>(),
  };
}

describe('plugin browser window lifecycle', () => {
  it('destroys only renderers using a partition that is about to be cleared', () => {
    const persistent = fakeWindow();
    const inMemory = fakeWindow();
    const unrelated = fakeWindow();
    const cleanups = [
      trackPluginBrowserWindow(persistent, 'persist:plugin-auth'),
      trackPluginBrowserWindow(inMemory, 'plugin-auth'),
      trackPluginBrowserWindow(unrelated, 'persist:other-plugin'),
    ];
    try {
      expect(destroyPluginBrowserWindowsForPartitions(['plugin-auth'])).toBe(2);
      expect(persistent.destroy).toHaveBeenCalledOnce();
      expect(inMemory.destroy).toHaveBeenCalledOnce();
      expect(unrelated.destroy).not.toHaveBeenCalled();
    } finally {
      for (const cleanup of cleanups) cleanup();
    }
  });

  it('fails the clear when a live renderer cannot be destroyed', () => {
    const window = fakeWindow();
    window.destroy.mockImplementation(() => {
      throw new Error('renderer is stuck');
    });
    const cleanup = trackPluginBrowserWindow(window, 'persist:plugin-auth');
    try {
      expect(() => destroyPluginBrowserWindowsForPartitions(['plugin-auth'])).toThrow(/could not be closed/);
    } finally {
      cleanup();
    }
  });

  it('blocks and destroys windows opened for a partition until its asynchronous clear releases', () => {
    const existing = fakeWindow();
    const existingCleanup = trackPluginBrowserWindow(existing, 'persist:plugin-auth');
    const release = beginPluginBrowserPartitionClear(['plugin-auth']);
    try {
      expect(existing.destroy).toHaveBeenCalledOnce();
      const racing = fakeWindow();
      expect(() => trackPluginBrowserWindow(racing, 'persist:plugin-auth')).toThrow(/currently being cleared/);
      expect(racing.destroy).toHaveBeenCalledOnce();

      const unrelated = fakeWindow();
      const unrelatedCleanup = trackPluginBrowserWindow(unrelated, 'persist:other-plugin');
      unrelatedCleanup();
      expect(unrelated.destroy).not.toHaveBeenCalled();
    } finally {
      completePluginBrowserPartitionClear('plugin-auth');
      release();
      existingCleanup();
    }

    const reopened = fakeWindow();
    const reopenedCleanup = trackPluginBrowserWindow(reopened, 'persist:plugin-auth');
    reopenedCleanup();
    expect(reopened.destroy).not.toHaveBeenCalled();
  });

  it('drains admitted session operations after installing the clear fence', async () => {
    const releaseOperation = beginPluginBrowserPartitionOperation('persist:plugin-auth-operation');
    const releaseClear = beginPluginBrowserPartitionClear(['plugin-auth-operation']);
    let drained = false;
    const drain = waitForPluginBrowserPartitionOperations(['plugin-auth-operation']).then(() => {
      drained = true;
    });
    try {
      await Promise.resolve();
      expect(drained).toBe(false);
      expect(() => beginPluginBrowserPartitionOperation('persist:plugin-auth-operation')).toThrow(
        /currently being cleared/,
      );

      releaseOperation();
      await drain;
      expect(drained).toBe(true);
      completePluginBrowserPartitionClear('plugin-auth-operation');
    } finally {
      releaseOperation();
      releaseClear();
    }
  });

  it('preserves persist-prefixed storage directory names when fencing runtime partitions', () => {
    const existing = fakeWindow();
    const collidingProfile = fakeWindow();
    const existingCleanup = trackPluginBrowserWindow(existing, 'persist:persist:foo');
    const collidingCleanup = trackPluginBrowserWindow(collidingProfile, 'persist:foo');
    const release = beginPluginBrowserPartitionClear(['persist:foo']);
    try {
      expect(existing.destroy).toHaveBeenCalledOnce();
      expect(collidingProfile.destroy).not.toHaveBeenCalled();
      expect(() => assertPluginBrowserPartitionAvailable('persist:persist:foo')).toThrow(/currently being cleared/);
      expect(() => assertPluginBrowserPartitionAvailable('persist:foo')).not.toThrow();

      const racing = fakeWindow();
      expect(() => trackPluginBrowserWindow(racing, 'persist:persist:foo')).toThrow(/currently being cleared/);
      expect(racing.destroy).toHaveBeenCalledOnce();
    } finally {
      completePluginBrowserPartitionClear('persist:foo');
      release();
      existingCleanup();
      collidingCleanup();
    }

    expect(() => assertPluginBrowserPartitionAvailable('persist:persist:foo')).not.toThrow();
  });

  it('keeps a failed partition quarantined until a later clear completes', () => {
    const failedRelease = beginPluginBrowserPartitionClear(['plugin-retry']);
    failedRelease();

    const blocked = fakeWindow();
    expect(() => trackPluginBrowserWindow(blocked, 'persist:plugin-retry')).toThrow(/quarantined/);
    expect(blocked.destroy).toHaveBeenCalledOnce();

    const retryRelease = beginPluginBrowserPartitionClear(['plugin-retry']);
    completePluginBrowserPartitionClear('plugin-retry');
    retryRelease();

    const reopened = fakeWindow();
    const cleanup = trackPluginBrowserWindow(reopened, 'persist:plugin-retry');
    cleanup();
    expect(reopened.destroy).not.toHaveBeenCalled();
  });

  it('keeps a failed partition quarantined across lifecycle reinitialization', () => {
    const failedRelease = beginPluginBrowserPartitionClear(['plugin-restart']);
    failedRelease();

    // A fresh main process has empty maps/sets but the same app home.
    initializePluginBrowserPartitionLifecycle(appHome);
    expect(() => assertPluginBrowserPartitionAvailable('persist:plugin-restart')).toThrow(/quarantined/);
    const blocked = fakeWindow();
    expect(() => trackPluginBrowserWindow(blocked, 'persist:plugin-restart')).toThrow(/quarantined/);
    expect(blocked.destroy).toHaveBeenCalledOnce();

    const retryRelease = beginPluginBrowserPartitionClear(['plugin-restart']);
    completePluginBrowserPartitionClear('plugin-restart');
    retryRelease();

    initializePluginBrowserPartitionLifecycle(appHome);
    const reopened = fakeWindow();
    const cleanup = trackPluginBrowserWindow(reopened, 'persist:plugin-restart');
    cleanup();
    expect(reopened.destroy).not.toHaveBeenCalled();
  });

  it('enumerates a durable quarantine even after its Chromium directory is gone', () => {
    const failedRelease = beginPluginBrowserPartitionClear(['plugin-orphaned-after-delete']);
    failedRelease();

    // Model a restart after the Partitions child was already removed but before
    // completePluginBrowserPartitionClear could commit marker deletion.
    initializePluginBrowserPartitionLifecycle(appHome);
    expect(listQuarantinedPluginBrowserPartitionNames()).toEqual(['plugin-orphaned-after-delete']);

    const retryRelease = beginPluginBrowserPartitionClear(['plugin-orphaned-after-delete']);
    completePluginBrowserPartitionClear('plugin-orphaned-after-delete');
    retryRelease();
    expect(listQuarantinedPluginBrowserPartitionNames()).toEqual([]);
  });

  it('preserves valid recovery rows when another quarantine marker is corrupt', () => {
    const failedRelease = beginPluginBrowserPartitionClear(['plugin-valid-recovery']);
    failedRelease();
    const markerDirectory = join(appHome, 'browser', 'pending-plugin-partition-cleanup');
    mkdirSync(markerDirectory, { recursive: true });
    writeFileSync(join(markerDirectory, `${'f'.repeat(64)}.pending`), '{not-json', { mode: 0o600 });

    expect(inspectQuarantinedPluginBrowserPartitions()).toEqual({
      partitionNames: ['plugin-valid-recovery'],
      corruptMarkerCount: 1,
      directoryUnreadable: false,
    });
    expect(listQuarantinedPluginBrowserPartitionNames()).toEqual(['plugin-valid-recovery']);
    expect(clearCorruptPluginBrowserQuarantineMarkers()).toBe(1);
    expect(inspectQuarantinedPluginBrowserPartitions()).toEqual({
      partitionNames: ['plugin-valid-recovery'],
      corruptMarkerCount: 0,
      directoryUnreadable: false,
    });

    const retryRelease = beginPluginBrowserPartitionClear(['plugin-valid-recovery']);
    completePluginBrowserPartitionClear('plugin-valid-recovery');
    retryRelease();
  });

  it('does not let an overlapping success release a later failed clear', () => {
    const firstRelease = beginPluginBrowserPartitionClear(['plugin-overlap']);
    const secondRelease = beginPluginBrowserPartitionClear(['plugin-overlap']);
    completePluginBrowserPartitionClear('plugin-overlap');
    firstRelease();
    secondRelease();

    const blocked = fakeWindow();
    expect(() => trackPluginBrowserWindow(blocked, 'plugin-overlap')).toThrow(/quarantined/);
    expect(blocked.destroy).toHaveBeenCalledOnce();

    const retryRelease = beginPluginBrowserPartitionClear(['plugin-overlap']);
    completePluginBrowserPartitionClear('plugin-overlap');
    retryRelease();
  });
});
