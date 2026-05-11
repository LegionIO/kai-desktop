/**
 * Cross-runtime conversation handoff.
 *
 * When a user switches runtimes mid-conversation (e.g. Claude Code SDK → Codex),
 * the new runtime has no knowledge of prior turns. This module:
 *
 *   1. Detects runtime switches by comparing the current runtime against the
 *      `messageMeta.runtimeId` stored on prior assistant messages.
 *   2. Generates context to inject — either a raw transcript (short conversations)
 *      or an LLM-generated summary (long conversations) via Mastra.
 *
 * The generated context is injected into the system prompt (Claude/Mastra) or
 * prepended to the user prompt (Codex) so the new runtime can continue
 * the conversation seamlessly.
 */

import { estimateToolTokens } from './compaction.js';
import { createLanguageModelFromConfig } from './language-model.js';
import type { LLMModelConfig } from './model-catalog.js';
import { RUNTIME_LABELS } from './runtime/types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default token threshold: below this, inject raw transcript; above, summarize. */
const DEFAULT_TOKEN_THRESHOLD = 4000;

const HANDOFF_SUMMARY_PROMPT = [
  'You are summarizing a conversation that will be continued by a different AI assistant.',
  'Preserve all key context: facts, decisions, constraints, user preferences, unresolved questions, code snippets, file paths, and identifiers.',
  'Be concise but comprehensive — the new assistant has no other context.',
  'Do not invent details. Return plain text only.',
].join(' ');

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/**
 * Detect whether the current stream represents a runtime switch.
 *
 * Walks backwards through the message array to find the most recent assistant
 * message with a `messageMeta.runtimeId`. Compares it against the current
 * runtime ID.
 *
 * @returns The previous runtime ID if a switch occurred, null otherwise.
 */
export function detectRuntimeSwitch(
  messages: unknown[],
  currentRuntimeId: string,
): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as {
      role?: string;
      messageMeta?: Record<string, unknown>;
    } | undefined;

    if (!msg || msg.role !== 'assistant') continue;

    const priorRuntimeId = msg.messageMeta?.runtimeId as string | undefined;
    if (!priorRuntimeId) continue;

    // Found the most recent assistant message with a runtime ID
    if (priorRuntimeId === currentRuntimeId) {
      return null; // Same runtime — no switch
    }
    return priorRuntimeId;
  }

  // No prior assistant messages with runtimeId — first message or legacy history
  return null;
}

// ---------------------------------------------------------------------------
// Context generation
// ---------------------------------------------------------------------------

export type HandoffOptions = {
  abortSignal?: AbortSignal;
  /** Token threshold for raw transcript vs. summarization (default: 4000). */
  tokenThreshold?: number;
};

/**
 * Generate context to inject when switching runtimes.
 *
 * - Short history (< tokenThreshold): formats messages as a readable transcript
 * - Long history (>= tokenThreshold): calls Mastra summarizer for a condensed summary
 *
 * @returns Formatted context string wrapped in XML tags, or null if no history.
 */
