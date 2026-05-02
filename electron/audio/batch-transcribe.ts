/**
 * Batch transcription handler for the main process.
 *
 * Accepts a WAV buffer (via base64 or temp file path) and transcribes it
 * using the Azure Speech SDK's continuous recognition. This provides
 * higher-quality transcription than real-time streaming because the SDK
 * can use the full audio context.
 *
 * For long recordings (> 3 minutes), the audio is split into ~2-minute
 * chunks with silence-boundary detection, transcribed sequentially, and
 * reassembled. Progress events are emitted for each completed chunk.
 *
 * For the native (Web Speech API) provider, batch transcription is handled
 * in the renderer via the background speech collector — this module is only
 * used for the Azure path.
 */

import * as sdk from 'microsoft-cognitiveservices-speech-sdk';
import { readFileSync, unlinkSync } from 'fs';
import type { IpcMain, WebContents } from 'electron';
import { chunkWavBuffer, calculateWavDuration } from './audio-chunker.js';

export interface BatchTranscribeRequest {
  /** Base64-encoded WAV audio (mutually exclusive with tempFilePath) */
  wavBase64?: string;
  /** Path to a temporary WAV file on disk (mutually exclusive with wavBase64) */
  tempFilePath?: string;
  /** BCP-47 language code, e.g. 'en-US' */
  language: string;
  /** Azure Speech subscription key */
  azureKey: string;
  /** Azure region, e.g. 'eastus' */
  azureRegion: string;
  /** Optional custom Azure endpoint URL */
  azureEndpoint?: string;
}

export interface BatchTranscribeResult {
  text: string;
  durationSec?: number;
  error?: string;
}

/** Threshold in seconds above which we split audio into chunks */
const CHUNK_THRESHOLD_SEC = 180; // 3 minutes
/** Target chunk duration in seconds */
const CHUNK_TARGET_SEC = 120; // 2 minutes

/** Safety timeout per chunk: audio duration × 3 + 30s base, capped at 120s */
function chunkTimeout(wavBuffer: Buffer): number {
  const durationSec = calculateWavDuration(wavBuffer);
  return Math.min(120_000, Math.max(15_000, durationSec * 3000 + 30_000));
}

function transcribeSingleBuffer(
  wavBuffer: Buffer,
  language: string,
  azureKey: string,
  azureRegion: string,
  azureEndpoint: string | undefined,
  sender: WebContents | null,
  chunkIndex: number,
  totalChunks: number,
): Promise<{ text: string }> {
  const timeoutMs = chunkTimeout(wavBuffer);

  return new Promise((resolve, reject) => {
    let speechConfig: sdk.SpeechConfig;

    if (azureEndpoint) {
      speechConfig = sdk.SpeechConfig.fromEndpoint(
        new URL(azureEndpoint),
        azureKey,
      );
    } else {
      speechConfig = sdk.SpeechConfig.fromSubscription(azureKey, azureRegion);
    }

    speechConfig.speechRecognitionLanguage = language;

    // Create a push stream and feed the WAV data
    const format = sdk.AudioStreamFormat.getWaveFormatPCM(16000, 16, 1);
    const pushStream = sdk.AudioInputStream.createPushStream(format);

    // Skip WAV header (44 bytes) and push raw PCM data
    const pcmData = wavBuffer.subarray(44);
    pushStream.write(pcmData.buffer.slice(pcmData.byteOffset, pcmData.byteOffset + pcmData.byteLength) as ArrayBuffer);
    pushStream.close();

    const audioConfig = sdk.AudioConfig.fromStreamInput(pushStream);
    const recognizer = new sdk.SpeechRecognizer(speechConfig, audioConfig);
    const results: string[] = [];
    let resolved = false;

    // Safety timeout — if the SDK never fires sessionStopped/canceled, resolve
    // with whatever results we have (or empty string) instead of hanging forever.
    const safetyTimer = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      console.warn('[BatchTranscribe] Safety timeout (%dms) for chunk %d/%d — resolving with %d results',
        timeoutMs, chunkIndex + 1, totalChunks, results.length);
      try { recognizer.stopContinuousRecognitionAsync(); } catch { /* ignore */ }
      try { recognizer.close(); } catch { /* ignore */ }

      if (sender && !sender.isDestroyed()) {
        sender.send('stt:transcription-progress', {
          percent: Math.round(((chunkIndex + 1) / totalChunks) * 100),
          chunkIndex,
          totalChunks,
        });
      }

      resolve({ text: results.join(' ') });
    }, timeoutMs);

    const finish = (text: string) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(safetyTimer);
      try { recognizer.close(); } catch { /* ignore */ }

      if (sender && !sender.isDestroyed()) {
        sender.send('stt:transcription-progress', {
          percent: Math.round(((chunkIndex + 1) / totalChunks) * 100),
          chunkIndex,
          totalChunks,
        });
      }

      resolve({ text });
    };

    recognizer.recognizing = (_s, e) => {
      console.log('[BatchTranscribe] recognizing (chunk %d/%d): "%s"',
        chunkIndex + 1, totalChunks, e.result.text?.substring(0, 80));
    };

    recognizer.recognized = (_s, e) => {
      if (e.result.reason === sdk.ResultReason.RecognizedSpeech && e.result.text) {
        console.log('[BatchTranscribe] recognized (chunk %d/%d): "%s"',
          chunkIndex + 1, totalChunks, e.result.text.substring(0, 80));
        results.push(e.result.text);
      } else if (e.result.reason === sdk.ResultReason.NoMatch) {
        console.log('[BatchTranscribe] NoMatch (chunk %d/%d)', chunkIndex + 1, totalChunks);
      }
    };

    recognizer.sessionStarted = () => {
      console.log('[BatchTranscribe] sessionStarted (chunk %d/%d)', chunkIndex + 1, totalChunks);
    };

    recognizer.sessionStopped = () => {
      console.log('[BatchTranscribe] sessionStopped (chunk %d/%d), results=%d',
        chunkIndex + 1, totalChunks, results.length);
      finish(results.join(' '));
    };

    recognizer.canceled = (_s, e) => {
      console.log('[BatchTranscribe] canceled (chunk %d/%d), reason=%s, errorDetails=%s',
        chunkIndex + 1, totalChunks, sdk.CancellationReason[e.reason], e.errorDetails ?? 'none');

      if (resolved) return;

      if (e.reason === sdk.CancellationReason.Error) {
        resolved = true;
        clearTimeout(safetyTimer);
        try { recognizer.close(); } catch { /* ignore */ }
        reject(new Error(e.errorDetails || 'Azure Speech SDK cancellation error'));
      } else {
        // EndOfStream or other non-error cancellation — return what we have
        finish(results.join(' '));
      }
    };

    recognizer.startContinuousRecognitionAsync(
      () => {
        console.log('[BatchTranscribe] Recognition started for chunk %d/%d (timeout=%dms)',
          chunkIndex + 1, totalChunks, timeoutMs);
      },
      (err) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(safetyTimer);
        try { recognizer.close(); } catch { /* ignore */ }
        reject(new Error(`Failed to start recognition: ${err}`));
      },
    );
  });
}

