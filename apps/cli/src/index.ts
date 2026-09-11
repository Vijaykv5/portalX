#!/usr/bin/env bun

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
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

const VERSION = "0.1.4";
const DEFAULT_TUNNEL_SERVER_URL = "wss://relay.vijaykv.xyz";
const DEFAULT_API_URL = "https://api.vijaykv.xyz";

type CliConfig = {
    command: "http";
    localPort: number;
    tunnelServerBaseUrl: string;
    authToken: string;
};

type FileConfig = {
    localPort?: number | string;
    serverUrl?: string;
    apiUrl?: string;
    authToken?: string;
};

type ConfigKey = keyof FileConfig;

const configKeys = new Set(["localPort", "serverUrl", "apiUrl", "authToken"]);

function printHelp() {
    console.log(`Portalx ${VERSION}

Usage:
  portalx login
  portalx http <port>
  portalx http --port <port>
  portalx config set <key> <value>
  portalx config get
  portalx config path

Options:
  -p, --port <port>      Local port to forward to
  -s, --server <url>     Portalx server URL
      --token <token>    Auth token for the Portalx server
  -v, --version          Show version
  -h, --help             Show help

Config:
  ~/.portalx/config.json
  PORTALX_CONFIG         Override config file path
  keys: serverUrl, apiUrl, authToken, localPort

Environment:
  PORTALX_SERVER_URL     Defaults to ${DEFAULT_TUNNEL_SERVER_URL}
  PORTALX_API_URL        Defaults to ${DEFAULT_API_URL}
  PORTALX_AUTH_TOKEN     Defaults to dev-token
  PORTALX_LOCAL_PORT     Defaults to 3000

Examples:
  portalx login
  portalx http 3000
  portalx config set authToken secret123
  portalx config set serverUrl wss://relay.vijaykv.xyz
`);
}

function printVersion() {
    console.log(`portalx ${VERSION}`);
}

function getConfigPath() {
    return process.env.PORTALX_CONFIG ?? process.env.PORTLEX_CONFIG ?? join(homedir(), ".portalx", "config.json");
}

function readFileConfig(): FileConfig {
    const configPath = getConfigPath();

    if (!existsSync(configPath)) {
        return {};
    }

    try {
        return JSON.parse(readFileSync(configPath, "utf8")) as FileConfig;
    } catch {
        console.error(`Could not read Portalx config at ${configPath}`);
        process.exit(1);
    }
}

