/**
 * Periodic sweep that marks long-idle sub-agent threads as `abandoned` so
 * stale "pending"/"running" rows don't accumulate in the UI when the app
 * was killed mid-task.
 *
 * Scheduling:
 *   - A `node-schedule` cron fires once a day at 03:00 local time.
 *   - On startup we also read a tiny timestamp file
 *     (`<APP_HOME>/data/subagent-cleanup-last-run.txt`) and run an immediate
 *     catch-up sweep if the last run was >25 h ago (or the file is missing).
 *     This covers the macOS-sleep / app-not-running case where a cron from a
 *     previous day was simply skipped.
 *   - Every successful sweep (cron OR startup catch-up) rewrites the file
 *     with `Date.now()` so both paths keep the timestamp fresh.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import schedule from 'node-schedule';
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
 */
export function initializeSubagentCleanup(getConfig: () => AppConfig, appHome: string, dbPath: string): void {
  const initialConfig = getConfig();
  if (!initialConfig.memory?.enabled) {
    console.info('[Cleanup] Memory disabled — skipping sub-agent cleanup');
    return;
  }

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

  // Daily cron at 03:00 local time.
  schedule.scheduleJob('0 3 * * *', () => {
    void runSweep('cron');
  });
  console.info('[Cleanup] Sub-agent cleanup scheduled (daily at 03:00)');
}
