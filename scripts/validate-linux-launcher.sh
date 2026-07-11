#!/bin/sh
# Validate bin/kai's Linux find_binary() resolution logic in a clean container.
#
# The Linux `kai` launcher is a pure-POSIX shim that locates the app's Electron
# ELF binary (from its own symlinked path, an env override, or a fixed install
# location) and exec's it with `--kai-cli`. This exercises that logic without a
# full Electron build by stubbing the "app binary" with a script that echoes its
# own path + args — so a correct launch proves the shim resolved the right
# target and forwarded `--kai-cli <args>`.
#
# Run directly on a Linux host, or via `pnpm validate:linux-cli` (Docker). The
# shim is copied to a writable path first so a read-only repo mount is fine.
set -eu

fail() { echo "FAIL: $1"; exit 1; }
pass() { echo "PASS: $1"; }

SRC_SHIM=${KAI_SHIM_PATH:-/work/bin/kai}
[ -f "$SRC_SHIM" ] || fail "shim not found at $SRC_SHIM (set KAI_SHIM_PATH)"
cp "$SRC_SHIM" /tmp/kai-shim
chmod +x /tmp/kai-shim
SHIM=/tmp/kai-shim

# Fake app binary standing in for the Electron ELF: echoes a marker + its args.
make_stub() {
  mkdir -p "$(dirname "$1")"
  printf '#!/bin/sh\necho "LAUNCHED:$0:$*"\n' > "$1"
  chmod +x "$1"
}

# Case 1: symlink on PATH → resources/bin/kai, ELF at <appRoot>/kai (deb layout).
APPROOT=/opt/Kai
make_stub "$APPROOT/kai"
mkdir -p "$APPROOT/resources/bin"
cp "$SHIM" "$APPROOT/resources/bin/kai"
chmod +x "$APPROOT/resources/bin/kai"
ln -sf "$APPROOT/resources/bin/kai" /usr/local/bin/kai
OUT=$(/usr/local/bin/kai hello world 2>&1) || fail "case1 exec failed: $OUT"
echo "$OUT" | grep -q "LAUNCHED:$APPROOT/kai:--kai-cli hello world" || fail "case1 wrong target/args: $OUT"
pass "case1 symlink→resources/bin→../../kai resolves + passes --kai-cli + args"

# Case 2: KAI_APP_BINARY override wins over everything.
make_stub /custom/mykai
OUT=$(KAI_APP_BINARY=/custom/mykai /usr/local/bin/kai x 2>&1) || fail "case2 exec failed: $OUT"
echo "$OUT" | grep -q "LAUNCHED:/custom/mykai:--kai-cli x" || fail "case2 override ignored: $OUT"
pass "case2 KAI_APP_BINARY override takes precedence"

# Case 3: shim with no adjacent app → fixed install location /opt/Kai/kai.
rm -f /usr/local/bin/kai
cp "$SHIM" /tmp/loosekai
chmod +x /tmp/loosekai
OUT=$(/tmp/loosekai probe 2>&1) || fail "case3 exec failed: $OUT"
echo "$OUT" | grep -q "LAUNCHED:$APPROOT/kai:--kai-cli probe" || fail "case3 fixed-location fallback failed: $OUT"
pass "case3 falls back to /opt/Kai/kai fixed location"

# Case 4: nothing resolvable → exit 127 with guidance.
rm -rf /opt/Kai /usr/lib/kai "${HOME:-/root}/.local/lib/kai" /custom
set +e
OUT=$(/tmp/loosekai nope 2>&1); RC=$?
set -e
[ "$RC" = "127" ] || fail "case4 expected exit 127, got $RC: $OUT"
echo "$OUT" | grep -q "could not locate the Kai app binary" || fail "case4 missing guidance: $OUT"
pass "case4 not-found → exit 127 + guidance"

echo "ALL LINUX LAUNCHER CASES PASSED"
