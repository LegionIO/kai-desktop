import type { AgentBackendDefinition, AgentBackendStreamOptions } from './backend-registry.js';
import type { StreamEvent } from './mastra-agent.js';
import { binaryExistsInResolvedPath } from '../utils/shell-env.js';

/**
 * Build a prompt string from the full conversation history.
 */
function buildPromptFromMessages(messages: unknown[]): string {
  const msgArray = messages as Array<{ role?: string; content?: unknown }>;
  if (msgArray.length === 0) return '';

  if (msgArray.length === 1 && msgArray[0].role === 'user') {
    return extractTextContent(msgArray[0].content);
  }

  const parts: string[] = [];
  const lastIdx = msgArray.length - 1;

  for (let i = 0; i < lastIdx; i++) {
    const msg = msgArray[i];
    const role = msg.role === 'assistant' ? 'Assistant' : 'User';
    const text = extractTextContent(msg.content);
    if (text) parts.push(`${role}: ${text}`);
  }

  const lastMsg = msgArray[lastIdx];
  const lastText = extractTextContent(lastMsg.content);

  if (parts.length === 0) return lastText;
  return `Here is our conversation so far:\n\n${parts.join('\n\n')}\n\nUser: ${lastText}`;
}

function extractTextContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const textParts: string[] = [];
    for (const part of content) {
      const p = part as { type?: string; text?: string };
      if (p.type === 'text' && typeof p.text === 'string') {
        textParts.push(p.text);
      }
    }
    if (textParts.length > 0) return textParts.join('\n');
  }
  return JSON.stringify(content);
}

/**
 * Build environment variables for the Codex CLI subprocess.
 */
function buildCodexEnv(options: AgentBackendStreamOptions): Record<string, string> {
  const env: Record<string, string> = {};

  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }

  const modelConfig = options.primaryModel?.modelConfig;
  if (!modelConfig) return env;

  // Codex uses CODEX_API_KEY internally, but also respects OPENAI_API_KEY
  if (modelConfig.apiKey) {
    env.OPENAI_API_KEY = modelConfig.apiKey;
  }

  return env;
}

// Codex SDK event types for casting
type CodexItem = {
  type: string;
  id?: string;
  text?: string;
  command?: string;
  aggregated_output?: string;
  name?: string;
  arguments?: string;
  call_id?: string;
  output?: string;
};
type CodexEvent = {
  type: string;
  item?: CodexItem;
  usage?: { input_tokens?: number; output_tokens?: number; cached_input_tokens?: number };
  error?: { message?: string };
};

