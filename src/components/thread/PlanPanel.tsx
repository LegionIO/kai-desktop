import { useState, useEffect, useCallback, type FC } from 'react';
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

  return (
    <div className="flex h-full min-w-[280px] flex-col border-l border-border/70 bg-background">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border/70 px-4 py-3">
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
          className="rounded-lg p-1 text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
        >
          <XIcon className="h-4 w-4" />
        </button>
      </div>
      {/* Content */}
      <div className="flex-1 overflow-y-auto px-5 py-4">
        <MarkdownText text={content} />
      </div>
    </div>
  );
};

/** Resizable divider between chat and plan panel — follows the sidebar resize pattern */
export const PlanPanelDivider: FC<{
  panelWidth: number;
  onWidthChange: (width: number) => void;
  minWidth?: number;
  maxWidth?: number;
}> = ({ panelWidth, onWidthChange, minWidth = 280, maxWidth = 700 }) => {
  const [dragState, setDragState] = useState<{ startX: number; startWidth: number } | null>(null);

  useEffect(() => {
    if (!dragState) return undefined;

    const handlePointerMove = (event: PointerEvent) => {
      // Dragging left increases panel width (panel is on the right)
      const delta = dragState.startX - event.clientX;
      const newWidth = Math.min(Math.max(dragState.startWidth + delta, minWidth), maxWidth);
      onWidthChange(newWidth);
    };

    const finishResize = () => {
      setDragState(null);
    };

    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', finishResize);
    window.addEventListener('pointercancel', finishResize);

    return () => {
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', finishResize);
      window.removeEventListener('pointercancel', finishResize);
    };
  }, [dragState, maxWidth, minWidth, onWidthChange]);

  const handleDragStart = useCallback((event: React.PointerEvent) => {
    event.preventDefault();
    setDragState({ startX: event.clientX, startWidth: panelWidth });
  }, [panelWidth]);

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize plan panel"
      aria-valuenow={panelWidth}
      aria-valuemin={minWidth}
      aria-valuemax={maxWidth}
      onPointerDown={handleDragStart}
      className="group relative h-full w-0 shrink-0 cursor-col-resize z-10"
    >
      {/* Invisible hit area */}
      <div className="absolute inset-y-0 -left-3 w-6" />
      {/* Handle pill */}
      <div className="absolute -left-0.5 top-1/2 -translate-y-1/2 h-8 w-1 rounded-full bg-border/0 transition-all duration-150 group-hover:bg-muted-foreground/40 group-hover:h-12 group-active:bg-primary/60 group-active:h-14" />
    </div>
  );
};
