# Agent & Task System Architecture

This document explains Kai Desktop's agent and task management architecture, clarifying the separation between the JSON-based autonomous agent system and the database-backed Mastra conversational agent system.

## Overview

Kai Desktop has **two separate agent systems** that serve different purposes and use different storage mechanisms:

1. **Autonomous Agent/Task System** (JSON-based) - For long-running background agents
2. **Main Conversational Agent** (Database-backed) - For the primary Kai assistant

This separation is **intentional** and not a bug, but it can be confusing because both use the term "agent" and share some infrastructure.

---

## System 1: Autonomous Agent/Task System

### Purpose

Enables users to create autonomous agents that can work on tasks independently in background terminal sessions.

### Storage: JSON Files

**Location**: `~/.kai/data/agents/` and `~/.kai/data/tasks/`

**Why JSON?**
- Simple persistence without database complexity
- Easy to inspect and debug
- Fast reads/writes for file-based operations
- Human-readable for advanced users

### Architecture

```
┌──────────────────────────────────────────────────────────┐
│                      Kai Desktop UI                       │
│                                                           │
│  ┌─────────────┐              ┌─────────────┐           │
│  │ Agent Panel │              │ Task Board  │           │
│  └──────┬──────┘              └──────┬──────┘           │
│         │                             │                   │
└─────────┼─────────────────────────────┼───────────────────┘
          │                             │
          │ IPC: agents:*               │ IPC: tasks:*
          │                             │
┌─────────▼─────────────────────────────▼───────────────────┐
│              Electron Main Process                         │
│                                                            │
│  ┌──────────────────┐      ┌──────────────────┐          │
│  │ agents.ts        │      │ tasks.ts         │          │
│  │ - readAgent()    │      │ - readTask()     │          │
│  │ - writeAgent()   │      │ - writeTask()    │          │
│  │ - assign-task    │      │ - update         │          │
│  │ - start/stop     │      │ - create         │          │
│  └────────┬─────────┘      └────────┬─────────┘          │
│           │                         │                     │
│           │ JSON I/O                │ JSON I/O            │
│           │                         │                     │
│  ┌────────▼─────────────────────────▼─────────┐          │
│  │       File System                            │          │
│  │  ~/.kai/data/agents/{uuid}.json              │          │
│  │  ~/.kai/data/tasks/{uuid}.json               │          │
│  └─────────────────────────────────────────────┘          │
│                                                            │
│  ┌─────────────────────────────────────────────┐          │
│  │   TaskTerminalManager                        │          │
│  │   - Spawns terminal sessions                 │          │
│  │   - Runs Claude Code, Codex, or Mastra       │          │
│  │   - Injects task descriptions                │          │
│  └─────────────────────────────────────────────┘          │
└────────────────────────────────────────────────────────────┘
```

### Key Components

**1. Agent Files** (`~/.kai/data/agents/{uuid}.json`)
- Contains agent configuration, instructions, runtime settings
- `currentTaskId` field links to assigned task
- Status tracked: `"idle"` or `"running"`

**2. Task Files** (`~/.kai/data/tasks/{uuid}.json`)
- Contains task title, description, status
- `assignedAgentId` field links to assigned agent
- Status lifecycle: `todo → in_progress → done`

**3. IPC Handlers** (`electron/ipc/agents.ts`, `electron/ipc/tasks.ts`)
- `agents:create`, `agents:assign-task`, `agents:start`, `agents:stop`
- `tasks:create`, `tasks:update`, `tasks:get`, `tasks:list`
- No database queries - pure JSON I/O

**4. Terminal Manager** (`electron/terminal/task-terminal-manager.ts`)
- Spawns PTY sessions for agent runtimes
- Injects task descriptions as initial prompts
- Streams output back to UI

### Workflow

1. **User creates agent** via UI
   - Agent JSON file written to `~/.kai/data/agents/`
   - Agent appears in UI immediately

2. **User creates task** via UI or plan generation
   - Task JSON file written to `~/.kai/data/tasks/`
   - Task appears on board immediately

3. **User assigns task to agent** via drag-and-drop or assign button
   - IPC call: `agents:assign-task(agentId, taskId)`
   - Updates both JSON files:
     - `agent.currentTaskId = taskId`
     - `task.assignedAgentId = agentId`

4. **User clicks "Start" on agent**
   - IPC call: `agents:start(agentId)`
   - Reads agent and task JSON files
   - Spawns terminal with configured runtime
   - Injects task description as prompt
   - Updates `agent.status = "running"`

5. **Agent works on task** in terminal session
   - Terminal output streamed to UI
   - User can monitor progress
   - No automatic task completion detection

6. **User clicks "Stop"** or agent exits
   - Terminal killed
   - `agent.status = "idle"`
   - Task status manually updated by user

### Limitations

- **No automatic polling**: Agents don't start automatically
- **Manual task assignment**: No auto-matching based on roles
- **Manual status updates**: Task completion not detected automatically
- **No persistence of terminal state**: Restart loses session

---

## System 2: Main Conversational Agent (Mastra)

### Purpose

