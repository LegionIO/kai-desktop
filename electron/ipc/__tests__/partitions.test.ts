/**
 * Tests for resolveSafePartitionDir — the guard that decides whether a
 * renderer-supplied partition name is safe to rmSync as a direct child of the
 * Partitions dir. The dangerous case: '' and '.' both make join(dir, name)
 * resolve back to the Partitions dir itself, so an unguarded delete would
 * recursively wipe EVERY partition. This locks the reject-list ('', '.', '..',
 * traversal, separators, NUL) and the resolved-path strict-child containment.
 */
import { describe, it, expect, vi } from 'vitest';
import { join, sep } from 'path';

// partitions.ts imports app/session from electron at module load.
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/kai-userdata' },
  session: { fromPartition: () => ({ clearStorageData: async () => {}, clearCache: async () => {} }) },
}));

import { resolveSafePartitionDir } from '../partitions.js';

const DIR = join('/tmp', 'kai-userdata', 'Partitions');

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
