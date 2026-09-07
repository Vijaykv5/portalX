# Portlex

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
PORTLEX_SERVER_URL=ws://localhost:8081 bun run portlex -- http 3000
```

When installed as a package binary, the command shape becomes:

```bash
portlex http 3000
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
PORT=8081 PORTLEX_AUTH_TOKEN=secret123 bun run server
```

CLI:

```bash
PORTLEX_SERVER_URL=ws://localhost:8081 PORTLEX_AUTH_TOKEN=secret123 bun run portlex -- http 3000
```

Arguments:

```txt
bun run portlex -- http <local-port>
```

CLI options:

```bash
bun run portlex -- --help
bun run portlex -- http 3000
bun run portlex -- http --port 5173 --server ws://localhost:8081
```

When installed as a package binary, the command shape becomes:

```bash
portlex http 3000
portlex http --port 5173 --server ws://localhost:8081
```

Examples:

```bash
bun run portlex -- http 3000
bun run portlex -- http 5173
bun run portlex -- http 8000
```

Only one CLI connection can be active at a time. If another terminal tries to run `portlex http 3001` while `portlex http 3000` is already connected, the server rejects the second connection.

## Status

Check active tunnels:

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
  "pendingRequests": 0,
}
```

## Connect Check

The CLI checks whether it can connect before opening the WebSocket:

```txt
http://localhost:8081/_connect-check?token=dev-token
```

This returns `200` when the server can accept a tunnel, `401` for a bad token, and `409` when another CLI is already connected.

## Test

Run the end-to-end smoke test:

```bash
bun run test:smoke
```

The test starts a temporary tunnel server, a temporary local app, and a CLI process. It verifies connection preflight, path forwarding, query forwarding, POST body forwarding, single-connection protection, status reporting, and oversized request rejection.

## What Works

- One active tunnel connection
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
- No user accounts or plan tiers yet
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
4. Add accounts, plan limits, and stronger auth.
5. Add request metrics and prettier CLI output.
6. Package and publish the CLI.
