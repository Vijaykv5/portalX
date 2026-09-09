import {
    DEFAULT_AUTH_TOKEN,
    DEFAULT_SERVER_PORT,
    MAX_BODY_BYTES,
    REQUEST_TIMEOUT_MS,
    TUNNEL_SLUG_LENGTH,
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
    token: string;
    slug: string;
    publicUrl: string;
    connectedAt: string;
    requestCount: number;
    lastRequestAt: string | null;
};

type TunnelClientData = {
    token: string;
    slug: string;
    publicUrl: string;
};

const pendingRequests = new Map<string, PendingRequest>();
const authToken = process.env.PORTALX_AUTH_TOKEN ?? process.env.PORTLEX_AUTH_TOKEN ?? process.env.TUNNEL_AUTH_TOKEN ?? DEFAULT_AUTH_TOKEN;
const allowedTokens = new Set(authToken.split(",").map((token) => token.trim()).filter(Boolean));
const requestedPort = Number(process.env.PORT ?? String(DEFAULT_SERVER_PORT));
const port = isValidPort(requestedPort) ? requestedPort : DEFAULT_SERVER_PORT;
const requestedTimeoutMs = Number(process.env.PORTALX_REQUEST_TIMEOUT_MS ?? process.env.PORTLEX_REQUEST_TIMEOUT_MS ?? String(REQUEST_TIMEOUT_MS));
const requestTimeoutMs = Number.isInteger(requestedTimeoutMs) && requestedTimeoutMs > 0 ? requestedTimeoutMs : REQUEST_TIMEOUT_MS;
const baseDomain = process.env.PORTALX_BASE_DOMAIN;
const tunnelsByToken = new Map<string, TunnelRecord>();
const tunnelsBySlug = new Map<string, TunnelRecord>();
let isShuttingDown = false;

function createRequestId() {
    return crypto.randomUUID();
}

function createTunnelSlug() {
    return crypto.randomUUID().replaceAll("-", "").slice(0, TUNNEL_SLUG_LENGTH);
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
        activeConnections: tunnelsByToken.size,
        tunnels: Array.from(tunnelsBySlug.values()).map((tunnel) => ({
            slug: tunnel.slug,
            publicUrl: tunnel.publicUrl,
            connectedAt: tunnel.connectedAt,
            requestCount: tunnel.requestCount,
            lastRequestAt: tunnel.lastRequestAt,
        })),
        pendingRequests: pendingRequests.size,
    };
}

function checkTunnelConnection(token: string | null) {
    if (!token || !allowedTokens.has(token)) {
        return new Response("Invalid tunnel auth token", {
            status: 401,
        });
    }

    if (tunnelsByToken.has(token)) {
        return new Response("This token already has an active tunnel", {
            status: 409,
        });
    }

    return Response.json({
        ok: true,
    });
}

function getRequestOrigin(req: Request) {
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

function getPublicUrl(req: Request, slug: string) {
    const origin = getRequestOrigin(req);

    if (!baseDomain) {
        return origin;
    }

    const protocol = new URL(origin).protocol;
    return `${protocol}//${slug}.${baseDomain}`;
}

function getTunnelFromRequest(req: Request) {
    if (!baseDomain) {
        return tunnelsBySlug.values().next().value as TunnelRecord | undefined;
    }

    const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
    const hostname = host?.split(":")[0];
    const suffix = `.${baseDomain}`;

    if (!hostname?.endsWith(suffix)) {
        return null;
    }

    const slug = hostname.slice(0, -suffix.length);
    return tunnelsBySlug.get(slug) ?? null;
}

function shutdown() {
    if (isShuttingDown) {
        return;
    }

    isShuttingDown = true;
    console.log("Shutting down Portalx server...");

    for (const tunnel of tunnelsBySlug.values()) {
        tunnel.socket.close();
    }

    tunnelsBySlug.clear();
    tunnelsByToken.clear();
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

            const tunnelToken = token ?? "";
            const slug = createTunnelSlug();
            const upgraded = server.upgrade(req, {
                data: {
                    token: tunnelToken,
                    slug,
                    publicUrl: getPublicUrl(req, slug),
                },
            });

            if (upgraded) {
                return;
            }

            return new Response("WebSocket upgrade failed", {
                status: 400,
            });
        }

        const tunnel = getTunnelFromRequest(req);

        if (!tunnel) {
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
        tunnel.requestCount++;
        tunnel.lastRequestAt = new Date().toISOString();

        tunnel.socket.send(
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
            const tunnel = {
                socket: ws,
                token: ws.data.token,
                slug: ws.data.slug,
                publicUrl: ws.data.publicUrl,
                connectedAt: new Date().toISOString(),
                requestCount: 0,
                lastRequestAt: null,
            };
            tunnelsByToken.set(ws.data.token, tunnel);
            tunnelsBySlug.set(ws.data.slug, tunnel);

            console.log(`Tunnel client connected: ${ws.data.slug}`);

            ws.send(
                JSON.stringify({
                    type: "connected",
                    message: `Tunnel ready at ${ws.data.publicUrl}`,
                    publicUrl: ws.data.publicUrl,
                    tunnelSlug: ws.data.slug,
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
            const tunnel = tunnelsBySlug.get(ws.data.slug);

            if (tunnel?.socket === ws) {
                tunnelsBySlug.delete(ws.data.slug);
                tunnelsByToken.delete(ws.data.token);
                failPendingRequests("Tunnel client disconnected", 502);
            }

            console.log(`Tunnel client disconnected: ${ws.data.slug}`);
        },
    },
});

console.log(`Portalx server running on http://localhost:${server.port}`);

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
