/**
 * EditDiffSummary — turn-level "N files changed · +X −Y" rollup rendered under
 * an assistant tool group (issue #80). Pure presentation over the shared
 * edit-diff core; returns null when disabled or when the turn changed no files.
 */
import type { FC } from 'react';
import { buildEditSummary, computeEditStat, type EditToolCallLike } from '../../../shared/edit-diff';

export const EditDiffSummary: FC<{ parts: EditToolCallLike[]; enabled: boolean }> = ({ parts, enabled }) => {
  if (!enabled) return null;

  const summary = buildEditSummary(parts.map((p) => computeEditStat(p)));
  if (summary.filesChanged === 0) return null;

  const fileWord = summary.filesChanged === 1 ? 'file' : 'files';

  return (
    <div className="ml-5 mt-1 flex items-center gap-2 text-xs text-muted-foreground">
      <span>
        {summary.filesChanged} {fileWord} changed
      </span>
      {summary.added > 0 && <span className="text-emerald-400">+{summary.added}</span>}
      {summary.removed > 0 && <span className="text-red-400">−{summary.removed}</span>}
      {summary.hasTruncated && (
        <span
          className="text-muted-foreground/70"
          title="A large edit exceeded the diff line cap, so its +/− counts are approximate."
        >
          (approx)
        </span>
      )}
    </div>
  );
};
