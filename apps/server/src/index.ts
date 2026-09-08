import {
    DEFAULT_AUTH_TOKEN,
    DEFAULT_SERVER_PORT,
    MAX_BODY_BYTES,
    REQUEST_TIMEOUT_MS,
    filterForwardHeaders,
    isValidPort,
    requestBodyToBase64,
    type ClientMessage,
} from "../../../packages/protocol/src/index";

type PendingRequest = {
    resolve: (response: Response) => void;
    timeout: ReturnType<typeof setTimeout>;
};

type TunnelRecord = {
    socket: Bun.ServerWebSocket<TunnelClientData>;
    connectedAt: string;
    requestCount: number;
    lastRequestAt: string | null;
};

type TunnelClientData = {
    publicUrl: string;
};

const pendingRequests = new Map<string, PendingRequest>();
const authToken = process.env.PORTALX_AUTH_TOKEN ?? process.env.PORTLEX_AUTH_TOKEN ?? process.env.TUNNEL_AUTH_TOKEN ?? DEFAULT_AUTH_TOKEN;
const requestedPort = Number(process.env.PORT ?? String(DEFAULT_SERVER_PORT));
const port = isValidPort(requestedPort) ? requestedPort : DEFAULT_SERVER_PORT;
const requestedTimeoutMs = Number(process.env.PORTALX_REQUEST_TIMEOUT_MS ?? process.env.PORTLEX_REQUEST_TIMEOUT_MS ?? String(REQUEST_TIMEOUT_MS));
const requestTimeoutMs = Number.isInteger(requestedTimeoutMs) && requestedTimeoutMs > 0 ? requestedTimeoutMs : REQUEST_TIMEOUT_MS;
let activeTunnel: TunnelRecord | null = null;
let isShuttingDown = false;

function createRequestId() {
    return crypto.randomUUID();
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
        }, requestTimeoutMs);

        pendingRequests.set(requestId, {
            resolve,
            timeout,
        });
    });
}

function failPendingRequests(message: string, status: number) {
    for (const [requestId, pendingRequest] of pendingRequests.entries()) {
        clearTimeout(pendingRequest.timeout);
        pendingRequests.delete(requestId);

        pendingRequest.resolve(
            new Response(message, {
                status,
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

function getStatus() {
    return {
        status: "ok",
        activeConnection: activeTunnel
            ? {
                  connectedAt: activeTunnel.connectedAt,
                  requestCount: activeTunnel.requestCount,
                  lastRequestAt: activeTunnel.lastRequestAt,
              }
            : null,
        pendingRequests: pendingRequests.size,
    };
}

function checkTunnelConnection(token: string | null) {
    if (token !== authToken) {
        return new Response("Invalid tunnel auth token", {
            status: 401,
        });
    }

    if (activeTunnel) {
        return new Response("A tunnel client is already connected", {
            status: 409,
        });
    }

    return Response.json({
        ok: true,
    });
}

function getPublicUrl(req: Request) {
    const headers = req.headers;
    const forwardedProto = headers.get("x-forwarded-proto");
    const host = headers.get("x-forwarded-host") ?? headers.get("host");

    if (forwardedProto && host) {
        return `${forwardedProto}://${host}`;
    }

    if (host) {
        return `http://${host}`;
    }

    return `http://localhost:${port}`;
}

function shutdown() {
    if (isShuttingDown) {
        return;
    }

    isShuttingDown = true;
    console.log("Shutting down Portalx server...");

    activeTunnel?.socket.close();
    activeTunnel = null;
    failPendingRequests("Portalx server shutting down", 503);

    server.stop();
    console.log("Portalx server stopped");
    process.exit(0);
}

const server = Bun.serve<TunnelClientData>({
    port,

    async fetch(req, server) {
        const url = new URL(req.url);

        if (url.pathname === "/_status") {
            return Response.json(getStatus());
        }

        if (url.pathname === "/_connect-check") {
            return checkTunnelConnection(url.searchParams.get("token"));
        }

        if (url.pathname === "/tunnel") {
            const token = url.searchParams.get("token");
            const checkResponse = checkTunnelConnection(token);

            if (!checkResponse.ok) {
                return checkResponse;
            }

            const upgraded = server.upgrade(req, {
                data: {
                    publicUrl: getPublicUrl(req),
                },
            });

            if (upgraded) {
                return;
            }

            return new Response("WebSocket upgrade failed", {
                status: 400,
            });
        }

        if (!activeTunnel) {
            return new Response("No tunnel client connected", {
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
        activeTunnel.requestCount++;
        activeTunnel.lastRequestAt = new Date().toISOString();

        activeTunnel.socket.send(
            JSON.stringify({
                type: "http_request",
                requestId,
                method: req.method,
                path: `${url.pathname}${url.search}`,
                headers: filterForwardHeaders(req.headers),
                bodyBase64,
            })
        );

        return waitForTunnelResponse(requestId);
    },

    websocket: {
        open(ws) {
            activeTunnel = {
                socket: ws,
                connectedAt: new Date().toISOString(),
                requestCount: 0,
                lastRequestAt: null,
            };

            console.log("Tunnel client connected");

            ws.send(
                JSON.stringify({
                    type: "connected",
                    message: `Tunnel ready at ${ws.data.publicUrl}`,
                    publicUrl: ws.data.publicUrl,
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
            if (activeTunnel?.socket === ws) {
                activeTunnel = null;
                failPendingRequests("Tunnel client disconnected", 502);
            }

            console.log("Tunnel client disconnected");
        },
    },
});

console.log(`Portalx server running on http://localhost:${server.port}`);

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
