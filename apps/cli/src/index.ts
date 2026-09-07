#!/usr/bin/env bun

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
    DEFAULT_AUTH_TOKEN,
    DEFAULT_CLI_TARGET_PORT,
    base64ToBody,
    filterForwardHeaders,
    isValidPort,
    responseBodyToBase64,
    websocketUrlToHttpUrl,
    type ServerMessage,
    type TunnelRequestMessage,
    type TunnelResponseMessage,
} from "../../../packages/protocol/src/index";

const VERSION = "0.1.0";

type CliConfig = {
    command: "http";
    localPort: number;
    tunnelServerBaseUrl: string;
    authToken: string;
};

type FileConfig = {
    localPort?: number | string;
    serverUrl?: string;
    authToken?: string;
};

function printHelp() {
    console.log(`Portlex ${VERSION}

Usage:
  portlex http <port>
  portlex http --port <port>

Options:
  -p, --port <port>      Local port to forward to
  -s, --server <url>     Portlex server URL
      --token <token>    Auth token for the Portlex server
  -v, --version          Show version
  -h, --help             Show help

Config:
  ~/.portlex/config.json
  PORTLEX_CONFIG         Override config file path

Environment:
  PORTLEX_SERVER_URL     Defaults to ws://localhost:8080
  PORTLEX_AUTH_TOKEN     Defaults to dev-token
  PORTLEX_LOCAL_PORT     Defaults to 3000

Examples:
  portlex http 3000
  portlex http --port 5173 --server ws://localhost:8081
`);
}

function printVersion() {
    console.log(`portlex ${VERSION}`);
}

function getConfigPath() {
    return process.env.PORTLEX_CONFIG ?? join(homedir(), ".portlex", "config.json");
}

function readFileConfig(): FileConfig {
    const configPath = getConfigPath();

    if (!existsSync(configPath)) {
        return {};
    }

    try {
        return JSON.parse(readFileSync(configPath, "utf8")) as FileConfig;
    } catch {
        console.error(`Could not read Portlex config at ${configPath}`);
        process.exit(1);
    }
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
    const fileConfig = readFileConfig();
    const positionalArgs: string[] = [];
    let command = args[0];
    let localPort = process.env.PORTLEX_LOCAL_PORT ?? String(fileConfig.localPort ?? DEFAULT_CLI_TARGET_PORT);
    let tunnelServerBaseUrl = process.env.PORTLEX_SERVER_URL ?? process.env.TUNNEL_SERVER_URL ?? fileConfig.serverUrl ?? "ws://localhost:8080";
    let authToken = process.env.PORTLEX_AUTH_TOKEN ?? process.env.TUNNEL_AUTH_TOKEN ?? fileConfig.authToken ?? DEFAULT_AUTH_TOKEN;

    if (command === "--version" || command === "-v") {
        printVersion();
        process.exit(0);
    }

    if (!command || command === "--help" || command === "-h") {
        printHelp();
        process.exit(command ? 0 : 1);
    }

    if (command !== "http") {
        console.error(`Unknown command: ${command}`);
        console.error("Run portlex --help for usage.");
        process.exit(1);
    }

    for (let index = 1; index < args.length; index++) {
        const arg = args[index];

        if (arg === "--help" || arg === "-h") {
            printHelp();
            process.exit(0);
        }

        if (arg === "--version" || arg === "-v") {
            printVersion();
            process.exit(0);
        }

        if (arg === "--port" || arg === "-p") {
            localPort = readOptionValue(args, index, arg);
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
            console.error("Run portlex --help for usage.");
            process.exit(1);
        }

        positionalArgs.push(arg);
    }

    localPort = positionalArgs[0] ?? localPort;

    return {
        command,
        localPort: Number(localPort),
        tunnelServerBaseUrl,
        authToken,
    };
}

const config = parseCliArgs(process.argv.slice(2));
const { localPort, tunnelServerBaseUrl, authToken } = config;
const localTargetUrl = `http://localhost:${localPort}`;
const reconnectDelayMs = 1_000;
let activeSocket: WebSocket | null = null;
let isShuttingDown = false;

function printStartup(publicUrl?: string) {
    console.log("");
    console.log(`Portlex ${VERSION}`);
    console.log(`Local:   ${localTargetUrl}`);
    console.log(`Server:  ${tunnelServerBaseUrl}`);

    if (publicUrl) {
        console.log(`Public:  ${publicUrl}`);
    }

    console.log("Status:  connected");
    console.log("");
}

function logRequest(method: string, path: string, status: number, durationMs: number) {
    console.log(`${method.padEnd(6)} ${String(status).padEnd(3)} ${String(`${durationMs}ms`).padStart(6)}  ${path}`);
}

function buildTunnelServerUrl() {
    const url = new URL("/tunnel", tunnelServerBaseUrl);

    url.searchParams.set("token", authToken);

    return url.toString();
}

function buildConnectCheckUrl() {
    const url = websocketUrlToHttpUrl(tunnelServerBaseUrl);

    url.pathname = "/_connect-check";
    url.search = "";
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

try {
    new URL(tunnelServerBaseUrl);
} catch {
    console.error("Portlex server URL must be a valid URL, like ws://localhost:8080");
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

        logRequest(message.method, message.path, localResponse.status, durationMs);

        return {
            type: "http_response",
            requestId: message.requestId,
            status: localResponse.status,
            headers: filterForwardHeaders(localResponse.headers),
            bodyBase64: await responseBodyToBase64(localResponse),
        };
    } catch (error) {
        const durationMs = Math.round(performance.now() - startedAt);

        logRequest(message.method, message.path, 502, durationMs);

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

async function runConnectCheck() {
    try {
        const response = await fetch(buildConnectCheckUrl());

        if (response.ok) {
            return true;
        }

        console.error(await response.text());
        return false;
    } catch {
        console.error(`Could not reach Portlex server at ${tunnelServerBaseUrl}`);
        return false;
    }
}

async function connect() {
    const canConnect = await runConnectCheck();

    if (!canConnect) {
        process.exit(1);
    }

    const tunnelServerUrl = buildTunnelServerUrl();
    const socket = new WebSocket(tunnelServerUrl);
    activeSocket = socket;

    socket.addEventListener("message", async (event) => {
        const message = parseServerMessage(event.data);

        if (!message) {
            return;
        }

        if (message.type === "connected") {
            printStartup(message.publicUrl);
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
        if (activeSocket === socket) {
            activeSocket = null;
        }

        if (isShuttingDown) {
            return;
        }

        console.log(`Status:  disconnected. Reconnecting in ${reconnectDelayMs}ms...`);
        setTimeout(connect, reconnectDelayMs);
    });

    socket.addEventListener("error", () => {
        console.log("Could not connect to Portlex server");
    });
}

function shutdown() {
    if (isShuttingDown) {
        return;
    }

    isShuttingDown = true;
    console.log("Closing tunnel...");

    if (activeSocket && activeSocket.readyState === WebSocket.OPEN) {
        activeSocket.close();
    }

    console.log("Tunnel closed");
    process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

connect();
