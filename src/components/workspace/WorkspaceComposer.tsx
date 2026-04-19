import { useState, useCallback, useEffect, useRef, type FC, type FormEvent } from 'react';
import { SendIcon, PackageIcon, LoaderIcon, CheckCircle2Icon, AlertCircleIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useWorkspace } from '@/providers/WorkspaceProvider';

/* ── Keyword matching ─────────────────────────────────────── */

const CAPABILITY_KEYWORDS: Record<string, string[]> = {
  'list-issues': ['issues', 'bugs', 'open issues', 'list issues', 'show issues', 'bug list'],
  'create-issue': ['create issue', 'new issue', 'file issue', 'open issue', 'report bug', 'submit issue'],
  'list-prs': ['pull requests', 'prs', 'open prs', 'list prs', 'show prs', 'merge requests'],
  'import-stories': ['stories', 'user stories', 'import stories', 'rally stories', 'backlog'],
  'sync-status': ['sync', 'sync status', 'push status', 'update rally', 'sync rally'],
};

/* ── Simulated responses ──────────────────────────────────── */

const SIMULATED_RESPONSES: Record<string, string> = {
  'list-issues':
    'Found 5 open issues in owner/repo:\n  #12 Fix authentication token refresh\n  #15 Update dependency versions\n  #18 Add input validation to settings form\n  #21 Terminal output not scrolling on new content\n  #24 Roadmap progress bar misaligned on mobile',
  'create-issue':
    'Issue created successfully:\n  #25 New issue created from workspace prompt\n  Labels: workspace, auto-created\n  Assignee: unassigned',
  'list-prs':
    'Found 3 open pull requests in owner/repo:\n  #42 feat: add plugin capability routing (2 reviews pending)\n  #43 fix: terminal scroll behavior (approved, ready to merge)\n  #44 chore: update dependencies (CI running)',
  'import-stories':
    'Imported 4 stories from Rally project:\n  US1234 - Implement SSO login flow (8 pts)\n  US1235 - Add dashboard metrics panel (5 pts)\n  US1236 - Create notification preferences page (3 pts)\n  US1237 - Write API integration tests (5 pts)',
  'sync-status':
    'Status synced to Rally:\n  3 tasks updated (in_progress -> Completed)\n  1 task updated (planning -> In-Progress)\n  Sync completed at ' + new Date().toLocaleTimeString(),
};

/* ── Conversation message type ────────────────────────────── */

interface ConversationMessage {
  id: string;
  role: 'user' | 'system' | 'assistant';
  content: string;
  timestamp: number;
  matchedCapabilities?: Array<{ pluginName: string; capabilityName: string }>;
}

/* ── Routing animation phases ─────────────────────────────── */

type RoutingPhase = 'analyzing' | 'matched' | 'executing' | 'done' | null;

/* ── Component ────────────────────────────────────────────── */

