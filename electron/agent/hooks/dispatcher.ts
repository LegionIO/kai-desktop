import { spawn } from 'node:child_process';
import type { AppConfig, AutomationRule } from '../../config/schema.js';
import { eventBus } from '../../automations/event-bus.js';
import { evaluateConditions } from '../../automations/conditions.js';

/* ───────────────────────── Types ───────────────────────── */

export type HookEvent =
  | 'UserPromptSubmit'
  | 'PreToolUse'
  | 'PostToolUse'
  | 'AssistantMessage'
  | 'AgentStop'
  | 'ConversationStart';

export const HOOK_EVENTS: readonly HookEvent[] = [
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'AssistantMessage',
  'AgentStop',
  'ConversationStart',
] as const;

/**
 * True when an automation rule's trigger would receive hook events — source is
 * `hook` or wildcard `*`, AND the event is `*` or a concrete hook event. Such
 * rules can read raw prompts / tool args / tool results off the automation bus.
 */
export function ruleTriggersOnHookEvents(rule: unknown): boolean {
  if (!rule || typeof rule !== 'object') return false;
  const trigger = (rule as { trigger?: { source?: unknown; event?: unknown } }).trigger;
  if (!trigger) return false;
  const { source, event } = trigger;
  if (source !== 'hook' && source !== '*') return false;
  return event === '*' || (typeof event === 'string' && (HOOK_EVENTS as readonly string[]).includes(event));
}

/**
 * Events whose dispatch is AWAITED and can act on a block/modify result.
 * The others (AssistantMessage, AgentStop, ConversationStart) are fire-and-
 * forget, so block/modify there is meaningless and gets coerced to observe.
 */
const ENFORCING_HOOK_EVENTS = new Set<HookEvent>(['UserPromptSubmit', 'PreToolUse', 'PostToolUse']);

export type HookMode = 'observe' | 'block' | 'modify';

export type HookOutcome = {
  decision?: 'allow' | 'deny';
  reason?: string;
  /** Replacement payload — only honored when the registration mode is 'modify'. */
  payload?: unknown;
};

export type HookHandler = (payload: unknown) => Promise<HookOutcome | void> | HookOutcome | void;

export type HookRegistrationOptions = {
  mode?: HookMode;
  /**
   * Glob-ish matcher against `payload.toolName` (PreToolUse / PostToolUse only).
   * Supports `*` wildcards; a bare string is an exact match. Omitted = match all.
   */
  matcher?: string;
};

type HookRegistration = {
  source: 'plugin' | 'user';
  pluginId?: string;
  mode: HookMode;
  matcher?: string;
  handler: HookHandler;
  /**
   * For user (automation-rule) shell hooks: the rule id and its throttle limits.
   * Throttling is applied once per rule per dispatch in the dispatch loop, so a
   * rule with multiple actions doesn't have the first action consume the budget.
   */
  ruleId?: string;
  debounceMs?: number;
  rateLimitPerMinute?: number;
  /**
   * Optional gate evaluated (with the payload) BEFORE throttling in the dispatch
   * loop. Used by user shell hooks to check the rule's conditions first, so a
   * non-matching rule doesn't consume its throttle budget (matches the engine's
   * conditions-then-throttle order).
   */
  conditionGate?: (payload: unknown) => boolean;
};

export type DispatchResult<T = unknown> = {
  payload: T;
  denied: boolean;
  reason?: string;
};

/* ───────────────────────── Helpers ───────────────────────── */

const DEFAULT_TIMEOUT_MS = 5000;

function matchesToolName(matcher: string | undefined, toolName: string | undefined): boolean {
  if (!matcher) return true;
  if (!toolName) return false;
  if (matcher === '*') return true;
  // Escape regex specials, then convert `*` → `.*`
  const escaped = matcher.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  try {
    return new RegExp(`^${escaped}$`).test(toolName);
  } catch {
    return matcher === toolName;
  }
}

