/**
 * Tests for src/lib/agent-names.ts generateAgentName (component-gated via
 * 178f07b). It's random, but its CONTRACT is deterministic: output is an
 * "Adjective Noun" from the known lists, never collides with existingNames
 * (case-insensitive), and falls back to a numeric suffix when the combo space
 * is saturated. Math.random is spied to make the random path deterministic.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { generateAgentName } from '../agent-names';

const ADJECTIVES = new Set([
  'Swift',
  'Keen',
  'Bold',
  'Calm',
  'Bright',
  'Sharp',
  'Quick',
  'Sage',
  'Vivid',
  'Prime',
  'Noble',
  'Iron',
  'Rapid',
  'Clear',
  'Stout',
  'True',
  'Warm',
  'Deep',
  'Firm',
  'Grand',
  'Deft',
  'Sure',
  'Vast',
  'Core',
  'Arch',
  'Flux',
  'Apex',
  'Nova',
  'Pulse',
  'Drift',
]);
const NOUNS = new Set([
  'Atlas',
  'Prism',
  'Forge',
  'Scout',
  'Spark',
  'Nexus',
  'Orbit',
  'Aegis',
  'Vault',
  'Torch',
  'Flint',
  'Quill',
  'Relay',
  'Slate',
  'Crest',
  'Ember',
  'Ridge',
  'Helix',
  'Shard',
  'Onyx',
  'Rune',
  'Cipher',
  'Pilot',
  'Beacon',
  'Sentry',
  'Vortex',
  'Locus',
  'Zenith',
  'Paragon',
  'Bastion',
]);

afterEach(() => vi.restoreAllMocks());

describe('generateAgentName', () => {
  it('produces an "Adjective Noun" pair from the known lists', () => {
    for (let i = 0; i < 200; i++) {
      const [adj, noun, ...rest] = generateAgentName().split(' ');
      expect(rest).toHaveLength(0);
      expect(ADJECTIVES.has(adj), adj).toBe(true);
      expect(NOUNS.has(noun), noun).toBe(true);
    }
  });

  it('never returns a name already in existingNames (case-insensitive), over many draws', () => {
    const existing = ['Swift Atlas', 'keen prism', 'BOLD FORGE'];
    for (let i = 0; i < 500; i++) {
      const name = generateAgentName(existing);
      expect(existing.map((n) => n.toLowerCase())).not.toContain(name.toLowerCase());
    }
  });

  it('falls back to a numeric suffix when the random combo space is saturated', () => {
    // Math.random() = 0 → randomElement always picks index 0 → always "Swift Atlas".
    vi.spyOn(Math, 'random').mockReturnValue(0);
    // All 50 attempts collide with the existing "Swift Atlas" → fallback appends 2.
    expect(generateAgentName(['Swift Atlas'])).toBe('Swift Atlas 2');
  });

  it('increments the numeric suffix past existing numbered fallbacks', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    expect(generateAgentName(['Swift Atlas', 'Swift Atlas 2', 'swift atlas 3'])).toBe('Swift Atlas 4');
  });

  it('returns the plain combo when it does not collide (no suffix)', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    expect(generateAgentName([])).toBe('Swift Atlas');
  });
});
