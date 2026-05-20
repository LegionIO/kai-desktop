#!/usr/bin/env node
/**
 * macOS node-pty native smoke test.
 *
 * Runs OUTSIDE vitest so the global `vi.mock('@lydell/node-pty')` in
 * `vitest.setup.ts` does NOT apply here. We exercise the real native
 * binding to catch ABI drift, missing rebuilds, and platform-specific
 * load failures before they hit users.
 *
 * Pass criteria:
 *   1. `require('@lydell/node-pty')` resolves cleanly.
 *   2. `pty.spawn('echo', ['hello'])` returns an IPty.
 *   3. The PTY emits 'hello' on stdout within the timeout window.
 *
 * Exit codes:
 *   0  smoke passed
 *   1  smoke failed (see stderr for the specific failure point)
 */

const path = require('node:path');
const { pathToFileURL } = require('node:url');

const SMOKE_TIMEOUT_MS = 10_000;
const EXPECTED_OUTPUT = 'hello';

function fail(stage, err) {
  const message = err instanceof Error ? err.stack || err.message : String(err);
  process.stderr.write(`[smoke-node-pty] FAILED at ${stage}: ${message}\n`);
  process.exit(1);
}

async function loadNodePty() {
  // @lydell/node-pty publishes a CommonJS entry. Use dynamic import so the
  // smoke script itself can stay CJS-portable across Node 22 ESM defaults.
  try {
    // Prefer require() — it surfaces native binding load errors with the
    // most informative stack trace.
    return require('@lydell/node-pty');
  } catch (cjsErr) {
    // Some pnpm layouts only expose ESM; fall back rather than failing fast.
    try {
      const resolved = require.resolve('@lydell/node-pty');
      const mod = await import(pathToFileURL(resolved).href);
      return mod.default ?? mod;
    } catch (esmErr) {
      fail('require/import @lydell/node-pty', new Error(`CJS: ${cjsErr.message}\nESM: ${esmErr.message}`));
    }
  }
}

async function main() {
  process.stdout.write(`[smoke-node-pty] node ${process.version} on ${process.platform}/${process.arch}\n`);
  process.stdout.write(`[smoke-node-pty] cwd=${process.cwd()}\n`);

  const pty = await loadNodePty();
  if (!pty || typeof pty.spawn !== 'function') {
    fail('module shape check', new Error(`expected pty.spawn to be a function, got ${typeof pty?.spawn}`));
  }
  process.stdout.write('[smoke-node-pty] require ok\n');

  let proc;
  try {
    // Pin cwd + env explicitly rather than inheriting from the surrounding
    // shell. The smoke runs in CI under the runner user — `process.env.HOME`
    // is reliable there but a developer hook environment might be hostile
    // (e.g. `HOME=/var/empty`). A fixed `cwd: '/tmp'` plus a minimal env
    // keeps the smoke deterministic regardless of who invoked it.
    proc = pty.spawn('echo', [EXPECTED_OUTPUT], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: '/tmp',
      env: { TERM: 'xterm-256color', PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
    });
  } catch (spawnErr) {
    fail('pty.spawn', spawnErr);
  }
  process.stdout.write('[smoke-node-pty] spawn ok\n');

  let collected = '';
  let resolved = false;

  const result = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      resolve({ ok: false, reason: `timed out after ${SMOKE_TIMEOUT_MS}ms (collected=${JSON.stringify(collected)})` });
    }, SMOKE_TIMEOUT_MS);

    const finalize = (verdict) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      resolve(verdict);
    };

    proc.onData((data) => {
      collected += String(data);
      if (collected.includes(EXPECTED_OUTPUT)) {
        finalize({ ok: true });
      }
    });

    proc.onExit(({ exitCode }) => {
      // If exit fires before we have seen the expected output we have to
      // check one last time — buffered chunks can land in the same tick.
      if (collected.includes(EXPECTED_OUTPUT)) {
        finalize({ ok: true });
      } else {
        finalize({
          ok: false,
          reason: `process exited with code=${exitCode} before "${EXPECTED_OUTPUT}" was seen (collected=${JSON.stringify(collected)})`,
        });
      }
    });
  });

  if (!result.ok) {
    fail('output assertion', new Error(result.reason));
  }

  process.stdout.write(`[smoke-node-pty] PASS (output=${JSON.stringify(collected.trim())})\n`);

  // Guard against the PTY keeping the event loop alive on some platforms.
  try {
    proc.kill();
  } catch {
    // best-effort cleanup
  }
  // Force-exit so a lingering PTY can't hold the runner open.
  setImmediate(() => process.exit(0));
}

main().catch((err) => fail('main', err));

// Path is referenced only for parity with other scripts/* entries; not used.
void path;
