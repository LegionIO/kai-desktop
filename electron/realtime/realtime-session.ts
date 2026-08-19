/**
 * Realtime Audio Session Manager
 *
 * Manages a WebSocket connection to the OpenAI Realtime API (or compatible endpoint)
 * for bidirectional audio streaming. Supports OpenAI, Azure OpenAI, and custom providers.
 *
 * Audio format: PCM16 24kHz mono (base64 encoded over the WebSocket)
 */

import { BrowserWindow } from 'electron';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { broadcastToWebClients } from '../web-server/web-clients.js';
import { z } from 'zod';
import type { AppConfig } from '../config/schema.js';
import { sanitizeRealtimeToolResult } from './tool-result.js';
import { resolveModelForThread } from '../agent/model-catalog.js';
import { compactToolResult, estimateToolTokens } from '../agent/compaction.js';
import type { ToolCompactionConfig } from '../agent/compaction.js';
import { findToolByName } from '../tools/naming.js';
import type { ToolDefinition } from '../tools/types.js';
import type { ComputerUseEvent } from '../../shared/computer-use.js';
import { getExistingComputerUseManager } from '../computer-use/service.js';
import type { IncomingMessage } from 'http';
import { withBrandUserAgent } from '../utils/user-agent.js';
import { redactBrowserToolArgsForExposure, redactBrowserToolErrorForExposure } from '../../shared/browser.js';
import { applyPostToolUseHooks, prepareToolUseWithHooks } from '../agent/hooks/tool-lifecycle.js';
import { hookDispatcher } from '../agent/hooks/dispatcher.js';

/* ── Types ── */

export type RealtimeProvider = 'openai' | 'azure' | 'custom';

export type RealtimeSessionStatus = 'idle' | 'connecting' | 'connected' | 'disconnected' | 'error';

type ActiveRealtimeToolCall = {
  toolName: string;
  tool: ToolDefinition;
  abort: AbortController;
  startedAt: string;
};

export type RealtimeEvent =
  | { type: 'status'; status: RealtimeSessionStatus; error?: string }
  | { type: 'transcript'; role: 'user' | 'assistant'; text: string; isFinal: boolean; itemId: string }
  | { type: 'audio'; audioBase64: string }
  | {
      type: 'tool-call';
      toolCallId: string;
      toolName: string;
      args: string;
      status: 'pending' | 'running' | 'done' | 'error';
    }
  | { type: 'tool-result'; toolCallId: string; result: unknown; isError?: boolean }
  | { type: 'input-speech'; speaking: boolean }
  | { type: 'response-started' }
  | { type: 'response-done' }
  | { type: 'end-call-pending' }
  | { type: 'interrupt'; itemId: string; spokenText: string; unspokenText: string };

/** Events broadcast on the agent:stream-event channel for RuntimeProvider integration */
export type RealtimeStreamEvent =
  | { type: 'realtime-user-transcript'; conversationId: string; text: string; isFinal: boolean; itemId: string }
  | { type: 'text-delta'; conversationId: string; text: string; source: 'realtime' }
  | { type: 'realtime-interrupt'; conversationId: string; spokenText: string; unspokenText: string }
  | {
      type: 'tool-call';
      conversationId: string;
      toolCallId: string;
      toolName: string;
      args: unknown;
      startedAt: string;
      source: 'realtime';
    }
  | {
      type: 'tool-result';
      conversationId: string;
      toolCallId: string;
      toolName: string;
      result: unknown;
      isError?: boolean;
      startedAt: string;
      finishedAt: string;
      source: 'realtime';
      compaction?: {
        originalContent: string;
        wasCompacted: boolean;
        extractionDurationMs: number;
      };
    }
  | {
      type: 'tool-compaction';
      conversationId: string;
      toolCallId: string;
      toolName: string;
      source: 'realtime';
      data: {
        phase: 'start' | 'complete';
        originalContent?: string;
        extractionDurationMs?: number;
        timestamp: string;
      };
    }
  | { type: 'realtime-status'; conversationId: string; status: RealtimeSessionStatus; error?: string }
  | { type: 'done'; conversationId: string; source: 'realtime' };

type PendingToolCall = {
  callId: string;
  name: string;
  argumentsJson: string;
  startedAt: string;
  argumentsSuppressed: boolean;
};

const WS_OPEN = 1; // WS_OPEN constant

/** Cap accumulated function-call args (provider-streamed deltas) so a buggy or
 *  hostile realtime endpoint can't grow memory unbounded over a session. */
const MAX_FUNCTION_ARGS_BYTES = 1024 * 1024;
/**
 * Redact a WebSocket/HTTP URL for logging: strips userinfo and masks any
 * query param whose name looks credential-bearing (token/key/secret/password).
 * A custom realtime baseUrl can legitimately carry `?token=…` or userinfo, which
 * must not land in logs. Falls back to a scheme-only string if the URL is
 * unparseable (never log the raw value on failure).
 */
function redactUrlForLog(raw: string): string {
  try {
    const u = new URL(raw);
    if (u.username || u.password) {
      u.username = '';
      u.password = '';
    }
    for (const key of [...u.searchParams.keys()]) {
      if (/token|key|secret|password|auth|sig/i.test(key)) {
        u.searchParams.set(key, '***');
      }
    }
    return u.toString();
  } catch {
    const scheme = raw.split('://')[0];
    return scheme && scheme !== raw ? `${scheme}://[unparseable-url-redacted]` : '[redacted-url]';
  }
}

export function realtimeServerEventPreview(eventType: string, event: Record<string, unknown>): string {
  if (eventType === 'response.audio.delta') return '(audio data)';
  // The aggregate response repeats completed output items, including full
  // function-call arguments. Never stringify it: Browser typing, passwords,
  // OTPs, and scripts may all be present even though their delta/item events
  // were redacted individually.
  if (eventType === 'response.done') return '(response aggregate redacted)';
  if (eventType === 'response.function_call_arguments.delta' || eventType === 'response.function_call_arguments.done') {
    return '(function-call arguments redacted)';
  }
  if (
    (eventType === 'response.output_item.added' ||
      eventType === 'response.output_item.done' ||
      eventType === 'conversation.item.created') &&
    (event.item as { type?: unknown } | undefined)?.type === 'function_call'
  ) {
    return '(function-call arguments redacted)';
  }
  if (
    (eventType === 'response.output_item.added' ||
      eventType === 'response.output_item.done' ||
      eventType === 'conversation.item.created') &&
    (event.item as { type?: unknown } | undefined)?.type === 'function_call_output'
  ) {
    return '(function-call output redacted)';
  }
  // Provider event schemas can grow without a Kai release. Default-deny the
  // payload so newly introduced transcript, tool, or credential fields do not
  // silently become plaintext diagnostics.
  return '(event payload redacted)';
}

