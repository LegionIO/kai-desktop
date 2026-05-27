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
   `memory.semanticRecall.scope` in `electron/config/schema.ts` — are
   passed through to Mastra's memory subsystem and must be one of the
   documented scope literals (`"thread"` or `"resource"`). The Zod enum
   at config-parse time prevents arbitrary renames inside the stored
   config from reaching Mastra at all; the harder-to-catch failure mode
   is a schema-side rename (e.g. flipping the enum from
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

### Worked examples

These examples ground the Decision table above; each one points to a
real symbol on `main`. Directory paths shown are the pre-rename layout;
once the rename in §Directory naming lands, `thread/` becomes `chat/`
and `conversations/` becomes `chat-list/`. Symbol names follow contracts
and don't move.

- `electron/config/schema.ts`: `scope: z.enum(['thread', 'resource'])` —
  Thread layer (Mastra runtime contract)
- `electron/ipc/conversations.ts`: `activeConversationId: string | null` —
  Conversation layer (wire format)
- `src/providers/RuntimeProvider.tsx`: `const [activeConversationId, ...]` —
  Conversation layer (state references storage entity)
- `src/components/thread/SubAgentThread.tsx` — Thread layer
  (assistant-ui composition primitive). The **symbol** name `SubAgentThread`
  persists post-rename because it names the assistant-ui contract; only
  the parent directory renames.
- `electron/plugins/types.ts`: `PluginThreadDecorationDescriptor` — Thread
  layer (assistant-ui extension API)
- IPC channels: `conversations:list`, `conversations:get`, `agent:stream`
  (parameter `conversationId`) — Conversation layer
- IPC channel: `computer-use:focus-thread` — Thread layer (routes to the
  assistant-ui thread surface)

### Exception: IPC channels that route to a UI surface

The Decision table's "IPC channels → Conversation" row is the default,
not a total rule. IPC channels whose purpose is _routing to a specific
UI surface_ (rather than performing storage CRUD) take the layer of the
surface they route to. The current example is `computer-use:focus-thread`:
it routes to the assistant-ui thread surface, so it takes the Thread
layer. The exception exists because the channel's _purpose_ is surface
activation, not storage operations on a conversation entity.

### Directory naming

Name a `src/components/` directory for the **user-facing surface a user
would name in conversation**. Use a **boundary name** only when the
directory's primary export is a contract-shaped abstraction other
directories depend on — i.e. removing it would break unrelated features,
not just one user-facing surface.

An audit of the eleven directories under `src/components/` on `main`
finds: four directories cleanly support a boundary reading (`overlay/`,
`plugins/`, `thread/`, `ui/`), five are user-facing surface names
(`agents/`, `backgrounds/`, `settings/`, `sidebar/`, `tasks/`), and two
are dual-named (`conversations/`, `dictation/`). The dominant pattern
is user-facing-surface naming; boundary naming is the narrower case.

Applied to the dual-named directories:

- `src/components/thread/` — **misnamed under this rule**. The directory
  is the chat surface: a user calls this "the chat," not "the
  assistant-ui thread surface." `ThreadPrimitive` is an internal
  composition primitive used inside `Thread.tsx` itself, not a contract
  other unrelated features depend on. The only cross-feature coupling
  is two utility leaves (`MarkdownText`, `RecordingButton`) imported by
  `src/components/tasks/` — that is an extraction smell, not a
  load-bearing boundary.
- `src/components/conversations/` — also misnamed. The user-facing
  surface is "the chat list" (sidebar list of chats). The directory
  currently mirrors the storage-domain name from
  `electron/ipc/conversations.ts`, but renderer directories are not
  wire-protocol-stable, so the storage mirror buys nothing the IPC
  channel namespace doesn't already provide.

**Commitment**: rename `src/components/thread/ → src/components/chat/`
and `src/components/conversations/ → src/components/chat-list/`. The
two shared utilities (`MarkdownText`, `RecordingButton`) extract to
`src/components/shared/` first, so the renamed `chat/` directory
contains only chat-surface code.

**Sequencing**: execution is deferred until the in-flight PR backlog
touching these directories drains. A bulk path rename mid-stream
produces gratuitous conflicts on every open PR. The rename ships as a
single mechanical commit once the backlog clears; until then, **new
files in these directories follow the layer rules above and the
rename plan absorbs them automatically**.

The wire-protocol layers (`electron/ipc/conversations.ts`,
`conversations.json`, Mastra `scope === "thread"`) are unaffected by
the directory rename and stay as documented in the Decision table.

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

### Keep `thread/` and `conversations/` directory names as-is

Rejected. This was the original framing of this ADR: directory names
express the _integration boundary_ (the `@assistant-ui/react`
composition surface, the storage domain); file names express what the
file is. The argument _for_ keeping the names: renaming erases the
integration-boundary signal in favor of UI vocabulary, telling future
readers "these are just chat UI files" when they are actually "the
assistant-ui thread surface that _renders as_ chat."

The argument doesn't survive a per-directory audit. Across the eleven
`src/components/` directories on `main`, only four match an
integration-boundary reading (`overlay/`, `plugins/`, `thread/`, `ui/`);
five are user-facing surface names (`agents/`, `backgrounds/`,
`settings/`, `sidebar/`, `tasks/`); two are dual-named
(`conversations/`, `dictation/`). The dominant pattern is user-facing
surface naming, not boundary naming. Preserving the integration-boundary
framing would force eleven directories to defend the same rule and most
of them can't.

Applied to `thread/` itself: the directory contains 33 chat-surface
files (composer, message renderers, tool group display, selectors). Its
twelve importers are dominated by `src/App.tsx`; the only cross-feature
coupling is two utility leaves imported by `src/components/tasks/`
(`MarkdownText`, `RecordingButton`) — accidental leakage, not a
contract other features depend on. Under the user-facing-surface rule
(§Directory naming), the directory should be named `chat/`. The same
analysis applies to `conversations/` → `chat-list/`. iamhollow's
original proposal in #13 was directionally right; this ADR commits to
the rename, deferred until the in-flight PR backlog drains.

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

- **Mixed dialect inside directories during the rename window.** Until
  the §Directory naming rename ships, paths like
  `src/components/thread/ChatSettingsButton.tsx` mix Thread-vocab
  directories with Chat-vocab leaves. The mix resolves once the rename
  lands; until then, the §Directory naming subsection is necessary
  context for any reader encountering one of these paths.
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
  will encounter file paths like
  `src/components/conversations/ThreadSettingsModal.tsx` (pre-rename)
  or `src/components/chat-list/ThreadSettingsModal.tsx` (post-rename)
  and need to read this ADR to understand the Thread/Chat split. The
  directory rename reduces this from three vocabulary terms in one
  path to two, but the layer rules still require Thread and
  Conversation symbols in some leaves. Internal contributors can ask
  in chat; OSS contributors cannot. The Mitigation pointers exist to
  shorten this curve.
- **Directory-rename migration cost.** The §Directory naming
  commitment requires renaming `src/components/thread/ →
src/components/chat/` and `src/components/conversations/ →
src/components/chat-list/`. This touches every import site (twelve
  for `thread/`, six for `conversations/`), invalidates `git
log --follow` callers that don't pass `-M`, and produces conflicts on
  every open PR that touches files in these directories. The rename
  is deferred until the in-flight PR backlog drains; it then ships as
  a single mechanical commit. The two utility leaves
  (`MarkdownText.tsx`, `RecordingButton.tsx`) that
  `src/components/tasks/` depends on extract to
  `src/components/shared/` first — see Mitigation.
- **Layer-cross-boundary cost remains.** Any future decision to change
  the convention (for example if Mastra changes its scope enum in a
  breaking release) still requires touching multiple layers
  atomically. The directory rename does not address this; only the
  wire-format mitigations (branded ID types, lint rules) would.
- **Documentation-only enforcement.** There is no lint rule, no CI gate,
  and no runtime check that asserts the convention is preserved across
  PRs. Drift is possible. See Mitigation for the path to mechanizing
  enforcement; right now the convention relies on review attention.

### Mitigation

- The pointer in `CLAUDE.md` ("Naming Convention" section) and the
  `### Naming Convention` subsection in `CONTRIBUTING.md` route both
  agents and human contributors to this ADR at the moment of need.
- **Pre-rename: extract shared utilities.** Before the
  `thread/ → chat/` directory rename can land, the two leaves that
  `src/components/tasks/` depends on must move out of the chat surface
  so the renamed `chat/` directory contains only chat-surface code:
  - `src/components/thread/MarkdownText.tsx` → `src/components/shared/MarkdownText.tsx`
    (imported by `tasks/TaskDetailModal.tsx`, `tasks/TaskCreationView.tsx`,
    `tasks/TaskDetailPanel.tsx`, and several leaves inside `thread/`
    itself)
  - `src/components/thread/RecordingButton.tsx` → `src/components/shared/RecordingButton.tsx`
    (imported by `tasks/TaskCreationView.tsx`,
    `tasks/TaskDetailPanel.tsx`, and `thread/ComposerInput.tsx`)

  These two files are extraction candidates regardless of the rename —
  authored as chat-surface leaves but adopted by `tasks/`, they are now
  cross-feature utilities masquerading as chat-surface code. The
  extraction ships as a separate commit before the directory rename
  and unblocks it.

- Drift can be audited manually with `grep` against these rules:
  - Imports from `@assistant-ui/react` live only under the chat
    directory (`src/components/thread/` pre-rename;
    `src/components/chat/` post-rename) or `src/providers/`. Hits
    elsewhere mean the assistant-ui composition surface is leaking
    outside the chat directory.
  - IPC channel prefixes use `conversations:` for storage operations,
    not `chat:`. A `chat:list` / `chat:get` / `chat:delete` channel is
    a wire-format drift signal. The directory rename does **not**
    extend to IPC; storage is still wire-protocol-stable.
  - `conversations.json` and `scope: "thread"` are byte-stable. Any
    diff that touches the literal `"conversations.json"` filename or
    the `'thread'` enum value in `electron/config/schema.ts` is
    crossing a wire-protocol boundary and needs review.

  A real ESLint custom rule or branded ID types (`type ConversationId =
string & { __brand: ... }`) is the long-term answer that converts
  this convention from documentation-only to a hard typecheck gate,
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
