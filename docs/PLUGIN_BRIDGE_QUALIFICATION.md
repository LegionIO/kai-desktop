# Plugin Bridge live qualification

Validated on macOS on 2026-11-10 using the development build and the existing Kai installation/accounts. The compact approval dialog is implemented and visually verified. Clanks imports work through Kai's Mastra runtime, and native MSGraph exports work from both real Claude and Codex clients. This is **not a claim that every SDK runtime or remote deployment is fully qualified**; the Codex SDK limitation below remains.

## Scope and results

The human approved temporary Clanks skills, MCP and supported hooks, testing the installed Claude and Codex packages separately. Export access was limited to MSGraph `auth-status` and `get-presence` for the signed-in user's own object ID. The live test clients did not send messages or perform Microsoft Graph writes. Client setup used the copy-only flow; real host configuration was preserved.

| Check                                         | Result                   | Evidence                                                                                                                                                                                                                                                                                                                          |
| --------------------------------------------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Approval window                               | Pass                     | Actual component, sharing and revocation approvals used a themed Radix dialog with bounded height, scrollable details, fixed buttons and initial focus on Cancel. The 11-component review fit in a 600 × 548 content area; a short review fit in 600 × 328.                                                                       |
| Claude-installed Clanks, `0.1.5+757747500679` | Pass                     | Actual installed programs exposed 29 MCP tools plus the skill reader. Skills, inboxes and supported lifecycle hooks executed.                                                                                                                                                                                                     |
| Codex-installed Clanks, same version          | Pass                     | The same checks passed independently with the Claude package disabled.                                                                                                                                                                                                                                                            |
| Concurrent Clanks sessions                    | Pass                     | Each package ran two simultaneous chat contexts and a child context with distinct handles and the correct parent identity. Cross-session handles were rejected. Registration was bound to Kai's identity; runtime changes preserved it.                                                                                           |
| Hook execution                                | Pass within stated scope | Registration/context injection, first-tool MOTD denial, permitted retry, bounded watchers and cancellation/cleanup passed. No live pending-message condition triggered stop continuation; the forced continuation and cancellation cases remain fixture-covered.                                                                  |
| Actual Kai Mastra chat                        | Pass                     | The Claude package's skill read was deferred by MOTD, then successfully retried after reading the inbox. Own identity and deregistration were verified. The Codex package's chat completed inbox/identity/deregistration; its model did not retry the deferred skill read, which passed separately in the controlled live driver. |
| Actual Claude client → Kai MSGraph            | Pass                     | Claude called only the two selected tools, reported authenticated, and read one self-presence entry.                                                                                                                                                                                                                              |
| Actual Codex client → Kai MSGraph             | Pass                     | Codex called the same two tools under native automatic approval review and returned the same bounded result.                                                                                                                                                                                                                      |
| Generated launchers with Kai closed           | Pass, both clients       | Each generated connector started the real headless backend, listed exactly two tools, preserved the presence input schema and text/structured results, and rejected unexported/admin calls. Backend shutdown followed disconnect.                                                                                                 |
| Reconnect                                     | Pass                     | The same MCP client survived GUI Kai shutdown, reconnected through a replacement headless backend, and retained the selected catalog.                                                                                                                                                                                             |
| Export withdrawal                             | Pass, both clients       | Removing the export selection emptied both connected clients' catalogs and rejected invocation of a formerly exported tool.                                                                                                                                                                                                       |
| Independent credential revocation             | Pass                     | A new Claude connection failed after Claude revocation while Codex remained authorized. A new Codex connection failed after its own revocation.                                                                                                                                                                                   |
| Remote MCP on the real installation           | Not exercised            | The existing Web UI uses anonymous authentication. Remote sharing remained off. TLS, OAuth/PKCE, consent, static tokens and revocation were exercised with isolated local fixtures.                                                                                                                                               |

## Codex SDK qualification limit

Kai resolved `/opt/homebrew/bin/codex`, version `0.145.0`. An early test-driver invocation omitted the selected Kai model and therefore used the host's newer `gpt-6-astra` default. That CLI reported missing model metadata and the model could not call the advertised tools. The driver was corrected to pass Kai's selected `gpt-5.4` explicitly.

