# ADR 0006: Plugin Backend Process Isolation (Research)

- **Status**: Proposed — research only, no decision to build yet
- **Date**: 2026-07-20
- **Deciders**: maintainers (pending)

## Context

Plugin **backends** run **in the Electron main process**. Each plugin's
`backend.js` is loaded by dynamic `import()` (`PluginManager.loadPlugin`) and
its `activate(api)` runs with a live in-process API object. Every plugin's
timers, WebSockets, caches, tool bodies, and agent hooks execute inside the one
main process.

Two consequences motivated this research:

1. **No per-plugin resource attribution.** The OS accounts CPU/memory per
   _process_. Because all 8 installed plugins share the main process, neither the
   OS nor the new Diagnostics panel (which currently counts only unhandled
   errors per plugin) can say "plugin X is using 40% CPU / 300 MB." A runaway
   plugin (e.g. a tight poll loop, a leaking cache) is invisible as _resource_
   usage and can only be inferred from error counts or symptoms.
2. **No fault/CPU isolation.** A plugin that spins, leaks, or blocks the event
   loop degrades the whole app — the same class of problem as the EPIPE
   self-loop we just fixed, but sourced from third-party code we don't control.

True per-plugin CPU/memory requires the plugin backend to run in its **own OS
process** (Electron `utilityProcess`, or `child_process`/`worker_threads`), so
the OS can attribute resources and a crash/spin is contained. This ADR records
what that would actually take. **There is no `utilityProcess` precedent anywhere
in the codebase** — this would be greenfield.

## The core obstacle

The plugin API is **not** a serializable message channel today. It is a live
in-process object (`createPluginAPI` in `electron/plugins/plugin-api.ts`)
holding closures over the shared mutable `PluginInstance` and ~30
`PluginAPICallbacks` wired in `PluginManager.loadPlugin`. A plugin backend
touches roughly **12-15 distinct main-process subsystems synchronously**, ~10
of them via crossings that cannot be serialized as-is: callbacks the main
process invokes, async generators, live handles, or shared mutable state. Each
would need a dedicated async IPC shim/proxy.

### Tier 1 — Callbacks/closures the main process invokes (hardest; not serializable)

Symbols in `plugin-api.ts` (`createPluginAPI`) unless noted; invocation sites in
`electron/ipc/agent.ts` and `electron/plugins/plugin-manager.ts`.

| API                                                                                                             | Why it's hard                                                                                                                                                                                                                                                                                                                                                 |
| --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tools.register` → `tool.execute` (invoked by the agent tool loop in `ipc/agent.ts`)                            | Tool body is a plugin closure run in-process on the agent's hot path, receiving a live `ToolExecutionContext` (`electron/tools/types.ts`) with an `onProgress` callback **and** an `AbortSignal`. Isolation ⇒ every tool call becomes an async round-trip and `onProgress`/`abortSignal` must be proxied _back_ into the child. The single most coupled path. |
| `agent.registerInferenceProvider` (consumed via `getInferenceProvider` in the model path)                       | Provider exposes sync `isAvailable()` and an **async-generator `stream()`**. Streaming a generator across a process boundary is a hard IPC problem.                                                                                                                                                                                                           |
| `hooks.register` (PostToolUse etc.; invoked by `hookDispatcher` mid-loop)                                       | Handler runs mid-agent-loop; returns a live unsubscribe fn.                                                                                                                                                                                                                                                                                                   |
| `messages.registerPreSendHook` / `registerPostReceiveHook` (awaited by `runPreSendHooks`/`runPostReceiveHooks`) | Closures on the turn hot path; can rewrite/abort the turn.                                                                                                                                                                                                                                                                                                    |
| `lifecycle.registerPreUpdateHook` / `registerPostUpdateHook`                                                    | Closures on shared arrays.                                                                                                                                                                                                                                                                                                                                    |
| `events.on(key, handler)` (via `subscribeBus` → `eventBus`)                                                     | Subscribes to in-process `eventBus`; returns live unsubscribe.                                                                                                                                                                                                                                                                                                |
| `config.onChanged(cb)` (invoked by the manager's config-change path)                                            | Main invokes plugin cb synchronously on config change.                                                                                                                                                                                                                                                                                                        |
| `onAction` + `events.declare({actions})` (dispatched by `handleAction`)                                         | The renderer→backend RPC entrypoint; handler runs in main.                                                                                                                                                                                                                                                                                                    |
| `auth.openAuthWindow`                                                                                           | Accepts `onReady(helpers)` and returns helper closures (`executeJavaScript`, `onDidNavigate`, …) that drive `webContents` directly. `cookiePromotion` may itself be a function (`resolveCookiePromotion`) invoked per-cookie in a `session.cookies.on('changed')` listener.                                                                                   |
| `http.listen(port, handler)`                                                                                    | `handler` runs per HTTP request with live `req`/`res` streams; returns a live `http.Server`.                                                                                                                                                                                                                                                                  |

### Tier 2 — Direct Electron main-only APIs (need async IPC shims)

Imports and calls **7 Electron singletons**: `app, shell, BrowserWindow,
safeStorage, session, net, Notification`, plus Node `http.createServer`.

- `auth.openAuthWindow` — `new BrowserWindow`, `session.fromPartition`, `webRequest.onBeforeSendHeaders`. Deeply main-only.
- `safeStorage.encryptString/decryptString` — **synchronous** today; plugins call them as blocking functions.
- `browser.open`, `session.clearCookies`.
- `fetch` — routes through `net.fetch`, returns a **streaming Response**.
- `shell.openExternal`; `notifications.show/dismiss` → `showPluginNotification` (`new Notification` + `webContents.send`).
- `agent.generate/stream` — pulls the full live tool registry (`getRegisteredTools`); `stream` is an async generator with an `abortSignal`.

### Tier 3 — Shared mutable state (needs a state-sync protocol)

The **`PluginInstance` object itself** is mutated by nearly every `ui.*`,
`state.*`, tool/event registration (`uiBanners`, `uiModals`, `uiPanels`,
`registeredTools`, `publishedState`, hook arrays, …). `broadcastUIState` ships
serialized snapshots to the renderer. If the backend moved out, these mutations
would happen in the child and need shipping back. `state.get/replace/set` +
`emitEvent` read/write `instance.publishedState`.

### Tier 4 — Already serializable (easy, but sync + touch main stores)

`config.get/set/getPluginData`, `conversations.*` (hits the conversation store
directly), `exec.run/which`, `detect.*`, `env.*`, `log.*`, `host.capabilities`.
Results already serialize; only the sync call-shape and store access need an
async shim.

### Renderer relationship (already solved)

Renderer↔backend is **already a serialized IPC boundary**, not shared memory:
`frontend.js` is compiled to a browser ESM bundle served over
`plugin-renderer://` and reaches the backend only via `plugin:action` /
`plugin:modal-action` / `plugin:banner-action` IPC (`electron/ipc/plugins.ts`) →
`handleAction`. So the renderer side is _not_ the problem — the
backend↔main-process coupling is the unsolved part.

