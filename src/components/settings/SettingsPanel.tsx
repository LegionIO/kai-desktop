import { useState, useEffect, useRef, type FC } from 'react';
import { ChevronRightIcon } from 'lucide-react';
import { useConfig } from '@/providers/ConfigProvider';
import { ModelSettings } from './ModelSettings';
import { ToolSettings } from './ToolSettings';
import { CliToolsSettings } from './CliToolsSettings';
import { McpSettings } from './McpSettings';
import { SkillSettings } from './SkillSettings';
import { AudioVoiceSettings } from './AudioVoiceSettings';
import { ComputerUseSettings } from './ComputerUseSettings';
import { MediaGenerationSettings } from './MediaGenerationSettings';
import { WebServerSettings } from './WebServerSettings';
import { GeneralSettings } from './GeneralSettings';
import type { SettingsProps } from './shared';

type SettingsSection =
  | 'models'
  | 'tools'
  | 'general'
  | 'audio-voice'
  | 'computer-use'
  | 'media-generation'
  | 'web-server';

const sections: Array<{ key: SettingsSection; label: string }> = [
  { key: 'models', label: 'Models' },
  { key: 'tools', label: 'Tools' },
  { key: 'general', label: 'Application' },
  { key: 'audio-voice', label: 'Audio & Voice' },
  { key: 'computer-use', label: 'Autopilot' },
  { key: 'media-generation', label: 'Media Generation' },
  { key: 'web-server', label: 'Web UI' },
];

export const SettingsPanel: FC<{ onClose: () => void }> = ({ onClose }) => {
  const { config, updateConfig } = useConfig();
  const [activeSection, setActiveSection] = useState<SettingsSection>('models');

  const navRef = useRef<HTMLDivElement>(null);

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

  if (!config) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-muted-foreground">Loading configuration...</p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-background md:flex-row">
      <div className="app-shell-panel w-full shrink-0 border-b border-border/70 bg-sidebar/55 md:w-[220px] md:overflow-y-auto md:border-b-0 md:border-r md:p-3">
        <div ref={navRef} className="flex gap-1 overflow-x-auto px-2 pb-2 md:block md:space-y-1 md:overflow-x-visible md:px-3 md:pb-0">
          {sections.map((section) => (
            <button
              key={section.key}
              type="button"
              data-active={activeSection === section.key}
              onClick={() => setActiveSection(section.key)}
              className={`flex shrink-0 items-center gap-2 whitespace-nowrap rounded-2xl px-3 py-2 text-xs font-medium transition-all md:w-full ${
                activeSection === section.key
                  ? 'bg-primary text-primary-foreground shadow-[0_12px_28px_var(--brand-accent-glow)]'
                  : 'text-muted-foreground hover:bg-muted/80 hover:text-foreground'
              }`}
            >
              {section.label}
              <ChevronRightIcon className="ml-auto hidden h-3 w-3 opacity-50 md:block" />
            </button>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3 md:p-5">
        {activeSection === 'models' && <ModelSettings config={config} updateConfig={updateConfig} />}
        {activeSection === 'tools' && <CombinedToolsSettings config={config} updateConfig={updateConfig} />}
        {activeSection === 'audio-voice' && <AudioVoiceSettings config={config} updateConfig={updateConfig} />}
        {activeSection === 'media-generation' && <MediaGenerationSettings config={config} updateConfig={updateConfig} />}
        {activeSection === 'computer-use' && <ComputerUseSettings config={config} updateConfig={updateConfig} />}
        {activeSection === 'web-server' && <WebServerSettings config={config} updateConfig={updateConfig} />}
        {activeSection === 'general' && <GeneralSettings config={config} updateConfig={updateConfig} />}
      </div>
    </div>
  );
};

type ToolTab = 'built-in' | 'cli' | 'skills' | 'mcp';

const CombinedToolsSettings: FC<SettingsProps> = ({ config, updateConfig }) => {
  const [activeTab, setActiveTab] = useState<ToolTab>('built-in');

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
