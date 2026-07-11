/**
 * Appshot IPC handler tests (#81) — id-validation rejection BEFORE the store
 * touches the filesystem, the update-patch allowlist, and appshots:changed
 * broadcast on mutation. The store's own security guards are covered in
 * electron/computer-use/__tests__/appshot-store.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const broadcast = vi.fn();
vi.mock('../../utils/window-send.js', () => ({
  broadcastToAllWindows: (...args: unknown[]) => broadcast(...args),
}));

import { createIpcHarness } from '../../../test-utils/ipc-harness.js';
import { registerAppshotHandlers } from '../appshots.js';
import { createAppshotStore } from '../../computer-use/appshot-store.js';
import type { AppConfig } from '../../config/schema.js';

const FAKE_EVENT = Object.freeze({}) as unknown;
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const CONFIG = {
  appshots: {
    enabled: true,
    autoCapture: false,
    captureVisibleText: false,
    retention: { maxCount: 200, maxAgeDays: 30, maxTotalBytes: 524288000 },
  },
} as unknown as AppConfig;

let home: string;

async function harnessFor() {
  return createIpcHarness({
    registerHandlers: (ipc) => {
      registerAppshotHandlers(ipc as Parameters<typeof registerAppshotHandlers>[0], home, () => CONFIG);
    },
  });
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'kai-appshot-ipc-'));
  broadcast.mockClear();
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('appshots IPC: id validation', () => {
  const BAD_IDS = ['appshot-1-deadbeef/../../etc/passwd', 'appshot-1-DEADBEEF', '../etc/passwd', 'x'];

  it('rejects malformed ids on get/get-image without touching the store', async () => {
    const h = await harnessFor();
    for (const id of BAD_IDS) {
      expect(await h.invoke('appshots:get', FAKE_EVENT, id)).toBeNull();
      expect(await h.invoke('appshots:get-image', FAKE_EVENT, id)).toBeNull();
    }
  });

  it('rejects malformed ids on delete/update (ok:false, no broadcast)', async () => {
    const h = await harnessFor();
    for (const id of BAD_IDS) {
      expect(await h.invoke('appshots:delete', FAKE_EVENT, id)).toMatchObject({ ok: false });
      expect(await h.invoke('appshots:update', FAKE_EVENT, id, { pinned: true })).toMatchObject({ ok: false });
    }
    expect(broadcast).not.toHaveBeenCalled();
  });
});

describe('appshots IPC: list/get/delete round-trip + broadcast', () => {
  it('lists a created appshot and broadcasts appshots:changed on delete', async () => {
    // Seed one appshot directly via the store, then exercise the handlers.
    const seeded = createAppshotStore(home).create(
      { imageData: JPEG, metadata: { appName: 'X' } },
      CONFIG.appshots!.retention as never,
    );
    const h = await harnessFor();

    const list = await h.invoke<Array<{ id: string }>>('appshots:list', FAKE_EVENT);
    expect(list.map((a) => a.id)).toContain(seeded.id);

    const del = await h.invoke('appshots:delete', FAKE_EVENT, seeded.id);
    expect(del).toMatchObject({ ok: true });
    expect(broadcast).toHaveBeenCalledWith('appshots:changed', undefined);
  });

  it('delete-all broadcasts', async () => {
    createAppshotStore(home).create({ imageData: JPEG, metadata: {} }, CONFIG.appshots!.retention as never);
    const h = await harnessFor();
    await h.invoke('appshots:delete-all', FAKE_EVENT);
    expect(broadcast).toHaveBeenCalledWith('appshots:changed', undefined);
    expect(await h.invoke('appshots:list', FAKE_EVENT)).toEqual([]);
  });
});

describe('appshots IPC: update allowlist', () => {
  it('accepts tags+pinned and rejects unknown keys via the strict schema', async () => {
    const seeded = createAppshotStore(home).create(
      { imageData: JPEG, metadata: {} },
      CONFIG.appshots!.retention as never,
    );
    const h = await harnessFor();

    const ok = await h.invoke('appshots:update', FAKE_EVENT, seeded.id, { tags: ['a'], pinned: true });
    expect(ok).toMatchObject({ ok: true });
    expect(broadcast).toHaveBeenCalledWith('appshots:changed', undefined);

    // A forged key must be rejected by the .strict() schema (no mutation).
    broadcast.mockClear();
    const bad = await h.invoke('appshots:update', FAKE_EVENT, seeded.id, { imageRef: '../evil', id: 'evil' });
    expect(bad).toMatchObject({ ok: false });
    expect(broadcast).not.toHaveBeenCalled();
  });
});
