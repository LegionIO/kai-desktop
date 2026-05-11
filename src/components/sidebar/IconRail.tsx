import type { FC } from 'react';
import {
  MessageSquareIcon,
  CheckSquareIcon,
  BotIcon,
  PackageIcon,
  SettingsIcon,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Tooltip } from '@/components/ui/Tooltip';
import { cn } from '@/lib/utils';
import type { SidebarTab } from '../../../electron/config/schema';

type ThemeButtonProps = {
  icon: FC<{ className?: string }>;
  title: string;
  onClick: () => void;
};

// ── Tab definitions ──────────────────────────────────────────────────────

type TabDef = { id: SidebarTab; icon: LucideIcon; label: string };

const SCOPED_TABS: readonly TabDef[] = [
  { id: 'chats', icon: MessageSquareIcon, label: 'Chats' },
  { id: 'tasks', icon: CheckSquareIcon, label: 'Tasks' },
];

const GLOBAL_TABS: readonly TabDef[] = [
  // { id: 'messages', icon: InboxIcon, label: 'Messages' },  // TODO: re-enable later
  { id: 'agents', icon: BotIcon, label: 'Agents' },
  { id: 'plugins', icon: PackageIcon, label: 'Plugins' },
];

// ── IconRailButton ───────────────────────────────────────────────────────

const IconRailButton: FC<{
  icon: LucideIcon;
  label: string;
  isActive: boolean;
  dimmed?: boolean;
  onClick: () => void;
}> = ({ icon: Icon, label, isActive, dimmed, onClick }) => (
  <Tooltip
    content={label}
    side="right"
    sideOffset={6}
  >
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex h-8 w-8 items-center justify-center rounded-lg transition-colors',
        isActive
          ? 'bg-[var(--brand-accent)]/20 text-[var(--brand-accent)] shadow-[inset_0_1px_2px_rgba(0,0,0,0.15)]'
          : dimmed
            ? 'text-muted-foreground/30'
            : 'text-muted-foreground hover:bg-sidebar-accent/40 hover:text-sidebar-foreground/80',
      )}
    >
      <Icon size={17} strokeWidth={1.8} />
    </button>
  </Tooltip>
);

// ── IconRail ─────────────────────────────────────────────────────────────

interface IconRailProps {
  activeTab: SidebarTab;
  onSelectTab: (tab: SidebarTab) => void;
  /** When true, all icons appear dimmed (e.g. no workspace) */
  dimmed?: boolean;
  /** Whether the settings view is currently active */
  settingsActive?: boolean;
  /** Called when the settings icon is clicked */
  onSettingsClick?: () => void;
  /** Theme toggle button config */
  themeButton?: ThemeButtonProps;
}

export const IconRail: FC<IconRailProps> = ({ activeTab, onSelectTab, dimmed, settingsActive, onSettingsClick, themeButton }) => (
  <div className="flex w-[38px] shrink-0 flex-col items-center border-r border-sidebar-border/50 py-2 gap-0.5">
    {SCOPED_TABS.map((tab) => (
      <IconRailButton
        key={tab.id}
        icon={tab.icon}
        label={tab.label}
        isActive={activeTab === tab.id}
        dimmed={dimmed}
        onClick={() => onSelectTab(tab.id)}
      />
    ))}

    {GLOBAL_TABS.map((tab) => (
      <IconRailButton
        key={tab.id}
        icon={tab.icon}
        label={tab.label}
        isActive={activeTab === tab.id}
        dimmed={dimmed}
        onClick={() => onSelectTab(tab.id)}
      />
    ))}

    {/* Push theme + settings to the bottom */}
    <div className="flex-1" />

    {themeButton && (
      <Tooltip
        content={themeButton.title}
        side="right"
        sideOffset={6}
      >
        <button
          type="button"
          onClick={themeButton.onClick}
          className="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-sidebar-accent/40 hover:text-sidebar-foreground/80"
        >
          <themeButton.icon className="h-[17px] w-[17px]" />
        </button>
      </Tooltip>
    )}

    {onSettingsClick && (
      <IconRailButton
        icon={SettingsIcon}
        label="Settings"
        isActive={!!settingsActive}
        onClick={onSettingsClick}
      />
    )}
  </div>
);
