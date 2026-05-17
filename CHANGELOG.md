# Changelog

## [1.0.80] - 2026-05-17

### Added
- **Council chat system** — Full multi-agent deliberation UI with real-time SSE streaming. Tasks now trigger intelligent council orchestration (Aithena advisor, Aidan planner, Airen reviewer) with conversational intake.
- **Council message rendering** — Dedicated `CouncilMessageBubble` component with per-agent styling, markdown support, typing indicators, and phase labels.
- **Council composer** — Users can respond to advisor questions directly in the council tab, with immediate local rendering and "thinking" indicator.
- **Council session history restoration** — Fetches and hydrates past council conversations when navigating back to a task.
- **Council approval flow** — Approve council plans to trigger automated execution via claude-code or codex.
- **Task execution loop** — Non-interactive execution with post-execution assessment, slice-based plan decomposition, and continuation logic.
- **Task terminal manager** — Spawns and manages CLI sessions (claude-code, codex) for task execution with output streaming.
- **Task detail modal** — Expanded task view with plan, council, and agent tabs.
- **`awaiting_approval` task status** — New column in task queue for tasks pending council plan approval.

### Fixed
- **Council user message echo** — Fixed duplicate "You" messages appearing in council chat. Root cause: `fetch-history` useEffect had `state.councilMessages` in dependency array, causing stale session restoration to race with live events. Fix: removed reactive dependency, added `fetchedHistoryRef` dedup tracker, `isDeliberating` guard, and content-based deduplication for user `agent_done` events.
- **Council refusal on knowledge questions** — Massive instruction block in USER role triggered Azure content filter jailbreak detection. Fixed by moving instructions to system role (mirroring fusion-app's ResponseComposer pattern).
- **Council advancing to planning for Q&A** — Added `_detect_plan_intent()` heuristic in the API service to keep pure knowledge questions in conversational mode without triggering the planner pipeline.
- **No visible feedback during council processing** — Added typing indicator that shows immediately when agents are processing, without requiring `currentCouncilAgent` to be set.
- **Old council sessions silently failing** — Added fallback to new deliberation when `provide-clarification` returns 400, plus error feedback messages to the UI.

### Changed
- `startAITaskCreation` now uses the user's message directly as task title/description (council handles orchestration instead of the old plan-streaming flow).
- Task lifecycle hooks fire council deliberation on `task_created` with intelligent orchestration routing (skip, advisor-only, full council).
- Removed debug `console.warn` logging from council event subscription.

## [1.0.19] - 2026-04-08

### Added
- Initial Kai release.
- Local-first desktop AI assistant built with Electron, React, TypeScript, Tailwind CSS, and Mastra.
- Persistent conversations, configurable model catalog, local tool execution, skills, MCP integration, memory, compaction, realtime audio, media generation, and sub-agent support.

### Notes
- This changelog starts fresh from the current Kai baseline.
