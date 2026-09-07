export const DEFAULT_AUTH_TOKEN = "dev-token";
export const DEFAULT_CLI_TARGET_PORT = 3000;
export const DEFAULT_SERVER_PORT = 8080;
export const MAX_BODY_BYTES = 1024 * 1024;
export const REQUEST_TIMEOUT_MS = 10_000;

const blockedHeaders = new Set([
    "connection",
    "content-length",
    "host",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
]);

export type TunnelRequestMessage = {
    type: "http_request";
    requestId: string;
    method: string;
    path: string;
    headers: Record<string, string>;
    bodyBase64: string;
};

export type TunnelResponseMessage = {
    type: "http_response";
    requestId: string;
    status: number;
    headers: Record<string, string>;
    bodyBase64: string;
};

export type ConnectedMessage = {
    type: "connected";
    message: string;
};

export type ServerMessage = TunnelRequestMessage | ConnectedMessage;
export type ClientMessage = TunnelResponseMessage;

export function isValidTunnelId(tunnelId: string) {
    return /^[a-zA-Z0-9_-]{3,40}$/.test(tunnelId);
}

export function isValidPort(port: number) {
    return Number.isInteger(port) && port > 0 && port < 65_536;
}

export function filterForwardHeaders(headers: Headers) {
    const filteredHeaders: Record<string, string> = {};

    for (const [name, value] of headers.entries()) {
        if (!blockedHeaders.has(name.toLowerCase())) {
            filteredHeaders[name] = value;
        }
    }

    return filteredHeaders;
}

export async function requestBodyToBase64(req: Request) {
    const body = await req.arrayBuffer();

    if (body.byteLength > MAX_BODY_BYTES) {
        return null;
    }

    return Buffer.from(body).toString("base64");
}

export async function responseBodyToBase64(response: Response) {
    const body = await response.arrayBuffer();
    return Buffer.from(body).toString("base64");
}

export function base64ToBody(bodyBase64: string) {
    if (!bodyBase64) {
        return undefined;
    }

    return Buffer.from(bodyBase64, "base64");
}
