import type { FC } from 'react';
import { InboxIcon } from 'lucide-react';

export const WorkspaceEmpty: FC = () => (
  <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
    <InboxIcon className="h-10 w-10 text-muted-foreground/40" />
    <div>
      <p className="text-sm font-medium text-muted-foreground">No engine selected</p>
      <p className="mt-1 text-xs text-muted-foreground/60">
        Choose an engine from the sidebar to get started.
      </p>
    </div>
  </div>
);
