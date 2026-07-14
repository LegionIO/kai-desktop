import { describe, it, expect } from 'vitest';
import { __internal } from '../ToolGroup';

const { sanitizeResultForDisplay, detectShResult } = __internal;

describe('sanitizeResultForDisplay — unwrap { value } past internal metadata', () => {
  it('unwraps { value } when it is the only visible key', () => {
    expect(sanitizeResultForDisplay({ value: 'hello' })).toBe('hello');
  });

  it('unwraps { value, _diffTracking } → the value (workspace-command shape)', () => {
    // Regression: a workspace/exec command result carries _diffTracking next to
    // value. Without stripping it, the 2-key object never unwrapped → the sh
    // detector saw no stdout → "No output" despite real output.
    const result = {
      value: 'STATUS: errored\nMESSAGE: bump ref\n',
      _diffTracking: { diffs: [], snapshotSkipped: true },
    };
    expect(sanitizeResultForDisplay(result)).toBe('STATUS: errored\nMESSAGE: bump ref\n');
  });

  it('strips ANY underscore-prefixed metadata + observer/modelStream before unwrap', () => {
    const result = { value: 'out', _modelContent: [{ type: 'image', data: 'x' }], observer: {}, modelStream: {} };
    expect(sanitizeResultForDisplay(result)).toBe('out');
  });

  it('does not unwrap when there are multiple REAL (non-underscore) keys', () => {
    const r = { stdout: 'a', stderr: 'b' };
    expect(sanitizeResultForDisplay(r)).toEqual({ stdout: 'a', stderr: 'b' });
  });

  it('leaves a plain string / non-object untouched', () => {
    expect(sanitizeResultForDisplay('raw')).toBe('raw');
    expect(sanitizeResultForDisplay(null)).toBeNull();
  });
});

describe('detectShResult after sanitize — the full "No output" path', () => {
  it('a { value: stdout, _diffTracking } workspace result yields the stdout (not null)', () => {
    const result = { value: 'STATUS: errored\nPLAN: plan-abc\n', _diffTracking: { diffs: [] } };
    const sh = detectShResult(sanitizeResultForDisplay(result));
    expect(sh).not.toBeNull();
    expect(sh!.stdout).toContain('STATUS: errored');
  });

  it('a plain { stdout } sh result still detects', () => {
    const sh = detectShResult({ stdout: 'ok', stderr: '', exitCode: 0 });
    expect(sh?.stdout).toBe('ok');
  });
});
