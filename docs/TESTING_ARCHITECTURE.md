# Testing Architecture

This document is the long-form companion to [`TESTING.md`](../TESTING.md). It
explains why the testing pipeline is shaped the way it is, what each layer
catches, and which trade-offs are deliberate.

Read [`TESTING.md`](../TESTING.md) first if you only need to know how to run
the tests. Read this if you are changing test infrastructure, adding a new
layer, or removing one.

## Layers and Tools

The pipeline has eight layers. They are ordered roughly by what they catch
and how expensive they are, not by when they run.

| Layer                 | Tool / Runner                           | Config                                                                                               | Trigger                                                   | Cost Profile                                                                                                       | Determinism Guarantee                                                                                                                                              |
| --------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Unit                  | Vitest                                  | [`vitest.unit.config.ts`](../vitest.unit.config.ts)                                                  | Every PR (Linux `checks` job) and pre-push hook           | Seconds. Pure-function tests with mocked IPC, no Electron, no DOM.                                                 | Frozen system time, deterministic UUIDs, mocked `@lydell/node-pty`, fetch firewall on.                                                                             |
| Component             | Vitest + jsdom + Testing Library        | [`vitest.component.config.ts`](../vitest.component.config.ts)                                        | Every PR (Linux `checks` job) and pre-push hook           | Seconds. Renders React components through `renderWithProviders`.                                                   | Same vitest globals as unit; uses [`test-utils/render.tsx`](../test-utils/render.tsx) so context providers are mounted identically across tests.                   |
| Integration           | Vitest                                  | [`vitest.integration.config.ts`](../vitest.integration.config.ts)                                    | Every PR (Linux `checks` job)                             | Single-digit seconds. Exercises IPC handlers through the in-memory harness rather than real Electron IPC.          | Same vitest globals as unit; the IPC harness in [`test-utils/ipc-harness.ts`](../test-utils/ipc-harness.ts) is synchronous so there are no event-loop races.       |
| IPC seam smoke        | Playwright + unpackaged Electron binary | [`playwright.config.ts`](../playwright.config.ts), [`e2e/ipc-seam.spec.ts`](../e2e/ipc-seam.spec.ts) | Every PR (`ipc-seam-smoke` job) on Linux under `xvfb-run` | ~30 seconds. Launches the real Electron binary against the built output in `out/`. No code signing, no DMG.        | Fresh tmp directory per run via `KAI_USER_DATA`. The `--no-sandbox` flag is orthogonal to all Electron Fuses (see below).                                          |
| Packaging (Mac build) | electron-builder                        | [`electron-builder.template.yml`](../electron-builder.template.yml)                                  | Gated PR job (`mac-build` label) and on every release     | Minutes on a Mac runner. Produces a signed, notarised DMG and an arm64 zip.                                        | The fuse-verification step (`scripts/verify-fuses.ts`, added by a sibling PR in this stream) is deterministic — see [ADR 0001](adr/0001-electron-fuses-policy.md). |
| Nightly evaluation    | TBD (added in a follow-up PR)           | TBD                                                                                                  | Scheduled nightly                                         | Minutes. Runs the evaluation rubric against committed fixtures only — no live providers.                           | All inputs are committed fixtures; the rubric grade is deterministic for a given fixture set.                                                                      |
| Nightly real-API      | TBD (added in a follow-up PR)           | TBD                                                                                                  | Scheduled nightly, behind real provider credentials       | Minutes to tens of minutes. The only path in CI that touches real provider hosts.                                  | Not deterministic by construction — that is why it runs only on the nightly cadence and never on PR.                                                               |
| Weekly fixture drift  | TBD (added in a follow-up PR)           | TBD                                                                                                  | Scheduled weekly                                          | Minutes. Replays the fixture generators against the real APIs and diffs the result against the committed fixtures. | Drift is the signal the layer is designed to catch — non-determinism here is information, not a bug.                                                               |

The unit / component / integration boundary is intentionally porous. We do
not enforce hard separation between them in tooling — what matters is that
no PR-time layer touches the real network and no PR-time layer requires a
packaged binary. The layering exists to let you reason about cost; it is
not a permission system.

