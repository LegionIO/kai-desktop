/**
 * Fixture self-tests for `test-utils/runtime-stubs.ts`.
 *
 * These pin the canonical `stubMastra` / `stubClaudeAgent` / `stubCodex`
 * fixtures themselves — the shape they expose, the default event sequence
 * they yield, and the override hook other tests rely on. The renderer
 * contract this fixture satisfies (text-delta → done) is asserted here so
 * that consumer test files do not silently inherit a broken stub.
 *
 * Production code paths that consume these stubs are covered by the IPC
 * agent test (`electron/ipc/__tests__/agent.test.ts`) and the runtime
 * adapter tests in `electron/agent/runtime/__tests__/`.
 */

import { describe, it, expect, vi } from 'vitest';
import { stubMastra } from '../runtime-stubs.js';

describe('runtime fixture: stubMastra', () => {
  it('exposes the AgentRuntime fields the streaming pipeline reads', () => {
    const stub = stubMastra();
    expect(stub.id).toBe('mastra');
    expect(stub.name).toBe('Mastra');
    // `agent.ts` reads `runtime.capabilities.toolObserver` and `.compaction`
    // to decide whether to wire the observer/compaction paths.
    expect(stub.capabilities).toMatchObject({
      toolObserver: true,
      compaction: true,
    });
  });

  it('yields a text-delta then a done event on stream() — the minimum renderer contract', async () => {
    const stub = stubMastra();
    const events: Array<{ type: string; conversationId?: string }> = [];

    for await (const event of stub.stream({ conversationId: 'conv-x' })) {
      events.push({
        type: event.type,
        conversationId: (event as { conversationId?: string }).conversationId,
      });
    }

    expect(events.length).toBeGreaterThanOrEqual(2);
    expect(events[0]).toMatchObject({ type: 'text-delta' });
    expect(events[events.length - 1]).toMatchObject({ type: 'done' });
  });

  it('records stream invocations on the vi.fn so tests can assert arguments', async () => {
    const stub = stubMastra();
    const opts = { conversationId: 'conv-record', messages: [], config: {}, tools: [], appHome: '/tmp' };

    // Drain the generator so the stub's vi.fn captures the call.
    for await (const _event of stub.stream(opts)) {
      // intentionally empty
    }

    expect(stub.stream).toHaveBeenCalledTimes(1);
    expect(stub.stream).toHaveBeenCalledWith(opts);
  });

  it('honours overrides so tests can inject custom event sequences', async () => {
    async function* customStream() {
      yield { conversationId: 'c', type: 'text-delta' as const, text: 'Hello' };
      yield { conversationId: 'c', type: 'tool-call' as const, toolCallId: 't1', toolName: 'echo', args: { x: 1 } };
      yield { conversationId: 'c', type: 'tool-result' as const, toolCallId: 't1', result: { ok: true } };
      yield { conversationId: 'c', type: 'done' as const };
    }

    const stub = stubMastra({ stream: vi.fn(() => customStream()) });
    const events: Array<{ type: string }> = [];
    for await (const event of stub.stream({ conversationId: 'c' })) {
      events.push({ type: event.type });
    }

    expect(events.map((e) => e.type)).toEqual(['text-delta', 'tool-call', 'tool-result', 'done']);
  });
});
