import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import type { ComponentPlan, HookCommand, PluginPlan } from './types.js';
import type { PluginBridgeManager } from './manager.js';
import { nativeBridgeSessionId, object } from './files.js';

export type BridgeSession = {
  id: string;
  cwd: string;
  runtime: string;
  parentId?: string;
  controller: AbortController;
  started: Map<string, string>;
  turnSignal?: AbortSignal;
  cleanup?: AbortController;
  subagentStarted?: boolean;
  context: string[];
  watchers: Map<string, AbortController>;
};
export type HookReply = { context?: string; deny?: string; continuation?: string };
const MAX_OUTPUT = 256 * 1024;
const MAX_CONTEXT = 32 * 1024;

export function translateHookReply(output: unknown, event: string, exitCode = 0): HookReply {
  const result = object(output);
  const specific = object(result.hookSpecificOutput);
  const context =
    typeof specific.additionalContext === 'string' ? specific.additionalContext.slice(0, MAX_CONTEXT) : undefined;
  const reason =
    typeof specific.permissionDecisionReason === 'string'
      ? specific.permissionDecisionReason
      : typeof result.reason === 'string'
        ? result.reason
        : 'Blocked by an imported hook.';
  if (['Stop', 'SubagentStop'].includes(event))
    return {
      context,
      continuation: result.decision === 'block' || exitCode === 2 ? reason.slice(0, MAX_CONTEXT) : undefined,
    };
  const deny =
    ['PreToolUse', 'UserPromptSubmit'].includes(event) &&
    (specific.permissionDecision === 'deny' ||
      result.decision === 'block' ||
      result.continue === false ||
      exitCode === 2);
  // An "allow" or permissionDecision=allow can never manufacture approval.
  return { context, deny: deny ? reason.slice(0, MAX_CONTEXT) : undefined };
}

function mergeReplies(previous: HookReply, next: HookReply): HookReply {
  const combine = (a?: string, b?: string) => [a, b].filter(Boolean).join('\n').slice(0, MAX_CONTEXT) || undefined;
  return {
    context: combine(previous.context, next.context),
    deny: previous.deny ?? next.deny,
    continuation: combine(previous.continuation, next.continuation),
  };
}

