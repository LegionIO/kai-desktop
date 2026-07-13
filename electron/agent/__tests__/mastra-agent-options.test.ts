/**
 * Tests for mastra-agent.ts provider-tool option normalizers (via __internal).
 * These shape the options passed to the model API for provider-defined tools
 * (web search context size, approximate location, allowed-domain filters), and
 * the get*Option accessors are the type-safe multi-key readers they build on.
 */
import { describe, it, expect } from 'vitest';
import { __internal } from '../mastra-agent.js';

const {
  compactToolArgs,
  getStringOption,
  getNumberOption,
  getBooleanOption,
  getStringArrayOption,
  getRecordOption,
  normalizeSearchContextSize,
  normalizeApproximateLocation,
  normalizeOpenAIWebSearchFilters,
  normalizeProviderToolType,
} = __internal;

describe('compactToolArgs', () => {
  it('drops undefined values, keeps everything else (incl. null/false/0/"")', () => {
    expect(compactToolArgs({ a: 1, b: undefined, c: null, d: false, e: 0, f: '' })).toEqual({
      a: 1,
      c: null,
      d: false,
      e: 0,
      f: '',
    });
  });
});

describe('get*Option accessors', () => {
  it('getStringOption: first non-empty trimmed string across keys', () => {
    expect(getStringOption({ a: '  ', b: 'x' }, 'a', 'b')).toBe('x');
    expect(getStringOption({ a: 5 }, 'a')).toBeUndefined();
    expect(getStringOption({}, 'a')).toBeUndefined();
  });
  it('getNumberOption: first finite number', () => {
    expect(getNumberOption({ a: NaN, b: 3 }, 'a', 'b')).toBe(3);
    expect(getNumberOption({ a: Infinity }, 'a')).toBeUndefined();
    expect(getNumberOption({ a: '3' }, 'a')).toBeUndefined();
  });
  it('getBooleanOption: first real boolean', () => {
    expect(getBooleanOption({ a: false }, 'a')).toBe(false);
    expect(getBooleanOption({ a: 'true' }, 'a')).toBeUndefined();
  });
  it('getStringArrayOption: first array with >=1 non-empty string, filtered', () => {
    expect(getStringArrayOption({ a: ['x', '  ', 'y', 5] }, 'a')).toEqual(['x', 'y']);
    expect(getStringArrayOption({ a: ['   '] }, 'a')).toBeUndefined(); // all empty → undefined
    expect(getStringArrayOption({ a: 'x' }, 'a')).toBeUndefined(); // not an array
  });
  it('getRecordOption: first plain-object value', () => {
    expect(getRecordOption({ a: { k: 1 } }, 'a')).toEqual({ k: 1 });
    expect(getRecordOption({ a: [1] }, 'a')).toBeUndefined(); // arrays are not records
    expect(getRecordOption({ a: 'x' }, 'a')).toBeUndefined();
  });
});

describe('normalizeSearchContextSize', () => {
  it('passes the low/medium/high enum, rejects anything else', () => {
    expect(normalizeSearchContextSize('low')).toBe('low');
    expect(normalizeSearchContextSize('high')).toBe('high');
    expect(normalizeSearchContextSize('huge')).toBeUndefined();
    expect(normalizeSearchContextSize(undefined)).toBeUndefined();
  });
});

describe('normalizeApproximateLocation', () => {
  it('requires type:"approximate" and picks the known string fields', () => {
    expect(
      normalizeApproximateLocation({
        type: 'approximate',
        country: 'US',
        city: 'NYC',
        region: 'NY',
        timezone: 'America/New_York',
        extra: 'x',
      }),
    ).toEqual({ type: 'approximate', country: 'US', city: 'NYC', region: 'NY', timezone: 'America/New_York' });
  });
  it('returns undefined without the approximate type, or with none set', () => {
    expect(normalizeApproximateLocation({ type: 'exact', city: 'NYC' })).toBeUndefined();
    expect(normalizeApproximateLocation(undefined)).toBeUndefined();
    expect(normalizeApproximateLocation({ type: 'approximate' })).toEqual({ type: 'approximate' });
  });
  it('omits empty/whitespace/non-string fields', () => {
    expect(normalizeApproximateLocation({ type: 'approximate', country: '  ', city: 5 })).toEqual({
      type: 'approximate',
    });
  });
});

describe('normalizeOpenAIWebSearchFilters', () => {
  it('accepts allowedDomains and the allowed_domains alias', () => {
    expect(normalizeOpenAIWebSearchFilters({ allowedDomains: ['a.com'] })).toEqual({ allowedDomains: ['a.com'] });
    expect(normalizeOpenAIWebSearchFilters({ allowed_domains: ['b.com'] })).toEqual({ allowedDomains: ['b.com'] });
  });
  it('returns undefined when no valid domains', () => {
    expect(normalizeOpenAIWebSearchFilters({})).toBeUndefined();
    expect(normalizeOpenAIWebSearchFilters({ allowedDomains: [] })).toBeUndefined();
    expect(normalizeOpenAIWebSearchFilters(undefined)).toBeUndefined();
  });
});

describe('normalizeProviderToolType', () => {
  it('lowercases and strips the namespace before the last dot', () => {
    expect(normalizeProviderToolType({ type: 'WebSearch' })).toBe('websearch');
    expect(normalizeProviderToolType({ type: 'openai.web_search' })).toBe('web_search');
    expect(normalizeProviderToolType({ type: 'a.b.c' })).toBe('c');
  });
  it('returns undefined when type is missing / non-string', () => {
    expect(normalizeProviderToolType({})).toBeUndefined();
    expect(normalizeProviderToolType({ type: 5 })).toBeUndefined();
  });
});
