import {
    DEFAULT_AUTH_TOKEN,
    MAX_BODY_BYTES,
    REQUEST_TIMEOUT_MS,
    TUNNEL_SLUG_LENGTH,
    filterForwardHeaders,
    requestBodyToBase64,
    type ClientMessage,
} from "../../../packages/protocol/src/index";

type Env = {
    PORTALX_RELAY: DurableObjectNamespace;
    PORTALX_AUTH_TOKEN?: string;
    PORTALX_BASE_DOMAIN?: string;
    PORTALX_REQUEST_TIMEOUT_MS?: string;
};

type DurableObjectNamespace = {
    idFromName(name: string): DurableObjectId;
    get(id: DurableObjectId): DurableObjectStub;
};

type DurableObjectId = unknown;

type DurableObjectStub = {
    fetch(request: Request): Promise<Response>;
};

type DurableObjectState = {
    acceptWebSocket(webSocket: WebSocket): void;
    getWebSockets(): WebSocket[];
};

declare const WebSocketPair: {
    new (): {
        0: WebSocket;
        1: WebSocket;
    };
};

type PendingRequest = {
    resolve: (response: Response) => void;
    timeout: ReturnType<typeof setTimeout>;
};

type TunnelRecord = {
    socket: WebSocket;
    token: string;
    slug: string;
    publicUrl: string;
    connectedAt: string;
    requestCount: number;
    lastRequestAt: string | null;
};

type SocketAttachment = {
    token: string;
    slug: string;
    publicUrl: string;
    connectedAt: string;
    requestCount: number;
    lastRequestAt: string | null;
};

type AttachmentWebSocket = WebSocket & {
    serializeAttachment?(attachment: SocketAttachment): void;
    deserializeAttachment?(): SocketAttachment | undefined;
};

type WebSocketResponseInit = ResponseInit & {
    webSocket: WebSocket;
};

export default {
    fetch(request: Request, env: Env) {
        const id = env.PORTALX_RELAY.idFromName("global");
        const relay = env.PORTALX_RELAY.get(id);

        return relay.fetch(request);
    },
};

export class PortalxRelay {
    private activeTunnelsByToken = new Map<string, TunnelRecord>();
    private activeTunnelsBySlug = new Map<string, TunnelRecord>();
    private pendingRequests = new Map<string, PendingRequest>();

    constructor(
        private readonly state: DurableObjectState,
        private readonly env: Env
    ) {
        for (const socket of state.getWebSockets() as AttachmentWebSocket[]) {
            const attachment = socket.deserializeAttachment?.();

            if (!attachment) {
                continue;
            }

            this.registerTunnel({
                socket,
                token: attachment.token,
                slug: attachment.slug,
                publicUrl: attachment.publicUrl,
                connectedAt: attachment.connectedAt,
                requestCount: attachment.requestCount,
                lastRequestAt: attachment.lastRequestAt,
            });
        }
    }

    async fetch(req: Request) {
        const url = new URL(req.url);

        if (url.pathname === "/_status") {
            return Response.json(this.getStatus());
        }

        if (url.pathname === "/_connect-check") {
            return this.checkTunnelConnection(url.searchParams.get("token"));
        }

        if (url.pathname === "/tunnel") {
            return this.connectTunnel(req);
        }

        return this.forwardRequest(req);
    }

