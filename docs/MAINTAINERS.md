# Maintainer Playbook

This document is the working reference for repo maintainers. It describes the
day-to-day decisions that keep the testing pipeline honest: what to look for in
a PR, when to apply gating labels, how behavioural regressions are tracked,
and how releases ship.

It is intentionally short on prescription. Where a process has a single owning
script or workflow, this doc points at it rather than restating it.

## Determinism Checklist

Before approving a PR, walk through this list. None of these checks require
spinning up the app locally — they are all observable from the PR diff and
the CI output.

- [ ] **Offline test pass.** The `checks` job on Linux ran `pnpm test` to
      completion. No suite hit the public network — that is enforced by the
      egress firewall in [`vitest.setup.ts`](../vitest.setup.ts), but the
      diff should still avoid introducing real-network calls or bypass shims.
- [ ] **Fixture verify.** If the PR touches anything under
      `electron/__tests__/__fixtures__/`, the `pnpm test:fixtures:verify` step
      passed. A hand-edited fixture without a regenerated `.checksum` fails
      this check.
- [ ] **No new dependencies that pull a real provider SDK at test time.**
      New SDK additions should arrive with msw fixtures or vi.mock at the SDK
      package boundary.
- [ ] **Secret grep limited to nightly / eval workflows.** Any new workflow
      that references a provider API key must run only on the nightly or
      on-demand eval path, never on PR. PR-time workflows must remain
      offline-only.