export class RealtimeSession {
  /** Unique owner for browser tabs and control leases created by this call. */
  readonly browserOwnerId = randomUUID();
  private ws: WebSocket | null = null;
  private connectionGeneration = 0;
  private _status: RealtimeSessionStatus = 'idle';
  private conversationId: string = '';
  private config: AppConfig['realtime'];
  private tools: ToolDefinition[];
  private getFullConfig: () => AppConfig;
  private pendingToolCalls: Map<string, PendingToolCall> = new Map();
  /** Aborted on close()/failAndClose() so an in-flight tool.execute() is
   *  cancelled when the call ends, and finishToolCall becomes a no-op for a
   *  result that arrives after teardown (it would otherwise broadcast a
   *  tool-result for a dead session). */
  private toolAbort: AbortController = new AbortController();
  private activeToolCalls: Map<string, ActiveRealtimeToolCall> = new Map();
  /** True once the session has been torn down (close/failAndClose). */
  private torndown = false;
  private terminalNotified = false;
  private pendingStart: { reject: (error: Error) => void } | null = null;
  private lastSessionUpdatePayload: string | null = null;
  private greetingRequested = false;

  /** Whether the AI has requested to end the call (deferred until response completes) */
  private _endCallRequested = false;

  /** Tracks whether we are inside a response (between response.created and response.done) */
  private _inResponse = false;
  private functionCallBuffers: Map<string, { name: string; args: string; itemId: string; callId: string }> = new Map();

  /** Audio tracking for barge-in truncation */
  private _currentAudioItemId: string | null = null;
  private _currentAudioContentIndex: number = 0;
  private _audioBytesSent: number = 0; // total PCM16 bytes sent for current item
  /** Transcript snapshot at the moment of interruption (what was approximately spoken) */
  private _interruptedSpokenText: string | null = null;
  private _interruptedItemId: string | null = null;

  /** Pre-built memory context to inject into session instructions */
  private memoryContext: string = '';

  /** Computer-use live tracking: session IDs started via tool calls during this realtime session */
  private computerSessionIds = new Set<string>();
  private computerEventCleanup: (() => void) | null = null;
  private lastComputerUpdateAt = new Map<string, number>();

  /** Track partial transcripts keyed by item_id */
  private userTranscriptBuffers: Map<string, string> = new Map();
  private assistantTranscriptBuffers: Map<string, string> = new Map();

  constructor(
    getConfig: () => AppConfig,
    tools: ToolDefinition[],
    private readonly onTerminal?: () => void,
  ) {
    this.getFullConfig = getConfig;
    this.config = getConfig().realtime;
    this.tools = tools;
  }

  get status(): RealtimeSessionStatus {
    return this._status;
  }

  private notifyTerminal(): void {
    if (this.terminalNotified) return;
    this.terminalNotified = true;
    try {
      this.onTerminal?.();
    } catch {
      // Session teardown must not depend on an observer callback.
    }
  }

  private rejectPendingStart(error: Error): void {
    const pending = this.pendingStart;
    if (!pending) return;
    this.pendingStart = null;
    pending.reject(error);
  }

  /* ── Public API ── */

  async start(conversationId: string, memoryContext?: string): Promise<void> {
    if (this.ws) {
      this.close();
    }

    this.conversationId = conversationId;
    this.torndown = false;
    // These guards belong to one WebSocket connection, not the reusable
    // RealtimeSession object. A fresh socket must receive its initial session
    // configuration and greeting, and must notify its own terminal observer.
    this.terminalNotified = false;
    this.lastSessionUpdatePayload = null;
    this.greetingRequested = false;
    if (this.toolAbort.signal.aborted) this.toolAbort = new AbortController();
    this.activeToolCalls.clear();
    this.config = this.getFullConfig().realtime;
    this.memoryContext = memoryContext ?? '';
    this.pendingToolCalls.clear();
    this.functionCallBuffers.clear();
    this.userTranscriptBuffers.clear();
    this.assistantTranscriptBuffers.clear();
    this._endCallRequested = false;
    this._inResponse = false;
    this._audioChunkCount = 0;
    this._serverEventCount = 0;

    this.setupComputerUseTracking();
    this.setStatus('connecting');
    const connectionGeneration = ++this.connectionGeneration;

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let pendingStart!: { reject: (error: Error) => void };
      const settle = (fn: () => void) => {
        if (!settled) {
          settled = true;
          if (this.pendingStart === pendingStart) this.pendingStart = null;
          fn();
        }
      };
      pendingStart = { reject: (error) => settle(() => reject(error)) };
      this.pendingStart = pendingStart;

      try {
        const { url, headers } = this.buildConnection();
        console.info(`[RealtimeSession] Connecting to: ${redactUrlForLog(url)}`);
        console.info(`[RealtimeSession] Headers: ${Object.keys(headers).join(', ')}`);
        const socket = new WebSocket(url, { headers });
        this.ws = socket;
        const isCurrentSocket = () => this.connectionGeneration === connectionGeneration && this.ws === socket;

        socket.on('open', () => {
          if (!isCurrentSocket()) return;
          this.setStatus('connected');
          this.sendSessionUpdate();
          settle(() => resolve());
        });

        socket.on('message', (data: WebSocket.RawData) => {
          if (!isCurrentSocket()) return;
          try {
            const event = JSON.parse(data.toString());
            this.handleServerEvent(event);
          } catch (err) {
            console.error('[RealtimeSession] Failed to parse server event:', err);
          }
        });

        socket.on('close', (code: number, reason: Buffer) => {
          if (!isCurrentSocket()) return;
          this.connectionGeneration++;
          this.ws = null;
          console.info(`[RealtimeSession] WebSocket closed: code=${code} reason=${reason.toString()}`);
          if (this._status !== 'error') {
            this.setStatus('disconnected');
          }
          // Remote close (network drop / provider hangup): mark torn down and
          // abort in-flight tools BEFORE broadcasting done, mirroring
          // failAndClose(). Otherwise a tool still running when the socket closed
          // keeps executing uncancelled, and its finishToolCall() would broadcast
          // a tool-result for a now-dead session (the exact race the torndown
          // guard exists to prevent).
          this.torndown = true;
          this.toolAbort.abort();
          // Tear down computer-use tracking so its listener does not outlive the
          // socket (setupComputerUseTracking ran before connect).
          this.teardownComputerUseTracking();
          this.broadcastStreamEvent({ type: 'done', conversationId: this.conversationId, source: 'realtime' });
          this.notifyTerminal();
          settle(() => reject(new Error('Realtime connection closed before session start completed.')));
        });

        socket.on('error', (err: Error) => {
          if (!isCurrentSocket()) return;
          // ECONNRESET after intentional close is expected — just log it
          if (settled) {
            console.info(`[RealtimeSession] Post-settle WebSocket error (safe to ignore): ${err.message}`);
            return;
          }
          this.connectionGeneration++;
          this.ws = null;
          console.error('[RealtimeSession] WebSocket error:', err.message);
          this.setStatus('error', err.message);
          this.teardownComputerUseTracking();
          settle(() => reject(err));
        });

        // Capture the actual HTTP response body on upgrade failure (400, 401, etc.)
        socket.on('unexpected-response', (_req: unknown, res: IncomingMessage) => {
          if (!isCurrentSocket()) return;
          let body = '';
          // Cap the error body: a failed handshake response is provider-controlled
          // and could otherwise stream unbounded before 'end'.
          const MAX_UPGRADE_BODY = 16 * 1024;
          let truncated = false;
          res.on('data', (chunk: Buffer) => {
            if (!isCurrentSocket()) return;
            if (body.length >= MAX_UPGRADE_BODY) {
              truncated = true;
              return;
            }
            body += chunk.toString();
            if (body.length > MAX_UPGRADE_BODY) {
              body = body.slice(0, MAX_UPGRADE_BODY);
              truncated = true;
            }
          });
          res.on('end', () => {
            if (!isCurrentSocket()) return;
            this.connectionGeneration++;
            this.ws = null;
            const shown = truncated ? `${body}…(truncated)` : body;
            const msg = `HTTP ${res.statusCode}: ${shown || res.statusMessage || 'Unknown error'}`;
            console.error(`[RealtimeSession] WebSocket upgrade rejected: ${msg}`);
            console.error(`[RealtimeSession] Response headers:`, JSON.stringify(res.headers, null, 2));
            this.setStatus('error', msg);
            this.teardownComputerUseTracking();
            settle(() => reject(new Error(msg)));
          });
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[RealtimeSession] Failed to connect:', msg);
        this.setStatus('error', msg);
        this.teardownComputerUseTracking();
        settle(() => reject(err instanceof Error ? err : new Error(msg)));
      }
    });
  }

