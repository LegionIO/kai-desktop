/**
 * Workspace Stream — direct LLM calls for workspace engines.
 *
 * Bypasses the full Mastra agent pipeline.  Uses the AI SDK's `streamText()`
 * directly while maintaining per-engine conversation history on the server
 * side.  The history key is (workspaceId + engine) — messages accumulate
 * across calls within the same session, and can be reset with `freshConversation`.
 *
 * For execution engines, tool support is enabled — the LLM can call file_read,
 * file_write, file_edit, sh, glob, grep, and list_directory.
 */

import type { IpcMain } from 'electron';
import { BrowserWindow } from 'electron';
import { streamText, stepCountIs } from 'ai';
import type { ModelMessage, ToolSet, Tool } from 'ai';
import { appendFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { readEffectiveConfig } from './config.js';
import { resolveModelForThread } from '../agent/model-catalog.js';
import { createLanguageModelFromConfig } from '../agent/language-model.js';

const LOG_FILE = '/tmp/kai-workspace-stream.log';
function log(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try { appendFileSync(LOG_FILE, line); } catch { /* ignore */ }
  console.info(`[workspace-stream] ${msg}`);
}
import { getRegisteredTools } from './agent.js';
import type { ToolDefinition, ToolExecutionContext } from '../tools/types.js';

// ── Active stream tracking (for cancellation) ─────────────────

const activeStreams = new Map<string, AbortController>();

// ── Conversation history (per workspace+engine pair) ──────────

type ConversationHistory = {
  systemPrompt: string;
  messages: ModelMessage[];
};

const conversationHistories = new Map<string, ConversationHistory>();

// Tools allowed for workspace execution (safe subset)
const EXECUTION_TOOL_NAMES = new Set([
  'file_read', 'file_write', 'file_edit',
  'sh', 'glob', 'grep', 'list_directory', 'file_search',
]);

function broadcast(channel: string, data: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, data);
    }
  }
}

/**
 * Convert a subset of Kai ToolDefinitions to AI SDK ToolSet for use with streamText().
 */
