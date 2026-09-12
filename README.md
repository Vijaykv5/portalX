# Portalx

Share localhost with a public URL.

Portalx is a lightweight tunneling CLI for previewing local apps, testing webhooks, and sharing demos without deploying them first.

```txt
https://random-name.vijaykv.xyz -> http://localhost:3000
```

## Install

```bash
npm install -g @vijaykv/portalx
```

Portalx currently runs with Bun. If Bun is not installed:

```bash
curl -fsSL https://bun.sh/install | bash
```

## Usage

Start your local app, then run:

```bash
portalx http 3000
```

Portalx prints a public URL that forwards requests to your local server.

```txt
Local:  http://localhost:3000
Public: https://random-name.vijaykv.xyz
```

## What It Does

- Creates a public URL for a local HTTP server
- Forwards browser requests back to your machine
- Works well for demos, API testing, and webhook development
- Allows one active tunnel session at a time

## Status

Portalx is early and currently supports HTTP tunneling only.
