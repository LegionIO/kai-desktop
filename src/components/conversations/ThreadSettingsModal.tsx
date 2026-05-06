import { useState, useEffect, useRef, useCallback, type FC } from 'react';
import { createPortal } from 'react-dom';
import { XIcon, RotateCcwIcon } from 'lucide-react';
import { app } from '@/lib/ipc-client';
import { useConfig } from '@/providers/ConfigProvider';
import type { ConversationRecord, ReasoningEffort } from '@/providers/RuntimeProvider';

type CatalogModel = {
  key: string;
  displayName: string;
};

type ProfileEntry = {
  key: string;
  name: string;
  primaryModelKey: string;
};

type RuntimeInfo = { id: string; name: string; available: boolean; reason?: string };

type Props = {
  open: boolean;
  conversationId: string | null;
  onClose: () => void;
  isActiveConversation: boolean;
};

type ThreadSettings = {
  selectedModelKey: string | null;
  selectedProfileKey: string | null;
  fallbackEnabled: boolean;
  reasoningEffort: ReasoningEffort | null;
  executionMode: 'auto' | 'plan-first' | null;
  temperature: number | null;
  systemPromptOverride: string | null;
  maxSteps: number | null;
  maxRetries: number | null;
  runtimeOverride: string | null;
  currentWorkingDirectory: string | null;
};

const selectClass = 'w-full rounded-xl border border-border/70 bg-card/80 px-3 py-2 text-xs outline-none';

