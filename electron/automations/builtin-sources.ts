import type { AutomationEventBus } from './event-bus.js';

export function registerBuiltinSources(bus: AutomationEventBus): void {
  bus.registerSource({
    source: 'app',
    displayName: 'Application',
    events: [
      { event: 'ready', title: 'App ready', description: 'Main window finished loading' },
      {
        event: 'config-changed',
        title: 'Config changed',
        description: 'Any settings value was updated',
        payloadSchema: { type: 'object', properties: { changedKeys: { type: 'array', items: { type: 'string' } } } },
      },
    ],
    actions: [],
  });

  bus.registerSource({
    source: 'hook',
    displayName: 'Agent lifecycle',
    events: [
      {
        event: 'UserPromptSubmit',
        title: 'User prompt submitted',
        description: 'Fires before the user message is sent to the model',
        payloadSchema: {
          type: 'object',
          properties: { conversationId: { type: 'string' }, messages: { type: 'array' } },
        },
      },
      {
        event: 'PreToolUse',
        title: 'Before tool executes',
        payloadSchema: {
          type: 'object',
          properties: { conversationId: { type: 'string' }, toolName: { type: 'string' }, args: {} },
        },
      },
      {
        event: 'PostToolUse',
        title: 'After tool executes',
        payloadSchema: {
          type: 'object',
          properties: { conversationId: { type: 'string' }, toolName: { type: 'string' }, args: {}, result: {} },
        },
      },
      {
        event: 'AssistantMessage',
        title: 'Assistant turn complete',
        payloadSchema: {
          type: 'object',
          properties: { conversationId: { type: 'string' }, text: { type: 'string' } },
        },
      },
      {
        event: 'AgentStop',
        title: 'Agent run finished',
        payloadSchema: {
          type: 'object',
          properties: { conversationId: { type: 'string' }, aborted: { type: 'boolean' } },
        },
      },
      {
        event: 'ConversationStart',
        title: 'New conversation created',
        payloadSchema: {
          type: 'object',
          properties: { conversationId: { type: 'string' }, title: { type: 'string' } },
        },
      },
    ],
    actions: [],
  });

  bus.registerSource({
    source: 'conversation',
    displayName: 'Conversations',
    events: [
      {
        event: 'created',
        title: 'Conversation created',
        payloadSchema: {
          type: 'object',
          properties: { id: { type: 'string' }, title: { type: 'string' } },
        },
      },
      {
        event: 'updated',
        title: 'Conversation updated (automation append)',
        payloadSchema: {
          type: 'object',
          properties: { id: { type: 'string' }, title: { type: 'string' } },
        },
      },
    ],
    actions: [],
  });
}
