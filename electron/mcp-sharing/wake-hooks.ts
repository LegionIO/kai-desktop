import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { PluginHost, WakeHookPreview } from '../../shared/plugin-bridge.js';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { hash, object, readBoundedFile } from '../plugin-bridge/files.js';

/** Marks our entries so install/remove only ever touches Kai's own hooks. */
const WAKE_HOOK_RE = / events (--shared|hint)( |$)/;

type Hook = Record<string, unknown> & { command?: string };
type Group = { matcher?: string; hooks?: Hook[] };
type HooksFile = Record<string, unknown> & { hooks?: Record<string, Group[]> };

function quote(arg: string): string {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`;
}

/**
 * Claude: one async-rewake watcher per session (the CLI locks by session_id),
 * re-armed on SessionStart/UserPromptSubmit/Stop so one is alive mid-turn too.
 * Codex has no async hooks: drain missed events on each turn boundary instead.
 */
export function wakeHookEntries(host: PluginHost, launcher: { command: string; args: string[] }) {
  const kai = [launcher.command, ...launcher.args].map(quote).join(' ');
  // Tells each new session it can subscribe itself (`kai events subscribe`).
  const hint = { type: 'command', command: `${kai} events hint`, timeout: 10 };
  const watch =
    host === 'claude'
      ? { type: 'command', command: `${kai} events --shared --rewake`, async: true, asyncRewake: true, timeout: 3600 }
      : { type: 'command', command: `${kai} events --shared --drain`, timeout: 10 };
  return {
    SessionStart: [{ hooks: [hint, watch] }],
    UserPromptSubmit: [{ hooks: [watch] }],
    Stop: [{ hooks: [watch] }],
  } as Record<string, Group[]>;
}

const isOurs = (hook: Hook) => typeof hook.command === 'string' && WAKE_HOOK_RE.test(hook.command);

/** Remove every Kai wake hook, dropping groups/events left empty. */
export function withoutWakeHooks(file: HooksFile): HooksFile {
  const hooks: Record<string, Group[]> = {};
  for (const [event, groups] of Object.entries(object(file.hooks) as Record<string, Group[]>)) {
    if (!Array.isArray(groups)) {
      hooks[event] = groups;
      continue;
    }
    // Only prune what we emptied: a group (or event) that held none of ours is kept as-is.
    const kept = groups.flatMap((g) => {
      if (!Array.isArray(g.hooks) || !g.hooks.some(isOurs)) return [g];
      const rest = g.hooks.filter((h) => !isOurs(h));
      return rest.length ? [{ ...g, hooks: rest }] : [];
    });
    if (kept.length || !groups.length) hooks[event] = kept;
  }
  const next: HooksFile = { ...file, hooks };
  if (!Object.keys(hooks).length) delete next.hooks;
  return next;
}

export function withWakeHooks(file: HooksFile, entries: Record<string, Group[]>): HooksFile {
  const clean = withoutWakeHooks(file);
  const hooks = { ...(clean.hooks ?? {}) };
  for (const [event, groups] of Object.entries(entries)) hooks[event] = [...(hooks[event] ?? []), ...groups];
  return { ...clean, hooks };
}

export function hasWakeHooks(file: HooksFile): boolean {
  return Object.values(object(file.hooks) as Record<string, Group[]>).some(
    (groups) => Array.isArray(groups) && groups.some((g) => Array.isArray(g.hooks) && g.hooks.some(isOurs)),
  );
}

type Preview = WakeHookPreview & { originalHash: string; next: string };

/** Preview → human approval → hash-checked write, mirroring McpClientSetup. */
export class WakeHookSetup {
  private readonly previews = new Map<string, Preview>();
  constructor(
    private readonly homes: () => Record<PluginHost, string>,
    private readonly launcher: () => { command: string; args: string[] },
  ) {}
  path(host: PluginHost): string {
    // Claude: user settings.json. Codex: hooks.json (Codex's hook file beside config.toml).
    return join(this.homes()[host], host === 'claude' ? 'settings.json' : 'hooks.json');
  }
  private read(path: string): { original: string; file: HooksFile } {
    const original = existsSync(path) ? readBoundedFile(path) : '';
    try {
      return { original, file: original ? (object(JSON.parse(original)) as HooksFile) : {} };
    } catch {
      throw new Error(`${path} could not be parsed. Repair it before changing Kai wake hooks.`);
    }
  }
  /** True only when the current hook set is present; older Kai installs read as not installed. */
  installed(host: PluginHost): boolean {
    try {
      const ours = (f: HooksFile) =>
        Object.entries(object(f.hooks) as Record<string, Group[]>)
          .map(([event, groups]) => [
            event,
            (Array.isArray(groups) ? groups : [])
              .flatMap((g) => (Array.isArray(g.hooks) ? g.hooks : []))
              .filter(isOurs),
          ])
          .filter(([, hooks]) => hooks.length)
          .sort(([a], [b]) => String(a).localeCompare(String(b))); // the user's file keeps its own event order
      const expected = ours({ hooks: wakeHookEntries(host, this.launcher()) });
      return JSON.stringify(ours(this.read(this.path(host)).file)) === JSON.stringify(expected);
    } catch {
      return false;
    }
  }
  preview(host: PluginHost, install: boolean): WakeHookPreview {
    const path = this.path(host);
    const { original, file } = this.read(path);
    const entries = wakeHookEntries(host, this.launcher());
    const next = JSON.stringify(install ? withWakeHooks(file, entries) : withoutWakeHooks(file), null, 2) + '\n';
    const preview: Preview = {
      id: randomUUID(),
      host,
      path,
      install,
      configuration: install ? JSON.stringify({ hooks: entries }, null, 2) : 'Remove Kai wake hooks',
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      originalHash: hash(original),
      next,
    };
    for (const [id, value] of this.previews) if (Date.parse(value.expiresAt) <= Date.now()) this.previews.delete(id);
    this.previews.set(preview.id, preview);
    return this.public(preview);
  }
  reviewed(id: string): WakeHookPreview {
    return this.public(this.live(id));
  }
  apply(id: string): void {
    const preview = this.live(id);
    this.previews.delete(id);
    const current = existsSync(preview.path) ? readBoundedFile(preview.path) : '';
    if (hash(current) !== preview.originalHash)
      throw new Error('The hook file changed after the preview. Preview it again.');
    mkdirSync(dirname(preview.path), { recursive: true, mode: 0o700 });
    atomicWriteFileSync(preview.path, preview.next, { mode: 0o600 });
  }
  private live(id: string): Preview {
    const preview = this.previews.get(id);
    if (!preview || Date.parse(preview.expiresAt) <= Date.now())
      throw new Error('Hook preview expired. Preview it again.');
    return preview;
  }
  private public(p: Preview): WakeHookPreview {
    return {
      id: p.id,
      host: p.host,
      path: p.path,
      install: p.install,
      configuration: p.configuration,
      expiresAt: p.expiresAt,
    };
  }
}