export const ThreadSettingsModal: FC<Props> = ({ open, conversationId, onClose, isActiveConversation }) => {
  const { config } = useConfig();
  const [settings, setSettings] = useState<ThreadSettings | null>(null);
  const [runtimes, setRuntimes] = useState<RuntimeInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const promptTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const promptFocusedRef = useRef(false);
  const [promptDraft, setPromptDraft] = useState('');

  // Load conversation settings
  useEffect(() => {
    if (!open || !conversationId) {
      setSettings(null);
      setLoading(true);
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        const conv = await app.conversations.get(conversationId) as ConversationRecord | null;
        if (cancelled || !conv) return;
        const s: ThreadSettings = {
          selectedModelKey: conv.selectedModelKey ?? null,
          selectedProfileKey: conv.selectedProfileKey ?? null,
          fallbackEnabled: conv.fallbackEnabled ?? false,
          reasoningEffort: conv.reasoningEffort ?? null,
          executionMode: conv.executionMode ?? null,
          temperature: conv.temperature ?? null,
          systemPromptOverride: conv.systemPromptOverride ?? null,
          maxSteps: conv.maxSteps ?? null,
          maxRetries: conv.maxRetries ?? null,
          runtimeOverride: conv.runtimeOverride ?? null,
          currentWorkingDirectory: conv.currentWorkingDirectory ?? null,
        };
        setSettings(s);
        setPromptDraft(s.systemPromptOverride ?? '');
        setLoading(false);
      } catch {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [open, conversationId]);

  // Keep modal in sync if composer changes settings for the active conversation
  // while the modal is open (e.g., user changes model via the title bar dropdown).
  useEffect(() => {
    if (!open || !isActiveConversation) return;
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as Record<string, unknown> & { conversationId: string };
      if (detail.conversationId !== conversationId) return;
      setSettings((prev) => prev ? { ...prev, ...detail } as ThreadSettings : prev);
    };
    window.addEventListener('thread-settings-changed', handler);
    return () => window.removeEventListener('thread-settings-changed', handler);
  }, [open, isActiveConversation, conversationId]);

  // Load available runtimes
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    app.agent.getAvailableRuntimes()
      .then((list: RuntimeInfo[]) => { if (!cancelled) setRuntimes(list); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [open]);

  // Persist a setting change
  const persistSetting = useCallback(async (field: string, value: unknown) => {
    if (!conversationId) return;
    try {
      const conv = await app.conversations.get(conversationId) as ConversationRecord | null;
      if (!conv) return;
      await app.conversations.put({
        ...conv,
        [field]: value,
        updatedAt: new Date().toISOString(),
      } as ConversationRecord);
    } catch {
      // Persist failed silently
    }
  }, [conversationId]);

  // Update local state + persist + notify active conversation
  const updateSetting = useCallback(<K extends keyof ThreadSettings>(field: K, value: ThreadSettings[K]) => {
    setSettings((prev) => prev ? { ...prev, [field]: value } : prev);

    // Map field names to ConversationRecord field names
    void persistSetting(field, value);

    // Notify App.tsx if this is the active conversation
    if (isActiveConversation && conversationId) {
      window.dispatchEvent(new CustomEvent('thread-settings-changed', {
        detail: { conversationId, [field]: value },
      }));
    }
  }, [conversationId, isActiveConversation, persistSetting]);

  // System prompt debounced flush
  const flushPrompt = useCallback((value: string) => {
    if (promptTimerRef.current) clearTimeout(promptTimerRef.current);
    promptTimerRef.current = null;
    const trimmed = value.trim() || null;
    updateSetting('systemPromptOverride', trimmed);
  }, [updateSetting]);

  const handlePromptChange = (value: string) => {
    setPromptDraft(value);
    if (promptTimerRef.current) clearTimeout(promptTimerRef.current);
    promptTimerRef.current = setTimeout(() => flushPrompt(value), 600);
  };

  if (!open || !conversationId) return null;

  const models = ((config?.models as { catalog?: CatalogModel[] })?.catalog ?? []) as CatalogModel[];
  const profiles = (config?.profiles as ProfileEntry[] | undefined) ?? [];
  const globalTemp = (config?.advanced as { temperature?: number } | undefined)?.temperature ?? 0.7;
  const globalMaxSteps = (config?.advanced as { maxSteps?: number } | undefined)?.maxSteps ?? 10;
  const globalMaxRetries = (config?.advanced as { maxRetries?: number } | undefined)?.maxRetries ?? 2;
  const defaultProfileKey = config?.defaultProfileKey as string | undefined;
  const globalExecutionMode = (config as { executionMode?: string } | undefined)?.executionMode ?? 'auto';
  const globalRuntime = ((config as { agent?: { runtime?: string } } | undefined)?.agent?.runtime) ?? 'auto';

  // Determine effective defaults from the active profile (if one is selected)
  const activeProfileKey = settings?.selectedProfileKey ?? defaultProfileKey;
  const activeProfile = activeProfileKey ? profiles.find((p) => p.key === activeProfileKey) : undefined;
  const effectiveTemp = (activeProfile as { temperature?: number } | undefined)?.temperature ?? globalTemp;
  const effectiveReasoningEffort = (activeProfile as { reasoningEffort?: string } | undefined)?.reasoningEffort ?? 'medium';

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      onClick={onClose}
      onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
      role="dialog"
      tabIndex={-1}
    >
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
      <div
        className="relative flex max-h-[70vh] w-full max-w-[520px] flex-col overflow-hidden rounded-2xl border border-border/50 bg-popover/95 shadow-2xl backdrop-blur-xl mx-4"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border/50 px-5 py-3.5">
          <h2 className="text-sm font-semibold">Thread Settings</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-muted-foreground hover:bg-muted/70 hover:text-foreground transition-colors"
          >
            <XIcon className="h-4 w-4" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-6">
          {loading || !settings ? (
            <div className="flex items-center justify-center py-8">
              <p className="text-xs text-muted-foreground">Loading...</p>
            </div>
          ) : (
            <>
              {/* ── Model & Routing ─────────────────────────────── */}
              <fieldset className="space-y-3">
                <legend className="text-xs font-semibold text-foreground">Model & Routing</legend>

                {/* Profile */}
                <div>
                  <div className="flex items-center justify-between mb-0.5">
                    <label className="text-[10px] text-muted-foreground">Profile</label>
                    {settings.selectedProfileKey !== null && (
                      <button
                        type="button"
                        onClick={() => updateSetting('selectedProfileKey', null)}
                        className="text-[10px] text-muted-foreground hover:text-foreground flex items-center gap-0.5"
                        title="Reset to default"
                      >
                        <RotateCcwIcon className="h-2.5 w-2.5" /> Reset
                      </button>
                    )}
                  </div>
                  <select
                    className={selectClass}
                    value={settings.selectedProfileKey ?? ''}
                    onChange={(e) => {
                      const val = e.target.value;
                      const key = val || null;
                      updateSetting('selectedProfileKey', key);
                      // When selecting a profile, set its primary model and enable fallback
                      if (key && key !== '__none__') {
                        const profile = profiles.find((p) => p.key === key);
                        if (profile) {
                          updateSetting('selectedModelKey', profile.primaryModelKey);
                          updateSetting('fallbackEnabled', true);
                        }
                      } else {
                        updateSetting('selectedModelKey', null);
                        updateSetting('fallbackEnabled', false);
                      }
                    }}
                  >
                    <option value="">Default{defaultProfileKey ? ` (${profiles.find((p) => p.key === defaultProfileKey)?.name ?? defaultProfileKey})` : ''}</option>
                    <option value="__none__">None (no profile)</option>
                    {profiles.map((p) => (
                      <option key={p.key} value={p.key}>{p.name}</option>
                    ))}
                  </select>
                </div>

                {/* Model */}
                <div>
                  <div className="flex items-center justify-between mb-0.5">
                    <label className="text-[10px] text-muted-foreground">Model</label>
                    {settings.selectedModelKey !== null && (
                      <button
                        type="button"
                        onClick={() => updateSetting('selectedModelKey', null)}
                        className="text-[10px] text-muted-foreground hover:text-foreground flex items-center gap-0.5"
                        title="Reset to default"
                      >
                        <RotateCcwIcon className="h-2.5 w-2.5" /> Reset
                      </button>
                    )}
                  </div>
                  <select
                    className={selectClass}
                    value={settings.selectedModelKey ?? ''}
                    onChange={(e) => updateSetting('selectedModelKey', e.target.value || null)}
                  >
                    <option value="">Default (from profile)</option>
                    {models.map((m) => (
                      <option key={m.key} value={m.key}>{m.displayName}</option>
                    ))}
                  </select>
                </div>

                {/* Runtime */}
                <div>
                  <div className="flex items-center justify-between mb-0.5">
                    <label className="text-[10px] text-muted-foreground">Runtime</label>
                    {settings.runtimeOverride !== null && (
                      <button
                        type="button"
                        onClick={() => updateSetting('runtimeOverride', null)}
                        className="text-[10px] text-muted-foreground hover:text-foreground flex items-center gap-0.5"
                        title="Reset to default"
                      >
                        <RotateCcwIcon className="h-2.5 w-2.5" /> Reset
                      </button>
                    )}
                  </div>
                  <select
                    className={selectClass}
                    value={settings.runtimeOverride ?? ''}
                    onChange={(e) => updateSetting('runtimeOverride', e.target.value || null)}
                  >
                    <option value="">Default ({globalRuntime})</option>
                    <option value="auto">Auto (prefer external if available)</option>
                    {runtimes.map((r) => (
                      <option key={r.id} value={r.id} disabled={!r.available}>
                        {r.name}{!r.available ? ' (unavailable)' : ''}
                      </option>
                    ))}
                  </select>
                </div>

                {/* Fallback */}
                <label className="flex cursor-pointer items-center gap-2 rounded-xl border border-border/60 bg-card/60 px-3 py-2">
                  <input
                    type="checkbox"
                    checked={settings.fallbackEnabled}
                    onChange={(e) => updateSetting('fallbackEnabled', e.target.checked)}
                    className="rounded"
                  />
                  <span className="text-xs">Enable model fallback</span>
                </label>
              </fieldset>

              {/* ── Parameters ──────────────────────────────────── */}
              <fieldset className="space-y-3">
                <legend className="text-xs font-semibold text-foreground">Parameters</legend>

                {/* Temperature */}
                <div>
                  <div className="flex items-center justify-between mb-0.5">
                    <label className="text-[10px] text-muted-foreground">
                      Temperature: {settings.temperature !== null ? settings.temperature.toFixed(2) : `Default (${effectiveTemp})`}
                    </label>
                    {settings.temperature !== null && (
                      <button
                        type="button"
                        onClick={() => updateSetting('temperature', null)}
                        className="text-[10px] text-muted-foreground hover:text-foreground flex items-center gap-0.5"
                        title="Reset to default"
                      >
                        <RotateCcwIcon className="h-2.5 w-2.5" /> Reset
                      </button>
                    )}
                  </div>
                  <input
                    type="range"
                    className="w-full accent-[var(--color-primary)]"
                    min={0}
                    max={2}
                    step={0.05}
                    value={settings.temperature ?? effectiveTemp}
                    onChange={(e) => updateSetting('temperature', Number(e.target.value))}
                  />
                  <div className="flex justify-between text-[9px] text-muted-foreground/60 mt-0.5">
                    <span>Precise</span>
                    <span>Creative</span>
                  </div>
                </div>

                {/* Reasoning Effort */}
                <div>
                  <div className="flex items-center justify-between mb-0.5">
                    <label className="text-[10px] text-muted-foreground">Reasoning Effort</label>
                    {settings.reasoningEffort !== null && (
                      <button
                        type="button"
                        onClick={() => updateSetting('reasoningEffort', null)}
                        className="text-[10px] text-muted-foreground hover:text-foreground flex items-center gap-0.5"
                        title="Reset to default"
                      >
                        <RotateCcwIcon className="h-2.5 w-2.5" /> Reset
                      </button>
                    )}
                  </div>
                  <select
                    className={selectClass}
                    value={settings.reasoningEffort ?? ''}
                    onChange={(e) => updateSetting('reasoningEffort', (e.target.value || null) as ReasoningEffort | null)}
                  >
                    <option value="">Default ({effectiveReasoningEffort})</option>
                    <option value="low">Low</option>
                    <option value="medium">Medium</option>
                    <option value="high">High</option>
                    <option value="xhigh">Extra High</option>
                  </select>
                </div>

                {/* Execution Mode */}
                <div>
                  <div className="flex items-center justify-between mb-0.5">
                    <label className="text-[10px] text-muted-foreground">Execution Mode</label>
                    {settings.executionMode !== null && (
                      <button
                        type="button"
                        onClick={() => updateSetting('executionMode', null)}
                        className="text-[10px] text-muted-foreground hover:text-foreground flex items-center gap-0.5"
                        title="Reset to default"
                      >
                        <RotateCcwIcon className="h-2.5 w-2.5" /> Reset
                      </button>
                    )}
                  </div>
                  <select
                    className={selectClass}
                    value={settings.executionMode ?? ''}
                    onChange={(e) => updateSetting('executionMode', (e.target.value || null) as 'auto' | 'plan-first' | null)}
                  >
                    <option value="">Default ({globalExecutionMode})</option>
                    <option value="auto">Auto</option>
                    <option value="plan-first">Plan First</option>
                  </select>
                </div>

                {/* Max Steps */}
                <div>
                  <div className="flex items-center justify-between mb-0.5">
                    <label className="text-[10px] text-muted-foreground">Max Steps</label>
                    {settings.maxSteps !== null && (
                      <button
                        type="button"
                        onClick={() => updateSetting('maxSteps', null)}
                        className="text-[10px] text-muted-foreground hover:text-foreground flex items-center gap-0.5"
                        title="Reset to default"
                      >
                        <RotateCcwIcon className="h-2.5 w-2.5" /> Reset
                      </button>
                    )}
                  </div>
                  <input
                    type="number"
                    className="w-full rounded-xl border border-border/70 bg-card/80 px-3 py-2 text-xs outline-none"
                    value={settings.maxSteps ?? ''}
                    placeholder={`Default (${globalMaxSteps})`}
                    min={1}
                    max={100}
                    onChange={(e) => {
                      const val = e.target.value ? Number(e.target.value) : null;
                      updateSetting('maxSteps', val && val >= 1 && val <= 100 ? val : null);
                    }}
                  />
                  <span className="text-[9px] text-muted-foreground/60 mt-0.5 block">
                    Maximum tool-call loops per turn (1–100)
                  </span>
                </div>

                {/* Max Retries */}
                <div>
                  <div className="flex items-center justify-between mb-0.5">
                    <label className="text-[10px] text-muted-foreground">Max Retries</label>
                    {settings.maxRetries !== null && (
                      <button
                        type="button"
                        onClick={() => updateSetting('maxRetries', null)}
                        className="text-[10px] text-muted-foreground hover:text-foreground flex items-center gap-0.5"
                        title="Reset to default"
                      >
                        <RotateCcwIcon className="h-2.5 w-2.5" /> Reset
                      </button>
                    )}
                  </div>
                  <input
                    type="number"
                    className="w-full rounded-xl border border-border/70 bg-card/80 px-3 py-2 text-xs outline-none"
                    value={settings.maxRetries ?? ''}
                    placeholder={`Default (${globalMaxRetries})`}
                    min={0}
                    max={10}
                    onChange={(e) => {
                      const val = e.target.value ? Number(e.target.value) : null;
                      updateSetting('maxRetries', val !== null && val >= 0 && val <= 10 ? val : null);
                    }}
                  />
                </div>
              </fieldset>

              {/* ── System Prompt ───────────────────────────────── */}
              <fieldset className="space-y-3">
                <div className="flex items-center justify-between">
                  <legend className="text-xs font-semibold text-foreground">System Prompt Override</legend>
                  {settings.systemPromptOverride !== null && (
                    <button
                      type="button"
                      onClick={() => {
                        updateSetting('systemPromptOverride', null);
                        setPromptDraft('');
                      }}
                      className="text-[10px] text-muted-foreground hover:text-foreground flex items-center gap-0.5"
                      title="Reset to default"
                    >
                      <RotateCcwIcon className="h-2.5 w-2.5" /> Reset
                    </button>
                  )}
                </div>
                <textarea
                  className="h-[120px] w-full resize-none overflow-y-auto rounded-xl border border-border/70 bg-card/80 p-3 text-xs font-mono outline-none focus:ring-1 focus:ring-ring"
                  value={promptDraft}
                  onFocus={() => { promptFocusedRef.current = true; }}
                  onBlur={() => { promptFocusedRef.current = false; flushPrompt(promptDraft); }}
                  onChange={(e) => handlePromptChange(e.target.value)}
                  placeholder="Leave empty to use the profile/global system prompt..."
                />
                <span className="text-[9px] text-muted-foreground/60 block">
                  Overrides the profile and global system prompt for this thread only.
                </span>
              </fieldset>

              {/* ── Working Directory ──────────────────────────── */}
              <fieldset className="space-y-3">
                <legend className="text-xs font-semibold text-foreground">Working Directory</legend>
                <div className="flex gap-2">
                  <input
                    type="text"
                    className="flex-1 rounded-xl border border-border/70 bg-card/80 px-3 py-2 text-xs font-mono outline-none"
                    value={settings.currentWorkingDirectory ?? ''}
                    placeholder="Default (app directory)"
                    onChange={(e) => updateSetting('currentWorkingDirectory', e.target.value || null)}
                  />
                  <button
                    type="button"
                    className="shrink-0 rounded-xl border border-border/70 bg-card/80 px-3 py-2 text-xs text-muted-foreground hover:text-foreground hover:bg-muted/70 transition-colors"
                    onClick={async () => {
                      try {
                        const result = await app.dialog.openDirectory();
                        if (!result.canceled && result.directoryPath) {
                          updateSetting('currentWorkingDirectory', result.directoryPath);
                        }
                      } catch {
                        // User cancelled
                      }
                    }}
                  >
                    Browse
                  </button>
                </div>
                {settings.currentWorkingDirectory !== null && (
                  <button
                    type="button"
                    onClick={() => updateSetting('currentWorkingDirectory', null)}
                    className="text-[10px] text-muted-foreground hover:text-foreground flex items-center gap-0.5"
                    title="Reset to default"
                  >
                    <RotateCcwIcon className="h-2.5 w-2.5" /> Reset to default
                  </button>
                )}
              </fieldset>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
};
