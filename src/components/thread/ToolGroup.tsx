import { useState, useCallback, type FC } from 'react';
import { CodeBlock } from './CodeBlock';
import { MarkdownText } from './MarkdownText';
import { ElapsedBadge } from './ElapsedBadge';
import {
  ChevronDownIcon,
  ChevronRightIcon,
  CheckIcon,
  SquareIcon,
  AsteriskIcon,
  LoaderIcon,
  ScissorsIcon,
  DownloadIcon,
  FileIcon,
  FolderIcon,
  ExternalLinkIcon,
  TerminalIcon,
  AlertTriangleIcon,
  CodeIcon,
  BookOpenIcon,
  ScrollTextIcon,
  SendHorizontalIcon,
} from 'lucide-react';
import { app } from '@/lib/ipc-client';
import { Tooltip } from '@/components/ui/Tooltip';

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

export const ToolGroup: FC<{ parts: ToolCallPart[]; onSendFeedback?: (text: string) => void }> = ({ parts, onSendFeedback }) => {
  if (parts.length === 0) return null;

  return (
    <div className="my-2 space-y-1.5">
      {parts.map((part) => (
        <ToolCallDisplay key={part.toolCallId} part={part} onSendFeedback={onSendFeedback} />
      ))}
    </div>
  );
};

