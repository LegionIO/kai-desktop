# ADR 0006: Plugin Backend Process Isolation

- **Status**: Accepted and implemented
- **Date**: 2026-07-20
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

Run every enabled plugin backend in its own Electron `utilityProcess`. Keep a
thin, permission-enforcing broker in the main process for Electron-only state
and live handles. Preserve the existing plugin API call shapes through two
purpose-built transports.

### Process topology

Each plugin gets:

- one Electron utility process named `Kai Plugin: <plugin-name>`;
- one worker thread inside that utility process for synchronous RPC; and
- one authenticated loopback broker connection to the main process.

The worker thread is deliberately inside the plugin's utility process. It can
continue servicing the broker while the plugin's JavaScript thread waits with
`Atomics.wait`, and all of its CPU/memory remains attributed to the same plugin
OS process.

### Synchronous compatibility channel

Legacy synchronous API methods retain their synchronous return values. The
utility thread encodes a request, hands it and a `SharedArrayBuffer` to its
worker, and waits. The worker performs asynchronous loopback I/O to the main
broker, writes the response into shared memory, and wakes the utility thread.
The main event loop never blocks on the plugin.

The broker is:

- bound only to `127.0.0.1` on an ephemeral port;
- authenticated with a per-process 256-bit random token;
- framed and size-bounded; and
- rate-limited per plugin to contain API-call floods.

### Asynchronous and bidirectional channel

Electron's utility-process message port carries:

- async API calls and results;
- tools, message hooks, lifecycle hooks, agent hooks, events, and actions;
- tool-progress callbacks in the reverse direction;
- auth-window helper callbacks and HTTP request handlers;
- cancellation in both directions via proxied `AbortSignal`s; and
- `agent.stream` and inference-provider streams as chunk/end/error sequences.

Functions are represented by opaque callback IDs, never source serialization.
Zod tool schemas cross as JSON Schema and are reconstructed on the receiving
side. Other supported non-JSON values use explicit tagged wire forms.

### Main-side broker responsibilities

`createPluginAPI` remains the single permission and behavior implementation.
The main-side process host calls that real API, so isolation does not duplicate
or bypass permission checks. Main-only objects stay in main:

- `BrowserWindow`, sessions, notifications, shell, and `safeStorage`;
- HTTP servers;
- conversation/config stores and published UI state; and
- the agent tool registry and generator implementation.

The streaming `net.fetch` implementation runs directly through Electron's
`net` module in the utility process, with the same HTTP(S)-only permission
gate, so a `Response` body remains streamable rather than being fully buffered
through IPC.

### Lifecycle and fault containment

Activation, config-change forwarding, deactivation, hot enable/disable, update
rollback, and uninstall all target the owning process host. Deactivation has a
bounded graceful window followed by `UtilityProcess.kill()`.

If a utility process crashes or exits unexpectedly, the manager:

- marks only that plugin as errored;
- rejects its pending calls and streams;
- removes its tools, hooks, actions, subscriptions, and inference provider;
- closes main-side resources such as its HTTP server; and
- leaves the main application and all other plugin processes running.

### Resource diagnostics

`app.getAppMetrics()` is joined to the process registry by PID. The Kai
Diagnostics GUI refreshes every five seconds and shows, per plugin:

- PID;
- CPU percentage;
- private memory when supplied by Electron, otherwise working-set memory;
- process state;
- crash count and last error.

The same table exposes pause, resume, kill, disable, and enable controls.
Pause/resume uses `SIGSTOP`/`SIGCONT` on supported POSIX platforms, so a
CPU-bound backend is suspended by the OS rather than asked to cooperate. Kill
targets only the selected utility process. Disable/enable goes through the
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

## Consequences

### Positive

- CPU, memory, crashes, and fatal V8 failures are attributable per plugin.
- CPU loops and ordinary memory leaks cannot block the main event loop or other
  plugin event loops.
- Existing plugins continue using the same public API without rewrites.
- Permission enforcement and Electron-only resources remain centralized.

### Negative

- Each enabled plugin now carries an Electron utility-process baseline and one
  worker thread, increasing total application memory.
- Cross-boundary calls cost more than in-process function calls.
- A plugin can still consume broker work by calling host APIs; message size and
  per-second/concurrency limits bound that path but do not make plugins a
  security sandbox. A process flooding the host IPC channel is terminated.
- Undocumented direct access to main-only Electron exports from `backend.js` is
  no longer possible. The documented `PluginAPI` is preserved.

### Mitigations

- Published state remains locally readable in the utility process, while writes
  are mirrored synchronously, avoiding a host round-trip for `state.get()`.
- Output pipes are rate-limited and backpressured per plugin.
- Activation/deactivation, synchronous RPC, and availability polling have
  bounded timeouts.
- The Diagnostics GUI makes process overhead and regressions visible.

## Verification

- Unit tests cover wire encoding, callback references, Zod schemas, synchronous
  compatibility, state mirroring, tools, generators, and inference providers.
- `pnpm verify:plugin-process` launches real Electron utility processes and
  verifies activation, config/event callbacks, tools and progress, hooks,
  actions, safe storage, agent streams, inference-provider streams, metrics,
  pause/resume, forced termination, graceful teardown, and crash containment.
- The normal `type-check`, `lint`, `test`, and `build` gates remain required.

## References

- Runtime host: `electron/plugins/process/plugin-process-host.ts`
- Utility runtime: `electron/plugins/process/utility-entry.ts`
- Compatibility API: `electron/plugins/process/utility-api.ts`
- Synchronous bridge: `electron/plugins/process/sync-rpc-worker.ts`
- Wire protocol: `electron/plugins/process/wire.ts`
- Lifecycle integration: `electron/plugins/plugin-manager.ts`
- Resource UI: `src/components/settings/DiagnosticsSettings.tsx`
