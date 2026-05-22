/**
 * Cross-platform wrapper for Swift helper compilation.
 *
 * On macOS, invokes `scripts/compile-swift-helper.sh` to build the
 * LocalMacosHelper binary. On other platforms, this script is a no-op
 * since the Swift helper is macOS-only.
 *
 * Usage:  node scripts/maybe-compile-swift.mjs
 *         (called by `pnpm dev` and `pnpm build`)
 */

import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

if (process.platform === 'darwin') {
  const script = resolve(root, 'scripts/compile-swift-helper.sh');
  try {
    execFileSync('bash', [script], { cwd: root, stdio: 'inherit' });
  } catch (error) {
    console.error('[maybe-compile-swift] Swift helper compilation failed:', error.message);
    process.exit(1);
  }
} else {
  console.info('[maybe-compile-swift] Skipping Swift helper compilation (not macOS).');
}
