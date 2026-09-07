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

const localPort = Number(process.argv[2] ?? String(DEFAULT_CLI_TARGET_PORT));
const tunnelId = process.argv[3] ?? "demo";
const tunnelServerBaseUrl = process.env.TUNNEL_SERVER_URL ?? "ws://localhost:8080";
const authToken = process.env.TUNNEL_AUTH_TOKEN ?? DEFAULT_AUTH_TOKEN;
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
