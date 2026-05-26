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

1. **Mastra's scope literal contract.** Three config fields —
   `memory.workingMemory.scope`, `memory.observationalMemory.scope`, and
   `memory.semanticRecall.scope` (`electron/config/schema.ts` lines 84, 89, 95) — are passed through to Mastra's memory subsystem and must be one
   of the documented scope literals (`"thread"` or `"resource"`). The
   Zod enum at config-parse time prevents arbitrary renames inside the
   stored config from reaching Mastra at all; the harder-to-catch failure
   mode is a schema-side rename (e.g. flipping the enum from
   `['thread', 'resource']` to `['chat', 'resource']`) which passes
   typecheck locally but breaks the wire contract with Mastra.
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

### Current drift

Without a written convention, files using all three vocabularies coexist
in single directories. `src/components/conversations/` contains
`ChatsListPage.tsx`, `ConversationList.tsx`, `RenameChatModal.tsx`,
`ThreadSettingsModal.tsx`, and `SubAgentSidebarSection.tsx` — four
naming families in one directory. Each individual file is named
correctly _under the layered model_, but a reader scanning the directory
sees an inconsistent surface that suggests the naming is arbitrary. This
ADR documents the rule those files were authored against so future
contributions stay aligned and the surface stops looking arbitrary.

## Decision

Each layer of the codebase uses the term that matches its forcing function:

| Layer                                          | Term             | Why                                                                                                                                                                                                                                               |
| ---------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| User-facing UI (labels, modals, page titles)   | **Chat**         | Industry vocabulary; what users say in support requests                                                                                                                                                                                           |
| Renderer state (active IDs, refs)              | **Conversation** | IDs reference storage entities; same wire-format stability as IPC/storage                                                                                                                                                                         |
| Sub-agent state + types                        | **Thread**       | Nested assistant-ui threads composed within a conversation                                                                                                                                                                                        |
| Plugin extension API                           | **Both**         | `PluginThreadDecorationDescriptor` aligns with `@assistant-ui/react` `ThreadPrimitive`; `PluginConversationDecorationDescriptor` exists for storage-entity-level decorations. Each decoration type uses the layer that matches what it decorates. |
| Mastra / agent internals                       | **Thread**       | Mastra's runtime `scope === "thread"` check                                                                                                                                                                                                       |
| IPC channels, parameter names, on-disk storage | **Conversation** | Wire protocol + on-disk format stability (`conversations.json`)                                                                                                                                                                                   |

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

### Container layer vs. prop / parameter layer

The layer a container belongs to does not constrain the names of its
props or parameters. Props and parameters follow the layer of the
_entity they identify_, regardless of the container's layer:

- `agent:stream(conversationId, ...)` — `agent:` channel namespace (the
  runtime domain) takes a `conversationId` parameter (the storage
  entity being streamed).
- `SubAgentThread` component — Thread-layer name (assistant-ui
  composition) with a `subAgentConversationId` prop (the conversation
  the sub-agent is nested inside).
- `memory.getThreadById({ threadId: conversationId })` — at the IPC ↔
  Mastra boundary, the same string identifier crosses layers and is
  re-shaped to match each side's contract.

Channel namespace and parameter naming are independent decisions.
Channel prefixes follow the _domain being routed to_ (`conversations:*`
for storage operations, `agent:*` for runtime operations,
`computer-use:*` for the computer-use surface); parameter names follow
the entity they identify.

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

### Rename directories now and absorb the migration debt

Rejected. This was iamhollow's original proposal in #13: rename
`src/components/thread/ → src/components/chat/` and
`src/components/conversations/ → src/components/chat-list/`. The
architectural argument against: directory names express the
_integration boundary_ (the `@assistant-ui/react` composition surface,
the storage domain), while file names express what the file is.
Renaming the directories erases the integration-boundary signal in
favor of UI vocabulary, telling future readers "these are just chat
UI files" when they are actually "the assistant-ui thread surface that
_renders as_ chat" and "the conversation storage domain that _renders
as_ a chat list." Renaming is technically possible — and the migration
cost is real — but it would lose information rather than add it. The
file-level Chat naming inside the existing directories is the better
tradeoff.

