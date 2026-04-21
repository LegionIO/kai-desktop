import { isAbsolute, resolve } from 'path';
import { homedir } from 'os';
import { stat } from 'fs/promises';

async function pathExists(p: string): Promise<boolean> {
  try { await stat(p); return true; } catch { return false; }
}

/**
 * Resolve a tool-provided path against the working directory.
 * If the path is absolute and exists, use it as-is.
 * If the path is absolute but does NOT exist and a cwd is available, fall back
 * to cwd — this guards against LLM-hallucinated absolute paths.
 */
export async function resolveToolPath(pathValue: string, cwd?: string): Promise<string> {
  if (isAbsolute(pathValue)) {
    if (await pathExists(pathValue)) return pathValue;
    // Hallucinated absolute path — fall back to cwd if available.
    if (cwd) {
      console.warn(`[resolveToolPath] Absolute path "${pathValue}" does not exist, falling back to cwd "${cwd}"`);
      return cwd;
    }
    return pathValue;
  }

  return resolve(cwd || homedir(), pathValue);
}
