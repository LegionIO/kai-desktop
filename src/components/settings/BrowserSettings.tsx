import { useCallback, useEffect, useRef, useState, type FC } from 'react';
import { GlobeIcon, HardDriveIcon, Loader2Icon, Trash2Icon } from 'lucide-react';
import type { BrowserDataSummary } from '../../../shared/browser';
import { NumberField, Toggle, settingsSelectClass, type SettingsProps } from './shared';
import { PartitionManager } from './GeneralSettings';

type BrowserConfig = {
  enabled?: boolean;
  dataScope?: 'global' | 'conversation';
  readAccess?: 'allow' | 'ask' | 'deny';
  structuredActions?: 'allow' | 'ask' | 'deny';
  scriptInjection?: 'allow' | 'ask' | 'deny';
  passwordAccess?: 'user-only' | 'ask' | 'automatic';
  offerToSavePasswords?: boolean;
  searchProvider?: 'duckduckgo' | 'google' | 'bing';
  aiAllowPrivateNetwork?: boolean;
  idleDiscardMinutes?: number;
  maxTabsPerConversation?: number;
  showBookmarksBar?: boolean;
};

export const BrowserSettings: FC<SettingsProps & { conversationId: string | null }> = ({
  config,
  updateConfig,
  conversationId,
}) => {
  const browser = (config.browser ?? {}) as BrowserConfig;
  if (!window.app?.browser) {
    return (
      <div className="space-y-6">
        <div>
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            <GlobeIcon className="h-4 w-4" />
            Browser
          </h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Control the Chromium browser in the right sidebar, its AI access, and persistent browser profiles.
          </p>
        </div>
        <p className="rounded-lg border p-3 text-xs text-muted-foreground">
          In-app Browser settings and profile data management are available in the Kai desktop app only. Plugin browser
          data can still be managed below.
        </p>
        <PartitionManager />
      </div>
    );
  }
  return (
    <div className="space-y-6">
      <div>
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          <GlobeIcon className="h-4 w-4" />
          Browser
        </h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Control the Chromium browser in the right sidebar, its AI access, and persistent browser profiles.
        </p>
      </div>

      <fieldset className="space-y-3 rounded-lg border p-3">
        <legend className="px-1 text-xs font-semibold">Browser experience</legend>
        <Toggle
          id="browser.enabled"
          label="Enable the in-app browser"
          checked={browser.enabled ?? true}
          onChange={(value) => void updateConfig('browser.enabled', value)}
        />
        <div data-setting-id="browser.dataScope">
          <label htmlFor="browser-data-scope" className="mb-1 block text-[10px] text-muted-foreground">
            Browser data scope
          </label>
          <select
            id="browser-data-scope"
            className={settingsSelectClass}
            value={browser.dataScope ?? 'global'}
            onChange={(event) => void updateConfig('browser.dataScope', event.target.value)}
          >
            <option value="global">App-wide (default) — share sign-ins and browser data across chats</option>
            <option value="conversation">Per chat — persistent until that chat is deleted</option>
          </select>
          <p className="mt-1 text-[10px] text-muted-foreground">
            Tabs always remain owned by one chat. This setting controls cookies, storage, history, bookmarks,
            permissions, zoom, and passwords.
          </p>
        </div>
        <div data-setting-id="browser.searchProvider">
          <label htmlFor="browser-search-provider" className="mb-1 block text-[10px] text-muted-foreground">
            Omnibox search provider
          </label>
          <select
            id="browser-search-provider"
            className={settingsSelectClass}
            value={browser.searchProvider ?? 'duckduckgo'}
            onChange={(event) => void updateConfig('browser.searchProvider', event.target.value)}
          >
            <option value="duckduckgo">DuckDuckGo</option>
            <option value="google">Google</option>
            <option value="bing">Bing</option>
          </select>
        </div>
        <Toggle
          id="browser.showBookmarksBar"
          label="Show bookmarks bar"
          checked={browser.showBookmarksBar ?? false}
          onChange={(value) => void updateConfig('browser.showBookmarksBar', value)}
        />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <NumberField
            id="browser.idleDiscardMinutes"
            label="Unload idle tabs after (minutes)"
            value={browser.idleDiscardMinutes ?? 10}
            min={1}
            max={1440}
            onChange={(value) => void updateConfig('browser.idleDiscardMinutes', value)}
          />
          <NumberField
            id="browser.maxTabsPerConversation"
            label="Maximum tabs per chat"
            value={browser.maxTabsPerConversation ?? 20}
            min={1}
            max={100}
            onChange={(value) => void updateConfig('browser.maxTabsPerConversation', value)}
          />
        </div>
      </fieldset>

      <fieldset className="space-y-3 rounded-lg border p-3">
        <legend className="px-1 text-xs font-semibold">AI control</legend>
        <PolicySelect
          id="browser.readAccess"
          label="Tab listing, page inspection, screenshots, and network diagnostics"
          value={browser.readAccess ?? 'allow'}
          onChange={(value) => void updateConfig('browser.readAccess', value)}
        />
        <PolicySelect
          id="browser.structuredActions"
          label="Clicks, typing, scrolling, and navigation"
          value={browser.structuredActions ?? 'allow'}
          onChange={(value) => void updateConfig('browser.structuredActions', value)}
        />
        <PolicySelect
          id="browser.scriptInjection"
          label="Injected JavaScript"
          value={browser.scriptInjection ?? 'allow'}
          onChange={(value) => void updateConfig('browser.scriptInjection', value)}
        />
        <Toggle
          id="browser.aiAllowPrivateNetwork"
          label="Allow AI navigation to direct private-network IPs and localhost"
          checked={browser.aiAllowPrivateNetwork ?? false}
          onChange={(value) => void updateConfig('browser.aiAllowPrivateNetwork', value)}
        />
      </fieldset>

      <fieldset className="space-y-3 rounded-lg border p-3">
        <legend className="px-1 text-xs font-semibold">Passwords</legend>
        <Toggle
          id="browser.offerToSavePasswords"
          label="Offer to save or update submitted passwords"
          checked={browser.offerToSavePasswords ?? true}
          onChange={(value) => void updateConfig('browser.offerToSavePasswords', value)}
        />
        <div data-setting-id="browser.passwordAccess">
          <label htmlFor="browser-password-access" className="mb-1 block text-[10px] text-muted-foreground">
            AI saved-password access
          </label>
          <select
            id="browser-password-access"
            className={settingsSelectClass}
            value={browser.passwordAccess ?? 'user-only'}
            onChange={(event) => void updateConfig('browser.passwordAccess', event.target.value)}
          >
            <option value="user-only">User only (default)</option>
            <option value="ask">Ask every time</option>
            <option value="automatic">Automatic matching autofill</option>
          </select>
          <p className="mt-1 text-[10px] text-muted-foreground">
            Autofill never returns plaintext to the AI. Reveal, copy, and editing require Touch ID; when Touch ID is
            unavailable, those controls stay locked.
          </p>
        </div>
      </fieldset>

      <BrowserDataManager dataScope={browser.dataScope ?? 'global'} conversationId={conversationId} />
      <PartitionManager />
    </div>
  );
};

