/**
 * Tests for AutomationEventBus (electron/automations/event-bus.ts) — the dispatch
 * bus that drives automation triggers. A bug means automations don't fire, fire
 * on the wrong event, or a single bad listener breaks the whole fan-out.
 * broadcastToAllWindows is mocked (electron BrowserWindow-free).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const broadcast = vi.fn();
vi.mock('../../utils/window-send.js', () => ({ broadcastToAllWindows: (...a: unknown[]) => broadcast(...a) }));

import { AutomationEventBus } from '../event-bus.js';
import type { SourceCatalogEntry, AutomationEvent } from '../types.js';

let bus: AutomationEventBus;
beforeEach(() => {
  bus = new AutomationEventBus();
  broadcast.mockClear();
});

const source = (name: string): SourceCatalogEntry => ({ source: name, events: [] }) as unknown as SourceCatalogEntry;

describe('source catalog', () => {
  it('registerSource adds to the catalog and broadcasts a catalog-changed', () => {
    bus.registerSource(source('sys'));
    expect(bus.getCatalog().map((e) => e.source)).toEqual(['sys']);
    expect(broadcast).toHaveBeenCalledWith('automations:catalog-changed');
  });

  it('unregisterSource removes it and broadcasts only when it existed', () => {
    bus.registerSource(source('sys'));
    broadcast.mockClear();
    bus.unregisterSource('sys');
    expect(bus.getCatalog()).toEqual([]);
    expect(broadcast).toHaveBeenCalledWith('automations:catalog-changed');

    broadcast.mockClear();
    bus.unregisterSource('never-registered');
    expect(broadcast).not.toHaveBeenCalled(); // no-op when absent
  });
});

describe('subscribe / hasListeners', () => {
  it('reflects listener count and unsubscribe removes the listener', () => {
    expect(bus.hasListeners()).toBe(false);
    const unsub = bus.subscribe(() => {});
    expect(bus.hasListeners()).toBe(true);
    unsub();
    expect(bus.hasListeners()).toBe(false);
  });
});

describe('emit', () => {
  it('builds an AutomationEvent and delivers it to every listener', () => {
    const seen: AutomationEvent[] = [];
    bus.subscribe((e) => seen.push(e));
    bus.subscribe((e) => seen.push(e));
    bus.emit('sys', 'started', { a: 1 }, 2);
    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatchObject({ key: 'sys:started', source: 'sys', event: 'started', payload: { a: 1 }, depth: 2 });
    expect(typeof seen[0].ts).toBe('number');
  });

  it('defaults depth to 0 and payload to undefined', () => {
    let evt: AutomationEvent | null = null;
    bus.subscribe((e) => (evt = e));
    bus.emit('sys', 'tick');
    expect(evt).toMatchObject({ key: 'sys:tick', depth: 0, payload: undefined });
  });

  it('isolates a throwing listener so the others still fire and emit does not throw', () => {
    const good = vi.fn();
    bus.subscribe(() => {
      throw new Error('bad listener');
    });
    bus.subscribe(good);
    expect(() => bus.emit('sys', 'x')).not.toThrow();
    expect(good).toHaveBeenCalledTimes(1);
  });

  it('re-broadcasts a plugin.<name> event on the plugin:event channel with the bare name', () => {
    bus.emit('plugin.my-plugin', 'did-thing', { v: 1 });
    expect(broadcast).toHaveBeenCalledWith('plugin:event', {
      pluginName: 'my-plugin',
      eventName: 'did-thing',
      data: { v: 1 },
    });
  });

  it('does NOT emit plugin:event for a non-plugin source', () => {
    bus.emit('sys', 'started', {});
    expect(broadcast).not.toHaveBeenCalledWith('plugin:event', expect.anything());
  });
});

describe('validator cache invalidation', () => {
  it('re-registering a source clears its cached payload validators', () => {
    // A source declaring a payloadSchema requiring { n: number }.
    const withSchema = (extra: Record<string, unknown>): SourceCatalogEntry =>
      ({
        source: 'sys',
        events: [
          {
            event: 'ping',
            payloadSchema: { type: 'object', properties: { n: { type: 'number' } }, required: ['n'], ...extra },
          },
        ],
      }) as unknown as SourceCatalogEntry;

    bus.registerSource(withSchema({}));
    // Prime the validator cache by emitting once.
    bus.emit('sys', 'ping', { n: 1 });
    // Re-register (schema unchanged shape, but this must invalidate the cache).
    bus.registerSource(withSchema({}));
    // Emitting again must still work (recompiled validator), no throw.
    expect(() => bus.emit('sys', 'ping', { n: 2 })).not.toThrow();
  });
});
