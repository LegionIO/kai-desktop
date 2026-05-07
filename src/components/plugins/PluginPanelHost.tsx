import type { FC, ReactNode } from 'react';
import { Settings2Icon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useConfig } from '@/providers/ConfigProvider';
import { useFullWidthContent } from '@/hooks/useFullWidthContent';
import { usePlugins, type PluginPanelDescriptor } from '@/providers/PluginProvider';
import { getPluginComponentByHint } from './PluginComponentRegistry';
import { getPluginNavigationIcon } from './plugin-icons';

export const PluginPanelHost: FC<{
  panel: PluginPanelDescriptor;
  onClose: () => void;
  displayName: string;
  onOpenSettings?: () => void;
}> = ({ panel, onClose, displayName, onOpenSettings }) => {
  const { config, updateConfig } = useConfig();
  const fullWidth = useFullWidthContent();
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

  const Component = getPluginComponentByHint(panel.pluginName, panel.component, ['PanelView', `${panel.pluginName}Panel`], 'panel');
  const pluginStatus = getPluginStatus(panel.pluginName);
  const pluginError = getPluginError(panel.pluginName);
  const rendererStatus = getPluginRendererStatus(panel.pluginName);
  const rendererError = getPluginRendererError(panel.pluginName);
  const waitingForRenderer = !Component && (
    pluginStatus === 'loading'
    || (hasRendererScript(panel.pluginName) && rendererStatus !== 'error' && rendererStatus !== 'ready')
  );
  const hasSettings = uiState?.settingsSections?.some((s) => s.pluginName === panel.pluginName) ?? false;
  const pluginState = getPluginState(panel.pluginName);
  // Plugins opt-in to the "configured" check by explicitly setting state.configured = false.
  // By default (undefined/true), the plugin's panel renders normally.
  const showUnconfigured = pluginState?.configured === false;

  // Resolve the plugin's icon from its navigation item
  const navItem = uiState?.navigationItems?.find((n) => n.pluginName === panel.pluginName && n.visible);
  const pluginIcon: ReactNode = (
    <span className="[&>svg]:h-5 [&>svg]:w-5 [&>span]:h-5 [&>span]:w-5 [&>span>svg]:h-5 [&>span>svg]:w-5">
      {getPluginNavigationIcon(navItem?.icon)}
    </span>
  );

  // Standard unconfigured view — shown when plugin has a component but state.configured is not true
  const unconfiguredView = (
    <div className="flex flex-col items-center gap-4 px-6 py-12 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted/60">
        {pluginIcon}
      </div>
      <div>
        <p className="text-sm font-medium text-foreground">Connect to {displayName}</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Open settings to configure this plugin.
        </p>
      </div>
      {hasSettings && (
        <button
          type="button"
          onClick={() => window.dispatchEvent(new CustomEvent('kai:open-settings', { detail: { plugin: panel.pluginName } }))}
          className="mt-2 rounded-lg bg-primary px-5 py-2 text-xs font-semibold text-primary-foreground hover:bg-primary/90 transition-colors"
        >
          Open Settings
        </button>
      )}
    </div>
  );

  const renderComponent = () => {
    if (!Component) {
      if (waitingForRenderer) {
        return (
          <div className="px-6 py-12 text-center text-sm text-muted-foreground">
            Loading plugin UI for &ldquo;{panel.pluginName}&rdquo;...
          </div>
        );
      }
      if (pluginError || rendererError) {
        return (
          <div className="px-6 py-12 text-center text-sm text-muted-foreground">
            Failed to load the plugin UI for &ldquo;{panel.pluginName}&rdquo;: {pluginError || rendererError}
          </div>
        );
      }
      return unconfiguredView;
    }
    if (showUnconfigured) return unconfiguredView;
    return (
      <Component
        pluginName={panel.pluginName}
        props={panel.props}
        config={config ?? undefined}
        updateConfig={updateConfig}
        pluginConfig={getResolvedPluginConfig(panel.pluginName)}
        pluginState={pluginState}
        onAction={(action, data) => {
          sendAction(panel.pluginName, `panel:${panel.id}`, action, data);
        }}
        onClose={onClose}
        setPluginConfig={async (path, value) => {
          await setPluginConfig(panel.pluginName, path, value);
        }}
      />
    );
  };

  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className={cn('mx-auto w-full px-4 pt-3 pb-5', !fullWidth && 'max-w-3xl')}>
          {/* Settings button */}
          <div className="flex justify-end pb-1.5">
            <button
              type="button"
              onClick={() => {
                if (onOpenSettings) {
                  onOpenSettings();
                } else {
                  window.dispatchEvent(new CustomEvent('kai:open-settings', { detail: { plugin: panel.pluginName } }));
                }
              }}
              className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs text-muted-foreground hover:bg-muted/60 hover:text-foreground transition-colors"
            >
              <Settings2Icon className="h-3.5 w-3.5" />
              Settings
            </button>
          </div>
          {/* Plugin content card */}
          <div className="rounded-2xl border border-border/50 bg-muted/30 overflow-hidden">
            {renderComponent()}
          </div>
        </div>
      </div>
    </div>
  );
};
