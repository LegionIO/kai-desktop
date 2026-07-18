/**
 * Sub-Agent Tool
 *
 * Allows the parent agent to spawn a child agent that has access to the same tools
 * (including recursive sub-agents up to the configured depth limit).
 * Sub-agent conversations can be resumed after completion.
 */

import { z } from 'zod';
import { join } from 'path';
import { BrowserWindow } from 'electron';
import { broadcastToWebClients } from '../web-server/web-clients.js';
import {
  runSubAgent,
  getActiveSubAgentCount,
  buildSubAgentTaskMessage,
  sanitizedMessageDisplayText,
} from '../agent/sub-agent-runner.js';
import type { SubAgentEvent } from '../agent/sub-agent-runner.js';
import { streamAgentResponse, streamWithFallback, getProviderDefinedToolNames } from '../agent/mastra-agent.js';
import { hookDispatcher } from '../agent/hooks/dispatcher.js';
import type { LLMModelConfig, ResolvedStreamConfig } from '../agent/model-catalog.js';
import { resolveModelForThread, resolveStreamConfig } from '../agent/model-catalog.js';
import type { AppConfig } from '../config/schema.js';
import type { ToolDefinition, ToolExecutionContext } from './types.js';
import { getSharedMemory } from '../agent/memory.js';
import { updateSubagentStatus } from '../agent/subagent-status.js';

/** Follow-up message queues keyed by subAgentConversationId */
const followUpQueues = new Map<string, string[]>();
/** Active sub-agent abort controllers keyed by subAgentConversationId */
const activeSubAgentControllers = new Map<string, AbortController>();
/** Map parent toolCallId → subAgentConversationId for observer lookups */
const toolCallToSubAgent = new Map<string, string>();
/** Parent conversation id per ACTIVE sub-agent — used to enforce maxPerParent. */
const activeSubAgentParents = new Map<string, string>();
/** Persisted sub-agent conversation state for resumption */
const subAgentState = new Map<
  string,
  {
    messages: Array<{ role: string; content: unknown }>;
    config: AppConfig;
    modelConfig: LLMModelConfig;
    streamConfig?: ResolvedStreamConfig;
    profileKey?: string | null;
    modelKey?: string | null;
    tools: ToolDefinition[];
    dbPath: string;
    parentConversationId: string;
    parentToolCallId: string;
    depth: number;
    task: string;
  }
>();

function broadcastEvent(event: SubAgentEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('agent:stream-event', event);
  }
  broadcastToWebClients('agent:stream-event', event);
}

/** Send a follow-up to a sub-agent by its parent toolCallId (for observer use) */
export function sendSubAgentFollowUpByToolCall(toolCallId: string, message: string): boolean {
  const saId = toolCallToSubAgent.get(toolCallId);
  if (!saId) return false;
  return sendSubAgentFollowUp(saId, message);
}

/** Send a follow-up message to a sub-agent (running or completed) */
export function sendSubAgentFollowUp(subAgentConversationId: string, message: string): boolean {
  // If running, push to queue
  const queue = followUpQueues.get(subAgentConversationId);
  if (queue) {
    queue.push(message);
    return true;
  }

  // If completed but state exists, resume the conversation
  const state = subAgentState.get(subAgentConversationId);
  if (state) {
    resumeSubAgent(subAgentConversationId, message, state);
    return true;
  }

  return false;
}

