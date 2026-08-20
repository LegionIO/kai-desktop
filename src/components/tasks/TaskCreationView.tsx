/**
 * TaskCreationView — AI-powered task creation splash screen.
 *
 * Phase 1: Splash background + composer at bottom for initial prompt.
 * After the user submits, creates an AI task and selects it in the sidebar,
 * transitioning to the unified TaskDetailPanel view.
 */

import { useState, useRef, useEffect, useCallback, type FC, type KeyboardEvent } from 'react';
import {
  SendHorizonalIcon,
  PlusIcon,
  FolderOpenIcon,
  FileIcon,
  FileTextIcon,
  ImageIcon,
  XIcon,
  ChevronUpIcon,
} from 'lucide-react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { SplashBackground } from '@/components/SplashBackground';
import { RecordingButton } from '@/components/thread/RecordingButton';
import { useVoiceRecording } from '@/hooks/useVoiceRecording';
import { Tooltip } from '@/components/ui/Tooltip';
import { useTasks } from '@/providers/TaskProvider';
import { useLocalAttachments } from '@/hooks/useLocalAttachments';
import { useCurrentWorkingDirectory } from '@/providers/RuntimeProvider';
import { useConfig } from '@/providers/ConfigProvider';
import { app } from '@/lib/ipc-client';
import {
  filterAttachmentsBySize,
  skippedAttachmentsNotice,
  releaseAttachmentReservation,
  attachmentsToImagePayload,
} from '@/lib/attachment-limits';
import { cn, refocusComposer } from '@/lib/utils';
import { usePopoverAlign } from '@/hooks/usePopoverAlign';
import { useSplitButtonHover } from '@/hooks/useSplitButtonHover';
import { useFullWidthContent } from '@/hooks/useFullWidthContent';

// ── Props ───────────────────────────────────────────────────────────────

interface TaskCreationViewProps {
  /** Called when the user submits and the task is created — passes the new task ID. */
  onDone?: (taskId: string) => void;
  /** Called when the user cancels without creating a task. */
  onCancel?: () => void;
}

// ── Component ───────────────────────────────────────────────────────────

