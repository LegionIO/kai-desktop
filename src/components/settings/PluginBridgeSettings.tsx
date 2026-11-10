import { useCallback, useEffect, useId, useState, type ReactNode } from 'react';
import * as Tabs from '@radix-ui/react-tabs';
import * as Checkbox from '@radix-ui/react-checkbox';
import * as Switch from '@radix-ui/react-switch';
import * as Collapsible from '@radix-ui/react-collapsible';
import { CheckIcon, ChevronDownIcon, CopyIcon, Loader2Icon, RefreshCwIcon } from 'lucide-react';
import { BRIDGE_APPROVAL_CANCELLED } from '../../../shared/bridge-approval';
import type {
  BridgeClientPreview,
  BridgeMutation,
  BridgePlugin,
  BridgeSnapshot,
  McpExportSource,
  PluginBridgeApi,
  PluginHost,
} from '../../../shared/plugin-bridge';

const buttonClass =
  'inline-flex min-h-8 items-center justify-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-medium hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50';
const inputClass =
  'w-full min-w-0 rounded-lg border border-border bg-background px-3 py-2 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

function Selection({
  checked,
  disabled,
  onChange,
  children,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <div className="flex items-start gap-2.5">
      <Checkbox.Root
        id={id}
        checked={checked}
        disabled={disabled}
        onCheckedChange={(value) => onChange(value === true)}
        className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded border border-border bg-background data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
      >
        <Checkbox.Indicator>
          <CheckIcon className="size-3" />
        </Checkbox.Indicator>
      </Checkbox.Root>
      <label
        htmlFor={id}
        className={`min-w-0 flex-1 break-words text-xs ${disabled ? 'text-muted-foreground' : 'cursor-pointer'}`}
      >
        {children}
      </label>
    </div>
  );
}
function Gate({
  checked,
  disabled,
  onChange,
  title,
  children,
}: {
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
  title: string;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <div className="flex items-start justify-between gap-4 border-b border-border pb-4">
      <div>
        <label htmlFor={id} className="text-sm font-semibold">
          {title}
        </label>
        <p className="mt-1 max-w-prose text-xs leading-relaxed text-muted-foreground">{children}</p>
      </div>
      <Switch.Root
        id={id}
        checked={checked}
        disabled={disabled}
        onCheckedChange={onChange}
        className="mt-1 h-5 w-9 shrink-0 rounded-full bg-muted data-[state=checked]:bg-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
      >
        <Switch.Thumb className="block size-4 translate-x-0.5 rounded-full bg-background shadow-sm data-[state=checked]:translate-x-[18px]" />
      </Switch.Root>
    </div>
  );
}

