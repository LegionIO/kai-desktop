# Fix: ask_user answers lost when the turn's controller aborts mid-loop

## Root cause (confirmed by code trace)

The screenshot is `AskUserErrorView` (ToolGroup.tsx:611) rendering the ask_user tool's
`{ error: 'No user response received' }` result — a string that comes from exactly one
place: `electron/tools/ask-user.ts:109` (the Mastra runtime path).

Two structural defects combine:

1. **The pending-approval entry is deleted on any abort.** The ask*user gate
   (`electron/ipc/agent.ts:4219-4242`) awaits `registerPendingApproval(streamId, controller.signal)`.
   That controller is the \_current turn's*. Anything that aborts it while the question is
   pending — plan-mode restart (4201/4213/4523), cancel-stream (5728), or a duplicate-id
   fail-closed eviction (`tool-approval.ts:47-51`) — fires the abort listener → `settle('dismiss')`
   → **deletes the `pendingToolApprovals` entry.**

2. **A late/racing answer is silently dropped, and the tool runs anyway with the wrong error.**
   - `agent:answer-tool-question` (`agent.ts:5900-5911`) guards on `if (pending)`. Once the entry
     is gone, `stashQuestionAnswers` never runs → the user's answers vanish.
   - The gate sees `approved !== true`, calls `state.cancel()` (4233). But `state.cancel()` only
     aborts a _local_ signal (`mastra-agent.ts:302`); it does NOT set `skip`, so Mastra still calls
     `tool.execute` (`mastra-agent.ts:341`). With no answers stashed under the exec id, `execute`
     returns `{ error: 'No user response received' }` — a GUI turn, so no headless alert fallback.

Net: even though the user answered on the focused GUI, the answer landed in the window where the
turn's controller had already aborted → answer dropped → tool emits the misleading "timed out /
canceled"-looking error.

The diagnostic trace (`diagnostic-trace.jsonl`) records `tool.stream-event` / `tool.apply-*` but
NOTHING about the approval/answer lifecycle, which is why the logs couldn't explain it.

## Fixes

### 1. Instrumentation FIRST (so the next occurrence is self-explaining)

Add `scope:'agent'` diagnostic-trace events (via `traceDiagnostic`) for the full ask_user /
approval lifecycle, keyed by `toolCallId`/`conversationId`:

- `approval.awaiting` — when the gate registers + broadcasts (record streamId, execId, toolName).
- `approval.settled` — with a **reason**: `answered` | `dismiss` | `reject` | `abort` |
  `duplicate-evict`. Emitted from `registerPendingApproval`'s `settle` and the IPC handlers.
- `question.answer-received` — in `agent:answer-tool-question`, recording whether a live pending
  entry existed (`hadPending: true/false`) — the exact signal that was missing this time.
- `question.answers-missing-at-execute` — in `ask-user.ts` when execute finds no answers, recording
  headless/conversationId so the fallback branch taken is visible.
- `approval.settle-reason` needs plumbing: `registerPendingApproval` will accept an optional
  `onSettle?: (reason) => void` or we thread a reason through the resolver. Simplest: have the IPC
  handlers + abort each pass a reason to a small wrapper. Chosen approach: add an optional
  `label`/`traceCtx` param to `registerPendingApproval` and emit inside `settle` with the terminal
  reason derived from the resolved value + an `aborted` flag.

### 2. The actual bug — don't lose an answer that raced an abort

Close the race in `agent:answer-tool-question` (`agent.ts:5900`):

