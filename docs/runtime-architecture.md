# Runtime Architecture

Kai Desktop supports pluggable agent runtimes that power conversations. Each runtime wraps a different AI agent execution engine behind a common interface, allowing users to switch between them in Settings without changing how the rest of the app works.

## Overview

```
┌─────────────────────────────────────────────────────────┐
│  Renderer (React)                                       │
│  RuntimeProvider → StreamEvent accumulation → UI        │
└──────────────────────┬──────────────────────────────────┘
                       │ IPC (agent:stream)
┌──────────────────────▼──────────────────────────────────┐
│  IPC Layer (electron/ipc/agent.ts)                      │
│  resolveRuntime(config) → runtime.stream(options)       │
│  Middleware: observer, compaction (gated by caps)       │
└──────────────────────┬──────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────┐
│  Runtime Registry (electron/agent/runtime/index.ts)     │
│  ┌───────────┐  ┌──────────────────┐  ┌─────────────┐  │
│  │  Mastra   │  │ Claude Agent SDK │  │  Codex SDK  │  │
│  │ (built-in)│  │  (optional)      │  │ (optional)  │  │
│  └───────────┘  └──────────────────┘  └─────────────┘  │
└─────────────────────────────────────────────────────────┘
```

## Key Files

| File | Purpose |
|------|---------|
| `electron/agent/runtime/types.ts` | `AgentRuntime` interface, `StreamEvent`, `StreamOptions`, `RuntimeCapabilities` |
| `electron/agent/runtime/index.ts` | Registry: `registerRuntime()`, `resolveRuntime()`, `getAvailableRuntimes()` |
| `electron/agent/runtime/mastra-runtime.ts` | Built-in Mastra adapter (always available) |
| `electron/agent/runtime/claude-agent-runtime.ts` | Claude Agent SDK adapter (optional) |
| `electron/agent/runtime/codex-runtime.ts` | Codex SDK adapter (optional) |
| `electron/agent/runtime/detect.ts` | CLI availability detection (`which claude`, `which codex`) |
| `electron/agent/runtime/tool-mcp-bridge.ts` | Exposes Kai's tools as MCP for external SDKs |
| `src/components/settings/RuntimeSettings.tsx` | Settings UI for runtime selection |

## AgentRuntime Interface

Every runtime must implement:

```typescript
interface AgentRuntime {
  readonly id: RuntimeId;           // 'mastra' | 'claude-agent-sdk' | 'codex-sdk'
  readonly name: string;            // Human-readable display name
  readonly capabilities: RuntimeCapabilities;

  isAvailable(): Promise<boolean>;  // Can this runtime be used?

  stream(options: StreamOptions): AsyncGenerator<StreamEvent>;  // Core streaming

  generateTitle?(messages: unknown[], config: AppConfig): Promise<string | null>;
  dispose?(): Promise<void>;
}
```

## StreamEvent Format

The `stream()` method yields `StreamEvent` objects that the renderer accumulates into the conversation UI. Required events:

| Event Type | Description | Required Fields |
|------------|-------------|-----------------|
| `text-delta` | Incremental text from the assistant | `text` |
| `tool-call` | A tool invocation started | `toolCallId`, `toolName`, `args` |
| `tool-result` | A tool execution completed | `toolCallId`, `toolName`, `result` |
| `done` | Turn is complete | — |
| `error` | Unrecoverable error | `error` (string) |

Optional events that enhance the UI:

| Event Type | Description |
|------------|-------------|
| `context-usage` | Token usage stats (input/output/total) |
| `observer-message` | Tool execution monitoring messages |
| `compaction` | Context was compacted |
| `model-fallback` | Switched to a fallback model |
| `retry` | API call is being retried |
| `enrichment` | Metadata about the session (SDK version, session ID) |
| `tool-progress` | Streaming output from a running tool |
| `tool-compaction` | A tool result was compacted |
| `tool-approval-required` | Waiting for user approval |

All events carry `conversationId: string` and `type: string`.

## RuntimeCapabilities

Capabilities control which IPC middleware runs:

```typescript
type RuntimeCapabilities = {
  builtInTools: boolean;   // Runtime has its own tools (no need for Kai's)
  mcpSupport: boolean;     // Runtime connects to MCP servers natively
  toolObserver: boolean;   // Compatible with Kai's ToolObserverManager
  compaction: boolean;     // Compatible with Kai's context compaction
  memory: boolean;         // Compatible with Kai's memory layers
  fallback: boolean;       // Supports model fallback chains
  multiProvider: boolean;  // Supports multiple model providers
  subAgents: boolean;      // Supports sub-agent delegation
  sessions: boolean;       // Supports session resume
  customTools: boolean;    // Accepts custom Kai tools at stream time
};
```

The IPC layer checks these before applying middleware:

```typescript
// Only run observer if the runtime supports it
if (runtime.capabilities.toolObserver) {
  // Apply tool observer middleware
}

// Only run compaction if the runtime supports it
if (runtime.capabilities.compaction) {
  // Apply context compaction middleware
}
```

