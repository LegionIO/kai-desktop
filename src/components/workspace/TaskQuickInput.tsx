import { useState, useRef, type FC, type KeyboardEvent } from 'react';
import { PlusIcon, SendIcon, LoaderIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

interface TaskQuickInputProps {
  onSubmit: (text: string) => Promise<void>;
  disabled?: boolean;
}

export const TaskQuickInput: FC<TaskQuickInputProps> = ({ onSubmit, disabled }) => {
  const [isOpen, setIsOpen] = useState(false);
  const [value, setValue] = useState('');
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleSubmit = async () => {
    const text = value.trim();
    if (!text || loading) return;
    setLoading(true);
    try {
      await onSubmit(text);
      setValue('');
      setIsOpen(false);
    } catch {
      // keep input open on error
    }
    setLoading(false);
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
    if (e.key === 'Escape') {
      setIsOpen(false);
      setValue('');
    }
  };

  if (!isOpen) {
    return (
      <button
        type="button"
        onClick={() => {
          setIsOpen(true);
          setTimeout(() => inputRef.current?.focus(), 50);
        }}
        disabled={disabled}
        className="flex w-full items-center gap-1.5 rounded-md border border-dashed border-border/40 px-2 py-1.5 text-[11px] text-muted-foreground/50 transition-colors hover:border-border/70 hover:text-muted-foreground disabled:opacity-50"
      >
        <PlusIcon className="h-3 w-3" />
        New Task...
      </button>
    );
  }

  return (
    <div className="flex items-center gap-1 rounded-md border border-primary/30 bg-muted/10 p-1">
      <input
        ref={inputRef}
        type="text"
        placeholder="Describe what you want to do..."
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={() => { if (!value.trim()) setIsOpen(false); }}
        disabled={loading}
        autoFocus
        className="h-6 flex-1 bg-transparent px-1.5 text-[11px] text-foreground placeholder:text-muted-foreground/40 focus:outline-none disabled:opacity-50"
      />
      <button
        type="button"
        onClick={handleSubmit}
        disabled={!value.trim() || loading}
        className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/30 hover:text-foreground disabled:opacity-30"
      >
        {loading ? (
          <LoaderIcon className="h-3 w-3 animate-spin" />
        ) : (
          <SendIcon className="h-3 w-3" />
        )}
      </button>
    </div>
  );
};
