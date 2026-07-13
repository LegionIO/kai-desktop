/**
 * Tests for electron/ipc/usage.ts event-store I/O — the NDJSON append-only log
 * that replaced a single JSON array. The old scheme read-parsed-mutated-
 * rewrote the entire file on EVERY usage event (O(n²) cumulative, ~1s main-
 * process block once large); the log makes recording an O(1) append. These lock:
 *   - NDJSON round-trip (serialize one line per event, parse back),
 *   - recordUsageEvent APPENDS (prior lines untouched — the anti-O(n²) property),
 *   - legacy usage-events.json is migrated in once (history preserved, old file
 *     removed, not double-counted on re-read),
 *   - a torn/corrupt final line after a crash is skipped without losing the rest,
 *   - bucketKey daily/weekly/monthly date bucketing.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { __internal } from '../usage.js';

const {
  serializeEventLine,
  parseEventLines,
  bucketKey,
  readEventStore,
  recordUsageEvent,
  setAppHomeForTest,
  eventLogPath,
  eventStorePath,
} = __internal;

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'kai-usage-'));
  // usage.ts paths are <home>/data/<file>; create the data dir.
  mkdirSync(join(home, 'data'), { recursive: true });
  setAppHomeForTest(home);
});

afterEach(() => {
  setAppHomeForTest(null);
  rmSync(home, { recursive: true, force: true });
});

const evt = (over: Record<string, unknown> = {}) => ({ modality: 'stt' as const, durationSec: 3, ...over });

describe('NDJSON serialize/parse round-trip', () => {
  it('serializes one event to exactly one newline-terminated line', () => {
    const line = serializeEventLine({ id: 'e1', timestamp: 't', modality: 'stt', durationSec: 2 });
    expect(line.endsWith('\n')).toBe(true);
    expect(line.trimEnd().includes('\n')).toBe(false); // single line
    expect(JSON.parse(line)).toMatchObject({ id: 'e1', modality: 'stt' });
  });

  it('parseEventLines skips blank lines and a torn/corrupt final line', () => {
    const good1 = JSON.stringify({ id: 'a', timestamp: 't', modality: 'stt' });
    const good2 = JSON.stringify({ id: 'b', timestamp: 't', modality: 'llm' });
    const text = `${good1}\n\n${good2}\n{"id":"c","modality":`; // last line torn
    const events = parseEventLines(text);
    expect(events.map((e) => e.id)).toEqual(['a', 'b']); // torn 'c' skipped, rest intact
  });
});

describe('recordUsageEvent — append-only', () => {
  it('appends without rewriting prior lines (the anti-O(n2) property)', () => {
    recordUsageEvent(evt({ conversationId: 'c1' }));
    const afterFirst = readFileSync(eventLogPath(), 'utf-8');
    recordUsageEvent(evt({ conversationId: 'c2' }));
    const afterSecond = readFileSync(eventLogPath(), 'utf-8');
    // The second write must PREFIX-preserve the first (pure append, not a rewrite).
    expect(afterSecond.startsWith(afterFirst)).toBe(true);
    const events = readEventStore().events;
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.conversationId)).toEqual(['c1', 'c2']);
    // Each event got a unique id + timestamp.
    expect(events[0].id).not.toBe(events[1].id);
    expect(events[0].timestamp).toBeTruthy();
  });

  it('is a no-op when appHome is unset', () => {
    setAppHomeForTest(null);
    expect(() => recordUsageEvent(evt())).not.toThrow();
    setAppHomeForTest(home);
    expect(readEventStore().events).toHaveLength(0);
  });
});

describe('legacy JSON migration', () => {
  it('folds usage-events.json into the NDJSON log once, preserves history, removes the legacy file', () => {
    // Seed a legacy store.
    const legacy = {
      events: [
        { id: 'old1', timestamp: '2026-01-01T00:00:00.000Z', modality: 'llm', totalTokens: 100 },
        { id: 'old2', timestamp: '2026-01-02T00:00:00.000Z', modality: 'stt', durationSec: 5 },
      ],
    };
    writeFileSync(eventStorePath(), JSON.stringify(legacy), 'utf-8');

    // First read migrates.
    const events = readEventStore().events;
    expect(events.map((e) => e.id)).toEqual(['old1', 'old2']);
    expect(existsSync(eventStorePath())).toBe(false); // legacy file removed
    expect(existsSync(eventLogPath())).toBe(true);

    // A subsequent record appends to the migrated log; history is NOT double-counted.
    recordUsageEvent(evt({ conversationId: 'new' }));
    const after = readEventStore().events;
    expect(after.map((e) => e.id)).toEqual(['old1', 'old2', after[2].id]);
    expect(after).toHaveLength(3);
  });

  it('leaves a corrupt legacy file in place (does not delete unread data)', () => {
    writeFileSync(eventStorePath(), '{ this is not valid json', 'utf-8');
    const events = readEventStore().events;
    expect(events).toHaveLength(0); // nothing migrated
    expect(existsSync(eventStorePath())).toBe(true); // corrupt file preserved, not deleted
  });

  it('recordUsageEvent triggers migration too (event lands in the same log as history)', () => {
    writeFileSync(
      eventStorePath(),
      JSON.stringify({ events: [{ id: 'hist', timestamp: 't', modality: 'llm' }] }),
      'utf-8',
    );
    recordUsageEvent(evt({ conversationId: 'fresh' }));
    const ids = readEventStore().events.map((e) => e.id);
    expect(ids[0]).toBe('hist');
    expect(ids).toHaveLength(2);
    expect(existsSync(eventStorePath())).toBe(false);
  });
});

describe('bucketKey', () => {
  it('daily → YYYY-MM-DD', () => {
    expect(bucketKey('2026-07-12T15:30:00.000Z', 'daily')).toBe('2026-07-12');
  });
  it('monthly → YYYY-MM', () => {
    expect(bucketKey('2026-07-12T15:30:00.000Z', 'monthly')).toBe('2026-07');
  });
  it('weekly → the Monday of that ISO date week (YYYY-MM-DD)', () => {
    // 2026-07-12 is a Sunday; ISO week's Monday is 2026-07-06.
    expect(bucketKey('2026-07-08T12:00:00.000Z', 'weekly')).toBe('2026-07-06'); // a Wednesday
    // Monday maps to itself.
    expect(bucketKey('2026-07-06T12:00:00.000Z', 'weekly')).toBe('2026-07-06');
    // Sunday maps back to the PRIOR Monday (day===0 → -6).
    expect(bucketKey('2026-07-12T12:00:00.000Z', 'weekly')).toBe('2026-07-06');
  });

  it('weekly bucketing is UTC-consistent at the UTC-midnight boundary', () => {
    // These early-UTC timestamps are the previous day in tz behind UTC; a
    // local-time computation would bucket them into the wrong week. Assert the
    // UTC week: 2026-07-13 is a Monday → these Mon/Tue-early-UTC stamps bucket to
    // 2026-07-13, NOT the prior week (2026-07-06).
    expect(bucketKey('2026-07-13T00:30:00.000Z', 'weekly')).toBe('2026-07-13'); // Monday 00:30 UTC
    expect(bucketKey('2026-07-14T01:00:00.000Z', 'weekly')).toBe('2026-07-13'); // Tuesday early UTC
    // A Sunday just before UTC midnight stays in the week ending that Sunday.
    expect(bucketKey('2026-07-12T23:30:00.000Z', 'weekly')).toBe('2026-07-06');
  });

  it('weekly bucketing crosses a month boundary correctly', () => {
    // 2026-08-02 is a Sunday → its week's Monday is 2026-07-27 (prior month).
    expect(bucketKey('2026-08-02T06:00:00.000Z', 'weekly')).toBe('2026-07-27');
  });
  it('unknown period falls back to daily', () => {
    expect(bucketKey('2026-07-12T15:30:00.000Z', 'nonsense')).toBe('2026-07-12');
  });
});
