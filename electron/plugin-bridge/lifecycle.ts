import type { DispatchResult, HookEvent } from '../agent/hooks/dispatcher.js';
import type { StreamEvent, StreamOptions, AgentRuntime } from '../agent/runtime/types.js';
import type { AppConfig } from '../config/schema.js';
import { object } from './files.js';
import type { ImportedHooks } from './hooks.js';

export type BridgePromptGate = (
  messages: unknown[],
  config: AppConfig,
  systemPrompt: string,
  modelKey?: string | null,
) => Promise<{ messages: unknown[]; systemPrompt?: string; abort?: boolean }>;
let hooks: ImportedHooks | undefined;
let preSend: BridgePromptGate | undefined;
export function setBridgeLifecycle(value: ImportedHooks | undefined, gate?: BridgePromptGate): void {
  hooks = value;
  preSend = gate;
}
export function hasBridgeHooks(): boolean {
  return !!hooks?.enabled();
}

/** SDK runtimes submit the last user message. Attach context to that message
 * so adding plugin instructions never replaces the human's actual request. */
function withBridgeContext(messages: unknown[], context: string): unknown[] {
  const next = [...messages];
  for (let index = next.length - 1; index >= 0; index--) {
    const message = object(next[index]);
    if (message.role !== 'user') continue;
    next[index] = {
      ...message,
      content: Array.isArray(message.content)
        ? [...message.content, { type: 'text', text: `[Imported plugin context]\n${context}` }]
        : `${typeof message.content === 'string' ? message.content : ''}\n\n[Imported plugin context]\n${context}`,
    };
    return next;
  }
  return [...next, { role: 'user', content: [{ type: 'text', text: `[Imported plugin context]\n${context}` }] }];
}
export async function endBridgeSession(id: string): Promise<void> {
  await hooks?.end(id);
}
export function settleBridgeTurn(id: string, signal?: AbortSignal): void {
  const session = hooks?.sessions.get(id);
  if (!session || (signal && session.turnSignal !== signal)) return;
  for (const watcher of session.watchers.values()) watcher.abort();
  session.context = [];
  if (signal?.aborted) void hooks?.interrupt(session);
}
export async function interruptBridgeSession(id: string): Promise<void> {
  const session = hooks?.sessions.get(id);
  if (session) await hooks?.interrupt(session);
}

/** Run before native policy. Bridge output never undoes a native deny/redaction. */
export async function dispatchBridgeEvent<T>(event: HookEvent, payload: T): Promise<DispatchResult<T>> {
  const current = hooks;
  if (!current?.enabled()) return { payload, denied: false, modified: false };
  const p = object(payload);
  if (
    typeof p.conversationId !== 'string' ||
    p.conversationId.startsWith('connector:') ||
    (p.purpose && !['sub-agent', 'sub-agent-resume'].includes(String(p.purpose))) ||
    !['UserPromptSubmit', 'PreToolUse', 'PostToolUse'].includes(event)
  )
    return { payload, denied: false, modified: false };
  const signal = p.abortSignal instanceof AbortSignal ? p.abortSignal : undefined;
  const session = current.session(
    p.conversationId,
    typeof p.cwd === 'string' ? p.cwd : undefined,
    undefined,
    typeof p.parentConversationId === 'string' ? p.parentConversationId : undefined,
    signal,
  );
  try {
    await current.start(session);
    const messages = Array.isArray(p.messages) ? p.messages : [];
    const lastUser = object(messages.filter((m) => object(m).role === 'user').at(-1));
    const prompt =
      typeof lastUser.content === 'string'
        ? lastUser.content
        : Array.isArray(lastUser.content)
          ? lastUser.content.map((part) => object(part).text ?? '').join('\n')
          : '';
    const hookEvent = event === 'PostToolUse' && object(p.result).isError === true ? 'PostToolUseFailure' : event;
    const reply = await current.event(session, hookEvent, {
      prompt,
      tool_name: p.toolName,
      tool_input: p.args,
      tool_response: p.result,
      tool_use_id: p.toolCallId,
    });
    if (reply.deny) return { payload, denied: true, modified: false, reason: reply.deny };
    const context = [current.takeContext(session), reply.context]
      .filter(Boolean)
      .join('\n')
      .slice(0, 32 * 1024);
    if (!context) return { payload, denied: false, modified: false };
    if (event === 'UserPromptSubmit') {
      const augmented = withBridgeContext(messages, context);
      const native = preSend
        ? await preSend(
            augmented,
            current.configuration(),
            String(p.systemPrompt ?? ''),
            typeof p.modelKey === 'string' ? p.modelKey : undefined,
          )
        : { messages: augmented };
      if (native.abort || signal?.aborted)
        return { payload, denied: true, modified: false, reason: 'Imported context was blocked or cancelled.' };
      return {
        payload: {
          ...p,
          messages: native.messages,
          ...(native.systemPrompt !== undefined ? { systemPrompt: native.systemPrompt } : {}),
        } as T,
        denied: false,
        modified: true,
      };
    }
    if (event === 'PostToolUse') {
      const result = object(p.result);
      const augmented = Array.isArray(result.content)
        ? { ...result, content: [...result.content, { type: 'text', text: `[Imported plugin context]\n${context}` }] }
        : { ...(Object.keys(result).length ? result : { result: p.result }), bridgeContext: context };
      return { payload: { ...p, result: augmented } as T, denied: false, modified: true };
    }
    current.queueContext(session, context);
    return { payload, denied: false, modified: false };
  } catch {
    // A broken pre-hook must not turn into permission to execute. Post-hook
    // failures do not destroy successful tool content, and are in Activity.
    return {
      payload,
      denied: event !== 'PostToolUse',
      modified: false,
      reason: 'An imported hook failed or was cancelled. Review Plugin Bridge Activity.',
    };
  }
}

