/**
 * Random agent name generator.
 *
 * Generates memorable names using an Adjective + Noun pattern.
 * ~900 unique combinations to avoid collisions.
 */

const ADJECTIVES = [
  'Swift', 'Keen', 'Bold', 'Calm', 'Bright',
  'Sharp', 'Quick', 'Sage', 'Vivid', 'Prime',
  'Noble', 'Iron', 'Rapid', 'Clear', 'Stout',
  'True', 'Warm', 'Deep', 'Firm', 'Grand',
  'Deft', 'Sure', 'Vast', 'Core', 'Arch',
  'Flux', 'Apex', 'Nova', 'Pulse', 'Drift',
];

const NOUNS = [
  'Atlas', 'Prism', 'Forge', 'Scout', 'Spark',
  'Nexus', 'Orbit', 'Aegis', 'Vault', 'Torch',
  'Flint', 'Quill', 'Relay', 'Slate', 'Crest',
  'Ember', 'Ridge', 'Helix', 'Shard', 'Onyx',
  'Rune', 'Cipher', 'Pilot', 'Beacon', 'Sentry',
  'Vortex', 'Locus', 'Zenith', 'Paragon', 'Bastion',
];

function randomElement<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * Generate a random agent name that doesn't collide with existing names.
 * Returns names like "Swift Atlas", "Keen Prism", "Bold Forge".
 */
export function generateAgentName(existingNames: string[] = []): string {
  const existing = new Set(existingNames.map((n) => n.toLowerCase()));

  // Try up to 50 times for a unique combo
  for (let i = 0; i < 50; i++) {
    const name = `${randomElement(ADJECTIVES)} ${randomElement(NOUNS)}`;
    if (!existing.has(name.toLowerCase())) return name;
  }

  // Fallback: append a number
  const base = `${randomElement(ADJECTIVES)} ${randomElement(NOUNS)}`;
  let suffix = 2;
  while (existing.has(`${base} ${suffix}`.toLowerCase())) suffix++;
  return `${base} ${suffix}`;
}
