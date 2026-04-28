# Plan: Bridge Kai Tools to Claude Code Runtime

## Context

The Claude Code runtime currently only supports SDK built-in tools (Read, Write, Edit, Bash, Glob, Grep, LSP, WebFetch, WebSearch, Agent, Monitor). When Claude wants to use Kai-specific features like `ask_user`, `enter_plan_mode`, or `exit_plan_mode`, it either:
1. Tries to use the SDK's built-in versions (which have incompatible APIs and break), OR
2. Asks in plain text (which bypasses Kai's custom UI components)

**The Goal**: Enable the Claude Code runtime to call Kai's tools (ask_user, plan mode, task management, etc.) so users get the full Kai feature set regardless of which runtime they choose.

**The Challenge**: The Claude Code SDK runs as a subprocess and can't directly access Kai's Electron IPC infrastructure. Kai tools require IPC to show dialogs, manage state, and communicate with the renderer.

---

## Architecture Options

### Option A: IPC-backed MCP Server (Recommended)

**How it works**:
1. Create a stdio-based MCP server in Kai's main process that wraps registered tools
2. Spawn the server as a child process alongside the Claude Code CLI
3. Configure the SDK to connect to this MCP server via stdio transport
4. When the SDK calls a tool, the MCP server executes it via Kai's IPC and returns the result

**Pros**:
- Clean separation: SDK subprocess ↔ MCP server ↔ Kai IPC
- Standard MCP protocol (no custom hacks)
- Works with any MCP-compatible client (not just Claude Code)
- Tools execute in Kai's context with full IPC access

**Cons**:
- Requires building a stdio MCP server (not just in-process)
- SDK must support stdio MCP connections (need to verify)
- Additional process management complexity

### Option B: HTTP-based MCP Server

**How it works**:
1. Start an HTTP server in Kai's main process that implements MCP over SSE
2. Configure SDK to connect via HTTP transport
3. MCP requests execute tools via Kai's IPC

**Pros**:
- HTTP/SSE is a standard MCP transport
- No stdio process management
- Easy to debug (can test with curl)

**Cons**:
- Need to allocate a port (localhost:random or fixed)
- More overhead than stdio
- Security consideration (localhost only)

### Option C: In-Process Callback Bridge

**How it works**:
1. Use SDK's `createSdkMcpServer` to create an in-process MCP server
2. Tool handlers call back to Kai via Node.js async calls (not subprocesses)
3. SDK runs in same process, just uses MCP interface

**Pros**:
- Simplest — no separate processes or servers
- Direct function calls (fast)

**Cons**:
- **Does not work**: SDK's `query()` spawns a subprocess (the Claude Code CLI), and the in-process MCP server can't be accessed from that subprocess
- Already attempted and failed (see current code)

### Option D: Accept Limited Tool Support

**How it works**:
- Document that Claude Code runtime has limited tool support
- Users who need plan mode / ask_user / tasks use Mastra runtime
- Claude Code is for fast, reliable file/code operations only

**Pros**:
- Zero implementation work
- Clear separation of concerns
- Mastra still has full features

**Cons**:
- Users lose Kai features when using Claude Code
- Inconsistent experience across runtimes

---

## Recommended Approach: Option A (IPC-backed MCP Server)

### Phase 1: Build stdio MCP Server

**File**: `electron/agent/runtime/kai-mcp-server.ts`

Create a Node.js script that:
1. Receives MCP requests via stdin (JSONRPC format)
2. Sends MCP responses via stdout
3. Calls Kai tools via... **wait, how does it call back to main process?**

**Problem**: A stdio MCP server runs as a separate process. It can't directly call Kai's IPC handlers because those are in the main process. We need IPC between the MCP server process and Kai's main process.

**Solution**: Use Node.js IPC (child_process with IPC channel):
```typescript
// In main.ts
const mcpServer = fork('electron/agent/runtime/kai-mcp-server.js', [], {
  stdio: ['pipe', 'pipe', 'pipe', 'ipc'], // stdin, stdout, stderr, IPC channel
});

// MCP server can call tools via IPC channel
mcpServer.on('message', async (msg) => {
  if (msg.type === 'tool-call') {
    const result = await executeToolInMainProcess(msg.toolName, msg.args);
    mcpServer.send({ type: 'tool-result', id: msg.id, result });
  }
});
```

### Phase 2: Wire MCP Server to Claude Code SDK

**File**: `electron/agent/runtime/claude-agent-runtime.ts`

In the SDK options:
```typescript
mcpServers: {
  'kai-tools': {
    command: process.execPath, // Node.js
    args: [path.join(__dirname, 'kai-mcp-server.js')],
    env: { KAI_MAIN_PROCESS_IPC: 'some-channel-id' }, // How to pass IPC back-channel?
  }
}
```

**Wait, another problem**: The SDK spawns the MCP server as a subprocess, but we need that subprocess to have an IPC channel back to Kai's main process. How do we establish that?

**Possible solutions**:
1. **Unix socket**: MCP server connects to a Unix socket that Kai's main process listens on
2. **TCP localhost**: MCP server connects to localhost:PORT where main process has an IPC bridge
3. **Shared memory / pipe**: More complex

Actually, **this is getting too complex**. Let me reconsider...

---

## Reconsidering: The Real Problem

The fundamental issue: **Claude Code SDK runs as a subprocess and cannot access Kai's Electron IPC**. Any bridge we build requires:
1. SDK subprocess → MCP server (stdio or HTTP)
2. MCP server → Kai main process (some IPC mechanism)
3. Kai main process → Tool execution (current IPC handlers)

This is a lot of plumbing for what amounts to: "call a function in the parent process from a subprocess."

### Alternative: Simpler HTTP Bridge

**File**: `electron/agent/runtime/tool-ipc-bridge.ts`

```typescript
import { createServer } from 'http';
import type { ToolDefinition } from '../../tools/types.js';

export class ToolIpcBridge {
  private server: Server;
  private port: number;

  constructor(private tools: ToolDefinition[]) {
    this.server = createServer(this.handleRequest.bind(this));
  }

  async start(): Promise<number> {
    return new Promise((resolve) => {
      this.server.listen(0, 'localhost', () => {
        this.port = (this.server.address() as AddressInfo).port;
        resolve(this.port);
      });
    });
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse) {
    if (req.url === '/tools') {
      // List tools (MCP list_tools format)
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ tools: this.tools.map(t => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      })) }));
    } else if (req.url?.startsWith('/call/')) {
      // Execute tool (MCP call_tool format)
      const toolName = req.url.slice(6);
      const tool = this.tools.find(t => t.name === toolName);
      
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', async () => {
        try {
          const args = JSON.parse(body);
          const result = await tool.execute(args, {
            toolCallId: `http-bridge-${Date.now()}`,
            conversationId: args._conversationId, // Pass through
            cwd: args._cwd,
            abortSignal: null, // TODO: handle abort
          });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ result }));
        } catch (err) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: err.message }));
        }
      });
    }
  }

  stop() {
    this.server.close();
  }
}
```

Then in SDK options:
```typescript
// Start bridge
const bridge = new ToolIpcBridge(tools);
const port = await bridge.start();

// Configure SDK
mcpServers: {
  'kai-tools': {
    url: `http://localhost:${port}/mcp`, // If SDK supports HTTP MCP
    // OR use sse:
    url: `http://localhost:${port}/sse`,
  }
}
```

**But does the Claude Code SDK support HTTP MCP servers?** Need to verify this.

---

## Decision Point

Before proceeding, we need to answer:

1. **Does the Claude Code SDK support stdio-based MCP servers?**
2. **Does the Claude Code SDK support HTTP/SSE-based MCP servers?**
3. **What MCP transport options does `mcpServers` config accept?**

Without knowing the SDK's MCP transport capabilities, we can't design the bridge properly.

---

## Interim Recommendation: Option D + Documentation

**For now**:
1. Accept that Claude Code runtime has limited tool support
2. Add clear documentation in RuntimeSettings UI:
   - **Mastra**: Full Kai features (plan mode, user questions, task management, memory, compaction, sub-agents)
   - **Claude Code**: Fast & reliable, best for file/code operations (Read, Write, Edit, Bash, Grep, LSP)
   - **Codex**: Similar to Claude Code with OpenAI models
3. Add a note: "Kai-specific tools (plan mode, user questions) require Mastra runtime"
4. Update runtime descriptions to set clear expectations

**Later**, when we have SDK documentation or can test MCP transports:
- Implement Option A (stdio MCP) or Option B (HTTP MCP) based on what the SDK supports
- This is a significant architectural addition and warrants its own focused implementation phase

---

## Implementation Steps (Interim Approach)

### Step 1: Update Runtime Descriptions

**File**: `src/components/settings/RuntimeSettings.tsx`

Update `RUNTIME_DESCRIPTIONS`:
```typescript
const RUNTIME_DESCRIPTIONS: Record<string, string> = {
  mastra: 'Built-in runtime with full Kai feature support: memory, observer, compaction, multi-provider models, plan mode, user questions, task management, and sub-agents.',
  'claude-agent-sdk': 'Anthropic\'s Claude Code. Production-tested tool execution, native MCP support, session resume. Best for file/code operations. Note: Kai-specific features (plan mode, user questions) are not available.',
  'codex-sdk': 'OpenAI\'s Codex agent. Thread-based execution with session resume. Best for file/code operations with OpenAI models.',
};
```

### Step 2: Add Feature Comparison Note

Add a prominent note in the Runtime Settings UI:
```tsx
{selectedRuntime !== 'mastra' && (
  <div className="rounded-xl border border-amber-500/40 bg-amber-500/5 px-3 py-2 mt-4">
    <p className="text-xs text-amber-600 dark:text-amber-400">
      <strong>Note:</strong> Kai-specific features (plan mode, user questions, task management) require the Mastra runtime. The {runtimes.find(r => r.id === selectedRuntime)?.name} runtime provides file and code operations only.
    </p>
  </div>
)}
```

### Step 3: Update Capability Table

Update the capability comparison to clarify which features are Kai-specific:
```typescript
['Plan mode', true, false, false],
['User questions', true, false, false],
['Task management', true, false, false],
```

### Step 4: Comment the Bridge Code

Add detailed comments in `claude-agent-runtime.ts` explaining why the bridge doesn't exist and what would be needed:
```typescript
// -----------------------------------------------------------------------
// NOTE: Kai Tool Bridging
// -----------------------------------------------------------------------
// Kai's custom tools (ask_user, enter_plan_mode, exit_plan_mode, task_*,
// etc.) require Electron IPC to show dialogs and manage state. The Claude
// Code SDK runs as a subprocess and cannot access IPC directly.
//
// To bridge these tools, we would need to:
// 1. Create an MCP server (stdio or HTTP) in Kai's main process
// 2. Have that server execute tools via IPC when the SDK calls them
// 3. Configure the SDK to connect to this MCP server
//
// This is architecturally complex and requires:
// - Understanding SDK's supported MCP transports (stdio/HTTP/SSE)
// - Building a subprocess → main process IPC bridge
// - Handling abort signals across process boundaries
// - Managing server lifecycle (start/stop with runtime)
//
// For now, users needing these features should use the Mastra runtime.
// Future work: Implement MCP bridge once SDK transport options are clear.
```

---

## Verification

1. **UI updates**: Open Settings → Agent Runtime, verify descriptions are clear
2. **Note visible**: When Claude Code or Codex is selected, the amber warning appears
3. **Capability table**: Shows plan mode / user questions as Mastra-only
4. **User understanding**: A user reading the UI should understand which runtime to pick based on their needs

---

## Future Work: MCP Bridge Implementation

When ready to implement the bridge:

1. **Research**: Determine SDK's supported MCP transports by reading SDK docs or testing
2. **Choose transport**: stdio (if supported) or HTTP (fallback)
3. **Build bridge**:
   - `electron/agent/runtime/kai-mcp-server.ts` (stdio variant) OR
   - `electron/agent/runtime/tool-http-bridge.ts` (HTTP variant)
4. **Wire to SDK**: Configure `mcpServers` in claude-agent-runtime.ts
5. **Test**: Verify tools work across the bridge (plan mode, ask_user, etc.)
6. **Update UI**: Remove limitation warnings once bridge works

---

## Files to Modify (Interim Approach)

| File | Change |
|------|--------|
| `src/components/settings/RuntimeSettings.tsx` | Update descriptions, add note, update capability table |
| `electron/agent/runtime/claude-agent-runtime.ts` | Add comment explaining bridge challenge |

---

## Files to Create (Future MCP Bridge)

| File | Purpose |
|------|---------|
| `electron/agent/runtime/kai-mcp-server.ts` | Stdio MCP server (if SDK supports) |
| `electron/agent/runtime/tool-http-bridge.ts` | HTTP MCP bridge (if SDK supports) |
| `electron/agent/runtime/mcp-transport-detect.ts` | Detect SDK's MCP capabilities |