export function createCodexBackend(): AgentBackendDefinition {
  return {
    key: 'codex',
    displayName: 'Codex SDK',

    isAvailable(): boolean {
      return binaryExistsInResolvedPath('codex');
    },

    async *stream(options: AgentBackendStreamOptions): AsyncGenerator<StreamEvent> {
      const { conversationId, abortSignal } = options;

      // Dynamic import
      let CodexClass: new (options?: Record<string, unknown>) => { startThread: (options?: Record<string, unknown>) => { runStreamed: (prompt: string) => Promise<{ events: AsyncIterable<unknown> }> } };
      try {
        const sdk = await import('@openai/codex-sdk');
        CodexClass = sdk.Codex;
      } catch {
        yield {
          conversationId,
          type: 'error',
          error: 'Codex SDK (@openai/codex-sdk) is not installed. Install it with: npm i -g @openai/codex',
        };
        yield { conversationId, type: 'done' };
        return;
      }

      const prompt = buildPromptFromMessages(options.messages);
      if (!prompt) {
        yield {
          conversationId,
          type: 'error',
          error: 'No user message found to send to Codex.',
        };
        yield { conversationId, type: 'done' };
        return;
      }

      const env = buildCodexEnv(options);
      const modelConfig = options.primaryModel?.modelConfig;

      // Build base URL — Codex expects the full /v1 path
      let baseUrl: string | undefined;
      if (modelConfig?.endpoint) {
        const ep = modelConfig.endpoint.replace(/\/+$/, '');
        baseUrl = ep.endsWith('/v1') ? ep : `${ep}/v1`;
      }

      try {
        console.info(`[CodexBackend] Starting session for ${conversationId} model=${modelConfig?.modelName}`);

        const codex = new CodexClass({
          env,
          ...(modelConfig?.apiKey ? { apiKey: modelConfig.apiKey } : {}),
          ...(baseUrl ? { baseUrl } : {}),
          ...(modelConfig?.modelName ? { config: { model: modelConfig.modelName } } : {}),
        });

        const cwd = options.cwd || process.cwd();
        const thread = codex.startThread({
          workingDirectory: cwd,
          skipGitRepoCheck: true,
          ...(modelConfig?.modelName ? { model: modelConfig.modelName } : {}),
        });

        const { events } = await thread.runStreamed(prompt);

        let accInputTokens = 0;
        let accOutputTokens = 0;

        for await (const rawEvent of events) {
          if (abortSignal?.aborted) break;
          const event = rawEvent as CodexEvent;

          if (event.type === 'item.completed' && event.item) {
            const item = event.item;

            // Agent message — text response
            if (item.type === 'agent_message' && item.text) {
              yield {
                conversationId,
                type: 'text-delta',
                text: item.text,
              };
            }

            // Command execution — tool call + result in one
            if (item.type === 'command_execution') {
              const toolCallId = item.id ?? `codex-tc-${Date.now()}`;
              const startedAt = new Date().toISOString();
              yield {
                conversationId,
                type: 'tool-call',
                toolCallId,
                toolName: 'shell',
                args: { command: item.command },
                startedAt,
              };
              if (item.aggregated_output !== undefined) {
                const finishedAt = new Date().toISOString();
                yield {
                  conversationId,
                  type: 'tool-result',
                  toolCallId,
                  toolName: 'shell',
                  result: item.aggregated_output,
                  startedAt,
                  finishedAt,
                };
              }
            }

            // Function call (if Codex uses function-calling format)
            if (item.type === 'function_call') {
              const startedAt = new Date().toISOString();
              let parsedArgs: unknown = {};
              try {
                parsedArgs = item.arguments ? JSON.parse(item.arguments) : {};
              } catch {
                parsedArgs = { raw: item.arguments };
              }
              yield {
                conversationId,
                type: 'tool-call',
                toolCallId: item.call_id ?? item.id ?? `codex-tc-${Date.now()}`,
                toolName: item.name ?? 'unknown',
                args: parsedArgs,
                startedAt,
              };
            }

            if (item.type === 'function_call_output') {
              const finishedAt = new Date().toISOString();
              yield {
                conversationId,
                type: 'tool-result',
                toolCallId: item.call_id ?? '',
                toolName: '',
                result: item.output,
                finishedAt,
              };
            }
          }

          // Turn completed — accumulate usage
          if (event.type === 'turn.completed' && event.usage) {
            accInputTokens += event.usage.input_tokens ?? 0;
            accOutputTokens += event.usage.output_tokens ?? 0;
          }

          // Turn failed — emit error
          if (event.type === 'turn.failed') {
            yield {
              conversationId,
              type: 'error',
              error: event.error?.message ?? 'Codex turn failed',
            };
          }
        }

        // Emit token usage
        if (accInputTokens > 0 || accOutputTokens > 0) {
          yield {
            conversationId,
            type: 'context-usage',
            data: {
              inputTokens: accInputTokens,
              outputTokens: accOutputTokens,
              totalTokens: accInputTokens + accOutputTokens,
            },
          };
        }

        console.info(`[CodexBackend] Session completed for ${conversationId}`);
      } catch (error) {
        if (!abortSignal?.aborted) {
          console.error(`[CodexBackend] Error for ${conversationId}:`, error);
          yield {
            conversationId,
            type: 'error',
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }

      yield { conversationId, type: 'done' };
    },
  };
}
