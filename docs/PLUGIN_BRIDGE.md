# Plugin Bridge and Kai MCP Sharing

Settings → Plugin Bridge adds three sections: **Import Plugins**, **Share Kai**, and **Activity**. Imports, sharing, and remote access are independently off by default. Native Kai plugins keep their installation, marketplace, permissions, tool names, and account flows.

## Import installed plugins

1. Enable **Import installed plugins**. This discovers installed user packages without starting their programs. Override Claude or Codex home paths under **User installation locations** if needed. Defaults honor `CLAUDE_CONFIG_DIR` and `CODEX_HOME`.
2. Open **Review** for a package. Inspect the installed path, version, components, detected access, runtime compatibility, and overlaps. Source-host enablement is informational; it is not Kai consent.
3. Select individual skills, MCP servers, or lifecycle hook groups. **Skills only**, **Skills + MCP**, and **All supported components** are shortcuts. Save to grant the selected components. Desktop approvals use a compact, isolated approval window with scrolling details and fixed Cancel/Approve buttons; password-authenticated Web UI settings have a separate approval API.

The bridge reads Claude's user installed-plugin registry and settings, and Codex's user configuration, configured local marketplace metadata, and installed cache. It never fetches marketplaces, runs installers, discovers project installations, or imports a development checkout. Obsolete versions are excluded when installation metadata identifies a current version. Ambiguous versions require an explicit selection. A missing selected source never activates a different source.

Root `plugin.json`, `.claude-plugin/plugin.json`, and `.codex-plugin/plugin.json` are supported, including portable OpenAI extensions, compatibility overlays, referenced MCP configurations, skills, and command-hook files. Packages execute directly from their installed location; no native wrapper or `skill.json` conversion is written. Referenced files and skill supporting files must remain inside the package, including after resolving symlinks. Relative MCP program/argument paths resolve against the installed package; plugin-root variables and declared environment values are resolved before review. Plugin data has its own writable directory under `~/.kai/plugin-bridge/data/`.

Executable components are local code running as your user. Detected access reports commands, endpoints, environment/header names and capabilities, with sensitive values omitted. It is **not an OS sandbox**. Undeclared provider environment secrets are not inherited. Command/configuration changes are conservatively fingerprinted; changed execution definitions require review even when their visible access labels are similar.

Changes to approved skill instructions and other updates within an approved detected scope are adopted at execution boundaries. New components remain off. Expanded access, malformed/missing components, connection failures and unsupported features have explicit statuses. Imported MCP catalog notifications refresh schemas and withdraw removed tools. Calls already using a compatible previous MCP version finish before that connection retires. Disabling imports cancels owned calls, processes and watchers. Selections remain for revalidation after re-enabling.

## Runtime compatibility

| Runtime          | Imported MCP and skills | Enforcing tool hooks | Lifecycle                                                                          |
| ---------------- | ----------------------- | -------------------- | ---------------------------------------------------------------------------------- |
| Mastra           | Supported               | All Kai tools        | Session start, prompt, results/failures, stop, Kai subagents, interruption and end |
| Claude Agent SDK | Supported               | Kai-provided tools   | Session lifecycle; native SDK tool/subagent boundaries remain runtime-owned        |
| Codex SDK        | Supported               | Kai-provided tools   | Session lifecycle; native Codex tools/subagents do not pass through Kai's hooks    |
| OpenCode         | Supported               | Kai-provided tools   | Native OpenCode tools/approvals remain runtime-owned                               |
| Pi               | Supported               | Kai-provided tools   | Native Pi interception and headless approvals are unavailable                      |

SDK compatibility also depends on the installed CLI and its selected model. A CLI that cannot represent the model's tool catalog can omit callable tools, and a non-interactive CLI can cancel MCP calls that require human approval. Kai retains those host policy decisions. The live qualification report records the tested versions and any affected calls; MCP discovery alone is not a successful tool-use test.

Skills are exposed as descriptions with on-demand instruction/supporting-file readers. Session and prompt context is attached to the user's message so SDK adapters still receive the original request. Imported context passes through native prompt policies again. Hook `allow` decisions cannot grant approval or clear a native denial. Pre-tool enforcement is never inferred from an event observed after execution.

Each Kai chat and Kai-managed subagent has a distinct, stable installation-qualified identity. MCP and hooks share the same working directory and identity. Clanks supports both executable and `node …/clanks.mjs` installations; Kai binds registration/inbox handles to their owning session. Without its compatible hook groups, Clanks uses polling mode. Shared connector calls also use polling because they do not run chat hooks.

Command hooks have time/output limits. Async watchers are replaced per event/command, cancelled at turn end, and cannot wake an idle chat. Stop hooks may request one continuation, with a two-minute limit, completed tool history and native policy checks. Explicit user cancellation wins. Imported commands/agent definitions, LSP extensions, registered cloud-app mappings, and arbitrary idle wake are outside V1.

