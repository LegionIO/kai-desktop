import { useState, useEffect, useCallback, type FC } from 'react';
import { MonitorIcon, SunIcon, MoonIcon } from 'lucide-react';
import { Tooltip } from '@/components/ui/Tooltip';
import { useConfig } from '@/providers/ConfigProvider';

export type ThemeMode = 'system' | 'light' | 'dark';

const STORAGE_KEY = __BRAND_APP_SLUG + '-theme';

function getStoredTheme(): ThemeMode {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'light' || stored === 'dark' || stored === 'system') return stored;
  } catch { /* ignore */ }
  return 'system';
}

function applyTheme(mode: ThemeMode): void {
  const isDark =
    mode === 'dark' ||
    (mode === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);

  if (isDark) {
    document.documentElement.classList.add('dark');
  } else {
    document.documentElement.classList.remove('dark');
  }
}

const icons: Record<ThemeMode, FC<{ className?: string }>> = {
  system: MonitorIcon,
  light: SunIcon,
  dark: MoonIcon,
};

const titles: Record<ThemeMode, string> = {
  system: 'Theme: System',
  light: 'Theme: Light',
  dark: 'Theme: Dark',
};

const cycle: ThemeMode[] = ['system', 'light', 'dark'];

function isThemeMode(value: unknown): value is ThemeMode {
  return value === 'light' || value === 'dark' || value === 'system';
}

export function useThemeToggleControl(): {
  mode: ThemeMode;
  title: string;
  Icon: FC<{ className?: string }>;
  toggle: () => void;
} {
  const { config, updateConfig } = useConfig();
  const [mode, setMode] = useState<ThemeMode>(getStoredTheme);

  const configTheme = (config as { ui?: { theme?: unknown } } | null)?.ui?.theme;

  useEffect(() => {
    if (isThemeMode(configTheme)) {
      setMode(configTheme);
    }
  }, [configTheme]);

  useEffect(() => {
    applyTheme(mode);
    try { localStorage.setItem(STORAGE_KEY, mode); } catch { /* ignore */ }
  }, [mode]);

  useEffect(() => {
    if (mode !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = () => applyTheme('system');
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [mode]);

  const toggle = useCallback(() => {
    setMode((prev) => {
      const idx = cycle.indexOf(prev);
      const next = cycle[(idx + 1) % cycle.length];
      void updateConfig('ui.theme', next);
      return next;
    });
  }, [updateConfig]);

  const Icon = icons[mode];

  return {
    mode,
    title: titles[mode],
    Icon,
    toggle,
  };
}

export const ThemeToggle: FC = () => {
  const { title, Icon, toggle } = useThemeToggleControl();

  return (
    <Tooltip content={title} side="top" sideOffset={6}>
      <button
        type="button"
        onClick={toggle}
        className="titlebar-no-drag rounded-xl p-1.5 transition-colors hover:bg-sidebar-accent"
      >
        <Icon className="h-[18px] w-[18px] text-muted-foreground" />
      </button>
    </Tooltip>
  );
};
