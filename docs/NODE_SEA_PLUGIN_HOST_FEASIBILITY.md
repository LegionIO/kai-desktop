# Node SEA Plugin Host Feasibility

## Status

Feasibility proof only. This experiment is deliberately separate from the
production Electron utility-process host and does not alter plugin loading.

Run it with Node 25.5 or newer:

```bash
node scripts/verify-sea-plugin-host.mjs
```

If the active Node was built without SEA support (Homebrew may expose the flag
while compiling the feature out), point the proof at a pinned official binary:

```bash
KAI_SEA_NODE_BINARY=/absolute/path/to/official-node/bin/node \
  node scripts/verify-sea-plugin-host.mjs
```

For Node 20-24, also provide `postject`:

```bash
KAI_SEA_NODE_BINARY=/absolute/path/to/node \
KAI_SEA_POSTJECT=/absolute/path/to/postject \
  node scripts/verify-sea-plugin-host.mjs
```

An existing plugin backend can be included in the smoke run without copying or
modifying it:

```bash
KAI_SEA_SMOKE_PLUGIN=/absolute/path/to/plugin/dist/backend.js \
KAI_SEA_NODE_BINARY=/absolute/path/to/node \
KAI_SEA_POSTJECT=/absolute/path/to/postject \
  node scripts/verify-sea-plugin-host.mjs
```

Node 24 uses the same SEA format but requires the older preparation-blob plus
`postject` build sequence. Production should use a pinned official or
Kai-built Node binary rather than whichever Node happens to run the build.

## What the proof establishes

The verification script creates a temporary, ad-hoc-signed SEA executable and
launches two copies. It verifies that the host can:

- ignore `NODE_OPTIONS` (`execArgvExtension: "none"`) and refuse generic Node
  CLI arguments;
- accept initialization through a private stdin pipe;
- authenticate to a loopback broker with a per-process random token;
- hash an external plugin backend before loading it;
- load an external ESM plugin containing top-level `await` without rewriting
  the plugin;
- publish API operations and invoke an asynchronous plugin callback;
- survive a sibling plugin host being force-killed; and
- deactivate and exit cleanly.

Node SEA entrypoints cannot directly import filesystem ESM. The proof embeds a
small CommonJS loader as a SEA asset, writes it into a mode-0700 temporary
directory, loads it as an ordinary filesystem module, and immediately removes
the extraction directory. Dynamic imports initiated by that ordinary module
use Node's normal ESM loader. This preserves top-level-await support.

## Local measurements

The proof was exercised on macOS arm64 with a self-contained Node 24.14 binary
and `postject` 1.0.0-alpha.6:

| Item                              | Measurement              |
| --------------------------------- | ------------------------ |
| SEA executable                    | 118,229,824 bytes        |
| Fixture host physical footprint A | 13.4 MB                  |
| Fixture host physical footprint B | 13.1 MB                  |
| Fixture host RSS                  | approximately 47 MB each |
| Stripped SEA executable           | 109,807,760 bytes        |
| Stripped fixture physical memory  | 13.1 MB                  |
| Stripped fixture RSS              | approximately 39 MB each |

The existing LLM Gateway `dist/backend.js` also activated, registered its
settings/actions, deactivated, and exited without source changes. It was given
unconfigured plugin data so the proof did not perform authentication or
network traffic.

The executable is a one-time application-size cost, not a per-plugin disk
cost. Every plugin launches the same signed file, and the OS can share its
read-only code pages. Node 24 and universal arm64/x64 packaging will have
different binary sizes and must be measured in the release build.

The Node 24 binary reported native module ABI 137 and N-API 10. Electron
41.2's embedded Node 24.14 reports module ABI 145 and N-API 10. This confirms
that classic Electron-targeted `.node` addons need the utility-process
fallback, while N-API addons remain candidates after explicit testing.

The SEA configuration used `execArgvExtension: "none"`; the verification
launched both the CLI-refusal probe and plugin hosts with a deliberately
invalid `NODE_OPTIONS=--require=...` value. Node 24 ignored it and completed
the proof, so the intended production hardening is empirically supported.

## Proposed production topology

```text
Electron main
  │
  ├── permission-enforcing PluginAPI broker
  │        │
  │        ├── signed Node SEA host: pure-JS/N-API plugin A
  │        ├── signed Node SEA host: pure-JS/N-API plugin B
  │        └── Electron utility process: Electron-ABI native plugin C
  │
  └── PID-based diagnostics and pause/resume/kill controls
```

