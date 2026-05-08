import { type FC, useState, useEffect, useCallback } from 'react';
import { ChevronUpIcon, ChevronDownIcon, XIcon, Trash2Icon, LoaderIcon, CheckCircle2Icon, AlertTriangleIcon, HardDriveIcon } from 'lucide-react';
import { app } from '@/lib/ipc-client';
import { Toggle, NumberField, SliderField, settingsSelectClass, type SettingsProps } from './shared';

type FallbackConfig = {
  enabled: boolean;
  modelKeys: string[];
};

type CatalogModel = {
  key: string;
  displayName: string;
};

export const AdvancedSettings: FC<SettingsProps> = ({ config, updateConfig }) => {
  const advanced = config.advanced as {
    temperature: number;
    maxSteps: number;
    maxRetries: number;
    useResponsesApi: boolean;
  };
  const titleGen = config.titleGeneration as {
    enabled: boolean;
    retitleIntervalMessages: number;
    retitleEagerUntilMessage: number;
  };
  const ui = config.ui as { theme: string; sidebarWidth: number; composer?: { showModelProfileSelector?: boolean } };
  const fallback = (config.fallback as FallbackConfig | undefined) ?? { enabled: false, modelKeys: [] };
  const models = ((config.models as { catalog?: CatalogModel[] })?.catalog ?? []) as CatalogModel[];

  return (
    <div className="space-y-6">
      <h3 className="text-sm font-semibold">Advanced</h3>

      <fieldset className="rounded-lg border p-3 space-y-3">
        <legend className="text-xs font-semibold px-1">General</legend>
        <div className="flex items-start justify-between gap-3 rounded-md border p-3">
          <div>
            <span className="text-xs font-medium">Launch at login</span>
            <p className="mt-0.5 text-[10px] text-muted-foreground">Automatically open Kai when you log in to your Mac.</p>
          </div>
          <input type="checkbox" checked={!!config.launchAtLogin} onChange={(e) => updateConfig('launchAtLogin', e.target.checked)} className="mt-0.5 h-4 w-4 rounded" />
        </div>
      </fieldset>

      <fieldset className="rounded-lg border p-3 space-y-3">
        <legend className="text-xs font-semibold px-1">LLM Parameters</legend>
        <SliderField label={`Temperature: ${advanced.temperature}`} value={advanced.temperature} min={0} max={2} step={0.1} onChange={(v) => updateConfig('advanced.temperature', v)} />
        <div className="flex justify-between text-[10px] text-muted-foreground -mt-2">
          <span>Focused &amp; predictable</span>
          <span>Creative &amp; varied</span>
        </div>
        <NumberField label="Max Steps (tool call loops)" value={advanced.maxSteps} onChange={(v) => updateConfig('advanced.maxSteps', v)} min={1} max={50} />
        <NumberField label="Max Retries" value={advanced.maxRetries} onChange={(v) => updateConfig('advanced.maxRetries', v)} min={0} max={10} />
        <Toggle label="Use Responses API" checked={advanced.useResponsesApi} onChange={(v) => updateConfig('advanced.useResponsesApi', v)} />
      </fieldset>

      <fieldset className="rounded-lg border p-3 space-y-3">
        <legend className="text-xs font-semibold px-1">Model Fallback</legend>
        <p className="text-xs text-muted-foreground">
          When enabled and the primary model fails before producing content, the system tries the next model in the chain.
          This is a global fallback chain used when no profile-specific chain is configured.
        </p>
        <Toggle
          label="Enable global fallback chain"
          checked={fallback.enabled}
          onChange={(v) => updateConfig('fallback.enabled', v)}
        />
        {fallback.enabled && (
          <FallbackModelList
            selectedKeys={fallback.modelKeys}
            catalog={models}
            onChange={(keys) => updateConfig('fallback.modelKeys', keys)}
          />
        )}
      </fieldset>

      <fieldset className="rounded-lg border p-3 space-y-3">
        <legend className="text-xs font-semibold px-1">AI Chat Titles</legend>

        <div className="flex items-start justify-between gap-3 rounded-md border p-3">
          <div>
            <span className="text-xs font-medium">Auto-generate titles</span>
            <p className="mt-0.5 text-[10px] text-muted-foreground">Automatically generate and refresh chat titles using AI.</p>
          </div>
          <input type="checkbox" checked={titleGen.enabled} onChange={(e) => updateConfig('titleGeneration.enabled', e.target.checked)} className="mt-0.5 h-4 w-4 rounded" />
        </div>

        <NumberField label="Title refresh interval (messages)" value={titleGen.retitleIntervalMessages} onChange={(v) => updateConfig('titleGeneration.retitleIntervalMessages', Math.max(1, v || 1))} min={1} />
        <p className="text-[10px] text-muted-foreground -mt-2">Regenerate title every N user messages after the eager window.</p>

        <NumberField label="Always refresh for first N messages" value={titleGen.retitleEagerUntilMessage} onChange={(v) => updateConfig('titleGeneration.retitleEagerUntilMessage', Math.max(0, v || 0))} min={0} />
        <p className="text-[10px] text-muted-foreground -mt-2">Always regenerate the title for each user message up to this count (eager phase).</p>
      </fieldset>

      <fieldset className="rounded-lg border p-3 space-y-3">
        <legend className="text-xs font-semibold px-1">UI</legend>
        <div>
          <label className="text-[10px] text-muted-foreground block mb-0.5">Theme</label>
          <select className={settingsSelectClass} value={ui.theme} onChange={(e) => updateConfig('ui.theme', e.target.value)}>
            <option value="system">System</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </div>
        <div className="flex items-start justify-between gap-3 rounded-md border p-3">
          <div>
            <span className="text-xs font-medium">Show model &amp; profile selector in composer</span>
            <p className="mt-0.5 text-[10px] text-muted-foreground">Display inline model and profile dropdowns in the chat composer toolbar.</p>
          </div>
          <input type="checkbox" checked={!!ui.composer?.showModelProfileSelector} onChange={(e) => updateConfig('ui.composer.showModelProfileSelector', e.target.checked)} className="mt-0.5 h-4 w-4 rounded" />
        </div>
      </fieldset>

      <PartitionManager />
    </div>
  );
};

