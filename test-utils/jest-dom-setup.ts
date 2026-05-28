/**
 * Jest-DOM matcher registration and jsdom globals. Loaded only by the
 * component-test config (`vitest.component.config.ts`) so the unit and
 * integration slices keep a clean global namespace.
 *
 * The jsdom shims below (matchMedia, IntersectionObserver, ResizeObserver,
 * document.execCommand) exist because jsdom does not implement them and
 * Radix UI primitives, Tailwind motion plugins, and contenteditable
 * components consult these APIs at render time.
 */

import { afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

// Cleanup mounted components after each component test so React tree state
// does not leak between assertions.
afterEach(() => {
  cleanup();
});

// document.execCommand is used by rich-text input fallbacks; jsdom returns
// undefined by default which throws under strict TS.
document.execCommand = vi.fn().mockImplementation(() => true);

// window.matchMedia is consulted by Radix tooltip + scroll-area for reduced
// motion / hover capability detection.
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

// IntersectionObserver is consulted by virtualized lists and lazy-mounted
// dropdowns. Minimal no-op shim is sufficient for unit-level component tests.
(globalThis as unknown as { IntersectionObserver: typeof IntersectionObserver }).IntersectionObserver =
  class IntersectionObserver {
    constructor() {}
    disconnect() {}
    observe() {}
    takeRecords(): IntersectionObserverEntry[] {
      return [];
    }
    unobserve() {}
  } as unknown as typeof IntersectionObserver;

// ResizeObserver is used by Radix scroll-area and the markdown code-block
// wrapper. Same no-op shape as IntersectionObserver.
(globalThis as unknown as { ResizeObserver: typeof ResizeObserver }).ResizeObserver =
  class ResizeObserver {
    constructor() {}
    disconnect() {}
    observe() {}
    unobserve() {}
  } as unknown as typeof ResizeObserver;