async function gatePrompt(options: StreamOptions, messages: unknown[], purpose: string): Promise<StreamOptions | null> {
  const systemPrompt = options.streamConfig?.systemPrompt ?? options.config.systemPrompt ?? '';
  const modelKey = options.parentModelKey ?? options.config.models.defaultModelKey;
  const native = preSend ? await preSend(messages, options.config, systemPrompt, modelKey) : { messages, systemPrompt };
  if (native.abort || options.abortSignal?.aborted) return null;
  const { hookDispatcher } = await import('../agent/hooks/dispatcher.js');
  const gate = await hookDispatcher.dispatch(
    'UserPromptSubmit',
    {
      conversationId: options.conversationId,
      messages: native.messages,
      systemPrompt: native.systemPrompt,
      modelKey,
      purpose,
      cwd: options.confinedCwd ?? options.cwd,
      abortSignal: options.abortSignal,
    },
    { suppressObserve: true },
  );
  if (gate.denied || options.abortSignal?.aborted) return null;
  const prompt = gate.payload.systemPrompt ?? systemPrompt;
  return {
    ...options,
    messages: gate.payload.messages,
    config: { ...options.config, systemPrompt: prompt },
    ...(options.streamConfig ? { streamConfig: { ...options.streamConfig, systemPrompt: prompt } } : {}),
  };
}

