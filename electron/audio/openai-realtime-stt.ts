/**
 * OpenAI Realtime STT — WebSocket-based streaming speech-to-text client.
 *
 * Implements the OpenAI Realtime API transcription protocol:
 * - Connects via WebSocket to `{baseUrl}/v1/realtime?model={model}`
 * - Sends audio as PCM16 base64 frames via `input_audio_buffer.append`
 * - Receives transcript events (`conversation.item.input_audio_transcription.*`)
 *
 * The server (OpenAI or gateway proxy) handles transcription intent automatically
 * based on the model name (gpt-realtime-whisper) or gateway routing.
 *
 * Used by both Dictation Anywhere and Composer streaming STT.
 */

import WebSocket from 'ws';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface OpenAIRealtimeSttConfig {
  /** WebSocket base URL, e.g. "wss://api.openai.com" or "wss://gateway.example.com" */
  baseUrl: string;
  /** API key for authentication */
  apiKey: string;
  /** Model name, e.g. "gpt-realtime-whisper" */
  model: string;
  /** PCM sample rate in Hz (default: 24000 — OpenAI Realtime native rate) */
  sampleRate?: number;
  /** BCP-47 language hint (optional, e.g. "en") */
  language?: string;
}

export interface OpenAIRealtimeSttCallbacks {
  onPartial: (text: string) => void;
  onFinal: (text: string) => void;
  onError: (error: string) => void;
}

type SessionState = 'idle' | 'connecting' | 'open' | 'stopping' | 'closed';

// ─── Session Class ──────────────────────────────────────────────────────────

export class OpenAIRealtimeSttSession {
  private ws: WebSocket | null = null;
  private state: SessionState = 'idle';
  private config: OpenAIRealtimeSttConfig;
  private callbacks: OpenAIRealtimeSttCallbacks;
  private accumulatedTranscript = '';
  private currentPartial = '';
  private openResolve: (() => void) | null = null;
  private openReject: ((err: Error) => void) | null = null;
  private stopResolve: ((transcript: string) => void) | null = null;
  private connectTimeoutId: ReturnType<typeof setTimeout> | null = null;
  private stopTimeoutId: ReturnType<typeof setTimeout> | null = null;
  private aborted = false;

  constructor(config: OpenAIRealtimeSttConfig, callbacks: OpenAIRealtimeSttCallbacks) {
    this.config = config;
    this.callbacks = callbacks;
  }

  /** Open the WebSocket connection and send session configuration. */
  async start(): Promise<void> {
    if (this.state !== 'idle') {
      throw new Error(`Cannot start: session is in state "${this.state}"`);
    }

    this.state = 'connecting';
    this.aborted = false;

    const baseUrl = this.normalizeBaseUrl(this.config.baseUrl);
    const url = `${baseUrl}/v1/realtime?model=${encodeURIComponent(this.config.model)}`;

    console.info('[OpenAI-RTT] Connecting to %s', url);

    return new Promise<void>((resolve, reject) => {
      this.openResolve = resolve;
      this.openReject = reject;

      // Build headers based on base URL pattern
      const headers: Record<string, string> = {
        'OpenAI-Beta': 'realtime=v1',
      };

      // Use api-key header for Azure-style gateways, Authorization for OpenAI-style
      const baseUrlLower = baseUrl.toLowerCase();
      if (baseUrlLower.includes('azure') || baseUrlLower.includes('microsoft')) {
        headers['api-key'] = this.config.apiKey;
      } else {
        headers['Authorization'] = `Bearer ${this.config.apiKey}`;
      }

      this.ws = new WebSocket(url, { headers });

      this.connectTimeoutId = setTimeout(() => {
        if (this.state === 'connecting') {
          const err = new Error('WebSocket connection timed out after 15 seconds');
          this.handleError(err.message);
          this.destroy();
          reject(err);
          this.openResolve = null;
          this.openReject = null;
        }
      }, 15000);

      this.ws.on('open', () => {
        this.clearConnectTimeout();

        // Guard against late open after abort/cancel
        if (this.aborted || this.state !== 'connecting') {
          this.ws?.close(1000);
          return;
        }

        this.state = 'open';
        console.info('[OpenAI-RTT] Connected');
        this.sendSessionConfig();
        this.openResolve?.();
        this.openResolve = null;
        this.openReject = null;
      });

      this.ws.on('message', (data) => {
        this.handleMessage(data);
      });

      this.ws.on('error', (err) => {
        this.clearConnectTimeout();
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[OpenAI-RTT] WebSocket error: %s', msg);
        this.handleError(`WebSocket error: ${msg}`);
        if (this.openReject) {
          this.openReject(new Error(msg));
          this.openResolve = null;
          this.openReject = null;
        }
      });

      this.ws.on('close', (code, reason) => {
        this.clearConnectTimeout();
        const reasonStr = reason?.toString() || '';
        console.info('[OpenAI-RTT] WebSocket closed: code=%d reason=%s', code, reasonStr);

        const wasConnecting = this.state === 'connecting';
        const wasStopping = this.state === 'stopping';
        if (this.state !== 'closed') {
          this.state = 'closed';
        }

        // Reject any pending open if socket closed while still connecting
        if (wasConnecting && this.openReject) {
          this.openReject(new Error(`WebSocket closed before open (code=${code})`));
          this.openResolve = null;
          this.openReject = null;
        }

        // Flush any remaining partial as final (suppress if session was aborted/canceled)
        if (this.currentPartial && !this.aborted) {
          this.accumulatedTranscript += (this.accumulatedTranscript ? ' ' : '') + this.currentPartial.trim();
          this.currentPartial = '';
          this.callbacks.onFinal(this.accumulatedTranscript);
        } else {
          this.currentPartial = '';
        }

        if (wasStopping) {
          // Graceful close after stop() was called
          this.resolveStop();
        } else if (code !== 1000 && !this.aborted) {
          // Unexpected close
          this.handleError(`Connection closed unexpectedly (code=${code})`);
        }
      });
    });
  }

