/**
 * Tests for the audio recording-support predicates (jsdom, component-gated via
 * 178f07b). isRecordingSupportedForProvider decides whether voice recording is
 * offered for a given provider: Azure (WebSocket-based) is always available once
 * a key is set, everything else depends on native browser SpeechRecognition.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { isRecordingSupported, isRecordingSupportedForProvider } from '../speech-adapters';

// jsdom has no SpeechRecognition by default; toggle it per-test via a loosely
// typed view so we don't have to satisfy the full SpeechRecognitionConstructor.
const w = window as unknown as Record<string, unknown>;

afterEach(() => {
  delete w.SpeechRecognition;
  delete w.webkitSpeechRecognition;
});

describe('isRecordingSupported', () => {
  it('is false when neither SpeechRecognition variant exists', () => {
    expect(isRecordingSupported()).toBe(false);
  });
  it('is true when window.SpeechRecognition exists', () => {
    w.SpeechRecognition = class {};
    expect(isRecordingSupported()).toBe(true);
  });
  it('is true when only the webkit-prefixed variant exists', () => {
    w.webkitSpeechRecognition = class {};
    expect(isRecordingSupported()).toBe(true);
  });
});

describe('isRecordingSupportedForProvider', () => {
  it('azure with a key set is always supported (WebSocket, no browser dep)', () => {
    // no SpeechRecognition in the env, yet azure+key → true
    expect(isRecordingSupportedForProvider('azure', true)).toBe(true);
  });

  it('azure WITHOUT a key falls back to native browser support', () => {
    expect(isRecordingSupportedForProvider('azure', false)).toBe(false);
    w.SpeechRecognition = class {};
    expect(isRecordingSupportedForProvider('azure', false)).toBe(true);
  });

  it('native provider depends on browser SpeechRecognition', () => {
    expect(isRecordingSupportedForProvider('native')).toBe(false);
    w.webkitSpeechRecognition = class {};
    expect(isRecordingSupportedForProvider('native')).toBe(true);
  });
});
