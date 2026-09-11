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
    GITHUB_CLIENT_ID?: string;
    GITHUB_CLIENT_SECRET?: string;
    PORTALX_TOKEN_SECRET?: string;
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

type LoginSession = {
    sessionId: string;
    state: string;
    status: "pending" | "approved";
    createdAt: string;
    expiresAt: number;
    token?: string;
    githubId?: number;
    username?: string;
};

type GitHubAccessTokenResponse = {
    access_token?: string;
    error?: string;
    error_description?: string;
};

type GitHubUserResponse = {
    id: number;
    login: string;
};

const LOGIN_SESSION_TTL_MS = 10 * 60 * 1000;

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
    private loginSessionsById = new Map<string, LoginSession>();
    private loginSessionsByState = new Map<string, LoginSession>();
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

        if (url.pathname === "/auth/github/start") {
            return this.startGitHubLogin(req);
        }

        if (url.pathname === "/auth/github/callback") {
            return this.finishGitHubLogin(req);
        }

        if (url.pathname.startsWith("/cli/session/")) {
            return this.getCliSession(req);
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

    private async connectTunnel(req: Request) {
        const url = new URL(req.url);
        const token = url.searchParams.get("token");
        const checkResponse = await this.checkTunnelConnection(token);

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

    private async checkTunnelConnection(token: string | null) {
        if (!token || !(await this.isAllowedToken(token))) {
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

    private startGitHubLogin(req: Request) {
        const envError = this.getGitHubConfigError();

        if (envError) {
            return new Response(envError, {
                status: 500,
            });
        }

        const url = new URL(req.url);
        const sessionId = url.searchParams.get("session");

        if (!sessionId) {
            return new Response("Missing CLI session id", {
                status: 400,
            });
        }

        this.cleanupExpiredLoginSessions();

        const state = crypto.randomUUID();
        const session: LoginSession = {
            sessionId,
            state,
            status: "pending",
            createdAt: new Date().toISOString(),
            expiresAt: Date.now() + LOGIN_SESSION_TTL_MS,
        };

        this.loginSessionsById.set(sessionId, session);
        this.loginSessionsByState.set(state, session);

        const githubUrl = new URL("https://github.com/login/oauth/authorize");
        githubUrl.searchParams.set("client_id", this.env.GITHUB_CLIENT_ID ?? "");
        githubUrl.searchParams.set("redirect_uri", `${url.origin}/auth/github/callback`);
        githubUrl.searchParams.set("state", state);
        githubUrl.searchParams.set("scope", "read:user");

        return Response.redirect(githubUrl.toString(), 302);
    }

    private async finishGitHubLogin(req: Request) {
        const envError = this.getGitHubConfigError();

        if (envError) {
            return new Response(envError, {
                status: 500,
            });
        }

        this.cleanupExpiredLoginSessions();

        const url = new URL(req.url);
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");

        if (!code || !state) {
            return new Response("Missing GitHub OAuth code or state", {
                status: 400,
            });
        }

        const session = this.loginSessionsByState.get(state);

        if (!session) {
            return new Response("Login session expired. Run portalx login again.", {
                status: 400,
            });
        }

        const tokenRequestBody = new URLSearchParams({
            client_id: this.env.GITHUB_CLIENT_ID ?? "",
            client_secret: this.env.GITHUB_CLIENT_SECRET ?? "",
            code,
            redirect_uri: `${url.origin}/auth/github/callback`,
        });

        const accessTokenResponse = await fetch("https://github.com/login/oauth/access_token", {
            method: "POST",
            headers: {
                accept: "application/json",
                "content-type": "application/x-www-form-urlencoded",
            },
            body: tokenRequestBody,
        });
        const accessTokenBody = await accessTokenResponse.json() as GitHubAccessTokenResponse;

        if (!accessTokenResponse.ok || !accessTokenBody.access_token) {
            const message = accessTokenBody.error_description
                ? `GitHub OAuth token exchange failed: ${accessTokenBody.error_description}`
                : `GitHub OAuth token exchange failed${accessTokenBody.error ? `: ${accessTokenBody.error}` : ""}`;

            return new Response(message, {
                status: 401,
            });
        }

        const userResponse = await fetch("https://api.github.com/user", {
            headers: {
                accept: "application/vnd.github+json",
                authorization: `Bearer ${accessTokenBody.access_token}`,
                "user-agent": "portalx",
            },
        });

        if (!userResponse.ok) {
            return new Response("Could not read GitHub user profile", {
                status: 401,
            });
        }

        const user = await userResponse.json() as GitHubUserResponse;
        const token = await this.createPortalxToken(user);

        session.status = "approved";
        session.token = token;
        session.githubId = user.id;
        session.username = user.login;
        this.loginSessionsById.set(session.sessionId, session);

        return new Response(this.getLoginSuccessHtml(user.login), {
            headers: {
                "content-type": "text/html; charset=utf-8",
            },
        });
    }

    private getCliSession(req: Request) {
        this.cleanupExpiredLoginSessions();

        const url = new URL(req.url);
        const sessionId = url.pathname.split("/").pop();
        const session = sessionId ? this.loginSessionsById.get(sessionId) : undefined;

        if (!session) {
            return Response.json({
                status: "expired",
            }, {
                status: 404,
            });
        }

        if (session.status === "pending") {
            return Response.json({
                status: "pending",
            });
        }

        return Response.json({
            status: "approved",
            token: session.token,
            user: {
                id: session.githubId,
                username: session.username,
            },
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

    private async isAllowedToken(token: string) {
        return this.allowedTokens.has(token) || await this.verifyPortalxToken(token);
    }

    private async createPortalxToken(user: GitHubUserResponse) {
        const payload = this.toBase64Url(JSON.stringify({
            sub: String(user.id),
            login: user.login,
            iat: Math.floor(Date.now() / 1000),
        }));
        const signature = await this.signTokenPayload(payload);

        return `px_${payload}.${signature}`;
    }

    private async verifyPortalxToken(token: string) {
        if (!token.startsWith("px_") || !this.env.PORTALX_TOKEN_SECRET) {
            return false;
        }

        const tokenBody = token.slice(3);
        const [payload, signature] = tokenBody.split(".");

        if (!payload || !signature) {
            return false;
        }

        return await this.signTokenPayload(payload) === signature;
    }

    private async signTokenPayload(payload: string) {
        const key = await crypto.subtle.importKey(
            "raw",
            new TextEncoder().encode(this.env.PORTALX_TOKEN_SECRET ?? ""),
            {
                name: "HMAC",
                hash: "SHA-256",
            },
            false,
            ["sign"]
        );
        const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));

        return this.toBase64Url(signature);
    }

    private toBase64Url(value: string | ArrayBuffer) {
        const buffer = typeof value === "string" ? Buffer.from(value) : Buffer.from(value);
        return buffer.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
    }

    private cleanupExpiredLoginSessions() {
        const now = Date.now();

        for (const session of this.loginSessionsById.values()) {
            if (session.expiresAt > now) {
                continue;
            }

            this.loginSessionsById.delete(session.sessionId);
            this.loginSessionsByState.delete(session.state);
        }
    }

    private getGitHubConfigError() {
        if (!this.env.GITHUB_CLIENT_ID || !this.env.GITHUB_CLIENT_SECRET || !this.env.PORTALX_TOKEN_SECRET) {
            return "Portalx GitHub auth is not configured";
        }

        return null;
    }

    private getLoginSuccessHtml(username: string) {
        return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Portalx login complete</title>
  <style>
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #05060a; color: #f6f7fb; font-family: system-ui, sans-serif; }
    main { max-width: 36rem; padding: 2rem; text-align: center; }
    h1 { font-size: 2rem; margin: 0 0 0.75rem; }
    p { color: rgba(246, 247, 251, 0.62); line-height: 1.7; }
    strong { color: #fff; }
  </style>
</head>
<body>
  <main>
    <h1>Portalx login complete</h1>
    <p>Signed in as <strong>@${this.escapeHtml(username)}</strong>. You can close this tab and return to your terminal.</p>
  </main>
</body>
</html>`;
    }

    private escapeHtml(value: string) {
        return value
            .replaceAll("&", "&amp;")
            .replaceAll("<", "&lt;")
            .replaceAll(">", "&gt;")
            .replaceAll('"', "&quot;")
            .replaceAll("'", "&#039;");
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
