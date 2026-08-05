import type { FC } from 'react';
import { ExternalLinkIcon } from 'lucide-react';
import type { TaskExternalLink } from '../../../shared/task-types';

interface ExternalTaskLinksProps {
  links?: TaskExternalLink[];
  labelWidthClass?: string;
}

/** Render the stable external identities supplied by task-sync plugins. */
export const ExternalTaskLinks: FC<ExternalTaskLinksProps> = ({ links, labelWidthClass = 'w-20' }) => {
  if (!links?.length) return null;
  return (
    <div className="col-span-2 flex items-start gap-2">
      <span className={`${labelWidthClass} shrink-0 pt-0.5 text-xs text-muted-foreground/70`}>External</span>
      <div className="flex min-w-0 flex-wrap gap-1.5">
        {links.map((link) => {
          const label = link.externalKey || `${link.pluginName}:${link.externalId}`;
          const classes =
            'inline-flex max-w-full items-center gap-1 rounded-full border border-border/60 bg-muted/40 px-2 py-0.5 text-[11px] font-medium text-foreground/80';
          return link.url ? (
            <a
              key={`${link.pluginName}:${link.source}:${link.externalId}`}
              href={link.url}
              target="_blank"
              rel="noopener noreferrer"
              className={`${classes} transition-colors hover:border-primary/40 hover:text-primary`}
              title={`Open ${label}`}
            >
              <span className="truncate">{label}</span>
              <ExternalLinkIcon className="h-3 w-3 shrink-0" />
            </a>
          ) : (
            <span key={`${link.pluginName}:${link.source}:${link.externalId}`} className={classes}>
              <span className="truncate">{label}</span>
            </span>
          );
        })}
      </div>
    </div>
  );
};
