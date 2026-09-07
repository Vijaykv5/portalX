type TunnelRequestMessage = {
    type: "http_request";
    requestId: string;
    method: string;
    path: string;
    headers: Record<string, string>;
    body: string;
};

type TunnelResponseMessage = {
    type: "http_response";
    requestId: string;
    status: number;
    headers: Record<string, string>;
    body: string;
};

type ServerMessage =
    | TunnelRequestMessage
    | {
          type: "connected";
          message: string;
      };

const localPort = process.argv[2] ?? "3000";
const tunnelId = process.argv[3] ?? "demo";
const tunnelServerBaseUrl = process.env.TUNNEL_SERVER_URL ?? "ws://localhost:8080";
const authToken = process.env.TUNNEL_AUTH_TOKEN ?? "dev-token";
const tunnelServerUrl = `${tunnelServerBaseUrl}/tunnel?id=${encodeURIComponent(tunnelId)}&token=${encodeURIComponent(authToken)}`;
const localTargetUrl = `http://localhost:${localPort}`;

function isValidTunnelId(tunnelId: string) {
    return /^[a-zA-Z0-9_-]{3,40}$/.test(tunnelId);
}

function headersToObject(headers: Headers) {
    return Object.fromEntries(headers.entries());
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
            headers: message.headers,
            body: message.body || undefined,
        });
        const durationMs = Math.round(performance.now() - startedAt);

        console.log(`${message.method} ${message.path} ${localResponse.status} ${durationMs}ms`);

        return {
            type: "http_response",
            requestId: message.requestId,
            status: localResponse.status,
            headers: headersToObject(localResponse.headers),
            body: await localResponse.text(),
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
            body: `Could not reach local app at ${localTargetUrl}\n\n${String(error)}`,
        };
    }
}

const socket = new WebSocket(tunnelServerUrl);

socket.addEventListener("open", () => {
    console.log(`Connected to tunnel server at ${tunnelServerBaseUrl}`);
    console.log(`Forwarding requests to ${localTargetUrl}`);
    console.log(`Tunnel id: ${tunnelId}`);
});

socket.addEventListener("message", async (event) => {
    const message = JSON.parse(String(event.data)) as ServerMessage;

    if (message.type === "connected") {
        console.log(message.message);
        return;
    }

    if (message.type !== "http_request") {
        return;
    }

    const tunnelResponse = await forwardToLocalApp(message);
    socket.send(JSON.stringify(tunnelResponse));
});

socket.addEventListener("close", () => {
    console.log("Disconnected from tunnel server");
});

socket.addEventListener("error", () => {
    console.log("Could not connect to tunnel server");
});
