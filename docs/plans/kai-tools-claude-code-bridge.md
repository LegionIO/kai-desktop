# Plan: Bridge Kai Tools to Claude Code Runtime

## Context

The Claude Code runtime currently only supports SDK built-in tools (Read, Write, Edit, Bash, Glob, Grep, LSP, WebFetch, WebSearch, Agent, Monitor). When Claude wants to use Kai-specific features like skills, CLI tools, settings management, or plan mode, they're unavailable — the user is told to switch to Mastra.

**The Goal**: Expose Kai's custom tools to the Claude Code SDK so users get a fuller Kai experience regardless of which runtime they choose.

**Key Insight**: The Claude Agent SDK supports **in-process MCP servers** via `createSdkMcpServer()`. Tool handlers run in Kai's main process (the parent), not inside the Claude Code subprocess. The SDK marshals tool calls back across the process boundary transparently. This means most Kai tools can be bridged with minimal effort.

---

## Architecture: In-Process MCP Server

```
┌──────────────────────────────────────────────────────────┐
│  Kai Main Process (Node/Electron)                        │
│                                                          │
│  ┌────────────────┐    ┌──────────────────────────────┐  │
│  │  Claude SDK    │    │  createSdkMcpServer()        │  │
│  │  query()       │───▶│  "kai-tools"                 │  │
│  │  (spawns CLI   │    │                              │  │
│  │   subprocess)  │    │  tool handlers execute here  │  │
│  └────────────────┘    │  (full main-process access)  │  │
│                        └──────────────────────────────┘  │
│                                   │                      │
│                                   ▼                      │
│                        ┌──────────────────────────────┐  │
│                        │  Kai Tool Registry            │  │
│                        │  (skills, CLI tools, MCP,     │  │
│                        │   plan mode, settings, etc.)  │  │
│                        └──────────────────────────────┘  │
│                                   │                      │
│                                   ▼                      │
│                        ┌──────────────────────────────┐  │
│                        │  Electron IPC / BrowserWindow │  │
│                        │  (UI broadcasts, file ops)    │  │
│                        └──────────────────────────────┘  │
└──────────────────────────────────────────────────────────┘
```

Because tool handlers run in the main process, they have full access to:
- `BrowserWindow.getAllWindows()` (for UI broadcasts)
- File system (`~/.kai/config.json`, `~/.kai/plans/`, etc.)
- The tool registry and all registered tools
- Electron IPC infrastructure

---

## Tool Categories & Bridging Feasibility

### Fully Bridgeable (execute in main process, no special flow needed)

| Tool | What it does | Why it works |
|------|-------------|--------------|
| `enter_plan_mode` | Broadcasts mode change to renderer, returns instructions | Pure broadcast + return |
| `exit_plan_mode` | Writes plan to `~/.kai/plans/`, broadcasts mode change | File write + broadcast |
| `mcp_manage` | Manages MCP server config in `~/.kai/config.json` | Config file I/O |
| `memory_settings` | Configures memory settings | Config file I/O |
| `compaction_settings` | Configures compaction | Config file I/O |
| `tool_settings` | Configures tool availability | Config file I/O |
| `advanced_settings` | Configures advanced behavior | Config file I/O |
| `system_prompt` | Configures system prompt | Config file I/O |
| `audio_settings` | Configures audio | Config file I/O |
| `realtime_settings` | Configures realtime API | Config file I/O |
| `model_switch` | Switches active model | Config file I/O |
| `skill_manage` | Installs/removes/toggles skills | File I/O + config |
| `cli_tool_manage` | Manages CLI tool bindings | Config file I/O |
| `plugin_info` | Returns plugin metadata | Pure read |
| CLI tools (gh, git, etc.) | Run shell commands | Subprocess execution |
| Skill tools | Execute skill logic | Pure function calls |
| MCP tools (external servers) | Forward to external MCP | Network/stdio calls |
| `web_fetch` / `web_search` | HTTP requests | Network I/O |
| `image_gen` / `video_gen` | Media generation APIs | Network I/O + file write |

### Requires Special Handling: `ask_user`

**The challenge**: `ask_user` needs orchestration beyond just running `execute()`:

1. Tool call arrives → broadcast `tool-approval-required` event to renderer
2. Renderer shows question UI to user
3. User submits answers via `agent:answer-tool-question` IPC
4. Answers stored in `pendingQuestionAnswers` map
5. Tool approval resolves → `execute()` retrieves answers from map

