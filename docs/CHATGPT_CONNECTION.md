# Connecting an MCP client / ChatGPT

The production endpoint is the public HTTPS URL ending in `/mcp`, for example:

```text
https://mcp.wandora.com.br/mcp
```

The service publishes OAuth authorization-server and protected-resource metadata under `/.well-known/` and supports OAuth 2.1 authorization code + PKCE S256, Dynamic Client Registration and rotating refresh tokens.

## Before connecting

Confirm that:

1. DNS/TLS reaches the Remote Ops MCP reverse proxy.
2. `AUTH_MODE=oauth`.
3. `PUBLIC_BASE_URL` exactly matches the public origin, without a path suffix.
4. `MCP_PASSWORD`, `ADMIN_PASSWORD` and `AUTH_SECRET` are present only in the deployment secret/environment layer.
5. `/healthz` returns healthy and the server is running with the intended production image digest.

## Connector flow

In an MCP-capable client, create a custom remote MCP connection using the `/mcp` URL. The client should discover the OAuth metadata and dynamically register a redirect URI. When redirected to the Remote Ops authorization page, enter the **MCP authorization password**, not the admin-console password.

After approval, the client exchanges the one-time code using PKCE. The server returns an access token and a rotating refresh token. Raw refresh tokens are never written to durable state.

## ChatGPT notes

The exact ChatGPT menu and plan/workspace availability can change independently of this server. Use the current ChatGPT **Developer mode / custom MCP app** flow exposed in your account. The connector URL remains the same.

A successful connection should be validated with low-authority calls first:

```text
List the available targets.
Show target_status for wandora-prod.
Show disk usage for wandora-prod.
```

Do not add write tools merely to make initial testing easier. Use `MOCK_MODE=1` when the remote transport itself is not yet ready.

## Revocation

Open `/admin` and revoke either the specific session/client or all clients. Because every MCP request checks current persisted session state, a currently valid JWT stops working immediately after revocation.

If a target itself should become unreachable through MCP, revoke the device in the Devices view. This closes the pooled SSH connection and blocks future tool calls until re-enabled. A target disabled in `targets.json` cannot be enabled from the UI.
