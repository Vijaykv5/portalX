const tunnelServerPort = 20_000 + Math.floor(Math.random() * 10_000);
const localAppPort = 30_000 + Math.floor(Math.random() * 10_000);
const tunnelServerUrl = `http://localhost:${tunnelServerPort}`;
const tunnelServerWsUrl = `ws://localhost:${tunnelServerPort}`;
const localAppUrl = `http://localhost:${localAppPort}`;
const configPath = `/tmp/portalx-smoke-${Date.now()}.json`;
const processes: Subprocess[] = [];

type Subprocess = ReturnType<typeof Bun.spawn>;

type StatusResponse = {
    status: "ok";
    activeConnections: number;
    tunnels: Array<{
        slug: string;
        publicUrl: string;
        connectedAt: string;
        requestCount: number;
        lastRequestAt: string | null;
    }>;
    pendingRequests: number;
};

type LocalAppResponse = {
    method: string;
    path: string;
    search: string;
    body: string;
};

function wait(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function spawnProcess(command: string[], env?: Record<string, string>) {
    const subprocess = Bun.spawn(command, {
        stdout: "pipe",
        stderr: "pipe",
        env: {
            ...process.env,
            ...env,
        },
    });

    processes.push(subprocess);
    return subprocess;
}

async function runCommand(command: string[], env?: Record<string, string>) {
    const subprocess = Bun.spawn(command, {
        stdout: "pipe",
        stderr: "pipe",
        env: {
            ...process.env,
            ...env,
        },
    });
    const [stdout, stderr, exitCode] = await Promise.all([
        new Response(subprocess.stdout).text(),
        new Response(subprocess.stderr).text(),
        subprocess.exited,
    ]);

    return {
        stdout,
        stderr,
        exitCode,
    };
}

async function waitForHttp(url: string) {
    for (let attempt = 0; attempt < 50; attempt++) {
        try {
            await fetch(url);
            return;
        } catch {
            await wait(100);
        }
    }

    throw new Error(`Timed out waiting for ${url}`);
}

async function waitForTunnel() {
    for (let attempt = 0; attempt < 50; attempt++) {
        const response = await fetch(`${tunnelServerUrl}/health`);

        if (response.ok) {
            return;
        }

        await wait(100);
    }

    throw new Error("Timed out waiting for tunnel to become ready");
}

function assert(condition: unknown, message: string): asserts condition {
    if (!condition) {
        throw new Error(message);
    }
}

async function cleanup() {
    for (const subprocess of processes) {
        subprocess.kill();
        await subprocess.exited.catch(() => {});
    }
}

try {
    spawnProcess(
        [
            "bun",
            "--eval",
            `Bun.serve({ port: ${localAppPort}, async fetch(req) { const url = new URL(req.url); if (url.pathname === "/slow") await new Promise(resolve => setTimeout(resolve, 500)); const body = await req.text(); return Response.json({ method: req.method, path: url.pathname, search: url.search, body }); } }); console.log("local app ready");`,
        ],
    );
    await waitForHttp(`${localAppUrl}/health`);

    const versionResult = await runCommand(["bun", "run", "cli", "--", "--version"]);
    assert(versionResult.exitCode === 0, "Version command should exit cleanly");
    assert(versionResult.stdout.trim() === "portalx 0.1.0", "Version command should print the current version");

    await Bun.write(
        configPath,
        JSON.stringify({
            localPort: localAppPort,
            serverUrl: tunnelServerWsUrl,
            authToken: "dev-token",
        })
    );

    spawnProcess(["bun", "run", "server"], {
        PORT: String(tunnelServerPort),
        PORTALX_REQUEST_TIMEOUT_MS: "100",
    });
    await waitForHttp(`${tunnelServerUrl}/_status`);

    const emptyStatusResponse = await fetch(`${tunnelServerUrl}/_status`);
    const emptyStatus = await emptyStatusResponse.json() as StatusResponse;

    assert(emptyStatusResponse.status === 200, "Status endpoint should return 200");
    assert(emptyStatus.status === "ok", "Status endpoint should report ok");
    assert(emptyStatus.activeConnections === 0, "Status endpoint should start with no active connections");
    assert(emptyStatus.tunnels.length === 0, "Status endpoint should start with no tunnel records");

    const invalidTokenCheckResponse = await fetch(`${tunnelServerUrl}/_connect-check?token=wrong`);
    assert(invalidTokenCheckResponse.status === 401, "Connect check should reject invalid tokens");

    const availableConnectionCheckResponse = await fetch(`${tunnelServerUrl}/_connect-check?token=dev-token`);
    assert(availableConnectionCheckResponse.status === 200, "Connect check should allow an open slot");

    spawnProcess(["bun", "run", "cli", "--", "http"], {
        PORTALX_CONFIG: configPath,
    });
    await waitForTunnel();

    const activeStatusResponse = await fetch(`${tunnelServerUrl}/_status`);
    const activeStatus = await activeStatusResponse.json() as StatusResponse;

    assert(activeStatusResponse.status === 200, "Status endpoint should return 200 with an active tunnel");
    assert(activeStatus.activeConnections === 1, "Status endpoint should report one active connection");
    assert(activeStatus.tunnels.length === 1, "Status endpoint should include one tunnel record");
    const activeTunnel = activeStatus.tunnels[0];

    assert(activeTunnel, "Status endpoint should include an active tunnel");
    assert(activeTunnel.requestCount === 1, "Status endpoint should include the health request");
    assert(activeTunnel.slug.length > 0, "Status endpoint should include a tunnel slug");

    const occupiedConnectionCheckResponse = await fetch(`${tunnelServerUrl}/_connect-check?token=dev-token`);
    assert(occupiedConnectionCheckResponse.status === 409, "Connect check should reject a second connection");

    const duplicateConnectionResponse = await fetch(`${tunnelServerUrl}/tunnel?token=dev-token`);
    assert(duplicateConnectionResponse.status === 409, "Second tunnel connection should be rejected");

    const getResponse = await fetch(`${tunnelServerUrl}/hello?x=1`);
    const getBody = await getResponse.json() as LocalAppResponse;

    assert(getResponse.status === 200, "GET request should return 200");
    assert(getBody.method === "GET", "GET method should be forwarded");
    assert(getBody.path === "/hello", "GET path should be forwarded");
    assert(getBody.search === "?x=1", "GET search params should be forwarded");

    const afterGetStatusResponse = await fetch(`${tunnelServerUrl}/_status`);
    const afterGetStatus = await afterGetStatusResponse.json() as StatusResponse;

    assert(afterGetStatus.tunnels.length === 1, "Status endpoint should still report one tunnel");
    const afterGetTunnel = afterGetStatus.tunnels[0];

    assert(afterGetTunnel, "Status endpoint should include a tunnel after the GET request");
    assert(afterGetTunnel.requestCount === 2, "Status endpoint should count forwarded requests");
    assert(typeof afterGetTunnel.connectedAt === "string", "Status endpoint should include connectedAt");
    assert(typeof afterGetTunnel.lastRequestAt === "string", "Status endpoint should include lastRequestAt");

    const postResponse = await fetch(`${tunnelServerUrl}/submit`, {
        method: "POST",
        body: "hello-body",
    });
    const postBody = await postResponse.json() as LocalAppResponse;

    assert(postResponse.status === 200, "POST request should return 200");
    assert(postBody.method === "POST", "POST method should be forwarded");
    assert(postBody.body === "hello-body", "POST body should be forwarded");

    const largeResponse = await fetch(`${tunnelServerUrl}/large`, {
        method: "POST",
        body: "x".repeat(1024 * 1024 + 1),
    });

    assert(largeResponse.status === 413, "Oversized request should return 413");

    const timeoutResponse = await fetch(`${tunnelServerUrl}/slow`);
    assert(timeoutResponse.status === 504, "Slow local responses should return 504");

    await cleanup();
    processes.length = 0;

    const subdomainServerPort = tunnelServerPort + 1;
    const subdomainLocalAppPort = localAppPort + 1;
    const baseDomain = "portalx.test";
    const subdomainServerUrl = `http://localhost:${subdomainServerPort}`;
    const subdomainLocalAppUrl = `http://localhost:${subdomainLocalAppPort}`;

    spawnProcess(
        [
            "bun",
            "--eval",
            `Bun.serve({ port: ${subdomainLocalAppPort}, async fetch(req) { const url = new URL(req.url); return Response.json({ path: url.pathname, host: req.headers.get("host") }); } }); console.log("subdomain local app ready");`,
        ],
    );
    await waitForHttp(`${subdomainLocalAppUrl}/health`);

    spawnProcess(["bun", "run", "server"], {
        PORT: String(subdomainServerPort),
        PORTALX_BASE_DOMAIN: baseDomain,
    });
    await waitForHttp(`${subdomainServerUrl}/_status`);

    spawnProcess(["bun", "run", "cli", "--", "http", String(subdomainLocalAppPort)], {
        PORTALX_SERVER_URL: `ws://localhost:${subdomainServerPort}`,
    });

    for (let attempt = 0; attempt < 50; attempt++) {
        const statusResponse = await fetch(`${subdomainServerUrl}/_status`);
        const status = await statusResponse.json() as StatusResponse;

        if (status.tunnels.length === 1) {
            break;
        }

        await wait(100);
    }

    const subdomainStatusResponse = await fetch(`${subdomainServerUrl}/_status`);
    const subdomainStatus = await subdomainStatusResponse.json() as StatusResponse;
    const subdomainTunnel = subdomainStatus.tunnels[0];

    assert(subdomainTunnel, "Subdomain mode should include a tunnel record");
    assert(subdomainTunnel.slug, "Subdomain mode should create a tunnel slug");
    assert(subdomainTunnel.publicUrl === `http://${subdomainTunnel.slug}.${baseDomain}`, "Subdomain mode should expose a slug public URL");

    const subdomainResponse = await fetch(`${subdomainServerUrl}/subdomain-path`, {
        headers: {
            host: `${subdomainTunnel.slug}.${baseDomain}`,
        },
    });
    const subdomainBody = await subdomainResponse.json() as { path: string };

    assert(subdomainResponse.status === 200, "Subdomain request should return 200");
    assert(subdomainBody.path === "/subdomain-path", "Subdomain request path should be forwarded");

    const landingHostResponse = await fetch(`${subdomainServerUrl}/`, {
        headers: {
            host: baseDomain,
        },
    });

    assert(landingHostResponse.status === 503, "Base domain should not be treated as a tunnel");

    console.log("Smoke test passed");
} finally {
    await Bun.file(configPath).delete().catch(() => {});
    await cleanup();
}
