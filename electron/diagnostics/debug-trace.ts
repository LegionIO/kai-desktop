import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AppConfig } from '../config/schema.js';

export type DiagnosticTraceScope = 'agent' | 'automation' | 'alert' | 'plugin' | 'renderer' | 'window';
export type DiagnosticTraceLevel = 'metadata' | 'content';

export type DiagnosticTraceEvent = {
  scope: DiagnosticTraceScope;
  event: string;
  level?: 'debug' | 'info' | 'warn' | 'error';
  correlationId?: string;
  parentCorrelationId?: string;
  conversationId?: string;
  runId?: string;
  messageId?: string;
  parentMessageId?: string | null;
  headId?: string | null;
  alertId?: string;
  ruleId?: string;
  pluginName?: string;
  toolName?: string;
  fields?: Record<string, unknown>;
};

type TraceConfig = {
  enabled: boolean;
  includeContent: boolean;
  scopes: DiagnosticTraceScope[];
  maxFileBytes: number;
  maxFiles: number;
  maxAgeDays: number;
};

const DEFAULT_SCOPES: DiagnosticTraceScope[] = ['agent', 'automation', 'alert', 'plugin', 'renderer', 'window'];
const SECRET_KEY_RE = /(authorization|cookie|token|secret|password|api[-_]?key|credential|session)/i;
// Content fields only — deliberately NOT broad substrings, or metadata keys like
// messageId / parentMessageId would be omitted in the default mode (the exact
// branch-correlation data this trace exists to capture).
const CONTENT_KEY_RE = /(?:^|_)(body|content|text|prompt|message|args|result|payload|response|url|uri|href|path|filepath|filename)$/i;
const MAX_STRING = 4000;

let appHome = '';
let getConfig: (() => AppConfig) | null = null;
let cachedConfig: TraceConfig | null = null;

export function initDiagnosticTrace(home: string, configProvider: () => AppConfig): void {
  appHome = home;
  getConfig = configProvider;
  cachedConfig = null;
}

/** Invalidate the cached trace config (wired to every config write). */
export function invalidateDiagnosticTraceConfig(): void {
  cachedConfig = null;
}

export function newDiagnosticCorrelationId(prefix = 'trace'): string {
  return `${prefix}-${randomUUID()}`;
}

export function getDiagnosticTracePath(): string {
  return join(appHome, 'logs', 'diagnostic-trace.jsonl');
}

function config(): TraceConfig {
  // Cached because getConfig is readEffectiveConfig(APP_HOME) — a synchronous
  // disk read + zod parse — and the renderer can emit a trace call per
  // tool-progress delta. The cache is invalidated on every config write, so a
  // toggle from the Diagnostics UI takes effect immediately.
  if (cachedConfig) return cachedConfig;
  const raw = getConfig?.().diagnostics?.debugTrace;
  cachedConfig = {
    enabled: raw?.enabled ?? false,
    includeContent: raw?.includeContent ?? false,
    // An explicit empty array means "no scopes" (trace nothing) — do NOT treat
    // it as the default set. Only a missing/undefined value falls back.
    scopes: (raw?.scopes ?? DEFAULT_SCOPES) as DiagnosticTraceScope[],
    maxFileBytes: raw?.retention?.maxFileBytes ?? 10 * 1024 * 1024,
    maxFiles: raw?.retention?.maxFiles ?? 3,
    maxAgeDays: raw?.retention?.maxAgeDays ?? 7,
  };
  return cachedConfig;
}

export function isDiagnosticTraceEnabled(scope?: DiagnosticTraceScope): boolean {
  const cfg = config();
  return cfg.enabled && (!scope || cfg.scopes.includes(scope));
}