function extractToolName(payload: unknown): string | undefined {
  if (payload && typeof payload === 'object' && 'toolName' in payload) {
    const value = (payload as { toolName?: unknown }).toolName;
    return typeof value === 'string' ? value : undefined;
  }
  return undefined;
}

/**
 * Validate a `modify` hook's replacement payload for an enforcing event. The
 * caller applies a specific field per event, so a replacement that omits it
 * would leave the caller using the ORIGINAL raw data (fail-open). Require the
 * field to be present with a plausible type; otherwise the dispatch fails closed.
 *  - UserPromptSubmit → `messages` array (systemPrompt is optional)
 *  - PreToolUse       → `args` object (the only field the caller applies)
 *  - PostToolUse      → `result` present (the only field the caller applies —
 *                        args-only replacements would be silently ignored → a
 *                        fail-open, so they are rejected)
 */
function isUsableModifyReplacement(event: HookEvent, replacement: unknown): boolean {
  if (replacement === undefined || replacement === null || typeof replacement !== 'object') return false;
  const r = replacement as Record<string, unknown>;
  switch (event) {
    case 'UserPromptSubmit':
      return Array.isArray(r.messages);
    case 'PreToolUse':
      return typeof r.args === 'object' && r.args !== null && !Array.isArray(r.args);
    case 'PostToolUse':
      // Require a DEFINED result — callers only apply `result` when it is not
      // undefined, so `{ result: undefined }` (key present) would fail open.
      return 'result' in r && r.result !== undefined;
    default:
      // Non-enforcing events don't reach the modify path (coerced to observe),
      // but be permissive if they somehow do.
      return true;
  }
}

const MAX_HOOK_PAYLOAD_BYTES = 256 * 1024;

/**
 * Serialize a hook payload to a JSON-safe value. When `truncate` is true
 * (observe fan-out to the event bus) an oversized payload is replaced with an
 * id-only stub to avoid forwarding multi-MB blobs to every automation. For
 * block/modify shell hooks we pass the FULL payload (truncate=false) — a DLP
 * scanner must see the whole content, or it could be bypassed by large input.
 */
