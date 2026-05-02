/**
 * WAV audio chunker for splitting long recordings into segments.
 *
 * Splits a 16kHz/16-bit/mono PCM WAV buffer into chunks of a target
 * duration, preferring silence boundaries to avoid cutting mid-word.
 *
 * Each chunk is returned as a complete WAV file (with header) that can
 * be independently transcribed by the Azure Speech SDK.
 */

export interface AudioChunk {
  /** Complete WAV file buffer (with header) for this chunk */
  wavBuffer: Buffer;
  /** Start time in seconds relative to the full recording */
  startSec: number;
  /** End time in seconds relative to the full recording */
  endSec: number;
  /** 0-based chunk index */
  index: number;
  /** Total number of chunks */
  total: number;
}

const WAV_HEADER_SIZE = 44;
const SAMPLE_RATE = 16000;
const BITS_PER_SAMPLE = 16;
const CHANNELS = 1;
const BYTES_PER_SAMPLE = BITS_PER_SAMPLE / 8;
const BYTES_PER_SEC = SAMPLE_RATE * BYTES_PER_SAMPLE * CHANNELS; // 32000

/**
 * Calculate the duration of a WAV buffer from its header.
 */
export function calculateWavDuration(wavBuffer: Buffer): number {
  if (wavBuffer.length < WAV_HEADER_SIZE) return 0;
  const dataSize = wavBuffer.readUInt32LE(40);
  return dataSize / BYTES_PER_SEC;
}

/**
 * Find the best split point near the target offset by looking for
 * a silence window (lowest RMS amplitude) within ±searchWindowSec.
 */
function findBestSplitPoint(
  data: Buffer,
  dataOffset: number,
  targetOffset: number,
  searchWindowSec: number,
): number {
  const searchWindowBytes = Math.floor(searchWindowSec * BYTES_PER_SEC);
  // RMS analysis window: 200ms
  const windowSizeBytes = Math.floor(0.2 * BYTES_PER_SEC);
  // Step: 10ms
  const stepBytes = Math.floor(0.01 * BYTES_PER_SEC);

  const start = Math.max(0, targetOffset - searchWindowBytes);
  const end = Math.min(data.length - dataOffset - windowSizeBytes, targetOffset + searchWindowBytes);

  if (start >= end) return targetOffset;

  let bestOffset = targetOffset;
  let bestRms = Infinity;

  for (let offset = start; offset < end; offset += stepBytes) {
    let sumSq = 0;
    const absOffset = dataOffset + offset;
    const windowEnd = absOffset + windowSizeBytes;

    if (windowEnd > data.length) break;

    for (let i = absOffset; i < windowEnd; i += BYTES_PER_SAMPLE) {
      const sample = data.readInt16LE(i);
      sumSq += sample * sample;
    }

    const numSamples = windowSizeBytes / BYTES_PER_SAMPLE;
    const rms = Math.sqrt(sumSq / numSamples);

    if (rms < bestRms) {
      bestRms = rms;
      bestOffset = offset;
    }
  }

  return bestOffset;
}

/**
 * Create a valid WAV header for a given data size.
 */
function createWavHeader(dataSize: number): Buffer {
  const header = Buffer.alloc(WAV_HEADER_SIZE);

  // RIFF header
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4); // file size - 8
  header.write('WAVE', 8);

  // fmt chunk
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // chunk size
  header.writeUInt16LE(1, 20); // PCM format
  header.writeUInt16LE(CHANNELS, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(BYTES_PER_SEC, 28); // byte rate
  header.writeUInt16LE(BYTES_PER_SAMPLE * CHANNELS, 32); // block align
  header.writeUInt16LE(BITS_PER_SAMPLE, 34);

  // data chunk
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);

  return header;
}

/**
 * Split a WAV buffer into chunks of approximately `targetDurationSec`.
 *
 * Assumes 16kHz, 16-bit, mono PCM (as produced by mic-recorder).
 * Splits on silence boundaries when possible to avoid cutting mid-word.
 *
 * @param wavBuffer Complete WAV file buffer (with 44-byte header)
 * @param targetDurationSec Target chunk duration in seconds (default: 120 = 2 min)
 * @returns Array of AudioChunk objects, each containing a complete WAV file
 */
export function chunkWavBuffer(
  wavBuffer: Buffer,
  targetDurationSec = 120,
): AudioChunk[] {
  if (wavBuffer.length < WAV_HEADER_SIZE) {
    return [];
  }

  const totalDataSize = wavBuffer.readUInt32LE(40);
  const totalDurationSec = totalDataSize / BYTES_PER_SEC;
  const dataStart = WAV_HEADER_SIZE;
  const targetChunkBytes = Math.floor(targetDurationSec * BYTES_PER_SEC);

  // If the recording fits in a single chunk, return as-is
  if (totalDataSize <= targetChunkBytes * 1.5) {
    return [{
      wavBuffer,
      startSec: 0,
      endSec: totalDurationSec,
      index: 0,
      total: 1,
    }];
  }

  const chunks: AudioChunk[] = [];
  let currentOffset = 0; // Offset within the PCM data (after header)
  const searchWindowSec = 2; // Look ±2 seconds around target split point

  while (currentOffset < totalDataSize) {
    const remaining = totalDataSize - currentOffset;

    // If remaining is less than 1.5x target, make it the last chunk
    if (remaining <= targetChunkBytes * 1.5) {
      const chunkData = wavBuffer.subarray(dataStart + currentOffset, dataStart + totalDataSize);
      const header = createWavHeader(chunkData.length);
      const chunkWav = Buffer.concat([header, chunkData]);

      chunks.push({
        wavBuffer: chunkWav,
        startSec: currentOffset / BYTES_PER_SEC,
        endSec: totalDurationSec,
        index: chunks.length,
        total: 0, // Will be filled in below
      });
      break;
    }

    // Find the best split point near the target boundary
    const splitOffset = findBestSplitPoint(
      wavBuffer,
      dataStart,
      currentOffset + targetChunkBytes,
      searchWindowSec,
    );

    // Ensure we make progress (at least half the target chunk)
    const effectiveSplit = Math.max(
      currentOffset + Math.floor(targetChunkBytes * 0.5),
      Math.min(splitOffset, currentOffset + Math.floor(targetChunkBytes * 1.5)),
    );

    const chunkData = wavBuffer.subarray(dataStart + currentOffset, dataStart + effectiveSplit);
    const header = createWavHeader(chunkData.length);
    const chunkWav = Buffer.concat([header, chunkData]);

    chunks.push({
      wavBuffer: chunkWav,
      startSec: currentOffset / BYTES_PER_SEC,
      endSec: effectiveSplit / BYTES_PER_SEC,
      index: chunks.length,
      total: 0, // Will be filled in below
    });

    currentOffset = effectiveSplit;
  }

  // Fill in the total count
  const total = chunks.length;
  for (const chunk of chunks) {
    chunk.total = total;
  }

  console.log('[AudioChunker] Split %.1fs recording into %d chunks of ~%ds each',
    totalDurationSec, total, targetDurationSec);

  return chunks;
}
