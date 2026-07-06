import { randomUUID } from 'node:crypto';
import { Notification } from 'electron';
import { generateForPlugin } from '../agent/plugin-generate.js';
import type { AppConfig, AutomationAction, AutomationRule } from '../config/schema.js';
import { broadcastConversationChange, readConversationStore, writeConversationStore } from '../ipc/conversations.js';
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

type InterpolationCtx = { payload: unknown; result: unknown[] };

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

  const result = await generateForPlugin({
    messages: [{ role: 'user', content: prompt }],
    config,
    appHome: deps.appHome,
    modelKey: action.modelKey,
    profileKey: action.profileKey,
    tools,
  });

  if (action.mode === 'conversation') {
    const now = new Date().toISOString();
    const id = `auto-${randomUUID()}`;
    const title = action.conversationTitle ? interpolateString(action.conversationTitle, ctx) : rule.name;
    const store = readConversationStore(deps.appHome);
    store.conversations[id] = {
      id,
      title,
      fallbackTitle: title,
      messages: [
        { role: 'user', content: prompt, createdAt: now },
        { role: 'assistant', content: result.text, createdAt: new Date().toISOString() },
      ],
      conversationCompaction: null,
      lastContextUsage: null,
      createdAt: now,
      updatedAt: new Date().toISOString(),
      lastMessageAt: new Date().toISOString(),
      titleStatus: 'ready',
      titleUpdatedAt: now,
      messageCount: 2,
      userMessageCount: 1,
      runStatus: 'idle',
      hasUnread: true,
      lastAssistantUpdateAt: new Date().toISOString(),
      selectedModelKey: action.modelKey ?? null,
      selectedProfileKey: action.profileKey ?? null,
      metadata: { automationRuleId: rule.id },
    };
    writeConversationStore(deps.appHome, store);
    broadcastConversationChange(store);
    deps.bus.emit('conversation', 'created', { id, title }, event.depth + 1);
    return { text: result.text, modelKey: result.modelKey, toolCalls: result.toolCalls, conversationId: id };
  }

  return { text: result.text, modelKey: result.modelKey, toolCalls: result.toolCalls };
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

  const ctx: InterpolationCtx = { payload: event.payload, result: [] };

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