function jsonSafe(value: unknown, truncate = true): unknown {
  try {
    const serialized =
      JSON.stringify(value, (_k, v) => (typeof v === 'function' || typeof v === 'bigint' ? undefined : v)) ?? 'null';
    if (truncate && serialized.length > MAX_HOOK_PAYLOAD_BYTES) {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const v = value as Record<string, unknown>;
        return {
          ...(typeof v.conversationId === 'string' ? { conversationId: v.conversationId } : {}),
          ...(typeof v.toolName === 'string' ? { toolName: v.toolName } : {}),
          ...(typeof v.toolCallId === 'string' ? { toolCallId: v.toolCallId } : {}),
          _truncated: true,
          _bytes: serialized.length,
        };
      }
      return { _truncated: true, _bytes: serialized.length };
    }
    return JSON.parse(serialized);
  } catch {
    return null;
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Run a user-configured shell hook.
 *
 * Contract:
 *  - The event payload is written to the child's stdin as a single JSON object:
 *      `{ "event": "<HookEvent>", "payload": <payload> }`
 *  - `observe` mode: exit code and output are ignored.
 *  - `block` mode: a non-zero exit code denies the action; stderr (or stdout if
 *    stderr is empty) is surfaced as the deny `reason`.
 *  - `modify` mode: stdout must be JSON of the shape `{ "payload": <replacement> }`.
 *    A non-zero exit is treated as a deny (same as `block`).
 */
const MAX_HOOK_OUTPUT_BYTES = 64 * 1024;

function runShellHook(
  event: HookEvent,
  command: string,
  mode: HookMode,
  payload: unknown,
  timeoutMs: number,
): Promise<HookOutcome | void> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const detached = process.platform !== 'win32';

    const child = spawn(command, {
      shell: true,
      detached,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, KAI_HOOK_EVENT: event },
    });

    const killTree = (): void => {
      try {
        if (detached && typeof child.pid === 'number') {
          process.kill(-child.pid, 'SIGKILL');
        } else {
          child.kill('SIGKILL');
        }
      } catch {
        /* ignore */
      }
    };

    const settle = (outcome: HookOutcome | void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };

    const timer = setTimeout(() => {
      killTree();
      if (mode === 'observe') return settle(undefined);
      settle({ decision: 'deny', reason: `hook command timed out after ${timeoutMs}ms` });
    }, timeoutMs);

    child.stdout?.on('data', (d: Buffer) => {
      if (stdout.length < MAX_HOOK_OUTPUT_BYTES) {
        stdout += d.toString('utf8');
        if (stdout.length > MAX_HOOK_OUTPUT_BYTES) stdout = stdout.slice(0, MAX_HOOK_OUTPUT_BYTES);
      }
    });
    child.stderr?.on('data', (d: Buffer) => {
      if (stderr.length < MAX_HOOK_OUTPUT_BYTES) {
        stderr += d.toString('utf8');
        if (stderr.length > MAX_HOOK_OUTPUT_BYTES) stderr = stderr.slice(0, MAX_HOOK_OUTPUT_BYTES);
      }
    });
    child.on('error', (err) => {
      if (mode === 'observe') return settle(undefined);
      settle({ decision: 'deny', reason: `hook command failed to spawn: ${err.message}` });
    });
    child.on('close', (code) => {
      if (mode === 'observe') return settle(undefined);
      if (code !== 0) {
        return settle({ decision: 'deny', reason: (stderr || stdout || `exit code ${code}`).trim().slice(0, 2000) });
      }
      if (mode === 'modify') {
        const trimmed = stdout.trim();
        // A modify hook that produces no usable replacement fails CLOSED — for a
        // DLP/sanitizer this prevents the unmodified payload from passing through.
        if (!trimmed) {
          return settle({ decision: 'deny', reason: 'modify hook produced no output; failing closed.' });
        }
        try {
          const parsed = JSON.parse(trimmed) as unknown;
          // Must be a non-null object to be a valid HookOutcome; a bare JSON
          // primitive (e.g. `"redacted"`, `true`) is malformed → fail closed.
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return settle({ decision: 'deny', reason: 'modify hook output was not a JSON object; failing closed.' });
          }
          const obj = parsed as Record<string, unknown>;
          // An explicit deny is honored. Otherwise a modify hook MUST return a
          // `payload` — `{}` or `{"decision":"allow"}` with no payload would
          // otherwise let the original unmodified data through (fail-open). So
          // require the replacement payload; absent it, fail CLOSED.
          if (obj.decision === 'deny') {
            return settle({ decision: 'deny', reason: typeof obj.reason === 'string' ? obj.reason : undefined });
          }
          if (!('payload' in obj) || obj.payload === undefined) {
            return settle({
              decision: 'deny',
              reason: 'modify hook returned no replacement payload; failing closed.',
            });
          }
          return settle(obj as HookOutcome);
        } catch (err) {
          console.warn(`[hooks] modify hook stdout was not valid JSON (${command}):`, err);
          return settle({ decision: 'deny', reason: 'modify hook output was not valid JSON; failing closed.' });
        }
      }
      settle({ decision: 'allow' });
    });

    try {
      // A hook that never reads stdin (e.g. `true`, a notifier) can trigger an
      // async EPIPE on this stream after we've returned; swallow it so it can't
      // crash the main process.
      child.stdin?.on('error', () => {});
      // Enforcing (block/modify) hooks must see the full payload — never a
      // truncated id-only stub, or a DLP scanner could be bypassed by large
      // input. observe hooks get the size-capped stub.
      const stdinPayload = jsonSafe(payload, mode === 'observe');
      child.stdin?.write(JSON.stringify({ event, payload: stdinPayload }));
      child.stdin?.end();
    } catch {
      /* ignore — broken pipe when child exits fast */
    }
  });
}

