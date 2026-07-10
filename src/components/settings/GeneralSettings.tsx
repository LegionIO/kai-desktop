import { type FC, useState, useEffect, useCallback } from 'react';
import { Trash2Icon, LoaderIcon, CheckCircle2Icon, AlertTriangleIcon, HardDriveIcon } from 'lucide-react';
import { app } from '@/lib/ipc-client';
import { Toggle, settingsSelectClass, type SettingsProps } from './shared';

export const GeneralSettings: FC<SettingsProps & { hideTitle?: boolean }> = ({ config, updateConfig, hideTitle }) => {
  const ui = config.ui as {
    theme: string;
    sidebarWidth: number;
    fullWidthContent?: boolean;
    splashBackground?: string;
    composer?: { showModelProfileSelector?: boolean };
  };
  const titleGen =
    (config.titleGeneration as
      | {
          enabled?: boolean;
        }
      | undefined) ?? {};
  const titleGenEnabled = titleGen.enabled ?? true;

  // "Install `kai` command in PATH" — VS Code `code`-style toggle backed by the
  // cli:install IPC (symlinks/copies the shipped launcher onto a per-user PATH dir).
  const [cliStatus, setCliStatus] = useState<{
    installed: boolean;
    target?: string;
    onPath?: boolean;
    conflict?: boolean;
  } | null>(null);
  const [cliBusy, setCliBusy] = useState(false);
  const [cliError, setCliError] = useState<string | null>(null);

  const refreshCliStatus = useCallback(() => {
    void app.cli
      .installStatus()
      .then((s) => setCliStatus(s))
      .catch(() => setCliStatus(null));
  }, []);

  useEffect(() => {
    refreshCliStatus();
  }, [refreshCliStatus]);

  const toggleCli = useCallback(async () => {
    setCliBusy(true);
    setCliError(null);
    try {
      const s = cliStatus?.installed ? await app.cli.uninstall() : await app.cli.install();
      setCliStatus(s);
      if (s.error) setCliError(s.error);
    } catch (err) {
      setCliError(err instanceof Error ? err.message : String(err));
    } finally {
      setCliBusy(false);
    }
  }, [cliStatus?.installed]);

  return (
    <div className="space-y-6">
      {!hideTitle && (
        <div>
          <h3 className="text-sm font-semibold">Application</h3>
          <p className="mt-1 text-xs text-muted-foreground">Startup behavior and appearance preferences.</p>
        </div>
      )}

      <fieldset className="rounded-lg border p-3 space-y-3">
        <legend className="text-xs font-semibold px-1">Startup</legend>
        <Toggle
          id="launchAtLogin"
          label="Launch at login"
          checked={!!config.launchAtLogin}
          onChange={(v) => updateConfig('launchAtLogin', v)}
        />
      </fieldset>

      <fieldset className="rounded-lg border p-3 space-y-3">
        <legend className="text-xs font-semibold px-1">Terminal CLI</legend>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs">
              Install the <code className="rounded bg-muted px-1">kai</code> command in your PATH
            </p>
            <p className="mt-0.5 text-[10px] text-muted-foreground">
              Adds a <code className="rounded bg-muted px-1">kai</code> launcher so you can start the terminal client
              from any shell.
              {cliStatus?.installed ? (
                <>
                  {' '}
                  Installed{cliStatus.target ? ` at ${cliStatus.target}` : ''}
                  {cliStatus.onPath === false ? ' (restart your shell to pick it up on PATH)' : ''}.
                </>
              ) : null}
            </p>
            {cliError ? (
              <p className="mt-0.5 text-[10px] text-red-500 flex items-center gap-1">
                <AlertTriangleIcon className="h-3 w-3 shrink-0" />
                {cliError}
              </p>
            ) : cliStatus?.conflict ? (
              <p className="mt-0.5 text-[10px] text-amber-500 flex items-center gap-1">
                <AlertTriangleIcon className="h-3 w-3 shrink-0" />A different `kai` command already exists in PATH — not
                managed by Kai.
              </p>
            ) : null}
          </div>
          <button
            type="button"
            disabled={cliBusy || cliStatus?.conflict}
            onClick={() => void toggleCli()}
            className="shrink-0 rounded-md border px-2.5 py-1 text-[11px] hover:bg-muted disabled:opacity-50 flex items-center gap-1"
          >
            {cliBusy ? (
              <LoaderIcon className="h-3 w-3 animate-spin" />
            ) : cliStatus?.installed ? (
              <CheckCircle2Icon className="h-3 w-3 text-green-500" />
            ) : null}
            {cliStatus?.installed ? 'Uninstall' : 'Install'}
          </button>
        </div>
      </fieldset>

      <fieldset className="rounded-lg border p-3 space-y-3">
        <legend className="text-xs font-semibold px-1">Appearance</legend>

        <div data-setting-id="ui.theme">
          <label className="text-[10px] text-muted-foreground block mb-0.5">Color scheme</label>
          <select
            className={settingsSelectClass}
            value={ui.theme}
            onChange={(e) => updateConfig('ui.theme', e.target.value)}
          >
            <option value="system">System</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </div>

        <div data-setting-id="ui.splashBackground">
          <label className="text-[10px] text-muted-foreground block mb-0.5">Splash background</label>
          <select
            className={settingsSelectClass}
            value={ui.splashBackground ?? 'random'}
            onChange={(e) => updateConfig('ui.splashBackground', e.target.value)}
          >
            <option value="random">Random</option>
            <option value="matrix">Matrix</option>
            <option value="constellations">Constellations</option>
            <option value="hexagons">Hexagons</option>
            <option value="smokescreen">Smokescreen</option>
          </select>
        </div>

        <div>
          <label className="text-[10px] text-muted-foreground block mb-0.5">Layout</label>
          <Toggle
            id="ui.fullWidthContent"
            label="Full width content"
            checked={!!ui.fullWidthContent}
            onChange={(v) => updateConfig('ui.fullWidthContent', v)}
          />
        </div>
      </fieldset>

      <fieldset className="rounded-lg border p-3 space-y-3">
        <legend className="text-xs font-semibold px-1">Chat Titles</legend>
        <Toggle
          id="titleGeneration.enabled"
          label="Auto-generate chat titles"
          checked={titleGenEnabled}
          onChange={(v) => updateConfig('titleGeneration.enabled', v)}
        />
        <p className="text-[10px] text-muted-foreground -mt-2">
          Use AI to title and refresh conversations automatically. Manually renamed chats are never overwritten.
        </p>
      </fieldset>

      <fieldset className="rounded-lg border p-3 space-y-3">
        <legend className="text-xs font-semibold px-1">Advanced</legend>
        <Toggle
          id="ui.composer.showModelProfileSelector"
          label="Show model & profile selector in composer"
          checked={!!ui.composer?.showModelProfileSelector}
          onChange={(v) => updateConfig('ui.composer.showModelProfileSelector', v)}
        />
        <p className="text-[10px] text-muted-foreground -mt-2">
          Display inline model and profile dropdowns in the chat composer toolbar.
        </p>
      </fieldset>

      <PartitionManager />
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
    <fieldset data-setting-id="partitions" className="rounded-lg border border-destructive/30 p-3 space-y-3">
      <legend className="text-xs font-semibold px-1 text-destructive flex items-center gap-1">
        <HardDriveIcon className="h-3 w-3" />
        Browser Partitions
      </legend>
      <p className="text-[10px] text-muted-foreground">
        Plugins create isolated browser sessions (partitions) for authentication and browsing. Deleting a partition
        clears its cookies, cache, and local storage.
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
              <label
                key={p.name}
                className="flex items-center gap-2 rounded border px-2 py-1.5 cursor-pointer hover:bg-muted/30 transition-colors"
              >
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
                  <li key={name} className="text-[10px] text-muted-foreground font-mono">
                    {name}
                  </li>
                ))}
              </ul>
            </div>
          </div>
          <button
            type="button"
            onClick={reset}
            className="text-[10px] text-muted-foreground underline hover:text-foreground transition-colors"
          >
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
          <button
            type="button"
            onClick={reset}
            className="text-[10px] text-muted-foreground underline hover:text-foreground transition-colors"
          >
            Dismiss
          </button>
        </div>
      )}
    </fieldset>
  );
};