  /** Push a PCM16 audio chunk (base64-encoded) to the server. */
  pushAudio(pcmBase64: string): void {
    if (this.state !== 'open' || !this.ws) return;

    // Resample to 24kHz if the input is at a different rate (e.g. 16kHz mic capture)
    const audio = this.config.sampleRate && this.config.sampleRate !== 24000
      ? resamplePcm16(pcmBase64, this.config.sampleRate, 24000)
      : pcmBase64;

    this.ws.send(JSON.stringify({
      type: 'input_audio_buffer.append',
      audio,
    }));
  }

  /**
   * Gracefully stop the session.
   * Commits the audio buffer and waits for any final transcription events before closing.
   */
  async stop(): Promise<string> {
    if (this.state !== 'open' || !this.ws) {
      this.state = 'closed';
      return this.accumulatedTranscript;
    }

    this.state = 'stopping';

    // Commit the audio buffer to signal end-of-audio and trigger final transcription
    this.ws.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));

    // Wait for final transcription events, then close.
    // The server will send any remaining transcription results after commit.
    return new Promise<string>((resolve) => {
      this.stopResolve = resolve;

      this.stopTimeoutId = setTimeout(() => {
        console.info('[OpenAI-RTT] Stop timeout reached (3s), closing WebSocket');
        this.stopTimeoutId = null;
        this.ws?.close(1000);
        // resolveStop will be called from close handler
      }, 3000);
    });
  }

  /**
   * Cancel the session without waiting for final transcription.
   * Does NOT commit audio — just tears down immediately.
   */
  cancel(): void {
    this.aborted = true;
    this.clearConnectTimeout();
    this.clearStopTimeout();
    this.state = 'closed';

    if (this.ws) {
      try { this.ws.close(1000); } catch { /* ignore */ }
      this.ws = null;
    }

    // Reject any pending open
    if (this.openReject) {
      this.openReject(new Error('Session canceled'));
      this.openResolve = null;
      this.openReject = null;
    }

    this.resolveStop();
  }

  /** Force-destroy the session without waiting. */
  destroy(): void {
    this.aborted = true;
    this.clearConnectTimeout();
    this.clearStopTimeout();
    this.state = 'closed';

    if (this.ws) {
      try { this.ws.close(1000); } catch { /* ignore */ }
      this.ws = null;
    }

    // Reject any pending open to prevent callers from hanging
    if (this.openReject) {
      this.openReject(new Error('Session destroyed'));
      this.openResolve = null;
      this.openReject = null;
    }

    this.resolveStop();
  }

  /** Get the full accumulated transcript so far. */
  getTranscript(): string {
    return this.accumulatedTranscript + this.currentPartial;
  }

  // ─── Private ────────────────────────────────────────────────────────────────

  private normalizeBaseUrl(raw: string): string {
    let url = raw.replace(/\/+$/, '');

    // Convert http(s) to ws(s) if needed
    if (url.startsWith('https://')) {
      url = 'wss://' + url.slice(8);
    } else if (url.startsWith('http://')) {
      url = 'ws://' + url.slice(7);
    } else if (!url.startsWith('ws://') && !url.startsWith('wss://')) {
      url = 'wss://' + url;
    }

    return url;
  }

  private clearConnectTimeout(): void {
    if (this.connectTimeoutId) {
      clearTimeout(this.connectTimeoutId);
      this.connectTimeoutId = null;
    }
  }

  private clearStopTimeout(): void {
    if (this.stopTimeoutId) {
      clearTimeout(this.stopTimeoutId);
      this.stopTimeoutId = null;
    }
  }

  private resolveStop(): void {
    this.clearStopTimeout();
    if (this.stopResolve) {
      this.stopResolve(this.accumulatedTranscript);
      this.stopResolve = null;
    }
  }

  private sendSessionConfig(): void {
    if (!this.ws) return;

    // Send session.update with session.type = "transcription" and the nested
    // audio.input structure required by the OpenAI Realtime Transcription API.
    //
    // The correct format (per OpenAI SDK RealtimeTranscriptionSessionCreateRequest):
    //   session.type = "transcription"
    //   session.audio.input.format = { type: "audio/pcm", rate: 24000 }
    //   session.audio.input.transcription = { model, language }
    //   session.audio.input.turn_detection = { type: "server_vad", ... }
    //
    // The transcription.model must be the actual Azure deployment name of the
    // transcription model (e.g. "gpt-4o-transcribe"), NOT the WebSocket routing
    // model (e.g. "gpt-realtime-whisper"). We default to "gpt-4o-transcribe"
    // but allow override via config if a "transcribe" model is explicitly set.
    const transcriptionModel = this.config.model.includes('transcribe')
      ? this.config.model
      : 'gpt-4o-transcribe';

    const transcription: Record<string, unknown> = {
      model: transcriptionModel,
    };

    // Add language hint if provided (ISO 639-1 code, e.g. "en")
    if (this.config.language) {
      transcription.language = this.config.language.split('-')[0].toLowerCase();
    }

    const sessionConfig = {
      type: 'session.update',
      session: {
        type: 'transcription',
        audio: {
          input: {
            format: { type: 'audio/pcm', rate: 24000 },
            transcription,
            turn_detection: {
              type: 'server_vad',
              threshold: 0.5,
              prefix_padding_ms: 300,
              silence_duration_ms: 500,
            },
          },
        },
      },
    };

    this.ws.send(JSON.stringify(sessionConfig));
    console.info('[OpenAI-RTT] Sent session.update (type=transcription, model=%s, language=%s, turn_detection=server_vad)',
      transcriptionModel, this.config.language ?? 'auto');
    console.info('[OpenAI-RTT] Full payload: %s', JSON.stringify(sessionConfig));
  }

  private handleMessage(data: WebSocket.Data): void {
    let msg: { type?: string; [key: string]: unknown };
    try {
      msg = JSON.parse(String(data));
    } catch {
      return; // Ignore non-JSON messages
    }

    const type = msg.type;
    if (!type) return;

    // Debug: log all received messages for troubleshooting
    if (type !== 'input_audio_buffer.speech_started' && type !== 'input_audio_buffer.speech_stopped') {
      console.info('[OpenAI-RTT] recv: %s %s', type, JSON.stringify(msg).slice(0, 500));
    }

    switch (type) {
      case 'session.created':
      case 'session.updated':
      case 'transcription_session.created':
      case 'transcription_session.updated':
        console.info('[OpenAI-RTT] %s', type);
        break;

      // Partial transcript delta
      case 'conversation.item.input_audio_transcription.delta': {
        const delta = String((msg as Record<string, unknown>).delta ?? '');
        if (delta) {
          this.currentPartial += delta;
          this.callbacks.onPartial(this.accumulatedTranscript + this.currentPartial);
        }
        break;
      }

      // Final transcript for a speech segment
      case 'conversation.item.input_audio_transcription.completed': {
        const transcript = String((msg as Record<string, unknown>).transcript ?? '');
        if (transcript) {
          // Completed replaces the accumulated partial for this segment
          this.accumulatedTranscript += (this.accumulatedTranscript ? ' ' : '') + transcript.trim();
          this.currentPartial = '';
          this.callbacks.onFinal(this.accumulatedTranscript);
        } else if (this.currentPartial) {
          // If no transcript in completed event, use what we accumulated from deltas
          this.accumulatedTranscript += (this.accumulatedTranscript ? ' ' : '') + this.currentPartial.trim();
          this.currentPartial = '';
          this.callbacks.onFinal(this.accumulatedTranscript);
        }

        // If we're stopping, the completed event means transcription is done
        if (this.state === 'stopping') {
          this.ws?.close(1000);
        }
        break;
      }

      case 'input_audio_buffer.speech_started':
        // Server VAD detected speech start — no action needed
        break;

      case 'input_audio_buffer.speech_stopped':
        // Server VAD detected speech end — transcription will follow
        break;

      case 'input_audio_buffer.committed':
        // Audio buffer committed — server is processing
        console.info('[OpenAI-RTT] Audio buffer committed');
        break;

      case 'conversation.item.input_audio_transcription.failed': {
        const error = (msg as { error?: { message?: string; code?: string } }).error;
        const errorMsg = error?.message ?? 'Transcription failed';
        const errorCode = error?.code ?? 'unknown';
        console.error('[OpenAI-RTT] Transcription failed: code=%s message=%s', errorCode, errorMsg);
        this.handleError(`Transcription failed (${errorCode}): ${errorMsg}`);
        break;
      }

      case 'conversation.item.added':
      case 'conversation.item.done':
        // Conversation lifecycle events — no action needed
        break;

      case 'error': {
        const errorMsg = String((msg as Record<string, unknown>).message ??
          (msg as { error?: { message?: string } }).error?.message ?? 'Unknown error');
        console.error('[OpenAI-RTT] Server error: %s', errorMsg);
        this.handleError(errorMsg);
        break;
      }

      // Ignore other message types silently (response.*, etc.)
      default:
        break;
    }
  }

  private handleError(message: string): void {
    this.callbacks.onError(message);
  }
}