function sanitize(value: unknown, includeContent: boolean, key = '', depth = 0): unknown {
  if (depth > 6) return '[depth-limit]';
  if (SECRET_KEY_RE.test(key)) return '[redacted]';
  // Error details can carry provider response bodies, prompts, file paths, or
  // embedded credentials. In metadata-only mode surface just the shape/type, not
  // the message/stack. `error`/`stack` are treated as content keys.
  const isErrorKey = /(?:^|_)(error|stack|reason|cause)$/i.test(key);
  if (!includeContent && (CONTENT_KEY_RE.test(key) || isErrorKey)) {
    if (value instanceof Error) return { omitted: true, name: value.name };
    if (typeof value === 'string') return { omitted: true, chars: value.length };
    if (Array.isArray(value)) return { omitted: true, items: value.length };
    if (value && typeof value === 'object') return { omitted: true, keys: Object.keys(value as object).length };
    return '[omitted]';
  }
  if (typeof value === 'string') return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return value.slice(0, 100).map((entry) => sanitize(entry, includeContent, key, depth + 1));
  if (value instanceof Error)
    return includeContent
      ? { name: value.name, message: value.message, stack: value.stack?.slice(0, MAX_STRING) }
      : { name: value.name, omitted: true };
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [childKey, child] of Object.entries(value as Record<string, unknown>).slice(0, 100)) {
      out[childKey] = sanitize(child, includeContent, childKey, depth + 1);
    }
    return out;
  }
  return String(value);
}

function rotate(path: string, cfg: TraceConfig): void {
  try {
    if (statSync(path).size < cfg.maxFileBytes) return;
  } catch {
    return;
  }
  // Drop any rotated siblings above the (possibly reduced) limit so a lowered
  // maxFiles is enforced immediately rather than waiting for age pruning.
  for (const name of readdirSync(dirname(path))) {
    const match = /\.jsonl\.(\d+)$/.exec(name);
    if (match && Number(match[1]) >= cfg.maxFiles) {
      try {
        rmSync(join(dirname(path), name), { force: true });
      } catch {
        /* best effort */
      }
    }
  }
  if (cfg.maxFiles <= 1) {
    rmSync(path, { force: true });
    return;
  }
  for (let i = cfg.maxFiles - 1; i >= 1; i -= 1) {
    const src = i === 1 ? path : `${path}.${i - 1}`;
    const dst = `${path}.${i}`;
    try {
      if (i === cfg.maxFiles - 1) rmSync(dst, { force: true });
      renameSync(src, dst);
    } catch {
      /* absent */
    }
  }
}

function prune(path: string, cfg: TraceConfig): void {
  const cutoff = Date.now() - cfg.maxAgeDays * 24 * 60 * 60 * 1000;
  try {
    for (const name of readdirSync(dirname(path))) {
      if (!name.startsWith('diagnostic-trace.jsonl')) continue;
      const candidate = join(dirname(path), name);
      // Enforce the (possibly reduced) rotated-file count: drop suffixes >= limit.
      const match = /\.jsonl\.(\d+)$/.exec(name);
      if (match && Number(match[1]) >= cfg.maxFiles) {
        try {
          rmSync(candidate, { force: true });
        } catch {
          /* best effort */
        }
        continue;
      }
      try {
        if (statSync(candidate).mtimeMs < cutoff) rmSync(candidate, { force: true });
      } catch {
        /* best effort */
      }
    }
  } catch {
    /* absent */
  }
}

let lastRetentionSweep = 0;
const RETENTION_SWEEP_INTERVAL_MS = 5 * 60_000;

/** Age/count-prune existing trace files. Runs independently of whether tracing
 * is currently enabled, so files recorded before disabling still expire. */
export function sweepDiagnosticTraceRetention(): void {
  if (!appHome) return;
  try {
    prune(getDiagnosticTracePath(), config());
  } catch {
    /* best effort */
  }
}

export function traceDiagnostic(event: DiagnosticTraceEvent): void {
  const cfg = config();
  // Retention runs even when tracing is OFF (throttled), so traces recorded
  // before disabling still expire by maxAgeDays/maxFiles.
  const now = Date.now();
  if (appHome && now - lastRetentionSweep > RETENTION_SWEEP_INTERVAL_MS) {
    lastRetentionSweep = now;
    sweepDiagnosticTraceRetention();
  }
  if (!cfg.enabled || !cfg.scopes.includes(event.scope) || !appHome) return;
  const path = getDiagnosticTracePath();
  try {
    mkdirSync(dirname(path), { recursive: true });
    rotate(path, cfg);
    prune(path, cfg);
    const record = sanitize({ ts: new Date().toISOString(), ...event }, cfg.includeContent) as Record<string, unknown>;
    appendFileSync(path, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
  } catch {
    /* diagnostics must never affect app behavior */
  }
}
