/**
 * WindowsStubHarness (#82, ADR-0005).
 *
 * A terminal, no-op computer-use harness for the `local-windows` target. Every
 * method rejects with a typed `ComputerHarnessUnsupportedError` — the harness
 * NEVER touches `permissions.ts`, the native helper, or any `xcrun`/OS path,
 * and orchestration must surface the failure rather than fall back to another
 * harness or swallow it into a success. This is the honest placeholder until a
 * native Windows harness (UIAutomation/SendInput/capture) is built.
 */

import type {
  ComputerEnvironmentMetadata,
  ComputerFrame,
  ComputerSession,
  ComputerUseTarget,
} from '../../../shared/computer-use.js';
import type { ComputerHarness, ComputerHarnessActionResult } from './shared.js';

export class ComputerHarnessUnsupportedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'ComputerHarnessUnsupportedError';
  }
}

const UNSUPPORTED_REASON =
  'Local computer use is not available on Windows yet. Use the isolated browser target instead.';

function unsupported(): never {
  throw new ComputerHarnessUnsupportedError(UNSUPPORTED_REASON);
}

export class WindowsStubHarness implements ComputerHarness {
  readonly target: ComputerUseTarget = 'local-windows';

  async initialize(_session: ComputerSession): Promise<void> {
    unsupported();
  }

  async dispose(_sessionId: string): Promise<void> {
    // dispose must be safe to call unconditionally (orchestrator cleanup),
    // and there is nothing to tear down — a stub never allocated anything.
  }

  async captureFrame(_session: ComputerSession): Promise<ComputerFrame> {
    unsupported();
  }

  async movePointer(): Promise<ComputerHarnessActionResult> {
    unsupported();
  }

  async click(): Promise<ComputerHarnessActionResult> {
    unsupported();
  }

  async doubleClick(): Promise<ComputerHarnessActionResult> {
    unsupported();
  }

  async drag(): Promise<ComputerHarnessActionResult> {
    unsupported();
  }

  async scroll(): Promise<ComputerHarnessActionResult> {
    unsupported();
  }

  async typeText(): Promise<ComputerHarnessActionResult> {
    unsupported();
  }

  async pressKeys(): Promise<ComputerHarnessActionResult> {
    unsupported();
  }

  async openApp(): Promise<ComputerHarnessActionResult> {
    unsupported();
  }

  async focusWindow(): Promise<ComputerHarnessActionResult> {
    unsupported();
  }

  async navigate(): Promise<ComputerHarnessActionResult> {
    unsupported();
  }

  async waitForIdle(): Promise<ComputerHarnessActionResult> {
    unsupported();
  }

  async getEnvironmentMetadata(_session: ComputerSession): Promise<ComputerEnvironmentMetadata> {
    unsupported();
  }
}
