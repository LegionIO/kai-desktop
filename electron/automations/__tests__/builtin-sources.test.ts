/**
 * Tests for registerBuiltinSources (electron/automations/builtin-sources.ts) —
 * the built-in automation event catalog (app / hook / conversation sources). A
 * bug drops a built-in trigger or ships a malformed payloadSchema that breaks
 * the event-bus validator (compileValidator → convertJsonSchemaToZod). Registered
 * into a REAL AutomationEventBus so the schemas are compiled for real on emit.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../utils/window-send.js', () => ({ broadcastToAllWindows: vi.fn() }));

import { AutomationEventBus } from '../event-bus.js';
import { registerBuiltinSources } from '../builtin-sources.js';

let bus: AutomationEventBus;
beforeEach(() => {
  bus = new AutomationEventBus();
  registerBuiltinSources(bus);
});

describe('registerBuiltinSources — catalog', () => {
  it('registers the app, hook, and conversation sources', () => {
    const sources = bus
      .getCatalog()
      .map((e) => e.source)
      .sort();
    expect(sources).toEqual(['app', 'conversation', 'hook']);
  });

  it('declares the expected events per source, each with a title', () => {
    const bySource = new Map(bus.getCatalog().map((e) => [e.source, e]));

    expect(
      bySource
        .get('app')!
        .events.map((e) => e.event)
        .sort(),
    ).toEqual(['config-changed', 'ready']);
    expect(
      bySource
        .get('hook')!
        .events.map((e) => e.event)
        .sort(),
    ).toEqual(
      ['AgentStop', 'AssistantMessage', 'ConversationStart', 'PostToolUse', 'PreToolUse', 'UserPromptSubmit'].sort(),
    );
    expect(
      bySource
        .get('conversation')!
        .events.map((e) => e.event)
        .sort(),
    ).toEqual(['created', 'updated']);

    // Every declared event carries a human-readable title.
    for (const entry of bus.getCatalog()) {
      for (const ev of entry.events) {
        expect(typeof ev.title).toBe('string');
        expect(ev.title.length).toBeGreaterThan(0);
      }
    }
  });
});

describe('registerBuiltinSources — payload schemas compile + validate', () => {
  it('emits a schema-matching payload without throwing (validator compiles + passes)', () => {
    expect(() =>
      bus.emit('hook', 'UserPromptSubmit', { conversationId: 'c1', messages: [{ role: 'user' }] }),
    ).not.toThrow();
    expect(() => bus.emit('app', 'config-changed', { changedKeys: ['models.defaultModelKey'] })).not.toThrow();
  });

  it('every declared event schema compiles without throwing on emit (empty + populated payloads)', () => {
    for (const entry of bus.getCatalog()) {
      for (const ev of entry.events) {
        // An empty payload: the validator compiles (from the declared schema);
        // a non-match logs a warning but must NEVER throw out of emit.
        expect(() => bus.emit(entry.source, ev.event, {})).not.toThrow();
        // A garbage payload likewise must not throw.
        expect(() => bus.emit(entry.source, ev.event, { unexpected: 123 })).not.toThrow();
      }
    }
  });

  it('an event with no declared payloadSchema still emits cleanly', () => {
    // app:ready has no payloadSchema — emit must be a clean no-validator path.
    expect(() => bus.emit('app', 'ready', undefined)).not.toThrow();
  });
});
