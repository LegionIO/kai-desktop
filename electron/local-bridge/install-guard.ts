import { execFileSync } from 'child_process';
import { existsSync, readFileSync, rmSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { getRunDir } from './paths.js';
import { atomicWriteFileSync } from '../utils/atomic-write.js';

/**
 * Install guard: closes the window between "Install and restart" and ShipIt's
 * "is the app still running?" check. While the marker is fresh, every Kai launch
 * (CLI, `kai mcp serve`, headless backend, second GUI) exits at startup, so an
 * MCP host relaunching its connector can't block the install. The new version
 * clears it on boot; the TTL makes a failed/abandoned install self-heal.
 */
const MARKER = 'installing.json';
export const INSTALL_GUARD_TTL_MS = 3 * 60_000;

function markerPath(): string {
  return join(getRunDir(), MARKER);
}

export function beginInstallGuard(version: string): void {
  const path = markerPath();
  mkdirSync(dirname(path), { recursive: true });
  atomicWriteFileSync(path, JSON.stringify({ version, startedAt: Date.now() }));
}

export function clearInstallGuard(): void {
  try {
    rmSync(markerPath(), { force: true });
  } catch {
    /* best-effort */
  }
}

/** True while an install of a DIFFERENT version, started within the TTL, is in
 *  progress. The freshly installed version itself is never blocked. */
export function isInstallGuardActive(runningVersion: string, now = Date.now()): boolean {
  try {
    if (!existsSync(markerPath())) return false;
    const { version, startedAt } = JSON.parse(readFileSync(markerPath(), 'utf-8')) as {
      version?: unknown;
      startedAt?: unknown;
    };
    if (version === runningVersion) return false;
    return typeof startedAt === 'number' && now - startedAt >= 0 && now - startedAt < INSTALL_GUARD_TTL_MS;
  } catch {
    return false;
  }
}

/** PIDs of other main processes running this exact executable (helpers have a different path). */
export function listOtherAppPids(execPath: string, selfPid: number, psOutput?: string): number[] {
  let out = psOutput;
  if (out === undefined) {
    try {
      out = execFileSync('/bin/ps', ['-axo', 'pid=,comm='], { encoding: 'utf8' });
    } catch {
      return [];
    }
  }
  const pids: number[] = [];
  for (const line of out.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(.*)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    if (pid !== selfPid && m[2] === execPath) pids.push(pid);
  }
  return pids;
}

/** SIGTERM every other Kai main process, then SIGKILL survivors after `graceMs`. */
export async function terminateOtherAppInstances(execPath: string, graceMs = 1500): Promise<number> {
  const pids = listOtherAppPids(execPath, process.pid);
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      /* already gone */
    }
  }
  if (pids.length === 0) return 0;
  await new Promise((resolve) => setTimeout(resolve, graceMs));
  for (const pid of listOtherAppPids(execPath, process.pid)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
  return pids.length;
}