With the selected model, the actual Kai Codex SDK chat discovered the imported tools and successfully called Clanks status and agent details. Skill reading, inbox reading and explicit deregistration returned the CLI's `user cancelled MCP tool call` result. These calls did **not** pass. No approval bypass or permission relaxation was used. Graceful Kai shutdown subsequently ran the session cleanup, and the test identity was independently confirmed deregistered/offline.

The newer Codex CLI bundled with the desktop app (`0.167.0-alpha.3.2`) passed the external MSGraph connector test with `approval_policy=on-request` and `approvals_reviewer=auto_review`. That proves the export flow under that client configuration, not full imported-plugin execution inside Kai's older SDK subprocess. An earlier external-client attempt was rejected by automatic approval review; the permitted retry submitted the exact human-authorized calls through native review.

The settings compatibility notes now state the installed CLI/model and MCP approval-flow dependency. Native SDK tools/subagents still have the hook coverage limits described in [Plugin Bridge documentation](PLUGIN_BRIDGE.md). No live qualification is claimed here for Claude Agent SDK, Pi or OpenCode imported-tool execution.

## Fixes found during validation

- Replaced the oversized stock confirmation with an isolated, sandboxed approval window and a restricted preload. Approval remains bound to the expected window, frame, URL and request. Escape, parent closure, navigation, renderer failure and expiry cancel the review. Clearing exports now explicitly says that all tools will be withdrawn.
- Generated connectors use the running Kai executable and the absolute application entry in development. Headless startup receives the same entry instead of depending on an older PATH wrapper.
- Fixed an Electron 41 crash: a headless window is hidden immediately and destroyed on the next event-loop turn, rather than synchronously inside `browser-window-created`.
- Registered restricted connector authentication early enough for clients to hold the starting backend alive. Requests wait for service initialization, and restricted MCP clients count toward backend lifetime and shutdown decisions.
- Restored Clanks hook mode for the Claude package, which does not declare an Interrupt group. A declared but unapproved group still prevents hook mode.
- Added Codex fallback executable detection, removed invalid synthetic MCP configuration, retained nonfatal SDK notices as notices, required imported MCP catalog readiness, and applied both older and newer Codex plugin-disable controls.

Native Kai plugin implementations and host installation files were not changed for these tests. This qualification covers the development build; release publication and packaged-app delivery are tracked separately.

## Automated validation

| Validation                                      | Observed result                                                                                  |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Full backend suite                              | 4,805 passed; 5 skipped                                                                          |
| Full component suite                            | 800 passed                                                                                       |
| Local Playwright/Electron/MCP suite             | 2 passed, including real headless window suppression and isolated approval/MCP/HTTPS/OAuth flows |
| Focused tests after final compatibility changes | 37 passed across approvals, lifecycle/isolation, imported runtime protocol and Codex adapters    |
| Final type-check                                | Passed                                                                                           |
| Final lint                                      | Passed with 0 errors and 32 warnings                                                             |
| Final production build                          | Passed                                                                                           |
| Diff whitespace check                           | Passed                                                                                           |

Fixtures use temporary host homes and do not modify real Claude/Codex settings or write to Microsoft Graph. Live checks are kept separate from deterministic test results.

## Cleanup and evidence

Cleanup was verified through settings UI, backend inventory, connection attempts and Clanks lifecycle state:

- Import, sharing and remote-sharing switches are off.
- Zero approved foreign components, export sources, export tools, active clients or imported tools remain.
- Both temporary connector credentials are revoked; new connections fail.
- All 18 test identities belonging to this Kai bridge instance are deregistered and offline.
- No temporary live-test child processes remain. Test conversations are retained as evidence.
- SHA-256 comparisons confirm `.claude/settings.json`, `.claude.json` and `.codex/config.toml` are unchanged from the baseline.
- Development Kai was closed gracefully and `/Applications/Kai.app` was reopened and observed running.

Redacted local reports include `claude-installed-clanks.json`, `codex-installed-clanks.json`, `claude-mastra.json`, `codex-sdk-selected-model.json`, `live-claude-client.json`, `live-codex-client.json`, `live-headless-export-transport.json`, `live-reconnect.json`, `live-revocation.json`, `test-session-cleanup.json` and `live-cleanup.json`. Their temporary directory is recorded in the gitignored `debug-logs/plugin-bridge-live-path.json`. Build and test logs use the `plugin-bridge-live-final-*` and `plugin-bridge-live-cleanup-*` prefixes in `debug-logs/`.
