import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import { ApprovalWindowFixture, approvalWindows } from '../../../test-utils/bridge-approval-window.js';
import type { BridgeApprovalPrompt } from '../../../shared/bridge-approval.js';

vi.mock('electron', async () => ({
  BrowserWindow: (await import('../../../test-utils/bridge-approval-window.js')).ApprovalWindowFixture,
  nativeTheme: { shouldUseDarkColors: true },
  screen: { getDisplayMatching: () => ({ workArea: { width: 640, height: 480 } }) },
}));
import { showBridgeApproval } from '../approval-window.js';

describe('isolated bridge approval window', () => {
  let parent: ApprovalWindowFixture;
  const open = (detail = 'Read this scope') =>
    showBridgeApproval(parent as unknown as BrowserWindow, 'Approve', detail, 'system');
  const child = () => approvalWindows.at(-1)!;
  beforeEach(() => {
    vi.useFakeTimers();
    approvalWindows.length = 0;
    parent = new ApprovalWindowFixture();
  });
  afterEach(() => {
    approvalWindows.forEach((win) => win.destroy());
    vi.useRealTimers();
  });

  it('bounds long reviews to the display and isolates the renderer and preload', async () => {
    const result = open('Long command and access details\n'.repeat(1000));
    expect(child().options).toMatchObject({
      width: 576,
      height: 384,
      parent,
      modal: true,
      resizable: false,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false },
    });
    expect(child().options.webPreferences?.preload).toMatch(/bridge-approval\.cjs$/);
    expect(child().options.webPreferences?.partition).toMatch(/^kai-bridge-approval-/);
    const prompt = child().invoke('bridge-approval:read') as BridgeApprovalPrompt;
    expect(prompt).toMatchObject({ title: 'Approve', dark: true });
    child().invoke('bridge-approval:decide', prompt.id, false);
    await expect(result).resolves.toBe(false);
  });

  it('rejects other windows, subframes and request ids, and consumes a decision only once', async () => {
    const result = open();
    const win = child();
    const prompt = win.invoke('bridge-approval:read') as BridgeApprovalPrompt;
    const decide = win.handlers.get('bridge-approval:decide')!;
    for (const event of [parent.event(), { ...win.event(), senderFrame: { url: win.webContents.mainFrame.url } }]) {
      expect(() => decide(event as IpcMainInvokeEvent, prompt.id, true)).toThrow('different window');
    }
    expect(() => win.invoke('bridge-approval:decide', 'other-request', true)).toThrow('Invalid');
    expect(() => win.invoke('bridge-approval:decide', prompt.id, 'true')).toThrow('Invalid');
    win.invoke('bridge-approval:decide', prompt.id, true);
    await expect(result).resolves.toBe(true);
    expect(() => decide(win.event(), prompt.id, true)).toThrow('expired');
  });

  it('never reuses another pending request and cancels on parent close or timeout', async () => {
    const first = open();
    await expect(open('Different grant')).resolves.toBe(false);
    expect(approvalWindows).toHaveLength(2);
    child().destroy();
    await expect(first).resolves.toBe(false);
    const second = open();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await expect(second).resolves.toBe(false);
    const third = open();
    parent.destroy();
    await expect(third).resolves.toBe(false);
  });

  it('cancels on navigation, Escape and renderer failure', async () => {
    for (const event of ['will-navigate', 'before-input-event', 'render-process-gone']) {
      const result = open();
      child().webContents.emit(event, { preventDefault() {} }, { type: 'keyDown', key: 'Escape' });
      await expect(result).resolves.toBe(false);
    }
  });
});
