import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installAppBridgeStub, uninstallAppBridgeStub } from '../../../../test-utils/app-bridge-stub';
import { ConfigProvider } from '@/providers/ConfigProvider';
import { ThreadSettingsModal } from '../ThreadSettingsModal';

afterEach(() => uninstallAppBridgeStub());

describe('ThreadSettingsModal Browser-authority admission', () => {
  it('does not finalize optimistic settings or notify the active thread after a rejected write', async () => {
    const put = vi.fn(async () => ({ rejected: 'native-browser-authority-required' }));
    installAppBridgeStub({
      config: { get: async () => ({ models: { catalog: [] }, profiles: [] }) },
      agent: { getAvailableRuntimes: async () => [] },
      conversations: {
        get: async () => ({
          id: 'browser-owned',
          fallbackEnabled: false,
          selectedModelKey: null,
          selectedProfileKey: null,
        }),
        put,
      },
    });
    const settingsChanged = vi.fn();
    window.addEventListener('thread-settings-changed', settingsChanged);

    try {
      render(
        <ConfigProvider>
          <ThreadSettingsModal open conversationId="browser-owned" isActiveConversation onClose={vi.fn()} />
        </ConfigProvider>,
      );

      const fallback = await screen.findByRole('checkbox', { name: 'Enable model fallback' });
      expect(fallback).not.toBeChecked();
      fireEvent.click(fallback);

      await waitFor(() => expect(put).toHaveBeenCalledWith(expect.objectContaining({ fallbackEnabled: true })));
      expect(fallback).not.toBeChecked();
      expect(settingsChanged).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('thread-settings-changed', settingsChanged);
    }
  });

  it('publishes a successful setting completion for its original conversation after the modal switches', async () => {
    let resolvePut: ((value: { ok: true }) => void) | undefined;
    const put = vi.fn(
      () =>
        new Promise<{ ok: true }>((resolve) => {
          resolvePut = resolve;
        }),
    );
    const get = vi.fn(async (conversationId: string) => ({
      id: conversationId,
      fallbackEnabled: false,
      selectedModelKey: null,
      selectedProfileKey: null,
    }));
    installAppBridgeStub({
      config: { get: async () => ({ models: { catalog: [] }, profiles: [] }) },
      agent: { getAvailableRuntimes: async () => [] },
      conversations: { get, put },
    });
    const settingsChanged = vi.fn();
    window.addEventListener('thread-settings-changed', settingsChanged);

    try {
      const rendered = render(
        <ConfigProvider>
          <ThreadSettingsModal open conversationId="chat-a" isActiveConversation onClose={vi.fn()} />
        </ConfigProvider>,
      );

      const fallback = await screen.findByRole('checkbox', { name: 'Enable model fallback' });
      fireEvent.click(fallback);
      await waitFor(() => expect(put).toHaveBeenCalledWith(expect.objectContaining({ id: 'chat-a' })));

      rendered.rerender(
        <ConfigProvider>
          <ThreadSettingsModal open conversationId="chat-b" isActiveConversation onClose={vi.fn()} />
        </ConfigProvider>,
      );
      await waitFor(() => expect(get).toHaveBeenCalledWith('chat-b'));
      await waitFor(() => expect(fallback).not.toBeChecked());

      await act(async () => {
        resolvePut?.({ ok: true });
        await Promise.resolve();
      });
      expect(fallback).not.toBeChecked();
      expect(settingsChanged).toHaveBeenCalledOnce();
      expect(settingsChanged.mock.calls[0]?.[0]).toMatchObject({
        detail: { conversationId: 'chat-a', fallbackEnabled: true },
      });
    } finally {
      window.removeEventListener('thread-settings-changed', settingsChanged);
    }
  });

  it('applies persisted runtime side effects after the modal closes', async () => {
    let resolvePut: ((value: { ok: true }) => void) | undefined;
    const put = vi.fn(
      () =>
        new Promise<{ ok: true }>((resolve) => {
          resolvePut = resolve;
        }),
    );
    const configSet = vi.fn(async () => undefined);
    installAppBridgeStub({
      config: {
        get: async () => ({ models: { catalog: [] }, profiles: [], agent: { runtime: 'auto' } }),
        set: configSet,
      },
      agent: {
        getAvailableRuntimes: async () => [{ id: 'codex', name: 'Codex', available: true }],
      },
      conversations: {
        get: async () => ({
          id: 'chat-a',
          fallbackEnabled: false,
          selectedModelKey: null,
          selectedProfileKey: null,
          runtimeOverride: null,
        }),
        put,
      },
    });
    const settingsChanged = vi.fn();
    window.addEventListener('thread-settings-changed', settingsChanged);

    try {
      const rendered = render(
        <ConfigProvider>
          <ThreadSettingsModal open conversationId="chat-a" isActiveConversation onClose={vi.fn()} />
        </ConfigProvider>,
      );
      const runtimeLabel = await screen.findByText('Runtime');
      const runtimeSelect = runtimeLabel.parentElement?.parentElement?.querySelector('select');
      expect(runtimeSelect).not.toBeNull();
      fireEvent.change(runtimeSelect!, { target: { value: 'codex' } });
      await waitFor(() => expect(put).toHaveBeenCalledWith(expect.objectContaining({ runtimeOverride: 'codex' })));

      rendered.rerender(
        <ConfigProvider>
          <ThreadSettingsModal open={false} conversationId="chat-a" isActiveConversation onClose={vi.fn()} />
        </ConfigProvider>,
      );
      await act(async () => {
        resolvePut?.({ ok: true });
        await Promise.resolve();
      });

      await waitFor(() => expect(configSet).toHaveBeenCalledWith('agent.runtime', 'codex'));
      expect(settingsChanged).toHaveBeenCalledOnce();
      expect(settingsChanged.mock.calls[0]?.[0]).toMatchObject({
        detail: { conversationId: 'chat-a', runtimeOverride: 'codex' },
      });
    } finally {
      window.removeEventListener('thread-settings-changed', settingsChanged);
    }
  });
});
