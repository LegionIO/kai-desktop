import { describe, expect, it, vi } from 'vitest';

// Mock electron and its transitive deps so importing electron/ipc/config.ts
// (which transitively imports BrowserWindow via window-send.ts) doesn't crash
// in the Node test environment.
vi.mock('electron', () => ({
  BrowserWindow: class { static getAllWindows() { return []; } },
  app: { getVersion: () => '0.0.0-test', getPath: () => '/tmp', isReady: () => true },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
}));

import {
  BLOCK_DIFF_THRESHOLD,
  baseFileName,
  buildEditSummary,
  computeDiffLines,
  computeEditStat,
  isEditToolName,
  type EditStat,
  type EditToolCallPart,
} from '../../shared/edit-diff.js';

// ── isEditToolName ────────────────────────────────────────────────────────────

describe('isEditToolName', () => {
  it('returns true for all recognised edit tool names', () => {
    const recognised = [
      'file_edit',
      'mastra_workspace_edit_file',
      'file_write',
      'mastra_workspace_write_file',
      'edit',
      'Edit',
      'write',
      'Write',
      'str_replace_based_edit_tool',
      'str_replace_editor',
    ];
    for (const name of recognised) {
      expect(isEditToolName(name), `expected ${name} to be recognised`).toBe(true);
    }
  });

  it('returns false for non-edit tool names', () => {
    const unknown = ['bash', 'sh', 'file_read', 'read', 'grep', 'Grep', 'glob', 'agent', '', 'EDIT'];
    for (const name of unknown) {
      expect(isEditToolName(name), `expected ${name} NOT to be recognised`).toBe(false);
    }
  });
});

// ── baseFileName ──────────────────────────────────────────────────────────────

describe('baseFileName', () => {
  it('returns the last component for a Unix path', () => {
    expect(baseFileName('/home/user/project/src/foo.ts')).toBe('foo.ts');
  });

  it('returns the last component for a Windows path', () => {
    expect(baseFileName('C:\\Users\\user\\project\\src\\foo.ts')).toBe('foo.ts');
  });

  it('handles mixed separators', () => {
    expect(baseFileName('/home/user/project/src\\foo.ts')).toBe('foo.ts');
  });

  it('handles a bare file name with no separators', () => {
    expect(baseFileName('foo.ts')).toBe('foo.ts');
  });

  it('handles a path ending with a separator gracefully', () => {
    // Trailing slash — return last non-empty segment
    expect(baseFileName('/home/user/project/')).toBe('project');
  });
});

// ── computeDiffLines ─────────────────────────────────────────────────────────

describe('computeDiffLines', () => {
  it('returns all-added for write tool with newStr', () => {
    const result = computeDiffLines(null, 'a\nb\nc', true);
    expect(result.mode).toBe('lcs');
    expect(result.truncated).toBe(false);
    expect(result.lines.map((l) => l.type)).toEqual(['added', 'added', 'added']);
  });

  it('returns empty diff when both args are null', () => {
    const result = computeDiffLines(null, null, false);
    expect(result.lines).toHaveLength(0);
    expect(result.truncated).toBe(false);
  });

  it('returns all-added when oldStr is null (create)', () => {
    const result = computeDiffLines(null, 'x\ny', false);
    expect(result.lines.every((l) => l.type === 'added')).toBe(true);
  });

  it('returns all-removed when newStr is null (delete)', () => {
    const result = computeDiffLines('a\nb', null, false);
    expect(result.lines.every((l) => l.type === 'removed')).toBe(true);
  });

  it('produces context, added, removed lines for a simple edit', () => {
    const old = 'line1\nline2\nline3';
    const next = 'line1\nLINE2_UPDATED\nline3';
    const result = computeDiffLines(old, next, false);
    expect(result.truncated).toBe(false);
    expect(result.mode).toBe('lcs');

    const types = result.lines.map((l) => l.type);
    expect(types).toContain('context');
    expect(types).toContain('added');
    expect(types).toContain('removed');
  });

  it('falls back to block diff when combined line count exceeds threshold', () => {
    // Build inputs that exceed BLOCK_DIFF_THRESHOLD
    const half = Math.ceil(BLOCK_DIFF_THRESHOLD / 2) + 1;
    const oldStr = Array.from({ length: half }, (_, i) => `old${i}`).join('\n');
    const newStr = Array.from({ length: half }, (_, i) => `new${i}`).join('\n');

    const result = computeDiffLines(oldStr, newStr, false);
    expect(result.truncated).toBe(true);
    expect(result.mode).toBe('block');

    // Block diff: all-removed then all-added
    const removedLines = result.lines.filter((l) => l.type === 'removed');
    const addedLines = result.lines.filter((l) => l.type === 'added');
    expect(removedLines.length).toBeGreaterThan(0);
    expect(addedLines.length).toBeGreaterThan(0);
    // No context lines in block mode
    expect(result.lines.some((l) => l.type === 'context')).toBe(false);
  });

  it('does NOT allocate the DP table for inputs at the threshold boundary', () => {
    // Exactly at the threshold — should use LCS (not block)
    const halfMinus1 = Math.floor(BLOCK_DIFF_THRESHOLD / 2);
    const oldStr = Array.from({ length: halfMinus1 }, (_, i) => `a${i}`).join('\n');
    const newStr = Array.from({ length: halfMinus1 }, (_, i) => `b${i}`).join('\n');
    // combined = halfMinus1 * 2 which may be < BLOCK_DIFF_THRESHOLD
    const combined = halfMinus1 + halfMinus1;
    const result = computeDiffLines(oldStr, newStr, false);
    if (combined > BLOCK_DIFF_THRESHOLD) {
      expect(result.truncated).toBe(true);
    } else {
      expect(result.truncated).toBe(false);
    }
  });
});

