/**
 * Aithena Lifecycle Hooks — wires cognitive memory into the conversation stream.
 *
 * Two hook points:
 *   1. enrichWithAithenaContext() — called BEFORE streaming starts, appends recalled
 *      memories and procedural hints to the system prompt.
 *   2. learnFromTurn() — called AFTER streaming completes (fire-and-forget),
 *      sends the full exchange to Aithena's LLM pipeline for episodic storage,
 *      semantic extraction, procedural detection, and identity observation.
 */

import type { AppConfig } from '../config/schema.js';
import { getAithenaAdapter, type ContextPacket } from './aithena-memory.js';

// ── Context Enrichment ────────────────────────────────────────────────

/**
 * Compile Aithena context and append to system prompt.
 * Returns the (possibly enriched) system prompt.
 * Graceful: returns original prompt on any failure.
 */
export async function enrichWithAithenaContext(
  config: AppConfig,
  messages: unknown[],
  systemPrompt: string,
  conversationId: string,
): Promise<{ systemPrompt: string }> {
  const adapter = getAithenaAdapter(config);
  if (!adapter) return { systemPrompt };

  const userQuery = extractLastUserMessage(messages);
  if (!userQuery) return { systemPrompt };

  try {
    const start = Date.now();
    const packet: ContextPacket | null = await adapter.compileContext(userQuery, {
      tokenBudget: 4000,
      includeRag: true,
      includeProcedural: true,
      sessionId: conversationId,
    });

    if (!packet || packet.token_count === 0) return { systemPrompt };

    const block = formatContextBlock(packet);
    const elapsed = Date.now() - start;
    console.info(
      `[Aithena:enrich] conv=${conversationId} memories=${packet.memories.length} rag=${packet.rag_results.length} hints=${packet.procedural_hints.length} tokens=${packet.token_count} ms=${elapsed}`,
    );

    return { systemPrompt: `${systemPrompt}\n\n${block}` };
  } catch (err) {
    console.warn('[Aithena:enrich] Failed, proceeding without context:', err instanceof Error ? err.message : err);
    return { systemPrompt };
  }
}

// ── Learning ──────────────────────────────────────────────────────────

/**
 * Send a completed conversation turn to Aithena for learning.
 * Fire-and-forget — never blocks, never throws.
 *
 * Aithena's server-side LLM pipeline handles:
 * - Episodic memory storage (interaction record)
 * - Semantic extraction (durable facts, preferences, decisions)
 * - Procedural detection (step-by-step workflows)
 * - Identity observation (user preferences, workspace patterns)
 */
export function learnFromTurn(
  config: AppConfig,
  userMessage: string,
  assistantResponse: string,
  conversationId: string,
): void {
  const adapter = getAithenaAdapter(config);
  if (!adapter) return;

  console.info(
    `[Aithena:learn] conv=${conversationId} userLen=${userMessage.length} assistantLen=${assistantResponse.length}`,
  );

  adapter.learn({
    userMessage,
    assistantResponse,
    conversationId,
  });
}

// ── Helpers ───────────────────────────────────────────────────────────

/**
 * Extract the last user message text from the messages array.
 * Handles both string content and multipart content arrays.
 */
export function extractLastUserMessage(messages: unknown[]): string | null {
  const msgs = messages as Array<{ role?: string; content?: unknown }>;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === 'user') {
      const content = msgs[i].content;
      if (typeof content === 'string') return content;
      if (Array.isArray(content)) {
        const text = content
          .filter((p: { type?: string }) => p.type === 'text')
          .map((p: { text?: string }) => p.text ?? '')
          .join('\n');
        return text || null;
      }
    }
  }
  return null;
}

/**
 * Format a ContextPacket into a structured block for system prompt injection.
 */
function formatContextBlock(packet: ContextPacket): string {
  const lines: string[] = [];

  lines.push(
    `<aithena_context source="aithena-memory" compiled_at="${packet.compiled_at}" token_count="${packet.token_count}">`,
  );
  lines.push('The following context was retrieved from your cognitive memory and knowledge base. Use this information to inform your responses — treat it as authoritative when relevant to the user\'s query.');
  lines.push('');

  if (packet.memories.length > 0) {
    lines.push('## Recalled Context');
    for (const m of packet.memories) {
      lines.push(`- [${m.memory_type}] ${m.content.slice(0, 300)}`);
    }
  }

  if (packet.rag_results.length > 0) {
    lines.push('');
    lines.push('## Knowledge Base (Retrieved Documents)');
    lines.push('These are relevant passages from ingested documentation, runbooks, and design docs. Cite or reference them when answering related questions.');
    for (const r of packet.rag_results) {
      const source = r.source_url ? ` (source: ${r.source_url})` : '';
      lines.push(`- **${r.title}**${source}: ${r.content.slice(0, 500)}`);
    }
  }

  if (packet.procedural_hints.length > 0) {
    lines.push('');
    lines.push('## Procedural Hints (Proven Workflows)');
    lines.push('These are previously successful workflows. Follow them when the user\'s intent matches.');
    for (const h of packet.procedural_hints) {
      lines.push(`- ${h.title} (confidence: ${h.confidence_score.toFixed(2)}, trust: ${h.trust_tier})`);
    }
  }

  lines.push('</aithena_context>');
  return lines.join('\n');
}
