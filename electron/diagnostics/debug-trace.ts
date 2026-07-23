import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
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
const SECRET_KEY_RE =
  /(authorization|cookie|token|secret|password|passphrase|api[-_]?key|credential|session|(?:private|public|access|signing|encryption|auth|client|refresh|bearer)[-_]?key)/i;
// Content words matched anywhere in a key (camelCase, snake_case, or plain), so
// `body`, `messageBody`, `promptText`, `toolArgs`, `request_url` are all caught.
const CONTENT_WORD_RE = /(body|content|text|prompt|message|args|result|payload|response|url|uri|href|path|filename)/i;
// Metadata suffixes that make a key an ID/counter/timestamp, NOT content — these
// override the content-word match so branch-correlation data (messageId,
// parentMessageId, resultCount, …) is preserved in metadata-only mode. NOTE:
// `name` is deliberately NOT here — `filename` is a path, so it must stay a
// content key; safe identifier *Name keys are exact-allowlisted below instead.
const METADATA_SUFFIX_RE = /(id|ids|count|at|ms|len|length|bytes|chars|index|hash|status|kind|type)$/i;
function isContentKey(key: string): boolean {
  return CONTENT_WORD_RE.test(key) && !METADATA_SUFFIX_RE.test(key);
}
// Keys whose STRING values are safe identifiers/codes to keep in metadata-only
// mode. Everything else (arbitrary renderer/web `fields`) is omitted. Matches
// common identifier suffixes plus an exact allowlist. `name` is NOT a suffix
// match (would pass `filename`); safe *Name keys are listed exactly.
const SAFE_METADATA_KEY_RE =
  /(id|ids|hash|status|kind|type|scope|scopes|key|version|mode|stage|event|source|level|phase|role|state|trigger)$/i;
