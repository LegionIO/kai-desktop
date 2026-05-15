import { useState, useEffect, useRef, type FC } from 'react';
import { PlusIcon, Trash2Icon, PencilIcon, XIcon, CheckIcon, EyeIcon, EyeOffIcon } from 'lucide-react';
import { EditableInput } from '@/components/EditableInput';
import { formatModelDisplayName } from '@/lib/model-display';
import { Toggle, settingsSelectClass, type SettingsProps } from './shared';
import { ProfileSettings } from './ProfileSettings';
import { RuntimeSettings } from './RuntimeSettings';
import { MastraRuntimeSettings } from './MastraRuntimeSettings';

export type Provider = {
  type: string;
  enabled?: boolean;
  endpoint?: string;
  apiKey?: string;
  useResponsesApi?: boolean;
  apiVersion?: string;
  region?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
  awsProfile?: string;
  roleArn?: string;
  useDefaultCredentials?: boolean;
};

type CatalogEntry = {
  key: string;
  displayName: string;
  provider: string;
  modelName: string;
  deploymentName?: string;
  maxInputTokens?: number;
  useResponsesApi?: boolean;
  computerUseSupport?: 'openai-responses' | 'anthropic-client-tool' | 'gemini-computer-use' | 'custom' | 'none';
  visionCapable?: boolean;
  preferredTarget?: 'isolated-browser' | 'local-macos';
};

type ModelTab = 'profiles' | 'runtimes' | 'providers' | 'catalog' | 'prompts';

export const ModelSettings: FC<SettingsProps> = ({ config, updateConfig }) => {
  const [activeTab, setActiveTab] = useState<ModelTab>('profiles');

  const tabs: Array<{ key: ModelTab; label: string }> = [
    { key: 'profiles', label: 'Profiles' },
    { key: 'runtimes', label: 'Runtimes' },
    { key: 'providers', label: 'Providers' },
    { key: 'catalog', label: 'Catalog' },
    { key: 'prompts', label: 'Prompts' },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-sm font-semibold">Models</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Configure model profiles, agent runtimes, API providers, and the model catalog.
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
      {activeTab === 'profiles' && <ProfileSettings config={config} updateConfig={updateConfig} embedded />}
      {activeTab === 'runtimes' && (
        <div className="space-y-6">
          <RuntimeSettings config={config} updateConfig={updateConfig} embedded />
          <MastraRuntimeSettings config={config} updateConfig={updateConfig} />
        </div>
      )}
      {activeTab === 'providers' && <ProvidersContent config={config} updateConfig={updateConfig} />}
      {activeTab === 'catalog' && <CatalogContent config={config} updateConfig={updateConfig} />}
      {activeTab === 'prompts' && <PromptsContent config={config} updateConfig={updateConfig} />}
    </div>
  );
};

/* ── Providers Content ── */

const ProvidersContent: FC<SettingsProps> = ({ config, updateConfig }) => {
  const models = config.models as { providers: Record<string, Provider> };

  return (
    <div className="space-y-3">
      {Object.entries(models.providers).map(([key, provider]) => (
        <ProviderCard key={key} name={key} provider={provider} updateConfig={updateConfig} />
      ))}
    </div>
  );
};

/* ── Catalog Content ── */

const CatalogContent: FC<SettingsProps> = ({ config, updateConfig }) => {
  const models = config.models as {
    providers: Record<string, Provider>;
    catalog: CatalogEntry[];
  };

  const providerKeys = Object.keys(models.providers);

  const updateCatalog = (newCatalog: CatalogEntry[]) => updateConfig('models.catalog', newCatalog);

  const addModel = (entry: CatalogEntry) => {
    updateCatalog([...models.catalog, entry]);
  };

  const updateModel = (index: number, entry: CatalogEntry) => {
    const next = [...models.catalog];
    next[index] = entry;
    updateCatalog(next);
  };

  const deleteModel = (index: number) => {
    updateCatalog(models.catalog.filter((_, i) => i !== index));
  };

  return (
    <ModelCatalog
      catalog={models.catalog}
      providerKeys={providerKeys}
      providers={models.providers}
      onAdd={addModel}
      onUpdate={updateModel}
      onDelete={deleteModel}
    />
  );
};

