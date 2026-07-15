/**
 * Tests for the CLI folder-trust store (electron/cli/folder-trust.ts) — the
 * security-boundary core of "do you trust this folder?". A real temp KAI_USER_DATA
 * backs the store (the module reads getAppHome() which honors that env var), and
 * real temp dirs (incl. a symlink) exercise the realpath canonicalization. The
 * invariants locked: HOME is implicitly trusted (never nags / never persisted),
 * trust is idempotent + persisted, a symlink to a trusted dir is trusted (can't
 * be used to masquerade the OTHER way), an unresolvable path is never trusted,
 * and a corrupt store fails closed (nothing trusted).
 *
 * POSIX-focused (symlink case skipped on win32).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, realpathSync } from 'fs';
import { tmpdir, homedir } from 'os';
import { join } from 'path';

const isWin = process.platform === 'win32';

let home: string;
let kaiHome: string;
let work: string;

beforeEach(() => {
  // Isolated app-home (store lives here) + a separate workspace root.
  kaiHome = mkdtempSync(join(tmpdir(), 'kai-trust-home-'));
  work = mkdtempSync(join(tmpdir(), 'kai-trust-work-'));
  process.env.KAI_USER_DATA = kaiHome;
  home = realpathSync(homedir());
  vi.resetModules(); // re-import so getAppHome() re-reads KAI_USER_DATA
});

afterEach(() => {
  delete process.env.KAI_USER_DATA;
  rmSync(kaiHome, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
});

async function load() {
  return import('../folder-trust.js');
}

describe('folder-trust — HOME is implicitly trusted', () => {
  it('trusts HOME without any prompt/persist', async () => {
    const { isFolderTrusted, __internal } = await load();
    expect(isFolderTrusted(homedir())).toBe(true);
    // Not written to the store (implicit).
    expect(__internal.loadStore().folders).toEqual([]);
  });
});

describe('folder-trust — trust is persisted + idempotent', () => {
  it('an untrusted dir starts untrusted, becomes trusted after trustFolder, and persists', async () => {
    const sub = join(work, 'proj');
    mkdirSync(sub);
    const { isFolderTrusted, trustFolder } = await load();
    expect(isFolderTrusted(sub)).toBe(false);
    const stored = trustFolder(sub);
    expect(stored).toBe(realpathSync(sub));
    expect(isFolderTrusted(sub)).toBe(true);

    // A fresh module load (new process) still sees it as trusted (persisted).
    vi.resetModules();
    const { isFolderTrusted: isTrusted2 } = await load();
    expect(isTrusted2(sub)).toBe(true);
  });

  it('trustFolder is idempotent (no duplicate entries)', async () => {
    const sub = join(work, 'proj');
    mkdirSync(sub);
    const { trustFolder, __internal } = await load();
    trustFolder(sub);
    trustFolder(sub);
    expect(__internal.loadStore().folders.filter((f) => f === realpathSync(sub))).toHaveLength(1);
  });
});

describe('folder-trust — canonicalization', () => {
  it.runIf(!isWin)('a symlink pointing at a trusted dir is trusted (resolves to the same realpath)', async () => {
    const real = join(work, 'real');
    mkdirSync(real);
    const link = join(work, 'link');
    symlinkSync(real, link);
    const { trustFolder, isFolderTrusted } = await load();
    trustFolder(real);
    // Querying via the symlink resolves to `real` → trusted.
    expect(isFolderTrusted(link)).toBe(true);
  });

  it('a path that cannot be resolved (does not exist) is never trusted', async () => {
    const { isFolderTrusted } = await load();
    expect(isFolderTrusted(join(work, 'does-not-exist'))).toBe(false);
  });

  it('trustFolder returns null for an unresolvable path (records nothing)', async () => {
    const { trustFolder, __internal } = await load();
    expect(trustFolder(join(work, 'nope'))).toBeNull();
    expect(__internal.loadStore().folders).toEqual([]);
  });
});

describe('folder-trust — fail closed', () => {
  it('a corrupt store file is treated as empty (nothing trusted)', async () => {
    const sub = join(work, 'proj');
    mkdirSync(sub);
    const { __internal, isFolderTrusted } = await load();
    // Write garbage to the store path.
    mkdirSync(join(kaiHome), { recursive: true });
    writeFileSync(__internal.storePath(), '{ not valid json', 'utf-8');
    expect(isFolderTrusted(sub)).toBe(false);
    expect(__internal.loadStore().folders).toEqual([]);
  });

  it('HOME stays trusted even with a corrupt store (implicit, not store-backed)', async () => {
    const { __internal, isFolderTrusted } = await load();
    writeFileSync(__internal.storePath(), 'garbage', 'utf-8');
    expect(isFolderTrusted(home)).toBe(true);
  });

  it('does NOT trust a dir just because $HOME points at it (bypass defense)', async () => {
    if (isWin) return; // $HOME semantics are POSIX
    const sub = mkdtempSync(join(tmpdir(), 'kai-trust-fakehome-'));
    const realHomeSaved = process.env.HOME;
    try {
      // A malicious wrapper could launch `HOME=<untrusted dir> kai` to make that
      // dir look like HOME (implicitly trusted) and skip the prompt. canonicalHome
      // uses userInfo().homedir (OS passwd), so the override must NOT grant trust.
      process.env.HOME = sub;
      vi.resetModules();
      const { isFolderTrusted } = await load();
      expect(isFolderTrusted(sub)).toBe(false);
    } finally {
      if (realHomeSaved === undefined) delete process.env.HOME;
      else process.env.HOME = realHomeSaved;
      rmSync(sub, { recursive: true, force: true });
    }
  });

  it('ignores a store with the wrong version or non-absolute entries', async () => {
    const sub = join(work, 'proj-v');
    mkdirSync(sub);
    const real = realpathSync(sub);
    const { __internal, isFolderTrusted } = await load();
    mkdirSync(kaiHome, { recursive: true });
    // Wrong version → whole store rejected.
    writeFileSync(__internal.storePath(), JSON.stringify({ version: 2, folders: [real] }), 'utf-8');
    expect(isFolderTrusted(sub)).toBe(false);
    // Right version but a relative entry → that entry dropped.
    writeFileSync(__internal.storePath(), JSON.stringify({ version: 1, folders: ['relative/path', real] }), 'utf-8');
    expect(__internal.loadStore().folders).toEqual([real]);
    expect(isFolderTrusted(sub)).toBe(true);
  });
});

describe('confirmFolderTrust (the interactive gate)', () => {
  it('returns true WITHOUT prompting for an already-trusted dir (HOME)', async () => {
    const { confirmFolderTrust } = await load();
    let prompted = false;
    const readLine = async () => {
      prompted = true;
      return '';
    };
    expect(await confirmFolderTrust(homedir(), readLine)).toBe(true);
    expect(prompted).toBe(false); // trusted → no prompt
  });

  it('prompts for an untrusted dir; "t" trusts it (and persists) → returns true', async () => {
    const sub = join(work, 'proj');
    mkdirSync(sub);
    const { confirmFolderTrust, isFolderTrusted } = await load();
    let prompted = false;
    const readLine = async () => {
      prompted = true;
      return 't';
    };
    expect(await confirmFolderTrust(sub, readLine)).toBe(true);
    expect(prompted).toBe(true);
    expect(isFolderTrusted(sub)).toBe(true); // persisted, so a later check passes without prompting
  });

  it('accepts y / yes / trust as affirmative (case-insensitive)', async () => {
    const { confirmFolderTrust } = await load();
    for (const ans of ['y', 'yes', 'trust', 'TRUST', 'Yes']) {
      const sub = mkdtempSync(join(tmpdir(), 'kai-trust-ans-'));
      expect(await confirmFolderTrust(sub, async () => ans), ans).toBe(true);
      rmSync(sub, { recursive: true, force: true });
    }
  });

  it('declines (Enter / n / anything else) → returns false, does NOT trust', async () => {
    const sub = join(work, 'proj2');
    mkdirSync(sub);
    const { confirmFolderTrust, isFolderTrusted } = await load();
    for (const ans of ['', 'n', 'no', 'x']) {
      expect(await confirmFolderTrust(sub, async () => ans), JSON.stringify(ans)).toBe(false);
    }
    expect(isFolderTrusted(sub)).toBe(false); // a decline never persists trust
  });
});