const SAFE_METADATA_KEY_EXACT = new Set([
  'correlationId',
  'parentCorrelationId',
  'conversationId',
  'runId',
  'messageId',
  'parentMessageId',
  'headId',
  'alertId',
  'ruleId',
  'pluginName',
  'toolName',
  'displayName',
  'modelName',
  'ts',
  'scope',
  'event',
  'level',
]);
function isSafeMetadataKey(key: string): boolean {
  return SAFE_METADATA_KEY_EXACT.has(key) || SAFE_METADATA_KEY_RE.test(key);
}
// Explicitly-safe categorical `reason`/`cause` codes. Anything not listed here is
// omitted in metadata-only mode (a free-text reason like runtimeSelection.reason
// can embed absolute plugin paths or raw scan errors).
const CATEGORICAL_REASONS = new Set([
  'alert-resume',
  'ordered-follower',
  'model-fallback',
  'disabled',
  'approval-required',
  'incompatible-strict',
  'missing-backend',
  'active-agent-stream',
  'no-primary-window',
  'reload-loop-guard',
  'renderer-not-loaded',
  'two-failed-health-probes',
  'window-destroyed-during-probe',
  'window-not-presented',
]);
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
  // embedded credentials — omit their message/stack in metadata-only mode. Match
  // the word anywhere (camelCase/plural: error, errors, metricsError, lastError).
  const isErrorKey = /(error|stack|exception|trace)/i.test(key);
  // `reason`/`cause` values are only safe when they are a KNOWN categorical code
  // (queued, disabled, reload-loop-guard, …). A short arbitrary reason string can
  // still embed a path or raw scan error (e.g. runtimeSelection.reason), so only
  // an allowlisted enum passes through; everything else is omitted.
  const isReasonKey = /(?:^|_)(reason|cause)$/i.test(key);
  if (!includeContent && isReasonKey) {
    if (typeof value === 'string' && CATEGORICAL_REASONS.has(value)) return value;
    if (typeof value === 'string') return { omitted: true, chars: value.length };
    if (value instanceof Error) return { omitted: true, name: value.name };
    return '[omitted]';
  }
  if (!includeContent && (isContentKey(key) || isErrorKey)) {
    if (value instanceof Error) return { omitted: true, name: value.name };
    if (typeof value === 'string') return { omitted: true, chars: value.length };
    if (Array.isArray(value)) return { omitted: true, items: value.length };
    if (value && typeof value === 'object') return { omitted: true, keys: Object.keys(value as object).length };
    return '[omitted]';
  }
  // Metadata-only default: strings are omitted UNLESS their key is an allowlisted
  // safe-metadata key (id/correlation/status/scope/type/name-style identifiers).
  // `debug:trace` accepts arbitrary renderer/web fields, so an unrecognized key
  // like `note`/`command`/`data` must not leak prose without content consent.
  if (!includeContent && typeof value === 'string' && !isSafeMetadataKey(key)) {
    return { omitted: true, chars: value.length };
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

function rotate(path: string, cfg: TraceConfig, addedBytes = 0): void {
  try {
    if (statSync(path).size + addedBytes <= cfg.maxFileBytes) return;
  } catch {
    // File doesn't exist yet: only the incoming record's bytes matter.
    if (addedBytes <= cfg.maxFileBytes) return;
  }
  // Drop rotated siblings of THIS trace file above the (possibly reduced) limit
  // so a lowered maxFiles is enforced promptly. Scoped to the trace basename so
  // unrelated *.jsonl.N logs in ~/.kai/logs are never touched.
  const baseName = basename(path);
  const siblingRe = new RegExp(`^${baseName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.(\\d+)$`);
  for (const name of readdirSync(dirname(path))) {
    const match = siblingRe.exec(name);
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
  const baseName = basename(path);
  const escaped = baseName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Only this trace file and its rotated siblings (baseName + baseName.N).
  const ownedRe = new RegExp(`^${escaped}(\\.(\\d+))?$`);
  const suffixRe = new RegExp(`^${escaped}\\.(\\d+)$`);
  try {
    for (const name of readdirSync(dirname(path))) {
      if (!ownedRe.test(name)) continue;
      const candidate = join(dirname(path), name);
      // Enforce the (possibly reduced) rotated-file count: drop suffixes >= limit.
      const match = suffixRe.exec(name);
      if (match && Number(match[1]) >= cfg.maxFiles) {
        try {
          rmSync(candidate, { force: true });
        } catch {
          /* best effort */
        }
        continue;
      }
      const isActive = name === baseName;
      try {
        const st = statSync(candidate);
        if (isActive) {
          // The active file's mtime is refreshed on every append, so use its
          // CREATION time — under low-volume tracing, old records would otherwise
          // never age out (size rotation could take years). When the active file
          // itself is older than maxAgeDays, ROTATE it (don't delete — it may hold
          // recent records too); the rotated sibling then ages out by mtime.
          const bornMs = Number.isFinite(st.birthtimeMs) && st.birthtimeMs > 0 ? st.birthtimeMs : st.mtimeMs;
          if (bornMs < cutoff) rotate(candidate, { ...cfg, maxFileBytes: 0 });
        } else if (st.mtimeMs < cutoff) {
          rmSync(candidate, { force: true });
        }
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
    const record = sanitize({ ts: new Date().toISOString(), ...event }, cfg.includeContent) as Record<string, unknown>;
    let line = `${JSON.stringify(record)}\n`;
    // Per-record cap: a single event with a large nested object/array must not
    // blow past maxFileBytes even though individual strings are capped. Cap a
    // record at min(1 MiB, half the file budget); replace an over-cap line with a
    // truncation marker carrying the correlation/scope/event for triage.
    const perRecordCap = Math.max(64 * 1024, Math.min(1024 * 1024, Math.floor(cfg.maxFileBytes / 2)));
    if (Buffer.byteLength(line, 'utf8') > perRecordCap) {
      line =
        `${JSON.stringify({
          ts: record.ts,
          scope: (record as { scope?: unknown }).scope,
          event: (record as { event?: unknown }).event,
          correlationId: (record as { correlationId?: unknown }).correlationId,
          truncated: true,
          bytes: Buffer.byteLength(line, 'utf8'),
        })}\n`;
    }
    // Rotate based on CURRENT size + this record's bytes so a single append can't
    // push the active file substantially over the budget.
    rotate(path, cfg, Buffer.byteLength(line, 'utf8'));
    appendFileSync(path, line, { encoding: 'utf8', mode: 0o600 });
  } catch {
    /* diagnostics must never affect app behavior */
  }
}
