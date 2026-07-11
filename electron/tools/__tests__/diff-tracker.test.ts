import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, symlinkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// diff-tracker's broadcast() references BrowserWindow + web clients; stub both so
// the tracker runs in the node test env.
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
}));
vi.mock('../../web-server/web-clients.js', () => ({
  broadcastToWebClients: () => {},
}));

import { trackFileWrite, revertDiff, clearAllDiffs } from '../diff-tracker';
import type { AppConfig } from '../../config/schema.js';

// Permissive diff-tracking + file-access config (allow everything).
function cfg(): AppConfig {
  return {
    tools: {
      fileAccess: { enabled: true, allowPaths: ['*'], denyPaths: [] },
      diffTracking: { enabled: true, snapshotFileLimit: 2000, snapshotTimeoutMs: 200 },
    },
  } as unknown as AppConfig;
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kai-difftracker-'));
  clearAllDiffs();
});
afterEach(() => {
  clearAllDiffs();
  rmSync(dir, { recursive: true, force: true });
});

/** Simulate the workspace write tool: snapshot before, mutate, finish. */
function trackWrite(convId: string, path: string, newContent: string): void {
  const handle = trackFileWrite(convId, path, { toolName: 'Write' }, cfg());
  writeFileSync(path, newContent, 'utf-8');
  handle.finish();
}

describe('diff-tracker revert safety', () => {
  it('reverts an agent-created file by deleting it', () => {
    const p = join(dir, 'created.txt');
    trackWrite('c1', p, 'agent content');
    expect(existsSync(p)).toBe(true);

    const r = revertDiff('c1', p);
    expect(r.success).toBe(true);
    expect(existsSync(p)).toBe(false);
  });

  it('reverts a modified pre-existing file to its original content', () => {
    const p = join(dir, 'existing.txt');
    writeFileSync(p, 'ORIGINAL', 'utf-8');
    trackWrite('c1', p, 'MODIFIED');
    expect(readFileSync(p, 'utf-8')).toBe('MODIFIED');

    const r = revertDiff('c1', p);
    expect(r.success).toBe(true);
    expect(readFileSync(p, 'utf-8')).toBe('ORIGINAL');
  });

  it('refuses to revert through a symlink swapped in after tracking', () => {
    const p = join(dir, 'target.txt');
    writeFileSync(p, 'ORIGINAL', 'utf-8');
    trackWrite('c1', p, 'MODIFIED');

    // Attacker/drift swaps the tracked path for a symlink to a sensitive file.
    const sensitive = join(dir, 'sensitive.txt');
    writeFileSync(sensitive, 'DO NOT TOUCH', 'utf-8');
    unlinkSync(p);
    symlinkSync(sensitive, p);

    const r = revertDiff('c1', p, { force: true }); // force bypasses drift, not symlink guard
    expect(r.success).toBe(false);
    // The symlink target must be untouched.
    expect(readFileSync(sensitive, 'utf-8')).toBe('DO NOT TOUCH');
  });
});
