# Kai Workspace: Developer-First Redesign

## Vision

Kai Workspace is a task-driven development environment where humans define what needs to be done and AI plans and executes autonomously. The human's role shifts from writing code to defining tasks, reviewing plans, and approving results. Every interaction is captured, every change is isolated, and the developer stays in control without being in the loop.

---

## Core Principles

1. **Task is the atom.** Everything flows from a task. No orphaned conversations, no loose threads. Every AI action traces back to a task.
2. **Isolation by default.** Each task gets its own worktree and execution thread. Tasks cannot interfere with each other.
3. **Autonomy with accountability.** AI runs with full terminal access but every command, file change, and decision is logged in the task thread. The human can replay the full execution.
4. **Human gates, not human loops.** The human approves the plan (before) and the result (after). They don't babysit execution.
5. **Progressive disclosure.** Simple surface, deep capability. A new user sees a task list and a chat. A power user sees worktrees, execution logs, and plugin hooks.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                          Kai Workspace                          │
├────────┬────────────────────────────────────────────────────────┤
│        │                                                        │
│  U     │              Main Content Area                         │
│  N     │  ┌──────────────────────────────────────────────────┐  │
│  I     │  │  Dynamic based on context:                       │  │
│  F     │  │  - Task Board (default)                          │  │
│  I     │  │  - Task Thread (when task selected)              │  │
│  E     │  │  - Git / Changes (when Git tab selected)         │  │
│  D     │  │  - Analysis (Insights/Roadmap/Ideation)          │  │
│        │  │  - Plugin panels                                 │  │
│  S     │  │                                                  │  │
│  I     │  └──────────────────────────────────────────────────┘  │
│  D     │                                                        │
│  E     │  ┌──────────────────────────────────────────────────┐  │
│  B     │  │  Floating Chat (collapsible, always accessible)  │  │
│  A     │  └──────────────────────────────────────────────────┘  │
│  R     │                                                        │
├────────┴────────────────────────────────────────────────────────┤
│  Status Bar: branch, sync status, active tasks count            │
└─────────────────────────────────────────────────────────────────┘
```

---

## 1. Unified Sidebar

The sidebar is the primary navigation. It shows project context at the top and a task-centric view below.

### Layout

```
┌──────────────────────────┐
│  Project Name            │
│  /path/to/project    [×] │
│  ● main  ↑2  (git status)│
├──────────────────────────┤
│                          │
│  TASKS                   │
│  ┌────────────────────┐  │
│  │ + New Task...      │  │ ← Natural language input
│  └────────────────────┘  │
│                          │
│  ▸ Defining        (2)   │ ← Expandable sections
│  ▸ Planning        (1)   │
│  ▾ Executing       (3)   │
│    ● Fix auth bug   ◉    │ ← ◉ = running indicator
│    ● Add dark mode  ◉    │
│    ● Update deps    ◉    │
│  ▸ Review          (1)   │
│  ▸ Done            (5)   │
│                          │
├──────────────────────────┤
│  WORKSPACE               │
│  ◇ Git                   │ ← Changes/History/Branches
│  ◇ Analysis              │ ← Insights + Roadmap + Ideation merged
│  ◇ Changelog             │ ← Auto-generated from tasks
│                          │
├──────────────────────────┤
│  PLUGINS                 │
│  ◇ GitHub Issues         │ ← From installed plugins
│  ◇ ...                   │
│                          │
├──────────────────────────┤
│  Close project           │
└──────────────────────────┘
```

### Key Changes from Current Sidebar

| Current | New | Rationale |
|---------|-----|-----------|
| Kanban Board | **Removed** — task board is the default main content | Kanban was a separate view; now it IS the workspace |
| Changes | **Git** — lives under WORKSPACE section | Grouped with workspace tools, not a primary nav item |
| Insights | **Analysis** — merged with Roadmap + Ideation | Three separate views with overlapping purpose → one |
| Roadmap | Merged into **Analysis** | Sub-tab within Analysis |
| Ideation | Merged into **Analysis** | Sub-tab within Analysis |
| Context | **Removed** — context is per-task, lives in task thread | Global context was confusing; task-level context is clearer |
| Worktrees | **Removed from sidebar** — auto-managed per task | Power users can see worktrees in Git view if needed |
| Prompt | **Removed** — replaced by task input + floating chat | No separate prompt; everything is task-driven or chat |
| Plugins | Stays, but under its own section | Cleaner grouping |

### Sidebar Behaviors

- **Task sections are expandable/collapsible** with task count badges
- **Clicking a task** opens the Task Thread in the main content area
- **The "+ New Task" input** is always visible — type and press Enter to create
- **Project header** shows branch name + ahead/behind + sync button inline
- **Git/Analysis/Changelog** open their respective views in the main content

---

## 2. Task Lifecycle

### States

```
DEFINING → PLANNING → EXECUTING → REVIEW → DONE
                ↑          |
                └──────────┘  (AI re-plans if execution hits a wall)