/** Resume a completed sub-agent with a new message */
async function resumeSubAgent(
  subAgentConversationId: string,
  message: string,
  state: NonNullable<ReturnType<typeof subAgentState.get>>,
): Promise<void> {
  const {
    messages,
    config,
    modelConfig,
    streamConfig,
    profileKey,
    modelKey,
    tools,
    dbPath,
    parentConversationId,
    parentToolCallId,
  } = state;

  // Add the resume message, but DON'T broadcast it yet — gate it through
  // UserPromptSubmit first so a DLP block/modify hook can redact/deny before the
  // raw message reaches renderer/web clients. Snapshot the prior history so a
  // denial can roll the raw message back out of the persisted state.
  const messagesBeforeResume = [...messages];
  messages.push({ role: 'user', content: message });

  const localController = new AbortController();
  activeSubAgentControllers.set(subAgentConversationId, localController);
  followUpQueues.set(subAgentConversationId, []);

  try {
    // Gate the resumed sub-agent prompt through UserPromptSubmit (before any
    // broadcast). Enforcement-only (suppressObserve) so a resume doesn't re-fire
    // the parent's UserPromptSubmit automations.
    let resumeSystemPrompt = config.systemPrompts?.chat?.trim() || config.systemPrompt;
    if (hookDispatcher.hasEnforcingHooksFor('UserPromptSubmit')) {
      const gate = await hookDispatcher.dispatch(
        'UserPromptSubmit',
        {
          conversationId: subAgentConversationId,
          parentConversationId,
          messages,
          systemPrompt: resumeSystemPrompt,
          modelKey: modelConfig.modelName,
          purpose: 'sub-agent-resume',
        },
        { suppressObserve: true },
      );
      if (gate.denied) {
        // Roll the raw denied message back out of the shared/persisted history so
        // a later resume can't replay it.
        messages.length = 0;
        messages.push(...messagesBeforeResume);
        broadcastEvent({
          subAgentConversationId,
          parentConversationId,
          parentToolCallId,
          type: 'sub-agent-status',
          status: 'failed',
          summary: gate.reason ?? 'Blocked by a UserPromptSubmit hook.',
        } as SubAgentEvent);
        activeSubAgentControllers.delete(subAgentConversationId);
        followUpQueues.delete(subAgentConversationId);
        return;
      }
      const gated = gate.payload as { messages?: unknown[]; systemPrompt?: string };
      if (Array.isArray(gated?.messages)) {
        messages.length = 0;
        messages.push(...(gated.messages as Array<{ role: string; content: unknown }>));
      }
      if (typeof gated?.systemPrompt === 'string') resumeSystemPrompt = gated.systemPrompt;
    }

    // Now broadcast the (possibly sanitized) resume message + running status.
    // Derive from the gated last message (never the raw `message`), covering
    // content-part arrays; empty when the hook removed/redacted all text.
    const gatedResumeText = sanitizedMessageDisplayText(messages[messages.length - 1]?.content);
    broadcastEvent({
      subAgentConversationId,
      parentConversationId,
      parentToolCallId,
      conversationId: subAgentConversationId,
      type: 'sub-agent-user-message',
      text: gatedResumeText,
      source: 'user',
    });
    broadcastEvent({
      subAgentConversationId,
      parentConversationId,
      parentToolCallId,
      type: 'sub-agent-status',
      status: 'running',
      summary: 'Resuming conversation',
    });

    const enforcingHooks = hookDispatcher.hasEnforcingToolHooks();
    // Provider-native tools execute in-provider; never suppress their args.
    const providerToolNames = getProviderDefinedToolNames(modelConfig);
    const rewrittenArgs = new Map<string, unknown>();
    // Stream-first queue: suppressed stream ids awaiting resolution, per tool
    // name. onToolExecutionStart rebroadcasts under the queued stream id (which
    // may differ from its exec id) instead of the exec id.
    const suppressedStreamIdsByTool = new Map<string, string[]>();
    // Exec-first queue: onToolExecutionStart resolved args BEFORE the stream
    // tool-call event arrived AND its exec id differs from the stream id. Park
    // the resolved args by toolName (FIFO); the stream loop claims one before
    // suppressing to {pending}, so the card is never left permanently hidden.
    const resolvedArgsByTool = new Map<string, unknown[]>();

    const resumeStreamOpts = {
      abortSignal: localController.signal,
      parentProfileKey: profileKey ?? null,
      parentModelKey: modelKey ?? null,
      emitEvent: (event) => {
        broadcastEvent({ ...event, subAgentConversationId, parentConversationId, parentToolCallId } as SubAgentEvent);
      },
      // Enforce lifecycle hooks on resume, same as the initial sub-agent run.
      onToolExecutionStart: async (state) => {
        const rebroadcast = (resolved: unknown): void => {
          rewrittenArgs.set(state.toolCallId, resolved);
          // Prefer a suppressed stream id already rendered under {pending}
          // (stream-first) whose id differs from this exec id — correct it.
          // Exec-first with a same/not-yet-seen id is handled when the stream
          // event finds the value by id (no per-tool stash that could leak
          // onto the next same-named call).
          const streamQ = suppressedStreamIdsByTool.get(state.toolName);
          const streamId = streamQ && streamQ.length > 0 ? streamQ.shift() : undefined;
          if (streamId) {
            // Stream-first: a card was already rendered under `streamId` as
            // {pending}. Correct it in place. Alias the extra key only when the
            // ids differ. Broadcast even when streamId === exec id, since the
            // renderer will not re-emit that card on its own.
            if (streamId !== state.toolCallId) rewrittenArgs.set(streamId, resolved);
            if (enforcingHooks) {
              broadcastEvent({
                type: 'tool-call',
                toolCallId: streamId,
                toolName: state.toolName,
                args: resolved,
                subAgentConversationId,
                parentConversationId,
                parentToolCallId,
              } as SubAgentEvent);
            }
          } else if (enforcingHooks) {
            // Exec-first: the stream event hasn't arrived yet. Do NOT broadcast
            // a card under the exec id here — the stream event will render it.
            // If it uses the SAME id it finds `resolved` via rewrittenArgs by
            // id; if it uses a DIFFERENT id it claims the parked args below.
            // Broadcasting now would duplicate the card (renderer upserts by id).
            const q = resolvedArgsByTool.get(state.toolName) ?? [];
            q.push(resolved);
            resolvedArgsByTool.set(state.toolName, q);
          }
        };
        const preTool = await hookDispatcher.dispatch('PreToolUse', {
          conversationId: subAgentConversationId,
          parentConversationId,
          toolCallId: state.toolCallId,
          toolName: state.toolName,
          args: state.args,
        });
        if (preTool.denied) {
          const reason = preTool.reason ?? 'Blocked by PreToolUse hook.';
          rebroadcast({ redacted: true, reason });
          return { skip: true as const, result: { isError: true, error: reason } };
        }
        const nextArgs = (preTool.payload as { args?: unknown } | undefined)?.args;
        if (nextArgs !== undefined && nextArgs !== state.args) {
          const canMutateInPlace =
            state.args &&
            typeof state.args === 'object' &&
            !Array.isArray(state.args) &&
            nextArgs &&
            typeof nextArgs === 'object' &&
            !Array.isArray(nextArgs);
          if (canMutateInPlace) {
            const target = state.args as Record<string, unknown>;
            for (const k of Object.keys(target)) delete target[k];
            Object.assign(target, nextArgs as Record<string, unknown>);
          } else {
            // Non-object modify replacement can't be applied to by-reference
            // args — fail closed rather than run with unsanitized input.
            const reason =
              'PreToolUse modify hook returned args that cannot be applied to this tool (non-object replacement); failing closed.';
            rebroadcast({ redacted: true, reason });
            return { skip: true as const, result: { isError: true, error: reason } };
          }
        }
        rebroadcast(state.args);
      },
      augmentToolResult: async ({ toolCallId, toolName, args, result }) => {
        // Use redacted args (if PreToolUse rewrote/denied) so PostToolUse
        // never sees the raw denied args.
        const postArgs = rewrittenArgs.get(toolCallId) ?? args;
        const postTool = await hookDispatcher.dispatch('PostToolUse', {
          conversationId: subAgentConversationId,
          parentConversationId,
          toolCallId,
          toolName,
          args: postArgs,
          result,
        });
        if (postTool.denied) return { isError: true, error: postTool.reason ?? 'Blocked by PostToolUse hook.' };
        const nextResult = (postTool.payload as { result?: unknown } | undefined)?.result;
        return nextResult !== undefined ? nextResult : result;
      },
    } satisfies Parameters<typeof streamAgentResponse>[6];

    const resumeConfig = { ...config, systemPrompt: resumeSystemPrompt };
    const stream =
      streamConfig && streamConfig.fallbackEnabled && streamConfig.fallbackModels.length > 0
        ? streamWithFallback(
            subAgentConversationId,
            messages,
            streamConfig,
            resumeConfig,
            tools,
            dbPath,
            resumeStreamOpts,
          )
        : streamAgentResponse(
            subAgentConversationId,
            messages,
            modelConfig,
            resumeConfig,
            tools,
            dbPath,
            resumeStreamOpts,
          );

    let turnText = '';
    for await (const event of stream) {
      if (event.type === 'text-delta' && event.text) turnText += event.text;
      const enriched = { ...event, subAgentConversationId, parentConversationId, parentToolCallId } as SubAgentEvent;
      // Suppress raw tool-call args until the hook resolves; publish rewritten
      // args once known (renderer upserts by toolCallId).
      if (event.type === 'tool-call' && event.toolCallId) {
        const rewritten = rewrittenArgs.get(event.toolCallId);
        if (rewritten !== undefined) {
          (enriched as Record<string, unknown>).args = rewritten;
          // Exec-first + SAME id: rebroadcast recorded args by id AND parked a
          // copy by toolName speculatively. We resolved by id, so drain that
          // parked entry, else it leaks onto the next same-named call.
          const pq = event.toolName ? resolvedArgsByTool.get(event.toolName) : undefined;
          if (pq && pq.length > 0) pq.shift();
        } else if (enforcingHooks && !(event.toolName && providerToolNames.has(event.toolName))) {
          // Exec-first with a mismatched id: claim a parked resolution instead
          // of suppressing, so the card is never stuck {pending}.
          const parkedQ = event.toolName ? resolvedArgsByTool.get(event.toolName) : undefined;
          const parked = parkedQ && parkedQ.length > 0 ? parkedQ.shift() : undefined;
          if (parked !== undefined) {
            (enriched as Record<string, unknown>).args = parked;
            rewrittenArgs.set(event.toolCallId, parked);
          } else {
            (enriched as Record<string, unknown>).args = { pending: true };
            (enriched as Record<string, unknown>).argsPending = true;
            // Record this suppressed stream id so onToolExecutionStart corrects
            // it under the id the renderer actually rendered (stream-first).
            if (event.toolName) {
              const q = suppressedStreamIdsByTool.get(event.toolName) ?? [];
              q.push(event.toolCallId);
              suppressedStreamIdsByTool.set(event.toolName, q);
            }
          }
        }
      }
      if (event.type !== 'done') {
        broadcastEvent(enriched);
      }
      if (event.type === 'done') break;
    }

    if (turnText) {
      messages.push({ role: 'assistant', content: turnText });
    }

    // Check for immediate follow-up
    const queue = followUpQueues.get(subAgentConversationId);
    if (queue && queue.length > 0) {
      const nextMsg = queue.shift()!;
      followUpQueues.delete(subAgentConversationId);
      activeSubAgentControllers.delete(subAgentConversationId);
      await resumeSubAgent(subAgentConversationId, nextMsg, state);
      return;
    }

    broadcastEvent({
      subAgentConversationId,
      parentConversationId,
      parentToolCallId,
      type: 'sub-agent-status',
      status: 'completed',
      summary: 'Response complete',
    });

    // Emit done so the UI finalizes
    broadcastEvent({
      subAgentConversationId,
      parentConversationId,
      parentToolCallId,
      conversationId: subAgentConversationId,
      type: 'done',
    });
  } catch (error) {
    broadcastEvent({
      subAgentConversationId,
      parentConversationId,
      parentToolCallId,
      conversationId: subAgentConversationId,
      type: 'error',
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    followUpQueues.delete(subAgentConversationId);
    activeSubAgentControllers.delete(subAgentConversationId);
  }
}

/** Stop a running sub-agent */
export function stopSubAgent(subAgentConversationId: string): boolean {
  const controller = activeSubAgentControllers.get(subAgentConversationId);
  if (!controller) return false;
  controller.abort();
  return true;
}

/** Get all active sub-agent conversation IDs */
export function getActiveSubAgentIds(): string[] {
  return Array.from(activeSubAgentControllers.keys());
}

/**
 * Decide which profile/model a sub-agent runs under, given the tool call's
 * explicit `profile`/`model` and the parent turn's inherited keys. Precedence:
 *   1. explicit `profile`      → that profile (may be '__none__' to force none)
 *   2. explicit `model`        → single model, no profile ('__none__')
 *   3. inherit parent profile  → parentProfileKey
 *   4. inherit parent model    → parentModelKey
 *   5. subAgents.defaultModel / global default (single model)
 * Returns keys shaped for `resolveStreamConfig` (threadProfileKey '__none__'
 * skips profiles; threadModelKey pins a single model). Exported for tests.
 */
export function resolveSubAgentModelSelection(input: {
  profile?: string;
  model?: string;
  parentProfileKey: string | null;
  parentModelKey: string | null;
  defaultModel: string | null;
}): { threadProfileKey: string | null; threadModelKey: string | null } {
  const { profile, model, parentProfileKey, parentModelKey, defaultModel } = input;
  if (profile !== undefined) {
    return { threadProfileKey: profile, threadModelKey: null };
  }
  if (model !== undefined) {
    return { threadProfileKey: '__none__', threadModelKey: model };
  }
  if (parentProfileKey != null && parentProfileKey !== '' && parentProfileKey !== '__none__') {
    return { threadProfileKey: parentProfileKey, threadModelKey: null };
  }
  return { threadProfileKey: '__none__', threadModelKey: parentModelKey ?? defaultModel };
}

export function createSubAgentTool(
  getConfig: () => AppConfig,
  appHome: string,
  currentDepth: number,
  parentTools?: ToolDefinition[],
): ToolDefinition {
  return {
    name: 'sub_agent',
    description: [
      'Spawn a sub-agent to handle a task autonomously. The sub-agent has access to all the same tools',
      '(shell, file operations, search, etc.) and can work independently on the assigned task.',
      'Use this when you want to delegate a self-contained task that can run in parallel or needs focused attention.',
      'The sub-agent will return its complete response when finished.',
      '',
      'You can send follow-up instructions to guide the sub-agent after it completes a turn.',
      `Current nesting depth: ${currentDepth}.`,
    ].join(' '),
    inputSchema: z.object({
      task: z
        .string()
        .describe('The task/instruction for the sub-agent. Be specific and clear about what you want accomplished.'),
      model: z
        .string()
        .optional()
        .describe(
          'Model key to pin a single model for the sub-agent (no fallback). Omit to inherit the current profile/model.',
        ),
      profile: z
        .string()
        .optional()
        .describe(
          'Profile key to run the sub-agent under (uses that profile\'s primary + fallback chain). Omit to inherit the current turn\'s profile; pass "__none__" to force a single model with no profile.',
        ),
      context: z
        .string()
        .optional()
        .describe('Additional context from the current conversation that the sub-agent needs.'),
    }),
    execute: async (input: unknown, ctx: ToolExecutionContext): Promise<unknown> => {
      const { task, model, profile, context } = input as {
        task: string;
        model?: string;
        profile?: string;
        context?: string;
      };
      const config = getConfig();
      const subAgentConfig = config.tools?.subAgents ?? {
        enabled: true,
        maxDepth: 3,
        maxConcurrent: 4,
        maxPerParent: 2,
      };

      const maxDepth = subAgentConfig.maxDepth ?? 3;
      if (currentDepth >= maxDepth) {
        return { isError: true, error: `Sub-agent depth limit reached (max: ${maxDepth}).` };
      }
      if (getActiveSubAgentCount() >= (subAgentConfig.maxConcurrent ?? 4)) {
        return {
          isError: true,
          error: `Maximum concurrent sub-agents (${subAgentConfig.maxConcurrent ?? 4}) reached.`,
        };
      }
      // Enforce the per-parent cap: how many sub-agents THIS conversation already
      // has running. Uses the synchronously-registered activeSubAgentParents map so
      // the check is race-free with the registration below (no await between).
      const maxPerParent = subAgentConfig.maxPerParent ?? 2;
      const parentId = ctx.conversationId;
      if (parentId) {
        let activeForParent = 0;
        for (const p of activeSubAgentParents.values()) {
          if (p === parentId) activeForParent += 1;
        }
        if (activeForParent >= maxPerParent) {
          return {
            isError: true,
            error: `Maximum sub-agents per parent (${maxPerParent}) reached.`,
          };
        }
      }

      // Resolve which profile/model the sub-agent runs under (see the helper).
      const { threadProfileKey, threadModelKey } = resolveSubAgentModelSelection({
        profile,
        model,
        parentProfileKey: ctx.parentProfileKey ?? null,
        parentModelKey: ctx.parentModelKey ?? null,
        defaultModel: subAgentConfig.defaultModel ?? null,
      });

      // Resolve the profile-aware chain. fallbackEnabled whenever a real profile
      // is active (not the '__none__' sentinel / single-model path).
      const profileActive = threadProfileKey !== null && threadProfileKey !== '__none__';
      const streamConfig: ResolvedStreamConfig | null = resolveStreamConfig(config, {
        threadModelKey,
        threadProfileKey,
        fallbackEnabled: profileActive,
      });

      // Primary model entry (for the single-model path + display/telemetry).
      const modelEntry = streamConfig?.primaryModel ?? resolveModelForThread(config, threadModelKey);
      if (!modelEntry) {
        return { isError: true, error: 'No model available for sub-agent.' };
      }

      const subAgentConversationId = `sub-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const dbPath = join(appHome, 'data', 'memory.db');

      followUpQueues.set(subAgentConversationId, []);
      const localController = new AbortController();
      activeSubAgentControllers.set(subAgentConversationId, localController);
      toolCallToSubAgent.set(ctx.toolCallId, subAgentConversationId);
      if (parentId) activeSubAgentParents.set(subAgentConversationId, parentId);

      if (ctx.abortSignal?.aborted) {
        cleanupRuntime(subAgentConversationId);
        return { isError: true, error: 'Parent operation was cancelled.' };
      }

      const parentAbortHandler = (): void => {
        localController.abort();
      };
      ctx.abortSignal?.addEventListener('abort', parentAbortHandler, { once: true });

      const baseTools = parentTools ?? [];
      const subAgentTools = baseTools
        .filter((t) => t.name !== 'sub_agent')
        .concat(
          currentDepth + 1 < maxDepth ? [createSubAgentTool(getConfig, appHome, currentDepth + 1, baseTools)] : [],
        );

      try {
        let fullResponse = '';
        let toolsUsed: string[] = [];
        // Set when the runner emits a terminal `failed` status (e.g. a
        // UserPromptSubmit hook denied the prompt). Turns the tool result into an
        // error so the parent agent doesn't treat a blocked sub-agent as success.
        let lastFailureSummary: string | null = null;

        // Don't echo the raw task here — a UserPromptSubmit DLP hook (run inside
        // runSubAgent) may redact/deny it. The sanitized task is broadcast by the
        // runner as a sub-agent-user-message after gating.
        ctx.onProgress?.({
          stream: 'stdout',
          delta: `[Sub-agent started]\n`,
          output: `[Sub-agent started]\n`,
          bytesSeen: 0,
          truncated: false,
          stopped: false,
          subAgentConversationId,
        });

        // Set initial status to 'running' and link to parent
        try {
          const memory = getSharedMemory(config, dbPath);
          if (memory) {
            await updateSubagentStatus(memory, subAgentConversationId, {
              status: 'running',
              parentThreadId: ctx.conversationId,
            });
          }
        } catch (err) {
          console.error('[Subagent] Failed to set initial status:', err);
        }

        // Captured from the runner's onFinalMessages so resume state persists
        // the GATED (sanitized) history, not a raw task/context reconstruction.
        let finalGatedMessages: Array<{ role: string; content: unknown }> | null = null;

        const stream = runSubAgent({
          subAgentConversationId,
          parentConversationId: ctx.toolCallId,
          parentToolCallId: ctx.toolCallId,
          task,
          context,
          depth: currentDepth + 1,
          config,
          modelConfig: modelEntry.modelConfig,
          ...(streamConfig ? { streamConfig } : {}),
          profileKey: threadProfileKey,
          modelKey: threadModelKey,
          tools: subAgentTools,
          dbPath,
          abortSignal: localController.signal,
          getFollowUp: async () => {
            const queue = followUpQueues.get(subAgentConversationId);
            if (!queue || queue.length === 0) return null;
            return queue.shift() ?? null;
          },
          onFinalMessages: (msgs) => {
            finalGatedMessages = msgs;
          },
        });

        for await (const event of stream) {
          if (event.type === 'text-delta' && 'text' in event && event.text) {
            fullResponse += event.text;
            ctx.onProgress?.({
              stream: 'stdout',
              delta: event.text,
              output: fullResponse.slice(-4000),
              bytesSeen: fullResponse.length,
              truncated: fullResponse.length > 4000,
              stopped: false,
              subAgentConversationId,
            });
          } else if (event.type === 'tool-call' && 'toolName' in event) {
            const toolName = event.toolName ?? 'unknown';
            if (!toolsUsed.includes(toolName) && toolName !== 'sub_agent_control') toolsUsed.push(toolName);
            ctx.onProgress?.({
              stream: 'stdout',
              delta: `[Sub-agent using tool: ${toolName}]\n`,
              output: `[Sub-agent using tool: ${toolName}]\n`,
              bytesSeen: fullResponse.length,
              truncated: false,
              stopped: false,
              subAgentConversationId,
            });
          } else if (event.type === 'sub-agent-status') {
            if (event.status === 'failed') {
              lastFailureSummary = event.summary ?? 'Sub-agent failed.';
            }
            ctx.onProgress?.({
              stream: 'stdout',
              delta: `[Status: ${event.status}] ${event.summary ?? ''}\n`,
              output: `[Status: ${event.status}] ${event.summary ?? ''}\n`,
              bytesSeen: fullResponse.length,
              truncated: false,
              stopped: false,
              subAgentConversationId,
            });
          }
        }

        // Persist state for resumption. Prefer the runner's GATED message
        // history (which reflects any UserPromptSubmit DLP redaction) so a later
        // resume never sends the raw original task/context to the model. Only
        // fall back to a reconstruction when the runner NEVER surfaced messages
        // (null) — an intentionally EMPTY gated history ([]) is a valid
        // redaction result and must NOT be replaced with the raw task/context.
        const gatedHistory = finalGatedMessages as Array<{ role: string; content: unknown }> | null;
        const persistedMessages: Array<{ role: string; content: unknown }> =
          gatedHistory !== null
            ? [...gatedHistory]
            : [{ role: 'user', content: buildSubAgentTaskMessage(task, context) }];
        // Ensure the final assistant response is captured. Only in the raw
        // FALLBACK path (gatedHistory === null) — a surfaced gated history (incl.
        // empty) already reflects what the runner accumulated + any redaction.
        const lastMsg = persistedMessages[persistedMessages.length - 1];
        if (fullResponse && !(lastMsg?.role === 'assistant' && lastMsg.content === fullResponse)) {
          if (gatedHistory === null) persistedMessages.push({ role: 'assistant', content: fullResponse });
        }

        // Don't create resumable state for a denied/failed/aborted run. A
        // UserPromptSubmit DLP denial returns from runSubAgent before it surfaces
        // gated messages, so the fallback would persist the RAW task/context and
        // a later resume (after the hook is disabled) could replay it. An aborted
        // run likewise has incomplete/ungated history. Only cleanly completed runs
        // become resumable.
        if (!lastFailureSummary && !localController.signal.aborted) {
          subAgentState.set(subAgentConversationId, {
            messages: persistedMessages,
            config,
            modelConfig: modelEntry.modelConfig,
            ...(streamConfig ? { streamConfig } : {}),
            profileKey: threadProfileKey,
            modelKey: threadModelKey,
            tools: subAgentTools,
            dbPath,
            parentConversationId: ctx.toolCallId,
            parentToolCallId: ctx.toolCallId,
            depth: currentDepth + 1,
            task,
          });
        }

        // Persist completion status to database
        try {
          const memory = getSharedMemory(config, dbPath);
          if (memory) {
            const finalStatus = localController.signal.aborted
              ? 'stopped'
              : lastFailureSummary
                ? 'failed'
                : 'completed';
            await updateSubagentStatus(memory, subAgentConversationId, {
              status: finalStatus,
              completedAt: new Date().toISOString(),
              exitReason: localController.signal.aborted
                ? 'user_aborted'
                : lastFailureSummary
                  ? lastFailureSummary.slice(0, 500)
                  : 'task_complete',
            });
          }
        } catch (err) {
          console.error('[Subagent] Failed to update completion status:', err);
        }

        // A terminal `failed` status (e.g. a UserPromptSubmit hook denied the
        // prompt) must surface to the parent as an error, not a completed run.
        if (lastFailureSummary && !localController.signal.aborted) {
          return {
            isError: true,
            subAgentConversationId,
            error: lastFailureSummary,
            response: fullResponse,
            toolsUsed,
            depth: currentDepth + 1,
            status: 'failed',
          };
        }

        // An aborted run returned partial/interrupted work — surface it as an
        // error so the parent agent doesn't treat a cancelled sub-agent as a
        // successful completion. (Any resumable state cached before the abort is
        // dropped in the finally block.)
        if (localController.signal.aborted) {
          return {
            isError: true,
            subAgentConversationId,
            error: 'Sub-agent was stopped before completing its task.',
            response: fullResponse,
            toolsUsed,
            depth: currentDepth + 1,
            status: 'stopped',
          };
        }

        return {
          subAgentConversationId,
          response: fullResponse,
          toolsUsed,
          depth: currentDepth + 1,
          status: 'completed',
        };
      } catch (error) {
        // Persist failure status to database
        try {
          const memory = getSharedMemory(config, dbPath);
          if (memory) {
            await updateSubagentStatus(memory, subAgentConversationId, {
              status: 'failed',
              completedAt: new Date().toISOString(),
              exitReason: (error instanceof Error ? error.message : String(error)).slice(0, 500),
            });
          }
        } catch (dbErr) {
          console.error('[Subagent] Failed to update error status in DB:', dbErr);
        }

        return {
          isError: true,
          subAgentConversationId,
          error: error instanceof Error ? error.message : String(error),
          depth: currentDepth + 1,
          status: 'error',
        };
      } finally {
        ctx.abortSignal?.removeEventListener('abort', parentAbortHandler);
        cleanupRuntime(subAgentConversationId);
        // Preserve subAgentState for resumption of a CLEANLY completed run — but
        // if this run was aborted, drop any resumable state that was cached before
        // the abort landed (covers an abort during the final awaited status write
        // AND the catch path). An aborted run has incomplete/ungated history and
        // must never be resumable.
        if (localController.signal.aborted) {
          subAgentState.delete(subAgentConversationId);
        }
      }
    },
  };
}

/** Clean up runtime state (queue + controller + toolCall mapping) but preserve
 *  conversation state. Removes the toolCallToSubAgent entry(ies) pointing at this
 *  sub-agent so the map doesn't grow unbounded (one entry per spawn). Follow-ups
 *  by toolCallId only route while the sub-agent is active (they read followUpQueues,
 *  also cleared here), so dropping the mapping on completion loses nothing. */
function cleanupRuntime(subAgentConversationId: string): void {
  followUpQueues.delete(subAgentConversationId);
  activeSubAgentControllers.delete(subAgentConversationId);
  activeSubAgentParents.delete(subAgentConversationId);
  for (const [toolCallId, saId] of toolCallToSubAgent) {
    if (saId === subAgentConversationId) toolCallToSubAgent.delete(toolCallId);
  }
}
