import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assistantDownloadQuarantineDirectory,
  assistantDownloadExportJournalDirectory,
  exportAssistantDownloadFile,
  isAssistantDownloadQuarantineFileAvailable,
  isAssistantDownloadQuarantinePath,
  listAssistantDownloadQuarantineScopeKeys,
  MAX_ASSISTANT_DOWNLOAD_BYTES,
  MAX_ASSISTANT_QUARANTINE_AGE_MS,
  MAX_ASSISTANT_QUARANTINE_BYTES_PER_SCOPE,
  MAX_ASSISTANT_QUARANTINE_FILES_PER_SCOPE,
  prepareAssistantDownloadQuarantine,
  pruneAssistantDownloadQuarantine,
  reconcileAssistantDownloadExportJournal,
  removeAssistantDownloadFile,
  removeAssistantDownloadQuarantineForScope,
  secureAssistantDownloadFile,
} from '../download-quarantine.js';

describe('assistant download quarantine', () => {
  const temporaryDirectories: string[] = [];

  const createAppHome = (): string => {
    const directory = mkdtempSync(join(tmpdir(), 'kai-download-quarantine-'));
    temporaryDirectories.push(directory);
    return directory;
  };

  const downloadId = (index: number): string => `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;

  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  it('uses a private non-executable generated path and exports only by explicit copy', async () => {
    const appHome = createAppHome();
    const id = downloadId(1);
    const source = prepareAssistantDownloadQuarantine(appHome, 'global', id);
    writeFileSync(source, 'remote payload', { mode: 0o777 });
    secureAssistantDownloadFile(source);

    expect(source).toMatch(/\/Kai-[0-9a-f-]{36}\.download$/);
    expect(source).not.toMatch(/\.pdf$|\.dmg$|\.app$|\.sh$/i);
    expect(statSync(assistantDownloadQuarantineDirectory(appHome, 'global')).mode & 0o777).toBe(0o700);
    expect(statSync(source).mode & 0o777).toBe(0o600);
    expect(isAssistantDownloadQuarantinePath(appHome, 'global', id, source)).toBe(true);

    const exported = join(appHome, 'chosen-by-user.pdf');
    await exportAssistantDownloadFile(appHome, source, exported);
    expect(readFileSync(exported, 'utf8')).toBe('remote payload');
    expect(statSync(exported).mode & 0o777).toBe(0o600);
  });

  it('publishes macOS exports only after applying a fresh Gatekeeper quarantine attribute', async () => {
    const appHome = createAppHome();
    const source = prepareAssistantDownloadQuarantine(appHome, 'global', downloadId(1));
    writeFileSync(source, 'remote payload');
    const exported = join(appHome, 'chosen-by-user.dmg');
    const writes: Array<{ path: string; value: string }> = [];
    const exportId = '11111111-1111-4111-8111-111111111111';

    await exportAssistantDownloadFile(appHome, source, exported, {
      platform: 'darwin',
      now: 1_700_000_000_000,
      exportId,
      writeMacOsQuarantineAttribute: async (path, value) => {
        expect(path).not.toBe(exported);
        expect(readFileSync(path, 'utf8')).toBe('remote payload');
        writes.push({ path, value });
      },
    });

    expect(readFileSync(exported, 'utf8')).toBe('remote payload');
    expect(writes).toHaveLength(1);
    expect(writes[0]?.value).toBe(`0083;${Math.floor(1_700_000_000).toString(16)};Kai;${exportId}`);
    expect(existsSync(writes[0]!.path)).toBe(false);
  });

  it('rejects a substituted macOS staging path after quarantining the original inode', async () => {
    const appHome = createAppHome();
    const source = prepareAssistantDownloadQuarantine(appHome, 'global', downloadId(1));
    writeFileSync(source, 'remote payload');
    const exported = join(appHome, 'chosen-by-user.dmg');
    const exportId = '66666666-6666-4666-8666-666666666666';
    let displaced = '';

    await expect(
      exportAssistantDownloadFile(appHome, source, exported, {
        platform: 'darwin',
        exportId,
        writeMacOsQuarantineAttribute: async (path, _value, handle) => {
          expect((await handle.stat()).isFile()).toBe(true);
          displaced = `${path}.displaced`;
          renameSync(path, displaced);
          writeFileSync(path, 'unquarantined substitute');
        },
      }),
    ).rejects.toThrow(/staging file changed/i);

    expect(existsSync(exported)).toBe(false);
    expect(readFileSync(displaced, 'utf8')).toBe('remote payload');
  });

  it('uses a bounded staging name for valid destinations near NAME_MAX', async () => {
    const appHome = createAppHome();
    const source = prepareAssistantDownloadQuarantine(appHome, 'global', downloadId(1));
    writeFileSync(source, 'remote payload');
    const exported = join(appHome, `${'x'.repeat(240)}.dmg`);
    const exportId = '55555555-5555-4555-8555-555555555555';
    const stagedPaths: string[] = [];

    await exportAssistantDownloadFile(appHome, source, exported, {
      platform: 'darwin',
      exportId,
      writeMacOsQuarantineAttribute: async (path) => {
        stagedPaths.push(path);
      },
    });

    expect(readFileSync(exported, 'utf8')).toBe('remote payload');
    expect(stagedPaths).toEqual([join(appHome, `.kai-export-${exportId}.tmp`)]);
  });

  it('keeps a published macOS export successful when post-rename journal cleanup fails', async () => {
    const appHome = createAppHome();
    const source = prepareAssistantDownloadQuarantine(appHome, 'global', downloadId(1));
    writeFileSync(source, 'remote payload');
    const exported = join(appHome, 'chosen-by-user.dmg');
    const exportId = '44444444-4444-4444-8444-444444444444';
    const removeExportJournal = vi.fn(async () => {
      throw new Error('journal directory temporarily read-only');
    });

    await expect(
      exportAssistantDownloadFile(appHome, source, exported, {
        platform: 'darwin',
        exportId,
        writeMacOsQuarantineAttribute: async () => undefined,
        removeExportJournal,
      }),
    ).resolves.toBeUndefined();

    expect(readFileSync(exported, 'utf8')).toBe('remote payload');
    expect(removeExportJournal).toHaveBeenCalledOnce();
    await expect(reconcileAssistantDownloadExportJournal(appHome)).resolves.toEqual([]);
    expect(readdirSync(assistantDownloadExportJournalDirectory(appHome))).toEqual([]);
    expect(readFileSync(exported, 'utf8')).toBe('remote payload');
  });

  it('retains the recovery journal when destination-directory sync fails after rename', async () => {
    const appHome = createAppHome();
    const source = prepareAssistantDownloadQuarantine(appHome, 'global', downloadId(1));
    writeFileSync(source, 'remote payload');
    const exported = join(appHome, 'chosen-by-user.dmg');
    const exportId = '77777777-7777-4777-8777-777777777777';

    await expect(
      exportAssistantDownloadFile(appHome, source, exported, {
        platform: 'darwin',
        exportId,
        writeMacOsQuarantineAttribute: async () => undefined,
        syncDestinationDirectory: async () => {
          throw new Error('destination directory sync failed');
        },
      }),
    ).rejects.toThrow(/directory sync failed/i);

    expect(readFileSync(exported, 'utf8')).toBe('remote payload');
    expect(readdirSync(assistantDownloadExportJournalDirectory(appHome))).toEqual([`Kai-${exportId}.json`]);
    await expect(reconcileAssistantDownloadExportJournal(appHome)).resolves.toEqual([]);
    expect(readdirSync(assistantDownloadExportJournalDirectory(appHome))).toEqual([]);
    expect(readFileSync(exported, 'utf8')).toBe('remote payload');
  });

  it('retains the recovery journal when post-rename destination verification fails', async () => {
    const appHome = createAppHome();
    const source = prepareAssistantDownloadQuarantine(appHome, 'global', downloadId(1));
    writeFileSync(source, 'remote payload');
    const exported = join(appHome, 'chosen-by-user.dmg');
    const exportId = '88888888-8888-4888-8888-888888888888';

    await expect(
      exportAssistantDownloadFile(appHome, source, exported, {
        platform: 'darwin',
        exportId,
        writeMacOsQuarantineAttribute: async () => undefined,
        verifyPublishedDestination: async () => {
          throw new Error('destination identity check failed');
        },
      }),
    ).rejects.toThrow(/identity check failed/i);

    expect(readFileSync(exported, 'utf8')).toBe('remote payload');
    expect(readdirSync(assistantDownloadExportJournalDirectory(appHome))).toEqual([`Kai-${exportId}.json`]);
  });

  it('fails macOS export closed without replacing an existing file when quarantine metadata cannot be set', async () => {
    const appHome = createAppHome();
    const source = prepareAssistantDownloadQuarantine(appHome, 'global', downloadId(1));
    writeFileSync(source, 'remote payload');
    const exported = join(appHome, 'existing.dmg');
    writeFileSync(exported, 'existing payload');
    const exportId = '22222222-2222-4222-8222-222222222222';

    await expect(
      exportAssistantDownloadFile(appHome, source, exported, {
        platform: 'darwin',
        exportId,
        writeMacOsQuarantineAttribute: async () => {
          throw new Error('xattr unavailable');
        },
      }),
    ).rejects.toThrow('xattr unavailable');

    expect(readFileSync(exported, 'utf8')).toBe('existing payload');
    expect(existsSync(join(appHome, `.kai-export-${exportId}.tmp`))).toBe(false);
  });

  it('rejects a symlinked quarantine scope without touching its external target', () => {
    const appHome = createAppHome();
    const external = createAppHome();
    const root = join(appHome, 'browser', 'download-quarantine');
    mkdirSync(root, { recursive: true });
    const externalFile = join(external, `Kai-${downloadId(1)}.download`);
    writeFileSync(externalFile, 'outside');
    symlinkSync(external, assistantDownloadQuarantineDirectory(appHome, 'global'), 'dir');

    expect(() => prepareAssistantDownloadQuarantine(appHome, 'global', downloadId(2))).toThrow(/app-owned directory/i);
    expect(() => pruneAssistantDownloadQuarantine(appHome, 'global')).toThrow(/unsafe non-directory path/i);
    expect(readFileSync(externalFile, 'utf8')).toBe('outside');
  });

  it('never follows a symlinked quarantine file while securing or exporting it', async () => {
    const appHome = createAppHome();
    const external = createAppHome();
    const source = prepareAssistantDownloadQuarantine(appHome, 'global', downloadId(1));
    const externalFile = join(external, 'unrelated.txt');
    const exported = join(appHome, 'chosen.bin');
    writeFileSync(externalFile, 'outside', { mode: 0o644 });
    symlinkSync(externalFile, source);

    expect(() => secureAssistantDownloadFile(source)).toThrow(/regular file|download limit/i);
    await expect(exportAssistantDownloadFile(appHome, source, exported)).rejects.toThrow(/unavailable|export limit/i);

    expect(readFileSync(externalFile, 'utf8')).toBe('outside');
    expect(statSync(externalFile).mode & 0o777).toBe(0o644);
    expect(existsSync(exported)).toBe(false);
  });

  it('enforces age, file-count, and per-file export bounds', async () => {
    const appHome = createAppHome();
    const pruned: Array<{ id: string; path: string }> = [];
    const stale = prepareAssistantDownloadQuarantine(appHome, 'global', downloadId(1));
    writeFileSync(stale, 'stale');
    const staleTime = new Date(Date.now() - MAX_ASSISTANT_QUARANTINE_AGE_MS - 1_000);
    utimesSync(stale, staleTime, staleTime);

    for (let index = 2; index <= MAX_ASSISTANT_QUARANTINE_FILES_PER_SCOPE + 3; index += 1) {
      const path = prepareAssistantDownloadQuarantine(appHome, 'global', downloadId(index), new Set(), (removed) =>
        pruned.push(...removed),
      );
      writeFileSync(path, `download-${index}`);
    }
    pruned.push(...pruneAssistantDownloadQuarantine(appHome, 'global'));
    expect(existsSync(stale)).toBe(false);
    expect(pruned).toContainEqual({ id: downloadId(1), path: stale });
    expect(readdirSync(assistantDownloadQuarantineDirectory(appHome, 'global'))).toHaveLength(
      MAX_ASSISTANT_QUARANTINE_FILES_PER_SCOPE,
    );

    const oversized = prepareAssistantDownloadQuarantine(
      appHome,
      'conversation-aaaaaaaaaaaaaaaaaaaaaaaa',
      downloadId(99),
    );
    writeFileSync(oversized, '');
    truncateSync(oversized, MAX_ASSISTANT_DOWNLOAD_BYTES + 1);
    expect(() => secureAssistantDownloadFile(oversized)).toThrow(/download limit/i);
    await expect(exportAssistantDownloadFile(appHome, oversized, join(appHome, 'oversized.bin'))).rejects.toThrow(
      /export limit/i,
    );
  });

  it('removes crash-left Chromium partials immediately while preserving active final-path reservations', () => {
    const appHome = createAppHome();
    const abandoned = prepareAssistantDownloadQuarantine(appHome, 'global', downloadId(1));
    const active = prepareAssistantDownloadQuarantine(appHome, 'global', downloadId(2));
    const abandonedPartial = `${abandoned}.crdownload`;
    const activePartial = `${active}.crdownload`;
    writeFileSync(abandonedPartial, 'abandoned');
    writeFileSync(activePartial, 'active');

    const pruned = pruneAssistantDownloadQuarantine(appHome, 'global', new Set([active]));

    expect(existsSync(abandonedPartial)).toBe(false);
    expect(existsSync(activePartial)).toBe(true);
    expect(pruned).toContainEqual({ id: downloadId(1), path: abandoned });
  });

  it('removes both the final and Chromium partial path during runtime cleanup', () => {
    const appHome = createAppHome();
    const path = prepareAssistantDownloadQuarantine(appHome, 'global', downloadId(1));
    writeFileSync(path, 'final');
    writeFileSync(`${path}.crdownload`, 'partial');

    removeAssistantDownloadFile(path);

    expect(existsSync(path)).toBe(false);
    expect(existsSync(`${path}.crdownload`)).toBe(false);
  });

  it('reconciles durably journaled macOS export staging files after a crash', async () => {
    const appHome = createAppHome();
    const exportId = '33333333-3333-4333-8333-333333333333';
    const destination = join(appHome, 'chosen.dmg');
    const staged = join(appHome, `.kai-export-${exportId}.tmp`);
    const journalDirectory = assistantDownloadExportJournalDirectory(appHome);
    mkdirSync(journalDirectory, { recursive: true });
    writeFileSync(staged, 'crash-left export');
    writeFileSync(
      join(journalDirectory, `Kai-${exportId}.json`),
      JSON.stringify({ version: 1, exportId, destination, staged }),
    );

    await expect(reconcileAssistantDownloadExportJournal(appHome)).resolves.toEqual([staged]);

    expect(existsSync(staged)).toBe(false);
    expect(readdirSync(journalDirectory)).toEqual([]);
    expect(existsSync(destination)).toBe(false);
  });

  it('discards a truncated export journal and continues reconciling later valid records', async () => {
    const appHome = createAppHome();
    const truncatedExportId = '11111111-1111-4111-8111-111111111111';
    const validExportId = '33333333-3333-4333-8333-333333333333';
    const destination = join(appHome, 'valid.dmg');
    const staged = join(appHome, `.kai-export-${validExportId}.tmp`);
    const unrelatedFile = join(appHome, 'must-not-be-removed.tmp');
    const journalDirectory = assistantDownloadExportJournalDirectory(appHome);
    mkdirSync(journalDirectory, { recursive: true });
    writeFileSync(unrelatedFile, 'unrelated');
    writeFileSync(join(journalDirectory, `Kai-${truncatedExportId}.json`), '{"version":1,"staged":');
    writeFileSync(staged, 'crash-left valid export');
    writeFileSync(
      join(journalDirectory, `Kai-${validExportId}.json`),
      JSON.stringify({ version: 1, exportId: validExportId, destination, staged }),
    );

    await expect(reconcileAssistantDownloadExportJournal(appHome)).resolves.toEqual([staged]);

    expect(existsSync(staged)).toBe(false);
    expect(readFileSync(unrelatedFile, 'utf8')).toBe('unrelated');
    expect(readdirSync(journalDirectory)).toEqual([]);
  });

  it('treats missing persisted quarantine artifacts as unavailable', () => {
    const appHome = createAppHome();
    const id = downloadId(1);
    const source = prepareAssistantDownloadQuarantine(appHome, 'global', id);
    writeFileSync(source, 'available');

    expect(isAssistantDownloadQuarantineFileAvailable(appHome, 'global', id, source)).toBe(true);
    rmSync(source);
    expect(isAssistantDownloadQuarantineFileAvailable(appHome, 'global', id, source)).toBe(false);
  });

  it('removes only the requested profile quarantine', () => {
    const appHome = createAppHome();
    const globalPath = prepareAssistantDownloadQuarantine(appHome, 'global', downloadId(1));
    const conversationPath = prepareAssistantDownloadQuarantine(
      appHome,
      'conversation-aaaaaaaaaaaaaaaaaaaaaaaa',
      downloadId(2),
    );
    writeFileSync(globalPath, 'global');
    writeFileSync(conversationPath, 'conversation');

    removeAssistantDownloadQuarantineForScope(appHome, 'conversation-aaaaaaaaaaaaaaaaaaaaaaaa');
    expect(existsSync(globalPath)).toBe(true);
    expect(existsSync(conversationPath)).toBe(false);
  });

  it('discovers quarantine-only profiles without trusting unrelated entry names', () => {
    const appHome = createAppHome();
    const conversationScope = 'conversation-aaaaaaaaaaaaaaaaaaaaaaaa';
    mkdirSync(assistantDownloadQuarantineDirectory(appHome, 'global'), { recursive: true });
    writeFileSync(assistantDownloadQuarantineDirectory(appHome, conversationScope), 'crash-left entry');
    writeFileSync(join(appHome, 'browser', 'download-quarantine', 'conversation-invalid'), 'unowned');

    expect(listAssistantDownloadQuarantineScopeKeys(appHome).sort()).toEqual(['global', conversationScope].sort());
  });

  it('reserves worst-case capacity for every active download before admitting another', () => {
    const appHome = createAppHome();
    const completed = prepareAssistantDownloadQuarantine(appHome, 'global', downloadId(1));
    writeFileSync(completed, '');
    truncateSync(completed, 20 * 1024 * 1024);

    const protectedPaths = new Set<string>();
    const maximumActive = Math.floor(MAX_ASSISTANT_QUARANTINE_BYTES_PER_SCOPE / MAX_ASSISTANT_DOWNLOAD_BYTES);
    for (let index = 0; index < maximumActive; index += 1) {
      const path = prepareAssistantDownloadQuarantine(appHome, 'global', downloadId(index + 2), protectedPaths);
      writeFileSync(path, `active-${index}`);
      protectedPaths.add(path);
    }

    expect(existsSync(completed)).toBe(false);
    expect([...protectedPaths].every((path) => existsSync(path))).toBe(true);
    expect(() => prepareAssistantDownloadQuarantine(appHome, 'global', downloadId(99), protectedPaths)).toThrow(
      /no capacity/i,
    );
    expect(readdirSync(assistantDownloadQuarantineDirectory(appHome, 'global'))).toHaveLength(maximumActive);
  });

  it('prunes completed artifacts around every remaining active download reservation', () => {
    const appHome = createAppHome();
    const olderCompleted = prepareAssistantDownloadQuarantine(appHome, 'global', downloadId(1));
    const newerCompleted = prepareAssistantDownloadQuarantine(appHome, 'global', downloadId(2));
    for (const path of [olderCompleted, newerCompleted]) {
      writeFileSync(path, '');
      truncateSync(path, 60 * 1024 * 1024);
    }
    const now = Date.now();
    utimesSync(olderCompleted, new Date(now - 2_000), new Date(now - 2_000));
    utimesSync(newerCompleted, new Date(now - 1_000), new Date(now - 1_000));

    const protectedPaths = new Set<string>();
    for (let index = 0; index < 4; index += 1) {
      const path = prepareAssistantDownloadQuarantine(appHome, 'global', downloadId(index + 3));
      writeFileSync(path, `active-${index}`);
      protectedPaths.add(path);
    }

    pruneAssistantDownloadQuarantine(appHome, 'global', protectedPaths, {
      reserveFiles: protectedPaths.size,
      reserveBytes: protectedPaths.size * MAX_ASSISTANT_DOWNLOAD_BYTES,
      reservationsIncludeProtectedPaths: true,
    });

    expect(existsSync(olderCompleted)).toBe(false);
    expect(existsSync(newerCompleted)).toBe(true);
    expect([...protectedPaths].every((path) => existsSync(path))).toBe(true);
  });
});
