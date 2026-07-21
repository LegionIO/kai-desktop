import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type ProcessResourceSample = {
  cpuPercent: number;
  cumulativeCpuSeconds: number | null;
  residentSetBytes: number;
  privateMemoryBytes: number;
};

export function parseProcessTime(value: string): number | null {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(value.trim());
  if (!match) return null;
  const days = Number(match[1] ?? 0);
  const hours = Number(match[2] ?? 0);
  const minutes = Number(match[3]);
  const seconds = Number(match[4]);
  return days * 86_400 + hours * 3_600 + minutes * 60 + seconds;
}

export function parsePsResourceOutput(output: string): Map<number, ProcessResourceSample> {
  const result = new Map<number, ProcessResourceSample>();
  for (const line of output.split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length !== 4) continue;
    const pid = Number(fields[0]);
    const rssKiB = Number(fields[1]);
    const cpuPercent = Number(fields[2]);
    if (!Number.isInteger(pid) || !Number.isFinite(rssKiB) || !Number.isFinite(cpuPercent)) continue;
    result.set(pid, {
      cpuPercent,
      cumulativeCpuSeconds: parseProcessTime(fields[3]),
      residentSetBytes: Math.max(0, rssKiB) * 1024,
      privateMemoryBytes: 0,
    });
  }
  return result;
}

type WindowsProcess = {
  Id?: unknown;
  CPU?: unknown;
  WorkingSet64?: unknown;
  PrivateMemorySize64?: unknown;
};

const windowsPrevious = new Map<number, { cpuSeconds: number; sampledAt: number }>();

export function parseWindowsResourceOutput(output: string, sampledAt = Date.now()): Map<number, ProcessResourceSample> {
  const result = new Map<number, ProcessResourceSample>();
  if (!output.trim()) return result;
  const decoded = JSON.parse(output) as WindowsProcess | WindowsProcess[];
  const rows = Array.isArray(decoded) ? decoded : [decoded];
  for (const row of rows) {
    const pid = Number(row.Id);
    const cpuSeconds = Number(row.CPU ?? 0);
    const residentSetBytes = Number(row.WorkingSet64 ?? 0);
    const privateMemoryBytes = Number(row.PrivateMemorySize64 ?? 0);
    if (!Number.isInteger(pid)) continue;
    const previous = windowsPrevious.get(pid);
    const elapsedSeconds = previous ? (sampledAt - previous.sampledAt) / 1000 : 0;
    const cpuPercent = previous && elapsedSeconds > 0 ? ((cpuSeconds - previous.cpuSeconds) / elapsedSeconds) * 100 : 0;
    windowsPrevious.set(pid, { cpuSeconds, sampledAt });
    result.set(pid, {
      cpuPercent: Math.max(0, cpuPercent),
      cumulativeCpuSeconds: Number.isFinite(cpuSeconds) ? cpuSeconds : null,
      residentSetBytes: Number.isFinite(residentSetBytes) ? Math.max(0, residentSetBytes) : 0,
      privateMemoryBytes: Number.isFinite(privateMemoryBytes) ? Math.max(0, privateMemoryBytes) : 0,
    });
  }
  return result;
}

export async function sampleProcessResources(pids: readonly number[]): Promise<Map<number, ProcessResourceSample>> {
  const unique = [...new Set(pids.filter((pid) => Number.isInteger(pid) && pid > 0))];
  if (unique.length === 0) return new Map();
  try {
    if (process.platform === 'win32') {
      const script =
        `$p = Get-Process -Id ${unique.join(',')} -ErrorAction SilentlyContinue | ` +
        'Select-Object Id,CPU,WorkingSet64,PrivateMemorySize64; $p | ConvertTo-Json -Compress';
      const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        maxBuffer: 1024 * 1024,
      });
      return parseWindowsResourceOutput(stdout);
    }
    const { stdout } = await execFileAsync(
      'ps',
      ['-o', 'pid=', '-o', 'rss=', '-o', '%cpu=', '-o', 'time=', '-p', unique.join(',')],
      { maxBuffer: 1024 * 1024 },
    );
    return parsePsResourceOutput(stdout);
  } catch {
    // A process may exit between the PID snapshot and OS query. Diagnostics is
    // best-effort and the next poll will refresh surviving processes.
    return new Map();
  }
}
