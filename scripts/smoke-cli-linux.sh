#!/bin/sh
# Compiled-CLI smoke test: run the built `out/main/cli.js` under a clean
# node:22-slim container (no Electron, no backend) and assert it fails FAST and
# CLEANLY rather than crashing on a bad import or hanging on stdin/socket.
#
# This proves the esbuild main bundle:
#   1. loads under plain Node (no hard `import 'electron'` at module load), and
#   2. reaches the backend-spawn guard and exits non-zero with actionable
#      guidance ("run `pnpm build`" / "run `pnpm install`") when no backend and
#      no dev Electron binary are present — instead of hanging.
#
# The interactive Ink TUI and a live agent turn both need a real TTY / running
# backend and are out of scope here; this is the deterministic, dependency-free
# slice that CI can run on every PR. Requires `pnpm build` to have produced
# out/main/cli.js first (the CI job builds before invoking this).
set -eu

REPO=$(cd "$(dirname "$0")/.." && pwd)
BUNDLE="$REPO/out/main/cli.js"
[ -f "$BUNDLE" ] || { echo "FAIL: $BUNDLE not found — run \`pnpm build\` first"; exit 1; }

# Run in a clean bare-node container: mount only out/ (no node_modules, no
# Electron), point KAI_HOME at a throwaway dir so it can't attach to any real
# backend, feed empty stdin, and cap the whole run so a hang fails loudly.
OUT=$(docker run --rm \
  -v "$REPO/out:/app/out:ro" \
  -e KAI_HOME=/tmp/kai-smoke \
  node:22-slim \
  sh -c 'cd /app && echo "" | timeout 40 node out/main/cli.js -p "smoke" --json; echo "EXIT=$?"' 2>&1) || true

echo "$OUT"

# 1. It must have terminated (our marker prints) and NOT hung into the 40s cap.
echo "$OUT" | grep -q "EXIT=" || { echo "FAIL: no EXIT marker — the CLI hung"; exit 1; }
echo "$OUT" | grep -q "EXIT=124" && { echo "FAIL: CLI hung (timeout 124)"; exit 1; }
echo "$OUT" | grep -q "EXIT=0" && { echo "FAIL: unexpectedly exited 0 with no backend"; exit 1; }

# 2. It must have loaded past all imports and reached the backend-spawn guard,
#    emitting actionable guidance (either missing-bundle or missing-electron).
if echo "$OUT" | grep -qE "run \`pnpm (build|install)\`|no running .* backend found"; then
  echo "PASS: compiled CLI loads under plain node + fails fast with guidance (no hang)"
else
  echo "FAIL: expected a backend-spawn guidance message; got the output above"
  exit 1
fi

echo "COMPILED-CLI LINUX SMOKE PASSED"
