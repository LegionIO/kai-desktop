import { useState, useRef, useCallback, useEffect, type FC, type KeyboardEvent } from 'react';
import { SparklesIcon, SendIcon, LoaderIcon, WrenchIcon, XIcon } from 'lucide-react';
import { cn, generateId } from '@/lib/utils';
import { useWorkspace } from '@/providers/WorkspaceProvider';
import type { InsightMessage } from '../../../shared/workspace-types';

/* ── Timestamp formatter ───────────────────────────────────── */

function formatTimestamp(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/* ── Component ─────────────────────────────────────────────── */

export const InsightsView: FC = () => {
  const { project, insightMessages: messages, setInsightMessages: setMessages, engineStreams, startEngineStream, cancelEngineStream } = useWorkspace();
  const projectName = project?.name ?? 'your project';
  const projectPath = project?.path ?? '';

  const [input, setInput] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);

  // Derive streaming state from provider
  const stream = engineStreams.get('insights');
  const isStreaming = stream?.status === 'streaming';
  const activeToolName = stream?.activeToolName ?? null;

  const SAMPLE_QUESTIONS = [
    `What frameworks does ${projectName} use?`,
    `Summarize the folder structure of ${projectName}`,
    `Find potential security issues in ${projectName}`,
    `Explain the data flow in ${projectName}`,
    `Analyze the architecture of ${projectName}`,
    `List key dependencies for ${projectName}`,
  ];

  // Auto-scroll when messages change
  useEffect(() => {
    requestAnimationFrame(() => {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
    });
  }, [messages]);

  // Track the current assistant message ID for text delta updates
  const assistantMsgIdRef = useRef<string | null>(null);

  const submit = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || isStreaming) return;

      const now = Date.now();
      const userMsg: InsightMessage = {
        id: generateId(),
        role: 'user',
        content: trimmed,
        timestamp: now,
      };
      const assistantMsgId = generateId();
      assistantMsgIdRef.current = assistantMsgId;
      const assistantMsg: InsightMessage = {
        id: assistantMsgId,
        role: 'assistant',
        content: '',
        timestamp: now + 1,
      };

      setMessages((prev) => [...prev, userMsg, assistantMsg]);
      setInput('');

      if (!projectPath) {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantMsgId
              ? { ...m, content: 'No project is selected. Open a project first so I can analyze its codebase.' }
              : m,
          ),
        );
        return;
      }

      startEngineStream({
        engine: 'insights',
        prompt: trimmed,
        onTextDelta: (delta) => {
          const msgId = assistantMsgIdRef.current;
          if (!msgId) return;
          setMessages((prev) =>
            prev.map((m) =>
              m.id === msgId ? { ...m, content: m.content + delta } : m,
            ),
          );
        },
        onComplete: () => {
          assistantMsgIdRef.current = null;
        },
        onError: (error) => {
          const msgId = assistantMsgIdRef.current;
          if (!msgId) return;
          setMessages((prev) =>
            prev.map((m) =>
              m.id === msgId ? { ...m, content: m.content + `\n\n**Error:** ${error}` } : m,
            ),
          );
          assistantMsgIdRef.current = null;
        },
      });
    },
    [projectPath, isStreaming, setMessages, startEngineStream],
  );

  const handleCancel = useCallback(() => {
    cancelEngineStream('insights');
    assistantMsgIdRef.current = null;
  }, [cancelEngineStream]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        submit(input);
      }
    },
    [input, submit],
  );

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="border-b border-border/70 px-5 py-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-foreground">Insights</h2>
          {isStreaming && activeToolName && (
            <span className="inline-flex items-center gap-1.5 rounded-md bg-blue-500/10 px-2 py-0.5 text-[10px] font-medium text-blue-400">
              <WrenchIcon className="h-3 w-3 animate-pulse" />
              {activeToolName}
            </span>
          )}
        </div>
        <p className="mt-0.5 text-xs text-muted-foreground/60">
          Explore your codebase{project ? ` -- ${project.name}` : ''}
        </p>
      </div>

      {/* Messages area */}
      <div ref={scrollRef} className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
        {messages.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-4 text-center">
            <SparklesIcon className="h-10 w-10 text-muted-foreground/40" />
            <div>
              <p className="text-sm font-medium text-muted-foreground">
                Ask a question about your codebase
              </p>
              <p className="mt-1 text-xs text-muted-foreground/60">
                AI-powered insights into your project
              </p>
            </div>
            <div className="flex flex-wrap justify-center gap-2">
              {SAMPLE_QUESTIONS.map((q) => (
                <button
                  key={q}
                  type="button"
                  onClick={() => submit(q)}
                  disabled={isStreaming}
                  className="rounded-lg border border-border/50 bg-muted/10 px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:border-border hover:text-foreground disabled:opacity-50"
                >
                  {q}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <>
            {messages.map((msg) => (
              <div
                key={msg.id}
                className={cn(
                  'flex flex-col gap-1',
                  msg.role === 'user' ? 'items-end' : 'items-start',
                )}
              >
                <div
                  className={cn(
                    'max-w-[85%] rounded-xl px-3.5 py-2.5 text-sm leading-relaxed whitespace-pre-wrap',
                    msg.role === 'user'
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-muted text-foreground',
                  )}
                >
                  {msg.role === 'assistant' && !msg.content && isStreaming ? (
                    <span className="inline-flex items-center gap-1.5 text-muted-foreground/60">
                      <LoaderIcon className="h-3 w-3 animate-spin" />
                      {activeToolName ? `Using ${activeToolName}...` : 'Thinking...'}
                    </span>
                  ) : (
                    msg.content
                  )}
                </div>
                <span className="px-1 text-[10px] text-muted-foreground/40">
                  {formatTimestamp(msg.timestamp)}
                </span>
              </div>
            ))}
          </>
        )}
      </div>

      {/* Input area */}
      <div className="border-t border-border/70 p-3">
        <div className="flex items-end gap-2 rounded-xl border border-border/50 bg-muted/10 px-3 py-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask about your codebase..."
            rows={1}
            disabled={isStreaming}
            className="min-h-[24px] max-h-[120px] flex-1 resize-none bg-transparent text-sm text-foreground placeholder:text-muted-foreground/40 focus:outline-none disabled:opacity-50"
          />
          {isStreaming ? (
            <button
              type="button"
              onClick={handleCancel}
              className="shrink-0 rounded-lg p-1.5 text-red-400 transition-colors hover:bg-red-500/10"
              title="Stop"
            >
              <XIcon className="h-4 w-4" />
            </button>
          ) : (
            <button
              type="button"
              onClick={() => submit(input)}
              disabled={!input.trim()}
              className="shrink-0 rounded-lg p-1.5 text-primary transition-colors hover:bg-primary/10 disabled:opacity-30 disabled:hover:bg-transparent"
            >
              <SendIcon className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