```

### 2.1 Defining (Human)

**How it starts**: User types in the "+ New Task" input or opens a detailed creation view.

**Natural language input**: "Fix the authentication bug where sessions expire after 5 minutes instead of 30"

**What the system does**:
1. Creates a task entry with status `defining`
2. Opens the Task Thread view
3. AI asks clarifying questions if needed (acceptance criteria, scope, constraints)
4. Once the user confirms, task moves to `planning`

**What the user sees**: A chat-like interface where they describe what they want. The AI may ask 1-2 clarifying questions. This should take under 60 seconds.

### 2.2 Planning (AI + Human)

**What happens**:
1. AI analyzes the codebase (reads files, understands architecture)
2. AI generates a structured plan:
   - **Approach**: What strategy to take
   - **Files to modify**: Which files will be created/changed/deleted
   - **Steps**: Ordered list of implementation steps
   - **Tests**: What tests to write/run
   - **Risks**: What could go wrong
3. Plan is presented to the user in the Task Thread
4. User can:
   - **Approve** → moves to `executing`
   - **Edit** → modify the plan, then approve
   - **Reject** → back to `defining` with feedback

**What the user sees**: The plan rendered as a structured document inside the task thread, with approve/edit/reject buttons.

### 2.3 Executing (AI, Autonomous)

**What happens**:
1. System creates a worktree: `.worktrees/<task-id>-<slug>/`
2. System creates a branch: `task/<task-id>-<slug>`
3. AI executes the plan step by step in the worktree:
   - Full terminal access (install deps, run builds, execute tests)
   - File creation, editing, deletion
   - Can run dev servers, curl endpoints, etc.
4. Every action is logged in the execution thread:
   - Commands run + output
   - Files changed (with diffs)
   - AI reasoning ("I'm doing X because Y")
   - Test results
5. AI self-validates:
   - Runs tests after implementation
   - Runs linter/type-checker
   - Verifies acceptance criteria from the plan
6. If AI hits a blocking issue:
   - Task moves to `needs-input` (sub-state of executing)
   - User gets notified, can answer in the task thread
   - Execution resumes after user responds

**Completion**: When all plan steps are done and validation passes, task moves to `review`.

**What the user sees in the task thread during execution**:
- Live streaming of AI actions (like a terminal log)
- Progress indicator (step 3 of 7)
- Ability to scroll through past actions
- A "pause" button to halt execution if something looks wrong

### 2.4 Review (Human)

**What the user sees**:
1. **Summary**: What was done, what changed
2. **Diff view**: Full diff of all changes (reuses our DiffView component)
3. **Changed files list**: Click to see per-file diffs
4. **Test results**: Pass/fail summary
5. **Execution log**: Collapsible full log of everything the AI did
6. **Actions**:
   - **Approve** → moves to `done`, branch ready to merge
   - **Request changes** → back to `executing` with feedback, AI revises
   - **Reject** → task closed, worktree cleaned up

### 2.5 Done

- Task is marked complete
- Branch is ready for manual merge (user decides when)
- Worktree remains until merged, then auto-cleaned
- Summary gets added to changelog
- User can archive the task via an **Archive** button
- Tasks auto-archive after **14 days** in the done state

---

## 3. Task Thread (The Core UI)

When you click a task, the main content area shows the Task Thread. This is the single most important view in the app.

### Layout

```
┌─────────────────────────────────────────────────────────────┐
│  Task: Fix authentication session expiry          [Status]  │
│  Branch: task/fix-auth-expiry  •  Worktree: active          │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌─ Plan ──────────────────────────────────────────────┐    │
│  │ Approach: Modify session middleware timeout...      │    │
│  │ Files: src/auth/session.ts, src/config/defaults.ts  │    │
│  │ Steps: 1. Update timeout constant  2. Add test...   │    │
│  │ [Approved ✓]                                        │    │
│  └─────────────────────────────────────────────────────┘    │
│                                                             │
│  ┌─ Execution Log ────────────────────────────────────┐    │
│  │ Step 1/4: Updating session timeout constant         │    │
│  │ > Editing src/auth/session.ts                       │    │
│  │   Changed SESSION_TIMEOUT from 300 to 1800          │    │
│  │ ✓ File saved                                        │    │
│  │                                                     │    │
│  │ Step 2/4: Adding configuration option               │    │
│  │ > Editing src/config/defaults.ts                    │    │
│  │ ...                                                 │    │
│  │                                                     │    │
│  │ Step 3/4: Writing tests                             │    │
│  │ > Creating src/auth/__tests__/session.test.ts       │    │
│  │ > Running: npm test -- --filter session             │    │
│  │   ✓ 3 tests passed                                 │    │
│  │                                                     │    │
│  │ Step 4/4: Validation                                │    │
│  │ > Running: npm run type-check                       │    │
│  │   ✓ No errors                                      │    │
│  │ > Running: npm run lint                             │    │
│  │   ✓ No warnings                                    │    │
│  └─────────────────────────────────────────────────────┘    │
│                                                             │
│  ┌─ Review (when in review state) ────────────────────┐    │
│  │ 3 files changed  +45 -12                            │    │
│  │ [src/auth/session.ts] [src/config/defaults.ts] ...  │    │
│  │ [Diff viewer here]                                  │    │
│  │                                                     │    │
│  │ [Approve]  [Request Changes]  [Reject]              │    │
│  └─────────────────────────────────────────────────────┘    │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐    │
│  │ Type a message to the AI about this task...    [Send]│    │ ← Task-level chat
│  └─────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
```

---

## 4. Parallel Execution

### How It Works

- Each task gets its own worktree + branch (completely isolated filesystem)
- Each task gets its own AI execution thread (separate conversation context)
- Tasks run truly in parallel — no queue, no waiting
- The sidebar shows which tasks are actively executing with a running indicator

### Resource Management

- **Max parallel tasks**: Configurable (default 3) to prevent overwhelming the machine
- **If at max**: New tasks entering `executing` wait in a "queued" sub-state
- **Each worktree**: Independent PTY sessions for terminal access
- **AI context**: Each task thread maintains its own conversation history

### Conflict Detection

- Before execution starts, AI checks if the task's target files overlap with any running task
- If overlap detected: warn the user, suggest sequencing, but allow parallel if user confirms
- At merge time: standard git merge conflict resolution (AI can assist)

---

## 5. Floating Chat

A persistent, collapsible chat panel for project-level questions that aren't tasks.

### Behavior

- **Always accessible** via a button in the bottom-right or a keyboard shortcut
- **Full-height right sidebar** that can be shown/hidden (similar to Copilot Chat in VS Code)
- **Hidden by default** — toggled via button or keyboard shortcut
- **When shown**: Takes up ~350-400px on the right side, pushes content left
- **Context-aware**: The AI knows the current project, can read files, answer questions
- **Not a task**: Conversations here don't create worktrees or modify files
- **Can spawn tasks**: "This looks like a bug, want me to create a task for it?" → one-click task creation

### What It's For

- "How does the auth system work?"
- "What's the test coverage for this module?"
- "Explain this error message"
- "What changed in the last 5 commits?"

---

## 6. Analysis View (Merged Insights + Roadmap + Ideation)

### Auto-fire on Project Load

When a project is loaded for the first time (or after significant changes), AI runs background analysis:
- Code quality scan
- Security audit
- Performance hotspots
- Missing test coverage
- Documentation gaps

Results are **passively surfaced** — a badge on the Analysis sidebar item, not a popup.

### Sub-tabs Within Analysis

| Tab | Content |
|-----|---------|
| **Insights** | AI-generated findings, clickable to create tasks |
| **Roadmap** | AI-suggested improvement plan, phased |
| **Ideas** | Lower-priority suggestions, brainstorming |

### Key Feature: Insight → Task Pipeline

Each insight/suggestion has a "Create Task" button that pre-fills the task definition with the AI's analysis.

---

## 7. Git View

The Git features we just built, housed under the WORKSPACE section:

- **Changes tab**: Staged/unstaged files, diff, commit form (as built)
- **History tab**: Commit log with diffs (as built)
- **Branches**: Branch switcher in the toolbar (as built)
- **Worktrees**: Shows all active worktrees (most auto-created by tasks)
- **Quick actions**: Open in VS Code, Show in Finder, View on GitHub (as built)

### Enhancement: Task-Aware Git View

The Changes view should show which worktree/task is active. If a task's worktree has changes, they appear here. The user can switch between worktrees to see changes from different tasks.

---

## 8. Changelog (Auto-Generated)

### How It Works

- When a task reaches `done`, its summary is auto-appended to a draft changelog entry
- Entries are grouped by type (added, changed, fixed, removed) — derived from the task description
- The user can edit entries, reorder, add context
- When ready, the user "cuts a release" which finalizes the changelog entry with a version number

### Format

```markdown
## [Unreleased]

