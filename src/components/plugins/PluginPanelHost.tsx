import type { FC } from 'react';
import { PuzzleIcon, Settings2Icon } from 'lucide-react';
import { useConfig } from '@/providers/ConfigProvider';
import { usePlugins, type PluginPanelDescriptor } from '@/providers/PluginProvider';
import { getPluginComponentByHint } from './PluginComponentRegistry';

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

  const Component = getPluginComponentByHint(panel.pluginName, panel.component, ['PanelView', `${panel.pluginName}Panel`], 'panel');
  const pluginStatus = getPluginStatus(panel.pluginName);
  const pluginError = getPluginError(panel.pluginName);
  const rendererStatus = getPluginRendererStatus(panel.pluginName);
  const rendererError = getPluginRendererError(panel.pluginName);
  const waitingForRenderer = !Component && (
    pluginStatus === 'loading'
    || (hasRendererScript(panel.pluginName) && rendererStatus !== 'error' && rendererStatus !== 'ready')
  );
  const widthClass = widthClassMap[panel.width ?? 'default'];
  const hasSettings = uiState?.settingsSections?.some((s) => s.pluginName === panel.pluginName) ?? false;

  return (
    <div className="flex h-full flex-col">
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
              Loading plugin UI for &ldquo;{panel.pluginName}&rdquo;...
            </div>
          ) : pluginError || rendererError ? (
            <div className="rounded-2xl border border-dashed border-border/70 bg-card/30 px-6 py-12 text-center text-sm text-muted-foreground">
              Failed to load the plugin UI for &ldquo;{panel.pluginName}&rdquo;: {pluginError || rendererError}
            </div>
          ) : (
            <div className="flex flex-col items-center gap-4 rounded-2xl border border-dashed border-border/70 bg-card/30 px-6 py-16 text-center">
              <PuzzleIcon className="h-10 w-10 text-muted-foreground/40" />
              <div>
                <p className="text-sm font-medium text-foreground">This plugin does not have a panel view</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  It runs in the background and provides its functionality through tools, hooks, or settings.
                </p>
              </div>
              {hasSettings && (
                <button
                  type="button"
                  onClick={() => window.dispatchEvent(new CustomEvent('kai:open-settings', { detail: { plugin: panel.pluginName } }))}
                  className="mt-2 inline-flex items-center gap-1.5 rounded-xl border border-border/70 bg-card/60 px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted/60"
                >
                  <Settings2Icon className="h-4 w-4" />
                  Open Settings
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