export const ToolCallDisplay: FC<{ part: ToolCallPart; onSendFeedback?: (text: string) => void }> = ({ part, onSendFeedback }) => {
  const [expanded, setExpanded] = useState(false);
  const [showOriginal, setShowOriginal] = useState(false);
  const [localApproval, setLocalApproval] = useState<'approved' | 'rejected' | null>(null);
  const [feedbackText, setFeedbackText] = useState('');
  const hasResult = part.result !== undefined;
  const isHung = Boolean(part.isHung);
  const isError = !isHung && (part.isError || (hasResult && isErrorResult(part.result)));
  const isRunning = !hasResult && !isHung;
  const hasLiveOutput = Boolean(part.liveOutput?.stdout || part.liveOutput?.stderr);
  const wasCompacted = Boolean(part.compactionMeta?.wasCompacted);
  const canShowOriginal = wasCompacted && part.originalResult !== undefined;
  const isSummarizing = part.compactionPhase === 'start';
  const mediaResult = hasResult && !isError ? detectMediaResult(part.result) : null;
  const todoItems = detectTodoItems(part);
  const smartResult = hasResult && !isError ? detectSmartResult(part) : null;
  const approvalStatus = localApproval ?? part.approvalStatus;
  const isPendingApproval = approvalStatus === 'pending';
  const isPlanApproval = part.toolName === 'exit_plan_mode';
  const isAskUser = part.toolName === 'ask_user';

  const handleApprove = useCallback(() => {
    setLocalApproval('approved');
    void app.agent.approveToolCall(part.approvalId ?? part.toolCallId);
  }, [part.toolCallId, part.approvalId]);

  const handleReject = useCallback(() => {
    setLocalApproval('rejected');
    void app.agent.rejectToolCall(part.approvalId ?? part.toolCallId);
  }, [part.toolCallId, part.approvalId]);

  const handleFeedbackSubmit = useCallback(() => {
    if (!feedbackText.trim()) return;
    setLocalApproval('rejected');
    void app.agent.rejectToolCall(part.approvalId ?? part.toolCallId);
    onSendFeedback?.(feedbackText.trim());
    setFeedbackText('');
  }, [part.toolCallId, part.approvalId, feedbackText, onSendFeedback]);

  const summary = getToolSummary(part);

  return (
    <div className="text-sm min-w-0 flex-1">
      {/* Compact header row — label + description */}
      <button
        type="button"
        className="group/tool flex w-full items-center gap-2 py-1 hover:bg-muted/30 rounded-md px-1 -mx-1 transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        <span className="font-semibold text-xs text-foreground whitespace-nowrap shrink-0">{getToolLabel(part.toolName)}</span>
        {summary && (
          <span className="text-xs text-muted-foreground truncate min-w-0">{summary}</span>
        )}
        {isHung && (
          <span className="text-[10px] font-medium text-amber-500 shrink-0">HUNG</span>
        )}
        {isSummarizing && (
          <span className="text-[10px] text-amber-500 animate-pulse shrink-0">Summarizing...</span>
        )}
        <span className={`ml-auto shrink-0 transition-opacity duration-300 ${isRunning ? 'opacity-100' : 'opacity-0 group-hover/tool:opacity-100'}`}>
          <ToolElapsedBadge
            isRunning={isRunning}
            isError={Boolean(isError)}
            isHung={isHung}
            startedAt={part.startedAt}
            finishedAt={part.finishedAt}
            durationMs={part.durationMs}
          />
        </span>
      </button>

      {/* Ask user questionnaire UI */}
      {isPendingApproval && isAskUser && (
        <QuestionnaireView
          toolCallId={part.approvalId ?? part.toolCallId}
          args={part.args}
          onSubmit={() => setLocalApproval('approved')}
        />
      )}
      {approvalStatus === 'approved' && isAskUser && (
        <div className="ml-1 mt-1 flex items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400">
          <CheckIcon className="h-3 w-3" />
          <span>Answered</span>
        </div>
      )}
      {/* Tool approval — plan mode exit */}
      {isPendingApproval && isPlanApproval && (
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
          {onSendFeedback && (
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={feedbackText}
                onChange={(e) => setFeedbackText(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleFeedbackSubmit(); }}
                placeholder="Tell Kai what to do instead"
                className="flex-1 rounded-lg border border-border/50 bg-background px-3 py-1.5 text-xs text-foreground placeholder:text-muted-foreground/50 outline-none focus:ring-1 focus:ring-primary/40"
              />
              <button
                type="button"
                onClick={handleFeedbackSubmit}
                disabled={!feedbackText.trim()}
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-30 disabled:cursor-not-allowed"
              >
                <SendHorizontalIcon className="h-3 w-3" />
              </button>
            </div>
          )}
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
      {approvalStatus === 'approved' && localApproval === 'approved' && !isAskUser && (
        <div className="ml-1 mt-1 flex items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400">
          <CheckIcon className="h-3 w-3" />
          <span>{isPlanApproval ? 'Plan accepted — implementing' : 'Approved'}</span>
        </div>
      )}
      {approvalStatus === 'rejected' && !isAskUser && (
        <div className="ml-1 mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
          <SquareIcon className="h-3 w-3" />
          <span>{isPlanApproval ? 'Continuing to plan' : 'Rejected'}</span>
        </div>
      )}

      {/* Todo items — always visible below header */}
      {todoItems && <TodoListView items={todoItems} />}

      {/* Expanded detail */}
      {expanded && (
        <div className="tool-detail-code ml-5 mt-1 mb-2 pl-3">
          {/* Arguments section */}
          <ToolSection title="Arguments" defaultOpen>
            <CodeBlock code={formatArgs(part.args)} language="json" />
          </ToolSection>

          {/* Pre-extraction / In-progress indicator */}
          {isRunning && !isSummarizing && (
            <div className="py-1.5">
              <div className="flex items-center gap-2">
                <LoaderIcon className="h-3.5 w-3.5 animate-spin text-blue-500" />
                <span className="text-xs text-blue-600 dark:text-blue-400">Executing tool...</span>
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
            <ToolSection title="Live Output" defaultOpen={isRunning}>
              <CodeBlock code={formatLiveOutput(part.liveOutput)} language="text" />
            </ToolSection>
          )}

          {/* Result section — with compacted/original toggle when available */}
          {hasResult && (
            <ToolSection
              title={isError ? 'Error' : 'Result'}
              defaultOpen
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
      )}
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
}> = ({ toolCallId, args, onSubmit }) => {
  const questions = parseQuestions(args);
  const [activeTab, setActiveTab] = useState(0);
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [otherTexts, setOtherTexts] = useState<Record<number, string>>({});

  const handleSelect = useCallback((qIdx: number, value: string) => {
    setAnswers((prev) => ({ ...prev, [qIdx]: value }));
    // Clear "other" text when a predefined option is selected
    if (value !== '__other__') {
      setOtherTexts((prev) => { const next = { ...prev }; delete next[qIdx]; return next; });
    }
  }, []);

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
  }, [toolCallId, questions, answers, otherTexts, onSubmit]);

  if (questions.length === 0) return null;

  const active = questions[activeTab];
  const hasAllAnswers = questions.every((_, i) => {
    const a = answers[i];
    return a && (a !== '__other__' || otherTexts[i]?.trim());
  });

  return (
    <div className="ml-1 mt-2 rounded-xl border border-primary/30 bg-primary/5 overflow-hidden">
      {/* Tabs — only show when multiple questions */}
      {questions.length > 1 && (
        <div className="flex border-b border-border/30">
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
        <div className="flex justify-end">
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!hasAllAnswers}
            className="rounded-lg bg-primary px-4 py-1.5 text-[11px] font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-30 disabled:cursor-not-allowed"
          >
            Submit answers
          </button>
        </div>
      </div>
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

function detectShResult(result: unknown, toolName: string): ShData | null {
  if (toolName !== 'sh') return null;
  if (typeof result === 'string') {
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

/** Detect the smart result type for a tool call */
function detectSmartResult(part: ToolCallPart): { type: 'file_read'; data: FileReadData } | { type: 'glob'; data: GlobData } | { type: 'list_dir'; data: ListDirData } | { type: 'sh'; data: ShData } | null {
  const result = sanitizeResultForDisplay(part.result);
  if (part.toolName === 'file_read') {
    const data = detectFileReadResult(result);
    if (data) return { type: 'file_read', data };
  }
  if (part.toolName === 'glob') {
    const data = detectGlobResult(result);
    if (data) return { type: 'glob', data };
  }
  if (part.toolName === 'list_directory') {
    const data = detectListDirResult(result);
    if (data) return { type: 'list_dir', data };
  }
  const shData = detectShResult(result, part.toolName);
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

const ToolSection: FC<{ title: string; defaultOpen?: boolean; badge?: React.ReactNode; children: React.ReactNode }> = ({ title, defaultOpen = false, badge, children }) => {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="mt-1">
      <button
        type="button"
        className="flex w-full items-center gap-1.5 py-1 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider hover:text-foreground/70 transition-colors"
        onClick={() => setOpen(!open)}
      >
        {open ? <ChevronDownIcon className="h-2.5 w-2.5" /> : <ChevronRightIcon className="h-2.5 w-2.5" />}
        {title}
        {badge}
      </button>
      {open && <div className="pb-1">{children}</div>}
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
  file_read: 'Read',
  file_write: 'Write',
  file_edit: 'Edit',
  grep: 'Grep',
  glob: 'Glob',
  list_directory: 'List Directory',
  agent_lattice_chat: 'Agent',
  sub_agent: 'Sub Agent',
  generate_image: 'Image Generation',
  generate_video: 'Video Generation',
  ask_user: 'Question',
  enter_plan_mode: 'Enter Plan Mode',
  exit_plan_mode: 'Exit Plan Mode',
};

function getToolLabel(toolName: string): string {
  return toolLabels[toolName] ?? toolName.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function getToolSummary(part: ToolCallPart): string {
  const args = part.args as Record<string, unknown>;
  if (part.toolName === 'sh' && args.command) return String(args.command).slice(0, 60);
  if (part.toolName === 'file_read' && args.path) return String(args.path).split('/').pop() ?? '';
  if (part.toolName === 'file_write' && args.path) return String(args.path).split('/').pop() ?? '';
  if (part.toolName === 'file_edit' && args.path) return String(args.path).split('/').pop() ?? '';
  if (part.toolName === 'grep' && args.pattern) return `/${args.pattern}/`;
  if (part.toolName === 'glob' && args.pattern) return String(args.pattern);
  if (part.toolName === 'list_directory' && args.path) return String(args.path);
  if (part.toolName === 'agent_lattice_chat') return 'Remote agent call';
  if (part.toolName === 'generate_image' && args.prompt) return String(args.prompt).slice(0, 60);
  if (part.toolName === 'generate_video' && args.prompt) return String(args.prompt).slice(0, 60);
  if (part.toolName === 'ask_user' && Array.isArray(args.questions)) {
    const count = (args.questions as unknown[]).length;
    return `${count} question${count !== 1 ? 's' : ''}`;
  }
  if (part.toolName === 'enter_plan_mode') return (args as Record<string, unknown>).reason ? String((args as Record<string, unknown>).reason).slice(0, 60) : '';
  if (part.toolName === 'exit_plan_mode') return (args as Record<string, unknown>).summary ? String((args as Record<string, unknown>).summary).slice(0, 60) : '';
  return '';
}

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