export class ImportedHooks {
  readonly sessions = new Map<string, BridgeSession>();
  private readonly processes = new Map<AbortController, string>();
  constructor(private readonly manager: PluginBridgeManager) {
    manager.onRevoked = (allowed) => {
      for (const [controller, id] of this.processes) if (!allowed.has(id)) controller.abort();
      for (const session of this.sessions.values()) {
        if ([...session.started.keys()].some((id) => !allowed.has(id))) session.context = [];
        for (const id of session.started.keys()) if (!allowed.has(id)) session.started.delete(id);
      }
      if (!allowed.size)
        for (const session of this.sessions.values()) {
          session.controller.abort();
          session.context = [];
          for (const watcher of session.watchers.values()) watcher.abort();
          session.started.clear();
        }
    };
  }
  enabled(): boolean {
    return this.manager.enabled();
  }
  configuration() {
    return this.manager.configuration();
  }
  session(id: string, cwd?: string, runtime?: string, parentId?: string, signal?: AbortSignal): BridgeSession {
    let session = this.sessions.get(id);
    if (session && signal && session.turnSignal !== signal) {
      session.cleanup?.abort();
      session.controller.abort();
      for (const watcher of session.watchers.values()) watcher.abort();
      session = { ...session, controller: new AbortController(), context: [], watchers: new Map(), turnSignal: signal };
      this.sessions.set(id, session);
    }
    if (!session) {
      if (this.sessions.size >= 500) throw new Error('Plugin Bridge session limit reached.');
      session = {
        id: nativeBridgeSessionId(this.manager.store.get().instanceId, id),
        cwd: cwd ?? homedir(),
        runtime: runtime ?? 'kai',
        parentId: parentId ? nativeBridgeSessionId(this.manager.store.get().instanceId, parentId) : undefined,
        controller: new AbortController(),
        started: new Map(),
        turnSignal: signal,
        context: [],
        watchers: new Map(),
      };
      this.sessions.set(id, session);
    } else {
      if (cwd) session.cwd = cwd;
      if (runtime) session.runtime = runtime;
      if (parentId) session.parentId = nativeBridgeSessionId(this.manager.store.get().instanceId, parentId);
    }
    if (signal && session.turnSignal === signal) {
      const controller = session.controller;
      if (signal.aborted) controller.abort();
      else signal.addEventListener('abort', () => controller.abort(), { once: true, signal: controller.signal });
    }
    return session;
  }
  queueContext(session: BridgeSession, text: string): void {
    session.context = [[...session.context, text].join('\n').slice(0, MAX_CONTEXT)];
  }
  async start(session: BridgeSession): Promise<void> {
    const deadline = AbortSignal.timeout(60_000);
    for (const { plan, component } of this.manager.activeComponents()) {
      if (
        !component.hooks ||
        component.hooks.event !== 'SessionStart' ||
        session.started.get(component.public.id) === component.public.revision
      )
        continue;
      const reply = await this.component(plan, component, session, { source: 'startup' }, deadline);
      session.started.set(component.public.id, component.public.revision);
      if (reply.context) this.queueContext(session, reply.context);
    }
    if (session.parentId && !session.subagentStarted) {
      const reply = await this.event(session, 'SubagentStart', {});
      session.subagentStarted = true;
      if (reply.context) this.queueContext(session, reply.context);
    }
  }
  async event(session: BridgeSession, event: string, payload: Record<string, unknown>): Promise<HookReply> {
    if (!this.manager.enabled()) return {};
    let reply: HookReply = {};
    const deadline = AbortSignal.timeout(60_000);
    for (const { plan, component } of this.manager.activeComponents()) {
      if (component.hooks?.event !== event) continue;
      const current = await this.component(plan, component, session, payload, deadline);
      reply = mergeReplies(reply, current);
      if (reply.deny) break;
    }
    return reply;
  }
  private async component(
    plan: PluginPlan,
    component: ComponentPlan,
    session: BridgeSession,
    payload: Record<string, unknown>,
    deadline: AbortSignal,
  ): Promise<HookReply> {
    const current = this.manager.revalidate(component.public.id);
    plan = current.plan;
    component = current.component;
    let reply: HookReply = {};
    for (const [index, command] of component.hooks!.commands.entries()) {
      if (!this.manager.isAllowed(component.public.id)) break;
      deadline.throwIfAborted();
      session.controller.signal.throwIfAborted();
      if (command.matcher && typeof payload.tool_name === 'string') {
        // Claude/Codex matchers are regular expressions (including a|b).
        try {
          if (!new RegExp(command.matcher === '*' ? '.*' : command.matcher).test(payload.tool_name)) continue;
        } catch {
          throw new Error('Invalid imported hook matcher.');
        }
      }
      if (command.async) {
        const key = `${component.public.id}:${index}`;
        // Repeated tool events replace, rather than accumulate, bounded watchers.
        session.watchers.get(key)?.abort();
        const controller = new AbortController();
        session.watchers.set(key, controller);
        void this.run(plan, component, command, session, payload, controller.signal)
          .then((result) => {
            if (!controller.signal.aborted && this.manager.isAllowed(component.public.id) && result.context)
              this.queueContext(session, result.context);
          })
          .catch(() => {})
          .finally(() => {
            if (session.watchers.get(key) === controller) session.watchers.delete(key);
          });
        continue;
      }
      const result = await this.run(plan, component, command, session, payload, deadline);
      reply = mergeReplies(reply, result);
      if (reply.deny) break;
    }
    return reply;
  }
  private run(
    plan: PluginPlan,
    component: ComponentPlan,
    command: HookCommand,
    session: BridgeSession,
    payload: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<HookReply> {
    const controller = new AbortController();
    this.processes.set(controller, component.public.id);
    const combined = AbortSignal.any([controller.signal, session.controller.signal, ...(signal ? [signal] : [])]);
    const event = component.hooks!.event;
    // Each child has its own native identity; do not append a second subagent
    // suffix to the id shared with its MCP transport (Clanks derives one from agent_id).
    const input = JSON.stringify({
      ...payload,
      session_id: session.id,
      cwd: session.cwd,
      hook_event_name: event,
      parent_session_id: session.parentId,
      model: session.runtime,
      permission_mode: 'default',
      kai: { instance_id: this.manager.store.get().instanceId, runtime: session.runtime, parent_id: session.parentId },
    });
    if (Buffer.byteLength(input) > MAX_OUTPUT) {
      this.processes.delete(controller);
      return Promise.reject(new Error('Imported hook payload exceeds the size limit.'));
    }
    mkdirSync(plan.dataDir, { recursive: true, mode: 0o700 });
    return new Promise<HookReply>((resolve, reject) => {
      if (combined.aborted) {
        this.processes.delete(controller);
        reject(new Error('Imported hook cancelled.'));
        return;
      }
      const child = spawn(command.command, {
        shell: true,
        cwd: session.cwd,
        detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...Object.fromEntries(
            ['PATH', 'HOME', 'USER', 'TMPDIR', 'LANG', 'SystemRoot'].flatMap((key) =>
              process.env[key] ? [[key, process.env[key]!]] : [],
            ),
          ),
          PLUGIN_ROOT: plan.root,
          PLUGIN_DATA: plan.dataDir,
          KAI_BRIDGE_INSTANCE_ID: this.manager.store.get().instanceId,
          CLAUDE_PLUGIN_ROOT: plan.root,
          CODEX_PLUGIN_ROOT: plan.root,
          CLAUDE_PLUGIN_DATA: plan.dataDir,
          CODEX_PLUGIN_DATA: plan.dataDir,
          CODEX_THREAD_ID: session.id,
          CLAUDE_SESSION_ID: session.id,
          KAI_BRIDGE_SESSION_ID: session.id,
        },
      });
      let output = '',
        stderr = '',
        bytes = 0,
        settled = false;
      const kill = () => {
        try {
          if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
          else child.kill('SIGKILL');
        } catch {
          /* Already exited. */
        }
      };
      const finish = (error?: Error, code = 0) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        combined.removeEventListener('abort', abort);
        this.processes.delete(controller);
        if (error) {
          kill();
          reject(error);
          return;
        }
        try {
          let data: unknown = {};
          try {
            data = output.trim() ? JSON.parse(output) : {};
          } catch {
            data = { hookSpecificOutput: { additionalContext: output.slice(0, MAX_CONTEXT) } };
          }
          if (code === 2 && stderr) data = { ...object(data), reason: stderr.slice(0, MAX_CONTEXT) };
          if (code !== 0 && code !== 2) throw new Error('Imported hook exited unsuccessfully.');
          kill();
          const reply = translateHookReply(data, event, code);
          if (reply.context) this.manager.pool.observeHookContext(plan.public.id, session.id, reply.context);
          resolve(reply);
        } catch {
          reject(new Error('Imported hook returned invalid output. Check the installed plugin.'));
        }
      };
      const abort = () => finish(new Error('Imported hook cancelled.'));
      const timer = setTimeout(() => finish(new Error('Imported hook exceeded its time limit.')), command.timeoutMs);
      combined.addEventListener('abort', abort, { once: true });
      child.on('error', () => finish(new Error('Imported hook could not start.')));
      child.stdout.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > MAX_OUTPUT) finish(new Error('Imported hook exceeded its output limit.'));
        else output += chunk.toString('utf8');
      });
      child.stderr.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > MAX_OUTPUT) finish(new Error('Imported hook exceeded its output limit.'));
        else stderr += chunk.toString('utf8');
      });
      child.stdin.on('error', () => {});
      child.on('close', (code) => finish(undefined, code ?? 1));
      child.stdin.end(input);
    }).catch((error) => {
      this.manager.store.record('error', 'An imported lifecycle hook failed or was cancelled.', component.public.id);
      throw error;
    });
  }
  takeContext(session: BridgeSession): string {
    const context = session.context.join('\n').slice(0, MAX_CONTEXT);
    session.context = [];
    return context;
  }
  async interrupt(session: BridgeSession): Promise<void> {
    session.controller.abort();
    for (const controller of session.watchers.values()) controller.abort();
    session.context = [];
    // A cancelled predecessor must not close a replacement turn's MCP pool.
    if (![...this.sessions.values()].includes(session)) return;
    await this.manager.pool.closeSession(session.id);
    // Cleanup gets a separate bounded signal. Never revive the cancelled
    // session controller while another tool in that turn is unwinding.
    const cleanup = {
      ...session,
      controller: new AbortController(),
      watchers: new Map<string, AbortController>(),
      context: [],
    };
    session.cleanup = cleanup.controller;
    await this.event(cleanup, 'Interrupt', {}).catch(() => {});
    cleanup.controller.abort();
  }
  async end(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) return;
    await this.interrupt(session);
    if (this.sessions.get(id) !== session) return;
    const cleanup = {
      ...session,
      controller: new AbortController(),
      watchers: new Map<string, AbortController>(),
      context: [],
    };
    await this.event(cleanup, 'SessionEnd', {}).catch(() => {});
    cleanup.controller.abort();
    session.controller.abort();
    if (this.sessions.get(id) === session) this.sessions.delete(id);
  }
  async close(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.allSettled([...this.sessions.keys()].map((id) => this.end(id))),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 3000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
      for (const controller of this.processes.keys()) controller.abort();
      for (const session of this.sessions.values()) {
        session.controller.abort();
        session.cleanup?.abort();
      }
      this.sessions.clear();
    }
  }
}
