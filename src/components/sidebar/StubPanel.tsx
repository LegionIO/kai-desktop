import type { FC, ReactNode } from 'react';

interface StubPanelProps {
  icon: ReactNode;
  title: string;
  description: string;
}

export const StubPanel: FC<StubPanelProps> = ({ icon, title, description }) => (
  <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
    <div className="text-muted-foreground/15">{icon}</div>
    <h3 className="mt-3 text-xs font-medium text-muted-foreground/40">
      {title}
    </h3>
    <p className="mt-1 text-[11px] text-muted-foreground/25">
      {description}
    </p>
  </div>
);
