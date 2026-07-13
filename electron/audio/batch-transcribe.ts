/**
 * Batch transcription handler for the main process.
 *
 * Accepts a WAV buffer (via base64) and transcribes it using either:
 *   1. OpenAI Whisper API (/v1/audio/transcriptions) — preferred, fast
 *   2. Azure Speech SDK continuous recognition — fallback for Azure-only setups
 *
 * For long recordings (> 3 minutes) with Azure, the audio is split into
 * ~2-minute chunks with silence-boundary detection, transcribed sequentially,
 * and reassembled. Whisper handles up to 25 MB files natively.
 *
 * For the native (Web Speech API) provider, batch transcription is handled
 * in the renderer via the background speech collector — this module is only
 * used for Electron.
 */

import * as sdk from 'microsoft-cognitiveservices-speech-sdk';
import { net } from 'electron';
import type { IpcMain, WebContents } from 'electron';
import type { AppConfig } from '../config/schema.js';
import { chunkWavBuffer, calculateWavDuration } from './audio-chunker.js';

export interface BatchTranscribeRequest {
  /** Base64-encoded WAV audio */
  wavBase64?: string;
  /** BCP-47 language code, e.g. 'en-US' */
  language: string;
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

/**
 * A BCP-47-ish language tag: a 2–3 letter primary subtag optionally followed by
 * `-`-separated alphanumeric subtags (region/script/variant), e.g. `en`,
 * `en-US`, `zh-Hans-CN`. Enforced at the IPC boundary so an unvalidated string
 * from the renderer can't flow into the manually-built Whisper multipart body or
 * the Azure SDK's recognition-language property. The explicit CR/LF guard is
 * belt-and-suspenders: JS `$` can match just before a trailing newline.
 */
const LANGUAGE_RE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;

export function isValidTranscriptionLanguage(language: unknown): language is string {
  return (
    typeof language === 'string' && language.length <= 64 && !/[\r\n]/.test(language) && LANGUAGE_RE.test(language)
  );
}

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
      speechConfig = sdk.SpeechConfig.fromEndpoint(new URL(azureEndpoint), azureKey);
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
      console.warn(
        '[BatchTranscribe] Safety timeout (%dms) for chunk %d/%d — resolving with %d results',
        timeoutMs,
        chunkIndex + 1,
        totalChunks,
        results.length,
      );
      try {
        recognizer.stopContinuousRecognitionAsync();
      } catch {
        /* ignore */
      }
      try {
        recognizer.close();
      } catch {
        /* ignore */
      }

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
      try {
        recognizer.close();
      } catch {
        /* ignore */
      }

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
      console.log(
        '[BatchTranscribe] recognizing (chunk %d/%d): "%s"',
        chunkIndex + 1,
        totalChunks,
        e.result.text?.substring(0, 80),
      );
    };

    recognizer.recognized = (_s, e) => {
      if (e.result.reason === sdk.ResultReason.RecognizedSpeech && e.result.text) {
        console.log(
          '[BatchTranscribe] recognized (chunk %d/%d): "%s"',
          chunkIndex + 1,
          totalChunks,
          e.result.text.substring(0, 80),
        );
        results.push(e.result.text);
      } else if (e.result.reason === sdk.ResultReason.NoMatch) {
        console.log('[BatchTranscribe] NoMatch (chunk %d/%d)', chunkIndex + 1, totalChunks);
      }
    };

    recognizer.sessionStarted = () => {
      console.log('[BatchTranscribe] sessionStarted (chunk %d/%d)', chunkIndex + 1, totalChunks);
    };

    recognizer.sessionStopped = () => {
      console.log(
        '[BatchTranscribe] sessionStopped (chunk %d/%d), results=%d',
        chunkIndex + 1,
        totalChunks,
        results.length,
      );
      finish(results.join(' '));
    };

    recognizer.canceled = (_s, e) => {
      console.log(
        '[BatchTranscribe] canceled (chunk %d/%d), reason=%s, errorDetails=%s',
        chunkIndex + 1,
        totalChunks,
        sdk.CancellationReason[e.reason],
        e.errorDetails ?? 'none',
      );

      if (resolved) return;

      if (e.reason === sdk.CancellationReason.Error) {
        resolved = true;
        clearTimeout(safetyTimer);
        try {
          recognizer.close();
        } catch {
          /* ignore */
        }
        reject(new Error(e.errorDetails || 'Azure Speech SDK cancellation error'));
      } else {
        // EndOfStream or other non-error cancellation — return what we have
        finish(results.join(' '));
      }
    };

    recognizer.startContinuousRecognitionAsync(
      () => {
        console.log(
          '[BatchTranscribe] Recognition started for chunk %d/%d (timeout=%dms)',
          chunkIndex + 1,
          totalChunks,
          timeoutMs,
        );
      },
      (err) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(safetyTimer);
        try {
          recognizer.close();
        } catch {
          /* ignore */
        }
        reject(new Error(`Failed to start recognition: ${err}`));
      },
    );
  });
}

