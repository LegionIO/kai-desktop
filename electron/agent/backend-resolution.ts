import type { ModelCatalogEntry } from './model-catalog.js';

/**
 * Resolves which agent backend key should be used for a given model catalog entry.
 * Currently all models use the Mastra backend.
 */
export function resolveAgentBackendKey(_entry: ModelCatalogEntry): string {
  return 'mastra';
}
