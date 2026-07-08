import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { eventBus } from '../automations/event-bus.js';
import { getAutomationEngine } from '../automations/engine.js';
import { validateRulePaths } from '../automations/schema-check.js';
import type { AutomationRule, AutomationsConfig } from '../config/schema.js';
import { automationRuleSchema } from '../config/schema.js';
import { getRegisteredTools, getWorkspaceToolDefinitions } from '../ipc/agent.js';
import { readEffectiveConfig, writeDesktopConfig } from '../ipc/config.js';
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

/**
 * A rule is "dangerous" when the AGENT creating/enabling it would gain a
 * powerful capability without the user in the loop: it either subscribes to
 * lifecycle hook events (can observe raw prompts + tool payloads) or runs an
 * arbitrary shell command.
 */
function isDangerousRule(rule: AutomationRule): boolean {
  return ruleTriggersOnHookEvents(rule) || hasShellHookAction(rule);
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
      error: `Blocked: automations.approvalMode is "block", so the agent cannot ${actionLabel} a rule that observes lifecycle hook events or runs shell commands. The user can change this in Settings → Automations.`,
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
      error: `Cannot request interactive approval from this context (no live chat). This rule (${actionLabel}) observes lifecycle hook events or runs shell commands and requires user approval. A user must perform this in Settings → Automations, or set automations.approvalMode to "auto-allow".`,
    };
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
      reason: hasShellHookAction(rule)
        ? 'This rule runs an arbitrary shell command.'
        : 'This rule subscribes to agent lifecycle hook events and can observe raw prompts and tool payloads.',
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
      '"get" returns one rule in full. "create" adds a rule. "update" patches a rule by id.',
      '"delete" removes a rule. "enable"/"disable" toggles a rule. "test" runs a rule once',
      'against a sample payload (executes real actions).',
      '',
      'Rule shape: { name, enabled, trigger:{source,event}, conditions:[{path,op,value,caseSensitive}],',
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
            hint: 'Use catalog[].source + catalog[].events[].event for trigger. Use catalog[].events[].payloadSchema property paths for condition.path. Plugin actions live in catalog[].actions[].targetId (source starting with "plugin."). For agent actions in "conversation" mode, set conversationTarget to {type:"per-invocation"|"singleton"|"existing"}; for "existing", omit conversationId to target this chat.',
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
          const parsed = automationRuleSchema.safeParse(candidate);
          if (!parsed.success) {
            return { error: 'Rule failed validation.', issues: parsed.error.issues };
          }
          // A dangerous, live rule needs approval per automations.approvalMode.
          if (parsed.data.enabled && isDangerousRule(parsed.data)) {
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
          const parsed = automationRuleSchema.safeParse(merged);
          if (!parsed.success) {
            return { error: 'Updated rule failed validation.', issues: parsed.error.issues };
          }
          // Approval is needed if the RESULT is a dangerous live rule, or if we
          // are editing an already-dangerous rule (so the agent can't quietly
          // rewrite a user-configured shell/hook rule).
          const needsApproval = (parsed.data.enabled && isDangerousRule(parsed.data)) || isDangerousRule(prev);
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
