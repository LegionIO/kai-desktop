import type { ReactNode } from 'react';
import { PuzzleIcon } from 'lucide-react';
import * as LucideIcons from 'lucide-react';

function lucideIconByName(name: string): ReactNode {
  // Convert kebab-case to PascalCase + 'Icon': 'message-circle' → 'MessageCircleIcon'
  const componentName = name
    .split('-')
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join('') + 'Icon';
  const Icon = (LucideIcons as Record<string, unknown>)[componentName] as React.ComponentType<{ className?: string }> | undefined;
  if (Icon) return <Icon className="h-[18px] w-[18px]" />;
  return <PuzzleIcon className="h-[18px] w-[18px]" />;
}

export function getPluginNavigationIcon(icon?: { lucide: string } | { svg: string }): ReactNode {
  if (!icon) return <PuzzleIcon className="h-[18px] w-[18px]" />;

  if ('lucide' in icon) {
    return lucideIconByName(icon.lucide);
  }

  if ('svg' in icon) {
    return (
      <span
        className="inline-flex h-[18px] w-[18px] items-center justify-center [&>svg]:h-full [&>svg]:w-full"
        dangerouslySetInnerHTML={{ __html: icon.svg }}
      />
    );
  }

  return <PuzzleIcon className="h-[18px] w-[18px]" />;
}
