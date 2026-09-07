const tunnelServerPort = 20_000 + Math.floor(Math.random() * 10_000);
const localAppPort = 30_000 + Math.floor(Math.random() * 10_000);
const tunnelServerUrl = `http://localhost:${tunnelServerPort}`;
const tunnelServerWsUrl = `ws://localhost:${tunnelServerPort}`;
const localAppUrl = `http://localhost:${localAppPort}`;
const configPath = `/tmp/portlex-smoke-${Date.now()}.json`;
const processes: Subprocess[] = [];

type Subprocess = ReturnType<typeof Bun.spawn>;

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

function assert(condition: unknown, message: string) {
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
    assert(versionResult.stdout.trim() === "portlex 0.1.0", "Version command should print the current version");

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
        PORTLEX_REQUEST_TIMEOUT_MS: "100",
    });
    await waitForHttp(`${tunnelServerUrl}/_status`);

    const emptyStatusResponse = await fetch(`${tunnelServerUrl}/_status`);
    const emptyStatus = await emptyStatusResponse.json();

    assert(emptyStatusResponse.status === 200, "Status endpoint should return 200");
    assert(emptyStatus.status === "ok", "Status endpoint should report ok");
    assert(emptyStatus.activeConnection === null, "Status endpoint should start with no active connection");

    const invalidTokenCheckResponse = await fetch(`${tunnelServerUrl}/_connect-check?token=wrong`);
    assert(invalidTokenCheckResponse.status === 401, "Connect check should reject invalid tokens");

    const availableConnectionCheckResponse = await fetch(`${tunnelServerUrl}/_connect-check?token=dev-token`);
    assert(availableConnectionCheckResponse.status === 200, "Connect check should allow an open slot");

    spawnProcess(["bun", "run", "cli", "--", "http"], {
        PORTLEX_CONFIG: configPath,
    });
    await waitForTunnel();

    const activeStatusResponse = await fetch(`${tunnelServerUrl}/_status`);
    const activeStatus = await activeStatusResponse.json();

    assert(activeStatusResponse.status === 200, "Status endpoint should return 200 with an active tunnel");
    assert(activeStatus.activeConnection !== null, "Status endpoint should report one active connection");
    assert(activeStatus.activeConnection.requestCount === 1, "Status endpoint should include the health request");

    const occupiedConnectionCheckResponse = await fetch(`${tunnelServerUrl}/_connect-check?token=dev-token`);
    assert(occupiedConnectionCheckResponse.status === 409, "Connect check should reject a second connection");

    const duplicateConnectionResponse = await fetch(`${tunnelServerUrl}/tunnel?token=dev-token`);
    assert(duplicateConnectionResponse.status === 409, "Second tunnel connection should be rejected");

    const getResponse = await fetch(`${tunnelServerUrl}/hello?x=1`);
    const getBody = await getResponse.json();

    assert(getResponse.status === 200, "GET request should return 200");
    assert(getBody.method === "GET", "GET method should be forwarded");
    assert(getBody.path === "/hello", "GET path should be forwarded");
    assert(getBody.search === "?x=1", "GET search params should be forwarded");

    const afterGetStatusResponse = await fetch(`${tunnelServerUrl}/_status`);
    const afterGetStatus = await afterGetStatusResponse.json();

    assert(afterGetStatus.activeConnection.requestCount === 2, "Status endpoint should count forwarded requests");
    assert(typeof afterGetStatus.activeConnection.connectedAt === "string", "Status endpoint should include connectedAt");
    assert(typeof afterGetStatus.activeConnection.lastRequestAt === "string", "Status endpoint should include lastRequestAt");

    const postResponse = await fetch(`${tunnelServerUrl}/submit`, {
        method: "POST",
        body: "hello-body",
    });
    const postBody = await postResponse.json();

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

    console.log("Smoke test passed");
} finally {
    await Bun.file(configPath).delete().catch(() => {});
    await cleanup();
}
