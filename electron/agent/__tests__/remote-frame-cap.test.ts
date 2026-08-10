import { describe, it, expect } from 'vitest';
import { capRemoteEvent, stripRemoteMediaDeep, newRemoteBudget } from '../remote-frame-cap.js';

describe('capRemoteEvent (remote frame-cap for stream/sub-agent events)', () => {
  it('caps a large tool-compaction originalContent', () => {
    const big = 'x'.repeat(5000);
    const out = capRemoteEvent({ type: 'tool-compaction', data: { originalContent: big } }) as {
      data: { originalContent: string };
    };
    expect(out.data.originalContent).toBe('[omitted-in-broadcast]');
  });

  it('leaves a small tool-compaction originalContent untouched (value-equal)', () => {
    const ev = { type: 'tool-compaction', data: { originalContent: 'short' } };
    expect(capRemoteEvent(ev)).toEqual(ev);
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

  it('caps a large string on a NON-tool event (e.g. user-message.text)', () => {
    const out = capRemoteEvent({ type: 'user-message', text: 'a'.repeat(300 * 1024) }) as { text: string };
    expect(out.text).toContain('[truncated-in-broadcast]');
    expect(out.text.length).toBeLessThan(300 * 1024);
  });

  it('leaves a small non-tool event value-equal', () => {
    const ev = { type: 'text-delta', text: 'hi' };
    expect(capRemoteEvent(ev)).toEqual(ev);
  });

  it('enforces a CUMULATIVE frame budget (many individually-small strings cannot exceed it)', () => {
    // 40 strings of 250 KiB each pass the per-string cap (< 256 KiB) but total ~10 MiB — over the
    // frame. The aggregate budget must omit the overflow so the serialized event stays bounded.
    const event = {
      conversationId: 'c',
      type: 'tool-result',
      result: Array.from({ length: 40 }, () => 'x'.repeat(250 * 1024)),
    };
    const capped = capRemoteEvent(event);
    const bytes = Buffer.byteLength(JSON.stringify(capped), 'utf8');
    // Comfortably under the tighter (web 4 MiB) frame limit.
    expect(bytes).toBeLessThan(4 * 1024 * 1024);
    // The tail entries were omitted once the budget was spent.
    expect(JSON.stringify(capped)).toContain('[omitted-in-broadcast]');
  });

  it('bounds a CJK-heavy payload by UTF-8 BYTES, not UTF-16 units', () => {
    // Each CJK char is 1 UTF-16 unit but 3 UTF-8 bytes. Counting units would let ~13×250k-char CJK
    // strings (~3 MiB units but ~10 MiB bytes) pass; the byte budget must still bound the frame.
    const event = {
      conversationId: 'c',
      type: 'tool-result',
      result: Array.from({ length: 20 }, () => '中'.repeat(250 * 1024)),
    };
    const bytes = Buffer.byteLength(JSON.stringify(capRemoteEvent(event)), 'utf8');
    expect(bytes).toBeLessThan(4 * 1024 * 1024);
  });

  it('a SHARED budget bounds many parts together (upsert case)', () => {
    // Simulate the conversation-upsert path: many parts stripped under ONE shared budget must not
    // each get a fresh cap. 40 parts of 250 KiB under one budget stays bounded.
    const budget = newRemoteBudget();
    const parts = Array.from({ length: 40 }, () => stripRemoteMediaDeep('x'.repeat(250 * 1024), budget));
    const bytes = Buffer.byteLength(JSON.stringify(parts), 'utf8');
    expect(bytes).toBeLessThan(4 * 1024 * 1024);
    expect(JSON.stringify(parts)).toContain('[omitted-in-broadcast]');
  });
});
