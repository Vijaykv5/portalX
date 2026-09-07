import {
    DEFAULT_AUTH_TOKEN,
    DEFAULT_SERVER_PORT,
    MAX_BODY_BYTES,
    REQUEST_TIMEOUT_MS,
    filterForwardHeaders,
    isValidPort,
    isValidTunnelId,
    requestBodyToBase64,
    type ClientMessage,
} from "../../../packages/protocol/src/index";

type TunnelClientData = {
    tunnelId: string;
};

type PendingRequest = {
    tunnelId: string;
    resolve: (response: Response) => void;
    timeout: ReturnType<typeof setTimeout>;
};

const tunnelClients = new Map<string, ServerWebSocket<TunnelClientData>>();
const pendingRequests = new Map<string, PendingRequest>();
const authToken = process.env.TUNNEL_AUTH_TOKEN ?? DEFAULT_AUTH_TOKEN;
const requestedPort = Number(process.env.PORT ?? String(DEFAULT_SERVER_PORT));
const port = isValidPort(requestedPort) ? requestedPort : DEFAULT_SERVER_PORT;

function createRequestId() {
    return crypto.randomUUID();
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

function waitForTunnelResponse(requestId: string, tunnelId: string) {
    return new Promise<Response>((resolve) => {
        const timeout = setTimeout(() => {
            pendingRequests.delete(requestId);

            resolve(
                new Response("Tunnel request timed out", {
                    status: 504,
                })
            );
        }, REQUEST_TIMEOUT_MS);

        pendingRequests.set(requestId, {
            tunnelId,
            resolve,
            timeout,
        });
    });
}

function failPendingRequestsForTunnel(tunnelId: string) {
    for (const [requestId, pendingRequest] of pendingRequests.entries()) {
        if (pendingRequest.tunnelId !== tunnelId) {
            continue;
        }

        clearTimeout(pendingRequest.timeout);
        pendingRequests.delete(requestId);

        pendingRequest.resolve(
            new Response("Tunnel client disconnected", {
                status: 502,
            })
        );
    }
}

function parseClientMessage(message: string | Buffer) {
    try {
        return JSON.parse(String(message)) as ClientMessage;
    } catch {
        return null;
    }
}

const server = Bun.serve({
    port,

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

        const bodyBase64 = await requestBodyToBase64(req);

        if (bodyBase64 === null) {
            return new Response(`Request body is too large. Limit is ${MAX_BODY_BYTES} bytes.`, {
                status: 413,
            });
        }

        const requestId = createRequestId();

        tunnelClient.send(
            JSON.stringify({
                type: "http_request",
                requestId,
                method: req.method,
                path: getForwardPath(url.pathname, url.search),
                headers: filterForwardHeaders(req.headers),
                bodyBase64,
            })
        );

        return waitForTunnelResponse(requestId, tunnelId);
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
            const parsedMessage = parseClientMessage(message);

            if (!parsedMessage || parsedMessage.type !== "http_response") {
                return;
            }

            const pendingRequest = pendingRequests.get(parsedMessage.requestId);

            if (!pendingRequest) {
                return;
            }

            clearTimeout(pendingRequest.timeout);
            pendingRequests.delete(parsedMessage.requestId);

            pendingRequest.resolve(
                new Response(Buffer.from(parsedMessage.bodyBase64, "base64"), {
                    status: parsedMessage.status,
                    headers: filterForwardHeaders(new Headers(parsedMessage.headers)),
                })
            );
        },

        close(ws) {
            tunnelClients.delete(ws.data.tunnelId);
            failPendingRequestsForTunnel(ws.data.tunnelId);

            console.log(`Tunnel client disconnected: ${ws.data.tunnelId}`);
        },
    },
});

console.log(`Tunnel server running on http://localhost:${server.port}`);
