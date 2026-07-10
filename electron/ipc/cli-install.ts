import { app } from 'electron';
import { existsSync, mkdirSync, lstatSync, rmSync, chmodSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { execFileSync } from 'child_process';

/**
 * "Install the `kai` command in PATH" — the VS Code `code`-style action promised
 * by the packaged launcher. electron-builder ships bin/kai + bin/kai.cmd into
 * Resources/bin; those shims resolve the app binary from their own location. But
 * once installed into a per-user PATH dir (a different directory), self-relative
 * resolution no longer points at the app. So instead of symlinking/copying the
 * shipped shim, we WRITE A SMALL WRAPPER that bakes in the absolute app-binary
 * path via KAI_APP_BINARY and delegates. This:
 *   - works from any install dir (fixes custom NSIS dirs / dev),
 *   - survives an AppImage's transient mount only if we point at a stable path
 *     (for AppImage we bake in $APPIMAGE, the launcher path, which is stable),
 *   - carries a marker line so we only ever manage/delete OUR file, never an
 *     unrelated user `kai` command.
 *
 * All destinations are per-user (no sudo): mac/linux ~/.local/bin, Windows a
 * per-user dir added to the user PATH.
 */

/** Marker embedded in every wrapper we generate, so status/uninstall only ever
 *  touch a Kai-managed file (never clobber an unrelated `kai` on PATH). */
const MANAGED_MARKER = 'KAI_MANAGED_CLI_WRAPPER';

export type CliInstallStatus = {
  installed: boolean;
  /** Absolute path the command resolves to, when installed. */
  target?: string;
  /** The app binary the wrapper delegates to (undefined in dev / unpackaged). */
  source?: string;
  /** Whether the destination dir is already on PATH. */
  onPath?: boolean;
  /** A non-Kai file already occupies the target path — we won't overwrite it. */
  conflict?: boolean;
  /** True when install succeeded but the dir isn't yet on PATH (restart shell). */
  requiresShellRestart?: boolean;
  error?: string;
};

/**
 * Absolute path to the app binary the installed wrapper should invoke. Prefer a
 * STABLE path (survives app restart): the packaged executable, or on AppImage
 * the $APPIMAGE launcher. Falls back to process.execPath.
 */
function appBinaryPath(): string | null {
  if (!app.isPackaged) {
    // Dev: no stable installed binary. The shipped repo shim resolves the dev
    // electron itself, so dev "install" isn't meaningful — signal unavailable.
    return null;
  }
  if (process.platform === 'linux' && process.env.APPIMAGE) {
    return process.env.APPIMAGE;
  }
  return process.execPath;
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

/** The wrapper script contents — bakes in the app binary + the managed marker. */
function wrapperContents(appBin: string): string {
  if (process.platform === 'win32') {
    return ['@echo off', `rem ${MANAGED_MARKER}`, `"${appBin}" --kai-cli %*`, ''].join('\r\n');
  }
  // POSIX: exec so signals/tty pass straight through. Quote the path.
  return [`#!/bin/sh`, `# ${MANAGED_MARKER}`, `exec "${appBin}" --kai-cli "$@"`, ''].join('\n');
}

function isOnPath(dir: string): boolean {
  const pathVar = process.env.PATH ?? '';
  const sep = process.platform === 'win32' ? ';' : ':';
  const norm = (p: string) => p.replace(/[/\\]+$/, '').toLowerCase();
  return pathVar.split(sep).map(norm).includes(norm(dir));
}

/** Is the file at `path` a wrapper WE wrote (carries the marker)? */
function isManaged(path: string): boolean {
  try {
    if (!existsSync(path)) return false;
    const st = lstatSync(path);
    if (!st.isFile()) return false;
    return readFileSync(path, 'utf-8').includes(MANAGED_MARKER);
  } catch {
    return false;
  }
}

export function getCliInstallStatus(): CliInstallStatus {
  const source = appBinaryPath() ?? undefined;
  const { dir, path } = installTarget();
  const exists = existsSync(path);
  const managed = exists && isManaged(path);
  // A file that exists but isn't ours = conflict (don't claim installed, don't clobber).
  const conflict = exists && !managed;
  return {
    installed: managed,
    target: managed ? path : undefined,
    source,
    onPath: isOnPath(dir),
    conflict: conflict || undefined,
  };
}

/** Add `dir` to the user's PATH on Windows (persists for future shells). */
function ensureWindowsPath(dir: string): void {
  if (isOnPath(dir)) return;
  // Pass `dir` via an environment variable (not string-interpolated into the
  // -Command text) to avoid any quoting/injection issue with the path, handle a
  // null user PATH, and compare normalized segments rather than a wildcard match.
  try {
    execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        [
          '$d = $env:KAI_CLI_DIR;',
          "$p = [Environment]::GetEnvironmentVariable('Path','User');",
          "if ([string]::IsNullOrEmpty($p)) { $p = '' }",
          "$segs = $p.Split(';') | Where-Object { $_ -ne '' };",
          "if (-not ($segs | Where-Object { $_.TrimEnd('\\') -ieq $d.TrimEnd('\\') })) {",
          "  $new = (@($segs) + $d) -join ';';",
          "  [Environment]::SetEnvironmentVariable('Path', $new, 'User')",
          '}',
        ].join(' '),
      ],
      { stdio: 'ignore', env: { ...process.env, KAI_CLI_DIR: dir } },
    );
  } catch {
    /* non-fatal: command still works via full path / this session */
  }
}