// ── computeEditStat ───────────────────────────────────────────────────────────

describe('computeEditStat', () => {
  const makePart = (overrides: Partial<EditToolCallPart> = {}): EditToolCallPart => ({
    toolName: 'file_edit',
    args: { file_path: '/home/user/foo.ts', old_string: 'old', new_string: 'new' },
    ...overrides,
  });

  it('returns null for a non-edit tool', () => {
    expect(computeEditStat({ toolName: 'bash', args: {} })).toBeNull();
  });

  it('returns null when isError is true', () => {
    expect(computeEditStat(makePart({ isError: true }))).toBeNull();
  });

  it('returns null when args is not an object', () => {
    expect(computeEditStat(makePart({ args: 'not an object' }))).toBeNull();
    expect(computeEditStat(makePart({ args: null }))).toBeNull();
    expect(computeEditStat(makePart({ args: ['array'] }))).toBeNull();
  });

  it('returns null when there is no file path in args', () => {
    expect(computeEditStat(makePart({ args: { old_string: 'a', new_string: 'b' } }))).toBeNull();
  });

  it('accepts "path" as an alternative to "file_path"', () => {
    const stat = computeEditStat(makePart({ args: { path: '/tmp/bar.py', new_string: 'content' } }));
    expect(stat).not.toBeNull();
    expect(stat?.filePath).toBe('/tmp/bar.py');
  });

  it('sets kind to "edit" for a patch-style edit', () => {
    const stat = computeEditStat(makePart());
    expect(stat?.kind).toBe('edit');
  });

  it('sets kind to "create" for a write tool with no old_string', () => {
    const stat = computeEditStat({
      toolName: 'file_write',
      args: { file_path: '/tmp/new.ts', content: 'hello' },
    });
    expect(stat?.kind).toBe('create');
  });

  it('sets kind to "write" for a write tool that replaces content', () => {
    // write tool with content arg — there's no old_string concept for write tools
    // but if old_string is also present it counts as "write"
    const stat = computeEditStat({
      toolName: 'file_write',
      args: { file_path: '/tmp/new.ts', old_string: 'prev', content: 'hello' },
    });
    expect(stat?.kind).toBe('write');
  });

  it('sets kind to "delete" when newStr is null and oldStr is present', () => {
    const stat = computeEditStat({
      toolName: 'file_edit',
      args: { file_path: '/tmp/del.ts', old_string: 'content' },
    });
    expect(stat?.kind).toBe('delete');
  });

  it('correctly extracts added and removed counts', () => {
    const stat = computeEditStat(makePart({
      args: { file_path: '/tmp/foo.ts', old_string: 'a\nb', new_string: 'a\nc\nd' },
    }));
    expect(stat?.removed).toBe(1); // "b" removed
    expect(stat?.added).toBe(2);   // "c" and "d" added
  });

  it('sets truncated when inputs exceed the threshold', () => {
    const half = Math.ceil(BLOCK_DIFF_THRESHOLD / 2) + 1;
    const oldStr = Array.from({ length: half }, (_, i) => `old${i}`).join('\n');
    const newStr = Array.from({ length: half }, (_, i) => `new${i}`).join('\n');
    const stat = computeEditStat(makePart({ args: { file_path: '/tmp/big.ts', old_string: oldStr, new_string: newStr } }));
    expect(stat?.truncated).toBe(true);
  });

  it('uses baseFileName for the fileName field', () => {
    const stat = computeEditStat(makePart({ args: { file_path: '/home/user/deep/nested/file.ts', new_string: 'x' } }));
    expect(stat?.fileName).toBe('file.ts');
  });
});

// ── buildEditSummary ──────────────────────────────────────────────────────────

