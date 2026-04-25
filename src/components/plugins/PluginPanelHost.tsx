import type { FC } from 'react';
import { Settings2Icon } from 'lucide-react';
import { useConfig } from '@/providers/ConfigProvider';
import { usePlugins, type PluginPanelDescriptor } from '@/providers/PluginProvider';
import { getPluginComponent } from './PluginComponentRegistry';

const widthClassMap: Record<NonNullable<PluginPanelDescriptor['width']>, string> = {
  default: 'max-w-5xl',
  wide: 'max-w-6xl',
  full: 'max-w-none',
};

export const PluginPanelHost: FC<{
  panel: PluginPanelDescriptor;
  onClose: () => void;
}> = ({ panel, onClose }) => {
  const { config, updateConfig } = useConfig();
  const {
    sendAction,
    setPluginConfig,
    getResolvedPluginConfig,
    getPluginState,
    rendererLoadCount,
    getPluginStatus,
    getPluginError,
    hasRendererScript,
    getPluginRendererStatus,
    getPluginRendererError,
    uiState,
  } = usePlugins();

  void rendererLoadCount;

  const Component = getPluginComponent(panel.pluginName, 'PanelView');
  const pluginStatus = getPluginStatus(panel.pluginName);
  const pluginError = getPluginError(panel.pluginName);
  const rendererStatus = getPluginRendererStatus(panel.pluginName);
  const rendererError = getPluginRendererError(panel.pluginName);
  const waitingForRenderer = !Component && (
    pluginStatus === 'loading'
    || (hasRendererScript(panel.pluginName) && rendererStatus !== 'error')
  );
  const widthClass = widthClassMap[panel.width ?? 'default'];

  const hasSettings = uiState?.settingsSections.some((s) => s.pluginName === panel.pluginName);

  const openSettings = () => {
    window.dispatchEvent(new CustomEvent('kai:open-settings', {
      detail: { plugin: panel.pluginName },
    }));
  };

  return (
    <div className="flex h-full flex-col">
      {hasSettings && (
        <div className="flex items-center justify-end border-b border-border/50 px-4 py-2 shrink-0">
          <button
            type="button"
            onClick={openSettings}
            className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs text-muted-foreground hover:bg-muted/60 hover:text-foreground transition-colors"
          >
            <Settings2Icon className="h-3.5 w-3.5" />
            Settings
          </button>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
        <div className={`mx-auto w-full ${widthClass}`}>
          {Component ? (
            <Component
              pluginName={panel.pluginName}
              props={panel.props}
              config={config ?? undefined}
              updateConfig={updateConfig}
              pluginConfig={getResolvedPluginConfig(panel.pluginName)}
              pluginState={getPluginState(panel.pluginName)}
              onAction={(action, data) => {
                sendAction(panel.pluginName, `panel:${panel.id}`, action, data);
              }}
              onClose={onClose}
              setPluginConfig={async (path, value) => {
                await setPluginConfig(panel.pluginName, path, value);
              }}
            />
          ) : waitingForRenderer ? (
            <div className="rounded-2xl border border-dashed border-border/70 bg-card/30 px-6 py-12 text-center text-sm text-muted-foreground">
              Loading plugin UI for "{panel.pluginName}"...
            </div>
          ) : pluginError || rendererError ? (
            <div className="rounded-2xl border border-dashed border-border/70 bg-card/30 px-6 py-12 text-center text-sm text-muted-foreground">
              Failed to load the plugin UI for "{panel.pluginName}": {pluginError || rendererError}
            </div>
          ) : (
            <div className="rounded-2xl border border-dashed border-border/70 bg-card/30 px-6 py-12 text-center text-sm text-muted-foreground">
              No UI registered for "{panel.pluginName}".
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
