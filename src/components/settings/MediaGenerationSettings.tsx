import { useState, useEffect, type FC } from 'react';
import { EyeIcon, EyeOffIcon } from 'lucide-react';
import type { SettingsProps } from './shared';
import { Toggle, NumberField, settingsSelectClass } from './shared';

type MediaProvider = 'openai' | 'azure' | 'custom';

type MediaTab = 'image' | 'video';

type MediaGenConfig = {
  enabled?: boolean;
  provider?: MediaProvider;
  openai?: { apiKey?: string };
  azure?: { endpoint?: string; apiKey?: string; deploymentName?: string; apiVersion?: string };
  custom?: { baseUrl?: string; apiKey?: string };
  model?: string;
  // Image-specific
  size?: string;
  quality?: string;
  style?: string;
  outputFormat?: string;
  // Video-specific
  duration?: string;
  // Audio-specific (reserved for future use)
  voice?: string;
  // Timeout
  timeout?: number;
};

// ─── Password Field ──────────────────────────────────────────────────────────

const PasswordField: FC<{
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}> = ({ label, value, onChange, placeholder }) => {
  const [visible, setVisible] = useState(false);

  return (
    <div>
      <label className="text-[10px] text-muted-foreground block mb-0.5">{label}</label>
      <div className="flex items-center gap-2 rounded-xl border border-border/70 bg-card/80 pr-2">
        <input
          type={visible ? 'text' : 'password'}
          className="min-w-0 flex-1 bg-transparent px-3 py-2 text-xs font-mono outline-none"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
        />
        <button
          type="button"
          onClick={() => setVisible((v) => !v)}
          className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          title={visible ? 'Hide value' : 'Show value'}
        >
          {visible ? <EyeOffIcon className="h-3.5 w-3.5" /> : <EyeIcon className="h-3.5 w-3.5" />}
        </button>
      </div>
    </div>
  );
};

// ─── Provider Config Section ─────────────────────────────────────────────────

