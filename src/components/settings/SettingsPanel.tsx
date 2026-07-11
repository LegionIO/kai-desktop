import { useState, useEffect, useRef, useMemo, type FC } from 'react';
import { ChevronRightIcon, SearchIcon } from 'lucide-react';
import { useConfig } from '@/providers/ConfigProvider';
import { ModelSettings } from './ModelSettings';
import { ToolSettings } from './ToolSettings';
import { CliToolsSettings } from './CliToolsSettings';
import { McpSettings } from './McpSettings';
import { SkillSettings } from './SkillSettings';
import { AudioSettings } from './AudioSettings';
import { RealtimeSettings } from './RealtimeSettings';
import { DictationSettings } from './DictationSettings';
import { AppShotsSettings } from './AppShotsSettings';
import { AppshotsSettings } from './AppshotGallerySettings';
import { UsageDashboard } from './UsageDashboard';
import { ComputerUseSettings } from './ComputerUseSettings';
import { MediaGenerationSettings } from './MediaGenerationSettings';
import { WebServerSettings } from './WebServerSettings';
import { GeneralSettings } from './GeneralSettings';
import { AutomationsSettings } from './AutomationsSettings';
import { searchSettings, breadcrumb, type SettingsSearchEntry } from './search-index';
import type { SettingsProps } from './shared';

export type SettingsSection =
  | 'models'
  | 'usage'
  | 'tools'
  | 'automations'
  | 'general'
  | 'audio'
  | 'voice'
  | 'computer-use'
  | 'media-generation'
  | 'web-server';

const sections: Array<{ key: SettingsSection; label: string }> = [
  { key: 'models', label: 'Models' },
  { key: 'usage', label: 'Usage' },
  { key: 'tools', label: 'Tools' },
  { key: 'automations', label: 'Automations' },
  { key: 'general', label: 'Application' },
  { key: 'audio', label: 'Audio' },
  { key: 'voice', label: 'Voice' },
  { key: 'computer-use', label: 'Autopilot' },
  { key: 'media-generation', label: 'Media Generation' },
  { key: 'web-server', label: 'Web UI' },
];

type FocusTarget = { tab?: string; anchorId?: string; fallbackId?: string; nonce: number };

type NavigateDetail = { section?: SettingsSection; tab?: string; anchorId?: string };

// Buffer `kai:navigate-settings` events fired before SettingsPanel mounts (e.g. immediately
// after `kai:open-settings` from the step-limit banner) so the target isn't lost to a race.
let pendingNav: NavigateDetail | null = null;
if (typeof window !== 'undefined') {
  window.addEventListener('kai:navigate-settings', (e) => {
    pendingNav = (e as CustomEvent<NavigateDetail>).detail ?? null;
  });
}

