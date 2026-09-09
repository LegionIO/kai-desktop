#!/usr/bin/env node
// Ensure the app-builder-bin native binaries are executable.
//
// We pin app-builder-bin to 4.2.0 via pnpm.overrides because electron-builder's
// default (app-builder-bin@5.0.0-alpha.12) is blocked by the Optum JFrog Xray
// download policy (see build(deps) commit). Unlike the 5.x alpha tarball, the
// 4.2.0 tarball stores its `app-builder` binaries WITHOUT the execute bit and
// ships no postinstall, so electron-builder fails at package time with
// `spawn .../app-builder EACCES`. Restore +x here after every install.
//
// Best-effort and idempotent: missing files / non-app-builder-bin layouts are
// skipped silently so this never breaks an install on an unrelated version.
import { chmodSync, existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

function resolveAppBuilderBinDir() {
  try {
    const require = createRequire(import.meta.url);
    // Resolves to <pkg>/index.js regardless of hoisted vs isolated layout.
    return dirname(require.resolve('app-builder-bin'));
  } catch {
    return null;
  }
}

const binDir = resolveAppBuilderBinDir();
if (binDir) {
  // Every prebuilt binary the package ships, across platforms/arches. We chmod
  // all of them (cheap) rather than just the current platform so a cross-platform
  // CI matrix that shares a checkout is covered.
  const candidates = [
    'linux/x64/app-builder',
    'linux/arm64/app-builder',
    'linux/arm/app-builder',
    'linux/ia32/app-builder',
    'linux/riscv64/app-builder',
    'mac/app-builder_amd64',
    'mac/app-builder_arm64',
    // .exe files are executable by extension on Windows; no chmod needed.
  ];
  for (const rel of candidates) {
    const p = join(binDir, rel);
    try {
      if (!existsSync(p)) continue;
      const mode = statSync(p).mode;
      // Add u+x,g+x,o+x (0o111) on top of existing perms.
      chmodSync(p, mode | 0o111);
    } catch {
      /* best-effort per binary */
    }
  }
}
