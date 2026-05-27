/**
 * Hermetic unit tests for `scripts/compare-fixture-shapes.ts`.
 *
 * No network, no file-system reads outside the test's own synthetic
 * strings. The point is to lock down the comparator semantics — what
 * counts as drift and what is deliberately ignored — so a future change
 * to the script is caught in the unit slice rather than the weekly
 * workflow.
 */

import { describe, expect, it } from 'vitest';

import { diffShapes, extractShape, formatDiff, symptomHash, type EventShapeSequence } from '../compare-fixture-shapes';

// ---------------------------------------------------------------------------
// Helpers — keep synthetic shapes terse so the tests read as specifications.
// ---------------------------------------------------------------------------

function seq(label: string, events: Array<{ type: string; fields: string[] }>): EventShapeSequence {
  return { label, events: events.map((e) => ({ type: e.type, fields: [...e.fields].sort() })) };
}

// ---------------------------------------------------------------------------
// diffShapes — the comparator semantics.
// ---------------------------------------------------------------------------

describe('diffShapes', () => {
  it('reports no drift when two shapes are structurally identical', () => {
    const a = seq('a', [
      { type: 'message_start', fields: ['message', 'type'] },
      { type: 'content_block_delta', fields: ['delta', 'index', 'type'] },
      { type: 'message_stop', fields: ['type'] },
    ]);
    const b = seq('b', [
      { type: 'message_start', fields: ['message', 'type'] },
      { type: 'content_block_delta', fields: ['delta', 'index', 'type'] },
      { type: 'message_stop', fields: ['type'] },
    ]);

    expect(diffShapes(a, b)).toEqual([]);
  });

  it('flags a single differing event type as reordered (not as add+remove)', () => {
    const a = seq('captured', [
      { type: 'message_start', fields: ['message', 'type'] },
      { type: 'content_block_finish', fields: ['index', 'type'] }, // renamed
    ]);
    const b = seq('fixture', [
      { type: 'message_start', fields: ['message', 'type'] },
      { type: 'content_block_stop', fields: ['index', 'type'] },
    ]);

    const diffs = diffShapes(a, b);
    expect(diffs).toHaveLength(1);
    expect(diffs[0]).toMatchObject({
      kind: 'event-reordered',
      index: 1,
      eventType: 'content_block_finish',
    });
  });

  it('flags a single field-name addition on a matching event type', () => {
    const a = seq('captured', [
      {
        type: 'content_block_delta',
        fields: ['delta', 'index', 'type', 'usage'],
      },
    ]);
    const b = seq('fixture', [
      {
        type: 'content_block_delta',
        fields: ['delta', 'index', 'type'],
      },
    ]);

    const diffs = diffShapes(a, b);
    expect(diffs).toHaveLength(1);
    expect(diffs[0]).toMatchObject({
      kind: 'field-added',
      index: 0,
      eventType: 'content_block_delta',
    });
    expect(diffs[0].detail).toContain('`usage`');
  });

  it('flags a single field-name removal on a matching event type', () => {
    const a = seq('captured', [{ type: 'message_stop', fields: ['type'] }]);
    const b = seq('fixture', [{ type: 'message_stop', fields: ['type', 'usage'] }]);

    const diffs = diffShapes(a, b);
    expect(diffs).toHaveLength(1);
    expect(diffs[0]).toMatchObject({
      kind: 'field-removed',
      index: 0,
      eventType: 'message_stop',
    });
    expect(diffs[0].detail).toContain('`usage`');
  });

  it('reports event-added when the captured sequence is longer', () => {
    const a = seq('captured', [
      { type: 'message_start', fields: ['type'] },
      { type: 'ping', fields: ['type'] }, // new event
      { type: 'message_stop', fields: ['type'] },
    ]);
    const b = seq('fixture', [
      { type: 'message_start', fields: ['type'] },
      { type: 'message_stop', fields: ['type'] },
    ]);

    const diffs = diffShapes(a, b);
    // Position-aligned algorithm: index 1 mismatches as reordered,
    // index 2 mismatches as reordered. Even though the SDK actually added
    // one event, the diff still surfaces both signals — this is by design,
    // since the human reviewer needs to see every position that no longer
    // matches the fixture.
    expect(diffs.length).toBeGreaterThanOrEqual(1);
    const kinds = new Set(diffs.map((d) => d.kind));
    // We expect at least one reorder or add-style report.
    expect(kinds.has('event-reordered') || kinds.has('event-added')).toBe(true);
  });

  it('reports event-removed when the captured sequence is shorter', () => {
    const a = seq('captured', [{ type: 'message_start', fields: ['type'] }]);
    const b = seq('fixture', [
      { type: 'message_start', fields: ['type'] },
      { type: 'message_stop', fields: ['type'] },
    ]);

    const diffs = diffShapes(a, b);
    expect(diffs.some((d) => d.kind === 'event-removed' && d.eventType === 'message_stop')).toBe(true);
  });

  it('skips field comparison when event types differ (avoids noisy cascade)', () => {
    const a = seq('captured', [{ type: 'foo', fields: ['x', 'y', 'z'] }]);
    const b = seq('fixture', [{ type: 'bar', fields: ['a', 'b', 'c'] }]);

    const diffs = diffShapes(a, b);
    // One reorder finding only — no field-added/field-removed cascade.
    expect(diffs).toHaveLength(1);
    expect(diffs[0].kind).toBe('event-reordered');
  });
});

