import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDiagnosticTracePath, initDiagnosticTrace, invalidateDiagnosticTraceConfig, isDiagnosticTraceEnabled, traceDiagnostic } from '../debug-trace';
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

  it('includes bounded content only when explicitly enabled', () => {
    mutateTrace({ enabled: true, includeContent: true });
    traceDiagnostic({ scope: 'alert', event: 'alert.created', fields: { body: 'hello', password: 'nope' } });
    const row = JSON.parse(readFileSync(getDiagnosticTracePath(), 'utf8').trim());
    expect(row.fields.body).toBe('hello');
    expect(row.fields.password).toBe('[redacted]');
  });
});
