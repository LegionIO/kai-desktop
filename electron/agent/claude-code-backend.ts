import type { AgentBackendDefinition, AgentBackendStreamOptions } from './backend-registry.js';
import type { StreamEvent } from './mastra-agent.js';
import { binaryExistsInResolvedPath } from '../utils/shell-env.js';

/**
 * Build a prompt string from the full conversation history.
 * Serializes all messages so Claude Code has complete context,
 * not just the last user message.
 */
function buildPromptFromMessages(messages: unknown[]): string {
  const msgArray = messages as Array<{ role?: string; content?: unknown }>;
  if (msgArray.length === 0) return '';

  // If there's only one user message, just return its text directly
  if (msgArray.length === 1 && msgArray[0].role === 'user') {
    return extractTextContent(msgArray[0].content);
  }

  // Multiple messages: serialize the conversation as context,
  // with the last user message as the primary prompt
  const parts: string[] = [];
  const lastIdx = msgArray.length - 1;

  // Everything before the last message becomes conversation context
  for (let i = 0; i < lastIdx; i++) {
    const msg = msgArray[i];
    const role = msg.role === 'assistant' ? 'Assistant' : 'User';
    const text = extractTextContent(msg.content);
    if (text) parts.push(`${role}: ${text}`);
  }

  // The last message (should be user) is the actual prompt
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
 * Build environment variables for the Claude Code CLI subprocess.
 * Overlays provider-specific credentials onto the inherited process env.
 */
function buildClaudeEnv(options: AgentBackendStreamOptions): Record<string, string> {
  const env: Record<string, string> = {};

  // Inherit process.env (filter out undefined values)
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }

  const modelConfig = options.primaryModel?.modelConfig;
  if (!modelConfig) return env;

  // Anthropic direct
  if (modelConfig.apiKey) {
    env.ANTHROPIC_API_KEY = modelConfig.apiKey;
  }
  if (modelConfig.endpoint) {
    env.ANTHROPIC_BASE_URL = modelConfig.endpoint;
  }

  // Bedrock credentials
  if (modelConfig.provider === 'amazon-bedrock') {
    if (modelConfig.region) env.AWS_REGION = modelConfig.region;
    if (modelConfig.accessKeyId) env.AWS_ACCESS_KEY_ID = modelConfig.accessKeyId;
    if (modelConfig.secretAccessKey) env.AWS_SECRET_ACCESS_KEY = modelConfig.secretAccessKey;
    if (modelConfig.sessionToken) env.AWS_SESSION_TOKEN = modelConfig.sessionToken;
    if (modelConfig.awsProfile) env.AWS_PROFILE = modelConfig.awsProfile;
  }

  return env;
}

// SDK message/content types (loosely typed for dynamic import compatibility)
type SDKTextBlock = { type: 'text'; text: string };
type SDKToolUseBlock = { type: 'tool_use'; id: string; name: string; input: unknown };
type SDKToolResultBlock = { type: 'tool_result'; tool_use_id: string; content: unknown };
type SDKContentBlock = SDKTextBlock | SDKToolUseBlock | SDKToolResultBlock;
type SDKStreamEvent = {
  type: string;
  delta?: { type: string; text?: string };
  content_block?: { type: string; name?: string; id?: string };
  index?: number;
};
type SDKMessage = {
  type: string;
  event?: SDKStreamEvent;
  message?: {
    role?: string;
    content?: SDKContentBlock[];
  };
  subtype?: string;
};

