import { useEffect, useRef, type FC } from 'react';
import { PanelRightOpenIcon, SparklesIcon } from 'lucide-react';
import { useArtifactsOptional, type ArtifactType } from '@/providers/ArtifactProvider';

const ARTIFACT_TYPES: readonly ArtifactType[] = ['html', 'markdown', 'svg', 'mermaid', 'react', 'text'];

function isArtifactType(value: unknown): value is ArtifactType {
  return typeof value === 'string' && (ARTIFACT_TYPES as readonly string[]).includes(value);
}

type ArtifactPayload = {
  id: string;
  title?: string;
  type?: ArtifactType;
  content: string;
  updatedAt?: string;
};

function extractArtifact(args: unknown, result: unknown): ArtifactPayload | null {
  // Prefer the tool result (has the resolved id + timestamp).
  const fromResult = result && typeof result === 'object' ? (result as Record<string, unknown>).artifact : undefined;
  const source =
    fromResult && typeof fromResult === 'object'
      ? (fromResult as Record<string, unknown>)
      : args && typeof args === 'object'
        ? (args as Record<string, unknown>)
        : null;
  if (!source) return null;
  const id = typeof source.id === 'string' && source.id.length > 0 ? source.id : null;
  const content = typeof source.content === 'string' ? source.content : null;
  if (!id || content == null) return null;
  return {
    id,
    content,
    title: typeof source.title === 'string' ? source.title : undefined,
    type: isArtifactType(source.type) ? source.type : undefined,
    updatedAt: typeof source.updatedAt === 'string' ? source.updatedAt : undefined,
  };
}

/**
 * Inline card rendered inside `ToolGroup` for `create_artifact` / `update_artifact`.
 * Side effect: upserts the artifact into `ArtifactProvider` and opens the panel
 * exactly once per tool-call result.
 */
export const ArtifactToolCard: FC<{
  toolCallId: string;
  toolName: 'create_artifact' | 'update_artifact';
  args: unknown;
  result: unknown;
  isError: boolean;
}> = ({ toolCallId, toolName, args, result, isError }) => {
  const ctx = useArtifactsOptional();
  const hasResult = result !== undefined;
  const payload = hasResult && !isError ? extractArtifact(args, result) : null;
  const firedRef = useRef<string | null>(null);

  useEffect(() => {
    if (!ctx || !payload) return;
    const key = `${toolCallId}:${payload.updatedAt ?? payload.content.length}`;
    if (firedRef.current === key) return;
    firedRef.current = key;
    ctx.upsert(payload);
    ctx.openPanel();
  }, [ctx, payload, toolCallId]);

  if (!payload) return null;

  const label = toolName === 'create_artifact' ? 'Created' : 'Updated';

  return (
    <div className="ml-1 mt-1.5 flex items-center gap-3 rounded-xl border border-primary/25 bg-primary/5 px-3 py-2">
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-primary/15 text-primary">
        <SparklesIcon className="h-3.5 w-3.5" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-xs font-medium text-foreground">{payload.title ?? payload.id}</div>
        <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
          {label} · {payload.type ?? 'artifact'}
        </div>
      </div>
      {ctx && (
        <button
          type="button"
          onClick={() => {
            ctx.setActive(payload.id);
            ctx.openPanel();
          }}
          className="flex shrink-0 items-center gap-1.5 rounded-md border border-border/60 bg-card px-2 py-1 text-[11px] font-medium text-foreground transition-colors hover:bg-accent"
        >
          <PanelRightOpenIcon className="h-3 w-3" />
          Open
        </button>
      )}
    </div>
  );
};
