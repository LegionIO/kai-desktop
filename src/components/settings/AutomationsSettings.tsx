import { useEffect, useMemo, useState, type FC } from 'react';
import {
  PlusIcon,
  Trash2Icon,
  ChevronDownIcon,
  ChevronRightIcon,
  PlayIcon,
  CheckCircle2Icon,
  AlertCircleIcon,
  MinusCircleIcon,
  MessageSquareIcon,
} from 'lucide-react';
import { app, type AutomationRunRecord, type AutomationSourceCatalogEntry } from '@/lib/ipc-client';
import { flattenJsonSchema } from '@/lib/schema-paths';
import { generateId } from '@/lib/utils';
import { NumberField, settingsSelectClass, TextField, Toggle, type SettingsProps } from './shared';

type ConditionOp =
  | 'equals'
  | 'notEquals'
  | 'contains'
  | 'startsWith'
  | 'endsWith'
  | 'matches'
  | 'in'
  | 'exists'
  | 'expression';

type Condition = { path: string; op: ConditionOp; value?: unknown; caseSensitive: boolean };

type ConversationTarget =
  | { type: 'per-invocation' }
  | { type: 'singleton' }
  | { type: 'existing'; conversationId: string };

type Action =
  | {
      type: 'agent';
      mode: 'background' | 'conversation';
      prompt: string;
      modelKey?: string;
      profileKey?: string;
      tools: boolean;
      conversationTitle?: string;
      conversationTarget?: ConversationTarget;
      includeHistory?: boolean;
    }
  | { type: 'plugin-action'; pluginName: string; targetId: string; action: string; data?: Record<string, unknown> }
  | { type: 'tool'; toolName: string; input: Record<string, unknown> }
  | { type: 'notification'; title: string; body?: string }
  | { type: 'emit'; source: string; event: string; payload?: Record<string, unknown> }
  | { type: 'runHookCommand'; command: string; mode: 'observe' | 'block' | 'modify'; matcher?: string };

type Rule = {
  id: string;
  name: string;
  enabled: boolean;
  trigger: { source: string; event: string };
  conditions: Condition[];
  conditionMode: 'all' | 'any';
  actions: Action[];
  debounceMs: number;
  rateLimitPerMinute?: number;
};

type AutomationApprovalMode = 'auto-allow' | 'prompt-user' | 'block';

type AutomationsConfig = {
  enabled: boolean;
  rules: Rule[];
  log: { maxEntries: number };
  approvalMode?: AutomationApprovalMode;
};

const APPROVAL_MODES: Array<{ value: AutomationApprovalMode; label: string; hint: string }> = [
  { value: 'auto-allow', label: 'Auto-allow', hint: 'The agent may create/enable these rules with no prompt.' },
  { value: 'prompt-user', label: 'Prompt me', hint: 'Ask for approval each time the agent tries.' },
  { value: 'block', label: 'Block', hint: 'The agent can never create/enable these rules.' },
];

const CONDITION_OPS: Array<{ value: ConditionOp; label: string }> = [
  { value: 'equals', label: 'equals' },
  { value: 'notEquals', label: 'not equals' },
  { value: 'contains', label: 'contains' },
  { value: 'startsWith', label: 'starts with' },
  { value: 'endsWith', label: 'ends with' },
  { value: 'matches', label: 'matches (regex)' },
  { value: 'in', label: 'in (comma list)' },
  { value: 'exists', label: 'exists' },
  { value: 'expression', label: 'JS expression' },
];

const ACTION_TYPES: Array<{ value: Action['type']; label: string }> = [
  { value: 'agent', label: 'Run AI agent' },
  { value: 'plugin-action', label: 'Call plugin action' },
  { value: 'tool', label: 'Run tool' },
  { value: 'notification', label: 'Show notification' },
  { value: 'emit', label: 'Emit event' },
  { value: 'runHookCommand', label: 'Run hook command' },
];

function newRule(): Rule {
  return {
    id: generateId(),
    name: 'New automation',
    // Start disabled so editing the rule (which itself writes config and would
    // otherwise match an app:config-changed trigger) can't fire half-built actions.
    enabled: false,
    trigger: { source: '', event: '' },
    conditions: [],
    conditionMode: 'all',
    actions: [{ type: 'notification', title: 'Automation fired', body: '{{payload}}' }],
    debounceMs: 0,
  };
}

