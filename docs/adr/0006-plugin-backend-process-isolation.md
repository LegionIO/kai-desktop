# ADR 0006: Plugin Backend Process Isolation

- **Status**: Accepted and implemented
- **Date**: 2026-07-20
- **Amended**: 2026-07-21 — hybrid Node SEA/Electron host selection
- **Deciders**: maintainers

## Context

Plugin backends previously ran inside Electron's main process. Each plugin's
`backend.js`, `activate(api)`, timers, WebSockets, caches, tool bodies, hooks,
and inference providers therefore shared one event loop and one OS process.

That design had two unacceptable properties:

1. The OS could not attribute CPU or memory to a specific plugin.
2. A plugin crash, infinite loop, or memory leak could degrade or terminate the
   main application and every other plugin.

Moving a backend across a process boundary is not a simple `fork()`. The public
plugin API intentionally contains synchronous methods (`config.get`,
`state.set`, `safeStorage.encryptString`, conversation access), callback
registrations (tools, hooks, events, actions, auth helpers), `AbortSignal`s, and
async generators. Requiring every plugin to become async would be a breaking
API-major migration and would force rewrites of existing plugins.

## Decision

Run every enabled plugin backend in its own OS process. Select a signed Node SEA
host for compatible lightweight plugins and an Electron `utilityProcess` for
native/Electron-dependent or measured-heavy compatibility cases. Keep a thin,
permission-enforcing broker in the main process for Electron-only state and
live handles. Preserve the existing plugin API call shapes through the shared
compatibility runtime and purpose-built transports.

### Process topology

Each plugin gets:

- one distinct Node SEA or Electron utility process named
  `Kai Plugin: <plugin-name>`;
- an on-demand worker thread inside that process for synchronous RPC;
- one authenticated loopback broker connection to the main process.

The worker thread is created only when a plugin makes a synchronous API call
that must return a host value. It is deliberately inside the plugin's process:
it can continue servicing the broker while the plugin's JavaScript thread waits
with `Atomics.wait`, and all of its CPU/memory remains attributed to the same
plugin OS process. Registration-only plugins never pay for its V8 isolate or
16 MiB shared response buffer. SEA embeds the worker source and materializes it
only on first use; Electron uses the packaged worker entry point.

Runtime selection completes before activation. A bounded plugin-tree scan
routes `.node` addons, native package metadata, direct Electron dependencies,
scan failures, and oversized trees to Electron. Permissions whose measured
compatibility cost makes Electron smaller (`tools:register`, safe storage,
conversation access, system environment, and inference providers) also use the
utility host. There is no post-activation fallback because retrying could
duplicate plugin side effects.

### Synchronous compatibility channel

Legacy synchronous API methods retain their synchronous return values. The
plugin runtime thread encodes a request, hands it and a `SharedArrayBuffer` to its
worker, and waits. The worker performs asynchronous loopback I/O to the main
broker, writes the response into shared memory, and wakes the utility thread.
The main event loop never blocks on the plugin.

Frequently used config reads are served from a process-local mirror. Config,
state, registration, and other void-returning calls retain their synchronous
call shape but use a numbered IPC queue. Later async, stream, and true sync
calls carry an ordering barrier, so they cannot overtake those side effects.
This preserves existing plugin behavior while avoiding the worker for plugins
such as LLM Gateway that only read/write config and register UI/actions.

The broker is:

- bound only to `127.0.0.1` on an ephemeral port;
- authenticated with a per-process 256-bit random token;
- framed and size-bounded; and
- rate-limited per plugin to contain API-call floods.

### Asynchronous and bidirectional channel

The Electron message port or SEA authenticated control socket carries:

- async API calls and results;
- tools, message hooks, lifecycle hooks, agent hooks, events, and actions;
- tool-progress callbacks in the reverse direction;
- auth-window helper callbacks and HTTP request handlers;
- cancellation in both directions via proxied `AbortSignal`s; and
- `agent.stream` and inference-provider streams as chunk/end/error sequences.

Functions are represented by opaque callback IDs, never source serialization.
Zod tool schemas cross as JSON Schema and are reconstructed on the receiving
side. The bundled Zod codec is loaded as a separate dynamic chunk only for
plugins declaring `tools:register`; plugins without schemas do not load it.
Other supported non-JSON values use explicit tagged wire forms.

### Main-side broker responsibilities

`createPluginAPI` remains the single permission and behavior implementation.
The main-side process host calls that real API, so isolation does not duplicate
or bypass permission checks. Main-only objects stay in main:

- `BrowserWindow`, sessions, notifications, shell, and `safeStorage`;
- HTTP servers;
- conversation/config stores and published UI state; and
- the agent tool registry and generator implementation.

Electron utility hosts run streaming `net.fetch` directly. SEA cannot import
Electron, so it streams request and response bodies through the control
protocol to the existing main-process `PluginAPI.fetch`. Both paths keep the
same HTTP(S)-only permission gate and preserve headers, status, redirect
metadata, proxy/session behavior, `AbortSignal`, and a streamable `Response`
without buffering whole bodies.

### Lifecycle and fault containment

Activation, config-change forwarding, deactivation, hot enable/disable, update
rollback, and uninstall all target the owning process host. Deactivation has a
bounded graceful window followed by runtime-appropriate process termination.

If either host crashes or exits unexpectedly, the manager:

- marks only that plugin as errored;
- rejects its pending calls and streams;
- removes its tools, hooks, actions, subscriptions, and inference provider;
- closes main-side resources such as its HTTP server; and
- leaves the main application and all other plugin processes running.

### Resource diagnostics