### Stop using `@assistant-ui/react`

Rejected. Forcing function #3 (`ThreadPrimitive` API) only applies
because we depend on the library. Today there are three import sites
(`src/providers/RuntimeProvider.tsx`, `src/components/thread/Thread.tsx`,
`src/components/thread/ComposerInput.tsx`), so the surface looks small.
But the library provides the streaming, branching, and tool-call
rendering primitives the chat surface depends on, and its message
format aligns with the AI SDK format Mastra emits. Replacing it would
require re-implementing message streaming, branch navigation, and
tool-call lifecycle — substantially more code than the three import
sites suggest. The library is actively maintained. Forking or replacing
is technically possible but not architecturally cheap; this ADR
assumes the dependency stays.

## Consequences

### Positive

- **Forcing functions are stated.** A contributor proposing a rename can
  read the ADR, see which layer they're crossing, and know which contract
  would break. Future bulk-rename proposals hit this section first.
- **The codebase is auditable in principle.** Each term has a verifiable
  home in the Worked examples above. A `grep` audit _could be written_
  to flag layer violations against the canonical references, but no
  such audit script exists today; this is currently a documentation-only
  convention.
- **Library upgrades stay cheap.** Mastra and `@assistant-ui/react`
  vocabulary alignment means library renames (if they ever happen)
  propagate cleanly rather than fighting our local terminology.

### Negative

- **Mixed dialect inside directories.** Following the layer rules means
  `src/components/thread/ChatSettingsButton.tsx` looks inconsistent at
  first glance. The integration-boundary explanation in the Decision
  section above is necessary context.
- **Cognitive overhead at boundary crossings.** Code at the IPC ↔ Mastra
  boundary reads `memory.getThreadById({ threadId: conversationId })` —
  the same string identifier carries two names depending on which side
  of the boundary you're reading. Correct per the layering, but the
  first encounter is non-obvious. Expect to see `{ threadId: ... }`
  shapes when calling into Mastra from IPC handlers.
- **Renderer-internal events and state types form a fifth implicit
  category.** Types like `threadMode: 'chat' | 'computer'` and DOM events
  like `thread-settings-changed` mix Thread-layer names with Chat-layer
  values. These do not fit cleanly into any single row of the layer
  table — the pragmatic rule is that renderer state names follow
  whichever layer the event or state is bridging at that moment.
- **OSS-contributor learning cost.** A first-time external contributor
  will encounter `src/components/conversations/ThreadSettingsModal.tsx`
  — a single file path with three vocabulary terms in it — and need to
  read this ADR to interpret it. Internal contributors can ask in chat;
  OSS contributors cannot. The Mitigation pointers exist to shorten
  this curve.
- **High switching cost.** Any future decision to change the convention
  (for example if Mastra changes its scope enum in a breaking release)
  requires touching multiple layers atomically.
- **Documentation-only enforcement.** There is no lint rule, no CI gate,
  and no runtime check that asserts the convention is preserved across
  PRs. Drift is possible. See Mitigation for the path to mechanizing
  enforcement; right now the convention relies on review attention.

### Mitigation

- The pointer in `CLAUDE.md` ("Naming Convention" section) and the
  `### Naming Convention` subsection in `CONTRIBUTING.md` route both
  agents and human contributors to this ADR at the moment of need.
- A follow-up could add a lightweight `scripts/check-naming.sh` (or an
  ESLint custom rule) that greps for the known drift patterns
  (`chatId` inside `electron/ipc/**`, `scope: 'chat'` anywhere, etc.)
  and wires it into `lint-staged`. That would convert the convention
  from documentation-only to a soft CI gate. The right long-term answer
  is branded ID types (`type ConversationId = string & { __brand: ... }`)
  but that is a larger change than this ADR.

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
