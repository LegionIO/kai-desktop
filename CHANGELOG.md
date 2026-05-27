# Changelog

## [1.0.89] - 2026-05-27

### Fixed
- Restore token input/output metrics in the message info popover by normalizing Legion daemon, plugin, and OpenAI-compatible context-usage payloads before recording or rendering them.

## [1.0.88] - 2026-05-27

### Fixed
- Preserve plugin runtime ownership when Legion-backed requests use Mastra as fallback transport, so Legion native mode can intercept inference through the registered provider instead of falling through to `/v1/chat/completions`.

## [1.0.19] - 2026-04-08

### Added
- Initial Kai release.
- Local-first desktop AI assistant built with Electron, React, TypeScript, Tailwind CSS, and Mastra.
- Persistent conversations, configurable model catalog, local tool execution, skills, MCP integration, memory, compaction, realtime audio, media generation, and sub-agent support.

### Notes
- This changelog starts fresh from the current Kai baseline.
