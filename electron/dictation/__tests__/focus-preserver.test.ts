import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const outputs: string[] = [];
  const execFile = vi.fn((_file: string, _args: string[], _options: unknown, callback: (error: Error | null, result: { stdout: string }) => void) => {
    callback(null, { stdout: outputs.shift() ?? '' });
  });

  return {
    outputs,
    execFile,
  };
});

vi.mock('node:child_process', () => ({
  execFile: mocks.execFile,
}));

describe('dictation focus preserver', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('__BRAND_PRODUCT_NAME', 'Kai');
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    mocks.outputs.length = 0;
    mocks.execFile.mockClear();
  });

  it('retries recapture when the first app-switch snapshot is the overlay app itself', async () => {
    mocks.outputs.push(
      'com.apple.TextEdit\nTextEdit\n1111',
      `com.example.Kai\nKai\n${process.pid}`,
      'com.apple.Notes\nNotes\n2222',
    );

    const focusPreserver = await import('../focus-preserver.js');
    await focusPreserver.beginDictationFocusSession();

    await expect(focusPreserver.recaptureDictationTargetFocus()).resolves.toBe(true);

    expect(focusPreserver.getDictationTargetPid()).toBe(2222);
    expect(mocks.execFile).toHaveBeenCalledTimes(3);
  });
});
