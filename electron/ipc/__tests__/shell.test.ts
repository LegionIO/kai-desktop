/**
 * Tests for the shell:open-path IPC handler (electron/ipc/shell.ts). It exists so
 * the user can open a tool-produced file (a generated image/doc) via a UI "open"
 * affordance — but a tool could plant a malicious binary and label it a document,
 * so the handler REFUSES to hand an executable/script extension to the OS default
 * handler (one-click code execution). This locks that denylist + the
 * case-insensitive match + the success/error passthrough. A regression dropping
 * an extension or breaking the lowercasing would silently allow launch-on-open.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const openPath = vi.fn(async (_p: string) => ''); // '' = success
vi.mock('electron', () => ({ shell: { openPath: (p: string) => openPath(p) } }));

import { createIpcHarness } from '../../../test-utils/ipc-harness.js';
import { registerShellHandlers } from '../shell.js';

const FAKE_EVENT = {} as unknown;

async function harness() {
  return createIpcHarness({
    registerHandlers: (ipc) => registerShellHandlers(ipc as Parameters<typeof registerShellHandlers>[0]),
  });
}

beforeEach(() => {
  openPath.mockReset();
  openPath.mockResolvedValue('');
});

describe('shell:open-path executable guard', () => {
  const EXECUTABLE = [
    'evil.app',
    'run.command',
    'x.exe',
    'x.BAT',
    'x.Cmd',
    'malware.ps1',
    'a.sh',
    'b.py',
    'c.rb',
    'launcher.desktop',
    'x.jar',
    's.vbs',
    'h.hta',
    'l.lnk',
  ];

  it('refuses every executable/script extension WITHOUT calling shell.openPath', async () => {
    const h = await harness();
    for (const name of EXECUTABLE) {
      const r = await h.invoke<{ ok: boolean; error?: string }>('shell:open-path', FAKE_EVENT, `/tmp/${name}`);
      expect(r.ok, name).toBe(false);
      expect(r.error, name).toMatch(/executable|script/i);
    }
    expect(openPath).not.toHaveBeenCalled();
  });

  it('is case-insensitive on the extension (.EXE / .Sh refused)', async () => {
    const h = await harness();
    expect((await h.invoke<{ ok: boolean }>('shell:open-path', FAKE_EVENT, '/tmp/X.EXE')).ok).toBe(false);
    expect((await h.invoke<{ ok: boolean }>('shell:open-path', FAKE_EVENT, '/tmp/Y.Sh')).ok).toBe(false);
    expect(openPath).not.toHaveBeenCalled();
  });

  it('opens a document / media file (delegates to shell.openPath)', async () => {
    const h = await harness();
    for (const name of ['report.pdf', 'photo.png', 'clip.mp4', 'notes.txt', 'data.json', 'noext']) {
      const r = await h.invoke<{ ok: boolean }>('shell:open-path', FAKE_EVENT, `/tmp/${name}`);
      expect(r.ok, name).toBe(true);
    }
    expect(openPath).toHaveBeenCalledTimes(6);
  });

  it('surfaces a shell.openPath error string as { ok:false, error }', async () => {
    openPath.mockResolvedValueOnce('No application found');
    const h = await harness();
    const r = await h.invoke<{ ok: boolean; error?: string }>('shell:open-path', FAKE_EVENT, '/tmp/x.pdf');
    expect(r).toEqual({ ok: false, error: 'No application found' });
  });

  it('catches a thrown openPath and returns { ok:false }', async () => {
    openPath.mockRejectedValueOnce(new Error('boom'));
    const h = await harness();
    const r = await h.invoke<{ ok: boolean; error?: string }>('shell:open-path', FAKE_EVENT, '/tmp/x.pdf');
    expect(r.ok).toBe(false);
    expect(r.error).toBe('boom');
  });

  it('treats a null/undefined path as empty (no extension) and attempts open', async () => {
    const h = await harness();
    // String(undefined ?? '') === '' → extname '' not in denylist → openPath('')
    const r = await h.invoke<{ ok: boolean }>('shell:open-path', FAKE_EVENT, undefined);
    expect(r.ok).toBe(true);
    expect(openPath).toHaveBeenCalledWith('');
  });
});
