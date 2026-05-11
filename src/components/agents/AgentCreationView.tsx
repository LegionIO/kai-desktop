/**
 * AgentCreationView — splash screen + composer for creating a new agent.
 *
 * Mirrors the TaskCreationView pattern: full-bleed background with a
 * composer at the bottom. The user describes what the agent should do,
 * and a new agent is created with a random name and those instructions.
 */

import {
  useState,
  useRef,
  useEffect,
  useCallback,
  type FC,
  type KeyboardEvent,
} from 'react';
import { SendHorizonalIcon } from 'lucide-react';
import { SplashBackground } from '@/components/SplashBackground';
import { useAgents } from '@/providers/AgentProvider';
import { useFullWidthContent } from '@/hooks/useFullWidthContent';
import { cn } from '@/lib/utils';

// ── Component ────────────────────────────────────────────────────────────

export const AgentCreationView: FC = () => {
  const { createAgent, selectAgent, setCreatingAgent, synthesizePrompt } = useAgents();
  const fullWidth = useFullWidthContent();

  const [input, setInput] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Focus textarea on mount
  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  // Auto-resize textarea
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 180) + 'px';
  }, [input]);

  const canSend = input.trim().length > 0 && !isSubmitting;

  const handleSubmit = useCallback(async () => {
    const text = input.trim();
    if (!text || isSubmitting) return;

    setIsSubmitting(true);
    try {
      const agent = await createAgent({
        name: 'New Agent',
        role: 'general',
        runtime: 'auto',
        instructions: text,
      });

      if (agent) {
        // Track synthesis in provider (shows spinner in detail view)
        synthesizePrompt(agent.id, text);
        setCreatingAgent(false);
        selectAgent(agent.id);
      }
    } finally {
      setIsSubmitting(false);
    }
  }, [input, isSubmitting, createAgent, selectAgent, setCreatingAgent, synthesizePrompt]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        void handleSubmit();
      }
    },
    [handleSubmit],
  );

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      {/* Full-bleed splash background */}
      <SplashBackground visible storageKey="__agent_bg_last_index" />

      {/* Spacer pushes composer to bottom */}
      <div className="flex-1" />

      {/* Composer at bottom */}
      <div className={cn('relative z-20 mx-auto w-full px-5 pb-4 pt-4 md:pb-5 md:pt-5', !fullWidth && 'max-w-3xl')}>
        <div className="mx-auto w-full">
          <div className="flex flex-col gap-0 rounded-2xl border border-border/70 app-composer-glass px-3 py-3 app-composer-shadow">
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Describe what this agent should do..."
              rows={1}
              className={cn(
                'min-h-[48px] max-h-[220px] w-full resize-none overflow-y-auto bg-transparent px-1 py-0.5 text-base text-foreground placeholder:text-muted-foreground/60 focus:outline-none md:text-[15px]',
                input.includes('\n') && 'pb-3',
              )}
            />
            <div className="flex items-center justify-end pt-0.5">
              <button
                type="button"
                onClick={() => void handleSubmit()}
                disabled={!canSend}
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <SendHorizonalIcon className="h-4 w-4" />
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
