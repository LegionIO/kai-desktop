import { app } from 'electron';
import {
  existsSync,
  mkdirSync,
  symlinkSync,
  lstatSync,
  readlinkSync,
  rmSync,
  copyFileSync,
  chmodSync,
  readFileSync,
  writeFileSync,
} from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { execFileSync } from 'child_process';

/**
 * "Install the `kai` command in PATH" — the VS Code `code`-style action promised
 * by the packaged launcher (electron-builder ships bin/kai + bin/kai.cmd into
 * Resources/bin). This resolves the shipped shim and links/copies it onto a
 * user-writable PATH location per OS, and reports current status.
 *
 * All destinations are per-user (no sudo): mac/linux use ~/.local/bin (plus a
 * /usr/local/bin attempt on mac if writable), Windows uses a per-user dir added
 * to the user PATH.
 */

export type CliInstallStatus = {
  installed: boolean;
  /** Absolute path the command resolves to, when installed. */
  target?: string;
  /** The shipped shim we install FROM (undefined in dev / unpackaged). */
  source?: string;
  /** Whether the destination dir is already on PATH. */
  onPath?: boolean;
  error?: string;
};

/** Path to the shipped launcher inside the packaged app, or the repo copy in dev. */
function shimSource(): string | null {
  const name = process.platform === 'win32' ? 'kai.cmd' : 'kai';
  if (app.isPackaged) {
    const p = join(process.resourcesPath, 'bin', name);
    return existsSync(p) ? p : null;
  }
  // Dev: repo bin/. app.getAppPath() is the project root under electron-vite dev.
  const p = join(app.getAppPath(), 'bin', name);
  return existsSync(p) ? p : null;
}

/** User-writable install directory + the command's final path within it. */
function installTarget(): { dir: string; path: string } {
  if (process.platform === 'win32') {
    const dir = join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Kai', 'bin');
    return { dir, path: join(dir, 'kai.cmd') };
  }
  const dir = join(homedir(), '.local', 'bin');
  return { dir, path: join(dir, 'kai') };
}

function isOnPath(dir: string): boolean {
  const pathVar = process.env.PATH ?? '';
  const sep = process.platform === 'win32' ? ';' : ':';
  return pathVar
    .split(sep)
    .map((p) => p.replace(/[/\\]+$/, ''))
    .includes(dir.replace(/[/\\]+$/, ''));
}

export function getCliInstallStatus(): CliInstallStatus {
  const source = shimSource() ?? undefined;
  const { dir, path } = installTarget();
  let installed = false;
  let resolved: string | undefined;
  try {
    if (existsSync(path)) {
      const st = lstatSync(path);
      if (st.isSymbolicLink()) {
        resolved = readlinkSync(path);
        installed = source ? resolved === source : true;
      } else {
        installed = true; // a copied .cmd / file
        resolved = path;
      }
    }
  } catch {
    /* treat as not installed */
  }
  return { installed, target: installed ? path : undefined, source, onPath: isOnPath(dir) };
}

/** Add `dir` to the user's PATH on Windows (persists for future shells). */
function ensureWindowsPath(dir: string): void {
  if (isOnPath(dir)) return;
  // Edit the user-scoped Environment PATH via PowerShell. Best-effort — failure
  // is non-fatal (the command still works via full path / this session).
  try {
    execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        `$p=[Environment]::GetEnvironmentVariable('Path','User'); if ($p -notlike '*${dir}*') { [Environment]::SetEnvironmentVariable('Path', ($p.TrimEnd(';') + ';${dir}'), 'User') }`,
      ],
      { stdio: 'ignore' },
    );
  } catch {
    /* non-fatal */
  }
}

export function installCliCommand(): CliInstallStatus {
  const source = shimSource();
  if (!source) {
    return { installed: false, error: 'kai launcher not found in this build' };
  }
  const { dir, path } = installTarget();
  try {
    mkdirSync(dir, { recursive: true });
    // Replace any existing entry.
    if (existsSync(path)) {
      try {
        rmSync(path);
      } catch {
        /* ignore */
      }
    }
    if (process.platform === 'win32') {
      // Windows: copy the .cmd (symlinks need admin/dev-mode) and rewrite its
      // KAI_APP_BINARY-free resolution to still find the app; the shim resolves
      // the exe itself, so a plain copy works.
      copyFileSync(source, path);
      ensureWindowsPath(dir);
    } else {
      // POSIX: symlink so upgrades that replace the shipped shim are reflected.
      symlinkSync(source, path);
      try {
        chmodSync(source, 0o755);
      } catch {
        /* shipped shim may already be executable / read-only */
      }
      // If ~/.local/bin isn't on PATH, add it to the user's shell profile once.
      if (!isOnPath(dir)) ensurePosixPath(dir);
    }
  } catch (err) {
    return { installed: false, source, error: err instanceof Error ? err.message : String(err) };
  }
  return getCliInstallStatus();
}

export function uninstallCliCommand(): CliInstallStatus {
  const { path } = installTarget();
  try {
    if (existsSync(path)) rmSync(path);
  } catch (err) {
    return { installed: true, error: err instanceof Error ? err.message : String(err) };
  }
  return getCliInstallStatus();
}

/** Append a PATH line to the user's shell rc (idempotent) so ~/.local/bin resolves. */
function ensurePosixPath(dir: string): void {
  const line = `export PATH="${dir}:$PATH"`;
  const marker = '# added by Kai (kai CLI)';
  const rcFiles = [join(homedir(), '.zshrc'), join(homedir(), '.bashrc')];
  for (const rc of rcFiles) {
    try {
      if (!existsSync(dirname(rc))) continue;
      const existing = existsSync(rc) ? readFileSync(rc, 'utf-8') : '';
      if (existing.includes(marker) || existing.includes(dir)) continue;
      writeFileSync(rc, `${existing}${existing.endsWith('\n') || existing === '' ? '' : '\n'}${marker}\n${line}\n`);
    } catch {
      /* best-effort */
    }
  }
}
