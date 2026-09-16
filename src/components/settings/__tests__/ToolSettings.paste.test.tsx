import { fireEvent, render, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installAppBridgeStub, uninstallAppBridgeStub } from '../../../../test-utils/app-bridge-stub';
import { ToolSettings } from '../ToolSettings';

afterEach(() => {
  uninstallAppBridgeStub();
  vi.restoreAllMocks();
});

function baseConfig(allowPaths: string[] = []) {
  return {
    tools: {
      shell: { enabled: true, timeout: 30000, allowPatterns: [], denyPatterns: [] },
      fileAccess: { enabled: true, allowPaths, denyPaths: [] },
      webFetch: { enabled: true, timeout: 30000 },
      webSearch: { enabled: true, timeout: 30000 },
      processStreaming: {
        enabled: true,
        updateIntervalMs: 1000,
        modelFeedMode: 'incremental' as const,
        maxOutputBytes: 100000,
        truncationMode: 'head-tail' as const,
        stopAfterMax: false,
        headTailRatio: 0.7,
        observer: {
          enabled: false,
          intervalMs: 5000,
          maxSnapshotChars: 2000,
          maxMessagesPerTool: 5,
          maxTotalLaunchedTools: 10,
        },
      },
    },
  };
}

/** Paste helper — jsdom needs an explicit clipboardData payload. */
function pasteInto(el: HTMLElement, text: string) {
  fireEvent.paste(el, { clipboardData: { getData: () => text } });
}

describe('PatternList multi-line paste', () => {
  it('adds one entry per pasted line in a single config write', () => {
    installAppBridgeStub({});
    const updateConfig = vi.fn();
    render(<ToolSettings config={baseConfig()} updateConfig={updateConfig} />);

    // Deny Patterns for the shell tool — a plain (non-filePicker) list.
    const denyList = document.querySelector('[data-setting-id="tools.shell.denyPatterns"]') as HTMLElement;
    const input = within(denyList).getByRole('textbox');

    pasteInto(input, 'rm -rf *\n:(){ :|:& };:\n  dd if=/dev/zero  \n\nmkfs*');

    // Previously EditableInput flattened newlines to spaces and this committed as
    // ONE unusable entry. Each line must land as its own pattern, blanks dropped
    // and each trimmed, in one write.
    expect(updateConfig).toHaveBeenCalledTimes(1);
    expect(updateConfig).toHaveBeenCalledWith('tools.shell.denyPatterns', [
      'rm -rf *',
      ':(){ :|:& };:',
      'dd if=/dev/zero',
      'mkfs*',
    ]);
  });

  it('appends pasted lines after existing entries and dedupes against them', () => {
    installAppBridgeStub({});
    const updateConfig = vi.fn();
    render(<ToolSettings config={baseConfig()} updateConfig={updateConfig} />);

    const allowList = document.querySelector('[data-setting-id="tools.shell.allowPatterns"]') as HTMLElement;
    const input = within(allowList).getByRole('textbox');

    pasteInto(input, 'git status\ngit status\nls -la');

    expect(updateConfig).toHaveBeenCalledTimes(1);
    // Duplicate within the pasted batch collapses to one.
    expect(updateConfig).toHaveBeenCalledWith('tools.shell.allowPatterns', ['git status', 'ls -la']);
  });

  it('leaves a single-line paste to normal typing (no list write)', () => {
    installAppBridgeStub({});
    const updateConfig = vi.fn();
    render(<ToolSettings config={baseConfig()} updateConfig={updateConfig} />);

    const denyList = document.querySelector('[data-setting-id="tools.shell.denyPatterns"]') as HTMLElement;
    const input = within(denyList).getByRole('textbox');

    pasteInto(input, 'just-one-pattern');

    // A single-line paste is still just text entry — it commits on submit/blur,
    // not as a batch add.
    expect(updateConfig).not.toHaveBeenCalled();
  });
});