/* ── Prompts Content ── */

type PromptKey = 'chat' | 'plan' | 'taskPlan' | 'computerUse' | 'realtimeInstructions';

const DEFAULT_CHAT_PROMPT = 'You are Kai, a powerful local AI assistant with access to the user\'s computer. You can execute shell commands, read/write files, search codebases, and connect to external services via MCP. Be proactive, thorough, and helpful. When executing tools, explain what you\'re doing and why.';

const DEFAULT_PLAN_PROMPT = 'You are a thorough planning assistant. Explore the codebase, understand the architecture, and create detailed implementation plans. Use only read-only tools to investigate. Ask the user to clarify requirements or preferences you cannot resolve from code alone. When your plan is ready, call exit_plan_mode with the full plan as markdown.';

const DEFAULT_COMPUTER_USE_PROMPT = 'You are an autopilot assistant controlling the computer on behalf of the user. Plan actions carefully, prefer navigation when URLs are obvious, and only mark a goal complete when the current screen confirms the final state.';

// Note: this string is duplicated from electron/agent/prompts.ts (TASK_PLAN_SYSTEM_PROMPT).
// Renderer code cannot import from Node/Electron modules — keep in sync manually.
const DEFAULT_TASK_PLAN_PROMPT = `You are a task planning assistant. When a user describes work they want done, create a structured task plan.

Write the plan as clear, actionable markdown with this structure:

## Objective
One sentence summarizing the goal.

## Steps
1. First step — specific and actionable
2. Second step — with enough detail to execute
3. Continue as needed...

## Acceptance Criteria
- [ ] Criterion 1
- [ ] Criterion 2

## Notes
Any additional context, risks, or dependencies.

Rules:
- Be specific and actionable, not vague
- Include technical details where relevant
- Use markdown checkboxes for criteria
- Keep the plan concise but complete
- When the user sends follow-up messages, regenerate the FULL plan incorporating their feedback
- Always output the complete updated plan, never just a diff or partial update`;

const promptFields: Array<{ key: PromptKey; label: string; placeholder: string; configPath: string }> = [
  { key: 'chat', label: 'New Chat', placeholder: DEFAULT_CHAT_PROMPT, configPath: 'systemPrompt' },
  { key: 'realtimeInstructions', label: 'Voice Chat', placeholder: 'You are a helpful assistant. Respond concisely and naturally in conversation.', configPath: 'realtime.instructions' },
  { key: 'plan', label: 'Create Plan', placeholder: DEFAULT_PLAN_PROMPT, configPath: 'systemPrompts.plan' },
  { key: 'taskPlan', label: 'Create Task', placeholder: DEFAULT_TASK_PLAN_PROMPT, configPath: 'systemPrompts.taskPlan' },
  { key: 'computerUse', label: 'Computer Use', placeholder: DEFAULT_COMPUTER_USE_PROMPT, configPath: 'systemPrompts.computerUse' },
];

const PromptsContent: FC<SettingsProps> = ({ config, updateConfig }) => {
  const configPrompt = (config as { systemPrompt?: string }).systemPrompt ?? '';
  const configPrompts = (config as { systemPrompts?: Partial<Record<string, string>> }).systemPrompts ?? {};
  const realtimeInstructions = ((config as Record<string, unknown>).realtime as { instructions?: string } | undefined)?.instructions ?? '';

  return (
    <div className="space-y-4">
      {promptFields.map((field) => {
        let value: string;
        if (field.key === 'chat') {
          value = configPrompts.chat?.trim() ? configPrompts.chat : configPrompt;
        } else if (field.key === 'realtimeInstructions') {
          value = realtimeInstructions;
        } else {
          value = configPrompts[field.key] ?? '';
        }

        return (
          <PromptFieldset
            key={field.key}
            label={field.label}
            value={value}
            placeholder={field.placeholder}
            onChange={(v) => {
              if (field.key === 'chat') {
                void updateConfig('systemPrompt', v);
                void updateConfig('systemPrompts.chat', v);
              } else {
                void updateConfig(field.configPath, v);
              }
            }}
          />
        );
      })}
    </div>
  );
};

