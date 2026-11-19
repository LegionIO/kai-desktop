import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { hasWakeHooks, WakeHookSetup, wakeHookEntries, withoutWakeHooks, withWakeHooks } from '../wake-hooks.js';

const launcher = { command: '/Applications/Kai.app/Contents/MacOS/Kai', args: ['--kai-cli'] };
const theirs = { type: 'command', command: 'other-tool hook' };

describe('wake hook file edits', () => {
  it('adds async-rewake watchers for Claude and drain hooks for Codex', () => {
    const claude = wakeHookEntries('claude', launcher);
    expect(Object.keys(claude)).toEqual(['SessionStart', 'UserPromptSubmit', 'Stop']);
    expect(claude.Stop[0].hooks![0]).toMatchObject({ async: true, asyncRewake: true, timeout: 3600 });
    expect(claude.Stop[0].hooks![0].command).toContain('events --shared --rewake');
    expect(claude.SessionStart[0].hooks!.map((h) => h.command)).toEqual([
      expect.stringContaining('events hint'),
      expect.stringContaining('events --shared --rewake'),
    ]);
    const codex = wakeHookEntries('codex', launcher);
    expect(codex.Stop[0].hooks![0].command).toContain('events --shared --drain');
    expect(codex.Stop[0].hooks![0]).not.toHaveProperty('async');
  });
  it('install keeps other hooks, is idempotent, and remove restores the original', () => {
    const original = { model: 'x', hooks: { Stop: [{ hooks: [theirs] }] } };
    const once = withWakeHooks(original, wakeHookEntries('claude', launcher));
    const twice = withWakeHooks(once, wakeHookEntries('claude', launcher));
    expect(twice).toEqual(once);
    expect(once.hooks!.Stop).toHaveLength(2);
    expect(hasWakeHooks(once)).toBe(true);
    expect(withoutWakeHooks(once)).toEqual(original);
    expect(withoutWakeHooks({ hooks: { Stop: [{ hooks: [] }] } })).toEqual({ hooks: { Stop: [{ hooks: [] }] } });
  });
});

describe('WakeHookSetup', () => {
  let dir = '';
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  it('writes only after a fresh preview, and refuses when the file changed', () => {
    dir = mkdtempSync(join(tmpdir(), 'kai-hooks-'));
    const path = join(dir, 'settings.json');
    writeFileSync(path, JSON.stringify({ hooks: { Stop: [{ hooks: [theirs] }] } }));
    const setup = new WakeHookSetup(
      () => ({ claude: dir, codex: dir }),
      () => launcher,
    );
    const preview = setup.preview('claude', true);
    expect(preview.path).toBe(path);
    setup.apply(preview.id);
    expect(setup.installed('claude')).toBe(true);
    // A previous Kai's hook set (no hint) reads as not installed, so the GUI offers an upgrade.
    const old = JSON.parse(readFileSync(path, 'utf8'));
    old.hooks.SessionStart[0].hooks.shift();
    writeFileSync(path, JSON.stringify(old));
    expect(setup.installed('claude')).toBe(false);
    setup.apply(setup.preview('claude', true).id);
    expect(setup.installed('claude')).toBe(true);
    expect(JSON.parse(readFileSync(path, 'utf8')).hooks.Stop[0].hooks[0]).toEqual(theirs);
    expect(() => setup.apply(preview.id)).toThrow(/expired/);

    const stale = setup.preview('claude', false);
    writeFileSync(path, JSON.stringify({ edited: true }));
    expect(() => setup.apply(stale.id)).toThrow(/changed/);
  });
});