    async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer) {
        const parsedMessage = this.parseClientMessage(message);

        if (!parsedMessage || parsedMessage.type !== "http_response") {
            return;
        }

        const pendingRequest = this.pendingRequests.get(parsedMessage.requestId);

        if (!pendingRequest) {
            return;
        }

        clearTimeout(pendingRequest.timeout);
        this.pendingRequests.delete(parsedMessage.requestId);

        pendingRequest.resolve(
            new Response(Buffer.from(parsedMessage.bodyBase64, "base64"), {
                status: parsedMessage.status,
                headers: filterForwardHeaders(new Headers(parsedMessage.headers)),
            })
        );
    }

    webSocketClose(socket: WebSocket) {
        this.removeTunnel(socket);
    }

    webSocketError(socket: WebSocket) {
        this.removeTunnel(socket);
    }

    private connectTunnel(req: Request) {
        const url = new URL(req.url);
        const token = url.searchParams.get("token");
        const checkResponse = this.checkTunnelConnection(token);

        if (!checkResponse.ok) {
            return checkResponse;
        }

        const pair = new WebSocketPair();
        const client = pair[0];
        const server = pair[1] as AttachmentWebSocket;
        const tunnelToken = token ?? "";
        const slug = this.createTunnelSlug();
        const publicUrl = this.getPublicUrl(req, slug);
        const connectedAt = new Date().toISOString();

        server.serializeAttachment?.({
            token: tunnelToken,
            slug,
            publicUrl,
            connectedAt,
            requestCount: 0,
            lastRequestAt: null,
        });

        this.state.acceptWebSocket(server);
        this.registerTunnel({
            socket: server,
            token: tunnelToken,
            slug,
            publicUrl,
            connectedAt,
            requestCount: 0,
            lastRequestAt: null,
        });

        server.send(
            JSON.stringify({
                type: "connected",
                message: `Tunnel ready at ${publicUrl}`,
                publicUrl,
                tunnelSlug: slug,
            })
        );

        return new Response(null, {
            status: 101,
            webSocket: client,
        } as WebSocketResponseInit);
    }

    private async forwardRequest(req: Request) {
        const tunnel = this.getTunnelFromRequest(req);

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

        const url = new URL(req.url);
        const requestId = crypto.randomUUID();
        tunnel.requestCount++;
        tunnel.lastRequestAt = new Date().toISOString();
        this.persistTunnelAttachment(tunnel);

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

        return this.waitForTunnelResponse(requestId);
    }

    private waitForTunnelResponse(requestId: string) {
        return new Promise<Response>((resolve) => {
            const timeout = setTimeout(() => {
                this.pendingRequests.delete(requestId);

                resolve(
                    new Response("Tunnel request timed out", {
                        status: 504,
                    })
                );
            }, this.requestTimeoutMs);

            this.pendingRequests.set(requestId, {
                resolve,
                timeout,
            });
        });
    }

    private getStatus() {
        return {
            status: "ok",
            activeConnections: this.activeTunnelsByToken.size,
            tunnels: Array.from(this.activeTunnelsBySlug.values()).map((tunnel) => ({
                slug: tunnel.slug,
                publicUrl: tunnel.publicUrl,
                connectedAt: tunnel.connectedAt,
                requestCount: tunnel.requestCount,
                lastRequestAt: tunnel.lastRequestAt,
            })),
            pendingRequests: this.pendingRequests.size,
        };
    }

    private checkTunnelConnection(token: string | null) {
        if (!token || !this.allowedTokens.has(token)) {
            return new Response("Invalid tunnel auth token", {
                status: 401,
            });
        }

        if (this.activeTunnelsByToken.has(token)) {
            return new Response("This token already has an active tunnel", {
                status: 409,
            });
        }

        return Response.json({
            ok: true,
        });
    }

    private getTunnelFromRequest(req: Request) {
        if (!this.baseDomain) {
            return this.activeTunnelsBySlug.values().next().value as TunnelRecord | undefined;
        }

        const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
        const hostname = host?.split(":")[0];
        const suffix = `.${this.baseDomain}`;

        if (!hostname?.endsWith(suffix)) {
            return null;
        }

        const slug = hostname.slice(0, -suffix.length);
        return this.activeTunnelsBySlug.get(slug) ?? null;
    }

    private getPublicUrl(req: Request, slug: string) {
        const origin = this.getRequestOrigin(req);

        if (!this.baseDomain) {
            return origin;
        }

        const protocol = new URL(origin).protocol;
        return `${protocol}//${slug}.${this.baseDomain}`;
    }

    private getRequestOrigin(req: Request) {
        const headers = req.headers;
        const forwardedProto = headers.get("x-forwarded-proto");
        const host = headers.get("x-forwarded-host") ?? headers.get("host");

        if (forwardedProto && host) {
            return `${forwardedProto}://${host}`;
        }

        if (host) {
            return `https://${host}`;
        }

        return "https://localhost";
    }

    private registerTunnel(tunnel: TunnelRecord) {
        this.activeTunnelsByToken.set(tunnel.token, tunnel);
        this.activeTunnelsBySlug.set(tunnel.slug, tunnel);
    }

    private removeTunnel(socket: WebSocket) {
        for (const tunnel of this.activeTunnelsBySlug.values()) {
            if (tunnel.socket !== socket) {
                continue;
            }

            this.activeTunnelsByToken.delete(tunnel.token);
            this.activeTunnelsBySlug.delete(tunnel.slug);
            this.failPendingRequests("Tunnel client disconnected", 502);
            return;
        }
    }

    private failPendingRequests(message: string, status: number) {
        for (const [requestId, pendingRequest] of this.pendingRequests.entries()) {
            clearTimeout(pendingRequest.timeout);
            this.pendingRequests.delete(requestId);

            pendingRequest.resolve(
                new Response(message, {
                    status,
                })
            );
        }
    }

    private parseClientMessage(message: string | ArrayBuffer) {
        try {
            const text = typeof message === "string" ? message : new TextDecoder().decode(message);
            return JSON.parse(text) as ClientMessage;
        } catch {
            return null;
        }
    }

    private persistTunnelAttachment(tunnel: TunnelRecord) {
        const socket = tunnel.socket as AttachmentWebSocket;

        socket.serializeAttachment?.({
            token: tunnel.token,
            slug: tunnel.slug,
            publicUrl: tunnel.publicUrl,
            connectedAt: tunnel.connectedAt,
            requestCount: tunnel.requestCount,
            lastRequestAt: tunnel.lastRequestAt,
        });
    }

    private createTunnelSlug() {
        return crypto.randomUUID().replaceAll("-", "").slice(0, TUNNEL_SLUG_LENGTH);
    }

    private get allowedTokens() {
        const tokens = this.env.PORTALX_AUTH_TOKEN ?? DEFAULT_AUTH_TOKEN;
        return new Set(tokens.split(",").map((token) => token.trim()).filter(Boolean));
    }

    private get requestTimeoutMs() {
        const timeoutMs = Number(this.env.PORTALX_REQUEST_TIMEOUT_MS ?? String(REQUEST_TIMEOUT_MS));
        return Number.isInteger(timeoutMs) && timeoutMs > 0 ? timeoutMs : REQUEST_TIMEOUT_MS;
    }

    private get baseDomain() {
        return this.env.PORTALX_BASE_DOMAIN;
    }
}
