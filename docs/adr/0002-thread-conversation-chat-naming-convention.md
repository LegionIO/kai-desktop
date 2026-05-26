# ADR 0002: Thread / Conversation / Chat Naming Convention

- **Status**: Accepted
- **Date**: 2026-05-26
- **Deciders**: maintainers

## Context

The Kai codebase has three candidate terms in active use — **Thread**,
**Conversation**, and **Chat** — and each is load-bearing in a different
layer. Without a written convention, contributors face a recurring decision:
when naming a new identifier, field, or IPC channel, which term applies?

Four forcing functions constrain the answer:

1. **Mastra's runtime scope check.** The `memory.workingMemory.scope` and
   `memory.observationalMemory.scope` config fields are passed to Mastra's
   memory subsystem, which performs a literal `scope === "thread"` check at
   runtime. Renaming the value to anything else (e.g. `"chat"`) silently
   breaks memory scoping without a typecheck failure.
2. **On-disk + wire-protocol stability.** Conversation state persists to
   `~/.kai/data/` as JSON shaped by `electron/ipc/conversations.ts`. Field
   names in this format are a wire-protocol concern: renaming
   `activeConversationId` to `activeChatId` would invalidate every user's
   stored config and would require a migration step (none exists today).
3. **`@assistant-ui/react` `ThreadPrimitive` API.** The renderer composes
   against `ThreadPrimitive` + `useThreadRuntime` from the
   `@assistant-ui/react` package; plugin extensions hook the same surface
   via `PluginThreadDecorationDescriptor`. Aligning these contracts with the
   underlying library vocabulary keeps `npm` upgrades cheap.
4. **UI vocabulary convergence.** End-user-facing labels (sidebar, modal
   titles, support requests) consistently say "chat" — this is the industry
   vocabulary users expect.

