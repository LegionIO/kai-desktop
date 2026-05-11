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
  BotIcon,
  FileCodeIcon,
  TerminalIcon,
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
import type { TaskFile, KaiTaskStatus } from '@/types/task';
import {
  KAI_TASK_STATUS_COLUMNS,
  KAI_TASK_STATUS_LABELS,
  KAI_TASK_STATUS_COLORS,
} from '@/types/task';

interface TaskDetailPanelProps {
  task: TaskFile;
  onClose?: () => void;
}

export const TaskDetailPanel: FC<TaskDetailPanelProps> = ({ task, onClose }) => {
  const { state, updateTaskStatus, updateTask, refineTaskPlan } = useTasks();
  const { state: agentState, assignTask, unassignTask } = useAgents();
  const { attachments, addAttachments, removeAttachment } = useAttachments();
  const { currentWorkingDirectory, setCurrentWorkingDirectory } = useCurrentWorkingDirectory();
  const { config } = useConfig();
  const fullWidth = useFullWidthContent();

  const { creatingTaskId, streamingText, isStreamingPlan } = state;
  const isActivelyStreaming = creatingTaskId === task.id && isStreamingPlan;

  const [terminalSessionId, setTerminalSessionId] = useState<string | null>(
    task.terminalSessionId ?? null,
  );
  const [isStartingAgent, setIsStartingAgent] = useState(false);
  const [selectedRuntime, setSelectedRuntime] = useState<string>('claude-code');

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
    ? ((config as Record<string, unknown>).audio as { recording?: { enabled?: boolean } })?.recording?.enabled ?? true
    : true;

  // CWD popover / split-button
  const [cwdPopoverOpen, setCwdPopoverOpen] = useState(false);
  const cwdRootRef = useRef<HTMLDivElement>(null);
  const cwdPopover = usePopoverAlign();
  const { expanded: cwdExpanded, containerProps: cwdContainerProps } = useSplitButtonHover({ popoverOpen: cwdPopoverOpen });

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
  const isWebBridge = Boolean((window as unknown as Record<string, unknown>).app && (window.app as Record<string, unknown>).__isWebBridge);
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
      const result = await app.dialog.openFile({ filters }) as { canceled: boolean; files?: Array<{ name: string; mime: string; isImage: boolean; size: number; dataUrl: string; text?: string }> };
      if (!result.canceled && result.files) addAttachments(result.files);
    } catch (err) { console.error('Attach failed:', err); }
  };

  const handleWebFileInputChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (!files || files.length === 0) return;
    const readers: Promise<{ name: string; mime: string; isImage: boolean; size: number; dataUrl: string; text?: string }>[] = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      readers.push(new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = () => {
          const dataUrl = reader.result as string;
          const isImage = file.type.startsWith('image/');
          resolve({ name: file.name, mime: file.type, isImage, size: file.size, dataUrl });
        };
        reader.readAsDataURL(file);
      }));
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
      }
    } catch (err) {
      console.error('Attach directory failed:', err);
    }
    refocusComposer();
    setTimeout(() => textareaRef.current?.focus(), 60);
  };

  const menuItemClassName = 'flex cursor-default items-center gap-2 rounded-lg px-3 py-2 text-sm text-foreground outline-none transition-colors data-[highlighted]:bg-muted/70';

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

  const handleStatusChange = useCallback(
    (status: KaiTaskStatus) => {
      void updateTaskStatus(task.id, status);
    },
    [task.id, updateTaskStatus],
  );

  const handleStartAgent = useCallback(async () => {
    setIsStartingAgent(true);
    try {
      const result = await app.tasks.terminalCreate(task.id, {
        runtime: selectedRuntime,
        cwd: task.metadata?.cwd,
      });
      if (result.sessionId) {
        setTerminalSessionId(result.sessionId);
        // Update task with session and move to in_progress
        void updateTask(task.id, {
          terminalSessionId: result.sessionId,
          agentRuntime: selectedRuntime,
          status: 'in_progress',
        });
      }
    } finally {
      setIsStartingAgent(false);
    }
  }, [task.id, task.metadata?.cwd, selectedRuntime, updateTask]);

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
  const displayText = (creatingTaskId === task.id && streamingText) ? streamingText : task.description;

  // Runtime display name helper
  const runtimeDisplayName = (rt: string) =>
    rt === 'claude-code' ? 'Claude Code' : rt === 'codex' ? 'Codex' : rt === 'mastra' ? 'Mastra' : rt;

  const runtimeColors: Record<string, string> = {
    'claude-code': 'bg-amber-500/10 text-amber-600',
    'codex': 'bg-emerald-500/10 text-emerald-600',
    'mastra': 'bg-violet-500/10 text-violet-500',
  };

  const runtimeDotColors: Record<string, string> = {
    'claude-code': 'bg-amber-500',
    'codex': 'bg-emerald-500',
    'mastra': 'bg-violet-500',
  };

  const statusDotColors: Record<KaiTaskStatus, string> = {
    todo: 'bg-sky-500',
    in_progress: 'bg-rose-500',
    ai_review: 'bg-amber-500',
    human_review: 'bg-purple-400',
    done: 'bg-emerald-500',
  };

  return (
    <div className="relative flex h-full w-full flex-col bg-background pt-12 md:pt-14">
      {/* ─── Header: Metadata (always visible) ─── */}
      <div className={cn('relative z-10 shrink-0 mx-auto w-full px-5 pt-4 pb-0 md:px-8', !fullWidth && 'max-w-3xl')}>
        {/* Row 1: Status | Updated */}
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
          <div className="flex items-center gap-2">
            <span className="w-11 shrink-0 text-muted-foreground">Status</span>
            <DropdownMenu.Root>
              <DropdownMenu.Trigger asChild>
                <button
                  type="button"
                  className={cn(
                    'inline-flex w-32 items-center justify-between gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium transition-colors hover:opacity-80',
                    KAI_TASK_STATUS_COLORS[task.status],
                  )}
                >
                  {KAI_TASK_STATUS_LABELS[task.status]}
                  <svg className="h-3 w-3" viewBox="0 0 12 12" fill="none">
                    <path d="M3 5l3 3 3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content
                  align="start"
                  sideOffset={4}
                  className="z-[9999] min-w-[160px] rounded-xl border border-border/70 bg-popover/95 p-1 text-popover-foreground shadow-xl backdrop-blur-md"
                >
                  {KAI_TASK_STATUS_COLUMNS.map((status) => (
                    <DropdownMenu.Item
                      key={status}
                      disabled={status === task.status}
                      className="flex cursor-default items-center gap-2 rounded-lg px-3 py-1.5 text-xs outline-none transition-colors data-[highlighted]:bg-muted/70 data-[disabled]:opacity-50"
                      onSelect={() => handleStatusChange(status)}
                    >
                      <span className={cn('h-2 w-2 rounded-full', statusDotColors[status])} />
                      {KAI_TASK_STATUS_LABELS[status]}
                    </DropdownMenu.Item>
                  ))}
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          </div>

          <div className="flex items-center gap-2">
            <span className="text-muted-foreground">Updated</span>
            <Tooltip
              content={
                <div className="flex flex-col gap-1 py-0.5">
                  <div className="flex items-center gap-2">
                    <span className="opacity-60">Created</span>
                    <span>{new Date(task.createdAt).toLocaleString()}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="opacity-60">Updated</span>
                    <span>{new Date(task.updatedAt).toLocaleString()}</span>
                  </div>
                </div>
              }
              side="bottom"
              sideOffset={4}
            >
              <span className="cursor-default rounded-full bg-foreground/10 px-2.5 py-0.5 text-xs font-medium text-foreground transition-colors hover:bg-foreground/15">
                {new Date(task.updatedAt).toLocaleString()}
              </span>
            </Tooltip>
          </div>
        </div>

        {/* Row 2: Agent runtime + Start/Stop + Assign */}
        <div className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
          <div className="flex items-center gap-2">
            <span className="w-11 shrink-0 text-muted-foreground">Agent</span>
            <DropdownMenu.Root>
              <DropdownMenu.Trigger asChild>
                <button
                  type="button"
                  className={cn(
                    'inline-flex items-center justify-between gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium transition-colors hover:opacity-80',
                    runtimeColors[selectedRuntime] ?? 'bg-muted/60 text-foreground',
                  )}
                >
                  {runtimeDisplayName(selectedRuntime)}
                  <svg className="h-3 w-3" viewBox="0 0 12 12" fill="none">
                    <path d="M3 5l3 3 3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content
                  align="start"
                  sideOffset={4}
                  className="z-[9999] min-w-[140px] rounded-xl border border-border/70 bg-popover/95 p-1 text-popover-foreground shadow-xl backdrop-blur-md"
                >
                  {['claude-code', 'codex', 'mastra'].map((rt) => (
                    <DropdownMenu.Item
                      key={rt}
                      disabled={rt === selectedRuntime}
                      className="flex cursor-default items-center gap-2 rounded-lg px-3 py-1.5 text-xs outline-none transition-colors data-[highlighted]:bg-muted/70 data-[disabled]:opacity-50"
                      onSelect={() => setSelectedRuntime(rt)}
                    >
                      <span className={cn('h-2 w-2 rounded-full', runtimeDotColors[rt] ?? 'bg-muted-foreground')} />
                      {runtimeDisplayName(rt)}
                    </DropdownMenu.Item>
                  ))}
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
            {terminalSessionId ? (
              <button
                type="button"
                onClick={handleStopAgent}
                className="inline-flex items-center gap-1.5 rounded-full bg-destructive/10 px-2.5 py-0.5 text-xs font-medium text-destructive transition-colors hover:bg-destructive/20"
              >
                <StopCircleIcon className="h-3.5 w-3.5" />
                Stop Agent
              </button>
            ) : (
              <button
                type="button"
                onClick={handleStartAgent}
                disabled={isStartingAgent || isActivelyStreaming}
                className="inline-flex items-center gap-1.5 rounded-full bg-primary/10 px-2.5 py-0.5 text-xs font-medium text-primary transition-colors hover:bg-primary/20 disabled:opacity-50"
              >
                <PlayIcon className="h-3.5 w-3.5" />
                {isStartingAgent ? 'Starting…' : 'Start Agent'}
              </button>
            )}
          </div>

          <div className="flex items-center gap-2">
            <span className="text-muted-foreground">Assign</span>
            <DropdownMenu.Root>
              <DropdownMenu.Trigger asChild>
                <button
                  type="button"
                  className="inline-flex items-center gap-1.5 rounded-full bg-muted/40 px-2.5 py-0.5 text-xs font-medium text-foreground/80 transition-colors hover:bg-muted/60"
                >
                  <BotIcon className="h-3 w-3" />
                  {task.assignedAgentId
                    ? (agentState.agents.find((a) => a.id === task.assignedAgentId)?.name ?? 'Unknown')
                    : 'No agent'}
                  <svg className="h-3 w-3" viewBox="0 0 12 12" fill="none">
                    <path d="M3 5l3 3 3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content
                  align="start"
                  sideOffset={4}
                  className="z-[9999] min-w-[160px] rounded-xl border border-border/70 bg-popover/95 p-1 text-popover-foreground shadow-xl backdrop-blur-md"
                >
                  {task.assignedAgentId && (
                    <DropdownMenu.Item
                      className="flex cursor-default items-center gap-2 rounded-lg px-3 py-1.5 text-xs outline-none transition-colors data-[highlighted]:bg-muted/70"
                      onSelect={() => {
                        const agent = agentState.agents.find((a) => a.id === task.assignedAgentId);
                        if (agent) void unassignTask(agent.id);
                      }}
                    >
                      <XIcon className="h-3 w-3 text-muted-foreground" />
                      Unassign
                    </DropdownMenu.Item>
                  )}
                  {task.assignedAgentId && agentState.agents.length > 0 && (
                    <DropdownMenu.Separator className="my-1 h-px bg-border/50" />
                  )}
                  {agentState.agents.length === 0 ? (
                    <div className="px-3 py-2 text-xs text-muted-foreground">
                      No agents available. Hire one first.
                    </div>
                  ) : (
                    agentState.agents
                      .filter((a) => a.status !== 'running')
                      .map((agent) => (
                        <DropdownMenu.Item
                          key={agent.id}
                          disabled={agent.id === task.assignedAgentId}
                          className="flex cursor-default items-center gap-2 rounded-lg px-3 py-1.5 text-xs outline-none transition-colors data-[highlighted]:bg-muted/70 data-[disabled]:opacity-50"
                          onSelect={() => void assignTask(agent.id, task.id)}
                        >
                          <span className="text-sm">{agent.icon ?? '\u{1F916}'}</span>
                          {agent.name}
                        </DropdownMenu.Item>
                      ))
                  )}
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
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
            {terminalSessionId && (
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
            )}
          </button>
        </div>
      </div>

      {/* ─── Tab content ─── */}
      {activeTab === 'plan' ? (
        /* ═══ PLAN TAB ═══ */
        <div className="relative min-h-0 flex-1 overflow-y-auto">
          <div ref={scrollRef} className="flex min-h-full flex-col">
            <div className="flex-1">
              <div className={cn('relative z-10 mx-auto px-5 pb-5 pt-5 md:px-8', !fullWidth && 'max-w-3xl')}>
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
              </div>
            </div>
            {/* Sticky plan composer */}
            <div className="sticky bottom-0 z-20">
              <div className="pointer-events-none absolute bottom-0 left-0 right-0 z-[15] h-56 bg-gradient-to-t from-background from-25% via-background/70 via-55% to-transparent md:h-64" />
              <div className={cn('relative z-20 mx-auto w-full px-4 pb-4 pt-4 md:pb-5 md:pt-5', !fullWidth && 'max-w-3xl')}>
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
                      <div key={`${file.name}-${i}`} className="group/att flex items-center gap-1.5 rounded-2xl border border-border/50 bg-muted/40 px-2.5 py-2 text-xs">
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
                    placeholder={isActivelyStreaming ? 'Waiting for plan to finish...' : 'Refine the plan...'}
                    rows={1}
                    className={cn('min-h-[48px] max-h-[220px] w-full resize-none overflow-y-auto bg-transparent px-1 py-0.5 text-base text-foreground placeholder:text-muted-foreground/60 focus:outline-none md:text-[15px]', input.includes('\n') && 'pb-3')}
                  />
                  <div className="flex flex-col gap-1.5 md:flex-row md:items-center md:justify-between md:gap-3">
                    {/* Left side: add files + working directory */}
                    <div className="flex min-w-0 flex-1 items-center gap-1.5 md:gap-2">
                      <DropdownMenu.Root>
                        <Tooltip content="Add files" side="top" sideOffset={8}>
                          <DropdownMenu.Trigger asChild>
                            <button type="button" className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-border/50 bg-muted/40 transition-colors hover:bg-muted/60 text-muted-foreground">
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
                            <DropdownMenu.Item className={menuItemClassName} onSelect={() => { void handleAttachFiles([{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'] }]); }}>
                              <ImageIcon className="h-4 w-4 text-muted-foreground" />
                              <span>Image</span>
                            </DropdownMenu.Item>
                            <DropdownMenu.Item className={menuItemClassName} onSelect={() => { void handleAttachFiles([{ name: 'PDF', extensions: ['pdf'] }]); }}>
                              <FileIcon className="h-4 w-4 text-muted-foreground" />
                              <span>PDF</span>
                            </DropdownMenu.Item>
                            <DropdownMenu.Item className={menuItemClassName} onSelect={() => { void handleAttachFiles([{ name: 'Documents', extensions: ['txt', 'md', 'json', 'csv', 'html', 'htm', 'js', 'jsx', 'ts', 'tsx', 'css', 'scss', 'py', 'rb', 'go', 'rs', 'java', 'c', 'cpp', 'h', 'hpp', 'sh', 'yaml', 'yml', 'toml', 'xml'] }]); }}>
                              <FileTextIcon className="h-4 w-4 text-muted-foreground" />
                              <span>Text / Document</span>
                            </DropdownMenu.Item>
                            <DropdownMenu.Separator className="my-1 h-px bg-border/60" />
                            <DropdownMenu.Item className={menuItemClassName} onSelect={() => { void handleAttachFiles(); }}>
                              <FileIcon className="h-4 w-4 text-muted-foreground" />
                              <span>Any File</span>
                            </DropdownMenu.Item>
                          </DropdownMenu.Content>
                        </DropdownMenu.Portal>
                      </DropdownMenu.Root>
                      {/* Working directory split button */}
                      <div ref={cwdRootRef} {...cwdContainerProps} className="relative flex items-center">
                        <div className={`flex items-center overflow-hidden rounded-lg border transition-colors ${
                          currentWorkingDirectory
                            ? 'border-primary/50 bg-primary/10'
                            : 'border-border/50 bg-muted/40'
                        }`}>
                          <Tooltip content={currentWorkingDirectory ? cwdName ?? 'Working directory' : 'Working directory'} side="top" sideOffset={8}>
                            <button
                              type="button"
                              onClick={() => { void handleAttachDirectory(); }}
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
                            <div className={`overflow-hidden transition-[max-width,opacity] duration-200 ease-out ${
                              cwdExpanded ? 'max-w-[2.5rem] opacity-100' : 'max-w-0 opacity-0'
                            }`}>
                              <Tooltip content="Directory settings" side="top" sideOffset={8}>
                                <button
                                  type="button"
                                  onClick={() => setCwdPopoverOpen((o) => !o)}
                                  className="flex h-10 w-10 shrink-0 items-center justify-center transition-colors hover:bg-primary/15 text-primary"
                                >
                                  <ChevronUpIcon className={`h-3.5 w-3.5 transition-transform ${cwdPopoverOpen ? '' : 'rotate-180'}`} />
                                </button>
                              </Tooltip>
                            </div>
                          )}
                        </div>
                        {/* CWD popover */}
                        {cwdPopoverOpen && currentWorkingDirectory && (
                          <div ref={cwdPopover.ref} style={cwdPopover.style} className="absolute bottom-full left-0 z-50 mb-2 w-[280px] max-w-[calc(100vw-2rem)] rounded-2xl border border-border/70 bg-popover/95 p-1.5 shadow-[0_16px_40px_rgba(5,4,15,0.28)] backdrop-blur-xl">
                            <div className="flex items-center gap-2 px-3 pt-2 pb-1">
                              <FolderOpenIcon className="h-3.5 w-3.5 text-muted-foreground" />
                              <span className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">Working Directory</span>
                            </div>
                            <div className="px-3 py-2">
                              <p className="text-xs font-medium text-foreground truncate" title={cwdName ?? undefined}>{cwdName}</p>
                              <p className="mt-0.5 text-[10px] text-muted-foreground truncate" title={currentWorkingDirectory}>{currentWorkingDirectory}</p>
                            </div>
                            <div className="border-t border-border/50 mx-1.5 mt-0.5" />
                            <button
                              type="button"
                              onClick={() => { void setCurrentWorkingDirectory(null); setCwdPopoverOpen(false); }}
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
                      {recordingEnabled && (
                        <RecordingButton onStart={startRecording} />
                      )}
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
        </div>
      ) : (
        /* ═══ AGENT TAB ═══ */
        <div className="flex min-h-0 flex-1 flex-col">
          {terminalSessionId ? (
            <>
              {/* Terminal fills available space */}
              <div className="min-h-0 flex-1 px-5 pt-4 md:px-8">
                <TaskTerminal
                  sessionId={terminalSessionId}
                  onExit={handleTerminalExit}
                  className="h-full rounded-xl"
                />
              </div>
              {/* Agent steering composer */}
              <div className="shrink-0 px-5 pb-4 pt-3 md:px-8 md:pb-5">
                <div className="flex flex-col gap-0 rounded-2xl border border-border/70 app-composer-glass px-3 py-3 app-composer-shadow">
                  <textarea
                    ref={agentTextareaRef}
                    value={agentInput}
                    onChange={(e) => setAgentInput(e.target.value)}
                    onKeyDown={handleAgentKeyDown}
                    placeholder="Send instructions to the agent..."
                    rows={1}
                    className={cn('min-h-[48px] max-h-[220px] w-full resize-none overflow-y-auto bg-transparent px-1 py-0.5 text-base text-foreground placeholder:text-muted-foreground/60 focus:outline-none md:text-[15px]', agentInput.includes('\n') && 'pb-3')}
                  />
                  <div className="flex items-center justify-end">
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
                  </div>
                </div>
              </div>
            </>
          ) : (
            /* No terminal running — empty state */
            <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
              <TerminalIcon className="h-10 w-10 text-muted-foreground/30" />
              <p className="text-sm text-muted-foreground">
                Start an agent to see the terminal here.
              </p>
              <button
                type="button"
                onClick={handleStartAgent}
                disabled={isStartingAgent}
                className="inline-flex items-center gap-1.5 rounded-full bg-primary/10 px-3 py-1 text-xs font-medium text-primary transition-colors hover:bg-primary/20 disabled:opacity-50"
              >
                <PlayIcon className="h-3.5 w-3.5" />
                {isStartingAgent ? 'Starting…' : 'Start Agent'}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
