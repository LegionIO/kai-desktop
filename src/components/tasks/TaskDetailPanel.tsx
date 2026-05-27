/**
 * TaskDetailPanel — unified task view with full details + composer.
 *
 * Renders status bar, agent controls, plan content, footer metadata,
 * and a composer at the bottom for plan refinements.
 * Used both when selecting a task from sidebar AND after AI creation.
 */

import { type FC, useCallback, useEffect, useState, useRef } from 'react';
import {
  PlayIcon,
  StopCircleIcon,
  SendHorizonalIcon,
  PlusIcon,
  FolderOpenIcon,
  FileIcon,
  FileTextIcon,
  ImageIcon,
  XIcon,
  ChevronUpIcon,
  FileCodeIcon,
  TerminalIcon,
  CheckCircle2Icon,
} from 'lucide-react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { cn } from '@/lib/utils';
import { refocusComposer } from '@/lib/utils';
import { useTasks } from '@/providers/TaskProvider';
import { useAgents } from '@/providers/AgentProvider';
import { useAttachments } from '@/providers/AttachmentContext';
import { useCurrentWorkingDirectory } from '@/providers/RuntimeProvider';
import { useConfig } from '@/providers/ConfigProvider';
import { app } from '@/lib/ipc-client';
import { MarkdownText } from '@/components/thread/MarkdownText';
import { RecordingButton } from '@/components/thread/RecordingButton';
import { useVoiceRecording } from '@/hooks/useVoiceRecording';
import { Tooltip } from '@/components/ui/Tooltip';
import { usePopoverAlign } from '@/hooks/usePopoverAlign';
import { useSplitButtonHover } from '@/hooks/useSplitButtonHover';
import { useFullWidthContent } from '@/hooks/useFullWidthContent';
import { TaskTerminal } from './TaskTerminal';
import { AgentAssignDropdown } from './AgentAssignDropdown';
import { TaskStatusDropdown } from './TaskStatusDropdown';
import type { TaskFile } from '@/types/task';

interface TaskDetailPanelProps {
  task: TaskFile;
  onClose?: () => void;
}