- Currently: stash ONLY `if (pending)`. Change to **always `stashQuestionAnswers(toolCallId, answers)`**
  first (the FIFO cap already bounds any orphan — that's its documented purpose), THEN resolve the
  pending approval if one is still live. This guarantees the answer is retrievable by the tool's
  `execute` even if the approval promise already settled via abort a beat earlier.
- Because the gate copies `pendingQuestionAnswers[streamId] → [execId]` only on the `approved===true`
  branch, also make the tool's `execute` fall back to the **streamId-keyed** answers. Cleanest:
  keep the copy, but ALSO have execute try both ids. Since execute only knows `context.toolCallId`
  (the exec id), the copy is the right seam — so on the answer path we stash under the streamId
  (what the renderer sends) AND the gate still copies. The new guarantee: stash happens
  unconditionally, so the copy at 4236 finds it even if `approved` resolved by a near-simultaneous
  abort that we then re-evaluate.

  Subtlety: if the abort truly won (turn is genuinely gone/superseded), we must NOT resurrect a
  dead turn. So: unconditional stash (cheap, bounded, harmless), but only `pending.resolve(true)`
  when a live entry exists. If no live entry, the answer sits in the bounded map; when the turn
  restarts (plan-mode restart / inject continuation), the re-invoked ask_user execute consumes it.

### 3. Honor a REAL dismiss cleanly (no misleading error)

In the ask_user gate (`agent.ts:4219`), when `approved !== true`, return a proper
**`{ skip: true, result }`** from `onToolExecutionStart` (mirroring the PreToolUse-deny path at
4087/4109) so `tool.execute` does NOT run and emit "No user response received". The skip result
should be an explicit, model-legible cancel:
`{ isError: true, error: 'The question was dismissed/cancelled before it was answered.' }`
— distinct from the timed-out-looking default, and matching the Claude runtime's
"User dismissed the question." semantics.

To thread `skip` out, the ask_user branch must be able to `return` from `onToolExecutionStart`.
The block currently doesn't return a value; refactor so the ask_user (and exit_plan_mode) branches
can return the skip descriptor. exit_plan_mode already `controller.abort(); return {conversationId}`
at the stream level, so its handling stays; only ask_user needs the skip-result return.

Distinguish abort-vs-genuine-dismiss so #2 and #3 don't fight:

- `approved === 'dismiss'` AND `controller.signal.aborted` → **abort/supersession**: answer may be
  in-flight; skip with a neutral "cancelled" result. The unconditionally-stashed answer (from #2)
  survives for a restart. Do NOT emit the scary error.
- `approved === false` → genuine reject → skip with a clear dismissed result.
- `approved === 'dismiss'` AND NOT aborted → user closed the card → skip with dismissed result.

### 4. ask-user.ts execute — softer error + trace

When execute finds no answers in the non-headless, non-restart case, keep returning an error but
make it match reality ("no response recorded — the question may have been cancelled") and emit the
`question.answers-missing-at-execute` trace. (Kept minimal; the primary defense is #2/#3 upstream.)

## Files touched

- `electron/ipc/tool-approval.ts` — thread a settle-reason + trace hook into `registerPendingApproval`.
- `electron/ipc/agent.ts` — ask_user gate returns skip-on-dismiss; `answer-tool-question`
  unconditional stash + trace; awaiting/settle traces.
- `electron/tools/ask-user.ts` — trace on missing-answers; reworded interactive error.
- Tests:
  - `electron/tools/__tests__/ask-user.test.ts` — update the reworded-error expectations.
  - `electron/ipc/__tests__/` — new test for `answer-tool-question` unconditional stash (answer
    lands even with no live pending entry) and for the skip-on-dismiss gate result. (Add a focused
    unit test around the pure pieces; the gate is inside a large closure, so test the extractable
    decision — factor a small pure `resolveAskUserGateOutcome(approved, aborted)` helper.)

## Verification

- `pnpm test` (targeted files first, then full), `pnpm type-check`, `pnpm lint`.
- Manual reasoning walk-through of the three settle reasons.

## Notes / constraints

- Sensitive mid-turn/supersession path. No behavior change for the happy path (answer while live).
- The unconditional stash is bounded by the existing FIFO cap (MAX_PENDING_QUESTION_ANSWERS=100),
  which was built for exactly this orphan case — so no new leak.
- Do NOT resurrect a genuinely superseded turn; only make a raced answer _recoverable_, not
  _forcibly re-run_.
