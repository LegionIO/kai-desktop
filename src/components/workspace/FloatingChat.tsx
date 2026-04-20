import { useState, useRef, useEffect, type FC, type KeyboardEvent } from 'react';
import { MessageSquareIcon, XIcon, SendIcon, LoaderIcon, BotIcon, UserIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useWorkspace } from '@/providers/WorkspaceProvider';

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

export const FloatingChat: FC = () => {
  const { project, insightMessages, setInsightMessages, engineStreams, startEngineStream, cancelEngineStream } = useWorkspace();
  const [isOpen, setIsOpen] = useState(false);
  const [input, setInput] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const stream = engineStreams.get('insights');
  const isStreaming = stream?.status === 'streaming';

  // Auto-scroll on new messages
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [insightMessages, stream?.accumulated]);

  // Focus input when opened
  useEffect(() => {
    if (isOpen && inputRef.current) {
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [isOpen]);

  const handleSend = () => {
    const text = input.trim();
    if (!text || isStreaming || !project) return;

    // Add user message
    const userMsg: ChatMessage = {
      id: `user-${Date.now()}`,
      role: 'user',
      content: text,
      timestamp: Date.now(),
    };
    setInsightMessages((prev) => [...prev, userMsg]);
    setInput('');

    // Add placeholder assistant message
    const assistantMsg: ChatMessage = {
      id: `assistant-${Date.now()}`,
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
    };
    setInsightMessages((prev) => [...prev, assistantMsg]);

    // Stream response
    startEngineStream({
      engine: 'insights',
      prompt: text,
      onTextDelta: (delta) => {
        setInsightMessages((prev) => {
          const msgs = [...prev];
          const last = msgs[msgs.length - 1];
          if (last?.role === 'assistant') {
            msgs[msgs.length - 1] = { ...last, content: last.content + delta };
          }
          return msgs;
        });
      },
      onComplete: () => {},
      onError: (error) => {
        setInsightMessages((prev) => {
          const msgs = [...prev];
          const last = msgs[msgs.length - 1];
          if (last?.role === 'assistant') {
            msgs[msgs.length - 1] = { ...last, content: `Error: ${error}` };
          }
          return msgs;
        });
      },
    });
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  if (!project) return null;

  // Toggle button (when closed)
  if (!isOpen) {
    return (
      <button
        type="button"
        onClick={() => setIsOpen(true)}
        className="fixed bottom-4 right-4 z-50 flex h-10 w-10 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg transition-transform hover:scale-105"
        title="Project Chat"
      >
        <MessageSquareIcon className="h-5 w-5" />
      </button>
    );
  }

  // Chat sidebar panel
  return (
    <div className="flex h-full w-80 shrink-0 flex-col border-l border-border/50 bg-background">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border/50 px-4 py-2.5">
        <div className="flex items-center gap-2">
          <MessageSquareIcon className="h-4 w-4 text-muted-foreground" />
          <span className="text-xs font-semibold text-foreground">Project Chat</span>
        </div>
        <button
          type="button"
          onClick={() => setIsOpen(false)}
          className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground/50 transition-colors hover:bg-muted/30 hover:text-foreground"
        >
          <XIcon className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-3 space-y-3">
        {insightMessages.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-2 text-muted-foreground/40">
            <BotIcon className="h-8 w-8" />
            <p className="text-xs text-center">Ask questions about your project.<br />The AI can read files and run commands.</p>
          </div>
        ) : (
          insightMessages.map((msg) => (
            <div key={msg.id} className={cn('flex gap-2', msg.role === 'user' ? 'justify-end' : 'justify-start')}>
              {msg.role === 'assistant' && (
                <div className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/10">
                  <BotIcon className="h-3 w-3 text-primary" />
                </div>
              )}
              <div
                className={cn(
                  'max-w-[85%] rounded-lg px-3 py-2 text-xs leading-relaxed',
                  msg.role === 'user'
                    ? 'bg-primary/15 text-foreground'
                    : 'bg-muted/20 text-muted-foreground/80',
                )}
              >
                {msg.content || (isStreaming ? <span className="inline-block h-3 w-1 bg-primary animate-pulse" /> : null)}
              </div>
              {msg.role === 'user' && (
                <div className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-muted/20">
                  <UserIcon className="h-3 w-3 text-muted-foreground/60" />
                </div>
              )}
            </div>
          ))
        )}
      </div>

      {/* Input */}
      <div className="border-t border-border/50 p-3">
        <div className="flex items-end gap-2">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask about this project..."
            rows={1}
            disabled={isStreaming}
            className="flex-1 resize-none rounded-lg border border-border/40 bg-muted/10 px-3 py-2 text-xs text-foreground placeholder:text-muted-foreground/40 focus:border-primary/50 focus:outline-none disabled:opacity-50"
            style={{ maxHeight: '80px' }}
          />
          <button
            type="button"
            onClick={isStreaming ? () => cancelEngineStream('insights') : handleSend}
            disabled={!isStreaming && !input.trim()}
            className={cn(
              'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-colors',
              isStreaming
                ? 'bg-red-500/10 text-red-400 hover:bg-red-500/20'
                : 'bg-primary/10 text-primary hover:bg-primary/20 disabled:opacity-30',
            )}
          >
            {isStreaming ? <XIcon className="h-3.5 w-3.5" /> : <SendIcon className="h-3.5 w-3.5" />}
          </button>
        </div>
      </div>
    </div>
  );
};