One SEA executable is reused for every compatible plugin, but every launch is
a distinct OS process. Fault and resource isolation therefore remain
per-plugin.

## Production work still required

1. **Reuse the production protocol.** Replace the proof's intentionally small
   JSON API with the existing bounded wire codec, callback/stream transport,
   abort propagation, and permission-enforcing main broker.
2. **Move `electron.net`.** A Node host cannot import Electron's `net` module.
   To preserve proxy, certificate, and streaming behavior, perform fetches in
   Electron main and stream request/response bodies over the broker.
3. **Pin the runtime.** Download/build Node by version and SHA-256 in release
   CI. Do not rely on Homebrew, nvm, or the build machine's `PATH`.
4. **Build each architecture.** Produce arm64/x64 hosts in the corresponding
   packaging jobs, merge them for a universal macOS app if required, then sign
   the final binary with Kai's identity and include it in notarization.
5. **Harden parent authentication.** The random broker token prevents a host
   from joining an existing Kai process, but a standalone caller can still
   launch the fixed host and provide its own initialization. Consider signing
   the initialization payload with an installation key or requiring an
   inherited endpoint that is never addressable by path/port.
6. **Close the hash/load race.** Production should open and verify the plugin
   file once, then load from that verified descriptor or an immutable private
   copy. The current utility host has the same path-based race.
7. **Native compatibility routing.** N-API addons should be tested by version;
   addons built specifically for Electron's module ABI must continue using the
   utility-process host. Detect this before activation so fallback cannot
   duplicate side effects.
8. **OTA protocol/versioning.** The SEA binary and embedded host cannot be
   replaced by an app.asar-only update. Changes to its protocol must require a
   full signed application update, like the current plugin process entrypoints.
9. **Resource limits.** Apply a per-host V8 heap limit and retain broker rate,
   message-size, and in-flight limits. Native allocations still require
   monitoring and kill thresholds.

## Packaging observations

- Stripping symbols mainly reduces disk size. The runtime memory reduction
  comes from avoiding Chromium/Electron utility-process initialization.
- In this sample, stripping before injection reduced the signed arm64 SEA by
  about 8.4 MB and gzip size by about 2.6 MB. It reduced RSS because fewer
  file-backed pages were mapped but did not materially change physical
  footprint. The stripped input must be re-signed before macOS will execute it,
  and the final injected host must receive Kai's production signature.
- Node 25.5+ can create the executable directly with `--build-sea`; Node 24
  needs `--experimental-sea-config` followed by `postject`.
- `useCodeCache` must remain disabled because Node documents that dynamic
  `import()` is unavailable when SEA code cache is enabled.
- `execArgvExtension: "none"` is load-bearing: it ignores `NODE_OPTIONS` and
  prevents CLI extension of Node/V8 flags.
- Some package-manager Node executables dynamically link a separately installed
  `libnode`. Release builds must verify that the chosen runtime is actually
  redistributable and self-contained.
- The locally installed Homebrew Node 26 advertised `--build-sea` but reported
  that SEA was compiled out. The NVM Node 22 binary completed the legacy flow.
  This confirms that runtime capability must be tested, not inferred from
  `node --help`.
- The enterprise npm virtual registry accepted the existing `~/.npmrc` token
  for installing `postject` and `node-bin-darwin-arm64@24.14.0`. That package's
  binary was signed by the Node.js Foundation and had SHA-256
  `20a18709f0154d668f1bd6f6ea8c2a7ae001447b4b2c339732f22e57a8767a55`.
  The generic Node distribution mirror requires its own username/token
  permission; the npm token alone did not authorize a known cached artifact
  during this proof. Release CI should prefer a checksum-pinned official
  archive mirrored in the generic repository, or explicitly approve and lock
  the platform npm package as release input. The npm virtual exposed the arm64
  package but not the corresponding x64 package during this run, so universal
  packaging still depends on making the x64 archive available through the
  generic mirror.

## Expected integration strategy

Keep the existing utility-process implementation as a compatibility fallback.
Select the SEA host only after a preflight classifies the plugin as pure JS or
compatible N-API. This permits incremental rollout without changing plugin
source or sacrificing functionality.
