# Node SEA Plugin Host

## Status

Accepted and implemented in production. The original feasibility experiment is
still available in `scripts/verify-sea-plugin-host.mjs`, but normal plugin
loading now selects between the lighter Node SEA host and the Electron utility
compatibility host before activation.

Every plugin still receives its own OS process. The SEA work changes the
runtime baseline; it does not combine plugins or weaken fault/resource
isolation.

## Why a second runtime exists

An Electron utility process preserves the entire Electron/Node environment but
charges even a small config-only plugin for that runtime. A signed Node Single
Executable Application (SEA) provides Node and the same Kai compatibility
runtime without Chromium/Electron initialization.

The host executable is shared on disk and in file-backed code pages, while
each launch has a distinct PID, heap, event loop, control channel, and lifecycle.
Plugins continue exporting the existing `activate(api)`, optional
`deactivate()`, and optional `onConfigChanged()` functions; no plugin rewrite is
required.

## Runtime selection

Selection is conservative and occurs before any plugin code runs. Kai uses SEA
when all of the following are true:

- the signed host for the current platform/architecture exists and is
  executable;
- the backend is inside the scanned plugin tree;
- the bounded scan finds no `.node` addon, native package metadata, or direct
  `electron` dependency; and
- the plugin does not request a permission class measured locally as cheaper in
  the Electron host.

The currently measured Electron-favored permission classes are `safe-storage`,
conversation reads/writes, `system:env`, and `agent:inference-provider`. These
APIs can start the synchronous compatibility worker, at which point Electron's
shared framework pages make its private footprint lower. `tools:register` by
itself stays workerless: JSON-Schema tool plugins use SEA, while a root Zod
dependency or direct Zod import routes the plugin to Electron because the
repeated Zod-only measurement remains slightly lower there. This is a routing
optimization, not a capability restriction: those plugins remain isolated in
their own Electron utility process.

Native addons and direct Electron consumers also use the utility host. A scan
error or configured size/file limit is treated the same way. Kai never retries
activation in the other runtime after plugin code has started, because doing so
could duplicate registrations or other side effects.

For development diagnostics only, `KAI_PLUGIN_HOST_RUNTIME=sea` and
`KAI_PLUGIN_HOST_RUNTIME=electron` force a runtime. `KAI_PLUGIN_SEA_HOST` can
point at an explicit executable.

## Shared compatibility runtime

`electron/plugins/process/plugin-runtime.ts` is Electron-free and runs in both
hosts. It preserves:

- config/state mirrors and ordered writes;
- true synchronous calls through the demand-started worker bridge;
- callbacks, hooks, actions, tools, progress events, and inference providers;
- async generators and bidirectional `AbortSignal` propagation;
- outbound Zod 4 tool schemas through their own JSON-Schema converter, with the
  external decoder loaded only if a schema actually crosses toward the plugin;
  and
- activation, config change, graceful deactivation, crash, and kill behavior.

The SEA runtime cannot import Electron's `net` module. Its `fetch` adapter
therefore streams request and response bodies through the bounded control
protocol to the existing permission-enforcing main-process `PluginAPI.fetch`.
This retains Electron session/proxy/certificate behavior, status and redirect
metadata, headers, streaming, and cancellation without buffering whole bodies.

## Process and channel hardening

The production host:

- is built from checksum-pinned official Node 24.14.0 archives;
- uses `execArgvExtension: "none"`, a fixed heap ceiling, no CLI arguments, and
  a sanitized environment;
- accepts its one initialization frame through inherited stdin;
- binds no public listener and connects only to the main process's IPv4
  loopback endpoint;
- authenticates both peers with a per-launch 256-bit token and HMAC challenge;
- re-hashes `backend.js` immediately before import;
- uses bounded frames, call/message rate limits, concurrency limits, and output
  backpressure; and
- extracts embedded runtime assets into a private mode-0700 temporary directory
  that is removed on exit.

This boundary provides fault and resource isolation, not a hostile-code
sandbox. A granted plugin can still exercise the capabilities represented by
its permissions.

## Measured footprint

Local macOS arm64 measurements using the production protocol and OS physical
footprint sampler were:

| Fixture                                        |           Node SEA |   Electron utility |
| ---------------------------------------------- | -----------------: | -----------------: |
| Lightweight mirrored-config plugin             | about 16.2-16.5 MB | about 17.9-18.2 MB |
| JSON-Schema tool plugin                        | about 16.3-16.5 MB | about 17.9-18.1 MB |
| Zod-backed tool plugin                         | about 23.0-23.5 MB | about 22.5-22.8 MB |
| Unchanged LLM Gateway backend                  | about 17.2-17.5 MB |      about 18.3 MB |
| Full sync/inbound-schema compatibility fixture |     about 36-37 MB |        about 27 MB |

The isolated tool rows are five-run ranges. They replace the earlier inference
from the mixed tools/sync fixture: tool registration itself does not justify an
Electron host. The Zod row supports the narrow source/dependency preflight,
while the last row supports permission-based routing for true synchronous APIs.
Values vary with OS/runtime versions and plugin behavior; the Diagnostics GUI
is the source of truth for a running app.
The stripped arm64 host is roughly 110 MB on disk, paid once per architecture
in the application rather than once per plugin.

## Build and packaging

`pnpm build` generates the current platform/architecture host. Release builds
use `scripts/build-plugin-sea-host.mjs`; macOS builds explicitly generate both
`darwin-arm64` and `darwin-x64` so a universal app can select the native host.
The generated manifest records the Node version, input archive checksum,
pre-application-signing host hash/size, architecture, and plugin protocol
version. Final application signing intentionally changes the nested executable
hash and size.

Hosts are copied to:

```text
Contents/Resources/plugin-host/<platform>-<arch>/kai-plugin-host
```

(`kai-plugin-host.exe` on Windows). The after-pack hook restores executable
bits before application signing. The host is then covered by the normal
application code-signing/notarization pipeline.

The SEA and its embedded protocol cannot be replaced by Kai's preload/renderer
OTA overlay. `package.json#pluginProcessProtocolVersion` is the release
sentinel; changing it makes the release classifier require a full signed-app
update. The SEA build reads the same value into its generated manifest, and a
test keeps the shared runtime constant in sync.

## Verification

The real-process smoke uses the production executable and unchanged plugin
backends. It covers mutual authentication (including invalid-proof rejection),
integrity validation, config/state ordering, callbacks, tools, streams, aborts,
streamed fetch upload/download, metrics, pause/resume/kill, crash and IPC-flood
containment, deactivation, lazy worker/Zod loading, and LLM Gateway activation
without network egress.

Standard gates remain:

```bash
pnpm type-check
pnpm lint
pnpm test
pnpm build
pnpm verify:plugin-process
```

To run the same smoke through a built SEA host, first bundle the smoke host as
done by `verify:plugin-process`, then set `KAI_PLUGIN_SEA_HOST` to the generated
executable before launching `scripts/verify-plugin-process.mjs` with Electron.
