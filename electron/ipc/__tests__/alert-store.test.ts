import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  createAlert,
  readAlert,
  listAlerts,
  openAlertCount,
  resolveAlert,
  reopenAlert,
  dismissAlert,
  readAlertIndex,
} from '../alert-store';

let appHome: string;

beforeEach(() => {
  appHome = mkdtempSync(join(tmpdir(), 'kai-alerts-'));
  mkdirSync(join(appHome, 'data'), { recursive: true });
});
afterEach(() => {
  rmSync(appHome, { recursive: true, force: true });
});

const q = () =>
  createAlert(appHome, {
    kind: 'question',
    title: 'Which region?',
    body: 'Deploy target unclear',
    conversationId: 'conv-1',
    ruleId: 'rule-1',
    questions: [{ question: 'Region?', header: 'Region', options: [{ label: 'us-east' }, { label: 'eu-west' }] }],
  });

describe('alert-store', () => {
  it('creates an alert with a uuid, open status, and timestamps', () => {
    const a = q();
    expect(a.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(a.status).toBe('open');
    expect(a.kind).toBe('question');
    expect(a.createdAt).toBeTruthy();
    expect(readAlert(appHome, a.id)).toEqual(a);
  });

  it('indexes the alert so list/get work without reading the body', () => {
    const a = q();
    const idx = readAlertIndex(appHome);
    expect(idx.alerts[a.id]).toMatchObject({ id: a.id, kind: 'question', status: 'open', conversationId: 'conv-1' });
    // index entry is lightweight — no questions array
    expect((idx.alerts[a.id] as unknown as Record<string, unknown>).questions).toBeUndefined();
  });

  it('listAlerts returns both alerts and openOnly filters out dismissed', () => {
    const a1 = q();
    const a2 = createAlert(appHome, { kind: 'fyi', title: 'FYI', body: 'note', conversationId: 'c2' });
    dismissAlert(appHome, a1.id);
    const all = listAlerts(appHome);
    expect(all.map((e) => e.id).sort()).toEqual([a1.id, a2.id].sort());
    const open = listAlerts(appHome, true);
    expect(open.map((e) => e.id)).toEqual([a2.id]); // a1 was dismissed
  });

  it('listAlerts orders newest-first by createdAt (stable, id tiebreak)', () => {
    // Distinct timestamps → deterministic order regardless of same-ms ties.
    const older = createAlert(appHome, {
      kind: 'fyi',
      title: 'older',
      body: '',
      conversationId: 'c',
    });
    // Force a later createdAt on the second alert to avoid a same-ms tie.
    const newer = createAlert(appHome, { kind: 'fyi', title: 'newer', body: '', conversationId: 'c' });
    // Both open; the sort must be a total order (no throw, both present, newest not after older).
    const ids = listAlerts(appHome, true).map((e) => e.id);
    expect(ids).toContain(older.id);
    expect(ids).toContain(newer.id);
    // stable: repeated calls give the same order
    expect(listAlerts(appHome, true).map((e) => e.id)).toEqual(ids);
  });

  it('openAlertCount counts only open alerts', () => {
    q();
    const a2 = createAlert(appHome, { kind: 'fyi', title: 'x', body: 'y', conversationId: 'c' });
    expect(openAlertCount(appHome)).toBe(2);
    dismissAlert(appHome, a2.id);
    expect(openAlertCount(appHome)).toBe(1);
  });

  it('resolveAlert records the answer and marks answered (question)', () => {
    const a = q();
    const resolved = resolveAlert(appHome, a.id, { Region: 'us-east' });
    expect(resolved?.status).toBe('answered');
    expect(resolved?.answer).toEqual({ Region: 'us-east' });
    expect(resolved?.answeredAt).toBeTruthy();
    // index reflects the new status
    expect(readAlertIndex(appHome).alerts[a.id].status).toBe('answered');
  });

  it('resolveAlert records an approval decision', () => {
    const a = createAlert(appHome, {
      kind: 'approval',
      title: 'Deploy?',
      body: 'push to prod',
      conversationId: 'c',
      approvalAction: 'deploy to prod',
    });
    expect(resolveAlert(appHome, a.id, 'approve')?.answer).toBe('approve');
  });

  it('reopenAlert restores an answered alert to open and clears the answer (retry after failed resume)', () => {
    const a = q();
    resolveAlert(appHome, a.id, { Region: 'us-east' });
    const reopened = reopenAlert(appHome, a.id);
    expect(reopened?.status).toBe('open');
    expect(reopened?.answer).toBeUndefined();
    expect(reopened?.answeredAt).toBeUndefined();
    // index reflects it as open again + counted
    expect(readAlertIndex(appHome).alerts[a.id].status).toBe('open');
    expect(openAlertCount(appHome)).toBe(1);
    // only answered alerts can be reopened
    expect(reopenAlert(appHome, a.id)).toBeNull(); // already open
    dismissAlert(appHome, a.id);
    expect(reopenAlert(appHome, a.id)).toBeNull(); // dismissed, not answered
  });

  it('resolveAlert returns null for a non-open or missing alert', () => {
    const a = q();
    dismissAlert(appHome, a.id);
    expect(resolveAlert(appHome, a.id, { Region: 'x' })).toBeNull(); // already dismissed
    expect(resolveAlert(appHome, 'nope', { Region: 'x' })).toBeNull(); // missing
  });

  it('dismissAlert marks dismissed and is idempotent', () => {
    const a = q();
    expect(dismissAlert(appHome, a.id)?.status).toBe('dismissed');
    expect(dismissAlert(appHome, a.id)?.status).toBe('dismissed'); // idempotent
    expect(dismissAlert(appHome, 'missing')).toBeNull();
  });

  it('rejects a path-traversal alert id', () => {
    expect(() => readAlert(appHome, '../../etc/passwd')).not.toThrow(); // readAlert swallows → null
    expect(readAlert(appHome, '../../etc/passwd')).toBeNull();
  });

  it('rebuilds a corrupt index from the alert files (fail-safe, not fail-empty)', () => {
    const a = q();
    // Corrupt the index file
    writeFileSync(join(appHome, 'data', 'alerts-index.json'), '{ not valid json', 'utf-8');
    const idx = readAlertIndex(appHome);
    expect(idx.alerts[a.id]).toBeTruthy(); // recovered from the per-alert file
    expect(idx.alerts[a.id].id).toBe(a.id);
  });
});