## Options considered

### Option A — Process-level metrics only (no isolation)

Add `app.getAppMetrics()` + `process.memoryUsage()`/`getCPUUsage()` to the
Diagnostics panel: live CPU%/memory for **main / each renderer / GPU / network**
processes. **Cost: low** (a few IPC calls, no arch change). **Attribution:
per-process only** — shows if Kai _overall_ is heavy, never per-plugin. Does not
solve the stated goal but is a cheap, honest baseline.

### Option B — Plugin-API activity accounting (approximate, in-process)

Instrument `createPluginAPI` to time every `api.*` call, timer tick, and `fetch`
per plugin; attribute wall-time and call counts. **Cost: medium.**
**Attribution: approximate _activity_, not true CPU** — but it would catch the
common "runaway timer/poll" case (which is what we actually hit). Adds overhead
to every plugin API call and cannot see CPU a plugin burns in pure computation
that never calls the API.

### Option C — Full backend process isolation (true per-plugin CPU/mem)

Move each backend to a `utilityProcess`, replace the live API object with an
async message-port RPC, and build proxies for every Tier 1-2 crossing. **Cost:
very high**, and it changes plugin-visible semantics:

- Every currently-synchronous API (`safeStorage.encryptString`, `state.set`,
  `config.get`) becomes **async** → breaking change to the plugin API contract,
  or a sync-over-async shim (not possible without `Atomics.wait`/SharedArrayBuffer
  gymnastics).
- Tool `execute`, agent hooks, and inference-provider `stream()` need
  bidirectional streaming proxies (args in, `onProgress`/chunks/`abortSignal`
  back). This is the bulk of the work and the highest-risk part.
- `auth.openAuthWindow` and `http.listen` return live handles that can't cross a
  process line — they'd need a full request/response and window-control proxy
  protocol, or those capabilities stay main-side.
- The existing capability/confinement system (`plugin-api.ts`,
  `sandboxed-exec.ts`, `plugin-integrity.ts`) sandboxes _external binary spawns_,
  **not** the plugin's own JS — so isolation is additive, not a refactor of
  something existing.

A realistic middle path within Option C: run the backend in a child process but
keep a **thin main-side broker** that holds all the live handles
(BrowserWindow, http.Server, safeStorage) and exposes them to the child over
RPC. Tools/hooks/inference-provider that must run synchronously on the agent
hot path arguably _stay_ in main (or the agent loop itself awaits the child).
This bounds the blast radius but still async-ifies the API contract.

## Recommendation (for maintainer decision)

- **Adopt Option A now** — cheap, useful, no risk; gives real process-level
  CPU/mem in the Diagnostics panel and an honest baseline.
- **Consider Option B next** — it targets the failure mode we actually saw
  (runaway plugin activity) at medium cost and no contract break.
- **Defer Option C** — the payoff (true per-plugin CPU/mem, fault isolation) is
  real, but it is a multi-week effort that breaks the plugin API's synchronous
  contract and requires streaming proxies for the agent hot path. It should be
  its own epic with a migration plan for the plugin API version, not folded into
  diagnostics work.

## Consequences

- If we ship only A/B, "per-plugin CPU/memory" remains _approximate_; we should
  say so in the UI rather than imply true accounting.
- If C is ever adopted, it forces a plugin-API major version (sync→async) and a
  migration for all 8 in-tree plugins; the renderer boundary is unaffected.
- The Diagnostics per-plugin **error** table (already shipped) is complementary
  to all three and remains the fastest way to attribute a _crash storm_.

## References

- Coupling inventory: `electron/plugins/plugin-api.ts` (`createPluginAPI`),
  `electron/plugins/plugin-manager.ts` (`loadPlugin` callback wiring,
  `getAllPluginTools`, `runPreSendHooks`/`runPostReceiveHooks`, `handleAction`),
  `electron/ipc/agent.ts` (plugin tool `execute` invocation), and
  `electron/ipc/plugins.ts` (renderer→backend `plugin:action` RPC).
- Related: ADR 0005 (platform capability seam) for the capability-gating model;
  the shipped Diagnostics section (error attribution) in
  `electron/diagnostics/` + `src/components/settings/DiagnosticsSettings.tsx`.
