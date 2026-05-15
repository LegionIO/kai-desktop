/**
 * AithenaMemoryAdapter — Direct HTTP client to Aithena's cognitive memory API.
 *
 * Provides: context compilation, learning, recall, workflow events, and recommendations.
 * All calls are non-blocking with graceful degradation (NullAdapter pattern).
 * Timeouts: 5s default, 8s for context compilation (planning-critical).
 *
 * Endpoints consumed:
 *   POST /v1/context/compile   — Assemble ranked context packet
 *   POST /v1/memory/learn      — Encode interaction for long-term learning
 *   POST /v1/memory/remember   — Store a specific memory
 *   POST /v1/memory/recall     — Retrieve relevant memories
 *   GET  /v1/health            — Connection test
 *   GET  /v1/memory/stats      — Memory stats
 *   POST /v1/workflows/events  — Emit workflow lifecycle event
 *   GET  /v1/workflows/runs/:id/recommendations — Fetch recommendations
 *   PATCH /v1/workflows/runs/:id/recommendations/:recId — Dismiss recommendation
 *   POST /v1/memory/skill_search — Search for proven workflows
 *   POST /v1/memory/skill_feedback — Report skill outcome
 */

import type { AppConfig } from '../config/schema.js';
import { net } from 'electron';

// ── Types ──────────────────────────────────────────────────────────

export interface AithenaConfig {
  enabled: boolean;
  gatewayUrl: string;
  apiKey: string;
  /** Timeout for standard calls (ms). Default: 5000 */
  timeoutMs?: number;
  /** Timeout for context compilation (ms). Default: 8000 */
  compileTimeoutMs?: number;
}

export interface ContextPacket {
  memories: ContextMemory[];
  session_threads: ContextMemory[];
  rag_results: RagResult[];
  procedural_hints: ProceduralHint[];
  entities: unknown[];
  user_profile: unknown | null;
  workflow_context: unknown | null;
  intent: IntentResult | null;
  token_count: number;
  compiled_at: string;
  compile_ms: number;
}

export interface ContextMemory {
  id: string;
  memory_type: string;
  title: string;
  content: string;
  attention_score: number;
  confidence_score: number;
  trust_tier: string;
  signals?: Record<string, number>;
}

export interface RagResult {
  content: string;
  score: number;
  source_url?: string;
  title: string;
}

export interface ProceduralHint {
  id: string;
  title: string;
  confidence_score: number;
  trust_tier: string;
}

export interface IntentResult {
  intent: string;
  confidence: number;
  reasoning: string;
  query_signal: string;
  detected_topics: string[];
}

export interface LearnInput {
  userMessage: string;
  assistantResponse: string;
  conversationId?: string;
  metadata?: Record<string, unknown>;
}

export interface RememberInput {
  content: string;
  tier: 'episodic' | 'semantic' | 'procedural';
  category?: string;
  confidence?: number;
  metadata?: Record<string, unknown>;
}

export interface RecalledMemory {
  id: string;
  content: string;
  tier: string;
  score: number;
  metadata?: Record<string, unknown>;
}

export interface WorkflowEvent {
  runId: string;
  eventType: 'planned' | 'approved' | 'executing' | 'failed' | 'retried' | 'completed' | 'cancelled';
  phase?: string;
  payload?: Record<string, unknown>;
}

export interface Recommendation {
  id: string;
  type: 'risk' | 'next_action' | 'context' | 'learning' | 'escalation';
  title: string;
  content: string;
  confidence: number;
  suggested_action?: string;
  status: 'open' | 'accepted' | 'dismissed';
}

export interface SkillSearchResult {
  id: string;
  title: string;
  confidence_score: number;
  trust_tier: string;
  steps?: Array<{ action: string; tool?: string; params?: unknown; expected_outcome?: string }>;
}

export interface HealthResult {
  ok: boolean;
  version?: string;
  environment?: string;
  error?: string;
}

export interface MemoryStats {
  episodic_count: number;
  semantic_count: number;
  procedural_count: number;
  [key: string]: unknown;
}

export interface CompileContextOptions {
  topics?: string[];
  tokenBudget?: number;
  sessionId?: string;
  workspaceId?: string;
  workflowRunId?: string;
  includeRag?: boolean;
  includeProcedural?: boolean;
  includeProfile?: boolean;
  classifyIntent?: boolean;
  conversationContext?: Array<{ role: 'user' | 'assistant'; content: string }>;
}

// ── Constants ──────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 5_000;
const COMPILE_TIMEOUT_MS = 8_000;
const COMPILE_RETRY_TIMEOUT_MS = 16_000;

// ── Adapter ────────────────────────────────────────────────────────

export class AithenaMemoryAdapter {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly compileTimeoutMs: number;
  private available = false;

