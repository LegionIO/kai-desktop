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
       sync RPC worker                   sync RPC worker           sync RPC worker
```

The renderer contract is unchanged. Only the backend-to-main boundary moved.

## What remains compatible

Plugins do not need to be rewritten. The following retain their existing call
shapes:

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
PID, CPU percentage, private/working-set memory, state, and crash count.

Each row also has operational controls:

- **Pause / Resume** suspends or continues the OS process on macOS/Linux. The
  control is disabled where the OS cannot provide reliable process suspension.
- **Kill** force-terminates only that backend and records it as crashed.
- **Disable** performs normal teardown and persists the disabled state.
- **Enable** starts a fresh isolated backend for a disabled plugin.

Electron reports CPU over its sampling window. The first sample for a new
process can be zero. On platforms where Electron does not expose private bytes,
Kai shows working-set memory instead.

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
- `out/main/plugin-sync-worker.js` — worker-thread synchronous bridge.

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