  close(): void {
    this.rejectPendingStart(new Error('Realtime session closed before startup completed.'));
    this.torndown = true;
    this.toolAbort.abort();
    this.teardownComputerUseTracking();
    const socket = this.ws;
    this.connectionGeneration++;
    this.ws = null;
    if (socket) {
      try {
        socket.close(1000, 'Client closing');
      } catch {
        // Ignore close errors
      }
    }
    this.setStatus('disconnected');
    this.broadcastStreamEvent({ type: 'done', conversationId: this.conversationId, source: 'realtime' });
    this.notifyTerminal();
  }

  /**
   * Terminal failure path for a fatal server/connection error: tear the session
   * down (close the socket + computer-use tracking) so the main process can't be
   * left half-open when the renderer doesn't call endSession, and surface the
   * error status once. Idempotent — a second call after the socket is gone is a
   * cheap no-op.
   */
  private failAndClose(message: string): void {
    if (!this.ws && this._status === 'error') return; // already failed+closed
    this.rejectPendingStart(new Error(`Realtime session failed before startup completed: ${message}`));
    this.torndown = true;
    this.toolAbort.abort();
    this.teardownComputerUseTracking();
    const socket = this.ws;
    this.connectionGeneration++;
    this.ws = null;
    if (socket) {
      try {
        socket.close(1011, 'Fatal error');
      } catch {
        // Ignore close errors
      }
    }
    // setStatus already broadcasts the status event (both realtime + stream).
    this.setStatus('error', message);
    this.broadcastStreamEvent({ type: 'done', conversationId: this.conversationId, source: 'realtime' });
    this.notifyTerminal();
  }

  private _audioChunkCount = 0;
  private _lastAudioLogTime = 0;

  sendAudio(pcmBase64: string): void {
    if (!this.ws || this.ws.readyState !== WS_OPEN) return;

    // Resample 16kHz → 24kHz (mic captures at 16kHz, Realtime API expects 24kHz PCM16)
    const resampled = resample16to24(pcmBase64);

    this.ws.send(
      JSON.stringify({
        type: 'input_audio_buffer.append',
        audio: resampled,
      }),
    );

    this._audioChunkCount++;
    const now = Date.now();
    if (now - this._lastAudioLogTime > 3000) {
      console.info(
        `[RealtimeSession] Audio sent: ${this._audioChunkCount} chunks total, latest input=${pcmBase64.length} chars → resampled=${resampled.length} chars`,
      );
      this._lastAudioLogTime = now;
    }
  }

  updateTools(tools: ToolDefinition[]): void {
    this.tools = tools;
    const revokedCalls: Array<[string, ActiveRealtimeToolCall]> = [];
    for (const [callId, active] of [...this.activeToolCalls]) {
      if (findToolByName(tools, active.toolName) === active.tool) continue;
      // Revocation must both stop privileged execution and settle the provider's
      // outstanding function call. Silently dropping it leaves the Realtime
      // response waiting forever for a function_call_output that can never arrive.
      this.activeToolCalls.delete(callId);
      active.abort.abort();
      revokedCalls.push([callId, active]);
    }
    // Update the provider-visible tool surface before asking it to resume from
    // any revoked calls, so the replacement response cannot select a stale tool.
    if (this.ws && this.ws.readyState === WS_OPEN) {
      this.sendSessionUpdate();
    }
    for (const [callId, active] of revokedCalls) {
      this.finishToolCall(
        callId,
        active.toolName,
        { error: 'Tool access was revoked before completion.' },
        true,
        active.startedAt,
        undefined,
        false,
      );
    }
    if (revokedCalls.length > 0) this.requestModelContinuation();
  }

  /* ── Computer-Use Live Tracking ── */

  private setupComputerUseTracking(): void {
    try {
      const manager = getExistingComputerUseManager();
      if (!manager) return;

      const handler = (event: ComputerUseEvent) => {
        if (!('sessionId' in event)) return;
        const sessionId = (event as { sessionId: string }).sessionId;
        if (!this.computerSessionIds.has(sessionId)) return;

        const cfg = this.getFullConfig().realtime.computerUseUpdates;
        if (cfg && !cfg.enabled) return;

        const message = this.formatComputerEvent(event, cfg);
        if (!message) return;

        // Throttle (configurable, default 3s) — terminal events always pass
        const now = Date.now();
        const last = this.lastComputerUpdateAt.get(sessionId) ?? 0;
        const throttleMs = cfg?.throttleMs ?? 3000;
        const isTerminal = message.includes('completed') || message.includes('failed') || message.includes('stopped');
        if (now - last < throttleMs && !isTerminal) return;

        this.lastComputerUpdateAt.set(sessionId, now);
        this.injectComputerUpdate(message);
      };

      manager.on('event', handler);
      this.computerEventCleanup = () => manager.off('event', handler);
    } catch {
      // Computer-use module may not be available
    }
  }

