import { describe, expect, it } from 'vitest';
import { sortModelsByDisplayName } from '../ModelSelector';

describe('sortModelsByDisplayName', () => {
  it('sorts formatted display labels alphabetically, case-insensitively', () => {
    const sorted = sortModelsByDisplayName([
      { key: 'z', displayName: 'Zulu' },
      { key: 'a2', displayName: 'alpha 10' },
      { key: 'b', displayName: 'Beta' },
      { key: 'a1', displayName: 'Alpha 2' },
    ]);

    expect(sorted.map((model) => model.key)).toEqual(['a1', 'a2', 'b', 'z']);
  });

  it('does not mutate the catalog array', () => {
    const models = [
      { key: 'b', displayName: 'beta' },
      { key: 'a', displayName: 'Alpha' },
    ];
    const original = [...models];

    sortModelsByDisplayName(models);

    expect(models).toEqual(original);
  });
});