## Runtime Resolution

When a user sends a message, the IPC layer resolves which runtime to use:

```typescript
const runtime = await resolveRuntime(config);
const stream = runtime.stream(options);
```

Resolution algorithm:

1. Read `config.agent.runtime` (`'auto'` | `'mastra'` | `'claude-agent-sdk'` | `'codex-sdk'`)
2. If explicitly set and available (CLI found on PATH) → use it
3. If `'auto'`: try Claude Agent SDK (if `claude` CLI available) → fall back to Mastra
4. If selected runtime unavailable (CLI not on PATH) → fall back to Mastra (always available)

> **Note:** Both `@anthropic-ai/claude-agent-sdk` and `@openai/codex-sdk` are bundled
> as regular dependencies. Availability depends on whether the corresponding CLI
> binary (`claude` or `codex`) is found on the user's PATH, not on package installation.

## Tool MCP Bridge

External SDKs (Claude Agent SDK, Codex SDK) have their own tool execution loops. To expose Kai's custom tools (skills, plugins, CLI tools) to these SDKs, we use the `ToolMcpBridge`:

```typescript
import { ToolMcpBridge } from './tool-mcp-bridge.js';

const bridge = new ToolMcpBridge({
  tools: activeTools,      // Kai's ToolDefinition[]
  conversationId: 'abc',
  cwd: '/path/to/workspace',
});

// List tools with JSON Schema (converted from Zod via toJSONSchema())
bridge.listTools(); // → McpToolListEntry[]

// Execute a tool
await bridge.callTool('read-file', { path: '/tmp/foo.txt' });
```

For the Claude Agent SDK specifically, tools are passed via `createSdkMcpServer()`:

```typescript
const sdkTools = tools.map(tool => sdkToolHelper(
  tool.name, tool.description, extractZodShape(tool.inputSchema), handler
));
const mcpConfig = createSdkMcpServer({ name: 'kai-tools', tools: sdkTools });
// Pass to SDK options: mcpServers: { 'kai-tools': mcpConfig }
```

## Adding a Custom Runtime

To add a new runtime adapter:

### 1. Create the adapter file

```typescript
// electron/agent/runtime/my-runtime.ts
import type { AgentRuntime, RuntimeCapabilities, StreamOptions, StreamEvent } from './types.js';

const MY_CAPABILITIES: RuntimeCapabilities = {
  builtInTools: true,
  mcpSupport: false,
  // ... set capabilities
};

export class MyRuntime implements AgentRuntime {
  readonly id = 'my-runtime' as const;  // Add to RuntimeId union in types.ts
  readonly name = 'My Runtime';
  readonly capabilities = MY_CAPABILITIES;

  async isAvailable(): Promise<boolean> {
    // Check if dependencies are installed
    try {
      await import('my-runtime-sdk');
      return true;
    } catch { return false; }
  }

  async *stream(options: StreamOptions): AsyncGenerator<StreamEvent> {
    const { conversationId, messages, config, tools, cwd, abortSignal } = options;

    // 1. Extract the user prompt
    // 2. Configure the SDK
    // 3. Start streaming
    // 4. Translate SDK events → StreamEvent

    yield { conversationId, type: 'text-delta', text: 'Hello!' };
    yield { conversationId, type: 'done' };
  }
}
```

### 2. Add the runtime ID to the type union

In `electron/agent/runtime/types.ts`:

```typescript
export type RuntimeId = 'mastra' | 'claude-agent-sdk' | 'codex-sdk' | 'my-runtime';
```

### 3. Register the runtime

In `electron/main.ts`:

```typescript
import { MyRuntime } from './agent/runtime/my-runtime.js';
registerRuntime(new MyRuntime());
```

### 4. Add CLI detection (optional)

In `electron/agent/runtime/detect.ts`:

```typescript
export async function detectMyRuntime(): Promise<boolean> {
  return isCliAvailable('my-runtime-cli');
}
```

### 5. Add to Settings UI

In `src/components/settings/RuntimeSettings.tsx`, add an option to the select dropdown and any runtime-specific configuration fields.

### 6. Externalize in Vite config

In `electron.vite.config.ts`, add the package to the externals list so it's not bundled:

```typescript
external: [
  // ... existing
  'my-runtime-sdk',
],
```

## Configuration

Runtime settings live in `~/.kai/config.json`:

```json
{
  "agent": {
    "runtime": "auto",
    "claudeAgentSdk": {
      "permissionMode": "default",
      "maxTurns": 25,
      "thinking": { "type": "adaptive" },
      "persistSession": false
    },
    "codexSdk": {
      "approval": "suggest"
    }
  }
}
```

## Testing

Runtime tests use Vitest and live in `electron/agent/runtime/__tests__/`:

```bash
pnpm test          # Run all tests
pnpm test:watch    # Watch mode
```

Current test coverage:
- `registry.test.ts` — Registry operations, resolution, fallback logic
- `tool-mcp-bridge.test.ts` — JSON Schema conversion, tool execution, error handling