export const TaskDetailPanel: FC<TaskDetailPanelProps> = ({ task, onClose }) => {
  const { state, updateTask, updateTaskStatus, refineTaskPlan } = useTasks();
  const { state: agentState, startAgent } = useAgents();
  const { attachments, addAttachments, removeAttachment } = useAttachments();
  const { currentWorkingDirectory, setCurrentWorkingDirectory } = useCurrentWorkingDirectory();
  const { config } = useConfig();
  const fullWidth = useFullWidthContent();

  const { creatingTaskId, streamingText, isStreamingPlan } = state;
  const isActivelyStreaming = creatingTaskId === task.id && isStreamingPlan;

  const [terminalSessionId, setTerminalSessionId] = useState<string | null>(task.terminalSessionId ?? null);
  const [isStartingAgent, setIsStartingAgent] = useState(false);

  // ── Tab state ─────────────────────────────────────────────────────────
  const [activeTab, setActiveTab] = useState<'plan' | 'agent'>('plan');

  // ── Composer state (plan tab) ─────────────────────────────────────────
  const [input, setInput] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // ── Agent composer state ──────────────────────────────────────────────
  const [agentInput, setAgentInput] = useState('');
  const agentTextareaRef = useRef<HTMLTextAreaElement>(null);

  // Voice recording
  const { startRecording } = useVoiceRecording();
  const recordingEnabled = (config as Record<string, unknown> | null)?.audio
    ? (((config as Record<string, unknown>).audio as { recording?: { enabled?: boolean } })?.recording?.enabled ?? true)
    : true;

  // CWD popover / split-button
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
  const canSend = input.trim().length > 0 || attachments.length > 0;

  // File attach handlers
  const isWebBridge = Boolean(
    (window as unknown as Record<string, unknown>).app && (window.app as Record<string, unknown>).__isWebBridge,
  );
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [pendingFileAccept, setPendingFileAccept] = useState<string>('*/*');

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
      };
      if (!result.canceled && result.files) addAttachments(result.files);
    } catch (err) {
      console.error('Attach failed:', err);
    }
  };

  const handleWebFileInputChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (!files || files.length === 0) return;
    const readers: Promise<{
      name: string;
      mime: string;
      isImage: boolean;
      size: number;
      dataUrl: string;
      text?: string;
    }>[] = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      readers.push(
        new Promise((resolve) => {
          const reader = new FileReader();
          reader.onload = () => {
            const dataUrl = reader.result as string;
            const isImage = file.type.startsWith('image/');
            resolve({ name: file.name, mime: file.type, isImage, size: file.size, dataUrl });
          };
          reader.readAsDataURL(file);
        }),
      );
    }
    void Promise.all(readers).then((results) => addAttachments(results));
    event.target.value = '';
  };

  const handleAttachDirectory = async () => {
    if (isWebBridge) return;
    try {
      const result = await app.dialog.openDirectory();
      if (!result.canceled && result.directoryPath) {
        await setCurrentWorkingDirectory(result.directoryPath);
        // Persist to task metadata so the terminal spawns in this directory
        void updateTask(task.id, {
          metadata: { ...task.metadata, cwd: result.directoryPath },
        });
      }
    } catch (err) {
      console.error('Attach directory failed:', err);
    }
    refocusComposer();
    setTimeout(() => textareaRef.current?.focus(), 60);
  };

  const menuItemClassName =
    'flex cursor-default items-center gap-2 rounded-lg px-3 py-2 text-sm text-foreground outline-none transition-colors data-[highlighted]:bg-muted/70';

  // Sync terminal session when task changes
  useEffect(() => {
    setTerminalSessionId(task.terminalSessionId ?? null);
  }, [task.id, task.terminalSessionId]);

  // Auto-switch to agent tab when terminal starts
  useEffect(() => {
    if (terminalSessionId) {
      setActiveTab('agent');
    }
  }, [terminalSessionId]);

  // Close on Escape (if onClose provided)
  useEffect(() => {
    if (!onClose) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  // Auto-scroll when streaming
  useEffect(() => {
    if (scrollRef.current && isActivelyStreaming) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [streamingText, isActivelyStreaming]);

  // Auto-resize textarea
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 180) + 'px';
  }, [input]);

  // Auto-resize agent textarea
  useEffect(() => {
    const el = agentTextareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 180) + 'px';
  }, [agentInput]);

  // Focus composer on mount and when task changes
  useEffect(() => {
    textareaRef.current?.focus();
  }, [task.id]);

  // Ref-based pending focus (survives re-renders from streaming state changes)
  const pendingFocusRef = useRef(false);
  useEffect(() => {
    if (pendingFocusRef.current) {
      pendingFocusRef.current = false;
      textareaRef.current?.focus();
    }
  });

  // ── Handlers ───────────────────────────────────────────────────────────

  const assignedAgent = task.assignedAgentId
    ? (agentState.agents.find((a) => a.id === task.assignedAgentId) ?? null)
    : null;

  const handleStartAgent = useCallback(async () => {
    if (!assignedAgent) return;
    setIsStartingAgent(true);
    try {
      const result = await startAgent(assignedAgent.id);
      if (result?.sessionId) setTerminalSessionId(result.sessionId);
    } catch (err) {
      console.error('[TaskDetail] start agent failed:', err);
    } finally {
      setIsStartingAgent(false);
    }
  }, [assignedAgent, startAgent]);

  const handleStopAgent = useCallback(() => {
    if (terminalSessionId) {
      void app.tasks.terminalKill(terminalSessionId);
      setTerminalSessionId(null);
      void updateTask(task.id, { terminalSessionId: undefined });
    }
  }, [terminalSessionId, task.id, updateTask]);

  const handleTerminalExit = useCallback(
    (_exitCode: number) => {
      setTerminalSessionId(null);
      void updateTask(task.id, { terminalSessionId: undefined });
    },
    [task.id, updateTask],
  );

  const handleComposerSubmit = useCallback(() => {
    const text = input.trim();
    if (!text || isActivelyStreaming) return;

    setInput('');
    void refineTaskPlan(task.id, text);

    // Request focus on next render (survives streaming state updates)
    pendingFocusRef.current = true;
  }, [input, task.id, refineTaskPlan, isActivelyStreaming]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleComposerSubmit();
      }
    },
    [handleComposerSubmit],
  );

  // ── Agent composer handlers ───────────────────────────────────────────
  const handleAgentSubmit = useCallback(() => {
    const text = agentInput.trim();
    if (!text || !terminalSessionId) return;
    setAgentInput('');
    void app.tasks.terminalWrite(terminalSessionId, text + '\n');
    agentTextareaRef.current?.focus();
  }, [agentInput, terminalSessionId]);

  const handleAgentKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleAgentSubmit();
      }
    },
    [handleAgentSubmit],
  );

  // Display text: streaming text if actively streaming for this task, else persisted description
  const displayText = creatingTaskId === task.id && streamingText ? streamingText : task.description;

  const fmtDate = (iso: string) =>
    new Date(iso).toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });

  const leftRows: Array<{ label: string; value: React.ReactNode }> = [
    {
      label: 'Status',
      value: <TaskStatusDropdown task={task} onStatusChange={(s) => void updateTaskStatus(task.id, s)} />,
    },
    {
      label: 'Agent',
      value: <AgentAssignDropdown taskId={task.id} currentAgentId={task.assignedAgentId} variant="inline" />,
    },
  ];

  const rightRows: Array<{ label: string; value: string | null }> = [
    { label: 'Created', value: fmtDate(task.createdAt) },
    { label: 'Updated', value: fmtDate(task.updatedAt) },
    { label: 'Started', value: task.startedAt ? fmtDate(task.startedAt) : null },
    { label: 'Completed', value: task.completedAt ? fmtDate(task.completedAt) : null },
  ];

  return (
    <div className="relative flex h-full w-full flex-col bg-background">
      {/* ─── Header ─── */}
      <div className={cn('relative z-10 shrink-0 mx-auto w-full px-5 pt-3 pb-0', !fullWidth && 'max-w-3xl')}>
        {/* Metadata: two columns */}
        <div className="flex gap-8">
          {/* Left col: Status + Agent */}
          <div className="flex flex-col gap-0.5">
            {leftRows.map(({ label, value }) => (
              <div key={label} className="flex h-[18px] items-center gap-2">
                <span className="w-12 shrink-0 text-xs text-muted-foreground/70">{label}</span>
                {value}
              </div>
            ))}
          </div>
          {/* Right col: timestamps */}
          <div className="flex flex-col gap-0.5">
            {rightRows.map(({ label, value }) => (
              <div key={label} className="flex h-[18px] items-center gap-2">
                <span className="w-18 shrink-0 text-xs text-muted-foreground/70">{label}</span>
                {value ? (
                  <span className="text-xs text-foreground/80">{value}</span>
                ) : (
                  <span className="text-xs text-muted-foreground/30">—</span>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* ─── Tab bar ─── */}
        <div className="mt-4 flex items-center gap-1 border-b border-border/40">
          <button
            type="button"
            onClick={() => setActiveTab('plan')}
            className={cn(
              'flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium transition-colors',
              activeTab === 'plan'
                ? 'border-primary text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground/80',
            )}
          >
            <FileCodeIcon className="h-3.5 w-3.5" />
            Plan
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('agent')}
            className={cn(
              'flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium transition-colors',
              activeTab === 'agent'
                ? 'border-primary text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground/80',
            )}
          >
            <TerminalIcon className="h-3.5 w-3.5" />
            Agent
            {terminalSessionId && <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />}
          </button>
        </div>
      </div>

      {/* ─── Tab content ─── */}
      {activeTab === 'plan' ? (
        /* ═══ PLAN TAB ═══ */
        <div className="relative min-h-0 flex-1">
          {/* Fade at top */}
          <div className="pointer-events-none absolute inset-x-0 top-0 z-20 h-12 bg-gradient-to-b from-background to-transparent" />
          <div className="h-full overflow-y-auto">
            <div ref={scrollRef} className="flex min-h-full flex-col">
              <div className="flex-1">
                <div className={cn('mx-auto px-8 pb-5 pt-4', !fullWidth && 'max-w-3xl')}>
                  {displayText ? (
                    <MarkdownText text={displayText} />
                  ) : isActivelyStreaming ? (
                    <div className="flex items-center gap-2 text-muted-foreground">
                      <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
                      <span className="text-sm">Generating plan...</span>
                    </div>
                  ) : (
                    <p className="text-sm italic text-muted-foreground">No description</p>
                  )}

                  {/* Completion summary — shown when autopilot or agent has reported a wrap-up */}
                  {(() => {
                    const summary = (task as unknown as { completionSummary?: string }).completionSummary;
                    const showSummary =
                      !!summary && (task.status === 'human_review' || task.status === 'done');
                    if (!showSummary) return null;
                    return (
                      <div className="mt-6 rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-4">
                        <div className="mb-2 flex items-center gap-2">
                          <CheckCircle2Icon className="h-4 w-4 text-emerald-500" />
                          <span className="text-xs font-semibold uppercase tracking-wide text-emerald-600 dark:text-emerald-400">
                            {task.status === 'human_review' ? 'Ready for review' : 'Completion summary'}
                          </span>
                        </div>
                        <div className="text-sm text-foreground/90">
                          <MarkdownText text={summary} />
                        </div>
                      </div>
                    );
                  })()}
                </div>
              </div>
              {/* Sticky plan composer */}
              <div className="sticky bottom-0 z-20">
                <div className="pointer-events-none absolute bottom-0 left-0 right-0 z-[15] h-56 bg-gradient-to-t from-background from-25% via-background/70 via-55% to-transparent md:h-64" />
                <div
                  className={cn(
                    'relative z-20 mx-auto w-full px-5 pb-4 pt-4 md:pb-5 md:pt-5',
                    !fullWidth && 'max-w-3xl',
                  )}
                >
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
                            <span className="text-[10px] text-muted-foreground">
                              {(file.size / 1024).toFixed(1)} KB
                            </span>
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
                      placeholder={isActivelyStreaming ? 'Waiting for plan to finish...' : 'Refine the plan...'}
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
                              currentWorkingDirectory
                                ? 'border-primary/50 bg-primary/10'
                                : 'border-border/50 bg-muted/40'
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
                                <p
                                  className="text-xs font-medium text-foreground truncate"
                                  title={cwdName ?? undefined}
                                >
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
                        {recordingEnabled && <RecordingButton onStart={startRecording} />}
                        <Tooltip content="Send message" side="top" sideOffset={8}>
                          <button
                            type="button"
                            onClick={handleComposerSubmit}
                            disabled={!canSend || isActivelyStreaming}
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
            {/* end scrollRef */}
          </div>
          {/* end overflow-y-auto */}
        </div>
      ) : (
        /* ═══ AGENT TAB ═══ */
        <div className="flex min-h-0 flex-1 flex-col">
          <div
            className={cn(
              'flex min-h-0 flex-1 flex-col gap-3 mx-auto w-full px-5 pt-4 pb-4 md:pb-5',
              !fullWidth && 'max-w-3xl',
            )}
          >
            {/* Terminal — always rendered; overlay when no session */}
            <div className="relative min-h-0 flex-1">
              {terminalSessionId ? (
                <TaskTerminal sessionId={terminalSessionId} onExit={handleTerminalExit} className="h-full rounded-xl" />
              ) : (
                <div className="flex h-full flex-col overflow-hidden rounded-xl border border-border/50 bg-[#1a1a2e]">
                  <div className="flex flex-1 items-center justify-center">
                    <div className="flex flex-col items-center gap-3 text-center">
                      <TerminalIcon className="h-8 w-8 text-white/20" />
                      <p className="text-sm text-white/40">No agent running</p>
                      <button
                        type="button"
                        onClick={handleStartAgent}
                        disabled={isStartingAgent}
                        className="inline-flex items-center gap-1.5 rounded-full bg-white/10 px-3 py-1.5 text-xs font-medium text-white/70 transition-colors hover:bg-white/20 disabled:opacity-50"
                      >
                        <PlayIcon className="h-3.5 w-3.5" />
                        {isStartingAgent ? 'Starting…' : assignedAgent ? `Start ${assignedAgent.name}` : 'Assign Agent'}
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Steering composer — always visible */}
            <div className="shrink-0">
              <div className="flex flex-col gap-0 rounded-2xl border border-border/70 app-composer-glass px-3 py-3 app-composer-shadow">
                <textarea
                  ref={agentTextareaRef}
                  value={agentInput}
                  onChange={(e) => setAgentInput(e.target.value)}
                  onKeyDown={handleAgentKeyDown}
                  placeholder="Send instructions to the agent…"
                  disabled={!terminalSessionId}
                  rows={1}
                  className={cn(
                    'min-h-[48px] max-h-[220px] w-full resize-none overflow-y-auto bg-transparent px-1 py-0.5 text-base text-foreground placeholder:text-muted-foreground/60 focus:outline-none disabled:opacity-40 md:text-[15px]',
                    agentInput.includes('\n') && 'pb-3',
                  )}
                />
                <div className="flex flex-col gap-1.5 md:flex-row md:items-center md:justify-between md:gap-3">
                  {/* Left: add files + working directory */}
                  <div className="flex min-w-0 flex-1 items-center gap-1.5 md:gap-2">
                    <DropdownMenu.Root>
                      <Tooltip content="Add files" side="top" sideOffset={8}>
                        <DropdownMenu.Trigger asChild>
                          <button
                            type="button"
                            disabled={!terminalSessionId}
                            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-border/50 bg-muted/40 transition-colors hover:bg-muted/60 text-muted-foreground disabled:opacity-40 disabled:cursor-not-allowed"
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
                        className={`flex items-center overflow-hidden rounded-lg border transition-colors ${currentWorkingDirectory ? 'border-primary/50 bg-primary/10' : 'border-border/50 bg-muted/40'}`}
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
                            disabled={!terminalSessionId}
                            className={`flex h-10 w-10 shrink-0 items-center justify-center transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${currentWorkingDirectory ? 'hover:bg-primary/15 text-primary' : 'hover:bg-muted/50 text-muted-foreground'}`}
                          >
                            <FolderOpenIcon className="h-4 w-4" />
                          </button>
                        </Tooltip>
                        {currentWorkingDirectory && (
                          <div
                            className={`overflow-hidden transition-[max-width,opacity] duration-200 ease-out ${cwdExpanded && terminalSessionId ? 'max-w-[2.5rem] opacity-100' : 'max-w-0 opacity-0'}`}
                          >
                            <Tooltip content="Directory settings" side="top" sideOffset={8}>
                              <button
                                type="button"
                                onClick={() => setCwdPopoverOpen((o) => !o)}
                                disabled={!terminalSessionId}
                                className="flex h-10 w-10 shrink-0 items-center justify-center transition-colors hover:bg-primary/15 text-primary disabled:opacity-40 disabled:cursor-not-allowed"
                              >
                                <ChevronUpIcon
                                  className={`h-3.5 w-3.5 transition-transform ${cwdPopoverOpen ? '' : 'rotate-180'}`}
                                />
                              </button>
                            </Tooltip>
                          </div>
                        )}
                      </div>
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
                  {/* Right: recording + send/stop */}
                  <div className="flex items-center gap-1.5 md:gap-2">
                    {recordingEnabled && <RecordingButton onStart={startRecording} disabled={!terminalSessionId} />}
                    {terminalSessionId ? (
                      <Tooltip content="Stop agent" side="top" sideOffset={8}>
                        <button
                          type="button"
                          onClick={handleStopAgent}
                          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-destructive/10 text-destructive transition-colors hover:bg-destructive/20"
                        >
                          <StopCircleIcon className="h-4 w-4" />
                        </button>
                      </Tooltip>
                    ) : (
                      <Tooltip content="Send to agent" side="top" sideOffset={8}>
                        <button
                          type="button"
                          onClick={handleAgentSubmit}
                          disabled={!agentInput.trim()}
                          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-40"
                        >
                          <SendHorizonalIcon className="h-4 w-4" />
                        </button>
                      </Tooltip>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
