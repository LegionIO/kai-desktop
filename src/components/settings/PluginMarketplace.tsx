import { useState, useEffect, useCallback, useRef, type FC } from 'react';
import {
  RefreshCwIcon,
  DownloadIcon,
  PackageIcon,
  LoaderIcon,
  AlertCircleIcon,
  SearchIcon,
  XIcon,
  CheckIcon,
  ArrowUpCircleIcon,
} from 'lucide-react';
import { app } from '@/lib/ipc-client';
import { cn } from '@/lib/utils';
import { Tooltip } from '@/components/ui/Tooltip';
import { PluginRestartBanner } from '@/components/plugins/PluginRestartBanner';
import { useFullWidthContent } from '@/hooks/useFullWidthContent';

type MarketplaceEntry = {
  name: string;
  displayName: string;
  description: string;
  version: string;
  author?: string;
  tags?: string[];
  icon?: string;
  installed: boolean;
  installedVersion?: string;
  marketplaceUrl: string;
};

type MarketplaceTab = 'available' | 'updates';

function isNewerVersion(catalogVersion: string, installedVersion: string): boolean {
  const toNum = (v: string) => v.split('.').map(Number);
  const [cMajor = 0, cMinor = 0, cPatch = 0] = toNum(catalogVersion);
  const [iMajor = 0, iMinor = 0, iPatch = 0] = toNum(installedVersion);
  if (cMajor !== iMajor) return cMajor > iMajor;
  if (cMinor !== iMinor) return cMinor > iMinor;
  return cPatch > iPatch;
}

// Detect an IPC call that reached the transport but hit no registered handler
// in the main process. This is the OTA skew case: an OTA overlay ships a NEW
// preload + renderer over the OLD bundled main process (main is never
// OTA-updated — see electron/ota/bootstrap.ts), so a channel the new preload
// exposes may have no handler on the running main. Electron rejects such an
// invoke with "No handler registered for '<channel>'". We treat that as
// "unsupported here" and fall back to an older channel rather than surfacing an
// error that would break the whole Plugins view until a full app update.
function isNoHandlerError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? '');
  return /No handler registered for/i.test(msg) || /not supported in web mode/i.test(msg);
}

type MarketplaceStatus = { configured: boolean; ready: boolean; reachable: boolean; catalogSize: number };

// Fetch marketplace status, tolerating an OTA-skewed / older main process that
// has no `plugin:marketplace-status` handler. Returns `supported: false` in
// that case (with a permissive default) so the caller knows the status signal
// is unavailable and can compensate (e.g. bounded polling for the original
// startup race, which the old main can't broadcast its way out of).
async function fetchStatusOrDefault(): Promise<{ status: MarketplaceStatus; supported: boolean }> {
  const fallback: MarketplaceStatus = { configured: true, ready: true, reachable: true, catalogSize: 0 };
  if (typeof app.plugins.marketplaceStatus !== 'function') return { status: fallback, supported: false };
  try {
    return { status: await app.plugins.marketplaceStatus(), supported: true };
  } catch (err) {
    if (isNoHandlerError(err)) return { status: fallback, supported: false };
    throw err;
  }
}

// Parse author string like "Name <https://example.com>" into {name, url}.
// The URL is only returned if it uses an allowlisted scheme (https:// or
// mailto:) — anything else (javascript:, data:, file:, etc.) is dropped so
// the caller renders plain text instead of a link.
function parseAuthor(author?: string): { name: string; url?: string } | null {
  if (!author) return null;
  const match = author.match(/^(.+?)\s*<(.+?)>$/);
  if (match) {
    const rawUrl = match[2].trim();
    const url = /^(https:\/\/|mailto:)/i.test(rawUrl) ? rawUrl : undefined;
    return { name: match[1].trim(), url };
  }
  return { name: author.trim() };
}

