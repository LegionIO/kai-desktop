/**
 * Tests for isExternallyOpenableUrl (electron/utils/safe-external-url.ts) — the
 * scheme allowlist that gates shell.openExternal in the main process. Chat
 * content and tool output are partially untrusted, so only http(s)/mailto may
 * reach the OS handler; file:/smb:/custom protocols (NTLM leak, arbitrary
 * handler launch) and unparseable input must be rejected.
 */
import { describe, it, expect } from 'vitest';
import { isExternallyOpenableUrl } from '../safe-external-url.js';

describe('isExternallyOpenableUrl', () => {
  it('allows http and https', () => {
    expect(isExternallyOpenableUrl('http://example.com')).toBe(true);
    expect(isExternallyOpenableUrl('https://example.com/path?q=1#frag')).toBe(true);
  });

  it('allows mailto', () => {
    expect(isExternallyOpenableUrl('mailto:someone@example.com')).toBe(true);
  });

  it('rejects file: (local file access)', () => {
    expect(isExternallyOpenableUrl('file:///etc/passwd')).toBe(false);
    expect(isExternallyOpenableUrl('file://server/share/x')).toBe(false);
  });

  it('rejects smb:/unc-style URLs (NTLM credential leak on Windows)', () => {
    expect(isExternallyOpenableUrl('smb://attacker.example/share')).toBe(false);
  });

  it('rejects custom / OS protocol schemes (registered-handler launch)', () => {
    for (const u of [
      'ssh://host',
      'tel:+15551234',
      'ms-settings:developers',
      'vscode://file/etc/passwd',
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'chrome://settings',
    ]) {
      expect(isExternallyOpenableUrl(u)).toBe(false);
    }
  });

  it('rejects unparseable / non-URL input', () => {
    expect(isExternallyOpenableUrl('')).toBe(false);
    expect(isExternallyOpenableUrl('not a url')).toBe(false);
    expect(isExternallyOpenableUrl('/relative/path')).toBe(false);
    expect(isExternallyOpenableUrl('example.com')).toBe(false); // no scheme
  });

  it('is scheme-exact and case-insensitive per URL parsing (HTTP -> http)', () => {
    // WHATWG URL lowercases the scheme, so uppercase still resolves correctly.
    expect(isExternallyOpenableUrl('HTTPS://example.com')).toBe(true);
    // But a scheme that merely starts with "http" is not http(s).
    expect(isExternallyOpenableUrl('httpx://example.com')).toBe(false);
  });
});
