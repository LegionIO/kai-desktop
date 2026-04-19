import { useState, useCallback, type FC, type FormEvent } from 'react';
import { SendIcon, PackageIcon } from 'lucide-react';
import { useWorkspace } from '@/providers/WorkspaceProvider';

export const WorkspaceComposer: FC = () => {
  const { allCapabilities, project } = useWorkspace();
  const [prompt, setPrompt] = useState('');
  const [lastResult, setLastResult] = useState<string | null>(null);

  const handleSubmit = useCallback(
    (e: FormEvent) => {
      e.preventDefault();
      const trimmed = prompt.trim();
      if (!trimmed) return;

      // MVP: log what would happen (later this routes through the LLM with plugin tools)
      const capCount = allCapabilities.length;
      const capNames = allCapabilities.map((c) => `${c.pluginName}/${c.name}`).join(', ');
      const message = capCount > 0
        ? `Prompt: "${trimmed}"\nAvailable capabilities (${capCount}): ${capNames}\nProject: ${project?.name ?? 'none'}`
        : `Prompt: "${trimmed}"\nNo plugin capabilities available.\nProject: ${project?.name ?? 'none'}`;

      console.info('[WorkspaceComposer]', message);
      setLastResult(message);
      setPrompt('');
    },
    [prompt, allCapabilities, project],
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

      {/* Content area */}
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-5">
        {/* Description */}
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

        {/* Last result */}
        {lastResult && (
          <div className="rounded-lg border border-border/50 bg-muted/10 p-3">
            <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/50">
              Last Submission
            </p>
            <pre className="whitespace-pre-wrap text-xs text-foreground/80 font-mono leading-relaxed">
              {lastResult}
            </pre>
          </div>
        )}

        {/* Spacer */}
        <div className="flex-1" />
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
            disabled={allCapabilities.length === 0}
            className="flex-1 rounded-lg border border-border bg-card px-3 py-2 text-xs text-foreground placeholder:text-muted-foreground/50 outline-none focus:ring-1 focus:ring-ring disabled:opacity-40"
          />
          <button
            type="submit"
            disabled={!prompt.trim() || allCapabilities.length === 0}
            className="inline-flex items-center justify-center rounded-lg bg-primary px-3 py-2 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <SendIcon className="h-3.5 w-3.5" />
          </button>
        </form>
      </div>
    </div>
  );
};
