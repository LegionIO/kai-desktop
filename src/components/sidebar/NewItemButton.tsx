import type { FC } from 'react';
import { PlusIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

interface NewItemButtonProps {
  label: string;
  onClick: () => void;
}

export const NewItemButton: FC<NewItemButtonProps> = ({ label, onClick }) => (
  <button
    type="button"
    onClick={onClick}
    className={cn(
      'mx-2 mt-2 flex items-center justify-center gap-1.5',
      'rounded-lg border border-dashed border-sidebar-border/60',
      'px-3 py-1.5 text-xs text-muted-foreground/60',
      'transition-colors hover:border-sidebar-border hover:text-muted-foreground',
    )}
  >
    <PlusIcon size={13} />
    {label}
  </button>
);
