/**
 * Shared edit/diff utilities for file-edit tracking.
 *
 * Pure module — no DOM, no Electron imports. Mirrors the token-usage.ts precedent.
 *
 * IMPORTANT — truncated diffs:
 *   When the combined line count of old+new exceeds BLOCK_DIFF_THRESHOLD (400), the
 *   algorithm falls back to a block diff (all-removed then all-added). The resulting
 *   `added` / `removed` counts are over-reported compared to a true LCS diff because
 *   identical lines are counted twice (once as removed, once as added). Consumers that
 *   display these counts MUST surface the `truncated` / `hasTruncated` flag so users
 *   understand the numbers are approximate.
 */

// ── Types ──────────────────────────────────────────────────────────────────────

export type DiffLineType = 'added' | 'removed' | 'context';

export type DiffLine = {
  text: string;
  type: DiffLineType;
};

/** Classification of the tool call kind */
export type EditKind = 'edit' | 'write' | 'create' | 'delete';

/**
 * Diff statistics for a single file-edit tool call.
 *
 * `truncated` is true when the block-diff fallback was used (combined line count
 * exceeded BLOCK_DIFF_THRESHOLD). Added/removed counts are over-reported in that case.
 */
export type EditStat = {
  filePath: string;
  fileName: string;
  added: number;
  removed: number;
  kind: EditKind;
  truncated: boolean;
  diffLines: DiffLine[];
};

/**
 * Turn-level rollup across all successful edit tool calls.
 *
 * `hasTruncated` is true when at least one EditStat in the set used block-diff
 * fallback. In that case the `added`/`removed` totals may be over-reported.
 */
export type EditSummary = {
  filesChanged: number;
  added: number;
  removed: number;
  /** One entry per distinct `filePath`; gross (not net) line sums across all edits. */
  perFile: EditStat[];
  hasTruncated: boolean;
};

// ── Constants ─────────────────────────────────────────────────────────────────

/**
 * Threshold above which LCS DP allocation is skipped in favour of block diff.
 * The cap gates the DP-table allocation (`(m+1)×(n+1)` numbers) — not just the
 * rendering loop — to avoid O(m×n) memory for large inputs.
 */
export const BLOCK_DIFF_THRESHOLD = 400;

/**
 * Fixed set of edit-tool names recognised by this module.
 * Only string equality is used — no regex, no user-influenced pattern.
 */
const EDIT_TOOL_NAMES = new Set([
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
]);

/** Names that count as "write" (new file, all-added) rather than patch-edit. */
const WRITE_TOOL_NAMES = new Set([
  'file_write',
  'mastra_workspace_write_file',
  'write',
  'Write',
]);

// ── Public helpers ─────────────────────────────────────────────────────────────

/**
 * Returns true if `name` is a recognised edit tool name.
 * Uses a fixed, anchored set — no user-influenced regex.
 */
export function isEditToolName(name: string): boolean {
  return EDIT_TOOL_NAMES.has(name);
}

/**
 * Extract the base file name from a path.
 *
 * Handles both `/` and `\` separators. Pure display helper — never passed to
 * `fs` or `path`. Returns the full string if no separator is found.
 */
export function baseFileName(filePath: string): string {
  // Split on both forward-slash and backslash; take the last non-empty segment.
  const parts = filePath.split(/[\\/]/);
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i];
    if (part) return part;
  }
  return filePath;
}

// ── Core diff algorithm ────────────────────────────────────────────────────────

export type ComputeDiffLinesResult = {
  lines: DiffLine[];
  truncated: boolean;
  mode: 'lcs' | 'block';
};

/**
 * Compute diff lines between `oldStr` and `newStr`.
 *
 * When `isWrite` is true (new-file create/write), `oldStr` is ignored and all
 * lines of `newStr` are marked `added`.
 *
 * When the combined line count exceeds BLOCK_DIFF_THRESHOLD the function falls
 * back to a block diff (`removed` block followed by `added` block) and sets
 * `truncated:true`. This keeps memory bounded — the LCS DP table is O(m×n).
 *
 * Callers MUST surface `truncated` to end-users because block-diff counts
 * over-report (identical lines appear as both removed and added).
 */