  private teardownComputerUseTracking(): void {
    this.computerEventCleanup?.();
    this.computerEventCleanup = null;
    this.computerSessionIds.clear();
    this.lastComputerUpdateAt.clear();
  }

  private formatComputerEvent(
    event: ComputerUseEvent,
    cfg?: AppConfig['realtime']['computerUseUpdates'],
  ): string | null {
    switch (event.type) {
      case 'session-updated': {
        const s = event.session;
        if (s.status === 'completed' && (cfg?.onSessionCompleted ?? true))
          return `Computer session completed successfully. Goal was: "${s.goal}". Final subgoal: ${s.currentSubgoal ?? 'done'}.`;
        if (s.status === 'failed' && (cfg?.onSessionFailed ?? true))
          return `Computer session failed: ${s.lastError ?? 'unknown error'}. Goal was: "${s.goal}".`;
        if (s.status === 'stopped') return 'Computer session was stopped by the user.';
        if (s.status === 'awaiting-approval' && (cfg?.onApprovalNeeded ?? true))
          return `Computer session needs your approval: ${s.statusMessage ?? 'an action requires confirmation before proceeding'}.`;
        return null;
      }
      case 'action-updated': {
        const a = event.action;
        if (a.status === 'completed' && (cfg?.onStepCompleted ?? true)) {
          const details: string[] = [`${a.kind}`];
          if (a.text) details.push(`typed "${a.text}"`);
          if (a.url) details.push(`navigated to ${a.url}`);
          if (a.appName) details.push(`in ${a.appName}`);
          if (a.x != null && a.y != null) details.push(`at (${a.x}, ${a.y})`);
          const desc = details.join(' ');
          return `Step completed: ${desc}. ${a.rationale}${a.resultSummary ? ` Result: ${a.resultSummary}` : ''}`;
        }
        if (a.status === 'failed' && (cfg?.onStepFailed ?? true))
          return `Step failed: ${a.kind} — ${a.error ?? 'unknown error'}. Was trying to: ${a.rationale}`;
        return null;
      }
      case 'checkpoint':
        if (!(cfg?.onCheckpoint ?? true)) return null;
        return `Checkpoint reached: ${event.checkpoint.summary}. Criteria: ${event.checkpoint.successCriteria.join(', ')}.`;
      case 'guidance-sent':
        if (!(cfg?.onGuidanceReceived ?? true)) return null;
        return `User guidance received: "${event.message.text}"`;
      case 'error':
        return `Computer session error: ${event.error}`;
      default:
        return null;
    }
  }

