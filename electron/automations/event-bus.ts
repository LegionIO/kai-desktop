import { broadcastToAllWindows } from '../utils/window-send.js';
import type { AutomationEvent, SourceCatalogEntry } from './types.js';

type Listener = (event: AutomationEvent) => void;

export class AutomationEventBus {
  private catalog = new Map<string, SourceCatalogEntry>();
  private listeners = new Set<Listener>();

  registerSource(entry: SourceCatalogEntry): void {
    this.catalog.set(entry.source, entry);
    broadcastToAllWindows('automations:catalog-changed');
  }

  unregisterSource(source: string): void {
    if (this.catalog.delete(source)) {
      broadcastToAllWindows('automations:catalog-changed');
    }
  }

  getCatalog(): SourceCatalogEntry[] {
    return Array.from(this.catalog.values());
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(source: string, event: string, payload?: unknown, depth = 0): void {
    const evt: AutomationEvent = {
      key: `${source}:${event}`,
      source,
      event,
      payload,
      ts: Date.now(),
      depth,
    };

    for (const listener of this.listeners) {
      try {
        listener(evt);
      } catch (err) {
        console.error('[AutomationEventBus] listener threw', err);
      }
    }

    // Preserve the pre-existing renderer contract: plugin-sourced events continue
    // to arrive on the `plugin:event` channel with the bare plugin name.
    if (source.startsWith('plugin.')) {
      broadcastToAllWindows('plugin:event', {
        pluginName: source.slice('plugin.'.length),
        eventName: event,
        data: payload,
      });
    }
  }
}

export const eventBus = new AutomationEventBus();
