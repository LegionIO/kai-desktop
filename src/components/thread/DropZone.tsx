import { useState, useCallback, useRef, type FC, type ReactNode, type DragEvent } from 'react';
import { UploadIcon } from 'lucide-react';
import { useAttachments } from '@/providers/AttachmentContext';
import { useMidTurnComposer } from '@/providers/RuntimeProvider';
import { filterAttachmentsBySize, skippedAttachmentsNotice } from '@/lib/attachment-limits';

export const DropZone: FC<{ children: ReactNode }> = ({ children }) => {
  const [isDragOver, setIsDragOver] = useState(false);
  const { addAttachments } = useAttachments();
  const { getActiveConversationId } = useMidTurnComposer();
  const dragCountRef = { current: 0 };
  // Transient notice for dropped files SKIPPED by the size gate (R183).
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showNotice = useCallback((message: string) => {
    if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
    setNotice(message);
    noticeTimerRef.current = setTimeout(() => setNotice(null), 6000);
  }, []);

  const handleDragEnter = useCallback((e: DragEvent) => {
    e.preventDefault();
    dragCountRef.current++;
    if (e.dataTransfer.types.includes('Files')) {
      setIsDragOver(true);
    }
  }, []);

  const handleDragLeave = useCallback((e: DragEvent) => {
    e.preventDefault();
    dragCountRef.current--;
    if (dragCountRef.current <= 0) {
      dragCountRef.current = 0;
      setIsDragOver(false);
    }
  }, []);

  const handleDragOver = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  }, []);

  const handleDrop = useCallback(
    (e: DragEvent) => {
      e.preventDefault();
      dragCountRef.current = 0;
      setIsDragOver(false);

      const files = Array.from(e.dataTransfer.files);
      if (files.length === 0) return;

      // Capture the conversation the drop targeted (R186): the attachment store is app-global, so a
      // chat switch during the async reads would otherwise attach these files to the wrong chat.
      const originConversationId = getActiveConversationId();

      // Gate by size BEFORE reading (R183): each FileReader materializes the whole file, so an oversized
      // or bulk drop would OOM the renderer if read first. Reject over-cap files up front and report them.
      const { accepted, skipped } = filterAttachmentsBySize(files);
      if (skipped.length > 0) showNotice(skippedAttachmentsNotice(skipped) ?? '');
      if (accepted.length === 0) return;

      type Attachable = {
        name: string;
        mime: string;
        isImage: boolean;
        size: number;
        dataUrl: string;
        text?: string;
        filePath?: string;
      };
      const pending: Promise<Attachable | null>[] = [];
      for (const file of accepted) {
        const filePath = (file as File & { path?: string }).path || undefined;
        pending.push(
          new Promise<Attachable | null>((resolve) => {
            const reader = new FileReader();
            // Resolve null on read error/abort (R185) so one unreadable dropped file can't leak an
            // unresolved promise or block the batch.
            reader.onerror = () => resolve(null);
            reader.onabort = () => resolve(null);
            reader.onload = () => {
              const dataUrl = reader.result as string;
              const isText = file.type.startsWith('text/') || file.type === 'application/json';
              if (isText) {
                const textReader = new FileReader();
                textReader.onerror = () => resolve(null);
                textReader.onabort = () => resolve(null);
                textReader.onload = () => {
                  resolve({
                    name: file.name,
                    mime: file.type,
                    isImage: file.type.startsWith('image/'),
                    size: file.size,
                    dataUrl,
                    text: textReader.result as string,
                    filePath,
                  });
                };
                textReader.readAsText(file);
              } else {
                resolve({
                  name: file.name,
                  mime: file.type,
                  isImage: file.type.startsWith('image/'),
                  size: file.size,
                  dataUrl,
                  filePath,
                });
              }
            };
            reader.readAsDataURL(file);
          }),
        );
      }
      void Promise.all(pending).then((results) => {
        // Discard if the user switched conversations while the reads were in flight (R186).
        if (getActiveConversationId() !== originConversationId) return;
        const attachable = results.filter((r): r is Attachable => r !== null);
        const unreadable = accepted.length - attachable.length;
        if (attachable.length > 0) {
          // Add in one call so the aggregate backstop applies across the whole drop, not per file.
          const { skipped: overCap } = addAttachments(attachable);
          if (overCap.length > 0) showNotice(skippedAttachmentsNotice(overCap) ?? '');
        }
        if (unreadable > 0) showNotice(`Couldn't read ${unreadable} file${unreadable === 1 ? '' : 's'}.`);
      });
    },
    [addAttachments, showNotice, getActiveConversationId],
  );

  return (
    <div
      className="relative h-full"
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {children}

      {/* Transient skipped-attachment notice */}
      {notice && (
        <div
          className="absolute bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-lg border border-amber-500/40 bg-background/95 px-3 py-2 text-xs text-amber-600 shadow-md dark:text-amber-400"
          role="status"
          aria-live="polite"
        >
          {notice}
        </div>
      )}

      {/* Full-window drop overlay */}
      {isDragOver && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm">
          <div className="flex flex-col items-center gap-3 rounded-2xl border-2 border-dashed border-primary/50 bg-primary/5 px-12 py-10">
            <UploadIcon className="h-10 w-10 text-primary/60" />
            <span className="text-lg font-medium text-primary/80">{__BRAND_DROP_ZONE_TEXT}</span>
            <span className="text-xs text-muted-foreground">Images, documents, code files</span>
          </div>
        </div>
      )}
    </div>
  );
};
