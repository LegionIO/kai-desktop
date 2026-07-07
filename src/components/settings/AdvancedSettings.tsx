import { type FC } from 'react';
import { InfoIcon, AlertTriangleIcon } from 'lucide-react';
import { Toggle, NumberField, settingsSelectClass, type SettingsProps } from './shared';

export const AdvancedSettings: FC<SettingsProps & { hideTitle?: boolean }> = ({ config, updateConfig, hideTitle }) => {
  const advanced = config.advanced as {
    temperature: number;
    maxSteps: number;
    maxRetries: number;
    useResponsesApi: boolean;
  };

  const ui = config.ui as { showPluginDockIcons?: boolean; dockBadgeStyle?: 'dot' | 'truncate' | 'full' } | undefined;

  return (
    <div className="space-y-6">
      {!hideTitle && (
        <div>
          <h3 className="text-sm font-semibold">Advanced Settings</h3>
          <p className="mt-1 text-xs text-muted-foreground">Fine-tune model behavior, step limits, and retry logic.</p>
        </div>
      )}

      {/* Step Limit Section */}
      <fieldset className="rounded-lg border p-4 space-y-4">
        <legend className="text-xs font-semibold px-1">Task Execution</legend>

        <div className="space-y-3">
          <NumberField
            id="advanced.maxSteps"
            label="Max steps per task"
            value={advanced.maxSteps}
            onChange={(v) => updateConfig('advanced.maxSteps', Math.max(5, Math.min(100, v || 25)))}
            min={5}
            max={100}
          />

          <div className="flex items-start gap-2 rounded-md bg-muted/40 p-3 text-[10px] leading-relaxed text-muted-foreground">
            <InfoIcon className="h-3.5 w-3.5 shrink-0 mt-0.5" />
            <p>
              Controls how many reasoning steps the AI can take before stopping. Higher values allow more complex tasks
              but take longer. Default: <strong>25 steps</strong>.
            </p>
          </div>
        </div>
      </fieldset>

      {/* Temperature Section */}
      <fieldset className="rounded-lg border p-4 space-y-4">
        <legend className="text-xs font-semibold px-1">Response Style</legend>

        <div className="space-y-3">
          <div data-setting-id="advanced.temperature">
            <label className="text-[10px] text-muted-foreground mb-1 flex items-center justify-between">
              <span>Temperature</span>
              <span className="font-mono font-semibold text-foreground">{advanced.temperature.toFixed(2)}</span>
            </label>
            <input
              type="range"
              min="0"
              max="2"
              step="0.05"
              value={advanced.temperature}
              onChange={(e) => updateConfig('advanced.temperature', parseFloat(e.target.value))}
              className="w-full"
            />
            <div className="flex justify-between text-[9px] text-muted-foreground mt-1">
              <span>Focused (0.0)</span>
              <span>Balanced (0.7)</span>
              <span>Creative (2.0)</span>
            </div>
          </div>

          <div className="flex items-start gap-2 rounded-md bg-muted/40 p-3 text-[10px] leading-relaxed text-muted-foreground">
            <InfoIcon className="h-3.5 w-3.5 shrink-0 mt-0.5" />
            <p>
              Lower values make responses more focused and deterministic. Higher values increase creativity and
              variation. Default: <strong>0.4</strong> (balanced).
            </p>
          </div>
        </div>
      </fieldset>

      {/* Retry Logic Section */}
      <fieldset className="rounded-lg border p-4 space-y-4">
        <legend className="text-xs font-semibold px-1">Error Handling</legend>

        <div className="space-y-3">
          <NumberField
            id="advanced.maxRetries"
            label="Max retries on transient errors"
            value={advanced.maxRetries}
            onChange={(v) => updateConfig('advanced.maxRetries', Math.max(0, Math.min(10, Number.isFinite(v) ? v : 4)))}
            min={0}
            max={10}
          />

          <div className="flex items-start gap-2 rounded-md bg-muted/40 p-3 text-[10px] leading-relaxed text-muted-foreground">
            <InfoIcon className="h-3.5 w-3.5 shrink-0 mt-0.5" />
            <p>
              How many times to retry when encountering network errors or rate limits. Default:{' '}
              <strong>4 retries</strong>.
            </p>
          </div>
        </div>
      </fieldset>

      {/* API Options */}
      <fieldset className="rounded-lg border p-4 space-y-4">
        <legend className="text-xs font-semibold px-1">API Options</legend>

        <Toggle
          id="advanced.useResponsesApi"
          label="Use Responses API (where available)"
          checked={advanced.useResponsesApi}
          onChange={(v) => updateConfig('advanced.useResponsesApi', v)}
        />

        <div className="flex items-start gap-2 rounded-md bg-muted/40 p-3 text-[10px] leading-relaxed text-muted-foreground">
          <InfoIcon className="h-3.5 w-3.5 shrink-0 mt-0.5" />
          <p>
            Enable the OpenAI Responses API format for models that support it. This provides better streaming and error
            handling.
          </p>
        </div>
      </fieldset>

      {/* Sidebar */}
      <fieldset className="rounded-lg border p-4 space-y-4">
        <legend className="text-xs font-semibold px-1">Sidebar</legend>

        <Toggle
          id="ui.showPluginDockIcons"
          label="Show plugin icons in dock"
          checked={ui?.showPluginDockIcons !== false}
          onChange={(v) => updateConfig('ui.showPluginDockIcons', v)}
        />

        <div className="flex items-start gap-2 rounded-md bg-muted/40 p-3 text-[10px] leading-relaxed text-muted-foreground">
          <InfoIcon className="h-3.5 w-3.5 shrink-0 mt-0.5" />
          <p>
            When enabled, plugins that provide a content panel (not settings-only) will appear as icons in the bottom
            dock for quick access.
          </p>
        </div>

        <div data-setting-id="ui.dockBadgeStyle">
          <label className="text-[10px] text-muted-foreground block mb-0.5">Dock badge style</label>
          <select
            className={settingsSelectClass}
            value={ui?.dockBadgeStyle ?? 'dot'}
            onChange={(e) => updateConfig('ui.dockBadgeStyle', e.target.value)}
          >
            <option value="dot">Dot (text in tooltip)</option>
            <option value="truncate">Truncated pill</option>
            <option value="full">Full text pill</option>
          </select>
          <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">
            How word/text notification badges render on dock icons. Numeric badges always show as a count. “Dot” keeps
            the dock compact and moves the text to the icon’s tooltip; “Full text” may widen the icon to fit.
          </p>
        </div>
      </fieldset>

      {/* Warning */}
      <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-[10px] text-amber-900 dark:text-amber-100">
        <AlertTriangleIcon className="h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400 mt-0.5" />
        <p>
          <strong>Note:</strong> These are global defaults. Individual profiles and conversations can override these
          values.
        </p>
      </div>
    </div>
  );
};
