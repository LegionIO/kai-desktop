/**
 * Tests for the WAV audio chunker (electron/audio/audio-chunker.ts) — splits a
 * 16kHz/16-bit/mono PCM WAV into ~N-second chunks for batch STT. Focus:
 * clamping the header-declared data size to the real buffer (a truncated/bogus
 * header must not produce wrong durations or empty chunks), the progress guard
 * against a tiny/zero targetDurationSec (no infinite loop / no pathological
 * chunk count), and correct chunk boundaries.
 */
import { describe, it, expect } from 'vitest';
import { chunkWavBuffer, calculateWavDuration } from '../audio-chunker.js';

const HEADER = 44;
const BYTES_PER_SEC = 32000; // 16kHz * 2 bytes * 1 channel

/** Build a WAV buffer: header (declaring `declaredSize` bytes, default = actual
 *  PCM length) + `pcmBytes` of PCM data. */
function makeWav(pcmBytes: number, declaredSize?: number): Buffer {
  const header = Buffer.alloc(HEADER);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcmBytes, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24);
  header.writeUInt32LE(BYTES_PER_SEC, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(declaredSize ?? pcmBytes, 40); // declared data size
  return Buffer.concat([header, Buffer.alloc(pcmBytes)]);
}

describe('calculateWavDuration', () => {
  it('returns 0 for a buffer shorter than the header', () => {
    expect(calculateWavDuration(Buffer.alloc(10))).toBe(0);
  });
  it('computes duration from the (clamped) data size', () => {
    expect(calculateWavDuration(makeWav(BYTES_PER_SEC * 5))).toBe(5); // 5s
  });
  it('clamps an over-declared header to the real buffer length', () => {
    // Header claims 100s but only 3s of PCM is present → duration reflects real data.
    const wav = makeWav(BYTES_PER_SEC * 3, BYTES_PER_SEC * 100);
    expect(calculateWavDuration(wav)).toBe(3);
  });
});

describe('chunkWavBuffer', () => {
  it('returns [] for a sub-header buffer', () => {
    expect(chunkWavBuffer(Buffer.alloc(10))).toEqual([]);
  });

  it('returns a single chunk when the recording fits', () => {
    const wav = makeWav(BYTES_PER_SEC * 30); // 30s, < 1.5*120
    const chunks = chunkWavBuffer(wav, 120);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].total).toBe(1);
    expect(chunks[0].wavBuffer).toBe(wav); // passthrough
  });

  it('splits a long recording into multiple chunks that each carry a WAV header', () => {
    const wav = makeWav(BYTES_PER_SEC * 300); // 5 min
    const chunks = chunkWavBuffer(wav, 60); // ~1 min chunks
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.wavBuffer.subarray(0, 4).toString()).toBe('RIFF');
      expect(c.total).toBe(chunks.length);
    }
    // Chunks cover the recording without gaps in index.
    expect(chunks.map((c) => c.index)).toEqual(chunks.map((_, i) => i));
  });

  it('does NOT emit empty trailing chunks when the header over-declares the data size', () => {
    // Header claims 300s but only 90s of PCM present. Clamp → chunks cover only real data.
    const wav = makeWav(BYTES_PER_SEC * 90, BYTES_PER_SEC * 300);
    const chunks = chunkWavBuffer(wav, 60);
    // Every chunk must carry real PCM (> just a 44-byte header).
    for (const c of chunks) expect(c.wavBuffer.length).toBeGreaterThan(HEADER);
  });

  it('does not loop / explode on a zero or negative targetDurationSec', () => {
    const wav = makeWav(BYTES_PER_SEC * 300);
    const started = Date.now();
    const chunks0 = chunkWavBuffer(wav, 0);
    const chunksNeg = chunkWavBuffer(wav, -5);
    expect(Date.now() - started).toBeLessThan(2000);
    // Floored to >=1s chunks → a bounded, sane number (not millions).
    expect(chunks0.length).toBeGreaterThan(0);
    expect(chunks0.length).toBeLessThan(1000);
    expect(chunksNeg.length).toBeLessThan(1000);
  });
});