interface WhisperCredentials {
  /** Full URL to POST the transcription request to */
  url: string;
  /** HTTP headers (auth, api-version, etc.) */
  headers: Record<string, string>;
  /** Model name for the form data (e.g. 'whisper-1' or deployment name) */
  model: string;
  /** Multipart field name for the audio upload. OpenAI-compatible transcription endpoints expect 'file'. */
  fileField: string;
}

/**
 * Resolve Whisper transcription credentials from the app config.
 *
 * The LLM gateway plugin configures audio + realtime as Azure-protocol
 * endpoints pointing at the gateway. The gateway hosts a `speech-to-text`
 * deployment behind an OpenAI-compatible transcription API:
 *   POST {endpoint}/v1/audio/transcriptions
 *
 * Priority:
 *   1. Audio azure config (set by the gateway plugin) — Azure OpenAI protocol
 *   2. Realtime azure config — Azure OpenAI protocol
 *   3. Realtime openai config — vanilla OpenAI protocol
 *   4. Realtime custom config — vanilla OpenAI protocol
 *   5. Model providers — first openai-compatible provider
 *
 * Returns null if no suitable credentials are found.
 */
function resolveWhisperCredentials(config: AppConfig): WhisperCredentials | null {
  const DEFAULT_STT_DEPLOYMENT = 'speech-to-text';

  // 1. Audio azure config (gateway plugin sets this)
  const audio = config.audio;
  if (audio?.provider === 'azure' && audio.azure?.subscriptionKey && audio.azure?.endpoint) {
    const base = audio.azure.endpoint.replace(/\/+$/, '');
    return {
      url: `${base}/v1/audio/transcriptions`,
      headers: { 'api-key': audio.azure.subscriptionKey },
      model: DEFAULT_STT_DEPLOYMENT,
      fileField: 'file',
    };
  }

  // 2. Realtime azure config
  const rt = config.realtime;
  if (rt?.provider === 'azure' && rt.azure?.apiKey && rt.azure?.endpoint) {
    const base = rt.azure.endpoint.replace(/\/+$/, '');
    return {
      url: `${base}/v1/audio/transcriptions`,
      headers: { 'api-key': rt.azure.apiKey },
      model: DEFAULT_STT_DEPLOYMENT,
      fileField: 'file',
    };
  }

  // 3. Realtime openai config — vanilla OpenAI
  if (rt?.provider === 'openai' && rt.openai?.apiKey) {
    return {
      url: 'https://api.openai.com/v1/audio/transcriptions',
      headers: { Authorization: `Bearer ${rt.openai.apiKey}` },
      model: 'whisper-1',
      fileField: 'file',
    };
  }

  // 4. Realtime custom config
  if (rt?.provider === 'custom' && rt.custom?.apiKey && rt.custom?.baseUrl) {
    let httpBase = rt.custom.baseUrl.replace(/\/+$/, '');
    if (/^wss?:\/\//.test(httpBase)) {
      httpBase = httpBase.replace(/^ws/, 'http');
    }
    return {
      url: `${httpBase}/v1/audio/transcriptions`,
      headers: { Authorization: `Bearer ${rt.custom.apiKey}` },
      model: 'whisper-1',
      fileField: 'file',
    };
  }

  // 5. Model providers — first OpenAI-compatible with an API key
  if (config.models?.providers) {
    for (const provider of Object.values(config.models.providers)) {
      if (provider.type === 'openai-compatible' && provider.apiKey) {
        const base = provider.endpoint?.replace(/\/+$/, '') || 'https://api.openai.com';
        return {
          url: `${base}/v1/audio/transcriptions`,
          headers: { Authorization: `Bearer ${provider.apiKey}` },
          model: 'whisper-1',
          fileField: 'file',
        };
      }
    }
  }

  return null;
}

/**
 * Transcribe audio using Whisper-compatible API (OpenAI or Azure OpenAI).
 *
 * Uses Electron's net.fetch (Chromium network stack) which respects the
 * OS certificate store — essential for corporate proxies that intercept TLS.
 */
