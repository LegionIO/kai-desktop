import type { ReactNode } from 'react';
import DOMPurify from 'dompurify';
import { PackageIcon } from 'lucide-react';
import * as LucideIcons from 'lucide-react';

function lucideIconByName(name: string): ReactNode {
  // Convert kebab-case to PascalCase + 'Icon': 'message-circle' → 'MessageCircleIcon'
  const componentName = name
    .split('-')
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join('') + 'Icon';
  const Icon = (LucideIcons as Record<string, unknown>)[componentName] as React.ComponentType<{ className?: string }> | undefined;
  if (Icon) return <Icon className="h-4 w-4" />;
  return <PackageIcon className="h-4 w-4" />;
}

export function getPluginNavigationIcon(icon?: { lucide: string } | { svg: string }): ReactNode {
  if (!icon) return <PackageIcon className="h-4 w-4" />;

  if ('lucide' in icon) {
    return lucideIconByName(icon.lucide);
  }

  if ('svg' in icon) {
    // Plugin-supplied SVG markup is untrusted — sanitise before injecting.
    // The svg/svgFilters profile already strips <script> and on* event
    // handlers; foreignObject is forbidden explicitly because it re-enters
    // the HTML namespace and would otherwise allow arbitrary HTML.
    const sanitized = DOMPurify.sanitize(icon.svg, {
      USE_PROFILES: { svg: true, svgFilters: true },
      FORBID_TAGS: ['foreignObject'],
    });
    return (
      <span
        className="inline-flex h-4 w-4 items-center justify-center [&>svg]:h-full [&>svg]:w-full"
        dangerouslySetInnerHTML={{ __html: sanitized }}
      />
    );
  }

  return <PackageIcon className="h-4 w-4" />;
}
