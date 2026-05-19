# ADR 0001: Electron Fuses Policy

- **Status**: Accepted
- **Date**: 2026-05-19
- **Deciders**: maintainers

## Context

Electron applications inherit a Chromium browser process plus a Node.js runtime
embedded in the same binary. That embedded Node is the part attackers care
about: if a malicious page or compromised dependency can convince the binary
to expose Node primitives, the sandbox is effectively gone and the process can
read the disk, exec child processes, and dial out over arbitrary protocols.

Electron exposes several historical opt-in surfaces that make this kind of
escape easier:

- `ELECTRON_RUN_AS_NODE` — when set in the environment, Electron behaves as
  a plain Node interpreter. Any tool that can spawn the app binary with this
  variable inherits a fully privileged Node REPL.
- `NODE_OPTIONS` — Node honours this variable on every interpreter start.
  Useful for developers, but it also means a packaged Electron binary will
  load arbitrary `--require <file>` modules if the variable is set in the
  invoking shell.
- `--inspect` / `--inspect-brk` / `--remote-debugging-port` — the V8 inspector
  exposes a TCP debug socket that grants read/write access to the running
  JavaScript context. In production we never want this surface to be
  reachable.
- ASAR loading — the packaged app code lives inside `app.asar`. Loading code
  from anywhere else (a writable directory, a swapped-in `.asar.unpacked`
  payload) is a tampering vector.

[Electron Fuses](https://www.electronjs.org/docs/latest/tutorial/fuses) are
the supported mitigation. A fuse is a single bit baked into the Electron
binary at build time. The values are checked by the loader before user code
runs. Because the bits are inside the Mach-O / PE binary itself, they are
covered by the same code-signing seal that protects the rest of the bundle —
you cannot flip a fuse without invalidating the signature, and you cannot
re-sign without the original signing identity.

Fuses are **distinct from**:

- The Chromium sandbox flag (`--no-sandbox`), which controls the OS-level
  child-process sandbox at runtime.
- `nodeIntegration` / `contextIsolation` in `webPreferences`, which control
  what the renderer can see.
- Hardened-runtime entitlements, which control what macOS itself lets the
  packaged app do.

A fuse bit is a build-time property of the binary. The other three are
runtime properties of how the app is launched and how it constructs its
windows. All four matter; this ADR concerns the fuses.

## Decision

We assert the following six fuses on every Mac build, and CI fails the
release path if any one disagrees with the expected value:

| Fuse                                    | Value   | Rationale                                                                                                                                                                                                |
| --------------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RunAsNode`                             | `false` | Disables the `ELECTRON_RUN_AS_NODE` behaviour. With this fuse off, no environment variable can repurpose the signed binary as a generic Node interpreter.                                                |
| `EnableCookieEncryption`                | `true`  | Encrypts the Chromium cookie store at rest using the OS keychain. Without this, a session cookie written to disk is recoverable by any process that can read the file.                                   |
| `EnableNodeOptionsEnvironmentVariable`  | `false` | Causes Electron to ignore `NODE_OPTIONS` entirely. A user shell exporting `NODE_OPTIONS="--require /tmp/payload.js"` cannot force the packaged app to load that script.                                  |
| `EnableNodeCliInspectArguments`         | `false` | Strips `--inspect`, `--inspect-brk`, and `--remote-debugging-port` from the recognised command-line surface. No production binary should ever expose a debug socket.                                     |
| `EnableEmbeddedAsarIntegrityValidation` | `true`  | Validates the SHA-256 of `app.asar` against the value embedded in the binary at every launch. A swapped or patched `app.asar` fails the check and the app refuses to start.                              |
| `OnlyLoadAppFromAsar`                   | `true`  | Forbids loading application code from anywhere other than the embedded `app.asar`. Combined with the integrity check above, this closes the "drop a malicious file next to the bundle" tampering vector. |

The authoritative gate is `scripts/verify-fuses.ts` (added by a sibling
PR in this hardening stream). That script reads the fuse bits out of the
packaged binary on disk and compares them against the table above. It
runs on the macOS packaging job because the fuses only exist in the
packaged binary, not in `pnpm dev` output.

A complementary **static security lint** runs in the lint job on Linux and
catches the same regression class on cheap runs without needing a packaged
binary. The lint inspects [`electron-builder.template.yml`](../../electron-builder.template.yml)
and the renderer / preload sources for the well-known patterns that
disable fuses (for example, a stray `runAsNode: true` in the builder
config, or `webPreferences.nodeIntegration: true` in a `BrowserWindow`
constructor). Linux lint is cheap and runs on every PR; the Mac fuse
check is expensive and gated. The two together give us a fast-fail signal
before the Mac job ever spins up.

## Consequences

### Positive

- **Eliminates a class of escape vectors.** Once these fuses are locked in
  on the signed binary, `ELECTRON_RUN_AS_NODE`, `NODE_OPTIONS`, and
  `--inspect` cannot be used to coerce the production app into running
  arbitrary code, regardless of what the invoking shell environment looks
  like. ASAR integrity plus the load restriction make it impossible to
  swap in a tampered app payload without re-signing.
- **Verifiable in CI.** Because the fuse bits are deterministic and
  on-disk, the verification script is a flat compare, not a probabilistic
  check. There is no false-negative path.
- **Cheap to maintain.** The fuse table changes maybe once per Electron
  major version. The script reads the canonical positions from the
  [`@electron/fuses`](https://www.npmjs.com/package/@electron/fuses)
  package so an Electron upgrade that shifts a fuse offset is handled by
  re-running the package.

### Negative

- **No `NODE_OPTIONS` against production builds.** Developers who want to
  attach `--require` shims, set `--max-old-space-size`, or otherwise
  influence the Node runtime cannot do it against a signed production
  build. They must use the unpackaged dev build.
- **No `--inspect` against production builds.** The same applies to the
  V8 inspector. You cannot attach a debugger to a signed production app;
  you have to reproduce the issue against `pnpm dev` or a non-signed
  local build that has the fuses relaxed.
- **`ELECTRON_RUN_AS_NODE` is unavailable.** Some build tooling (e.g.
  rebuilding native modules against the embedded Node ABI) historically
  relied on this. Anything that needs that pathway has to invoke a
  separate Node binary rather than reusing the Electron binary.

### Mitigation

- The **dev build** does not have these fuses asserted. `pnpm dev` runs
  Electron against unpackaged JavaScript with no fuse enforcement, so
  developers retain `NODE_OPTIONS`, `--inspect`, and friends locally.
- The fuse table in this ADR plus `scripts/verify-fuses.ts` is the
  single source of truth. If a future change needs to flip a fuse, that
  change lands as a new ADR superseding this one, not as a quiet edit
  to the script.

## References

- [Electron Fuses documentation](https://www.electronjs.org/docs/latest/tutorial/fuses)
- [`@electron/fuses` on npm](https://www.npmjs.com/package/@electron/fuses)
- `scripts/verify-fuses.ts` — authoritative CI gate that asserts the
  table above against the packaged binary. Added by a sibling PR in this
  hardening stream.
- [`electron-builder.template.yml`](../../electron-builder.template.yml) —
  packaging config; the static security lint reads this file.
