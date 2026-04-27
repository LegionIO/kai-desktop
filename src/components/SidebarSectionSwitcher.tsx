import type { FC } from 'react';
import * as Tabs from '@radix-ui/react-tabs';
import { cn } from '@/lib/utils';

export type SidebarSection = 'threads' | 'extensions';

interface SidebarSectionSwitcherProps {
  value: SidebarSection;
  onValueChange: (v: SidebarSection) => void;
}

export const SidebarSectionSwitcher: FC<SidebarSectionSwitcherProps> = ({
  value,
  onValueChange,
}) => (
  <Tabs.Root
    value={value}
    onValueChange={(v) => onValueChange(v as SidebarSection)}
  >
    <Tabs.List className="titlebar-no-drag flex gap-1 border-b border-sidebar-border/80 px-3 py-1.5">
      <Tabs.Trigger
        value="threads"
        className={cn(
          'rounded-lg px-2.5 py-1 text-xs font-medium transition-colors',
          'data-[state=active]:bg-sidebar-accent/80 data-[state=active]:text-sidebar-foreground',
          'data-[state=inactive]:text-muted-foreground data-[state=inactive]:hover:text-sidebar-foreground/70',
        )}
      >
        {__BRAND_SIDEBAR_SECTION_THREADS}
      </Tabs.Trigger>
      <Tabs.Trigger
        value="extensions"
        className={cn(
          'rounded-lg px-2.5 py-1 text-xs font-medium transition-colors',
          'data-[state=active]:bg-sidebar-accent/80 data-[state=active]:text-sidebar-foreground',
          'data-[state=inactive]:text-muted-foreground data-[state=inactive]:hover:text-sidebar-foreground/70',
        )}
      >
        {__BRAND_SIDEBAR_SECTION_PLUGINS}
      </Tabs.Trigger>
    </Tabs.List>
  </Tabs.Root>
);