  constructor(config: AithenaConfig) {
    this.baseUrl = config.gatewayUrl.replace(/\/+$/, '');
    this.apiKey = config.apiKey;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.compileTimeoutMs = config.compileTimeoutMs ?? COMPILE_TIMEOUT_MS;
  }

  /** Check if Aithena is reachable. Also updates internal availability flag. */
  async checkHealth(): Promise<HealthResult> {
    try {
      const data = await this.get('/v1/health', this.timeoutMs) as Record<string, unknown>;
      this.available = data?.status === 'ok';
      return {
        ok: this.available,
        version: data?.version as string | undefined,
        environment: data?.environment as string | undefined,
      };
    } catch (err) {
      this.available = false;
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Get memory statistics. */
  async getStats(): Promise<MemoryStats | null> {
    if (!this.available) await this.checkHealth();
    if (!this.available) return null;

    try {
      return await this.get('/v1/memory/stats', this.timeoutMs) as MemoryStats;
    } catch {
      return null;
    }
  }

  /** Compile a context packet from Aithena's intelligence sources. */
  async compileContext(query: string, options?: CompileContextOptions): Promise<ContextPacket | null> {
    if (!this.available) await this.checkHealth();
    if (!this.available) return null;

    const body = {
      query,
      topics: options?.topics ?? null,
      session_id: options?.sessionId ?? null,
      workspace_id: options?.workspaceId ?? null,
      workflow_run_id: options?.workflowRunId ?? null,
      source_type: 'kai-desktop',
      include: {
        memory: true,
        rag: options?.includeRag ?? true,
        procedural: options?.includeProcedural ?? true,
        entities: false,
        profile: options?.includeProfile ?? false,
      },
      token_budget: options?.tokenBudget ?? 4000,
      min_confidence: 0.5,
      top_k: 10,
      classify_intent: options?.classifyIntent ?? false,
      conversation_context: options?.conversationContext ?? null,
    };

    // First attempt
    let result = await this.post('/v1/context/compile', body, this.compileTimeoutMs) as ContextPacket | null;
    if (result && (result.token_count ?? 0) > 0) return result;

    // Retry with extended timeout
    result = await this.post('/v1/context/compile', body, COMPILE_RETRY_TIMEOUT_MS) as ContextPacket | null;
    if (result && (result.token_count ?? 0) > 0) return result;

    return null;
  }

  /** Send a learning event to Aithena (fire-and-forget). */
  async learn(input: LearnInput): Promise<void> {
    if (!this.available) return;

    const body = {
      user_message: input.userMessage,
      assistant_response: input.assistantResponse,
      conversation_id: input.conversationId ?? null,
      source_type: 'kai-desktop',
      metadata: input.metadata ?? null,
      enable: {
        episodic: true,
        semantic_extraction: true,
        procedural_detection: true,
        identity_observation: true,
      },
    };

    // Fire-and-forget — don't await in caller
    this.post('/v1/memory/learn', body, this.timeoutMs).catch(() => {});
  }

  /** Store a specific memory. */
  async remember(input: RememberInput): Promise<void> {
    if (!this.available) return;

    const tier = input.tier;
    let path: string;
    let body: Record<string, unknown>;

    if (tier === 'semantic') {
      path = '/v1/memory/semantic/encode';
      body = {
        fact: input.content,
        category: input.category ?? 'preference',
        confidence: input.confidence ?? 0.8,
        source_type: 'kai-desktop',
        metadata: input.metadata ?? null,
      };
    } else if (tier === 'episodic') {
      path = '/v1/memory/episodic/encode';
      body = {
        user_message: input.content,
        assistant_response: input.content,
        source_type: 'kai-desktop',
        metadata: { ...(input.metadata ?? {}), category: input.category },
      };
    } else {
      // procedural
      path = '/v1/memory/procedural/encode';
      body = {
        trigger_pattern: input.content,
        steps: (input.metadata?.steps as unknown[]) ?? [],
        confidence: input.confidence ?? 0.8,
        source_type: 'kai-desktop',
        metadata: input.metadata ?? null,
      };
    }

    await this.post(path, body, this.timeoutMs).catch(() => {});
  }

  /** Recall relevant memories (uses context compile with memory-only scope). */
  async recall(query: string, topK = 5, minConfidence = 0.3): Promise<RecalledMemory[]> {
    if (!this.available) return [];

    try {
      const result = await this.post('/v1/context/compile', {
        query,
        source_type: 'kai-desktop',
        include: { memory: true, rag: false, procedural: false, entities: false, profile: false },
        token_budget: 4000,
        min_confidence: minConfidence,
        top_k: topK,
      }, this.timeoutMs) as ContextPacket | null;

      if (!result || !result.memories?.length) return [];
      return result.memories.map((m) => ({
        id: m.id,
        content: m.content,
        tier: m.memory_type,
        score: m.attention_score,
        metadata: m.signals as Record<string, unknown> | undefined,
      }));
    } catch {
      return [];
    }
  }

  /** Emit a workflow lifecycle event. */
  async emitWorkflowEvent(event: WorkflowEvent): Promise<void> {
    if (!this.available) return;

    const body = {
      event_id: crypto.randomUUID(),
      workflow_run_id: event.runId,
      event_type: event.eventType,
      phase: event.phase ?? '',
      payload: event.payload ?? {},
      source_type: 'kai-desktop',
    };

    this.post('/v1/workflows/events', body, this.timeoutMs).catch(() => {});
  }

  /** Fetch open recommendations for a workflow run. */
  async fetchRecommendations(runId: string, limit = 10): Promise<Recommendation[]> {
    if (!this.available) return [];

    try {
      const result = await this.get(
        `/v1/workflows/runs/${runId}/recommendations?status=open&limit=${limit}`,
        this.timeoutMs,
      );
      if (!result || !Array.isArray(result)) return [];
      return result as Recommendation[];
    } catch {
      return [];
    }
  }

  /** Dismiss a recommendation. */
  async dismissRecommendation(_runId: string, recommendationId: string): Promise<void> {
    if (!this.available) return;

    this.post(
      `/v1/workflows/recommendations/${recommendationId}/dismiss`,
      {},
      this.timeoutMs,
    ).catch(() => {});
  }

  /** Search for proven procedural skills (via context compile with procedural scope). */
  async skillSearch(query: string, topK = 5): Promise<SkillSearchResult[]> {
    if (!this.available) return [];

    try {
      const result = await this.post('/v1/context/compile', {
        query,
        source_type: 'kai-desktop',
        include: { memory: false, rag: false, procedural: true, entities: false, profile: false },
        token_budget: 4000,
        min_confidence: 0.5,
        top_k: topK,
      }, this.timeoutMs) as ContextPacket | null;

      if (!result || !result.procedural_hints?.length) return [];
      return result.procedural_hints.map((h) => ({
        id: h.id,
        title: h.title,
        confidence_score: h.confidence_score,
        trust_tier: h.trust_tier,
      }));
    } catch {
      return [];
    }
  }

  /** Report outcome after following a skill. */
  async skillFeedback(skillId: string, outcome: 'success' | 'failure', context?: string, latencyMs?: number): Promise<void> {
    if (!this.available) return;

    this.post(`/v1/memory/procedural/${skillId}/feedback`, {
      outcome,
      context: context ?? null,
      latency_ms: latencyMs ?? null,
      source_type: 'kai-desktop',
    }, this.timeoutMs).catch(() => {});
  }

  /** Whether the adapter considers Aithena reachable. */
  get isAvailable(): boolean {
    return this.available;
  }

  // ── HTTP helpers ─────────────────────────────────────────────────

  private async get(path: string, timeoutMs: number): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await net.fetch(`${this.baseUrl}${path}`, {
        method: 'GET',
        headers: this.headers(),
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
      }
      return await res.json();
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error(`Timeout after ${timeoutMs}ms`);
      }
      throw err;
    }
  }

