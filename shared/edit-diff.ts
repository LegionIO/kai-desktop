/**
 * Pure edit-diff logic shared by the renderer's tool views.
 *
 * Extracted verbatim from the hand-rolled diff inside ToolGroup.tsx's
 * EditInlineView so it can be unit-tested and reused for a turn-level rollup.
 * No DOM / Electron imports — pure functions of tool-call args.
 *
 * The diff is a pure function of a tool call's `args` (old_string / new_string
 * / content), which are already present on the rendered ToolCallPart — nothing
 * new crosses the IPC wire or lands in conversations.json.
 */

export type DiffLineType = 'added' | 'removed' | 'context';

export type DiffLine = { text: string; type: DiffLineType };

/** Kind of file mutation a tool call represents. */
export type EditKind = 'edit' | 'write' | 'create' | 'delete';

export type EditStat = {
  filePath: string;
  fileName: string;
  added: number;
  removed: number;
  kind: EditKind;
  /** True when the LCS was skipped for a large input (counts over-report). */
  truncated: boolean;
  diffLines: DiffLine[];
};

export type EditSummary = {
  filesChanged: number;
  added: number;
  removed: number;
  perFile: EditStat[];
  /** True when any contributing edit hit the block-diff fallback. */
  hasTruncated: boolean;
};

/** A minimal shape of the tool-call part the diff needs. */
export type EditToolCallLike = {
  toolName?: string;
  args?: unknown;
  result?: unknown;
  isError?: boolean;
};

/**
 * Above this combined line count the LCS DP table is skipped (it would be
 * O(m*n) space/time); we fall back to "all removed then all added". The cap
 * gates the DP allocation itself, not just the walk.
 */
const LCS_LINE_CAP = 400;

const EDIT_TOOL_NAMES = new Set<string>([
  // local + mastra workspace edit/write tools
  'file_edit',
  'file_write',
  'mastra_workspace_edit_file',
  'mastra_workspace_write_file',
  'edit',
  'write',
  // Claude Code agent tool names (title-case)
  'Edit',
  'Write',
]);

const WRITE_TOOL_NAMES = new Set<string>(['file_write', 'mastra_workspace_write_file', 'write', 'Write']);

/** Anchored membership test — no user-influenced regex. */
export function isEditToolName(name: string | undefined): boolean {
  return !!name && EDIT_TOOL_NAMES.has(name);
}

function isWriteToolName(name: string | undefined): boolean {
  return !!name && WRITE_TOOL_NAMES.has(name);
}

/**
 * Compute the diff lines between two strings. Ported from EditInlineView.
 * Returns the lines plus whether the LCS was skipped (block fallback) so the
 * caller can mark over-reported counts.
 */
export function computeDiffLines(
  oldStr: string | null,
  newStr: string | null,
  isWrite: boolean,
): { lines: DiffLine[]; truncated: boolean; mode: 'lcs' | 'block' } {
  if (isWrite && newStr != null) {
    return {
      lines: newStr.split('\n').map((text) => ({ text, type: 'added' as const })),
      truncated: false,
      mode: 'block',
    };
  }
  if (oldStr == null && newStr == null) return { lines: [], truncated: false, mode: 'block' };
  if (oldStr == null) {
    return {
      lines: (newStr ?? '').split('\n').map((text) => ({ text, type: 'added' as const })),
      truncated: false,
      mode: 'block',
    };
  }
  if (newStr == null) {
    return {
      lines: oldStr.split('\n').map((text) => ({ text, type: 'removed' as const })),
      truncated: false,
      mode: 'block',
    };
  }

  const aLines = oldStr.split('\n');
  const bLines = newStr.split('\n');

  // Too large for LCS — show removed block then added block. This gates the DP
  // allocation below, so counts over-report (every line is removed+added).
  if (aLines.length + bLines.length > LCS_LINE_CAP) {
    return {
      lines: [
        ...aLines.map((text) => ({ text, type: 'removed' as const })),
        ...bLines.map((text) => ({ text, type: 'added' as const })),
      ],
      truncated: true,
      mode: 'block',
    };
  }

  // Myers diff via DP LCS.
  const m = aLines.length;
  const n = bLines.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      if (aLines[i] === bLines[j]) dp[i][j] = dp[i + 1][j + 1] + 1;
      else dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < m || j < n) {
    if (i < m && j < n && aLines[i] === bLines[j]) {
      lines.push({ text: aLines[i], type: 'context' });
      i++;
      j++;
    } else if (j < n && (i >= m || dp[i][j + 1] >= dp[i + 1][j])) {
      lines.push({ text: bLines[j], type: 'added' });
      j++;
    } else {
      lines.push({ text: aLines[i], type: 'removed' });
      i++;
    }
  }
  return { lines, truncated: false, mode: 'lcs' };
}

function extractArgs(part: EditToolCallLike): {
  rawPath: string;
  oldStr: string | null;
  newStr: string | null;
} {
  const args = (part.args && typeof part.args === 'object' ? part.args : {}) as Record<string, unknown>;
  const rawPath = typeof args.file_path === 'string' ? args.file_path : typeof args.path === 'string' ? args.path : '';
  const oldStr = typeof args.old_string === 'string' ? args.old_string : null;
  const newStr =
    typeof args.new_string === 'string'
      ? args.new_string
      : typeof args.new_content === 'string'
        ? args.new_content
        : typeof args.content === 'string'
          ? args.content
          : null;
  return { rawPath, oldStr, newStr };
}

/**
 * Compute an EditStat for an edit/write tool call, or null when it's not an
 * edit tool, errored, or carries no usable args.
 */
export function computeEditStat(part: EditToolCallLike): EditStat | null {
  if (!isEditToolName(part.toolName)) return null;
  if (part.isError === true) return null;

  const { rawPath, oldStr, newStr } = extractArgs(part);
  if (oldStr == null && newStr == null) return null;

  const isWrite = isWriteToolName(part.toolName);
  const { lines, truncated } = computeDiffLines(oldStr, newStr, isWrite);

  let added = 0;
  let removed = 0;
  for (const l of lines) {
    if (l.type === 'added') added++;
    else if (l.type === 'removed') removed++;
  }

  const fileName = rawPath.split('/').pop() ?? rawPath;
  let kind: EditKind;
  if (isWrite) kind = 'write';
  else if (oldStr != null && newStr == null) kind = 'delete';
  else kind = 'edit';

  return { filePath: rawPath, fileName, added, removed, kind, truncated, diffLines: lines };
}

/**
 * Merge per-edit stats into a turn-level summary, deduped by filePath (gross
 * line sums across repeated edits to the same file). O(sum of per-edit line
 * counts) — no cross-edit quadratic behavior.
 */
export function buildEditSummary(stats: Array<EditStat | null>): EditSummary {
  const byPath = new Map<string, EditStat>();
  let hasTruncated = false;

  for (const stat of stats) {
    if (!stat) continue;
    if (stat.truncated) hasTruncated = true;
    const existing = byPath.get(stat.filePath);
    if (existing) {
      existing.added += stat.added;
      existing.removed += stat.removed;
      existing.truncated = existing.truncated || stat.truncated;
    } else {
      // Clone so callers can't mutate the source stat through the summary.
      byPath.set(stat.filePath, { ...stat });
    }
  }

  const perFile = [...byPath.values()];
  let added = 0;
  let removed = 0;
  for (const f of perFile) {
    added += f.added;
    removed += f.removed;
  }

  return { filesChanged: perFile.length, added, removed, perFile, hasTruncated };
}
