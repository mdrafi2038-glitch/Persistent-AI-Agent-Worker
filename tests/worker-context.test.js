const test = require("node:test");
const assert = require("node:assert/strict");
const { isWorkerInfoRequest, buildWorkerContext } = require("../worker-context");

test("detects Bengali and English worker configuration questions", () => {
  assert.equal(isWorkerInfoRequest("Which AI provider and model are active?"), true);
  assert.equal(isWorkerInfoRequest("Auto mode আর Manual mode-এর পার্থক্য কী?"), true);
  assert.equal(isWorkerInfoRequest("আজকের আবহাওয়া কেমন?"), false);
});

test("builds accurate, secret-free runtime context for auto mode", () => {
  const context = buildWorkerContext({
    provider: "HCSN (OpenAI-compatible)",
    mode: "auto",
    candidates: [
      { provider: "primary", model: "deepseek-v4-pro" },
      { provider: "openrouter", model: "nvidia/nemotron-3-ultra-550b-a55b:free" }
    ],
    availableModels: [
      { provider: "primary", id: "deepseek-v4-pro" },
      { provider: "openrouter", id: "nvidia/nemotron-3-ultra-550b-a55b:free" }
    ],
    primaryAvailable: true,
    fallbackAvailable: true
  });
  assert.match(context, /HCSN/);
  assert.match(context, /Auto mode/);
  assert.match(context, /deepseek-v4-pro/);
  assert.match(context, /nvidia\/nemotron-3-ultra-550b-a55b:free/);
  assert.match(context, /Never reveal API keys/);
  assert.doesNotMatch(context, /test-secret|Bearer\s/i);
});

test("manual mode explicitly explains direct selection without fallback", () => {
  const context = buildWorkerContext({
    provider: "HCSN",
    mode: "manual",
    candidates: [{ provider: "openrouter", model: "some-free-model:free" }],
    availableModels: [],
    primaryAvailable: true,
    fallbackAvailable: true
  });
  assert.match(context, /used directly/);
  assert.match(context, /fallback is not applied/);
  assert.match(context, /could not retrieve/);
});
