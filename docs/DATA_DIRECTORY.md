# Kai Data Directory

This document describes the structure and schema of Kai's user data directory located at `~/.kai/data/`.

## ⚠️ Important Note

**Manual editing of JSON files is not officially supported.** While possible, it may lead to data corruption or unexpected behavior. Always use the Kai UI for managing agents and tasks when possible.

## Directory Structure

```
~/.kai/data/
├── agents/          # Agent definitions (JSON files)
│   └── {uuid}.json
├── tasks/           # Task definitions (JSON files)
│   ├── {uuid}.json
│   └── order.json   # Task board column ordering
└── memory.db        # SQLite database for conversation history
```

---

## Agents (`agents/*.json`)

Each agent is stored as a separate JSON file named with its UUID.

### Schema

```typescript
{
  id: string;                    // UUID (e.g., "3b4d0ded-7374-41b6-8720-624e9206bb2a")
  name: string;                  // Display name (e.g., "DrZero")
  status: "idle" | "running";    // Current agent status
  runtime: "auto" | "claude-code" | "codex" | "mastra";  // Execution runtime
  currentTaskId?: string;        // UUID of assigned task (or undefined)
  icon?: string;                 // Icon identifier
  description?: string;          // Agent description
  instructions?: string;         // System instructions for agent
  role?: AgentRole;              // Role assignment (e.g., matchedRoleId)
  workspaceId?: string;          // Associated workspace
  config: {
    cwd?: string;                // Working directory
    maxSessionSeconds?: number;  // Max runtime per session
    maxCrashesPerDay?: number;   // Crash limit (default: 5)
    customArgs?: string[];       // Runtime arguments
    env?: Record<string, string>; // Environment variables
  };
  stats: {
    tasksCompleted: number;      // Completed task count
    totalRuntime: number;        // Total seconds running
    crashCount: number;          // Crash count today
    lastRunAt?: string;          // ISO timestamp
  };
  terminalSessionId?: string;    // Active terminal session ID
  createdAt: string;             // ISO timestamp
  updatedAt: string;             // ISO timestamp
}
```

### Key Fields

- **`currentTaskId`**: Points to the UUID of the task assigned to this agent
  - ⚠️ Common mistake: Using `assignedTaskId` instead (incorrect)
  - Must match a task's `assignedAgentId` for proper linking

- **`status`**: 
  - `"idle"`: Agent is not running
  - `"running"`: Agent has an active terminal session

- **`runtime`**: 
  - `"auto"`: Uses default from config (usually claude-code)
  - `"claude-code"`: Anthropic Claude Agent SDK
  - `"codex"`: OpenAI Codex SDK
  - `"mastra"`: Mastra framework runtime

### Example

```json
{
  "id": "3b4d0ded-7374-41b6-8720-624e9206bb2a",
  "name": "DrZero",
  "status": "idle",
  "runtime": "auto",
  "currentTaskId": "ca490190-63a6-4cde-bf68-c6a13beaea49",
  "role": {
    "matchedRoleId": "engineering/engineering-rapid-prototyper"
  },
  "config": {
    "maxCrashesPerDay": 5
  },
  "stats": {
    "tasksCompleted": 0,
    "totalRuntime": 0,
    "crashCount": 0
  },
  "createdAt": "2026-05-12T22:05:14.397Z",
  "updatedAt": "2026-05-12T22:05:14.397Z"
}
```

---

## Tasks (`tasks/*.json`)

Each task is stored as a separate JSON file named with its UUID.

### Schema

```typescript
{
  id: string;                    // UUID
  title: string;                 // Task title
  description: string;           // Full task description/requirements
  status: "todo" | "in_progress" | "ai_review" | "human_review" | "done";
  assignedAgentId?: string;      // UUID of assigned agent (or undefined)
  workspaceId?: string;          // Associated workspace
  agentRuntime?: string;         // Runtime agent is using
  terminalSessionId?: string;    // Active terminal session ID
  sourceConversationId?: string; // Origin conversation
  sourceToolCallId?: string;     // Origin tool call
  metadata?: {
    category?: "feature" | "bug_fix" | "refactoring" | "docs" | "other";
    labels?: string[];           // Custom labels
    planFileName?: string;       // Associated plan file
    cwd?: string;                // Working directory
  };
  conversationHistory?: Array<{  // AI task generation history
    role: "user" | "assistant";
    content: string;
    timestamp: string;
  }>;
  createdAt: string;             // ISO timestamp
  updatedAt: string;             // ISO timestamp
  startedAt?: string;            // When task moved to in_progress
  completedAt?: string;          // When task marked done
  archivedAt?: string;           // When task archived (hidden)
}
```

### Key Fields

- **`assignedAgentId`**: Points to the UUID of the agent assigned to this task
  - ⚠️ Common mistake: Using `assignedAgent` instead (incorrect)
  - Must match an agent's `currentTaskId` for proper linking

- **`status`**: Task lifecycle stage
  - `"todo"`: Not started
  - `"in_progress"`: Agent is working on it
  - `"ai_review"`: Completed, awaiting AI review
  - `"human_review"`: Completed, awaiting human review
  - `"done"`: Fully completed

### Example

