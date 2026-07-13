/**
 * Tests for the loopback-host guard on a plugin's api.http.listen bind address.
 * A plugin holding the `http:listen` permission may run a LOCAL server, but must
 * not bind to a routable/wildcard interface and expose its unauthenticated
 * handler to the LAN. isLoopbackHost is the pure gate enforcing that.
 */
import { describe, it, expect } from 'vitest';
import { __internal } from '../plugin-api.js';

const { isLoopbackHost } = __internal;

describe('isLoopbackHost — plugin http.listen bind guard', () => {
  it('accepts the canonical loopback hosts', () => {
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('::1')).toBe(true);
  });

  it('accepts any 127.0.0.0/8 address', () => {
    expect(isLoopbackHost('127.0.0.2')).toBe(true);
    expect(isLoopbackHost('127.255.255.254')).toBe(true);
  });

  it('accepts bracketed / zoned IPv6 loopback', () => {
    expect(isLoopbackHost('[::1]')).toBe(true);
    expect(isLoopbackHost('::1%lo0')).toBe(true);
  });

  it('is case- and whitespace-insensitive', () => {
    expect(isLoopbackHost('  LOCALHOST ')).toBe(true);
    expect(isLoopbackHost('LocalHost')).toBe(true);
  });

  it('rejects wildcard binds', () => {
    expect(isLoopbackHost('0.0.0.0')).toBe(false);
    expect(isLoopbackHost('::')).toBe(false);
    expect(isLoopbackHost('[::]')).toBe(false);
  });

  it('rejects LAN / routable addresses', () => {
    expect(isLoopbackHost('192.168.1.10')).toBe(false);
    expect(isLoopbackHost('10.0.0.5')).toBe(false);
    expect(isLoopbackHost('169.254.169.254')).toBe(false);
    expect(isLoopbackHost('example.com')).toBe(false);
  });

  it('rejects addresses that merely start with 127 but are not 127.0.0.0/8', () => {
    expect(isLoopbackHost('1270.0.0.1')).toBe(false);
    expect(isLoopbackHost('127.0.0.1.evil.com')).toBe(false);
  });
});
