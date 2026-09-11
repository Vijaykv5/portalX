# Portalx

A lightweight ngrok-style HTTP tunneling prototype built with Bun.

The server accepts public HTTP traffic and forwards it over a WebSocket to one CLI process running on your machine. The CLI calls your local app, captures the response, and sends it back through the tunnel.

```txt
Browser -> tunnel server -> WebSocket -> CLI -> localhost app
Browser <- tunnel server <- WebSocket <- CLI <- localhost app
```

## Install

```bash
bun install
```

## Run

Start the tunnel server:

```bash
PORT=8081 bun run server
```

Start any local app:

```bash
bun --eval 'Bun.serve({ port: 3000, fetch: req => new Response("Hello from local app: " + new URL(req.url).pathname) }); console.log("local app on 3000")'
```

Start the tunnel CLI:

```bash
PORTALX_SERVER_URL=ws://localhost:8081 bun run portalx -- http 3000
```

When installed as a package binary, the command shape becomes:

```bash
portalx http 3000
```

By default, the published CLI connects to:

```txt
wss://relay.vijaykv.xyz
```

For hosted Portalx, log in once:

```bash
portalx login
portalx http 3000
```

Open:

```txt
http://localhost:8081
```

That request is forwarded to:

```txt
http://localhost:3000/
```

Try another path:

```txt
http://localhost:8081/api/users
```

That is forwarded to:

```txt
http://localhost:3000/api/users
```

## Configuration

Server:

```bash
PORT=8081 PORTALX_AUTH_TOKEN=secret123 bun run server
```

CLI:

```bash
PORTALX_SERVER_URL=ws://localhost:8081 PORTALX_AUTH_TOKEN=secret123 bun run portalx -- http 3000
```

For local/manual testing, save the token once:

```bash
portalx config set authToken secret123
portalx http 3000
```

For hosted Portalx, prefer browser login:

```bash
portalx login
portalx http 3000
```

Arguments:

```txt
bun run portalx -- http <local-port>
```

CLI options:

```bash
bun run portalx -- --help
bun run portalx -- --version
portalx login
bun run portalx -- http 3000
bun run portalx -- http --port 5173 --server ws://localhost:8081
portalx config set serverUrl wss://relay.vijaykv.xyz
portalx config set apiUrl https://api.vijaykv.xyz
portalx config set authToken secret123
portalx config get
portalx config path
```

When installed as a package binary, the command shape becomes:

```bash
portalx http 3000
portalx http --port 5173 --server ws://localhost:8081
```

Examples:

```bash
bun run portalx -- http 3000
bun run portalx -- http 5173
bun run portalx -- http 8000
```

Only one CLI connection can be active at a time. If another terminal tries to run `portalx http 3001` while `portalx http 3000` is already connected, the server rejects the second connection.

## Config File

Portalx reads optional defaults from:

```txt
~/.portalx/config.json
```

Example:

```json
{
  "localPort": 3000,
  "serverUrl": "wss://relay.vijaykv.xyz",
  "apiUrl": "https://api.vijaykv.xyz",
  "authToken": "secret123"
}
```

Create that file through the CLI:

```bash
portalx config set serverUrl wss://relay.vijaykv.xyz
portalx config set apiUrl https://api.vijaykv.xyz
portalx config set authToken secret123
portalx config set localPort 3000
```

You can point to a different config file with:

```bash
PORTALX_CONFIG=/path/to/config.json portalx http
```

Precedence is:

```txt
defaults -> config file -> environment variables -> CLI flags
```

## Status

Check the active connection:

```txt
http://localhost:8081/_status
```

Example response:

```json
{
  "status": "ok",
  "activeConnection": {
    "connectedAt": "2026-09-07T13:57:29.000Z",
    "requestCount": 3,
    "lastRequestAt": "2026-09-07T13:58:10.000Z"
  },
  "pendingRequests": 0
}
```

## Connect Check

The CLI checks whether it can connect before opening the WebSocket:

```txt
http://localhost:8081/_connect-check?token=dev-token
```

This returns `200` when the server can accept a tunnel, `401` for a bad token, and `409` when another CLI is already connected.

## Hosted Login

The Cloudflare Worker relay includes a first-pass GitHub OAuth login flow for the CLI. This version does not use a database yet; it keeps short-lived CLI login sessions in the Worker Durable Object and issues signed Portalx tunnel tokens.

GitHub OAuth app settings:

```txt
Homepage URL: https://portalx.vijaykv.xyz
Authorization callback URL: https://api.vijaykv.xyz/auth/github/callback
```

Cloudflare routes:

```txt
portalx.vijaykv.xyz  -> Cloudflare Pages frontend
api.vijaykv.xyz      -> Portalx Worker auth API
relay.vijaykv.xyz    -> Portalx Worker relay
*.tunnel.vijaykv.xyz -> Portalx tunnel URLs
```

Worker secrets:

```bash
bunx wrangler secret put GITHUB_CLIENT_ID
bunx wrangler secret put GITHUB_CLIENT_SECRET
bunx wrangler secret put PORTALX_TOKEN_SECRET
bun run worker:deploy
```

CLI flow:

```bash
portalx login
portalx http 3000
```

The CLI opens GitHub login, polls `https://api.vijaykv.xyz/cli/session/<id>`, then saves the returned token to `~/.portalx/config.json`.

Tunnel URLs are generated under:

```txt
https://<random>.tunnel.vijaykv.xyz
```

## Test

Run the end-to-end smoke test:

```bash
bun run test:smoke
```

The test starts a temporary tunnel server, a temporary local app, and a CLI process. It verifies connection preflight, path forwarding, query forwarding, POST body forwarding, single-connection protection, status reporting, and oversized request rejection.

## What Works

- One active tunnel connection
- GitHub OAuth CLI login without a database
- Shared auth token for CLI connections
- Configurable server port
- Configurable local target port
- Request IDs for concurrent request matching
- Request timeout handling
- Second connection protection
- CLI reconnects after disconnect
- Clean CLI and server shutdown on `Ctrl+C`
- Safer forwarded headers
- 1MB request body limit
- Base64 transport for request and response bodies

## Current Limits

- HTTP only
- No public deployment setup yet
- No TLS/domain/subdomain support yet
- No persistent account database or plan tiers yet
- No streaming request or response bodies yet
- WebSocket traffic through the tunnel is not supported yet

## Project Structure

```txt
apps/server/src/index.ts
  Public HTTP server and WebSocket tunnel router

apps/cli/src/index.ts
  Local tunnel client that forwards requests to localhost

packages/protocol/src/index.ts
  Shared message types, validation, body helpers, and header filtering
```

## Roadmap

1. Add public deployment with a real hosted URL.
2. Add TLS and deploy the server to a public VPS.
3. Add streaming body support for large uploads/downloads.
4. Persist users, sessions, and token hashes in Cloudflare D1.
5. Add request metrics and prettier CLI output.
6. Package and publish the CLI.