async function transcribeWithWhisper(
  wavBuffer: Buffer,
  language: string,
  creds: WhisperCredentials,
): Promise<{ text: string }> {
  // Convert BCP-47 (e.g. 'en-US') to ISO-639-1 (e.g. 'en') for Whisper
  const langCode = language.split('-')[0].toLowerCase();

  // Build multipart/form-data body manually
  const boundary = `----WhisperBoundary${Date.now()}${Math.random().toString(36).slice(2)}`;
  const parts: Buffer[] = [];

  // file/audio field (field name varies by provider)
  parts.push(
    Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="${creds.fileField}"; filename="recording.wav"\r\n` +
        `Content-Type: audio/wav\r\n\r\n`,
    ),
  );
  parts.push(wavBuffer);
  parts.push(Buffer.from('\r\n'));

  // model field
  parts.push(
    Buffer.from(`--${boundary}\r\n` + `Content-Disposition: form-data; name="model"\r\n\r\n` + `${creds.model}\r\n`),
  );

  // language field
  parts.push(
    Buffer.from(`--${boundary}\r\n` + `Content-Disposition: form-data; name="language"\r\n\r\n` + `${langCode}\r\n`),
  );

  // closing boundary
  parts.push(Buffer.from(`--${boundary}--\r\n`));

  const body = Buffer.concat(parts);

  console.log(
    '[BatchTranscribe:Whisper] POST %s, model=%s, language=%s, wav=%d bytes, body=%d bytes',
    creds.url,
    creds.model,
    langCode,
    wavBuffer.length,
    body.length,
  );

  const response = await net.fetch(creds.url, {
    method: 'POST',
    headers: {
      ...creds.headers,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
    },
    body,
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => '');
    throw new Error(`Whisper API error ${response.status}: ${errorBody}`);
  }

  const responseText = await response.text();

  // Parse response — gateway returns JSON with combinedPhrases, OpenAI returns plain text
  let transcribedText: string;
  try {
    const json = JSON.parse(responseText) as {
      text?: string;
      combinedPhrases?: Array<{ text: string }>;
    };
    // Gateway format: { combinedPhrases: [{ text: "..." }] }
    if (json.combinedPhrases?.length) {
      transcribedText = json.combinedPhrases.map((p) => p.text).join(' ');
    } else {
      // Standard OpenAI JSON format: { text: "..." }
      transcribedText = json.text ?? responseText;
    }
  } catch {
    // Plain text response (response_format=text)
    transcribedText = responseText;
  }

  console.log('[BatchTranscribe:Whisper] Done: %d chars', transcribedText.length);
  return { text: transcribedText.trim() };
}

export function registerBatchTranscribeHandlers(ipc: IpcMain, getConfig: () => AppConfig): void {
  ipc.handle('stt:batch-transcribe', async (event, request: BatchTranscribeRequest): Promise<BatchTranscribeResult> => {
    console.log(
      '[BatchTranscribe] Request received, language=%s, hasWavBase64=%s',
      request.language,
      Boolean(request.wavBase64),
    );

    try {
      const config = getConfig();

      // Load the WAV buffer
      if (!request.wavBase64) {
        return { text: '', error: 'No audio data provided' };
      }

      // Validate the language tag at the boundary: it flows into a manually-built
      // multipart body (Whisper) and the Azure SDK's recognition-language prop.
      // Reject rather than silently fall back so a malformed tag can't produce
      // wrong-language recognition or a corrupt request.
      if (!isValidTranscriptionLanguage(request.language)) {
        return { text: '', error: 'Invalid transcription language' };
      }

      const wavBuffer = Buffer.from(request.wavBase64, 'base64');

      if (wavBuffer.length < 44) {
        return { text: '', error: 'WAV data too short (missing header)' };
      }

      const durationSec = calculateWavDuration(wavBuffer);
      console.log('[BatchTranscribe] WAV buffer: %d bytes, ~%.1f seconds', wavBuffer.length, durationSec);

      // ── Whisper HTTP path (preferred — fast, simple HTTP) ──────
      const whisperCreds = resolveWhisperCredentials(config);
      if (whisperCreds) {
        console.log('[BatchTranscribe] Using Whisper API: %s', whisperCreds.url);
        try {
          const result = await transcribeWithWhisper(wavBuffer, request.language, whisperCreds);
          return { text: result.text, durationSec };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error('[BatchTranscribe:Whisper] Error:', msg);
          return { text: '', error: `Whisper transcription failed: ${msg}` };
        }
      }

      // ── Azure Speech SDK path ───────────────────────────────────
      const azureConfig = config.audio?.azure;
      if (!azureConfig?.subscriptionKey) {
        return {
          text: '',
          error:
            'No transcription credentials configured. Configure an OpenAI-compatible provider or Azure Speech credentials.',
        };
      }

      const sender = event.sender;
      const azureKey = azureConfig.subscriptionKey;
      const azureRegion = azureConfig.region ?? 'eastus';
      const azureEndpoint = azureConfig.sttEndpoint ?? azureConfig.endpoint;

      // Short recordings (< 3 min): transcribe as single unit
      if (durationSec < CHUNK_THRESHOLD_SEC) {
        const result = await transcribeSingleBuffer(
          wavBuffer,
          request.language,
          azureKey,
          azureRegion,
          azureEndpoint,
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
          azureKey,
          azureRegion,
          azureEndpoint,
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

/** Exposed for unit tests only. */
export const __internal = { resolveWhisperCredentials };
