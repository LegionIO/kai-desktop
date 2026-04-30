/**
 * Mastra agent runtime adapter.
 *
 * Wraps the existing `streamAgentResponse()` and `streamWithFallback()` from
 * `mastra-agent.ts` behind the `AgentRuntime` interface.  This adapter
 * introduces **zero** behavioral change — it delegates directly to the
 * existing Mastra code paths.
 */

import { join } from 'path';
import type { AgentRuntime, RuntimeCapabilities, StreamOptions, StreamEvent } from './types.js';
import { streamAgentResponse, streamWithFallback } from '../mastra-agent.js';
import { resolveStreamConfig } from '../model-catalog.js';
import { withWorkingDirectoryPrompt } from '../instructions.js';
import type { AppConfig } from '../../config/schema.js';

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

const MASTRA_CAPABILITIES: RuntimeCapabilities = {
  builtInTools: false, // Mastra workspace tools are created per-stream, not "built in" to the SDK
  mcpSupport: true,    // Kai connects MCP and passes tools to Mastra
  toolObserver: true,
  compaction: true,
  memory: true,
  fallback: true,
  multiProvider: true,
  subAgents: true,
  sessions: false,     // Mastra doesn't have session resume (Kai manages conversations)
  customTools: true,
};

// ---------------------------------------------------------------------------
// Runtime implementation
// ---------------------------------------------------------------------------

export class MastraRuntime implements AgentRuntime {
  readonly id = 'mastra' as const;
  readonly name = 'Mastra';
  readonly capabilities = MASTRA_CAPABILITIES;

  async isAvailable(): Promise<boolean> {
    // Mastra is always available — it's bundled.
    return true;
  }

  /**
   * Streams an agent response via Mastra.
   *
   * Accepts optional pre-resolved `streamConfig` and `primaryModel` from the
   * IPC layer.  When these are provided the runtime skips internal resolution
   * (avoiding duplicate catalog lookups).  When absent it falls back to
   * resolving from the raw `AppConfig`.
   */
  async *stream(options: StreamOptions): AsyncGenerator<StreamEvent> {
    const {
      conversationId,
      messages,
      config,
      tools,
      appHome,
      reasoningEffort,
      abortSignal,
      cwd,
      emitEvent,
      onToolExecutionStart,
      onToolExecutionEnd,
      augmentToolResult,
    } = options;

    // Use pre-resolved config when the IPC layer provides it, otherwise resolve
    const streamConfig = options.streamConfig ?? resolveStreamConfig(config, {
      threadModelKey: null,
      threadProfileKey: null,
      reasoningEffort,
      fallbackEnabled: false,
    });
    const primaryModel = options.primaryModel !== undefined
      ? options.primaryModel
      : streamConfig?.primaryModel ?? null;

    if (!primaryModel || !streamConfig) {
      yield {
        conversationId,
        type: 'text-delta',
        text: 'No model configured. Please add a model provider in Settings and ensure your API key is set.',
      };
      yield { conversationId, type: 'done' };
      return;
    }

    // Assemble system prompt with working directory + project instructions
    const assembledPrompt = await withWorkingDirectoryPrompt(
      streamConfig.systemPrompt,
      cwd,
    );

    const configForStream: AppConfig = {
      ...config,
      systemPrompt: assembledPrompt,
      systemPrompts: {
        ...config.systemPrompts,
        chat: assembledPrompt,
      },
      advanced: {
        ...config.advanced,
        temperature: streamConfig.temperature,
        maxSteps: streamConfig.maxSteps,
        maxRetries: streamConfig.maxRetries,
      },
    };

    const dbPath = join(appHome, 'data', 'memory.db');

    const streamOpts = {
      reasoningEffort,
      abortSignal,
      cwd,
      emitEvent,
      onToolExecutionStart,
      onToolExecutionEnd,
      augmentToolResult,
    };

    if (streamConfig.fallbackEnabled && streamConfig.fallbackModels.length > 0) {
      yield* streamWithFallback(
        conversationId,
        messages,
        streamConfig,
        configForStream,
        tools,
        dbPath,
        streamOpts,
      );
    } else {
      yield* streamAgentResponse(
        conversationId,
        messages,
        primaryModel.modelConfig,
        configForStream,
        tools,
        dbPath,
        streamOpts,
      );
    }
  }

  async generateTitle(
    _messages: unknown[],
    _config: AppConfig,
  ): Promise<string | null> {
    // Title generation is handled separately by the IPC layer for Mastra.
    // Returning null signals that the caller should use its own implementation.
    return null;
  }
}
