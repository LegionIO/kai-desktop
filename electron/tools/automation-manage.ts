import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { eventBus } from '../automations/event-bus.js';
import { getAutomationEngine } from '../automations/engine.js';
import { validateRulePaths } from '../automations/schema-check.js';
import type { AutomationRule, AutomationsConfig } from '../config/schema.js';
import { automationRuleSchema } from '../config/schema.js';
import { getRegisteredTools, getWorkspaceToolDefinitions } from '../ipc/agent.js';
import { readEffectiveConfig, writeDesktopConfig } from '../ipc/config.js';
import { readIndex } from '../ipc/conversation-store.js';
import type { ToolDefinition, ToolExecutionContext } from './types.js';
import { ruleTriggersOnHookEvents } from '../agent/hooks/dispatcher.js';
import { registerPendingApproval, broadcastStreamEventRaw } from '../ipc/tool-approval.js';

type MutableAgentAction = {
  type?: unknown;
  conversationTarget?: { type?: unknown; conversationId?: unknown };
};

function defaultExistingTargetToCurrent(actions: unknown, currentConversationId: string | undefined): void {
  if (!Array.isArray(actions)) return;
  for (const a of actions as MutableAgentAction[]) {
    if (a?.type !== 'agent') continue;
    const target = a.conversationTarget;
    if (target?.type !== 'existing') continue;
    if (typeof target.conversationId === 'string' && target.conversationId) continue;
    if (currentConversationId) target.conversationId = currentConversationId;
  }
}

/**
 * Validate/repair `{type:'existing', conversationId}` targets at authoring time.
 *
 * Without this, a model that passes a conversationId that ISN'T a real id — a
 * chat *title*, a guessed id, or a since-deleted one — silently sails through:
 * at runtime `readConversation` returns null and the run creates a BRAND-NEW
 * conversation every single fire (the "one automation, many duplicate chats"
 * bug). We fail loudly at create/update instead:
 *   - a conversationId that resolves to a real conversation → keep;
 *   - one that instead uniquely matches a conversation *title* → repair to that
 *     id (handles "used the name, not the id");
 *   - anything else (unknown / ambiguous title) → return an actionable error so
 *     the create/update is rejected.
 * Returns an error string, or null if all targets are valid/repaired in place.
 */
function validateExistingTargets(actions: unknown, appHome: string): string | null {
  if (!Array.isArray(actions)) return null;
  let index: ReturnType<typeof readIndex> | null = null;
  const getIndex = () => (index ??= readIndex(appHome));
  for (const a of actions as MutableAgentAction[]) {
    if (a?.type !== 'agent') continue;
    const target = a.conversationTarget;
    if (target?.type !== 'existing') continue;
    const id = target.conversationId;
    // This runs AFTER defaultExistingTargetToCurrent, so an empty id here means
    // it couldn't be pinned to the current chat (e.g. created headlessly with no
    // active conversation). An unpinned existing-target resolves to null every
    // run → a brand-new chat each fire (the "one rule, many duplicate chats"
    // race). Reject it: the author must pass a real id, or use singleton/
    // per-invocation instead.
    if (typeof id !== 'string' || !id) {
      return 'conversationTarget {type:"existing"} has no conversationId and there is no current chat to default to. Pass a real conversation id, or use {type:"singleton"} (one shared chat per rule) / {type:"per-invocation"} (a new chat each run) instead — an unpinned existing-target would create a new chat on every run.';
    }

    const convs = Object.values(getIndex().conversations);
    if (convs.some((c) => c.id === id)) continue; // valid id — keep

    // Not an id — maybe the model passed a title. Repair only on a UNIQUE match.
    const byTitle = convs.filter((c) => c.title != null && c.title === id);
    if (byTitle.length === 1) {
      target.conversationId = byTitle[0].id;
      continue;
    }
    if (byTitle.length > 1) {
      return `conversationTarget.conversationId "${id}" matches ${byTitle.length} chats by title — pass the exact conversation id, or omit conversationId to target the current chat.`;
    }
    return `conversationTarget.conversationId "${id}" is not a known conversation id (and matches no chat title). Omit conversationId to append to the current chat, or pass a valid conversation id — otherwise every run would create a new chat.`;
  }
  return null;
}

