import { type FC } from 'react';
import { CheckIcon as CheckSmallIcon } from 'lucide-react';

export const DeviceRow: FC<{
  label: string;
  selected: boolean;
  level: number;
  onClick: () => void;
}> = ({ label, selected, onClick }) => {
  return (
    <button
      type="button"
      className={`flex w-full items-center gap-2 rounded-xl px-3 py-2 text-xs transition-colors ${
        selected ? 'bg-primary/10 text-primary font-medium' : 'hover:bg-muted/60 text-foreground'
      }`}
      onClick={onClick}
    >
      {selected && <CheckSmallIcon className="h-3 w-3 shrink-0" />}
      <span className="flex-1 min-w-0 truncate text-left">{label}</span>
    </button>
  );
};