## Hermeticity Boundaries

The PR-time pipeline is hermetic by construction. There are several named
seams that make that hermeticity easy to verify and easy to extend. Each
exists for a specific reason that is worth knowing before changing.

### msw opt-in pattern (per-suite `server.listen`)

[`vitest.setup.ts`](../vitest.setup.ts) exports a shared `httpMock` harness
but does **not** call `server.listen()` for the global suite. Suites that
need HTTP mocking opt in by calling `httpMock.server.listen()` in their
own `beforeAll` and `httpMock.server.close()` in `afterAll`.

The reason for the opt-in is concrete: msw 2.x patches `globalThis.fetch`
via `@mswjs/interceptors`. That interceptor breaks chunked-transfer / SSE
responses on loopback connections — tests that spin up a local MCP server
and stream events back to a client transport hang because the wrapped
response body never flushes. `'bypass'` mode does not help; the wrapper
stays installed.

Per-suite opt-in is the documented escape hatch. Suites that need msw get
msw; suites that do not, never see the interceptor at all. The canary at
[`electron/__tests__/canaries/msw-coverage.test.ts`](../electron/__tests__/canaries/msw-coverage.test.ts)
asserts the opt-in path still works as expected after any msw upgrade.

### `globalThis.fetch` firewall (the L2 watchdog)

[`vitest.setup.ts`](../vitest.setup.ts) wraps `globalThis.fetch` so any
request to a known provider hostname fails-closed with an
`ECONNREFUSED`-shaped error before bytes leave the machine. The blocked
hostnames live in `BLOCKED_HOSTS` at the top of the setup file:
`api.anthropic.com`, `api.openai.com`, the Bedrock regional endpoints,
and Azure OpenAI deployment subdomains.

This is the primary fail-closed mechanism since msw is opt-in. Even a
suite that forgets to register the relevant msw handler still gets a
recognisable error rather than a silent network egress.

Why `globalThis.fetch` and not `node:dns`? Node 22 marks `dns.lookup`
non-configurable in a way that silently breaks the previous
`Object.defineProperty` approach. `fetch` is writable and is the path
every SDK in the repo actually routes through, so wrapping it is both
reliable and easy to verify. The canary at
[`electron/__tests__/canaries/dns-firewall.test.ts`](../electron/__tests__/canaries/dns-firewall.test.ts)
asserts the wrapper actually installs.

The firewall also runs a self-install probe at the bottom of
`vitest.setup.ts`: it does a fetch against `api.anthropic.com` and refuses
to start the suite unless that fetch fails with the firewall's marker
error code. If the wrapper ever silently fails to attach (a future Node
change, a transitive dep that stamps over `fetch`), the entire suite
refuses to run rather than letting traffic out.

### `KAI_USER_DATA` env seam

[`electron/main.ts`](../electron/main.ts) reads `KAI_USER_DATA` and uses
its value as the root of the per-app data directory in place of the
default `~/.kai/`. The IPC seam smoke at
[`e2e/ipc-seam.spec.ts`](../e2e/ipc-seam.spec.ts) passes a fresh `tmpdir`
through this variable on every test run, so the smoke cannot pollute a
developer's real `~/.kai/`, and a failing test cannot leave bad state
behind that contaminates the next run.

This is the only environment variable that controls runtime data
location. There is no second seam; there is no fallback.

### `helperRunner` injection (computer-use permissions)

The macOS computer-use permissions service in
[`electron/computer-use/permissions.ts`](../electron/computer-use/permissions.ts)
defaults to a module-level `helperRunner` that shells out to the signed
`LocalMacosHelper` Swift binary. The factory accepts a `helperRunner`
override so tests can inject the stub from
[`test-utils/swift-helper-stub.ts`](../test-utils/swift-helper-stub.ts)
and skip the Swift compile entirely. CI on Linux never has the Swift
toolchain available, so this seam is what lets the computer-use code
path live in the unit suite at all.

### `@lydell/node-pty` global vi.mock