const wrapped = new WeakSet<AgentRuntime>();
export function attachBridgeRuntime(runtime: AgentRuntime): void {
  // Mastra also has direct callers (subagents and task agents). Its primitive
  // owns the wrapper, so the adapter must not double-fire lifecycle events.
  if (runtime.id === 'mastra' || wrapped.has(runtime)) return;
  wrapped.add(runtime);
  const original = runtime.stream.bind(runtime);
  runtime.stream = (options) => bridgeStream(original, runtime.id, options);
}
export async function* bridgeStream(
  stream: (options: StreamOptions) => AsyncGenerator<StreamEvent>,
  runtime: string,
  options: StreamOptions,
): AsyncGenerator<StreamEvent> {
  const current = hooks;
  if (!current?.enabled()) {
    yield* stream(options);
    return;
  }
  const parentId =
    typeof options.conversationMetadata?.parentConversationId === 'string'
      ? options.conversationMetadata.parentConversationId
      : undefined;
  const session = current.session(
    options.conversationId,
    options.confinedCwd ?? options.cwd,
    runtime,
    parentId,
    options.abortSignal ?? new AbortController().signal,
  );
  let terminal: StreamEvent | undefined;
  let failed = false,
    completed = false;
  // Reuse the same transcript shape accepted by Kai's runtime adapters. Stop
  // continuation needs completed tool calls/results, not just assistant prose.
  const transcript: Array<{ role: string; content: Array<Record<string, unknown>> }> = [];
  const calls = new Map<string, Record<string, unknown>>();
  let transcriptBytes = 0;
  let transcriptComplete = true;
  const append = (role: string, part: Record<string, unknown>) => {
    if (!transcriptComplete) return;
    try {
      transcriptBytes += Buffer.byteLength(JSON.stringify(part));
    } catch {
      transcriptComplete = false;
      return;
    }
    if (transcriptBytes > 2 * 1024 * 1024) {
      transcriptComplete = false;
      return;
    }
    let message = transcript.at(-1);
    if (message?.role !== role) {
      message = { role, content: [] };
      transcript.push(message);
    }
    const last = message.content.at(-1);
    if (part.type === 'text' && last?.type === 'text') last.text = String(last.text) + String(part.text);
    else message.content.push(part);
  };
  try {
    options.abortSignal?.throwIfAborted();
    await current.start(session);
    const context = current.takeContext(session);
    if (context) {
      const gated = await gatePrompt(options, withBridgeContext(options.messages, context), 'bridge-session-context');
      if (!gated) {
        yield {
          conversationId: options.conversationId,
          type: 'error',
          error: 'Imported context was blocked by Kai policy.',
        };
        return;
      }
      options = gated;
    }
    for await (const event of stream(options)) {
      if (event.type === 'text-delta') append('assistant', { type: 'text', text: event.text ?? '' });
      if (event.type === 'tool-call' && event.toolCallId) {
        const existing = calls.get(event.toolCallId);
        if (existing) {
          existing.args = event.args ?? existing.args;
        } else {
          const part = {
            type: 'tool-call',
            toolCallId: event.toolCallId,
            toolName: event.toolName ?? 'tool',
            args: event.args ?? {},
          };
          calls.set(event.toolCallId, part);
          append('assistant', part);
        }
      }
      if (['tool-result', 'tool-error'].includes(event.type) && event.toolCallId && calls.has(event.toolCallId)) {
        append('tool', {
          type: 'tool-result',
          toolCallId: event.toolCallId,
          toolName: event.toolName ?? calls.get(event.toolCallId)!.toolName,
          result: event.type === 'tool-error' ? { isError: true, error: event.error } : event.result,
        });
        calls.delete(event.toolCallId);
      }
      if (event.type === 'error') failed = true;
      if (event.type === 'done') terminal = event;
      else yield event;
    }
    if (terminal && !failed && !options.abortSignal?.aborted && current.enabled()) {
      const stop = await current.event(session, parentId ? 'SubagentStop' : 'Stop', { stop_hook_active: false });
      if (stop.continuation && transcriptComplete && calls.size === 0 && !options.abortSignal?.aborted) {
        const signal = AbortSignal.any([
          AbortSignal.timeout(120_000),
          session.controller.signal,
          ...(options.abortSignal ? [options.abortSignal] : []),
        ]);
        const continued = await gatePrompt(
          { ...options, abortSignal: signal },
          [...options.messages, ...transcript, { role: 'user', content: [{ type: 'text', text: stop.continuation }] }],
          'bridge-stop-continuation',
        );
        if (continued && !signal.aborted) {
          for await (const event of stream(continued)) {
            if (event.type === 'done') terminal = event;
            else yield event;
          }
        }
        if (!options.abortSignal?.aborted && current.enabled())
          await current.event(session, parentId ? 'SubagentStop' : 'Stop', { stop_hook_active: true });
      }
    }
    completed = true;
    if (terminal && !options.abortSignal?.aborted) yield terminal;
  } finally {
    if (!completed || options.abortSignal?.aborted) await current.interrupt(session);
    for (const controller of session.watchers.values()) controller.abort();
  }
}
