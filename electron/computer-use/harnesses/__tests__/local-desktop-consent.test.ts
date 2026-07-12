/**
 * Tests for the experimental screen-capture consent gate in LocalDesktopHarness
 * (ADR-0005 experimental-on privacy fix). On Windows/Linux this harness
 * screenshots all displays via nut-js with NO OS screen-recording consent
 * prompt, so initialize() must refuse to start until the user opts in via
 * computerUse.safety.experimentalScreenCaptureConsent. macOS (OS TCC gates
 * capture) is unaffected. electron is mocked; process.platform is overridden.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { on: vi.fn(), getPath: () => '/tmp' },
  BrowserWindow: { getAllWindows: () => [] },
  nativeImage: { createFromBuffer: () => ({}) },
}));

import { LocalDesktopHarness } from '../local-desktop.js';
import type { AppConfig } from '../../../config/schema.js';
import type { ComputerSession } from '../../../../shared/computer-use.js';

const original = process.platform;
const setPlatform = (p: NodeJS.Platform) =>
  Object.defineProperty(process, 'platform', { value: p, configurable: true });
afterEach(() => Object.defineProperty(process, 'platform', { value: original, configurable: true }));

const configWith = (consent: boolean): AppConfig =>
  ({ computerUse: { safety: { experimentalScreenCaptureConsent: consent } } }) as unknown as AppConfig;

const session = {} as ComputerSession;
const CONSENT_MSG = /experimental on this platform and captures your screen/i;

describe('LocalDesktopHarness experimental screen-capture consent gate', () => {
  it('refuses to initialize on win32 when consent is off (fail-closed, no capture)', async () => {
    setPlatform('win32');
    const h = new LocalDesktopHarness(() => configWith(false));
    await expect(h.initialize(session)).rejects.toThrow(CONSENT_MSG);
  });

  it('does not throw the CONSENT error on win32 when consent is on', async () => {
    setPlatform('win32');
    const h = new LocalDesktopHarness(() => configWith(true));
    // It may still reject later (no real nut-js helper in the test env), but the
    // rejection must NOT be the consent refusal — the gate is passed.
    let err: Error | null = null;
    try {
      await h.initialize(session);
    } catch (e) {
      err = e as Error;
    }
    if (err) expect(err.message).not.toMatch(CONSENT_MSG);
  });

  it('never applies the consent gate on darwin (native, non-experimental)', async () => {
    setPlatform('darwin');
    const h = new LocalDesktopHarness(() => configWith(false));
    let err: Error | null = null;
    try {
      await h.initialize(session);
    } catch (e) {
      err = e as Error;
    }
    // On darwin the consent gate is skipped entirely; any error is about the
    // helper/adapter, never the experimental consent refusal.
    if (err) expect(err.message).not.toMatch(CONSENT_MSG);
  });
});
