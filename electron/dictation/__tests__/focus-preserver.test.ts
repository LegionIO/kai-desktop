import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const outputs: string[] = [];
  const helperResults: Array<Record<string, unknown>> = [];
  const execFile = vi.fn((_file: string, _args: string[], _options: unknown, callback: (error: Error | null, result: { stdout: string }) => void) => {
    callback(null, { stdout: outputs.shift() ?? '' });
  });
  const runLocalMacMouseCommand = vi.fn(async () => helperResults.shift() ?? { ok: false });

  return {
    outputs,
    helperResults,
    execFile,
    runLocalMacMouseCommand,
  };
});

vi.mock('node:child_process', () => ({
  execFile: mocks.execFile,
}));

vi.mock('../../computer-use/permissions.js', () => ({
  runLocalMacMouseCommand: mocks.runLocalMacMouseCommand,
}));

describe('dictation focus preserver', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('__BRAND_PRODUCT_NAME', 'Kai');
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    mocks.outputs.length = 0;
    mocks.helperResults.length = 0;
    mocks.execFile.mockClear();
    mocks.runLocalMacMouseCommand.mockClear();
  });

  it('retries recapture when the first app-switch snapshot is the overlay app itself', async () => {
    mocks.helperResults.push(
      { ok: true, bundleId: 'com.apple.TextEdit', name: 'TextEdit', pid: 1111 },
      { ok: true, bundleId: 'com.example.Kai', name: 'Kai', pid: process.pid },
      { ok: true, bundleId: 'com.apple.Notes', name: 'Notes', pid: 2222 },
    );

    const focusPreserver = await import('../focus-preserver.js');
    await focusPreserver.beginDictationFocusSession();

    await expect(focusPreserver.recaptureDictationTargetFocus()).resolves.toBe(true);

    expect(focusPreserver.getDictationTargetPid()).toBe(2222);
    expect(mocks.runLocalMacMouseCommand).toHaveBeenCalledTimes(3);
  });
});
