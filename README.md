# Tunnel

A lightweight ngrok-style HTTP tunneling prototype built with Bun.

The server accepts public HTTP traffic and forwards it over a WebSocket to a CLI process running on your machine. The CLI calls your local app, captures the response, and sends it back through the tunnel.

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
TUNNEL_SERVER_URL=ws://localhost:8081 bun run cli -- 3000 demo
```

Open:

```txt
http://localhost:8081/t/demo
```

That request is forwarded to:

```txt
http://localhost:3000/
```

Try another path:

```txt
http://localhost:8081/t/demo/api/users
```

That is forwarded to:

```txt
http://localhost:3000/api/users
```

## Configuration

Server:

```bash
PORT=8081 TUNNEL_AUTH_TOKEN=secret123 bun run server
```

CLI:

```bash
TUNNEL_SERVER_URL=ws://localhost:8081 TUNNEL_AUTH_TOKEN=secret123 bun run cli -- 3000 demo
```

Arguments:

```txt
bun run cli -- <local-port> <tunnel-id>
```

Examples:

```bash
bun run cli -- 3000 demo
bun run cli -- 5173 vite
bun run cli -- 8000 api
```

Tunnel IDs must be 3-40 characters and can only use letters, numbers, dashes, and underscores.

## What Works

- Multiple tunnel IDs with `/t/:tunnelId/...` routing
- Shared auth token for CLI connections
- Configurable server port
- Configurable local target port
- Request IDs for concurrent request matching
- Request timeout handling
- Duplicate tunnel ID protection
- CLI reconnects after disconnect
- Safer forwarded headers
- 1MB request body limit
- Base64 transport for request and response bodies

## Current Limits

- HTTP only
- No public deployment setup yet
- No TLS/domain/subdomain support yet
- No user accounts or per-user tunnel ownership yet
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

1. Add real subdomain routing.
2. Add TLS and deploy the server to a public VPS.
3. Add streaming body support for large uploads/downloads.
4. Add reserved tunnel names and stronger auth.
5. Add request metrics and prettier CLI output.
6. Package the CLI as an installable command.