export const PluginMarketplace: FC = () => {
  const fullWidth = useFullWidthContent();
  const [catalog, setCatalog] = useState<MarketplaceEntry[]>([]);
  const [installedVersions, setInstalledVersions] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState(true);
  // Distinguishes a genuinely unconfigured marketplace from one whose startup
  // catalog fetch simply hasn't settled yet, and (once settled) whether the
  // endpoint was actually reachable. Without this the view falsely shows
  // "No marketplace configured" during the async init window, and can't tell a
  // valid empty catalog from an unreachable endpoint.
  const [marketplaceReady, setMarketplaceReady] = useState(false);
  const [marketplaceConfigured, setMarketplaceConfigured] = useState(false);
  const [marketplaceReachable, setMarketplaceReachable] = useState(false);
  // Whether the running main actually reported status. False under OTA skew (new
  // renderer over an older main with no status handler); the reachable/ready/
  // configured flags are then meaningless, so the UI falls back to the legacy
  // single empty-state rather than the new loading/unreachable/no-plugins states.
  const [marketplaceStatusSupported, setMarketplaceStatusSupported] = useState(true);
  const searchRef = useRef<HTMLInputElement>(null);
  const [activeTab, setActiveTab] = useState<MarketplaceTab>('available');

  useEffect(() => {
    const t = setTimeout(() => searchRef.current?.focus(), 50);
    return () => clearTimeout(t);
  }, []);
  const [refreshing, setRefreshing] = useState(false);
  const [justRefreshed, setJustRefreshed] = useState(false);
  const [installingPlugins, setInstallingPlugins] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [failedUpdates, setFailedUpdates] = useState<
    Map<string, { attemptedVersion: string; runningVersion: string; error: string }>
  >(new Map());
  const [updatingAll, setUpdatingAll] = useState(false);
  const updatingAllRef = useRef(false);
  const loadReqId = useRef(0);
  // Guards against scheduling work after unmount: an in-flight loadData() can
  // resolve after the cleanup ran, and must not arm a new polling timer then.
  const mountedRef = useRef(true);
  // OTA-skew safety net: when the running main is too old to expose
  // marketplace-status (so it also never broadcasts marketplace-ready), the
  // original startup race can leave the catalog momentarily empty with no event
  // to recover from. In that ONE case we poll marketplaceCatalog until it
  // arrives or a deadline passes. The deadline must cover the old main's real
  // init window: fetchCatalog processes URLs SEQUENTIALLY at up to 60s each, so
  // size the ceiling for a few configured marketplaces (enterprise + public),
  // with a gentle backoff (cheap, and stops as soon as the catalog is non-empty).
  const legacyPollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const legacyPollDeadline = useRef<number | null>(null);
  const LEGACY_POLL_MAX_MS = 200_000; // ~3 URLs × 60s + margin
  const legacyPollDelayMs = (elapsed: number) =>
    elapsed < 10_000 ? 1500 : elapsed < 30_000 ? 3000 : elapsed < 90_000 ? 6000 : 10_000;

  const loadData = useCallback(async () => {
    const reqId = ++loadReqId.current;
    try {
      // Prefer the atomic snapshot so catalog + status come from a single
      // main-process read — two separate round-trips can interleave with a
      // concurrent fetch commit and pair an old catalog with new status. Guard
      // on BOTH the preload function existing AND the invoke succeeding: under
      // OTA skew the new preload exposes the function while the old main lacks
      // the handler, so a preload `typeof` check alone is not enough.
      if (typeof app.plugins.marketplaceSnapshot === 'function') {
        try {
          const [snapshot, pluginList] = await Promise.all([app.plugins.marketplaceSnapshot(), app.plugins.list()]);
          if (reqId !== loadReqId.current) return;
          setCatalog(snapshot.catalog);
          setInstalledVersions(new Map(pluginList.map((p: { name: string; version: string }) => [p.name, p.version])));
          setMarketplaceConfigured(snapshot.status.configured);
          setMarketplaceReady(snapshot.status.ready);
          setMarketplaceReachable(snapshot.status.reachable);
          setMarketplaceStatusSupported(true);
          setError(null);
          return;
        } catch (err) {
          // Only swallow the OTA-skew "no handler" case; real errors fall
          // through to the catch below via rethrow.
          if (!isNoHandlerError(err)) throw err;
        }
      }
      // Fallback: separate catalog + status calls. marketplaceStatus can also be
      // missing a handler under OTA skew, so fetch it defensively; when it's
      // unsupported we default to configured+ready+reachable (the old behavior:
      // show whatever the catalog holds).
      const [catalogData, pluginList, statusResult] = await Promise.all([
        app.plugins.marketplaceCatalog(),
        app.plugins.list(),
        fetchStatusOrDefault(),
      ]);
      if (reqId !== loadReqId.current) return;
      const { status, supported: statusSupported } = statusResult;
      setCatalog(catalogData);
      setInstalledVersions(new Map(pluginList.map((p: { name: string; version: string }) => [p.name, p.version])));
      setMarketplaceConfigured(status.configured);
      setMarketplaceReady(status.ready);
      setMarketplaceReachable(status.reachable);
      setMarketplaceStatusSupported(statusSupported);
      setError(null);

      // OTA-skew recovery: an old main can't tell us whether its startup fetch
      // has settled, and never broadcasts marketplace-ready. If the catalog is
      // still empty, poll (until a deadline that covers the old main's ~60s/URL
      // fetch window) so a slow initial fetch surfaces without the user having
      // to manually refresh. A non-empty catalog, or a main new enough to report
      // status, needs no polling.
      if (!statusSupported && catalogData.length === 0) {
        const now = Date.now();
        if (legacyPollDeadline.current === null) legacyPollDeadline.current = now + LEGACY_POLL_MAX_MS;
        // Don't arm a timer if the component unmounted while this load was in
        // flight (cleanup already ran) — otherwise polling + state updates leak.
        if (mountedRef.current && now < legacyPollDeadline.current) {
          const elapsed = LEGACY_POLL_MAX_MS - (legacyPollDeadline.current - now);
          if (legacyPollTimer.current) clearTimeout(legacyPollTimer.current);
          legacyPollTimer.current = setTimeout(() => void loadData(), legacyPollDelayMs(elapsed));
        }
      } else {
        // Settled (or catalog arrived) — stop any further polling.
        legacyPollDeadline.current = null;
        if (legacyPollTimer.current) {
          clearTimeout(legacyPollTimer.current);
          legacyPollTimer.current = null;
        }
      }
    } catch (err) {
      if (reqId !== loadReqId.current) return;
      setError(err instanceof Error ? err.message : 'Failed to load marketplace data');
    } finally {
      if (reqId === loadReqId.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Re-arm on (re)mount: StrictMode runs setup→cleanup→setup on the same ref
    // in dev, and the cleanup below sets this false. Without re-arming, the
    // second setup would leave polling permanently disabled.
    mountedRef.current = true;
    loadData();
    return () => {
      mountedRef.current = false;
      if (legacyPollTimer.current) {
        clearTimeout(legacyPollTimer.current);
        legacyPollTimer.current = null;
      }
    };
  }, [loadData]);

  // If the view is opened while the startup catalog fetch is still in flight,
  // reload once the main process signals it has settled — this replaces the
  // transient loading state with the real catalog (or the unconfigured/
  // unreachable empty state) without the user needing to refresh manually.
  useEffect(() => {
    if (typeof app.plugins.onMarketplaceReady !== 'function') return;
    return app.plugins.onMarketplaceReady((status) => {
      setMarketplaceConfigured(status.configured);
      setMarketplaceReady(status.ready);
      setMarketplaceReachable(status.reachable);
      void loadData();
    });
  }, [loadData]);

  useEffect(() => {
    if (typeof app.plugins.getFailedUpdates !== 'function') return;
    const apply = (list: Array<{ name: string; attemptedVersion: string; runningVersion: string; error: string }>) =>
      setFailedUpdates(new Map(list.map((f) => [f.name, f])));
    app.plugins
      .getFailedUpdates()
      .then(apply)
      .catch(() => {});
    return app.plugins.onFailedUpdatesChanged?.(({ failedUpdates: list }) => {
      apply(list);
      void loadData();
    });
  }, [loadData]);

  const handleRefresh = async () => {
    setRefreshing(true);
    setJustRefreshed(false);
    const startTime = Date.now();
    try {
      const refreshed = await app.plugins.marketplaceRefresh();
      setCatalog(refreshed);
      const pluginList = await app.plugins.list();
      setInstalledVersions(new Map(pluginList.map((p: { name: string; version: string }) => [p.name, p.version])));
      // Default to reachable so an older/OTA-skewed main (no status handler)
      // keeps the prior success behavior; the current main always reports it.
      const { status } = await fetchStatusOrDefault();
      setMarketplaceConfigured(status.configured);
      setMarketplaceReady(status.ready);
      setMarketplaceReachable(status.reachable);
      // Only treat a refresh as failed-to-reach when the marketplace is
      // actually configured; an unconfigured brand isn't a connectivity error.
      const reachable = !status.configured || status.reachable;
      const elapsed = Date.now() - startTime;
      if (elapsed < 1000) await new Promise((r) => setTimeout(r, 1000 - elapsed));
      if (reachable) {
        // Genuine success — clear any prior error and flash the success state.
        setError(null);
        setJustRefreshed(true);
        setTimeout(() => setJustRefreshed(false), 2000);
      } else {
        // The refresh resolved but reached no configured URL — surface it as an
        // error instead of the misleading green "Up to date" success state.
        setError('Couldn’t reach the plugin marketplace. Check your connection and try again.');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to refresh marketplace');
    } finally {
      setRefreshing(false);
    }
  };

  const handleInstall = async (pluginName: string): Promise<string | undefined> => {
    setInstallingPlugins((prev) => new Set([...prev, pluginName]));
    try {
      const result = await app.plugins.marketplaceInstall(pluginName);
      if (result.needsConfirmation) {
        const accepted = window.confirm(
          `"${result.pluginName ?? pluginName}" has no published integrity hash. ` +
            'Installing it means trusting whatever the download server returns. Install anyway?',
        );
        if (!accepted) {
          return;
        }
        await app.plugins.marketplaceInstallUnverified(pluginName);
      }
      await loadData();
    } catch (err) {
      const msg = err instanceof Error ? err.message : `Failed to install ${pluginName}`;
      setError(msg);
      return msg;
    } finally {
      setInstallingPlugins((prev) => {
        const next = new Set(prev);
        next.delete(pluginName);
        return next;
      });
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <LoaderIcon className="h-5 w-5 animate-spin text-muted-foreground" />
        <span className="ml-2 text-sm text-muted-foreground">Loading marketplace...</span>
      </div>
    );
  }

  const searchLower = searchQuery.toLowerCase();

  const matchesSearch = (entry: MarketplaceEntry) =>
    !searchLower ||
    entry.displayName.toLowerCase().includes(searchLower) ||
    entry.name.toLowerCase().includes(searchLower) ||
    entry.description.toLowerCase().includes(searchLower) ||
    entry.tags?.some((tag) => tag.toLowerCase().includes(searchLower));

  const availablePlugins = catalog
    .filter((entry) => !entry.installed && !installedVersions.has(entry.name))
    .filter(matchesSearch);

  const updatablePlugins = catalog
    .filter((entry) => {
      if (!entry.installed && !installedVersions.has(entry.name)) return false;
      const liveVersion = installedVersions.get(entry.name) ?? entry.installedVersion;
      return liveVersion != null && isNewerVersion(entry.version, liveVersion);
    })
    .filter(matchesSearch);

  const updateCount = updatablePlugins.length;

  const handleUpdateAll = async () => {
    if (updatingAllRef.current) return;
    const targets = updatablePlugins.map((p) => p.name).filter((name) => !installingPlugins.has(name));
    if (targets.length === 0) return;
    updatingAllRef.current = true;
    setUpdatingAll(true);
    try {
      const results = await Promise.all(targets.map((name) => handleInstall(name)));
      const failures = results.filter((r): r is string => r != null);
      if (failures.length > 0) {
        setError(failures.length === 1 ? failures[0] : `${failures.length} updates failed: ${failures.join('; ')}`);
      }
    } finally {
      updatingAllRef.current = false;
      setUpdatingAll(false);
    }
  };

  return (
    <div className="relative z-20 flex flex-col h-full min-h-0">
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className={cn('mx-auto w-full px-4 pt-6 pb-6', !fullWidth && 'max-w-3xl')}>
          {/* Glass card wrapping everything */}
          <div className="rounded-2xl border border-border/40 bg-background/85 backdrop-blur-xl overflow-hidden">
            {/* Search + refresh */}
            <div className="flex items-center gap-2 px-4 py-3 border-b border-border/40">
              <div className="flex flex-1 items-center gap-2 rounded-xl border border-border/60 bg-muted/30 px-3 py-2">
                <SearchIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <input
                  ref={searchRef}
                  type="text"
                  placeholder="Search marketplace…"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') setSearchQuery('');
                  }}
                  className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
                />
                {searchQuery && (
                  <button
                    type="button"
                    onClick={() => setSearchQuery('')}
                    className="shrink-0 rounded p-0.5 hover:bg-muted transition-colors"
                  >
                    <XIcon className="h-3.5 w-3.5 text-muted-foreground" />
                  </button>
                )}
              </div>
              <Tooltip content={justRefreshed ? 'Up to date' : 'Refresh catalog'} side="bottom">
                <button
                  type="button"
                  onClick={handleRefresh}
                  disabled={refreshing || justRefreshed}
                  className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg transition-colors disabled:opacity-50 ${
                    justRefreshed ? 'text-green-400' : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
                  }`}
                >
                  {refreshing ? (
                    <RefreshCwIcon className="h-4 w-4 animate-spin" />
                  ) : justRefreshed ? (
                    <CheckIcon className="h-4 w-4" />
                  ) : (
                    <RefreshCwIcon className="h-4 w-4" />
                  )}
                </button>
              </Tooltip>
            </div>

            {/* Tab bar */}
            <div className="flex items-center gap-1 px-4 py-2 border-b border-border/40">
              <button
                type="button"
                onClick={() => setActiveTab('available')}
                className={cn(
                  'rounded-lg px-3 py-1.5 text-xs font-medium transition-colors',
                  activeTab === 'available'
                    ? 'bg-primary/10 text-primary'
                    : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground',
                )}
              >
                Available
              </button>
              <button
                type="button"
                onClick={() => setActiveTab('updates')}
                className={cn(
                  'flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors',
                  activeTab === 'updates'
                    ? 'bg-primary/10 text-primary'
                    : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground',
                )}
              >
                Updates
                {updateCount > 0 && (
                  <span className="flex h-4 min-w-[16px] items-center justify-center rounded-full bg-blue-500 px-1 text-[10px] font-bold text-white">
                    {updateCount}
                  </span>
                )}
              </button>
            </div>

            {/* Content */}
            <div className="p-3 space-y-2">
              <PluginRestartBanner />

              {/* Error banner */}
              {error && (
                <div className="flex items-start gap-2 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3">
                  <AlertCircleIcon className="mt-0.5 h-4 w-4 shrink-0 text-red-400" />
                  <p className="text-xs font-medium text-red-400">{error}</p>
                  <button
                    type="button"
                    onClick={() => setError(null)}
                    className="ml-auto shrink-0 text-xs text-red-400/70 hover:text-red-400"
                  >
                    Dismiss
                  </button>
                </div>
              )}

              {/* ── Available Tab ── */}
              {activeTab === 'available' && (
                <>
                  {/* Configured but startup catalog fetch not yet settled —
                      show loading rather than the misleading "unconfigured".
                      Only when the main reported real status (not OTA-skew). */}
                  {catalog.length === 0 &&
                    !error &&
                    marketplaceStatusSupported &&
                    marketplaceConfigured &&
                    !marketplaceReady && (
                      <div className="rounded-2xl border border-dashed border-border/70 bg-card/30 px-6 py-16 text-center">
                        <LoaderIcon className="mx-auto h-8 w-8 animate-spin text-muted-foreground/40" />
                        <p className="mt-4 text-sm text-muted-foreground">Loading marketplace…</p>
                      </div>
                    )}

                  {/* Configured + settled, but no configured URL was reachable
                      and there's no cache — a genuine connectivity failure. */}
                  {catalog.length === 0 &&
                    !error &&
                    marketplaceStatusSupported &&
                    marketplaceConfigured &&
                    marketplaceReady &&
                    !marketplaceReachable && (
                      <div className="rounded-2xl border border-dashed border-border/70 bg-card/30 px-6 py-16 text-center">
                        <PackageIcon className="mx-auto h-10 w-10 text-muted-foreground/40" />
                        <p className="mt-4 text-sm text-muted-foreground">Couldn’t reach the plugin marketplace</p>
                        <p className="mt-1 text-xs text-muted-foreground/70">Check your connection and try again.</p>
                        <button
                          type="button"
                          onClick={handleRefresh}
                          disabled={refreshing}
                          className={cn(
                            'mt-4 inline-flex items-center gap-1.5 rounded-lg border border-border/70 bg-card px-3 py-1.5 text-xs font-medium transition-colors',
                            refreshing
                              ? 'cursor-not-allowed text-muted-foreground/50'
                              : 'text-foreground hover:bg-muted/50',
                          )}
                        >
                          <RefreshCwIcon className={cn('h-3.5 w-3.5', refreshing && 'animate-spin')} />
                          {refreshing ? 'Retrying…' : 'Try again'}
                        </button>
                      </div>
                    )}

                  {/* Configured + settled + reachable, but the endpoint returned
                      zero plugins — a VALID empty catalog, not a failure. */}
                  {catalog.length === 0 &&
                    !error &&
                    marketplaceStatusSupported &&
                    marketplaceConfigured &&
                    marketplaceReady &&
                    marketplaceReachable && (
                      <div className="rounded-2xl border border-dashed border-border/70 bg-card/30 px-6 py-16 text-center">
                        <PackageIcon className="mx-auto h-10 w-10 text-muted-foreground/40" />
                        <p className="mt-4 text-sm text-muted-foreground">No plugins available</p>
                        <p className="mt-1 text-xs text-muted-foreground/70">
                          The marketplace is reachable but currently lists no plugins.
                        </p>
                      </div>
                    )}

                  {/* Genuinely no marketplace URLs for this brand — OR the running
                      main is too old to report status (OTA skew), in which case we
                      fall back to the classic pre-status message rather than
                      guessing "no plugins" vs "unreachable". */}
                  {catalog.length === 0 && !error && (!marketplaceStatusSupported || !marketplaceConfigured) && (
                    <div className="rounded-2xl border border-dashed border-border/70 bg-card/30 px-6 py-16 text-center">
                      <PackageIcon className="mx-auto h-10 w-10 text-muted-foreground/40" />
                      <p className="mt-4 text-sm text-muted-foreground">No marketplace configured</p>
                      <p className="mt-1 text-xs text-muted-foreground/70">
                        Plugin marketplace URLs can be configured in the branding config.
                      </p>
                    </div>
                  )}

                  {/* No search results / all installed */}
                  {catalog.length > 0 && availablePlugins.length === 0 && (
                    <div className="rounded-2xl border border-dashed border-border/70 bg-card/30 px-6 py-12 text-center">
                      <PackageIcon className="mx-auto h-8 w-8 text-muted-foreground/40" />
                      <p className="mt-3 text-sm text-muted-foreground">
                        {searchQuery
                          ? `No plugins found matching "${searchQuery}"`
                          : 'All available plugins are already installed'}
                      </p>
                    </div>
                  )}

                  {/* Available plugin cards */}
                  {availablePlugins.map((entry) => {
                    const parsedAuthor = parseAuthor(entry.author);
                    return (
                      <div
                        key={entry.name}
                        className="flex items-center gap-3 rounded-xl border border-border/70 bg-card px-4 py-3 min-h-[80px]"
                      >
                        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted/50">
                          <PackageIcon className="h-4 w-4 text-muted-foreground" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-xs font-semibold">{entry.displayName}</span>
                            <span className="text-[10px] text-muted-foreground">v{entry.version}</span>
                            {parsedAuthor && (
                              <span className="text-[10px] text-muted-foreground">
                                by{' '}
                                {parsedAuthor.url ? (
                                  <a
                                    href={parsedAuthor.url}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-primary hover:underline"
                                  >
                                    {parsedAuthor.name}
                                  </a>
                                ) : (
                                  parsedAuthor.name
                                )}
                              </span>
                            )}
                            {entry.tags &&
                              entry.tags.length > 0 &&
                              entry.tags.map((tag) => (
                                <span
                                  key={tag}
                                  className="rounded-full bg-muted/50 px-2 py-0.5 text-[9px] text-muted-foreground"
                                >
                                  {tag}
                                </span>
                              ))}
                          </div>
                          <p className="line-clamp-2 text-[11px] text-muted-foreground">{entry.description}</p>
                        </div>
                        <button
                          type="button"
                          onClick={() => void handleInstall(entry.name)}
                          disabled={installingPlugins.has(entry.name)}
                          className="flex shrink-0 items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-[11px] font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
                        >
                          {installingPlugins.has(entry.name) ? (
                            <LoaderIcon className="h-3 w-3 animate-spin" />
                          ) : (
                            <DownloadIcon className="h-3 w-3" />
                          )}
                          {installingPlugins.has(entry.name) ? 'Installing…' : 'Install'}
                        </button>
                      </div>
                    );
                  })}
                </>
              )}

              {/* ── Updates Tab ── */}
              {activeTab === 'updates' && (
                <>
                  {updatablePlugins.length > 0 && (
                    <div className="flex justify-end">
                      <button
                        type="button"
                        onClick={() => void handleUpdateAll()}
                        disabled={updatingAll || updatablePlugins.every((p) => installingPlugins.has(p.name))}
                        className="flex items-center gap-1.5 rounded-lg border border-blue-500/30 bg-blue-500/20 px-3 py-1.5 text-[11px] font-medium text-blue-400 transition-colors hover:bg-blue-500/30 disabled:opacity-50"
                      >
                        {updatingAll || updatablePlugins.some((p) => installingPlugins.has(p.name)) ? (
                          <LoaderIcon className="h-3 w-3 animate-spin" />
                        ) : (
                          <ArrowUpCircleIcon className="h-3 w-3" />
                        )}
                        Update All ({updatablePlugins.length})
                      </button>
                    </div>
                  )}

                  {updatablePlugins.length === 0 && (
                    <div className="rounded-2xl border border-dashed border-border/70 bg-card/30 px-6 py-12 text-center">
                      <CheckIcon className="mx-auto h-8 w-8 text-green-400/60" />
                      <p className="mt-3 text-sm text-muted-foreground">
                        {searchQuery ? `No updates found matching "${searchQuery}"` : 'All plugins are up to date'}
                      </p>
                    </div>
                  )}

                  {updatablePlugins.map((entry) => {
                    const parsedAuthor = parseAuthor(entry.author);
                    const currentVersion = installedVersions.get(entry.name) ?? entry.installedVersion;
                    const failedUpdate = failedUpdates.get(entry.name);
                    return (
                      <div
                        key={entry.name}
                        className="flex items-center gap-3 rounded-xl border border-blue-500/30 bg-blue-500/5 px-4 py-3 min-h-[80px]"
                      >
                        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-blue-500/10">
                          <ArrowUpCircleIcon className="h-4 w-4 text-blue-400" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-xs font-semibold">{entry.displayName}</span>
                            <span className="flex items-center gap-1 text-[10px]">
                              <span className="text-muted-foreground">v{currentVersion}</span>
                              <span className="text-muted-foreground/60">→</span>
                              <span className="font-medium text-blue-400">v{entry.version}</span>
                            </span>
                            {parsedAuthor && (
                              <span className="text-[10px] text-muted-foreground">
                                by{' '}
                                {parsedAuthor.url ? (
                                  <a
                                    href={parsedAuthor.url}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-primary hover:underline"
                                  >
                                    {parsedAuthor.name}
                                  </a>
                                ) : (
                                  parsedAuthor.name
                                )}
                              </span>
                            )}
                          </div>
                          <p className="line-clamp-2 text-[11px] text-muted-foreground">{entry.description}</p>
                          {failedUpdate && (
                            <p className="mt-1 flex items-start gap-1 text-[10px] text-amber-400">
                              <AlertCircleIcon className="mt-px h-3 w-3 shrink-0" />
                              <span>
                                v{failedUpdate.attemptedVersion} failed to load ({failedUpdate.error}) — still running v
                                {failedUpdate.runningVersion}.
                              </span>
                            </p>
                          )}
                        </div>
                        <button
                          type="button"
                          onClick={() => void handleInstall(entry.name)}
                          disabled={installingPlugins.has(entry.name)}
                          className="flex shrink-0 items-center gap-1.5 rounded-lg border border-blue-500/30 bg-blue-500/20 px-3 py-1.5 text-[11px] font-medium text-blue-400 transition-colors hover:bg-blue-500/30 disabled:opacity-50"
                        >
                          {installingPlugins.has(entry.name) ? (
                            <LoaderIcon className="h-3 w-3 animate-spin" />
                          ) : (
                            <ArrowUpCircleIcon className="h-3 w-3" />
                          )}
                          {installingPlugins.has(entry.name) ? 'Updating…' : failedUpdate ? 'Retry' : 'Update'}
                        </button>
                      </div>
                    );
                  })}
                </>
              )}
            </div>
            {/* end content */}
          </div>
          {/* end glass card */}
        </div>
        {/* end max-w-3xl */}
      </div>
      {/* end overflow-y-auto */}
    </div>
  );
};
