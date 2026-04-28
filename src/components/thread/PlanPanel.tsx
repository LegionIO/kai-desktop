import { useEffect, type FC } from 'react';
import { createPortal } from 'react-dom';
import { ScrollTextIcon, XIcon, FileTextIcon } from 'lucide-react';
import { MarkdownText } from './MarkdownText';

export const PlanPanel: FC<{
  content: string;
  filePath?: string;
  onClose: () => void;
}> = ({ content, filePath, onClose }) => {
  const filename = filePath ? filePath.split('/').pop() : undefined;

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      onClick={onClose}
      onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
      {/* Modal */}
      <div
        className="relative flex h-[min(80vh,720px)] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-border/50 bg-popover/95 shadow-2xl backdrop-blur-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border/70 px-5 py-3">
          <div className="flex items-center gap-2 min-w-0">
            <ScrollTextIcon className="h-4 w-4 shrink-0 text-primary" />
            <span className="text-sm font-semibold text-foreground">Plan</span>
            {filename && (
              <span className="flex items-center gap-1 truncate text-xs text-muted-foreground">
                <FileTextIcon className="h-3 w-3 shrink-0" />
                {filename}
              </span>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1 text-muted-foreground transition-colors hover:bg-muted/80 hover:text-foreground"
          >
            <XIcon className="h-4 w-4" />
          </button>
        </div>
        {/* Content */}
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <MarkdownText text={content} />
        </div>
      </div>
    </div>,
    document.body,
  );
};