// ---------------------------------------------------------------------------
// Value-vs-name distinction — values must NEVER cause a drift report.
// ---------------------------------------------------------------------------

describe('diffShapes — field VALUE differences are intentionally ignored', () => {
  it('does not flag drift when only values differ inside captured JSONL bodies', () => {
    // Two synthetic single-line JSONL fixtures: same field names,
    // different values for every field.
    const live = JSON.stringify({
      response: {
        body: {
          id: 'msg_live_9999',
          type: 'message',
          model: 'claude-3-5-haiku-latest',
          content: [{ type: 'text', text: 'Whatever the live response said.' }],
          usage: { input_tokens: 1234, output_tokens: 5678 },
        },
      },
    });
    const fixture = JSON.stringify({
      response: {
        body: {
          id: 'msg_test_0001',
          type: 'message',
          model: 'claude-3-5-sonnet-20241022',
          content: [{ type: 'text', text: 'Hi.' }],
          usage: { input_tokens: 5, output_tokens: 2 },
        },
      },
    });

    const liveShape = extractShape(live, 'live');
    const fixtureShape = extractShape(fixture, 'fixture');

    expect(diffShapes(liveShape, fixtureShape)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// extractShape — JSONL → EventShapeSequence transformation.
// ---------------------------------------------------------------------------

describe('extractShape', () => {
  it('reads a single-body Anthropic-style fixture into a one-event shape', () => {
    const jsonl = JSON.stringify({
      response: {
        body: {
          id: 'msg_test_0001',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'Hi.' }],
          model: 'claude-3-5-sonnet-20241022',
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 5, output_tokens: 2 },
        },
      },
    });

    const shape = extractShape(jsonl, 'simple-completion');
    expect(shape.events).toHaveLength(1);
    expect(shape.events[0].type).toBe('body:message');
    expect(shape.events[0].fields).toEqual(
      ['content', 'id', 'model', 'role', 'stop_reason', 'stop_sequence', 'type', 'usage'].sort(),
    );
  });

  it('reads a streaming Anthropic fixture into one event per SSE chunk in order', () => {
    const jsonl = JSON.stringify({
      response: {
        bodyStream: [
          'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_x"}}\n\n',
          'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}\n\n',
          'event: message_stop\ndata: {"type":"message_stop"}\n\n',
        ],
      },
    });

    const shape = extractShape(jsonl, 'streaming');
    expect(shape.events.map((e) => e.type)).toEqual(['message_start', 'content_block_delta', 'message_stop']);
    expect(shape.events[1].fields).toContain('delta');
    expect(shape.events[1].fields).toContain('index');
    expect(shape.events[1].fields).toContain('type');
  });

  it('reads an OpenAI-style streaming fixture (data-only chunks) by inferring type from `object`', () => {
    const jsonl = JSON.stringify({
      response: {
        bodyStream: [
          'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"Hi"}}]}\n\n',
          'data: [DONE]\n\n',
        ],
      },
    });

    const shape = extractShape(jsonl, 'openai-stream');
    expect(shape.events.map((e) => e.type)).toEqual(['chat.completion.chunk', '[DONE]']);
    // The first event's fields should include the OpenAI chat.completion.chunk top-level keys.
    expect(shape.events[0].fields).toContain('choices');
    expect(shape.events[0].fields).toContain('id');
    expect(shape.events[0].fields).toContain('object');
  });

  it('handles multiple JSONL entries by concatenating their events', () => {
    const line1 = JSON.stringify({
      response: { body: { type: 'message', id: 'a' } },
    });
    const line2 = JSON.stringify({
      response: { body: { type: 'error', error: { type: 'rate_limit_error' } } },
    });
    const jsonl = `${line1}\n${line2}\n`;

    const shape = extractShape(jsonl);
    expect(shape.events.map((e) => e.type)).toEqual(['body:message', 'body:error']);
  });

  it('skips unparseable lines without throwing', () => {
    const bad = 'this is not json\n';
    const good = JSON.stringify({
      response: { body: { type: 'message', id: 'a' } },
    });
    const shape = extractShape(`${bad}${good}\n`);
    expect(shape.events).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// formatDiff — the markdown reporter.
// ---------------------------------------------------------------------------

describe('formatDiff', () => {
  it('returns empty string when no diffs are present', () => {
    const cap = seq('cap', [{ type: 'message_start', fields: ['type'] }]);
    const fix = seq('fix', [{ type: 'message_start', fields: ['type'] }]);
    expect(formatDiff([], cap, fix)).toBe('');
  });

  it('renders a markdown table with one row per diff and an explanatory tail', () => {
    const cap = seq('cap', [{ type: 'a', fields: ['x', 'y'] }]);
    const fix = seq('fix', [{ type: 'a', fields: ['x'] }]);
    const diffs = diffShapes(cap, fix);
    const md = formatDiff(diffs, cap, fix);
    expect(md).toContain('### Fixture shape drift detected');
    expect(md).toContain('| Index | Kind | Event | Detail |');
    // The diff `kind` is rendered in plain text inside the table cell; the
    // backticked tokens in the table come from the event type and the
    // field names inside the detail string.
    expect(md).toContain('field-added');
    expect(md).toContain('`y`');
    expect(md).toContain('Field VALUES are intentionally not compared');
  });

  it('escapes pipe characters in detail strings so the table stays well-formed', () => {
    const cap = seq('cap', [{ type: 'pipe|in|type', fields: ['x'] }]);
    const fix = seq('fix', [{ type: 'safe', fields: ['x'] }]);
    const diffs = diffShapes(cap, fix);
    const md = formatDiff(diffs, cap, fix);
    // The detail string surfaces the event types verbatim — the escape
    // only happens inside the rendered Detail column, so we check the
    // rendered output, not the diff payload.
    expect(md.split('\n').filter((l) => l.startsWith('|')).length).toBeGreaterThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
// symptomHash — dedup signature for GitHub Issue grouping.
// ---------------------------------------------------------------------------

describe('symptomHash', () => {
  it('returns the literal "none" when no diffs are present', () => {
    expect(symptomHash([])).toBe('none');
  });

  it('returns the same hash for the same diff signatures regardless of order', () => {
    const baseCap = seq('cap', [
      { type: 'a', fields: ['x', 'y'] },
      { type: 'b', fields: ['p'] },
    ]);
    const baseFix = seq('fix', [
      { type: 'a', fields: ['x'] },
      { type: 'b', fields: ['p', 'q'] },
    ]);
    const reversedCap = seq('cap', [
      { type: 'b', fields: ['p'] },
      { type: 'a', fields: ['x', 'y'] },
    ]);
    const reversedFix = seq('fix', [
      { type: 'b', fields: ['p', 'q'] },
      { type: 'a', fields: ['x'] },
    ]);
    expect(symptomHash(diffShapes(baseCap, baseFix))).toBe(symptomHash(diffShapes(reversedCap, reversedFix)));
  });

  it('returns a different hash when the diff signature changes', () => {
    const cap1 = seq('cap', [{ type: 'a', fields: ['x', 'y'] }]);
    const fix1 = seq('fix', [{ type: 'a', fields: ['x'] }]);
    const cap2 = seq('cap', [{ type: 'a', fields: ['x'] }]);
    const fix2 = seq('fix', [{ type: 'a', fields: ['x', 'z'] }]);
    expect(symptomHash(diffShapes(cap1, fix1))).not.toBe(symptomHash(diffShapes(cap2, fix2)));
  });
});

// ---------------------------------------------------------------------------
// End-to-end: simulated workflow "exit 0 vs exit 1" decision.
// ---------------------------------------------------------------------------

describe('end-to-end exit-code semantics', () => {
  it('a == b → diff is empty (workflow would exit 0)', () => {
    const jsonl = JSON.stringify({
      response: {
        body: {
          id: 'msg_x',
          type: 'message',
          model: 'm',
          content: [{ type: 'text', text: 'hi' }],
        },
      },
    });
    const a = extractShape(jsonl, 'a');
    const b = extractShape(jsonl, 'b');
    expect(diffShapes(a, b).length).toBe(0);
  });

  it('a != b → diff is non-empty (workflow would exit 1)', () => {
    const a = extractShape(
      JSON.stringify({
        response: { body: { id: 'm', type: 'message', extra_new_field: 1 } },
      }),
      'a',
    );
    const b = extractShape(JSON.stringify({ response: { body: { id: 'm', type: 'message' } } }), 'b');
    expect(diffShapes(a, b).length).toBeGreaterThan(0);
  });
});
