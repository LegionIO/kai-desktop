/**
 * Cross-platform native-helper build step.
 *
 * - macOS: compile the Swift `LocalMacosHelper` binary.
 * - Windows: stage `LocalWindowsHelper.ps1` into build/bin/ (interpreted, no compile).
 * - Linux: stage `LocalLinuxHelper.sh` + `atspi_helper.py` into build/bin/ and warn
 *   about missing runtime tools (xdotool / maim / grim / jq).
 *
 * Usage:  node scripts/maybe-compile-swift.mjs
 *         (called by `pnpm dev` and `pnpm build`)
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const binDir = resolve(root, 'build', 'bin');

mkdirSync(binDir, { recursive: true });

function stage(src, dest, executable = false) {
  copyFileSync(src, dest);
  if (executable && process.platform !== 'win32') {
    chmodSync(dest, 0o755);
  }
  console.info(`[native-helpers] staged ${dest}`);
}

function which(bin) {
  const probe = process.platform === 'win32' ? 'where' : 'which';
  return spawnSync(probe, [bin], { stdio: 'ignore' }).status === 0;
}

function pruneStaleActiveWinStub() {
  if (process.platform === 'win32') return;
  const stub = resolve(
    root,
    'node_modules',
    'active-win',
    'lib',
    'binding',
    `napi-9-${process.platform}-unknown-${process.arch}`,
    'node-active-win.node',
  );
  if (existsSync(stub)) {
    rmSync(stub);
    console.info('[native-helpers] removed empty active-win addon stub (non-Windows)');
  }
}

pruneStaleActiveWinStub();

// Stage interpreted helpers for ALL targets so cross-platform packaging
// (e.g. `electron-builder --win` from a macOS host) finds the files that
// `electron-builder.template.yml` lists under `extraResources`.
stage(
  resolve(root, 'electron/platform/windows/LocalWindowsHelper.ps1'),
  resolve(binDir, 'LocalWindowsHelper.ps1'),
);
stage(
  resolve(root, 'electron/platform/linux/LocalLinuxHelper.sh'),
  resolve(binDir, 'LocalLinuxHelper.sh'),
  true,
);
stage(
  resolve(root, 'electron/platform/linux/atspi_helper.py'),
  resolve(binDir, 'atspi_helper.py'),
  true,
);

if (process.platform === 'darwin') {
  const script = resolve(root, 'scripts/compile-swift-helper.sh');
  try {
    execFileSync('bash', [script], { cwd: root, stdio: 'inherit' });
  } catch (error) {
    console.error('[native-helpers] Swift helper compilation failed:', error.message);
    process.exit(1);
  }
} else if (process.platform === 'win32') {
  if (!which('powershell.exe') && !which('pwsh.exe')) {
    console.warn('[native-helpers] WARNING: powershell.exe not found on PATH; Windows native helper will fall back to nut-js.');
  }
} else if (process.platform === 'linux') {
  const missing = ['jq', 'xdotool', 'maim', 'grim'].filter((bin) => !which(bin));
  if (missing.length > 0) {
    console.warn(
      `[native-helpers] WARNING: missing Linux tools: ${missing.join(', ')}. `
      + 'Install them for full local-desktop control (xdotool+maim on X11, grim on Wayland). '
      + 'The nut-js fallback will be used where unavailable.',
    );
  }
}
