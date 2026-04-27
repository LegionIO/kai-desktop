import { type FC } from 'react';
import { createPortal } from 'react-dom';
import { XIcon } from 'lucide-react';
import { useConfig } from '@/providers/ConfigProvider';
import { usePlugins } from '@/providers/PluginProvider';
import { usePluginSettingsSections } from './PluginSettingsSections';
import { getPluginComponentByHint } from './PluginComponentRegistry';

interface PluginSettingsModalProps {
  pluginName: string;
  displayName: string;
  onClose: () => void;
}

export const PluginSettingsModal: FC<PluginSettingsModalProps> = ({ pluginName, displayName, onClose }) => {
  const { config, updateConfig } = useConfig();
  const {
    setPluginConfig,
    sendAction,
    getResolvedPluginConfig,
    getPluginState,
    getPluginStatus,
    getPluginError,
    hasRendererScript,
    getPluginRendererStatus,
    getPluginRendererError,
  } = usePlugins();
  const pluginSections = usePluginSettingsSections();
  const sectionsForPlugin = pluginSections.filter((s) => s.pluginName === pluginName);

  if (!config) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      onClick={onClose}
      onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
    >
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
      <div
        className="relative flex h-[min(70vh,600px)] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-border/50 bg-popover/95 shadow-2xl backdrop-blur-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border/70 px-5 py-3">
          <h2 className="text-sm font-semibold text-foreground">{displayName} Settings</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1 text-muted-foreground transition-colors hover:bg-muted/80 hover:text-foreground"
          >
            <XIcon className="h-4 w-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          {sectionsForPlugin.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-border/70 bg-card/30 px-6 py-12 text-center text-sm text-muted-foreground">
              No settings available for this plugin.
            </div>
          ) : (
            sectionsForPlugin.map((pluginSection) => {
              const Component = getPluginComponentByHint(pluginSection.pluginName, pluginSection.component, ['SettingsView', `${pluginSection.pluginName}Settings`], 'settings');
              const pluginStatus = getPluginStatus(pluginSection.pluginName);
              const pluginError = getPluginError(pluginSection.pluginName);
              const rendererStatus = getPluginRendererStatus(pluginSection.pluginName);
              const rendererError = getPluginRendererError(pluginSection.pluginName);
              const waitingForRenderer = !Component && (
                pluginStatus === 'loading'
                || (hasRendererScript(pluginSection.pluginName) && rendererStatus !== 'error' && rendererStatus !== 'ready')
              );

              if (!Component) {
                if (waitingForRenderer) {
                  return (
                    <div key={pluginSection.key} className="rounded-2xl border border-dashed border-border/70 bg-card/30 px-6 py-12 text-center text-sm text-muted-foreground">
                      Loading plugin settings...
                    </div>
                  );
                }
                if (pluginError || rendererError) {
                  return (
                    <div key={pluginSection.key} className="rounded-2xl border border-dashed border-border/70 bg-card/30 px-6 py-12 text-center text-sm text-muted-foreground">
                      Failed to load settings: {pluginError || rendererError}
                    </div>
                  );
                }
                return null;
              }

              return (
                <Component
                  key={pluginSection.key}
                  pluginName={pluginSection.pluginName}
                  config={config}
                  updateConfig={updateConfig}
                  pluginConfig={getResolvedPluginConfig(pluginSection.pluginName)}
                  pluginState={getPluginState(pluginSection.pluginName)}
                  onAction={(action: string, data?: unknown) => {
                    sendAction(pluginSection.pluginName, `settings:${pluginSection.component}`, action, data);
                  }}
                  setPluginConfig={async (path, value) => {
                    await setPluginConfig(pluginSection.pluginName, path, value);
                  }}
                />
              );
            })
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
};