### Added
- Dark mode support for all workspace panels (Task #12)
- Email notification settings page (Task #15)

### Fixed
- Authentication session expiry was 5min instead of 30min (Task #8)

### Changed
- Upgraded React from 18 to 19 (Task #11)
```

---

## 9. Plugin Architecture (Separate Repo)

### In Kai (this repo)

- Plugin loader, sandbox, lifecycle management
- Plugin API surface (hooks, tool registration, UI slots)
- Built-in plugin: GitHub integration (as proof of concept)

### In kai-plugin-sdk (new repo)

- TypeScript types for the plugin API
- `create-kai-plugin` CLI scaffold
- Example plugins
- Documentation
- Plugin testing utilities

### Plugin Capabilities

```typescript
interface KaiPlugin {
  id: string;
  name: string;
  version: string;

  // Lifecycle hooks
  onProjectLoad?(project: Project): void;
  onTaskCreate?(task: Task): void;
  onTaskPlanApproved?(task: Task, plan: Plan): void;
  onTaskExecutionStart?(task: Task): void;
  onTaskReview?(task: Task): void;
  onTaskDone?(task: Task): void;

  // Tool registration (AI can use these during execution)
  tools?: ToolDefinition[];

  // UI extensions
  sidebarItems?: SidebarItem[];
  reviewChecks?: ReviewCheck[];
  settingsPanel?: SettingsPanel;
}
```

---

## 10. Data Model Changes

### Task (Enhanced)

```typescript
interface WorkspaceTask {
  id: string;
  title: string;
  description: string;              // Natural language from user
  status: 'defining' | 'planning' | 'queued' | 'executing' | 'needs_input' | 'review' | 'done' | 'rejected';
  priority: TaskPriority;
  labels: string[];

  // Planning
  plan?: TaskPlan;                   // AI-generated plan
  planApprovedAt?: number;

  // Execution
  worktreePath?: string;
  worktreeBranch?: string;
  executionThread: ExecutionEntry[]; // Full log of AI actions
  executionStartedAt?: number;
  executionCompletedAt?: number;

  // Review
  reviewComments?: ReviewComment[];
  reviewResult?: 'approved' | 'changes_requested' | 'rejected';

  // Metadata
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  linkedInsightId?: string;          // If created from an insight
  linkedChangelogEntry?: string;     // Auto-generated changelog text
}

interface TaskPlan {
  approach: string;
  steps: PlanStep[];
  filesToModify: string[];
  testsToRun: string[];
  risks: string[];
  estimatedSteps: number;
}

interface ExecutionEntry {
  type: 'command' | 'file_edit' | 'file_create' | 'file_delete' | 'reasoning' | 'test_result' | 'error' | 'user_input';
  timestamp: number;
  content: string;
  metadata?: Record<string, unknown>; // command output, diff, etc.
}
```

---

## 11. Implementation Phases

### Phase 1: Foundation (Week 1-2)
- Redesign sidebar (unified layout, task sections)
- New task data model + persistence
- Task creation (natural language input)
- Task thread view (basic — shows status, description, plan)
- Remove/merge deprecated views (Context, separate Prompt)

### Phase 2: AI Planning (Week 2-3)
- AI plan generation from task description
- Plan review UI (approve/edit/reject)
- Clarifying question flow in defining stage

### Phase 3: Autonomous Execution (Week 3-5)
- Auto worktree creation per task
- Execution engine (AI runs plan steps, full terminal access)
- Execution thread streaming (live log in task thread UI)
- Parallel execution support (configurable max)
- Pause/resume, needs-input state

### Phase 4: Review & Merge (Week 5-6)
- Review view with diff, changed files, test results
- Approve/request changes/reject flow
- Manual merge workflow (branch is ready, user decides when)
- Worktree cleanup after merge

### Phase 5: Polish (Week 6-7)
- Floating chat panel
- Analysis view (merged insights/roadmap/ideation)
- Auto-fire analysis on project load
- Changelog auto-generation from completed tasks
- Git view enhancements (task-aware changes)

### Phase 6: Plugin SDK (Separate track)
- Extract plugin API types to kai-plugin-sdk repo
- CLI scaffold tool
- Example plugins
- Documentation

---

## 12. Verification Criteria

For each phase, we verify:

1. **Type-check**: `pnpm type-check` passes
2. **Lint**: `pnpm lint` has no errors
3. **Visual**: UI matches design intent (screenshot review)
4. **Functional**: Core workflows work end-to-end
5. **Data persistence**: Tasks survive app restart
6. **Isolation**: Parallel tasks don't interfere with each other
7. **Error handling**: Failures are surfaced clearly, not swallowed