// ─── Factory helper ─────────────────────────────────────────────────────────

/**
 * Resolve OpenAI Realtime STT config from the app config.
 * For dictation: uses dictation.openai first, falls back to audio.stt.openai.
 * For composer: uses audio.stt.openai first, falls back to dictation.openai.
 * Returns null if no credentials are configured.
 */
export function resolveOpenAISttConfig(
  fullConfig: {
    dictation?: { provider?: string; openai?: { baseUrl?: string; apiKey?: string; model?: string } };
    audio?: { stt?: { provider?: string; openai?: { baseUrl?: string; apiKey?: string; model?: string } } };
  },
  source: 'dictation' | 'composer' = 'dictation',
): OpenAIRealtimeSttConfig | null {
  const dictationOpenai = fullConfig.dictation?.openai;
  const audioSttOpenai = fullConfig.audio?.stt?.openai;

  const primary = source === 'dictation' ? dictationOpenai : audioSttOpenai;
  const fallback = source === 'dictation' ? audioSttOpenai : dictationOpenai;

  const config = primary?.apiKey ? primary : fallback;

  if (!config?.apiKey) return null;

  return {
    baseUrl: config.baseUrl || 'wss://api.openai.com',
    apiKey: config.apiKey,
    model: config.model || 'gpt-realtime-whisper',
  };
}