const FallbackModelList: FC<{
  selectedKeys: string[];
  catalog: CatalogModel[];
  onChange: (keys: string[]) => void;
}> = ({ selectedKeys, catalog, onChange }) => {
  const toggleModel = (key: string) => {
    if (selectedKeys.includes(key)) {
      onChange(selectedKeys.filter((k) => k !== key));
    } else {
      onChange([...selectedKeys, key]);
    }
  };

  const moveModel = (index: number, direction: -1 | 1) => {
    const next = [...selectedKeys];
    const targetIndex = index + direction;
    if (targetIndex < 0 || targetIndex >= next.length) return;
    [next[index], next[targetIndex]] = [next[targetIndex], next[index]];
    onChange(next);
  };

  return (
    <div className="space-y-2">
      <label className="text-[10px] text-muted-foreground block">Fallback order (tried top to bottom):</label>
      {selectedKeys.length > 0 && (
        <div className="space-y-1">
          {selectedKeys.map((key, i) => {
            const model = catalog.find((m) => m.key === key);
            return (
              <div key={key} className="flex items-center gap-1.5 rounded border bg-card/50 px-2 py-1">
                <span className="text-[10px] text-muted-foreground font-mono w-4">{i + 1}.</span>
                <span className="text-xs flex-1 truncate">{model?.displayName ?? key}</span>
                <button type="button" onClick={() => moveModel(i, -1)} disabled={i === 0} className="p-0.5 rounded hover:bg-muted disabled:opacity-30 transition-colors" title="Move up">
                  <ChevronUpIcon className="h-3 w-3" />
                </button>
                <button type="button" onClick={() => moveModel(i, 1)} disabled={i === selectedKeys.length - 1} className="p-0.5 rounded hover:bg-muted disabled:opacity-30 transition-colors" title="Move down">
                  <ChevronDownIcon className="h-3 w-3" />
                </button>
                <button type="button" onClick={() => toggleModel(key)} className="p-0.5 rounded hover:bg-destructive/10 transition-colors" title="Remove">
                  <XIcon className="h-3 w-3 text-muted-foreground" />
                </button>
              </div>
            );
          })}
        </div>
      )}
      <div className="flex flex-wrap gap-1.5">
        {catalog
          .filter((m) => !selectedKeys.includes(m.key))
          .map((m) => (
            <button
              key={m.key}
              type="button"
              onClick={() => toggleModel(m.key)}
              className="rounded-lg border border-dashed px-2 py-1 text-[10px] text-muted-foreground hover:bg-muted/50 transition-colors"
            >
              + {m.displayName}
            </button>
          ))}
      </div>
    </div>
  );
};

// ─── Partition Manager ──────────────────────────────────────────────────────

