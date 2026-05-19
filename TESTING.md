# Testing

This repo has three distinct test layers. Each one catches a different class of regression, and the cost/coverage trade-offs differ enough that we keep them separated.

| Layer                 | Runner                | Where it runs on PR          | Wall-clock | What it catches                                                                 |
| --------------------- | --------------------- | ---------------------------- | ---------- | ------------------------------------------------------------------------------- |
| Unit + component      | vitest                | `checks` job (Linux)         | seconds    | logic regressions inside main, preload, and renderer modules                    |
| IPC seam smoke        | Playwright + Electron | `ipc-seam-smoke` job (Linux) | ~30s       | broken main ↔ renderer wiring, contextBridge regressions, preload load failures |
| Packaging integration | electron-builder      | `pr-mac-build` job (macOS)   | minutes    | DMG generation, code signing, hardened runtime, notarization-adjacent flags     |

The rest of this file documents the **IPC seam smoke** layer added in this PR. Unit testing conventions live in `CONTRIBUTING.md`; packaging is owned by the existing `pr-mac-build` workflow.

## What the IPC seam smoke does

The IPC seam smoke launches the **unpackaged** Electron binary (from `pnpm build` output in `out/main/index.js`) under Playwright, and verifies that the main process can complete its bootstrap and round-trip a message through the contextBridge to the renderer.

Concretely, one test file (`e2e/ipc-seam.spec.ts`) asserts:

1. **Main boots.** The main process emits the `data-app-ready` event without crashing.
2. **Preload exposes `window.app`.** The contextBridge object survives `contextIsolation: true` and is reachable from the renderer's main world.
3. **`invoke` round-trips.** `ipcRenderer.invoke('config:get')` resolves to a `Record`-shaped object — proves the bidirectional invoke seam works.
4. **`send` reaches the renderer.** `webContents.send('menu:open-settings')` fires the corresponding subscriber registered via `window.app.onMenuOpenSettings`.
5. **Fuse-adjacent runtime probes.** `window.process`, `window.require`, and `window.module` are all `undefined` in the renderer — confirms that `nodeIntegration: false` plus `contextIsolation: true` are honoured at runtime.

This is **not** a packaging-level E2E. The unpackaged binary skips code signing, the DMG layout, the hardened runtime entitlements, the notarization step, the auto-updater channel, and everything else that the `pr-mac-build` job exercises. Those concerns are validated independently on macOS by running `pnpm build:mac` end-to-end.

## What it deliberately does NOT do

- **It does not exercise the DMG.** Packaging signals come from `pr-mac-build`.
- **It does not exercise real network calls.** PR 1 wired a fetch firewall into the vitest suite; the IPC seam smoke runs against fresh user-data directories that have no configured providers, so no outbound traffic happens.
- **It does not assert UI behaviour.** DOM matching, accessibility checks, and visual regression belong elsewhere. Anything that uses `data-testid` for a stable selector should go in a separate component or end-to-end suite, not here.
- **It is not the only IPC test.** Behavioural coverage of individual handlers (config, conversations, agent, mcp, skills, etc.) lives under `electron/__tests__/` and runs in the vitest job, where a full mock harness sidesteps the need to launch Electron at all.

## When to extend the smoke

If you add a new IPC channel that is **structural** — i.e. removing it breaks the renderer at boot — add a smoke scenario. Examples that warrant a smoke scenario:

- A new `contextBridge.exposeInMainWorld` entry.
- A change to the preload that swaps the import shape of `window.app`.
- A new main-process push event the renderer relies on during initial paint.

If the channel is **incremental** — a new handler that the renderer queries lazily — vitest coverage is usually enough. When you add an IPC handler and skip a smoke scenario, mention the rationale in the PR description (e.g. "lazy-loaded settings panel only — covered by unit tests in `electron/__tests__/ipc/foo.test.ts`").

## Running locally

The smoke target is Linux because CI runs it under `xvfb-run`, but it works on macOS in headed mode and runs in well under 30 seconds:

```bash
pnpm install
pnpm build                    # produces out/main/index.js and out/renderer/
pnpm test:ipc-seam:linux      # runs the Playwright spec; ~12s on a recent Mac
```

On Linux without a display, install xvfb and prefix:

```bash
sudo apt-get install -y xvfb
xvfb-run -a pnpm test:ipc-seam:linux
```

The launcher always passes `--no-sandbox` on Linux. That flag is required by xvfb-driven CI runners and container environments and is **orthogonal to all Electron Fuses** — it changes only the OS-level sandbox attached at process start, not any bit baked into the packaged binary. The Mac DMG security signal is asserted independently by `pr-mac-build`, so this dev-only switch cannot contaminate the production trust surface.

## Output and debugging

- Test results print to stdout in `list` reporter format.
- On CI failure, the workflow uploads `playwright-report/` as a build artifact so you can open `index.html` locally and inspect the trace.
- Each run uses a fresh tmp directory passed via `KAI_USER_DATA`, so failures cannot pollute your developer `~/.kai/`.

## Follow-up

A `TESTING_ARCHITECTURE.md` document explaining the full rationale — including the trade-offs between unit, seam smoke, and packaging integration — will land in a follow-up PR. This file is intentionally short.
