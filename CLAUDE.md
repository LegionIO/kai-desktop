# Kai: Electron Desktop AI Assistant

## What Is This?

An Electron desktop app that provides a local-first AI chat experience with tool use, MCP integration, skills, sub-agents, and memory. Built with React 19 + TypeScript + Tailwind CSS 4, orchestrated by Mastra.

**Author**: Contributed by community member
**License**: MIT
**Package Manager**: pnpm 10+
**Node**: 22+

## Commands

```bash
pnpm install          # install dependencies
pnpm dev              # start electron in dev/watch mode
pnpm build            # build main + preload + renderer
pnpm build:mac        # build + package for macOS (arm64 + x64)
pnpm lint             # eslint (ts/tsx only)
pnpm type-check       # tsc --noEmit
pnpm preview          # preview production build
pnpm rebuild          # rebuild native deps (electron-builder install-app-deps)
```

### Testing the Auto-Updater

The auto-updater is disabled in dev mode by default. Set `KAI_UPDATE_TEST_VERSION` to a fake old version to enable it:

```bash
# Test against GitHub releases (default):
KAI_UPDATE_TEST_VERSION=0.0.1 pnpm dev

# Test against a different GitHub repo:
KAI_UPDATE_TEST_VERSION=0.0.1 KAI_UPDATE_REPO=owner/repo pnpm dev

# Test against a generic server (e.g. on-prem S3):
KAI_UPDATE_TEST_VERSION=0.0.1 KAI_UPDATE_URL=https://example.com/releases/latest pnpm dev
```

| Variable | Default | Purpose |
|----------|---------|---------|
| `KAI_UPDATE_TEST_VERSION` | *(unset — updater disabled in dev)* | Fake current version (e.g. `0.0.1`) |
| `KAI_UPDATE_REPO` | `legionio/kai-desktop` | GitHub `owner/repo` for release lookup |
| `KAI_UPDATE_URL` | *(unset)* | Generic server URL (takes priority over `KAI_UPDATE_REPO`). Server must host `latest-mac.yml` + zip at this URL. |

Note: the actual install/relaunch step will fail in dev mode (Squirrel expects a signed app bundle) but the full check → download → UI notification flow can be verified.

## Architecture

Three Electron process layers with strict isolation:

```
electron/main.ts          <- Main process: window, menus, IPC registration, tool init
electron/preload.ts       <- Preload: exposes `window.app` API via contextBridge
src/App.tsx               <- Renderer: React shell, sidebar, conversations, settings
```

### Main Process (`electron/`)

| Directory | Purpose |
|-----------|---------|
| `electron/agent/` | Mastra agent orchestration, model catalog, memory, sub-agents, tokenization |
| `electron/ipc/` | IPC handler registration (agent, config, conversations, mcp, memory, skills, plugins, usage, media, realtime, computer use) |
| `electron/tools/` | Tool implementations + registry builder |
| `electron/config/schema.ts` | Zod config schema (`AppConfig`) - central to everything |
| `electron/main.ts` | App bootstrap, window creation, menu, hot-reload for MCP + skills |

### Renderer (`src/`)

| Directory | Purpose |
|-----------|---------|
| `src/components/thread/` | Chat thread, composer, markdown, code blocks, tool groups, sub-agent views, token usage, and pipeline insights |
| `src/components/settings/` | Settings panels (models, tools, MCP, memory, compaction, skills, advanced, usage) |
| `src/components/conversations/` | Sidebar conversation list and sub-agent section |
| `src/components/plugins/` | Plugin banners, modal host, panel host, toast host, and plugin-driven settings sections |
| `src/providers/` | React context providers (Config, Runtime, Attachments) |
| `src/lib/` | IPC client wrapper, utilities |

## Key Files

- `electron/config/schema.ts` - Zod schema defining all config (`AppConfig` type)
- `electron/tools/registry.ts` - Builds active tool set from config, skills, MCP servers
- `electron/preload.ts` - The `window.app` IPC bridge (renderer's only way to talk to main)
- `electron/agent/mastra-agent.ts` - Mastra agent setup and streaming
- `src/providers/RuntimeProvider.tsx` - Manages conversation streaming state in renderer
- `src/providers/ConfigProvider.tsx` - Reads/writes config via IPC
- `electron-builder.yml` - macOS packaging config
- `electron.vite.config.ts` - Vite config for main, preload, and renderer builds

## Config

All app state lives under `~/.kai/`:

| Path | Contents |
|------|----------|
| `~/.kai/config.json` | Primary config (models, tools, MCP, memory, compaction, etc.) |
| `~/.kai/data/` | Conversation persistence |
| `~/.kai/skills/` | Installed skill directories |
| `~/.kai/certs/` | TLS certificates for integrations |
| `~/.kai/settings/llm.json` | Imported provider/model settings |

Config changes trigger hot-reload for MCP servers and skills (fingerprint diffing in `main.ts`).

## Code Style

ESLint enforces (see `eslint.config.js`):
- `consistent-type-imports` (error) - use `import type` for type-only imports
- `no-explicit-any` (warn)
- `no-unused-vars` (warn, `_` prefix ignored)
- `no-console` (warn, `console.warn/error/info` allowed)

Additional conventions:
- Tailwind CSS 4 (PostCSS plugin, not the old `tailwind.config.js` approach)
- Radix UI primitives for all interactive components
- `@/` path alias maps to `src/`
- Lucide React for icons

## IPC Boundary

Renderer code **never** accesses Node APIs directly. All communication goes through `window.app` (defined in `preload.ts`):

- `window.app.agent.*` - streaming, title generation, sub-agents
- `window.app.config.*` - get/set config, change listeners
- `window.app.conversations.*` - CRUD, active conversation tracking
- `window.app.mcp.*` - test MCP connections
- `window.app.memory.*` - clear memory stores
- `window.app.skills.*` - list/get/delete/toggle skills
- `window.app.dialog.*` - native file picker
- `window.app.image.*` - fetch/save images (bypasses CORS)

## Plugin Notes

- Plugin `main` entries run directly from disk in the main process.
- Plugin `renderer` entries are treated as **browser entrypoints** and may be authored as multi-file module graphs.
- Kai compiles plugin renderer graphs into a cached browser ESM output served over a custom protocol, so relative imports, dynamic imports, plugin-local packages, CSS imports, and URL-based assets/workers can load without exposing raw source files to the renderer.
- Plugin renderer packages must still be browser-runnable; Node builtins such as `fs`, `net`, or `child_process` are not supported in renderer code.

## Model Providers

Supported via Mastra + AI SDK:
- OpenAI-compatible (custom endpoints)
- Anthropic
- Amazon Bedrock (AWS credential chain)
- Google

Config schema: `models.providers` (keyed by name) + `models.catalog` (array of model entries).

## Gotchas

- **macOS only** for now - `electron-builder.yml` only targets `mac` with `dmg` output
- **contextIsolation is ON** - never try to use `require()` or Node APIs in renderer code
- **Tailwind v4** - uses `@tailwindcss/postcss` plugin, not the v3 `tailwind.config.js` pattern
- **No test suite** - no specs or test framework currently configured
- **`sandbox: false`** in webPreferences - needed for preload script to work with full Node access
- **Conversation cleanup** - the app auto-deletes empty/abandoned conversations on switch
- **Tool registry is async** - tools build after window creation; MCP connections happen at startup
- **Config persistence allowlist** - `desktopConfigPayload()` in `electron/ipc/config.ts` is an explicit allowlist; new config sections MUST be added there or they won't persist

---

**Last Updated**: 2026-04-01
