import type { IpcMain } from 'electron';
import { join } from 'path';
import type { AppConfig } from '../config/schema.js';
import { getSharedMemory, getResourceId, testEmbeddingConnection } from '../agent/memory.js';

export function registerMemoryHandlers(ipcMain: IpcMain, appHome: string, getConfig: () => AppConfig): void {
  const dbPath = join(appHome, 'data', 'memory.db');

  ipcMain.handle(
    'memory:clear',
    async (
      _event,
      options: {
        working?: boolean;
        observational?: boolean;
        semantic?: boolean;
        all?: boolean;
      },
    ) => {
      const config = getConfig();
      const memory = getSharedMemory(config, dbPath);
      if (!memory) {
        return { error: 'Memory is not initialized. Enable memory in settings first.' };
      }

      const resourceId = getResourceId();
      const cleared: string[] = [];
      const failed: string[] = [];

      try {
        // Destructive flags are compared strictly to `true`: this clears user
        // memory, so a coerced/malformed payload (e.g. all:"false", all:1) must
        // NOT trigger a wider wipe than the caller intended.
        if (options?.all === true) {
          // Nuclear option — clear everything
          const store = await (
            memory as unknown as { storage: { getStore(name: string): Promise<unknown> } }
          ).storage.getStore('memory');
          const memStore = store as { dangerouslyClearAll(): Promise<void> };
          await memStore.dangerouslyClearAll();
          cleared.push('all memory stores');

          // Also clear vector indexes
          try {
            const vector = (
              memory as unknown as {
                vector?: {
                  listIndexes(): Promise<string[]>;
                  truncateIndex(opts: { indexName: string }): Promise<void>;
                };
              }
            ).vector;
            if (vector) {
              const indexes = await vector.listIndexes();
              for (const idx of indexes) {
                await vector.truncateIndex({ indexName: idx });
              }
              if (indexes.length > 0) cleared.push(`${indexes.length} vector index(es)`);
            }
          } catch (err) {
            console.error('[Memory] Failed to clear vector indexes:', err);
            failed.push('vector indexes');
          }

          return { success: failed.length === 0, cleared, ...(failed.length ? { failed } : {}) };
        }

        // Selective clearing
        if (options?.working === true) {
          try {
            // Clear resource-scoped working memory
            const store = await (
              memory as unknown as { storage: { getStore(name: string): Promise<unknown> } }
            ).storage.getStore('memory');
            const memStore = store as {
              updateResource(opts: { resourceId: string; workingMemory: string }): Promise<void>;
            };
            await memStore.updateResource({ resourceId, workingMemory: '' });
            cleared.push('working memory');
          } catch (err) {
            console.error('[Memory] Failed to clear working memory:', err);
            failed.push('working memory');
          }
        }

        if (options?.observational === true) {
          try {
            const store = await (
              memory as unknown as { storage: { getStore(name: string): Promise<unknown> } }
            ).storage.getStore('memory');
            const memStore = store as {
              clearObservationalMemory(threadId: string | null, resourceId: string): Promise<void>;
            };
            await memStore.clearObservationalMemory(null, resourceId);
            cleared.push('observational memory');
          } catch (err) {
            console.error('[Memory] Failed to clear observational memory:', err);
            failed.push('observational memory');
          }
        }

        if (options?.semantic === true) {
          try {
            const vector = (
              memory as unknown as {
                vector?: {
                  listIndexes(): Promise<string[]>;
                  truncateIndex(opts: { indexName: string }): Promise<void>;
                };
              }
            ).vector;
            if (vector) {
              const indexes = await vector.listIndexes();
              for (const idx of indexes) {
                await vector.truncateIndex({ indexName: idx });
              }
              cleared.push(`semantic recall (${indexes.length} index(es))`);
            } else {
              cleared.push('semantic recall (no vector store configured)');
            }
          } catch (err) {
            console.error('[Memory] Failed to clear semantic recall:', err);
            failed.push('semantic recall');
          }
        }

        return { success: failed.length === 0, cleared, ...(failed.length ? { failed } : {}) };
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
      }
    },
  );

  ipcMain.handle('memory:test-embedding', async () => {
    const config = getConfig();
    return testEmbeddingConnection(config);
  });
}