describe('buildEditSummary', () => {
  const makeStat = (partial: Partial<EditStat> = {}): EditStat => ({
    filePath: '/tmp/foo.ts',
    fileName: 'foo.ts',
    added: 1,
    removed: 0,
    kind: 'edit',
    truncated: false,
    diffLines: [],
    ...partial,
  });

  it('returns zero counts for an empty input', () => {
    const summary = buildEditSummary([]);
    expect(summary.filesChanged).toBe(0);
    expect(summary.added).toBe(0);
    expect(summary.removed).toBe(0);
    expect(summary.perFile).toHaveLength(0);
    expect(summary.hasTruncated).toBe(false);
  });

  it('counts a single edit correctly', () => {
    const summary = buildEditSummary([makeStat({ added: 3, removed: 1 })]);
    expect(summary.filesChanged).toBe(1);
    expect(summary.added).toBe(3);
    expect(summary.removed).toBe(1);
    expect(summary.hasTruncated).toBe(false);
  });

  it('deduplicates distinct file paths (filesChanged = distinct paths)', () => {
    const stats = [
      makeStat({ filePath: '/tmp/a.ts', fileName: 'a.ts', added: 2 }),
      makeStat({ filePath: '/tmp/b.ts', fileName: 'b.ts', added: 5 }),
      makeStat({ filePath: '/tmp/c.ts', fileName: 'c.ts', added: 1 }),
    ];
    const summary = buildEditSummary(stats);
    expect(summary.filesChanged).toBe(3);
  });

  it('merges multiple edits to the same file with gross line sums', () => {
    const stats = [
      makeStat({ filePath: '/tmp/foo.ts', added: 3, removed: 1 }),
      makeStat({ filePath: '/tmp/foo.ts', added: 2, removed: 4 }),
    ];
    const summary = buildEditSummary(stats);
    expect(summary.filesChanged).toBe(1);
    expect(summary.added).toBe(5);    // gross sum
    expect(summary.removed).toBe(5);  // gross sum
  });

  it('sets hasTruncated when any stat is truncated', () => {
    const stats = [
      makeStat({ truncated: false }),
      makeStat({ filePath: '/tmp/bar.ts', truncated: true }),
    ];
    expect(buildEditSummary(stats).hasTruncated).toBe(true);
  });

  it('does not set hasTruncated when no stats are truncated', () => {
    const stats = [makeStat({ truncated: false }), makeStat({ filePath: '/tmp/bar.ts', truncated: false })];
    expect(buildEditSummary(stats).hasTruncated).toBe(false);
  });

  it('is non-quadratic: 50 edits near the threshold completes in bounded time', () => {
    // Each edit is just under the block-diff threshold so it uses LCS.
    // The key property: buildEditSummary itself must be O(n) — no cross-edit quadratic work.
    const halfThreshold = Math.floor(BLOCK_DIFF_THRESHOLD / 2) - 1;
    const oldStr = Array.from({ length: halfThreshold }, (_, i) => `old${i}`).join('\n');
    const newStr = Array.from({ length: halfThreshold }, (_, i) => `new${i}`).join('\n');

    const stats: EditStat[] = Array.from({ length: 50 }, (_, i) => {
      const result = computeDiffLines(oldStr, newStr, false);
      return {
        filePath: `/tmp/file_${i}.ts`,
        fileName: `file_${i}.ts`,
        added: result.lines.filter((l) => l.type === 'added').length,
        removed: result.lines.filter((l) => l.type === 'removed').length,
        kind: 'edit' as const,
        truncated: result.truncated,
        diffLines: result.lines,
      };
    });

    const start = Date.now();
    const summary = buildEditSummary(stats);
    const elapsed = Date.now() - start;

    expect(summary.filesChanged).toBe(50);
    // buildEditSummary itself should complete almost instantly (well under 100ms)
    expect(elapsed).toBeLessThan(500);
  });
});

// ── Config round-trip — desktopConfigPayload includes ui.editDiffSummary ─────

describe('desktopConfigPayload includes ui.editDiffSummary', () => {
  it('round-trips ui.editDiffSummary.enabled through desktopConfigPayload', async () => {
    // Dynamic import to avoid Electron bootstrap at module load
    const { desktopConfigPayload, readEffectiveConfig } = await import('../ipc/config.js');

    // Use a temp dir so readEffectiveConfig falls back to defaults
    const config = readEffectiveConfig('/nonexistent/__kai_test_defaults__');
    const payload = desktopConfigPayload(config);

    // The allowlist must include ui, and ui must include editDiffSummary
    expect(payload).toHaveProperty('ui');
    const ui = payload.ui as Record<string, unknown>;
    expect(ui).toHaveProperty('editDiffSummary');
    const editDiffSummary = ui.editDiffSummary as Record<string, unknown>;
    expect(editDiffSummary).toHaveProperty('enabled');
    expect(typeof editDiffSummary.enabled).toBe('boolean');
  });
});
