import { useState, useRef, useCallback, type FC, type KeyboardEvent } from 'react';
import { SparklesIcon, SendIcon } from 'lucide-react';
import { cn, generateId } from '@/lib/utils';
import type { InsightMessage } from '../../../shared/workspace-types';

const SAMPLE_QUESTIONS = [
  'What frameworks does this project use?',
  'Summarize the folder structure',
  'Find potential security issues',
  'Explain the data flow',
];

export const InsightsView: FC = () => {
  const [messages, setMessages] = useState<InsightMessage[]>([]);
  const [input, setInput] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);

  const submit = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;

      const userMsg: InsightMessage = {
        id: generateId(),
        role: 'user',
        content: trimmed,
        timestamp: Date.now(),
      };
      const assistantMsg: InsightMessage = {
        id: generateId(),
        role: 'assistant',
        content: 'Insights will connect to your AI provider in a future update.',
        timestamp: Date.now() + 1,
      };

      setMessages((prev) => [...prev, userMsg, assistantMsg]);
      setInput('');

      // Scroll to bottom on next frame
      requestAnimationFrame(() => {
        scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
      });
    },
    [],
  );

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
        <h2 className="text-sm font-semibold text-foreground">Insights</h2>
        <p className="mt-0.5 text-xs text-muted-foreground/60">Explore your codebase</p>
      </div>

      {/* Messages area */}
      <div ref={scrollRef} className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
        {messages.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-4 text-center">
            <SparklesIcon className="h-10 w-10 text-muted-foreground/40" />
            <div>
              <p className="text-sm font-medium text-muted-foreground">
                Ask a question about your codebase
              </p>
              <p className="mt-1 text-xs text-muted-foreground/60">
                Get AI-powered insights into your project
              </p>
            </div>
            <div className="flex flex-wrap justify-center gap-2">
              {SAMPLE_QUESTIONS.map((q) => (
                <button
                  key={q}
                  type="button"
                  onClick={() => submit(q)}
                  className="rounded-lg border border-border/50 bg-muted/10 px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:border-border hover:text-foreground"
                >
                  {q}
                </button>
              ))}
            </div>
          </div>
        ) : (
          messages.map((msg) => (
            <div
              key={msg.id}
              className={cn(
                'max-w-[80%] rounded-xl px-3.5 py-2.5 text-sm leading-relaxed',
                msg.role === 'user'
                  ? 'self-end bg-primary text-primary-foreground'
                  : 'self-start bg-muted text-foreground',
              )}
            >
              {msg.content}
            </div>
          ))
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
            className="min-h-[24px] max-h-[120px] flex-1 resize-none bg-transparent text-sm text-foreground placeholder:text-muted-foreground/40 focus:outline-none"
          />
          <button
            type="button"
            onClick={() => submit(input)}
            disabled={!input.trim()}
            className="shrink-0 rounded-lg p-1.5 text-primary transition-colors hover:bg-primary/10 disabled:opacity-30 disabled:hover:bg-transparent"
          >
            <SendIcon className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
};