/* ───────────────────────── Dispatcher ───────────────────────── */

type DispatcherOptions = {
  getConfig?: () => AppConfig;
};

export class HookDispatcher {
  private readonly registry = new Map<HookEvent, HookRegistration[]>();
  private getConfig: (() => AppConfig) | undefined;
  private userHookFingerprint = '';
  // Per-rule throttle state for user shell hooks, mirroring AutomationEngine so
  // a rule's debounceMs / rateLimitPerMinute apply on the hook path too.
  private readonly ruleLastFireAt = new Map<string, number>();
  private readonly ruleMinuteBuckets = new Map<string, number[]>();
  // A monotonic id stamped on each dispatch() so all handlers of the SAME rule
  // fired within one dispatch share a single throttle decision (a rule with
  // multiple runHookCommand actions must not have the first action consume the
  // budget and starve the rest — that could fail a later block/modify open).
  private dispatchSeq = 0;
  private readonly ruleThrottleDecision = new Map<string, { seq: number; throttled: boolean }>();

  configure(opts: DispatcherOptions): void {
    if (opts.getConfig) this.getConfig = opts.getConfig;
  }

  /**
   * True when at least one block/modify tool hook (plugin- or user-configured)
   * is active for PreToolUse/PostToolUse. Used to warn when the selected
   * runtime does not enforce hooks, so a DLP/deny policy can't silently no-op.
   */
  hasEnforcingToolHooks(): boolean {
    const cfg = this.safeConfig();
    if (cfg && (cfg.hooks?.enabled ?? true)) this.syncUserHooks(cfg);
    if (!(cfg?.hooks?.enabled ?? true)) return false;
    for (const event of ['PreToolUse', 'PostToolUse'] as const) {
      const list = this.registry.get(event) ?? [];
      if (list.some((r) => r.mode === 'block' || r.mode === 'modify')) return true;
    }
    return false;
  }

  /**
   * True when at least one block/modify (enforcing) hook is active for a given
   * event. Used to decide whether an auxiliary model call (e.g. title
   * generation) must be gated through that event's enforcement too.
   */
  hasEnforcingHooksFor(event: HookEvent): boolean {
    const cfg = this.safeConfig();
    if (cfg && (cfg.hooks?.enabled ?? true)) this.syncUserHooks(cfg);
    if (!(cfg?.hooks?.enabled ?? true)) return false;
    if (!ENFORCING_HOOK_EVENTS.has(event)) return false;
    const list = this.registry.get(event) ?? [];
    return list.some((r) => r.mode === 'block' || r.mode === 'modify');
  }

  /**
   * Register a hook handler. Returns an unregister function.
   * Plugin registrations run before user (shell) registrations so DLP /
   * sanitization plugins see raw data.
   */
  register(
    event: HookEvent,
    handler: HookHandler,
    opts: HookRegistrationOptions & {
      source?: 'plugin' | 'user';
      pluginId?: string;
      ruleId?: string;
      debounceMs?: number;
      rateLimitPerMinute?: number;
      conditionGate?: (payload: unknown) => boolean;
    } = {},
  ): () => void {
    const reg: HookRegistration = {
      source: opts.source ?? 'plugin',
      pluginId: opts.pluginId,
      mode: opts.mode ?? 'observe',
      matcher: opts.matcher,
      handler,
      ruleId: opts.ruleId,
      debounceMs: opts.debounceMs,
      rateLimitPerMinute: opts.rateLimitPerMinute,
      conditionGate: opts.conditionGate,
    };
    const list = this.registry.get(event) ?? [];
    list.push(reg);
    this.registry.set(event, list);
    return () => {
      const current = this.registry.get(event);
      if (!current) return;
      const idx = current.indexOf(reg);
      if (idx >= 0) current.splice(idx, 1);
    };
  }

