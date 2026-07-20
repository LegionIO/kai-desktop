# Architecture Decision Records

ADRs document architecturally significant decisions for Kai: the constraint
the decision answers, the option chosen, the alternatives rejected, and the
consequences (positive and negative) we accept. The goal is that a future
contributor can read the ADR and understand _why_ the codebase looks the
way it does — not just _what_ it does.

## Index

| #    | Title                                                                                                  | Status   | Date       |
| ---- | ------------------------------------------------------------------------------------------------------ | -------- | ---------- |
| 0001 | [Electron Fuses Policy](./0001-electron-fuses-policy.md)                                               | Accepted | 2026-05-19 |
| 0002 | [Thread / Conversation / Chat Naming Convention](./0002-thread-conversation-chat-naming-convention.md) | Accepted | 2026-05-26 |
| 0004 | [Appshots Persisted Capture Artifacts](./0004-appshots-persisted-capture-artifacts.md)                 | Accepted | 2026-07-11 |
| 0005 | [Platform Capability Seam](./0005-platform-capability-seam.md)                                         | Accepted | 2026-07-11 |
| 0006 | [Plugin Backend Process Isolation](./0006-plugin-backend-process-isolation.md)                         | Proposed | 2026-07-20 |

## Adding a new ADR

- Number the file sequentially (`NNNN-short-kebab-title.md`).
- Follow the structure of an existing ADR: Status / Date / Deciders header,
  then `## Context`, `## Decision`, `## Considered Alternatives`,
  `## Consequences` (Positive / Negative / Mitigation), `## References`.
- Cite symbols (file paths + symbol names), not line numbers — line numbers
  rot. ADR-0001 is the convention reference.
- Update this index when the file lands.

ADRs are immutable once Accepted. To change a decision, write a new ADR
that supersedes it and update the older ADR's Status to `Superseded by
NNNN`.
