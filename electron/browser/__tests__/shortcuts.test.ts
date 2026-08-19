import { describe, expect, it } from 'vitest';
import {
  isApplicationAcceleratorShortcutKeys,
  isClipboardShortcutKeys,
  isReservedBrowserShortcutKeys,
  resolveClipboardShortcutCommand,
  resolveBrowserShortcut,
  shouldFocusBrowserChrome,
} from '../shortcuts.js';

describe('resolveBrowserShortcut', () => {
  it('moves native-page address/find shortcuts back to Browser chrome', () => {
    expect(shouldFocusBrowserChrome('new-tab')).toBe(true);
    expect(shouldFocusBrowserChrome('focus-url')).toBe(true);
    expect(shouldFocusBrowserChrome('find')).toBe(true);
    expect(shouldFocusBrowserChrome('find-next')).toBe(true);
    expect(shouldFocusBrowserChrome('reload')).toBe(false);
  });

  it('routes the complete tab/navigation/find/zoom shortcut set', () => {
    const command = (key: string, shift = false) =>
      resolveBrowserShortcut({ type: 'keyDown', key, meta: true, shift }, true)?.action;
    expect(command('t')).toBe('new-tab');
    expect(command('t', true)).toBe('reopen-tab');
    expect(command('w')).toBe('close-tab');
    expect(command('l')).toBe('focus-url');
    expect(command('r')).toBe('reload');
    expect(command('r', true)).toBe('hard-reload');
    expect(command('f')).toBe('find');
    expect(command('g')).toBe('find-next');
    expect(command('g', true)).toBe('find-previous');
    expect(command('=')).toBe('zoom-in');
    expect(command('-')).toBe('zoom-out');
    expect(command('0')).toBe('zoom-reset');
    expect(command('9')).toBe('tab-last');
  });

  it('uses Ctrl on non-macOS and handles alternate back/forward', () => {
    expect(resolveBrowserShortcut({ type: 'keyDown', key: 't', control: true }, false)?.action).toBe('new-tab');
    expect(resolveBrowserShortcut({ type: 'keyDown', key: 't', meta: true }, false)).toBeNull();
    expect(resolveBrowserShortcut({ type: 'keyDown', key: 'ArrowLeft', alt: true }, false)?.action).toBe('back');
    expect(resolveBrowserShortcut({ type: 'keyDown', key: 'ArrowRight', alt: true }, false)?.action).toBe('forward');
    expect(resolveBrowserShortcut({ type: 'keyDown', key: 'ArrowLeft', alt: true, shift: true }, false)).toBeNull();
    expect(resolveBrowserShortcut({ type: 'keyDown', key: 'ArrowLeft', alt: true }, true)).toBeNull();
    expect(resolveBrowserShortcut({ type: 'keyDown', key: 'Escape' }, false)?.action).toBe('stop');
  });

  it('does not steal modified-arrow caret movement from editable page controls', () => {
    expect(resolveBrowserShortcut({ type: 'keyDown', key: 'ArrowLeft', meta: true }, true)).toBeNull();
    expect(resolveBrowserShortcut({ type: 'keyDown', key: 'ArrowRight', control: true }, false)).toBeNull();
    expect(resolveBrowserShortcut({ type: 'keyDown', key: '[', meta: true }, true)?.action).toBe('back');
    expect(resolveBrowserShortcut({ type: 'keyDown', key: ']', control: true }, false)?.action).toBe('forward');
  });

  it('recognizes only Command clipboard key combinations on macOS', () => {
    expect(isClipboardShortcutKeys(['Meta', 'c'], true)).toBe(true);
    expect(resolveClipboardShortcutCommand(['Meta', 'c'], true)).toBe('copy');
    expect(resolveClipboardShortcutCommand(['Command', 'x'], true)).toBe('cut');
    expect(resolveClipboardShortcutCommand(['Meta', 'v'], true)).toBe('paste');
    expect(resolveClipboardShortcutCommand(['Meta', 'Shift', 'v'], true)).toBe('paste');
    expect(resolveClipboardShortcutCommand(['Meta', 'Shift', 'c'], true)).toBeNull();
    expect(resolveClipboardShortcutCommand(['Control', 'c'], true)).toBeNull();
    expect(resolveClipboardShortcutCommand(['Control', 'Meta', 'c'], true)).toBeNull();
    expect(resolveClipboardShortcutCommand(['Control', 'Insert'], true)).toBeNull();
    expect(resolveClipboardShortcutCommand(['Shift', 'Insert'], true)).toBeNull();
    expect(resolveClipboardShortcutCommand(['Shift', 'Delete'], true)).toBeNull();
  });

  it('recognizes only Control and legacy clipboard key combinations on non-macOS', () => {
    expect(isClipboardShortcutKeys(['Control', 'V'], false)).toBe(true);
    expect(resolveClipboardShortcutCommand(['Control', 'c'], false)).toBe('copy');
    expect(resolveClipboardShortcutCommand(['Ctrl', 'x'], false)).toBe('cut');
    expect(resolveClipboardShortcutCommand(['Control', 'v'], false)).toBe('paste');
    expect(resolveClipboardShortcutCommand(['Control', 'Shift', 'v'], false)).toBe('paste');
    expect(resolveClipboardShortcutCommand(['Control', 'Shift', 'c'], false)).toBeNull();
    expect(resolveClipboardShortcutCommand(['Meta', 'c'], false)).toBeNull();
    expect(resolveClipboardShortcutCommand(['Meta', 'Control', 'c'], false)).toBeNull();
    expect(resolveClipboardShortcutCommand(['Control', 'Insert'], false)).toBe('copy');
    expect(resolveClipboardShortcutCommand(['Shift', 'Insert'], false)).toBe('paste');
    expect(resolveClipboardShortcutCommand(['Shift', 'Delete'], false)).toBe('cut');
    expect(isClipboardShortcutKeys(['Shift', 'c'], false)).toBe(false);
  });

  it('recognizes synthetic keys that would be intercepted as browser chrome shortcuts', () => {
    expect(isReservedBrowserShortcutKeys(['Meta', 't'])).toBe(true);
    expect(isReservedBrowserShortcutKeys(['Control', 'w'])).toBe(true);
    expect(isReservedBrowserShortcutKeys(['Alt', 'ArrowLeft'])).toBe(true);
    expect(isReservedBrowserShortcutKeys(['Alt', 'Shift', 'ArrowLeft'])).toBe(false);
    expect(isReservedBrowserShortcutKeys(['Meta', 'ArrowLeft'])).toBe(false);
    expect(isReservedBrowserShortcutKeys(['Escape'])).toBe(true);
    expect(isReservedBrowserShortcutKeys(['Control', 'a'])).toBe(false);
  });

  it('blocks assistant input that can reach application-menu accelerators', () => {
    expect(isApplicationAcceleratorShortcutKeys(['Meta', 'q'])).toBe(true);
    expect(isApplicationAcceleratorShortcutKeys(['Control', ','])).toBe(true);
    expect(isApplicationAcceleratorShortcutKeys(['Meta', 'Alt', 'i'])).toBe(true);
    expect(isApplicationAcceleratorShortcutKeys(['F11'])).toBe(true);
    expect(isApplicationAcceleratorShortcutKeys(['Shift', 'Tab'])).toBe(false);
    expect(isApplicationAcceleratorShortcutKeys(['Enter'])).toBe(false);
  });
});
