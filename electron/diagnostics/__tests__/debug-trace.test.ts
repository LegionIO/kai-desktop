import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDiagnosticTracePath, initDiagnosticTrace, isDiagnosticTraceEnabled, traceDiagnostic } from '../debug-trace';
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

describe('diagnostic trace', () => {
  it('is disabled by default and scope-gated', () => {
    expect(isDiagnosticTraceEnabled('automation')).toBe(false);
    traceDiagnostic({ scope: 'automation', event: 'turn.start' });
    expect(() => statSync(getDiagnosticTracePath())).toThrow();

    cfg.diagnostics.debugTrace.enabled = true;
    expect(isDiagnosticTraceEnabled('automation')).toBe(true);
    expect(isDiagnosticTraceEnabled('plugin')).toBe(false);
  });

  it('records metadata while omitting content and redacting secrets', () => {
    cfg.diagnostics.debugTrace.enabled = true;
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

  it('includes bounded content only when explicitly enabled', () => {
    cfg.diagnostics.debugTrace.enabled = true;
    cfg.diagnostics.debugTrace.includeContent = true;
    traceDiagnostic({ scope: 'alert', event: 'alert.created', fields: { body: 'hello', password: 'nope' } });
    const row = JSON.parse(readFileSync(getDiagnosticTracePath(), 'utf8').trim());
    expect(row.fields.body).toBe('hello');
    expect(row.fields.password).toBe('[redacted]');
  });
});