  private async post(path: string, body: unknown, timeoutMs: number): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await net.fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
      }
      return await res.json();
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error(`Timeout after ${timeoutMs}ms`);
      }
      throw err;
    }
  }

  private async patch(path: string, body: unknown, timeoutMs: number): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await net.fetch(`${this.baseUrl}${path}`, {
        method: 'PATCH',
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
      }
      return await res.json();
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error(`Timeout after ${timeoutMs}ms`);
      }
      throw err;
    }
  }

  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'Authorization': `Aithena-Key ${this.apiKey}`,
    };
  }
}

// ── Singleton management ───────────────────────────────────────────

let sharedAdapter: AithenaMemoryAdapter | null = null;

export function getAithenaAdapter(config: AppConfig): AithenaMemoryAdapter | null {
  const aithenaConfig = (config as unknown as { aithena?: AithenaConfig }).aithena;
  if (!aithenaConfig?.enabled || !aithenaConfig.gatewayUrl || !aithenaConfig.apiKey) {
    sharedAdapter = null;
    return null;
  }

  // Recreate if config changed
  if (
    sharedAdapter &&
    (sharedAdapter as unknown as { baseUrl: string }).baseUrl !== aithenaConfig.gatewayUrl.replace(/\/+$/, '')
  ) {
    sharedAdapter = null;
  }

  if (!sharedAdapter) {
    sharedAdapter = new AithenaMemoryAdapter(aithenaConfig);
  }

  return sharedAdapter;
}

export function resetAithenaAdapter(): void {
  sharedAdapter = null;
}
