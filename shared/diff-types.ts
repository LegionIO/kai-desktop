/**
 * Shared types for file-edit diff tracking. Used by both the main process
 * (tracker + IPC) and the renderer (inline diff view + Changes panel).
 */

export type DiffSource = 'file-tool' | 'shell-snapshot' | 'shell-ai';

export type DiffOp = {
  at: string;
  toolName: string;
  toolCallId?: string;
  source: DiffSource;
  additions: number;
  deletions: number;
  /** True when a per-op content snapshot is retained (enables revert-to-op). Wire-safe. */
  snapshotAvailable?: boolean;
};

export type FileDiff = {
  conversationId: string;
  path: string;
  /** Unified-diff string (git-style hunks). Empty when the file was created and we have no original. */
  unifiedDiff: string;
  additions: number;
  deletions: number;
  /** true when the file did not exist (or was untracked) before the first mutating op. */
  created: boolean;
  /** true when the file no longer exists on disk after the last op. */
  deleted: boolean;
  /** Per-operation trail so the panel can show "3 edits via write/edit/shell". */
  ops: DiffOp[];
  source: DiffSource;
  /**
   * Revert is only safe when the tracker holds the true pre-image. Shell/AI
   * detected changes to previously-untracked files do not, and reverting them
   * would truncate the file.
   */
  revertable: boolean;
};

export type DiffEvent = {
  conversationId: string;
  path: string;
  unifiedDiff: string;
  additions: number;
  deletions: number;
  source: DiffSource;
  toolName: string;
  toolCallId?: string;
  created: boolean;
  deleted: boolean;
};

/** Embedded on tool-result payloads so inline diffs survive conversation reload. */
export type DiffTrackingResultMeta = {
  diffs: DiffEvent[];
  snapshotSkipped?: boolean;
};