  private injectComputerUpdate(text: string): void {
    if (!this.ws || this.ws.readyState !== WS_OPEN) return;

    this.ws.send(
      JSON.stringify({
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: `[Computer Session Update] ${text}` }],
        },
      }),
    );

    // Trigger a response so the model can react — but only if not already responding
    if (!this._inResponse) {
      this.ws.send(JSON.stringify({ type: 'response.create' }));
    }
  }

  /* ── Connection Building ── */

  private buildConnection(): { url: string; headers: Record<string, string> } {
    const provider = this.config.provider;
    const model = this.config.model || 'gpt-4o-realtime-preview';

    if (provider === 'openai') {
      const apiKey = this.config.openai?.apiKey;
      if (!apiKey) throw new Error('OpenAI API key not configured for realtime');
      return {
        url: `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`,
        headers: withBrandUserAgent({
          Authorization: `Bearer ${apiKey}`,
          'OpenAI-Beta': 'realtime=v1',
        }),
      };
    }

    if (provider === 'azure') {
      const azureCfg = this.config.azure;
      if (!azureCfg?.endpoint || !azureCfg?.apiKey) {
        throw new Error('Azure endpoint and API key required for realtime');
      }
      const deployment = azureCfg.deploymentName || model;
      const apiVersion = azureCfg.apiVersion || '2024-10-01-preview';
      // Derive WebSocket URL from the endpoint, preserving http vs https
      const wsBase = azureCfg.endpoint.replace(/\/+$/, '').replace(/^http/, 'ws');
      const url = `${wsBase}/openai/realtime?api-version=${apiVersion}&deployment=${encodeURIComponent(deployment)}`;
      console.info(
        `[RealtimeSession] Azure config: endpoint="${redactUrlForLog(azureCfg.endpoint)}" deploymentName="${azureCfg.deploymentName}" model="${model}" → resolved deployment="${deployment}"`,
      );
      console.info(`[RealtimeSession] Azure WebSocket URL: ${redactUrlForLog(url)}`);
      return {
        url,
        headers: withBrandUserAgent({
          'api-key': azureCfg.apiKey,
        }),
      };
    }

    if (provider === 'custom') {
      const customCfg = this.config.custom;
      if (!customCfg?.baseUrl) throw new Error('Custom base URL required for realtime');
      const baseUrl = customCfg.baseUrl.replace(/\/+$/, '');
      // Convert http(s) to ws(s), or leave ws(s) as-is
      let wsUrl: string;
      if (/^wss?:\/\//.test(baseUrl)) {
        wsUrl = baseUrl; // already a WebSocket URL
      } else if (/^https?:\/\//.test(baseUrl)) {
        wsUrl = baseUrl.replace(/^http/, 'ws'); // http→ws, https→wss
      } else {
        wsUrl = `wss://${baseUrl}`; // no protocol — default to secure wss://
      }
      const separator = wsUrl.includes('?') ? '&' : '?';
      const headers = withBrandUserAgent();
      if (customCfg.apiKey) {
        headers['Authorization'] = `Bearer ${customCfg.apiKey}`;
      }
      const url = `${wsUrl}${separator}model=${encodeURIComponent(model)}`;
      console.info(`[RealtimeSession] Custom WebSocket URL: ${redactUrlForLog(url)}`);
      console.info(`[RealtimeSession] Custom headers: ${JSON.stringify(Object.keys(headers))}`);
      return { url, headers };
    }

    throw new Error(`Unknown realtime provider: ${provider}`);
  }

  /* ── Session Configuration ── */

  private sendSessionUpdate(): void {
    if (!this.ws || this.ws.readyState !== WS_OPEN) return;

    const cuSurface = this.getFullConfig().computerUse?.toolSurface ?? 'both';
    const cuEnabledForCalls = cuSurface === 'both' || cuSurface === 'only-calls';
    const effectiveTools = cuEnabledForCalls
      ? this.tools
      : this.tools.filter((t) => !t.name.startsWith('computer_use_'));

    const toolDefinitions = effectiveTools.map((tool) => {
      let parameters: Record<string, unknown> = { type: 'object', properties: {} };
      if (tool.inputSchema) {
        const schema = z.toJSONSchema(tool.inputSchema, { target: 'draft-7' }) as Record<string, unknown>;
        // Remove $schema and additionalProperties — Realtime API doesn't need them
        delete schema.$schema;
        delete schema.additionalProperties;
        parameters = schema;
      }
      return {
        type: 'function' as const,
        name: tool.name,
        description: tool.description,
        parameters,
      };
    });

    // Add the built-in end_call tool
    toolDefinitions.push({
      type: 'function' as const,
      name: 'end_call',
      description:
        'End the current voice call. Use this when the user says goodbye, asks to hang up, or the conversation has naturally concluded. The call will end after your current response finishes.',
      parameters: { type: 'object', properties: {} } as Record<string, unknown>,
    });

    // Compose instructions from config + memory context
    const instructionParts = [this.config.instructions || '', this.memoryContext || ''].filter(Boolean);
    const composedInstructions = instructionParts.length > 0 ? instructionParts.join('\n\n') : undefined;

    console.info(
      `[RealtimeSession] Instructions composition: configInstructions=${(this.config.instructions || '').length} chars, memoryContext=${this.memoryContext.length} chars, composed=${composedInstructions?.length ?? 0} chars`,
    );

    const sessionConfig: Record<string, unknown> = {
      type: 'session.update',
      session: {
        modalities: ['text', 'audio'],
        instructions: composedInstructions,
        voice: this.config.voice || 'alloy',
        input_audio_format: 'pcm16',
        output_audio_format: 'pcm16',
        input_audio_transcription: this.config.inputAudioTranscription !== false ? { model: 'whisper-1' } : null,
        turn_detection:
          this.config.turnDetection?.type === 'none'
            ? null
            : {
                type: 'server_vad',
                threshold: this.config.turnDetection?.threshold ?? 0.5,
                silence_duration_ms: this.config.turnDetection?.silenceDurationMs ?? 500,
                prefix_padding_ms: 300,
              },
        tools: toolDefinitions.length > 0 ? toolDefinitions : undefined,
      },
    };

    const payload = JSON.stringify(sessionConfig);
    if (payload === this.lastSessionUpdatePayload) return;
    console.info('[RealtimeSession] Sending session.update with', toolDefinitions.length, 'tools');
    console.info('[RealtimeSession] Instructions prepared:', composedInstructions ? 'yes' : 'no');
    this.ws.send(payload);
    this.lastSessionUpdatePayload = payload;
  }

  /* ── Server Event Handling ── */

  private _serverEventCount = 0;

  private handleServerEvent(event: Record<string, unknown>): void {
    const eventType = event.type as string;
    this._serverEventCount++;

    // Log all events for first 20, then periodically
    if (this._serverEventCount <= 20 || this._serverEventCount % 50 === 0) {
      const preview = realtimeServerEventPreview(eventType, event);
      console.info(`[RealtimeSession] Server event #${this._serverEventCount}: ${eventType} ${preview}`);
    }

    switch (eventType) {
      case 'session.created':
        console.info('[RealtimeSession] Session created');
        break;
      case 'session.updated':
        console.info('[RealtimeSession] Session updated');
        // Inject a synthetic message to prompt the assistant to greet the user
        if (!this.greetingRequested && this.ws?.readyState === WS_OPEN) {
          this.greetingRequested = true;
          this.ws.send(
            JSON.stringify({
              type: 'conversation.item.create',
              item: {
                type: 'message',
                role: 'user',
                content: [{ type: 'input_text', text: '[Call has been answered]' }],
              },
            }),
          );
          this.ws.send(JSON.stringify({ type: 'response.create' }));
        }
        break;

      case 'error': {
        const error = event.error as { message?: string; code?: string } | undefined;
        const msg = error?.message ?? 'Unknown realtime API error';
        const code = error?.code ?? '';
        // Some errors are benign (e.g., cancelling a response that already finished)
        // Only broadcast fatal status for connection/session-level errors
        const benignCodes = [
          'response_cancel_not_active',
          'conversation_item_not_found',
          'conversation_already_has_active_response',
        ];
        if (benignCodes.includes(code)) {
          console.info('[RealtimeSession] Benign server error (ignored):', msg, code);
        } else {
          // Fatal server/session error: tear the session down so the main
          // process isn't left half-open (the renderer may not call endSession).
          console.error('[RealtimeSession] Fatal server error — closing session:', msg, code);
          this.failAndClose(msg);
        }
        break;
      }

      /* ── Input (user) events ── */

      case 'input_audio_buffer.speech_started':
        console.info('[RealtimeSession] VAD: speech started');
        this.broadcastRealtimeEvent({ type: 'input-speech', speaking: true });
        // Barge-in: cancel the current AI response and truncate unplayed audio
        if (this._inResponse && this.ws?.readyState === WS_OPEN) {
          console.info('[RealtimeSession] Interrupting AI response (barge-in)');

          // Snapshot the transcript at the moment of interruption — this is approximately what was spoken
          if (this._currentAudioItemId) {
            this._interruptedItemId = this._currentAudioItemId;
            this._interruptedSpokenText = (this.assistantTranscriptBuffers.get(this._currentAudioItemId) ?? '').trim();
          }

          this.ws.send(JSON.stringify({ type: 'response.cancel' }));

          // Truncate the model's audio to what the user actually heard
          if (this._currentAudioItemId) {
            const totalAudioMs = Math.round((this._audioBytesSent / 2 / 24000) * 1000);
            const playedMs = Math.max(0, totalAudioMs - 500);
            console.info(
              `[RealtimeSession] Truncating audio item ${this._currentAudioItemId} at ${playedMs}ms (total sent: ${totalAudioMs}ms)`,
            );
            this.ws.send(
              JSON.stringify({
                type: 'conversation.item.truncate',
                item_id: this._currentAudioItemId,
                content_index: this._currentAudioContentIndex,
                audio_end_ms: playedMs,
              }),
            );
          }
        }
        break;

      case 'input_audio_buffer.speech_stopped':
        console.info('[RealtimeSession] VAD: speech stopped');
        this.broadcastRealtimeEvent({ type: 'input-speech', speaking: false });
        break;

      case 'input_audio_buffer.committed':
        console.info('[RealtimeSession] Input audio buffer committed');
        break;

      case 'conversation.item.input_audio_transcription.completed': {
        const itemId = event.item_id as string;
        const transcript = event.transcript as string;
        console.info('[RealtimeSession] User transcription completed');
        if (transcript) {
          this.userTranscriptBuffers.set(itemId, transcript);
          this.broadcastRealtimeEvent({
            type: 'transcript',
            role: 'user',
            text: transcript,
            isFinal: true,
            itemId,
          });
          this.broadcastStreamEvent({
            type: 'realtime-user-transcript',
            conversationId: this.conversationId,
            text: transcript,
            isFinal: true,
            itemId,
          });
        }
        break;
      }

      /* ── Response events ── */

      case 'response.created':
        this._inResponse = true;
        this._currentAudioItemId = null;
        this._audioBytesSent = 0;
        this._interruptedItemId = null;
        this._interruptedSpokenText = null;
        this.broadcastRealtimeEvent({ type: 'response-started' });
        break;

      case 'response.done': {
        this._inResponse = false;
        this._currentAudioItemId = null;
        this._audioBytesSent = 0;

        // Check if this was a cancelled response (barge-in interrupt)
        const responseObj = event.response as { status?: string } | undefined;
        if (responseObj?.status === 'cancelled' && this._interruptedItemId && this._interruptedSpokenText != null) {
          // Get the full accumulated text (includes deltas that arrived after the interrupt)
          const fullText = (this.assistantTranscriptBuffers.get(this._interruptedItemId) ?? '').trim();
          const spokenText = this._interruptedSpokenText;
          const unspokenText = fullText.length > spokenText.length ? fullText.slice(spokenText.length).trim() : '';

          if (spokenText && unspokenText) {
            console.info(
              `[RealtimeSession] Interrupt resolved: spoken=${spokenText.length} chars, unspoken=${unspokenText.length} chars`,
            );
            this.broadcastRealtimeEvent({
              type: 'interrupt',
              itemId: this._interruptedItemId,
              spokenText,
              unspokenText,
            });
            this.broadcastStreamEvent({
              type: 'realtime-interrupt',
              conversationId: this.conversationId,
              spokenText,
              unspokenText,
            });
          }
        }

        // Clear interrupt tracking
        this._interruptedItemId = null;
        this._interruptedSpokenText = null;

        this.broadcastRealtimeEvent({ type: 'response-done' });
        break;
      }

      /* ── Audio output ── */

      case 'response.audio.delta': {
        const audioBase64 = event.delta as string;
        if (audioBase64) {
          // Track item ID and accumulate audio bytes for truncation on barge-in
          const itemId = event.item_id as string;
          const contentIndex = (event.content_index as number) ?? 0;
          if (itemId) {
            this._currentAudioItemId = itemId;
            this._currentAudioContentIndex = contentIndex;
          }
          // base64 → raw bytes: each base64 char = 6 bits, so length * 3/4 = bytes
          this._audioBytesSent += Math.floor((audioBase64.length * 3) / 4);

          this.broadcastRealtimeEvent({ type: 'audio', audioBase64 });
        }
        break;
      }

      /* ── Text transcript output ── */

      case 'response.audio_transcript.delta': {
        const itemId = event.item_id as string;
        const delta = event.delta as string;
        if (delta) {
          const existing = this.assistantTranscriptBuffers.get(itemId) ?? '';
          this.assistantTranscriptBuffers.set(itemId, existing + delta);
          this.broadcastRealtimeEvent({
            type: 'transcript',
            role: 'assistant',
            text: delta,
            isFinal: false,
            itemId,
          });
          this.broadcastStreamEvent({
            type: 'text-delta',
            conversationId: this.conversationId,
            text: delta,
            source: 'realtime',
          });
        }
        break;
      }

      case 'response.audio_transcript.done': {
        const itemId = event.item_id as string;
        const fullText = event.transcript as string;
        if (fullText) {
          this.assistantTranscriptBuffers.set(itemId, fullText);
          this.broadcastRealtimeEvent({
            type: 'transcript',
            role: 'assistant',
            text: fullText,
            isFinal: true,
            itemId,
          });
        }
        break;
      }

      /* ── Function/tool calls ── */

      case 'response.function_call_arguments.delta': {
        const callId = event.call_id as string;
        const delta = event.delta as string;
        if (!callId || !delta) break;

        const buf = this.functionCallBuffers.get(callId);
        if (buf) {
          // Cap accumulated tool-call args: a buggy/hostile provider streaming
          // endless deltas must not grow memory unbounded for the session's life.
          // 1 MiB is far above any real tool-args payload; extra deltas are dropped
          // (the args.done handler will then fail to JSON.parse and error the call).
          if (buf.args.length < MAX_FUNCTION_ARGS_BYTES) {
            buf.args += delta;
          }
        } else {
          this.functionCallBuffers.set(callId, {
            name: (event.name as string) ?? '',
            args: delta.slice(0, MAX_FUNCTION_ARGS_BYTES),
            itemId: event.item_id as string,
            callId,
          });
        }
        break;
      }

      case 'response.function_call_arguments.done': {
        const callId = event.call_id as string;
        const buf = this.functionCallBuffers.get(callId);
        const toolName = buf?.name || (event.name as string) || 'unknown';
        const argsJson = buf?.args || (event.arguments as string) || '{}';

        this.functionCallBuffers.delete(callId);

        // Broadcast tool-call event
        const startedAt = new Date().toISOString();
        const argumentsSuppressed = hookDispatcher.hasEnforcingToolHooks();
        const exposedArgs = argumentsSuppressed
          ? { pending: true }
          : redactBrowserToolArgsForExposure(toolName, safeParseJSON(argsJson));
        this.broadcastRealtimeEvent({
          type: 'tool-call',
          toolCallId: callId,
          toolName,
          args: JSON.stringify(exposedArgs),
          status: 'running',
        });
        this.broadcastStreamEvent({
          type: 'tool-call',
          conversationId: this.conversationId,
          toolCallId: callId,
          toolName,
          args: exposedArgs,
          startedAt,
          source: 'realtime',
        });

        // Execute tool
        this.pendingToolCalls.set(callId, {
          callId,
          name: toolName,
          argumentsJson: argsJson,
          startedAt,
          argumentsSuppressed,
        });
        void this.executeTool(callId, toolName, argsJson);
        break;
      }

      /* ── Output item done (for completed function calls from server) ── */

      case 'response.output_item.done': {
        const item = event.item as Record<string, unknown> | undefined;
        if (item?.type === 'function_call') {
          // Already handled via function_call_arguments.done
        }
        break;
      }

      /* ── Content part lifecycle (authoritative transcript on done) ── */

      case 'response.content_part.added':
        // Content part started — no action needed (streaming deltas handle live display)
        break;

      case 'response.content_part.done': {
        // Store the authoritative final transcript for this content part
        const part = event.part as { type?: string; transcript?: string } | undefined;
        const contentField = event.content as { type?: string; transcript?: string } | undefined;
        const itemId = event.item_id as string;
        const finalTranscript = (part?.transcript ?? contentField?.transcript ?? '').trim();
        if (finalTranscript && itemId) {
          this.assistantTranscriptBuffers.set(itemId, finalTranscript);
          this.broadcastRealtimeEvent({
            type: 'transcript',
            role: 'assistant',
            text: finalTranscript,
            isFinal: true,
            itemId,
          });
        }
        break;
      }

      case 'response.audio.done':
        // Audio stream finished for this content part — no action needed
        break;

      case 'response.output_item.added':
      case 'conversation.item.created':
        // Informational — item added to conversation. No action needed.
        break;

      case 'conversation.item.truncated':
        // Confirmation that our truncation was applied. Logged for debugging.
        console.info('[RealtimeSession] Audio truncation confirmed');
        break;

      default:
        // Log unhandled events so we can spot transcription failures or other issues
        console.info(`[RealtimeSession] Unhandled event: ${eventType} ${realtimeServerEventPreview(eventType, event)}`);
        break;
    }
  }

  /* ── Tool Execution ── */

  private stringifyToolResult(result: unknown): string {
    if (typeof result === 'string') return result;
    if (result == null) return '';
    try {
      return JSON.stringify(result);
    } catch {
      return String(result);
    }
  }

  private latestUserQuery(): string {
    const entries = Array.from(this.userTranscriptBuffers.values());
    return entries.at(-1)?.trim() ?? '';
  }

  private async maybeCompactToolOutput(
    callId: string,
    toolName: string,
    result: unknown,
    isCurrent: () => boolean,
  ): Promise<{
    result: unknown;
    compaction?: {
      originalContent: string;
      wasCompacted: boolean;
      extractionDurationMs: number;
    };
  }> {
    const fullConfig = this.getFullConfig();
    const toolCompaction = fullConfig.compaction?.tool as ToolCompactionConfig | undefined;
    if (!toolCompaction?.enabled) {
      return { result };
    }

    const originalText = this.stringifyToolResult(result);
    const modelEntry = resolveModelForThread(fullConfig, null);
    const modelName = modelEntry?.modelConfig.modelName;
    const shouldAttemptCompaction =
      originalText.length > 0 && estimateToolTokens(originalText, modelName) > toolCompaction.triggerTokens;

    if (!shouldAttemptCompaction) {
      return { result };
    }

    const conversationId = this.conversationId;
    const connectionGeneration = this.connectionGeneration;
    const isCurrentSessionCall = (): boolean =>
      isCurrent() &&
      !this.torndown &&
      this.connectionGeneration === connectionGeneration &&
      this.conversationId === conversationId;
    if (!isCurrentSessionCall()) return { result };

    this.broadcastStreamEvent({
      type: 'tool-compaction',
      conversationId,
      toolCallId: callId,
      toolName,
      source: 'realtime',
      data: {
        phase: 'start',
        originalContent: originalText,
        timestamp: new Date().toISOString(),
      },
    });

    try {
      const compacted = await compactToolResult(
        originalText,
        toolName,
        this.latestUserQuery(),
        toolCompaction,
        modelEntry?.modelConfig,
        modelName,
      );

      if (!isCurrentSessionCall()) return { result };
      if (compacted.wasCompacted) {
        this.broadcastStreamEvent({
          type: 'tool-compaction',
          conversationId,
          toolCallId: callId,
          toolName,
          source: 'realtime',
          data: {
            phase: 'complete',
            extractionDurationMs: compacted.extractionDurationMs ?? 0,
            timestamp: new Date().toISOString(),
          },
        });

        return {
          result: compacted.content,
          compaction: {
            originalContent: originalText,
            wasCompacted: true,
            extractionDurationMs: compacted.extractionDurationMs ?? 0,
          },
        };
      }
    } catch (error) {
      console.warn('[RealtimeSession] Tool compaction failed for', toolName, ':', error);
    }

    return { result };
  }

  private async executeTool(callId: string, toolName: string, argsJson: string): Promise<void> {
    const pending = this.pendingToolCalls.get(callId);
    const startedAt = pending?.startedAt ?? new Date().toISOString();
    let resolvedArgsPublished = !pending?.argumentsSuppressed;
    const publishResolvedArgs = (args: unknown): void => {
      if (resolvedArgsPublished) return;
      resolvedArgsPublished = true;
      this.broadcastRealtimeEvent({
        type: 'tool-call',
        toolCallId: callId,
        toolName,
        args: JSON.stringify(args),
        status: 'running',
      });
      this.broadcastStreamEvent({
        type: 'tool-call',
        conversationId: this.conversationId,
        toolCallId: callId,
        toolName,
        args,
        startedAt,
        source: 'realtime',
      });
    };

    // Handle the built-in end_call tool
    if (toolName === 'end_call') {
      publishResolvedArgs({});
      console.info('[RealtimeSession] AI requested end_call — notifying renderer');
      this.finishToolCall(
        callId,
        toolName,
        { success: true, message: 'Call will end after your response completes.' },
        false,
        startedAt,
      );
      // Notify renderer — it will wait for all audio to finish playing before closing
      this.broadcastRealtimeEvent({ type: 'end-call-pending' });
      return;
    }

    const tool = findToolByName(this.tools, toolName);

    if (!tool) {
      publishResolvedArgs({ redacted: true, reason: 'Unknown tool.' });
      const errorResult = { error: `Unknown tool: ${toolName}` };
      this.finishToolCall(callId, toolName, errorResult, true, startedAt);
      return;
    }

    const duplicate = this.activeToolCalls.get(callId);
    if (duplicate) {
      this.activeToolCalls.delete(callId);
      duplicate.abort.abort();
      this.finishToolCall(
        callId,
        duplicate.toolName,
        { error: 'Realtime protocol error: duplicate active tool call id.' },
        true,
        duplicate.startedAt,
      );
      return;
    }

    const callAbort = new AbortController();
    const abortForSession = () => callAbort.abort();
    const sessionToolSignal = this.toolAbort.signal;
    if (sessionToolSignal.aborted) callAbort.abort();
    else sessionToolSignal.addEventListener('abort', abortForSession, { once: true });
    const activeCall = { toolName, tool, abort: callAbort, startedAt };
    this.activeToolCalls.set(callId, activeCall);
    const isCurrent = (): boolean =>
      !this.torndown &&
      !callAbort.signal.aborted &&
      this.activeToolCalls.get(callId) === activeCall &&
      findToolByName(this.tools, toolName) === tool;
    const dropRevokedCall = (): void => {
      this.pendingToolCalls.delete(callId);
    };

    let exposedArgs = redactBrowserToolArgsForExposure(toolName, safeParseJSON(argsJson));
    try {
      if (!isCurrent()) {
        dropRevokedCall();
        return;
      }
      const prepared = await prepareToolUseWithHooks(this.conversationId, callId, toolName, safeParseJSON(argsJson));
      if (!isCurrent()) {
        dropRevokedCall();
        return;
      }
      exposedArgs = prepared.exposedArgs;
      if (!prepared.allowed) {
        publishResolvedArgs(prepared.exposedArgs);
        const postTool = await applyPostToolUseHooks(
          this.conversationId,
          callId,
          toolName,
          prepared.exposedArgs,
          prepared.result,
        );
        if (!isCurrent()) {
          dropRevokedCall();
          return;
        }
        const compacted = await this.maybeCompactToolOutput(
          callId,
          toolName,
          sanitizeRealtimeToolResult(postTool.result),
          isCurrent,
        );
        if (!isCurrent()) {
          dropRevokedCall();
          return;
        }
        this.finishToolCall(
          callId,
          toolName,
          compacted.result,
          postTool.denied || !postTool.modified,
          startedAt,
          compacted.compaction,
        );
        return;
      }

      const args = tool.inputSchema.parse(prepared.args);
      exposedArgs = redactBrowserToolArgsForExposure(toolName, args);
      if (!isCurrent()) {
        dropRevokedCall();
        return;
      }
      publishResolvedArgs(exposedArgs);
      if (!isCurrent()) {
        dropRevokedCall();
        return;
      }
      const rawResult = await tool.execute(args, {
        toolCallId: callId,
        conversationId: this.conversationId,
        browserOwnerId: this.browserOwnerId,
        abortSignal: callAbort.signal,
      });
      if (!isCurrent()) {
        dropRevokedCall();
        return;
      }
      const postTool = await applyPostToolUseHooks(this.conversationId, callId, toolName, exposedArgs, rawResult);
      if (!isCurrent()) {
        dropRevokedCall();
        return;
      }
      const compacted = await this.maybeCompactToolOutput(
        callId,
        toolName,
        sanitizeRealtimeToolResult(postTool.result),
        isCurrent,
      );
      if (!isCurrent()) {
        dropRevokedCall();
        return;
      }
      this.finishToolCall(callId, toolName, compacted.result, postTool.denied, startedAt, compacted.compaction);
    } catch (err) {
      if (!isCurrent()) {
        dropRevokedCall();
        return;
      }
      const rawErrorResult = { error: redactBrowserToolErrorForExposure(toolName, err) };
      publishResolvedArgs({ redacted: true, reason: 'Tool arguments were rejected.' });
      const postTool = await applyPostToolUseHooks(this.conversationId, callId, toolName, exposedArgs, rawErrorResult);
      if (!isCurrent()) {
        dropRevokedCall();
        return;
      }
      const compacted = await this.maybeCompactToolOutput(
        callId,
        toolName,
        sanitizeRealtimeToolResult(postTool.result),
        isCurrent,
      );
      if (!isCurrent()) {
        dropRevokedCall();
        return;
      }
      this.finishToolCall(
        callId,
        toolName,
        compacted.result,
        postTool.denied || !postTool.modified,
        startedAt,
        compacted.compaction,
      );
    } finally {
      sessionToolSignal.removeEventListener('abort', abortForSession);
      if (this.activeToolCalls.get(callId) === activeCall) this.activeToolCalls.delete(callId);
    }
  }

  private finishToolCall(
    callId: string,
    toolName: string,
    result: unknown,
    isError: boolean,
    startedAt: string,
    compaction?: {
      originalContent: string;
      wasCompacted: boolean;
      extractionDurationMs: number;
    },
    requestContinuation = true,
  ): void {
    const finishedAt = new Date().toISOString();
    this.pendingToolCalls.delete(callId);

    // If the session was torn down while this tool ran (hangup / fatal error),
    // don't broadcast a tool-result or push it to the (now-closed) socket — the
    // result is for a dead session. Dropping the pending entry above is enough.
    if (this.torndown) {
      return;
    }

    // Broadcast result to renderer
    this.broadcastRealtimeEvent({
      type: 'tool-result',
      toolCallId: callId,
      result,
      isError,
    });
    this.broadcastStreamEvent({
      type: 'tool-result',
      conversationId: this.conversationId,
      toolCallId: callId,
      toolName,
      result,
      isError,
      startedAt,
      finishedAt,
      source: 'realtime',
      ...(compaction ? { compaction } : {}),
    });

    // Send result back to the Realtime API
    if (this.ws && this.ws.readyState === WS_OPEN) {
      // Create a conversation item with the tool output
      this.ws.send(
        JSON.stringify({
          type: 'conversation.item.create',
          item: {
            type: 'function_call_output',
            call_id: callId,
            output: JSON.stringify(result),
          },
        }),
      );

      if (requestContinuation) this.requestModelContinuation();

      // Auto-track computer-use sessions started via tool calls
      if (toolName === 'computer_use_session' && !isError) {
        const sessionId = (result as { sessionId?: string })?.sessionId;
        if (sessionId) {
          this.computerSessionIds.add(sessionId);
        }
      }
    }
  }

  private requestModelContinuation(): void {
    if (!this.ws || this.ws.readyState !== WS_OPEN) return;
    this.ws.send(
      JSON.stringify({
        type: 'response.create',
      }),
    );
  }

  /* ── Broadcasting ── */

  private setStatus(status: RealtimeSessionStatus, error?: string): void {
    this._status = status;
    this.broadcastRealtimeEvent({ type: 'status', status, error });
    this.broadcastStreamEvent({
      type: 'realtime-status',
      conversationId: this.conversationId,
      status,
      error,
    });
  }

  /** Broadcast on the realtime:event channel (for RealtimeProvider) */
  private broadcastRealtimeEvent(event: RealtimeEvent): void {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('realtime:event', event);
    }
    broadcastToWebClients('realtime:event', event);
  }

  /** Broadcast on the agent:stream-event channel (for RuntimeProvider/thread integration) */
  private broadcastStreamEvent(event: RealtimeStreamEvent): void {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('agent:stream-event', event);
    }
    broadcastToWebClients('agent:stream-event', event);
  }
}

/* ── Helpers ── */

function safeParseJSON(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return json;
  }
}

/**
 * Resample PCM16 audio from 16kHz to 24kHz using linear interpolation.
 * Input and output are base64-encoded Int16 PCM data.
 * Ratio: 24000/16000 = 3/2, so every 2 input samples produce 3 output samples.
 */
function resample16to24(pcmBase64: string): string {
  // Decode base64 to Int16Array
  const binaryString = Buffer.from(pcmBase64, 'base64');
  const input = new Int16Array(binaryString.buffer, binaryString.byteOffset, binaryString.byteLength / 2);

  if (input.length === 0) return pcmBase64;

  // 24kHz/16kHz = 1.5 ratio
  const ratio = 24000 / 16000;
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

  // Encode back to base64
  return Buffer.from(output.buffer, output.byteOffset, output.byteLength).toString('base64');
}
