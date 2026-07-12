/**
 * Tests for RealtimeProvider.computePcmLevel (via __internal) — turns a base64
 * PCM chunk into a normalized [0,1] level for the realtime-voice meter. Pure
 * (base64 → Int16 samples → max abs / 32768, sampling every 16th value), with a
 * try/catch → 0 fallback on bad input.
 */
import { describe, it, expect } from 'vitest';
import { __internal } from '../RealtimeProvider';

const { computePcmLevel } = __internal;

// Encode an Int16 PCM sample array to the base64 the function expects.
function pcmToBase64(samples: number[]): string {
  const int16 = Int16Array.from(samples);
  const bytes = new Uint8Array(int16.buffer);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

describe('computePcmLevel', () => {
  it('returns 0 for silence (all-zero samples)', () => {
    expect(computePcmLevel(pcmToBase64(new Array(64).fill(0)))).toBe(0);
  });

  it('returns ~1 for a full-scale sample (clamped)', () => {
    // 32767 is max positive; -32768 would give exactly 1. Use -32768 at index 0.
    expect(computePcmLevel(pcmToBase64([-32768, 0, 0, 0]))).toBe(1);
    // 32767 → 32767/32768 ≈ 0.99997
    expect(computePcmLevel(pcmToBase64([32767]))).toBeCloseTo(0.99997, 4);
  });

  it('returns a proportional mid-level value', () => {
    expect(computePcmLevel(pcmToBase64([16384]))).toBeCloseTo(0.5, 5); // 16384/32768
  });

  it('takes the absolute value of a negative sample (index 0 is sampled)', () => {
    // -16384 at index 0 (a sampled position) → |−16384|/32768 = 0.5.
    expect(computePcmLevel(pcmToBase64([-16384, 100, 200]))).toBeCloseTo(0.5, 5);
  });

  it('samples every 16th value — a peak NOT on a 16-boundary is skipped', () => {
    // index 0 sampled (value 0), index 1 (the peak) is skipped → level 0.
    const arr = new Array(32).fill(0);
    arr[1] = 32767;
    expect(computePcmLevel(pcmToBase64(arr))).toBe(0);
    // same peak placed on index 16 (a boundary) IS counted.
    const arr2 = new Array(32).fill(0);
    arr2[16] = 32767;
    expect(computePcmLevel(pcmToBase64(arr2))).toBeGreaterThan(0.99);
  });

  it('falls back to 0 on invalid / empty base64', () => {
    expect(computePcmLevel('')).toBe(0);
    expect(computePcmLevel('!!!not base64!!!')).toBe(0);
  });
});
