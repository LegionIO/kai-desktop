/**
 * Claude Agent SDK runtime adapter (stub).
 *
 * Provides registration so the runtime registry can offer Claude Agent SDK
 * as an option when `@anthropic-ai/claude-agent-sdk` is installed.
 *
 * The full implementation will:
 *   - Use the SDK's `query()` async iterator to stream messages
 *   - Translate SDK events → Kai's `StreamEvent` format
 *   - Expose Kai's custom tools via the MCP bridge
 *   - Support tool approval via `canUseTool` callback
 *   - Handle session resume across conversations
 *
 * For now, selecting this runtime yields a placeholder message.
 */

import type { AgentRuntime, RuntimeCapabilities, StreamOptions, StreamEvent } from './types.js';
import { detectClaudeAgentSdk } from './detect.js';
import type { AppConfig } from '../../config/schema.js';

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

const CLAUDE_CAPABILITIES: RuntimeCapabilities = {
  builtInTools: true,
  mcpSupport: true,
  toolObserver: false,
  compaction: false,   // SDK manages context internally
  memory: false,       // SDK uses sessions, not Kai memory layers
  fallback: true,      // SDK supports fallbackModel option
  multiProvider: true,  // Anthropic + Bedrock + Vertex
  subAgents: true,     // SDK has native Agent tool
  sessions: true,
  customTools: true,   // Via MCP bridge
};

// ---------------------------------------------------------------------------
// Runtime implementation
// ---------------------------------------------------------------------------

export class ClaudeAgentRuntime implements AgentRuntime {
  readonly id = 'claude-agent-sdk' as const;
  readonly name = 'Claude Agent SDK';
  readonly capabilities = CLAUDE_CAPABILITIES;

  async isAvailable(): Promise<boolean> {
    return detectClaudeAgentSdk();
  }

  async *stream(options: StreamOptions): AsyncGenerator<StreamEvent> {
    // TODO: Full implementation with SDK query() integration
    //
    // Implementation outline:
    //   1. Dynamic import of @anthropic-ai/claude-agent-sdk
    //   2. Create agent with model from options.config
    //   3. Attach Kai tools via ToolMcpBridge
    //   4. Call agent.query() with messages
    //   5. For each SDK message:
    //      - stream_event (text_delta) → yield { type: 'text-delta', text }
    //      - stream_event (tool_use)   → yield { type: 'tool-call', ... }
    //      - assistant message          → yield tool results
    //      - result message             → yield { type: 'done' } + usage
    //
    yield {
      conversationId: options.conversationId,
      type: 'text-delta',
      text: 'The Claude Agent SDK runtime is registered but not yet fully implemented. Please switch to the Mastra runtime in Settings → Runtime.',
    };
    yield { conversationId: options.conversationId, type: 'done' };
  }

  async generateTitle(
    _messages: unknown[],
    _config: AppConfig,
  ): Promise<string | null> {
    return null;
  }
}
