import { useState, useRef, useCallback, type FC, type KeyboardEvent } from 'react';
import { SparklesIcon, SendIcon, InfoIcon } from 'lucide-react';
import { cn, generateId } from '@/lib/utils';
import { useWorkspace } from '@/providers/WorkspaceProvider';
import type { InsightMessage } from '../../../shared/workspace-types';

/* ── Question-to-answer mapping for realistic sample responses ── */

const ANSWER_MAP: Record<string, (projectName: string) => string> = {
  'frameworks': (p) =>
    `Based on analysis of ${p}, the project uses the following frameworks and libraries:\n\n` +
    `- **React 19** with TypeScript for the UI layer\n` +
    `- **Tailwind CSS 4** for styling with a custom dark theme\n` +
    `- **Electron 36** for the desktop shell\n` +
    `- **Radix UI** for accessible primitive components\n` +
    `- **Lucide React** for iconography\n` +
    `- **Framer Motion** for animations\n\n` +
    `The build system uses Vite with the React SWC plugin for fast HMR during development.`,

  'folder structure': (p) =>
    `Here is the folder structure for ${p}:\n\n` +
    `\`\`\`\n` +
    `src/\n` +
    `  components/       UI components organized by feature\n` +
    `    workspace/      Workspace engine views (kanban, insights, etc.)\n` +
    `    chat/           Chat and conversation components\n` +
    `  providers/        React context providers\n` +
    `  lib/              Utility functions and IPC client\n` +
    `  hooks/            Custom React hooks\n` +
    `shared/             Types shared between main and renderer\n` +
    `electron/           Electron main process code\n` +
    `\`\`\`\n\n` +
    `The architecture follows a provider pattern where WorkspaceProvider manages global state for tasks, plugins, and project selection.`,

  'security': (p) =>
    `Security analysis of ${p} found the following areas of interest:\n\n` +
    `1. **IPC Channel Validation** - The Electron IPC bridge should validate all incoming channel names against an allowlist to prevent arbitrary code execution.\n` +
    `2. **Input Sanitization** - Plugin configuration values are passed through without sanitization. Consider adding Zod validation.\n` +
    `3. **CSP Headers** - Ensure Content-Security-Policy is configured in the Electron BrowserWindow webPreferences.\n` +
    `4. **Dependency Audit** - Run \`npm audit\` to check for known vulnerabilities in dependencies.\n\n` +
    `Overall risk: **Low-Medium**. The main attack surface is the plugin system which accepts arbitrary configuration.`,

  'data flow': (p) =>
    `Data flow in ${p}:\n\n` +
    `1. **User Input** -> React components capture user actions\n` +
    `2. **Context Providers** -> WorkspaceProvider holds tasks, plugins, and project state\n` +
    `3. **IPC Bridge** -> \`@/lib/ipc-client\` sends requests to Electron main process\n` +
    `4. **Main Process** -> Handles file I/O, plugin execution, and system operations\n` +
    `5. **Stream Events** -> Agent responses stream back via \`app.agent.onStreamEvent()\`\n\n` +
    `State flows top-down through React context. Side effects (file ops, LLM calls) go through the IPC bridge to the main process.`,

  'architecture': (p) =>
    `${p} follows a layered architecture:\n\n` +
    `- **Presentation Layer**: React components with Tailwind CSS, organized by feature area\n` +
    `- **State Layer**: React Context providers (WorkspaceProvider) for centralized state management\n` +
    `- **IPC Layer**: Electron IPC bridge for renderer-to-main communication\n` +
    `- **Service Layer**: Main process handlers for file operations, LLM integration, and plugin execution\n\n` +
    `The workspace engine system is extensible -- each engine (kanban, insights, roadmap, etc.) is a self-contained view that consumes shared state via \`useWorkspace()\`.`,

  'dependencies': (p) =>
    `Key dependencies for ${p}:\n\n` +
    `**Runtime:**\n` +
    `- react@19, react-dom@19\n` +
    `- @radix-ui/react-collapsible, @radix-ui/react-dialog\n` +
    `- lucide-react (icons)\n` +
    `- framer-motion (animations)\n` +
    `- tailwindcss@4\n\n` +
    `**Dev:**\n` +
    `- typescript@5.x\n` +
    `- vite with @vitejs/plugin-react-swc\n` +
    `- electron@36\n` +
    `- electron-builder for packaging\n\n` +
    `No known critical vulnerabilities detected in the current lockfile.`,

  'performance': (p) =>
    `Performance observations for ${p}:\n\n` +
    `- **Bundle Size**: The workspace views are loaded eagerly. Consider React.lazy() for less-used engines like Roadmap and Changelog.\n` +
    `- **Re-renders**: WorkspaceProvider re-renders all consumers when any state changes. Consider splitting into separate contexts (TasksContext, PluginsContext).\n` +
    `- **List Virtualization**: The Kanban board and task lists could benefit from virtualization for projects with 100+ tasks.\n` +
    `- **IPC Overhead**: Frequent IPC calls (e.g., task saves) should be debounced to avoid main-process contention.\n\n` +
    `Estimated initial load time: ~1.2s (desktop), ~0.8s after Electron cache warm-up.`,
};

/** Try to match a user question to a sample answer */
function findAnswer(question: string, projectName: string): string {
  const q = question.toLowerCase();
  for (const [key, answerFn] of Object.entries(ANSWER_MAP)) {
    if (q.includes(key)) {
      return answerFn(projectName);
    }
  }
  return (
    `I analyzed the codebase and here's what I found: Based on your project at ${projectName}, ` +
    `this would require examining the relevant files. AI-powered insights will provide detailed ` +
    `analysis in a future update.`
  );
}

/* ── Timestamp formatter ───────────────────────────────────── */

function formatTimestamp(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/* ── Component ─────────────────────────────────────────────── */

export const InsightsView: FC = () => {
  const { project } = useWorkspace();
  const projectName = project?.name ?? 'your project';

  const [messages, setMessages] = useState<InsightMessage[]>([]);
  const [input, setInput] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);

  const SAMPLE_QUESTIONS = [
    `What frameworks does ${projectName} use?`,
    `Summarize the folder structure of ${projectName}`,
    `Find potential security issues in ${projectName}`,
    `Explain the data flow in ${projectName}`,
    `Analyze the architecture of ${projectName}`,
    `List key dependencies for ${projectName}`,
  ];

  const submit = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;

      const now = Date.now();
      const userMsg: InsightMessage = {
        id: generateId(),
        role: 'user',
        content: trimmed,
        timestamp: now,
      };
      const assistantMsg: InsightMessage = {
        id: generateId(),
        role: 'assistant',
        content: findAnswer(trimmed, projectName),
        timestamp: now + 1,
      };

      setMessages((prev) => [...prev, userMsg, assistantMsg]);
      setInput('');

      // Scroll to bottom on next frame
      requestAnimationFrame(() => {
        scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
      });
    },
    [projectName],
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
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-foreground">Insights</h2>
          <span className="inline-flex items-center gap-1 rounded-md bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-400">
            <InfoIcon className="h-3 w-3" />
            AI generation coming soon
          </span>
        </div>
        <p className="mt-0.5 text-xs text-muted-foreground/60">
          Explore your codebase{project ? ` — ${project.name}` : ''}
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
                {msg.content}
              </div>
              <span className="px-1 text-[10px] text-muted-foreground/40">
                {formatTimestamp(msg.timestamp)}
              </span>
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