export function computeDiffLines(
  oldStr: string | null,
  newStr: string | null,
  isWrite: boolean,
): ComputeDiffLinesResult {
  // Write tool — all lines are added
  if (isWrite && newStr != null) {
    const lines = newStr.split('\n').map((text): DiffLine => ({ text, type: 'added' }));
    return { lines, truncated: false, mode: 'lcs' };
  }

  // No args — empty diff
  if (oldStr == null && newStr == null) {
    return { lines: [], truncated: false, mode: 'lcs' };
  }

  // Only newStr — treat as create (all added)
  if (oldStr == null) {
    const lines = (newStr ?? '').split('\n').map((text): DiffLine => ({ text, type: 'added' }));
    return { lines, truncated: false, mode: 'lcs' };
  }

  // Only oldStr — treat as delete (all removed)
  if (newStr == null) {
    const lines = oldStr.split('\n').map((text): DiffLine => ({ text, type: 'removed' }));
    return { lines, truncated: false, mode: 'lcs' };
  }

  const aLines = oldStr.split('\n');
  const bLines = newStr.split('\n');

  // Cap gates the DP-table allocation: O((m+1)×(n+1)) numbers. For large inputs,
  // fall back to block diff to keep memory usage bounded.
  if (aLines.length + bLines.length > BLOCK_DIFF_THRESHOLD) {
    const lines: DiffLine[] = [
      ...aLines.map((text): DiffLine => ({ text, type: 'removed' })),
      ...bLines.map((text): DiffLine => ({ text, type: 'added' })),
    ];
    return { lines, truncated: true, mode: 'block' };
  }

  // Myers diff via DP LCS (same algorithm as ToolGroup.tsx EditInlineView)
  const m = aLines.length;
  const n = bLines.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      if (aLines[i] === bLines[j]) dp[i][j] = dp[i + 1][j + 1] + 1;
      else dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const result: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < m || j < n) {
    if (i < m && j < n && aLines[i] === bLines[j]) {
      result.push({ text: aLines[i], type: 'context' });
      i++;
      j++;
    } else if (j < n && (i >= m || dp[i][j + 1] >= dp[i + 1][j])) {
      result.push({ text: bLines[j], type: 'added' });
      j++;
    } else {
      result.push({ text: aLines[i], type: 'removed' });
      i++;
    }
  }

  return { lines: result, truncated: false, mode: 'lcs' };
}

// ── Per-call stat extraction ───────────────────────────────────────────────────

/**
 * A minimal tool-call part shape consumed by `computeEditStat`.
 * Kept narrow so this module remains independent of the renderer's ToolCallPart type.
 */
export type EditToolCallPart = {
  toolName: string;
  args: unknown;
  isError?: boolean;
};

/**
 * Extract an EditStat from a single tool-call part.
 *
 * Returns `null` when:
 * - The tool name is not a recognised edit tool.
 * - `isError` is true (failed edits are excluded from summaries).
 * - Args are not a plain object (binary / no-op).
 * - Neither `file_path` nor `path` arg is a non-empty string.
 */
export function computeEditStat(part: EditToolCallPart): EditStat | null {
  try {
    if (!isEditToolName(part.toolName)) return null;
    if (part.isError) return null;
    if (!part.args || typeof part.args !== 'object' || Array.isArray(part.args)) return null;

    const args = part.args as Record<string, unknown>;

    // Support both 'path' (local tools) and 'file_path' (Claude Code agent tools)
    const filePath =
      typeof args.file_path === 'string' && args.file_path
        ? args.file_path
        : typeof args.path === 'string' && args.path
          ? args.path
          : null;

    if (!filePath) return null;

    const fileName = baseFileName(filePath);

    const isWriteTool = WRITE_TOOL_NAMES.has(part.toolName);
    const oldStr = typeof args.old_string === 'string' ? args.old_string : null;
    const newStr =
      typeof args.new_string === 'string'
        ? args.new_string
        : typeof args.new_content === 'string'
          ? args.new_content
          : typeof args.content === 'string'
            ? args.content
            : null;

    // Classify kind
    let kind: EditKind;
    if (isWriteTool && newStr != null) {
      kind = oldStr == null ? 'create' : 'write';
    } else if (newStr == null && oldStr != null) {
      kind = 'delete';
    } else if (oldStr == null && newStr != null) {
      kind = 'create';
    } else {
      kind = 'edit';
    }

    const { lines, truncated } = computeDiffLines(oldStr, newStr, isWriteTool);

    const added = lines.filter((l) => l.type === 'added').length;
    const removed = lines.filter((l) => l.type === 'removed').length;

    return {
      filePath,
      fileName,
      added,
      removed,
      kind,
      truncated,
      diffLines: lines,
    };
  } catch {
    return null;
  }
}

// ── Turn-level rollup ─────────────────────────────────────────────────────────

/**
 * Build a turn-level rollup from a list of EditStat objects.
 *
 * Complexity: O(sum of per-edit line counts) — dedup-merge is done in a single
 * pass keyed by `filePath`. No cross-edit quadratic behaviour.
 *
 * Gross counts: identical lines modified by multiple edits to the same file are
 * counted once per edit, not deduplicated. This matches `git --stat` gross-count
 * semantics for incremental patches.
 */
export function buildEditSummary(stats: EditStat[]): EditSummary {
  // Merge per filePath — gross line sums (O(n) pass)
  const perFileMap = new Map<string, EditStat>();
  let hasTruncated = false;

  for (const stat of stats) {
    hasTruncated = hasTruncated || stat.truncated;
    const existing = perFileMap.get(stat.filePath);
    if (existing) {
      // Gross-sum: add line counts across multiple edits to the same file
      perFileMap.set(stat.filePath, {
        ...existing,
        added: existing.added + stat.added,
        removed: existing.removed + stat.removed,
        // Last-write-wins for kind / truncated / diffLines (per-file view shows last state)
        kind: stat.kind,
        truncated: existing.truncated || stat.truncated,
        diffLines: stat.diffLines,
      });
    } else {
      perFileMap.set(stat.filePath, { ...stat });
    }
  }

  const perFile = Array.from(perFileMap.values());
  const filesChanged = perFile.length;
  let added = 0;
  let removed = 0;
  for (const s of perFile) {
    added += s.added;
    removed += s.removed;
  }

  return { filesChanged, added, removed, perFile, hasTruncated };
}
