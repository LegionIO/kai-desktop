import type { FC } from 'react';
import * as Tabs from '@radix-ui/react-tabs';
import { cn } from '@/lib/utils';

export type SidebarSection = 'threads' | 'extensions' | 'tasks';

interface SidebarSectionSwitcherProps {
  value: SidebarSection;
  onValueChange: (v: SidebarSection) => void;
  /** Called when user clicks the already-active "threads" tab (no-op when switching TO it) */
  onThreadsReselect?: () => void;
  /** Called when user clicks the already-active "extensions" tab (no-op when switching TO it) */
  onExtensionsReselect?: () => void;
  /** Called when user clicks the already-active "tasks" tab */
  onTasksReselect?: () => void;
}

const tabClass = cn(
  'flex-1 py-2 text-xs font-medium transition-all duration-150',
  'rounded-lg',
  'data-[state=active]:bg-sidebar-accent/90 data-[state=active]:text-sidebar-foreground data-[state=active]:shadow-[inset_0_1px_2px_rgba(0,0,0,0.25)]',
  'data-[state=inactive]:text-muted-foreground data-[state=inactive]:hover:text-sidebar-foreground/80',
);

export const SidebarSectionSwitcher: FC<SidebarSectionSwitcherProps> = ({
  value,
  onValueChange,
  onThreadsReselect,
  onExtensionsReselect,
  onTasksReselect,
}) => {
  const handleValueChange = (v: string) => {
    const section = v as SidebarSection;
    if (section === value) return;
    onValueChange(section);
  };

  return (
    <Tabs.Root
      value={value}
      onValueChange={handleValueChange}
    >
      <Tabs.List className="titlebar-no-drag grid grid-cols-3 gap-1 border-b border-sidebar-border/80 px-3 py-1.5">
        <Tabs.Trigger
          value="threads"
          onClick={() => { if (value === 'threads') onThreadsReselect?.(); }}
          className={tabClass}
        >
          {__BRAND_SIDEBAR_SECTION_THREADS}
        </Tabs.Trigger>
        <Tabs.Trigger
          value="tasks"
          onClick={() => { if (value === 'tasks') onTasksReselect?.(); }}
          className={tabClass}
        >
          {__BRAND_SIDEBAR_SECTION_TASKS}
        </Tabs.Trigger>
        <Tabs.Trigger
          value="extensions"
          onClick={() => { if (value === 'extensions') onExtensionsReselect?.(); }}
          className={tabClass}
        >
          {__BRAND_SIDEBAR_SECTION_PLUGINS}
        </Tabs.Trigger>
      </Tabs.List>
    </Tabs.Root>
  );
};
