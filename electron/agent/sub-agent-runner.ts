/**
 * Sub-Agent Execution Engine
 *
 * Runs a child agent as an async generator, yielding stream events back to the caller.
 * The sub-agent has a control tool to signal completion, request input, etc.
 * Multi-turn: the runner loops until the sub-agent signals done or max turns.
 */

import { BrowserWindow } from 'electron';
import { broadcastToWebClients } from '../web-server/web-clients.js';
import { z } from 'zod';
import { streamAgentResponse, getProviderDefinedToolNames } from './mastra-agent.js';
import type { StreamEvent } from './mastra-agent.js';
import { hookDispatcher } from './hooks/dispatcher.js';
import type { LLMModelConfig } from './model-catalog.js';
import type { AppConfig } from '../config/schema.js';
import type { ToolDefinition, ToolExecutionContext } from '../tools/types.js';
import {
  ToolObserverManager,
  resolveToolObserverConfig,
  summarizeLatestUserRequest,
  summarizeThreadContext,
} from './tool-observer.js';

export type SubAgentEvent =
  | (StreamEvent & { subAgentConversationId: string; parentConversationId: string; parentToolCallId: string })
  | {
      subAgentConversationId: string;
      parentConversationId: string;
      parentToolCallId: string;
      type: 'sub-agent-status';
      status: 'running' | 'awaiting-input' | 'completed' | 'stopped' | 'failed';
      summary?: string;
    }
  | {
      subAgentConversationId: string;
      parentConversationId: string;
      parentToolCallId: string;
      conversationId: string;
      type: 'sub-agent-user-message';
      text: string;
      source: 'task' | 'parent' | 'user';
    };

export type SubAgentRunOptions = {
  subAgentConversationId: string;
  parentConversationId: string;
  parentToolCallId: string;
  task: string;
  context?: string;
  depth: number;
  config: AppConfig;
  modelConfig: LLMModelConfig;
  tools: ToolDefinition[];
  dbPath: string;
  abortSignal?: AbortSignal;
  /** Called between agent turns to check for pending follow-up messages. */
  getFollowUp: () => Promise<string | null>;
};

/** Global counter for enforcing maxConcurrent limit */
let activeSubAgentCount = 0;

export function getActiveSubAgentCount(): number {
  return activeSubAgentCount;
}

function broadcastSubAgentEvent(event: SubAgentEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('agent:stream-event', event);
  }
  broadcastToWebClients('agent:stream-event', event);
}

/** Sub-agent control signal — set by the sub_agent_control tool */
type ControlSignal = {
  action: 'complete' | 'failed' | 'awaiting_response' | 'continue';
  message?: string;
};

/** Create the virtual control tool that the sub-agent uses to signal state */
function createControlTool(signalRef: { current: ControlSignal | null }): ToolDefinition {
  return {
    name: 'sub_agent_control',
    description: [
      'Signal your current state to the parent agent and user.',
      'You MUST call this tool when you have completed your task, encountered a failure,',
      'or need input from the user/parent before continuing.',
      '',
      'Actions:',
      '- "complete": Task is done. Include a summary of what you accomplished.',
      '- "failed": Task cannot be completed. Explain why.',
      '- "awaiting_response": You need input/clarification before continuing. Ask your question in the message.',
      '- "continue": You are not done yet and will keep working (use between multi-step operations).',
    ].join(' '),
    inputSchema: z.object({
      action: z.enum(['complete', 'failed', 'awaiting_response', 'continue']).describe('Your current state'),
      message: z.string().optional().describe('Summary, error explanation, or question for the user'),
    }),
    execute: async (input: unknown, _ctx: ToolExecutionContext): Promise<unknown> => {
      const { action, message } = input as { action: string; message?: string };
      signalRef.current = { action: action as ControlSignal['action'], message };
      return { acknowledged: true, action, message: message ?? '' };
    },
  };
}

function buildSubAgentSystemPrompt(baseSystemPrompt: string, task: string, context?: string, depth?: number): string {
  const parts = [
    baseSystemPrompt,
    '',
    '--- Sub-Agent Context ---',
    `You are a sub-agent (depth ${depth ?? 0}) spawned to handle a specific task.`,
    `Your assigned task: ${task}`,
  ];
  if (context) {
    parts.push('', 'Additional context from parent agent:', context);
  }
  parts.push(
    '',
    'Instructions:',
    '- Focus on the assigned task. Use tools as needed.',
    '- You MUST call sub_agent_control with action "complete" when done, or "failed" if you cannot finish.',
    '- If you need user input or clarification, call sub_agent_control with action "awaiting_response".',
    '- For multi-step work, call sub_agent_control with "continue" between major steps if needed.',
    '- The user or parent agent may send you follow-up messages between turns.',
    '- Do NOT just provide a text response without calling sub_agent_control — the system needs the signal.',
  );
  return parts.join('\n');
}

