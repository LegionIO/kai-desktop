import { describe, it, expect } from 'vitest';
import { isUrlAllowed, isPrivateAddress } from '../ssrf-guard.js';

describe('ssrf-guard isPrivateAddress', () => {
  it('flags loopback / private / link-local / ULA', () => {
    expect(isPrivateAddress('127.0.0.1', 4)).toBe(true);
    expect(isPrivateAddress('10.1.2.3', 4)).toBe(true);
    expect(isPrivateAddress('172.16.5.5', 4)).toBe(true);
    expect(isPrivateAddress('192.168.0.1', 4)).toBe(true);
    expect(isPrivateAddress('169.254.169.254', 4)).toBe(true); // cloud metadata
    expect(isPrivateAddress('::1', 6)).toBe(true);
    expect(isPrivateAddress('fe80::1', 6)).toBe(true);
    expect(isPrivateAddress('fc00::1', 6)).toBe(true);
  });

  it('allows public addresses', () => {
    expect(isPrivateAddress('8.8.8.8', 4)).toBe(false);
    expect(isPrivateAddress('1.1.1.1', 4)).toBe(false);
    expect(isPrivateAddress('2606:4700:4700::1111', 6)).toBe(false);
  });
});

describe('ssrf-guard isUrlAllowed', () => {
  it('rejects non-http(s) schemes unless in extraProtocols', () => {
    expect(isUrlAllowed('file:///etc/passwd', false).ok).toBe(false);
    expect(isUrlAllowed('ftp://x/y', false).ok).toBe(false);
    expect(isUrlAllowed('mymedia://images/a.png', false).ok).toBe(false);
    expect(isUrlAllowed('mymedia://images/a.png', false, ['mymedia']).ok).toBe(true);
  });

  it('rejects IP-literal private hosts on http(s), allows public', () => {
    expect(isUrlAllowed('http://169.254.169.254/latest/meta-data/', false).ok).toBe(false);
    expect(isUrlAllowed('http://127.0.0.1:8080/', false).ok).toBe(false);
    expect(isUrlAllowed('http://[::1]/', false).ok).toBe(false);
    expect(isUrlAllowed('http://10.0.0.5/x', false).ok).toBe(false);
    expect(isUrlAllowed('https://example.com/a.png', false).ok).toBe(true);
    expect(isUrlAllowed('https://8.8.8.8/', false).ok).toBe(true);
  });

  it('allowPrivate=true skips the IP-literal check (but still enforces scheme)', () => {
    expect(isUrlAllowed('http://127.0.0.1/', true).ok).toBe(true);
    expect(isUrlAllowed('file:///x', true).ok).toBe(false);
  });

  it('rejects an unparseable URL', () => {
    expect(isUrlAllowed('not a url', false).ok).toBe(false);
  });
});
