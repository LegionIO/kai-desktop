import { describe, it, expect } from 'vitest';
import {
  computeDiffLines,
  computeEditStat,
  buildEditSummary,
  isEditToolName,
  type EditToolCallLike,
} from '../../shared/edit-diff.js';

describe('isEditToolName', () => {
  it('matches known edit/write tool names (anchored, no regex)', () => {
    for (const n of [
      'file_edit',
      'file_write',
      'mastra_workspace_edit_file',
      'mastra_workspace_write_file',
      'edit',
      'write',
      'Edit',
      'Write',
    ]) {
      expect(isEditToolName(n)).toBe(true);
    }
  });
  it('rejects non-edit / undefined / lookalike names', () => {
    expect(isEditToolName(undefined)).toBe(false);
    expect(isEditToolName('read')).toBe(false);
    expect(isEditToolName('file_edit ')).toBe(false); // no trim/fuzzy
    expect(isEditToolName('WRITE')).toBe(false);
  });
});

describe('computeDiffLines', () => {
  it('write tool: all new lines are added', () => {
    const r = computeDiffLines(null, 'a\nb\nc', true);
    expect(r.mode).toBe('block');
    expect(r.truncated).toBe(false);
    expect(r.lines).toEqual([
      { text: 'a', type: 'added' },
      { text: 'b', type: 'added' },
      { text: 'c', type: 'added' },
    ]);
  });

  it('both null → empty', () => {
    expect(computeDiffLines(null, null, false).lines).toEqual([]);
  });

  it('only new → added; only old → removed', () => {
    expect(computeDiffLines(null, 'x', false).lines).toEqual([{ text: 'x', type: 'added' }]);
    expect(computeDiffLines('y', null, false).lines).toEqual([{ text: 'y', type: 'removed' }]);
  });

  it('LCS diff keeps common context and marks add/remove', () => {
    const r = computeDiffLines('a\nb\nc', 'a\nB\nc', false);
    expect(r.mode).toBe('lcs');
    expect(r.truncated).toBe(false);
    expect(r.lines).toEqual([
      { text: 'a', type: 'context' },
      { text: 'B', type: 'added' },
      { text: 'b', type: 'removed' },
      { text: 'c', type: 'context' },
    ]);
  });

  it('falls back to block diff (truncated) above the 400-line cap', () => {
    const big = Array.from({ length: 250 }, (_, i) => `line ${i}`).join('\n');
    const big2 = Array.from({ length: 250 }, (_, i) => `LINE ${i}`).join('\n');
    const r = computeDiffLines(big, big2, false);
    expect(r.mode).toBe('block');
    expect(r.truncated).toBe(true);
    // all removed then all added
    expect(r.lines.filter((l) => l.type === 'removed').length).toBe(250);
    expect(r.lines.filter((l) => l.type === 'added').length).toBe(250);
  });
});

describe('computeEditStat', () => {
  const edit = (over: Partial<EditToolCallLike>): EditToolCallLike => ({ toolName: 'file_edit', ...over });

  it('returns null for non-edit tools, errored calls, and no-arg calls', () => {
    expect(computeEditStat({ toolName: 'read', args: {} })).toBeNull();
    expect(computeEditStat(edit({ isError: true, args: { old_string: 'a', new_string: 'b', path: 'f' } }))).toBeNull();
    expect(computeEditStat(edit({ args: { path: 'f' } }))).toBeNull();
  });

  it('computes added/removed + basename for an edit', () => {
    const stat = computeEditStat(edit({ args: { path: '/a/b/foo.ts', old_string: 'x\ny', new_string: 'x\nz' } }));
    expect(stat).not.toBeNull();
    expect(stat!.fileName).toBe('foo.ts');
    expect(stat!.filePath).toBe('/a/b/foo.ts');
    expect(stat!.added).toBe(1);
    expect(stat!.removed).toBe(1);
    expect(stat!.kind).toBe('edit');
  });

  it('classifies a write tool as kind=write', () => {
    const stat = computeEditStat({ toolName: 'Write', args: { file_path: 'x.md', content: 'a\nb' } });
    expect(stat!.kind).toBe('write');
    expect(stat!.added).toBe(2);
  });

  it('supports file_path (Claude tools) and new_content/content arg aliases', () => {
    const a = computeEditStat(edit({ args: { file_path: 'p', old_string: 'a', new_content: 'b' } }));
    expect(a!.filePath).toBe('p');
    expect(a!.added + a!.removed).toBeGreaterThan(0);
  });
});

describe('buildEditSummary', () => {
  it('dedup-merges by filePath with gross sums and distinct-file count', () => {
    const s1 = computeEditStat({ toolName: 'file_edit', args: { path: 'a.ts', old_string: 'x', new_string: 'y' } });
    const s2 = computeEditStat({
      toolName: 'file_edit',
      args: { path: 'a.ts', old_string: 'p\nq', new_string: 'p\nr' },
    });
    const s3 = computeEditStat({ toolName: 'file_edit', args: { path: 'b.ts', old_string: 'm', new_string: 'n' } });
    const sum = buildEditSummary([s1, s2, s3, null]);
    expect(sum.filesChanged).toBe(2); // a.ts + b.ts
    expect(sum.perFile.find((f) => f.filePath === 'a.ts')!.added).toBe(s1!.added + s2!.added);
    expect(sum.added).toBe(s1!.added + s2!.added + s3!.added);
    expect(sum.hasTruncated).toBe(false);
  });

  it('flags hasTruncated when any contributing edit hit the block fallback', () => {
    const big = Array.from({ length: 300 }, (_, i) => `l${i}`).join('\n');
    const s = computeEditStat({
      toolName: 'file_edit',
      args: { path: 'big.ts', old_string: big, new_string: big + '\nmore' },
    });
    const sum = buildEditSummary([s]);
    expect(sum.hasTruncated).toBe(true);
  });

  it('empty input → zeroed summary', () => {
    expect(buildEditSummary([null, null])).toEqual({
      filesChanged: 0,
      added: 0,
      removed: 0,
      perFile: [],
      hasTruncated: false,
    });
  });

  it('does not mutate source stats through the summary', () => {
    const s = computeEditStat({ toolName: 'file_edit', args: { path: 'a.ts', old_string: 'x', new_string: 'y' } })!;
    const beforeAdded = s.added;
    const sum = buildEditSummary([
      s,
      computeEditStat({ toolName: 'file_edit', args: { path: 'a.ts', old_string: 'z', new_string: 'w' } }),
    ]);
    sum.perFile[0].added += 999;
    expect(s.added).toBe(beforeAdded);
  });
});
