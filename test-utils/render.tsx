/**
 * `renderWithProviders` — render a React component inside the same provider
 * stack `App.tsx` uses, so component tests see realistic context values.
 *
 * The real providers (`ConfigProvider`, `RuntimeProvider`, `AttachmentProvider`)
 * read their state from IPC (`window.app.*`). Tests that need specific values
 * should mock the IPC layer; the override slots on `RenderWithProvidersOptions`
 * are reserved for a future seam that exposes context-value overrides directly.
 */

import type { ReactNode } from 'react';
import { render, type RenderOptions, type RenderResult } from '@testing-library/react';
import { ConfigProvider } from '../src/providers/ConfigProvider';
import { AttachmentProvider } from '../src/providers/AttachmentContext';
import { RuntimeProvider } from '../src/providers/RuntimeProvider';

export interface RenderWithProvidersOptions extends Omit<RenderOptions, 'wrapper'> {
  /**
   * Reserved override for the value seen by ConfigProvider. Not currently
   * applied — ConfigProvider sources its state from IPC. Mock
   * `window.app.config.*` in tests until the override seam lands.
   */
  // TODO: Wire to a future ConfigProvider value override prop.
  configOverride?: Partial<unknown>;
  /**
   * Reserved override for the value seen by RuntimeProvider. Not currently
   * applied — RuntimeProvider sources its state from IPC.
   */
  // TODO: Wire to a future RuntimeProvider value override prop.
  runtimeOverride?: Partial<unknown>;
}

function Providers({ children }: { children: ReactNode }) {
  return (
    <ConfigProvider>
      <AttachmentProvider>
        <RuntimeProvider>{children}</RuntimeProvider>
      </AttachmentProvider>
    </ConfigProvider>
  );
}

export function renderWithProviders(ui: ReactNode, opts: RenderWithProvidersOptions = {}): RenderResult {
  const { configOverride: _configOverride, runtimeOverride: _runtimeOverride, ...rest } = opts;
  return render(ui as Parameters<typeof render>[0], { wrapper: Providers, ...rest });
}