function newAction(type: Action['type']): Action {
  switch (type) {
    case 'agent':
      return {
        type,
        mode: 'background',
        prompt: '',
        tools: true,
        conversationTarget: { type: 'per-invocation' },
        includeHistory: true,
      };
    case 'plugin-action':
      return { type, pluginName: '', targetId: '', action: 'automation' };
    case 'tool':
      return { type, toolName: '', input: {} };
    case 'notification':
      return { type, title: '' };
    case 'emit':
      return { type, source: '', event: '' };
    case 'runHookCommand':
      return { type, command: '', mode: 'observe' };
  }
}

export const AutomationsSettings: FC<SettingsProps & { onOpenConversation?: (id: string) => void }> = ({
  config,
  updateConfig,
  onOpenConversation,
}) => {
  const automations = ((config as { automations?: AutomationsConfig }).automations ?? {
    enabled: true,
    rules: [],
    log: { maxEntries: 200 },
    approvalMode: 'prompt-user',
  }) as AutomationsConfig;
  const approvalMode: AutomationApprovalMode = automations.approvalMode ?? 'prompt-user';

  const [catalog, setCatalog] = useState<AutomationSourceCatalogEntry[]>([]);
  const [runLog, setRunLog] = useState<AutomationRunRecord[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  useEffect(() => {
    let alive = true;
    const load = () => {
      void app.automations.catalog().then((c) => alive && setCatalog(c));
    };
    load();
    void app.automations.log().then((l) => alive && setRunLog(l));
    const offCatalog = app.automations.onCatalogChanged(load);
    const offRun = app.automations.onRun((r) => setRunLog((prev) => [r, ...prev].slice(0, automations.log.maxEntries)));
    return () => {
      alive = false;
      offCatalog();
      offRun();
    };
  }, [automations.log.maxEntries]);

  const setRules = (rules: Rule[]) => updateConfig('automations.rules', rules);
  const patchRule = (id: string, patch: Partial<Rule>) =>
    setRules(automations.rules.map((r) => (r.id === id ? { ...r, ...patch } : r)));

  const lastRunByRule = useMemo(() => {
    const m = new Map<string, AutomationRunRecord>();
    for (const r of runLog) if (!m.has(r.ruleId)) m.set(r.ruleId, r);
    return m;
  }, [runLog]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">Automations</h3>
        <div className="flex items-center gap-2">
          <Toggle
            id="automations.enabled"
            label="Enabled"
            checked={automations.enabled}
            onChange={(v) => updateConfig('automations.enabled', v)}
          />
          <button
            type="button"
            onClick={() => {
              const rule = newRule();
              void setRules([...automations.rules, rule]);
              setExpanded((s) => new Set(s).add(rule.id));
            }}
            className="inline-flex items-center gap-1 rounded-xl border border-border/70 bg-card/80 px-3 py-2 text-xs hover:bg-muted/80"
          >
            <PlusIcon className="h-3 w-3" /> New rule
          </button>
        </div>
      </div>

      <p className="text-xs text-muted-foreground">
        React to events from the app or plugins. When a trigger fires and its conditions match, the actions run in
        order. Use <code className="font-mono">{'{{payload.field}}'}</code> and{' '}
        <code className="font-mono">{'{{result[0].text}}'}</code> in action fields to reference event data and previous
        results.
      </p>

      <div className="space-y-2 rounded-xl border border-border/60 bg-card/50 p-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-xs font-medium">Agent approval for hook &amp; shell rules</div>
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              Controls what happens when the AI agent tries to create, enable, or test a rule that observes lifecycle
              hook events (raw prompts &amp; tool payloads) or runs a shell command. Does not affect rules you configure
              here yourself.
            </p>
          </div>
          <select
            aria-label="Agent approval mode"
            className={settingsSelectClass}
            value={approvalMode}
            onChange={(e) => updateConfig('automations.approvalMode', e.target.value as AutomationApprovalMode)}
          >
            {APPROVAL_MODES.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
        </div>
        <p className="text-[11px] text-muted-foreground">
          {APPROVAL_MODES.find((m) => m.value === approvalMode)?.hint}
        </p>
      </div>

      {automations.rules.length === 0 && <p className="text-xs text-muted-foreground">No rules configured.</p>}

      <div data-setting-id="automations.rules" className="space-y-2">
        {automations.rules.map((rule) => {
          const isOpen = expanded.has(rule.id);
          const last = lastRunByRule.get(rule.id);
          return (
            <div key={rule.id} className="rounded-lg border border-border/70 bg-card/50">
              <div className="flex items-center gap-2 px-3 py-2">
                <button
                  type="button"
                  onClick={() =>
                    setExpanded((s) => {
                      const n = new Set(s);
                      if (n.has(rule.id)) n.delete(rule.id);
                      else n.add(rule.id);
                      return n;
                    })
                  }
                  className="text-muted-foreground hover:text-foreground"
                >
                  {isOpen ? <ChevronDownIcon className="h-3 w-3" /> : <ChevronRightIcon className="h-3 w-3" />}
                </button>
                <input
                  type="checkbox"
                  checked={rule.enabled}
                  onChange={(e) => patchRule(rule.id, { enabled: e.target.checked })}
                  className="rounded"
                />
                <input
                  value={rule.name}
                  onChange={(e) => patchRule(rule.id, { name: e.target.value })}
                  className="flex-1 bg-transparent text-xs font-medium outline-none"
                />
                <span className="rounded-full bg-muted/80 px-2 py-0.5 text-[10px] text-muted-foreground">
                  {rule.trigger.source}:{rule.trigger.event}
                </span>
                {last &&
                  (last.matched && !last.error ? (
                    <CheckCircle2Icon className="h-3 w-3 text-green-500" />
                  ) : last.error ? (
                    <AlertCircleIcon className="h-3 w-3 text-red-500" />
                  ) : (
                    <MinusCircleIcon className="h-3 w-3 text-muted-foreground" />
                  ))}
                <button
                  type="button"
                  onClick={() => setRules(automations.rules.filter((r) => r.id !== rule.id))}
                  className="text-muted-foreground hover:text-destructive"
                >
                  <Trash2Icon className="h-3 w-3" />
                </button>
              </div>
              {isOpen && (
                <RuleEditor
                  rule={rule}
                  catalog={catalog}
                  onChange={(patch) => patchRule(rule.id, patch)}
                  onTest={async (payload) => app.automations.test(rule.id, payload)}
                />
              )}
            </div>
          );
        })}
      </div>

      <ActivityLog runLog={runLog} onOpenConversation={onOpenConversation} />
    </div>
  );
};

/* ───────────────────────── Rule editor ───────────────────────── */

const RuleEditor: FC<{
  rule: Rule;
  catalog: AutomationSourceCatalogEntry[];
  onChange: (patch: Partial<Rule>) => void;
  onTest: (payload: unknown) => Promise<AutomationRunRecord>;
}> = ({ rule, catalog, onChange, onTest }) => {
  const source = catalog.find((c) => c.source === rule.trigger.source);
  const eventDesc = source?.events.find((e) => e.event === rule.trigger.event);
  const payloadPaths = useMemo(() => flattenJsonSchema(eventDesc?.payloadSchema), [eventDesc]);

  const [testPayload, setTestPayload] = useState('{}');
  const [testResult, setTestResult] = useState<AutomationRunRecord | null>(null);
  const [testing, setTesting] = useState(false);

  const pluginSources = catalog.filter((c) => c.source.startsWith('plugin.'));

  return (
    <div className="space-y-4 border-t border-border/70 px-3 py-3">
      {/* Trigger */}
      <div>
        <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Trigger</div>
        <div className="flex gap-2">
          <select
            className={settingsSelectClass}
            value={rule.trigger.source}
            onChange={(e) => onChange({ trigger: { source: e.target.value, event: '' } })}
          >
            <option value="">— select source —</option>
            {!source && rule.trigger.source && <option value={rule.trigger.source}>{rule.trigger.source}</option>}
            {catalog.map((c) => (
              <option key={c.source} value={c.source}>
                {c.displayName}
              </option>
            ))}
          </select>
          <select
            className={settingsSelectClass}
            value={rule.trigger.event}
            onChange={(e) => onChange({ trigger: { ...rule.trigger, event: e.target.value } })}
          >
            <option value="">— select event —</option>
            {!eventDesc && rule.trigger.event && <option value={rule.trigger.event}>{rule.trigger.event}</option>}
            {(source?.events ?? []).map((ev) => (
              <option key={ev.event} value={ev.event}>
                {ev.title}
              </option>
            ))}
          </select>
        </div>
        {eventDesc?.description && (
          <span className="mt-0.5 block text-[10px] text-muted-foreground/60">{eventDesc.description}</span>
        )}
      </div>

      {/* Conditions */}
      <div>
        <div className="mb-1 flex items-center justify-between">
          <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Conditions</span>
          <div className="flex items-center gap-2">
            <select
              className="rounded border border-border/70 bg-card/80 px-1.5 py-0.5 text-[10px] outline-none"
              value={rule.conditionMode}
              onChange={(e) => onChange({ conditionMode: e.target.value as 'all' | 'any' })}
            >
              <option value="all">match all</option>
              <option value="any">match any</option>
            </select>
            <button
              type="button"
              onClick={() =>
                onChange({
                  conditions: [...rule.conditions, { path: '', op: 'equals', value: '', caseSensitive: false }],
                })
              }
              className="inline-flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground"
            >
              <PlusIcon className="h-3 w-3" /> add
            </button>
          </div>
        </div>
        <div className="space-y-1.5">
          {rule.conditions.map((cond, i) => (
            <ConditionRow
              key={i}
              cond={cond}
              paths={payloadPaths}
              onChange={(next) => onChange({ conditions: rule.conditions.map((c, j) => (j === i ? next : c)) })}
              onRemove={() => onChange({ conditions: rule.conditions.filter((_, j) => j !== i) })}
            />
          ))}
          {rule.conditions.length === 0 && (
            <p className="text-[10px] text-muted-foreground/60">No conditions — fires on every matching event.</p>
          )}
        </div>
      </div>

      {/* Actions */}
      <div>
        <div className="mb-1 flex items-center justify-between">
          <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Actions</span>
          <button
            type="button"
            onClick={() => onChange({ actions: [...rule.actions, newAction('notification')] })}
            className="inline-flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground"
          >
            <PlusIcon className="h-3 w-3" /> add
          </button>
        </div>
        <div className="space-y-2">
          {rule.actions.map((action, i) => (
            <ActionEditor
              key={i}
              index={i}
              action={action}
              catalog={catalog}
              pluginSources={pluginSources}
              onChange={(next) => onChange({ actions: rule.actions.map((a, j) => (j === i ? next : a)) })}
              onRemove={
                rule.actions.length > 1
                  ? () => onChange({ actions: rule.actions.filter((_, j) => j !== i) })
                  : undefined
              }
            />
          ))}
        </div>
      </div>

      {/* Throttle + test */}
      <div className="grid grid-cols-2 gap-2">
        <NumberField
          label="Debounce (ms)"
          value={rule.debounceMs}
          min={0}
          onChange={(v) => onChange({ debounceMs: Math.max(0, Math.trunc(Number.isFinite(v) ? v : 0)) })}
        />
        <NumberField
          label="Rate limit (per minute, 0 = none)"
          value={rule.rateLimitPerMinute ?? 0}
          min={0}
          onChange={(v) => {
            const n = Math.trunc(Number.isFinite(v) ? v : 0);
            onChange({ rateLimitPerMinute: n > 0 ? n : undefined });
          }}
        />
      </div>

      <div className="rounded-lg border border-border/60 bg-muted/30 p-2">
        <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Test</div>
        <div className="flex gap-2">
          <input
            className="flex-1 rounded-xl border border-border/70 bg-card/80 px-3 py-2 font-mono text-[11px] outline-none"
            value={testPayload}
            onChange={(e) => setTestPayload(e.target.value)}
            placeholder='{"from":{"email":"boss@corp"},"body":"urgent"}'
          />
          <button
            type="button"
            disabled={testing}
            onClick={async () => {
              setTesting(true);
              setTestResult(null);
              try {
                const parsed = testPayload.trim() ? JSON.parse(testPayload) : {};
                const rec = await onTest(parsed);
                setTestResult(rec);
              } catch (err) {
                setTestResult({
                  id: 'err',
                  ruleId: rule.id,
                  ruleName: rule.name,
                  ts: Date.now(),
                  event: { key: 'test', source: 'test', event: 'test', payload: null },
                  matched: false,
                  results: [],
                  error: err instanceof Error ? err.message : String(err),
                });
              } finally {
                setTesting(false);
              }
            }}
            className="inline-flex items-center gap-1 rounded-xl border border-border/70 bg-card/80 px-3 py-2 text-xs hover:bg-muted/80 disabled:opacity-50"
          >
            <PlayIcon className="h-3 w-3" /> Run
          </button>
        </div>
        {testResult && (
          <pre className="mt-2 max-h-40 overflow-auto rounded bg-background/60 p-2 text-[10px]">
            {JSON.stringify(testResult, null, 2)}
          </pre>
        )}
      </div>
    </div>
  );
};

/* ───────────────────────── Condition row ───────────────────────── */

const ConditionRow: FC<{
  cond: Condition;
  paths: string[];
  onChange: (next: Condition) => void;
  onRemove: () => void;
}> = ({ cond, paths, onChange, onRemove }) => {
  const listId = useMemo(() => `paths-${Math.random().toString(36).slice(2)}`, []);
  const isExpr = cond.op === 'expression';
  const needsValue = cond.op !== 'exists';
  const normalized = cond.path.replace(/\[\d+\]/g, '[0]');
  const unknownPath = !isExpr && cond.path.length > 0 && paths.length > 0 && !paths.includes(normalized);

  return (
    <div>
      <div className="flex items-center gap-1.5">
        {!isExpr && (
          <>
            <input
              list={listId}
              value={cond.path}
              onChange={(e) => onChange({ ...cond, path: e.target.value })}
              placeholder="payload.path"
              className="w-1/3 rounded-xl border border-border/70 bg-card/80 px-2 py-1.5 font-mono text-[11px] outline-none"
            />
            <datalist id={listId}>
              {paths.map((p) => (
                <option key={p} value={p} />
              ))}
            </datalist>
          </>
        )}
        <select
          className="rounded-xl border border-border/70 bg-card/80 px-2 py-1.5 text-[11px] outline-none"
          value={cond.op}
          onChange={(e) => onChange({ ...cond, op: e.target.value as ConditionOp })}
        >
          {CONDITION_OPS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        {isExpr ? (
          <input
            value={typeof cond.value === 'string' ? cond.value : ''}
            onChange={(e) => onChange({ ...cond, value: e.target.value })}
            placeholder="event.from.email === 'boss@corp' && /urgent/i.test(event.body)"
            className="flex-1 rounded-xl border border-border/70 bg-card/80 px-2 py-1.5 font-mono text-[11px] outline-none"
          />
        ) : needsValue ? (
          <input
            value={
              cond.op === 'in' && Array.isArray(cond.value)
                ? cond.value.join(', ')
                : typeof cond.value === 'string'
                  ? cond.value
                  : cond.value == null
                    ? ''
                    : String(cond.value)
            }
            onChange={(e) =>
              onChange({
                ...cond,
                value:
                  cond.op === 'in'
                    ? e.target.value
                        .split(',')
                        .map((s) => s.trim())
                        .filter(Boolean)
                    : e.target.value,
              })
            }
            placeholder="value"
            className="flex-1 rounded-xl border border-border/70 bg-card/80 px-2 py-1.5 text-[11px] outline-none"
          />
        ) : (
          <div className="flex-1" />
        )}
        {!isExpr && (
          <label className="flex items-center gap-1 text-[10px] text-muted-foreground">
            <input
              type="checkbox"
              checked={cond.caseSensitive}
              onChange={(e) => onChange({ ...cond, caseSensitive: e.target.checked })}
            />
            Aa
          </label>
        )}
        <button type="button" onClick={onRemove} className="text-muted-foreground hover:text-destructive">
          <Trash2Icon className="h-3 w-3" />
        </button>
      </div>
      {unknownPath && (
        <span className="mt-0.5 block pl-1 text-[10px] text-amber-500">
          “{cond.path}” is not in this event’s declared payload schema — check the field name.
        </span>
      )}
    </div>
  );
};

/* ───────────────────────── Action editor ───────────────────────── */

function useConversationOptions(): Array<{ id: string; title: string }> {
  const [options, setOptions] = useState<Array<{ id: string; title: string }>>([]);
  useEffect(() => {
    let cancelled = false;
    app.conversations
      .list()
      .then((convs: unknown) => {
        if (cancelled) return;
        setOptions(
          (convs as Array<{ id: string; title?: string | null; fallbackTitle?: string | null }>).map((c) => ({
            id: c.id,
            title: c.title?.trim() || c.fallbackTitle?.trim() || c.id,
          })),
        );
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  return options;
}

function useModelOptions(): Array<{ key: string; label: string }> {
  const [options, setOptions] = useState<Array<{ key: string; label: string }>>([]);
  useEffect(() => {
    let cancelled = false;
    app
      .modelCatalog()
      .then((data) => {
        if (cancelled) return;
        const models = (data as { models?: Array<{ key: string; displayName?: string }> } | null)?.models ?? [];
        setOptions(models.map((m) => ({ key: m.key, label: m.displayName?.trim() || m.key })));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  return options;
}

function useProfileOptions(): Array<{ key: string; label: string }> {
  const [options, setOptions] = useState<Array<{ key: string; label: string }>>([]);
  useEffect(() => {
    let cancelled = false;
    app
      .profileCatalog()
      .then((data) => {
        if (cancelled) return;
        const profiles = (data as { profiles?: Array<{ key: string; name?: string }> } | null)?.profiles ?? [];
        setOptions(profiles.map((p) => ({ key: p.key, label: p.name?.trim() || p.key })));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  return options;
}

const ActionEditor: FC<{
  index: number;
  action: Action;
  catalog: AutomationSourceCatalogEntry[];
  pluginSources: AutomationSourceCatalogEntry[];
  onChange: (next: Action) => void;
  onRemove?: () => void;
}> = ({ index, action, catalog, pluginSources, onChange, onRemove }) => {
  const changeType = (type: Action['type']) => onChange(newAction(type));
  const conversationOptions = useConversationOptions();
  const modelOptions = useModelOptions();
  const profileOptions = useProfileOptions();
  const target: ConversationTarget =
    action.type === 'agent' ? (action.conversationTarget ?? { type: 'per-invocation' }) : { type: 'per-invocation' };
  const includeHistory = action.type === 'agent' ? (action.includeHistory ?? true) : true;

  return (
    <div className="rounded-lg border border-border/60 bg-background/40 p-2">
      <div className="mb-2 flex items-center gap-2">
        <span className="text-[10px] text-muted-foreground">#{index + 1}</span>
        <select
          className="rounded-xl border border-border/70 bg-card/80 px-2 py-1.5 text-[11px] outline-none"
          value={action.type}
          onChange={(e) => changeType(e.target.value as Action['type'])}
        >
          {ACTION_TYPES.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>
        <div className="flex-1" />
        {onRemove && (
          <button type="button" onClick={onRemove} className="text-muted-foreground hover:text-destructive">
            <Trash2Icon className="h-3 w-3" />
          </button>
        )}
      </div>

      {action.type === 'agent' && (
        <div className="space-y-2">
          <div className="flex gap-2">
            <select
              className={settingsSelectClass}
              value={action.mode}
              onChange={(e) => onChange({ ...action, mode: e.target.value as 'background' | 'conversation' })}
            >
              <option value="background">Background (headless)</option>
              <option value="conversation">Conversation</option>
            </select>
            <label className="flex items-center gap-1 whitespace-nowrap rounded-xl border border-border/70 bg-card/80 px-3 py-2 text-xs">
              <input
                type="checkbox"
                checked={action.tools}
                onChange={(e) => onChange({ ...action, tools: e.target.checked })}
              />
              tools
            </label>
          </div>
          <div>
            <label className="mb-0.5 block text-[10px] text-muted-foreground">Prompt</label>
            <textarea
              value={action.prompt}
              onChange={(e) => onChange({ ...action, prompt: e.target.value })}
              placeholder="Summarize this Teams message and draft a reply: {{payload.body}}"
              rows={3}
              className="w-full rounded-xl border border-border/70 bg-card/80 px-3 py-2 font-mono text-[11px] outline-none"
            />
          </div>
          {action.mode === 'conversation' && (
            <div className="space-y-2">
              <div>
                <label className="mb-0.5 block text-[10px] text-muted-foreground">Conversation target</label>
                <select
                  className={settingsSelectClass}
                  value={target.type}
                  onChange={(e) => {
                    const type = e.target.value as ConversationTarget['type'];
                    onChange({
                      ...action,
                      conversationTarget:
                        type === 'existing'
                          ? {
                              type,
                              conversationId:
                                target.type === 'existing' ? target.conversationId : (conversationOptions[0]?.id ?? ''),
                            }
                          : { type },
                    });
                  }}
                >
                  <option value="per-invocation">New chat each run</option>
                  <option value="singleton">One shared chat for this rule</option>
                  <option value="existing">Append to a specific chat</option>
                </select>
              </div>
              {target.type === 'existing' && (
                <div>
                  <label className="mb-0.5 block text-[10px] text-muted-foreground">Chat</label>
                  <select
                    className={settingsSelectClass}
                    value={target.conversationId}
                    onChange={(e) =>
                      onChange({
                        ...action,
                        conversationTarget: { type: 'existing', conversationId: e.target.value },
                      })
                    }
                  >
                    <option value="">— select a chat —</option>
                    {conversationOptions.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.title}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              {target.type !== 'existing' && (
                <TextField
                  label="Conversation title"
                  value={action.conversationTitle ?? ''}
                  onChange={(v) => onChange({ ...action, conversationTitle: v || undefined })}
                  placeholder="{{payload.from.name}} — auto-reply"
                />
              )}
              {target.type !== 'per-invocation' && (
                <Toggle
                  label="Include chat history in prompt context"
                  checked={includeHistory}
                  onChange={(v) => onChange({ ...action, includeHistory: v })}
                />
              )}
            </div>
          )}
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="mb-0.5 block text-[10px] text-muted-foreground">Model (optional)</label>
              <select
                className={settingsSelectClass}
                value={action.modelKey ?? ''}
                onChange={(e) => onChange({ ...action, modelKey: e.target.value || undefined })}
              >
                <option value="">— default —</option>
                {modelOptions.map((m) => (
                  <option key={m.key} value={m.key}>
                    {m.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-0.5 block text-[10px] text-muted-foreground">Profile (optional)</label>
              <select
                className={settingsSelectClass}
                value={action.profileKey ?? ''}
                onChange={(e) => onChange({ ...action, profileKey: e.target.value || undefined })}
              >
                <option value="">— default —</option>
                {profileOptions.map((p) => (
                  <option key={p.key} value={p.key}>
                    {p.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>
      )}

      {action.type === 'plugin-action' && (
        <div className="space-y-2">
          <div className="flex gap-2">
            <select
              className={settingsSelectClass}
              value={action.pluginName}
              onChange={(e) => onChange({ ...action, pluginName: e.target.value, targetId: '' })}
            >
              <option value="">— plugin —</option>
              {pluginSources.map((p) => (
                <option key={p.source} value={p.source.slice('plugin.'.length)}>
                  {p.displayName}
                </option>
              ))}
            </select>
            <select
              className={settingsSelectClass}
              value={action.targetId}
              onChange={(e) => onChange({ ...action, targetId: e.target.value })}
            >
              <option value="">— action —</option>
              {(pluginSources.find((p) => p.source === `plugin.${action.pluginName}`)?.actions ?? []).map((a) => (
                <option key={a.targetId} value={a.targetId}>
                  {a.title}
                </option>
              ))}
            </select>
          </div>
          <TextField label="Action verb" value={action.action} onChange={(v) => onChange({ ...action, action: v })} />
          <JsonField
            label="Data (JSON, values may use {{…}})"
            value={action.data ?? {}}
            onChange={(v) => onChange({ ...action, data: v })}
          />
        </div>
      )}

      {action.type === 'tool' && (
        <div className="space-y-2">
          <TextField
            label="Tool name"
            value={action.toolName}
            onChange={(v) => onChange({ ...action, toolName: v })}
            mono
          />
          <JsonField label="Input (JSON)" value={action.input} onChange={(v) => onChange({ ...action, input: v })} />
        </div>
      )}

      {action.type === 'notification' && (
        <div className="space-y-2">
          <TextField label="Title" value={action.title} onChange={(v) => onChange({ ...action, title: v })} />
          <TextField
            label="Body"
            value={action.body ?? ''}
            onChange={(v) => onChange({ ...action, body: v || undefined })}
          />
        </div>
      )}

      {action.type === 'emit' && (
        <div className="space-y-2">
          <div className="flex gap-2">
            <select
              className={settingsSelectClass}
              value={action.source}
              onChange={(e) => onChange({ ...action, source: e.target.value })}
            >
              <option value="">— source —</option>
              {catalog.map((c) => (
                <option key={c.source} value={c.source}>
                  {c.displayName}
                </option>
              ))}
            </select>
            <input
              value={action.event}
              onChange={(e) => onChange({ ...action, event: e.target.value })}
              placeholder="event"
              className="flex-1 rounded-xl border border-border/70 bg-card/80 px-3 py-2 text-xs outline-none"
            />
          </div>
          <JsonField
            label="Payload (JSON)"
            value={action.payload ?? {}}
            onChange={(v) => onChange({ ...action, payload: v })}
          />
        </div>
      )}

      {action.type === 'runHookCommand' && (
        <div className="space-y-2">
          <p className="text-[10px] text-muted-foreground/70">
            Only fires for <code className="font-mono">Agent lifecycle</code> triggers. The event payload is written to
            the command’s stdin as JSON. In <em>block</em> mode a non-zero exit cancels the action (stderr is surfaced
            to the agent). In <em>modify</em> mode stdout must be JSON of the form{' '}
            <code className="font-mono">{'{"payload": …}'}</code>. Note: <em>block</em>/<em>modify</em> only take effect
            for <code className="font-mono">PreToolUse</code>, <code className="font-mono">PostToolUse</code>, and{' '}
            <code className="font-mono">UserPromptSubmit</code>; other lifecycle events run observe-only.
          </p>
          <TextField
            label="Command"
            value={action.command}
            onChange={(v) => onChange({ ...action, command: v })}
            placeholder="~/.kai/hooks/redact.sh"
            mono
          />
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="mb-0.5 block text-[10px] text-muted-foreground">Mode</label>
              <select
                className={settingsSelectClass}
                value={action.mode}
                onChange={(e) => onChange({ ...action, mode: e.target.value as 'observe' | 'block' | 'modify' })}
              >
                <option value="observe">observe (fire & forget)</option>
                <option value="block">block (deny on non-zero exit)</option>
                <option value="modify">modify (replace payload from stdout)</option>
              </select>
            </div>
            <TextField
              label="Tool matcher (Pre/PostToolUse only)"
              value={action.matcher ?? ''}
              onChange={(v) => onChange({ ...action, matcher: v || undefined })}
              placeholder="mastra_workspace_*"
              mono
            />
          </div>
        </div>
      )}
    </div>
  );
};

const JsonField: FC<{
  label: string;
  value: Record<string, unknown>;
  onChange: (v: Record<string, unknown>) => void;
}> = ({ label, value, onChange }) => {
  const [text, setText] = useState(() => JSON.stringify(value, null, 2));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setText(JSON.stringify(value, null, 2));
  }, [value]);

  return (
    <div>
      <label className="mb-0.5 block text-[10px] text-muted-foreground">{label}</label>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          try {
            const parsed = text.trim() ? JSON.parse(text) : {};
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
              setError(null);
              onChange(parsed);
            } else {
              setError('must be a JSON object');
            }
          } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
          }
        }}
        rows={3}
        className="w-full rounded-xl border border-border/70 bg-card/80 px-3 py-2 font-mono text-[11px] outline-none"
      />
      {error && <span className="mt-0.5 block text-[10px] text-red-500">{error}</span>}
    </div>
  );
};

/* ───────────────────────── Activity log ───────────────────────── */

function runConversationIds(r: AutomationRunRecord): string[] {
  const ids = new Set<string>();
  for (const res of r.results) {
    const cid = (res.output as { conversationId?: unknown } | null | undefined)?.conversationId;
    if (typeof cid === 'string' && cid) ids.add(cid);
  }
  return [...ids];
}

const ActivityLog: FC<{ runLog: AutomationRunRecord[]; onOpenConversation?: (id: string) => void }> = ({
  runLog,
  onOpenConversation,
}) => {
  const [open, setOpen] = useState<Set<string>>(new Set());
  return (
    <div>
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        Activity ({runLog.length})
      </div>
      <div className="max-h-64 space-y-1 overflow-auto rounded-lg border border-border/60 bg-card/30 p-2">
        {runLog.length === 0 && <p className="text-[10px] text-muted-foreground/60">No runs yet.</p>}
        {runLog.map((r) => {
          const isOpen = open.has(r.id);
          const convIds = runConversationIds(r);
          return (
            <div key={r.id} className="rounded border border-border/40 bg-background/40">
              <button
                type="button"
                onClick={() =>
                  setOpen((s) => {
                    const n = new Set(s);
                    if (n.has(r.id)) n.delete(r.id);
                    else n.add(r.id);
                    return n;
                  })
                }
                className="flex w-full items-center gap-2 px-2 py-1 text-left"
              >
                {r.matched && !r.error ? (
                  <CheckCircle2Icon className="h-3 w-3 shrink-0 text-green-500" />
                ) : r.error ? (
                  <AlertCircleIcon className="h-3 w-3 shrink-0 text-red-500" />
                ) : (
                  <MinusCircleIcon className="h-3 w-3 shrink-0 text-muted-foreground" />
                )}
                <span className="text-[10px] text-muted-foreground">{new Date(r.ts).toLocaleTimeString()}</span>
                <span className="truncate text-[11px]">{r.ruleName}</span>
                <span className="text-[10px] text-muted-foreground">{r.event.key}</span>
                {r.skippedReason && (
                  <span className="ml-auto text-[10px] text-muted-foreground">skipped: {r.skippedReason}</span>
                )}
              </button>
              {isOpen && (
                <div className="border-t border-border/40">
                  {convIds.length > 0 && onOpenConversation && (
                    <div className="flex flex-wrap gap-1 px-2 pt-2">
                      {convIds.map((cid) => (
                        <button
                          key={cid}
                          type="button"
                          onClick={() => onOpenConversation(cid)}
                          className="flex items-center gap-1 rounded-md border border-border/70 bg-card/80 px-2 py-1 text-[10px] hover:bg-card"
                        >
                          <MessageSquareIcon className="h-3 w-3" />
                          Open chat
                        </button>
                      ))}
                    </div>
                  )}
                  <pre className="max-h-40 overflow-auto p-2 text-[10px]">
                    {JSON.stringify({ event: r.event, results: r.results, error: r.error }, null, 2)}
                  </pre>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};
