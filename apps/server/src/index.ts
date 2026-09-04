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

type PendingRequest = {
    resolve: (response: Response) => void;
    timeout: ReturnType<typeof setTimeout>;
};

let tunnelClient: ServerWebSocket<unknown> | null = null;
const pendingRequests = new Map<string, PendingRequest>();

function createRequestId() {
    return crypto.randomUUID();
}

function headersToObject(headers: Headers) {
    return Object.fromEntries(headers.entries());
}

function waitForTunnelResponse(requestId: string) {
    return new Promise<Response>((resolve) => {
        const timeout = setTimeout(() => {
            pendingRequests.delete(requestId);

            resolve(
                new Response("Tunnel request timed out", {
                    status: 504,
                })
            );
        }, 10_000);

        pendingRequests.set(requestId, {
            resolve,
            timeout,
        });
    });
}

const server = Bun.serve({
    port: 8080,

    async fetch(req, server) {
        const url = new URL(req.url);

        if (url.pathname === "/tunnel") {
            const upgraded = server.upgrade(req);

            if (upgraded) {
                return;
            }

            return new Response("WebSocket upgrade failed", {
                status: 400,
            });
        }

        if (!tunnelClient) {
            return new Response("No tunnel client connected", {
                status: 503,
            });
        }

        const requestId = createRequestId();
        const body = await req.text();
        const tunnelRequest: TunnelRequestMessage = {
            type: "http_request",
            requestId,
            method: req.method,
            path: `${url.pathname}${url.search}`,
            headers: headersToObject(req.headers),
            body,
        };

        tunnelClient.send(JSON.stringify(tunnelRequest));

        return waitForTunnelResponse(requestId);
    },

    websocket: {
        open(ws) {
            tunnelClient = ws;
            console.log("Tunnel client connected");

            ws.send(
                JSON.stringify({
                    type: "connected",
                    message: "Connected to tunnel server",
                })
            );
        },

        message(_ws, message) {
            const parsedMessage = JSON.parse(String(message)) as TunnelResponseMessage;

            if (parsedMessage.type !== "http_response") {
                return;
            }

            const pendingRequest = pendingRequests.get(parsedMessage.requestId);

            if (!pendingRequest) {
                return;
            }

            clearTimeout(pendingRequest.timeout);
            pendingRequests.delete(parsedMessage.requestId);

            pendingRequest.resolve(
                new Response(parsedMessage.body, {
                    status: parsedMessage.status,
                    headers: parsedMessage.headers,
                })
            );
        },

        close(ws) {
            if (tunnelClient === ws) {
                tunnelClient = null;
            }

            console.log("Tunnel client disconnected");
        },
    },
});

console.log(`Tunnel server running on http://localhost:${server.port}`);
