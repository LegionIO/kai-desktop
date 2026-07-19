import type { FC, ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { useConfig } from '@/providers/ConfigProvider';
import { useFullWidthContent } from '@/hooks/useFullWidthContent';
import { usePlugins, type PluginPanelDescriptor } from '@/providers/PluginProvider';
import { getPluginComponentByHint } from './PluginComponentRegistry';
import { PluginErrorBoundary } from './PluginErrorBoundary';
import { usePluginSettingsSections } from './PluginSettingsSections';
import { getPluginNavigationIcon } from './plugin-icons';

export const PluginPanelHost: FC<{
  panel: PluginPanelDescriptor;
  onClose: () => void;
  displayName: string;
}> = ({ panel, onClose, displayName }) => {
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
  const allSettingsSections = usePluginSettingsSections();

  void rendererLoadCount;

  const Component = getPluginComponentByHint(
    panel.pluginName,
    panel.component,
    ['PanelView', `${panel.pluginName}Panel`],
    'panel',
  );
  const pluginStatus = getPluginStatus(panel.pluginName);
  const pluginError = getPluginError(panel.pluginName);
  const rendererStatus = getPluginRendererStatus(panel.pluginName);
  const rendererError = getPluginRendererError(panel.pluginName);
  const waitingForRenderer =
    !Component &&
    (pluginStatus === 'loading' ||
      (hasRendererScript(panel.pluginName) && rendererStatus !== 'error' && rendererStatus !== 'ready'));
  const sectionsForPlugin = allSettingsSections.filter((s) => s.pluginName === panel.pluginName);
  const hasSettings = sectionsForPlugin.length > 0;
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

  // Inline settings view — rendered when there's no panel component but the plugin has settings.
  // Avoids the "Open Settings" indirection by surfacing the settings directly in the panel area.
  const inlineSettingsView = (
    <div className="px-5 py-5 space-y-4">
      {sectionsForPlugin.map((pluginSection) => {
        const SettingsComponent = getPluginComponentByHint(
          pluginSection.pluginName,
          pluginSection.component,
          ['SettingsView', `${pluginSection.pluginName}Settings`],
          'settings',
        );
        const sectionRendererStatus = getPluginRendererStatus(pluginSection.pluginName);
        const sectionRendererError = getPluginRendererError(pluginSection.pluginName);
        const sectionPluginError = getPluginError(pluginSection.pluginName);
        const waitingForSectionRenderer =
          !SettingsComponent &&
          (getPluginStatus(pluginSection.pluginName) === 'loading' ||
            (hasRendererScript(pluginSection.pluginName) &&
              sectionRendererStatus !== 'error' &&
              sectionRendererStatus !== 'ready'));

        if (!SettingsComponent) {
          if (waitingForSectionRenderer) {
            return (
              <div key={pluginSection.key} className="px-6 py-8 text-center text-sm text-muted-foreground">
                Loading settings...
              </div>
            );
          }
          if (sectionPluginError || sectionRendererError) {
            return (
              <div key={pluginSection.key} className="px-6 py-8 text-center text-sm text-muted-foreground">
                Failed to load settings: {sectionPluginError || sectionRendererError}
              </div>
            );
          }
          return null;
        }

        return (
          <PluginErrorBoundary
            key={pluginSection.key}
            pluginName={pluginSection.pluginName}
            resetKey={rendererLoadCount}
          >
            <SettingsComponent
              pluginName={pluginSection.pluginName}
              config={config ?? undefined}
              updateConfig={updateConfig}
              pluginConfig={getResolvedPluginConfig(pluginSection.pluginName)}
              pluginState={pluginState}
              onAction={(action: string, data?: unknown) => {
                return sendAction(pluginSection.pluginName, `settings:${pluginSection.id}`, action, data);
              }}
              setPluginConfig={async (path: string, value: unknown) => {
                await setPluginConfig(pluginSection.pluginName, path, value);
              }}
            />
          </PluginErrorBoundary>
        );
      })}
    </div>
  );

  // Fallback unconfigured view — only shown when there's no panel component AND no settings to render inline
  const unconfiguredView = (
    <div className="flex flex-col items-center gap-4 px-6 py-12 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted/60">{pluginIcon}</div>
      <div>
        <p className="text-sm font-medium text-foreground">Connect to {displayName}</p>
        <p className="mt-1 text-xs text-muted-foreground">No settings available for this plugin.</p>
      </div>
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
      // No panel component — render settings inline if available, otherwise show fallback
      return hasSettings ? inlineSettingsView : unconfiguredView;
    }
    if (showUnconfigured) {
      // Has a panel component but plugin reports unconfigured (e.g. Outlook, Rally awaiting credentials).
      // Show the "Open Settings" button so the user configures the plugin before the panel renders.
      return (
        <div className="flex flex-col items-center gap-4 px-6 py-12 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted/60">{pluginIcon}</div>
          <div>
            <p className="text-sm font-medium text-foreground">Connect to {displayName}</p>
            <p className="mt-1 text-xs text-muted-foreground">Open settings to configure this plugin.</p>
          </div>
          {hasSettings && (
            <button
              type="button"
              onClick={() =>
                window.dispatchEvent(new CustomEvent('kai:open-settings', { detail: { plugin: panel.pluginName } }))
              }
              className="mt-2 rounded-lg bg-primary px-5 py-2 text-xs font-semibold text-primary-foreground hover:bg-primary/90 transition-colors"
            >
              Open Settings
            </button>
          )}
        </div>
      );
    }
    return (
      <Component
        pluginName={panel.pluginName}
        props={panel.props}
        config={config ?? undefined}
        updateConfig={updateConfig}
        pluginConfig={getResolvedPluginConfig(panel.pluginName)}
        pluginState={pluginState}
        onAction={(action, data) => {
          return sendAction(panel.pluginName, `panel:${panel.id}`, action, data);
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
          {/* Plugin content card */}
          <div className="rounded-2xl border border-border/50 bg-muted/30 overflow-hidden">
            <PluginErrorBoundary pluginName={panel.pluginName} resetKey={`${panel.id}:${rendererLoadCount}`}>
              {renderComponent()}
            </PluginErrorBoundary>
          </div>
        </div>
      </div>
    </div>
  );
};