function writeFileConfig(config: FileConfig) {
    const configPath = getConfigPath();

    mkdirSync(dirname(configPath), {
        recursive: true,
    });
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

function maskConfig(config: FileConfig) {
    return {
        ...config,
        authToken: config.authToken ? "********" : undefined,
    };
}

function parseConfigKey(value: string | undefined): ConfigKey {
    if (!value || !configKeys.has(value)) {
        console.error("Config key must be one of: serverUrl, authToken, localPort");
        process.exit(1);
    }

    return value as ConfigKey;
}

function runConfigCommand(args: string[]) {
    const subcommand = args[1];

    if (!subcommand || subcommand === "--help" || subcommand === "-h") {
        console.log(`Portalx config

Usage:
  portalx config set <key> <value>
  portalx config get
  portalx config path

Keys:
  serverUrl
  apiUrl
  authToken
  localPort
`);
        process.exit(subcommand ? 0 : 1);
    }

    if (subcommand === "path") {
        console.log(getConfigPath());
        process.exit(0);
    }

    if (subcommand === "get") {
        console.log(JSON.stringify(maskConfig(readFileConfig()), null, 2));
        process.exit(0);
    }

    if (subcommand === "set") {
        const key = parseConfigKey(args[2]);
        const value = args[3];

        if (!value) {
            console.error("Config set requires a value");
            process.exit(1);
        }

        if (key === "localPort" && !isValidPort(Number(value))) {
            console.error("localPort must be a number between 1 and 65535");
            process.exit(1);
        }

        const nextConfig = {
            ...readFileConfig(),
            [key]: key === "localPort" ? Number(value) : value,
        };

        writeFileConfig(nextConfig);
        console.log(`Saved ${key} to ${getConfigPath()}`);
        process.exit(0);
    }

    console.error(`Unknown config command: ${subcommand}`);
    console.error("Run portalx config --help for usage.");
    process.exit(1);
}

type LoginSessionResponse = {
    status: "pending" | "approved" | "expired";
    token?: string;
    user?: {
        id?: number;
        username?: string;
    };
};

function getApiUrl(fileConfig: FileConfig) {
    return process.env.PORTALX_API_URL ?? process.env.PORTLEX_API_URL ?? fileConfig.apiUrl ?? DEFAULT_API_URL;
}

function openBrowser(url: string) {
    const platform = process.platform;
    const command = platform === "darwin"
        ? ["open", url]
        : platform === "win32"
            ? ["cmd", "/c", "start", "", url]
            : ["xdg-open", url];

    Bun.spawn(command, {
        stdout: "ignore",
        stderr: "ignore",
    });
}

function wait(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runLoginCommand(args: string[], fileConfig: FileConfig) {
    let apiUrl = getApiUrl(fileConfig);

    for (let index = 1; index < args.length; index++) {
        const arg = args[index];

        if (arg === "--help" || arg === "-h") {
            console.log(`Portalx login

Usage:
  portalx login
  portalx login --api <url>
`);
            process.exit(0);
        }

        if (arg === "--api") {
            apiUrl = readOptionValue(args, index, arg);
            index++;
            continue;
        }

        if (arg?.startsWith("-")) {
            console.error(`Unknown option: ${arg}`);
            process.exit(1);
        }
    }

    const sessionId = crypto.randomUUID();
    const loginUrl = new URL("/auth/github/start", apiUrl);
    loginUrl.searchParams.set("session", sessionId);

    console.log("Opening GitHub login...");
    console.log(loginUrl.toString());
    openBrowser(loginUrl.toString());

    const sessionUrl = new URL(`/cli/session/${sessionId}`, apiUrl);
    const deadline = Date.now() + 10 * 60 * 1000;

    while (Date.now() < deadline) {
        await wait(2_000);

        const response = await fetch(sessionUrl);

        if (response.status === 404) {
            console.error("Login session expired. Run portalx login again.");
            process.exit(1);
        }

        if (!response.ok) {
            console.error(await response.text());
            process.exit(1);
        }

        const session = await response.json() as LoginSessionResponse;

        if (session.status === "pending") {
            continue;
        }

        if (session.status !== "approved" || !session.token) {
            console.error("Login was not approved. Run portalx login again.");
            process.exit(1);
        }

        writeFileConfig({
            ...fileConfig,
            apiUrl,
            serverUrl: fileConfig.serverUrl ?? DEFAULT_TUNNEL_SERVER_URL,
            authToken: session.token,
        });

        console.log(`Logged in${session.user?.username ? ` as @${session.user.username}` : ""}`);
        console.log(`Saved Portalx token to ${getConfigPath()}`);
        process.exit(0);
    }

    console.error("Timed out waiting for GitHub login. Run portalx login again.");
    process.exit(1);
}

function readOptionValue(args: string[], index: number, optionName: string) {
    const value = args[index + 1];

    if (!value || value.startsWith("-")) {
        console.error(`${optionName} requires a value`);
        process.exit(1);
    }

    return value;
}

async function parseCliArgs(args: string[]): Promise<CliConfig> {
    const fileConfig = readFileConfig();
    const positionalArgs: string[] = [];
    let command = args[0];
    let localPort = process.env.PORTALX_LOCAL_PORT ?? process.env.PORTLEX_LOCAL_PORT ?? String(fileConfig.localPort ?? DEFAULT_CLI_TARGET_PORT);
    let tunnelServerBaseUrl = process.env.PORTALX_SERVER_URL ?? process.env.PORTLEX_SERVER_URL ?? process.env.TUNNEL_SERVER_URL ?? fileConfig.serverUrl ?? DEFAULT_TUNNEL_SERVER_URL;
    let authToken = process.env.PORTALX_AUTH_TOKEN ?? process.env.PORTLEX_AUTH_TOKEN ?? process.env.TUNNEL_AUTH_TOKEN ?? fileConfig.authToken ?? DEFAULT_AUTH_TOKEN;

    if (command === "--version" || command === "-v") {
        printVersion();
        process.exit(0);
    }

    if (!command || command === "--help" || command === "-h") {
        printHelp();
        process.exit(command ? 0 : 1);
    }

    if (command === "config") {
        runConfigCommand(args);
    }

    if (command === "login") {
        await runLoginCommand(args, fileConfig);
    }

    if (command !== "http") {
        console.error(`Unknown command: ${command}`);
        console.error("Run portalx --help for usage.");
        process.exit(1);
    }

    for (let index = 1; index < args.length; index++) {
        const arg = args[index];

        if (!arg) {
            continue;
        }

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
            console.error("Run portalx --help for usage.");
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

const config = await parseCliArgs(process.argv.slice(2));
const { localPort, tunnelServerBaseUrl, authToken } = config;
const localTargetUrl = `http://localhost:${localPort}`;
const reconnectDelayMs = 1_000;
let activeSocket: WebSocket | null = null;
let isShuttingDown = false;

function printStartup(publicUrl?: string) {
    console.log("");
    console.log(`Portalx ${VERSION}`);
    console.log(`Local:   ${localTargetUrl}`);
    console.log(`Server:  ${tunnelServerBaseUrl}`);

    if (publicUrl) {
        console.log(`Public:  ${publicUrl}`);
        console.log(`Forward: ${publicUrl} -> ${localTargetUrl}`);
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
    console.error("Portalx server URL must be a valid URL, like ws://localhost:8080");
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
        console.error(`Could not reach Portalx server at ${tunnelServerBaseUrl}`);
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
        console.log("Could not connect to Portalx server");
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
