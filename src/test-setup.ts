import { afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

// Mock window.app IPC client
globalThis.window = globalThis.window || ({} as Window & typeof globalThis);
(globalThis.window as unknown as { app: unknown }).app = {
  agent: {
    onStreamEvent: vi.fn(() => () => {}),
    stream: vi.fn(),
    sendSubAgentMessage: vi.fn(),
    stopSubAgent: vi.fn(),
    injectMidTurn: vi.fn().mockResolvedValue({ ok: true, cooperative: true, id: 'inj-test' }),
    listInjects: vi.fn().mockResolvedValue([]),
    cancelInject: vi.fn().mockResolvedValue({ ok: true }),
  },
  conversations: {
    getActiveId: vi.fn().mockResolvedValue('test-conversation'),
    onChanged: vi.fn(() => () => {}),
    list: vi.fn().mockResolvedValue([]),
    get: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    persist: vi.fn(),
  },
  settings: {
    get: vi.fn(),
    update: vi.fn(),
  },
};

// Cleanup after each test
afterEach(() => {
  cleanup();
});
