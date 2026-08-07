import { useState, useCallback, useRef, useEffect, type FC } from 'react';
import {
  ChevronDownIcon,
  ChevronRightIcon,
  CheckCircle2Icon,
  AlertCircleIcon,
  LoaderIcon,
  StopCircleIcon,
  SendHorizontalIcon,
  ExternalLinkIcon,
  BotIcon,
  UserIcon,
  MonitorIcon,
  InfoIcon,
} from 'lucide-react';
import { useSubAgents, type SubAgentThreadState } from '@/providers/RuntimeProvider';
import { app } from '@/lib/ipc-client';
import { MarkdownText } from './MarkdownText';
import { ToolCallDisplay } from './ToolGroup';
import { RichChatInput } from './RichChatInput';
import { UserCodeMarkdown } from './UserCodeMarkdown';

type SubAgentInlineProps = {
  toolCallId: string;
  args: unknown;
  result?: unknown;
  isError?: boolean;
  liveOutput?: {
    stdout?: string;
    stderr?: string;
    truncated?: boolean;
    stopped?: boolean;
    subAgentConversationId?: string;
  };
};

export const SubAgentInline: FC<SubAgentInlineProps> = ({ toolCallId, args, result, isError, liveOutput }) => {
  const [expanded, setExpanded] = useState(true);
  const [messageInput, setMessageInput] = useState('');
  const [sendError, setSendError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const { threads, sendMessage, stop, navigateTo } = useSubAgents();

  const [showArgs, setShowArgs] = useState(false);
  const taskArgs = args as { task?: string; model?: string; context?: string } | undefined;
  const task = taskArgs?.task ?? 'Sub-agent task';
  const modelOverride = taskArgs?.model;
  const contextArg = taskArgs?.context;

  const resultData = result as { subAgentConversationId?: string; response?: string; status?: string; toolsUsed?: string[] } | undefined;
  // Resolve the child id from TRUSTED sources first: the backend-bound liveOutput
  // (set onto THIS tool-call's progress), then the renderer's tool-call→child
  // binding. Only fall back to the tool RESULT content last — a result is
  // tool-produced, so for an unknown-named call promoted via liveOutput, honoring
  // result.subAgentConversationId could bind this card (navigate/message/stop) to
  // an UNRELATED child id an arbitrary tool emitted. Trusted sources win.
  const subAgentId = liveOutput?.subAgentConversationId
    ?? findSubAgentByToolCall(threads, toolCallId)
    ?? resultData?.subAgentConversationId;
  const thread = subAgentId ? threads.get(subAgentId) : null;

  const hasResult = result !== undefined;
  // Live thread status is AUTHORITATIVE when a thread exists — the initial tool
  // `result` is frozen at first completion and would otherwise force "Completed"
  // forever, hiding a later resume's running/paused/failed state. Fall back to
  // the result status only when there is no live thread.
  const liveStatus = thread?.status;
  const effectiveStatus = liveStatus ?? resultData?.status;
  const isRunning = effectiveStatus === 'running';
  // 'awaiting-input' = actively waiting for input (a LIVE run, still stoppable).
  // 'paused' = terminal-but-resumable. A pause can mean the agent REQUESTED input
  // (pausedReason 'awaiting-input') OR it exhausted its turn budget / was deferred
  // by a capacity cap (turn-limit / capacity) — the latter did NOT ask for input,
  // so the card must not claim "Awaiting input" for it.
  const isActivelyAwaiting = effectiveStatus === 'awaiting-input';
  const isPaused = effectiveStatus === 'paused';
  const pausedReason = thread?.pausedReason;
  // Treat as "awaiting input" (label) only when the agent actually requested it:
  // a live awaiting-input, or a pause whose reason is awaiting-input.
  const awaitingInput = isActivelyAwaiting || (isPaused && pausedReason === 'awaiting-input');
  // The composer is offered for ANY resumable state (running / awaiting / paused).
  const isResumable = isActivelyAwaiting || isPaused;
  // A live, still-running (stoppable) sub-agent: running or actively awaiting
  // input — but NOT a terminal paused/completed/failed/stopped.
  const isActive = isRunning || isActivelyAwaiting;
  const isStopped = effectiveStatus === 'stopped';
  // Whether the frozen parent tool-call `result`/`isError` is still CURRENT. It is
  // stale once the thread moved past that result — an actively-live run (running /
  // awaiting-input), a thread that was RESUMED (hasResumed), OR a CAPACITY pause: a
  // capacity pause means the user's follow-up was ACCEPTED + queued (the backend
  // goes straight to paused without a `running` event, so hasResumed stays false),
  // so the frozen error is superseded — show the queued/paused state, not Error. A
  // NON-resumed awaiting-input / turn-limit pause is NOT "moved past": e.g. an
  // initial pause whose parent tool-result a PostToolUse hook blocked must still
  // surface that current error.
  const liveMovedPastResult =
    liveStatus === 'running' ||
    liveStatus === 'awaiting-input' ||
    Boolean(thread?.hasResumed) ||
    (isPaused && pausedReason === 'capacity');
  const hasError =
    // Explicit live error/failed status wins. A bare frozen isError prop applies
    // only when the live thread has NOT moved past that result AND it isn't a
    // stopped one (a stopped sub-agent result carries isError:true but should read
    // as "Stopped"). Honored on a NON-resumed live `completed` thread so a
    // PostToolUse-blocked completed result reads as an error, not green Completed;
    // suppressed once a resume/retry has moved past the frozen error.
    effectiveStatus === 'error' ||
    effectiveStatus === 'failed' ||
    (isError && !liveMovedPastResult && effectiveStatus !== 'stopped');
  // "Completed" only when the effective status is a clean completion (or, with no
  // status at all, a result is present) AND there is no current error — a live
  // `completed` thread whose parent tool-result was policy-blocked reads as an
  // error, not green Completed.
  const isCompleted =
    !hasError && (effectiveStatus === 'completed' || (effectiveStatus === undefined && hasResult));

  // Auto-scroll to bottom of inline thread
  useEffect(() => {
    if (expanded && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [expanded, thread?.messages.length]);

  // Diagnostic: record whether this card resolved its live sub-agent thread.
  // Surfaced under the "agent" scope in the Diagnostics trace so parallel
  // sub-agent card resolution can be inspected when tracing is enabled. Depend
  // on the resolved id + a STABLE hasThread boolean (not the `thread` object,
  // which RuntimeProvider replaces on every stream delta — depending on it would
  // fire a renderer→main IPC per delta).
  const hasThread = Boolean(thread);
  const resolvedVia = liveOutput?.subAgentConversationId
    ? 'liveOutput'
    : findSubAgentByToolCall(threads, toolCallId)
      ? 'byToolCall'
      : resultData?.subAgentConversationId
        ? 'result'
        : 'unresolved';
  useEffect(() => {
    app.debug?.trace?.({
      event: 'sub-agent.inline-resolve',
      scope: 'agent',
      fields: {
        parentToolCallId: toolCallId,
        resolvedSubAgentId: subAgentId ?? null,
        via: resolvedVia,
        hasThread,
        threadCount: threads.size,
      },
    });
  }, [toolCallId, subAgentId, hasThread, resolvedVia, threads.size]);

  const handleSendMessage = useCallback(async () => {
    if (!subAgentId || !messageInput.trim()) return;
    const text = messageInput.trim();
    // Only clear the input if the backend ACCEPTED the message. It returns false
    // when the sub-agent's live/resumable state is gone (e.g. after a main-process
    // restart the persisted status is `paused` but in-memory state was cleared) —
    // clearing then would silently discard the user's message. Keep it + surface
    // an error so the user can retry (a re-run/re-open rehydrates state).
    const ok = await sendMessage(subAgentId, text);
    if (ok) {
      setMessageInput('');
      setSendError(null);
    } else {
      setSendError('This sub-agent is no longer resumable (its session ended). Start a new sub-agent to continue.');
    }
  }, [subAgentId, messageInput, sendMessage]);

  const handleStop = useCallback(async () => {
    if (!subAgentId) return;
    const ok = await stop(subAgentId);
    if (!ok) {
      // Backend had no live/resumable state to stop (e.g. after a restart the
      // in-memory state is gone though the persisted status is paused). Surface it
      // rather than silently doing nothing.
      setSendError('This sub-agent is no longer active (its session ended); nothing to stop.');
    }
  }, [subAgentId, stop]);

  const handleNavigate = useCallback(() => {
    if (!subAgentId) return;
    navigateTo(subAgentId);
  }, [subAgentId, navigateTo]);

  // Status display, derived from the authoritative flags above (live thread
  // status wins over the frozen initial result).
  const StatusIcon = hasError
    ? AlertCircleIcon
    : isStopped
      ? StopCircleIcon
      : isResumable
        ? UserIcon
        : isCompleted
          ? CheckCircle2Icon
          : LoaderIcon;
  const statusColor = hasError
    ? 'text-destructive'
    : isStopped
      ? 'text-orange-400'
      : isResumable
        ? 'text-amber-400'
        : isCompleted
          ? 'text-green-500'
          : 'text-blue-400';
  const statusLabel = hasError
    ? 'Error'
    : isStopped
      ? 'Stopped'
      : awaitingInput
        ? 'Awaiting input'
        : isPaused
          ? 'Paused'
          : isCompleted
            ? 'Completed'
            : 'Running';

  return (
    <div className="rounded-lg border-l-4 border-l-blue-500/60 border border-border bg-card text-sm overflow-hidden">
      {/* Header — always visible */}
      <div className="flex items-center gap-2 px-3 py-2">
        <button
          type="button"
          className="flex items-center gap-2 flex-1 min-w-0 hover:opacity-80 transition-opacity"
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? <ChevronDownIcon className="h-3.5 w-3.5 text-muted-foreground shrink-0" /> : <ChevronRightIcon className="h-3.5 w-3.5 text-muted-foreground shrink-0" />}
          <BotIcon className="h-4 w-4 text-blue-400 shrink-0" />
          <span className="text-xs font-medium truncate text-left">
            Sub-agent: {task.length > 70 ? task.slice(0, 67) + '...' : task}
          </span>
        </button>

        {modelOverride && <span className="text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded shrink-0">{modelOverride}</span>}
        <StatusIcon className={`h-3.5 w-3.5 shrink-0 ${statusColor} ${isRunning ? 'animate-spin' : ''}`} />
        <span className={`text-[10px] shrink-0 ${statusColor}`}>{statusLabel}</span>

        {/* Stop/cancel: for a live active run, or a paused agent that still has a
            LIVE thread (in-memory resumable state). A paused card reconstructed
            only from the persisted tool result (no live thread — e.g. after an app
            restart) has nothing the backend can stop, so we don't offer it. */}
        {(isActive || (isPaused && Boolean(thread))) && subAgentId && (
          <button type="button" onClick={(e) => { e.stopPropagation(); handleStop(); }} className="p-1 rounded hover:bg-destructive/10 shrink-0" title={isPaused && !isActive ? 'Cancel (stop resuming)' : 'Stop'}>
            <StopCircleIcon className="h-3.5 w-3.5 text-destructive" />
          </button>
        )}
        {subAgentId && (
          <button type="button" onClick={(e) => { e.stopPropagation(); handleNavigate(); }} className="flex items-center gap-1 text-[10px] text-blue-400 hover:text-blue-300 hover:bg-blue-500/10 px-1.5 py-0.5 rounded transition-colors shrink-0" title="Open full chat">
            <ExternalLinkIcon className="h-3 w-3" />
            <span>Open</span>
          </button>
        )}
      </div>

      {/* Tool args detail — collapsible */}
      {(contextArg || modelOverride) && (
        <div className="border-t">
          <button
            type="button"
            onClick={() => setShowArgs(!showArgs)}
            className="flex items-center gap-1.5 px-3 py-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors w-full"
          >
            <InfoIcon className="h-3 w-3" />
            <span>Tool args</span>
            {showArgs ? <ChevronDownIcon className="h-3 w-3 ml-auto" /> : <ChevronRightIcon className="h-3 w-3 ml-auto" />}
          </button>
          {showArgs && (
            <div className="px-3 pb-2 space-y-1">
              <div className="text-[10px]"><span className="text-muted-foreground">Task:</span> <span className="text-foreground">{task}</span></div>
              {modelOverride && <div className="text-[10px]"><span className="text-muted-foreground">Model:</span> <span className="text-foreground">{modelOverride}</span></div>}
              {contextArg && (
                <div className="text-[10px]">
                  <span className="text-muted-foreground">Context:</span>
                  <pre className="mt-0.5 text-foreground text-[10px] font-mono whitespace-pre-wrap bg-muted/50 rounded p-1.5 max-h-[100px] overflow-y-auto">{contextArg}</pre>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Collapsed: compact single-line preview */}
      {!expanded && (
        <div className="border-t px-3 py-1.5">
          <CompactPreview thread={thread} liveOutput={liveOutput} isRunning={isRunning} />
        </div>
      )}

      {/* Expanded: full nested thread display */}
      {expanded && (
        <div className="border-t">
          {/* Mini chat thread */}
          <div ref={scrollRef} className="overflow-y-auto px-3 py-2 space-y-2 max-h-[450px]">
            {thread && thread.messages.length > 0 ? (
              thread.messages.map((msg, i) => {
                const content = Array.isArray(msg.content) ? msg.content : [];
                const role = msg.role as string;
                return <MiniChatBubble key={(msg as { id?: string }).id ?? i} role={role} content={content} />;
              })
            ) : liveOutput?.stdout ? (
              <pre className="text-[11px] font-mono text-muted-foreground whitespace-pre-wrap">{liveOutput.stdout.slice(-2000)}</pre>
            ) : isRunning ? (
              <div className="text-xs text-muted-foreground italic py-2">Waiting for sub-agent response...</div>
            ) : null}

            {/* Typing indicator */}
            {isRunning && thread && thread.messages.length > 0 && (
              <div className="flex items-center gap-2 pl-6 py-1">
                <BotIcon className="h-3 w-3 text-blue-400" />
                <div className="flex items-center gap-1">
                  <div className="h-1.5 w-1.5 rounded-full bg-blue-400 animate-bounce [animation-delay:0ms]" />
                  <div className="h-1.5 w-1.5 rounded-full bg-blue-400 animate-bounce [animation-delay:150ms]" />
                  <div className="h-1.5 w-1.5 rounded-full bg-blue-400 animate-bounce [animation-delay:300ms]" />
                </div>
              </div>
            )}
          </div>

          {/* Inline composer — visible when running or awaiting input */}
          {(isRunning || isResumable) && subAgentId && (
            <div className="border-t px-3 py-2">
              {sendError && (
                <div className="mb-1.5 text-[10px] text-destructive">{sendError}</div>
              )}
              <div className="flex items-center gap-1.5 rounded-lg border bg-background px-2 py-1.5">
                <RichChatInput
                  value={messageInput}
                  onChange={setMessageInput}
                  onSubmit={handleSendMessage}
                  placeholder="Message sub-agent..."
                  className="min-h-[28px] max-h-[160px] flex-1 bg-transparent text-xs outline-none"
                />
                <button
                  type="button"
                  onClick={handleSendMessage}
                  disabled={!messageInput.trim()}
                  className="flex h-5 w-5 items-center justify-center rounded-full bg-blue-500 text-white hover:bg-blue-600 disabled:opacity-30 transition-colors shrink-0"
                >
                  <SendHorizontalIcon className="h-3 w-3" />
                </button>
              </div>
            </div>
          )}

          {/* Final result summary (after completion) */}
          {resultData?.toolsUsed && resultData.toolsUsed.length > 0 && (
            <div className="border-t px-3 py-1.5 flex flex-wrap gap-1">
              <span className="text-[10px] text-muted-foreground mr-1">Tools used:</span>
              {resultData.toolsUsed.map((t) => (
                <span key={t} className="text-[10px] bg-muted px-1.5 py-0.5 rounded text-muted-foreground">{t}</span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

// --- Mini chat bubble for inline thread ---

type ContentPart = {
  type: string;
  text?: string;
  source?: string;
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  argsText?: string;
  result?: unknown;
  isError?: boolean;
  startedAt?: string;
  finishedAt?: string;
  liveOutput?: { stdout?: string; stderr?: string; truncated?: boolean; stopped?: boolean };
};

const MiniChatBubble: FC<{ role: string; content: ContentPart[] }> = ({ role, content }) => {
  const isAssistant = role === 'assistant';

  // Determine user message source (task, parent, or user)
  const firstTextPart = content.find((p) => p.type === 'text');
  const source = (firstTextPart as { source?: string } | undefined)?.source;

  let label: string;
  let Icon: typeof BotIcon;
  let iconColor: string;
  let bubbleBg: string;
  let align: string;

  if (isAssistant) {
    label = 'Sub-agent';
    Icon = BotIcon;
    iconColor = 'text-blue-400';
    bubbleBg = 'bg-muted/80';
    align = 'justify-start';
  } else if (source === 'task') {
    label = 'Task (from parent)';
    Icon = MonitorIcon;
    iconColor = 'text-primary';
    bubbleBg = 'bg-[var(--brand-accent-subtle)] border border-[var(--brand-accent-border)]';
    align = 'justify-start';
  } else if (source === 'user') {
    label = 'You';
    Icon = UserIcon;
    iconColor = 'text-primary';
    bubbleBg = 'bg-primary/10 border border-primary/20';
    align = 'justify-end';
  } else {
    // Generic user message (e.g. from parent agent follow-up)
    label = 'Parent agent';
    Icon = MonitorIcon;
    iconColor = 'text-orange-400';
    bubbleBg = 'bg-orange-500/10 border border-orange-500/20';
    align = 'justify-start';
  }

  const hasText = content.some((p) => p.type === 'text' && p.text?.trim());
  const hasToolCalls = content.some((p) => p.type === 'tool-call');

  if (!hasText && !hasToolCalls) return null;

  return (
    <div className={`flex gap-2 ${align}`}>
      {align === 'justify-start' && <Icon className={`h-3.5 w-3.5 mt-1.5 shrink-0 ${iconColor}`} />}
      <div className={`max-w-[90%] rounded-xl px-3 py-1.5 ${bubbleBg}`}>
        <span className="text-[9px] uppercase text-muted-foreground/70 font-medium">{label}</span>
        <div className="mt-0.5 space-y-1">
          {content.map((part, i) => {
            if (part.type === 'text' && part.text?.trim()) {
              return (
                <div key={i} className="text-xs">
                  {source === 'user'
                    ? <UserCodeMarkdown text={part.text} className="text-xs" />
                    : <MarkdownText text={part.text} />}
                </div>
              );
            }
            if (part.type === 'tool-call') {
              return (
                <div key={part.toolCallId ?? i} className="my-1">
                  <ToolCallDisplay
                    part={{
                      type: 'tool-call',
                      toolCallId: part.toolCallId ?? `tc-${i}`,
                      toolName: part.toolName ?? 'unknown',
                      args: part.args ?? {},
                      argsText: part.argsText ?? JSON.stringify(part.args, null, 2),
                      result: part.result,
                      isError: part.isError,
                      startedAt: part.startedAt,
                      finishedAt: part.finishedAt,
                      liveOutput: part.liveOutput,
                    }}
                  />
                </div>
              );
            }
            return null;
          })}
        </div>
      </div>
      {align === 'justify-end' && <Icon className={`h-3.5 w-3.5 mt-1.5 shrink-0 ${iconColor}`} />}
    </div>
  );
};

// --- Compact preview for collapsed state ---

const CompactPreview: FC<{
  thread: SubAgentThreadState | null | undefined;
  liveOutput: SubAgentInlineProps['liveOutput'];
  isRunning: boolean;
}> = ({ thread, liveOutput, isRunning }) => {
  // Show last assistant message snippet
  if (thread?.messages.length) {
    const lastAssistant = [...thread.messages].reverse().find((m) => m.role === 'assistant');
    if (lastAssistant) {
      const content = Array.isArray(lastAssistant.content) ? lastAssistant.content : [];
      const text = content
        .filter((p: unknown) => (p as { type: string }).type === 'text')
        .map((p: unknown) => (p as { text: string }).text ?? '')
        .join(' ').trim();
      const toolCount = content.filter((p: unknown) => (p as { type: string }).type === 'tool-call').length;
      return (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <BotIcon className="h-3 w-3 text-blue-400 shrink-0" />
          <span className="truncate">{text ? text.slice(0, 120) : `${toolCount} tool call${toolCount !== 1 ? 's' : ''}`}</span>
          {isRunning && (
            <div className="flex items-center gap-0.5 shrink-0">
              <div className="h-1 w-1 rounded-full bg-blue-400 animate-bounce [animation-delay:0ms]" />
              <div className="h-1 w-1 rounded-full bg-blue-400 animate-bounce [animation-delay:150ms]" />
              <div className="h-1 w-1 rounded-full bg-blue-400 animate-bounce [animation-delay:300ms]" />
            </div>
          )}
        </div>
      );
    }
  }

  if (liveOutput?.stdout) {
    const lastLine = liveOutput.stdout.trim().split('\n').pop() ?? '';
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <BotIcon className="h-3 w-3 text-blue-400 shrink-0" />
        <span className="truncate font-mono text-[11px]">{lastLine.slice(0, 120)}</span>
      </div>
    );
  }

  if (isRunning) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground italic">
        <div className="flex items-center gap-0.5">
          <div className="h-1 w-1 rounded-full bg-blue-400 animate-bounce [animation-delay:0ms]" />
          <div className="h-1 w-1 rounded-full bg-blue-400 animate-bounce [animation-delay:150ms]" />
          <div className="h-1 w-1 rounded-full bg-blue-400 animate-bounce [animation-delay:300ms]" />
        </div>
        <span>Working...</span>
      </div>
    );
  }

  return null;
};

// --- Helpers ---

function findSubAgentByToolCall(threads: Map<string, SubAgentThreadState>, toolCallId: string): string | undefined {
  for (const [id, thread] of threads) {
    if (thread.parentToolCallId === toolCallId) return id;
  }
  return undefined;
}