A prior pull request ([#13](https://github.com/LegionIO/kai-desktop/pull/13))
articulated the layered model and documented it. Its directory-rename
component (`thread/ → chat/`, `conversations/ → chat-list/`) was implicitly
rejected by main's converging on file-level naming inside the existing
directories instead. The architectural model survived; this ADR codifies it.

## Decision

Each layer of the codebase uses the term that matches its forcing function:

| Layer                                          | Term             | Why                                                                       |
| ---------------------------------------------- | ---------------- | ------------------------------------------------------------------------- |
| User-facing UI (labels, modals, page titles)   | **Chat**         | Industry vocabulary; what users say in support requests                   |
| Renderer state (active IDs, refs)              | **Conversation** | IDs reference storage entities; same wire-format stability as IPC/storage |
| Sub-agent state + types                        | **Thread**       | Nested assistant-ui threads composed within a conversation                |
| Plugin extension API                           | **Thread**       | Aligns with `@assistant-ui/react` `ThreadPrimitive` API contract          |
| Mastra / agent internals                       | **Thread**       | Mastra's runtime `scope === "thread"` check                               |
| IPC channels, parameter names, on-disk storage | **Conversation** | Wire protocol + on-disk format stability (`conversations.json`)           |

### Concrete examples

- `electron/config/schema.ts`: `scope: z.enum(['thread', 'resource'])` —
  Thread layer (Mastra runtime contract)
- `electron/ipc/conversations.ts`: `activeConversationId: string | null` —
  Conversation layer (wire format)
- `src/providers/RuntimeProvider.tsx`: `const [activeConversationId, ...]` —
  Conversation layer (state references storage entity)
- `src/components/thread/SubAgentThread.tsx` — Thread layer (assistant-ui
  composition primitive)
- `src/components/thread/ChatSettingsButton.tsx` — Chat layer (UI leaf)
  inside a Thread-layer directory (assistant-ui boundary)
- `electron/plugins/types.ts`: `PluginThreadDecorationDescriptor` — Thread
  layer (assistant-ui extension API)
- IPC channels: `conversations:list`, `conversations:get`, `agent:stream`
  (parameter `conversationId`) — Conversation layer
- IPC channel: `computer-use:focus-thread` — Thread layer (routes to the
  assistant-ui thread surface)

### Directory naming

Directory names match their **integration boundary**, not the user-facing
vocabulary at the leaves. `src/components/thread/` is named for the
`@assistant-ui/react` `ThreadPrimitive` it composes around; the files
inside follow the layer rules above, so leaves like `ChatSettingsButton.tsx`
and `SubAgentThread.tsx` coexist in the same directory and that is correct.

The same applies to `src/components/conversations/`: the directory is the
storage-domain grouping, and the files inside use UI vocabulary at the
leaves (`ChatsListPage.tsx`, `RenameChatModal.tsx`).

## Considered Alternatives

### Unify on "Chat" everywhere

Rejected. Breaks Mastra's runtime `scope === "thread"` check (silent
runtime failure with no typecheck signal). Misaligns with
`@assistant-ui/react`'s `ThreadPrimitive` API, which would force a fork or
a wrapper layer if we wanted to call it `ChatPrimitive` locally.

### Unify on "Thread" everywhere

Rejected. Confuses end users who say "chat" in support requests and
documentation. Requires renaming `conversations.json` and every IPC
channel that currently uses the `conversations:` prefix — substantial
migration cost with no offsetting benefit, since the wire-format layer
has no library forcing function pulling it toward "Thread".

### Unify on "Conversation" everywhere

Rejected. Conflicts with `@assistant-ui/react`'s `Thread*` vocabulary —
there is no `ConversationPrimitive`. Not what users say.

### No documented convention (status quo before this ADR)

Rejected. Visible drift in the tree already: `src/components/conversations/`
contains `ChatsListPage.tsx`, `ConversationList.tsx`, `RenameChatModal.tsx`,
and `ThreadSettingsModal.tsx` simultaneously. Each PR locally honors the
convention but the file system surface tells new contributors that the
naming is arbitrary, which produces a slow drift toward inconsistency.

## Consequences

### Positive

- **Forcing functions are stated.** A contributor proposing a rename can
  read the ADR, see which layer they're crossing, and know which contract
  would break. Future bulk-rename proposals hit this section first.
- **The codebase is auditable.** Each term has a verifiable home (file
  plus line for the canonical examples above). A `grep` audit can flag
  layer violations against a known reference.
- **Library upgrades stay cheap.** Mastra and `@assistant-ui/react`
  vocabulary alignment means library renames (if they ever happen)
  propagate cleanly rather than fighting our local terminology.

### Negative

- **Mixed dialect inside directories.** Following the layer rules means
  `src/components/thread/ChatSettingsButton.tsx` looks inconsistent at
  first glance. The integration-boundary explanation in the Decision
  section above is necessary context.
- **High switching cost.** Any future decision to change the convention
  (for example if Mastra changes its scope enum in a breaking release)
  requires touching multiple layers atomically.

### Mitigation

- The pointer in `CLAUDE.md` ("Naming Convention" section) and the
  `### Naming Convention` subsection in `CONTRIBUTING.md` route both
  agents and human contributors to this ADR at the moment of need.
- A future cleanup PR could rename `src/components/conversations/` to
  better reflect its storage-domain grouping, or split it into
  storage-domain vs UI-page directories. That is a deliberate change,
  not arbitrary, and would land as a follow-up to this ADR rather than
  preceding it.

## References

- [`electron/config/schema.ts`](../../electron/config/schema.ts) — Mastra
  scope enum (`scope: z.enum(['thread', 'resource'])`)
- [`electron/ipc/conversations.ts`](../../electron/ipc/conversations.ts) —
  Conversation store + IPC channel definitions
- [`src/providers/RuntimeProvider.tsx`](../../src/providers/RuntimeProvider.tsx) —
  Renderer state shape (`activeConversationId`)
- [`electron/plugins/types.ts`](../../electron/plugins/types.ts) — Plugin
  extension API (`PluginThreadDecorationDescriptor`)
- [`src/components/thread/Thread.tsx`](../../src/components/thread/Thread.tsx) —
  Canonical `ThreadPrimitive` consumer (`useThreadRuntime`,
  `ThreadPrimitive.Root`, `ThreadPrimitive.Viewport`, `ThreadPrimitive.Messages`)
- [PR #13](https://github.com/LegionIO/kai-desktop/pull/13) — Original
  analysis articulating the layered model
- [`@assistant-ui/react` package](https://www.npmjs.com/package/@assistant-ui/react)
- [Mastra Memory documentation](https://mastra.ai/en/docs/memory/overview)