`vitest.setup.ts` installs a global `vi.mock('@lydell/node-pty')` that
returns the stub from [`test-utils/pty-stub.ts`](../test-utils/pty-stub.ts).
The real PTY library is a native module and not consistently available on
all CI runners. The stub gives tests deterministic control over the
spawned process events (data, exit, signal) without ever launching a
real subprocess.

Suites that genuinely need a real PTY — the macOS `node-pty` smoke job —
unstub explicitly. Everything else gets the stub for free.

### Frozen system time + deterministic UUIDs

`vitest.setup.ts` calls `vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))`
in a global `beforeEach`. Any code that reads `Date.now()` or
`new Date()` sees the same instant in every test. UUIDs come from a
counter-backed stub on `crypto.randomUUID` so a test asserting against an
emitted UUID can use the literal value `00000000-0000-0000-0000-000000000001`
rather than a regex.

This is a deliberate design choice: the cost is that tests that _need_
real time or real UUIDs have to unstub themselves explicitly. The benefit
is that the entire suite can rely on these being globals, and the test
output is reproducible across machines.

## Fixture Strategy

The fixture system has three properties that matter:

1. **Typed at generation time.** The generator at
   [`electron/__tests__/__fixtures__/generate.ts`](../electron/__tests__/__fixtures__/generate.ts)
   uses real provider SDK types where they exist (e.g.
   `ChatCompletionCreateParamsBase` from the OpenAI SDK). A fixture whose
   request body has drifted from the real wire format is a compile error
   at `pnpm fixtures:gen` time, not a silent runtime mismatch later.
2. **SHA-256 checksum verified.** Every fixture file's hash is recorded
   in `electron/__tests__/__fixtures__/.checksum`. The
   [`scripts/verify-fixtures.ts`](../scripts/verify-fixtures.ts) script
   re-hashes the on-disk fixtures and fails CI if they do not match the
   manifest. A hand-edited fixture without a regenerated checksum fails
   the build.
3. **One file per provider per scenario.** Layout under
   `electron/__tests__/__fixtures__/`:

   ```text
   anthropic/   - Anthropic SDK (/v1/messages)
   openai/      - OpenAI SDK (/v1/chat/completions, /v1/responses)
   bedrock/     - AWS Bedrock Runtime (/model/{id}/invoke)
   azure/       - Azure OpenAI (/openai/deployments/{id}/chat/completions)
   claude-sdk/  - Anthropic Agent SDK
   codex/       - OpenAI Codex SDK (streaming with MCP framing)
   mastra/      - Mastra-orchestrated multi-step exchanges
   ```

   Each provider directory holds one or more `.jsonl` files. Each line is
   a single `{ request, response }` pair.

### Why not PollyJS HAR?

PollyJS replays HTTP recordings in HAR format. It works, but it has
properties we did not want:

- HAR is a generic browser-network format. It does not know the shape of
  the Anthropic / OpenAI / Bedrock request and response bodies, so a
  fixture that has drifted away from the real wire format silently
  replays the stale body and the test passes against a lie.
- HAR files are large and verbose, with much of the byte budget spent on
  headers and metadata that have no bearing on the test. Diffing them in
  PRs is painful.
- The replay path is opaque. A test that fails because the recording is
  wrong looks identical to a test that fails because the code is wrong.

The typed JSONL approach trades a small amount of authoring overhead for
a substantial gain in diff-readability, drift detection, and failure
attribution.

### Weekly fixture drift check

The follow-up PR adds a weekly scheduled workflow that re-runs the
fixture generators against the real provider APIs (using credentials that
only that workflow has access to) and diffs the result against the
committed fixtures. The output is either "no drift" or a file of new
fixtures that a maintainer can merge in.

This is the canonical answer to "what if the real API changed in a way
our committed fixtures do not catch?" Drift is detected at the cadence of
the workflow, not at PR time, and is surfaced as actionable diffs rather
than mysterious test failures.

## Why No LLM-as-Judge

A common pattern in evaluation pipelines is to use a second LLM as the
grader: feed prompt + response into a judge model, have it return a
quality score. We deliberately do not use that pattern.

