# Changelog

## [Unreleased] - feat/aithena-memory-hooks

### Added
- **Aithena Lifecycle Hooks** (`electron/agent/aithena-hooks.ts`): Two-phase integration wiring cognitive memory into the conversation stream pipeline.
  - `enrichWithAithenaContext()` — compiles recalled memories, RAG documents, and procedural hints into the system prompt before streaming starts.
  - `learnFromTurn()` — fire-and-forget post-stream call that sends the user/assistant exchange to Aithena's LLM pipeline for episodic storage, semantic extraction, procedural detection, and identity observation.
- **RAG integration**: Context enrichment now includes Aithena's knowledge base (ingested docs, runbooks, design docs) with `includeRag: true` and 4000 token budget.
- **Instructional preamble in context block**: Formatted context injection now includes explicit guidance for the model to treat retrieved context as authoritative, cite knowledge base sources, and follow procedural hints when intent matches.
- **Source attribution**: All Aithena API calls now emit `source_type: 'kai-desktop'` instead of `'external'`, enabling proper attribution in Aithena's telemetry and memory provenance tracking.

### Changed
- `electron/ipc/agent.ts`:
  - Import and wire `enrichWithAithenaContext`, `learnFromTurn`, `extractLastUserMessage` from aithena-hooks.
  - Context enrichment injected after plugin hooks, before runtime resolution.
  - Text accumulator added to stream loop (`text-delta` events).
  - `learnFromTurn()` called on stream `done` event (min 50 chars guard).
- `electron/agent/aithena-memory.ts`:
  - All `source_type` fields changed from `'external'` to `'kai-desktop'` across learn, remember (semantic/episodic/procedural encode), compileContext, recall, workflow events, skill search, and skill feedback.
  - Learn endpoint now includes `source_type: 'kai-desktop'` in the request body.

### Technical Notes
- Context enrichment: max 8s compile timeout with retry, graceful degradation (returns original prompt on failure).
- Learning: fire-and-forget, never blocks the stream pipeline. Minimum 50-char response length guard prevents learning from empty/error responses.
- RAG results render as a `## Knowledge Base (Retrieved Documents)` section with title, source URL, and content snippet (up to 500 chars each).
- System prompt injection order: base prompt → Aithena context block → working directory → project instructions (CLAUDE.md).

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
