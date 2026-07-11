/**
 * Periodic sweep that marks long-idle sub-agent threads as `abandoned` so
 * stale "pending"/"running" rows don't accumulate in the UI when the app
 * was killed mid-task.
 *
 * Scheduling:
 *   - A native `setTimeout` fires the first sweep at the next 03:00 local time,
 *     then a `setInterval` repeats every 24 h. We deliberately do not depend on
 *     a cron library (`node-schedule` was removed in PR #29) for a single
 *     fixed daily slot — DST drift over a 24 h interval is acceptable given
 *     the 72 h orphan window this protects.
 *   - On startup we also read a tiny timestamp file
 *     (`<APP_HOME>/data/subagent-cleanup-last-run.txt`) and run an immediate
 *     catch-up sweep if the last run was >25 h ago (or the file is missing).
 *     This covers the macOS-sleep / app-not-running case where the daily
 *     fire from a previous day was simply skipped.
 *   - Every successful sweep (timer OR startup catch-up) rewrites the file
 *     with `Date.now()` so both paths keep the timestamp fresh.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { getResourceId, getSharedMemory } from '../agent/memory.js';
import { readSubagentStatus, updateSubagentStatus } from '../agent/subagent-status.js';
import type { AppConfig } from '../config/schema.js';

/** A thread is considered orphaned when it has been untouched for at least this many ms. */
const ORPHAN_AGE_MS = 3 * 24 * 60 * 60 * 1000; // 72 h
/** Startup catch-up triggers if last sweep was longer than this ago. */
const CATCH_UP_AFTER_MS = 25 * 60 * 60 * 1000; // 25 h

function lastRunFilePath(appHome: string): string {
  return join(appHome, 'data', 'subagent-cleanup-last-run.txt');
}

function readLastRun(appHome: string): number | null {
  try {
    const path = lastRunFilePath(appHome);
    if (!existsSync(path)) return null;
    const raw = readFileSync(path, 'utf-8').trim();
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

function writeLastRun(appHome: string, when: number): void {
  try {
    const path = lastRunFilePath(appHome);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, String(when));
  } catch (err) {
    console.warn('[Cleanup] Could not persist last-run timestamp:', err);
  }
}

/**
 * Sweep all sub-agent threads owned by this resource and mark any that have
 * been pending/running for too long as `abandoned`. Returns the count of
 * threads cleaned up.
 */
export async function cleanupOrphanedSubagents(config: AppConfig, dbPath: string): Promise<{ cleaned: number }> {
  const memory = getSharedMemory(config, dbPath);
  if (!memory) {
    console.info('[Cleanup] Memory not available — skipping cleanup');
    return { cleaned: 0 };
  }

  const resourceId = getResourceId();
  const cutoff = Date.now() - ORPHAN_AGE_MS;
  const completedAt = new Date().toISOString();
  let cleaned = 0;

  let page = 0;
  let hasMore = true;
  while (hasMore) {
    const result = await memory.listThreads({
      filter: { resourceId },
      perPage: 100,
      page,
    });

    for (const thread of result.threads) {
      if (!thread.id.startsWith('sub-')) continue;
      const updatedAtMs = new Date(thread.updatedAt).getTime();
      if (!Number.isFinite(updatedAtMs) || updatedAtMs >= cutoff) continue;

      const current = await readSubagentStatus(memory, thread.id);
      if (!current) continue;
      if (current.status !== 'pending' && current.status !== 'running') continue;

      await updateSubagentStatus(memory, thread.id, {
        status: 'abandoned',
        completedAt,
        exitReason: 'cleanup_orphaned_72h',
      });
      cleaned += 1;
    }

    hasMore = result.hasMore;
    page += 1;
  }

  if (cleaned > 0) {
    console.info(`[Cleanup] Marked ${cleaned} orphaned sub-agent(s) as abandoned`);
  } else {
    console.info('[Cleanup] No orphaned sub-agents found');
  }
  return { cleaned };
}

/**
 * Wire up the daily cron + the startup catch-up sweep. Called once from
 * `main.ts`. Safe to call when memory is disabled (it short-circuits).
 *
 * Idempotent: a second call while a schedule is already armed is a no-op (the
 * timers would otherwise leak — they're `unref`'d so they don't block exit, but
 * a re-init would run two overlapping daily sweeps with no handle to cancel the
 * first). Mirrors `startLocalServer`'s single-arm guard.
 */
let scheduled = false;
let initialTimer: ReturnType<typeof setTimeout> | null = null;
let intervalTimer: ReturnType<typeof setInterval> | null = null;

export function initializeSubagentCleanup(getConfig: () => AppConfig, appHome: string, dbPath: string): void {
  const initialConfig = getConfig();
  if (!initialConfig.memory?.enabled) {
    console.info('[Cleanup] Memory disabled — skipping sub-agent cleanup');
    return;
  }

  if (scheduled) {
    console.info('[Cleanup] Sub-agent cleanup already scheduled — skipping re-init');
    return;
  }
  scheduled = true;

  const runSweep = async (trigger: 'cron' | 'startup'): Promise<void> => {
    try {
      await cleanupOrphanedSubagents(getConfig(), dbPath);
      writeLastRun(appHome, Date.now());
    } catch (err) {
      console.error(`[Cleanup] ${trigger} sweep failed:`, err);
    }
  };

  // Startup catch-up: covers the case where the daily cron was skipped
  // (machine asleep, app not running). We don't await this — let it run
  // in the background so app startup is never gated on cleanup.
  const lastRun = readLastRun(appHome);
  const needsCatchUp = lastRun === null || Date.now() - lastRun > CATCH_UP_AFTER_MS;
  if (needsCatchUp) {
    console.info('[Cleanup] Running startup catch-up sweep');
    void runSweep('startup');
  }

  // Daily timer at 03:00 local time: wait until next 03:00, then repeat every 24 h.
  const ONE_DAY_MS = 24 * 60 * 60 * 1000;
  const now = new Date();
  const next3am = new Date(now);
  next3am.setHours(3, 0, 0, 0);
  if (next3am.getTime() <= now.getTime()) {
    next3am.setDate(next3am.getDate() + 1);
  }
  const msUntilNext = next3am.getTime() - now.getTime();
  initialTimer = setTimeout(() => {
    void runSweep('cron');
    intervalTimer = setInterval(() => {
      void runSweep('cron');
    }, ONE_DAY_MS);
    // Allow the process to exit even with the interval pending.
    intervalTimer.unref?.();
  }, msUntilNext);
  initialTimer.unref?.();
  console.info('[Cleanup] Sub-agent cleanup scheduled (daily at 03:00)');
}

/**
 * Cancel the scheduled sweep timers and reset the arm guard. Idempotent. Exists
 * so a restart (or a test) can tear down cleanly and re-arm; `main.ts` boots
 * once so this is not on the normal path, but leaving armed timers uncancelable
 * is the leak this closes.
 */
export function stopSubagentCleanup(): void {
  if (initialTimer) {
    clearTimeout(initialTimer);
    initialTimer = null;
  }
  if (intervalTimer) {
    clearInterval(intervalTimer);
    intervalTimer = null;
  }
  scheduled = false;
}