The issue is version skew. If the target model (the one being graded) and
the judge model (the one doing the grading) drift between releases — and
they always drift, because providers update their hosted models on their
own cadence — then a regression that looks like "the target got worse"
might actually be "the judge changed its standards". You cannot
distinguish the two from a flat numerical score.

The pipeline instead uses **explicit rubric assertions**. Each evaluated
prompt comes with a set of programmatic checks (this substring appears,
this JSON shape validates, this tool call is invoked with these
arguments). The checks are deterministic against the recorded response.
A change in the target's behaviour shows up as a specific failed
assertion, not as a fluctuation on a 0–1 score.

This is more work to author per prompt. It is also more diagnostic when
something fails.

## Why Reporting-Only Coverage

Coverage thresholds (e.g. "fail PR if line coverage drops below 80%")
have a known failure mode: they become deadweight maintenance. A PR that
refactors a 200-line file into ten 20-line files moves coverage numbers
around in ways that have nothing to do with the change's quality, and
reviewers end up rubber-stamping `// istanbul ignore` comments or
adjusting threshold values to keep the build green.

We report coverage on PRs (as a comment, computed by the coverage
collector during the unit / component / integration runs) but do not
gate on it. The PR comment gives reviewers visibility into what the
change touched and what it did not. Reviewers can use that information
without being burdened with a mechanical pass/fail score on arbitrary
lines-changed.

If a PR adds a new module with zero coverage, that is a review-time
conversation, not a CI-time block.

## Conventions

- **Explicit assertions only.** Use `expect(...).toBe(...)`,
  `.toEqual(...)`, `.toMatchObject(...)`, `.toBeInTheDocument()`, and so
  on. Snapshots (`.toMatchSnapshot`, `.toMatchInlineSnapshot`) are
  forbidden. Snapshots invite rubber-stamp updates: a PR that
  accidentally changes output regenerates the snapshot and the test
  still passes. An explicit assertion fails loudly with a readable diff.
- **Helper-driven fixtures over inline setup.** When you find yourself
  building a fake `ipcMain`, a fake provider stack, or a partial render
  tree in a test, look in [`test-utils/`](../test-utils/) first.
  `createIpcHarness`, `renderWithProviders`, `setupHttpMock`,
  `createPtyStub`, and `createSwiftHelperStub` exist so that the same
  test stack assembles the same way across the suite. If you need a
  variation that the helpers do not support, extend the helper rather
  than inlining a one-off shape.
- **No production-code changes for testability** unless a clear seam is
  needed and the PR explicitly carves it out. The `helperRunner`
  injection in `permissions.ts` is a good example of how a seam should
  look: a single named parameter with a typed signature, a documented
  default, and a stub builder in `test-utils/`. Avoid adding
  `if (process.env.NODE_ENV === 'test')` branches to production code.
- **AI provider mocking strategy is two-layered.** `vi.mock` at the SDK
  package boundary for the Claude Agent SDK, the OpenAI Codex SDK, and
  the Mastra factory. msw at the HTTP egress for the `@ai-sdk/*`
  providers in [`electron/agent/language-model.ts`](../electron/agent/language-model.ts).
  The split is because the first three have non-trivial client-side
  state that is easier to fake at the SDK boundary, while the
  `@ai-sdk/*` providers are stateless adapters over plain HTTP that are
  cleanly mocked at the wire.
- **Determinism seams are global.** `vitest.setup.ts` sets the frozen
  system time, stubs `crypto.randomUUID`, and mocks `@lydell/node-pty`
  globally. Tests should rely on these rather than reintroducing them.
  If a test genuinely needs real time or real UUIDs, it should unstub
  explicitly and document why.
- **Onboarding sentence.** A first-time contributor to a test file
  should be able to read the file top-to-bottom and understand what it
  asserts without scrolling away to fetch helper definitions. If a test
  needs three layers of fixture indirection to set up a single
  scenario, that is a signal the helper is the wrong shape, not a
  signal that you should write a fourth layer.

For the day-to-day "how do I run a test" view, see
[`TESTING.md`](../TESTING.md).