export function createClaudeCodeBackend(): AgentBackendDefinition {
  return {
    key: 'claude-code',
    displayName: 'Claude Code SDK',

    isAvailable(): boolean {
      return binaryExistsInResolvedPath('claude');
    },

    async *stream(options: AgentBackendStreamOptions): AsyncGenerator<StreamEvent> {
      const { conversationId, config, abortSignal } = options;

      // Dynamic import — graceful failure if SDK not installed
      let queryFn: (opts: { prompt: string; options?: Record<string, unknown> }) => AsyncIterable<unknown>;
      try {
        const sdk = await import('@anthropic-ai/claude-agent-sdk');
        queryFn = sdk.query;
      } catch {
        yield {
          conversationId,
          type: 'error',
          error: 'Claude Code SDK (@anthropic-ai/claude-agent-sdk) is not installed. Install it with: npm i -g @anthropic-ai/claude-code',
        };
        yield { conversationId, type: 'done' };
        return;
      }

      const prompt = buildPromptFromMessages(options.messages);
      if (!prompt) {
        yield {
          conversationId,
          type: 'error',
          error: 'No user message found to send to Claude Code.',
        };
        yield { conversationId, type: 'done' };
        return;
      }

      const env = buildClaudeEnv(options);
      const modelName = options.primaryModel?.modelConfig.modelName;
      const sdkOptions: Record<string, unknown> = {
        systemPrompt: config.systemPrompt || undefined,
        cwd: options.cwd || process.cwd(),
        maxTurns: config.advanced.maxSteps,
        model: modelName,
        includePartialMessages: true,
        env,
        allowedTools: [
          'Read', 'Write', 'Edit', 'MultiEdit', 'Bash', 'Glob', 'Grep',
          'LS', 'WebFetch', 'WebSearch', 'TodoWrite', 'NotebookEdit',
        ],
      };

      try {
        console.info(`[ClaudeCodeBackend] Starting query for ${conversationId}`);
        const stream = queryFn({ prompt, options: sdkOptions });
        let streamedText = false;

        for await (const raw of stream) {
          if (abortSignal?.aborted) break;

          const message = raw as SDKMessage;

          // Stream events — real-time text deltas
          if (message.type === 'stream_event' && message.event) {
            const evt = message.event;
            if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta' && evt.delta.text) {
              streamedText = true;
              yield {
                conversationId,
                type: 'text-delta',
                text: evt.delta.text,
              };
            }
            continue;
          }

          // Assistant messages — extract tool_use blocks (text already streamed via deltas)
          if (message.type === 'assistant' && message.message?.content) {
            for (const block of message.message.content) {
              if (abortSignal?.aborted) break;

              // Only emit text if we didn't stream it already
              if (block.type === 'text' && !streamedText) {
                yield {
                  conversationId,
                  type: 'text-delta',
                  text: (block as SDKTextBlock).text,
                };
              } else if (block.type === 'tool_use') {
                const toolBlock = block as SDKToolUseBlock;
                const startedAt = new Date().toISOString();
                yield {
                  conversationId,
                  type: 'tool-call',
                  toolCallId: toolBlock.id,
                  toolName: toolBlock.name,
                  args: toolBlock.input,
                  startedAt,
                };
              }
            }
            // Reset for next turn (multi-turn conversations)
            streamedText = false;
          }

          // Tool results
          if (message.type === 'tool_result' || message.subtype === 'tool_result') {
            const resultMsg = message.message;
            if (resultMsg?.content) {
              for (const block of resultMsg.content) {
                if (block.type === 'tool_result') {
                  const resultBlock = block as SDKToolResultBlock;
                  const finishedAt = new Date().toISOString();
                  yield {
                    conversationId,
                    type: 'tool-result',
                    toolCallId: resultBlock.tool_use_id,
                    toolName: '',
                    result: resultBlock.content,
                    finishedAt,
                  };
                }
              }
            }
          }

          // Final result — check for errors
          if (message.type === 'result') {
            const resultData = raw as { is_error?: boolean; result?: string };
            if (resultData.is_error && resultData.result) {
              yield {
                conversationId,
                type: 'error',
                error: resultData.result,
              };
            }
          }
        }

        console.info(`[ClaudeCodeBackend] Query completed for ${conversationId}`);
      } catch (error) {
        if (!abortSignal?.aborted) {
          console.error(`[ClaudeCodeBackend] Error for ${conversationId}:`, error);
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