export const WorkspaceComposer: FC = () => {
  const { allCapabilities, project } = useWorkspace();
  const [prompt, setPrompt] = useState('');
  const [conversation, setConversation] = useState<ConversationMessage[]>([]);
  const [routingPhase, setRoutingPhase] = useState<RoutingPhase>(null);
  const [matchedCaps, setMatchedCaps] = useState<Array<{ pluginName: string; capabilityName: string; capabilityId: string }>>([]);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [conversation, routingPhase]);

  const handleSubmit = useCallback(
    (e: FormEvent) => {
      e.preventDefault();
      const trimmed = prompt.trim();
      if (!trimmed || routingPhase) return;

      const userMsg: ConversationMessage = {
        id: `${Date.now()}-user`,
        role: 'user',
        content: trimmed,
        timestamp: Date.now(),
      };
      setConversation((prev) => [...prev, userMsg]);
      setPrompt('');

      // Start routing animation
      setRoutingPhase('analyzing');

      const lower = trimmed.toLowerCase();

      // Match capabilities by keyword
      const matched = allCapabilities.filter((cap) => {
        const keywords = CAPABILITY_KEYWORDS[cap.capabilityId] ?? [];
        // Also check if the capability name or description words appear in the prompt
        const nameWords = cap.name.toLowerCase().split(/\s+/);
        const descWords = cap.description.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
        return (
          keywords.some((kw) => lower.includes(kw)) ||
          nameWords.some((w) => lower.includes(w.toLowerCase())) ||
          descWords.filter((w) => lower.includes(w)).length >= 2
        );
      });

      const matchedForState = matched.map((m) => ({
        pluginName: m.pluginName,
        capabilityName: m.name,
        capabilityId: m.capabilityId,
      }));

      setTimeout(() => {
        setMatchedCaps(matchedForState);
        setRoutingPhase('matched');

        if (matched.length === 0) {
          // No match
          setTimeout(() => {
            const noMatchMsg: ConversationMessage = {
              id: `${Date.now()}-nomatch`,
              role: 'assistant',
              content: 'No matching plugin capabilities found. Try installing plugins or rephrasing your request.',
              timestamp: Date.now(),
            };
            setConversation((prev) => [...prev, noMatchMsg]);
            setRoutingPhase(null);
            setMatchedCaps([]);
          }, 800);
          return;
        }

        setTimeout(() => {
          setRoutingPhase('executing');

          setTimeout(() => {
            // Build simulated result
            const results = matched.map((cap) => {
              const sim = SIMULATED_RESPONSES[cap.capabilityId];
              return sim
                ? `[${cap.pluginName} / ${cap.name}]\n${sim}`
                : `[${cap.pluginName} / ${cap.name}]\nCapability executed successfully.`;
            });

            const assistantMsg: ConversationMessage = {
              id: `${Date.now()}-assistant`,
              role: 'assistant',
              content: results.join('\n\n'),
              timestamp: Date.now(),
              matchedCapabilities: matched.map((m) => ({ pluginName: m.pluginName, capabilityName: m.name })),
            };
            setConversation((prev) => [...prev, assistantMsg]);
            setRoutingPhase('done');

            setTimeout(() => {
              setRoutingPhase(null);
              setMatchedCaps([]);
            }, 500);
          }, 1200);
        }, 600);
      }, 800);
    },
    [prompt, allCapabilities, routingPhase],
  );

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border/70 px-5 py-3">
        <h2 className="text-sm font-semibold text-foreground">Workspace Prompt</h2>
        {allCapabilities.length > 0 && (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-primary/20 bg-primary/5 px-2.5 py-0.5 text-[10px] font-medium text-primary">
            <PackageIcon className="h-3 w-3" />
            {allCapabilities.length} {allCapabilities.length === 1 ? 'capability' : 'capabilities'} available
          </span>
        )}
      </div>

      {/* Conversation area */}
      <div ref={scrollRef} className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-5">
        {/* Empty state */}
        {conversation.length === 0 && !routingPhase && (
          <>
            <div className="rounded-lg border border-border/50 bg-card/40 px-4 py-3">
              <p className="text-xs text-muted-foreground leading-relaxed">
                Send instructions that will be routed through your installed plugin capabilities.
                The LLM will decide which plugins to invoke based on your prompt.
              </p>
              {allCapabilities.length === 0 && (
                <p className="mt-2 text-xs text-amber-400/80">
                  No plugin capabilities are available. Install and enable plugins to unlock this feature.
                </p>
              )}
            </div>

            {/* Available capabilities summary */}
            {allCapabilities.length > 0 && (
              <div className="space-y-1.5">
                <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/60">
                  Available Capabilities
                </h3>
                <div className="flex flex-wrap gap-1.5">
                  {allCapabilities.map((cap) => (
                    <span
                      key={`${cap.pluginId}:${cap.capabilityId}`}
                      className="inline-flex items-center rounded-md border border-border/50 bg-muted/20 px-2 py-0.5 text-[10px] text-muted-foreground"
                      title={cap.description}
                    >
                      <span className="font-medium text-foreground/70">{cap.pluginName}</span>
                      <span className="mx-1 text-border">/</span>
                      {cap.name}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </>
        )}

        {/* Messages */}
        {conversation.map((msg) => (
          <div
            key={msg.id}
            className={cn(
              'rounded-lg px-4 py-3',
              msg.role === 'user'
                ? 'self-end border border-primary/20 bg-primary/5 max-w-[85%]'
                : msg.role === 'assistant'
                  ? 'self-start border border-border/50 bg-card/60 max-w-[90%]'
                  : 'self-start border border-amber-500/20 bg-amber-500/5 max-w-[90%]',
            )}
          >
            {msg.role !== 'user' && msg.matchedCapabilities && msg.matchedCapabilities.length > 0 && (
              <div className="mb-2 flex flex-wrap gap-1">
                {msg.matchedCapabilities.map((mc, i) => (
                  <span
                    key={i}
                    className="inline-flex items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[9px] font-medium text-emerald-400"
                  >
                    <CheckCircle2Icon className="h-2.5 w-2.5" />
                    {mc.pluginName} / {mc.capabilityName}
                  </span>
                ))}
              </div>
            )}
            <pre className="whitespace-pre-wrap text-xs text-foreground/80 font-mono leading-relaxed">
              {msg.content}
            </pre>
            <span className="mt-1 block text-[9px] text-muted-foreground/40">
              {new Date(msg.timestamp).toLocaleTimeString()}
            </span>
          </div>
        ))}

        {/* Routing animation */}
        {routingPhase && (
          <div className="self-start rounded-lg border border-purple-500/20 bg-purple-500/5 px-4 py-3 max-w-[90%]">
            <div className="flex flex-col gap-2 text-xs">
              <div className={cn(
                'flex items-center gap-2 transition-opacity',
                routingPhase === 'analyzing' ? 'text-purple-400' : 'text-muted-foreground/50',
              )}>
                {routingPhase === 'analyzing' ? (
                  <LoaderIcon className="h-3 w-3 animate-spin" />
                ) : (
                  <CheckCircle2Icon className="h-3 w-3 text-emerald-400" />
                )}
                Analyzing request...
              </div>

              {(routingPhase === 'matched' || routingPhase === 'executing' || routingPhase === 'done') && (
                <div className={cn(
                  'flex items-center gap-2',
                  routingPhase === 'matched' ? 'text-purple-400' : 'text-muted-foreground/50',
                )}>
                  {routingPhase === 'matched' ? (
                    <LoaderIcon className="h-3 w-3 animate-spin" />
                  ) : (
                    <CheckCircle2Icon className="h-3 w-3 text-emerald-400" />
                  )}
                  {matchedCaps.length > 0
                    ? `Matched capabilities: ${matchedCaps.map((m) => `${m.pluginName} / ${m.capabilityName}`).join(', ')}`
                    : 'No matching capabilities found'}
                </div>
              )}

              {(routingPhase === 'executing' || routingPhase === 'done') && matchedCaps.length > 0 && (
                <div className={cn(
                  'flex items-center gap-2',
                  routingPhase === 'executing' ? 'text-purple-400' : 'text-muted-foreground/50',
                )}>
                  {routingPhase === 'executing' ? (
                    <LoaderIcon className="h-3 w-3 animate-spin" />
                  ) : (
                    <CheckCircle2Icon className="h-3 w-3 text-emerald-400" />
                  )}
                  Executing...
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Input area */}
      <div className="border-t border-border/70 p-4">
        <form onSubmit={handleSubmit} className="flex gap-2">
          <input
            type="text"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder={
              allCapabilities.length > 0
                ? 'Ask something using your workspace plugins...'
                : 'Install plugins to enable workspace prompts...'
            }
            disabled={allCapabilities.length === 0 || !!routingPhase}
            className="flex-1 rounded-lg border border-border bg-card px-3 py-2 text-xs text-foreground placeholder:text-muted-foreground/50 outline-none focus:ring-1 focus:ring-ring disabled:opacity-40"
          />
          <button
            type="submit"
            disabled={!prompt.trim() || allCapabilities.length === 0 || !!routingPhase}
            className="inline-flex items-center justify-center rounded-lg bg-primary px-3 py-2 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <SendIcon className="h-3.5 w-3.5" />
          </button>
        </form>
      </div>
    </div>
  );
};
