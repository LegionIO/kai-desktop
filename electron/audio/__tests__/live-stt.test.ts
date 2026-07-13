/**
 * Tests for live-stt.ts's isAzureSpeechHost — the classifier that decides
 * whether a renderer-supplied Speech endpoint host is an official Azure host
 * (SDK fromEndpoint, redirect-capable) vs. a custom/proxy host (fromHost, skips
 * the :443 redirect dance). Misclassifying breaks connectivity, so the DNS-label
 * boundary (no `evil-azure.com` / `azure.com.evil.com` false-positives), the
 * root-suffix match, uppercase normalization, and trailing-DNS-dot handling are
 * the behaviors worth locking.
 */
import { describe, it, expect, vi } from 'vitest';

// live-stt.ts imports BrowserWindow from electron at module load.
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }));

import { isAzureSpeechHost } from '../live-stt.js';

describe('isAzureSpeechHost', () => {
  it('matches official Azure subdomains', () => {
    for (const h of [
      'eastus.stt.speech.microsoft.com',
      'foo.cognitiveservices.azure.com',
      'x.azure.cn',
      'y.azure.us',
      'westus2.api.cognitive.microsoft.com',
    ]) {
      expect(isAzureSpeechHost(h), h).toBe(true);
    }
  });

  it('matches the root suffix itself (not just subdomains)', () => {
    expect(isAzureSpeechHost('azure.com')).toBe(true);
    expect(isAzureSpeechHost('microsoft.com')).toBe(true);
  });

  it('normalizes uppercase', () => {
    expect(isAzureSpeechHost('EastUS.STT.Speech.Microsoft.COM')).toBe(true);
    expect(isAzureSpeechHost('AZURE.COM')).toBe(true);
  });

  it('handles a single trailing DNS dot (FQDN)', () => {
    expect(isAzureSpeechHost('foo.azure.com.')).toBe(true);
    expect(isAzureSpeechHost('azure.com.')).toBe(true);
  });

  it('does NOT false-positive on look-alike hosts (DNS-label boundary enforced)', () => {
    for (const h of [
      'evil-azure.com',
      'xazure.com',
      'azure.com.evil.com',
      'notmicrosoft.com',
      'fakeazure.us',
      'azure.com.attacker.net',
      'example.com',
      'azure.io',
    ]) {
      expect(isAzureSpeechHost(h), h).toBe(false);
    }
  });

  it('does not match an empty/partial host', () => {
    expect(isAzureSpeechHost('')).toBe(false);
    expect(isAzureSpeechHost('azure')).toBe(false);
    expect(isAzureSpeechHost('com')).toBe(false);
  });
});