const ProviderConfigSection: FC<{
  prefix: string;
  config: MediaGenConfig;
  updateConfig: (path: string, value: unknown) => void;
  enableLabel: string;
  enabled: boolean;
  onEnableChange: (v: boolean) => void;
}> = ({ prefix, config, updateConfig, enableLabel, enabled, onEnableChange }) => {
  const provider: MediaProvider = config?.provider ?? 'azure';

  return (
    <fieldset className="rounded-lg border p-3 space-y-3">
      <legend className="text-xs font-semibold px-1">Provider</legend>

      <Toggle id={`${prefix}.enabled`} label={enableLabel} checked={enabled} onChange={onEnableChange} />

      {/* Provider Selector */}
      <div>
        <label className="text-[10px] text-muted-foreground block mb-0.5">Provider</label>
        <select
          className={settingsSelectClass}
          value={provider}
          onChange={(e) => updateConfig(`${prefix}.provider`, e.target.value)}
        >
          <option value="openai">OpenAI</option>
          <option value="azure">Azure OpenAI</option>
          <option value="custom">Custom</option>
        </select>
      </div>

      {/* OpenAI Configuration */}
      {provider === 'openai' && (
        <fieldset className="rounded-lg border p-3 space-y-3">
          <legend className="text-xs font-semibold px-1">OpenAI Configuration</legend>
          <PasswordField
            label="API Key"
            value={config?.openai?.apiKey ?? ''}
            onChange={(v) => updateConfig(`${prefix}.openai.apiKey`, v)}
            placeholder="sk-..."
          />
        </fieldset>
      )}

      {/* Azure Configuration */}
      {provider === 'azure' && (
        <fieldset className="rounded-lg border p-3 space-y-3">
          <legend className="text-xs font-semibold px-1">Azure OpenAI Configuration</legend>

          <div>
            <label className="text-[10px] text-muted-foreground block mb-0.5">Endpoint</label>
            <input
              type="text"
              className="w-full rounded-xl border border-border/70 bg-card/80 px-3 py-2 text-xs font-mono outline-none"
              value={config?.azure?.endpoint ?? ''}
              onChange={(e) => updateConfig(`${prefix}.azure.endpoint`, e.target.value || undefined)}
              placeholder="https://your-resource.openai.azure.com"
            />
            <span className="text-[10px] text-muted-foreground/60 mt-0.5 block">
              Your Azure OpenAI resource base URL.
            </span>
          </div>

          <PasswordField
            label="API Key"
            value={config?.azure?.apiKey ?? ''}
            onChange={(v) => updateConfig(`${prefix}.azure.apiKey`, v)}
            placeholder="Enter your Azure OpenAI API key"
          />

          <div>
            <label className="text-[10px] text-muted-foreground block mb-0.5">Deployment Name</label>
            <input
              type="text"
              className="w-full rounded-xl border border-border/70 bg-card/80 px-3 py-2 text-xs outline-none"
              value={config?.azure?.deploymentName ?? ''}
              onChange={(e) => updateConfig(`${prefix}.azure.deploymentName`, e.target.value)}
              placeholder={prefix.includes('image') ? 'gpt-image-2' : 'sora-2'}
            />
          </div>

          <div>
            <label className="text-[10px] text-muted-foreground block mb-0.5">API Version</label>
            <input
              type="text"
              className="w-full rounded-xl border border-border/70 bg-card/80 px-3 py-2 text-xs outline-none"
              value={config?.azure?.apiVersion ?? ''}
              onChange={(e) => updateConfig(`${prefix}.azure.apiVersion`, e.target.value)}
              placeholder="2024-02-15-preview"
            />
          </div>
        </fieldset>
      )}

      {/* Custom Configuration */}
      {provider === 'custom' && (
        <fieldset className="rounded-lg border p-3 space-y-3">
          <legend className="text-xs font-semibold px-1">Custom Provider Configuration</legend>

          <div>
            <label className="text-[10px] text-muted-foreground block mb-0.5">Base URL</label>
            <input
              type="text"
              className="w-full rounded-xl border border-border/70 bg-card/80 px-3 py-2 text-xs font-mono outline-none"
              value={config?.custom?.baseUrl ?? ''}
              onChange={(e) => updateConfig(`${prefix}.custom.baseUrl`, e.target.value || undefined)}
              placeholder="https://your-proxy.example.com/v1"
            />
            <span className="text-[10px] text-muted-foreground/60 mt-0.5 block">
              Your ai-gateway or proxy base URL. The generation API path will be appended automatically.
            </span>
          </div>

          <PasswordField
            label="API Key"
            value={config?.custom?.apiKey ?? ''}
            onChange={(v) => updateConfig(`${prefix}.custom.apiKey`, v)}
            placeholder="Enter your API key (optional)"
          />
        </fieldset>
      )}

      {/* Model */}
      <div>
        <label className="text-[10px] text-muted-foreground block mb-0.5">Model</label>
        <input
          type="text"
          className="w-full rounded-xl border border-border/70 bg-card/80 px-3 py-2 text-xs outline-none"
          value={config?.model ?? ''}
          onChange={(e) => updateConfig(`${prefix}.model`, e.target.value)}
          placeholder={prefix.includes('image') ? 'gpt-image-2' : 'sora-2'}
        />
      </div>
    </fieldset>
  );
};

// ─── Image Options ───────────────────────────────────────────────────────────

const ImageOptions: FC<{
  config: MediaGenConfig;
  updateConfig: (path: string, value: unknown) => void;
}> = ({ config, updateConfig }) => (
  <fieldset className="rounded-lg border p-3 space-y-3">
    <legend className="text-xs font-semibold px-1">Image Options</legend>

    <div className="grid grid-cols-2 gap-3">
      <div data-setting-id="imageGeneration.size">
        <label className="text-[10px] text-muted-foreground block mb-0.5">Size</label>
        <select
          className={settingsSelectClass}
          value={config?.size ?? '1024x1024'}
          onChange={(e) => updateConfig('imageGeneration.size', e.target.value)}
        >
          <option value="1024x1024">1024 x 1024</option>
          <option value="1536x1024">1536 x 1024 (landscape)</option>
          <option value="1024x1536">1024 x 1536 (portrait)</option>
          <option value="auto">Auto</option>
        </select>
      </div>

      <div data-setting-id="imageGeneration.quality">
        <label className="text-[10px] text-muted-foreground block mb-0.5">Quality</label>
        <select
          className={settingsSelectClass}
          value={config?.quality ?? 'auto'}
          onChange={(e) => updateConfig('imageGeneration.quality', e.target.value)}
        >
          <option value="auto">Auto</option>
          <option value="low">Low</option>
          <option value="medium">Medium</option>
          <option value="high">High</option>
        </select>
      </div>

      <div>
        <label className="text-[10px] text-muted-foreground block mb-0.5">Output Format</label>
        <select
          className={settingsSelectClass}
          value={config?.outputFormat ?? 'png'}
          onChange={(e) => updateConfig('imageGeneration.outputFormat', e.target.value)}
        >
          <option value="png">PNG</option>
          <option value="jpeg">JPEG</option>
          <option value="webp">WebP</option>
        </select>
      </div>

      <NumberField
        label="Timeout (ms)"
        value={config?.timeout ?? 300000}
        onChange={(v) => updateConfig('imageGeneration.timeout', v)}
        min={5000}
      />
    </div>
  </fieldset>
);

