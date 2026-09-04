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

const tunnelServerUrl = "ws://localhost:8080/tunnel";
const localTargetUrl = "http://localhost:3000";

function headersToObject(headers: Headers) {
    return Object.fromEntries(headers.entries());
}

async function forwardToLocalApp(message: TunnelRequestMessage): Promise<TunnelResponseMessage> {
    try {
        const localResponse = await fetch(`${localTargetUrl}${message.path}`, {
            method: message.method,
            headers: message.headers,
            body: message.body || undefined,
        });

        return {
            type: "http_response",
            requestId: message.requestId,
            status: localResponse.status,
            headers: headersToObject(localResponse.headers),
            body: await localResponse.text(),
        };
    } catch (error) {
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
    console.log(`Connected to tunnel server at ${tunnelServerUrl}`);
    console.log(`Forwarding requests to ${localTargetUrl}`);
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

    console.log(`${message.method} ${message.path}`);

    const tunnelResponse = await forwardToLocalApp(message);
    socket.send(JSON.stringify(tunnelResponse));
});

socket.addEventListener("close", () => {
    console.log("Disconnected from tunnel server");
});

socket.addEventListener("error", () => {
    console.log("Could not connect to tunnel server");
});