function summarizeRule(rule: AutomationRule) {
  return {
    id: rule.id,
    name: rule.name,
    enabled: rule.enabled,
    trigger: rule.trigger,
    conditionCount: rule.conditions.length,
    conditionMode: rule.conditionMode,
    actions: rule.actions.map((a) => a.type),
    debounceMs: rule.debounceMs,
    rateLimitPerMinute: rule.rateLimitPerMinute,
  };
}

/** A rule contains an arbitrary-shell hook action. */
function hasShellHookAction(rule: Pick<AutomationRule, 'actions'>): boolean {
  return rule.actions.some((a) => a.type === 'runHookCommand');
}

/** A rule executes a registered tool. A `tool` action can invoke ANY registered
 *  tool — including model-directed exec tools (sh, file writes) — with the rule's
 *  interpolated input, on every matching event. That is a capability grant
 *  equivalent to (or exceeding) a shell hook, so it must clear the same approval
 *  gate; otherwise the agent could self-grant unattended tool execution by
 *  writing (or `test`ing) a rule the approval flow never sees. */
function hasToolAction(rule: Pick<AutomationRule, 'actions'>): boolean {
  return rule.actions.some((a) => a.type === 'tool');
}

/** Tool names a rule's `tool` actions would execute (for the approval prompt). */
function toolActionNames(rule: Pick<AutomationRule, 'actions'>): string[] {
  return rule.actions
    .filter((a): a is Extract<AutomationRule['actions'][number], { type: 'tool' }> => a.type === 'tool')
    .map((a) => a.toolName);
}

/** A rule runs an autonomous agent turn WITH tools enabled. `runAgentAction`
 *  (electron/automations/actions.ts) streams through `generateForPlugin`, which
 *  has NO interactive per-tool approval — so the agent executes whatever tools
 *  it calls (including exec tools like sh) freely. `tools` defaults TRUE, so
 *  this is the same unattended-exec capability grant as a `tool` action and must
 *  clear the same gate. A `tools:false` agent action is text-only (no exec). */
function hasAgentToolExecAction(rule: Pick<AutomationRule, 'actions'>): boolean {
  return rule.actions.some((a) => a.type === 'agent' && a.tools !== false);
}

/**
 * A rule is "dangerous" when the AGENT creating/enabling it would gain a
 * powerful capability without the user in the loop: it subscribes to lifecycle
 * hook events (can observe raw prompts + tool payloads), runs an arbitrary shell
 * command, executes a registered tool, or runs an autonomous agent turn WITH
 * tools (which can call exec/file tools with no interactive approval). All are
 * gated behind the automations approval policy.
 */
function isDangerousRule(rule: AutomationRule): boolean {
  return (
    ruleTriggersOnHookEvents(rule) || hasShellHookAction(rule) || hasToolAction(rule) || hasAgentToolExecAction(rule)
  );
}

type ApprovalDecision = { ok: true } | { ok: false; error: string };

/**
 * Gate a dangerous agent-initiated automation mutation behind the configured
 * approval policy. On `prompt-user` it broadcasts a tool-approval-required event
 * for the calling `automations` tool card and awaits the user's one-shot
 * decision.
 */
