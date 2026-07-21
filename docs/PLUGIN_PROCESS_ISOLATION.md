# Plugin Process Isolation

Every enabled plugin backend runs in a separate Electron utility process. This
document is the operational companion to
[ADR 0006](./adr/0006-plugin-backend-process-isolation.md).

## Runtime map

```text
renderer ── existing plugin action IPC ──> Electron main
                                               │
                              permission-enforcing PluginAPI broker
                                               │
             ┌─────────────────────────────────┼─────────────────────────┐
             │                                 │                         │
      utility: plugin A                 utility: plugin B         utility: plugin C
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

The compatibility promise applies to the documented `PluginAPI`. A backend
that imported main-only Electron objects directly was bypassing that contract;
those exports are intentionally unavailable in a utility process.

## Diagnostics

Open **Settings → Advanced → Diagnostics** to inspect the “Plugin process
resources” table. It refreshes every five seconds and reports each plugin's
PID, CPU percentage, physical/private footprint, RSS/working-set memory, state,
and crash count.

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

Isolation still has an unavoidable Electron utility-process baseline, but
optional compatibility machinery is demand-driven:

- the worker thread and 16 MiB response buffer are created only by a true
  value-returning synchronous host call;
- app/plugin config reads and read-after-write behavior use local mirrors;
- void calls are sent over ordered IPC without changing the public API shape;
- the Zod transport bundle is loaded only for plugins with `tools:register`.

This keeps lightweight config/UI plugins isolated without charging them for
tool-schema code or a second V8 isolate. Diagnostics continues to attribute the
remaining baseline to each plugin rather than hiding it in the main process.

An unexpectedly exited process remains visible as `crashed` until the plugin is
disabled, re-enabled, uninstalled, or the app exits. The plugin error view also
shows the failure while other plugins continue running.

## Lifecycle

- **Enable/load:** integrity and permission checks run before a process starts.
- **Activate:** the utility imports `backend.js` and calls the unchanged
  `activate(api)` export.
- **Config change:** both module `onConfigChanged` and registered listeners are
  forwarded to the utility.
- **Disable/update/uninstall:** `deactivate()` gets a bounded graceful window;
  Kai then terminates the utility and cleans all main-side registrations.
- **Crash/hang:** pending work rejects, registrations are removed, and only the
  owning process is terminated. A CPU-bound utility can be killed from main
  even when its JavaScript event loop is blocked.
- **IPC flood:** per-plugin rate and concurrency limits terminate a backend
  that overwhelms the host channel, containing pressure on the main event loop.

## Development and verification

The production build has two additional main outputs:

- `out/main/plugin-host.js` — utility-process entry point;
- `out/main/plugin-sync-worker.js` — demand-started worker-thread synchronous bridge.

`package.json` carries `pluginProcessProtocolVersion`. Bump it whenever the
host/utility wire contract becomes incompatible; the release classifier then
requires a full signed-app update because OTA overlays cannot replace these
app.asar entrypoints.

Run the focused real-Electron verification after changing this subsystem:

```bash
pnpm verify:plugin-process
```

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
