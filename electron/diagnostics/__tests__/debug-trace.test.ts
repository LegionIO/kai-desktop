import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, existsSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  getDiagnosticTracePath,
  initDiagnosticTrace,
  invalidateDiagnosticTraceConfig,
  isDiagnosticTraceEnabled,
  sweepDiagnosticTraceRetention,
  traceDiagnostic,
} from '../debug-trace';
import type { AppConfig } from '../../config/schema';

let home: string;
let cfg: AppConfig;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'kai-debug-trace-'));
  cfg = {
    diagnostics: {
      debugTrace: {
        enabled: false,
        includeContent: false,
        scopes: ['automation', 'alert'],
        retention: { maxFileBytes: 1048576, maxFiles: 2, maxAgeDays: 7 },
      },
    },
  } as AppConfig;
  initDiagnosticTrace(home, () => cfg);
});

afterEach(() => rmSync(home, { recursive: true, force: true }));

/** Mutate the in-memory trace config and invalidate the module cache (prod
 * invalidates on every config write; tests mutate the object in place). */
function mutateTrace(patch: Partial<AppConfig['diagnostics']['debugTrace']>): void {
  Object.assign(cfg.diagnostics.debugTrace, patch);
  invalidateDiagnosticTraceConfig();
}

describe('diagnostic trace', () => {
  it('is disabled by default and scope-gated', () => {
    expect(isDiagnosticTraceEnabled('automation')).toBe(false);
    traceDiagnostic({ scope: 'automation', event: 'turn.start' });
    expect(() => statSync(getDiagnosticTracePath())).toThrow();

    mutateTrace({ enabled: true });
    expect(isDiagnosticTraceEnabled('automation')).toBe(true);
    expect(isDiagnosticTraceEnabled('plugin')).toBe(false);
  });

  it('records metadata while omitting content and redacting secrets', () => {
    mutateTrace({ enabled: true });
    traceDiagnostic({
      scope: 'automation',
      event: 'turn.start',
      correlationId: 'c1',
      conversationId: 'conv',
      messageId: 'msg-1',
      parentMessageId: 'msg-0',
      fields: { prompt: 'sensitive words', token: 'secret-token', count: 2 },
    });
    const row = JSON.parse(readFileSync(getDiagnosticTracePath(), 'utf8').trim());
    expect(row.event).toBe('turn.start');
    expect(row.correlationId).toBe('c1');
    expect(row.messageId).toBe('msg-1');
    expect(row.parentMessageId).toBe('msg-0');
    expect(row.fields.prompt).toEqual({ omitted: true, chars: 15 });
    expect(row.fields.token).toBe('[redacted]');
    expect(row.fields.count).toBe(2);
  });

  it('treats an explicit empty scope list as trace-nothing', () => {
    mutateTrace({ enabled: true, scopes: [] });
    expect(isDiagnosticTraceEnabled('automation')).toBe(false);
    expect(isDiagnosticTraceEnabled('agent')).toBe(false);
  });

  it('omits error message/stack in metadata-only mode', () => {
    mutateTrace({ enabled: true });
    traceDiagnostic({
      scope: 'automation',
      event: 'turn.finalized',
      fields: { error: new Error('provider said https://secret/path failed') },
    });
    const row = JSON.parse(readFileSync(getDiagnosticTracePath(), 'utf8').trim());
    expect(row.fields.error).toEqual({ omitted: true, name: 'Error' });
  });

  it('enforces a reduced maxFiles by dropping rotated siblings above the limit', () => {
    mutateTrace({ enabled: true });
    const base = getDiagnosticTracePath();
    mkdirSync(dirname(base), { recursive: true });
    writeFileSync(`${base}.1`, 'old1');
    writeFileSync(`${base}.2`, 'old2');
    writeFileSync(`${base}.3`, 'old3');
    mutateTrace({ retention: { maxFileBytes: 10485760, maxFiles: 2, maxAgeDays: 7 } });
    // A trace write triggers prune(), which removes suffixes >= maxFiles.
    traceDiagnostic({ scope: 'automation', event: 'turn.start' });
    expect(existsSync(`${base}.2`)).toBe(false);
    expect(existsSync(`${base}.3`)).toBe(false);
  });

  it('omits url/path fields in metadata-only mode', () => {
    mutateTrace({ enabled: true, scopes: ['window'] });
    traceDiagnostic({
      scope: 'window',
      event: 'main-renderer-load-finished',
      fields: { url: 'file:///Users/secret/app/index.html', reloadCount: 1 },
    });
    const row = JSON.parse(readFileSync(getDiagnosticTracePath(), 'utf8').trim());
    expect(row.fields.url).toEqual({ omitted: true, chars: 'file:///Users/secret/app/index.html'.length });
    expect(row.fields.reloadCount).toBe(1);
  });

  it('prunes expired trace files even after tracing is disabled', () => {
    const base = getDiagnosticTracePath();
    mkdirSync(dirname(base), { recursive: true });
    writeFileSync(`${base}.1`, 'stale');
    const old = Date.now() / 1000 - 40 * 24 * 60 * 60;
    utimesSync(`${base}.1`, old, old);
    mutateTrace({ enabled: false });
    sweepDiagnosticTraceRetention();
    expect(existsSync(`${base}.1`)).toBe(false);
  });

  it('keeps short categorical reason codes in metadata-only mode', () => {
    mutateTrace({ enabled: true });
    traceDiagnostic({ scope: 'automation', event: 'turn.queued', fields: { reason: 'alert-resume' } });
    const row = JSON.parse(readFileSync(getDiagnosticTracePath(), 'utf8').trim());
    expect(row.fields.reason).toBe('alert-resume');
  });

  it('omits an over-long or Error reason in metadata-only mode', () => {
    mutateTrace({ enabled: true });
    traceDiagnostic({
      scope: 'automation',
      event: 'turn.finalized',
      fields: { reason: 'x'.repeat(300) },
    });
    const row = JSON.parse(readFileSync(getDiagnosticTracePath(), 'utf8').trim());
    expect(row.fields.reason).toEqual({ omitted: true, chars: 300 });
  });

  it('omits camelCase/snake_case content keys but keeps id/count metadata', () => {
    mutateTrace({ enabled: true });
    traceDiagnostic({
      scope: 'automation',
      event: 'turn.start',
      fields: {
        messageBody: 'secret prose',
        promptText: 'do the thing',
        toolArgs: { k: 'v' },
        request_url: 'https://x/y',
        messageId: 'm-1',
        parentMessageId: 'm-0',
        resultCount: 3,
      },
    });
    const row = JSON.parse(readFileSync(getDiagnosticTracePath(), 'utf8').trim());
    expect(row.fields.messageBody).toEqual({ omitted: true, chars: 'secret prose'.length });
    expect(row.fields.promptText).toEqual({ omitted: true, chars: 'do the thing'.length });
    expect(row.fields.toolArgs).toEqual({ omitted: true, keys: 1 });
    expect(row.fields.request_url).toEqual({ omitted: true, chars: 'https://x/y'.length });
    expect(row.fields.messageId).toBe('m-1');
    expect(row.fields.parentMessageId).toBe('m-0');
    expect(row.fields.resultCount).toBe(3);
  });

  it('includes bounded content only when explicitly enabled', () => {
    mutateTrace({ enabled: true, includeContent: true });
    traceDiagnostic({ scope: 'alert', event: 'alert.created', fields: { body: 'hello', password: 'nope' } });
    const row = JSON.parse(readFileSync(getDiagnosticTracePath(), 'utf8').trim());
    expect(row.fields.body).toBe('hello');
    expect(row.fields.password).toBe('[redacted]');
  });
});
