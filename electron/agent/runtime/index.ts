/**
 * Agent runtime registry.
 *
 * Manages the set of available runtimes and resolves which one to use
 * for a given conversation based on the user's `agent.runtime` config.
 *
 * Fallback order for `'auto'` mode:
 *   Claude Agent SDK (if installed) → Mastra (always available)
 *
 * Codex SDK is registered but never auto-selected; the user must
 * explicitly choose it.
 */

import type { AgentRuntime, RuntimeId } from './types.js';
import type { AppConfig } from '../../config/schema.js';
import type { ModelCatalogEntry } from '../model-catalog.js';
import { resolveRuntimeForModel, type RuntimeResolution } from './model-runtime-compat.js';

// ---------------------------------------------------------------------------
// Registry state
// ---------------------------------------------------------------------------

const runtimes = new Map<RuntimeId, AgentRuntime>();

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/** Register a runtime adapter.  Overwrites any previous registration. */
export function registerRuntime(runtime: AgentRuntime): void {
  runtimes.set(runtime.id, runtime);
}

/** Retrieve a runtime by id (may be undefined). */
export function getRuntime(id: RuntimeId): AgentRuntime | undefined {
  return runtimes.get(id);
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the runtime to use for a given config.
 *
 * Algorithm:
 *   1. If user explicitly selected a runtime and it's available → use it.
 *   2. If `'auto'`: try Claude Agent SDK → Mastra.
 *   3. Fallback: Mastra (always present).
 */
export async function resolveRuntime(config: AppConfig): Promise<AgentRuntime> {
  const preferred: RuntimeId | 'auto' =
    (config as Record<string, unknown>).agent &&
    typeof ((config as Record<string, unknown>).agent as Record<string, unknown>)?.runtime === 'string'
      ? (((config as Record<string, unknown>).agent as Record<string, unknown>).runtime as RuntimeId | 'auto')
      : 'auto';

  if (preferred !== 'auto') {
    const runtime = runtimes.get(preferred);
    if (runtime && (await runtime.isAvailable())) {
      return runtime;
    }
    console.warn(`[Runtime] Requested runtime '${preferred}' is not available, falling back to Mastra.`);
    return getMastraOrThrow();
  }

  // Auto: prefer Claude Agent SDK if installed, then fall back to Mastra.
  const claudeSdk = runtimes.get('claude-agent-sdk');
  if (claudeSdk && (await claudeSdk.isAvailable())) {
    return claudeSdk;
  }

  return getMastraOrThrow();
}

function getMastraOrThrow(): AgentRuntime {
  const mastra = runtimes.get('mastra');
  if (!mastra) {
    throw new Error('[Runtime] Mastra runtime is not registered. This is a bug.');
  }
  return mastra;
}

// ---------------------------------------------------------------------------
// Model-aware resolution (for streaming)
// ---------------------------------------------------------------------------

/**
 * Resolve the runtime to use for a stream, taking the selected model into
 * account.  In `auto` mode the runtime is chosen based on the model's provider
 * type; in explicit mode it validates compatibility and may return a warning.
 *
 * This replaces `resolveRuntime()` in the stream handler.
 */
export async function resolveRuntimeForStream(
  config: AppConfig,
  model: ModelCatalogEntry | null,
): Promise<{ runtime: AgentRuntime; resolution: RuntimeResolution }> {
  const preferred: RuntimeId | 'auto' =
    (config as Record<string, unknown>).agent &&
    typeof ((config as Record<string, unknown>).agent as Record<string, unknown>)?.runtime === 'string'
      ? (((config as Record<string, unknown>).agent as Record<string, unknown>).runtime as RuntimeId | 'auto')
      : 'auto';

  // Build the set of currently available runtimes (built-ins only)
  const available = new Set<string>();
  for (const [id, rt] of runtimes) {
    if (await rt.isAvailable()) {
      available.add(id);
    }
  }
  // Mastra is always available
  available.add('mastra');

  const resolution = resolveRuntimeForModel(model, config, preferred, available);

  // Look up the runtime instance — unknown IDs fall through to Mastra
  const runtime = runtimes.get(resolution.runtimeId as RuntimeId);
  if (runtime) {
    return { runtime, resolution };
  }

  return { runtime: getMastraOrThrow(), resolution: { runtimeId: 'mastra' } };
}

// ---------------------------------------------------------------------------
// Introspection
// ---------------------------------------------------------------------------

/**
 * Returns a list of all registered runtimes with their availability status.
 * Used by the settings UI.
 */
export async function getAvailableRuntimes(): Promise<
  Array<{
    id: string;
    name: string;
    available: boolean;
    reason?: string;
    description?: string;
    executesUntrustedTools?: boolean;
  }>
> {
  const results: Array<{
    id: string;
    name: string;
    available: boolean;
    reason?: string;
    description?: string;
    executesUntrustedTools?: boolean;
  }> = [];

  for (const [, runtime] of runtimes) {
    const available = await runtime.isAvailable();
    results.push({
      id: runtime.id,
      name: runtime.name,
      available,
      executesUntrustedTools: runtime.capabilities.executesUntrustedTools,
      reason: available
        ? undefined
        : runtime.id === 'claude-agent-sdk'
          ? 'Claude Code CLI not found on PATH'
          : runtime.id === 'codex-sdk'
            ? 'Codex CLI not found on PATH'
            : runtime.id === 'pi'
              ? 'pi CLI not found on PATH'
              : undefined,
    });
  }

  return results;
}

/**
 * Returns the id of the runtime that would be selected for the given config.
 */
export async function getActiveRuntimeId(config: AppConfig): Promise<RuntimeId> {
  const runtime = await resolveRuntime(config);
  return runtime.id;
}
