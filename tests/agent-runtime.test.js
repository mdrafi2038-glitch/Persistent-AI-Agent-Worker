const test = require("node:test");
const assert = require("node:assert/strict");
const { executeAgentTask } = require("../agent-runtime");

const envKeys = [
  "AI_PROVIDER", "AI_API_KEY", "AI_BASE_URL", "AI_MODEL",
  "OPENROUTER_API_KEY", "OPENROUTER_MODEL", "OPENROUTER_BASE_URL",
  "TAVILY_API_KEY", "MAX_OUTPUT_TOKENS"
];

function setEnv(values) {
  const previous = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  for (const key of envKeys) {
    if (Object.hasOwn(values, key)) process.env[key] = values[key];
    else delete process.env[key];
  }
  return () => {
    for (const key of envKeys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

test("automatic task mode falls back from HCSN-compatible primary to OpenRouter", async () => {
  const restoreEnv = setEnv({
    AI_PROVIDER: "openai-compatible",
    AI_API_KEY: "test-primary-key",
    AI_BASE_URL: "https://primary.test/v1",
    AI_MODEL: "deepseek-v4-pro",
    OPENROUTER_API_KEY: "test-openrouter-key",
    OPENROUTER_MODEL: "nvidia/nemotron-3-ultra-550b-a55b:free",
    OPENROUTER_BASE_URL: "https://openrouter.test/api/v1"
  });
  const originalFetch = global.fetch;
  const calls = [];

  global.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), authorization: options.headers?.authorization, body: options.body ? JSON.parse(options.body) : null });
    if (String(url).startsWith("https://primary.test/")) {
      return jsonResponse({ error: { message: "simulated primary outage" } }, 503);
    }
    if (String(url).startsWith("https://openrouter.test/")) {
      return jsonResponse({ choices: [{ message: { content: "Fallback model completed the task." } }] });
    }
    throw new Error("Unexpected URL: " + url);
  };

  try {
    const result = await executeAgentTask({
      title: "Failover test",
      description: "Return a short confirmation.",
      taskId: "test-failover-001"
    });
    assert.equal(result, "Fallback model completed the task.");
    assert.equal(calls.length, 2);
    assert.equal(calls[0].body.model, "deepseek-v4-pro");
    assert.equal(calls[1].body.model, "nvidia/nemotron-3-ultra-550b-a55b:free");
    assert.equal(calls[1].authorization, "Bearer test-openrouter-key");
  } finally {
    global.fetch = originalFetch;
    restoreEnv();
  }
});

test("autonomous task executes a requested web-search tool and returns the model's final result", async () => {
  const restoreEnv = setEnv({
    AI_PROVIDER: "openai-compatible",
    AI_API_KEY: "test-primary-key",
    AI_BASE_URL: "https://primary.test/v1",
    AI_MODEL: "test-free-model",
    TAVILY_API_KEY: "test-tavily-key"
  });
  const originalFetch = global.fetch;
  const calls = [];

  global.fetch = async (url, options = {}) => {
    const target = String(url);
    calls.push({ url: target, body: options.body ? JSON.parse(options.body) : null });
    if (target === "https://primary.test/v1/chat/completions" && calls.filter(x => x.url === target).length === 1) {
      return jsonResponse({
        choices: [{
          message: {
            role: "assistant",
            content: null,
            tool_calls: [{
              id: "call_search_1",
              type: "function",
              function: {
                name: "web_search",
                arguments: JSON.stringify({ query: "latest Node.js LTS release" })
              }
            }]
          }
        }]
      });
    }
    if (target === "https://api.tavily.com/search") {
      assert.equal(JSON.parse(options.body).query, "latest Node.js LTS release");
      return jsonResponse({
        answer: "Search found a current Node.js release announcement.",
        results: [{ title: "Node.js release", url: "https://example.test/node", content: "Release notes summary.", score: 0.99 }]
      });
    }
    if (target === "https://primary.test/v1/chat/completions") {
      const body = JSON.parse(options.body);
      assert.ok(body.messages.some(message => message.role === "tool" && message.content.includes("Node.js release")));
      return jsonResponse({ choices: [{ message: { content: "I searched the web and reviewed the returned result." } }] });
    }
    throw new Error("Unexpected URL: " + target);
  };

  try {
    const result = await executeAgentTask({
      title: "Autonomous web-search test",
      description: "Search for the latest Node.js LTS release and summarize the result.",
      taskId: "test-tools-001"
    });
    assert.equal(result, "I searched the web and reviewed the returned result.");
    assert.equal(calls.filter(x => x.url === "https://api.tavily.com/search").length, 1);
    assert.equal(calls.filter(x => x.url === "https://primary.test/v1/chat/completions").length, 2);
  } finally {
    global.fetch = originalFetch;
    restoreEnv();
  }
});
