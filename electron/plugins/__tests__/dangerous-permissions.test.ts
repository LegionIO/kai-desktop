/**
 * Pins the shared DANGEROUS_PLUGIN_PERMISSIONS set — the SINGLE SOURCE OF TRUTH
 * for which plugin permissions require explicit user consent (imported by both
 * plugin-manager.ts's runtime consent gate and marketplace-service.ts's install
 * flow, replacing the two previously-duplicated copies). This set is security-
 * critical: narrowing it (e.g. dropping 'agent:hook') would let a plugin with
 * that capability load/install WITHOUT consent. This test fails if the set is
 * accidentally changed, forcing the change to be deliberate.
 */
import { describe, it, expect } from 'vitest';
import { DANGEROUS_PLUGIN_PERMISSIONS } from '../types.js';

describe('DANGEROUS_PLUGIN_PERMISSIONS', () => {
  it('contains exactly the code-execution / secret-read / network-exposure capabilities that require consent', () => {
    expect([...DANGEROUS_PLUGIN_PERMISSIONS].sort()).toEqual([
      'agent:hook',
      'config:read-secrets',
      'exec:whitelisted',
      'http:listen:network',
    ]);
  });

  it('includes each individually (a narrowing that drops one is a consent-gate regression)', () => {
    expect(DANGEROUS_PLUGIN_PERMISSIONS.has('exec:whitelisted')).toBe(true); // run binaries
    expect(DANGEROUS_PLUGIN_PERMISSIONS.has('config:read-secrets')).toBe(true); // read provider keys/secrets
    expect(DANGEROUS_PLUGIN_PERMISSIONS.has('agent:hook')).toBe(true); // MITM the agent loop
    expect(DANGEROUS_PLUGIN_PERMISSIONS.has('http:listen:network')).toBe(true); // expose local server to LAN
  });

  it('does NOT flag a benign permission as dangerous', () => {
    expect(DANGEROUS_PLUGIN_PERMISSIONS.has('config:read' as never)).toBe(false);
    expect(DANGEROUS_PLUGIN_PERMISSIONS.has('ui:banner' as never)).toBe(false);
    expect(DANGEROUS_PLUGIN_PERMISSIONS.has('network:fetch' as never)).toBe(false);
  });
});
