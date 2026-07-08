import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { eventBus } from '../automations/event-bus.js';
import { getAutomationEngine } from '../automations/engine.js';
import { validateRulePaths } from '../automations/schema-check.js';
import type { AutomationRule } from '../config/schema.js';
import { automationRuleSchema } from '../config/schema.js';
import { getRegisteredTools, getWorkspaceToolDefinitions } from '../ipc/agent.js';
import { readEffectiveConfig, writeDesktopConfig } from '../ipc/config.js';
import type { ToolDefinition, ToolExecutionContext } from './types.js';

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
          if (parsed.data.actions.some((a) => a.type === 'runHookCommand')) {
            return {
              error:
                'runHookCommand actions execute arbitrary shell without guardrails and can only be configured by the user in Settings → Automations.',
            };
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
          if (
            parsed.data.actions.some((a) => a.type === 'runHookCommand') ||
            prev.actions.some((a) => a.type === 'runHookCommand')
          ) {
            return {
              error:
                'Rules containing runHookCommand actions execute arbitrary shell without guardrails and can only be configured by the user in Settings → Automations.',
            };
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
          persist(rules.filter((_, i) => i !== idx));
          return { success: true, deleted: summarizeRule(removed) };
        }

        case 'enable':
        case 'disable': {
          const idx = findIndex();
          if (idx < 0) return { error: id ? `Rule "${id}" not found.` : 'id is required.' };
          const next = [...rules];
          next[idx] = { ...next[idx], enabled: action === 'enable' };
          persist(next);
          return { success: true, id, enabled: action === 'enable' };
        }

        case 'test': {
          const idx = findIndex();
          if (idx < 0) return { error: id ? `Rule "${id}" not found.` : 'id is required.' };
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
