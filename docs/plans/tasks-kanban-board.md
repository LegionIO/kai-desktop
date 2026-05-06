# Add "Tasks" Kanban Board Tab to Kai Desktop

## Context

Kai Desktop currently has two sidebar tabs (Chats and Plugins). The user wants a third **Tasks** tab that displays a kanban board inspired by the Aperant orchestrator (`../sandbox/agent-orchestrators/Aperant`). The critical workflow: when a user accepts a plan via "Accept Plan" in the chat panel, it auto-creates a task in the **Todo** swim lane. Each in-progress task runs an agent (Claude Code, Codex, or Mastra) in an embedded mini-terminal borrowed from Aperant's xterm.js + node-pty integration.

### User's Choices
- **Plan → Task mapping**: One task per plan (title → task title, full markdown → description)
- **Swim lanes**: Todo → In Progress → AI Review → Human Review → Done
- **Terminal**: Borrow Aperant's xterm.js + PTY manager
- **Persistence**: JSON files at `~/.kai/data/tasks/`

---

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                     RENDERER PROCESS                          │
│                                                               │
│  ToolGroup.tsx ─approve─► onPlanApproved callback             │
│       │                        │                              │
│       │              TaskProvider.createTaskFromPlan()         │
│       ▼                        │                              │
│  (existing plan impl flow)     ▼                              │
│                      TaskProvider (Context + useReducer)       │
│                        │                                      │
│     ┌──────────────────┼───────────────────┐                  │
│     │                  │                   │                   │
│  TaskSidebarList   KanbanBoard       TaskDetailPanel          │
│  (sidebar tab)     (main view,       (slide-over panel,       │
│                     dnd-kit)          markdown + terminal)    │
│                                            │                  │
│                                       TaskTerminal            │
│                                       (xterm.js)              │
├────────────────── IPC BRIDGE ────────────────────────────────┤
│                     MAIN PROCESS                              │
│                                                               │
│  electron/ipc/tasks.ts          task-terminal-manager.ts      │
│  ├─ tasks:list/create/update    ├─ tasks:terminal-create      │
│  ├─ tasks:delete                ├─ tasks:terminal-write       │
│  └─ tasks:save-order            ├─ tasks:terminal-resize      │
│  (reads/writes ~/.kai/data/     └─ tasks:terminal-kill        │
│   tasks/*.json)                  (spawns PTY w/ claude/codex) │
└──────────────────────────────────────────────────────────────┘
```

---

## Data Model

**File**: `src/types/task.ts` (NEW)

```typescript
export type KaiTaskStatus = 'todo' | 'in_progress' | 'ai_review' | 'human_review' | 'done';

export interface KaiTask {
  id: string;                       // crypto.randomUUID()
  title: string;                    // From planTitle
  description: string;              // Full plan markdown
  status: KaiTaskStatus;
  createdAt: string;                // ISO 8601
  updatedAt: string;
  sourceConversationId?: string;    // Which chat produced this task
  sourceToolCallId?: string;        // The exit_plan_mode toolCallId
  agentRuntime?: string;            // 'claude-code' | 'codex' | 'mastra'
  terminalSessionId?: string;       // Active PTY session id
  metadata?: KaiTaskMetadata;
}

export const KAI_TASK_STATUS_COLUMNS: KaiTaskStatus[] = [
  'todo', 'in_progress', 'ai_review', 'human_review', 'done'
];
```

**Persistence**: One JSON file per task at `~/.kai/data/tasks/{uuid}.json` + `order.json` for column ordering. Follows Kai's existing `~/.kai/data/` convention.

---

## Implementation Phases

### Phase 1: Foundation (~2-3 days)
Create types, persistence layer, and React Context.

| Action | File | Details |
|--------|------|---------|
| CREATE | `shared/task-types.ts` | Shared types between main/renderer (~30 LOC) |
| CREATE | `src/types/task.ts` | Status enums, column constants, color mappings (~60 LOC) |
| CREATE | `electron/ipc/tasks.ts` | IPC handlers for CRUD + file persistence in `~/.kai/data/tasks/` (~200 LOC) |
| MODIFY | `electron/preload.ts` | Add `tasks` namespace to IPC bridge (same pattern as `conversations`) |
| MODIFY | `electron/main.ts` | Register task handlers |
| MODIFY | `src/lib/ipc-client.ts` | Add `tasks` type to AppAPI |
| CREATE | `src/providers/TaskProvider.tsx` | React Context + useReducer, IPC sync, CRUD actions (~300 LOC) |
| MODIFY | `branding.config.ts` | Add `sidebarSectionTasks: 'Tasks'` |
| MODIFY | `branding.d.ts` | Add `__BRAND_SIDEBAR_SECTION_TASKS` |
| MODIFY | `electron.vite.config.ts` | Add brand constant to Vite define map |

**Verify**: Call `app.tasks.create()` from devtools → JSON file appears in `~/.kai/data/tasks/`

### Phase 2: Sidebar Tab + Kanban Board (~2-3 days)
Third tab visible, kanban board renders with drag-and-drop.

| Action | File | Details |
|--------|------|---------|
| MODIFY | `src/components/SidebarSectionSwitcher.tsx` | Extend `SidebarSection` type to include `'tasks'`, add third tab trigger (+15 LOC) |
| CREATE | `src/components/tasks/TaskSidebarList.tsx` | Compact task list for sidebar (~150 LOC) |
| CREATE | `src/components/tasks/KanbanBoard.tsx` | DndContext, 5 columns, drag handlers. Adapted from Aperant's KanbanBoard (~400 LOC) |
| CREATE | `src/components/tasks/KanbanColumn.tsx` | Droppable column with SortableContext (~150 LOC) |
| CREATE | `src/components/tasks/TaskCard.tsx` | Card: title, status badge, timestamp, agent icon (~120 LOC) |
| CREATE | `src/components/tasks/SortableTaskCard.tsx` | useSortable wrapper (~50 LOC) |
| MODIFY | `src/App.tsx` | Add `TASKS_VIEW` constant, TaskProvider in tree, sidebar routing for tasks tab, main content routing for kanban (+40 LOC) |
| MODIFY | `package.json` | Add `@dnd-kit/core`, `@dnd-kit/sortable`, `@dnd-kit/utilities` |

**Verify**: Switch to Tasks tab → see empty kanban with 5 columns → create task via devtools → card appears

### Phase 3: Plan → Task Bridge (~1-2 days)
Approving a plan in chat auto-creates a task in "Todo".

| Action | File | Details |
|--------|------|---------|
| MODIFY | `src/components/thread/ToolGroup.tsx` | Add `onPlanApproved` callback prop. In `handleApprove` (line ~111), after `approveToolCall()`, fire callback with `{ title, description, planFileName, toolCallId }` (+15 LOC) |
| MODIFY | `src/components/thread/Thread.tsx` | Pass `onPlanApproved` down to ToolGroup, wired to `createTaskFromPlan()` from TaskProvider |

**Key data flow**:
```
User clicks "Accept Plan" → handleApprove()
  → app.agent.approveToolCall()        (existing — continues implementation)
  → onPlanApproved(data)               (new — creates task)
    → TaskProvider.createTaskFromPlan({ title, description, status: 'todo', ... })
    → Task appears in "Todo" column
```

**Verify**: Enter plan-first mode → approve plan → task appears in Todo lane

### Phase 4: Task Detail Panel + Manual Creation (~1-2 days)

| Action | File | Details |
|--------|------|---------|
| CREATE | `src/components/tasks/TaskDetailPanel.tsx` | Right slide-over: full markdown via `<MarkdownText />`, status dropdown, "Start Agent" button, terminal embed area (~250 LOC) |
| CREATE | `src/components/tasks/CreateTaskDialog.tsx` | Radix Dialog for manual task creation (~150 LOC) |

**Verify**: Click task card → detail panel slides in → can change status → can create task manually

### Phase 5: Terminal Integration (~3-4 days)
Port Aperant's xterm.js + node-pty for agent terminals.

| Action | File | Details |
|--------|------|---------|
| CREATE | `electron/terminal/task-terminal-manager.ts` | PTY process manager. Spawns `claude`, `codex`, or `npx mastra dev` based on `agentRuntime`. Broadcasts terminal data/exit via IPC. Adapted from Aperant's terminal manager (~250 LOC) |
| CREATE | `src/hooks/useTaskTerminal.ts` | Hook: xterm.js init, IPC data streaming, resize handling. Adapted from Aperant's `useXterm` + `usePtyProcess` (~120 LOC) |
| CREATE | `src/components/tasks/TaskTerminal.tsx` | Renders xterm.js container (~50 LOC) |
| MODIFY | `electron/ipc/tasks.ts` | Add terminal IPC handlers (create/write/resize/kill) |
| MODIFY | `electron/preload.ts` | Add terminal IPC bridge methods |
| MODIFY | `electron/main.ts` | Instantiate TaskTerminalManager, register terminal handlers |
| MODIFY | `package.json` | Add `@xterm/xterm`, `@xterm/addon-fit`, `@xterm/addon-web-links`, `@lydell/node-pty` |

**Terminal spawn logic**:
- `claude-code` → `claude --dangerously-skip-permissions`
- `codex` → `codex`
- `mastra` → `npx mastra dev`

**Verify**: Open task detail → click "Start Agent" → terminal spawns → can type and see output → kill terminal

### Phase 6: Polish (~2-3 days)

- Column order persistence across restarts
- Terminal cleanup when task moves to done (kill PTY)
- Empty states for each column
- Task count badges in sidebar
- Drag-and-drop visual feedback (ghost overlay, column highlight)
- `React.memo` on TaskCard and KanbanColumn (following Aperant's pattern)
- Error handling: IPC failures, corrupt JSON, missing files

---

## File Summary

| New Files (15) | ~LOC |
|----------------|------|
| `shared/task-types.ts` | 30 |
| `src/types/task.ts` | 60 |
| `src/providers/TaskProvider.tsx` | 300 |
| `src/components/tasks/KanbanBoard.tsx` | 400 |
| `src/components/tasks/KanbanColumn.tsx` | 150 |
| `src/components/tasks/TaskCard.tsx` | 120 |
| `src/components/tasks/SortableTaskCard.tsx` | 50 |
| `src/components/tasks/TaskDetailPanel.tsx` | 250 |
| `src/components/tasks/TaskSidebarList.tsx` | 150 |
| `src/components/tasks/TaskTerminal.tsx` | 50 |
| `src/components/tasks/CreateTaskDialog.tsx` | 150 |
| `src/hooks/useTaskTerminal.ts` | 120 |
| `electron/ipc/tasks.ts` | 200 |
| `electron/terminal/task-terminal-manager.ts` | 250 |
| **Total** | **~2,280** |

| Modified Files (11) | Changes |
|---------------------|---------|
| `SidebarSectionSwitcher.tsx` | +15 lines (add 'tasks' to type, third tab trigger) |
| `App.tsx` | +40 lines (TASKS_VIEW, TaskProvider, routing) |
| `ToolGroup.tsx` | +15 lines (onPlanApproved callback in handleApprove) |
| `Thread.tsx` | +10 lines (wire onPlanApproved to TaskProvider) |
| `ipc-client.ts` | +20 lines (tasks namespace in AppAPI) |
| `electron/preload.ts` | +25 lines (tasks IPC bridge) |
| `electron/main.ts` | +10 lines (register handlers) |
| `branding.config.ts` | +1 line |
| `branding.d.ts` | +1 line |
| `electron.vite.config.ts` | +1 line |
| `package.json` | +7 deps |

## New Dependencies

| Package | Version | Purpose | Source |
|---------|---------|---------|--------|
| `@dnd-kit/core` | ^6.3.1 | Drag-and-drop | Aperant-matched |
| `@dnd-kit/sortable` | ^10.0.0 | Sortable columns | Aperant-matched |
| `@dnd-kit/utilities` | ^3.2.2 | CSS.Transform | Aperant-matched |
| `@xterm/xterm` | ^6.0.0 | Terminal emulator | Aperant-matched |
| `@xterm/addon-fit` | ^0.11.0 | Auto-resize | Aperant-matched |
| `@xterm/addon-web-links` | ^0.12.0 | Clickable URLs | Aperant-matched |
| `@lydell/node-pty` | ^1.1.0 | PTY backend (native) | Aperant-matched |

---

## Verification

### End-to-End Test Flow
1. Launch app → click "Tasks" tab → see empty 5-column kanban
2. Start a chat → trigger plan mode → approve plan → task appears in "Todo"
3. Drag task from "Todo" to "In Progress"
4. Click task → detail panel opens with full plan markdown
5. Click "Start Agent" → select "Claude Code" → mini-terminal spawns
6. Type in terminal → see agent output
7. Drag task to "Done" → terminal killed automatically
8. Restart app → all tasks persist, order preserved
9. Create task manually via dialog → appears in Todo
10. Delete task → JSON file removed from `~/.kai/data/tasks/`
