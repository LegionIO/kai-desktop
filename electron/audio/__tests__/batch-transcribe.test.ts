/**
 * Tests for batch-transcribe.ts pure logic:
 *   - isValidTranscriptionLanguage: the IPC-boundary guard that stops an
 *     unvalidated renderer-supplied language from reaching the manually-built
 *     Whisper multipart body / the Azure SDK. Codex confirmed the multipart
 *     CRLF-injection isn't exploitable (split('-')[0] truncates any boundary
 *     delimiter, which contains hyphens), but the tag was unvalidated and could
 *     silently cause wrong-language recognition — so we reject non-BCP-47 tags.
 *   - resolveWhisperCredentials: the 5-tier priority ladder that derives the
 *     transcription URL + auth headers + model from config (audio.azure →
 *     realtime.azure → realtime.openai → realtime.custom → first
 *     openai-compatible model provider), including trailing-slash trimming and
 *     the ws(s)→http(s) rewrite for custom endpoints.
 */
import { describe, it, expect, vi } from 'vitest';

// batch-transcribe.ts imports `net`/IpcMain from electron at module load.
vi.mock('electron', () => ({ net: { fetch: vi.fn() } }));

import type { AppConfig } from '../../config/schema.js';
import { isValidTranscriptionLanguage, __internal } from '../batch-transcribe.js';

const { resolveWhisperCredentials } = __internal;

describe('isValidTranscriptionLanguage', () => {
  it('accepts well-formed BCP-47 tags', () => {
    for (const ok of ['en', 'EN', 'eng', 'en-US', 'zh-Hans-CN', 'de-DE', 'pt-BR', 'sr-Latn-RS']) {
      expect(isValidTranscriptionLanguage(ok), ok).toBe(true);
    }
  });

  it('rejects CRLF-injection-shaped and malformed values', () => {
    for (const bad of [
      'en\r\nContent-Disposition: form-data; name="model"\r\n\r\nevil',
      'en\r\n',
      'en\n', // trailing newline — the case JS `$` can slip past without the explicit CR/LF guard
      'en\rX',
      '', // empty
      'e', // too short
      'englishlanguage', // >3 letter primary subtag
      '12', // digits in primary subtag
      'en_US', // underscore, not hyphen
      'en-', // dangling separator
      'en-US-', // trailing separator
      'a'.repeat(65), // over length cap
      'en US', // space
    ]) {
      expect(isValidTranscriptionLanguage(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it('rejects non-string inputs', () => {
    for (const bad of [undefined, null, 42, {}, ['en'], true]) {
      expect(isValidTranscriptionLanguage(bad)).toBe(false);
    }
  });
});

describe('resolveWhisperCredentials — priority ladder', () => {
  const cfg = (over: Partial<AppConfig>): AppConfig => over as AppConfig;

  it('tier 1: audio.azure wins, builds /v1/audio/transcriptions + api-key header, trims trailing slashes', () => {
    const creds = resolveWhisperCredentials(
      cfg({
        audio: { provider: 'azure', azure: { subscriptionKey: 'k1', endpoint: 'https://gw.example.com///' } },
        realtime: { provider: 'openai', openai: { apiKey: 'should-not-win' } },
      } as unknown as Partial<AppConfig>),
    );
    expect(creds).toEqual({
      url: 'https://gw.example.com/v1/audio/transcriptions',
      headers: { 'api-key': 'k1' },
      model: 'speech-to-text',
      fileField: 'file',
    });
  });

  it('tier 2: realtime.azure when audio.azure absent', () => {
    const creds = resolveWhisperCredentials(
      cfg({
        realtime: { provider: 'azure', azure: { apiKey: 'k2', endpoint: 'https://rt.example.com/' } },
      } as unknown as Partial<AppConfig>),
    );
    expect(creds?.url).toBe('https://rt.example.com/v1/audio/transcriptions');
    expect(creds?.headers).toEqual({ 'api-key': 'k2' });
  });

  it('tier 3: realtime.openai → vanilla OpenAI url + Bearer + whisper-1', () => {
    const creds = resolveWhisperCredentials(
      cfg({ realtime: { provider: 'openai', openai: { apiKey: 'sk-x' } } } as unknown as Partial<AppConfig>),
    );
    expect(creds).toEqual({
      url: 'https://api.openai.com/v1/audio/transcriptions',
      headers: { Authorization: 'Bearer sk-x' },
      model: 'whisper-1',
      fileField: 'file',
    });
  });

  it('tier 4: realtime.custom rewrites wss:// → https:// and trims slashes', () => {
    const creds = resolveWhisperCredentials(
      cfg({
        realtime: { provider: 'custom', custom: { apiKey: 'ck', baseUrl: 'wss://custom.example.com/api//' } },
      } as unknown as Partial<AppConfig>),
    );
    expect(creds?.url).toBe('https://custom.example.com/api/v1/audio/transcriptions');
    expect(creds?.headers).toEqual({ Authorization: 'Bearer ck' });
  });

  it('tier 4: realtime.custom rewrites ws:// → http://', () => {
    const creds = resolveWhisperCredentials(
      cfg({
        realtime: { provider: 'custom', custom: { apiKey: 'ck', baseUrl: 'ws://insecure.example.com' } },
      } as unknown as Partial<AppConfig>),
    );
    expect(creds?.url).toBe('http://insecure.example.com/v1/audio/transcriptions');
  });

  it('tier 5: first openai-compatible model provider with an apiKey; default endpoint when none', () => {
    const creds = resolveWhisperCredentials(
      cfg({
        models: {
          providers: {
            noKey: { type: 'openai-compatible', endpoint: 'https://a.example.com' },
            good: { type: 'openai-compatible', apiKey: 'pk', endpoint: 'https://b.example.com/' },
          },
        },
      } as unknown as Partial<AppConfig>),
    );
    expect(creds?.url).toBe('https://b.example.com/v1/audio/transcriptions');
    expect(creds?.headers).toEqual({ Authorization: 'Bearer pk' });
  });

  it('tier 5: falls back to api.openai.com when the provider has no endpoint', () => {
    const creds = resolveWhisperCredentials(
      cfg({
        models: { providers: { p: { type: 'openai-compatible', apiKey: 'pk' } } },
      } as unknown as Partial<AppConfig>),
    );
    expect(creds?.url).toBe('https://api.openai.com/v1/audio/transcriptions');
  });

  it('returns null when no usable credentials exist', () => {
    expect(resolveWhisperCredentials(cfg({}))).toBeNull();
    expect(
      resolveWhisperCredentials(
        cfg({ audio: { provider: 'azure', azure: { endpoint: 'https://x' } } } as unknown as Partial<AppConfig>),
      ),
    ).toBeNull(); // missing subscriptionKey
    expect(
      resolveWhisperCredentials(
        cfg({ realtime: { provider: 'custom', custom: { apiKey: 'k' } } } as unknown as Partial<AppConfig>),
      ),
    ).toBeNull(); // custom missing baseUrl
  });
});