Powers the main Kai assistant that handles conversations, tool calls, and context management for the primary chat interface.

### Storage: SQLite Database

**Location**: `~/.kai/data/memory.db`

**Tables**:
- `mastra_agents` - Agent definitions
- `mastra_agent_versions` - Agent version history
- `mastra_conversations` - Conversation threads
- `mastra_messages` - Individual messages
- `mastra_tools` - Available tools

**Why Database?**
- Complex relational queries (messages, context, tools)
- ACID transactions for consistency
- Efficient full-text search
- Structured conversation history
- Tool call tracking and approval

### Architecture

```
┌──────────────────────────────────────────────────────────┐
│                    Kai Desktop UI                         │
│                                                           │
│  ┌─────────────────────────────────────────┐             │
│  │   Main Chat Interface                    │             │
│  └──────────────┬───────────────────────────┘             │
│                 │                                         │
└─────────────────┼─────────────────────────────────────────┘
                  │
                  │ IPC: agent:*
                  │
┌─────────────────▼─────────────────────────────────────────┐
│              Electron Main Process                         │
│                                                            │
│  ┌────────────────────────────────────────┐               │
│  │  agent.ts (Main Agent Handler)         │               │
│  │  - streamResponse()                    │               │
│  │  - generate-title                      │               │
│  │  - approve-tool / reject-tool          │               │
│  └─────────────┬──────────────────────────┘               │
│                │                                          │
│  ┌─────────────▼──────────────────────────┐               │
│  │  Mastra Agent SDK                       │               │
│  │  (@mastra/core, @mastra/memory)         │               │
│  │  - Agent versioning                     │               │
│  │  - Tool management                      │               │
│  │  - Conversation state                   │               │
│  └─────────────┬──────────────────────────┘               │
│                │                                          │
│                │ Database queries                         │
│                │                                          │
│  ┌─────────────▼──────────────────────────┐               │
│  │      SQLite: memory.db                  │               │
│  │                                          │               │
│  │  mastra_agents                          │               │
│  │  mastra_agent_versions                  │               │
│  │  mastra_conversations                   │               │
│  │  mastra_messages                        │               │
│  │  mastra_tools                           │               │
│  └─────────────────────────────────────────┘               │
└────────────────────────────────────────────────────────────┘
```

### Key Components

**1. Mastra SDK** (`@mastra/core`)
- Framework for building conversational agents
- Handles message history, context, tool calls
- Manages agent versioning and updates
- Provides database abstractions

**2. Database Schema**
- `mastra_agents`: High-level agent metadata (id, status, activeVersionId)
- `mastra_agent_versions`: Version-specific config (name, instructions, tools, model)
- `mastra_conversations`: Conversation threads with metadata
- `mastra_messages`: Individual messages with role, content, tool calls

**3. Agent Handler** (`electron/ipc/agent.ts`)
- Streams LLM responses to UI
- Handles tool approval workflow
- Generates conversation titles
- Manages sub-agent spawning

### Workflow

1. **User sends message** in main chat
   - IPC call: `agent:stream-response(conversationId, messages)`
   - Message saved to `mastra_messages`

2. **Mastra agent processes**
   - Loads agent version from database
   - Retrieves conversation context
   - Calls LLM with available tools

3. **Tool calls require approval**
   - Tool call saved to database
   - UI shows approval prompt
   - User approves/rejects
   - Result saved and LLM continues

4. **Response streamed**
   - Chunks sent to renderer process
   - Final message saved to database
   - Conversation updated

---

## Why Two Systems?

### Historical Context

Kai Desktop evolved from a single conversational agent (Mastra-based) to support autonomous background agents for task execution. Rather than shoehorn task agents into the Mastra framework, a simpler JSON-based system was built.

### Design Rationale

| Aspect                    | Conversational Agent (DB) | Task Agent (JSON)      |
|---------------------------|---------------------------|------------------------|
| **Interaction Pattern**   | Synchronous chat          | Async background work  |
| **State Complexity**      | High (tools, context)     | Low (config, status)   |
| **Query Patterns**        | Relational, full-text     | Simple key-value       |
| **Persistence Needs**     | History, versions, tools  | Config, assignment     |
| **Read Frequency**        | Constant (every message)  | Occasional (UI load)   |
| **Write Frequency**       | High (every message)      | Low (status changes)   |
| **Data Size**             | Grows unbounded           | Fixed per agent        |

### Trade-offs

**JSON System Advantages:**
- ✅ Simple, no ORM overhead
- ✅ Easy to backup/restore
- ✅ Human-readable for debugging
- ✅ Fast for small datasets

**JSON System Disadvantages:**
- ❌ No query optimization
- ❌ No transactions
- ❌ Manual consistency management
- ❌ Race conditions on concurrent writes

**Database System Advantages:**
- ✅ Transactions and ACID
- ✅ Efficient complex queries
- ✅ Built-in full-text search
- ✅ Scales to millions of messages

**Database System Disadvantages:**
- ❌ Migration complexity
- ❌ Harder to inspect manually
- ❌ Larger memory footprint

---

## Common Confusion Points

### 1. "Why is `mastra_agents` empty?"

