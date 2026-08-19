import { describe, expect, it, vi } from 'vitest';
import { dispatchBrowserAwareApplicationMenuCommand, dispatchBrowserAwareEditCommand } from '../edit-menu.js';

describe('dispatchBrowserAwareEditCommand', () => {
  it('dispatches native editing to ordinary focused contents', () => {
    const copy = vi.fn();
    const contents = { isDestroyed: () => false, copy };

    expect(dispatchBrowserAwareEditCommand(contents as never, null, 'copy')).toBe(true);
    expect(copy).toHaveBeenCalledOnce();
  });

  it('lets BrowserManager claim application-menu clipboard access before native dispatch', () => {
    const paste = vi.fn();
    const contents = { isDestroyed: () => false, paste };
    const dispatcher = { dispatchClipboardCommand: vi.fn(() => true) };

    expect(dispatchBrowserAwareEditCommand(contents as never, dispatcher as never, 'paste')).toBe(true);
    expect(dispatcher.dispatchClipboardCommand).toHaveBeenCalledWith(contents, 'paste');
    expect(paste).not.toHaveBeenCalled();
  });

  it('routes Browser-owned application commands and preserves the host fallback', () => {
    const contents = { isDestroyed: () => false };
    const fallback = vi.fn();
    const dispatcher = { dispatchApplicationMenuCommand: vi.fn(() => true) };

    expect(dispatchBrowserAwareApplicationMenuCommand(contents as never, dispatcher as never, 'reload', fallback)).toBe(
      true,
    );
    expect(dispatcher.dispatchApplicationMenuCommand).toHaveBeenCalledWith(contents, 'reload');
    expect(fallback).not.toHaveBeenCalled();

    dispatcher.dispatchApplicationMenuCommand.mockReturnValue(false);
    expect(
      dispatchBrowserAwareApplicationMenuCommand(contents as never, dispatcher as never, 'zoom-in', fallback),
    ).toBe(true);
    expect(fallback).toHaveBeenCalledWith(contents, 'zoom-in');
  });
});
