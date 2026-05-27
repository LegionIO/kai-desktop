# Contributing to Kai

Thanks for your interest in contributing to Kai. Whether you're reporting a bug, improving documentation, submitting code, or building a plugin, your contributions are welcome and appreciated.

Kai is licensed under MIT. No contributor license agreement or sign-off is required.

## Conduct

Be respectful and constructive in all interactions. Harassment, discrimination, and bad-faith behavior are not tolerated. Maintainers reserve the right to remove content or ban participants who violate this expectation.

## Ways to Contribute

- **Report bugs** -- Open a GitHub Issue with reproduction steps, expected vs. actual behavior, and your macOS / Node / pnpm versions.
- **Suggest features** -- Open an Issue describing the use case and why it matters.
- **Submit code** -- Bug fixes, features, and refactors are all welcome. PRs can be opened directly without a preceding issue.
- **Improve documentation** -- README, inline docs, guides, and this file.
- **Build plugins or skills** -- Extend Kai with new capabilities. See [Plugin and Skill Development](#plugin-and-skill-development) below.

## Development Setup

### Prerequisites

- **macOS** (the only supported platform currently)
- **Node.js 22+**
- **pnpm 10+** (enforced via `packageManager` in `package.json`; npm and yarn will not work)

### Getting Started

```bash
git clone https://github.com/kai-systems/kai-desktop.git
cd kai-desktop
pnpm install
pnpm dev          # starts Electron in dev/watch mode
```

### Useful Commands

| Command           | Purpose                                          |
| ----------------- | ------------------------------------------------ |
| `pnpm dev`        | Start Electron app with hot reload               |
| `pnpm build`      | Build main + preload + renderer                  |
| `pnpm lint`       | ESLint (TypeScript files only)                   |
| `pnpm type-check` | `tsc --noEmit` -- full type check                |
| `pnpm build:mac`  | Compile Swift helper + build + package macOS DMG |
| `pnpm preview`    | Preview a production build                       |
| `pnpm rebuild`    | Rebuild native dependencies                      |

All app runtime data lives under `~/.kai/` (config, conversations, skills, certs). The app creates this directory on first launch.

## Code Style and Conventions

### ESLint (run with `pnpm lint`)

- `consistent-type-imports` (error) -- always use `import type { Foo }` for type-only imports
- `no-explicit-any` (warn) -- prefer specific types or `unknown`
- `no-unused-vars` (warn) -- prefix intentionally unused variables with `_`

See [`eslint.config.js`](eslint.config.js) for the full configuration.

### TypeScript

- Strict mode is enabled
- Path alias: `@/` maps to `src/`

### UI

- **Tailwind CSS 4** via `@tailwindcss/postcss` (not the v3 `tailwind.config.js` pattern)
- **Radix UI** primitives for interactive components (dialogs, dropdowns, tabs, etc.)
- **Lucide React** for icons

### Commit Messages

Write clear, descriptive commit messages. No strict format is enforced -- look at recent `git log` output for style reference.

### Naming Convention

The codebase uses **Chat** for user-facing labels, **Conversation** for IPC channels / on-disk storage / renderer state IDs, and **Thread** for `@assistant-ui/react` `ThreadPrimitive` consumers, plugin extensions, and Mastra agent internals. See [`docs/adr/0002-thread-conversation-chat-naming-convention.md`](docs/adr/0002-thread-conversation-chat-naming-convention.md) for the full layer table and forcing functions before proposing renames.

## Architecture Awareness

Kai follows the standard Electron three-process model with strict isolation:

| Layer        | Location                                     | What to know                                                    |
| ------------ | -------------------------------------------- | --------------------------------------------------------------- |
| Main process | `electron/`                                  | Node.js, full system access, tools, agent orchestration, config |
| Preload      | [`electron/preload.ts`](electron/preload.ts) | Bridge between main and renderer via `contextBridge`            |
| Renderer     | `src/`                                       | React app, browser-only -- no Node APIs                         |

### The IPC Boundary

Renderer code **never** accesses Node APIs directly. All communication goes through the `window.app` bridge defined in [`electron/preload.ts`](electron/preload.ts). If a new feature needs Node access from the renderer, add an IPC handler in `electron/ipc/` and expose it through the preload bridge.

IPC payloads cross the naming layer (renderer Chat-vocab UI ⇄ `conversations:`-prefixed channel wire format ⇄ Mastra `scope: 'thread'` runtime). When adding or renaming a channel, see [`docs/adr/0002-thread-conversation-chat-naming-convention.md`](docs/adr/0002-thread-conversation-chat-naming-convention.md) so the channel name + parameter names match the layer they route to.

### Key Files

- [`electron/config/schema.ts`](electron/config/schema.ts) -- Zod schema defining `AppConfig`. Central authority for all configuration. New config sections must also be added to the persistence allowlist in [`electron/ipc/config.ts`](electron/ipc/config.ts) (`desktopConfigPayload()`).
- [`electron/tools/registry.ts`](electron/tools/registry.ts) -- Builds the active tool set from config, skills, and MCP servers. Tool registration is async and runs after window creation.
- [`electron/preload.ts`](electron/preload.ts) -- Defines the `window.app` API surface the renderer sees.
- [`electron/agent/mastra-agent.ts`](electron/agent/mastra-agent.ts) -- Mastra agent setup and streaming.
- [`src/providers/`](src/providers/) -- React context providers (Config, Runtime, Attachments).
- [`docs/adr/`](docs/adr/) -- Architecture Decision Records. Read the relevant ADR before changing a contract the project has already debated (current ADRs cover Electron fuses policy and the Thread/Conversation/Chat naming convention).

### Gotchas

- **`contextIsolation` is ON** -- never use `require()` or Node APIs in renderer code.
- **Tailwind v4** -- do not create a `tailwind.config.js`.
- **Tests** -- Vitest is the unit/component test runner. Run `pnpm test` locally; CI runs the same suite on every PR. New code should land with tests where possible.
- **Config persistence allowlist** -- new config sections must be added to `desktopConfigPayload()` in `electron/ipc/config.ts` or they will not persist.

For a deeper architecture reference, see [`CLAUDE.md`](CLAUDE.md).

## Pull Request Process

### Branching

- **External contributors**: Fork the repo and open a PR from your fork to `main`.
- **Team members**: Create a branch on the main repo and open a PR to `main`.

### Before Opening a PR

Run these locally and make sure they pass:

```bash
pnpm lint          # fix any errors; warnings are acceptable but should be minimized
pnpm type-check    # must pass cleanly
pnpm test          # vitest suite must pass
pnpm build         # full build must succeed
```

`pnpm install` registers Husky hooks via the `prepare` script: a pre-commit hook runs `lint-staged` (ESLint + Prettier on changed files), and a pre-push hook runs `pnpm type-check` followed by `pnpm test` so broken pushes are caught locally.

### CI Checks

Every PR automatically runs:

1. `pnpm lint`
2. `pnpm type-check`
3. `pnpm test`
4. `pnpm build`
5. macOS DMG build

All checks must pass before merge.

### Review

- External contributor PRs require at least one maintainer approval.
- Maintainers may merge their own changes directly when appropriate.

### Tips

- Keep PRs focused -- one logical change per PR.
- Write a clear description of what changed and why.
- Link related issues when they exist.

## Plugin and Skill Development

### Skills

Skills are installed under `~/.kai/skills/` and loaded from a JSON manifest. Supported execution types include `shell`, `script`, `prompt`, `http`, and `composite`.

Relevant source files:

- [`electron/tools/skill-loader.ts`](electron/tools/skill-loader.ts) -- manifest schema and loading logic
- [`electron/tools/skill-manage.ts`](electron/tools/skill-manage.ts) -- skill management tool definitions

### Plugins

Plugins have a `main` entry (runs in the main process with full Node access) and an optional `renderer` entry (compiled to browser ESM -- no Node builtins like `fs`, `net`, or `child_process`).

Relevant source files:

- [`electron/plugins/plugin-api.ts`](electron/plugins/plugin-api.ts) -- plugin API
- [`electron/plugins/types.ts`](electron/plugins/types.ts) -- type definitions
- [`electron/plugins/plugin-manager.ts`](electron/plugins/plugin-manager.ts) -- lifecycle management

A dedicated plugin/skill authoring guide may be added in the future. For now, refer to the source files listed above.

## Testing Conventions

When adding tests, follow these conventions:

- **Explicit assertions only.** Use `expect(...).toBe(...)`, `.toEqual(...)`, `.toMatchObject(...)`, `.toBeInTheDocument()`, etc. Snapshots (`.toMatchSnapshot`, `.toMatchInlineSnapshot`) are forbidden because they invite rubber-stamp updates.
- **Helper-driven fixtures over inline setup.** See [`test-utils/`](test-utils/) for `createIpcHarness`, `renderWithProviders`, `setupHttpMock`. Reuse before reinventing.
- **No real network egress in tests.** The `globalThis.fetch` firewall in [`vitest.setup.ts`](vitest.setup.ts) will throw an `ECONNREFUSED`-shaped error on unmocked provider hosts. If your test needs HTTP, use msw via `setupHttpMock()` and call `server.listen()` in your suite's own `beforeAll`.
- **AI provider mocking strategy.** `vi.mock` at the SDK package boundary for the Claude Agent SDK, the OpenAI Codex SDK, and the Mastra factory; msw at the HTTP egress for the `@ai-sdk/*` providers in [`electron/agent/language-model.ts`](electron/agent/language-model.ts).
- **Determinism seams.** [`vitest.setup.ts`](vitest.setup.ts) sets a frozen system time (`2026-01-01T00:00:00.000Z`), spies `crypto.randomUUID`, and mocks `@lydell/node-pty`. Tests should rely on these globals rather than reintroducing them.
- **No production-code changes for testability** unless a clear seam is needed and the PR explicitly carves it out.

For the full architectural rationale, see [`docs/TESTING_ARCHITECTURE.md`](docs/TESTING_ARCHITECTURE.md).

## Getting Help

- **Bug reports and feature requests** -- [GitHub Issues](https://github.com/kai-systems/kai-desktop/issues)
- **Questions and discussion** -- [GitHub Discussions](https://github.com/kai-systems/kai-desktop/discussions)