type PartitionEntry = { name: string; sizeBytes: number };
type PartitionStatus = 'idle' | 'confirming' | 'deleting' | 'done' | 'error';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const PartitionManager: FC = () => {
  const [partitions, setPartitions] = useState<PartitionEntry[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [status, setStatus] = useState<PartitionStatus>('idle');
  const [result, setResult] = useState<{ deleted?: string[]; error?: string } | null>(null);
  const [loading, setLoading] = useState(true);

  const loadPartitions = useCallback(async () => {
    try {
      const list = await app.partitions.list();
      setPartitions(list);
    } catch {
      setPartitions([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadPartitions();
  }, [loadPartitions]);

  const handleDelete = async () => {
    const names = selected.size > 0 ? Array.from(selected) : partitions.map((p) => p.name);
    if (names.length === 0) return;

    setStatus('deleting');
    setResult(null);

    try {
      const res = await app.partitions.delete(names);
      if (res.error) {
        setResult({ error: res.error, deleted: res.deleted });
        setStatus('error');
      } else {
        setResult({ deleted: res.deleted });
        setStatus('done');
        setSelected(new Set());
        // Refresh the list
        await loadPartitions();
      }
    } catch (err) {
      setResult({ error: String(err) });
      setStatus('error');
    }
  };

  const reset = () => {
    setStatus('idle');
    setResult(null);
  };

  const toggleSelected = (name: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const targetNames = selected.size > 0 ? Array.from(selected) : partitions.map((p) => p.name);

  return (
    <fieldset className="rounded-lg border border-destructive/30 p-3 space-y-3">
      <legend className="text-xs font-semibold px-1 text-destructive flex items-center gap-1">
        <HardDriveIcon className="h-3 w-3" />
        Browser Partitions
      </legend>

      <p className="text-[10px] text-muted-foreground">
        Plugins create isolated browser sessions (partitions) for authentication and browsing.
        Deleting a partition clears its cookies, cache, and local storage.
      </p>

      {loading && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <LoaderIcon className="h-3 w-3 animate-spin" />
          Loading partitions...
        </div>
      )}

      {!loading && status === 'idle' && partitions.length === 0 && (
        <p className="text-xs text-muted-foreground italic">No saved partitions.</p>
      )}

      {!loading && status === 'idle' && partitions.length > 0 && (
        <>
          <div className="space-y-1">
            {partitions.map((p) => (
              <label key={p.name} className="flex items-center gap-2 rounded border px-2 py-1.5 cursor-pointer hover:bg-muted/30 transition-colors">
                <input
                  type="checkbox"
                  checked={selected.has(p.name)}
                  onChange={() => toggleSelected(p.name)}
                  className="h-3.5 w-3.5 rounded"
                />
                <span className="text-xs flex-1 truncate font-mono">{p.name}</span>
                <span className="text-[10px] text-muted-foreground">{formatBytes(p.sizeBytes)}</span>
              </label>
            ))}
          </div>
          <button
            type="button"
            onClick={() => setStatus('confirming')}
            disabled={partitions.length === 0}
            className="flex items-center gap-1.5 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-1.5 text-xs font-medium text-destructive hover:bg-destructive/10 transition-colors disabled:opacity-40"
          >
            <Trash2Icon className="h-3 w-3" />
            {selected.size > 0 ? `Delete ${selected.size} selected` : 'Delete all'}
          </button>
        </>
      )}

      {status === 'confirming' && (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 space-y-2">
          <div className="flex items-start gap-2">
            <AlertTriangleIcon className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
            <div>
              <p className="text-xs font-medium text-destructive">Are you sure?</p>
              <p className="text-[10px] text-muted-foreground mt-0.5">
                This will permanently delete all cookies, cache, and storage for{' '}
                {targetNames.length === 1 ? (
                  <span className="font-mono">{targetNames[0]}</span>
                ) : (
                  <span>{targetNames.length} partitions</span>
                )}
                . You may need to re-authenticate with affected plugins.
              </p>
            </div>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={handleDelete}
              className="rounded-md bg-destructive px-3 py-1 text-xs font-medium text-destructive-foreground hover:bg-destructive/90 transition-colors"
            >
              Delete
            </button>
            <button
              type="button"
              onClick={reset}
              className="rounded-md border px-3 py-1 text-xs font-medium hover:bg-muted transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {status === 'deleting' && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <LoaderIcon className="h-3 w-3 animate-spin" />
          Deleting partitions...
        </div>
      )}

      {status === 'done' && result?.deleted && (
        <div className="rounded-md border border-green-500/30 bg-green-500/5 p-3 space-y-2">
          <div className="flex items-start gap-2">
            <CheckCircle2Icon className="h-4 w-4 text-green-600 shrink-0 mt-0.5" />
            <div>
              <p className="text-xs font-medium text-green-700 dark:text-green-400">
                Deleted {result.deleted.length} partition{result.deleted.length !== 1 ? 's' : ''}.
              </p>
              <ul className="mt-1 space-y-0.5">
                {result.deleted.map((name) => (
                  <li key={name} className="text-[10px] text-muted-foreground font-mono">{name}</li>
                ))}
              </ul>
            </div>
          </div>
          <button type="button" onClick={reset} className="text-[10px] text-muted-foreground underline hover:text-foreground transition-colors">
            Dismiss
          </button>
        </div>
      )}

      {status === 'error' && result?.error && (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 space-y-2">
          <div className="flex items-start gap-2">
            <AlertTriangleIcon className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
            <div>
              <p className="text-xs font-medium text-destructive">Failed to delete partitions</p>
              <p className="text-[10px] text-muted-foreground mt-0.5">{result.error}</p>
            </div>
          </div>
          <button type="button" onClick={reset} className="text-[10px] text-muted-foreground underline hover:text-foreground transition-colors">
            Dismiss
          </button>
        </div>
      )}
    </fieldset>
  );
};