const PromptFieldset: FC<{
  label: string;
  value: string;
  placeholder: string;
  onChange: (value: string) => void;
}> = ({ label, value, placeholder, onChange }) => {
  const [draft, setDraft] = useState(value);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isFocusedRef = useRef(false);

  useEffect(() => {
    if (!isFocusedRef.current) setDraft(value);
  }, [value]);

  const flush = (v: string) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    if (v !== value) onChange(v);
  };

  const handleChange = (v: string) => {
    setDraft(v);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => flush(v), 800);
  };

  return (
    <fieldset className="rounded-lg border p-3 space-y-3">
      <legend className="text-xs font-semibold px-1">{label}</legend>
      <textarea
        className="w-full rounded-xl border border-border/70 bg-card/80 px-3 py-2 text-xs font-mono outline-none min-h-[100px] resize-y"
        value={draft}
        onFocus={() => { isFocusedRef.current = true; }}
        onBlur={() => { isFocusedRef.current = false; flush(draft); }}
        onChange={(e) => handleChange(e.target.value)}
        placeholder={placeholder}
        rows={5}
      />
    </fieldset>
  );
};

/* ── Model Catalog ── */

const ModelCatalog: FC<{
  catalog: CatalogEntry[];
  providerKeys: string[];
  providers: Record<string, Provider>;
  onAdd: (entry: CatalogEntry) => void;
  onUpdate: (index: number, entry: CatalogEntry) => void;
  onDelete: (index: number) => void;
}> = ({ catalog, providerKeys, providers, onAdd, onUpdate, onDelete }) => {
  const [showAdd, setShowAdd] = useState(false);
  const [editIndex, setEditIndex] = useState<number | null>(null);

  return (
    <div className="space-y-2">
      <div className="space-y-1.5">
        {catalog.map((m, i) =>
          editIndex === i ? (
            <ModelForm
              key={`edit-${i}`}
              initial={m}
              providerKeys={providerKeys}
              providers={providers}
              onSave={(entry) => { onUpdate(i, entry); setEditIndex(null); }}
              onCancel={() => setEditIndex(null)}
              submitLabel="Save"
            />
          ) : (
            <div key={m.key} className="flex items-center gap-2 rounded-lg border px-3 py-2">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium truncate">{formatModelDisplayName(m.displayName)}</span>
                  <span className="text-[10px] text-muted-foreground bg-muted rounded px-1.5 py-0.5 shrink-0">{m.provider}</span>
                  {m.computerUseSupport && m.computerUseSupport !== 'none' && (
                    <span className="text-[10px] text-primary bg-primary/10 rounded px-1.5 py-0.5 shrink-0">Autopilot</span>
                  )}
                </div>
                <div className="text-[10px] text-muted-foreground font-mono truncate mt-0.5">
                  {m.modelName}
                  {m.maxInputTokens ? ` · ${Math.round(m.maxInputTokens / 1000)}k ctx` : ''}
                </div>
              </div>
              <button type="button" onClick={() => setEditIndex(i)} className="p-1 rounded hover:bg-muted transition-colors" title="Edit">
                <PencilIcon className="h-3.5 w-3.5 text-muted-foreground" />
              </button>
              <button type="button" onClick={() => onDelete(i)} className="p-1 rounded hover:bg-destructive/10 transition-colors" title="Delete">
                <Trash2Icon className="h-3.5 w-3.5 text-muted-foreground" />
              </button>
            </div>
          ),
        )}
      </div>

      {showAdd ? (
        <ModelForm
          initial={{ key: '', displayName: '', provider: providerKeys[0] ?? '', modelName: '' }}
          providerKeys={providerKeys}
          providers={providers}
          onSave={(entry) => { onAdd(entry); setShowAdd(false); }}
          onCancel={() => setShowAdd(false)}
          submitLabel="Add Model"
        />
      ) : (
        <button
          type="button"
          onClick={() => setShowAdd(true)}
          className="flex items-center gap-1.5 rounded-lg border border-dashed px-3 py-2 text-xs text-muted-foreground hover:bg-muted/50 transition-colors w-full"
        >
          <PlusIcon className="h-3.5 w-3.5" />
          Add Model
        </button>
      )}
    </div>
  );
};