export const TaskCreationView: FC<TaskCreationViewProps> = ({ onDone, onCancel: _onCancel }) => {
  const { startAITaskCreation, selectTask } = useTasks();
  // Task-local attachment store (R186): the shared AttachmentProvider spans chat + tasks, so using it
  // here leaked task files into chat and let leaving Tasks clear unsent chat attachments. Local state
  // is discarded on unmount automatically, so no cross-surface clearing is needed.
  const { attachments, addAttachments, removeAttachment } = useLocalAttachments();
  const { currentWorkingDirectory, setCurrentWorkingDirectory } = useCurrentWorkingDirectory();
  const { config } = useConfig();
  const fullWidth = useFullWidthContent();

  const [input, setInput] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Voice recording hook
  const { startRecording: taskStartRecording } = useVoiceRecording();

  // Recording config (just to check enabled state)
  const recordingEnabled = (config as Record<string, unknown> | null)?.audio
    ? (((config as Record<string, unknown>).audio as { recording?: { enabled?: boolean } })?.recording?.enabled ?? true)
    : true;

  // ── CWD popover / split-button state ────────────────────────────────
  const [cwdPopoverOpen, setCwdPopoverOpen] = useState(false);
  const cwdRootRef = useRef<HTMLDivElement>(null);
  const cwdPopover = usePopoverAlign();
  const { expanded: cwdExpanded, containerProps: cwdContainerProps } = useSplitButtonHover({
    popoverOpen: cwdPopoverOpen,
  });

  useEffect(() => {
    if (!cwdPopoverOpen) return;
    const handler = (e: PointerEvent) => {
      if (!cwdRootRef.current?.contains(e.target as Node)) {
        setCwdPopoverOpen(false);
      }
    };
    window.addEventListener('pointerdown', handler);
    return () => window.removeEventListener('pointerdown', handler);
  }, [cwdPopoverOpen]);

  const cwdName = currentWorkingDirectory?.split('/').pop() ?? currentWorkingDirectory;
  const hasFileAttachments = attachments.length > 0;
  // Text OR image attachments can start a task (R187): image attachments are forwarded to the plan
  // model. Text is still required unless at least one image is staged.
  const canSend = input.trim().length > 0 || attachments.some((a) => a.isImage);

  // ── File attach / directory handlers ────────────────────────────────
  const isWebBridge = Boolean(
    (window as unknown as Record<string, unknown>).app && (window.app as Record<string, unknown>).__isWebBridge,
  );
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [pendingFileAccept, setPendingFileAccept] = useState<string>('*/*');
  // Transient notice for attachment files the main process SKIPPED (too large / not a regular
  // file) (R183) — without this the user picks a file and nothing happens (silent no-op).
  const [attachNotice, setAttachNotice] = useState<string | null>(null);
  const attachNoticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showAttachMessage = useCallback((message: string) => {
    if (!message) return;
    if (attachNoticeTimerRef.current) clearTimeout(attachNoticeTimerRef.current);
    setAttachNotice(message);
    attachNoticeTimerRef.current = setTimeout(() => setAttachNotice(null), 6000);
  }, []);
  const showAttachNotice = useCallback(
    (skipped: string[]) => {
      showAttachMessage(skippedAttachmentsNotice(skipped) ?? '');
    },
    [showAttachMessage],
  );

  const handleAttachFiles = async (filters?: Array<{ name: string; extensions: string[] }>) => {
    if (isWebBridge) {
      const accept = filters?.flatMap((f) => f.extensions.map((e) => `.${e}`)).join(',') || '*/*';
      setPendingFileAccept(accept);
      setTimeout(() => fileInputRef.current?.click(), 0);
      return;
    }
    try {
      const result = (await app.dialog.openFile({ filters })) as {
        canceled: boolean;
        files?: Array<{ name: string; mime: string; isImage: boolean; size: number; dataUrl: string; text?: string }>;
        skipped?: string[];
      };
      if (result.canceled) return;
      // Task plans can only submit IMAGES (R188), so only stage images — drop non-image files with a
      // notice instead of showing a chip that would be silently cleared without being sent.
      const images = (result.files ?? []).filter((f) => f.isImage);
      const nonImages = (result.files ?? []).filter((f) => !f.isImage).map((f) => f.name);
      // Surface images the renderer-wide budget rejected (R202): addAttachments returns {skipped} when
      // another store / in-flight reservation consumed the cap — otherwise they'd vanish with no chip.
      const overCap = images.length > 0 ? addAttachments(images).skipped : [];
      if (nonImages.length > 0) {
        showAttachMessage(`Only images can be attached to a task. Skipped: ${nonImages.join(', ')}`);
      } else if (result.skipped && result.skipped.length > 0) {
        showAttachNotice(result.skipped);
      }
      if (overCap.length > 0) showAttachNotice(overCap);
    } catch (err) {
      console.error('Attach failed:', err);
    }
  };

  const handleWebFileInputChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const fileList = event.target.files;
    if (!fileList || fileList.length === 0) return;
    // Task plans can only submit IMAGES (R188) — keep only image files so no non-submittable chip is
    // ever staged. Gate by size BEFORE reading (R184): FileReader materializes each file fully.
    const allFiles = Array.from(fileList);
    const imageFiles = allFiles.filter((f) => f.type.startsWith('image/'));
    const nonImageNames = allFiles.filter((f) => !f.type.startsWith('image/')).map((f) => f.name);
    const { accepted, skipped, reservedBytes } = filterAttachmentsBySize(imageFiles);
    if (nonImageNames.length > 0) {
      showAttachMessage(`Only images can be attached to a task. Skipped: ${nonImageNames.join(', ')}`);
    } else if (skipped.length > 0) {
      showAttachNotice(skipped);
    }
    event.target.value = '';
    if (accepted.length === 0) {
      releaseAttachmentReservation(reservedBytes);
      return;
    }
    const readers: Promise<{
      name: string;
      mime: string;
      isImage: boolean;
      size: number;
      dataUrl: string;
      text?: string;
    } | null>[] = [];
    for (const file of accepted) {
      readers.push(
        new Promise((resolve) => {
          const reader = new FileReader();
          // Resolve null on error/abort (R185) so one unreadable file can't hang Promise.all.
          reader.onerror = () => resolve(null);
          reader.onabort = () => resolve(null);
          reader.onload = () => {
            const dataUrl = reader.result as string;
            const isImage = file.type.startsWith('image/');
            resolve({ name: file.name, mime: file.type, isImage, size: file.size, dataUrl });
          };
          reader.readAsDataURL(file);
        }),
      );
    }
    void Promise.all(readers).then((results) => {
      releaseAttachmentReservation(reservedBytes);
      const attachable = results.filter((r): r is NonNullable<typeof r> => r !== null);
      const unreadable = accepted.length - attachable.length;
      if (attachable.length > 0) {
        const { skipped: overCap } = addAttachments(attachable);
        if (overCap.length > 0) showAttachNotice(overCap);
      }
      if (unreadable > 0) showAttachMessage(`Couldn't read ${unreadable} file${unreadable === 1 ? '' : 's'}.`);
    });
  };

  const handleAttachDirectory = async () => {
    if (isWebBridge) return;
    try {
      const result = await app.dialog.openDirectory();
      if (!result.canceled && result.directoryPath) {
        await setCurrentWorkingDirectory(result.directoryPath);
      }
    } catch (err) {
      console.error('Attach directory failed:', err);
    }
    refocusComposer();
  };

  const menuItemClassName =
    'flex cursor-default items-center gap-2 rounded-lg px-3 py-2 text-sm text-foreground outline-none transition-colors data-[highlighted]:bg-muted/70';

  // Auto-resize textarea
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 180) + 'px';
  }, [input]);

  // Focus textarea on mount
  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  const handleSubmit = useCallback(() => {
    const text = input.trim();
    const images = attachmentsToImagePayload(attachments);
    // Require text OR at least one image (R187).
    if (!text && images.length === 0) return;

    // Do NOT clear optimistically (R210): a cleared-then-snapshot-rollback retained the data URLs in a
    // local snapshot while clearAttachments() released their bytes from the global counter (uncounted
    // memory + a near-cap rollback would be rejected). Instead keep the composer's text + attachments
    // intact until submission SUCCEEDS; on success the view transitions away (unmount) so an explicit
    // clear is unnecessary, and on failure the user's input simply stays put — no snapshot, no rollback.
    void startAITaskCreation(
      text,
      currentWorkingDirectory ? { cwd: currentWorkingDirectory } : undefined,
      images.length > 0 ? images : undefined,
    );
    // The composer's text/attachments stay intact on failure (no optimistic clear, R210); on success the
    // view transitions away. A dropped-image warning is surfaced by the provider's surviving UI, not here.
  }, [input, attachments, startAITaskCreation, currentWorkingDirectory]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSubmit();
      }
    },
    [handleSubmit],
  );

  // Watch for creatingTaskId to appear — once the task is created, select it and exit creation mode
  const { state } = useTasks();
  const hasTransitioned = useRef(false);
  useEffect(() => {
    if (state.creatingTaskId && !hasTransitioned.current) {
      hasTransitioned.current = true;
      selectTask(state.creatingTaskId);
      onDone?.(state.creatingTaskId);
    }
  }, [state.creatingTaskId, selectTask, onDone]);

  // ── Render: Splash + Composer ──────────────────────────────────────────

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      {/* Full-bleed splash background */}
      <SplashBackground visible storageKey="__task_bg_last_index" />

      {/* Spacer */}
      <div className="flex-1" />

      {/* Composer at bottom */}
      <div className={cn('relative z-20 mx-auto w-full px-5 pb-4 pt-4 md:pb-5 md:pt-5', !fullWidth && 'max-w-3xl')}>
        {/* Hidden file input for web bridge */}
        {isWebBridge && (
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept={pendingFileAccept}
            className="hidden"
            onChange={handleWebFileInputChange}
          />
        )}
        <div className="mx-auto w-full">
          {attachNotice && (
            <div className="mb-2 px-1 text-xs text-amber-600 dark:text-amber-400" role="status" aria-live="polite">
              {attachNotice}
            </div>
          )}
          {/* File attachment chips */}
          {hasFileAttachments && (
            <div className="mb-3 flex flex-wrap gap-2">
              {attachments.map((file, i) => (
                <div
                  key={`${file.name}-${i}`}
                  className="group/att flex items-center gap-1.5 rounded-2xl border border-border/50 bg-muted/40 px-2.5 py-2 text-xs"
                >
                  {file.isImage ? (
                    <img src={file.dataUrl} alt={file.name} className="h-10 w-10 rounded object-cover" />
                  ) : (
                    <FileIcon className="h-4 w-4 text-muted-foreground" />
                  )}
                  <div className="flex flex-col">
                    <span className="max-w-[120px] truncate font-medium">{file.name}</span>
                    <span className="text-[10px] text-muted-foreground">{(file.size / 1024).toFixed(1)} KB</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => removeAttachment(i)}
                    className="ml-1 rounded p-0.5 opacity-100 transition-opacity hover:bg-destructive/10 md:opacity-0 md:group-hover/att:opacity-100"
                  >
                    <XIcon className="h-3 w-3 text-muted-foreground" />
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="flex flex-col gap-0 rounded-2xl border border-border/70 app-composer-glass px-3 py-3 app-composer-shadow">
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Describe what you want to accomplish..."
              rows={1}
              className={cn(
                'min-h-[48px] max-h-[220px] w-full resize-none overflow-y-auto bg-transparent px-1 py-0.5 text-base text-foreground placeholder:text-muted-foreground/60 focus:outline-none md:text-[15px]',
                input.includes('\n') && 'pb-3',
              )}
            />
            <div className="flex flex-col gap-1.5 md:flex-row md:items-center md:justify-between md:gap-3">
              {/* Left side: add files + working directory */}
              <div className="flex min-w-0 flex-1 items-center gap-1.5 md:gap-2">
                <DropdownMenu.Root>
                  <Tooltip content="Add files" side="top" sideOffset={8}>
                    <DropdownMenu.Trigger asChild>
                      <button
                        type="button"
                        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-border/50 bg-muted/40 transition-colors hover:bg-muted/60 text-muted-foreground"
                      >
                        <PlusIcon className="h-4 w-4" />
                      </button>
                    </DropdownMenu.Trigger>
                  </Tooltip>
                  <DropdownMenu.Portal>
                    <DropdownMenu.Content
                      align="start"
                      sideOffset={8}
                      className="z-50 min-w-[240px] rounded-2xl border border-border/70 bg-popover/95 p-1.5 text-popover-foreground shadow-xl backdrop-blur-md"
                    >
                      <DropdownMenu.Item
                        className={menuItemClassName}
                        onSelect={() => {
                          void handleAttachFiles([
                            { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'] },
                          ]);
                        }}
                      >
                        <ImageIcon className="h-4 w-4 text-muted-foreground" />
                        <span>Image</span>
                      </DropdownMenu.Item>
                      <DropdownMenu.Item
                        className={menuItemClassName}
                        onSelect={() => {
                          void handleAttachFiles([{ name: 'PDF', extensions: ['pdf'] }]);
                        }}
                      >
                        <FileIcon className="h-4 w-4 text-muted-foreground" />
                        <span>PDF</span>
                      </DropdownMenu.Item>
                      <DropdownMenu.Item
                        className={menuItemClassName}
                        onSelect={() => {
                          void handleAttachFiles([
                            {
                              name: 'Documents',
                              extensions: [
                                'txt',
                                'md',
                                'json',
                                'csv',
                                'html',
                                'htm',
                                'js',
                                'jsx',
                                'ts',
                                'tsx',
                                'css',
                                'scss',
                                'py',
                                'rb',
                                'go',
                                'rs',
                                'java',
                                'c',
                                'cpp',
                                'h',
                                'hpp',
                                'sh',
                                'yaml',
                                'yml',
                                'toml',
                                'xml',
                              ],
                            },
                          ]);
                        }}
                      >
                        <FileTextIcon className="h-4 w-4 text-muted-foreground" />
                        <span>Text / Document</span>
                      </DropdownMenu.Item>
                      <DropdownMenu.Separator className="my-1 h-px bg-border/60" />
                      <DropdownMenu.Item
                        className={menuItemClassName}
                        onSelect={() => {
                          void handleAttachFiles();
                        }}
                      >
                        <FileIcon className="h-4 w-4 text-muted-foreground" />
                        <span>Any File</span>
                      </DropdownMenu.Item>
                    </DropdownMenu.Content>
                  </DropdownMenu.Portal>
                </DropdownMenu.Root>
                {/* Working directory split button */}
                <div ref={cwdRootRef} {...cwdContainerProps} className="relative flex items-center">
                  <div
                    className={`flex items-center overflow-hidden rounded-lg border transition-colors ${
                      currentWorkingDirectory ? 'border-primary/50 bg-primary/10' : 'border-border/50 bg-muted/40'
                    }`}
                  >
                    <Tooltip
                      content={currentWorkingDirectory ? (cwdName ?? 'Working directory') : 'Working directory'}
                      side="top"
                      sideOffset={8}
                    >
                      <button
                        type="button"
                        onClick={() => {
                          void handleAttachDirectory();
                        }}
                        className={`flex h-10 w-10 shrink-0 items-center justify-center transition-colors ${
                          currentWorkingDirectory
                            ? 'hover:bg-primary/15 text-primary'
                            : 'hover:bg-muted/50 text-muted-foreground'
                        }`}
                      >
                        <FolderOpenIcon className="h-4 w-4" />
                      </button>
                    </Tooltip>
                    {currentWorkingDirectory && (
                      <div
                        className={`overflow-hidden transition-[max-width,opacity] duration-200 ease-out ${
                          cwdExpanded ? 'max-w-[2.5rem] opacity-100' : 'max-w-0 opacity-0'
                        }`}
                      >
                        <Tooltip content="Directory settings" side="top" sideOffset={8}>
                          <button
                            type="button"
                            onClick={() => setCwdPopoverOpen((o) => !o)}
                            className="flex h-10 w-10 shrink-0 items-center justify-center transition-colors hover:bg-primary/15 text-primary"
                          >
                            <ChevronUpIcon
                              className={`h-3.5 w-3.5 transition-transform ${cwdPopoverOpen ? '' : 'rotate-180'}`}
                            />
                          </button>
                        </Tooltip>
                      </div>
                    )}
                  </div>
                  {/* CWD popover */}
                  {cwdPopoverOpen && currentWorkingDirectory && (
                    <div
                      ref={cwdPopover.ref}
                      style={cwdPopover.style}
                      className="absolute bottom-full left-0 z-50 mb-2 w-[280px] max-w-[calc(100vw-2rem)] rounded-2xl border border-border/70 bg-popover/95 p-1.5 shadow-[0_16px_40px_rgba(5,4,15,0.28)] backdrop-blur-xl"
                    >
                      <div className="flex items-center gap-2 px-3 pt-2 pb-1">
                        <FolderOpenIcon className="h-3.5 w-3.5 text-muted-foreground" />
                        <span className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">
                          Working Directory
                        </span>
                      </div>
                      <div className="px-3 py-2">
                        <p className="text-xs font-medium text-foreground truncate" title={cwdName ?? undefined}>
                          {cwdName}
                        </p>
                        <p
                          className="mt-0.5 text-[10px] text-muted-foreground truncate"
                          title={currentWorkingDirectory}
                        >
                          {currentWorkingDirectory}
                        </p>
                      </div>
                      <div className="border-t border-border/50 mx-1.5 mt-0.5" />
                      <button
                        type="button"
                        onClick={() => {
                          void setCurrentWorkingDirectory(null);
                          setCwdPopoverOpen(false);
                        }}
                        className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-xs text-destructive transition-colors hover:bg-destructive/10"
                      >
                        <XIcon className="h-3.5 w-3.5" />
                        <span>Clear directory</span>
                      </button>
                    </div>
                  )}
                </div>
              </div>
              {/* Right side: recording, send */}
              <div className="flex items-center gap-1.5 md:gap-2">
                {recordingEnabled && <RecordingButton onStart={taskStartRecording} />}
                <Tooltip content="Send message" side="top" sideOffset={8}>
                  <button
                    type="button"
                    onClick={handleSubmit}
                    disabled={!canSend}
                    className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-40"
                  >
                    <SendHorizonalIcon className="h-4 w-4" />
                  </button>
                </Tooltip>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
