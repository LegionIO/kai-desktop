import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NativePlatformAdapter } from '../../platform/types.js';

const adapterMock = {
  kind: 'win32' as const,
  capabilities: {
    screenshotDisplay: true,
    screenshotWindow: true,
    input: true,
    textIntrospection: true,
    uiTree: true,
    inputMonitor: true,
  },
  readFocusedTextField: vi.fn(),
  writeFocusedTextField: vi.fn(),
  typeText: vi.fn(),
  pressKeys: vi.fn(),
  checkPermissions: vi.fn(),
} as unknown as NativePlatformAdapter;

vi.mock('../../platform/index.js', () => ({
  getPlatformAdapter: async () => adapterMock,
  getFallbackAdapter: () => adapterMock,
}));

import { runDictationViaAdapter } from '../adapter-bridge.js';

describe('runDictationViaAdapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('translates focusedTextSelection to readFocusedTextField', async () => {
    (adapterMock.readFocusedTextField as ReturnType<typeof vi.fn>).mockResolvedValue({
      value: 'hello world',
      selectionStart: 3,
      selectionEnd: 7,
      elementSignature: 'pid:1:auto',
    });
    const result = await runDictationViaAdapter(['focusedTextSelection']);
    expect(result).toEqual({
      ok: true,
      selectedTextRangeLocation: 3,
      selectedTextRangeLength: 4,
      elementSignature: 'pid:1:auto',
    });
  });

  it('returns ok:false when no focused text field', async () => {
    (adapterMock.readFocusedTextField as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const result = await runDictationViaAdapter(['focusedTextRangeState', '0', '0']);
    expect(result?.ok).toBe(false);
  });

  it('slices focusedTextRangeState to the requested range', async () => {
    (adapterMock.readFocusedTextField as ReturnType<typeof vi.fn>).mockResolvedValue({
      value: 'hello brave world',
      selectionStart: 11,
      selectionEnd: 11,
      elementSignature: 'sig',
    });
    const result = await runDictationViaAdapter(['focusedTextRangeState', '6', '5']);
    expect(result).toMatchObject({
      ok: true,
      rangeText: 'brave',
      textUtf16Length: 17,
      selectedTextRangeLocation: 11,
      selectedTextRangeLength: 0,
      elementSignature: 'sig',
    });
  });

  it('routes postText through adapter.typeText with base64 decoding', async () => {
    (adapterMock.typeText as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    const encoded = Buffer.from('héllo', 'utf-8').toString('base64');
    const result = await runDictationViaAdapter(['postText', encoded]);
    expect(adapterMock.typeText).toHaveBeenCalledWith('héllo');
    expect(result?.ok).toBe(true);
  });

  it('routes deleteBack through adapter.pressKeys N times', async () => {
    (adapterMock.pressKeys as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    await runDictationViaAdapter(['deleteBack', '3']);
    expect(adapterMock.pressKeys).toHaveBeenCalledTimes(3);
    expect(adapterMock.pressKeys).toHaveBeenCalledWith(['backspace']);
  });

  it('replays applyTextPatch operations in order', async () => {
    (adapterMock.pressKeys as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (adapterMock.typeText as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    const ops = [
      { kind: 'moveLeft', count: 2 },
      { kind: 'deleteForward', count: 1 },
      { kind: 'insertText', text: 'ab' },
      { kind: 'moveRight', count: 1 },
    ];
    const encoded = Buffer.from(JSON.stringify(ops), 'utf-8').toString('base64');
    const result = await runDictationViaAdapter(['applyTextPatch', encoded]);
    expect(result?.ok).toBe(true);
    expect((adapterMock.pressKeys as ReturnType<typeof vi.fn>).mock.calls).toEqual([
      [['left']],
      [['left']],
      [['delete']],
      [['right']],
    ]);
    expect(adapterMock.typeText).toHaveBeenCalledWith('ab');
  });

  it('splices replaceTextAtomically into the focused field at [location, location+length)', async () => {
    (adapterMock.readFocusedTextField as ReturnType<typeof vi.fn>).mockResolvedValue({
      value: 'hello brave world',
      selectionStart: 17,
      selectionEnd: 17,
      elementSignature: 'sig',
    });
    (adapterMock.writeFocusedTextField as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    const encoded = Buffer.from('cruel', 'utf-8').toString('base64');
    const sig = Buffer.from('sig', 'utf-8').toString('base64');
    const result = await runDictationViaAdapter(['replaceTextAtomically', '6', '5', encoded, '', sig]);
    expect(adapterMock.writeFocusedTextField).toHaveBeenCalledWith('hello cruel world', 11, 11);
    expect(result?.ok).toBe(true);
    expect(result?.textUtf16Length).toBe(5);
  });

  it('rejects replaceTextAtomically when element signature drifts', async () => {
    (adapterMock.readFocusedTextField as ReturnType<typeof vi.fn>).mockResolvedValue({
      value: 'abc',
      selectionStart: 3,
      selectionEnd: 3,
      elementSignature: 'other',
    });
    const encoded = Buffer.from('x', 'utf-8').toString('base64');
    const sig = Buffer.from('sig', 'utf-8').toString('base64');
    const result = await runDictationViaAdapter(['replaceTextAtomically', '0', '1', encoded, '', sig]);
    expect(result?.ok).toBe(false);
    expect(adapterMock.writeFocusedTextField).not.toHaveBeenCalled();
  });

  it('returns null for unknown commands', async () => {
    const result = await runDictationViaAdapter(['someMacOnlyThing']);
    expect(result).toBeNull();
  });
});
