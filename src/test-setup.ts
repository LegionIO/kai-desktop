import { expect, afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

// Mock window.app IPC client
global.window = global.window || {};
(global.window as any).app = {
  agent: {
    onStreamEvent: vi.fn(() => () => {}),
    stream: vi.fn(),
    sendSubAgentMessage: vi.fn(),
    stopSubAgent: vi.fn(),
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