export function PluginBridgeSettings({ focusTab, focusNonce }: { focusTab?: string; focusNonce?: number }) {
  const [snapshot, setSnapshot] = useState<BridgeSnapshot | null>(null);
  const [tab, setTab] = useState('imports');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const api = window.app?.pluginBridge;
  const load = useCallback(async () => {
    if (!api) return;
    try {
      setSnapshot(await api.snapshot());
      setError('');
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Could not load Plugin Bridge.');
    }
  }, [api]);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (focusTab && ['imports', 'sharing', 'activity'].includes(focusTab)) setTab(focusTab);
  }, [focusTab, focusNonce]);
  const run = async (operation: () => Promise<void>) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await operation();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The bridge change failed. Refresh and try again.';
      if (message.endsWith(BRIDGE_APPROVAL_CANCELLED)) setNotice('No changes applied.');
      else setError(message);
    } finally {
      setBusy(false);
    }
  };
  const mutate = (change: BridgeMutation) =>
    run(async () => {
      if (!api) throw new Error('Plugin Bridge is unavailable.');
      setSnapshot(await api.mutate(change));
      setNotice('Settings saved.');
    });
  if (!api)
    return (
      <p className="text-xs text-muted-foreground">
        Plugin Bridge requires the updated Kai backend. Restart Kai to load it.
      </p>
    );
  return (
    <div className="mx-auto max-w-3xl space-y-5" aria-busy={busy}>
      <div>
        <h3 className="text-sm font-semibold">Plugin Bridge</h3>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          Use installed Claude and Codex plugins, or share selected Kai tools with other clients.
        </p>
      </div>
      {error && (
        <div role="alert" className="rounded-lg border border-destructive/50 p-3 text-xs text-destructive">
          {error}
          <button className={`${buttonClass} ml-2`} onClick={() => void load()}>
            Refresh
          </button>
        </div>
      )}
      {notice && (
        <p role="status" className="text-xs text-muted-foreground">
          {notice}
        </p>
      )}
      {!snapshot ? (
        error ? null : (
          <p role="status" className="flex items-center gap-2 text-xs">
            <Loader2Icon className="size-4 animate-spin" />
            Loading bridge settings…
          </p>
        )
      ) : (
        <Tabs.Root
          value={tab}
          onValueChange={(value) => {
            setTab(value);
            if (value === 'activity') void load();
          }}
        >
          <Tabs.List aria-label="Plugin Bridge sections" className="mb-5 flex gap-1 border-b border-border">
            {[
              ['imports', 'Import Plugins'],
              ['sharing', 'Share Kai'],
              ['activity', 'Activity'],
            ].map(([value, label]) => (
              <Tabs.Trigger
                key={value}
                value={value}
                className="border-b-2 border-transparent px-3 py-2 text-xs text-muted-foreground data-[state=active]:border-primary data-[state=active]:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {label}
              </Tabs.Trigger>
            ))}
          </Tabs.List>
          <Tabs.Content value="imports" className="space-y-5" data-setting-id="pluginBridge.enabled">
            <Gate
              title="Import installed plugins"
              checked={snapshot.importsEnabled}
              disabled={busy}
              onChange={(enabled) => void mutate({ action: 'imports', enabled })}
            >
              Discover plugins in your user installations. Review and enable each component before Kai uses it.
            </Gate>
            {snapshot.importsEnabled ? (
              <>
                <HostHomes
                  homes={snapshot.hostHomes}
                  busy={busy}
                  save={(claude, codex) => mutate({ action: 'homes', claude, codex })}
                />
                <div className="flex items-center justify-between gap-3">
                  <h4 className="text-xs font-semibold">Installed plugins</h4>
                  <button
                    className={buttonClass}
                    disabled={busy}
                    onClick={() => void run(async () => setSnapshot(await api.discover()))}
                  >
                    <RefreshCwIcon className="size-3.5" />
                    Discover again
                  </button>
                </div>
                {!snapshot.plugins.length && (
                  <p className="py-5 text-xs text-muted-foreground">
                    No supported user installations were found. Check the host home paths above; discovery details are
                    in Activity.
                  </p>
                )}
                <div className="divide-y divide-border">
                  {snapshot.plugins.map((plugin) => (
                    <PluginReview
                      key={`${plugin.id}:${plugin.packagePath}`}
                      plugin={plugin}
                      busy={busy}
                      approve={(revisions, allowOverlap) =>
                        mutate({
                          action: 'approve',
                          pluginId: plugin.id,
                          packagePath: plugin.packagePath,
                          revisions,
                          allowOverlap,
                        })
                      }
                    />
                  ))}
                </div>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  Executable components run as your local user. Detected access describes commands and capabilities; it
                  is not an OS sandbox. Updates with unchanged detected access apply automatically. New components and
                  expanded access require review.
                </p>
              </>
            ) : (
              <p className="py-4 text-xs text-muted-foreground">
                Importing is off. Enable it to discover installed plugins and review their components. Saved approvals
                are retained.
              </p>
            )}
            <Collapsible.Root>
              <Collapsible.Trigger className={`${buttonClass} w-full justify-between`}>
                Runtime compatibility
                <ChevronDownIcon className="size-4" />
              </Collapsible.Trigger>
              <Collapsible.Content className="mt-3 overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <caption className="sr-only">Plugin Bridge runtime support</caption>
                  <thead>
                    <tr className="border-b">
                      <th className="p-2 font-medium">Runtime</th>
                      <th className="p-2 font-medium">Tools and skills</th>
                      <th className="p-2 font-medium">Hooks</th>
                    </tr>
                  </thead>
                  <tbody>
                    {snapshot.compatibility.map((runtime) => (
                      <tr key={runtime.runtime} className="border-b align-top">
                        <th className="p-2 font-medium">{runtime.runtime}</th>
                        <td className="p-2">Supported</td>
                        <td className="min-w-48 p-2 leading-relaxed text-muted-foreground">{runtime.notes}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Collapsible.Content>
            </Collapsible.Root>
          </Tabs.Content>
          <Tabs.Content value="sharing" className="space-y-5" data-setting-id="mcpExport.enabled">
            <Gate
              title="Share Kai through MCP"
              checked={snapshot.sharingEnabled}
              disabled={busy}
              onChange={(enabled) => void mutate({ action: 'sharing', enabled })}
            >
              Share tools you select using the accounts signed in to Kai. Import approvals and export selections are
              separate.
            </Gate>
            <ExportSelection
              sources={snapshot.sources}
              busy={busy}
              enabled={snapshot.sharingEnabled}
              save={(sources, tools) => mutate({ action: 'exports', sources, tools })}
            />
            {snapshot.sharingEnabled && (
              <>
                <ClientConnection api={api} busy={busy} run={run} refresh={load} />
                <RemoteSettings
                  snapshot={snapshot}
                  busy={busy}
                  mutate={mutate}
                  createToken={(name, days) => api.createToken(name, days)}
                  run={run}
                  refresh={load}
                />
              </>
            )}
            {!!snapshot.clients.length && (
              <div className="space-y-2">
                <h4 className="text-xs font-semibold">Connected clients and tokens</h4>
                <ul className="divide-y divide-border">
                  {snapshot.clients.map((client) => (
                    <li key={client.id} className="flex items-center justify-between gap-3 py-3">
                      <div className="min-w-0">
                        <p className="break-words text-xs font-medium">{client.name}</p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {client.kind}
                          {client.expiresAt
                            ? ` · Expires ${new Date(client.expiresAt).toLocaleDateString()}`
                            : ' · Until revoked'}
                        </p>
                      </div>
                      <button
                        className={buttonClass}
                        disabled={busy}
                        onClick={() => void mutate({ action: 'revoke-client', clientId: client.id })}
                      >
                        Revoke
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {snapshot.credentialStorage === 'session' && (
              <p className="text-xs text-muted-foreground">
                Secure storage is unavailable. New connector credentials last only until the Kai backend restarts.
              </p>
            )}
          </Tabs.Content>
          <Tabs.Content value="activity" className="space-y-4">
            <div className="flex items-center justify-between">
              <h4 className="text-xs font-semibold">Recent bridge activity</h4>
              <button className={buttonClass} onClick={() => void load()}>
                <RefreshCwIcon className="size-3.5" />
                Refresh
              </button>
            </div>
            {!snapshot.activity.length ? (
              <p className="py-5 text-xs text-muted-foreground">
                Bridge activity will appear here after discovery, approval, or tool use.
              </p>
            ) : (
              <ol className="divide-y divide-border">
                {snapshot.activity.map((entry) => (
                  <li key={entry.id} className="py-3 text-xs">
                    <p className="break-words leading-relaxed">{entry.message}</p>
                    <time className="mt-1 block text-muted-foreground" dateTime={entry.at}>
                      {new Date(entry.at).toLocaleString()} · {entry.kind}
                    </time>
                  </li>
                ))}
              </ol>
            )}
          </Tabs.Content>
        </Tabs.Root>
      )}
    </div>
  );
}

function HostHomes({
  homes,
  busy,
  save,
}: {
  homes: Record<PluginHost, string>;
  busy: boolean;
  save: (claude: string, codex: string) => Promise<void>;
}) {
  const [claude, setClaude] = useState(homes.claude);
  const [codex, setCodex] = useState(homes.codex);
  return (
    <Collapsible.Root>
      <Collapsible.Trigger className={`${buttonClass} w-full justify-between`}>
        User installation locations
        <ChevronDownIcon className="size-4" />
      </Collapsible.Trigger>
      <Collapsible.Content>
        <form
          className="mt-3 space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            void save(claude, codex);
          }}
        >
          <label className="block text-xs">
            Claude home
            <input
              className={`${inputClass} mt-1`}
              value={claude}
              onChange={(event) => setClaude(event.target.value)}
            />
          </label>
          <label className="block text-xs">
            Codex home
            <input className={`${inputClass} mt-1`} value={codex} onChange={(event) => setCodex(event.target.value)} />
          </label>
          <p className="text-xs text-muted-foreground">
            Kai reads installed user packages. Project discovery, development-folder imports, and downloads are outside
            V1.
          </p>
          <button className={buttonClass} disabled={busy}>
            Save locations
          </button>
        </form>
      </Collapsible.Content>
    </Collapsible.Root>
  );
}
function PluginReview({
  plugin,
  busy,
  approve,
}: {
  plugin: BridgePlugin;
  busy: boolean;
  approve: (revisions: Record<string, string>, overlap: boolean) => Promise<void>;
}) {
  const [selected, setSelected] = useState(
    () => new Set(plugin.components.filter((c) => c.status === 'approved' || c.selected).map((c) => c.id)),
  );
  const [overlap, setOverlap] = useState(false);
  useEffect(() => {
    setSelected(new Set(plugin.components.filter((c) => c.status === 'approved' || c.selected).map((c) => c.id)));
  }, [plugin]);
  const preset = (kinds: string[]) =>
    setSelected(
      new Set(
        plugin.components
          .filter((c) => kinds.includes(c.kind) && !['error', 'unsupported'].includes(c.status))
          .map((c) => c.id),
      ),
    );
  return (
    <Collapsible.Root className="py-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h5 className="break-words text-sm font-medium">{plugin.name}</h5>
          <p className="mt-1 break-words text-xs text-muted-foreground">
            {plugin.host === 'claude' ? 'Claude' : 'Codex'} · {plugin.version} ·{' '}
            {plugin.components.filter((c) => c.status === 'approved').length} approved
          </p>
        </div>
        <Collapsible.Trigger className={buttonClass}>
          Review
          <ChevronDownIcon className="size-3.5" />
        </Collapsible.Trigger>
      </div>
      <Collapsible.Content className="mt-4 space-y-4">
        <p className="text-xs leading-relaxed text-muted-foreground">{plugin.description}</p>
        <dl className="space-y-2 text-xs">
          <div>
            <dt className="font-medium">Installed package</dt>
            <dd className="mt-1 break-all text-muted-foreground">{plugin.packagePath}</dd>
          </div>
          <div>
            <dt className="font-medium">Source host</dt>
            <dd className="mt-1 text-muted-foreground">
              {plugin.hostEnabled === null ? 'Enablement unknown' : plugin.hostEnabled ? 'Enabled' : 'Disabled'} in{' '}
              {plugin.host}. Kai approval is independent.
            </dd>
          </div>
        </dl>
        {plugin.ambiguous && (
          <p className="text-xs font-medium">
            The current installation could not be identified unambiguously. Saving this review explicitly selects
            version {plugin.version}.
          </p>
        )}
        {!!plugin.overlaps.length && (
          <ul className="space-y-2 text-xs">
            {plugin.overlaps.map((o, i) => (
              <li key={`${o.sourceId}:${i}`}>
                <strong>{o.confidence === 'verified' ? 'Verified duplicate' : 'Possible overlap'}:</strong> {o.name}.{' '}
                {o.reason}.{o.native && o.confidence === 'verified' ? ' Kai prefers the native integration.' : ''}
              </li>
            ))}
          </ul>
        )}
        <div className="flex flex-wrap gap-2">
          <button className={buttonClass} disabled={busy} onClick={() => preset(['skill'])}>
            Skills only
          </button>
          <button className={buttonClass} disabled={busy} onClick={() => preset(['skill', 'mcp'])}>
            Skills + MCP
          </button>
          <button className={buttonClass} disabled={busy} onClick={() => preset(['skill', 'mcp', 'hooks'])}>
            All supported components
          </button>
          <button className={buttonClass} disabled={busy} onClick={() => setSelected(new Set())}>
            Clear selection
          </button>
        </div>
        <div className="space-y-4">
          {plugin.components.map((component) => (
            <Selection
              key={component.id}
              checked={selected.has(component.id)}
              disabled={busy || (!selected.has(component.id) && ['error', 'unsupported'].includes(component.status))}
              onChange={(checked) =>
                setSelected((previous) => {
                  const next = new Set(previous);
                  if (checked) next.add(component.id);
                  else next.delete(component.id);
                  return next;
                })
              }
            >
              <span className="font-medium">{component.name}</span>
              <span className="ml-2 text-muted-foreground">
                {component.kind} · {component.status.replaceAll('-', ' ')}
              </span>
              <span className="mt-1 block leading-relaxed text-muted-foreground">{component.description}</span>
              {component.access.map((access) => (
                <span key={access} className="mt-1 block text-muted-foreground">
                  {access}
                </span>
              ))}
              {component.diagnostics.map((diagnostic) => (
                <span key={diagnostic} className="mt-1 block text-destructive">
                  {diagnostic}
                </span>
              ))}
            </Selection>
          ))}
        </div>
        {plugin.diagnostics.map((diagnostic) => (
          <p key={diagnostic} className="text-xs text-destructive">
            {diagnostic}
          </p>
        ))}
        {!!plugin.overlaps.length && (
          <Selection checked={overlap} disabled={busy} onChange={setOverlap}>
            Use this source despite the overlaps above. Multiple enabled sources keep separate tool names. To use only
            this source, disable the other integration in its settings.
          </Selection>
        )}
        <button
          className={`${buttonClass} bg-primary text-primary-foreground hover:bg-primary/90`}
          disabled={busy}
          onClick={() =>
            void approve(
              Object.fromEntries(plugin.components.filter((c) => selected.has(c.id)).map((c) => [c.id, c.revision])),
              overlap,
            )
          }
        >
          Save component approvals
        </button>
      </Collapsible.Content>
    </Collapsible.Root>
  );
}

function ExportSelection({
  sources,
  busy,
  enabled,
  save,
}: {
  sources: McpExportSource[];
  busy: boolean;
  enabled: boolean;
  save: (sources: string[], tools: string[]) => Promise<void>;
}) {
  const [selectedSources, setSources] = useState(() => new Set(sources.filter((s) => s.selected).map((s) => s.id)));
  const [selectedTools, setTools] = useState(
    () => new Set(sources.flatMap((s) => s.tools.filter((t) => t.selected).map((t) => t.id))),
  );
  useEffect(() => {
    setSources(new Set(sources.filter((s) => s.selected).map((s) => s.id)));
    setTools(new Set(sources.flatMap((s) => s.tools.filter((t) => t.selected).map((t) => t.id))));
  }, [sources]);
  const disabled = busy || !enabled;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-xs font-semibold">Shared tools</h4>
        <div className="flex gap-2">
          <button
            className={buttonClass}
            disabled={disabled}
            onClick={() => {
              setSources(new Set());
              setTools(new Set(sources.flatMap((s) => s.tools.filter((t) => t.available).map((t) => t.id))));
            }}
          >
            Select available tools
          </button>
          <button
            className={buttonClass}
            disabled={disabled}
            onClick={() => {
              setSources(new Set());
              setTools(new Set());
            }}
          >
            Clear
          </button>
        </div>
      </div>
      <div className="divide-y divide-border">
        {sources.map((source) => (
          <Collapsible.Root key={source.id} className="py-3">
            <div className="flex items-center gap-2">
              <div className="min-w-0 flex-1">
                <Selection
                  checked={selectedSources.has(source.id)}
                  disabled={disabled || (!selectedSources.has(source.id) && !source.tools.some((t) => t.available))}
                  onChange={(checked) => {
                    setSources((previous) => {
                      const next = new Set(previous);
                      if (checked) next.add(source.id);
                      else next.delete(source.id);
                      return next;
                    });
                    if (!checked)
                      setTools(
                        (previous) => new Set([...previous].filter((id) => !source.tools.some((t) => t.id === id))),
                      );
                  }}
                >
                  <span className="break-words font-medium">{source.name}</span>
                  {source.imported && <span className="ml-2 text-muted-foreground">Imported</span>}
                  <span className="mt-1 block text-muted-foreground">
                    {source.tools.filter((t) => t.available).length} available · Select this source to share its
                    available tools, including tools added by future updates
                  </span>
                </Selection>
              </div>
              <Collapsible.Trigger aria-label={`Review ${source.name} tools`} className={buttonClass}>
                <ChevronDownIcon className="size-4" />
              </Collapsible.Trigger>
            </div>
            <Collapsible.Content className="mt-4 space-y-3 pl-6">
              {source.tools.map((tool) => (
                <Selection
                  key={tool.id}
                  checked={selectedSources.has(source.id) || selectedTools.has(tool.id)}
                  disabled={
                    disabled || (!selectedTools.has(tool.id) && !selectedSources.has(source.id) && !tool.available)
                  }
                  onChange={(checked) => {
                    const next = new Set(selectedTools);
                    if (selectedSources.has(source.id)) {
                      source.tools.filter((t) => t.available).forEach((t) => next.add(t.id));
                      setSources(new Set([...selectedSources].filter((id) => id !== source.id)));
                    }
                    if (checked) next.add(tool.id);
                    else next.delete(tool.id);
                    setTools(next);
                  }}
                >
                  <span className="break-words font-medium">{tool.name}</span>
                  <span className="mt-1 block leading-relaxed text-muted-foreground">
                    {tool.reason ?? tool.description}
                  </span>
                </Selection>
              ))}
            </Collapsible.Content>
          </Collapsible.Root>
        ))}
      </div>
      {!sources.length && (
        <p className="py-3 text-xs text-muted-foreground">
          Kai has no registered tools yet. Enable an integration, then refresh these settings.
        </p>
      )}
      <button
        className={buttonClass}
        disabled={disabled}
        onClick={() => void save([...selectedSources], [...selectedTools])}
      >
        Save shared tools
      </button>
    </div>
  );
}
type Run = (operation: () => Promise<void>) => Promise<void>;
function ClientConnection({
  api,
  busy,
  run,
  refresh,
}: {
  api: PluginBridgeApi;
  busy: boolean;
  run: Run;
  refresh: () => Promise<void>;
}) {
  const [preview, setPreview] = useState<BridgeClientPreview | null>(null);
  const [copied, setCopied] = useState(false);
  const [createdConfiguration, setCreatedConfiguration] = useState('');
  return (
    <div className="space-y-3 border-t border-border pt-5">
      <h4 className="text-xs font-semibold">Connect a local client</h4>
      <p className="text-xs leading-relaxed text-muted-foreground">
        The connector uses stdio and starts Kai’s headless backend when needed. Review the host configuration before
        applying it.
      </p>
      <div className="flex flex-wrap gap-2">
        {(['claude', 'codex'] as const).map((host) => (
          <button
            key={host}
            className={buttonClass}
            disabled={busy}
            onClick={() =>
              void run(async () => {
                setPreview(await api.previewClient(host));
                setCopied(false);
                setCreatedConfiguration('');
              })
            }
          >
            Connect to {host === 'claude' ? 'Claude' : 'Codex'}
          </button>
        ))}
      </div>
      {preview && (
        <div className="space-y-3 rounded-lg border border-border p-3">
          <p className="break-all text-xs font-medium">Configuration preview · {preview.path}</p>
          <pre className="max-h-56 overflow-auto rounded-md bg-muted p-3 text-xs">{preview.configuration}</pre>
          {createdConfiguration && (
            <p role="status" className="text-xs text-muted-foreground">
              Connector created. The configuration above is ready to copy or select manually.
            </p>
          )}
          {preview.conflict && (
            <p role="alert" className="text-xs text-destructive">
              A kai-mcp entry already exists. Kai will not overwrite it. Create a connector and copy the configuration
              to review the entry manually.
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <button
              className={buttonClass}
              disabled={busy || preview.conflict || !!createdConfiguration}
              onClick={() =>
                void run(async () => {
                  await api.applyClient(preview.id, true);
                  setPreview(null);
                  await refresh();
                })
              }
            >
              Create connector and apply
            </button>
            <button
              className={buttonClass}
              disabled={busy || copied}
              onClick={() =>
                void run(async () => {
                  const configuration =
                    createdConfiguration || (await api.applyClient(preview.id, false)).configuration;
                  setCreatedConfiguration(configuration);
                  await refresh();
                  await navigator.clipboard.writeText(configuration);
                  setCopied(true);
                })
              }
            >
              <CopyIcon className="size-3.5" />
              {copied
                ? 'Created and copied'
                : createdConfiguration
                  ? 'Copy created configuration'
                  : 'Create connector and copy'}
            </button>
            <button className={buttonClass} onClick={() => setPreview(null)}>
              Close preview
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
function RemoteSettings({
  snapshot,
  busy,
  mutate,
  createToken,
  run,
  refresh,
}: {
  snapshot: BridgeSnapshot;
  busy: boolean;
  mutate: (change: BridgeMutation) => Promise<void>;
  createToken: (name: string, days: number) => Promise<{ token: string }>;
  run: Run;
  refresh: () => Promise<void>;
}) {
  const [url, setUrl] = useState(snapshot.publicUrl);
  const [name, setName] = useState('');
  const [days, setDays] = useState('30');
  const [token, setToken] = useState('');
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!snapshot.remoteEnabled) {
      setToken('');
      setCopied(false);
    }
  }, [snapshot.remoteEnabled]);
  return (
    <div className="space-y-3 border-t border-border pt-5" data-setting-id="mcpExport.remote">
      <Gate
        title="Allow remote MCP connections"
        checked={snapshot.remoteEnabled}
        disabled={busy}
        onChange={(enabled) => void mutate({ action: 'remote', enabled, publicUrl: url })}
      >
        Serve /mcp through the existing Web UI HTTPS server. Remote clients use this installation’s signed-in accounts.
      </Gate>
      <label className="block text-xs">
        Public MCP URL
        <input
          type="url"
          className={`${inputClass} mt-1`}
          placeholder="https://kai.example.com/mcp"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
        />
      </label>
      <button
        className={buttonClass}
        disabled={busy}
        onClick={() => void mutate({ action: 'remote', enabled: snapshot.remoteEnabled, publicUrl: url })}
      >
        Save remote URL
      </button>
      {!!snapshot.remoteProblems.length && (
        <ul className="list-inside list-disc space-y-1 text-xs text-muted-foreground">
          {snapshot.remoteProblems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      )}
      {snapshot.remoteEnabled && (
        <>
          <p className="text-xs leading-relaxed text-muted-foreground">
            OAuth clients sign in with the Web UI password, then approve the connection. Access tokens last one hour;
            refresh tokens rotate and last 30 days. You can also create a named bearer token.
          </p>
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              void run(async () => {
                const result = await createToken(name, Number(days));
                setToken(result.token);
                setCopied(false);
                setName('');
                await refresh();
              });
            }}
          >
            <div className="grid gap-3 sm:grid-cols-[1fr_120px]">
              <label className="text-xs">
                Token name
                <input
                  className={`${inputClass} mt-1`}
                  required
                  maxLength={100}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="My remote client"
                />
              </label>
              <label className="text-xs">
                Expires in days
                <input
                  type="number"
                  className={`${inputClass} mt-1`}
                  min={1}
                  max={365}
                  required
                  value={days}
                  onChange={(event) => setDays(event.target.value)}
                />
              </label>
            </div>
            <button className={buttonClass} disabled={busy}>
              Create bearer token
            </button>
          </form>
        </>
      )}
      {token && (
        <div className="space-y-2 rounded-lg border border-border p-3">
          <p className="text-xs font-medium">Save this token now. Kai shows it only once.</p>
          <code className="block break-all text-xs">{token}</code>
          <div className="flex gap-2">
            <button
              className={buttonClass}
              onClick={() =>
                void run(async () => {
                  await navigator.clipboard.writeText(token);
                  setCopied(true);
                })
              }
            >
              <CopyIcon className="size-3.5" />
              {copied ? 'Copied' : 'Copy token'}
            </button>
            <button className={buttonClass} onClick={() => setToken('')}>
              Done
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