The process registry is joined to OS samples by PID. Electron metrics remain a
fallback for utility processes; `ps` supplies CPU, cumulative CPU, and RSS for
both runtimes on POSIX, PowerShell supplies working set/private bytes on
Windows, and one bounded `/usr/bin/footprint` query supplies physical footprint
for all live plugin PIDs on macOS while the panel is being polled. The Kai
Diagnostics GUI refreshes every five seconds and shows, per plugin:

- PID;
- CPU percentage;
- physical/private footprint as the primary memory value, with RSS/working set
  shown separately;
- process state;
- crash count and last error; and
- selected runtime and routing reason.

The same table exposes pause, resume, kill, disable, and enable controls.
Pause/resume uses `SIGSTOP`/`SIGCONT` on supported POSIX platforms, so a
CPU-bound backend is suspended by the OS rather than asked to cooperate. Kill
targets only the selected plugin process. Disable/enable goes through the
normal plugin lifecycle and persistence rules.

These are OS process metrics, not estimated API activity.

## Considered alternatives

### Main-process metrics only

Rejected because it cannot attribute resource use to a plugin and provides no
fault or event-loop isolation.

### In-process API activity accounting

Rejected as the primary solution because it misses pure computation, native
work, and memory leaks. It also does not protect the main event loop.

### Async-only plugin API

Rejected because it would break every synchronous plugin caller and require a
plugin API major version. The worker-backed compatibility bridge preserves the
current contract instead.

### One shared plugin child process

Rejected because one runaway plugin would still affect every other plugin and
the OS could not provide per-plugin accounting.

### Node SEA for every plugin

Rejected because native addons and direct Electron dependencies require the
compatibility host, and measured tools/synchronous fixtures used less private
memory in Electron than in SEA. Conservative pre-activation routing preserves
functionality while still reducing the baseline for light plugins such as LLM
Gateway.

## Consequences

### Positive

- CPU, memory, crashes, and fatal V8 failures are attributable per plugin.
- CPU loops and ordinary memory leaks cannot block the main event loop or other
  plugin event loops.
- Existing plugins continue using the same public API without rewrites.
- Permission enforcement and Electron-only resources remain centralized.

### Negative

- Each enabled plugin still carries a Node/V8 process baseline. Plugins that
  require true synchronous host results additionally carry a worker thread and
  shared response buffer. The SEA executable also adds roughly 110 MB per
  architecture to application disk size, shared by all SEA plugin processes.
- Cross-boundary calls cost more than in-process function calls.
- A plugin can still consume broker work by calling host APIs; message size and
  per-second/concurrency limits bound that path but do not make plugins a
  security sandbox. A process flooding the host IPC channel is terminated.
- Native or direct-Electron plugins retain the higher Electron compatibility
  baseline. The documented `PluginAPI` is preserved in both runtimes.

### Mitigations

- Published state remains locally readable in the plugin process, while writes
  are mirrored synchronously, avoiding a host round-trip for `state.get()`.
- App and plugin config mirrors preserve synchronous reads and read-after-write
  behavior without starting the compatibility worker.
- The sync worker and Zod transport chunk are both demand-driven.
- Lightweight compatible plugins use SEA; measured-heavy permission classes
  remain on Electron when its private footprint is lower.
- Output pipes are rate-limited and backpressured per plugin.
- Activation/deactivation, synchronous RPC, and availability polling have
  bounded timeouts.
- The Diagnostics GUI makes process overhead and regressions visible.

### Packaging and update compatibility

Release builds construct SEA hosts from checksum-pinned official Node 24.14.0
archives. macOS packages include native arm64 and x64 hosts, restore executable
bits in `afterPack`, and cover the nested binaries with the normal application
signing/notarization flow. SEA initialization arrives only through inherited
stdin; the control connection mutually authenticates with a per-launch secret
and HMAC challenge. The runtime revalidates the backend hash immediately before
import and rejects CLI/Node option extension.

SEA binaries and app.asar main entrypoints cannot be changed by Kai's
preload/renderer-only OTA overlay. `pluginProcessProtocolVersion` therefore
remains a full-update sentinel. The build reads it into the SEA manifest, and
the release classifier rejects OTA eligibility when it changes.

## Verification

- Unit tests cover wire encoding, callback references, Zod schemas, synchronous
  compatibility, state mirroring, tools, generators, and inference providers.
- `pnpm verify:plugin-process` launches real Electron utility processes and
  verifies activation, config/event callbacks, tools and progress, hooks,
  actions, safe storage, agent streams, inference-provider streams, metrics,
  pause/resume, forced termination, graceful teardown, crash containment, and a
  workerless LLM-Gateway-shaped activation path.
- The same real-process smoke against the production SEA executable additionally
  verifies mutual authentication and invalid-proof rejection, streamed fetch
  upload/download and abort, unchanged LLM Gateway activation, lazy worker/Zod
  loading, runtime metrics, and control/crash/flood containment.
- The normal `type-check`, `lint`, `test`, and `build` gates remain required.

## References

- Runtime host: `electron/plugins/process/plugin-process-host.ts`
- Utility runtime: `electron/plugins/process/utility-entry.ts`
- Shared runtime: `electron/plugins/process/plugin-runtime.ts`
- SEA runtime: `electron/plugins/process/sea-runtime-entry.ts`
- Runtime selection: `electron/plugins/process/runtime-selection.ts`
- Streaming fetch broker: `electron/plugins/process/broker-fetch.ts`
- SEA builder: `scripts/build-plugin-sea-host.mjs`
- Compatibility API: `electron/plugins/process/utility-api.ts`
- Synchronous bridge: `electron/plugins/process/sync-rpc-worker.ts`
- Wire protocol: `electron/plugins/process/wire.ts`
- Lifecycle integration: `electron/plugins/plugin-manager.ts`
- Resource UI: `src/components/settings/DiagnosticsSettings.tsx`
