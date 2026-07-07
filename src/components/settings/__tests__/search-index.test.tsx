import { describe, it, expect } from 'vitest';
import { searchSettings, breadcrumb, SETTINGS_INDEX, TAB_LABELS } from '../search-index';

describe('searchSettings', () => {
  it('returns empty for blank/whitespace query', () => {
    expect(searchSettings('')).toEqual([]);
    expect(searchSettings('   ')).toEqual([]);
  });

  it('matches by label, case-insensitive', () => {
    const results = searchSettings('MAX TURNS');
    expect(results.some((r) => r.id === 'agent.maxTurns')).toBe(true);
  });

  it('matches by config-path id', () => {
    const results = searchSettings('webServer.port');
    expect(results.some((r) => r.id === 'webServer.port')).toBe(true);
  });

  it('matches by keyword synonym', () => {
    const results = searchSettings('dark mode');
    expect(results.some((r) => r.id === 'ui.theme')).toBe(true);
  });

  it('surfaces all max-turns/steps settings for "max"', () => {
    const ids = searchSettings('max').map((r) => r.id);
    expect(ids).toContain('agent.maxTurns');
    expect(ids).toContain('profile.maxSteps');
    expect(ids).toContain('advanced.maxSteps');
  });

  it('caps results at 30', () => {
    expect(searchSettings('e').length).toBeLessThanOrEqual(30);
  });
});

describe('breadcrumb', () => {
  it('renders section only when no tab', () => {
    expect(breadcrumb({ id: 'x', label: 'x', section: 'audio' })).toBe('Audio');
  });

  it('renders section › tab when tab present', () => {
    expect(breadcrumb({ id: 'x', label: 'x', section: 'models', tab: 'runtimes' })).toBe('Models › Runtimes');
  });
});

describe('SETTINGS_INDEX integrity', () => {
  it('has unique ids', () => {
    const ids = SETTINGS_INDEX.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every tab key has a display label', () => {
    for (const e of SETTINGS_INDEX) {
      if (e.tab) expect(TAB_LABELS[e.tab]).toBeDefined();
    }
  });
});
