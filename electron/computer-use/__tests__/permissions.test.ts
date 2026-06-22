/**
 * Tests for the injectable permissions service factory in
 * `electron/computer-use/permissions.ts`.
 *
 * The factory exists specifically so tests can substitute the real Swift
 * helper binary with an in-memory stub. Coverage here pins that contract
 * — without these tests, the factory is dead code in the test surface and
 * production code paths leak through to the real `xcrun swift` invocation.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Production code probes Accessibility / Screen Recording via the Electron
// `systemPreferences` API and Automation via `osascript`. Neither belongs
// in a unit test — stub both so the factory's branching, not the OS, is
// what we exercise.
vi.mock('electron', () => ({
  systemPreferences: {
    isTrustedAccessibilityClient: vi.fn(() => true),
    getMediaAccessStatus: vi.fn(() => 'granted'),
  },
}));

vi.mock('node:child_process', () => ({
  execFile: (
    _cmd: string,
    _args: string[],
    _opts: unknown,
    cb: (err: Error | null, out: { stdout: string; stderr: string }) => void,
  ) => {
    // Always resolve OK — Automation probe is not what these tests assert.
    cb(null, { stdout: '0\n', stderr: '' });
  },
}));

import { createSwiftHelperStub } from '../../../test-utils/swift-helper-stub.js';
import { createPermissionsService, parseDisplayInfoArray } from '../permissions.js';
import { primaryDisplayIndex } from '../../../shared/computer-use.js';

describe('createPermissionsService factory', () => {
  let stub: ReturnType<typeof createSwiftHelperStub>;

  beforeEach(() => {
    stub = createSwiftHelperStub();
  });

  it('check() delegates the (subcommand, args) tuple to the injected runner', async () => {
    // `HelperRunnerResult` wraps the helper JSON in a `data` field;
    // `unwrapHelperResponse` flattens that into the returned shape.
    stub.setNext({ ok: true, data: { screenRecordingGranted: true } });
    const svc = createPermissionsService({ helperRunner: stub.runner });

    const result = await svc.check('permissions');

    expect(stub.mock).toHaveBeenCalledTimes(1);
    expect(stub.mock).toHaveBeenCalledWith('permissions', []);
    expect(result.ok).toBe(true);
    expect(result.screenRecordingGranted).toBe(true);
  });

  it('check() forwards a non-empty args array unchanged', async () => {
    stub.setNext({ ok: true, data: { inputMonitoringGranted: true } });
    const svc = createPermissionsService({ helperRunner: stub.runner });

    await svc.check('probeInputMonitoring', ['1500']);

    expect(stub.mock).toHaveBeenCalledWith('probeInputMonitoring', ['1500']);
  });

  it('check() surfaces a helper-reported error verbatim', async () => {
    stub.setNext({ ok: false, error: 'Missing helper subcommand' });
    const svc = createPermissionsService({ helperRunner: stub.runner });

    const result = await svc.check('bogus-subcommand');

    expect(result.ok).toBe(false);
    expect(result.error).toBe('Missing helper subcommand');
  });

  it('getPermissions() invokes the helper "permissions" subcommand by default', async () => {
    stub.setNext({ ok: true, data: { screenRecordingGranted: true } });
    const svc = createPermissionsService({ helperRunner: stub.runner });

    await svc.getPermissions({ probeInputMonitoring: false });

    // probeInputMonitoring: false short-circuits the second helper call.
    expect(stub.mock).toHaveBeenCalledTimes(1);
    expect(stub.mock).toHaveBeenCalledWith('permissions', []);
  });

  it('getPermissions() probes input monitoring when enabled and respects the timeout', async () => {
    // Two-call sequence: `permissions` first (returns the default ok=true),
    // then `probeInputMonitoring` with the timeout we passed in.
    const svc = createPermissionsService({ helperRunner: stub.runner });

    await svc.getPermissions({ probeInputMonitoring: true, probeTimeoutMs: 1500 });

    expect(stub.mock).toHaveBeenCalledTimes(2);
    const callArgs = stub.mock.mock.calls.map((c) => ({ sub: c[0], args: c[1] }));
    expect(callArgs).toEqual(
      expect.arrayContaining([
        { sub: 'permissions', args: [] },
        { sub: 'probeInputMonitoring', args: ['1500'] },
      ]),
    );
  });

  it('getPermissions() reports helperReady=false when the runner errors', async () => {
    stub.setNext({ ok: false, error: 'helper not installed' });
    const svc = createPermissionsService({ helperRunner: stub.runner });

    const result = await svc.getPermissions({ probeInputMonitoring: false });

    expect(result.helperReady).toBe(false);
    expect(result.message).toBe('helper not installed');
  });

  it('check() surfaces helper data when the runner returns an ok payload', async () => {
    // Belt-and-suspenders for the unwrap path: the helper's own ok field
    // inside `data` must override the wrapper-level ok=true.
    stub.setNext({ ok: true, data: { ok: false, error: 'sandboxed' } });
    const svc = createPermissionsService({ helperRunner: stub.runner });

    const result = await svc.check('permissions');

    expect(result.ok).toBe(false);
    expect(result.error).toBe('sandboxed');
  });

  it('two separate service instances do not share runner state', async () => {
    const stubA = createSwiftHelperStub();
    const stubB = createSwiftHelperStub();
    const svcA = createPermissionsService({ helperRunner: stubA.runner });
    const _svcB = createPermissionsService({ helperRunner: stubB.runner });

    stubA.setNext({ ok: true, data: { screenRecordingGranted: true } });
    await svcA.check('permissions');

    expect(stubA.mock).toHaveBeenCalledTimes(1);
    expect(stubB.mock).toHaveBeenCalledTimes(0);
  });
});

describe('parseDisplayInfoArray', () => {
  const raw = [
    {
      displayId: '100',
      name: 'External',
      pixelWidth: 2560,
      pixelHeight: 1440,
      logicalWidth: 2560,
      logicalHeight: 1440,
      globalX: -2560,
      globalY: 0,
      scaleFactor: 1,
      isPrimary: false,
    },
    {
      displayId: '1',
      name: 'Built-in Retina Display',
      pixelWidth: 1728,
      pixelHeight: 1117,
      logicalWidth: 1728,
      logicalHeight: 1117,
      globalX: 0,
      globalY: 0,
      scaleFactor: 2,
      isPrimary: true,
    },
  ];

  it('assigns displayIndex from native helper order', () => {
    const out = parseDisplayInfoArray(raw);
    expect(out.map((d) => [d.displayId, d.displayIndex])).toEqual([
      ['100', 0],
      ['1', 1],
    ]);
  });

  it('preserves native displayIndex when filtered by allowedDisplays', () => {
    const out = parseDisplayInfoArray(raw, ['Built-in Retina Display']);
    expect(out).toHaveLength(1);
    expect(out[0].displayId).toBe('1');
    expect(out[0].displayIndex).toBe(1);
  });

  it('filters by displayId case-insensitively and preserves native index', () => {
    const out = parseDisplayInfoArray(raw, ['100']);
    expect(out).toHaveLength(1);
    expect(out[0].displayIndex).toBe(0);
  });
});

describe('primaryDisplayIndex', () => {
  it('returns 0 for undefined/null layout', () => {
    expect(primaryDisplayIndex(undefined)).toBe(0);
    expect(primaryDisplayIndex(null)).toBe(0);
  });

  it('returns the isPrimary display index even when it is not at position 0', () => {
    const layout = {
      displays: parseDisplayInfoArray([
        { displayId: '100', name: 'External', pixelWidth: 2560, pixelHeight: 1440, isPrimary: false },
        { displayId: '1', name: 'Built-in', pixelWidth: 1728, pixelHeight: 1117, isPrimary: true },
      ]),
    };
    expect(primaryDisplayIndex(layout)).toBe(1);
  });

  it('falls back to the first display index when none is marked primary', () => {
    const layout = {
      displays: parseDisplayInfoArray(
        [
          { displayId: '100', name: 'A', pixelWidth: 1920, pixelHeight: 1080, isPrimary: false },
          { displayId: '200', name: 'B', pixelWidth: 1920, pixelHeight: 1080, isPrimary: false },
        ],
        ['B'],
      ),
    };
    expect(primaryDisplayIndex(layout)).toBe(1);
  });
});