In the Mastra runtime, `agent.ts` orchestrates steps 1-4 via `onToolExecutionStart` hooks. The Claude Code SDK manages its own tool execution loop, so we need a different approach.

**Solution**: Implement the full orchestration inside the MCP tool handler itself:

```typescript
tool('ask_user', 'Ask the user a question...', schema, async (args) => {
  const toolCallId = `mcp-ask-${Date.now()}`;

  // 1. Broadcast to renderer (show question UI)
  broadcastStreamEvent({
    conversationId,
    type: 'tool-approval-required',
    toolCallId,
    toolName: 'ask_user',
    args,
  });

  // 2. Wait for user response (blocks until IPC resolves)
  const answers = await waitForUserAnswer(toolCallId);

  // 3. Return answers to SDK
  if (!answers) {
    return { content: [{ type: 'text', text: 'User dismissed the question.' }], isError: true };
  }
  return { content: [{ type: 'text', text: JSON.stringify({ success: true, answers }) }] };
});
```

The key insight: since the tool handler runs in the main process, it can directly broadcast events and await IPC responses, just like `agent.ts` does for Mastra. The tool call simply blocks (awaits a Promise) until the user responds.

### Not Bridgeable: `sub_agent`

The sub-agent tool creates new Mastra agent instances with their own streaming loops. It's deeply tied to the Mastra runtime's streaming architecture and would require essentially reimplementing a second runtime inside the bridge. Not worth the complexity — Claude Code SDK already has its own native `Agent` tool that does the same thing.

---

## Implementation Plan

### Phase 1: Core Bridge (~50-100 lines)

**File**: `electron/agent/runtime/claude-agent-runtime.ts`

Wire the existing `ToolMcpBridge` into the SDK via `createSdkMcpServer()`:

```typescript
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

// In stream() method, before calling query():

// Filter tools: exclude sub_agent (SDK has its own Agent tool) and
// tools that duplicate SDK built-ins (web_fetch, web_search already in SDK)
const EXCLUDED_TOOLS = new Set(['sub_agent']);
const bridgeableTools = (options.tools ?? []).filter(t => !EXCLUDED_TOOLS.has(t.name));

if (bridgeableTools.length > 0) {
  const bridge = new ToolMcpBridge({
    tools: bridgeableTools,
    conversationId,
    cwd,
  });

  const kaiMcpServer = createSdkMcpServer({
    name: 'kai-tools',
    version: '1.0.0',
    tools: bridgeableTools.map(t => tool(
      t.name,
      t.description ?? '',
      t.inputSchema,
      async (args) => {
        const result = await bridge.callTool(t.name, args, abortSignal);
        return result;
      }
    )),
  });

  sdkOptions.mcpServers = {
    'kai-tools': kaiMcpServer,
  };
}
```

### Phase 2: `ask_user` Bridge (~80 lines)

**File**: `electron/agent/runtime/claude-agent-runtime.ts` (or extracted to a helper)

Create a self-contained `ask_user` handler that orchestrates the full approval flow within the MCP tool handler:

```typescript
// Helper: wait for user answer via IPC
function createAskUserBridgeHandler(conversationId: string) {
  return async (args: { questions: unknown[] }) => {
    const toolCallId = `mcp-ask-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    // Broadcast to renderer — shows question UI
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('agent:stream-event', {
        conversationId,
        type: 'tool-approval-required',
        toolCallId,
        toolName: 'ask_user',
        args,
      });
    }

    // Block until user responds (or aborts)
    const answers = await new Promise<Record<string, string> | null>((resolve) => {
      const handler = (_event: unknown, id: string, userAnswers: Record<string, string>) => {
        if (id === toolCallId) {
          ipcMain.removeHandler(`ask-user-bridge:${toolCallId}`);
          resolve(userAnswers);
        }
      };
      // Register one-shot handler
      pendingMcpAskUserResolvers.set(toolCallId, resolve);
    });

    if (!answers) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: 'User dismissed' }) }], isError: true };
    }
    return { content: [{ type: 'text', text: JSON.stringify({ success: true, answers }) }] };
  };
}
```

**Renderer-side**: The renderer already handles `tool-approval-required` events and calls `agent:answer-tool-question`. We just need to ensure the bridge handler listens for answers on the same channel (or a parallel one) so the existing UI flow works unchanged.

### Phase 3: Plan Mode Integration (~20 lines)

Plan mode tools (`enter_plan_mode`, `exit_plan_mode`) already work as pure functions that broadcast + write files. They'll work through the standard bridge path (Phase 1) with zero modifications because:
- `broadcastModeChange()` calls `BrowserWindow.getAllWindows()` — works from main process
- `writeFileSync()` writes plans to disk — works from main process
- No approval flow or IPC blocking needed

The only consideration: when `enter_plan_mode` fires, the SDK won't actually restrict its own tools. The tool's return value tells Claude "only use read-only tools" as an instruction in the system context, which Claude typically respects. For stronger enforcement, we could filter the `tools` array mid-session, but that's a stretch goal.

### Phase 4: UI Updates (~30 lines)

**File**: `src/components/settings/RuntimeSettings.tsx`

Update capability table and descriptions to reflect the new bridge:

```typescript
// Before (incorrect):
['Plan mode', true, false, false],
['User questions', true, false, false],

