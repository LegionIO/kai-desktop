import { type FC, useState } from 'react';
import { InfoIcon } from 'lucide-react';

/**
 * A Kai-authored notice about the REQUEST — a retry, a compact-and-resend — as opposed to
 * anything the model said.
 *
 * Deliberately styled unlike `AssistantTextPart`: no timeline dot, no markdown rendering,
 * a muted bordered chip with an icon. A retry notice used to render as ordinary assistant
 * prose ("Retrying (1/4) in 0s — compatibility"), which read as though the model had
 * spoken it. The chip makes the authorship unambiguous at a glance.
 *
 * The provider's own error text goes behind a "Details" disclosure so the cause stays
 * inspectable without dropping a wall of provider JSON into the middle of the reply.
 */
export const NoticeTextPart: FC<{ text: string; detail?: string }> = ({ text, detail }) => {
  const [expanded, setExpanded] = useState(false);
  if (!text) return null;
  return (
    <div
      data-testid="assistant-notice"
      // `aui-assistant-notice` is load-bearing, not cosmetic: it exempts this chip from the
      // CSS rule that hides the thinking spinner once a content part renders. A retry notice
      // arrives mid-turn while the re-sent request is still streaming, so treating it as
      // content made Kai look idle for the rest of the turn. See globals.css.
      className="aui-assistant-notice my-1.5 flex items-start gap-2 rounded-lg border border-border/40 bg-muted/30 px-2.5 py-1.5"
    >
      {/* Optically centered against the FIRST text line, not the whole chip: the text is
          `leading-5` (20px) and the icon is `h-3` (12px), so (20-12)/2 = 4px = `mt-1`.
          Pairs with `items-start` on the container so expanding "Details" grows the text
          column downward without dragging the icon with it. */}
      <InfoIcon className="mt-1 h-3 w-3 shrink-0 text-muted-foreground/70" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <span className="text-[11px] leading-5 text-muted-foreground">{text}</span>
        {detail && (
          <>
            {' '}
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="text-[11px] leading-5 text-muted-foreground/70 underline decoration-dotted underline-offset-2 transition-colors hover:text-muted-foreground"
              aria-expanded={expanded}
            >
              {expanded ? 'Hide details' : 'Details'}
            </button>
            {expanded && (
              <div className="mt-1 whitespace-pre-wrap break-words rounded bg-background/60 px-2 py-1 font-mono text-[10px] leading-4 text-muted-foreground/80">
                {detail}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
};
