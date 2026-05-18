import { expect, afterEach, vi } from 'vitest';

// Define global variables that Electron provides
(global as Record<string, unknown>).__BRAND_MEDIA_PROTOCOL = 'kai-media';

// Kai is a macOS-only product. Several modules under test guard native paths with
// `process.platform === 'darwin'`. CI runs on Linux runners, so force the platform
// to darwin here to keep platform-gated code paths exercised everywhere tests run.
if (process.platform !== 'darwin') {
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
}

// DOM-specific setup — only runs in jsdom environment (src/** tests)
if (typeof document !== 'undefined') {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { cleanup } = require('@testing-library/react');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const matchers = require('@testing-library/jest-dom/matchers');

  // Extend Vitest's expect with jest-dom matchers
  expect.extend(matchers);

  // Cleanup after each test
  afterEach(() => {
    cleanup();
  });

  // Mock document.execCommand for RichChatInput
  document.execCommand = vi.fn().mockImplementation(() => true);

  // Mock window.matchMedia
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });

  // Mock IntersectionObserver
  global.IntersectionObserver = class IntersectionObserver {
    constructor() {}
    disconnect() {}
    observe() {}
    takeRecords() {
      return [];
    }
    unobserve() {}
  } as unknown as typeof IntersectionObserver;

  // Mock ResizeObserver
  global.ResizeObserver = class ResizeObserver {
    constructor() {}
    disconnect() {}
    observe() {}
    unobserve() {}
  } as unknown as typeof ResizeObserver;
}
