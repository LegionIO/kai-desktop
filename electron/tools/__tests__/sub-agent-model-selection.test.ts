import { describe, it, expect, vi } from 'vitest';

// sub-agent.ts pulls electron + the mastra agent at import time; stub the heavy
// / native deps so we can import the pure selection helper in isolation.
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }));
vi.mock('../../web-server/web-clients.js', () => ({ broadcastToWebClients: vi.fn() }));
vi.mock('../../agent/mastra-agent.js', () => ({
  streamAgentResponse: vi.fn(),
  streamWithFallback: vi.fn(),
  getProviderDefinedToolNames: () => [],
}));
vi.mock('../../agent/hooks/dispatcher.js', () => ({
  hookDispatcher: { dispatch: vi.fn(), hasEnforcingHooksFor: () => false },
}));
vi.mock('../../agent/model-catalog.js', () => ({
  resolveModelForThread: vi.fn(),
  resolveStreamConfig: vi.fn(),
}));

import { resolveSubAgentModelSelection } from '../sub-agent.js';

describe('resolveSubAgentModelSelection — profile/model precedence', () => {
  const base = { parentProfileKey: null, parentModelKey: null, defaultModel: null };

  it('1. explicit profile wins (chain), ignores model', () => {
    expect(
      resolveSubAgentModelSelection({ ...base, profile: 'fast', model: 'gpt-x', parentProfileKey: 'parent' }),
    ).toEqual({ threadProfileKey: 'fast', threadModelKey: null });
  });

  it("explicit profile '__none__' forces no profile", () => {
    expect(resolveSubAgentModelSelection({ ...base, profile: '__none__', parentProfileKey: 'parent' })).toEqual({
      threadProfileKey: '__none__',
      threadModelKey: null,
    });
  });

  it('2. explicit model → single model, no profile', () => {
    expect(resolveSubAgentModelSelection({ ...base, model: 'claude-x', parentProfileKey: 'parent' })).toEqual({
      threadProfileKey: '__none__',
      threadModelKey: 'claude-x',
    });
  });

  it('3. inherits the parent profile when neither profile nor model given', () => {
    expect(resolveSubAgentModelSelection({ ...base, parentProfileKey: 'parent-profile' })).toEqual({
      threadProfileKey: 'parent-profile',
      threadModelKey: null,
    });
  });

  it('the Settings default-model override beats implicit parent inheritance', () => {
    // An explicit subAgents.defaultModel is a user choice → wins over the parent
    // profile/model that would otherwise be inherited.
    expect(
      resolveSubAgentModelSelection({
        ...base,
        defaultModel: 'override-m',
        parentProfileKey: 'parent-profile',
        parentModelKey: 'parent-m',
      }),
    ).toEqual({ threadProfileKey: '__none__', threadModelKey: 'override-m' });
  });

  it('an explicit call profile/model still beats the default-model override', () => {
    expect(resolveSubAgentModelSelection({ ...base, profile: 'fast', defaultModel: 'override-m' })).toEqual({
      threadProfileKey: 'fast',
      threadModelKey: null,
    });
    expect(resolveSubAgentModelSelection({ ...base, model: 'call-m', defaultModel: 'override-m' })).toEqual({
      threadProfileKey: '__none__',
      threadModelKey: 'call-m',
    });
  });

  it('4. inherits the parent model when parent had no profile', () => {
    expect(resolveSubAgentModelSelection({ ...base, parentProfileKey: null, parentModelKey: 'parent-model' })).toEqual({
      threadProfileKey: '__none__',
      threadModelKey: 'parent-model',
    });
  });

  it("treats a parent '__none__' profile as no profile (fall to parent/default model)", () => {
    expect(resolveSubAgentModelSelection({ ...base, parentProfileKey: '__none__', parentModelKey: 'pm' })).toEqual({
      threadProfileKey: '__none__',
      threadModelKey: 'pm',
    });
  });

  it('5. falls back to the configured default model', () => {
    expect(resolveSubAgentModelSelection({ ...base, defaultModel: 'default-m' })).toEqual({
      threadProfileKey: '__none__',
      threadModelKey: 'default-m',
    });
  });

  it('nothing available → null model, no profile', () => {
    expect(resolveSubAgentModelSelection({ ...base })).toEqual({ threadProfileKey: '__none__', threadModelKey: null });
  });
});
