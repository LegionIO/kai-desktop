import { useState, useRef, useEffect, type FC, type KeyboardEvent } from 'react';
import { CheckIcon, XIcon } from 'lucide-react';

interface InlineRenameInputProps {
  defaultValue: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
}

export const InlineRenameInput: FC<InlineRenameInputProps> = ({
  defaultValue,
  onCommit,
  onCancel,
}) => {
  const [value, setValue] = useState(defaultValue);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // Auto-focus and select all text on mount
    const el = inputRef.current;
    if (el) {
      el.focus();
      el.select();
    }
  }, []);

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (value.trim()) onCommit(value.trim());
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onCancel();
    }
  };

  const isValid = value.trim().length > 0 && value.trim() !== defaultValue;

  return (
    <div className="flex flex-1 items-center gap-1" onClick={(e) => e.stopPropagation()}>
      <input
        ref={inputRef}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        className="min-w-0 flex-1 rounded-md border border-sidebar-border bg-sidebar-accent/50 px-1.5 py-0.5 text-xs text-sidebar-foreground outline-none focus:border-primary/50"
      />
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          if (value.trim()) onCommit(value.trim());
        }}
        disabled={!isValid}
        className="rounded p-0.5 text-muted-foreground hover:text-emerald-400 disabled:opacity-30"
      >
        <CheckIcon size={13} />
      </button>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onCancel();
        }}
        className="rounded p-0.5 text-muted-foreground hover:text-destructive"
      >
        <XIcon size={13} />
      </button>
    </div>
  );
};
