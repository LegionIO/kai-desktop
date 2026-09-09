#!/usr/bin/env node
// Ensure the app-builder-bin native binaries are executable.
//
// We pin app-builder-bin to 4.2.0 via pnpm.overrides because electron-builder's
// default (app-builder-bin@5.0.0-alpha.12) is blocked by the Optum JFrog Xray
// download policy (see build(deps) commits). Unlike the 5.x alpha tarball, the
// 4.2.0 tarball stores its `app-builder` binaries WITHOUT the execute bit and
// ships no postinstall, so electron-builder fails at package time with:
//   ⨯ spawn .../app-builder-bin@4.2.0/.../linux/x64/app-builder EACCES
//
// This runs both as a `postinstall` AND immediately before each electron-builder
// invocation (build:linux/mac/win) — the latter is the reliable one, because
// pnpm's content-addressable hardlink relinking can undo a postinstall chmod, and
// the store layout (hoisted vs isolated `.pnpm`) may place multiple physical
// copies. So rather than resolving a single path, we walk node_modules and chmod
// EVERY `app-builder` binary we find. Best-effort + idempotent.
import { chmodSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

// Binary basenames app-builder-bin ships (Linux/mac; Windows .exe needs no chmod).
const BINARY_NAMES = new Set(['app-builder', 'app-builder_amd64', 'app-builder_arm64']);

let chmodded = 0;

function walk(dir, depth) {
  // Bound recursion: these binaries live at node_modules/**/app-builder-bin/<os>/<arch>/…,
  // never deep. Cap depth to keep this fast on a large tree.
  if (depth > 8) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    try {
      if (entry.isDirectory()) {
        // Skip nested node_modules of unrelated packages only shallowly — app-builder-bin
        // may itself be nested, so we DO descend into node_modules dirs.
        walk(full, depth + 1);
      } else if (entry.isFile() && BINARY_NAMES.has(entry.name) && full.includes('app-builder-bin')) {
        const mode = statSync(full).mode;
        chmodSync(full, mode | 0o111); // u+x,g+x,o+x
        chmodded += 1;
      }
    } catch {
      /* best-effort per entry */
    }
  }
}

walk('node_modules', 0);
if (chmodded > 0) {
  console.info(`[fix-app-builder-bin-perms] set +x on ${chmodded} app-builder binary(ies)`);
}
