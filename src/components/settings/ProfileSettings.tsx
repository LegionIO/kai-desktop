import { useState, type FC } from 'react';
import { PlusIcon, Trash2Icon, PencilIcon, XIcon, CheckIcon, CopyIcon } from 'lucide-react';
import { EditableInput } from '@/components/EditableInput';
import { EditableTextarea } from '@/components/EditableTextarea';
import { Toggle, SliderField, settingsSelectClass, type SettingsProps } from './shared';
import { SortableList } from './shared/SortableList';
import { cn } from '@/lib/utils';

type ProfileEntry = {
  key: string;
  name: string;
  primaryModelKey: string;
  fallbackModelKeys: string[];
  systemPrompt?: string;
  temperature?: number;
  maxSteps?: number;
  maxRetries?: number;
  useResponsesApi?: boolean;
  reasoningEffort?: string;
};

type CatalogModel = {
  key: string;
  displayName: string;
};

export const ProfileSettings: FC<SettingsProps & { embedded?: boolean }> = ({ config, updateConfig, embedded }) => {
  const profiles = (config.profiles as ProfileEntry[] | undefined) ?? [];
  const models = ((config.models as { catalog?: CatalogModel[] })?.catalog ?? []) as CatalogModel[];
  const defaultProfileKey = config.defaultProfileKey as string | undefined;

  const [editIndex, setEditIndex] = useState<number | null>(null);
  const [showAdd, setShowAdd] = useState(false);

  const updateProfiles = (next: ProfileEntry[]) => updateConfig('profiles', next);
  const addProfile = (p: ProfileEntry) => updateProfiles([...profiles, p]);
  const updateProfile = (i: number, p: ProfileEntry) => {
    const next = [...profiles];
    next[i] = p;
    updateProfiles(next);
    // Keep defaultModelKey in sync when the default profile's primary model changes
    if (defaultProfileKey === p.key) {
      void updateConfig('models.defaultModelKey', p.primaryModelKey);
    }
  };
  const deleteProfile = (i: number) => {
    const deleted = profiles[i];
    const next = profiles.filter((_, idx) => idx !== i);
    updateProfiles(next);
    if (deleted && defaultProfileKey === deleted.key) {
      // Deleted the default profile — fall back to the first remaining profile
      const fallbackProfile = next[0];
      if (fallbackProfile) {
        void updateConfig('defaultProfileKey', fallbackProfile.key);
        void updateConfig('models.defaultModelKey', fallbackProfile.primaryModelKey);
      } else {
        void updateConfig('defaultProfileKey', undefined);
      }
    }
  };

  /**
   * Profile keys are identity: `defaultProfileKey` and each conversation's
   * `selectedProfileKey` reference them, and resolution is a `.find()` by key
   * (electron/agent/model-catalog.ts). A duplicate key would silently shadow the
   * original, so derive a free one.
   */
  const uniqueProfileKey = (base: string): string => {
    const taken = new Set(profiles.map((p) => p.key));
    if (!taken.has(base)) return base;
    let i = 2;
    while (taken.has(`${base}-${i}`)) i++;
    return `${base}-${i}`;
  };

  /**
   * Clone a profile, inserted directly AFTER its source so the copy appears where the
   * user is looking. Everything is copied except the key (must be unique) and the name
   * (suffixed so the two are distinguishable in the picker). Deliberately does NOT
   * become the default profile — cloning is a starting point for edits, and silently
   * repointing the default would change which model new chats use.
   */
  const duplicateProfile = (i: number) => {
    const source = profiles[i];
    if (!source) return;
    const copy: ProfileEntry = {
      ...source,
      key: uniqueProfileKey(`${source.key}-copy`),
      name: `${source.name} copy`,
      // Fresh array so later edits to the copy's chain can't alias the source's.
      fallbackModelKeys: [...source.fallbackModelKeys],
    };
    const next = [...profiles];
    next.splice(i + 1, 0, copy);
    updateProfiles(next);
  };

  /** When the user picks a new default profile, sync defaultModelKey to match */
  const handleDefaultProfileChange = (newKey: string) => {
    void updateConfig('defaultProfileKey', newKey || undefined);
    const profile = profiles.find((p) => p.key === newKey);
    if (profile) {
      void updateConfig('models.defaultModelKey', profile.primaryModelKey);
    }
  };

  return (
    <div className="space-y-6">
      {!embedded && (
        <>
          <h3 className="text-sm font-semibold">Profiles</h3>
          <p className="text-xs text-muted-foreground">
            Profiles bundle a primary model, fallback chain, system prompt, and LLM parameters into named presets.
            Select a profile per-conversation in the composer area.
          </p>
        </>
      )}

      {/* Default profile selector */}
      <fieldset data-setting-id="profiles" className="rounded-lg border p-3 space-y-3">
        <legend className="text-xs font-semibold px-1">Default Profile</legend>
        <div>
          <label className="text-[10px] text-muted-foreground block mb-0.5">Active profile for new conversations</label>
          <select
            className={settingsSelectClass}
            value={defaultProfileKey ?? ''}
            onChange={(e) => handleDefaultProfileChange(e.target.value)}
          >
            {profiles.map((p) => (
              <option key={p.key} value={p.key}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
      </fieldset>

      {/* Profile list */}
      <fieldset data-setting-id="profile.maxSteps" className="rounded-lg border p-3 space-y-3">
        <legend className="text-xs font-semibold px-1">Profile List</legend>
        <div className="space-y-1.5">
          {profiles.map((profile, i) =>
            editIndex === i ? (
              <ProfileForm
                key={`edit-${i}`}
                initial={profile}
                models={models}
                onSave={(p) => {
                  updateProfile(i, p);
                  setEditIndex(null);
                }}
                onCancel={() => setEditIndex(null)}
                submitLabel="Save"
              />
            ) : (
              <ProfileCard
                key={profile.key}
                profile={profile}
                models={models}
                onEdit={() => setEditIndex(i)}
                onDuplicate={() => duplicateProfile(i)}
                onDelete={() => deleteProfile(i)}
              />
            ),
          )}
        </div>

        {showAdd ? (
          <ProfileForm
            initial={{ key: '', name: '', primaryModelKey: models[0]?.key ?? '', fallbackModelKeys: [] }}
            models={models}
            onSave={(p) => {
              addProfile(p);
              setShowAdd(false);
            }}
            onCancel={() => setShowAdd(false)}
            submitLabel="Add Profile"
          />
        ) : (
          <button
            type="button"
            onClick={() => setShowAdd(true)}
            className="flex items-center gap-1.5 rounded-lg border border-dashed px-3 py-2 text-xs text-muted-foreground hover:bg-muted/50 transition-colors w-full"
          >
            <PlusIcon className="h-3.5 w-3.5" />
            Add Profile
          </button>
        )}
      </fieldset>
    </div>
  );
};

const ProfileCard: FC<{
  profile: ProfileEntry;
  models: CatalogModel[];
  onEdit: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}> = ({ profile, models, onEdit, onDuplicate, onDelete }) => {
  const primaryModel = models.find((m) => m.key === profile.primaryModelKey);
  const fallbackCount = profile.fallbackModelKeys.length;
  // A profile bundles a primary model, an ordered fallback chain, a system prompt and
  // tuning params — all hand-entered and unrecoverable. Confirm inline (same pattern as
  // ProviderRow in ModelSettings) rather than deleting on a single click next to Edit.
  const [confirmDelete, setConfirmDelete] = useState(false);

  return (
    <div className="flex items-center gap-2 rounded-lg border px-3 py-2">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium truncate">{profile.name}</span>
          <span className="text-[10px] text-muted-foreground bg-muted rounded px-1.5 py-0.5 shrink-0">
            {primaryModel?.displayName ?? profile.primaryModelKey}
          </span>
        </div>
        <div className="text-[10px] text-muted-foreground mt-0.5 flex items-center gap-2">
          <span className="font-mono">{profile.key}</span>
          {fallbackCount > 0 && (
            <span>
              {fallbackCount} fallback{fallbackCount > 1 ? 's' : ''}
            </span>
          )}
          {profile.temperature !== undefined && <span>temp {profile.temperature}</span>}
          {profile.systemPrompt && <span>custom prompt</span>}
        </div>
      </div>
      {confirmDelete ? (
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] text-muted-foreground">Delete?</span>
          <button
            type="button"
            onClick={onDelete}
            className="rounded bg-destructive/10 px-2 py-1 text-[10px] font-medium text-destructive transition-colors hover:bg-destructive/20"
          >
            Delete
          </button>
          <button
            type="button"
            onClick={() => setConfirmDelete(false)}
            className="rounded p-1 transition-colors hover:bg-muted"
            title="Cancel"
          >
            <XIcon className="h-3.5 w-3.5 text-muted-foreground" />
          </button>
        </div>
      ) : (
        <>
          <button type="button" onClick={onEdit} className="p-1 rounded hover:bg-muted transition-colors" title="Edit">
            <PencilIcon className="h-3.5 w-3.5 text-muted-foreground" />
          </button>
          <button
            type="button"
            onClick={onDuplicate}
            className="p-1 rounded hover:bg-muted transition-colors"
            title="Duplicate"
          >
            <CopyIcon className="h-3.5 w-3.5 text-muted-foreground" />
          </button>
          <button
            type="button"
            onClick={() => setConfirmDelete(true)}
            className="p-1 rounded hover:bg-destructive/10 transition-colors"
            title="Delete"
          >
            <Trash2Icon className="h-3.5 w-3.5 text-muted-foreground" />
          </button>
        </>
      )}
    </div>
  );
};

const ProfileForm: FC<{
  initial: ProfileEntry;
  models: CatalogModel[];
  onSave: (entry: ProfileEntry) => void;
  onCancel: () => void;
  submitLabel: string;
}> = ({ initial, models, onSave, onCancel, submitLabel }) => {
  const [key, setKey] = useState(initial.key);
  const [name, setName] = useState(initial.name);
  const [chain, setChain] = useState<string[]>(() => buildInitialChain(initial));
  const [systemPrompt, setSystemPrompt] = useState(initial.systemPrompt ?? '');
  const [temperature, setTemperature] = useState<number | undefined>(initial.temperature);
  const [maxSteps, setMaxSteps] = useState<number | undefined>(initial.maxSteps);
  const [maxRetries, setMaxRetries] = useState<number | undefined>(initial.maxRetries);
  const [useResponsesApi, setUseResponsesApi] = useState(initial.useResponsesApi ?? false);
  const [reasoningEffort, setReasoningEffort] = useState(initial.reasoningEffort ?? '');
  const [showAdvanced, setShowAdvanced] = useState(false);

  const canSave = key.trim() && name.trim() && chain.length > 0;

  const handleNameChange = (v: string) => {
    const wasAuto = !initial.key || key === toKey(initial.name);
    setName(v);
    if (wasAuto) setKey(toKey(v));
  };

  const handleSave = () => {
    if (!canSave) return;
    const entry: ProfileEntry = {
      key: key.trim(),
      name: name.trim(),
      primaryModelKey: chain[0]!,
      fallbackModelKeys: chain.slice(1),
    };
    if (systemPrompt.trim()) entry.systemPrompt = systemPrompt.trim();
    if (temperature !== undefined) entry.temperature = temperature;
    if (maxSteps !== undefined) entry.maxSteps = maxSteps;
    if (maxRetries !== undefined) entry.maxRetries = maxRetries;
    if (useResponsesApi) entry.useResponsesApi = true;
    if (reasoningEffort) entry.reasoningEffort = reasoningEffort;
    onSave(entry);
  };

  const addToChain = (modelKey: string) => {
    if (chain.includes(modelKey)) return;
    setChain([...chain, modelKey]);
  };

  const removeFromChain = (modelKey: string) => {
    if (chain.length <= 1) return; // never allow an empty chain — see canSave
    setChain(chain.filter((k) => k !== modelKey));
  };

  const availableToAdd = models.filter((m) => !chain.includes(m.key));

  return (
    <div className="rounded-lg border bg-card p-3 space-y-3">
      {/* Name + Key */}
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="text-[10px] text-muted-foreground block mb-0.5">Profile Name</label>
          <EditableInput
            className="w-full rounded border bg-background px-2 py-1 text-xs"
            value={name}
            onChange={handleNameChange}
            placeholder="Fast Coding"
          />
        </div>
        <div>
          <label className="text-[10px] text-muted-foreground block mb-0.5">Key (unique ID)</label>
          <EditableInput
            className="w-full rounded border bg-background px-2 py-1 text-xs font-mono"
            value={key}
            onChange={setKey}
            placeholder="fast-coding"
          />
        </div>
      </div>

      {/* Model chain */}
      <div>
        <label className="text-[10px] text-muted-foreground block mb-0.5">Model chain</label>

        <div className="rounded-lg border bg-background/50 p-1">
          <SortableList
            items={chain}
            onReorder={setChain}
            ariaLabel="model chain"
            getItemLabel={(modelKey) => models.find((m) => m.key === modelKey)?.displayName ?? modelKey}
            itemClassName="relative flex items-center gap-1.5 px-2 py-1.5"
            renderLeading={(index) => (
              <div className="relative flex w-3 shrink-0 flex-col items-center justify-center self-stretch">
                {/* Spine: one continuous hairline through the stack, clipped to
                    the vertical center on the first/last row so it starts and
                    ends at the dot rather than the row's edge. Percentage-based
                    (top-1/2 / bottom-1/2), so it holds regardless of row height
                    — including a row that wraps to two lines. */}
                {chain.length > 1 && (
                  <div
                    className={cn(
                      'absolute left-1/2 w-px -translate-x-1/2 bg-border',
                      index === 0 && 'top-1/2 bottom-0',
                      index === chain.length - 1 && 'top-0 bottom-1/2',
                      index > 0 && index < chain.length - 1 && 'top-0 bottom-0',
                    )}
                  />
                )}
                <div
                  className={cn(
                    'z-10 h-1.5 w-1.5 shrink-0 rounded-full',
                    index === 0 ? 'bg-primary' : 'border border-border bg-background',
                  )}
                />
              </div>
            )}
            renderItem={(modelKey, index) => {
              const model = models.find((m) => m.key === modelKey);
              return (
                <>
                  <span className="text-xs flex-1 truncate">{model?.displayName ?? modelKey}</span>
                  {index === 0 && (
                    <span
                      key="primary-pill"
                      className="motion-reduce:animate-none animate-in fade-in-0 zoom-in-95 rounded-full bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium text-primary shrink-0"
                    >
                      Primary
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={() => removeFromChain(modelKey)}
                    disabled={chain.length === 1}
                    className="p-0.5 rounded hover:bg-destructive/10 disabled:opacity-30 disabled:hover:bg-transparent transition-colors shrink-0"
                    title={chain.length === 1 ? 'A profile needs at least one model' : 'Remove'}
                    aria-label={`Remove ${model?.displayName ?? modelKey} from chain`}
                  >
                    <XIcon className="h-3 w-3 text-muted-foreground" />
                  </button>
                </>
              );
            }}
          />
        </div>

        {availableToAdd.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mt-1.5">
            {availableToAdd.map((m) => (
              <button
                key={m.key}
                type="button"
                onClick={() => addToChain(m.key)}
                className="rounded-lg border border-dashed px-2 py-1 text-[10px] text-muted-foreground hover:bg-muted/50 transition-colors"
              >
                + {m.displayName}
              </button>
            ))}
          </div>
        )}

        <p className="text-[10px] text-muted-foreground mt-1.5">
          Drag to reorder. The top model runs; the rest are tried in order if it fails.
        </p>
      </div>

      {/* System Prompt */}
      <div>
        <label className="text-[10px] text-muted-foreground block mb-0.5">System Prompt Override</label>
        <EditableTextarea
          className="w-full h-[80px] rounded border bg-background p-2 text-xs font-mono overflow-y-auto outline-none focus:ring-1 focus:ring-ring"
          value={systemPrompt}
          onChange={setSystemPrompt}
          placeholder="Leave blank to use global system prompt"
        />
      </div>

      {/* Advanced toggle */}
      <button
        type="button"
        onClick={() => setShowAdvanced(!showAdvanced)}
        className="text-[10px] text-primary hover:underline"
      >
        {showAdvanced ? 'Hide advanced parameters' : 'Show advanced parameters'}
      </button>

      {showAdvanced && (
        <div className="space-y-2 border-t pt-2">
          {/* Temperature */}
          <div>
            <SliderField
              label={`Temperature: ${temperature ?? 'inherit global'}`}
              value={temperature ?? 0.4}
              min={0}
              max={2}
              step={0.1}
              onChange={(v) => setTemperature(v)}
            />
            <button
              type="button"
              onClick={() => setTemperature(undefined)}
              className="text-[10px] text-muted-foreground hover:underline"
            >
              Reset to inherit
            </button>
          </div>

          {/* Max Steps */}
          <div>
            <label className="text-[10px] text-muted-foreground block mb-0.5">Max Steps</label>
            <input
              type="number"
              className="w-full rounded border bg-background px-2 py-1 text-xs outline-none"
              value={maxSteps ?? ''}
              onChange={(e) => setMaxSteps(e.target.value ? Number(e.target.value) : undefined)}
              placeholder="Inherit global"
              min={1}
              max={50}
            />
          </div>

          {/* Max Retries */}
          <div>
            <label className="text-[10px] text-muted-foreground block mb-0.5">Max Retries</label>
            <input
              type="number"
              className="w-full rounded border bg-background px-2 py-1 text-xs outline-none"
              value={maxRetries ?? ''}
              onChange={(e) => setMaxRetries(e.target.value ? Number(e.target.value) : undefined)}
              placeholder="Inherit global"
              min={0}
              max={10}
            />
          </div>

          {/* Reasoning Effort */}
          <div>
            <label className="text-[10px] text-muted-foreground block mb-0.5">Default Reasoning Effort</label>
            <select
              className={settingsSelectClass.replace('bg-card/80', 'bg-background')}
              value={reasoningEffort}
              onChange={(e) => setReasoningEffort(e.target.value)}
            >
              <option value="">Inherit (medium)</option>
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
              <option value="xhigh">Extra High</option>
            </select>
          </div>

          {/* Use Responses API */}
          <Toggle label="Use Responses API" checked={useResponsesApi} onChange={setUseResponsesApi} />
        </div>
      )}

      {/* Actions */}
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
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Builds the initial `chain` state (primary + fallbacks) for the model-chain
 * list. Filters out empty/duplicate keys so a malformed config (e.g. a
 * fallback that duplicates the primary, or a blank key from hand-edited
 * config.json) can't produce a broken row in the reorderable list.
 */
function buildInitialChain(profile: Pick<ProfileEntry, 'primaryModelKey' | 'fallbackModelKeys'>): string[] {
  const seen = new Set<string>();
  const chain: string[] = [];
  for (const key of [profile.primaryModelKey, ...profile.fallbackModelKeys]) {
    if (!key || seen.has(key)) continue;
    seen.add(key);
    chain.push(key);
  }
  return chain;
}