// ─── Audio Resampling ─────────────────────────────────────────────────────────

/**
 * Resample PCM16 base64-encoded audio from one sample rate to another
 * using linear interpolation. Used to convert 16kHz mic capture to the
 * 24kHz rate expected by the OpenAI Realtime API.
 */
function resamplePcm16(pcmBase64: string, fromRate: number, toRate: number): string {
  if (fromRate === toRate) return pcmBase64;

  const buf = Buffer.from(pcmBase64, 'base64');
  const input = new Int16Array(buf.buffer, buf.byteOffset, buf.byteLength / 2);

  if (input.length === 0) return pcmBase64;

  const ratio = toRate / fromRate;
  const outputLen = Math.ceil(input.length * ratio);
  const output = new Int16Array(outputLen);

  for (let i = 0; i < outputLen; i++) {
    const srcPos = i / ratio;
    const srcIdx = Math.floor(srcPos);
    const frac = srcPos - srcIdx;

    if (srcIdx >= input.length - 1) {
      output[i] = input[input.length - 1];
    } else {
      // Linear interpolation
      output[i] = Math.round(input[srcIdx] * (1 - frac) + input[srcIdx + 1] * frac);
    }
  }

  return Buffer.from(output.buffer, output.byteOffset, output.byteLength).toString('base64');
}