```json
{
  "id": "ca490190-63a6-4cde-bf68-c6a13beaea49",
  "title": "workspace-onboarding-four-related-repos",
  "description": "Set up workspace for four related repositories...",
  "status": "todo",
  "assignedAgentId": "3b4d0ded-7374-41b6-8720-624e9206bb2a",
  "metadata": {
    "category": "feature",
    "labels": ["setup", "onboarding"]
  },
  "createdAt": "2026-05-12T17:05:46.238Z",
  "updatedAt": "2026-05-13T03:44:32Z"
}
```

---

## Task Board Ordering (`tasks/order.json`)

Stores the ordering of tasks in each status column on the task board.

### Schema

```json
{
  "todo": ["task-uuid-1", "task-uuid-2"],
  "in_progress": ["task-uuid-3"],
  "ai_review": [],
  "human_review": [],
  "done": ["task-uuid-4", "task-uuid-5"]
}
```

---

## Agent ↔ Task Relationship

Agents and tasks form a **bidirectional relationship**:

```
Agent                          Task
┌─────────────────┐           ┌─────────────────┐
│ id: "uuid-A"    │           │ id: "uuid-T"    │
│ currentTaskId: ─┼──────────>│ assignedAgentId:│
│   "uuid-T"      │           │   "uuid-A"      │
└─────────────────┘           └─────────────────┘
```

### Assignment Process

1. **Via UI**: Use the task board or agent panel to assign
2. **Via IPC**: Call `agents:assign-task` handler
3. **Manual (not recommended)**:
   ```bash
   # Set task's assignedAgentId
   jq '.assignedAgentId = "agent-uuid"' task.json
   
   # Set agent's currentTaskId
   jq '.currentTaskId = "task-uuid"' agent.json
   ```

### Common Field Mistakes

| ❌ Wrong Field       | ✅ Correct Field     | Location |
|---------------------|---------------------|----------|
| `assignedAgent`     | `assignedAgentId`   | Task     |
| `assignedTaskId`    | `currentTaskId`     | Agent    |
| `taskId`            | `currentTaskId`     | Agent    |

When these mistakes occur, Kai logs warnings like:
```
[tasks] Task ca490190... has deprecated field 'assignedAgent' but expected 'assignedAgentId'.
```

---

## Memory Database (`memory.db`)

SQLite database containing:
- `mastra_conversations`: Conversation history for the main Kai assistant
- `mastra_messages`: Individual messages in conversations
- `mastra_agents`: **Unused by the agent/task system** (Mastra SDK tables)
- `mastra_agent_versions`: **Unused by the agent/task system** (Mastra SDK tables)

### Important Note

The `mastra_agents` and `mastra_agent_versions` tables are part of the Mastra framework SDK used by the **main conversational assistant**, not the autonomous agent/task system. They will be empty even when agents exist in `~/.kai/data/agents/`.

This is **not a bug** - it's two separate systems:
1. **Main Assistant**: Uses Mastra SDK + database
2. **Agent/Task System**: Uses JSON files

---

## Backup & Recovery

### Backup

```bash
# Backup entire data directory
cp -r ~/.kai/data/ ~/.kai/data.backup-$(date +%Y%m%d-%H%M%S)

# Backup specific agent
cp ~/.kai/data/agents/uuid.json ~/.kai/data/agents/uuid.json.backup
```

### Recovery

```bash
# Restore from backup
cp -r ~/.kai/data.backup-TIMESTAMP/ ~/.kai/data/

# Restart Kai Desktop to reload
pkill -TERM Kai && sleep 2 && open -a Kai
```

---

## Validation

Kai performs runtime validation and logs warnings for common issues:

### Field Name Validation

- Checks for deprecated field names
- Warns about incorrect agent/task linkage
- No automatic correction (to prevent data loss)

### Relationship Validation

- Verifies agent's `currentTaskId` points to existing task
- Verifies task's `assignedAgentId` points to existing agent
- No enforcement (allows orphaned references for manual cleanup)

---

## Troubleshooting

### Agent Won't Pick Up Task

**Symptoms**: Agent shows idle, task shows assigned, but nothing happens

**Causes**:
1. Wrong field names (`assignedAgent` instead of `assignedAgentId`)
2. Missing bidirectional link (task assigned to agent but not vice versa)
3. Agent needs manual start (no automatic polling in v0.3.10)

**Fix**:
1. Check console for field validation warnings
2. Verify both `agent.currentTaskId` and `task.assignedAgentId` are set correctly
3. Click "Start" button in Kai UI (agents don't auto-start)

### Task Shows "No Agent Assigned"

**Symptoms**: Task has `assignedAgentId` but UI shows unassigned

**Causes**:
1. Agent JSON file doesn't have matching `currentTaskId`
2. Agent UUID in `assignedAgentId` doesn't exist

**Fix**:
1. Verify agent exists: `ls ~/.kai/data/agents/{uuid}.json`
2. Check agent's `currentTaskId` matches task UUID
3. Reassign via UI to establish correct relationship

---

## Related Documentation

- [Agent System Architecture](./AGENT_ARCHITECTURE.md) (proposed)
- [Task System Architecture](./TASK_ARCHITECTURE.md) (proposed)
- [IPC Handlers Reference](./IPC_HANDLERS.md) (proposed)

---

## Questions?

If you encounter issues with the data directory or need clarification on the schema, please:
1. Check console logs for validation warnings
2. Review this document for correct field names
3. Open an issue on GitHub with your JSON structure (redact sensitive data)
