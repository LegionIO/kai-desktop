# MCP OAuth in Kai

Kai supports OAuth for URL-based MCP servers over Streamable HTTP and legacy SSE. The desktop, terminal, browser UI, and Mastra/Claude/Codex tool runtimes share the backend connection and account for each configured server. Stdio servers keep their existing behavior.

Save and enable a server in **Settings → MCP Servers**, then select **Sign in** when authentication is required. Background startup and failed tools never open a browser. Expiring access tokens refresh silently; revoked refresh tokens display **Sign in again**, and scope challenges display **Additional permissions required**. Select **Reconnect** to authorize again. A failed call stays failed; subsequent calls use the restored connection and refreshed tool discovery.

## Client registration

Kai tries an explicitly configured client ID first, its hosted client metadata document when the server advertises support, then dynamic client registration. Servers that support neither metadata documents nor dynamic registration need a client ID from the server administrator. Set an optional client secret using **Set client secret** on the saved server; secrets never belong in configuration.

Optional server `oauth` settings:

```json
{
  "name": "example",
  "url": "https://mcp.example.com/mcp",
  "enabled": true,
  "oauth": {
    "clientId": "registered-client-id",
    "scopes": ["read"],
    "callbackHost": "127.0.0.1",
    "callbackPort": 33419
  }
}
```

All OAuth fields are optional. Omit the port to select an available loopback port; pre-registered clients may need an exact fixed port and redirect URI. The callback path is `/callback`. Dynamically registered clients reuse their registered port. `callbackHost` supports `127.0.0.1` and `localhost`.

The default client identity is <https://legionio.github.io/kai-desktop/oauth/client-metadata.json>. GitHub hosts public metadata only. Authorization codes return to the local backend. Forks can change `mcpClientMetadataUrl` in branding; an individual server can override `oauth.clientMetadataUrl` with its own HTTPS document URL. The document must describe the same callback behavior as the client.

## Terminal and remote browser clients

Interactive terminal commands:

```sh
kai mcp list
kai mcp login example
kai mcp login example --no-browser
kai mcp reconnect example --no-browser
kai mcp logout example
kai mcp client-secret example
```

Within the terminal chat, use `/mcp login example`, `/mcp reconnect example`, or `/mcp logout example`. `--no-browser` prints the sign-in link. SSH/headless Linux sessions also avoid opening a browser automatically. Login and client-secret commands require an interactive terminal.

If the browser runs on a different device, the loopback callback may show a connection error after consent. Copy the full address into Kai's **Callback URL** field or terminal prompt. This input is hidden and sent through authenticated IPC; it is never added to the chat transcript. Login attempts expire after five minutes. Cancel closes the listener and invalidates the pending callback.

## Storage and recovery

Credentials are stored separately from configuration in `mcp/credentials.enc` under Kai's application home. Electron's OS-backed secure storage encrypts tokens and registration credentials. The directory and atomic file writes are private. If secure storage cannot be used, Kai reports session-only storage and preserves any existing unreadable vault; unlocking the OS keychain and restarting restores access to persistent credentials.

Credential identity includes the saved server name, endpoint, and OAuth settings; registration is additionally checked against the issuer. Changing identity invalidates affected credentials. Connection tests use the same identity for saved configurations. Save an unsaved configuration before signing in.

A definite HTTP 401 permits one coordinated refresh and one retry. Timeouts, connection loss, and ordinary server errors are not replayed. Transient refresh failures preserve credentials. Sign out clears local tokens and attempts revocation when advertised; the UI explicitly distinguishes local sign-out from confirmed server revocation.

## Deployment and validation

`.github/workflows/mcp-metadata-pages.yml` validates the public identity in PRs and publishes only `site/` on relevant changes to `main`. The deployment verifies HTTPS, JSON content type, and exact content with `node scripts/validate-mcp-metadata.mjs --live`. Enable GitHub Pages with GitHub Actions as its source.

Regression tests use controlled OAuth metadata, registration, token and MCP responses. They cover PKCE, issuer/state checks, credential isolation, rotation, concurrent refresh, cancellation, transient errors, retry bounds, connection replacement, private IPC, and client controls. Before distributing a release, verify the live metadata and run the full test suite, renderer suite, type-check, lint and build. Automated qualification requires no external account sign-ins.
