import { execFile } from 'node:child_process';

const FOOTPRINT_PATH = '/usr/bin/footprint';
const FOOTPRINT_TIMEOUT_MS = 3_000;
const FOOTPRINT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

/** Parse `footprint --noCategories --format bytes` output by target PID. */
export function parseMacOSPrivateMemory(output: string): Map<number, number> {
  const result = new Map<number, number>();
  let currentPid: number | null = null;

  for (const line of output.split(/\r?\n/)) {
    const heading = line.match(/\[(\d+)\]:.*\bFootprint:/);
    if (heading) {
      currentPid = Number(heading[1]);
      continue;
    }
    if (currentPid === null) continue;
    const physical = line.match(/^\s*phys_footprint:\s*(\d+)\s+B\s*$/);
    if (!physical) continue;
    const bytes = Number(physical[1]);
    if (Number.isSafeInteger(bytes) && bytes >= 0) result.set(currentPid, bytes);
    currentPid = null;
  }

  return result;
}

/**
 * Electron's utility-process `process` object does not expose
 * getProcessMemoryInfo(), and app.getAppMetrics() omits private bytes on macOS.
 * Ask the OS for all live plugin PIDs in one bounded subprocess instead.
 */
export function sampleMacOSPrivateMemory(pids: number[]): Promise<Map<number, number>> {
  const targets = [...new Set(pids.filter((pid) => Number.isSafeInteger(pid) && pid > 0))];
  if (process.platform !== 'darwin' || targets.length === 0) return Promise.resolve(new Map());

  const args = targets.flatMap((pid) => ['--pid', String(pid)]);
  args.push('--noCategories', '--format', 'bytes');

  return new Promise((resolve) => {
    execFile(
      FOOTPRINT_PATH,
      args,
      { timeout: FOOTPRINT_TIMEOUT_MS, maxBuffer: FOOTPRINT_MAX_OUTPUT_BYTES, encoding: 'utf8' },
      (_error, stdout, stderr) => resolve(parseMacOSPrivateMemory(`${stdout}\n${stderr}`)),
    );
  });
}
