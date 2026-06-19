import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolveCompiledHelperBinary } from '../computer-use/permissions.js';
import { FallbackAdapter } from './fallback/adapter.js';
import type { AdapterCapabilities, NativePlatformAdapter } from './types.js';

const execFileAsync = promisify(execFile);

let adapterPromise: Promise<NativePlatformAdapter> | null = null;
let fallbackInstance: FallbackAdapter | null = null;

export function getFallbackAdapter(): NativePlatformAdapter {
  if (!fallbackInstance) fallbackInstance = new FallbackAdapter();
  return fallbackInstance;
}

/**
 * Resolve the active platform adapter.
 *
 * Selection order: native helper for the current OS when its prerequisites are
 * present, otherwise the nut-js fallback. Memoized for the process lifetime.
 */
export function getPlatformAdapter(): Promise<NativePlatformAdapter> {
  if (!adapterPromise) {
    adapterPromise = selectAdapter().catch((error) => {
      console.warn(
        '[platform] adapter selection failed, using fallback:',
        error instanceof Error ? error.message : String(error),
      );
      return getFallbackAdapter();
    });
  }
  return adapterPromise;
}

export async function getAdapterCapabilities(): Promise<AdapterCapabilities> {
  const adapter = await getPlatformAdapter();
  return adapter.capabilities;
}

/** Test seam: clear the memoized adapter so the next call reselects. */
export function resetPlatformAdapterForTests(): void {
  adapterPromise = null;
  fallbackInstance = null;
}

async function selectAdapter(): Promise<NativePlatformAdapter> {
  switch (process.platform) {
    case 'darwin': {
      if (resolveCompiledHelperBinary() || (await canRun('xcrun', ['--version']))) {
        const { MacosAdapter } = await import('./macos/adapter.js');
        return new MacosAdapter();
      }
      return getFallbackAdapter();
    }
    case 'win32': {
      const { WindowsAdapter, resolveWindowsHelperPath } = await import('./windows/adapter.js');
      if (
        resolveWindowsHelperPath() &&
        (await canRun('powershell.exe', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major']))
      ) {
        return new WindowsAdapter();
      }
      return getFallbackAdapter();
    }
    case 'linux': {
      const { LinuxAdapter, resolveLinuxHelperPath } = await import('./linux/adapter.js');
      const hasJq = await canRun('which', ['jq']);
      const hasX11 = await canRun('which', ['xdotool']);
      const hasWaylandShot = await canRun('which', ['grim']);
      if (resolveLinuxHelperPath() && hasJq && (hasX11 || hasWaylandShot)) {
        return new LinuxAdapter();
      }
      return getFallbackAdapter();
    }
    default:
      return getFallbackAdapter();
  }
}

async function canRun(command: string, args: string[]): Promise<boolean> {
  try {
    await execFileAsync(command, args, { timeout: 4000 });
    return true;
  } catch {
    return false;
  }
}

export * from './types.js';