export function installCliCommand(): CliInstallStatus {
  const appBin = appBinaryPath();
  if (!appBin) {
    return { installed: false, error: 'kai command install is only available in the packaged app' };
  }
  const { dir, path } = installTarget();
  // Refuse to overwrite an unrelated `kai` command the user already has.
  if (existsSync(path) && !isManaged(path)) {
    return { installed: false, source: appBin, conflict: true, error: `a non-Kai file already exists at ${path}` };
  }
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, wrapperContents(appBin), 'utf-8');
    if (process.platform !== 'win32') chmodSync(path, 0o755);
    if (process.platform === 'win32') {
      ensureWindowsPath(dir);
    } else if (!isOnPath(dir)) {
      ensurePosixPath(dir);
    }
  } catch (err) {
    return { installed: false, source: appBin, error: err instanceof Error ? err.message : String(err) };
  }
  const status = getCliInstallStatus();
  return { ...status, requiresShellRestart: status.installed && status.onPath === false ? true : undefined };
}

export function uninstallCliCommand(): CliInstallStatus {
  const { path } = installTarget();
  // Only remove a file we manage — never delete an unrelated user `kai`.
  if (existsSync(path) && !isManaged(path)) {
    return { installed: false, conflict: true, error: `refusing to remove non-Kai file at ${path}` };
  }
  try {
    if (existsSync(path)) rmSync(path);
    if (process.platform !== 'win32') removePosixPath(installTarget().dir);
  } catch (err) {
    return { installed: true, error: err instanceof Error ? err.message : String(err) };
  }
  return getCliInstallStatus();
}

const POSIX_PATH_MARKER = '# added by Kai (kai CLI)';

/** Append a managed PATH block to the user's shell rc (idempotent). */
function ensurePosixPath(dir: string): void {
  const block = `${POSIX_PATH_MARKER}\nexport PATH="${dir}:$PATH"`;
  // Target the user's actual shell rc when detectable, else default to zsh (macOS
  // default) / bash. Writing to a single file avoids duplicate PATH entries.
  const shell = process.env.SHELL ?? '';
  const rc = shell.includes('bash') ? join(homedir(), '.bashrc') : join(homedir(), '.zshrc');
  try {
    const existing = existsSync(rc) ? readFileSync(rc, 'utf-8') : '';
    if (existing.includes(POSIX_PATH_MARKER)) return;
    writeFileSync(rc, `${existing}${existing === '' || existing.endsWith('\n') ? '' : '\n'}${block}\n`);
  } catch {
    /* best-effort */
  }
}

/** Remove the managed PATH block on uninstall. */
function removePosixPath(dir: string): void {
  void dir;
  const rcs = [join(homedir(), '.zshrc'), join(homedir(), '.bashrc')];
  for (const rc of rcs) {
    try {
      if (!existsSync(rc)) continue;
      const lines = readFileSync(rc, 'utf-8').split('\n');
      const out: string[] = [];
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes(POSIX_PATH_MARKER)) {
          i++; // also skip the export PATH line that follows the marker
          continue;
        }
        out.push(lines[i]);
      }
      const next = out.join('\n');
      if (next !== readFileSync(rc, 'utf-8')) writeFileSync(rc, next);
    } catch {
      /* best-effort */
    }
  }
}