async function ensureApproved(
  rule: AutomationRule,
  actionLabel: string,
  automations: AutomationsConfig,
  context: ToolExecutionContext | undefined,
): Promise<ApprovalDecision> {
  const mode = automations.approvalMode ?? 'prompt-user';

  if (mode === 'auto-allow') return { ok: true };

  if (mode === 'block') {
    return {
      ok: false,
      error: `Blocked: automations.approvalMode is "block", so the agent cannot ${actionLabel} a rule that observes lifecycle hook events, runs shell commands, or executes registered tools. The user can change this in Settings → Automations.`,
    };
  }

  // prompt-user: require a live user decision on the calling tool card. This
  // needs a resolvable UI owner: a real conversation AND an abort signal (the
  // signature of a live agent stream). Internal callers — e.g. an automation
  // `tool` action (electron/automations/actions.ts) invoking this tool with only
  // a synthetic { toolCallId } — have no owner to answer the prompt, so awaiting
  // would hang forever and stall the run. Fail CLOSED (deny) in that case rather
  // than broadcast an unanswerable approval.
  const toolCallId = context?.toolCallId;
  if (!context || !toolCallId || !context.conversationId || !context.abortSignal) {
    return {
      ok: false,
      error: `Cannot request interactive approval from this context (no live chat). This rule (${actionLabel}) observes lifecycle hook events, runs shell commands, or executes registered tools, and requires user approval. A user must perform this in Settings → Automations, or set automations.approvalMode to "auto-allow".`,
    };
  }
  // Surface the actual shell commands (command/mode/matcher) AND any tool
  // actions so the approval card shows exactly what will run — summarizeRule
  // reduces actions to type names, which is not enough to consent to arbitrary
  // shell/tool execution.
  const shellActions = rule.actions
    .filter(
      (a): a is Extract<AutomationRule['actions'][number], { type: 'runHookCommand' }> => a.type === 'runHookCommand',
    )
    .map((a) => ({ command: a.command, mode: a.mode, matcher: a.matcher ?? '*' }));
  const toolNames = toolActionNames(rule);
  const reasonParts: string[] = [];
  if (shellActions.length) {
    reasonParts.push(
      `runs ${shellActions.length === 1 ? 'the shell command' : 'shell commands'}: ${shellActions
        .map((s) => `\`${s.command}\` (${s.mode})`)
        .join(', ')}`,
    );
  }
  if (toolNames.length) {
    reasonParts.push(
      `executes ${toolNames.length === 1 ? 'the tool' : 'tools'} ${toolNames.map((t) => `\`${t}\``).join(', ')} (which may run shell/file operations)`,
    );
  }
  if (hasAgentToolExecAction(rule)) {
    reasonParts.push('runs an autonomous agent turn with tools enabled (the agent can call exec/file tools directly)');
  }
  if (ruleTriggersOnHookEvents(rule)) {
    reasonParts.push('subscribes to agent lifecycle hook events and can observe raw prompts and tool payloads');
  }
  broadcastStreamEventRaw({
    conversationId: context.conversationId,
    type: 'tool-approval-required',
    toolCallId,
    toolName: 'automations',
    args: {
      approvalKind: 'dangerous-automation',
      action: actionLabel,
      rule: summarizeRule(rule),
      ...(shellActions.length ? { shellCommands: shellActions } : {}),
      ...(toolNames.length ? { toolActions: toolNames } : {}),
      reason: `This rule ${reasonParts.join('; ') || 'requires approval'}.`,
    },
  });
  const decision = await registerPendingApproval(toolCallId, context.abortSignal);
  if (decision === true) return { ok: true };
  return {
    ok: false,
    error:
      decision === 'dismiss'
        ? `Approval dismissed by the user; did not ${actionLabel} the rule.`
        : `Approval denied by the user; did not ${actionLabel} the rule.`,
  };
}

export function createAutomationManageTool(appHome: string): ToolDefinition {
  return {
    name: 'automations',
    source: 'builtin',
    description: [
      'Manage event-driven automation rules. A rule fires when its trigger event',
      '(from the app or a plugin) arrives and its conditions match, then runs its',
      'actions in order.',
      '',
      'Actions: "list" returns the event catalog (available sources/events/plugin-actions),',
      'available tool names, and current rules — always call this first to discover valid',
      'trigger.source, trigger.event, plugin-action targetIds, and payload field paths.',
      'trigger.source and trigger.event each also accept "*" to match ALL sources / ALL events',
      '(e.g. {source:"*",event:"*"} fires on every event — narrow it with conditions).',
      'To fire on SEVERAL specific events — even across different sources (e.g.',
      'teams:message-received AND outlook:email-received) — add a triggers[] array of',
      '{source,event} pairs alongside trigger; the rule fires when the event matches ANY',
      'of trigger or triggers[] (prefer this over "*"+conditions when you know the exact set).',
      '"get" returns one rule in full. "create" adds a rule. "update" patches a rule by id.',
      '"delete" removes a rule. "enable"/"disable" toggles a rule. "test" runs a rule once',
      'against a sample payload (executes real actions).',
      '',
      'Rule shape: { name, enabled, trigger:{source,event}, triggers?:[{source,event},...],',
      'conditions:[{path,op,value,caseSensitive}],',
      'conditionMode:"all"|"any", actions:[...], debounceMs, rateLimitPerMinute }.',
      'Condition ops: equals, notEquals, contains, startsWith, endsWith, matches (regex), in,',
      'exists, expression (JS with `event` bound to the payload).',
      'Action types: agent (mode "background"|"conversation", prompt supports {{payload.x}} and',
      '{{result[N].text}}), plugin-action (pluginName+targetId+data), tool (toolName+input),',
      'notification (title+body), emit (source+event+payload).',
      '',
      'For agent mode "conversation": conversationTarget is one of',
      '{type:"per-invocation"} (new chat each run, default), {type:"singleton"} (one shared chat',
      'per rule, created on first run then appended), or {type:"existing", conversationId} (append',
      'to a specific chat — omit conversationId to target the chat you are running in right now).',
      'For {type:"existing"}, conversationId MUST be a real conversation id (not a chat title/name);',
      'an unknown id is rejected at create/update time because it would make every run spawn a new chat.',
      "includeHistory (default true) passes the target chat's prior messages as context to the agent.",
    ].join('\n'),
    inputSchema: z.object({
      action: z
        .enum(['list', 'get', 'create', 'update', 'delete', 'enable', 'disable', 'test'])
        .describe('The management action to perform'),
      id: z.string().optional().describe('Rule id (required for get/update/delete/enable/disable/test)'),
      rule: z
        .record(z.string(), z.unknown())
        .optional()
        .describe(
          'Full rule object for "create", or a top-level patch for "update". On update, top-level fields and trigger.{source,event} merge; conditions/actions arrays replace wholesale (call "get" first if you need to edit one entry). id is always auto-generated on create.',
        ),
      samplePayload: z
        .unknown()
        .optional()
        .describe('For "test": event payload to evaluate conditions and interpolation against'),
    }),
    execute: async (input, context?: ToolExecutionContext) => {
      const { action, id, rule, samplePayload } = input as {
        action: 'list' | 'get' | 'create' | 'update' | 'delete' | 'enable' | 'disable' | 'test';
        id?: string;
        rule?: Record<string, unknown>;
        samplePayload?: unknown;
      };

      const config = readEffectiveConfig(appHome);
      const rules = config.automations.rules;

      const persist = (nextRules: AutomationRule[]) => {
        config.automations = { ...config.automations, rules: nextRules };
        writeDesktopConfig(appHome, config);
        getAutomationEngine()?.reload(nextRules);
      };

      const findIndex = (): number => (id ? rules.findIndex((r) => r.id === id) : -1);

      switch (action) {
        case 'list': {
          const catalog = eventBus.getCatalog();
          const toolNames = [...getRegisteredTools(), ...getWorkspaceToolDefinitions()].map((t) => ({
            name: t.name,
            source: t.source,
            aliases: t.aliases,
          }));
          return {
            enabled: config.automations.enabled,
            rules: rules.map(summarizeRule),
            catalog,
            availableTools: toolNames,
            hint: 'Use catalog[].source + catalog[].events[].event for trigger, or "*" for trigger.source/trigger.event to match all sources/all events (then narrow with conditions). Use catalog[].events[].payloadSchema property paths for condition.path AND for `{{payload.<path>}}` interpolation in action fields. Available `{{ }}` template variables in any action field: `{{payload.<path>}}` (the triggering event payload — shape is per-event, see payloadSchema), `{{source}}` + `{{event}}` (the trigger names), and `{{result[N].text}}` (a prior action\'s output in this rule, 0-indexed). Plugin actions live in catalog[].actions[].targetId (source starting with "plugin."). For agent actions in "conversation" mode, set conversationTarget to {type:"per-invocation"|"singleton"|"existing"}; for "existing", omit conversationId to target this chat.',
          };
        }

        case 'get': {
          const idx = findIndex();
          if (idx < 0) return { error: id ? `Rule "${id}" not found.` : 'id is required.' };
          return { rule: rules[idx] };
        }

        case 'create': {
          if (!rule) return { error: 'rule is required for create.' };
          const candidate: Record<string, unknown> = { enabled: true, ...rule, id: randomUUID() };
          defaultExistingTargetToCurrent(candidate.actions, context?.conversationId);
          const targetErr = validateExistingTargets(candidate.actions, appHome);
          if (targetErr) return { error: targetErr };
          const parsed = automationRuleSchema.safeParse(candidate);
          if (!parsed.success) {
            return { error: 'Rule failed validation.', issues: parsed.error.issues };
          }
          // Writing a dangerous rule (hook-triggered or runHookCommand) needs
          // approval per automations.approvalMode — REGARDLESS of enabled state.
          // A disabled rule is still unapproved shell/hook config the agent must
          // not plant dormantly; enabling it later wouldn't retroactively gate
          // the already-persisted config.
          if (isDangerousRule(parsed.data)) {
            const gate = await ensureApproved(parsed.data, 'create', config.automations, context);
            if (!gate.ok) return { error: gate.error };
          }
          const warnings = validateRulePaths(parsed.data, eventBus.getCatalog());
          persist([...rules, parsed.data]);
          return {
            success: true,
            created: summarizeRule(parsed.data),
            id: parsed.data.id,
            warnings: warnings.length ? warnings : undefined,
            note: parsed.data.enabled
              ? 'Rule is live immediately.'
              : 'Rule created disabled; use action "enable" to activate.',
          };
        }

        case 'update': {
          const idx = findIndex();
          if (idx < 0) return { error: id ? `Rule "${id}" not found.` : 'id is required.' };
          if (!rule) return { error: 'rule (patch) is required for update.' };
          const prev = rules[idx];
          const patchTrigger = rule.trigger as Partial<AutomationRule['trigger']> | undefined;
          const merged = {
            ...prev,
            ...rule,
            trigger: patchTrigger ? { ...prev.trigger, ...patchTrigger } : prev.trigger,
            id: prev.id,
          };
          defaultExistingTargetToCurrent(merged.actions, context?.conversationId);
          const updateTargetErr = validateExistingTargets(merged.actions, appHome);
          if (updateTargetErr) return { error: updateTargetErr };
          const parsed = automationRuleSchema.safeParse(merged);
          if (!parsed.success) {
            return { error: 'Updated rule failed validation.', issues: parsed.error.issues };
          }
          // Approval is needed if the RESULT is a dangerous rule (regardless of
          // enabled state — a disabled dangerous rule is still unapproved config),
          // or if we're editing an already-dangerous rule (so the agent can't
          // quietly rewrite a user-configured shell/hook rule).
          const needsApproval = isDangerousRule(parsed.data) || isDangerousRule(prev);
          if (needsApproval) {
            const gate = await ensureApproved(parsed.data, 'update', config.automations, context);
            if (!gate.ok) return { error: gate.error };
          }
          const warnings = validateRulePaths(parsed.data, eventBus.getCatalog());
          const next = [...rules];
          next[idx] = parsed.data;
          persist(next);
          return {
            success: true,
            updated: summarizeRule(parsed.data),
            warnings: warnings.length ? warnings : undefined,
          };
        }

        case 'delete': {
          const idx = findIndex();
          if (idx < 0) return { error: id ? `Rule "${id}" not found.` : 'id is required.' };
          const removed = rules[idx];
          // Deleting a user-configured shell (enforcement) rule could neuter a
          // DLP/block hook, so gate it. Non-shell rules (incl. hook-triggered
          // observe rules the agent created) delete freely.
          if (hasShellHookAction(removed)) {
            const gate = await ensureApproved(removed, 'delete', config.automations, context);
            if (!gate.ok) return { error: gate.error };
          }
          persist(rules.filter((_, i) => i !== idx));
          return { success: true, deleted: summarizeRule(removed) };
        }

        case 'enable':
        case 'disable': {
          const idx = findIndex();
          if (idx < 0) return { error: id ? `Rule "${id}" not found.` : 'id is required.' };
          const target = rules[idx];
          // Enabling a dangerous rule makes it live → gate. Disabling a
          // user-configured shell (enforcement) rule could neuter protection →
          // gate. Disabling a non-shell rule is safe.
          const gateNeeded = action === 'enable' ? isDangerousRule(target) : hasShellHookAction(target);
          if (gateNeeded) {
            const gate = await ensureApproved(target, action, config.automations, context);
            if (!gate.ok) return { error: gate.error };
          }
          const next = [...rules];
          next[idx] = { ...next[idx], enabled: action === 'enable' };
          persist(next);
          return { success: true, id, enabled: action === 'enable' };
        }

        case 'test': {
          const idx = findIndex();
          if (idx < 0) return { error: id ? `Rule "${id}" not found.` : 'id is required.' };
          // `test` executes the rule's real actions once, so a dangerous rule
          // must clear the approval gate too.
          if (isDangerousRule(rules[idx])) {
            const gate = await ensureApproved(rules[idx], 'test', config.automations, context);
            if (!gate.ok) return { error: gate.error };
          }
          const engine = getAutomationEngine();
          if (!engine) return { error: 'Automation engine not initialized.' };
          const record = await engine.testRule(rules[idx].id, samplePayload === undefined ? {} : samplePayload);
          return { record };
        }

        default:
          return { error: `Unknown action: ${action satisfies never}` };
      }
    },
  };
}