  /** Drop every registration originating from a given plugin. */
  unregisterPlugin(pluginId: string): void {
    for (const list of this.registry.values()) {
      for (let i = list.length - 1; i >= 0; i--) {
        if (list[i].source === 'plugin' && list[i].pluginId === pluginId) list.splice(i, 1);
      }
    }
  }

  /**
   * Dispatch a hook event through all matching registrations.
   * Order: plugin hooks first, then user hooks. `observe` handlers are
   * fire-and-forget; `block`/`modify` are awaited under `hooks.timeoutMs`.
   * Also emits on the automation event bus so non-hook automation actions
   * (notifications, agent runs, …) can react to lifecycle events in
   * observe-only fashion.
   */
  async dispatch<T = unknown>(
    event: HookEvent,
    payload: T,
    opts?: { suppressObserve?: boolean },
  ): Promise<DispatchResult<T>> {
    const cfg = this.safeConfig();
    const enabled = cfg?.hooks?.enabled ?? true;
    const timeoutMs = cfg?.hooks?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    if (!enabled) return { payload, denied: false };

    if (cfg) this.syncUserHooks(cfg);

    // New dispatch cycle: rule-level throttle decisions are memoized against
    // this id so every handler of the same rule shares one decision.
    const dispatchId = ++this.dispatchSeq;

    const list = this.registry.get(event) ?? [];

    // Observe-only fan-out to the automation engine. Emits the FINAL (post-
    // enforcement) payload and is skipped on deny, so a low-permission event
    // subscriber never sees raw data that a DLP block/modify hook removed.
    // `suppressObserve` skips the fan-out entirely — used for auxiliary calls
    // (e.g. title generation) that must run ENFORCEMENT only and must not
    // re-trigger the user's automations for the same prompt.
    const emitObserve = (finalPayload: T): void => {
      if (opts?.suppressObserve) return;
      if (!eventBus.hasListeners()) return;
      try {
        eventBus.emit('hook', event, jsonSafe(finalPayload));
      } catch (err) {
        console.warn('[hooks] event bus emit failed:', err);
      }
    };

    if (list.length === 0) {
      emitObserve(payload);
      return { payload, denied: false };
    }

    const ordered = [...list].sort((a, b) => (a.source === b.source ? 0 : a.source === 'plugin' ? -1 : 1));
    const toolName = extractToolName(payload);
    let current = payload;

    for (const reg of ordered) {
      if ((event === 'PreToolUse' || event === 'PostToolUse') && !matchesToolName(reg.matcher, toolName)) {
        continue;
      }

      // User shell hooks carry their rule's throttle. Decide ONCE per rule per
      // dispatch (memoized on dispatchId) so a rule with multiple actions
      // doesn't have the first action consume the budget and skip the rest.
      // Evaluate the rule's conditions FIRST so a non-matching rule doesn't
      // consume its throttle budget (matches the engine's ordering).
      //
      // suppressObserve marks an ENFORCEMENT-ONLY auxiliary dispatch (e.g. title
      // generation, sub-agent gating). Such calls must still apply block/modify
      // enforcement, but must NOT consume the shell hook's throttle budget —
      // otherwise an auxiliary dispatch could exhaust a UserPromptSubmit rule's
      // rate-limit and cause the real chat prompt to be throttled past the DLP
      // hook (raw prompt leaks). So we skip the throttle check (no bucket
      // advancement) for suppressObserve dispatches and let enforcement proceed.
      if (reg.source === 'user' && reg.ruleId) {
        if (reg.conditionGate && !reg.conditionGate(current)) continue;
        if (
          !opts?.suppressObserve &&
          this.isRuleThrottled(reg.ruleId, reg.debounceMs ?? 0, reg.rateLimitPerMinute, dispatchId)
        ) {
          continue;
        }
      }

      // block/modify are only meaningful for awaited (enforcing) events; for
      // fire-and-forget events, downgrade to observe regardless of source so a
      // plugin can't deny/short-circuit (and suppress the observe fan-out).
      const effectiveMode = ENFORCING_HOOK_EVENTS.has(event) ? reg.mode : 'observe';

      if (effectiveMode === 'observe') {
        // suppressObserve → enforcement-only dispatch (e.g. title generation):
        // skip observe handlers too, so their side effects don't fire for the
        // auxiliary call.
        if (opts?.suppressObserve) continue;
        void Promise.resolve()
          .then(() => reg.handler(current))
          .catch((err) => console.warn(`[hooks] observe handler for ${event} threw:`, err));
        continue;
      }

      let outcome: HookOutcome | void;
      try {
        outcome = await withTimeout(
          Promise.resolve(reg.handler(current)),
          timeoutMs,
          `[hooks] ${reg.source} ${event} handler`,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[hooks] ${effectiveMode} handler for ${event} failed: ${message}`);
        // Both block and modify fail CLOSED: a sanitizer/DLP modify hook that
        // throws or times out must not let the unmodified payload through.
        // Denied → NOT fanned out to observers.
        return {
          payload: current,
          denied: true,
          reason: `${effectiveMode} hook failed (${message}); failing closed to avoid leaking unmodified data.`,
        };
      }

      if (outcome?.decision === 'deny') {
        return { payload: current, denied: true, reason: outcome.reason };
      }
      if (effectiveMode === 'modify') {
        // A modify hook MUST return a replacement payload that carries the field
        // the caller will actually apply for this event. If it returns nothing
        // usable (e.g. `{}` or `{payload:{}}` missing messages/args/result), the
        // caller would silently fall back to the ORIGINAL raw data — a fail-open
        // for a DLP/sanitizer. Reject such replacements: fail CLOSED (deny).
        const replacement =
          outcome && typeof outcome === 'object' && 'payload' in outcome ? outcome.payload : undefined;
        if (!isUsableModifyReplacement(event, replacement)) {
          return {
            payload: current,
            denied: true,
            reason: `modify hook for ${event} returned no usable replacement (missing the expected field); failing closed to avoid leaking unmodified data.`,
          };
        }
        current = replacement as T;
      }
    }

    emitObserve(current);
    return { payload: current, denied: false };
  }

  /* ── User (shell) hooks — sourced from automations config ── */

  private safeConfig(): AppConfig | undefined {
    try {
      return this.getConfig?.();
    } catch {
      return undefined;
    }
  }

  /**
   * Rebuild the user-hook layer from `config.automations.rules`. A rule
   * contributes a user hook when its trigger is `hook:<HookEvent>` and it has
   * one or more `runHookCommand` actions. Other action types on `hook:*`
   * triggers are handled by the automation engine via the event-bus emit above.
   */
  /**
   * True when a user hook rule is currently throttled by its own `debounceMs`
   * or `rateLimitPerMinute`. Mirrors AutomationEngine's throttle so the same
   * limits apply whether a rule fires via the engine or via this hook path.
   * The decision is memoized per `dispatchId` so all of a rule's actions in one
   * dispatch share a single decision (and only one advances the counters).
   */
  private isRuleThrottled(
    ruleId: string,
    debounceMs: number,
    rateLimitPerMinute: number | undefined,
    dispatchId: number,
  ): boolean {
    const cached = this.ruleThrottleDecision.get(ruleId);
    if (cached && cached.seq === dispatchId) return cached.throttled;

    const now = Date.now();
    let throttled = false;
    if (debounceMs > 0) {
      const last = this.ruleLastFireAt.get(ruleId) ?? 0;
      if (now - last < debounceMs) throttled = true;
    }
    if (!throttled && rateLimitPerMinute) {
      const bucket = (this.ruleMinuteBuckets.get(ruleId) ?? []).filter((t) => now - t < 60_000);
      if (bucket.length >= rateLimitPerMinute) {
        this.ruleMinuteBuckets.set(ruleId, bucket);
        throttled = true;
      } else {
        bucket.push(now);
        this.ruleMinuteBuckets.set(ruleId, bucket);
      }
    }
    if (!throttled) this.ruleLastFireAt.set(ruleId, now);
    this.ruleThrottleDecision.set(ruleId, { seq: dispatchId, throttled });
    return throttled;
  }

  private syncUserHooks(config: AppConfig): void {
    const automationsEnabled = config.automations?.enabled !== false;
    const rules: AutomationRule[] = config.automations?.rules ?? [];
    // A rule contributes user hooks when its trigger subscribes to hook events:
    // source 'hook' or wildcard '*', and event is a specific hook event or '*'.
    const targetsHook = (r: AutomationRule): boolean =>
      (r.trigger.source === 'hook' || r.trigger.source === '*') &&
      (r.trigger.event === '*' || (HOOK_EVENTS as readonly string[]).includes(r.trigger.event));
    const relevant = automationsEnabled ? rules.filter((r) => r.enabled && targetsHook(r)) : [];
    // The concrete hook events a rule maps to (wildcard event → all events).
    const eventsFor = (r: AutomationRule): HookEvent[] =>
      r.trigger.event === '*' ? [...HOOK_EVENTS] : [r.trigger.event as HookEvent];
    const timeoutMs = config.hooks?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const fingerprint = JSON.stringify([
      timeoutMs,
      automationsEnabled,
      relevant.map((r) => [
        r.id,
        r.trigger.source,
        r.trigger.event,
        r.conditions,
        r.conditionMode,
        r.debounceMs,
        r.rateLimitPerMinute ?? 0,
        r.actions
          .filter((a): a is Extract<typeof a, { type: 'runHookCommand' }> => a.type === 'runHookCommand')
          .map((a) => [a.command, a.mode, a.matcher ?? '']),
      ]),
    ]);
    if (fingerprint === this.userHookFingerprint) return;
    this.userHookFingerprint = fingerprint;

    // Drop existing user registrations, then rebuild.
    for (const list of this.registry.values()) {
      for (let i = list.length - 1; i >= 0; i--) {
        if (list[i].source === 'user') list.splice(i, 1);
      }
    }

    for (const rule of relevant) {
      // A wildcard-event rule registers against every concrete hook event.
      for (const event of eventsFor(rule)) {
        // Only PreToolUse/PostToolUse/UserPromptSubmit are awaited and can act
        // on a block/modify result. The rest are fire-and-forget, so coerce
        // their mode to observe — a block/modify there would silently do nothing.
        const mode0 = (m: HookMode): HookMode => (ENFORCING_HOOK_EVENTS.has(event) ? m : 'observe');
        for (const action of rule.actions) {
          if (action.type !== 'runHookCommand') continue;
          const { command, matcher } = action;
          const mode = mode0(action.mode);
          const conditionGate = (payload: unknown): boolean => {
            try {
              return evaluateConditions(rule.conditions, rule.conditionMode, payload).ok;
            } catch {
              return false;
            }
          };
          const handler = (payload: unknown): Promise<HookOutcome | void> | void => {
            // Conditions + throttling are checked in the dispatch loop before
            // this runs (conditions first, so a non-matching rule doesn't consume
            // its throttle budget).
            return runShellHook(event, command, mode, payload, timeoutMs);
          };
          this.register(event, handler, {
            source: 'user',
            mode,
            matcher,
            ruleId: rule.id,
            debounceMs: rule.debounceMs,
            rateLimitPerMinute: rule.rateLimitPerMinute,
            conditionGate,
          });
        }
      }
    }
  }
}

export const hookDispatcher = new HookDispatcher();
