# Plugin Process Isolation

Every enabled plugin backend runs in a separate OS process. Lightweight,
compatible plugins use a signed Node SEA host; plugins that need native or
heavier compatibility features use an Electron utility process. This document
is the operational companion to
[ADR 0006](./adr/0006-plugin-backend-process-isolation.md).

## Runtime map

```text
renderer ── existing plugin action IPC ──> Electron main
                                               │
                              permission-enforcing PluginAPI broker
                                               │
             ┌─────────────────────────────────┼─────────────────────────┐
             │                                 │                         │
       Node SEA: plugin A                Node SEA: plugin B       Electron utility: C
       backend.js + API                  backend.js + API          backend.js + API
       sync worker on demand             sync worker on demand     sync worker on demand
```

The renderer contract is unchanged. Only the backend-to-main boundary moved.

## What remains compatible

Plugins do not need to be rewritten. Config reads use a local mirror, and
void-returning writes/registrations use an ordered IPC queue; only APIs that
must synchronously return a host value start the compatibility worker. The
following retain their existing call shapes:

- synchronous config, state, conversations, environment, and safe-storage APIs;
- tool registration/execution, progress, and cancellation;
- message, lifecycle, agent, config, and event hooks;
- actions and UI/notification/navigation registration;
- auth-window helpers and cookie-promotion callbacks;
- plugin HTTP handlers;
- agent generation and streaming;
- inference providers and their async-generator streams; and
- plugin activation, config changes, and deactivation.

The compatibility promise applies to the documented `PluginAPI`. A bounded
preflight routes native addons and direct Electron imports to the Electron
compatibility host before activation. It never starts a plugin in SEA and then
retries in Electron, so activation side effects cannot run twice.

## Diagnostics

Open **Settings → Advanced → Diagnostics** to inspect the “Plugin process
resources” table. It refreshes every five seconds and reports each plugin's
PID, CPU percentage, cumulative CPU time, physical/private footprint,
RSS/working-set memory, state, crash count, and selected runtime. The runtime is
shown as **Node SEA** or **Electron compatibility host**, with the routing reason
available as hover text.

Each row also has operational controls:

- **Pause / Resume** suspends or continues the OS process on macOS/Linux. The
  control is disabled where the OS cannot provide reliable process suspension.
- **Kill** force-terminates only that backend and records it as crashed.
- **Disable** performs normal teardown and persists the disabled state.
- **Enable** starts a fresh isolated backend for a disabled plugin.

Electron reports CPU over its sampling window. The first sample for a new
process can be zero. On macOS, Kai obtains all live plugin physical footprints
with one bounded OS query while Diagnostics is open because Electron utility
metrics expose only working set there. On platforms where private bytes are
unavailable, Kai labels and shows working-set memory instead.

## Memory overhead

Isolation has an unavoidable per-process Node/V8 baseline, but compatible light
plugins avoid Electron/Chromium initialization by using the shared signed SEA
executable. Optional compatibility machinery is demand-driven in both hosts:

- the worker thread and 16 MiB response buffer are created only by a true
  value-returning synchronous host call;
- app/plugin config reads and read-after-write behavior use local mirrors;
- void calls are sent over ordered IPC without changing the public API shape;
- the Zod transport bundle is loaded only for plugins with `tools:register`.

This keeps lightweight config/UI plugins isolated without charging them for
Electron, tool-schema code, or a second V8 isolate. Plugins declaring APIs that
load enough compatibility machinery to make Electron cheaper are routed to the
utility host based on measured private footprint. The routing set currently
includes tools, safe storage, conversations, system environment, and inference
providers. Diagnostics continues to attribute the selected runtime's full
baseline to each plugin rather than hiding it in the main process.

`network:fetch` remains available in SEA. Upload and response bodies are
streamed through the bounded broker to main's existing Electron fetch
implementation, preserving proxy/session behavior and cancellation without
whole-body buffering.

An unexpectedly exited process remains visible as `crashed` until the plugin is
disabled, re-enabled, uninstalled, or the app exits. The plugin error view also
shows the failure while other plugins continue running.

## Lifecycle

- **Enable/load:** integrity and permission checks run before a process starts.
- **Activate:** the selected host imports `backend.js` and calls the unchanged
  `activate(api)` export.
- **Config change:** both module `onConfigChanged` and registered listeners are
  forwarded to the selected host.
- **Disable/update/uninstall:** `deactivate()` gets a bounded graceful window;
  Kai then terminates the process and cleans all main-side registrations.
- **Crash/hang:** pending work rejects, registrations are removed, and only the
  owning process is terminated. A CPU-bound plugin can be killed from main
  even when its JavaScript event loop is blocked.
- **IPC flood:** per-plugin rate and concurrency limits terminate a backend
  that overwhelms the host channel, containing pressure on the main event loop.

## Development and verification

The production build has two additional main outputs and one generated host:

- `out/main/plugin-host.js` — utility-process entry point;
- `out/main/plugin-sync-worker.js` — demand-started worker-thread synchronous bridge;
- `resources/plugin-host/<platform>-<arch>/kai-plugin-host` — signed Node SEA
  executable (`.exe` on Windows), generated from pinned Node inputs.

`package.json` carries `pluginProcessProtocolVersion`. Bump it whenever the
host/runtime wire contract becomes incompatible; the release classifier then
requires a full signed-app update because OTA overlays cannot replace these
app.asar entrypoints or the SEA executable. The generated SEA manifest carries
the same protocol value.

Run the focused real-Electron verification after changing this subsystem:

```bash
pnpm verify:plugin-process
```

The smoke can also target a generated SEA host by setting
`KAI_PLUGIN_SEA_HOST`. That path additionally verifies mutual control-channel
authentication, brokered streaming fetch and abort, and an unchanged external
plugin backend.

Also run the standard repository gates:

```bash
pnpm type-check
pnpm lint
pnpm test
pnpm build
```

When adding a PluginAPI method, classify it as synchronous, asynchronous, or an
async generator in `utility-api.ts`. Function-valued arguments must cross as
callback references; Electron objects and live handles must stay in the main
broker.
