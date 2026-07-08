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

const MAX_HOOK_PAYLOAD_BYTES = 256 * 1024;

function jsonSafe(value: unknown): unknown {
  try {
    const serialized =
      JSON.stringify(value, (_k, v) => (typeof v === 'function' || typeof v === 'bigint' ? undefined : v)) ?? 'null';
    // Guard against forwarding multi-MB tool results into every hook/automation.
    if (serialized.length > MAX_HOOK_PAYLOAD_BYTES) {
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
      child.stdin?.write(JSON.stringify({ event, payload: jsonSafe(payload) }));
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
   * Register a hook handler. Returns an unregister function.
   * Plugin registrations run before user (shell) registrations so DLP /
   * sanitization plugins see raw data.
   */
  register(
    event: HookEvent,
    handler: HookHandler,
    opts: HookRegistrationOptions & { source?: 'plugin' | 'user'; pluginId?: string } = {},
  ): () => void {
    const reg: HookRegistration = {
      source: opts.source ?? 'plugin',
      pluginId: opts.pluginId,
      mode: opts.mode ?? 'observe',
      matcher: opts.matcher,
      handler,
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
  async dispatch<T = unknown>(event: HookEvent, payload: T): Promise<DispatchResult<T>> {
    const cfg = this.safeConfig();
    const enabled = cfg?.hooks?.enabled ?? true;
    const timeoutMs = cfg?.hooks?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    if (!enabled) return { payload, denied: false };

    if (cfg) this.syncUserHooks(cfg);

    const list = this.registry.get(event) ?? [];

    // Observe-only fan-out to the automation engine. Emits the FINAL (post-
    // enforcement) payload and is skipped on deny, so a low-permission event
    // subscriber never sees raw data that a DLP block/modify hook removed.
    const emitObserve = (finalPayload: T): void => {
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

      if (reg.mode === 'observe') {
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
        console.warn(`[hooks] ${reg.mode} handler for ${event} failed: ${message}`);
        // Both block and modify fail CLOSED: a sanitizer/DLP modify hook that
        // throws or times out must not let the unmodified payload through.
        // Denied → NOT fanned out to observers.
        return {
          payload: current,
          denied: true,
          reason: `${reg.mode} hook failed (${message}); failing closed to avoid leaking unmodified data.`,
        };
      }

      if (outcome?.decision === 'deny') {
        return { payload: current, denied: true, reason: outcome.reason };
      }
      if (
        reg.mode === 'modify' &&
        outcome &&
        typeof outcome === 'object' &&
        'payload' in outcome &&
        outcome.payload !== undefined
      ) {
        current = outcome.payload as T;
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
  private syncUserHooks(config: AppConfig): void {
    const automationsEnabled = config.automations?.enabled !== false;
    const rules: AutomationRule[] = config.automations?.rules ?? [];
    const relevant = automationsEnabled
      ? rules.filter(
          (r) =>
            r.enabled && r.trigger.source === 'hook' && (HOOK_EVENTS as readonly string[]).includes(r.trigger.event),
        )
      : [];
    const timeoutMs = config.hooks?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const fingerprint = JSON.stringify([
      timeoutMs,
      automationsEnabled,
      relevant.map((r) => [
        r.id,
        r.trigger.event,
        r.conditions,
        r.conditionMode,
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
      const event = rule.trigger.event as HookEvent;
      // Only PreToolUse/PostToolUse/UserPromptSubmit are awaited and can act on
      // a block/modify result. The rest are fire-and-forget, so coerce their
      // mode to observe — a block/modify there would silently do nothing.
      const effectiveModeFor = (mode: HookMode): HookMode => (ENFORCING_HOOK_EVENTS.has(event) ? mode : 'observe');
      for (const action of rule.actions) {
        if (action.type !== 'runHookCommand') continue;
        const { command, matcher } = action;
        const mode = effectiveModeFor(action.mode);
        const handler = (payload: unknown): Promise<HookOutcome | void> | void => {
          try {
            const cond = evaluateConditions(rule.conditions, rule.conditionMode, payload);
            if (!cond.ok) return undefined;
          } catch {
            return undefined;
          }
          return runShellHook(event, command, mode, payload, timeoutMs);
        };
        this.register(event, handler, {
          source: 'user',
          mode,
          matcher,
        });
      }
    }
  }
}

export const hookDispatcher = new HookDispatcher();
