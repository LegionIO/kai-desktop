import { randomUUID } from 'node:crypto';
import type { AutomationRule, AutomationsConfig } from '../config/schema.js';
import { broadcastToAllWindows } from '../utils/window-send.js';
import type { ActionDeps } from './actions.js';
import { executeActions } from './actions.js';
import { evaluateConditions } from './conditions.js';
import type { AutomationEventBus } from './event-bus.js';
import type { AutomationEvent, AutomationRunRecord } from './types.js';

const MAX_EMIT_DEPTH = 4;

function jsonSafeValue(value: unknown): unknown {
  try {
    return JSON.parse(
      JSON.stringify(value, (_k, v) =>
        typeof v === 'bigint' ? v.toString() : typeof v === 'function' ? undefined : v,
      ) ?? 'null',
    );
  } catch {
    return '[unserializable]';
  }
}

function toJsonSafeRecord(record: AutomationRunRecord): AutomationRunRecord {
  return {
    ...record,
    event: { ...record.event, payload: jsonSafeValue(record.event.payload) },
    results: record.results.map((r) => ({ ...r, output: jsonSafeValue(r.output) })),
  };
}

export type EngineDeps = ActionDeps & {
  bus: AutomationEventBus;
  getAutomationsConfig: () => AutomationsConfig;
};

export class AutomationEngine {
  private rules: AutomationRule[] = [];
  private runLog: AutomationRunRecord[] = [];
  private lastFireAt = new Map<string, number>();
  private minuteBuckets = new Map<string, number[]>();
  private unsubscribe?: () => void;

  constructor(private readonly deps: EngineDeps) {}

  start(): void {
    this.reload(this.deps.getAutomationsConfig().rules);
    this.unsubscribe = this.deps.bus.subscribe((e) => {
      void this.onEvent(e);
    });
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  reload(rules: AutomationRule[]): void {
    this.rules = rules;
    const ids = new Set(rules.map((r) => r.id));
    for (const id of this.lastFireAt.keys()) if (!ids.has(id)) this.lastFireAt.delete(id);
    for (const id of this.minuteBuckets.keys()) if (!ids.has(id)) this.minuteBuckets.delete(id);
  }

  getRunLog(): AutomationRunRecord[] {
    return this.runLog;
  }

  async testRule(ruleId: string, samplePayload: unknown): Promise<AutomationRunRecord> {
    const rule = this.rules.find((r) => r.id === ruleId);
    if (!rule) {
      return {
        id: randomUUID(),
        ruleId,
        ruleName: '(unknown rule)',
        ts: Date.now(),
        event: { key: 'test', source: 'test', event: 'test', payload: samplePayload },
        matched: false,
        results: [],
        error: `Rule ${ruleId} not found`,
      };
    }
    const event: AutomationEvent = {
      key: `${rule.trigger.source}:${rule.trigger.event}`,
      source: rule.trigger.source,
      event: rule.trigger.event,
      payload: samplePayload,
      ts: Date.now(),
      depth: 0,
    };
    const record = await this.runRule(rule, event, { skipThrottle: true });
    this.pushLog(record);
    return record;
  }

  private async onEvent(event: AutomationEvent): Promise<void> {
    const cfg = this.deps.getAutomationsConfig();
    if (!cfg.enabled) return;
    if (event.depth > MAX_EMIT_DEPTH) {
      console.warn(`[AutomationEngine] dropping ${event.key}: emit chain depth ${event.depth} > ${MAX_EMIT_DEPTH}`);
      return;
    }

    for (const rule of this.rules) {
      if (!rule.enabled) continue;
      if (rule.trigger.source !== event.source || rule.trigger.event !== event.event) continue;
      const record = await this.runRule(rule, event, { skipThrottle: false });
      this.pushLog(record);
    }
  }

  private async runRule(
    rule: AutomationRule,
    event: AutomationEvent,
    opts: { skipThrottle: boolean },
  ): Promise<AutomationRunRecord> {
    const base = {
      id: randomUUID(),
      ruleId: rule.id,
      ruleName: rule.name,
      ts: Date.now(),
      event: { key: event.key, source: event.source, event: event.event, payload: event.payload },
      results: [] as AutomationRunRecord['results'],
    };

    let cond: ReturnType<typeof evaluateConditions>;
    try {
      cond = evaluateConditions(rule.conditions, rule.conditionMode, event.payload);
    } catch (err) {
      return {
        ...base,
        matched: false,
        skippedReason: 'conditions',
        error: err instanceof Error ? err.message : String(err),
      };
    }
    if (!cond.ok) {
      return {
        ...base,
        matched: false,
        skippedReason: 'conditions',
        error: cond.errors.length ? cond.errors.join('; ') : undefined,
      };
    }

    if (!opts.skipThrottle) {
      const now = Date.now();
      if (rule.debounceMs > 0) {
        const last = this.lastFireAt.get(rule.id) ?? 0;
        if (now - last < rule.debounceMs) {
          return { ...base, matched: false, skippedReason: 'debounce' };
        }
      }
      if (rule.rateLimitPerMinute) {
        const bucket = (this.minuteBuckets.get(rule.id) ?? []).filter((t) => now - t < 60_000);
        if (bucket.length >= rule.rateLimitPerMinute) {
          this.minuteBuckets.set(rule.id, bucket);
          return { ...base, matched: false, skippedReason: 'rate-limit' };
        }
        bucket.push(now);
        this.minuteBuckets.set(rule.id, bucket);
      }
      this.lastFireAt.set(rule.id, now);
    }

    try {
      return await executeActions(rule, event, this.deps);
    } catch (err) {
      return {
        ...base,
        matched: true,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private pushLog(record: AutomationRunRecord): void {
    const safe = toJsonSafeRecord(record);
    const max = this.deps.getAutomationsConfig().log.maxEntries;
    this.runLog.unshift(safe);
    if (this.runLog.length > max) this.runLog.length = max;
    broadcastToAllWindows('automations:run', safe);
  }
}

let engine: AutomationEngine | null = null;

export function initializeAutomationEngine(deps: EngineDeps): AutomationEngine {
  engine?.stop();
  engine = new AutomationEngine(deps);
  engine.start();
  return engine;
}

export function getAutomationEngine(): AutomationEngine | null {
  return engine;
}
