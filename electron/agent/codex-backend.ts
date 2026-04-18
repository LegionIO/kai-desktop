import type { AgentBackendDefinition, AgentBackendStreamOptions } from './backend-registry.js';
import type { StreamEvent } from './mastra-agent.js';
import { binaryExistsInResolvedPath } from '../utils/shell-env.js';

/**
 * Extract the last user message text from the conversation messages array.
 */
function extractLastUserPrompt(messages: unknown[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as { role?: string; content?: unknown };
    if (msg.role !== 'user') continue;

    if (typeof msg.content === 'string') return msg.content;
    if (Array.isArray(msg.content)) {
      const textParts: string[] = [];
      for (const part of msg.content) {
        const p = part as { type?: string; text?: string };
        if (p.type === 'text' && typeof p.text === 'string') {
          textParts.push(p.text);
        }
      }
      if (textParts.length > 0) return textParts.join('\n');
    }
    return JSON.stringify(msg.content);
  }
  return '';
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

  if (modelConfig.apiKey) {
    env.OPENAI_API_KEY = modelConfig.apiKey;
  }
  if (modelConfig.endpoint) {
    env.OPENAI_BASE_URL = modelConfig.endpoint;
  }

  return env;
}

export function createCodexBackend(): AgentBackendDefinition {
  return {
    key: 'codex',
    displayName: 'Codex',

    isAvailable(): boolean {
      return binaryExistsInResolvedPath('codex');
    },

    async *stream(options: AgentBackendStreamOptions): AsyncGenerator<StreamEvent> {
      const { conversationId, abortSignal } = options;

      // Dynamic import — graceful failure if SDK not installed
      let CodexClass: new (options?: { env?: Record<string, string>; config?: Record<string, unknown> }) => { startThread: (options?: { workingDirectory?: string; skipGitRepoCheck?: boolean }) => { runStreamed: (prompt: string) => Promise<{ events: AsyncIterable<unknown> }> } };
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

      const prompt = extractLastUserPrompt(options.messages);
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

      try {
        console.info(`[CodexBackend] Starting session for ${conversationId}`);

        const codex = new CodexClass({
          env,
          ...(modelConfig?.modelName ? { config: { model: modelConfig.modelName } } : {}),
        });

        const cwd = options.cwd || process.cwd();
        const thread = codex.startThread({
          workingDirectory: cwd,
          skipGitRepoCheck: true,
        });

        const { events } = await thread.runStreamed(prompt);

        // Local types for casting the loosely-typed SDK events
        type CodexItem = {
          type: string;
          id?: string;
          content?: Array<{ type: string; text?: string }>;
          name?: string;
          arguments?: string;
          call_id?: string;
          output?: string;
        };
        type CodexEvent = {
          type: string;
          item?: CodexItem;
          usage?: { input_tokens?: number; output_tokens?: number };
        };

        let accInputTokens = 0;
        let accOutputTokens = 0;

        for await (const rawEvent of events) {
          if (abortSignal?.aborted) break;
          const event = rawEvent as CodexEvent;

          if (event.type === 'item.completed' && event.item) {
            const item = event.item;

            // Message content (text response)
            if (item.type === 'message' && item.content) {
              for (const part of item.content) {
                if (part.type === 'output_text' || part.type === 'text') {
                  yield {
                    conversationId,
                    type: 'text-delta',
                    text: part.text ?? '',
                  };
                }
              }
            }

            // Function call (tool invocation)
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

            // Function call output (tool result)
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
