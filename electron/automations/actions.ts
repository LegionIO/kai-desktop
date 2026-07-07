import { randomUUID } from 'node:crypto';
import { Notification } from 'electron';
import { generateForPlugin } from '../agent/plugin-generate.js';
import type { AppConfig, AutomationAction, AutomationRule } from '../config/schema.js';
import {
  appendConversationMessages,
  broadcastConversationChange,
  ensureConversationTree,
  getConversationBranch,
  readConversationStore,
  writeConversationStore,
} from '../ipc/conversations.js';
import type { PluginActionPayload } from '../plugins/types.js';
import type { ToolDefinition } from '../tools/types.js';
import { getPath } from './conditions.js';
import type { AutomationEventBus } from './event-bus.js';
import type { AutomationActionResult, AutomationEvent, AutomationRunRecord } from './types.js';

export type ActionDeps = {
  bus: AutomationEventBus;
  appHome: string;
  getConfig: () => AppConfig;
  getRegisteredTools: () => ToolDefinition[];
  getWorkspaceTools: () => ToolDefinition[];
  handlePluginAction: (payload: PluginActionPayload) => Promise<unknown>;
};

type InterpolationCtx = { payload: unknown; result: unknown[]; source?: string; event?: string };

const inFlightAutomationTargets = new Set<string>();

const TEMPLATE_RE = /\{\{\s*([^}]+?)\s*\}\}/g;

export function interpolateString(template: string, ctx: InterpolationCtx): string {
  return template.replace(TEMPLATE_RE, (_, path: string) => {
    const value = getPath(ctx, path.trim());
    if (value === undefined || value === null) return '';
    return typeof value === 'string' ? value : JSON.stringify(value);
  });
}

function interpolateDeep<T>(value: T, ctx: InterpolationCtx): T {
  if (typeof value === 'string') return interpolateString(value, ctx) as T;
  if (Array.isArray(value)) return value.map((v) => interpolateDeep(v, ctx)) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = interpolateDeep(v, ctx);
    return out as T;
  }
  return value;
}

function createAutomationConversation(
  appHome: string,
  rule: AutomationRule,
  action: Extract<AutomationAction, { type: 'agent' }>,
  title: string,
  singleton: boolean,
): string {
  const now = new Date().toISOString();
  const id = `auto-${randomUUID()}`;
  const store = readConversationStore(appHome);
  store.conversations[id] = {
    id,
    title,
    fallbackTitle: title,
    messages: [],
    messageTree: [],
    headId: null,
    conversationCompaction: null,
    lastContextUsage: null,
    createdAt: now,
    updatedAt: now,
    lastMessageAt: null,
    titleStatus: 'ready',
    titleUpdatedAt: now,
    messageCount: 0,
    userMessageCount: 0,
    runStatus: 'idle',
    hasUnread: true,
    lastAssistantUpdateAt: null,
    selectedModelKey: action.modelKey ?? null,
    selectedProfileKey: action.profileKey ?? null,
    metadata: { automationRuleId: rule.id, automationSingleton: singleton },
  };
  writeConversationStore(appHome, store);
  broadcastConversationChange(store);
  return id;
}

function resolveConversationTarget(
  action: Extract<AutomationAction, { type: 'agent' }>,
  rule: AutomationRule,
  appHome: string,
  title: string,
): { targetId: string; created: boolean } | null {
  const target = action.conversationTarget;
  if (target.type === 'per-invocation') return null;

  const store = readConversationStore(appHome);
  const isBusy = (c: { id: string; runStatus?: string }) =>
    c.runStatus === 'running' || c.runStatus === 'awaiting-approval' || inFlightAutomationTargets.has(c.id);

  if (target.type === 'existing') {
    const conv = store.conversations[target.conversationId];
    if (!conv) {
      console.warn(
        `[automations] rule "${rule.name}" targets missing conversation ${target.conversationId}; creating a new one`,
      );
      return null;
    }
    if (isBusy(conv)) {
      console.warn(
        `[automations] rule "${rule.name}" target ${target.conversationId} is busy (${conv.runStatus}); diverting`,
      );
      return null;
    }
    return { targetId: target.conversationId, created: false };
  }

  for (const conv of Object.values(store.conversations)) {
    const meta = conv.metadata as { automationRuleId?: unknown; automationSingleton?: unknown } | undefined;
    if (meta?.automationRuleId === rule.id && meta?.automationSingleton === true) {
      if (isBusy(conv)) {
        console.warn(`[automations] rule "${rule.name}" singleton ${conv.id} is busy (${conv.runStatus}); diverting`);
        return null;
      }
      return { targetId: conv.id, created: false };
    }
  }
  // Reserve the singleton synchronously so concurrent first-runs converge on one id.
  return { targetId: createAutomationConversation(appHome, rule, action, title, true), created: true };
}

