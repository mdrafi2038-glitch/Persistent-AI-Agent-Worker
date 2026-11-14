const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { spawn } = require("node:child_process");

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve(server.address().port);
    });
  });
}

function close(server) {
  return new Promise(resolve => server.close(() => resolve()));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

async function waitForHealth(url, child) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) throw new Error("Worker exited before becoming healthy.");
    try {
      const response = await fetch(url + "/health");
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error("Worker did not become healthy in time.");
}

test("normal Auto chat falls back from a failing primary provider to OpenRouter", async () => {
  const reservation = http.createServer();
  const appPort = await listen(reservation);
  await close(reservation);

  const providerCalls = [];
  const primary = http.createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/v1/chat/completions") return res.writeHead(404).end();
    const body = JSON.parse(await readBody(req));
    providerCalls.push({ provider: "primary", model: body.model });
    res.writeHead(503, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "simulated primary outage" } }));
  });
  const openRouter = http.createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/api/v1/chat/completions") return res.writeHead(404).end();
    const body = JSON.parse(await readBody(req));
    providerCalls.push({ provider: "openrouter", model: body.model, authorization: req.headers.authorization });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: "LIVE CHAT FALLBACK OK" } }] }));
  });

  const primaryPort = await listen(primary);
  const openRouterPort = await listen(openRouter);
  const child = spawn(process.execPath, ["server.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(appPort),
      APP_PASSWORD: "integration-test-password",
      SESSION_SECRET: "integration-test-session-secret-at-least-32-chars",
      AI_PROVIDER: "openai-compatible",
      AI_API_KEY: "test-primary-key",
      AI_BASE_URL: `http://127.0.0.1:${primaryPort}/v1`,
      AI_MODEL: "deepseek-v4-pro",
      OPENROUTER_API_KEY: "test-openrouter-key",
      OPENROUTER_MODEL: "nvidia/nemotron-3-ultra-550b-a55b:free",
      OPENROUTER_BASE_URL: `http://127.0.0.1:${openRouterPort}/api/v1`,
      SUPABASE_URL: "",
      SUPABASE_SERVICE_ROLE_KEY: ""
    },
    stdio: "ignore"
  });

  const appUrl = `http://127.0.0.1:${appPort}`;
  try {
    await waitForHealth(appUrl, child);
    const login = await fetch(appUrl + "/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "integration-test-password" })
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie")?.split(";")[0];
    assert.ok(cookie, "login should return a session cookie");

    const response = await fetch(appUrl + "/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        sessionId: "7d5c6b42-37ab-4a47-9b45-2c89c0a0b123",
        message: "Reply with the fallback test confirmation.",
        modelMode: "auto"
      })
    });
    const payload = await response.json();
    assert.equal(response.status, 200, JSON.stringify(payload));
    assert.equal(payload.answer, "LIVE CHAT FALLBACK OK");
    assert.deepEqual(providerCalls.map(call => call.provider), ["primary", "openrouter"]);
    assert.equal(providerCalls[0].model, "deepseek-v4-pro");
    assert.equal(providerCalls[1].model, "nvidia/nemotron-3-ultra-550b-a55b:free");
    assert.equal(providerCalls[1].authorization, "Bearer test-openrouter-key");
  } finally {
    child.kill("SIGTERM");
    await Promise.all([close(primary), close(openRouter)]);
  }
});