const PolicySelect: FC<{
  id: string;
  label: string;
  value: 'allow' | 'ask' | 'deny';
  onChange: (value: string) => void;
}> = ({ id, label, value, onChange }) => (
  <div data-setting-id={id}>
    <label htmlFor={id} className="mb-1 block text-[10px] text-muted-foreground">
      {label}
    </label>
    <select id={id} className={settingsSelectClass} value={value} onChange={(event) => onChange(event.target.value)}>
      <option value="allow">Allow</option>
      <option value="ask">Ask each time</option>
      <option value="deny">Deny</option>
    </select>
  </div>
);

const BrowserDataManager: FC<{ dataScope: 'global' | 'conversation'; conversationId: string | null }> = ({
  dataScope,
  conversationId,
}) => {
  const browser = window.app?.browser;
  const [summaries, setSummaries] = useState<BrowserDataSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const loadRequestRef = useRef(0);
  const currentContextRef = useRef({ dataScope, conversationId });
  currentContextRef.current = { dataScope, conversationId };
  const load = useCallback(async () => {
    const request = ++loadRequestRef.current;
    setLoading(true);
    setError(null);
    try {
      if (!browser) return;
      // Conversation selection is window-local. The backend's global active id
      // may belong to a CLI or another Kai window, so use the selection captured
      // by this Settings surface for profile summaries and clear routing.
      const next = await browser.dataSummary(conversationId ?? undefined);
      if (request !== loadRequestRef.current) return;
      setSummaries(next);
    } catch (reason) {
      if (request !== loadRequestRef.current) return;
      setError(`Browser data could not be loaded: ${reason instanceof Error ? reason.message : String(reason)}`);
    } finally {
      if (request === loadRequestRef.current) setLoading(false);
    }
  }, [browser, conversationId, dataScope]);
  useEffect(() => {
    void load();
    return () => {
      loadRequestRef.current++;
    };
  }, [load]);
  const clear = async (summary: BrowserDataSummary) => {
    if (!browser) return;
    const requestedContext = { dataScope, conversationId };
    const contextIsCurrent = () =>
      currentContextRef.current.dataScope === requestedContext.dataScope &&
      currentContextRef.current.conversationId === requestedContext.conversationId;
    const recoveryRequired = summary.recoveryRequired === true;
    if (
      !window.confirm(
        recoveryRequired
          ? 'Browser cleanup metadata is unreadable. Recover by clearing cookies, storage, permissions, history, bookmarks, saved passwords, retained Browser screenshots, and unexported assistant download quarantine copies for every discoverable Browser profile? Files you already exported or saved remain on disk.'
          : `Clear cookies, storage, permissions, history, bookmarks, saved passwords, retained Browser screenshots, and unexported assistant download quarantine copies for ${summary.scopeKey}? Files you already exported or saved remain on disk.`,
      )
    )
      return;
    setError(null);
    try {
      await browser.clearData({
        conversationId: conversationId ?? undefined,
        ...(recoveryRequired
          ? { recoverUnreadableCleanup: true }
          : {
              scopeKeys: [summary.scopeKey],
            }),
      });
      if (!contextIsCurrent()) return;
      await load();
    } catch (reason) {
      if (!contextIsCurrent()) return;
      setError(`Browser data could not be cleared: ${reason instanceof Error ? reason.message : String(reason)}`);
    }
  };
  if (!browser)
    return (
      <p className="rounded-lg border p-3 text-xs text-muted-foreground">
        Browser data management is available in the Kai desktop app.
      </p>
    );
  return (
    <fieldset data-setting-id="browser.data" className="space-y-3 rounded-lg border border-destructive/30 p-3">
      <legend className="flex items-center gap-1 px-1 text-xs font-semibold text-destructive">
        <HardDriveIcon className="h-3 w-3" />
        Browser Data
      </legend>
      <p className="text-[10px] text-muted-foreground">
        Clear a live profile safely: its page views close first, then cookies, cache, storage, permissions, history,
        bookmarks, scoped credentials, retained Browser screenshots, and unexported assistant download quarantine copies
        are removed. Files you already exported or saved remain on disk.
      </p>
      {error && (
        <p
          role="alert"
          className="rounded-md border border-destructive/30 bg-destructive/10 p-2 text-[10px] text-destructive"
        >
          {error}
        </p>
      )}
      {loading ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2Icon className="h-3.5 w-3.5 animate-spin" />
          Loading profiles…
        </div>
      ) : (
        summaries.map((summary) => (
          <div
            key={summary.scopeKey}
            className="flex items-center gap-2 rounded-lg border border-border/70 bg-card/70 p-2"
          >
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-medium">
                {summary.scopeKey === 'global'
                  ? 'App-wide browser profile'
                  : `Conversation browser profile · ${summary.scopeKey}`}
              </p>
              {summary.cleanupPending && (
                <p className="text-[10px] font-medium text-destructive">Cleanup needed for {summary.scopeKey}</p>
              )}
              {summary.warning && (
                <p className="text-[10px] font-medium text-amber-600 dark:text-amber-400">{summary.warning}</p>
              )}
              <p className="truncate font-mono text-[9px] text-muted-foreground">{summary.partition}</p>
              <p className="text-[10px] text-muted-foreground">
                {summary.historyCount} history · {summary.bookmarkCount} bookmarks · {summary.downloadCount} downloads ·{' '}
                {summary.credentialCount} passwords · {summary.activeTabCount} tabs
              </p>
            </div>
            <button
              type="button"
              onClick={() => void clear(summary)}
              className="flex items-center gap-1 rounded-md border border-destructive/40 px-2 py-1 text-[10px] text-destructive hover:bg-destructive/10"
            >
              <Trash2Icon className="h-3 w-3" />
              {summary.recoveryRequired ? 'Recover all' : 'Clear'}
            </button>
          </div>
        ))
      )}
    </fieldset>
  );
};