**Answer**: Because the autonomous agent/task system uses JSON files, not the Mastra SDK database tables.

The `mastra_agents` table is for the **main conversational agent** that you chat with in Kai's primary interface. The **autonomous agents** you create in the Agents panel are stored in `~/.kai/data/agents/` as JSON files.

### 2. "Why don't agents auto-start when assigned tasks?"

**Answer**: The JSON-based system has no background polling mechanism.

Unlike a traditional job queue system, Kai's autonomous agents require manual start via the UI. This is a design choice to:
- Give users explicit control
- Avoid surprise resource usage
- Keep the implementation simple

### 3. "Can I migrate agents to the database?"

**Answer**: Technically possible but not currently supported.

You could write a migration script to insert agent JSON data into `mastra_agents` and `mastra_agent_versions`, but:
- The IPC handlers would need updates to query the database
- The Mastra SDK would need to be integrated with task terminal management
- Bidirectional sync between JSON and DB would be required

This is future work and not trivial.

### 4. "Why have two systems at all?"

**Answer**: Pragmatic incremental development.

Kai started with Mastra for conversational AI. Adding autonomous task agents was a new feature with different requirements. Building a separate JSON-based system was:
- Faster to implement
- Lower risk (didn't touch existing Mastra code)
- Easier to iterate on

The downside is architectural confusion, which this document aims to clarify.

---

## Future Architecture Considerations

### Option 1: Unify on Database

**Approach**: Migrate agent/task system to use `mastra_agents` + new `kai_tasks` table

**Pros**:
- Single source of truth
- Better query capabilities
- Transactions for consistency
- Easier to add features (filtering, search, history)

**Cons**:
- Migration complexity
- Breaking changes for existing users
- More code to maintain

### Option 2: Unify on JSON

**Approach**: Remove `mastra_agents` and use JSON for everything

**Pros**:
- Simpler overall architecture
- No database dependency
- Easier backups

**Cons**:
- Conversation history would be very inefficient
- No good solution for full-text search
- Mastra SDK benefits lost

### Option 3: Keep Separate but Clarify

**Approach**: Keep both systems but improve documentation and naming

**Pros**:
- No breaking changes
- Both systems optimized for their use case
- Clear separation of concerns

**Cons**:
- Conceptual overhead for users
- Duplicate code (some logic in both)

**Recommendation**: **Option 3** for now, potentially **Option 1** in a major version.

---

## Developer Guidelines

### When Working on Autonomous Agents/Tasks

✅ **DO**:
- Modify files in `electron/ipc/agents.ts` and `electron/ipc/tasks.ts`
- Use `readAgent()`, `writeAgent()`, `readTask()`, `writeTask()` helpers
- Update JSON files directly
- Test with sample JSON files in `~/.kai/data/`

❌ **DON'T**:
- Query the `mastra_agents` or `mastra_agent_versions` tables
- Use the Mastra SDK for agent/task operations
- Expect automatic polling or background execution

### When Working on Main Conversational Agent

✅ **DO**:
- Modify files in `electron/ipc/agent.ts` (singular)
- Use the Mastra SDK (`@mastra/core`, `@mastra/memory`)
- Query `mastra_conversations`, `mastra_messages` tables
- Use transactions for consistency

❌ **DON'T**:
- Read/write JSON files in `~/.kai/data/agents/` or `~/.kai/data/tasks/`
- Confuse this with the autonomous agent system

### Adding New Features

**Before implementing**, determine which system the feature belongs to:

- **Conversational features**: Chat, tools, context, history → Use Mastra/Database
- **Task execution features**: Agents, tasks, terminals, status → Use JSON files

If a feature spans both (e.g., "create task from conversation"), coordinate between both systems via IPC.

---

## Testing Guidance

### Testing Autonomous Agents

```bash
# Create test agent JSON
echo '{
  "id": "test-agent-001",
  "name": "Test Agent",
  "status": "idle",
  "runtime": "auto",
  "currentTaskId": "test-task-001",
  "config": {},
  "stats": {"tasksCompleted": 0, "totalRuntime": 0, "crashCount": 0},
  "createdAt": "2026-01-01T00:00:00Z",
  "updatedAt": "2026-01-01T00:00:00Z"
}' > ~/.kai/data/agents/test-agent-001.json

# Verify it appears in Kai UI
open -a Kai
```

### Testing Conversational Agent

```bash
# Query database
sqlite3 ~/.kai/data/memory.db "SELECT * FROM mastra_agents;"
sqlite3 ~/.kai/data/memory.db "SELECT * FROM mastra_conversations LIMIT 10;"

# Start conversation
# (Use Kai UI, as main agent is always present)
```

---

## Related Documentation

- [Data Directory Structure](./DATA_DIRECTORY.md)
- [IPC Handlers Reference](./IPC_HANDLERS.md) (proposed)
- [Agent System Roadmap](./ROADMAP.md) (proposed)

---

## Questions?

If you have questions about the architecture or encounter issues:
1. Check which system you're working with (JSON vs Database)
2. Review the appropriate section of this document
3. Open an issue on GitHub with architecture clarification tag
