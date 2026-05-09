import { useState, useCallback, useEffect, useMemo, useRef, type FC } from 'react';
import { createPortal } from 'react-dom';
import { CodeBlock } from './CodeBlock';
import { MarkdownText } from './MarkdownText';
import { ElapsedBadge } from './ElapsedBadge';
import {
  ChevronDownIcon,
  ChevronRightIcon,
  CheckIcon,
  SquareIcon,
  CircleIcon,
  AsteriskIcon,
  LoaderIcon,
  ScissorsIcon,
  DownloadIcon,
  FileIcon,
  FileTextIcon,
  FilePenIcon,
  FolderIcon,
  FolderOpenIcon,
  ExternalLinkIcon,
  TerminalIcon,
  AlertTriangleIcon,
  CodeIcon,
  SearchIcon,
  BookOpenIcon,
  ScrollTextIcon,
  SendHorizontalIcon,
  XIcon,
  CopyIcon,
  BotIcon,
  ImageIcon,
  VideoIcon,
  HelpCircleIcon,
  ListTodoIcon,
  SparklesIcon,
} from 'lucide-react';
import { app } from '@/lib/ipc-client';
import { Tooltip } from '@/components/ui/Tooltip';
import { usePlanPanel } from '@/providers/PlanPanelContext';
import { useTasksOptional } from '@/providers/TaskProvider';
import { refocusComposer } from '@/lib/utils';

type ToolCallPart = {
  type: 'tool-call';
  toolCallId: string;
  toolName: string;
  args: unknown;
  argsText?: string;
  result?: unknown;
  isError?: boolean;
  isHung?: boolean;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  /** Original (pre-compaction) result — present when tool output was compacted */
  originalResult?: unknown;
  /** Tool compaction metadata */
  compactionMeta?: {
    wasCompacted: boolean;
    extractionDurationMs: number;
  };
  /** Live compaction phase — 'start' while AI summarization is running */
  compactionPhase?: 'start' | 'complete' | null;
  liveOutput?: {
    stdout?: string;
    stderr?: string;
    truncated?: boolean;
    stopped?: boolean;
  };
  /** Approval status for confirm-writes execution mode */
  approvalStatus?: 'pending' | 'approved' | 'rejected';
  /** Backend-side approval ID — may differ from toolCallId due to ID mismatch */
  approvalId?: string;
};

export const ToolGroup: FC<{ parts: ToolCallPart[]; onSendFeedback?: (text: string) => void; onPlanApproved?: (data: { title: string; description: string; planFileName?: string; toolCallId: string }) => Promise<{ id: string; title: string } | null> }> = ({ parts, onSendFeedback, onPlanApproved }) => {
  if (parts.length === 0) return null;

  return (
    <div className="my-2 space-y-1.5">
      {parts.map((part) => (
        <ToolCallDisplay key={part.toolCallId} part={part} onSendFeedback={onSendFeedback} onPlanApproved={onPlanApproved} />
      ))}
    </div>
  );
};

export const ToolCallDisplay: FC<{ part: ToolCallPart; onSendFeedback?: (text: string) => void; onPlanApproved?: (data: { title: string; description: string; planFileName?: string; toolCallId: string }) => Promise<{ id: string; title: string } | null> }> = ({ part, onSendFeedback, onPlanApproved }) => {
  const [expanded, setExpanded] = useState(true);
  const [showOriginal, setShowOriginal] = useState(false);
  const [localApproval, setLocalApproval] = useState<'approved' | 'rejected' | 'dismissed' | null>(null);
  const [feedbackText, setFeedbackText] = useState('');
  const [createdTaskIdLocal, setCreatedTaskIdLocal] = useState<string | null>(null);
  const tasksCtx = useTasksOptional();
  // Derive createdTaskId from the tasks list (survives remount) or fall back to local state
  const createdTaskId = useMemo(() => {
    if (createdTaskIdLocal) return createdTaskIdLocal;
    if (!tasksCtx || part.toolName !== 'exit_plan_mode') return null;
    const match = tasksCtx.state.tasks.find((t) => t.sourceToolCallId === part.toolCallId);
    return match?.id ?? null;
  }, [createdTaskIdLocal, tasksCtx, part.toolName, part.toolCallId]);
  const planPanelCtx = usePlanPanel();
  const onOpenPlan = planPanelCtx?.openPlan;
  const hasResult = part.result !== undefined;
  const isHung = Boolean(part.isHung);
  const isError = !isHung && (part.isError || (hasResult && isErrorResult(part.result)));
  const approvalStatus = localApproval ?? part.approvalStatus;
  const isPendingApproval = approvalStatus === 'pending' && !hasResult;
  const isAskUser = part.toolName === 'ask_user';
  const isRunning = !hasResult && !isHung && !isPendingApproval;
  const hasLiveOutput = Boolean(part.liveOutput?.stdout || part.liveOutput?.stderr);
  const wasCompacted = Boolean(part.compactionMeta?.wasCompacted);
  const canShowOriginal = wasCompacted && part.originalResult !== undefined;
  const isSummarizing = part.compactionPhase === 'start';
  const mediaResult = hasResult && !isError ? detectMediaResult(part.result) : null;
  const todoItems = detectTodoItems(part);
  const smartResult = hasResult && !isError ? detectSmartResult(part) : null;
  // For bash tools, detect even on error so we render IN/OUT box instead of raw JSON
  const isBashTool = part.toolName === 'sh' || part.toolName === 'bash' || part.toolName === 'mastra_workspace_execute_command';
  const isEditTool = part.toolName === 'file_edit' || part.toolName === 'mastra_workspace_edit_file'
    || part.toolName === 'file_write' || part.toolName === 'mastra_workspace_write_file'
    || part.toolName === 'edit' || part.toolName === 'Edit' || part.toolName === 'write' || part.toolName === 'Write'
    || part.toolName === 'str_replace_based_edit_tool' || part.toolName === 'str_replace_editor';
  const isReadTool = part.toolName === 'file_read' || part.toolName === 'read' || part.toolName === 'Read'
    || part.toolName === 'mastra_workspace_read_file';
  const isGrepToolName = part.toolName === 'grep' || part.toolName === 'Grep'
    || part.toolName === 'mastra_workspace_grep' || part.toolName === 'grep_search';
  const isGlobToolName = part.toolName === 'glob' || part.toolName === 'Glob'
    || part.toolName === 'mastra_workspace_glob' || part.toolName === 'glob_search';
  const bashErrorData = hasResult && isError && isBashTool ? detectShResult(part.result) : null;
  // If the tool already has a result, it was already approved/executed in a prior
  // session — don't re-show the approval modal on conversation reload.
  const isPlanApproval = part.toolName === 'exit_plan_mode';

  // Extract plan content and filename from exit_plan_mode args
  const planArgs = isPlanApproval && part.args && typeof part.args === 'object' ? part.args as Record<string, unknown> : null;
  const planContent = planArgs?.planContent ? String(planArgs.planContent) : null;
  const planFileName = planArgs?.planTitle
    ? String(planArgs.planTitle).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) + '.md'
    : (part.result && typeof part.result === 'object' && (part.result as Record<string, unknown>).planName)
      ? String((part.result as Record<string, unknown>).planName)
      : null;

  const handleApprove = useCallback(async () => {
    setLocalApproval('approved');
    void app.agent.approveToolCall(part.approvalId ?? part.toolCallId);
    // Bridge: create a task queue entry from approved plan
    if (isPlanApproval && planContent) {
      const task = await onPlanApproved?.({
        title: planArgs?.planTitle ? String(planArgs.planTitle) : 'Untitled Plan',
        description: planContent,
        planFileName: planFileName ?? undefined,
        toolCallId: part.toolCallId,
      });
      if (task?.id) {
        setCreatedTaskIdLocal(task.id);
      }
    }
    refocusComposer();
  }, [part.toolCallId, part.approvalId, isPlanApproval, planContent, planArgs?.planTitle, planFileName, onPlanApproved]);

  const handleReject = useCallback(() => {
    setLocalApproval('rejected');
    void app.agent.rejectToolCall(part.approvalId ?? part.toolCallId);
    refocusComposer();
  }, [part.toolCallId, part.approvalId]);

  const handleDismiss = useCallback(() => {
    setLocalApproval('dismissed');
    void app.agent.dismissToolCall(part.approvalId ?? part.toolCallId);
    refocusComposer();
  }, [part.toolCallId, part.approvalId]);

  const handleFeedbackSubmit = useCallback(() => {
    if (!feedbackText.trim()) return;
    setLocalApproval('rejected');
    void app.agent.rejectToolCall(part.approvalId ?? part.toolCallId);
    onSendFeedback?.(feedbackText.trim());
    setFeedbackText('');
    refocusComposer();
  }, [part.toolCallId, part.approvalId, feedbackText, onSendFeedback]);

  const summary = getToolSummary(part);
  const subtitle = getToolSubtitle(part);
  const miniPreview = getMiniCodePreview(part);
  // Use result shape to drive rendering — works regardless of tool name
  // isEdit takes priority: a plain-string result from edit tools would otherwise
  // match the sh shape detector (detectShResult accepts any non-empty string).
  const isBash = !isEditTool && !isReadTool && !isGrepToolName && !isGlobToolName && (smartResult?.type === 'sh' || isBashTool);
  const isEdit = isEditTool;
  const isFileRead = isReadTool || smartResult?.type === 'file_read';
  const isGrepTool = isGrepToolName;
  const isGlobTool = isGlobToolName;

  const ToolIcon = getToolIcon(part.toolName);
  const iconColor = getToolIconColor(part.toolName);

  return (
    <div className="text-sm min-w-0 flex-1">
      {/* Header row — clickable toggle */}
      <button
        type="button"
        className="group/tool flex w-full items-center gap-2 py-1 hover:bg-muted/40 rounded-md px-1.5 -mx-1.5 transition-colors text-left"
        onClick={() => setExpanded(!expanded)}
      >
        {/* Tool icon chip */}
        <span className={`shrink-0 flex items-center justify-center w-5 h-5 rounded ${iconColor}`}>
          <ToolIcon className="w-3 h-3" />
        </span>

        {/* Tool name */}
        <span className="font-medium text-xs text-foreground whitespace-nowrap shrink-0">{getToolLabel(part.toolName)}</span>

        {/* Separator dot */}
        {summary && <span className="text-muted-foreground/30 text-[10px] shrink-0">·</span>}

        {/* Inline arg summary */}
        {summary && (
          <span className="text-xs text-muted-foreground/70 truncate min-w-0 font-mono leading-none">{summary}</span>
        )}

        {/* Spacer */}
        <span className="flex-1" />

        {/* Status indicators */}
        {isHung && (
          <span className="text-[10px] font-semibold text-amber-500 shrink-0 tracking-wide">HUNG</span>
        )}
        {isSummarizing && (
          <span className="text-[10px] text-amber-500 animate-pulse shrink-0">Summarizing…</span>
        )}

        {/* Elapsed badge — always visible when running, hover-only when done */}
        <span className={`shrink-0 transition-opacity ${isRunning ? 'opacity-100' : 'opacity-0 group-hover/tool:opacity-100'}`}>
          <ToolElapsedBadge
            isRunning={isRunning}
            isError={Boolean(isError)}
            isHung={isHung}
            startedAt={part.startedAt}
            finishedAt={part.finishedAt}
            durationMs={part.durationMs}
          />
        </span>

        {/* Expand chevron */}
        <ChevronIcon expanded={expanded} />
      </button>

      {/* Subtitle line — always visible */}
      {subtitle && (
        <div className="text-[11px] text-muted-foreground/50 pl-1.5 leading-snug -mt-0.5 mb-0.5">{subtitle}</div>
      )}

      {/* Mini code preview for Write/Edit tools — hidden when EditInlineView is shown */}
      {miniPreview && !isEdit && (
        <MiniCodePreview lines={miniPreview.lines} language={miniPreview.language} />
      )}

      {/* Ask user questionnaire UI */}
      {isPendingApproval && isAskUser && (
        <QuestionnaireView
          toolCallId={part.approvalId ?? part.toolCallId}
          args={part.args}
          onSubmit={() => setLocalApproval('approved')}
          onCancel={handleDismiss}
        />
      )}
      {!isPendingApproval && isAskUser && approvalStatus !== 'dismissed' && (approvalStatus === 'approved' || hasResult) && (
        <div className="ml-1 mt-1 flex items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400">
          <CheckIcon className="h-3 w-3" />
          <span>Answered</span>
        </div>
      )}
      {!isPendingApproval && isAskUser && approvalStatus === 'dismissed' && (
        <div className="ml-1 mt-1 flex items-center gap-1.5 text-xs text-red-500 dark:text-red-400">
          <XIcon className="h-3 w-3" />
          <span>Dismissed</span>
        </div>
      )}
      {/* Tool approval — plan mode exit: "Kai's Plan" card */}
      {isPlanApproval && planContent && (
        <PlanApprovalCard
          planContent={planContent}
          planFileName={planFileName}
          isPendingApproval={isPendingApproval}
          approvalStatus={approvalStatus}
          feedbackText={feedbackText}
          onFeedbackChange={setFeedbackText}
          onApprove={handleApprove}
          onReject={handleReject}
          onDismiss={handleDismiss}
          onFeedbackSubmit={handleFeedbackSubmit}
          onOpenPlan={onOpenPlan}
          showFeedback={Boolean(onSendFeedback)}
          createdTaskId={createdTaskId}
          hasResult={hasResult}
          isError={isError}
        />
      )}
      {/* Fallback: plan approval without planContent (legacy/edge case) */}
      {isPendingApproval && isPlanApproval && !planContent && (
        <div className="ml-1 mt-2 rounded-xl border border-primary/30 bg-primary/5 p-3 space-y-3">
          <div className="flex items-center gap-2">
            <ScrollTextIcon className="h-4 w-4 shrink-0 text-primary" />
            <span className="text-xs font-medium text-foreground">Accept this plan?</span>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleApprove}
              className="rounded-lg bg-primary px-3 py-1.5 text-[11px] font-medium text-primary-foreground transition-colors hover:bg-primary/90"
            >
              Yes, implement this plan
            </button>
            <button
              type="button"
              onClick={handleReject}
              className="rounded-lg border border-border/70 bg-card px-3 py-1.5 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted/50"
            >
              No, keep planning
            </button>
          </div>
        </div>
      )}
      {/* Tool approval — generic confirm-writes mode */}
      {isPendingApproval && !isPlanApproval && !isAskUser && (
        <div className="ml-1 mt-1.5 flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2">
          <AlertTriangleIcon className="h-3.5 w-3.5 shrink-0 text-amber-500" />
          <span className="flex-1 text-xs text-amber-700 dark:text-amber-400">Requires approval to execute</span>
          <button
            type="button"
            onClick={handleReject}
            className="rounded-md border border-border/70 bg-card px-2.5 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
          >
            Reject
          </button>
          <button
            type="button"
            onClick={handleApprove}
            className="rounded-md bg-primary px-2.5 py-1 text-[11px] font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Approve
          </button>
        </div>
      )}
      {!isPendingApproval && (approvalStatus === 'approved' || (part.approvalStatus === 'pending' && hasResult)) && !isAskUser && !(isPlanApproval && planContent) && (
        <div className="ml-1 mt-1 flex items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400">
          <CheckIcon className="h-3 w-3" />
          <span>{isPlanApproval ? 'Plan accepted — implementing' : 'Approved'}</span>
        </div>
      )}
      {approvalStatus === 'rejected' && !isAskUser && !(isPlanApproval && planContent) && (
        <div className="ml-1 mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
          <SquareIcon className="h-3 w-3" />
          <span>{isPlanApproval ? 'Continuing to plan' : 'Rejected'}</span>
        </div>
      )}

      {/* Todo items — always visible */}
      {todoItems && <TodoListView items={todoItems} />}

      {/* Collapsible tool content — expanded by default */}
      {expanded && (isBash ? (
        <BashInlineView part={part} isRunning={isRunning} isError={Boolean(isError)} />
      ) : isEdit ? (
        <EditInlineView part={part} isRunning={isRunning} isError={Boolean(isError)} />
      ) : isFileRead ? (
        <ReadInlineView part={part} isRunning={isRunning} />
      ) : isGrepTool ? (
        <GrepInlineView part={part} isRunning={isRunning} />
      ) : isGlobTool ? (
        <GlobInlineView part={part} isRunning={isRunning} />
      ) : (
        <div className="tool-detail-code ml-5 mt-1 mb-2 pl-3">
          {/* Running spinner */}
          {isRunning && !isSummarizing && (
            <div className="py-1.5">
              <div className="flex items-center gap-2">
                <LoaderIcon className="h-3.5 w-3.5 animate-spin text-blue-500" />
                <span className="text-xs text-blue-600 dark:text-blue-400">Running…</span>
              </div>
            </div>
          )}

          {/* AI summarization in progress */}
          {isSummarizing && (
            <div className="py-1.5">
              <div className="flex items-center gap-2">
                <ScissorsIcon className="h-3.5 w-3.5 animate-pulse text-amber-500" />
                <span className="text-xs text-amber-600 dark:text-amber-400">Summarizing large output...</span>
              </div>
            </div>
          )}

          {hasLiveOutput && (
            <ToolSection title="Live Output">
              <CodeBlock code={formatLiveOutput(part.liveOutput)} language="text" />
            </ToolSection>
          )}

          {/* Result section — with compacted/original toggle when available */}
          {hasResult && (
            <ToolSection
              title={isError ? 'Error' : 'Result'}
              badge={canShowOriginal ? (
                <CompactionToggle showOriginal={showOriginal} onToggle={() => setShowOriginal(!showOriginal)} />
              ) : undefined}
            >
              {/* Media preview for image/video/audio generation results */}
              {mediaResult && <MediaPreview media={mediaResult} />}
              {/* Smart result rendering for known tool shapes, or fallback to raw JSON */}
              {!isError && !(canShowOriginal && showOriginal) && smartResult ? (
                <SmartResultView part={part} />
              ) : (
                <CodeBlock
                  code={formatResult(canShowOriginal && showOriginal ? part.originalResult : part.result)}
                  language="json"
                  isError={isError}
                />
              )}
            </ToolSection>
          )}
        </div>
      ))}
    </div>
  );
};