function buildWorkspaceToolSet(
  kaiTools: ToolDefinition[],
  opts: { streamId: string; cwd?: string; abortSignal?: AbortSignal },
): ToolSet {
  const toolSet: ToolSet = {};

  for (const kaiTool of kaiTools) {
    if (!EXECUTION_TOOL_NAMES.has(kaiTool.name)) continue;

    toolSet[kaiTool.name] = {
      description: kaiTool.description,
      inputSchema: kaiTool.inputSchema,
      execute: async (input: unknown) => {
        const ctx: ToolExecutionContext = {
          toolCallId: `ws-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          cwd: opts.cwd,
          abortSignal: opts.abortSignal,
          onProgress: (progress) => {
            broadcast('workspace:stream-event', {
              streamId: opts.streamId,
              type: 'tool-progress',
              toolName: kaiTool.name,
              data: progress,
            });
          },
        };
        try {
          return await kaiTool.execute(input, ctx);
        } catch (err) {
          // Don't let tool errors crash the entire stream — return error as text
          const msg = err instanceof Error ? err.message : String(err);
          log(`Tool ${kaiTool.name} error: ${msg}`);
          return `[Error] ${msg}`;
        }
      },
    } satisfies Tool;
  }

  return toolSet;
}

export function registerWorkspaceStreamHandlers(ipcMain: IpcMain, appHome: string): void {
  log('Registering workspace stream handlers');
  ipcMain.handle(
    'workspace:stream',
    async (
      _event,
      streamId: string,
      historyKey: string,
      messages: Array<{ role: string; content: string }>,
      modelKey?: string,
      freshConversation?: boolean,
      enableTools?: boolean,
    ) => {
      log(`Received: streamId=${streamId} historyKey=${historyKey} msgs=${messages?.length} fresh=${freshConversation} tools=${enableTools}`);
      try {
      // Cancel any existing stream with the same ID
      const existing = activeStreams.get(streamId);
      if (existing) existing.abort();

      const abortController = new AbortController();
      activeStreams.set(streamId, abortController);

      // Resolve model from config
      const config = readEffectiveConfig(appHome);
      const modelEntry = resolveModelForThread(config, modelKey ?? null);
      if (!modelEntry) {
        broadcast('workspace:stream-event', {
          streamId,
          type: 'error',
          error: 'No model configured. Please add a model in Settings.',
        });
        activeStreams.delete(streamId);
        return { streamId };
      }

      // ── Build conversation history ────────────────────────

      const systemMsg = messages.find((m) => m.role === 'system');
      const userMessages = messages.filter((m) => m.role !== 'system');

      let history = conversationHistories.get(historyKey);
      if (freshConversation || !history || (systemMsg && history.systemPrompt !== systemMsg.content)) {
        history = {
          systemPrompt: systemMsg?.content ?? '',
          messages: [],
        };
        conversationHistories.set(historyKey, history);
      }

      for (const msg of userMessages) {
        history.messages.push({
          role: msg.role as 'user' | 'assistant',
          content: msg.content,
        });
      }

      // ── Build tool set (only for execution engines) ───────

      // Extract cwd from the system prompt (project directory line)
      const cwdMatch = history.systemPrompt.match(/Project directory:\s*(.+)/);
      const cwd = cwdMatch?.[1]?.trim();

      const toolSet = enableTools
        ? buildWorkspaceToolSet(getRegisteredTools(), {
            streamId,
            cwd,
            abortSignal: abortController.signal,
          })
        : undefined;

      // Fire-and-forget: stream in background, return immediately
      (async () => {
        let assistantText = '';
        try {
          log(`Creating model: ${modelEntry.key} (${modelEntry.modelConfig.provider}/${modelEntry.modelConfig.modelName})`);
          const model = await createLanguageModelFromConfig(modelEntry.modelConfig);

          const hasTools = toolSet && Object.keys(toolSet).length > 0;
          log(`Starting streamText for ${streamId} with ${history.messages.length} messages, tools=${hasTools ? Object.keys(toolSet).join(',') : 'none'}`);

          const streamOpts: Parameters<typeof streamText>[0] = {
            model,
            system: history.systemPrompt || undefined,
            messages: history.messages,
            abortSignal: abortController.signal,
            temperature: modelEntry.modelConfig.temperature,
          };

          if (hasTools) {
            streamOpts.tools = toolSet;
            streamOpts.stopWhen = stepCountIs(50);
          }

          const result = streamText(streamOpts);

          // Use fullStream to capture tool events alongside text
          let inToolPhase = false;
          for await (const part of result.fullStream) {
            if (abortController.signal.aborted) break;

            switch (part.type) {
              case 'text-delta':
                // Skip text deltas during tool phases (some models emit garbage between tool calls)
                if (inToolPhase) break;
                assistantText += part.text;
                broadcast('workspace:stream-event', {
                  streamId,
                  type: 'text-delta',
                  text: part.text,
                });
                break;

              case 'tool-call':
                inToolPhase = true;
                broadcast('workspace:stream-event', {
                  streamId,
                  type: 'tool-call',
                  toolCallId: part.toolCallId,
                  toolName: part.toolName,
                  args: part.input,
                });
                break;

              case 'tool-result':
                inToolPhase = false;
                broadcast('workspace:stream-event', {
                  streamId,
                  type: 'tool-result',
                  toolCallId: part.toolCallId,
                  toolName: part.toolName,
                  result: typeof part.output === 'string'
                    ? part.output.slice(0, 2000)
                    : JSON.stringify(part.output).slice(0, 2000),
                });
                break;

              case 'start':
                // New agentic step — text is allowed again
                inToolPhase = false;
                log(`Step started for ${streamId}`);
                break;

              case 'finish-step':
                log(`Step finished for ${streamId}, finishReason=${(part as { finishReason?: string }).finishReason}`);
                break;

              // Ignore other part types (reasoning, etc.)
            }
          }

          if (!abortController.signal.aborted) {
            if (assistantText) {
              history!.messages.push({
                role: 'assistant',
                content: assistantText,
              });
            }

            broadcast('workspace:stream-event', {
              streamId,
              type: 'done',
            });
          }
        } catch (err) {
          log(`Error in stream ${streamId}: ${err instanceof Error ? err.message : String(err)}`);
          if (assistantText) {
            history!.messages.push({
              role: 'assistant',
              content: assistantText,
            });
          }

          if (abortController.signal.aborted) {
            // Cancelled by user — emit a distinct event so renderer knows
            broadcast('workspace:stream-event', {
              streamId,
              type: 'cancelled',
            });
          } else {
            const message = err instanceof Error ? err.message : String(err);
            broadcast('workspace:stream-event', {
              streamId,
              type: 'error',
              error: message,
            });
          }
        } finally {
          activeStreams.delete(streamId);
        }
      })();

      return { streamId };
    } catch (outerErr) {
        log(`Outer error for ${streamId}: ${outerErr instanceof Error ? outerErr.message : String(outerErr)}`);
        broadcast('workspace:stream-event', {
          streamId,
          type: 'error',
          error: outerErr instanceof Error ? outerErr.message : String(outerErr),
        });
        activeStreams.delete(streamId);
        return { streamId };
      }
    },
  );

  ipcMain.handle('workspace:cancel-stream', async (_event, streamId: string) => {
    const controller = activeStreams.get(streamId);
    if (controller) {
      controller.abort();
      activeStreams.delete(streamId);
    }
    return { ok: true };
  });

  ipcMain.handle('workspace:reset-history', async (_event, historyKey: string) => {
    conversationHistories.delete(historyKey);
    return { ok: true };
  });
}
