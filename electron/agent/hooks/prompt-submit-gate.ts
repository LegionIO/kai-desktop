/**
 * Shared UserPromptSubmit DLP gate for any path that sends message content to a
 * model OUTSIDE the normal turn — title generation, on-demand /compact
 * summarization, etc. Sending transcript content to a model must pass the same
 * block/modify enforcement a normal turn does. Extracted here (rather than in
 * ipc/agent.ts) so both ipc/agent.ts and ipc/conversations.ts can import it
 * without a circular dependency.
 */
import type { AppConfig } from '../../config/schema.js';
import { hookDispatcher } from './dispatcher.js';

/**
 * Run `messages` through the UserPromptSubmit enforcement hooks. Returns the
 * (possibly hook-modified) messages, or `suppressed: true` when a hook denies —
 * callers must then NOT proceed with the messages. Fails CLOSED (suppressed) on
 * a hook error. A no-op (returns the input) when no enforcing hooks exist.
 */
export async function gateMessagesThroughUserPromptSubmit(
  messages: unknown[],
  config: AppConfig,
  conversationId: string,
  modelKey?: string,
  purpose: string = 'title-generation',
  systemPrompt: string = '',
): Promise<{ suppressed: boolean; messages: unknown[]; systemPrompt?: string }> {
  if (!hookDispatcher.hasEnforcingHooksFor('UserPromptSubmit')) {
    return { suppressed: false, messages };
  }
  try {
    const dispatch = await hookDispatcher.dispatch(
      'UserPromptSubmit',
      {
        conversationId,
        messages,
        // Pass the ACTUAL system prompt this request will send — a system-prompt-
        // conditioned DLP hook must see the same prompt a normal turn shows it, or
        // it can behave differently (e.g. skip a sanitization it would apply on the
        // real turn). Empty only when the caller genuinely has no prompt.
        systemPrompt,
        modelKey: modelKey ?? config.models.defaultModelKey,
        purpose,
      },
      { suppressObserve: true },
    );
    if (dispatch.denied) return { suppressed: true, messages };
    const next = dispatch.payload as { messages?: unknown[]; systemPrompt?: string };
    return {
      suppressed: false,
      messages: Array.isArray(next?.messages) ? next.messages : messages,
      systemPrompt: typeof next?.systemPrompt === 'string' ? next.systemPrompt : undefined,
    };
  } catch {
    return { suppressed: true, messages };
  }
}
