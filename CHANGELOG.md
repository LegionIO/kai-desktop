# Changelog

## [Unreleased] - feat/aithena-memory-adapter

### Added
- **Aithena Memory Adapter** (`electron/agent/aithena-memory.ts`): Direct HTTP client to Aithena's cognitive memory API with full lifecycle support — context compilation, learning, recall, remember, workflow events, recommendations, skill search, and skill feedback.
- **Aithena IPC handlers** (`electron/ipc/aithena.ts`): 7 IPC channels (`aithena:health`, `aithena:stats`, `aithena:compile-context`, `aithena:recall`, `aithena:learn`, `aithena:remember`, `aithena:skill-search`) exposing memory operations to the renderer process.
- **Preload bridge** (`electron/preload.ts`): `window.app.aithena.*` namespace with typed methods for all Aithena operations.
- **Config schema** (`electron/config/schema.ts`): `aithena` config section (enabled, gatewayUrl, apiKey, timeoutMs, compileTimeoutMs) with Zod validation.

### Changed
- `electron/main.ts`: Registers Aithena IPC handlers at startup.
- `electron/ipc/config.ts`: Added `aithena` to config persistence allowlist.

### Technical Notes
- Graceful degradation: all memory calls are non-blocking with 5s timeout (8s for context compilation, 16s retry). Orchestration never blocks on Aithena availability.
- Singleton adapter with automatic health-check gating — if Aithena is unreachable, methods return null/empty without throwing.
- Auth pattern: `Authorization: Aithena-Key ${apiKey}` header.

## [1.0.19] - 2026-04-08

### Added
- Initial Kai release.
- Local-first desktop AI assistant built with Electron, React, TypeScript, Tailwind CSS, and Mastra.
- Persistent conversations, configurable model catalog, local tool execution, skills, MCP integration, memory, compaction, realtime audio, media generation, and sub-agent support.

### Notes
- This changelog starts fresh from the current Kai baseline.
