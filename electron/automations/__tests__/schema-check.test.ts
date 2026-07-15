import { describe, expect, it, vi } from 'vitest';

vi.mock('../../utils/window-send.js', () => ({ broadcastToAllWindows: () => 0 }));

import type { AutomationRule } from '../../config/schema.js';
import { AutomationEventBus } from '../event-bus.js';
import { flattenSchemaPaths, validateRulePaths } from '../schema-check.js';

const teamsSchema = {
  type: 'object',
  required: ['from'],
  properties: {
    from: { type: 'object', properties: { email: { type: 'string' }, displayName: { type: 'string' } } },
    body: { type: 'string' },
  },
};

const catalog = [
  {
    source: 'plugin.teams',
    displayName: 'Teams',
    events: [{ event: 'message-received', title: 'msg', payloadSchema: teamsSchema }],
    actions: [{ targetId: 'send-reply', title: 'Reply' }],
  },
];

function rule(over: Partial<AutomationRule> = {}): AutomationRule {
  return {
    id: 'r',
    name: 'r',
    enabled: true,
    trigger: { source: 'plugin.teams', event: 'message-received' },
    conditions: [],
    conditionMode: 'all',
    actions: [{ type: 'notification', title: 't' }],
    debounceMs: 0,
    ...over,
  };
}

describe('flattenSchemaPaths', () => {
  it('flattens nested object properties', () => {
    expect(flattenSchemaPaths(teamsSchema)).toEqual(['from', 'from.email', 'from.displayName', 'body']);
  });
});

describe('validateRulePaths', () => {
  it('no warnings for known paths', () => {
    expect(
      validateRulePaths(
        rule({ conditions: [{ path: 'from.email', op: 'equals', value: 'x', caseSensitive: false }] }),
        catalog,
      ),
    ).toEqual([]);
  });

  it('accepts wildcard "*" source without warnings (matches all sources)', () => {
    // A "*" source has no single catalog entry; must not warn "not in catalog".
    expect(
      validateRulePaths(
        rule({
          trigger: { source: '*', event: '*' },
          conditions: [{ path: 'anything.at.all', op: 'exists', value: '', caseSensitive: false }],
        }),
        catalog,
      ),
    ).toEqual([]);
  });

  it('accepts wildcard "*" event on a real source without warnings', () => {
    expect(validateRulePaths(rule({ trigger: { source: 'plugin.teams', event: '*' } }), catalog)).toEqual([]);
  });

  it('warns with suggestion for typo', () => {
    const w = validateRulePaths(
      rule({ conditions: [{ path: 'fromEmail', op: 'equals', value: 'x', caseSensitive: false }] }),
      catalog,
    );
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/fromEmail/);
    expect(w[0]).toMatch(/from\.email/);
  });

  it('warns on unknown source', () => {
    const w = validateRulePaths(rule({ trigger: { source: 'plugin.nope', event: 'x' } }), catalog);
    expect(w[0]).toMatch(/not in the event catalog/);
  });

  it('warns on unknown event', () => {
    const w = validateRulePaths(rule({ trigger: { source: 'plugin.teams', event: 'nope' } }), catalog);
    expect(w[0]).toMatch(/not declared by Teams/);
  });

  it('warns on undeclared plugin-action targetId', () => {
    const w = validateRulePaths(
      rule({ actions: [{ type: 'plugin-action', pluginName: 'teams', targetId: 'bogus', action: 'a' }] }),
      catalog,
    );
    expect(w[0]).toMatch(/bogus/);
  });

  it('validates plugin-action even when trigger event has no payloadSchema', () => {
    const cat = [
      { source: 'app', displayName: 'App', events: [{ event: 'ready', title: 'ready' }], actions: [] },
      catalog[0],
    ];
    const w = validateRulePaths(
      rule({
        trigger: { source: 'app', event: 'ready' },
        actions: [{ type: 'plugin-action', pluginName: 'teams', targetId: 'bogus', action: 'a' }],
      }),
      cat,
    );
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/bogus/);
  });

  it('warns when plugin declares zero actions', () => {
    const cat = [{ ...catalog[0], actions: [] }];
    const w = validateRulePaths(
      rule({ actions: [{ type: 'plugin-action', pluginName: 'teams', targetId: 'send-reply', action: 'a' }] }),
      cat,
    );
    expect(w[0]).toMatch(/\(none\)/);
  });

  it('warns on descendant of scalar field', () => {
    const w = validateRulePaths(
      rule({ conditions: [{ path: 'body.text', op: 'equals', value: 'x', caseSensitive: false }] }),
      catalog,
    );
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/body\.text/);
  });
});

describe('emit-time schema check', () => {
  it('warns when payload is missing required field', () => {
    const bus = new AutomationEventBus();
    bus.registerSource(catalog[0]);
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    bus.emit('plugin.teams', 'message-received', { body: 'no from' });
    expect(spy).toHaveBeenCalled();
    expect(spy.mock.calls[0].join(' ')).toMatch(/does not match declared schema/);
    spy.mockRestore();
  });

  it('warns when payload shares zero declared keys', () => {
    const bus = new AutomationEventBus();
    bus.registerSource({
      ...catalog[0],
      events: [
        {
          event: 'message-received',
          title: 'msg',
          payloadSchema: { type: 'object', properties: { from: { type: 'string' }, body: { type: 'string' } } },
        },
      ],
    });
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    bus.emit('plugin.teams', 'message-received', { fromEmail: 'x' });
    expect(spy).toHaveBeenCalled();
    expect(spy.mock.calls[0].join(' ')).toMatch(/none of the declared fields/);
    spy.mockRestore();
  });

  it('silent when payload matches', () => {
    const bus = new AutomationEventBus();
    bus.registerSource(catalog[0]);
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    bus.emit('plugin.teams', 'message-received', { from: { email: 'a@b' }, body: 'hi' });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('silent for undeclared events', () => {
    const bus = new AutomationEventBus();
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    bus.emit('plugin.teams', 'undeclared', { anything: true });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
