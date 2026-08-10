import { describe, it, expect } from 'vitest';
import { capRemoteEvent, stripRemoteMediaDeep } from '../remote-frame-cap.js';

describe('capRemoteEvent (remote frame-cap for stream/sub-agent events)', () => {
  it('caps a large tool-compaction originalContent', () => {
    const big = 'x'.repeat(5000);
    const out = capRemoteEvent({ type: 'tool-compaction', data: { originalContent: big } }) as {
      data: { originalContent: string };
    };
    expect(out.data.originalContent).toBe('[omitted-in-broadcast]');
  });

  it('leaves a small tool-compaction originalContent untouched (returns the same object)', () => {
    const ev = { type: 'tool-compaction', data: { originalContent: 'short' } };
    expect(capRemoteEvent(ev)).toBe(ev);
  });

  it('strips a tool-result compaction.originalContent AND nested _modelContent / base64', () => {
    const out = capRemoteEvent({
      type: 'tool-result',
      compaction: { originalContent: 'y'.repeat(9000) },
      result: {
        value: { _modelContent: [{ type: 'image', data: 'z'.repeat(500) }], data: 'q'.repeat(400) },
      },
    }) as { compaction: { originalContent: string }; result: { value: { _modelContent: unknown; data: string } } };
    expect(out.compaction.originalContent).toBe('[omitted-in-broadcast]');
    expect(out.result.value._modelContent).toBe('[omitted-in-broadcast]');
    expect(out.result.value.data).toBe('[omitted-in-broadcast]');
  });

  it('omits (does not pass verbatim) a container past the depth ceiling', () => {
    // Build a chain deeper than the depth cap (8) with media at the bottom.
    let deep: unknown = { _modelContent: ['aaaa'] };
    for (let i = 0; i < 12; i++) deep = { nested: deep };
    const stripped = stripRemoteMediaDeep(deep);
    // The raw media must never survive anywhere in the serialized output, and an omission marker
    // must appear (the depth-exhausted subtree was replaced, not passed verbatim).
    const serialized = JSON.stringify(stripped);
    expect(serialized).not.toContain('aaaa');
    expect(serialized).toContain('[omitted-in-broadcast]');
  });

  it('returns a non-tool event unchanged', () => {
    const ev = { type: 'text-delta', text: 'hi' };
    expect(capRemoteEvent(ev)).toBe(ev);
  });
});
