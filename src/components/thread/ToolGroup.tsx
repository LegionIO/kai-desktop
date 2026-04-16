import { useState, useCallback, type FC } from 'react';
import { CodeBlock } from './CodeBlock';
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
} from 'lucide-react';
import { app } from '@/lib/ipc-client';

type ToolCallPart = {
  type: 'tool-call';
  toolCallId: string;
  toolName: string;
  args: unknown;
  argsText?: string;
  result?: unknown;
  isError?: boolean;
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
};

export const ToolGroup: FC<{ parts: ToolCallPart[] }> = ({ parts }) => {
  if (parts.length === 0) return null;

  return (
    <div className="my-2 space-y-1.5">
      {parts.map((part) => (
        <ToolCallDisplay key={part.toolCallId} part={part} />
      ))}
    </div>
  );
};

export const ToolCallDisplay: FC<{ part: ToolCallPart }> = ({ part }) => {
  const [expanded, setExpanded] = useState(false);
  const [showOriginal, setShowOriginal] = useState(false);
  const hasResult = part.result !== undefined;
  const isError = part.isError || (hasResult && isErrorResult(part.result));
  const isRunning = !hasResult;
  const hasLiveOutput = Boolean(part.liveOutput?.stdout || part.liveOutput?.stderr);
  const wasCompacted = Boolean(part.compactionMeta?.wasCompacted);
  const canShowOriginal = wasCompacted && part.originalResult !== undefined;
  const isSummarizing = part.compactionPhase === 'start';
  const mediaResult = hasResult && !isError ? detectMediaResult(part.result) : null;
  const todoItems = detectTodoItems(part);

  const summary = getToolSummary(part);

  return (
    <div className="text-sm">
      {/* Compact header row — label + description */}
      <button
        type="button"
        className="flex w-full items-center gap-2 py-1 hover:bg-muted/30 rounded-md px-1 -mx-1 transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        <span className="font-semibold text-xs text-foreground">{getToolLabel(part.toolName)}</span>
        {summary && (
          <span className="text-xs text-muted-foreground truncate">{summary}</span>
        )}
        {isSummarizing && (
          <span className="text-[10px] text-amber-500 animate-pulse shrink-0">Summarizing...</span>
        )}
        <span className="ml-auto shrink-0">
          <ToolElapsedBadge
            isRunning={isRunning}
            isError={Boolean(isError)}
            startedAt={part.startedAt}
            finishedAt={part.finishedAt}
            durationMs={part.durationMs}
          />
        </span>
      </button>

      {/* Todo items — always visible below header */}
      {todoItems && <TodoListView items={todoItems} />}

      {/* Expanded detail */}
      {expanded && (
        <div className="ml-5 mt-1 mb-2 border-l-2 border-border/50 pl-3">
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
              <CodeBlock
                code={formatResult(canShowOriginal && showOriginal ? part.originalResult : part.result)}
                language="json"
                isError={isError}
              />
            </ToolSection>
          )}
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
              <button
                type="button"
                onClick={() => handleSave(url)}
                className="absolute top-2 right-2 opacity-100 md:opacity-0 md:group-hover:opacity-80 transition-opacity bg-black/60 hover:bg-black/80 text-white rounded-md p-1.5"
                title="Save image"
              >
                <DownloadIcon className="h-3.5 w-3.5" />
              </button>
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
          <button
            type="button"
            onClick={() => handleSave(media.urls[0])}
            className="absolute top-2 right-2 opacity-100 md:opacity-0 md:group-hover:opacity-80 transition-opacity bg-black/60 hover:bg-black/80 text-white rounded-md p-1.5"
            title="Save video"
          >
            <DownloadIcon className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    );
  }

  return null;
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
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
}> = ({ isRunning, isError, startedAt, finishedAt, durationMs }) => {
  return (
    <ElapsedBadge
      startedAt={startedAt}
      finishedAt={finishedAt}
      durationMs={durationMs}
      isRunning={isRunning}
      isError={isError}
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
