/**
 * Tests for the main-process diagnostics helpers behind the "Diagnostics"
 * settings section and the hardened unhandled-error handler. The load-bearing
 * behavior: a dead-pipe (EPIPE) write must be classified so the handler never
 * re-logs it to the console (that write throws again — the self-feeding loop
 * that once grew main-process.log to 218 MB and pinned the event loop), the
 * per-source counter must attribute errors to the originating plugin, and the
 * bounded-append writer must rotate rather than grow without limit.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, statSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  isDeadPipeError,
  extractPluginName,
  recordDiagnostic,
  getDiagnosticCounters,
  resetDiagnosticCounters,
  appendBoundedLog,
  readLogTail,
} from '../main-diagnostics';

describe('isDeadPipeError', () => {
  it('classifies EPIPE by error code', () => {
    expect(isDeadPipeError(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))).toBe(true);
  });
  it('classifies ERR_STREAM_DESTROYED by code', () => {
    expect(isDeadPipeError(Object.assign(new Error('x'), { code: 'ERR_STREAM_DESTROYED' }))).toBe(true);
  });
  it('classifies EPIPE by message when code is absent', () => {
    expect(isDeadPipeError(new Error('write EPIPE'))).toBe(true);
    expect(isDeadPipeError(new Error('write after end'))).toBe(true);
  });
  it('does not misclassify unrelated errors', () => {
    expect(isDeadPipeError(new Error('boom'))).toBe(false);
    expect(isDeadPipeError(Object.assign(new Error('x'), { code: 'ENOENT' }))).toBe(false);
    expect(isDeadPipeError(null)).toBe(false);
    expect(isDeadPipeError('EPIPES-not-a-word')).toBe(false);
  });
});

describe('extractPluginName', () => {
  it('pulls the plugin name from a backend.js stack frame', () => {
    const stack = 'Error: nope\n    at set (file:///Users/x/.kai/plugins/msgraph/backend.js?v=abc:123:9)';
    expect(extractPluginName(stack)).toBe('msgraph');
  });
  it('handles windows-style separators', () => {
    expect(extractPluginName('at C:\\Users\\x\\.kai\\plugins\\skynet\\backend.js:1:1')).toBe('skynet');
  });
  it('returns null for core/app stacks', () => {
    expect(extractPluginName('at Object.foo (file:///app.asar/out/main/index.js:1:1)')).toBeNull();
  });
});

describe('diagnostic counters', () => {
  beforeEach(() => resetDiagnosticCounters());

  it('aggregates repeated errors under one key and tracks count + sample', () => {
    const stack = 'Error: Plugin "msgraph" is no longer active\n    at .kai/plugins/msgraph/backend.js:1:1';
    recordDiagnostic('unhandledRejection', stack);
    recordDiagnostic('unhandledRejection', stack);
    const counters = getDiagnosticCounters();
    expect(counters).toHaveLength(1);
    expect(counters[0].plugin).toBe('msgraph');
    expect(counters[0].kind).toBe('unhandledRejection');
    expect(counters[0].count).toBe(2);
    expect(counters[0].sample).toContain('no longer active');
  });

  it('separates by kind and by plugin, and sorts by count desc', () => {
    recordDiagnostic('uncaughtException', 'plain core error');
    const pluginStack = 'x\n    at .kai/plugins/cron/backend.js:1:1';
    recordDiagnostic('unhandledRejection', pluginStack);
    recordDiagnostic('unhandledRejection', pluginStack);
    const counters = getDiagnosticCounters();
    expect(counters).toHaveLength(2);
    expect(counters[0].count).toBe(2); // sorted first
    expect(counters[0].plugin).toBe('cron');
    expect(counters.find((c) => c.plugin === null)?.kind).toBe('uncaughtException');
  });

  it('reset clears the map', () => {
    recordDiagnostic('uncaughtException', 'x');
    expect(getDiagnosticCounters()).toHaveLength(1);
    resetDiagnosticCounters();
    expect(getDiagnosticCounters()).toHaveLength(0);
  });
});

describe('appendBoundedLog + readLogTail', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kai-diag-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('appends when under the cap', () => {
    const p = join(dir, 'log.log');
    appendBoundedLog(p, 'line1\n', 1024);
    appendBoundedLog(p, 'line2\n', 1024);
    expect(readFileSync(p, 'utf-8')).toBe('line1\nline2\n');
  });

  it('rotates to .1 once the file exceeds the cap', () => {
    const p = join(dir, 'log.log');
    writeFileSync(p, 'X'.repeat(200));
    appendBoundedLog(p, 'fresh\n', 100); // 200 > 100 → rotate first
    expect(existsSync(`${p}.1`)).toBe(true);
    expect(readFileSync(p, 'utf-8')).toBe('fresh\n'); // new file starts fresh
    expect(statSync(`${p}.1`).size).toBe(200); // old content preserved in .1
  });

  it('never throws on an unwritable path', () => {
    expect(() => appendBoundedLog('/nonexistent-root-dir/nope/log.log', 'x\n', 10)).not.toThrow();
  });

  it('readLogTail returns only the last maxBytes and flags truncation', () => {
    const p = join(dir, 'log.log');
    writeFileSync(p, 'ABCDEFGHIJ'); // 10 bytes
    const tail = readLogTail(p, 4);
    expect(tail.text).toBe('GHIJ');
    expect(tail.sizeBytes).toBe(10);
    expect(tail.truncated).toBe(true);
  });

  it('readLogTail returns whole file when under cap, not truncated', () => {
    const p = join(dir, 'log.log');
    writeFileSync(p, 'hello');
    const tail = readLogTail(p, 4096);
    expect(tail.text).toBe('hello');
    expect(tail.truncated).toBe(false);
  });

  it('readLogTail is safe on a missing file', () => {
    const tail = readLogTail(join(dir, 'missing.log'), 100);
    expect(tail).toEqual({ text: '', sizeBytes: 0, truncated: false });
  });
});