/* ── Questionnaire UI for ask_user tool ── */

type QuestionOption = { label: string; description?: string };
type Question = { question: string; header: string; options: QuestionOption[]; multiSelect?: boolean };

function parseQuestions(args: unknown): Question[] {
  if (!args || typeof args !== 'object') return [];
  const a = args as Record<string, unknown>;
  if (!Array.isArray(a.questions)) return [];
  return (a.questions as Array<Record<string, unknown>>).map((q) => ({
    question: String(q.question ?? ''),
    header: String(q.header ?? ''),
    options: Array.isArray(q.options) ? (q.options as Array<Record<string, unknown>>).map((o) => ({
      label: String(o.label ?? ''),
      description: typeof o.description === 'string' ? o.description : undefined,
    })) : [],
    multiSelect: q.multiSelect === true,
  }));
}

const QuestionnaireView: FC<{
  toolCallId: string;
  args: unknown;
  onSubmit: () => void;
  onCancel: () => void;
}> = ({ toolCallId, args, onSubmit, onCancel }) => {
  const questions = parseQuestions(args);
  const [activeTab, setActiveTab] = useState(0);
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [otherTexts, setOtherTexts] = useState<Record<number, string>>({});

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCancel();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onCancel]);

  const handleSelect = useCallback((qIdx: number, value: string) => {
    setAnswers((prev) => ({ ...prev, [qIdx]: value }));
    // Clear "other" text when a predefined option is selected
    if (value !== '__other__') {
      setOtherTexts((prev) => { const next = { ...prev }; delete next[qIdx]; return next; });
      // Auto-advance to the next tab after a brief delay
      if (qIdx < questions.length - 1) {
        setTimeout(() => setActiveTab(qIdx + 1), 180);
      }
    }
  }, [questions.length]);

  const handleOtherText = useCallback((qIdx: number, text: string) => {
    setOtherTexts((prev) => ({ ...prev, [qIdx]: text }));
    setAnswers((prev) => ({ ...prev, [qIdx]: '__other__' }));
  }, []);

  const handleSubmit = useCallback(() => {
    const result: Record<string, string> = {};
    questions.forEach((q, i) => {
      const answer = answers[i];
      if (answer === '__other__') {
        result[q.question] = otherTexts[i] ?? '';
      } else if (answer) {
        result[q.question] = answer;
      }
    });
    void app.agent.answerToolQuestion(toolCallId, result);
    onSubmit();
    refocusComposer();
  }, [toolCallId, questions, answers, otherTexts, onSubmit]);

  if (questions.length === 0) return null;

  const active = questions[activeTab];
  const hasAllAnswers = questions.every((_, i) => {
    const a = answers[i];
    return a && (a !== '__other__' || otherTexts[i]?.trim());
  });

  return (
    <div className="ml-1 mt-2 rounded-xl border border-primary/30 bg-primary/5 overflow-hidden">
      {/* Header — tabs (if multiple questions) + close button */}
      <div className="flex items-center border-b border-border/30">
        {questions.length > 1 && (
          <div className="flex flex-1 min-w-0">
            {questions.map((q, i) => {
              const isAnswered = answers[i] && (answers[i] !== '__other__' || otherTexts[i]?.trim());
              return (
                <button
                  key={i}
                  type="button"
                  onClick={() => setActiveTab(i)}
                  className={`relative flex items-center gap-1.5 px-3 py-2 text-[11px] font-medium transition-colors ${
                    i === activeTab
                      ? 'text-primary border-b-2 border-primary -mb-px'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {isAnswered && <CheckIcon className="h-2.5 w-2.5 text-emerald-500" />}
                  {q.header}
                </button>
              );
            })}
          </div>
        )}
        {questions.length === 1 && <div className="flex-1" />}
        <button
          type="button"
          onClick={onCancel}
          className="shrink-0 p-2 mr-1 text-muted-foreground hover:text-foreground transition-colors"
          aria-label="Cancel"
        >
          <XIcon className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Active question content */}
      <div className="p-3 space-y-3">
        <p className="text-xs font-medium text-foreground">{active.question}</p>

        {/* Options */}
        <div className="space-y-1.5">
          {active.options.map((opt) => {
            const isSelected = answers[activeTab] === opt.label;
            return (
              <button
                key={opt.label}
                type="button"
                onClick={() => handleSelect(activeTab, opt.label)}
                className={`flex w-full items-start gap-2.5 rounded-lg border px-3 py-2 text-left transition-colors ${
                  isSelected
                    ? 'border-primary/50 bg-primary/10'
                    : 'border-border/40 bg-card/50 hover:border-border/70 hover:bg-muted/30'
                }`}
              >
                <span className={`mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border ${
                  isSelected
                    ? 'border-primary bg-primary'
                    : 'border-muted-foreground/40'
                }`}>
                  {isSelected && <span className="block h-1.5 w-1.5 rounded-full bg-primary-foreground" />}
                </span>
                <div className="min-w-0 flex-1">
                  <span className="text-xs font-medium text-foreground">{opt.label}</span>
                  {opt.description && (
                    <p className="mt-0.5 text-[11px] text-muted-foreground leading-snug">{opt.description}</p>
                  )}
                </div>
              </button>
            );
          })}

          {/* Other option */}
          <button
            type="button"
            onClick={() => handleSelect(activeTab, '__other__')}
            className={`flex w-full items-start gap-2.5 rounded-lg border px-3 py-2 text-left transition-colors ${
              answers[activeTab] === '__other__'
                ? 'border-primary/50 bg-primary/10'
                : 'border-border/40 bg-card/50 hover:border-border/70 hover:bg-muted/30'
            }`}
          >
            <span className={`mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border ${
              answers[activeTab] === '__other__'
                ? 'border-primary bg-primary'
                : 'border-muted-foreground/40'
            }`}>
              {answers[activeTab] === '__other__' && <span className="block h-1.5 w-1.5 rounded-full bg-primary-foreground" />}
            </span>
            <span className="text-xs font-medium text-muted-foreground">Other</span>
          </button>

          {/* Other text input */}
          {answers[activeTab] === '__other__' && (
            <input
              type="text"
              autoFocus
              value={otherTexts[activeTab] ?? ''}
              onChange={(e) => handleOtherText(activeTab, e.target.value)}
              placeholder="Tell Kai what to do instead"
              className="w-full rounded-lg border border-border/50 bg-background px-3 py-1.5 text-xs text-foreground placeholder:text-muted-foreground/50 outline-none focus:ring-1 focus:ring-primary/40"
            />
          )}
        </div>

        {/* Submit button */}
        <button
          type="button"
          onClick={handleSubmit}
          disabled={!hasAllAnswers}
          className="w-full rounded-lg bg-primary px-4 py-1.5 text-[11px] font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-30 disabled:cursor-not-allowed"
        >
          Submit answers
        </button>
      </div>
    </div>
  );
};

/* ── Plan Approval Card ── */

const PlanApprovalCard: FC<{
  planContent: string;
  planFileName: string | null;
  isPendingApproval: boolean;
  approvalStatus: 'pending' | 'approved' | 'rejected' | 'dismissed' | undefined;
  feedbackText: string;
  onFeedbackChange: (text: string) => void;
  onApprove: () => void;
  onReject: () => void;
  onDismiss: () => void;
  onFeedbackSubmit: () => void;
  onOpenPlan?: (content: string, filePath?: string) => void;
  showFeedback: boolean;
  createdTaskId?: string | null;
  hasResult: boolean;
  isError: boolean;
}> = ({ planContent, planFileName, isPendingApproval, approvalStatus, feedbackText, onFeedbackChange, onApprove, onReject, onDismiss, onFeedbackSubmit, onOpenPlan, showFeedback, createdTaskId, hasResult, isError }) => {

  const handleOpenPlan = useCallback(() => {
    onOpenPlan?.(planContent, planFileName ?? undefined);
  }, [planContent, planFileName, onOpenPlan]);

  const handleViewTask = useCallback(() => {
    if (createdTaskId) {
      window.dispatchEvent(new CustomEvent('kai:open-task', { detail: { taskId: createdTaskId } }));
    }
  }, [createdTaskId]);

  useEffect(() => {
    if (!isPendingApproval) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onDismiss();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [isPendingApproval, onDismiss]);

  return (
    <div className="ml-1 mt-2 rounded-xl border border-primary/30 bg-primary/5 p-3 space-y-3">
      {/* Header: "Kai's Plan" + filename link + close */}
      <div className="flex items-center gap-2">
        <ScrollTextIcon className="h-4 w-4 shrink-0 text-primary" />
        <span className="text-xs font-semibold text-foreground">Kai&apos;s Plan</span>
        {planFileName && (
          <button
            type="button"
            onClick={handleOpenPlan}
            className="flex items-center gap-1 text-xs text-primary hover:text-primary/80 transition-colors"
          >
            <FileTextIcon className="h-3 w-3" />
            <span className="underline underline-offset-2">{planFileName}</span>
          </button>
        )}
        {isPendingApproval && (
          <button
            type="button"
            onClick={onDismiss}
            className="ml-auto shrink-0 p-1 mr-1 text-muted-foreground hover:text-foreground transition-colors"
            aria-label="Dismiss plan"
          >
            <XIcon className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {/* Approval buttons */}
      {isPendingApproval && (
        <>
          <div className="text-[11px] text-muted-foreground">
            Review the plan in the side panel, then accept or reject.
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={onApprove}
              className="rounded-lg bg-primary px-3 py-1.5 text-[11px] font-medium text-primary-foreground transition-colors hover:bg-primary/90"
            >
              Yes, implement this plan
            </button>
            <button
              type="button"
              onClick={onReject}
              className="rounded-lg border border-border/70 bg-card px-3 py-1.5 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted/50"
            >
              No, keep planning
            </button>
          </div>
          {showFeedback && (
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={feedbackText}
                onChange={(e) => onFeedbackChange(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') onFeedbackSubmit(); }}
                placeholder="Tell Kai what to do instead"
                className="flex-1 rounded-lg border border-border/50 bg-background px-3 py-1.5 text-xs text-foreground placeholder:text-muted-foreground/50 outline-none focus:ring-1 focus:ring-primary/40"
              />
              <button
                type="button"
                onClick={onFeedbackSubmit}
                disabled={!feedbackText.trim()}
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-30 disabled:cursor-not-allowed"
              >
                <SendHorizontalIcon className="h-3 w-3" />
              </button>
            </div>
          )}
        </>
      )}

      {/* Post-approval states — show "accepted" when explicitly approved OR when the tool
          completed successfully (has a result and no error), which means it was approved in a
          prior session even if approvalStatus wasn't persisted as 'approved'. */}
      {(approvalStatus === 'approved' || (hasResult && !isError)) && (
        <div className="flex items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400">
          <CheckIcon className="h-3 w-3" />
          <span>Plan accepted — added to Task Queue</span>
          {createdTaskId && (
            <button
              type="button"
              onClick={handleViewTask}
              className="ml-1 inline-flex items-center gap-1 text-xs font-medium text-primary hover:text-primary/80 transition-colors underline underline-offset-2"
            >
              View Task
              <ExternalLinkIcon className="h-3 w-3" />
            </button>
          )}
        </div>
      )}
      {approvalStatus === 'rejected' && (
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <CircleIcon className="h-2.5 w-2.5 fill-yellow-400 text-yellow-400" />
          <span>Planning resumed</span>
        </div>
      )}
      {approvalStatus === 'dismissed' && (
        <div className="flex items-center gap-1.5 text-xs text-red-500 dark:text-red-400">
          <XIcon className="h-3 w-3" />
          <span>Plan dismissed</span>
        </div>
      )}
    </div>
  );
};

/* ── Todo List Detection & Rendering ── */

type TodoItem = {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
};

/** Detect if tool args or result contains a todo list */
function detectTodoItems(part: ToolCallPart): TodoItem[] | null {
  // Check args.todos (e.g. a TodoWrite-style tool)
  const args = part.args as Record<string, unknown> | null;
  if (args?.todos && Array.isArray(args.todos)) {
    const items = args.todos as Array<Record<string, unknown>>;
    if (items.length > 0 && items.every((t) => typeof t.content === 'string' && typeof t.status === 'string')) {
      return items.map((t) => ({ content: String(t.content), status: String(t.status) as TodoItem['status'] }));
    }
  }

  // Check result.todos or result as array
  const result = part.result;
  if (result && typeof result === 'object') {
    const r = result as Record<string, unknown>;
    const candidates = Array.isArray(r.todos) ? r.todos : Array.isArray(result) ? result : null;
    if (candidates && candidates.length > 0) {
      const items = candidates as Array<Record<string, unknown>>;
      if (items.every((t) => typeof t.content === 'string' && typeof t.status === 'string')) {
        return items.map((t) => ({ content: String(t.content), status: String(t.status) as TodoItem['status'] }));
      }
    }
  }

  return null;
}

const TodoItemIcon: FC<{ status: TodoItem['status'] }> = ({ status }) => {
  if (status === 'completed') return <CheckIcon className="h-3.5 w-3.5 shrink-0 text-emerald-500" />;
  if (status === 'in_progress') return <AsteriskIcon className="h-3.5 w-3.5 shrink-0 text-amber-500" />;
  return <SquareIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground/40" />;
};

const TodoListView: FC<{ items: TodoItem[] }> = ({ items }) => (
  <div className="ml-5 mt-1 mb-1 space-y-0.5">
    {items.map((item, i) => (
      <div
        key={`${item.content}-${i}`}
        className={`flex items-center gap-2.5 py-0.5 text-xs ${
          item.status === 'completed'
            ? 'line-through text-muted-foreground'
            : item.status === 'in_progress'
              ? 'text-foreground'
              : 'text-foreground/80'
        }`}
      >
        <TodoItemIcon status={item.status} />
        <span>{item.content}</span>
      </div>
    ))}
  </div>
);

/* ── Media Result Detection & Preview ── */

type MediaResult = {
  type: 'image' | 'video';
  urls: string[];
  filePaths?: string[];
};

function detectMediaResult(result: unknown): MediaResult | null {
  if (!result || typeof result !== 'object') return null;
  const r = result as Record<string, unknown>;

  if (r.type === 'image_generation_result') {
    const images = Array.isArray(r.images) ? r.images as Array<Record<string, unknown>> : [];
    const urls = images.map((img) => String(img.url ?? '')).filter(Boolean);
    const filePaths = images.map((img) => String(img.filePath ?? '')).filter(Boolean);
    return urls.length > 0 ? { type: 'image', urls, filePaths } : null;
  }

  if (r.type === 'video_generation_result') {
    const url = typeof r.url === 'string' ? r.url : '';
    const filePath = typeof r.filePath === 'string' ? r.filePath : '';
    return url ? { type: 'video', urls: [url], filePaths: filePath ? [filePath] : [] } : null;
  }

  return null;
}

const MediaPreview: FC<{ media: MediaResult }> = ({ media }) => {
  const handleSave = useCallback((url: string) => {
    // Extract filename from the URL for the save dialog suggestion
    const filename = url.split('/').pop() ?? undefined;
    app.image.save(url, filename);
  }, []);

  if (media.type === 'image') {
    return (
      <div className="mb-2 space-y-2">
        {media.urls.map((url, i) => (
          <div key={url} className="relative group inline-block">
            <img
              src={url}
              alt={`Generated image${media.urls.length > 1 ? ` ${i + 1}` : ''}`}
              className="max-w-md max-h-96 rounded-lg object-contain"
              loading="lazy"
            />
            {media.filePaths?.[i] && (
              <Tooltip content="Save image" side="top">
                <button
                  type="button"
                  onClick={() => handleSave(url)}
                  className="absolute top-2 right-2 opacity-100 md:opacity-0 md:group-hover:opacity-80 transition-opacity bg-black/60 hover:bg-black/80 text-white rounded-md p-1.5"
                >
                  <DownloadIcon className="h-3.5 w-3.5" />
                </button>
              </Tooltip>
            )}
          </div>
        ))}
      </div>
    );
  }

  if (media.type === 'video') {
    return (
      <div className="mb-2 relative group inline-block">
        <video
          src={media.urls[0]}
          controls
          className="max-w-md max-h-96 rounded-lg"
          preload="metadata"
        />
        {media.filePaths?.[0] && (
          <Tooltip content="Save video" side="top">
            <button
              type="button"
              onClick={() => handleSave(media.urls[0])}
              className="absolute top-2 right-2 opacity-100 md:opacity-0 md:group-hover:opacity-80 transition-opacity bg-black/60 hover:bg-black/80 text-white rounded-md p-1.5"
            >
              <DownloadIcon className="h-3.5 w-3.5" />
            </button>
          </Tooltip>
        )}
      </div>
    );
  }

  return null;
};

/* ── Smart Result Detection & Rendering ── */

type FileReadData = {
  content: string;
  path: string;
  totalLines?: number;
  truncated?: boolean;
};

type GlobData = {
  files: string[];
  count: number;
  basePath: string;
};

type ListDirItem = {
  name: string;
  type: 'file' | 'directory' | 'unknown';
  size: number;
  modified: string;
};

type ListDirData = {
  items: ListDirItem[];
  count: number;
  path: string;
};

type ShData = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
};

function detectFileReadResult(result: unknown): FileReadData | null {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return null;
  const r = result as Record<string, unknown>;
  if (typeof r.content === 'string' && typeof r.path === 'string') {
    return {
      content: r.content as string,
      path: r.path as string,
      totalLines: typeof r.totalLines === 'number' ? r.totalLines : undefined,
      truncated: r.truncated === true,
    };
  }
  return null;
}

function detectGlobResult(result: unknown): GlobData | null {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return null;
  const r = result as Record<string, unknown>;
  if (Array.isArray(r.files) && typeof r.count === 'number') {
    return {
      files: (r.files as unknown[]).map(String),
      count: r.count as number,
      basePath: typeof r.path === 'string' ? r.path as string : '',
    };
  }
  return null;
}

function detectListDirResult(result: unknown): ListDirData | null {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return null;
  const r = result as Record<string, unknown>;
  if (Array.isArray(r.items) && typeof r.count === 'number' && typeof r.path === 'string') {
    const items = (r.items as Array<Record<string, unknown>>).map((item) => ({
      name: String(item.name ?? ''),
      type: (item.type === 'directory' || item.type === 'file' ? item.type : 'unknown') as ListDirItem['type'],
      size: typeof item.size === 'number' ? item.size : 0,
      modified: typeof item.modified === 'string' ? item.modified : '',
    }));
    return { items, count: r.count as number, path: r.path as string };
  }
  return null;
}

function detectShResult(result: unknown): ShData | null {
  if (typeof result === 'string' && result.length > 0) {
    return { stdout: result, stderr: '', exitCode: null };
  }
  if (!result || typeof result !== 'object' || Array.isArray(result)) return null;
  const r = result as Record<string, unknown>;
  if (typeof r.stdout === 'string' || typeof r.stderr === 'string' || typeof r.output === 'string') {
    return {
      stdout: String(r.stdout ?? r.output ?? ''),
      stderr: String(r.stderr ?? ''),
      exitCode: typeof r.exitCode === 'number' ? r.exitCode : null,
    };
  }
  return null;
}

/** Detect the smart result type for a tool call — shape-based, not tool-name-gated */
function detectSmartResult(part: ToolCallPart): { type: 'file_read'; data: FileReadData } | { type: 'glob'; data: GlobData } | { type: 'list_dir'; data: ListDirData } | { type: 'sh'; data: ShData } | null {
  const result = sanitizeResultForDisplay(part.result);

  // file_read: detect by shape (content + path) first, then by known tool names
  const fileReadData = detectFileReadResult(result);
  if (fileReadData) return { type: 'file_read', data: fileReadData };

  // glob: detect by shape (files array + count)
  const globData = detectGlobResult(result);
  if (globData) return { type: 'glob', data: globData };

  // list_dir: detect by shape (items array + count + path)
  const listDirData = detectListDirResult(result);
  if (listDirData) return { type: 'list_dir', data: listDirData };

  // sh: detect by shape (stdout/stderr/exitCode or plain string)
  const shData = detectShResult(result);
  if (shData) return { type: 'sh', data: shData };

  return null;
}

/* ── File extension → language mapping ── */

const EXT_LANG_MAP: Record<string, string> = {
  ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'jsx',
  json: 'json', json5: 'json5', jsonc: 'json',
  py: 'python', rb: 'ruby', rs: 'rust', go: 'go', java: 'java',
  kt: 'kotlin', swift: 'swift', c: 'c', cpp: 'cpp', h: 'c', hpp: 'cpp',
  cs: 'csharp', php: 'php', lua: 'lua', r: 'r', scala: 'scala',
  sh: 'bash', bash: 'bash', zsh: 'bash', fish: 'bash',
  sql: 'sql', graphql: 'graphql', gql: 'graphql',
  html: 'html', htm: 'html', xml: 'xml', svg: 'xml',
  css: 'css', scss: 'scss', less: 'less', sass: 'sass',
  md: 'markdown', mdx: 'mdx', yaml: 'yaml', yml: 'yaml', toml: 'toml',
  dockerfile: 'dockerfile', makefile: 'makefile',
  env: 'bash', ini: 'ini', conf: 'ini', cfg: 'ini',
};

function langFromPath(filePath: string): string {
  const name = filePath.split('/').pop()?.toLowerCase() ?? '';
  // Handle dotfiles and special names
  if (name === 'dockerfile' || name === 'containerfile') return 'dockerfile';
  if (name === 'makefile' || name === 'gnumakefile') return 'makefile';
  if (name.startsWith('.env')) return 'bash';
  const ext = name.includes('.') ? name.split('.').pop() ?? '' : '';
  return EXT_LANG_MAP[ext] || 'text';
}

/* ── Clickable file path helper ── */

const ClickablePath: FC<{ path: string; className?: string }> = ({ path, className }) => {
  const handleClick = useCallback(() => {
    app.shell.openPath(path);
  }, [path]);

  const fileName = path.split('/').pop() ?? path;
  const dirPath = path.slice(0, path.length - fileName.length);

  return (
    <Tooltip content={`Open ${path}`} side="top">
      <button
        type="button"
        onClick={handleClick}
        className={`group/path inline-flex items-center gap-1 text-left hover:underline decoration-muted-foreground/40 transition-colors ${className ?? ''}`}
      >
        <ExternalLinkIcon className="h-2.5 w-2.5 shrink-0 opacity-0 group-hover/path:opacity-60 transition-opacity" />
        {dirPath && <span className="text-muted-foreground/60 truncate">{dirPath}</span>}
        <span className="font-medium">{fileName}</span>
      </button>
    </Tooltip>
  );
};

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/* ── Specialized Result Components ── */

const MARKDOWN_EXTENSIONS = new Set(['md', 'mdx', 'markdown']);

function isMarkdownFile(filePath: string): boolean {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  return MARKDOWN_EXTENSIONS.has(ext);
}

const FileReadResultView: FC<{ data: FileReadData }> = ({ data }) => {
  const isMd = isMarkdownFile(data.path);
  const [showSource, setShowSource] = useState(false);

  return (
    <div>
      <div className="flex items-center gap-2 mb-1.5">
        <FileIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <ClickablePath path={data.path} className="text-xs text-foreground/80" />
        {data.totalLines != null && (
          <span className="text-[10px] text-muted-foreground ml-auto shrink-0">
            {data.totalLines} lines{data.truncated ? ' (truncated)' : ''}
          </span>
        )}
      </div>
      {isMd ? (
        <>
          <div className={showSource ? 'hidden' : ''}>
            <div className="tool-detail-markdown group/md relative rounded-md shiki-bg px-4 py-3 max-h-[400px] overflow-y-auto">
              <MarkdownText text={data.content} />
              <Tooltip content="Show source" side="top">
                <button
                  type="button"
                  onClick={() => setShowSource(true)}
                  className="sticky bottom-0 float-right h-6 w-6 p-0 inline-flex items-center justify-center rounded opacity-100 md:opacity-0 md:group-hover/md:opacity-100 transition-opacity bg-background/80 backdrop-blur-sm text-muted-foreground hover:text-foreground hover:bg-accent z-10"
                >
                  <CodeIcon className="h-3 w-3" />
                </button>
              </Tooltip>
            </div>
          </div>
          <div className={showSource ? '' : 'hidden'}>
            <CodeBlock
              code={data.content}
              language={langFromPath(data.path)}
              maxHeight="400px"
              extraActions={
                <Tooltip content="Show rendered" side="top">
                  <button
                    type="button"
                    onClick={() => setShowSource(false)}
                    className="h-6 w-6 p-0 inline-flex items-center justify-center rounded opacity-100 md:opacity-0 md:group-hover/code:opacity-100 transition-opacity bg-background/80 backdrop-blur-sm text-muted-foreground hover:text-foreground hover:bg-accent"
                  >
                    <BookOpenIcon className="h-3 w-3" />
                  </button>
                </Tooltip>
              }
            />
          </div>
        </>
      ) : (
        <CodeBlock code={data.content} language={langFromPath(data.path)} maxHeight="400px" />
      )}
    </div>
  );
};

const GlobResultView: FC<{ data: GlobData }> = ({ data }) => {
  const [showAll, setShowAll] = useState(false);
  const LIMIT = 20;
  const visible = showAll ? data.files : data.files.slice(0, LIMIT);
  const hasMore = data.files.length > LIMIT;

  return (
    <div>
      <div className="flex items-center gap-2 mb-1.5">
        <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
          {data.count} {data.count === 1 ? 'match' : 'matches'}
        </span>
        {data.basePath && (
          <span className="text-[10px] text-muted-foreground/60 truncate">in {data.basePath}</span>
        )}
      </div>
      <div className="space-y-0.5">
        {visible.map((filePath) => (
          <div key={filePath} className="flex items-center gap-1.5 py-0.5">
            <FileIcon className="h-3 w-3 shrink-0 text-muted-foreground/50" />
            <ClickablePath path={filePath} className="text-xs text-foreground/70" />
          </div>
        ))}
      </div>
      {hasMore && !showAll && (
        <button
          type="button"
          onClick={() => setShowAll(true)}
          className="mt-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
        >
          Show all {data.count} files...
        </button>
      )}
    </div>
  );
};

const ListDirResultView: FC<{ data: ListDirData }> = ({ data }) => {
  const sorted = [...data.items].sort((a, b) => {
    if (a.type === 'directory' && b.type !== 'directory') return -1;
    if (a.type !== 'directory' && b.type === 'directory') return 1;
    return a.name.localeCompare(b.name);
  });
  const [showAll, setShowAll] = useState(false);
  const LIMIT = 25;
  const visible = showAll ? sorted : sorted.slice(0, LIMIT);
  const hasMore = sorted.length > LIMIT;

  return (
    <div>
      <div className="flex items-center gap-2 mb-1.5">
        <FolderIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <ClickablePath path={data.path} className="text-xs text-foreground/80" />
        <span className="text-[10px] text-muted-foreground ml-auto shrink-0">{data.count} items</span>
      </div>
      <div className="space-y-0">
        {visible.map((item) => {
          const isDir = item.type === 'directory';
          const fullPath = data.path.endsWith('/') ? data.path + item.name : `${data.path}/${item.name}`;
          return (
            <div key={item.name} className="flex items-center gap-2 py-0.5 text-xs">
              {isDir
                ? <FolderIcon className="h-3 w-3 shrink-0 text-blue-400/70" />
                : <FileIcon className="h-3 w-3 shrink-0 text-muted-foreground/50" />
              }
              <ClickablePath path={fullPath} className="text-foreground/70 min-w-0" />
              {!isDir && item.size > 0 && (
                <span className="text-[10px] text-muted-foreground/50 ml-auto shrink-0 tabular-nums">
                  {formatFileSize(item.size)}
                </span>
              )}
            </div>
          );
        })}
      </div>
      {hasMore && !showAll && (
        <button
          type="button"
          onClick={() => setShowAll(true)}
          className="mt-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
        >
          Show all {data.count} items...
        </button>
      )}
    </div>
  );
};

const ShResultView: FC<{ data: ShData }> = ({ data }) => (
  <div className="space-y-2">
    {data.exitCode != null && data.exitCode !== 0 && (
      <div className="flex items-center gap-1.5">
        <AlertTriangleIcon className="h-3 w-3 shrink-0 text-destructive" />
        <span className="text-[10px] font-semibold text-destructive">Exit code {data.exitCode}</span>
      </div>
    )}
    {data.stdout && (
      <div>
        {data.stderr && (
          <div className="flex items-center gap-1.5 mb-1">
            <TerminalIcon className="h-3 w-3 shrink-0 text-muted-foreground/50" />
            <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">stdout</span>
          </div>
        )}
        <CodeBlock code={data.stdout} language="text" maxHeight="400px" />
      </div>
    )}
    {data.stderr && (
      <div>
        <div className="flex items-center gap-1.5 mb-1">
          <AlertTriangleIcon className="h-3 w-3 shrink-0 text-amber-500/70" />
          <span className="text-[10px] font-semibold text-amber-600 dark:text-amber-400 uppercase tracking-wider">stderr</span>
        </div>
        <CodeBlock code={data.stderr} language="text" maxHeight="300px" isError />
      </div>
    )}
    {!data.stdout && !data.stderr && (
      <span className="text-xs text-muted-foreground italic">No output</span>
    )}
  </div>
);

/** Renders a smart result view if the tool result matches a known shape, otherwise returns null */
const SmartResultView: FC<{ part: ToolCallPart }> = ({ part }) => {
  const smart = detectSmartResult(part);
  if (!smart) return null;
  switch (smart.type) {
    case 'file_read': return <FileReadResultView data={smart.data} />;
    case 'glob': return <GlobResultView data={smart.data} />;
    case 'list_dir': return <ListDirResultView data={smart.data} />;
    case 'sh': return <ShResultView data={smart.data} />;
  }
};

const CompactionToggle: FC<{ showOriginal: boolean; onToggle: () => void }> = ({ showOriginal, onToggle }) => (
  <span
    role="switch"
    aria-checked={showOriginal}
    tabIndex={0}
    className="ml-auto text-[10px] font-medium px-1.5 py-0.5 rounded border border-amber-500/30 bg-amber-500/5 text-amber-600 dark:text-amber-400 hover:bg-amber-500/10 transition-colors cursor-pointer select-none"
    onClick={(e) => { e.stopPropagation(); onToggle(); }}
    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); e.preventDefault(); onToggle(); } }}
  >
    {showOriginal ? 'Show Compacted' : 'Show Original'}
  </span>
);

const ToolElapsedBadge: FC<{
  isRunning: boolean;
  isError: boolean;
  isHung?: boolean;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
}> = ({ isRunning, isError, isHung, startedAt, finishedAt, durationMs }) => {
  return (
    <ElapsedBadge
      startedAt={startedAt}
      finishedAt={finishedAt}
      durationMs={durationMs}
      isRunning={isRunning && !isHung}
      isError={isError || Boolean(isHung)}
      className="ml-auto"
    />
  );
};

/* ── Chevron helper ── */
const ChevronIcon: FC<{ expanded: boolean }> = ({ expanded }) => (
  <span className="shrink-0 text-muted-foreground/40 group-hover/tool:text-muted-foreground/70 transition-colors">
    {expanded ? <ChevronDownIcon className="w-3 h-3" /> : <ChevronRightIcon className="w-3 h-3" />}
  </span>
);

/* ── Portal helper — renders modals over the full app (document.body) ── */

function useModalPortalTarget(): HTMLElement {
  return useMemo(() => document.body, []);
}

/* ── File Content Modal (for Read tool) ── */

const FileContentModal: FC<{ part: ToolCallPart; onClose: () => void }> = ({ part, onClose }) => {
  const overlayRef = useRef<HTMLDivElement>(null);
  const smartResult = detectSmartResult(part);
  const fileData = smartResult?.type === 'file_read' ? smartResult.data : null;
  const portalTarget = useModalPortalTarget();

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return createPortal(
    <div
      ref={overlayRef}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      onClick={(e) => { if (e.target === overlayRef.current) onClose(); }}
    >
      <div className="relative flex flex-col w-full max-w-3xl max-h-[80vh] rounded-xl border border-border/50 bg-background shadow-2xl overflow-hidden">
        {/* Modal header */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-border/30 shrink-0">
          <FileTextIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
          {fileData ? (
            <ClickablePath path={fileData.path} className="text-sm text-foreground/80 min-w-0" />
          ) : (
            <span className="text-sm text-foreground/80">File contents</span>
          )}
          {fileData?.totalLines != null && (
            <span className="text-[10px] text-muted-foreground ml-auto shrink-0">
              {fileData.totalLines} lines{fileData.truncated ? ' (truncated)' : ''}
            </span>
          )}
          <button
            type="button"
            onClick={onClose}
            className="ml-auto shrink-0 p-1 text-muted-foreground hover:text-foreground transition-colors"
            aria-label="Close"
          >
            <XIcon className="h-4 w-4" />
          </button>
        </div>
        {/* Content */}
        <div className="overflow-y-auto flex-1 p-4">
          {fileData ? (
            <FileReadResultView data={fileData} />
          ) : (
            <CodeBlock
              code={formatResult(part.result)}
              language="text"
            />
          )}
        </div>
      </div>
    </div>,
    portalTarget,
  );
};

/* ── Bash Inline Terminal View ── */

const BashOutputModal: FC<{ command: string; shData: ShData; onClose: () => void }> = ({ command, shData, onClose }) => {
  const overlayRef = useRef<HTMLDivElement>(null);
  const portalTarget = useModalPortalTarget();

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return createPortal(
    <div
      ref={overlayRef}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      onClick={(e) => { if (e.target === overlayRef.current) onClose(); }}
    >
      <div className="relative flex flex-col w-full max-w-3xl max-h-[80vh] rounded-xl border border-border/40 bg-[#0d0d0d] shadow-2xl overflow-hidden font-mono text-xs">
        {/* Header */}
        <div className="flex items-center gap-3 px-3 py-2 border-b border-border/20 shrink-0">
          <span className="text-[10px] font-semibold text-muted-foreground/40 uppercase tracking-wider">IN</span>
          <span className="text-foreground/60 truncate flex-1">{command}</span>
          <button type="button" onClick={onClose} className="shrink-0 p-1 text-muted-foreground/50 hover:text-foreground transition-colors">
            <XIcon className="h-3.5 w-3.5" />
          </button>
        </div>
        {/* Full output */}
        <div className="overflow-y-auto flex-1 px-3 py-2 space-y-2">
          {shData.exitCode != null && shData.exitCode !== 0 && (
            <div className="text-destructive text-[10px] font-semibold">Exit code {shData.exitCode}</div>
          )}
          {shData.stdout && <pre className="text-foreground/75 whitespace-pre-wrap break-all leading-5">{shData.stdout}</pre>}
          {shData.stderr && <pre className="text-amber-400/80 whitespace-pre-wrap break-all leading-5">{shData.stderr}</pre>}
          {!shData.stdout && !shData.stderr && <span className="text-muted-foreground/40 italic">No output</span>}
        </div>
      </div>
    </div>,
    portalTarget,
  );
};

const BashInlineView: FC<{ part: ToolCallPart; isRunning: boolean; isError: boolean }> = ({ part, isRunning, isError }) => {
  const args = part.args as Record<string, unknown>;
  const rawCommand = typeof args.command === 'string' ? args.command : '';
  // Unwrap /bin/zsh -lc '...' style wrappers for display
  const shellWrapped = rawCommand.match(/^\/bin\/(?:zsh|bash|sh)\s+-\w+\s+'(.+)'$/s);
  const command = shellWrapped ? shellWrapped[1] : rawCommand;
  const shData = detectShResult(part.result);
  // For error results that don't have stdout/stderr shape, extract the error string
  const resultObj = part.result && typeof part.result === 'object' ? part.result as Record<string, unknown> : null;
  const errorMessage = isError && !shData && resultObj
    ? String(resultObj.error ?? resultObj.message ?? JSON.stringify(part.result))
        .replace(/<tool_use_error>/g, '').replace(/<\/tool_use_error>/g, '').trim()
    : null;
  const [outputModalOpen, setOutputModalOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    void navigator.clipboard.writeText(command);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [command]);

  // Combine stdout + stderr for the preview, cap at 3 lines
  const fullOutput = shData ? [shData.stdout, shData.stderr].filter(Boolean).join('\n') : '';
  const allLines = fullOutput.split('\n');
  const previewLines = allLines.slice(0, 3);
  const hasMore = allLines.length > 3;

  return (
    <>
      <div className="ml-5 mt-1 mb-2 rounded-xs border border-border/70 bg-muted dark:bg-[#111] dark:border-white/10 overflow-hidden text-xs font-mono">
        {/* IN row — single line + hover copy button */}
        <div className="group/in flex items-center gap-3 px-3 py-2 border-b border-border/50 dark:border-white/10">
          <span className="text-[10px] font-semibold text-muted-foreground/40 uppercase tracking-wider shrink-0">IN</span>
          <span className="text-foreground/75 truncate flex-1 leading-5">{command}</span>
          <button
            type="button"
            onClick={handleCopy}
            className={`shrink-0 transition-all p-1 rounded ${copied ? 'opacity-100 text-emerald-400' : 'opacity-0 group-hover/in:opacity-100 text-muted-foreground/50 hover:text-foreground'}`}
            title={copied ? 'Copied!' : 'Copy command'}
          >
            {copied ? <CheckIcon className="h-3 w-3" /> : <CopyIcon className="h-3 w-3" />}
          </button>
        </div>
        {/* OUT row */}
        <div className="flex gap-3 px-3 py-2">
          <span className="text-[10px] font-semibold text-muted-foreground/40 uppercase tracking-wider shrink-0 pt-px">OUT</span>
          <div className="flex-1 min-w-0">
            {isRunning ? (
              <span className="flex items-center gap-1.5 text-blue-400">
                <LoaderIcon className="h-3 w-3 animate-spin" />
                <span>Running…</span>
              </span>
            ) : errorMessage ? (
              <pre className="text-destructive whitespace-pre-wrap break-all leading-5">{errorMessage}</pre>
            ) : shData ? (
              <div>
                {shData.exitCode != null && shData.exitCode !== 0 && (
                  <div className="text-destructive text-[10px] font-semibold mb-1">Exit code {shData.exitCode}</div>
                )}
                {(shData.stdout || shData.stderr) ? (
                  <pre className="text-foreground/75 whitespace-pre-wrap break-all leading-5">
                    {previewLines.join('\n')}
                  </pre>
                ) : (
                  <span className="text-muted-foreground/40 italic">No output</span>
                )}
              </div>
            ) : (
              <span className="text-muted-foreground/40 italic">No output</span>
            )}
          </div>
        </div>
        {/* N more lines / Click to expand bar */}
        {hasMore && !isRunning && (
          <div className="border-t border-border/50 dark:border-white/10 px-3 py-1.5 flex items-center justify-between">
            <span className="text-muted-foreground/40 text-[10px] tabular-nums">{allLines.length - 3} more line{allLines.length - 3 !== 1 ? 's' : ''}</span>
            <button
              type="button"
              onClick={() => setOutputModalOpen(true)}
              className="flex items-center gap-1.5 text-[11px] font-medium bg-background/90 hover:bg-background border border-border/50 text-foreground/70 hover:text-foreground px-2.5 py-1 rounded-full shadow-sm transition-colors"
            >
              <ExternalLinkIcon className="h-2.5 w-2.5" />
              <span>Click to expand</span>
            </button>
          </div>
        )}
      </div>
      {outputModalOpen && shData && (
        <BashOutputModal command={command} shData={shData} onClose={() => setOutputModalOpen(false)} />
      )}
    </>
  );
};

/* ── Read Inline View ── */

/** Parse a plain-string Read result that may have embedded line numbers.
 *  Claude Code emits: "1\tcontent\n2\tcontent\n..."
 *  Returns { lines, startLine } where startLine is the first line number found (default 1).
 *  If the format isn't detected, returns raw lines with startLine=1.
 */
function parseReadContent(raw: string): { lines: string[]; startLine: number } {
  if (!raw) return { lines: [], startLine: 1 };
  const allLines = raw.split('\n');
  // Detect embedded line numbers: "N\t..." or "N  ..." where N is a number at the start
  const numberedRe = /^(\d+)\t(.*)/;
  const firstMatch = numberedRe.exec(allLines[0]);
  if (firstMatch) {
    const startLine = parseInt(firstMatch[1], 10);
    const parsed = allLines.map((l) => {
      const m = numberedRe.exec(l);
      return m ? m[2] : l;
    });
    return { lines: parsed, startLine };
  }
  return { lines: allLines, startLine: 1 };
}

const ReadInlineView: FC<{ part: ToolCallPart; isRunning: boolean }> = ({ part, isRunning }) => {
  const fileData = useMemo(() => {
    const smart = detectSmartResult(part);
    return smart?.type === 'file_read' ? smart.data : null;
  }, [part]);

  const args = part.args as Record<string, unknown>;
  const rawPath = fileData?.path
    ?? (typeof args.path === 'string' ? args.path : typeof args.file_path === 'string' ? args.file_path : '');
  const fileName = rawPath.split('/').pop() ?? rawPath;

  // Result can be a shaped {content,path} object, a plain string (Claude Code Read tool),
  // an observer-wrapped { value: string }, or an array of content blocks [{ type:'text', text }].
  const resultValue = useMemo(() => {
    if (typeof part.result === 'string') return part.result;
    if (Array.isArray(part.result)) {
      // Anthropic tool_result content blocks: [{ type: 'text', text: '...' }]
      return (part.result as Array<Record<string, unknown>>)
        .filter((b) => b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text as string)
        .join('\n') || null;
    }
    if (part.result && typeof part.result === 'object') {
      const r = part.result as Record<string, unknown>;
      // Observer-wrapped: { value: "...", observer: ... }
      if (typeof r.value === 'string') return r.value;
    }
    return null;
  }, [part.result]);

  const rawContent = fileData?.content ?? resultValue ?? '';

  const { lines, startLine } = useMemo(() => parseReadContent(rawContent), [rawContent]);
  const totalLines = fileData?.totalLines ?? lines.length;
  const truncated = fileData?.truncated ?? false;
  const endLine = startLine + lines.length - 1;
  const rangeLabel = lines.length > 0
    ? `lines ${startLine}–${endLine}${truncated ? ' (truncated)' : ''}`
    : '';

  const PREVIEW_LINES = 3;
  const previewLines = lines.slice(0, PREVIEW_LINES);
  const hasMore = lines.length > PREVIEW_LINES || truncated;

  const [modalOpen, setModalOpen] = useState(false);

  return (
    <>
      <div className="ml-5 mt-1 mb-2 rounded-xs border border-border/70 bg-muted dark:bg-[#111] dark:border-white/10 overflow-hidden text-xs font-mono">
        {/* Header */}
        <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border/50 dark:border-white/10 bg-muted/50 dark:bg-white/[0.03]">
          <span className="text-foreground/80 font-semibold truncate flex-1">{fileName || rawPath}</span>
          {isRunning ? (
            <span className="shrink-0 flex items-center gap-1 text-blue-400">
              <LoaderIcon className="h-3 w-3 animate-spin" />
            </span>
          ) : totalLines > 0 ? (
            <span className="shrink-0 text-[10px] text-muted-foreground/50 tabular-nums">{rangeLabel}</span>
          ) : null}
        </div>
        {/* Full path */}
        {rawPath && (
          <div className="px-3 py-1 text-[10px] text-muted-foreground/40 border-b border-border/30 dark:border-white/[0.06] truncate">{rawPath}</div>
        )}
        {/* Preview lines */}
        {!isRunning && previewLines.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <tbody>
                {previewLines.map((line, i) => (
                  <tr key={i}>
                    <td className="select-none w-8 pl-2 pr-3 text-right text-[10px] text-muted-foreground/30 tabular-nums border-r border-border/20 dark:border-white/[0.06]">{startLine + i}</td>
                    <td className="pl-3 pr-3 py-px whitespace-pre leading-5 text-foreground/75">{line || ' '}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {/* Click to expand */}
        {hasMore && !isRunning && (
          <div className="border-t border-border/50 dark:border-white/10 px-3 py-1.5 flex items-center justify-between">
            <span className="text-muted-foreground/40 text-[10px] tabular-nums">{lines.length - PREVIEW_LINES > 0 ? `${lines.length - PREVIEW_LINES} more line${lines.length - PREVIEW_LINES !== 1 ? 's' : ''}` : 'truncated'}</span>
            <button
              type="button"
              onClick={() => setModalOpen(true)}
              className="flex items-center gap-1.5 text-[11px] font-medium bg-background/90 hover:bg-background border border-border/50 text-foreground/70 hover:text-foreground px-2.5 py-1 rounded-full shadow-sm transition-colors"
            >
              <ExternalLinkIcon className="h-2.5 w-2.5" />
              <span>Click to expand</span>
            </button>
          </div>
        )}
        {!isRunning && lines.length === 0 && (
          <div className="px-3 py-2 text-muted-foreground/40 italic">Empty file</div>
        )}
      </div>
      {modalOpen && (
        <ReadContentModal
          fileName={fileName || rawPath}
          filePath={rawPath}
          lines={lines}
          startLine={startLine}
          truncated={truncated}
          onClose={() => setModalOpen(false)}
        />
      )}
    </>
  );
};

const ReadContentModal: FC<{ fileName: string; filePath: string; lines: string[]; startLine: number; truncated: boolean; onClose: () => void }> = ({ fileName, filePath, lines, startLine, truncated, onClose }) => {
  const overlayRef = useRef<HTMLDivElement>(null);
  const portalTarget = useModalPortalTarget();
  const endLine = startLine + lines.length - 1;
  const rangeLabel = lines.length > 0
    ? `lines ${startLine}–${endLine}${truncated ? ' (truncated)' : ''}`
    : '';

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  return createPortal(
    <div
      ref={overlayRef}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      onClick={(e) => { if (e.target === overlayRef.current) onClose(); }}
    >
      <div className="relative flex flex-col w-full max-w-3xl max-h-[80vh] rounded-xl border border-border/40 bg-background shadow-2xl overflow-hidden font-mono text-xs">
        {/* Header */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border/40 bg-muted/30 shrink-0">
          <FileTextIcon className="h-3.5 w-3.5 text-blue-500 shrink-0" />
          <span className="font-semibold text-foreground/90 truncate flex-1">{fileName}</span>
          <span className="text-[10px] text-muted-foreground/50 shrink-0 tabular-nums">{rangeLabel}</span>
          <button type="button" onClick={onClose} className="shrink-0 p-1 text-muted-foreground/50 hover:text-foreground transition-colors">
            <XIcon className="h-3.5 w-3.5" />
          </button>
        </div>
        {/* Full path */}
        {filePath && (
          <div className="px-4 py-1.5 text-[10px] text-muted-foreground/40 border-b border-border/20 shrink-0 truncate">{filePath}</div>
        )}
        {/* Content */}
        <div className="overflow-y-auto overflow-x-auto flex-1">
          <table className="w-full border-collapse">
            <tbody>
              {lines.map((line, i) => (
                <tr key={i}>
                  <td className="select-none w-10 pl-3 pr-3 text-right text-[10px] text-muted-foreground/30 tabular-nums border-r border-border/20 shrink-0">{startLine + i}</td>
                  <td className="pl-3 pr-4 py-px whitespace-pre leading-5 text-foreground/80">{line || ' '}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>,
    portalTarget,
  );
};

/* ── Grep Inline View ── */

const GrepInlineView: FC<{ part: ToolCallPart; isRunning: boolean }> = ({ part, isRunning }) => {
  const args = part.args as Record<string, unknown>;
  const pattern = typeof args.pattern === 'string' ? args.pattern : '';
  const searchPath = typeof args.path === 'string' ? args.path : typeof args.cwd === 'string' ? args.cwd : '';

  // Parse result — grep returns:
  //   { matches: [{file, line, content}] }  (Mastra)
  //   a plain array of strings              (Claude Code)
  //   a plain string                        (raw grep output)
  const result = part.result;
  type GrepMatch = { file?: string; line?: number; content?: string; text?: string };

  type GrepLine = { file?: string; line?: number; text: string };
  const allLines: GrepLine[] = useMemo(() => {
    if (!result) return [];
    // Claude Code returns a plain array of "file:line:content" strings
    if (Array.isArray(result)) {
      return (result as unknown[]).map((item) => {
        const s = String(item);
        const m = s.match(/^(.+):(\d+):(.*)/);
        if (m) return { file: m[1], line: parseInt(m[2], 10), text: m[3] };
        return { text: s };
      }).filter((l) => l.text !== '');
    }
    if (typeof result === 'string') {
      // Sentinel strings returned by Claude Code when there are no results
      if (result.trim() === 'No matches found' || result.trim() === '') return [];
      // "Found N files\npath1\npath2..." — strip the summary header line
      const lines = result.split('\n').filter(Boolean);
      const dataLines = lines[0]?.match(/^Found \d+ files?$/) ? lines.slice(1) : lines;
      return dataLines.map((l) => {
        const m = l.match(/^(.+):(\d+):(.*)/);
        if (m) return { file: m[1], line: parseInt(m[2], 10), text: m[3] };
        return { text: l };
      });
    }
    if (typeof result === 'object' && result !== null) {
      const r = result as Record<string, unknown>;
      if (Array.isArray(r.matches)) {
        return (r.matches as GrepMatch[]).map((m) => ({ file: m.file, line: m.line, text: m.content ?? m.text ?? '' }));
      }
      if (typeof r.output === 'string') {
        return r.output.split('\n').filter(Boolean).map((l) => ({ text: l }));
      }
    }
    return [];
  }, [result]);

  const PREVIEW_LINES = 3;
  const hasMore = allLines.length > PREVIEW_LINES;
  const previewItems = allLines.slice(0, PREVIEW_LINES);
  const [modalOpen, setModalOpen] = useState(false);

  return (
    <>
      <div className="ml-5 mt-1 mb-2 rounded-xs border border-border/70 bg-muted dark:bg-[#111] dark:border-white/10 overflow-hidden text-xs font-mono">
        {/* Header */}
        <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border/50 dark:border-white/10 bg-muted/50 dark:bg-white/[0.03]">
          <span className="text-foreground/80 font-semibold truncate flex-1">/{pattern}/</span>
          {isRunning ? (
            <span className="shrink-0 flex items-center gap-1 text-blue-400">
              <LoaderIcon className="h-3 w-3 animate-spin" />
            </span>
          ) : allLines.length > 0 ? (
            <span className="shrink-0 text-[10px] text-muted-foreground/50 tabular-nums">{allLines.length} match{allLines.length !== 1 ? 'es' : ''}</span>
          ) : null}
        </div>
        {/* Search path */}
        {searchPath && (
          <div className="px-3 py-1 text-[10px] text-muted-foreground/40 border-b border-border/30 dark:border-white/[0.06] truncate">{searchPath}</div>
        )}
        {/* Preview matches */}
        {!isRunning && previewItems.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <tbody>
                {previewItems.map((item, i) => (
                  <tr key={i} className="border-b border-border/20 dark:border-white/[0.04] last:border-0">
                    {item.file && (
                      <td className="select-none pl-2 pr-1 text-[10px] text-muted-foreground/40 whitespace-nowrap shrink-0 truncate max-w-[120px]">{item.file.split('/').pop()}</td>
                    )}
                    {item.line != null && (
                      <td className="select-none pr-3 text-[10px] text-muted-foreground/30 tabular-nums shrink-0">{item.line}</td>
                    )}
                    <td className="pl-2 pr-3 py-px whitespace-pre leading-5 text-foreground/75 w-full">{item.text || ' '}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {/* Click to expand */}
        {hasMore && !isRunning && (
          <div className="border-t border-border/50 dark:border-white/10 px-3 py-1.5 flex items-center justify-between">
            <span className="text-muted-foreground/40 text-[10px] tabular-nums">{allLines.length - PREVIEW_LINES} more match{allLines.length - PREVIEW_LINES !== 1 ? 'es' : ''}</span>
            <button
              type="button"
              onClick={() => setModalOpen(true)}
              className="flex items-center gap-1.5 text-[11px] font-medium bg-background/90 hover:bg-background border border-border/50 text-foreground/70 hover:text-foreground px-2.5 py-1 rounded-full shadow-sm transition-colors"
            >
              <ExternalLinkIcon className="h-2.5 w-2.5" />
              <span>Click to expand</span>
            </button>
          </div>
        )}
        {!isRunning && allLines.length === 0 && (
          <div className="px-3 py-2 text-muted-foreground/40 italic">No matches</div>
        )}
      </div>
      {modalOpen && (
        <GrepResultModal pattern={pattern} searchPath={searchPath} allLines={allLines} onClose={() => setModalOpen(false)} />
      )}
    </>
  );
};

const GrepResultModal: FC<{ pattern: string; searchPath: string; allLines: { file?: string; line?: number; text: string }[]; onClose: () => void }> = ({ pattern, searchPath, allLines, onClose }) => {
  const overlayRef = useRef<HTMLDivElement>(null);
  const portalTarget = useModalPortalTarget();

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  return createPortal(
    <div
      ref={overlayRef}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      onClick={(e) => { if (e.target === overlayRef.current) onClose(); }}
    >
      <div className="relative flex flex-col w-full max-w-3xl max-h-[80vh] rounded-xl border border-border/40 bg-background shadow-2xl overflow-hidden font-mono text-xs">
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border/40 bg-muted/30 shrink-0">
          <SearchIcon className="h-3.5 w-3.5 text-sky-500 shrink-0" />
          <span className="font-semibold text-foreground/90 truncate flex-1">/{pattern}/</span>
          <span className="text-[10px] text-muted-foreground/50 shrink-0 tabular-nums">{allLines.length} match{allLines.length !== 1 ? 'es' : ''}</span>
          <button type="button" onClick={onClose} className="shrink-0 p-1 text-muted-foreground/50 hover:text-foreground transition-colors">
            <XIcon className="h-3.5 w-3.5" />
          </button>
        </div>
        {searchPath && (
          <div className="px-4 py-1.5 text-[10px] text-muted-foreground/40 border-b border-border/20 shrink-0 truncate">{searchPath}</div>
        )}
        <div className="overflow-y-auto overflow-x-auto flex-1">
          <table className="w-full border-collapse">
            <tbody>
              {allLines.map((item, i) => (
                <tr key={i} className="border-b border-border/10 dark:border-white/[0.04] last:border-0">
                  {item.file && (
                    <td className="select-none pl-3 pr-2 py-px text-[10px] text-muted-foreground/40 whitespace-nowrap shrink-0 truncate max-w-[140px]">{item.file.split('/').pop()}</td>
                  )}
                  {item.line != null && (
                    <td className="select-none pr-3 py-px text-[10px] text-muted-foreground/30 tabular-nums shrink-0 text-right">{item.line}</td>
                  )}
                  <td className="pl-2 pr-4 py-px whitespace-pre leading-5 text-foreground/80 w-full">{item.text || ' '}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>,
    portalTarget,
  );
};

/* ── Glob Inline View ── */

const GlobInlineView: FC<{ part: ToolCallPart; isRunning: boolean }> = ({ part, isRunning }) => {
  const args = part.args as Record<string, unknown>;
  const pattern = typeof args.pattern === 'string' ? args.pattern : '';
  const searchPath = typeof args.path === 'string' ? args.path : '';

  // Result can be:
  //   - an array of file path strings (Claude Code Glob)
  //   - { files: string[], count: number, path?: string } (Mastra workspace glob)
  //   - a plain string listing of files
  const result = part.result;
  const files: string[] = useMemo(() => {
    if (!result) return [];
    if (Array.isArray(result)) return (result as unknown[]).map(String).filter(Boolean);
    if (typeof result === 'object' && result !== null) {
      const r = result as Record<string, unknown>;
      if (Array.isArray(r.files)) return (r.files as unknown[]).map(String).filter(Boolean);
    }
    if (typeof result === 'string') {
      // Sentinel string returned by Claude Code when there are no results
      if (result.trim() === 'No files found' || result.trim() === '') return [];
      // "Found N files\npath1\npath2..." — strip the summary header line
      const lines = result.split('\n').filter(Boolean);
      return lines[0]?.match(/^Found \d+ files?$/) ? lines.slice(1) : lines;
    }
    return [];
  }, [result]);

  const PREVIEW_COUNT = 5;
  const previewFiles = files.slice(0, PREVIEW_COUNT);
  const hasMore = files.length > PREVIEW_COUNT;
  const [modalOpen, setModalOpen] = useState(false);

  return (
    <>
      <div className="ml-5 mt-1 mb-2 rounded-xs border border-border/70 bg-muted dark:bg-[#111] dark:border-white/10 overflow-hidden text-xs font-mono">
        {/* Header */}
        <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border/50 dark:border-white/10 bg-muted/50 dark:bg-white/[0.03]">
          <span className="text-foreground/80 font-semibold truncate flex-1">{pattern || '*'}</span>
          {isRunning ? (
            <span className="shrink-0 flex items-center gap-1 text-blue-400">
              <LoaderIcon className="h-3 w-3 animate-spin" />
            </span>
          ) : files.length > 0 ? (
            <span className="shrink-0 text-[10px] text-muted-foreground/50 tabular-nums">{files.length} file{files.length !== 1 ? 's' : ''}</span>
          ) : null}
        </div>
        {/* Search path */}
        {searchPath && (
          <div className="px-3 py-1 text-[10px] text-muted-foreground/40 border-b border-border/30 dark:border-white/[0.06] truncate">{searchPath}</div>
        )}
        {/* Preview files */}
        {!isRunning && previewFiles.length > 0 && (
          <div className="divide-y divide-border/20 dark:divide-white/[0.04]">
            {previewFiles.map((filePath, i) => (
              <div key={i} className="flex items-center gap-1.5 px-3 py-0.5">
                <FileIcon className="h-3 w-3 shrink-0 text-muted-foreground/40" />
                <ClickablePath path={filePath} className="text-foreground/75 truncate" />
              </div>
            ))}
          </div>
        )}
        {/* Click to expand */}
        {hasMore && !isRunning && (
          <div className="border-t border-border/50 dark:border-white/10 px-3 py-1.5 flex items-center justify-between">
            <span className="text-muted-foreground/40 text-[10px] tabular-nums">{files.length - PREVIEW_COUNT} more file{files.length - PREVIEW_COUNT !== 1 ? 's' : ''}</span>
            <button
              type="button"
              onClick={() => setModalOpen(true)}
              className="flex items-center gap-1.5 text-[11px] font-medium bg-background/90 hover:bg-background border border-border/50 text-foreground/70 hover:text-foreground px-2.5 py-1 rounded-full shadow-sm transition-colors"
            >
              <ExternalLinkIcon className="h-2.5 w-2.5" />
              <span>Click to expand</span>
            </button>
          </div>
        )}
        {!isRunning && files.length === 0 && (
          <div className="px-3 py-2 text-muted-foreground/40 italic">No files found</div>
        )}
      </div>
      {modalOpen && (
        <GlobResultModal pattern={pattern} searchPath={searchPath} files={files} onClose={() => setModalOpen(false)} />
      )}
    </>
  );
};

const GlobResultModal: FC<{ pattern: string; searchPath: string; files: string[]; onClose: () => void }> = ({ pattern, searchPath, files, onClose }) => {
  const overlayRef = useRef<HTMLDivElement>(null);
  const portalTarget = useModalPortalTarget();

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  return createPortal(
    <div
      ref={overlayRef}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      onClick={(e) => { if (e.target === overlayRef.current) onClose(); }}
    >
      <div className="relative flex flex-col w-full max-w-2xl max-h-[80vh] rounded-xl border border-border/40 bg-background shadow-2xl overflow-hidden font-mono text-xs">
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border/40 bg-muted/30 shrink-0">
          <FolderOpenIcon className="h-3.5 w-3.5 text-indigo-500 shrink-0" />
          <span className="font-semibold text-foreground/90 truncate flex-1">{pattern || '*'}</span>
          <span className="text-[10px] text-muted-foreground/50 shrink-0 tabular-nums">{files.length} file{files.length !== 1 ? 's' : ''}</span>
          <button type="button" onClick={onClose} className="shrink-0 p-1 text-muted-foreground/50 hover:text-foreground transition-colors">
            <XIcon className="h-3.5 w-3.5" />
          </button>
        </div>
        {searchPath && (
          <div className="px-4 py-1.5 text-[10px] text-muted-foreground/40 border-b border-border/20 shrink-0 truncate">{searchPath}</div>
        )}
        <div className="overflow-y-auto flex-1 divide-y divide-border/10 dark:divide-white/[0.04]">
          {files.map((filePath, i) => (
            <div key={i} className="flex items-center gap-2 px-4 py-1">
              <FileIcon className="h-3 w-3 shrink-0 text-muted-foreground/40" />
              <ClickablePath path={filePath} className="text-foreground/80 truncate" />
            </div>
          ))}
        </div>
      </div>
    </div>,
    portalTarget,
  );
};

/* ── Edit Diff Modal ── */

type DiffLine = { text: string; type: 'added' | 'removed' | 'context' };

const EditDiffModal: FC<{ fileName: string; filePath: string; diffLines: DiffLine[]; addedCount: number; removedCount: number; onClose: () => void }> = ({ fileName, filePath, diffLines, addedCount, removedCount, onClose }) => {
  const overlayRef = useRef<HTMLDivElement>(null);
  const portalTarget = useModalPortalTarget();
  const shortStat = [
    addedCount > 0 ? <span key="a" className="text-emerald-400">+{addedCount}</span> : null,
    addedCount > 0 && removedCount > 0 ? <span key="sep" className="text-muted-foreground/40"> / </span> : null,
    removedCount > 0 ? <span key="r" className="text-red-400">−{removedCount}</span> : null,
  ];

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  return createPortal(
    <div
      ref={overlayRef}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      onClick={(e) => { if (e.target === overlayRef.current) onClose(); }}
    >
      <div className="relative flex flex-col w-full max-w-3xl max-h-[80vh] rounded-xl border border-border/40 bg-background shadow-2xl overflow-hidden font-mono text-xs">
        {/* Modal header */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border/40 bg-muted/30 shrink-0">
          <FilePenIcon className="h-3.5 w-3.5 text-amber-500 shrink-0" />
          <span className="font-semibold text-foreground/90 truncate flex-1">{fileName}</span>
          <span className="text-[11px] shrink-0 tabular-nums">{shortStat}</span>
          <button type="button" onClick={onClose} className="shrink-0 p-1 text-muted-foreground/50 hover:text-foreground transition-colors">
            <XIcon className="h-3.5 w-3.5" />
          </button>
        </div>
        {/* Full path */}
        {filePath && (
          <div className="px-4 py-1.5 text-[10px] text-muted-foreground/40 border-b border-border/20 shrink-0 truncate">{filePath}</div>
        )}
        {/* Full diff */}
        <div className="overflow-y-auto overflow-x-auto flex-1">
          <table className="w-full border-collapse">
            <tbody>
              {diffLines.map((line, i) => {
                let newN = 1;
                for (let k = 0; k < i; k++) {
                  if (diffLines[k].type !== 'removed') newN++;
                }
                return (
                  <tr key={i} className={line.type === 'added' ? 'bg-emerald-500/10' : line.type === 'removed' ? 'bg-red-500/10' : ''}>
                    <td className="select-none w-10 pl-3 pr-2 text-right text-[10px] text-muted-foreground/25 tabular-nums shrink-0 border-r border-border/15">
                      {line.type !== 'removed' ? newN : ''}
                    </td>
                    <td className="select-none w-5 pl-1 pr-1 text-center text-[10px] font-bold shrink-0">
                      {line.type === 'added' ? <span className="text-emerald-500">+</span> : line.type === 'removed' ? <span className="text-red-500">−</span> : null}
                    </td>
                    <td className={`pl-1 pr-4 py-px whitespace-pre leading-5 ${line.type === 'added' ? 'text-emerald-300/90' : line.type === 'removed' ? 'text-red-300/90' : 'text-foreground/60'}`}>
                      {line.text || ' '}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>,
    portalTarget,
  );
};

/* ── Edit / Write Inline View ── */

const EditInlineView: FC<{ part: ToolCallPart; isRunning: boolean; isError: boolean }> = ({ part, isRunning, isError }) => {
  const args = part.args as Record<string, unknown>;
  // Support both 'path' (local tools) and 'file_path' (Claude Code agent tools)
  const rawPath = typeof args.file_path === 'string' ? args.file_path : typeof args.path === 'string' ? args.path : '';
  const fileName = rawPath.split('/').pop() ?? rawPath;

  const isWriteTool = part.toolName === 'file_write' || part.toolName === 'mastra_workspace_write_file' || part.toolName === 'write' || part.toolName === 'Write';
  const oldStr = typeof args.old_string === 'string' ? args.old_string : null;
  const newStr = typeof args.new_string === 'string' ? args.new_string
    : typeof args.new_content === 'string' ? args.new_content
    : typeof args.content === 'string' ? args.content
    : null;

  const language = langFromPath(rawPath);

  // Build an interleaved diff using a simple LCS-based Myers diff
  const diffLines: DiffLine[] = useMemo(() => {
    if (isWriteTool && newStr != null) {
      return newStr.split('\n').map((text) => ({ text, type: 'added' as const }));
    }
    if (oldStr == null && newStr == null) return [];
    if (oldStr == null) return (newStr ?? '').split('\n').map((text) => ({ text, type: 'added' as const }));
    if (newStr == null) return oldStr.split('\n').map((text) => ({ text, type: 'removed' as const }));

    const aLines = oldStr.split('\n');
    const bLines = newStr.split('\n');

    // Simple patience-style LCS diff for small inputs, fallback to block diff for large
    if (aLines.length + bLines.length > 400) {
      // Too large for LCS — just show removed block then added block
      return [
        ...aLines.map((text) => ({ text, type: 'removed' as const })),
        ...bLines.map((text) => ({ text, type: 'added' as const })),
      ];
    }

    // Myers diff via DP LCS
    const m = aLines.length, n = bLines.length;
    const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
    for (let i = m - 1; i >= 0; i--) {
      for (let j = n - 1; j >= 0; j--) {
        if (aLines[i] === bLines[j]) dp[i][j] = dp[i+1][j+1] + 1;
        else dp[i][j] = Math.max(dp[i+1][j], dp[i][j+1]);
      }
    }
    const result: DiffLine[] = [];
    let i = 0, j = 0;
    while (i < m || j < n) {
      if (i < m && j < n && aLines[i] === bLines[j]) {
        result.push({ text: aLines[i], type: 'context' });
        i++; j++;
      } else if (j < n && (i >= m || dp[i][j+1] >= dp[i+1][j])) {
        result.push({ text: bLines[j], type: 'added' });
        j++;
      } else {
        result.push({ text: aLines[i], type: 'removed' });
        i++;
      }
    }
    return result;
  }, [isWriteTool, oldStr, newStr]);

  const PREVIEW_LINES = 3;
  const hasMore = diffLines.length > PREVIEW_LINES;
  const previewLines = hasMore ? diffLines.slice(0, PREVIEW_LINES) : diffLines;

  const addedCount = diffLines.filter((l) => l.type === 'added').length;
  const removedCount = diffLines.filter((l) => l.type === 'removed').length;

  // Result message (success string or error)
  const resultObj = part.result && typeof part.result === 'object' ? part.result as Record<string, unknown> : null;
  const resultStr = typeof part.result === 'string' ? part.result : null;
  const errorMessage = isError
    ? (resultObj ? String(resultObj.error ?? resultObj.message ?? JSON.stringify(part.result)) : resultStr ?? '')
        .replace(/<tool_use_error>/g, '').replace(/<\/tool_use_error>/g, '').trim()
    : null;

  const [diffModalOpen, setDiffModalOpen] = useState(false);

  return (
    <>
      <div className="ml-5 mt-1 mb-2 rounded-xs border border-border/70 bg-muted dark:bg-[#111] dark:border-white/10 overflow-hidden text-xs font-mono">
        {/* Header: filename + +N/-N counts */}
        <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border/50 dark:border-white/10 bg-muted/50 dark:bg-white/[0.03]">
          <span className="text-foreground/80 font-semibold truncate flex-1">{fileName || rawPath}</span>
          {isRunning ? (
            <span className="shrink-0 flex items-center gap-1 text-blue-400">
              <LoaderIcon className="h-3 w-3 animate-spin" />
            </span>
          ) : (
            <span className="shrink-0 text-[11px] tabular-nums">
              {addedCount > 0 && <span className="text-emerald-500">+{addedCount}</span>}
              {addedCount > 0 && removedCount > 0 && <span className="text-muted-foreground/40"> / </span>}
              {removedCount > 0 && <span className="text-red-400">−{removedCount}</span>}
            </span>
          )}
        </div>
        {/* Full file path */}
        {rawPath && (
          <div className="px-3 py-1 text-[10px] text-muted-foreground/40 border-b border-border/30 dark:border-white/[0.06] truncate">{rawPath}</div>
        )}

        {/* Diff preview lines */}
        {diffLines.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <tbody>
                {previewLines.map((line, i) => {
                  let newN = 1;
                  for (let k = 0; k < i; k++) {
                    if (previewLines[k].type !== 'removed') newN++;
                  }
                  return (
                    <tr
                      key={i}
                      className={line.type === 'added' ? 'bg-emerald-500/10' : line.type === 'removed' ? 'bg-red-500/10' : ''}
                    >
                      <td className="select-none w-8 pl-2 pr-2 text-right text-[10px] text-muted-foreground/25 tabular-nums shrink-0 border-r border-border/15">
                        {line.type !== 'removed' ? newN : ''}
                      </td>
                      <td className="select-none w-4 pl-1 text-center shrink-0 text-[10px] font-bold">
                        {line.type === 'added' ? (
                          <span className="text-emerald-500">+</span>
                        ) : line.type === 'removed' ? (
                          <span className="text-red-500">−</span>
                        ) : null}
                      </td>
                      <td className={`pl-1 pr-3 py-px whitespace-pre leading-5 ${line.type === 'added' ? 'text-emerald-300/90' : line.type === 'removed' ? 'text-red-300/90' : 'text-foreground/60'}`}>
                        {line.text || ' '}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* Click to expand — shown when there are more than 3 lines */}
        {hasMore && !isRunning && (
          <div className="border-t border-border/50 dark:border-white/10 px-3 py-1.5 flex items-center justify-between">
            <span className="text-muted-foreground/40 text-[10px] tabular-nums">{diffLines.length - PREVIEW_LINES} more line{diffLines.length - PREVIEW_LINES !== 1 ? 's' : ''}</span>
            <button
              type="button"
              onClick={() => setDiffModalOpen(true)}
              className="flex items-center gap-1.5 text-[11px] font-medium bg-background/90 hover:bg-background border border-border/50 text-foreground/70 hover:text-foreground px-2.5 py-1 rounded-full shadow-sm transition-colors"
            >
              <ExternalLinkIcon className="h-2.5 w-2.5" />
              <span>Click to expand</span>
            </button>
          </div>
        )}

        {/* Error or no-diff state */}
        {errorMessage && (
          <div className="px-3 py-2 text-destructive whitespace-pre-wrap break-all leading-5">{errorMessage}</div>
        )}
        {!isRunning && diffLines.length === 0 && !errorMessage && (
          <div className="px-3 py-2 text-muted-foreground/40 italic">No changes</div>
        )}
      </div>

      {diffModalOpen && (
        <EditDiffModal
          fileName={fileName || rawPath}
          filePath={rawPath}
          diffLines={diffLines}
          addedCount={addedCount}
          removedCount={removedCount}
          onClose={() => setDiffModalOpen(false)}
        />
      )}
    </>

  );
};

/* ── Tool Section (always-open label + content) ── */

const ToolSection: FC<{ title: string; badge?: React.ReactNode; children: React.ReactNode }> = ({ title, badge, children }) => {
  return (
    <div className="mt-1">
      <div className="flex w-full items-center gap-1.5 py-1 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
        {title}
        {badge}
      </div>
      <div className="pb-1">{children}</div>
    </div>
  );
};

/* CodeBlock imported from ./CodeBlock */

function isErrorResult(result: unknown): boolean {
  if (!result || typeof result !== 'object') return false;
  const r = result as Record<string, unknown>;
  return Boolean(r.error) || r.isError === true || (r.exitCode !== undefined && r.exitCode !== 0);
}

const toolLabels: Record<string, string> = {
  sh: 'Bash',
  bash: 'Bash',
  mastra_workspace_execute_command: 'Bash',
  file_read: 'Read',
  read: 'Read',
  Read: 'Read',
  mastra_workspace_read_file: 'Read',
  file_write: 'Write',
  mastra_workspace_write_file: 'Write',
  write: 'Write',
  Write: 'Write',
  file_edit: 'Edit',
  mastra_workspace_edit_file: 'Edit',
  edit: 'Edit',
  Edit: 'Edit',
  str_replace_based_edit_tool: 'Edit',
  str_replace_editor: 'Edit',
  grep: 'Grep',
  Grep: 'Grep',
  mastra_workspace_grep: 'Grep',
  glob: 'Glob',
  Glob: 'Glob',
  mastra_workspace_glob: 'Glob',
  glob_search: 'Glob',
  list_directory: 'List Directory',
  mastra_workspace_list_files: 'List Files',
  agent_lattice_chat: 'Agent',
  sub_agent: 'Sub Agent',
  generate_image: 'Image Generation',
  generate_video: 'Video Generation',
  ask_user: 'Question',
  enter_plan_mode: 'Enter Plan Mode',
  exit_plan_mode: 'Exit Plan Mode',
};

function getToolLabel(toolName: string): string {
  if (toolLabels[toolName]) return toolLabels[toolName];
  // Split PascalCase (e.g. UpdateWorkingMemory → Update Working Memory),
  // then handle snake_case, and title-case any remaining words.
  return toolName
    .replace(/([a-z])([A-Z])/g, '$1 $2')  // camelCase/PascalCase split
    .replace(/_/g, ' ')                     // snake_case split
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

type LucideIcon = FC<{ className?: string }>;

function getToolIcon(toolName: string): LucideIcon {
  if (toolName === 'sh' || toolName === 'bash' || toolName === 'mastra_workspace_execute_command') return TerminalIcon;
  if (toolName === 'file_read' || toolName === 'read' || toolName === 'Read' || toolName === 'mastra_workspace_read_file') return FileTextIcon;
  if (toolName === 'file_write' || toolName === 'mastra_workspace_write_file' || toolName === 'write' || toolName === 'Write') return FileIcon;
  if (toolName === 'file_edit' || toolName === 'mastra_workspace_edit_file' || toolName === 'edit' || toolName === 'Edit' || toolName === 'str_replace_based_edit_tool' || toolName === 'str_replace_editor') return FilePenIcon;
  if (toolName === 'grep' || toolName === 'Grep' || toolName === 'mastra_workspace_grep') return SearchIcon;
  if (toolName === 'glob' || toolName === 'Glob' || toolName === 'mastra_workspace_glob' || toolName === 'glob_search') return FolderOpenIcon;
  if (toolName === 'list_directory' || toolName === 'mastra_workspace_list_files') return FolderIcon;
  if (toolName === 'ask_user') return HelpCircleIcon;
  if (toolName === 'enter_plan_mode') return ListTodoIcon;
  if (toolName === 'exit_plan_mode') return ScrollTextIcon;
  if (toolName === 'agent_lattice_chat' || toolName === 'sub_agent') return BotIcon;
  if (toolName === 'generate_image') return ImageIcon;
  if (toolName === 'generate_video') return VideoIcon;
  return SparklesIcon;
}

function getToolIconColor(toolName: string): string {
  if (toolName === 'sh' || toolName === 'bash' || toolName === 'mastra_workspace_execute_command')
    return 'bg-violet-500/15 text-violet-500';
  if (toolName === 'file_read' || toolName === 'read' || toolName === 'Read' || toolName === 'mastra_workspace_read_file')
    return 'bg-blue-500/15 text-blue-500';
  if (toolName === 'file_write' || toolName === 'mastra_workspace_write_file' || toolName === 'write' || toolName === 'Write')
    return 'bg-emerald-500/15 text-emerald-500';
  if (toolName === 'file_edit' || toolName === 'mastra_workspace_edit_file' || toolName === 'edit' || toolName === 'Edit' || toolName === 'str_replace_based_edit_tool' || toolName === 'str_replace_editor')
    return 'bg-amber-500/15 text-amber-500';
  if (toolName === 'grep' || toolName === 'Grep' || toolName === 'mastra_workspace_grep')
    return 'bg-sky-500/15 text-sky-500';
  if (toolName === 'glob' || toolName === 'Glob' || toolName === 'mastra_workspace_glob' || toolName === 'glob_search' || toolName === 'list_directory' || toolName === 'mastra_workspace_list_files')
    return 'bg-indigo-500/15 text-indigo-500';
  if (toolName === 'ask_user')
    return 'bg-orange-500/15 text-orange-500';
  if (toolName === 'enter_plan_mode' || toolName === 'exit_plan_mode')
    return 'bg-primary/15 text-primary';
  if (toolName === 'agent_lattice_chat' || toolName === 'sub_agent')
    return 'bg-pink-500/15 text-pink-500';
  if (toolName === 'generate_image' || toolName === 'generate_video')
    return 'bg-rose-500/15 text-rose-500';
  return 'bg-muted text-muted-foreground';
}

function getToolSummary(part: ToolCallPart): string {
  const args = part.args as Record<string, unknown>;
  if ((part.toolName === 'sh' || part.toolName === 'bash' || part.toolName === 'mastra_workspace_execute_command') && args.command) {
    // Strip common shell wrappers like /bin/zsh -lc '...' or /bin/bash -c '...'
    const raw = String(args.command);
    const shellWrapped = raw.match(/^\/bin\/(?:zsh|bash|sh)\s+-\w+\s+'(.+)'$/s);
    if (shellWrapped) return shellWrapped[1].slice(0, 80);
    return raw.slice(0, 80);
  }
  if ((part.toolName === 'file_read' || part.toolName === 'read' || part.toolName === 'Read' || part.toolName === 'mastra_workspace_read_file') && (args.path || args.file_path)) {
    const filePath = String(args.path ?? args.file_path ?? '');
    const fileName = filePath.split('/').pop() ?? '';
    // Try to derive line range from the result first (most accurate)
    if (part.result !== undefined && !part.isError) {
      const rawStr = typeof part.result === 'string' ? part.result
        : Array.isArray(part.result)
          ? (part.result as Array<Record<string, unknown>>).filter((b) => b.type === 'text' && typeof b.text === 'string').map((b) => b.text as string).join('\n')
          : typeof part.result === 'object' && part.result !== null ? (() => { const r = part.result as Record<string, unknown>; return typeof r.value === 'string' ? r.value : typeof r.content === 'string' ? r.content : null; })()
          : null;
      if (rawStr) {
        const { lines, startLine } = parseReadContent(rawStr);
        if (lines.length > 0) return `${fileName} (lines ${startLine}–${startLine + lines.length - 1})`;
      }
    }
    // Fall back to args when result not yet available
    const offset = typeof args.offset === 'number' ? args.offset : null;
    const limit = typeof args.limit === 'number' ? args.limit : null;
    if (offset != null && limit != null) return `${fileName} (lines ${offset}–${offset + limit - 1})`;
    if (offset != null) return `${fileName} (from line ${offset})`;
    return fileName;
  }
  const isWriteToolName = part.toolName === 'file_write' || part.toolName === 'mastra_workspace_write_file' || part.toolName === 'write' || part.toolName === 'Write';
  const isEditToolName = part.toolName === 'file_edit' || part.toolName === 'mastra_workspace_edit_file' || part.toolName === 'edit' || part.toolName === 'Edit' || part.toolName === 'str_replace_based_edit_tool' || part.toolName === 'str_replace_editor';
  // Support both 'path' and 'file_path' arg names
  const filePath = typeof args.path === 'string' ? args.path : typeof args.file_path === 'string' ? args.file_path : null;
  if (isWriteToolName && filePath) return filePath.split('/').pop() ?? '';
  if (isEditToolName && filePath) return filePath.split('/').pop() ?? '';
  if ((part.toolName === 'grep' || part.toolName === 'Grep' || part.toolName === 'mastra_workspace_grep' || part.toolName === 'grep_search') && args.pattern) return `/${args.pattern}/`;
  if ((part.toolName === 'glob' || part.toolName === 'Glob' || part.toolName === 'mastra_workspace_glob' || part.toolName === 'glob_search') && args.pattern) return String(args.pattern);
  if ((part.toolName === 'list_directory' || part.toolName === 'mastra_workspace_list_files') && args.path) return String(args.path);
  if (part.toolName === 'agent_lattice_chat') return 'Remote agent call';
  if (part.toolName === 'generate_image' && args.prompt) return String(args.prompt).slice(0, 60);
  if (part.toolName === 'generate_video' && args.prompt) return String(args.prompt).slice(0, 60);
  if (part.toolName === 'ask_user' && Array.isArray(args.questions)) {
    const count = (args.questions as unknown[]).length;
    return `${count} question${count !== 1 ? 's' : ''}`;
  }
  if (part.toolName === 'enter_plan_mode') return (args as Record<string, unknown>).reason ? String((args as Record<string, unknown>).reason) : '';
  if (part.toolName === 'exit_plan_mode') return (args as Record<string, unknown>).summary ? String((args as Record<string, unknown>).summary) : '';
  return '';
}

/** Returns a short subtitle line shown below the tool name — muted metadata about the result */
function getToolSubtitle(part: ToolCallPart): string {
  if (!part.result || part.isError) return '';
  const result = part.result as Record<string, unknown>;
  const args = part.args as Record<string, unknown>;

  // file_write → "Wrote N lines" or "Wrote file"
  if (part.toolName === 'file_write' || part.toolName === 'mastra_workspace_write_file') {
    if (typeof args.content === 'string') {
      const lines = args.content.split('\n').length;
      return `Wrote ${lines} line${lines !== 1 ? 's' : ''}`;
    }
    return 'Wrote file';
  }

  // file_edit → "Edited file"
  if (part.toolName === 'file_edit' || part.toolName === 'mastra_workspace_edit_file') {
    return 'Edited file';
  }

  // sh / bash → "Exit code N" or "Completed"
  if (part.toolName === 'sh' || part.toolName === 'bash' || part.toolName === 'mastra_workspace_execute_command') {
    if (typeof result.exitCode === 'number') {
      return result.exitCode === 0 ? 'Exited with code 0' : `Exit code ${result.exitCode}`;
    }
    if (typeof result.stdout === 'string' || typeof result.stderr === 'string') {
      return 'Command completed';
    }
  }

  // list_directory → "N items"
  if (part.toolName === 'list_directory' || part.toolName === 'mastra_workspace_list_files') {
    if (typeof result.count === 'number') return `${result.count} item${result.count !== 1 ? 's' : ''}`;
    if (Array.isArray(result.items)) return `${result.items.length} item${result.items.length !== 1 ? 's' : ''}`;
  }

  return '';
}

type MiniPreviewLine = { lineNum: number; text: string; type: 'added' | 'removed' | 'context' };

/** Returns a small set of lines to preview for Write/Edit tools */
function getMiniCodePreview(part: ToolCallPart): { lines: MiniPreviewLine[]; language: string } | null {
  const isWrite = part.toolName === 'file_write' || part.toolName === 'mastra_workspace_write_file';
  const isEdit = part.toolName === 'file_edit' || part.toolName === 'mastra_workspace_edit_file';
  if (!isWrite && !isEdit) return null;

  const args = part.args as Record<string, unknown>;
  const filePath = typeof args.path === 'string' ? args.path : '';
  const language = langFromPath(filePath);
  const MAX_PREVIEW = 5;

  if (isWrite && typeof args.content === 'string') {
    const allLines = args.content.split('\n');
    const preview = allLines.slice(0, MAX_PREVIEW);
    return {
      language,
      lines: preview.map((text, i) => ({ lineNum: i + 1, text, type: 'added' as const })),
    };
  }

  if (isEdit) {
    // Try to show new_string (the replacement) as added lines
    const newStr = typeof args.new_string === 'string' ? args.new_string : typeof args.newContent === 'string' ? args.newContent : null;
    if (newStr) {
      const allLines = newStr.split('\n');
      const preview = allLines.slice(0, MAX_PREVIEW);
      return {
        language,
        lines: preview.map((text, i) => ({ lineNum: i + 1, text, type: 'added' as const })),
      };
    }
  }

  return null;
}

/** Mini inline code preview shown below Write/Edit tool headers */
const MiniCodePreview: FC<{ lines: MiniPreviewLine[]; language: string }> = ({ lines }) => {
  if (lines.length === 0) return null;
  return (
    <div className="mt-1 mb-0.5 rounded-md overflow-hidden border border-border/30" style={{ backgroundColor: 'var(--mini-preview-bg, #1e1e1e)' }}>
      <table className="w-full text-[11px] font-mono leading-5 border-collapse">
        <tbody>
          {lines.map((line) => (
            <tr
              key={line.lineNum}
              className={line.type === 'added' ? 'bg-emerald-500/10' : line.type === 'removed' ? 'bg-red-500/10' : ''}
            >
              <td
                className="select-none text-right pr-3 pl-2 text-muted-foreground/40 tabular-nums w-8 shrink-0 border-r border-border/20"
                style={{ userSelect: 'none' }}
              >
                {line.lineNum}
              </td>
              <td className={`pl-3 pr-2 whitespace-pre truncate max-w-0 ${line.type === 'added' ? 'text-emerald-300' : line.type === 'removed' ? 'text-red-300' : 'text-foreground/70'}`}>
                {line.text || ' '}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

function formatArgs(args: unknown): string {
  try {
    return JSON.stringify(args, null, 2);
  } catch {
    return String(args);
  }
}

function formatResult(result: unknown): string {
  const sanitized = sanitizeResultForDisplay(result);
  if (typeof sanitized === 'string') return sanitized;
  try {
    return JSON.stringify(sanitized, null, 2);
  } catch {
    return String(sanitized);
  }
}

function sanitizeResultForDisplay(result: unknown): unknown {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return result;
  const record = result as Record<string, unknown>;
  const internalKeys = new Set(['observer', 'modelStream', '__compaction', '__executeToolCallId']);
  const visibleEntries = Object.entries(record).filter(([key]) => !internalKeys.has(key));
  const visible = Object.fromEntries(visibleEntries);

  // Observer augmentation may wrap primitive results as { value, observer }.
  if ('value' in visible && Object.keys(visible).length === 1) {
    return visible.value;
  }

  return visible;
}

function formatLiveOutput(output?: { stdout?: string; stderr?: string; truncated?: boolean; stopped?: boolean }): string {
  if (!output) return '';
  const chunks: string[] = [];
  if (output.stdout) chunks.push(`STDOUT\n${output.stdout}`);
  if (output.stderr) chunks.push(`STDERR\n${output.stderr}`);
  if (output.truncated) chunks.push('[output truncated]');
  if (output.stopped) chunks.push('[streaming stopped at max output]');
  return chunks.join('\n\n') || '[no output yet]';
}
