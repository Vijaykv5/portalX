const server = Bun.serve({
    port: 8080,

    fetch(req, server) {
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

        return new Response("MyTunnel server is running");
    },

    websocket: {
        open(ws) {
            console.log("Client connected");

            ws.send(
                JSON.stringify({
                    type: "connected",
                    message: "Connected to MyTunnel server",
                })
            );
        },

        message(ws, message) {
            console.log("Message from client:", message);
        },

        close() {
            console.log("Client disconnected");
        },
    },
});

console.log(`Tunnel server running on http://localhost:${server.port}`);