async function runAgentAction(
  action: Extract<AutomationAction, { type: 'agent' }>,
  ctx: InterpolationCtx,
  rule: AutomationRule,
  event: AutomationEvent,
  deps: ActionDeps,
): Promise<unknown> {
  const config = deps.getConfig();
  const prompt = interpolateString(action.prompt, ctx);
  const tools = action.tools ? deps.getRegisteredTools() : [];
  const title = action.conversationTitle ? interpolateString(action.conversationTitle, ctx) : rule.name;

  const resolved = action.mode === 'conversation' ? resolveConversationTarget(action, rule, deps.appHome, title) : null;
  const targetId = resolved?.targetId ?? null;
  if (targetId) inFlightAutomationTargets.add(targetId);

  try {
    let messages: Array<{ role: string; content: unknown }> = [{ role: 'user', content: prompt }];
    let historyHeadId: string | null | undefined;
    if (targetId) {
      const existing = readConversationStore(deps.appHome).conversations[targetId];
      if (existing) {
        const { tree, headId } = ensureConversationTree(existing);
        historyHeadId = headId;
        if (action.includeHistory) {
          const branch = getConversationBranch(tree, headId);
          const HISTORY_PART_TYPES = new Set(['text', 'image']);
          const history = branch
            .map((m) => ({
              role: m.role,
              content: Array.isArray(m.content)
                ? (m.content as Array<{ type?: unknown }>).filter(
                    (p) => typeof p?.type === 'string' && HISTORY_PART_TYPES.has(p.type),
                  )
                : m.content,
            }))
            .filter((m) => (Array.isArray(m.content) ? m.content.length > 0 : Boolean(m.content)))
            .slice(-40);
          messages = [...history, { role: 'user', content: prompt }];
        }
      }
    }

    const result = await generateForPlugin({
      messages,
      config,
      appHome: deps.appHome,
      conversationId: targetId ?? undefined,
      modelKey: action.modelKey,
      profileKey: action.profileKey,
      tools,
    });

    if (action.mode !== 'conversation') {
      return { text: result.text, modelKey: result.modelKey, toolCalls: result.toolCalls };
    }

    const exchange = [
      { role: 'user' as const, content: [{ type: 'text', text: prompt }], createdAt: new Date().toISOString() },
      {
        role: 'assistant' as const,
        content: [{ type: 'text', text: result.text }],
        createdAt: new Date().toISOString(),
      },
    ];

    let conversationId = targetId ?? createAutomationConversation(deps.appHome, rule, action, title, false);
    let created = !targetId || (resolved?.created ?? false);
    let appended = appendConversationMessages(deps.appHome, conversationId, exchange, {
      skipIfBusy: true,
      parentId: historyHeadId,
    });
    if (!appended) {
      console.warn(
        `[automations] rule "${rule.name}" target ${conversationId} is busy or was deleted mid-run; diverting to a new conversation`,
      );
      conversationId = createAutomationConversation(deps.appHome, rule, action, title, false);
      created = true;
      appended = appendConversationMessages(deps.appHome, conversationId, exchange);
    }

    const emittedTitle = appended?.title ?? appended?.fallbackTitle ?? title;
    deps.bus.emit(
      'conversation',
      created ? 'created' : 'updated',
      { id: conversationId, title: emittedTitle },
      event.depth + 1,
    );
    return { text: result.text, modelKey: result.modelKey, toolCalls: result.toolCalls, conversationId };
  } finally {
    if (targetId) inFlightAutomationTargets.delete(targetId);
  }
}

async function runSingleAction(
  action: AutomationAction,
  ctx: InterpolationCtx,
  rule: AutomationRule,
  event: AutomationEvent,
  deps: ActionDeps,
): Promise<unknown> {
  switch (action.type) {
    case 'agent':
      return runAgentAction(action, ctx, rule, event, deps);

    case 'plugin-action': {
      const data = action.data ? interpolateDeep(action.data, ctx) : undefined;
      const result = await deps.handlePluginAction({
        pluginName: action.pluginName,
        targetId: action.targetId,
        action: action.action,
        data,
      });
      if (result && typeof result === 'object' && typeof (result as { error?: unknown }).error === 'string') {
        throw new Error(`${action.pluginName}:${action.targetId} → ${(result as { error: string }).error}`);
      }
      return result;
    }

    case 'tool': {
      const tools = [...deps.getRegisteredTools(), ...deps.getWorkspaceTools()];
      const tool = tools.find((t) => t.name === action.toolName || t.aliases?.includes(action.toolName));
      if (!tool) throw new Error(`Tool not found: ${action.toolName}`);
      const input = interpolateDeep(action.input, ctx);
      return tool.execute(input, { toolCallId: `auto-${randomUUID()}` });
    }

    case 'notification': {
      const title = interpolateString(action.title, ctx);
      const body = action.body ? interpolateString(action.body, ctx) : undefined;
      new Notification({ title, body }).show();
      return { title, body };
    }

    case 'emit': {
      const payload = action.payload ? interpolateDeep(action.payload, ctx) : undefined;
      deps.bus.emit(action.source, action.event, payload, event.depth + 1);
      return { emitted: `${action.source}:${action.event}` };
    }
  }
}

export async function executeActions(
  rule: AutomationRule,
  event: AutomationEvent,
  deps: ActionDeps,
): Promise<AutomationRunRecord> {
  const record: AutomationRunRecord = {
    id: randomUUID(),
    ruleId: rule.id,
    ruleName: rule.name,
    ts: Date.now(),
    event: { key: event.key, source: event.source, event: event.event, payload: event.payload },
    matched: true,
    results: [],
  };

  const ctx: InterpolationCtx = { payload: event.payload, result: [], source: event.source, event: event.event };

  for (const action of rule.actions) {
    const started = Date.now();
    try {
      const output = await runSingleAction(action, ctx, rule, event, deps);
      ctx.result.push(output);
      const result: AutomationActionResult = {
        type: action.type,
        ok: true,
        output,
        durationMs: Date.now() - started,
      };
      record.results.push(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.result.push({ error: message });
      record.results.push({
        type: action.type,
        ok: false,
        error: message,
        durationMs: Date.now() - started,
      });
      record.error = record.error ?? message;
    }
  }

  return record;
}
