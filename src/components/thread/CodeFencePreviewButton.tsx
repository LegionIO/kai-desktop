import { useMemo, type FC } from 'react';
import { PanelRightOpenIcon } from 'lucide-react';
import { Tooltip } from '@/components/ui/Tooltip';
import { useArtifactsOptional, type ArtifactType } from '@/providers/ArtifactProvider';

const PREVIEWABLE: Record<string, ArtifactType> = {
  html: 'html',
  htm: 'html',
  svg: 'svg',
  markdown: 'markdown',
  md: 'markdown',
  mermaid: 'mermaid',
};

/** djb2 — cheap deterministic hash so re-clicking the same block reuses its artifact. */
function hash(input: string): string {
  let h = 5381;
  for (let i = 0; i < input.length; i++) h = ((h << 5) + h + input.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/**
 * "Preview →" button rendered in the code-block toolbar for html/svg/markdown/mermaid
 * fences. Click-only — never auto-opens the panel.
 */
export const CodeFencePreviewButton: FC<{ code: string; language?: string }> = ({ code, language }) => {
  const ctx = useArtifactsOptional();
  const lang = language?.toLowerCase();
  const type = lang ? PREVIEWABLE[lang] : undefined;

  const artifactId = useMemo(() => 'fence_' + hash(`${lang ?? ''}::${code}`), [lang, code]);

  if (!ctx || !type) return null;

  return (
    <Tooltip content="Preview in side panel" side="top">
      <button
        type="button"
        onClick={() => {
          ctx.upsert({
            id: artifactId,
            title: `${language ?? 'Code'} preview`,
            type,
            content: code,
          });
          ctx.openPanel();
        }}
        className="inline-flex h-6 items-center gap-1 rounded bg-background/80 px-1.5 text-[10px] font-medium text-muted-foreground opacity-100 backdrop-blur-sm transition-opacity hover:bg-accent hover:text-foreground md:opacity-0 md:group-hover/code:opacity-100"
      >
        <PanelRightOpenIcon className="h-3 w-3" />
        Preview
      </button>
    </Tooltip>
  );
};