Kai-managed Claude SDK subprocesses use explicit settings sources, strict MCP configuration and no ambient plugin list. Codex subprocess overrides disable default installed plugins, explicit inherited entries, remote plugin loading and host hooks. Standalone authentication/session homes and host settings are preserved. The only MCP servers added by these subprocesses are Kai's per-turn bridges.

## Overlaps and provenance

Verified equivalence requires matching component content or normalized execution/endpoint configuration, including account-affecting data. A similar name or repository alone is a possible overlap. Native equivalents are preferred; foreign alternatives remain off until explicitly selected. Multiple selected sources have stable namespaces. Native names remain unchanged, and failures never trigger alternate-source activation.

Kai's own connector cannot be imported. Managed capabilities carry origin/source metadata; known forwarding connectors and returning origin chains are rejected. This detects managed forwarding cycles, not arbitrary third-party servers that discard provenance.

## Share Kai locally

Enable **Share Kai through MCP**, then select sources or individual tools. A source selection includes future eligible tools from that source; choosing individual tools pins the export selection to those tools. Imported components have separate export consent. Every client uses this shared selection and has an independently revocable credential.

Select **Connect to Claude** or **Connect to Codex** to preview the exact connector entry. Applying preserves unrelated host settings and refuses to overwrite an existing `kai-mcp` entry. Copy-only setup creates the credential without editing host configuration. Preview revisions expire and are rechecked before writes.

The generated launcher runs:

```sh
kai mcp serve --credential <reference>
```

The command speaks MCP on stdout and diagnostics on stderr. Existing `kai mcp list`, `login`, `logout` and registration commands remain available. It uses Kai's authenticated local backend connection, headless startup/reconnect and client lifetime handling. Its credential authorizes only MCP list/call/cancel channels and receives no general IPC broadcasts.

Exports require both an enabled underlying source and export selection at discovery and invocation. Disabling a source/export withdraws tools and cancels its pending calls. Registered native plugin tools execute with their existing signed-in accounts; Microsoft Graph tokens stay in Kai. Schemas, structured results, content blocks, error status, progress and cancellation are retained. Calls have client/session context without creating ordinary Kai conversations. Tools requiring unsupported UI/chat context, agent delegation, credential management or bridge administration are excluded. Existing tool lifecycle and execution policies still apply.

## Share Kai remotely

Remote sharing uses `/mcp` on the existing Web UI listener. Enable password sign-in and HTTPS in **Settings → Web UI**, set the canonical public HTTPS MCP URL ending in `/mcp`, then enable **Allow remote MCP connections**. Plain HTTP and anonymous access are rejected. V1 shares one Kai installation's accounts; it does not provide separate users/accounts per connector.

OAuth clients discover the protected-resource metadata at `/.well-known/oauth-protected-resource/mcp`. Authorization-server metadata, registration, token exchange and revocation use the MCP SDK's routes. URLs derive from the canonical public URL, never the request Host. Authorization code flow requires S256 PKCE, registered redirects, the MCP resource, Web UI password sign-in and connector consent. Codes are single-use; consent is bound to the browser session and CSRF token. Rate limits and a restricted login return path apply.

OAuth access tokens last one hour; rotating refresh tokens last 30 days. Alternatively, create a named static bearer token with a chosen 1–365 day lifetime (30 days by default). The secret is shown once. Both credential types authorize only MCP, not Web UI administration or ordinary IPC. Password changes, remote URL changes, disabling remote sharing and client revocation invalidate remote access.

Approval state is separate from ordinary config at `~/.kai/plugin-bridge/approvals.json`. Generic config setters cannot edit bridge grants. Remote secrets are represented by hashes in a backend-only encrypted credential ledger, with durable revocation generations. Local launcher references resolve to owner-readable credential files. If secure storage is unavailable, credentials are session-only and must be recreated after the backend restarts. Activity never records credential values or tool payloads.

## Validation

See the [live qualification report](PLUGIN_BRIDGE_QUALIFICATION.md) for the tested installed packages, actual client results, cleanup evidence and remaining runtime limits.

```sh
pnpm exec vitest run electron/plugin-bridge electron/mcp-sharing --maxWorkers=4
pnpm exec vitest run --config vitest.component.config.ts src/components/settings/__tests__/PluginBridgeSettings.test.tsx
pnpm build
pnpm test:plugin-bridge:local
pnpm lint
pnpm type-check
pnpm test --maxWorkers=4
pnpm test:component --maxWorkers=4
```

The local Playwright suite uses a throwaway Kai data directory and fixture Claude/Codex homes, real stdio MCP, a loopback HTTPS listener and a browser sign-in/consent flow. It never changes real host configuration or writes to Microsoft Graph. Unit suites cover discovery/version ambiguity, redaction, approval authority, updates, deduplication, Clanks session separation, hook continuation/cancellation, export enforcement, OAuth validation/rotation/revocation, and local connector isolation. Live third-party services and every native SDK's private tool boundary are not claimed by fixture tests.