const ModelForm: FC<{
  initial: CatalogEntry;
  providerKeys: string[];
  providers: Record<string, Provider>;
  onSave: (entry: CatalogEntry) => void;
  onCancel: () => void;
  submitLabel: string;
}> = ({ initial, providerKeys, providers, onSave, onCancel, submitLabel }) => {
  const [key, setKey] = useState(initial.key);
  const [displayName, setDisplayName] = useState(initial.displayName);
  const [provider, setProvider] = useState(initial.provider);
  const [modelName, setModelName] = useState(initial.modelName);
  const [deploymentName, setDeploymentName] = useState(initial.deploymentName ?? '');
  const [maxInputTokens, setMaxInputTokens] = useState(initial.maxInputTokens?.toString() ?? '');
  const [useResponsesApi, setUseResponsesApi] = useState(initial.useResponsesApi ?? false);
  const [computerUseSupport, setComputerUseSupport] = useState(initial.computerUseSupport ?? 'none');
  const [visionCapable, setVisionCapable] = useState(initial.visionCapable ?? false);
  const [preferredTarget, setPreferredTarget] = useState(initial.preferredTarget ?? 'isolated-browser');

  const selectedProvider = providers[provider];

  const canSave = key.trim() && displayName.trim() && provider && modelName.trim();

  const handleSave = () => {
    if (!canSave) return;
    const entry: CatalogEntry = {
      key: key.trim(),
      displayName: displayName.trim(),
      provider,
      modelName: modelName.trim(),
    };
    if (deploymentName.trim()) entry.deploymentName = deploymentName.trim();
    if (maxInputTokens) entry.maxInputTokens = Number(maxInputTokens);
    if (selectedProvider?.type === 'openai-compatible') {
      if (computerUseSupport === 'openai-responses' || useResponsesApi) {
        entry.useResponsesApi = true;
      }
    }
    entry.computerUseSupport = computerUseSupport;
    entry.visionCapable = visionCapable;
    entry.preferredTarget = preferredTarget;
    onSave(entry);
  };

  // Auto-generate key from display name if key is empty or matches previous auto
  const handleDisplayNameChange = (v: string) => {
    const wasAuto = !initial.key || key === toKey(initial.displayName);
    setDisplayName(v);
    if (wasAuto) setKey(toKey(v));
  };

  return (
    <div className="rounded-lg border bg-card p-3 space-y-2">
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="text-[10px] text-muted-foreground block mb-0.5">Display Name</label>
          <EditableInput
            className="w-full rounded border bg-background px-2 py-1 text-xs"
            value={displayName}
            onChange={handleDisplayNameChange}
            placeholder="GPT-5.4"
          />
        </div>
        <div>
          <label className="text-[10px] text-muted-foreground block mb-0.5">Key (unique ID)</label>
          <EditableInput
            className="w-full rounded border bg-background px-2 py-1 text-xs font-mono"
            value={key}
            onChange={setKey}
            placeholder="gpt-5.4"
          />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="text-[10px] text-muted-foreground block mb-0.5">Provider</label>
          <select
            className={settingsSelectClass.replace('bg-card/80', 'bg-background')}
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
          >
            {providerKeys.map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="text-[10px] text-muted-foreground block mb-0.5">Model Name / ID</label>
          <EditableInput
            className="w-full rounded border bg-background px-2 py-1 text-xs font-mono"
            value={modelName}
            onChange={setModelName}
            placeholder="gpt-5.4"
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="text-[10px] text-muted-foreground block mb-0.5">Deployment Name (optional)</label>
          <EditableInput
            className="w-full rounded border bg-background px-2 py-1 text-xs font-mono"
            value={deploymentName}
            onChange={setDeploymentName}
            placeholder="Same as model name if blank"
          />
        </div>
        <div>
          <label className="text-[10px] text-muted-foreground block mb-0.5">Max Input Tokens</label>
          <input
            type="number"
            className="w-full rounded border bg-background px-2 py-1 text-xs outline-none"
            value={maxInputTokens}
            onChange={(e) => setMaxInputTokens(e.target.value)}
            placeholder="128000"
            min={1}
          />
        </div>
      </div>

      {selectedProvider?.type === 'openai-compatible' && (
        <Toggle label="Force Responses API For This Model" checked={useResponsesApi} onChange={setUseResponsesApi} />
      )}

      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="text-[10px] text-muted-foreground block mb-0.5">Autopilot Support</label>
          <select
            className={settingsSelectClass.replace('bg-card/80', 'bg-background')}
            value={computerUseSupport}
            onChange={(e) => setComputerUseSupport((e.target.value || 'none') as NonNullable<CatalogEntry['computerUseSupport']>)}
          >
            <option value="none">None</option>
            <option value="openai-responses">OpenAI Responses</option>
            <option value="anthropic-client-tool">Anthropic client tool</option>
            <option value="gemini-computer-use">Gemini computer use</option>
            <option value="custom">Custom</option>
          </select>
        </div>
        <div>
          <label className="text-[10px] text-muted-foreground block mb-0.5">Preferred Target</label>
          <select
            className={settingsSelectClass.replace('bg-card/80', 'bg-background')}
            value={preferredTarget}
            onChange={(e) => setPreferredTarget((e.target.value || 'isolated-browser') as NonNullable<CatalogEntry['preferredTarget']>)}
          >
            <option value="isolated-browser">Isolated Browser</option>
            <option value="local-macos">Local Mac</option>
          </select>
        </div>
      </div>

      <Toggle label="Vision Capable" checked={visionCapable} onChange={setVisionCapable} />

      <div className="flex items-center gap-2 pt-1">
        <button
          type="button"
          onClick={handleSave}
          disabled={!canSave}
          className="flex items-center gap-1 rounded-md bg-primary text-primary-foreground px-3 py-1 text-xs font-medium disabled:opacity-40 transition-colors hover:bg-primary/90"
        >
          <CheckIcon className="h-3 w-3" />
          {submitLabel}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="flex items-center gap-1 rounded-md bg-muted px-3 py-1 text-xs hover:bg-muted/80 transition-colors"
        >
          <XIcon className="h-3 w-3" />
          Cancel
        </button>
      </div>
    </div>
  );
};

function toKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function getProviderTypeLabel(type: string): string {
  return type === 'openai-compatible' ? 'openai' : type;
}

const PasswordField: FC<{
  label: string;
  value: string;
  onChange: (value: string) => Promise<void>;
  placeholder?: string;
}> = ({ label, value, onChange, placeholder }) => {
  const [visible, setVisible] = useState(false);

  return (
    <div>
      <label className="text-[10px] text-muted-foreground block mb-0.5">{label}</label>
      <div className="flex items-center gap-2 rounded border bg-card pr-2">
        <EditableInput
          type={visible ? 'text' : 'password'}
          className="min-w-0 flex-1 bg-transparent px-2 py-1 text-xs font-mono"
          value={value}
          onChange={onChange}
          placeholder={placeholder}
        />
        <button
          type="button"
          onClick={() => setVisible((current) => !current)}
          className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          title={visible ? 'Hide value' : 'Show value'}
          aria-label={visible ? `Hide ${label}` : `Show ${label}`}
        >
          {visible ? <EyeOffIcon className="h-3.5 w-3.5" /> : <EyeIcon className="h-3.5 w-3.5" />}
        </button>
      </div>
    </div>
  );
};

/* ── Provider Cards ── */

const ProviderCard: FC<{
  name: string;
  provider: Provider;
  updateConfig: (path: string, value: unknown) => Promise<void>;
}> = ({ name, provider, updateConfig }) => {
  const prefix = `models.providers.${name}`;
  const isBedrock = provider.type === 'amazon-bedrock';
  const isOllama = name === 'ollama';
  const isOpenAICompatible = provider.type === 'openai-compatible' && !isOllama;

  return (
    <fieldset className="rounded-lg border p-3 space-y-3">
      <legend className="text-xs font-semibold px-1">
        {name} <span className="font-normal text-muted-foreground">[{getProviderTypeLabel(provider.type)}]</span>
      </legend>

      <Toggle
        label="Enabled"
        checked={provider.enabled !== false}
        onChange={(v) => updateConfig(`${prefix}.enabled`, v)}
      />

      {provider.endpoint !== undefined && (
        <div>
          <label className="text-[10px] text-muted-foreground block mb-0.5">
            {isOllama ? 'Base URL' : 'Endpoint'}
          </label>
          <EditableInput
            className="w-full rounded border bg-card px-2 py-1 text-xs font-mono"
            value={provider.endpoint ?? ''}
            onChange={(v) => updateConfig(`${prefix}.endpoint`, v)}
            placeholder={isOllama ? 'http://localhost:11434' : 'https://api.openai.com/v1'}
          />
        </div>
      )}

      {isOpenAICompatible && (
        <Toggle
          label="Use Responses API By Default"
          checked={provider.useResponsesApi ?? false}
          onChange={(v) => updateConfig(`${prefix}.useResponsesApi`, v)}
        />
      )}

      {!isOllama && provider.apiKey !== undefined && (
        <PasswordField
          label="API Key"
          value={provider.apiKey}
          onChange={(v) => updateConfig(`${prefix}.apiKey`, v)}
        />
      )}

      {isBedrock && (
        <BedrockCredentials prefix={prefix} provider={provider} updateConfig={updateConfig} />
      )}
    </fieldset>
  );
};

const BedrockCredentials: FC<{
  prefix: string;
  provider: Provider;
  updateConfig: (path: string, value: unknown) => Promise<void>;
}> = ({ prefix, provider, updateConfig }) => {
  const useDefault = provider.useDefaultCredentials !== false;
  const hasProfile = Boolean(provider.awsProfile?.trim());
  const hasKeys = Boolean(provider.accessKeyId?.trim() && provider.secretAccessKey?.trim());
  const hasRoleArn = Boolean(provider.roleArn?.trim());
  const hasAnyCreds = hasProfile || hasKeys || hasRoleArn;

  return (
    <>
      <div>
        <label className="text-[10px] text-muted-foreground block mb-0.5">Region</label>
        <EditableInput
          className="w-full rounded border bg-card px-2 py-1 text-xs font-mono"
          value={provider.region ?? ''}
          onChange={(v) => updateConfig(`${prefix}.region`, v)}
          placeholder="us-east-1"
        />
      </div>

      <Toggle
        label="Use default AWS credential chain (env vars, ~/.aws/credentials, instance role)"
        checked={useDefault}
        onChange={(v) => updateConfig(`${prefix}.useDefaultCredentials`, v)}
      />

      {useDefault ? (
        <p className="text-[10px] text-muted-foreground bg-muted/50 rounded px-2 py-1">
          Credentials resolved automatically via AWS_PROFILE, environment variables, shared credentials file, or instance metadata.
        </p>
      ) : (
        <fieldset className="rounded-md border p-2 space-y-2">
          <legend className="text-[10px] font-semibold px-1">AWS Credentials</legend>

          {!hasAnyCreds && (
            <p className="text-[10px] text-amber-600 dark:text-amber-400">
              Provide at least one: an AWS profile, access key + secret, or a role ARN.
            </p>
          )}

          <div>
            <label className="text-[10px] text-muted-foreground block mb-0.5">AWS Profile</label>
            <EditableInput
              className="w-full rounded border bg-card px-2 py-1 text-xs font-mono"
              value={provider.awsProfile ?? ''}
              onChange={(v) => updateConfig(`${prefix}.awsProfile`, v)}
              placeholder="default"
            />
          </div>
          <PasswordField
            label="Access Key ID"
            value={provider.accessKeyId ?? ''}
            onChange={(v) => updateConfig(`${prefix}.accessKeyId`, v)}
          />
          <PasswordField
            label="Secret Access Key"
            value={provider.secretAccessKey ?? ''}
            onChange={(v) => updateConfig(`${prefix}.secretAccessKey`, v)}
          />
          <PasswordField
            label="Session Token"
            value={provider.sessionToken ?? ''}
            onChange={(v) => updateConfig(`${prefix}.sessionToken`, v)}
          />
          <div>
            <label className="text-[10px] text-muted-foreground block mb-0.5">Role ARN (STS AssumeRole)</label>
            <EditableInput
              className="w-full rounded border bg-card px-2 py-1 text-xs font-mono"
              value={provider.roleArn ?? ''}
              onChange={(v) => updateConfig(`${prefix}.roleArn`, v)}
              placeholder="arn:aws:iam::123456789:role/my-role"
            />
          </div>
        </fieldset>
      )}
    </>
  );
};
