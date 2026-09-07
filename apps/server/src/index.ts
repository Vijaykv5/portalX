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

type TunnelClientData = {
    tunnelId: string;
};

type PendingRequest = {
    resolve: (response: Response) => void;
    timeout: ReturnType<typeof setTimeout>;
};

const tunnelClients = new Map<string, ServerWebSocket<TunnelClientData>>();
const pendingRequests = new Map<string, PendingRequest>();
const authToken = process.env.TUNNEL_AUTH_TOKEN ?? "dev-token";
const port = Number(process.env.PORT ?? "8080");

function createRequestId() {
    return crypto.randomUUID();
}

function headersToObject(headers: Headers) {
    return Object.fromEntries(headers.entries());
}

function isValidTunnelId(tunnelId: string) {
    return /^[a-zA-Z0-9_-]{3,40}$/.test(tunnelId);
}

function isValidPort(port: number) {
    return Number.isInteger(port) && port > 0 && port < 65_536;
}

function getTunnelIdFromPath(pathname: string) {
    const [, prefix, tunnelId] = pathname.split("/");

    if (prefix !== "t" || !tunnelId) {
        return null;
    }

    return tunnelId;
}

function getForwardPath(pathname: string, search: string) {
    const [, , , ...forwardPathParts] = pathname.split("/");
    const forwardPath = `/${forwardPathParts.join("/")}`;

    return `${forwardPath}${search}`;
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
    port: isValidPort(port) ? port : 8080,

    async fetch(req, server) {
        const url = new URL(req.url);

        if (url.pathname === "/tunnel") {
            const tunnelId = url.searchParams.get("id");
            const token = url.searchParams.get("token");

            if (!tunnelId) {
                return new Response("Missing tunnel id", {
                    status: 400,
                });
            }

            if (token !== authToken) {
                return new Response("Invalid tunnel auth token", {
                    status: 401,
                });
            }

            if (!isValidTunnelId(tunnelId)) {
                return new Response("Tunnel id must be 3-40 characters and only use letters, numbers, dashes, or underscores", {
                    status: 400,
                });
            }

            if (tunnelClients.has(tunnelId)) {
                return new Response(`Tunnel id "${tunnelId}" is already connected`, {
                    status: 409,
                });
            }

            const upgraded = server.upgrade(req, {
                data: {
                    tunnelId,
                },
            });

            if (upgraded) {
                return;
            }

            return new Response("WebSocket upgrade failed", {
                status: 400,
            });
        }

        const tunnelId = getTunnelIdFromPath(url.pathname);

        if (!tunnelId) {
            return new Response("Use /t/:tunnelId to reach a tunnel", {
                status: 404,
            });
        }

        if (!isValidTunnelId(tunnelId)) {
            return new Response("Invalid tunnel id", {
                status: 400,
            });
        }

        const tunnelClient = tunnelClients.get(tunnelId);

        if (!tunnelClient) {
            return new Response(`No tunnel client connected for "${tunnelId}"`, {
                status: 503,
            });
        }

        const requestId = createRequestId();
        const body = await req.text();
        const tunnelRequest: TunnelRequestMessage = {
            type: "http_request",
            requestId,
            method: req.method,
            path: getForwardPath(url.pathname, url.search),
            headers: headersToObject(req.headers),
            body,
        };

        tunnelClient.send(JSON.stringify(tunnelRequest));

        return waitForTunnelResponse(requestId);
    },

    websocket: {
        open(ws) {
            tunnelClients.set(ws.data.tunnelId, ws);
            console.log(`Tunnel client connected: ${ws.data.tunnelId}`);

            ws.send(
                JSON.stringify({
                    type: "connected",
                    message: `Tunnel ready at http://localhost:${server.port}/t/${ws.data.tunnelId}`,
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
            tunnelClients.delete(ws.data.tunnelId);

            console.log(`Tunnel client disconnected: ${ws.data.tunnelId}`);
        },
    },
});

console.log(`Tunnel server running on http://localhost:${server.port}`);
