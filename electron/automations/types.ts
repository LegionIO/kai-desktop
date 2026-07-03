import type { AutomationAction, AutomationCondition, AutomationRule } from '../config/schema.js';

export type { AutomationAction, AutomationCondition, AutomationRule };

export type AutomationEvent = {
  key: string;
  source: string;
  event: string;
  payload: unknown;
  ts: number;
  depth: number;
};

export type EventDescriptor = {
  event: string;
  title: string;
  description?: string;
  payloadSchema?: Record<string, unknown>;
};

export type ActionDescriptor = {
  targetId: string;
  title: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
};

export type SourceCatalogEntry = {
  source: string;
  displayName: string;
  events: EventDescriptor[];
  actions: ActionDescriptor[];
};

export type AutomationActionResult = {
  type: AutomationAction['type'];
  ok: boolean;
  output?: unknown;
  error?: string;
  durationMs: number;
};

export type AutomationRunRecord = {
  id: string;
  ruleId: string;
  ruleName: string;
  ts: number;
  event: { key: string; source: string; event: string; payload: unknown };
  matched: boolean;
  skippedReason?: 'debounce' | 'rate-limit' | 'conditions';
  results: AutomationActionResult[];
  error?: string;
};