export const SettingsPanel: FC<{ onClose: () => void; onOpenConversation?: (id: string) => void }> = ({
  onClose,
  onOpenConversation,
}) => {
  const { config, updateConfig } = useConfig();
  const [activeSection, setActiveSection] = useState<SettingsSection>('models');
  const [query, setQuery] = useState('');
  const [focus, setFocus] = useState<FocusTarget | null>(null);

  const navRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // Scroll active nav item into view whenever activeSection changes
  useEffect(() => {
    const nav = navRef.current;
    if (!nav) return;
    const active = nav.querySelector('[data-active="true"]') as HTMLElement | null;
    active?.scrollIntoView({ block: 'nearest' });
  }, [activeSection]);

  useEffect(() => {
    const handler = () => onClose();
    window.addEventListener('close-settings', handler);
    return () => window.removeEventListener('close-settings', handler);
  }, [onClose]);

  // Programmatic navigation (e.g. "Adjust settings" from the step-limit banner in RuntimeProvider).
  useEffect(() => {
    const apply = (detail: NavigateDetail | null) => {
      if (!detail?.section) return;
      setActiveSection(detail.section);
      setFocus({ tab: detail.tab, anchorId: detail.anchorId, nonce: Date.now() });
      pendingNav = null;
    };
    apply(pendingNav);
    const handler = (e: Event) => apply((e as CustomEvent<NavigateDetail>).detail);
    window.addEventListener('kai:navigate-settings', handler);
    return () => window.removeEventListener('kai:navigate-settings', handler);
  }, []);

  // After navigating from a search result, scroll the target field into view and pulse it.
  useEffect(() => {
    if (!focus?.anchorId) return;
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        const find = (id?: string) =>
          id ? contentRef.current?.querySelector<HTMLElement>(`[data-setting-id="${id}"]`) : null;
        const el = find(focus.anchorId) ?? find(focus.fallbackId);
        if (el) {
          el.scrollIntoView({ block: 'center', behavior: 'smooth' });
          el.classList.add('settings-highlight');
          setTimeout(() => el.classList.remove('settings-highlight'), 1600);
        } else {
          contentRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
        }
      });
    });
    return () => {
      cancelAnimationFrame(raf1);
      if (raf2) cancelAnimationFrame(raf2);
    };
  }, [focus]);

  const results = useMemo(() => searchSettings(query), [query]);
  const searching = query.trim().length > 0;

  const handleResultClick = (entry: SettingsSearchEntry) => {
    setActiveSection(entry.section);
    setFocus({ tab: entry.tab, anchorId: entry.id, fallbackId: entry.fallbackId, nonce: Date.now() });
    setQuery('');
    searchRef.current?.blur();
  };

  if (!config) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-muted-foreground">Loading configuration...</p>
      </div>
    );
  }

  const focusTab = focus?.tab;
  const focusNonce = focus?.nonce;

  return (
    <div className="flex h-full flex-col bg-background md:flex-row">
      <div className="app-shell-panel w-full shrink-0 border-b border-border/70 bg-sidebar/55 md:w-[220px] md:overflow-y-auto md:border-b-0 md:border-r md:p-3">
        <div className="px-2 pt-2 md:px-3 md:pt-0 md:pb-2">
          <div className="flex items-center gap-2 rounded-xl border border-border/60 bg-muted/30 px-2.5 py-1.5">
            <SearchIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <input
              ref={searchRef}
              type="text"
              placeholder="Search settings…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  if (query) {
                    e.preventDefault();
                    e.stopPropagation();
                    setQuery('');
                  }
                  searchRef.current?.blur();
                } else if (e.key === 'Enter' && results.length > 0) {
                  handleResultClick(results[0]);
                }
              }}
              className="min-w-0 flex-1 bg-transparent text-xs text-foreground placeholder:text-muted-foreground focus:outline-none"
            />
          </div>
        </div>

        <div
          ref={navRef}
          className={
            searching
              ? 'block space-y-1 px-2 pb-2 max-h-[45vh] overflow-y-auto md:max-h-none md:overflow-visible md:px-3 md:pb-0'
              : 'flex gap-1 overflow-x-auto px-2 pb-2 md:block md:space-y-1 md:overflow-x-visible md:px-3 md:pb-0'
          }
        >
          {searching ? (
            results.length > 0 ? (
              results.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  onClick={() => handleResultClick(entry)}
                  className="flex w-full min-w-0 shrink-0 flex-col items-start gap-0.5 rounded-2xl px-3 py-2 text-left text-xs font-medium text-muted-foreground transition-all hover:bg-muted/80 hover:text-foreground"
                >
                  <span className="w-full truncate text-foreground">{entry.label}</span>
                  <span className="w-full truncate text-[10px] text-muted-foreground/70">{breadcrumb(entry)}</span>
                </button>
              ))
            ) : (
              <div className="px-3 py-4 text-center text-[11px] text-muted-foreground/70">No settings match</div>
            )
          ) : (
            sections.map((section) => (
              <button
                key={section.key}
                type="button"
                data-active={activeSection === section.key}
                onClick={() => {
                  setActiveSection(section.key);
                  setFocus(null);
                }}
                className={`flex shrink-0 items-center gap-2 whitespace-nowrap rounded-2xl px-3 py-2 text-xs font-medium transition-all md:w-full ${
                  activeSection === section.key
                    ? 'bg-primary text-primary-foreground shadow-[0_12px_28px_var(--brand-accent-glow)]'
                    : 'text-muted-foreground hover:bg-muted/80 hover:text-foreground'
                }`}
              >
                {section.label}
                <ChevronRightIcon className="ml-auto hidden h-3 w-3 opacity-50 md:block" />
              </button>
            ))
          )}
        </div>
      </div>

      <div ref={contentRef} className="min-h-0 flex-1 overflow-y-auto p-3 md:p-5">
        {activeSection === 'models' && (
          <ModelSettings config={config} updateConfig={updateConfig} focusTab={focusTab} focusNonce={focusNonce} />
        )}
        {activeSection === 'usage' && <UsageDashboard config={config} updateConfig={updateConfig} />}
        {activeSection === 'tools' && (
          <CombinedToolsSettings
            config={config}
            updateConfig={updateConfig}
            focusTab={focusTab}
            focusNonce={focusNonce}
          />
        )}
        {activeSection === 'automations' && (
          <AutomationsSettings config={config} updateConfig={updateConfig} onOpenConversation={onOpenConversation} />
        )}
        {activeSection === 'audio' && <AudioSettings config={config} updateConfig={updateConfig} />}
        {activeSection === 'voice' && (
          <VoiceSettings config={config} updateConfig={updateConfig} focusTab={focusTab} focusNonce={focusNonce} />
        )}
        {activeSection === 'media-generation' && (
          <MediaGenerationSettings
            config={config}
            updateConfig={updateConfig}
            focusTab={focusTab}
            focusNonce={focusNonce}
          />
        )}
        {activeSection === 'computer-use' && <ComputerUseSettings config={config} updateConfig={updateConfig} />}
        {activeSection === 'web-server' && <WebServerSettings config={config} updateConfig={updateConfig} />}
        {activeSection === 'general' && (
          <ApplicationSettings
            config={config}
            updateConfig={updateConfig}
            focusTab={focusTab}
            focusNonce={focusNonce}
          />
        )}
      </div>
    </div>
  );
};