export async function generateHandoffContext(
  messages: unknown[],
  modelConfig: LLMModelConfig,
  options?: HandoffOptions,
): Promise<string | null> {
  const threshold = options?.tokenThreshold ?? DEFAULT_TOKEN_THRESHOLD;

  // Build transcript from all messages except the last user message
  // (that's the new prompt — don't duplicate it in the context)
  const transcript = buildTranscript(messages);
  if (!transcript) return null;

  // Find the prior runtime name for the context header
  const priorRuntimeId = findPriorRuntimeId(messages);
  const priorRuntimeLabel = priorRuntimeId
    ? (RUNTIME_LABELS[priorRuntimeId as keyof typeof RUNTIME_LABELS] ?? priorRuntimeId)
    : 'a previous runtime';

  // Estimate token count
  const tokenCount = estimateToolTokens(transcript, modelConfig.modelName);

  let contextBody: string;

  if (tokenCount < threshold) {
    // Short conversation — inject raw transcript
    contextBody = transcript;
  } else {
    // Long conversation — summarize via Mastra
    if (options?.abortSignal?.aborted) return null;

    const summary = await summarizeTranscript(transcript, modelConfig, options?.abortSignal);
    if (!summary) return null;
    if (options?.abortSignal?.aborted) return null;

    contextBody = summary;
  }

  return [
    '<prior-conversation-context>',
    `The following is the context from the prior conversation conducted with ${priorRuntimeLabel}.`,
    'Continue this conversation seamlessly — the user expects you to remember everything discussed.',
    '',
    contextBody,
    '</prior-conversation-context>',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Find the runtimeId from the most recent assistant message.
 */
function findPriorRuntimeId(messages: unknown[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as {
      role?: string;
      messageMeta?: Record<string, unknown>;
    } | undefined;
    if (msg?.role === 'assistant' && msg.messageMeta?.runtimeId) {
      return msg.messageMeta.runtimeId as string;
    }
  }
  return null;
}

/**
 * Build a human-readable transcript from the message history.
 * Excludes the last user message (which is the new prompt).
 */
function buildTranscript(messages: unknown[]): string | null {
  // Find the index of the last user message (the new prompt to exclude)
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as { role?: string } | undefined;
    if (msg?.role === 'user') {
      lastUserIdx = i;
      break;
    }
  }

  const lines: string[] = [];

  for (let i = 0; i < messages.length; i++) {
    if (i === lastUserIdx) continue; // Skip the new prompt

    const msg = messages[i] as {
      role?: string;
      content?: unknown;
    } | undefined;
    if (!msg?.role) continue;

    const text = extractTextContent(msg.content);
    if (!text) continue;

    const label = msg.role === 'user' ? 'User'
      : msg.role === 'assistant' ? 'Assistant'
      : null;

    if (label) {
      lines.push(`${label}: ${text}`);
    }
  }

  if (lines.length === 0) return null;
  return lines.join('\n\n');
}

/**
 * Extract plain text from a message content field.
 * Handles both string content and content arrays.
 */
function extractTextContent(content: unknown): string | null {
  if (typeof content === 'string') return content.trim() || null;

  if (Array.isArray(content)) {
    const textParts: string[] = [];
    for (const part of content) {
      if (!part || typeof part !== 'object') continue;
      const typed = part as { type?: string; text?: string };
      if (typed.type === 'text' && typed.text) {
        textParts.push(typed.text);
      }
    }
    const joined = textParts.join('\n').trim();
    return joined || null;
  }

  return null;
}

/**
 * Summarize a transcript using Mastra's Agent (always available).
 */
async function summarizeTranscript(
  transcript: string,
  modelConfig: LLMModelConfig,
  abortSignal?: AbortSignal,
): Promise<string | null> {
  try {
    const { Agent } = await import('@mastra/core/agent');
    const model = await createLanguageModelFromConfig(modelConfig);

    type AgentConfig = ConstructorParameters<typeof Agent>[0];
    const agent = new Agent({
      id: `handoff-summary-${Date.now()}`,
      name: 'handoff-summarizer',
      instructions: HANDOFF_SUMMARY_PROMPT,
      model: model as AgentConfig['model'],
    });

    const prompt = [
      'Summarize the following conversation for seamless continuation by a new assistant.',
      'Keep all key context: facts, decisions, requirements, code, file paths, and unresolved items.',
      '',
      'Conversation:',
      transcript,
    ].join('\n');

    const result = await agent.generate(prompt, {
      maxSteps: 1,
      ...(abortSignal ? { abortSignal } : {}),
    });

    const summaryText = typeof result.text === 'string' ? result.text.trim() : null;
    return summaryText || null;
  } catch (err) {
    console.warn('[runtime-handoff] Summarization failed:', err);
    return null;
  }
}
