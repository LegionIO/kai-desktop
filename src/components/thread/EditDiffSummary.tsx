/**
 * EditDiffSummary — turn-level rollup footer rendered under an assistant
 * turn's ToolGroup.
 *
 * Renders "N file(s) changed · +X −Y" with optional truncation hint.
 * Returns null when disabled or when no files were changed.
 *
 * Diff content is rendered ONLY as React text children (no
 * dangerouslySetInnerHTML / innerHTML). All values are treated as plain
 * strings so any user-supplied content (including HTML tags) is displayed
 * as literal text by React's built-in escaping.
 */

import type { FC } from 'react';
import type { EditSummary } from '../../../shared/edit-diff';

type EditDiffSummaryProps = {
  summary: EditSummary;
  /** When false the component renders null (feature disabled in config). */
  enabled: boolean;
};

export const EditDiffSummary: FC<EditDiffSummaryProps> = ({ summary, enabled }) => {
  if (!enabled || summary.filesChanged === 0) return null;

  const { filesChanged, added, removed, hasTruncated } = summary;
  const fileLabel = filesChanged === 1 ? 'file changed' : 'files changed';

  return (
    <div
      className="mt-1 ml-1 flex items-center gap-1.5 text-[11px] text-muted-foreground/60 tabular-nums select-none"
      data-testid="edit-diff-summary"
    >
      {/* File count — plain text child, no dangerouslySetInnerHTML */}
      <span>{filesChanged} {fileLabel}</span>
      <span className="text-muted-foreground/30">·</span>
      {added > 0 && (
        <span className="text-emerald-500">+{added}</span>
      )}
      {removed > 0 && (
        <span className="text-red-400">−{removed}</span>
      )}
      {/* Truncation hint: block-diff counts over-report identical lines */}
      {hasTruncated && (
        <span
          className="text-amber-500/70"
          title="One or more edits exceeded the diff size limit; line counts may be over-reported"
        >
          (approx.)
        </span>
      )}
    </div>
  );
};