export async function* runSubAgent(opts: SubAgentRunOptions): AsyncGenerator<SubAgentEvent> {
  const {
    subAgentConversationId,
    parentConversationId,
    parentToolCallId,
    task,
    context,
    depth,
    config,
    modelConfig,
    tools,
    dbPath,
    abortSignal,
    getFollowUp,
  } = opts;

  const maxConcurrent = config.tools?.subAgents?.maxConcurrent ?? 4;
  if (activeSubAgentCount >= maxConcurrent) {
    yield {
      subAgentConversationId,
      parentConversationId,
      parentToolCallId,
      conversationId: subAgentConversationId,
      type: 'error',
      error: `Maximum concurrent sub-agents (${maxConcurrent}) reached.`,
    };
    yield {
      subAgentConversationId,
      parentConversationId,
      parentToolCallId,
      conversationId: subAgentConversationId,
      type: 'done',
    };
    return;
  }

  activeSubAgentCount++;

  try {
    const basePrompt = config.systemPrompts?.chat?.trim() || config.systemPrompt;
    const systemPrompt = buildSubAgentSystemPrompt(basePrompt, task, context, depth);
    const messages: Array<{ role: string; content: unknown }> = [{ role: 'user', content: task }];

    const subAgentConfig: AppConfig = { ...config, systemPrompt };

    // Control signal shared with the control tool
    const controlSignal: { current: ControlSignal | null } = { current: null };
    const controlTool = createControlTool(controlSignal);

    // Inject the control tool into the sub-agent's toolset
    const allTools = [...tools.filter((t) => t.name !== 'sub_agent_control'), controlTool];

    let fullResponseText = '';
    let turnCount = 0;
    const maxTurns = Math.max(config.advanced.maxSteps, 20); // generous turn limit

    // Emit initial status
    const emitStatus = (
      _status: never,
      st: 'running' | 'awaiting-input' | 'completed' | 'stopped' | 'failed',
      summary?: string,
    ) => {
      const evt: SubAgentEvent = {
        subAgentConversationId,
        parentConversationId,
        parentToolCallId,
        type: 'sub-agent-status',
        status: st,
        summary,
      };
      broadcastSubAgentEvent(evt);
      return evt;
    };

    yield emitStatus(undefined as never, 'running', `Starting task: ${task.slice(0, 100)}`);

    // Emit initial task as user message
    const taskMsgEvent: SubAgentEvent = {
      subAgentConversationId,
      parentConversationId,
      parentToolCallId,
      conversationId: subAgentConversationId,
      type: 'sub-agent-user-message',
      text: task,
      source: 'task',
    };
    yield taskMsgEvent;
    broadcastSubAgentEvent(taskMsgEvent);

    // Create observer for the sub-agent's tool executions
    const observerConfig = resolveToolObserverConfig(config);
    let subObserver: ToolObserverManager | null = null;
    const toolCancels = new Map<string, () => void>();
    // Suppress raw tool-call args in the sub-agent stream until PreToolUse
    // resolves, matching the main-agent path, so a DLP block/modify hook can't
    // leak raw args into the sub-agent UI/persistence.
    const subEnforcingHooks = hookDispatcher.hasEnforcingToolHooks();
    // Provider-native tools execute in-provider and never hit
    // onToolExecutionStart, so their args must not be suppressed (nothing would
    // un-suppress them → stuck {pending}).
    const subProviderToolNames = getProviderDefinedToolNames(modelConfig);
    const subHookRewrittenArgs = new Map<string, unknown>();
    // Sub-agent runtime has no exec/stream id pairing map. To reconcile a
    // possible id mismatch, the stream loop records suppressed stream ids per
    // toolName (FIFO); onToolExecutionStart dequeues one and re-broadcasts the
    // resolved args under the stream id the renderer actually rendered.
    const subSuppressedStreamIdsByTool = new Map<string, string[]>();
    // Symmetric case: onToolExecutionStart resolved args BEFORE the stream
    // tool-call event arrived AND the exec id differs from the stream id. There
    // is no stream id to correct yet, so the resolved args are parked here per
    // toolName (FIFO); the stream loop consumes one before falling back to
    // {pending}, so the card is never left permanently suppressed.
    const subResolvedArgsByTool = new Map<string, unknown[]>();

    // Helper: add a follow-up message and emit it as a UI event
    const addFollowUpMessage = (text: string, source: 'user' | 'parent' | 'task' = 'parent'): SubAgentEvent => {
      messages.push({ role: 'user', content: text });
      const evt: SubAgentEvent = {
        subAgentConversationId,
        parentConversationId,
        parentToolCallId,
        conversationId: subAgentConversationId,
        type: 'sub-agent-user-message',
        text,
        source,
      };
      broadcastSubAgentEvent(evt);
      return evt;
    };

    while (turnCount < maxTurns) {
      if (abortSignal?.aborted) break;
      turnCount++;
      controlSignal.current = null; // reset for this turn

      let turnText = '';

      // Create/re-create observer each turn with updated context
      subObserver?.dispose();
      if (observerConfig.enabled) {
        subObserver = new ToolObserverManager({
          conversationId: subAgentConversationId,
          modelConfig,
          config: observerConfig,
          userRequestSummary: summarizeLatestUserRequest(messages),
          baseThreadContext: summarizeThreadContext(messages),
          emitMidToolMessage: (text) => {
            if (!abortSignal?.aborted) {
              broadcastSubAgentEvent({
                subAgentConversationId,
                parentConversationId,
                parentToolCallId,
                conversationId: subAgentConversationId,
                type: 'observer-message',
                text,
              });
            }
          },
          cancelToolCall: (toolCallId) => {
            const cancel = toolCancels.get(toolCallId);
            if (!cancel) return false;
            cancel();
            return true;
          },
        });
      }

      const stream = streamAgentResponse(
        subAgentConversationId,
        messages,
        modelConfig,
        subAgentConfig,
        allTools,
        dbPath,
        {
          abortSignal,
          emitEvent: (event) => {
            if (event.type === 'tool-progress') {
              subObserver?.onToolProgress({
                toolCallId: event.toolCallId,
                toolName: event.toolName,
                data: event.data as
                  | {
                      stream?: 'stdout' | 'stderr';
                      output?: string;
                      delta?: string;
                      bytesSeen?: number;
                      truncated?: boolean;
                      stopped?: boolean;
                    }
                  | undefined,
              });
            }
            broadcastSubAgentEvent({
              ...event,
              subAgentConversationId,
              parentConversationId,
              parentToolCallId,
            } as SubAgentEvent);
          },
          onToolExecutionStart: async (state) => {
            toolCancels.set(state.toolCallId, state.cancel);
            // PreToolUse BEFORE the observer so a block/modify hook can deny or
            // sanitize args before the observer model sees them.
            const preTool = await hookDispatcher.dispatch('PreToolUse', {
              conversationId: subAgentConversationId,
              parentConversationId,
              toolCallId: state.toolCallId,
              toolName: state.toolName,
              args: state.args,
            });
            // Resolve the stream id the renderer used. If the stream event
            // already arrived it's queued here; otherwise (exec-first) we get
            // undefined and stash the resolved args by toolName so the stream
            // loop applies them when its id shows up.
            const dequeueStreamId = (): string | undefined => {
              const q = subSuppressedStreamIdsByTool.get(state.toolName);
              return q && q.length > 0 ? q.shift() : undefined;
            };
            const publishResolved = (resolved: unknown): void => {
              if (!subEnforcingHooks) return;
              const streamId = dequeueStreamId();
              // Record under the exec id (the stream loop checks this by id).
              subHookRewrittenArgs.set(state.toolCallId, resolved);
              if (streamId) {
                // Stream-first: a card was already rendered under `streamId` as
                // {pending}. Re-broadcast the resolved args to correct it — even
                // when streamId === exec id, since the renderer will NOT re-emit
                // that card on its own. Alias the extra key only when the ids
                // actually differ.
                if (streamId !== state.toolCallId) subHookRewrittenArgs.set(streamId, resolved);
                broadcastSubAgentEvent({
                  type: 'tool-call',
                  toolCallId: streamId,
                  toolName: state.toolName,
                  args: resolved,
                  subAgentConversationId,
                  parentConversationId,
                  parentToolCallId,
                } as SubAgentEvent);
              } else {
                // Exec-first: the stream event hasn't arrived yet. If it later
                // uses the SAME id, it finds `resolved` via subHookRewrittenArgs
                // by id. If it uses a DIFFERENT id, that by-id lookup misses and
                // it would suppress to {pending} forever — so also park the
                // resolved args by toolName (FIFO) for the stream loop to claim.
                const q = subResolvedArgsByTool.get(state.toolName) ?? [];
                q.push(resolved);
                subResolvedArgsByTool.set(state.toolName, q);
              }
            };
            if (preTool.denied) {
              const reason = preTool.reason ?? 'Blocked by PreToolUse hook.';
              publishResolved({ redacted: true, reason });
              return {
                skip: true as const,
                result: { isError: true, error: reason },
              };
            }
            const nextArgs = (preTool.payload as { args?: unknown } | undefined)?.args;
            if (
              nextArgs !== undefined &&
              nextArgs !== state.args &&
              state.args &&
              typeof state.args === 'object' &&
              nextArgs &&
              typeof nextArgs === 'object' &&
              !Array.isArray(state.args) &&
              !Array.isArray(nextArgs)
            ) {
              const target = state.args as Record<string, unknown>;
              for (const k of Object.keys(target)) delete target[k];
              Object.assign(target, nextArgs as Record<string, unknown>);
            }
            // Emit resolved args (sanitized or allowed-unchanged) so the
            // suppressed initial tool-call event is corrected in place.
            publishResolved(state.args);
            subObserver?.onToolExecutionStart(state);
          },
          onToolExecutionEnd: ({ toolCallId }) => {
            toolCancels.delete(toolCallId);
            subObserver?.onToolExecutionEnd(toolCallId);
          },
          augmentToolResult: async ({ toolCallId, toolName, args, result }) => {
            // Use redacted/sanitized args (if PreToolUse rewrote/denied them) so
            // PostToolUse hooks/observers never see the raw denied args.
            const postArgs = subHookRewrittenArgs.get(toolCallId) ?? args;
            const postTool = await hookDispatcher.dispatch('PostToolUse', {
              conversationId: subAgentConversationId,
              parentConversationId,
              toolCallId,
              toolName,
              args: postArgs,
              result,
            });
            if (postTool.denied) {
              result = { isError: true, error: postTool.reason ?? 'Blocked by PostToolUse hook.' };
            } else {
              const nextResult = (postTool.payload as { result?: unknown } | undefined)?.result;
              if (nextResult !== undefined) result = nextResult;
            }
            await subObserver?.waitForLinkedLaunchedTools(toolCallId);
            subObserver?.onToolExecutionResult(toolCallId, toolName, result);
            const augmentation = subObserver?.getToolAugmentation(toolCallId);
            if (!augmentation) return result;
            if (!result || typeof result !== 'object' || Array.isArray(result)) {
              return { value: result, ...augmentation };
            }
            return { ...(result as Record<string, unknown>), ...augmentation };
          },
        },
      );

      for await (const event of stream) {
        if (event.type === 'text-delta' && event.text) {
          turnText += event.text;
        }
        const enriched = { ...event, subAgentConversationId, parentConversationId, parentToolCallId } as SubAgentEvent;
        // Suppress raw args on tool-call events until PreToolUse resolves; the
        // onToolExecutionStart handler re-broadcasts the resolved args.
        if (event.type === 'tool-call' && event.toolCallId) {
          const rewritten = subHookRewrittenArgs.get(event.toolCallId);
          if (rewritten !== undefined) {
            (enriched as Record<string, unknown>).args = rewritten;
            // Exec-first + SAME id: publishResolved both recorded args by id AND
            // speculatively parked a copy by toolName (it couldn't yet know the
            // stream id would match). We resolved by id here, so drain that
            // parked entry — otherwise it leaks onto the next same-named call.
            const pq = event.toolName ? subResolvedArgsByTool.get(event.toolName) : undefined;
            if (pq && pq.length > 0) pq.shift();
          } else if (subEnforcingHooks && !(event.toolName && subProviderToolNames.has(event.toolName))) {
            // Exec-first with a mismatched id: onToolExecutionStart already
            // resolved args and parked them by toolName. Claim one instead of
            // suppressing, so the card is never stuck {pending}.
            const parkedQueue = event.toolName ? subResolvedArgsByTool.get(event.toolName) : undefined;
            const parked = parkedQueue && parkedQueue.length > 0 ? parkedQueue.shift() : undefined;
            if (parked !== undefined) {
              (enriched as Record<string, unknown>).args = parked;
              subHookRewrittenArgs.set(event.toolCallId, parked);
            } else {
              (enriched as Record<string, unknown>).args = { pending: true };
              (enriched as Record<string, unknown>).argsPending = true;
              // Record this stream id so onToolExecutionStart can re-broadcast the
              // resolved args under it even if the exec-side id differs.
              if (event.toolName) {
                const q = subSuppressedStreamIdsByTool.get(event.toolName) ?? [];
                q.push(event.toolCallId);
                subSuppressedStreamIdsByTool.set(event.toolName, q);
              }
            }
          }
        }
        if (event.type !== 'done') {
          broadcastSubAgentEvent(enriched);
        }
        yield enriched;
        if (event.type === 'done') break;
      }

      if (turnText) {
        fullResponseText += (fullResponseText ? '\n\n' : '') + turnText;
        messages.push({ role: 'assistant', content: turnText });
      }

      if (abortSignal?.aborted) break;

      // Check what the sub-agent signaled via the control tool
      const signal = controlSignal.current as ControlSignal | null;

      if (signal?.action === 'complete' || signal?.action === 'failed') {
        // Before finalizing, check if a message arrived during this turn
        const pendingFollowUp = await getFollowUp();
        if (pendingFollowUp) {
          yield addFollowUpMessage(pendingFollowUp);
          yield emitStatus(undefined as never, 'running', 'Processing follow-up');
          continue;
        }
        const finalSt = signal.action === 'complete' ? ('completed' as const) : ('failed' as const);
        yield emitStatus(undefined as never, finalSt, signal.message ?? fullResponseText.slice(0, 500));
        break;
      }
      if (signal?.action === 'awaiting_response') {
        yield emitStatus(undefined as never, 'awaiting-input', signal.message ?? 'Waiting for input');

        const followUp = await waitForFollowUp(getFollowUp, abortSignal, 300000);
        if (!followUp || abortSignal?.aborted) break;

        yield addFollowUpMessage(followUp);
        yield emitStatus(undefined as never, 'running', 'Processing follow-up');
        continue;
      }

      // signal === 'continue' or no signal — check for opportunistic follow-ups
      const followUp = await getFollowUp();
      if (followUp) {
        yield addFollowUpMessage(followUp);
        yield emitStatus(undefined as never, 'running', `Processing follow-up (turn ${turnCount + 1})`);
        continue;
      }

      // No control signal and no follow-up — brief window then auto-complete
      if (!signal) {
        const lateFollowUp = await waitForFollowUp(getFollowUp, abortSignal, 5000);
        if (lateFollowUp) {
          yield addFollowUpMessage(lateFollowUp);
          yield emitStatus(undefined as never, 'running', `Processing follow-up (turn ${turnCount + 1})`);
          continue;
        }
        yield emitStatus(undefined as never, 'completed', fullResponseText.slice(0, 500));
        break;
      }

      // signal === 'continue' — keep going
      yield emitStatus(undefined as never, 'running', `Continuing (turn ${turnCount + 1})`);
    }

    const finalStatus = abortSignal?.aborted
      ? 'stopped'
      : controlSignal.current?.action === 'failed'
        ? 'failed'
        : 'completed';
    if (finalStatus !== 'completed' && finalStatus !== 'failed') {
      yield emitStatus(undefined as never, finalStatus as 'stopped', fullResponseText.slice(0, 500));
    }

    // Dispose observer before exiting (inside try to avoid bundler scope issue with finally)
    subObserver?.dispose();
    subObserver = null;
  } finally {
    // subObserver already disposed above; only decrement counter here
    activeSubAgentCount--;
  }
}

/** Wait for a follow-up message with timeout */
async function waitForFollowUp(
  getFollowUp: () => Promise<string | null>,
  abortSignal?: AbortSignal,
  timeoutMs = 15000,
): Promise<string | null> {
  // Check immediately
  const immediate = await getFollowUp();
  if (immediate) return immediate;

  // Poll with timeout
  return new Promise<string | null>((resolve) => {
    let resolved = false;
    const finish = (val: string | null) => {
      if (!resolved) {
        resolved = true;
        resolve(val);
      }
    };

    const interval = setInterval(async () => {
      if (abortSignal?.aborted) {
        clearInterval(interval);
        finish(null);
        return;
      }
      const msg = await getFollowUp();
      if (msg) {
        clearInterval(interval);
        finish(msg);
      }
    }, 300);

    setTimeout(() => {
      clearInterval(interval);
      finish(null);
    }, timeoutMs);

    if (abortSignal) {
      abortSignal.addEventListener(
        'abort',
        () => {
          clearInterval(interval);
          finish(null);
        },
        { once: true },
      );
    }
  });
}