export function registerBatchTranscribeHandlers(ipc: IpcMain): void {
  ipc.handle('stt:batch-transcribe', async (event, request: BatchTranscribeRequest): Promise<BatchTranscribeResult> => {
    console.log('[BatchTranscribe] Request received, language=%s, hasWavBase64=%s, hasTempFile=%s',
      request.language, Boolean(request.wavBase64), Boolean(request.tempFilePath));

    try {
      // Load the WAV buffer
      let wavBuffer: Buffer;
      if (request.tempFilePath) {
        wavBuffer = readFileSync(request.tempFilePath);
        // Clean up temp file
        try { unlinkSync(request.tempFilePath); } catch { /* ignore */ }
      } else if (request.wavBase64) {
        wavBuffer = Buffer.from(request.wavBase64, 'base64');
      } else {
        return { text: '', error: 'No audio data provided' };
      }

      if (wavBuffer.length < 44) {
        return { text: '', error: 'WAV data too short (missing header)' };
      }

      const durationSec = calculateWavDuration(wavBuffer);
      console.log('[BatchTranscribe] WAV buffer: %d bytes, ~%.1f seconds', wavBuffer.length, durationSec);

      const sender = event.sender;

      // Short recordings (< 3 min): transcribe as single unit
      if (durationSec < CHUNK_THRESHOLD_SEC) {
        const result = await transcribeSingleBuffer(
          wavBuffer,
          request.language,
          request.azureKey,
          request.azureRegion,
          request.azureEndpoint,
          sender,
          0,
          1,
        );

        console.log('[BatchTranscribe] Done (single): %d chars of text', result.text.length);
        return { text: result.text, durationSec };
      }

      // Long recordings: chunk and transcribe sequentially
      const chunks = chunkWavBuffer(wavBuffer, CHUNK_TARGET_SEC);
      console.log('[BatchTranscribe] Split into %d chunks', chunks.length);

      const results: string[] = [];

      for (const chunk of chunks) {
        const result = await transcribeSingleBuffer(
          chunk.wavBuffer,
          request.language,
          request.azureKey,
          request.azureRegion,
          request.azureEndpoint,
          sender,
          chunk.index,
          chunk.total,
        );

        if (result.text.trim()) {
          results.push(result.text.trim());
        }
      }

      const fullText = results.join(' ');
      console.log('[BatchTranscribe] Done (chunked): %d chars from %d chunks', fullText.length, chunks.length);
      return { text: fullText, durationSec };

    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[BatchTranscribe] Error:', message);
      return { text: '', error: message };
    }
  });
}