// After (accurate):
['Plan mode', true, true, false],
['User questions (ask_user)', true, true, false],
['Skills & CLI tools', true, true, false],
['Sub-agents', true, 'native', false],  // SDK has its own Agent tool
```

Update runtime description:
```typescript
'claude-agent-sdk': 'Anthropic\'s Claude Code. Production-tested tool execution with native MCP support and session resume. Kai tools (skills, plan mode, settings) are available via MCP bridge.',
```

---

## Verification Plan

1. **Basic bridge**: Select Claude Code runtime → start a conversation → ask Claude to use a skill → verify it executes via the MCP bridge
2. **Plan mode**: Ask Claude to "plan this first" → verify `enter_plan_mode` broadcasts mode change → renderer shows plan mode UI → `exit_plan_mode` writes plan file
3. **ask_user**: Give Claude a task that requires clarification → verify question UI appears → submit answer → verify Claude receives it
4. **Settings tools**: Ask Claude to "switch the model" or "configure memory" → verify config changes persist
5. **CLI tools**: Ask Claude to use `gh` → verify it routes through the bridge (not SDK's built-in Bash)
6. **Abort**: Start a bridged tool call → cancel the stream → verify cleanup

---

## Files to Modify

| File | Change |
|------|--------|
| `electron/agent/runtime/claude-agent-runtime.ts` | Wire `createSdkMcpServer()` with bridgeable tools, add `ask_user` orchestration |
| `electron/agent/runtime/tool-mcp-bridge.ts` | Minor: ensure `callTool` return type matches SDK's `CallToolResult` |
| `src/components/settings/RuntimeSettings.tsx` | Update capability table and descriptions |

## Files to Create (optional)

| File | Purpose |
|------|---------|
| `electron/agent/runtime/ask-user-bridge.ts` | Extract `ask_user` orchestration if it grows complex |

---

## Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| `createSdkMcpServer()` API changes between SDK versions | Pin SDK version; add integration test |
| Tool handler blocks forever if user never answers `ask_user` | Add timeout (configurable, default 5 min); abort cleans up |
| SDK tool list conflicts (e.g. SDK's `WebFetch` vs Kai's `web_fetch`) | Use distinct names; Kai tools use snake_case, SDK uses PascalCase |
| Plan mode "enforcement" is advisory only | Accept this — Claude respects instructions; add a note in plan mode tool response |
| Too many tools in MCP server slows SDK startup | Lazy-load MCP server; only include tools relevant to execution mode |

---

## What This Does NOT Solve

- **Mastra-specific features**: Memory layers, compaction, tool observer, and observer-launched tools remain Mastra-only. These are deeply integrated into Mastra's streaming pipeline.
- **Sub-agents via Kai**: Claude Code SDK has its own `Agent` tool. Kai's sub-agent system (which uses Mastra internally) won't be bridged — it's redundant.
- **Model override**: Claude Code uses its own model config. Kai's model switcher can update `~/.kai/config.json` but won't affect the SDK's active session.

---

## Estimated Effort

| Phase | Lines of Code | Complexity |
|-------|--------------|------------|
| Phase 1: Core bridge | ~50 | Low — mostly wiring existing pieces |
| Phase 2: ask_user | ~80 | Medium — IPC orchestration |
| Phase 3: Plan mode | ~0 (works via Phase 1) | None |
| Phase 4: UI updates | ~30 | Low |
| **Total** | **~160** | **Low-Medium** |

This is a focused integration task, not a multi-phase architecture project.
