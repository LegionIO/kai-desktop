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
    ],
    actions: [],
  });
}
