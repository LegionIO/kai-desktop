// @vitest-environment node
/**
 * Tests for computer-use model-chain resolution — that the PRIMARY model and the
 * FALLBACK chain are both derived from the active profile (not just from a
 * session-level model key), matching how chat/sub-agent/task agents resolve.
 */
import { describe, it, expect, vi } from 'vitest';

// The orchestrator imports provider SDKs + native harnesses at module load;
// stub the heavy graph so we can import the pure chain resolvers in isolation.
vi.mock('./provider-adapters/anthropic.js', () => ({ anthropicPlanSession: vi.fn() }));
vi.mock('./provider-adapters/gemini.js', () => ({ geminiPlanSession: vi.fn() }));
vi.mock('./provider-adapters/openai.js', () => ({ openaiPlanSession: vi.fn() }));
vi.mock('./harnesses/isolated-browser.js', () => ({ IsolatedBrowserHarness: class {} }));
vi.mock('./harnesses/local-desktop.js', () => ({ LocalDesktopHarness: class {} }));
vi.mock('./harnesses/local-macos.js', () => ({ LocalMacosHarness: class {} }));
vi.mock('./harnesses/windows-stub.js', () => ({ WindowsStubHarness: class {} }));

import { getEntryForRole, getModelChainForRole } from '../orchestrator.js';
import type { AppConfig } from '../../config/schema.js';
import type { ComputerSession } from '../../../shared/computer-use.js';

function mk(model: string) {
  return {
    key: model,
    displayName: model,
    modelName: model,
    provider: 'anthropic',
    apiEndpoint: '',
    apiKey: '',
  };
}

// Minimal AppConfig with a catalog of 3 models + one profile.
const config = {
  models: {
    defaultModelKey: 'default-m',
    catalog: [mk('default-m'), mk('profile-primary'), mk('profile-fb1'), mk('profile-fb2')],
    providers: { anthropic: { type: 'anthropic', apiKey: 'x' } },
  },
  profiles: [
    {
      key: 'fast',
      name: 'Fast',
      primaryModelKey: 'profile-primary',
      fallbackModelKeys: ['profile-fb1', 'profile-fb2'],
    },
  ],
  defaultProfileKey: null,
  computerUse: { models: {} },
  fallback: { modelKeys: [] },
  advanced: { maxRetries: 3 },
} as unknown as AppConfig;

const session = (over: Partial<ComputerSession> = {}): ComputerSession =>
  ({ selectedModelKey: null, selectedProfileKey: null, ...over }) as ComputerSession;

describe('computer-use getEntryForRole — primary follows the profile', () => {
  it('uses the profile primary when a profile is active and no session model is set', () => {
    const entry = getEntryForRole(config, session({ selectedProfileKey: 'fast' }), 'driver');
    expect(entry?.key).toBe('profile-primary');
  });

  it('a session-level model pick still wins over the profile primary', () => {
    const entry = getEntryForRole(
      config,
      session({ selectedProfileKey: 'fast', selectedModelKey: 'default-m' }),
      'driver',
    );
    expect(entry?.key).toBe('default-m');
  });

  it('falls to the global default model when neither profile nor session model is set', () => {
    const entry = getEntryForRole(config, session(), 'driver');
    expect(entry?.key).toBe('default-m');
  });
});

describe('computer-use getModelChainForRole — profile fallback chain', () => {
  it('builds primary + profile fallbacks when a profile is selected (auto-enables fallback)', () => {
    const chain = getModelChainForRole(config, session({ selectedProfileKey: 'fast' }), 'driver');
    expect(chain.map((c) => c.key)).toEqual(['profile-primary', 'profile-fb1', 'profile-fb2']);
  });

  it('returns primary-only when no profile and fallback not enabled', () => {
    const chain = getModelChainForRole(config, session({ selectedModelKey: 'default-m' }), 'driver');
    expect(chain.map((c) => c.key)).toEqual(['default-m']);
  });

  it('honors explicit fallbackEnabled with the profile chain even without a profile (global fallback)', () => {
    const cfg = { ...config, fallback: { modelKeys: ['profile-fb1'] } } as unknown as AppConfig;
    const chain = getModelChainForRole(
      cfg,
      session({ selectedModelKey: 'default-m', fallbackEnabled: true }),
      'driver',
    );
    expect(chain.map((c) => c.key)).toEqual(['default-m', 'profile-fb1']);
  });

  it('an explicit fallbackEnabled:false wins over a profile (user toggled it off)', () => {
    const chain = getModelChainForRole(
      config,
      session({ selectedProfileKey: 'fast', fallbackEnabled: false }),
      'driver',
    );
    // Fallback disabled → primary only, even though a profile is selected.
    expect(chain.map((c) => c.key)).toEqual(['profile-primary']);
  });
});
