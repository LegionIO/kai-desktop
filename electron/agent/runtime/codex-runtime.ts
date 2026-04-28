/**
 * Codex SDK agent runtime adapter (stub).
 *
 * Provides minimal registration so the runtime registry can offer Codex SDK
 * as an option when it's installed.  The actual streaming implementation is
 * not yet built — selecting this runtime will yield a placeholder message.
 *
 * Full implementation will be revisited when the Codex SDK exposes streaming
 * event support.
 */

import type { AgentRuntime, RuntimeCapabilities, StreamOptions, StreamEvent } from './types.js';
import { detectCodexSdk } from './detect.js';
import type { AppConfig } from '../../config/schema.js';

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

const CODEX_CAPABILITIES: RuntimeCapabilities = {
  builtInTools: true,
  mcpSupport: false,
  toolObserver: false,
  compaction: false,
  memory: false,
  fallback: false,
  multiProvider: false,
  subAgents: false,
  sessions: true,
  customTools: false,
};

// ---------------------------------------------------------------------------
// Runtime implementation
// ---------------------------------------------------------------------------

export class CodexRuntime implements AgentRuntime {
  readonly id = 'codex-sdk' as const;
  readonly name = 'Codex SDK';
  readonly capabilities = CODEX_CAPABILITIES;

  async isAvailable(): Promise<boolean> {
    return detectCodexSdk();
  }

  async *stream(options: StreamOptions): AsyncGenerator<StreamEvent> {
    // TODO: Implement Codex SDK thread-based streaming
    yield {
      conversationId: options.conversationId,
      type: 'text-delta',
      text: 'The Codex SDK runtime is registered but not yet fully implemented. Please switch to the Mastra runtime in Settings → Runtime.',
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
