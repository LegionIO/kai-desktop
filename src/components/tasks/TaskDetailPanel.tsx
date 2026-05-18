/**
 * TaskDetailPanel — unified task view with full details + composer.
 *
 * Renders status bar, agent controls, plan content, footer metadata,
 * and a composer at the bottom for plan refinements.
 * Used both when selecting a task from sidebar AND after AI creation.
 */

import { type FC, useCallback, useEffect, useState, useRef } from 'react';
import {
  SendHorizonalIcon,
  PlusIcon,
  FolderOpenIcon,
  FileIcon,
  FileTextIcon,
  ImageIcon,
  XIcon,
  ChevronUpIcon,
  ChevronDownIcon,
  FileCodeIcon,
  TerminalIcon,
  MessagesSquareIcon,
  CheckIcon,
  PauseIcon,
  Loader2Icon,
  AlertTriangleIcon,
  ZapIcon,
  SparklesIcon,
  StopCircleIcon,
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
import { useAutoScroll } from '@/hooks/useAutoScroll';
import { TaskTerminal } from './TaskTerminal';
import { CouncilMessageBubble, CouncilTypingIndicator, CouncilStreamingBubble } from './CouncilMessageBubble';
import { RecommendationBanner } from './RecommendationBanner';
import type { TaskFile } from '@/types/task';
import {
  KAI_TASK_STATUS_LABELS,
  KAI_TASK_STATUS_COLORS,
} from '@/types/task';

interface TaskDetailPanelProps {
  task: TaskFile;
  onClose?: () => void;
}

export const TaskDetailPanel: FC<TaskDetailPanelProps> = ({ task, onClose }) => {
  const { state, updateTask, refineTaskPlan, approveCouncil, councilRespond, getCouncilMessages, isTaskDeliberating, getCouncilAgent, getCouncilPhase, getCouncilStreaming } = useTasks();
  const { state: agentState } = useAgents();
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
  const selectedRuntime = task.agentRuntime ?? 'claude-code';

  // ── Council state ─────────────────────────────────────────────────────
  const councilMessages = getCouncilMessages(task.id);
  const deliberating = isTaskDeliberating(task.id);
  const currentCouncilAgent = getCouncilAgent(task.id);
  const councilStreamingMsg = getCouncilStreaming(task.id);
  const councilPhase = getCouncilPhase(task.id);
  const awaitingClarification = councilPhase === 'awaiting_clarification';

  // ── Auto-approve discovery hint ──────────────────────────────────────
  const [autoApproveHintDismissed, setAutoApproveHintDismissed] = useState(
    () => localStorage.getItem('kai:autoApproveHintDismissed') === '1',
  );
  const [pluginAutoApproveEnabled, setPluginAutoApproveEnabled] = useState<boolean | null>(null);

  useEffect(() => {
    // Fetch current sliceAutoApproval from plugin config
    app.plugins?.getConfig?.('aithena')
      .then((cfg: Record<string, unknown>) => {
        setPluginAutoApproveEnabled(cfg?.sliceAutoApproval !== false); // defaults true
      })
      .catch(() => setPluginAutoApproveEnabled(null));
  }, [task.status]); // re-check when task status changes (e.g. hits human_review)

  const isAtApprovalGate = task.status === 'awaiting_approval' || task.status === 'human_review';
  const showAutoApproveHint = isAtApprovalGate
    && !autoApproveHintDismissed
    && pluginAutoApproveEnabled === false;

  const handleEnableAutoApprove = useCallback(() => {
    app.plugins?.action?.('aithena', 'settings:SettingsView', 'save-settings', { sliceAutoApproval: true });
    setAutoApproveHintDismissed(true);
    setPluginAutoApproveEnabled(true);
    localStorage.setItem('kai:autoApproveHintDismissed', '1');
  }, []);

  const handleDismissAutoApproveHint = useCallback(() => {
    setAutoApproveHintDismissed(true);
    localStorage.setItem('kai:autoApproveHintDismissed', '1');
  }, []);

  // ── Tab state — smart default based on task content ─────────────────────
  const [activeTab, setActiveTab] = useState<'plan' | 'council' | 'agent'>(() => {
    // If there are council messages or deliberation is active, default to council
    if (councilMessages.length > 0 || deliberating || awaitingClarification) return 'council';
    return 'plan';
  });

  // Smart auto-scroll for council messages — allows user to scroll up without being snapped back
  const { ref: councilScrollRef, handleScroll: handleCouncilScroll, userScrolled, setUserScrolled } =
    useAutoScroll<HTMLDivElement>([councilMessages.length, councilStreamingMsg?.content]);

  // Reset tab to smart default when switching tasks or when messages arrive
  const prevTaskId = useRef(task.id);
  const hadMessages = useRef(councilMessages.length > 0);
  useEffect(() => {
    if (prevTaskId.current !== task.id) {
      // Task changed — pick the right tab for the new task
      prevTaskId.current = task.id;
      hadMessages.current = councilMessages.length > 0;
      if (councilMessages.length > 0 || deliberating || awaitingClarification) {
        setActiveTab('council');
      } else {
        setActiveTab('plan');
      }
    } else if (!hadMessages.current && councilMessages.length > 0) {
      // Messages just arrived (e.g. from fetch-history) — switch to council
      hadMessages.current = true;
      setActiveTab('council');
    }
  }, [task.id, councilMessages.length, deliberating, awaitingClarification]);

  // ── Composer state (plan tab) ─────────────────────────────────────────
  const [input, setInput] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // ── Council composer state ──────────────────────────────────────────────
  const [councilInput, setCouncilInput] = useState('');
  const councilTextareaRef = useRef<HTMLTextAreaElement>(null);

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

  // Auto-switch to council tab when deliberation starts
  useEffect(() => {
    if (deliberating && activeTab === 'plan') {
      setActiveTab('council');
    }
  }, [deliberating]);

  // Auto-switch to council tab when advisor requests clarification
  useEffect(() => {
    if (awaitingClarification && activeTab !== 'council') {
      setActiveTab('council');
    }
  }, [awaitingClarification]);

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

  // Auto-resize council textarea
  useEffect(() => {
    const el = councilTextareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 180) + 'px';
  }, [councilInput]);

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

  const handleStartAgent = useCallback(async () => {
    const runtime = task.agentRuntime ?? 'claude-code';
    setIsStartingAgent(true);
    try {
      const result = await app.tasks.terminalCreate(task.id, {
        runtime: selectedRuntime,
        cwd: task.metadata?.cwd ?? currentWorkingDirectory ?? undefined,
      });
      if (result.sessionId) {
        setTerminalSessionId(result.sessionId);
        void updateTask(task.id, {
          terminalSessionId: result.sessionId,
          agentRuntime: runtime,
          status: 'in_progress',
          ...(!task.startedAt && { startedAt: new Date().toISOString() }),
        });
      }
    } finally {
      setIsStartingAgent(false);
    }
  }, [task.id, task.metadata?.cwd, currentWorkingDirectory, selectedRuntime, updateTask]);

  const handleStopAgent = useCallback(() => {
    void app.tasks.stopExecution(task.id);
  }, [task.id]);

  const handleTerminalExit = useCallback(
    (_exitCode: number) => {
      // Keep terminalSessionId so the xterm buffer stays visible with output history.
      // The terminal shows "[Process exited with code X]" — user can still scroll.
      // Only clear the session on explicit "Stop" or task deletion.
    },
    [],
  );

  const handleComposerSubmit = useCallback(() => {
    const text = input.trim();
    if (!text || isActivelyStreaming) return;

    setInput('');
    void refineTaskPlan(task.id, text);

    // Request focus on next render (survives streaming state updates)
    pendingFocusRef.current = true;
  }, [input, task.id, refineTaskPlan, isActivelyStreaming]);

  const handleApproveCouncil = useCallback(async () => {
    const result = await approveCouncil(task.id);
    if (!result.ok) {
      console.error('[TaskDetailPanel] Council approval failed:', result.error);
    }
  }, [task.id, approveCouncil]);

  const handleMarkDone = useCallback(async () => {
    void updateTask(task.id, { status: 'done', completedAt: new Date().toISOString() });
  }, [task.id, updateTask]);

  const handleContinueExecution = useCallback(async () => {
    // Move back to awaiting_approval so approveCouncil can re-trigger execution
    void updateTask(task.id, { status: 'awaiting_approval' });
    // Then auto-approve to start execution
    const result = await approveCouncil(task.id);
    if (!result.ok) {
      console.error('[TaskDetailPanel] Continue execution failed:', result.error);
    }
  }, [task.id, updateTask, approveCouncil]);

  const handleCouncilSubmit = useCallback(() => {
    const text = councilInput.trim();
    if (!text || (deliberating && !awaitingClarification)) return;
    setCouncilInput('');
    void councilRespond(task.id, text);
    councilTextareaRef.current?.focus();
  }, [councilInput, deliberating, awaitingClarification, task.id, councilRespond]);

  const handleCouncilKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleCouncilSubmit();
      }
    },
    [handleCouncilSubmit],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleComposerSubmit();
      }
    },
    [handleComposerSubmit],
  );

  // Display text: streaming text if actively streaming for this task, else persisted description
  const displayText = (creatingTaskId === task.id && streamingText) ? streamingText : task.description;

  const assignedAgent = task.assignedAgentId
    ? agentState.agents.find((a) => a.id === task.assignedAgentId)
    : null;

  const fmtDate = (iso: string) =>
    new Date(iso).toLocaleString(undefined, {
      year: 'numeric', month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit',
    });

  const leftRows: Array<{ label: string; value: React.ReactNode }> = [
    {
      label: 'Status',
      value: (
        <span className={cn('inline-flex items-center rounded-full px-2 py-px text-xs font-medium', KAI_TASK_STATUS_COLORS[task.status])}>
          {KAI_TASK_STATUS_LABELS[task.status]}
        </span>
      ),
    },
    {
      label: 'Agent',
      value: assignedAgent
        ? <span className="text-xs text-foreground/80">{assignedAgent.icon ?? '🤖'} {assignedAgent.name}</span>
        : <span className="text-xs text-muted-foreground/30">—</span>,
    },
  ];

  const rightRows: Array<{ label: string; value: string | null }> = [
    { label: 'Created',   value: fmtDate(task.createdAt) },
    { label: 'Updated',   value: fmtDate(task.updatedAt) },
    { label: 'Started',   value: task.startedAt ? fmtDate(task.startedAt) : null },
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
                {value
                  ? <span className="text-xs text-foreground/80">{value}</span>
                  : <span className="text-xs text-muted-foreground/30">—</span>
                }
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
            onClick={() => setActiveTab('council')}
            className={cn(
              'flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium transition-colors',
              activeTab === 'council'
                ? 'border-primary text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground/80',
            )}
          >
            <MessagesSquareIcon className="h-3.5 w-3.5" />
            Council
            {deliberating && (
              <span className="h-1.5 w-1.5 rounded-full bg-amber-500 animate-pulse" />
            )}
            {!deliberating && councilMessages.length > 0 && (
              <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-muted px-1 text-[10px] font-medium text-muted-foreground">
                {councilMessages.length}
              </span>
            )}
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
      {activeTab === 'plan' && (
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
              </div>
            </div>
            {/* Sticky plan composer */}
            <div className="sticky bottom-0 z-20">
              <div className="pointer-events-none absolute bottom-0 left-0 right-0 z-[15] h-56 bg-gradient-to-t from-background from-25% via-background/70 via-55% to-transparent md:h-64" />
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
          </div>{/* end scrollRef */}
          </div>{/* end overflow-y-auto */}
        </div>
      )}

      {activeTab === 'council' && (
        /* ═══ COUNCIL TAB ═══ */
        <div className="flex min-h-0 flex-1 flex-col">
          {/* ─── Execution Progress Stepper ─── */}
          {(councilMessages.length > 0 || deliberating) && (
            <ExecutionProgressStepper task={task} councilPhase={councilPhase} deliberating={deliberating} />
          )}

          {/* ─── Auto-approve discovery hint ─── */}
          {showAutoApproveHint && (
            <div className="mx-6 mt-2 flex items-center gap-2 rounded-xl border border-violet-500/15 bg-violet-500/5 px-4 py-2 animate-in fade-in slide-in-from-bottom-1">
              <ZapIcon size={12} className="text-violet-400 flex-shrink-0" />
              <span className="text-[11px] text-muted-foreground">
                Want Aithena to auto-approve?
              </span>
              <button
                type="button"
                onClick={handleEnableAutoApprove}
                className="text-[11px] text-violet-400 hover:text-violet-300 font-medium transition-colors"
              >
                Enable
              </button>
              <button
                type="button"
                onClick={handleDismissAutoApproveHint}
                className="text-[11px] text-muted-foreground/60 hover:text-muted-foreground transition-colors ml-1"
              >
                Dismiss
              </button>
            </div>
          )}

          {/* ─── Aithena Recommendations Banner ─── */}
          <RecommendationBanner taskId={task.id} />

          {/* Scrollable message list */}
          <div className="relative flex-1 min-h-0">
          <div ref={councilScrollRef} onScroll={handleCouncilScroll} className="h-full overflow-y-auto px-6 py-4 space-y-4">
            {councilMessages.length === 0 && !deliberating && (
              <div className="flex h-full items-center justify-center">
                <div className="flex flex-col items-center gap-3 text-center">
                  <MessagesSquareIcon className="h-8 w-8 text-muted-foreground/20" />
                  <div>
                    <p className="text-sm text-muted-foreground/60">No council deliberation yet</p>
                    <p className="mt-1 text-xs text-muted-foreground/40">
                      The council will deliberate when this task is created or moved to planning
                    </p>
                  </div>
                </div>
              </div>
            )}
            {councilMessages.map((msg) => (
              <CouncilMessageBubble key={msg.id} message={msg} />
            ))}
            {deliberating && !awaitingClarification && (
              councilStreamingMsg && councilStreamingMsg.content
                ? <CouncilStreamingBubble
                    agent={councilStreamingMsg.agent}
                    phase={councilStreamingMsg.phase}
                    content={councilStreamingMsg.content}
                  />
                : <CouncilTypingIndicator agent={currentCouncilAgent || 'aithena'} />
            )}
          </div>

          {/* Floating scroll-to-bottom button */}
          {userScrolled && councilMessages.length > 0 && (
            <button
              type="button"
              onClick={() => {
                councilScrollRef.current?.scrollTo({ top: councilScrollRef.current.scrollHeight, behavior: 'smooth' });
                setUserScrolled(false);
              }}
              className="absolute bottom-4 right-6 z-10 flex h-8 w-8 items-center justify-center rounded-full border border-border/50 bg-card/90 shadow-lg backdrop-blur-sm text-muted-foreground hover:text-foreground hover:bg-card transition-all duration-200 animate-in fade-in slide-in-from-bottom-2"
              title="Scroll to latest"
            >
              <ChevronDownIcon size={16} />
            </button>
          )}
          </div>

          {/* Approval banner (when awaiting_approval — fallback if auto-execute didn't trigger) */}
          {task.status === 'awaiting_approval' && (
            <div className="border-t border-border/40 bg-card/50 px-6 py-3 flex items-center justify-between">
              <div>
                <p className="text-sm font-medium">Plan approved by council</p>
                <p className="text-xs text-muted-foreground">
                  Starting execution...
                </p>
              </div>
              <button
                type="button"
                onClick={() => { void handleApproveCouncil(); }}
                className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
              >
                Execute Now
              </button>
            </div>
          )}

          {/* Execution in progress — stop button */}
          {task.status === 'in_progress' && (
            <div className="border-t border-border/40 bg-card/50 px-6 py-3 flex items-center justify-between">
              <div>
                <p className="text-sm font-medium">Execution in progress</p>
                <p className="text-xs text-muted-foreground">Agent is executing the approved plan</p>
              </div>
              <button
                type="button"
                onClick={() => { void app.tasks.stopExecution(task.id); }}
                className="flex items-center gap-1.5 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-1.5 text-sm font-medium text-red-400 transition-colors hover:bg-red-500/20"
              >
                <StopCircleIcon className="h-3.5 w-3.5" />
                Stop
              </button>
            </div>
          )}

          {/* Gathering artifacts indicator — council requested deeper investigation */}
          {councilPhase === 'gathering_artifacts' && task.status !== 'in_progress' && (
            <div className="border-t border-border/40 bg-card/50 px-6 py-3 flex items-center gap-3">
              <div className="h-2 w-2 animate-pulse rounded-full bg-cyan-400" />
              <div>
                <p className="text-sm font-medium">Gathering project artifacts</p>
                <p className="text-xs text-muted-foreground">Runner is collecting files and context for the council</p>
              </div>
            </div>
          )}

          {/* Human review banner — execution finished, needs user decision */}
          {task.status === 'human_review' && (
            <div className="border-t border-border/40 bg-card/50 px-6 py-3">
              <div className="mb-2">
                <p className="text-sm font-medium">Execution complete — review required</p>
                <p className="text-xs text-muted-foreground">
                  {(task.metadata as Record<string, unknown>)?.sliceBlockReason
                    ? `Paused: ${(task.metadata as Record<string, unknown>).sliceBlockReason}`
                    : 'The agent has completed its work. Review the results and decide how to proceed.'}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => { void handleMarkDone(); }}
                  className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-emerald-700"
                >
                  Accept &amp; Done
                </button>
                <button
                  type="button"
                  onClick={() => { void handleContinueExecution(); }}
                  className="rounded-lg border border-border/60 bg-muted/40 px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted/70"
                >
                  Continue Execution
                </button>
              </div>
            </div>
          )}

          {/* Council composer — respond to advisor's clarification questions */}
          {task.status !== 'awaiting_approval' && task.status !== 'human_review' && task.status !== 'in_progress' && task.status !== 'done' && (
            <div className="shrink-0 border-t border-border/40 px-6 py-3">
              {/* Quick-action hints when awaiting user input */}
              {awaitingClarification && councilMessages.length >= 2 && (
                <div className="mb-2 flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      void councilRespond(task.id, 'Let\'s plan this. Proceed with a detailed implementation plan.');
                    }}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-primary/20 bg-primary/5 px-3 py-1.5 text-[11px] font-medium text-primary transition-colors hover:bg-primary/10 hover:border-primary/40"
                  >
                    <SparklesIcon className="h-3 w-3" />
                    Plan this
                  </button>
                  <span className="text-[10px] text-muted-foreground/50">or type below to continue chatting</span>
                </div>
              )}
              <div className="flex items-end gap-2">
                <textarea
                  ref={councilTextareaRef}
                  value={councilInput}
                  onChange={(e) => setCouncilInput(e.target.value)}
                  onKeyDown={handleCouncilKeyDown}
                  placeholder={deliberating && !awaitingClarification ? 'Council is deliberating...' : awaitingClarification ? 'Respond to the advisor...' : 'Respond to the council...'}
                  disabled={deliberating && !awaitingClarification}
                  rows={1}
                  className="min-h-[40px] max-h-[120px] flex-1 resize-none overflow-y-auto rounded-xl border border-border/50 bg-muted/30 px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/50 focus:border-primary/50 focus:outline-none disabled:opacity-40"
                />
                <button
                  type="button"
                  onClick={handleCouncilSubmit}
                  disabled={!councilInput.trim() || (deliberating && !awaitingClarification)}
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-40"
                >
                  <SendHorizonalIcon className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {activeTab === 'agent' && (
        /* ═══ AGENT TAB ═══ */
        <div className="flex min-h-0 flex-1 flex-col">
          {/* Gathering artifacts label — shows above terminal when runner is active */}
          {councilPhase === 'gathering_artifacts' && terminalSessionId && (
            <div className="flex items-center gap-2 px-5 py-1.5 text-xs text-muted-foreground">
              <div className="h-1.5 w-1.5 animate-pulse rounded-full bg-cyan-400" />
              Gathering artifacts for council...
            </div>
          )}
          <div className={cn('flex min-h-0 flex-1 flex-col mx-auto w-full px-5 pt-4 pb-4', !fullWidth && 'max-w-3xl')}>
            {terminalSessionId ? (
              <TaskTerminal
                sessionId={terminalSessionId}
                onExit={handleTerminalExit}
                className="h-full rounded-xl"
              />
            ) : (
              <div className="flex h-full flex-col overflow-hidden rounded-xl border border-border/50 bg-[#1a1a2e]">
                <div className="flex flex-1 items-center justify-center">
                  <div className="flex flex-col items-center gap-3 text-center">
                    <TerminalIcon className="h-8 w-8 text-white/20" />
                    <p className="text-sm text-white/40">
                      {task.status === 'todo' ? 'Agent will run after council approval' : 'No execution output'}
                    </p>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

// ── Execution Progress Stepper (Stateful) ─────────────────────────────────────

const WORKFLOW_STEPS = [
  { key: 'gathering', label: 'Gather' },
  { key: 'planning', label: 'Plan' },
  { key: 'reviewing', label: 'Review' },
  { key: 'signoff', label: 'Sign-off' },
  { key: 'executing', label: 'Execute' },
  { key: 'done', label: 'Done' },
] as const;

type StepState = 'completed' | 'active' | 'paused' | 'blocked' | 'future';

function resolveStepIndex(phase: string, taskStatus: string, deliberating: boolean): number {
  if (taskStatus === 'done') return 5;
  if (taskStatus === 'in_progress' || taskStatus === 'human_review') return 4;
  if (taskStatus === 'awaiting_approval') return 4;

  if (phase === 'complete' || phase === 'done') return 5;
  if (phase === 'executing' || phase === 'execution') return 4;
  if (phase === 'advisor_signoff' || phase === 'signoff') return 3;
  if (phase === 'reviewing' || phase === 'review') return 2;
  if (phase === 'planning') return 1;
  if (phase === 'gathering' || phase === 'awaiting_clarification') return 0;

  if (deliberating) return 0;
  return -1;
}

function resolveStepState(
  stepIdx: number,
  currentIdx: number,
  taskStatus: string,
  councilPhase: string,
  meta: Record<string, unknown>,
): StepState {
  if (stepIdx < currentIdx) return 'completed';
  if (stepIdx > currentIdx) return 'future';

  // Current step — determine sub-state
  const action = meta.councilAction as string | undefined;
  const blockReason = meta.sliceBlockReason as string | undefined;

  if (action === 'blocked' || blockReason) return 'blocked';
  if (taskStatus === 'human_review' || taskStatus === 'awaiting_approval') return 'paused';
  if (councilPhase === 'awaiting_clarification') return 'paused';
  if (taskStatus === 'in_progress') return 'active';
  if (taskStatus === 'done') return 'completed';

  return 'active'; // default during deliberation
}

function getStepAnnotation(
  stepIdx: number,
  currentIdx: number,
  taskStatus: string,
  councilPhase: string,
  meta: Record<string, unknown>,
  deliberating: boolean,
): string | null {
  if (stepIdx !== currentIdx) return null;

  const slices = meta.councilSlices as Array<unknown> | undefined;
  const sliceIdx = (meta.currentSliceIndex as number) ?? 0;
  const cycles = (meta.executionCycles as number) ?? 0;
  const executor = (meta.chosenExecutor as string) ?? '';
  const blockReason = meta.sliceBlockReason as string | undefined;

  // Execution step
  if (stepIdx === 4) {
    if (taskStatus === 'human_review') {
      return blockReason ? blockReason.slice(0, 50) : 'Review required';
    }
    if (slices && slices.length > 1) {
      return `Slice ${sliceIdx + 1}/${slices.length}${cycles ? ` · Cycle ${cycles}` : ''}${executor ? ` · ${executor.replace('claude-code', 'claude').replace('codex', 'codex')}` : ''}`;
    }
    if (cycles) {
      return `Cycle ${cycles}${executor ? ` · ${executor.replace('claude-code', 'claude')}` : ''}`;
    }
    return executor ? executor.replace('claude-code', 'claude') : null;
  }

  // Done
  if (stepIdx === 5) return 'Complete';

  // Council phases
  if (councilPhase === 'awaiting_clarification') return 'Awaiting response';
  if (deliberating) {
    if (stepIdx === 0) return 'Thinking…';
    if (stepIdx === 1) return 'Planning…';
    if (stepIdx === 2) return 'Reviewing…';
    if (stepIdx === 3) return 'Signing off…';
  }
  return null;
}

function formatElapsed(startedAt: string | undefined, freeze: boolean): string {
  if (!startedAt) return '';
  const start = new Date(startedAt).getTime();
  if (isNaN(start)) return '';
  const now = freeze ? Date.now() : Date.now(); // both use now — freeze just stops the interval
  const diff = Math.max(0, Math.floor((now - start) / 1000));
  if (diff < 60) return `${diff}s`;
  const m = Math.floor(diff / 60);
  const s = diff % 60;
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

interface ExecutionProgressStepperProps {
  task: TaskFile;
  councilPhase: string;
  deliberating: boolean;
}

const ExecutionProgressStepper: FC<ExecutionProgressStepperProps> = ({
  task,
  councilPhase,
  deliberating,
}) => {
  const currentIdx = resolveStepIndex(councilPhase, task.status, deliberating);
  if (currentIdx < 0) return null;

  const meta = (task.metadata ?? {}) as Record<string, unknown>;
  const slices = meta.councilSlices as Array<unknown> | undefined;
  const sliceIdx = (meta.currentSliceIndex as number) ?? 0;
  const shouldTick = task.status === 'in_progress';

  // Elapsed time ticker
  const [elapsed, setElapsed] = useState(() => formatElapsed(task.startedAt, !shouldTick));
  useEffect(() => {
    if (!task.startedAt) { setElapsed(''); return; }
    setElapsed(formatElapsed(task.startedAt, false));
    if (!shouldTick) return;
    const id = setInterval(() => setElapsed(formatElapsed(task.startedAt, false)), 1000);
    return () => clearInterval(id);
  }, [task.startedAt, shouldTick]);

  return (
    <div className="shrink-0 border-b border-border/30 px-6 py-3">
      {/* Step indicators */}
      <div className="flex items-center justify-between">
        {WORKFLOW_STEPS.map((step, idx) => {
          const state = resolveStepState(idx, currentIdx, task.status, councilPhase, meta);
          const annotation = getStepAnnotation(idx, currentIdx, task.status, councilPhase, meta, deliberating);

          return (
            <div key={step.key} className="flex items-center">
              <div className="flex flex-col items-center gap-1">
                {/* Circle indicator */}
                <div
                  className={cn(
                    'flex h-6 w-6 items-center justify-center rounded-full text-[10px] font-semibold transition-all',
                    state === 'completed' && 'bg-emerald-500/20 text-emerald-400',
                    state === 'active' && 'bg-primary/20 text-primary ring-2 ring-primary/40 animate-pulse',
                    state === 'paused' && 'bg-amber-500/20 text-amber-400 ring-2 ring-amber-500/30',
                    state === 'blocked' && 'bg-rose-500/20 text-rose-400 ring-2 ring-rose-500/30',
                    state === 'future' && 'bg-muted/40 text-muted-foreground/40',
                  )}
                >
                  {state === 'completed' && <CheckIcon className="h-3 w-3" />}
                  {state === 'active' && <Loader2Icon className="h-3 w-3 animate-spin" />}
                  {state === 'paused' && <PauseIcon className="h-3 w-3" />}
                  {state === 'blocked' && <AlertTriangleIcon className="h-3 w-3" />}
                  {state === 'future' && <span>{idx + 1}</span>}
                </div>

                {/* Label */}
                <span
                  className={cn(
                    'text-[10px] font-medium leading-tight',
                    state === 'completed' && 'text-emerald-400/80',
                    state === 'active' && 'text-foreground',
                    state === 'paused' && 'text-amber-400/80',
                    state === 'blocked' && 'text-rose-400/80',
                    state === 'future' && 'text-muted-foreground/40',
                  )}
                >
                  {step.label}
                </span>

                {/* Annotation (only on current step) */}
                {annotation && (
                  <span
                    className={cn(
                      'text-[9px] leading-tight max-w-[80px] truncate',
                      state === 'blocked' ? 'text-rose-400/60' : 'text-muted-foreground/50',
                    )}
                    title={annotation}
                  >
                    {annotation}
                  </span>
                )}
              </div>

              {/* Connector line */}
              {idx < WORKFLOW_STEPS.length - 1 && (
                <div
                  className={cn(
                    'mx-1 h-px w-5 sm:w-7 md:w-9 transition-colors',
                    idx < currentIdx ? 'bg-emerald-500/40' : 'bg-border/40',
                  )}
                />
              )}
            </div>
          );
        })}
      </div>

      {/* Bottom row: elapsed time + slice progress */}
      {(elapsed || (slices && slices.length > 1 && currentIdx >= 4)) && (
        <div className="mt-2 flex items-center justify-center gap-3 text-[10px] text-muted-foreground/60">
          {elapsed && <span>⏱ {elapsed}</span>}
          {slices && slices.length > 1 && currentIdx >= 4 && (
            <span className="flex items-center gap-0.5">
              {Array.from({ length: slices.length }, (_, i) => (
                <span
                  key={i}
                  className={cn(
                    'inline-block h-1.5 w-1.5 rounded-full transition-colors',
                    i < sliceIdx ? 'bg-emerald-400' :
                    i === sliceIdx ? 'bg-primary animate-pulse' :
                    'bg-muted-foreground/20',
                  )}
                />
              ))}
            </span>
          )}
        </div>
      )}
    </div>
  );
};
