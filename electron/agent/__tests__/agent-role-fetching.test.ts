/**
 * Tests for agent-role-fetching.ts — fetches role-template markdown from GitHub.
 * Focus: the defense-in-depth roleId validation added before URL interpolation
 * (an untrusted roleId must not path-traverse or alter the fetch target), plus
 * the cache-hit short-circuit. The network is mocked so no real request is made;
 * the key security assertion is that a malformed roleId is rejected WITHOUT any
 * https.get call.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

// Mock https.get so we can (a) assert it is NOT called for invalid ids and
// (b) feed a canned body for valid ids.
const httpsGetMock = vi.fn();
vi.mock('https', () => ({
  default: { get: (...args: unknown[]) => httpsGetMock(...args) },
  get: (...args: unknown[]) => httpsGetMock(...args),
}));

import { isValidRoleId, fetchRoleTemplate } from '../agent-role-fetching.js';

/** Build a fake https.get that returns a 200 with the given body. */
function stubOk(body: string) {
  httpsGetMock.mockImplementation(
    (_url: string, cb: (res: EventEmitter & { statusCode: number; headers: Record<string, string> }) => void) => {
      const res = Object.assign(new EventEmitter(), { statusCode: 200, headers: {} });
      const req = Object.assign(new EventEmitter(), { destroy: vi.fn(), setTimeout: vi.fn() });
      cb(res as never);
      queueMicrotask(() => {
        res.emit('data', Buffer.from(body, 'utf-8'));
        res.emit('end');
      });
      return req;
    },
  );
}

beforeEach(() => {
  httpsGetMock.mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('isValidRoleId', () => {
  it('accepts catalog-shaped ids (division/role-name, lowercase, hyphens)', () => {
    expect(isValidRoleId('engineering/engineering-code-reviewer')).toBe(true);
    expect(isValidRoleId('design/ui-designer')).toBe(true);
    expect(isValidRoleId('marketing')).toBe(true); // single segment ok
    expect(isValidRoleId('a/b/c')).toBe(true); // multiple segments ok
    expect(isValidRoleId('role123/sub-role-9')).toBe(true);
  });

  it('rejects path traversal and dot segments', () => {
    expect(isValidRoleId('../secret')).toBe(false);
    expect(isValidRoleId('x/../../../../etc/passwd')).toBe(false);
    expect(isValidRoleId('..')).toBe(false);
    expect(isValidRoleId('a/./b')).toBe(false);
    expect(isValidRoleId('a.md')).toBe(false); // no dots
  });

  it('rejects URL-authority-altering and encoded characters', () => {
    expect(isValidRoleId('@evil.com')).toBe(false);
    expect(isValidRoleId('x@evil.com')).toBe(false);
    expect(isValidRoleId('%2e%2e/x')).toBe(false);
    expect(isValidRoleId('a\\b')).toBe(false);
    expect(isValidRoleId('a?b')).toBe(false);
    expect(isValidRoleId('a#b')).toBe(false);
    expect(isValidRoleId('https://evil')).toBe(false);
    expect(isValidRoleId('a b')).toBe(false); // no spaces
  });

  it('rejects leading/trailing/double slashes and empties', () => {
    expect(isValidRoleId('/leading')).toBe(false);
    expect(isValidRoleId('trailing/')).toBe(false);
    expect(isValidRoleId('a//b')).toBe(false);
    expect(isValidRoleId('')).toBe(false);
    expect(isValidRoleId('Upper/Case')).toBe(false); // lowercase only
  });
});

describe('fetchRoleTemplate', () => {
  it('refuses an invalid roleId WITHOUT making a network call', async () => {
    const result = await fetchRoleTemplate('../../etc/passwd');
    expect(result).toBeNull();
    expect(httpsGetMock).not.toHaveBeenCalled();
  });

  it('fetches and returns the template body for a valid id', async () => {
    stubOk('# Role Template\nbody');
    const result = await fetchRoleTemplate('engineering/engineering-security-engineer');
    expect(result).toBe('# Role Template\nbody');
    expect(httpsGetMock).toHaveBeenCalledTimes(1);
    // URL is the catalog base + id + .md
    const calledUrl = httpsGetMock.mock.calls[0][0] as string;
    expect(calledUrl).toContain('raw.githubusercontent.com');
    expect(calledUrl).toContain('engineering/engineering-security-engineer.md');
  });

  it('serves a cached template without a second network call', async () => {
    stubOk('cached-body');
    const id = 'product/cache-test-role';
    const first = await fetchRoleTemplate(id);
    expect(first).toBe('cached-body');
    const second = await fetchRoleTemplate(id);
    expect(second).toBe('cached-body');
    expect(httpsGetMock).toHaveBeenCalledTimes(1); // second served from cache
  });

  it('returns null when the fetch errors', async () => {
    httpsGetMock.mockImplementation((_url: string, _cb: unknown) => {
      const req = Object.assign(new EventEmitter(), { destroy: vi.fn(), setTimeout: vi.fn() });
      queueMicrotask(() => req.emit('error', new Error('network down')));
      return req;
    });
    const result = await fetchRoleTemplate('finance/error-role');
    expect(result).toBeNull();
  });
});
