#!/usr/bin/env bun

import {
    DEFAULT_AUTH_TOKEN,
    DEFAULT_CLI_TARGET_PORT,
    base64ToBody,
    filterForwardHeaders,
    isValidPort,
    isValidTunnelId,
    responseBodyToBase64,
    type ServerMessage,
    type TunnelRequestMessage,
    type TunnelResponseMessage,
} from "../../../packages/protocol/src/index";

type CliConfig = {
    localPort: number;
    tunnelId: string;
    tunnelServerBaseUrl: string;
    authToken: string;
};

function printHelp() {
    console.log(`Tunnel

Usage:
  tunnel <port> [tunnel-id]
  tunnel --port <port> --name <tunnel-id>

Options:
  -p, --port <port>      Local port to forward to
  -n, --name <id>        Tunnel ID used in /t/:id
  -s, --server <url>     Tunnel server URL
      --token <token>    Auth token for the tunnel server
  -h, --help             Show help

Environment:
  TUNNEL_SERVER_URL      Defaults to ws://localhost:8080
  TUNNEL_AUTH_TOKEN      Defaults to dev-token

Examples:
  tunnel 3000 demo
  tunnel --port 5173 --name vite --server ws://localhost:8081
`);
}

function readOptionValue(args: string[], index: number, optionName: string) {
    const value = args[index + 1];

    if (!value || value.startsWith("-")) {
        console.error(`${optionName} requires a value`);
        process.exit(1);
    }

    return value;
}

function parseCliArgs(args: string[]): CliConfig {
    const positionalArgs: string[] = [];
    let localPort = process.env.TUNNEL_LOCAL_PORT ?? String(DEFAULT_CLI_TARGET_PORT);
    let tunnelId = process.env.TUNNEL_ID ?? "demo";
    let tunnelServerBaseUrl = process.env.TUNNEL_SERVER_URL ?? "ws://localhost:8080";
    let authToken = process.env.TUNNEL_AUTH_TOKEN ?? DEFAULT_AUTH_TOKEN;

    for (let index = 0; index < args.length; index++) {
        const arg = args[index];

        if (arg === "--help" || arg === "-h") {
            printHelp();
            process.exit(0);
        }

        if (arg === "--port" || arg === "-p") {
            localPort = readOptionValue(args, index, arg);
            index++;
            continue;
        }

        if (arg === "--name" || arg === "--id" || arg === "-n") {
            tunnelId = readOptionValue(args, index, arg);
            index++;
            continue;
        }

        if (arg === "--server" || arg === "-s") {
            tunnelServerBaseUrl = readOptionValue(args, index, arg);
            index++;
            continue;
        }

        if (arg === "--token") {
            authToken = readOptionValue(args, index, arg);
            index++;
            continue;
        }

        if (arg.startsWith("-")) {
            console.error(`Unknown option: ${arg}`);
            console.error("Run tunnel --help for usage.");
            process.exit(1);
        }

        positionalArgs.push(arg);
    }

    localPort = positionalArgs[0] ?? localPort;
    tunnelId = positionalArgs[1] ?? tunnelId;

    return {
        localPort: Number(localPort),
        tunnelId,
        tunnelServerBaseUrl,
        authToken,
    };
}

const config = parseCliArgs(process.argv.slice(2));
const { localPort, tunnelId, tunnelServerBaseUrl, authToken } = config;
const localTargetUrl = `http://localhost:${localPort}`;
const reconnectDelayMs = 1_000;

function buildTunnelServerUrl() {
    const url = new URL("/tunnel", tunnelServerBaseUrl);

    url.searchParams.set("id", tunnelId);
    url.searchParams.set("token", authToken);

    return url.toString();
}

function parseServerMessage(data: unknown) {
    try {
        return JSON.parse(String(data)) as ServerMessage;
    } catch {
        return null;
    }
}

function getRequestBody(message: TunnelRequestMessage) {
    if (message.method === "GET" || message.method === "HEAD") {
        return undefined;
    }

    return base64ToBody(message.bodyBase64);
}

if (!isValidPort(localPort)) {
    console.error("Local port must be a number between 1 and 65535");
    process.exit(1);
}

if (!isValidTunnelId(tunnelId)) {
    console.error("Tunnel id must be 3-40 characters and only use letters, numbers, dashes, or underscores");
    process.exit(1);
}

try {
    new URL(tunnelServerBaseUrl);
} catch {
    console.error("Tunnel server URL must be a valid URL, like ws://localhost:8080");
    process.exit(1);
}

async function forwardToLocalApp(message: TunnelRequestMessage): Promise<TunnelResponseMessage> {
    const startedAt = performance.now();

    try {
        const localResponse = await fetch(`${localTargetUrl}${message.path}`, {
            method: message.method,
            headers: filterForwardHeaders(new Headers(message.headers)),
            body: getRequestBody(message),
        });
        const durationMs = Math.round(performance.now() - startedAt);

        console.log(`${message.method} ${message.path} ${localResponse.status} ${durationMs}ms`);

        return {
            type: "http_response",
            requestId: message.requestId,
            status: localResponse.status,
            headers: filterForwardHeaders(localResponse.headers),
            bodyBase64: await responseBodyToBase64(localResponse),
        };
    } catch (error) {
        const durationMs = Math.round(performance.now() - startedAt);

        console.log(`${message.method} ${message.path} 502 ${durationMs}ms`);

        return {
            type: "http_response",
            requestId: message.requestId,
            status: 502,
            headers: {
                "content-type": "text/plain",
            },
            bodyBase64: Buffer.from(`Could not reach local app at ${localTargetUrl}\n\n${String(error)}`).toString("base64"),
        };
    }
}

function connect() {
    const tunnelServerUrl = buildTunnelServerUrl();
    const socket = new WebSocket(tunnelServerUrl);

    socket.addEventListener("open", () => {
        console.log(`Connected to tunnel server at ${tunnelServerBaseUrl}`);
        console.log(`Forwarding requests to ${localTargetUrl}`);
        console.log(`Tunnel id: ${tunnelId}`);
    });

    socket.addEventListener("message", async (event) => {
        const message = parseServerMessage(event.data);

        if (!message) {
            return;
        }

        if (message.type === "connected") {
            console.log(message.message);
            return;
        }

        if (message.type !== "http_request") {
            return;
        }

        const tunnelResponse = await forwardToLocalApp(message);

        if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify(tunnelResponse));
        }
    });

    socket.addEventListener("close", () => {
        console.log(`Disconnected from tunnel server. Reconnecting in ${reconnectDelayMs}ms...`);
        setTimeout(connect, reconnectDelayMs);
    });

    socket.addEventListener("error", () => {
        console.log("Could not connect to tunnel server");
    });
}

connect();
