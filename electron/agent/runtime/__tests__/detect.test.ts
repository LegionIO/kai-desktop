/**
 * Tests for runtime/detect.ts — CLI availability detection with a documented
 * cache contract: a SUCCESS (resolved path string) is cached for the process
 * lifetime, but a MISS (binary not on PATH) is rechecked on every call, because
 * Kai resolves the user's shell PATH asynchronously at startup and a user may
 * install a CLI while Kai is running. resetDetectionCache() clears everything.
 * The resolver (resolveBinaryPathSync) is mocked so we can assert call counts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const resolveBinaryPathSync = vi.fn();
vi.mock('../../../utils/shell-env.js', () => ({
  resolveBinaryPathSync: (...a: unknown[]) => resolveBinaryPathSync(...a),
}));

import {
  detectClaudeAgentSdk,
  resolveClaudeCliPath,
  detectCodexSdk,
  detectPiCli,
  resolvePiCliPath,
  resetDetectionCache,
} from '../detect.js';

beforeEach(() => {
  vi.clearAllMocks();
  resetDetectionCache();
});

describe('detect.ts — success is cached, miss is rechecked', () => {
  it('detectClaudeAgentSdk returns true and caches the resolved path (resolver called once)', async () => {
    resolveBinaryPathSync.mockReturnValue('/usr/local/bin/claude');
    expect(await detectClaudeAgentSdk()).toBe(true);
    expect(await detectClaudeAgentSdk()).toBe(true);
    // A cached string short-circuits — resolver runs only on the first call.
    expect(resolveBinaryPathSync).toHaveBeenCalledTimes(1);
    expect(resolveBinaryPathSync).toHaveBeenCalledWith('claude');
  });

  it('a MISS is rechecked on every call (so a later install is picked up)', async () => {
    resolveBinaryPathSync.mockReturnValue(null); // not on PATH
    expect(await detectClaudeAgentSdk()).toBe(false);
    expect(await detectClaudeAgentSdk()).toBe(false);
    expect(resolveBinaryPathSync).toHaveBeenCalledTimes(2); // rechecked, not cached
  });

  it('miss-then-install: recheck flips false → true without a manual reset', async () => {
    resolveBinaryPathSync.mockReturnValueOnce(null); // first check: absent
    expect(await detectCodexSdk()).toBe(false);
    resolveBinaryPathSync.mockReturnValue('/opt/homebrew/bin/codex'); // user installs it
    expect(await detectCodexSdk()).toBe(true);
    expect(await detectCodexSdk()).toBe(true); // now cached
    // 1 (miss) + 1 (hit that caches) = 2; the third call is served from cache.
    expect(resolveBinaryPathSync).toHaveBeenCalledTimes(2);
  });
});

describe('detect.ts — path resolvers return the string or undefined', () => {
  it('resolveClaudeCliPath returns the absolute path when found, undefined when missing', async () => {
    resolveBinaryPathSync.mockReturnValue('/usr/local/bin/claude');
    expect(await resolveClaudeCliPath()).toBe('/usr/local/bin/claude');

    resetDetectionCache();
    resolveBinaryPathSync.mockReturnValue(null);
    expect(await resolveClaudeCliPath()).toBeUndefined();
  });

  it('resolvePiCliPath mirrors the same found/undefined contract', async () => {
    resolveBinaryPathSync.mockReturnValue('/usr/bin/pi');
    expect(await resolvePiCliPath()).toBe('/usr/bin/pi');
    // Cached: detectPiCli now sees the cached string and returns true without re-resolving.
    expect(await detectPiCli()).toBe(true);
    expect(resolveBinaryPathSync).toHaveBeenCalledTimes(1);
  });
});

describe('detect.ts — resetDetectionCache forces a fresh resolve', () => {
  it('clears a cached success so the next call re-resolves', async () => {
    resolveBinaryPathSync.mockReturnValue('/usr/local/bin/claude');
    await detectClaudeAgentSdk();
    expect(resolveBinaryPathSync).toHaveBeenCalledTimes(1);

    resetDetectionCache();
    await detectClaudeAgentSdk();
    expect(resolveBinaryPathSync).toHaveBeenCalledTimes(2); // re-resolved after reset
  });
});