- [ ] **No production-code changes for testability** unless the PR carves
      out an explicit seam and explains it in the description (see
      [`CONTRIBUTING.md` testing conventions](../CONTRIBUTING.md#testing-conventions)).
- [ ] **Doc impact considered.** If the PR changes the test layering,
      fixture strategy, or fuse policy, the corresponding doc
      ([`docs/TESTING_ARCHITECTURE.md`](TESTING_ARCHITECTURE.md),
      [`docs/adr/0001-electron-fuses-policy.md`](adr/0001-electron-fuses-policy.md))
      is updated in the same PR.

## Label Gating Policy

Two labels gate expensive CI work. Both are added **by a maintainer** when
needed. They are never auto-applied by automation. External contributors
cannot self-apply them.

| Label       | Effect                                           | When to apply                                                                                                                                                                                                    |
| ----------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mac-build` | Triggers the macOS packaging job on the PR.      | When the PR touches packaging config, fuse-related code, or anything that could plausibly affect the signed bundle. Default state for most PRs is **off** — Linux checks plus the IPC seam smoke are sufficient. |
| `run-eval`  | Triggers the on-demand evaluation job on the PR. | When the PR meaningfully changes prompt, agent, or model-routing behaviour. Routine code refactors do not need it.                                                                                               |

Both labels are deliberately not on by default. The point is that the
expensive paths (Mac runners, eval credits) are spent only when there is a
specific reason to spend them. A maintainer adding the label is the audit
trail.

## Behavioral Regression Triage Workflow

Nightly evaluation runs (added in a follow-up PR) detect when a class of
prompt or agent behaviour regresses between releases. When that happens,
the failure has to land somewhere actionable, not just a workflow log line.

This is the GitHub-mechanics version of that workflow. It does not assume
any particular tooling on the fix side — the choice of how a fix PR is
authored is outside the scope of this plan.

### Setup (one-time, performed by a maintainer)

> Until the steps below are completed, the `integration-nightly`,
> `evals`, and `fixture-drift-check` workflows will run on schedule but
> their issue-creation and board-ingestion steps silently skip because
> the field-ID guards treat missing variables as "not configured". A
> contributor watching the Actions tab will see them as green-but-empty.
> Do not merge PR-stack changes that depend on these workflows until
> these variables are set.

1. Create the project board with `gh project create`:

   ```bash
   gh project create --owner <org> --title "Behavioral Regressions"
   ```

2. Add the columns the workflow expects. The shipped workflow writes
   `Status: Detected` as the first state, then maintainers manually
   advance items to `Triage`, `In Progress`, `Fix Pending Review`, and
   `Resolved` during review.

3. Capture the project URL plus every field + option ID the workflow
   reads, then store each as a repository variable. The exact names
   below are what `integration-nightly.yml` and `evals.yml` consume —
   the prior generic names (`BEHAVIORAL_REGRESSIONS_PROJECT_ID`,
   `BEHAVIORAL_REGRESSIONS_FIELD_STATUS`, etc.) are NOT read anywhere
   and were never wired to the workflow:

   ```bash
   # Project handles
   gh variable set BEHAVIORAL_REGRESSIONS_PROJECT_URL --body "<project-url>"
   gh variable set BEHAVIORAL_REGRESSIONS_PROJECT_NODE_ID --body "<project-node-id>"

   # Field IDs (one per column the workflow writes)
   gh variable set STATUS_FIELD_ID --body "<status-field-id>"
   gh variable set SEVERITY_FIELD_ID --body "<severity-field-id>"
   gh variable set DETECTED_BY_FIELD_ID --body "<detected-by-field-id>"
   gh variable set AFFECTED_PROMPT_ID_FIELD_ID --body "<affected-prompt-id-field-id>"

   # Single-select option IDs (the workflow writes these specific values
   # when ingesting a new regression; replace each with the option ID
   # captured from the project schema query)
   gh variable set STATUS_DETECTED_OPTION_ID --body "<status:detected-option-id>"
   gh variable set SEVERITY_AUTO_OPTION_ID --body "<severity:auto-option-id>"
   gh variable set DETECTED_BY_NIGHTLY_OPTION_ID --body "<detected-by:nightly-option-id>"
   ```

The IDs are static once captured — they only change if the board is
recreated.

### Issue creation (automated, on every nightly detection)

Nightly evaluation workflows file an issue per detected regression using
`gh issue create` against the template at
`.github/ISSUE_TEMPLATE/behavioral-regression.yml`. The body captures:

- The prompt ID or test case ID that regressed.
- The detected severity (auto-classified by the eval rubric).
- A diff between the previous-known-good output and the regressed output.
- The commit SHA and CI run URL where the regression first appeared.

Labels applied automatically: `behavioral-regression`, `nightly-detected`,
`severity:auto`.

**Dedup**: the workflow searches existing issues by a `<!-- test-id:... -->`
body trailer (or by the dated title prefix for the evals workflow) before
creating a new issue, so a regression that recurs on subsequent nights
appends to the open issue rather than creating duplicates. The search
itself has a 30–60s GitHub-side indexing latency, which is acceptable for
the nightly cadence but means two cron runs in the same minute could open
distinct issues — that is by design and is the trade-off for keeping the
detection path free of an explicit lock.

### Board ingestion (automated)

A workflow step uses [`actions/add-to-project@v2`](https://github.com/actions/add-to-project)
to drop the new issue onto the Behavioral Regressions board, followed by a
`gh api graphql` call to populate the `Severity`, `Detected-By`, and
`Affected-Prompt-Id` fields from the issue body.

We chose `actions/add-to-project@v2` deliberately. It is the first-party
GitHub action: minimal attack surface, declarative configuration, and
maintained by the same org that hosts the data. The alternative (a custom
GraphQL script) would do the same thing with more code to audit and own.

### Maintainer triage

A maintainer reviews each new issue and assigns severity / column:

- **Severity:high** — user-visible regression in a documented prompt path.
  Move to `Triage` immediately, target a fix within the current release.
- **Severity:medium** — measurable regression in a less-exercised path.
  Target the next release.
- **Severity:low** — rubric noise, fixture drift, or an intentional
  behaviour change that the nightly run flagged. Close with rationale.

Triage frequency: at minimum weekly. High-severity items get same-day
attention.

### Fix PR

When a maintainer or contributor opens a fix PR, the standard PR flow
applies:

1. PR opens against `main`, gets reviewed under the normal review process.
2. The PR description includes a `Closes #N` trailer (or `Fixes #N`)
   referencing the regression issue, so the issue auto-closes on merge.
3. The next nightly run validates that the regression is no longer
   detected.

The author's choice of tooling to produce the fix is their own. This
playbook is concerned only with the GitHub-side accounting: the issue
exists, it lands on the board, a fix lands through normal review, and the
next nightly confirms the class is gone.

### Cadence

- **Weekly:** maintainer reviews the Behavioral Regressions board, closes
  stale items, re-triages anything sitting in `Triage` too long.
- **Per-release:** eval rubric updates land via separate PRs. The rubric
  itself is documented in `docs/EVAL_RUBRIC.md` (to be added in a
  follow-up PR).

## Future Tooling Migration Notes

Tooling occasionally migrates: a linter swap, a formatter swap, a test
runner upgrade, a build-tool replacement. When that happens, this section
gets a one-line entry pointing at the migration PR or ADR.

Currently tracked considerations (no commitment to act):

- A possible future ESLint → [Biome](https://biomejs.dev/) migration if
  Biome reaches parity with our current rule set and is meaningfully
  faster on the workspace. No timeline.
- A possible future swap of the msw transport to undici's `MockAgent` if
  the streaming-response interceptor friction in msw 2.x becomes
  unworkable. The HTTP mock harness in
  [`test-utils/http-mock.ts`](../test-utils/http-mock.ts) already exposes
  a backend-agnostic API to keep that swap to a single-file change.

This list is descriptive, not predictive. Removing an item from the list
when it lands (or when it is decided against) is part of the maintainer's
cleanup.

## PR Body Conventions

PR descriptions follow the template at
[`.github/PULL_REQUEST_TEMPLATE.md`](../.github/PULL_REQUEST_TEMPLATE.md).
The template fills itself in on PR open — the checklist is meaningful, not
ceremonial.

Two specific conventions are worth calling out:

- **Linking issues.** Use `Closes #N` (or `Fixes #N`) on the line where
  you would otherwise write "fixes that bug". The trailer auto-closes
  the issue when the PR merges. `Refs #N` is for issues that the PR
  touches but does not close.
- **Doc impact.** If the diff plausibly changes how a contributor
  approaches the project, update the relevant doc in the same PR. The
  checklist line on the template is there as a deliberate prompt.

## Release Process

This section is a quick-reference, not the canonical release runbook. The
authoritative steps live in the release workflow at
[`.github/workflows/release.yml`](../.github/workflows/release.yml).

1. Maintainer cuts a release branch from `main` and bumps the version in
   `package.json`.
2. The release workflow runs the full Mac build, signs and notarises the
   DMG, and uploads it as a GitHub Release asset.
3. The `latest-mac.yml` manifest is published alongside the DMG so the
   in-app auto-updater can find it.
4. The release notes are derived from the PR titles merged since the
   previous tag.

If a release fails the fuse-verification step, the release is **not** cut.
That gate is non-negotiable — see
[`docs/adr/0001-electron-fuses-policy.md`](adr/0001-electron-fuses-policy.md).
