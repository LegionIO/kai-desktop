import { useEffect, useMemo, useState, type FC } from 'react';
import * as Select from '@radix-ui/react-select';
import { ChevronDownIcon, CodeIcon, EyeIcon, HistoryIcon, PanelRightIcon } from 'lucide-react';
import { useArtifacts, type Artifact } from '@/providers/ArtifactProvider';
import { ArtifactRenderer } from './artifact-views/ArtifactRenderer';
import { CodeBlock } from '@/components/thread/CodeBlock';
import { Tooltip } from '@/components/ui/Tooltip';
import { cn } from '@/lib/utils';

const typeToSourceLang: Record<Artifact['type'], string> = {
  html: 'html',
  svg: 'xml',
  react: 'tsx',
  markdown: 'markdown',
  mermaid: 'mermaid',
  text: 'text',
};

/** Body of the "Preview" side-panel tab. */
export const ArtifactPanel: FC = () => {
  const { artifacts, activeId, setActive } = useArtifacts();
  const list = useMemo(() => Array.from(artifacts.values()).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), [artifacts]);
  const active = (activeId ? artifacts.get(activeId) : null) ?? list[0] ?? null;

  const [versionIdx, setVersionIdx] = useState<number | null>(null);
  const [showSource, setShowSource] = useState(false);

  // Reset version selection when the active artifact changes or gains a new version.
  useEffect(() => {
    setVersionIdx(null);
  }, [active?.id, active?.versions.length]);

  if (!active) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-muted-foreground">
        <PanelRightIcon className="h-6 w-6 opacity-40" />
        <p className="text-sm">No preview yet</p>
        <p className="max-w-xs text-xs opacity-70">
          Ask the assistant to create an artifact, or click <span className="font-medium">Preview</span> on a code
          block in the chat.
        </p>
      </div>
    );
  }

  const effectiveIdx = versionIdx ?? active.versions.length - 1;
  const version = active.versions[effectiveIdx] ?? active.versions[active.versions.length - 1];
  const displayed = { title: version.title, content: version.content };

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header */}
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border/60 px-3">
        {/* Artifact selector */}
        {list.length > 1 ? (
          <Select.Root value={active.id} onValueChange={(id) => setActive(id)}>
            <Select.Trigger className="flex min-w-0 max-w-[55%] items-center gap-1.5 rounded-md px-2 py-1 text-sm font-medium text-foreground hover:bg-accent">
              <Select.Value />
              <ChevronDownIcon className="h-3.5 w-3.5 shrink-0 opacity-60" />
            </Select.Trigger>
            <Select.Portal>
              <Select.Content
                position="popper"
                sideOffset={4}
                className="z-50 min-w-[12rem] overflow-hidden rounded-lg border border-border/60 bg-popover p-1 shadow-xl"
              >
                <Select.Viewport>
                  {list.map((a) => (
                    <Select.Item
                      key={a.id}
                      value={a.id}
                      className="cursor-pointer rounded-md px-2 py-1.5 text-xs outline-none data-[highlighted]:bg-accent"
                    >
                      <Select.ItemText>{a.title}</Select.ItemText>
                    </Select.Item>
                  ))}
                </Select.Viewport>
              </Select.Content>
            </Select.Portal>
          </Select.Root>
        ) : (
          <span className="min-w-0 truncate text-sm font-medium text-foreground">{displayed.title}</span>
        )}

        <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          {active.type}
        </span>

        <div className="flex-1" />

        {/* Version dropdown */}
        {active.versions.length > 1 && (
          <Select.Root value={String(effectiveIdx)} onValueChange={(v) => setVersionIdx(Number(v))}>
            <Select.Trigger className="flex items-center gap-1 rounded-md border border-border/60 px-2 py-1 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground">
              <HistoryIcon className="h-3 w-3" />
              <span>
                v{effectiveIdx + 1} / {active.versions.length}
              </span>
              <ChevronDownIcon className="h-3 w-3" />
            </Select.Trigger>
            <Select.Portal>
              <Select.Content
                position="popper"
                sideOffset={4}
                align="end"
                className="z-50 overflow-hidden rounded-lg border border-border/60 bg-popover p-1 shadow-xl"
              >
                <Select.Viewport>
                  {active.versions.map((v, i) => (
                    <Select.Item
                      key={i}
                      value={String(i)}
                      className="cursor-pointer rounded-md px-2 py-1.5 text-xs outline-none data-[highlighted]:bg-accent"
                    >
                      <Select.ItemText>
                        v{i + 1}
                        {i === active.versions.length - 1 ? ' (latest)' : ''} · {new Date(v.updatedAt).toLocaleTimeString()}
                      </Select.ItemText>
                    </Select.Item>
                  ))}
                </Select.Viewport>
              </Select.Content>
            </Select.Portal>
          </Select.Root>
        )}

        {/* Source / preview toggle */}
        <Tooltip content={showSource ? 'Show preview' : 'Show source'} side="bottom">
          <button
            type="button"
            onClick={() => setShowSource((s) => !s)}
            className={cn(
              'flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground',
              showSource && 'bg-accent text-foreground',
            )}
          >
            {showSource ? <EyeIcon className="h-3.5 w-3.5" /> : <CodeIcon className="h-3.5 w-3.5" />}
          </button>
        </Tooltip>
      </div>

      {/* Body */}
      <div className="min-h-0 flex-1">
        {showSource ? (
          <div className="h-full overflow-auto p-3">
            <CodeBlock code={displayed.content} language={typeToSourceLang[active.type]} maxHeight="none" />
          </div>
        ) : (
          <ArtifactRenderer type={active.type} content={displayed.content} title={displayed.title} />
        )}
      </div>
    </div>
  );
};
