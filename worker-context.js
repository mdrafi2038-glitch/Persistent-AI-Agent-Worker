const CONFIG_QUESTION = /(?:provider|model(?:s| id)?|auto\s*mode|manual\s*mode|routing|configuration|config|/api\/models|/api\/status|কোন\s*মডেল|মডেলগুলোর|মডেল\s*আইডি|প্রোভাইডার|অটো\s*মোড|ম্যানুয়াল\s*মোড|কনফিগারেশন|রাউটিং)/i;

function isWorkerInfoRequest(message) {
  return CONFIG_QUESTION.test(String(message || ""));
}

function buildWorkerContext({ provider, mode, candidates = [], availableModels = [], primaryAvailable, fallbackAvailable }) {
  const candidateLines = candidates.map(item => "- " + String(item.provider) + ": " + String(item.model));
  const modelLines = availableModels.map(item => "- " + String(item.provider) + ": " + String(item.id));
  const routing = mode === "manual"
    ? "Manual mode: the user-selected provider and model are used directly. Automatic fallback is not applied to a manually selected model."
    : "Auto mode: the configured primary provider/model is tried first; if it fails, the configured OpenRouter fallback is tried when available.";
  return [
    "TRUSTED SERVER-SUPPLIED WORKER RUNTIME CONTEXT:",
    "You are the chat assistant inside the user's Persistent AI Agent Worker application, not a generic standalone chatbot.",
    "You may disclose the non-secret runtime facts in this context when asked. Do not claim you cannot access your own application's configuration or that this is forbidden system information.",
    "Never reveal API keys, passwords, cookies, tokens, authorization headers, secret values, or full environment variables.",
    "Configured primary provider: " + String(provider || "unknown"),
    "Request mode: " + String(mode || "auto"),
    "Provider/model candidates for this request (ordered):",
    ...(candidateLines.length ? candidateLines : ["- No model candidate could be resolved."]),
    "Available model catalogue returned by the server:",
    ...(modelLines.length ? modelLines : ["- The server could not retrieve any model IDs for this request; do not invent names."]),
    "Primary provider configured: " + Boolean(primaryAvailable),
    "OpenRouter fallback configured: " + Boolean(fallbackAvailable),
    routing,
    "Explain that the candidate list is the route order, not proof of which provider ultimately succeeded unless the backend explicitly confirms it.",
    "If the catalogue lookup failed, say so plainly. Do not claim that you personally called arbitrary endpoints; the backend supplied this context."
  ].join("\n");
}

module.exports = { isWorkerInfoRequest, buildWorkerContext };
