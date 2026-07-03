import type { z } from 'zod';
import { convertJsonSchemaToZod } from '../tools/json-schema-zod.js';
import { broadcastToAllWindows } from '../utils/window-send.js';
import type { AutomationEvent, SourceCatalogEntry } from './types.js';

type Listener = (event: AutomationEvent) => void;

type CompiledValidator = { zod: z.ZodTypeAny; declaredKeys: string[] };

export class AutomationEventBus {
  private catalog = new Map<string, SourceCatalogEntry>();
  private listeners = new Set<Listener>();
  private validators = new Map<string, CompiledValidator>();

  registerSource(entry: SourceCatalogEntry): void {
    this.catalog.set(entry.source, entry);
    for (const key of this.validators.keys()) {
      if (key.startsWith(`${entry.source}:`)) this.validators.delete(key);
    }
    broadcastToAllWindows('automations:catalog-changed');
  }

  unregisterSource(source: string): void {
    if (this.catalog.delete(source)) {
      for (const key of this.validators.keys()) {
        if (key.startsWith(`${source}:`)) this.validators.delete(key);
      }
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
    const key = `${source}:${event}`;
    this.checkPayload(key, source, event, payload);

    const evt: AutomationEvent = {
      key,
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

  private compileValidator(source: string, event: string): CompiledValidator | null {
    const desc = this.catalog.get(source)?.events.find((e) => e.event === event);
    if (!desc?.payloadSchema) return null;
    try {
      const zod = convertJsonSchemaToZod(desc.payloadSchema);
      const props = desc.payloadSchema.properties;
      const declaredKeys = props && typeof props === 'object' ? Object.keys(props as Record<string, unknown>) : [];
      return { zod, declaredKeys };
    } catch (err) {
      console.warn(`[AutomationEventBus] failed to compile payloadSchema for ${source}:${event}:`, err);
      return null;
    }
  }

  private checkPayload(key: string, source: string, event: string, payload: unknown): void {
    let validator = this.validators.get(key) ?? null;
    if (validator === null) {
      validator = this.compileValidator(source, event);
      if (validator) this.validators.set(key, validator);
    }
    if (!validator) return;

    try {
      const parsed = validator.zod.safeParse(payload);
      if (!parsed.success) {
        console.warn(
          `[AutomationEventBus] ${key} payload does not match declared schema:`,
          parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; '),
        );
        return;
      }
      if (
        validator.declaredKeys.length > 0 &&
        payload &&
        typeof payload === 'object' &&
        !Array.isArray(payload) &&
        !validator.declaredKeys.some((k) => k in (payload as Record<string, unknown>))
      ) {
        console.warn(
          `[AutomationEventBus] ${key} payload has none of the declared fields (${validator.declaredKeys.join(', ')}); emitted keys: ${Object.keys(payload as Record<string, unknown>).join(', ') || '(none)'}`,
        );
      }
    } catch (err) {
      console.warn(`[AutomationEventBus] ${key} payload validation threw:`, err);
    }
  }
}

export const eventBus = new AutomationEventBus();