// ─── Video Options ───────────────────────────────────────────────────────────

const VideoOptions: FC<{
  config: MediaGenConfig;
  updateConfig: (path: string, value: unknown) => void;
}> = ({ config, updateConfig }) => (
  <fieldset className="rounded-lg border p-3 space-y-3">
    <legend className="text-xs font-semibold px-1">Video Options</legend>

    <div className="grid grid-cols-2 gap-3">
      <div>
        <label className="text-[10px] text-muted-foreground block mb-0.5">Size</label>
        <select
          className={settingsSelectClass}
          value={config?.size ?? '1280x720'}
          onChange={(e) => updateConfig('videoGeneration.size', e.target.value)}
        >
          <option value="1280x720">1280 x 720 (landscape)</option>
          <option value="720x1280">720 x 1280 (portrait)</option>
          <option value="1792x1024">1792 x 1024 (wide)</option>
          <option value="1024x1792">1024 x 1792 (tall)</option>
        </select>
      </div>

      <div data-setting-id="videoGeneration.duration">
        <label className="text-[10px] text-muted-foreground block mb-0.5">Duration</label>
        <select
          className={settingsSelectClass}
          value={config?.duration ?? '4'}
          onChange={(e) => updateConfig('videoGeneration.duration', e.target.value)}
        >
          <option value="4">4 seconds</option>
          <option value="8">8 seconds</option>
          <option value="12">12 seconds</option>
        </select>
      </div>

      <NumberField
        label="Timeout (ms)"
        value={config?.timeout ?? 300000}
        onChange={(v) => updateConfig('videoGeneration.timeout', v)}
        min={5000}
      />
    </div>
  </fieldset>
);

// ─── Main Component ──────────────────────────────────────────────────────────

const tabs: Array<{ key: MediaTab; label: string }> = [
  { key: 'image', label: 'Image' },
  { key: 'video', label: 'Video' },
];

const configKeys: Record<MediaTab, string> = {
  image: 'imageGeneration',
  video: 'videoGeneration',
};

export const MediaGenerationSettings: FC<SettingsProps> = ({ config, updateConfig, focusTab, focusNonce }) => {
  const [activeTab, setActiveTab] = useState<MediaTab>('image');

  useEffect(() => {
    if (focusTab) setActiveTab(focusTab as MediaTab);
  }, [focusTab, focusNonce]);

  const prefix = configKeys[activeTab];
  const mediaConfig = (config as Record<string, unknown>)[prefix] as MediaGenConfig | undefined;
  const enabled = mediaConfig?.enabled ?? false;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h3 className="text-sm font-semibold">Media Generation</h3>
        <p className="text-xs text-muted-foreground mt-1">Configure AI-powered image and video generation.</p>
      </div>

      {/* Tab Bar */}
      <div className="flex gap-1 border-b border-border/60">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setActiveTab(t.key)}
            className={`px-3 py-1.5 text-xs font-medium rounded-t-lg transition-colors ${
              activeTab === t.key
                ? 'bg-card border border-b-0 border-border/60 text-foreground'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Provider Config (includes enable toggle) */}
      <ProviderConfigSection
        prefix={prefix}
        config={mediaConfig ?? {}}
        updateConfig={updateConfig}
        enableLabel={`Enable ${activeTab} generation`}
        enabled={enabled}
        onEnableChange={(v) => updateConfig(`${prefix}.enabled`, v)}
      />

      {/* Type-specific options */}
      {activeTab === 'image' && <ImageOptions config={mediaConfig ?? {}} updateConfig={updateConfig} />}
      {activeTab === 'video' && <VideoOptions config={mediaConfig ?? {}} updateConfig={updateConfig} />}
    </div>
  );
};