type ToolTab = 'built-in' | 'cli' | 'skills' | 'mcp';

const CombinedToolsSettings: FC<SettingsProps> = ({ config, updateConfig, focusTab, focusNonce }) => {
  const [activeTab, setActiveTab] = useState<ToolTab>('built-in');

  useEffect(() => {
    if (focusTab) setActiveTab(focusTab as ToolTab);
  }, [focusTab, focusNonce]);

  const tabs: Array<{ key: ToolTab; label: string }> = [
    { key: 'built-in', label: 'System' },
    { key: 'cli', label: 'CLI' },
    { key: 'mcp', label: 'MCP' },
    { key: 'skills', label: 'Skills' },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-sm font-semibold">Tools</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Manage built-in tools, CLI integrations, MCP servers, and skills.
        </p>
      </div>

      {/* Tab Bar */}
      <div className="flex gap-1 border-b border-border/60">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            type="button"
            onClick={() => setActiveTab(tab.key)}
            className={`px-3 py-1.5 text-xs font-medium rounded-t-lg transition-colors ${
              activeTab === tab.key
                ? 'bg-card border border-b-0 border-border/60 text-foreground'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Content */}
      {activeTab === 'built-in' && <ToolSettings config={config} updateConfig={updateConfig} hideTitle />}
      {activeTab === 'cli' && <CliToolsSettings config={config} updateConfig={updateConfig} hideTitle />}
      {activeTab === 'skills' && <SkillSettings config={config} updateConfig={updateConfig} hideTitle />}
      {activeTab === 'mcp' && <McpSettings config={config} updateConfig={updateConfig} hideTitle />}
    </div>
  );
};

type ApplicationTab = 'general' | 'app-shots' | 'appshots';

const ApplicationSettings: FC<SettingsProps> = ({ config, updateConfig, focusTab, focusNonce }) => {
  const [activeTab, setActiveTab] = useState<ApplicationTab>('general');

  useEffect(() => {
    if (focusTab) setActiveTab(focusTab as ApplicationTab);
  }, [focusTab, focusNonce]);

  const tabs: Array<{ key: ApplicationTab; label: string }> = [
    { key: 'general', label: 'General' },
    { key: 'app-shots', label: 'App Shots' },
    { key: 'appshots', label: 'Appshots' },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-sm font-semibold">Application</h3>
        <p className="mt-1 text-xs text-muted-foreground">Startup, appearance, and capture shortcuts.</p>
      </div>

      {/* Tab Bar */}
      <div className="flex gap-1 border-b border-border/60">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            type="button"
            onClick={() => setActiveTab(tab.key)}
            className={`px-3 py-1.5 text-xs font-medium rounded-t-lg transition-colors ${
              activeTab === tab.key
                ? 'bg-card border border-b-0 border-border/60 text-foreground'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Content */}
      {activeTab === 'general' && <GeneralSettings config={config} updateConfig={updateConfig} hideTitle />}
      {activeTab === 'app-shots' && <AppShotsSettings config={config} updateConfig={updateConfig} hideTitle />}
      {activeTab === 'appshots' && <AppshotsSettings config={config} updateConfig={updateConfig} hideTitle />}
    </div>
  );
};

type VoiceTab = 'realtime' | 'dictation';

const VoiceSettings: FC<SettingsProps> = ({ config, updateConfig, focusTab, focusNonce }) => {
  const [activeTab, setActiveTab] = useState<VoiceTab>('realtime');

  useEffect(() => {
    if (focusTab) setActiveTab(focusTab as VoiceTab);
  }, [focusTab, focusNonce]);

  const tabs: Array<{ key: VoiceTab; label: string }> = [
    { key: 'realtime', label: 'Voice Chat' },
    { key: 'dictation', label: 'Dictation' },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-sm font-semibold">Voice</h3>
        <p className="mt-1 text-xs text-muted-foreground">Configure live voice chat and dictation settings.</p>
      </div>

      {/* Tab Bar */}
      <div className="flex gap-1 border-b border-border/60">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            type="button"
            onClick={() => setActiveTab(tab.key)}
            className={`px-3 py-1.5 text-xs font-medium rounded-t-lg transition-colors ${
              activeTab === tab.key
                ? 'bg-card border border-b-0 border-border/60 text-foreground'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Content */}
      {activeTab === 'realtime' && <RealtimeSettings config={config} updateConfig={updateConfig} hideTitle />}
      {activeTab === 'dictation' && <DictationSettings config={config} updateConfig={updateConfig} />}
    </div>
  );
};
