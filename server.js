const crypto = require("node:crypto");
const express = require("express");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const { createClient } = require("@supabase/supabase-js");
const { registerAgentWorker } = require("./agent-worker");
const { executeAgentTask } = require("./agent-runtime");
const { isWorkerInfoRequest, buildWorkerContext } = require("./worker-context");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const COOKIE_NAME = "pa_session";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;
const APP_PASSWORD = process.env.APP_PASSWORD || "";
const SESSION_SECRET = process.env.SESSION_SECRET || "";
const AI_PROVIDER = (process.env.AI_PROVIDER || "anthropic").toLowerCase();
const OPENROUTER_BASE_URL = (process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1").replace(/\/+$/, "");
const OPENROUTER_READY = Boolean(process.env.OPENROUTER_API_KEY && process.env.OPENROUTER_MODEL);
// Publicly documented HCSN free-tier model IDs. Paid/SVIP models are deliberately excluded.
const HCNSEC_FREE_MODEL_IDS = new Set(["deepseek-v4-pro", "kimi-k3", "step-3.7-flash"]);
const MAX_OUTPUT_TOKENS = Math.min(4000, Math.max(100, Number(process.env.MAX_OUTPUT_TOKENS || 1200)));

const supabaseReady = Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
const supabase = supabaseReady
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false }
    })
  : null;

// Memory fallback is only for local testing. It is lost when the service restarts.
const memorySessions = new Map();
const memoryMessages = new Map();

app.set("trust proxy", 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "28mb" }));
app.use(express.static("public", { etag: true, maxAge: "1h" }));

const limiter = rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: "draft-8", legacyHeaders: false });
app.use("/api/", limiter);

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function sign(value) {
  return crypto.createHmac("sha256", SESSION_SECRET).update(value).digest("base64url");
}

function makeToken() {
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS })).toString("base64url");
  return payload + "." + sign(payload);
}

function isAuthenticated(req) {
  if (!SESSION_SECRET) return false;
  const token = (req.headers.cookie || "").split(";").map(s => s.trim()).find(s => s.startsWith(COOKIE_NAME + "="))?.slice(COOKIE_NAME.length + 1);
  if (!token) return false;
  const [payload, signature] = token.split(".");
  if (!payload || !signature || !safeEqual(signature, sign(payload))) return false;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return Number(parsed.exp) > Math.floor(Date.now() / 1000);
  } catch {
    return false;
  }
}

function requireAuth(req, res, next) {
  if (!isAuthenticated(req)) return res.status(401).json({ error: "Please sign in again." });
  next();
}

function requireConfig(res) {
  if (!APP_PASSWORD || APP_PASSWORD === "change-this-to-a-long-random-password" || SESSION_SECRET.length < 32) {
    res.status(503).json({ error: "Set APP_PASSWORD and a SESSION_SECRET of at least 32 characters in the hosting environment." });
    return false;
  }
  return true;
}

app.get("/health", (_req, res) => res.json({ ok: true, persistence: supabaseReady ? "supabase" : "memory-only" }));

app.get("/api/status", (_req, res) => {
  res.json({
    ok: true,
    authenticated: isAuthenticated(_req),
    persistenceConfigured: supabaseReady,
    provider: AI_PROVIDER,
    configuration: {
      password: Boolean(APP_PASSWORD && APP_PASSWORD !== "change-this-to-a-long-random-password"),
      sessionSecret: SESSION_SECRET.length >= 32,
      aiKey: AI_PROVIDER === "anthropic" ? Boolean(process.env.ANTHROPIC_API_KEY) : Boolean(process.env.AI_API_KEY && process.env.AI_BASE_URL),
      openRouterFallback: OPENROUTER_READY,
      webSearch: Boolean(process.env.TAVILY_API_KEY),
      github: Boolean(process.env.GITHUB_TOKEN),
      autonomousTools: true
    }
  });
});

app.post("/api/login", (req, res) => {
  if (!requireConfig(res)) return;
  const password = String(req.body?.password || "");
  if (!safeEqual(password, APP_PASSWORD)) return res.status(401).json({ error: "Password did not match." });
  res.setHeader("Set-Cookie", `${COOKIE_NAME}=${makeToken()}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_SECONDS}`);
  res.json({ ok: true });
});

app.post("/api/logout", (_req, res) => {
  res.setHeader("Set-Cookie", `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`);
  res.json({ ok: true });
});

app.get("/api/sessions", requireAuth, async (_req, res) => {
  try {
    if (supabase) {
      const { data, error } = await supabase.from("chat_sessions").select("id,title,created_at,updated_at").order("updated_at", { ascending: false }).limit(100);
      if (error) throw error;
      return res.json({ sessions: data || [] });
    }
    return res.json({ sessions: [...memorySessions.values()].sort((a,b) => new Date(b.updated_at || 0) - new Date(a.updated_at || 0)) });
  } catch (error) {
    console.error("sessions error:", error.message);
    return res.status(500).json({ error: "Could not load chat list." });
  }
});

app.get("/api/history/:sessionId", requireAuth, async (req, res) => {
  const sessionId = String(req.params.sessionId || "");
  if (!/^[0-9a-f-]{36}$/i.test(sessionId)) return res.status(400).json({ error: "Invalid conversation ID." });
  try {
    let messages = [];
    if (supabase) {
      const { data, error } = await supabase.from("chat_messages").select("role,content,created_at").eq("session_id", sessionId).order("created_at", { ascending: true }).limit(200);
      if (error) throw error;
      messages = data || [];
    } else messages = memoryMessages.get(sessionId) || [];
    const hydrated = await Promise.all(messages.map(async item => {
      try {
        const parsed = JSON.parse(item.content);
        if (!parsed || parsed.kind !== "chat_message") return item;
        const attachments = await Promise.all((parsed.attachments || []).map(async file => {
          if (!file.path || !supabase) return { ...file, url: null };
          const { data } = await supabase.storage.from("chat-attachments").createSignedUrl(file.path, 3600);
          return { ...file, url: data?.signedUrl || null };
        }));
        return { ...item, content: JSON.stringify({ ...parsed, attachments }) };
      } catch { return item; }
    }));
    return res.json({ messages: hydrated });
  } catch (error) {
    console.error("history error:", error.message);
    return res.status(500).json({ error: "Could not load conversation history." });
  }
});

async function persistMessage(sessionId, role, content) {
  const now = new Date().toISOString();
  if (supabase) {
    const { data: existing, error: lookupError } = await supabase.from("chat_sessions").select("id,title").eq("id", sessionId).maybeSingle();
    if (lookupError) throw lookupError;
    if (!existing) {
      const { error } = await supabase.from("chat_sessions").insert({ id: sessionId, title: role === "user" ? (() => { try { const v = JSON.parse(content); return String(v.text || v.attachments?.[0]?.name || "New chat").slice(0, 70); } catch { return content.slice(0, 70); } })() : "New chat", created_at: now, updated_at: now });
      if (error) throw error;
    } else {
      const updates = { updated_at: now };
      if (role === "user" && (!existing.title || existing.title === "New chat")) { try { const v = JSON.parse(content); updates.title = String(v.text || v.attachments?.[0]?.name || "New chat").slice(0, 70); } catch { updates.title = content.slice(0, 70); } }
      const { error } = await supabase.from("chat_sessions").update(updates).eq("id", sessionId);
      if (error) throw error;
    }
    const { error } = await supabase.from("chat_messages").insert({ session_id: sessionId, role, content });
    if (error) throw error;
  } else {
    const list = memoryMessages.get(sessionId) || [];
    list.push({ role, content, created_at: now });
    memoryMessages.set(sessionId, list);
    const current = memorySessions.get(sessionId) || { id: sessionId, title: content.slice(0, 70), created_at: now };
    if (role === "user" && (!current.title || current.title === "New chat")) current.title = content.slice(0, 70);
    current.updated_at = now;
    memorySessions.set(sessionId, current);
  }
}

async function requestAnthropic(messages, system = "") {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("Missing ANTHROPIC_API_KEY.");
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: process.env.ANTHROPIC_MODEL || "claude-3-5-haiku-latest",
      max_tokens: MAX_OUTPUT_TOKENS,
      ...(system ? { system } : {}),
      messages: messages.map(m => ({ role: m.role, content: m.content }))
    }),
    signal: AbortSignal.timeout(90_000)
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error?.message || `Anthropic API returned HTTP ${response.status}`);
  return (body.content || []).filter(x => x.type === "text").map(x => x.text).join("\n").trim();
}

async function requestCompatible(messages, model, onDelta = null, provider = null) {
  const apiKey = provider?.apiKey || process.env.AI_API_KEY;
  const baseUrl = provider?.baseUrl || process.env.AI_BASE_URL;
  if (!apiKey || !baseUrl || !model) throw new Error("Set the provider API key, base URL, and model.");
  const base = baseUrl.replace(/\/+$/, "");
  const streaming = typeof onDelta === "function";
  const response = await fetch(base + "/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + apiKey },
    body: JSON.stringify({ model, messages, max_tokens: MAX_OUTPUT_TOKENS, stream: streaming }),
    signal: AbortSignal.timeout(90_000)
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error?.message || "AI gateway returned HTTP " + response.status);
  }
  if (!streaming) {
    const body = await response.json().catch(() => ({}));
    return String(body.choices?.[0]?.message?.content || "").trim();
  }
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("text/event-stream")) {
    const body = await response.json().catch(() => ({}));
    const fallbackAnswer = String(body.choices?.[0]?.message?.content || "").trim();
    if (!fallbackAnswer) throw new Error(body.error?.message || "The AI gateway returned neither a stream nor a usable chat response.");
    onDelta(fallbackAnswer);
    return fallbackAnswer;
  }
  if (!response.body) throw new Error("The AI gateway did not provide a streaming response.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "", answer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      let event;
      try { event = JSON.parse(payload); } catch { continue; }
      const delta = event.choices?.[0]?.delta?.content;
      if (typeof delta === "string" && delta) { answer += delta; onDelta(delta); }
      else if (Array.isArray(delta)) {
        for (const part of delta) if (part.type === "text" && part.text) { answer += part.text; onDelta(part.text); }
      }
      if (event.error?.message) throw new Error(event.error.message);
    }
  }
  return answer.trim();
}

async function fetchCompatibleModels() {
  if (!process.env.AI_API_KEY || !process.env.AI_BASE_URL) throw new Error("Set AI_BASE_URL and AI_API_KEY first.");
  const base = process.env.AI_BASE_URL.replace(/\/+$/, "");
  const response = await fetch(base + "/models", {
    headers: { authorization: `Bearer ${process.env.AI_API_KEY}` },
    signal: AbortSignal.timeout(30000)
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error?.message || `Model list request failed (HTTP ${response.status})`);
  const models = Array.isArray(body.data) ? body.data.map(item => String(item.id || "")).filter(Boolean) : [];
  if (!models.length) throw new Error("Provider returned no model IDs.");
  return [...new Set(models)].sort((a, b) => a.localeCompare(b));
}
function isHcnsecProvider() {
  try { return new URL(process.env.AI_BASE_URL || "").hostname.toLowerCase() === "api.hcnsec.cn"; }
  catch { return false; }
}
async function fetchHcnsecFreeModels() {
  if (!isHcnsecProvider()) return [];
  const available = await fetchCompatibleModels();
  return available.filter(id => HCNSEC_FREE_MODEL_IDS.has(id.toLowerCase()));
}
async function fetchOpenRouterModels() {
  if (!process.env.OPENROUTER_API_KEY) return [];
  const response = await fetch(OPENROUTER_BASE_URL + "/models", { headers: { authorization: "Bearer " + process.env.OPENROUTER_API_KEY }, signal: AbortSignal.timeout(30000) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error?.message || `OpenRouter model list failed (HTTP ${response.status})`);
  const records = Array.isArray(body.data) ? body.data : [];
  const isFree = item => {
    const id = String(item?.id || "");
    if (/:free$/i.test(id)) return true;
    const pricing = item?.pricing || {};
    const prompt = Number(pricing.prompt), completion = Number(pricing.completion);
    if (!Number.isFinite(prompt) || !Number.isFinite(completion) || prompt !== 0 || completion !== 0) return false;
    return ["request", "image"].every(key => pricing[key] == null || Number(pricing[key]) === 0);
  };
  return [...new Set(records.filter(isFree).map(item => String(item.id || "")).filter(Boolean))].sort((a,b)=>a.localeCompare(b));
}
app.get("/api/models", requireAuth, async (_req, res) => {
  const models = [], errors = [];
  if (isHcnsecProvider() && process.env.AI_API_KEY) {
    try { for (const id of await fetchHcnsecFreeModels()) models.push({ id, provider: "primary", label: id + " · HCSN Free" }); }
    catch (error) { errors.push("HCSN: " + error.message); }
  }
  if (process.env.OPENROUTER_API_KEY) {
    try { for (const id of await fetchOpenRouterModels()) models.push({ id, provider: "openrouter", label: id + " · OpenRouter Free" }); }
    catch (error) { errors.push("OpenRouter: " + error.message); }
  }
  res.json({ models, preferred: { provider: "primary", id: "" }, automatic: { primary: Boolean(isHcnsecProvider() && process.env.AI_API_KEY && process.env.AI_BASE_URL), openRouter: OPENROUTER_READY }, warning: models.length ? "" : (errors.join(" | ") || "No free HCSN or OpenRouter models are currently available.") });
});

function parseStoredMessage(item) {
  try {
    const value = JSON.parse(item.content);
    if (value?.kind === "chat_message") return value;
  } catch {}
  return { text: item.content, attachments: [] };
}

async function providerHistory(items) {
  return Promise.all(items.map(async item => {
    const saved = parseStoredMessage(item);
    const parts = [{ type: "text", text: saved.modelText || saved.text || "" }];
    for (const file of (saved.attachments || [])) {
      if (file.type?.startsWith("image/") && file.path && supabase) {
        const { data } = await supabase.storage.from("chat-attachments").createSignedUrl(file.path, 3600);
        if (data?.signedUrl) parts.push({ type: "image_url", image_url: { url: data.signedUrl } });
      }
    }
    return { role: item.role, content: parts.length === 1 ? (saved.text || "") : parts };
  }));
}

app.post("/api/chat", requireAuth, async (req, res) => {
  const sessionId = String(req.body?.sessionId || "");
  const content = String(req.body?.message || "").trim();
  const incoming = Array.isArray(req.body?.attachments) ? req.body.attachments : [];
  if (!/^[0-9a-f-]{36}$/i.test(sessionId)) return res.status(400).json({ error: "Start a new conversation first." });
  if (!content && !incoming.length) return res.status(400).json({ error: "Write a message or attach a file." });
  if (content.length > 12000) return res.status(413).json({ error: "Message is too long (12,000 characters max)." });
  if (incoming.length > 4) return res.status(400).json({ error: "Attach up to 4 files at a time." });
  if (!supabase && incoming.length) return res.status(503).json({ error: "File uploads require Supabase storage to be connected." });
  try {
    const savedAttachments = [];
    const imageParts = [];
    const extractedText = [];
    for (const file of incoming) {
      const name = String(file.name || "attachment").replace(/[\\/\\\\]/g, "_").slice(0, 120);
      const type = String(file.type || "application/octet-stream").toLowerCase();
      const allowed = ["image/jpeg","image/png","image/webp","image/gif","text/plain","text/markdown","text/csv","application/json","application/pdf"];
      if (!allowed.includes(type)) return res.status(415).json({ error: "Supported: images, PDF, TXT, MD, CSV and JSON." });
      const match = /^data:([^;,]+);base64,([a-z0-9+/=]+)$/i.exec(String(file.data || ""));
      if (!match || match[1].toLowerCase() !== type) return res.status(400).json({ error: "Invalid file data." });
      const buffer = Buffer.from(match[2], "base64");
      if (!buffer.length || buffer.length > 5 * 1024 * 1024) return res.status(413).json({ error: "Each file must be smaller than 5 MB." });
      const path = sessionId + "/" + crypto.randomUUID() + "-" + name.replace(/[^a-z0-9._-]/gi, "_");
      const { error: uploadError } = await supabase.storage.from("chat-attachments").upload(path, buffer, { contentType: type, upsert: false });
      if (uploadError) throw uploadError;
      savedAttachments.push({ name, type, size: buffer.length, path });
      if (type.startsWith("image/")) imageParts.push({ type: "image_url", image_url: { url: "data:" + type + ";base64," + buffer.toString("base64") } });
      else if (type.startsWith("text/") || type === "application/json") extractedText.push("\n\n--- " + name + " ---\n" + buffer.toString("utf8").slice(0, 30000));
      else extractedText.push("\n\n[PDF attached: " + name + ". It is saved in this chat, but this provider integration does not extract PDF text yet.]");
    }
    const userText = (content || "Please review the attached file(s).") + extractedText.join("");
    const storedUser = JSON.stringify({ kind: "chat_message", text: content, modelText: userText, attachments: savedAttachments });
    let previous = [];
    if (supabase) {
      const { data, error } = await supabase.from("chat_messages").select("role,content").eq("session_id", sessionId).order("created_at", { ascending: true }).limit(40);
      if (error) throw error;
      previous = data || [];
    } else previous = memoryMessages.get(sessionId) || [];
    let messages = await providerHistory(previous);
    const currentContent = imageParts.length ? [{ type: "text", text: userText }, ...imageParts] : userText;
    messages.push({ role: "user", content: currentContent });
    await persistMessage(sessionId, "user", storedUser);
    const streamRequested = req.body?.stream === true && AI_PROVIDER !== "anthropic";
    if (streamRequested) {
      res.status(200);
      res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.flushHeaders?.();
    }
    const sendStreamEvent = event => { if (streamRequested && !res.writableEnded) res.write("data: " + JSON.stringify(event) + "\n\n"); };
    let answer;
    const wantsWorkerInfo = isWorkerInfoRequest(content);
    if (AI_PROVIDER === "anthropic") {
      if (imageParts.length) throw new Error("Image understanding is currently supported through the OpenAI-compatible provider only.");
      const workerContext = wantsWorkerInfo ? buildWorkerContext({ provider: "anthropic", mode: "auto", candidates: [{ provider: "anthropic", model: process.env.ANTHROPIC_MODEL || "claude-3-5-haiku-latest" }], availableModels: [{ provider: "anthropic", id: process.env.ANTHROPIC_MODEL || "claude-3-5-haiku-latest" }], primaryAvailable: true, fallbackAvailable: false }) : "";
      answer = await requestAnthropic(messages, workerContext);
    } else {
      const mode = req.body?.modelMode === "manual" ? "manual" : "auto";
      const requestedModel = String(req.body?.model || "").trim();
      let providers = [];
      if (mode === "manual") {
        const separator = requestedModel.indexOf("::");
        const providerName = separator > 0 ? requestedModel.slice(0, separator) : "primary";
        const modelId = separator > 0 ? requestedModel.slice(separator + 2) : requestedModel;
        if (!modelId) return res.status(400).json({ error: "Choose a model first." });
        if (providerName === "openrouter") {
          const available = await fetchOpenRouterModels();
          if (!available.includes(modelId)) return res.status(400).json({ error: "That OpenRouter model is not in the current model list. Refresh and choose again." });
          providers = [{ name: "openrouter", model: modelId, apiKey: process.env.OPENROUTER_API_KEY, baseUrl: OPENROUTER_BASE_URL }];
        } else if (providerName === "anthropic" && AI_PROVIDER === "anthropic") {
          if (modelId !== (process.env.ANTHROPIC_MODEL || "claude-3-5-haiku-latest")) return res.status(400).json({ error: "Choose the configured Anthropic model." });
          answer = await requestAnthropic(messages);
        } else {
          const available = isHcnsecProvider() ? await fetchHcnsecFreeModels() : await fetchCompatibleModels();
          if (!available.includes(modelId)) return res.status(400).json({ error: isHcnsecProvider() ? "Choose an available HCSN free model from the current model list." : "Choose a primary model from the current model list." });
          providers = [{ name: "primary", model: modelId, apiKey: process.env.AI_API_KEY, baseUrl: process.env.AI_BASE_URL }];
        }
      } else if (AI_PROVIDER === "anthropic") {
        providers = [{ name: "anthropic", model: process.env.ANTHROPIC_MODEL || "claude-3-5-haiku-latest" }];
      } else {
        const preferred = String(process.env.AI_MODEL || "").trim();
        if (isHcnsecProvider() && process.env.AI_API_KEY && process.env.AI_BASE_URL) {
          try {
            const freeModels = await fetchHcnsecFreeModels();
            const selected = freeModels.includes(preferred) ? preferred : freeModels[0];
            if (selected) providers.push({ name: "primary", model: selected, apiKey: process.env.AI_API_KEY, baseUrl: process.env.AI_BASE_URL });
          } catch (error) {
            console.warn("HCSN free-model discovery failed; continuing to OpenRouter fallback:", error.message);
          }
        } else if (preferred && process.env.AI_API_KEY && process.env.AI_BASE_URL) {
          providers.push({ name: "primary", model: preferred, apiKey: process.env.AI_API_KEY, baseUrl: process.env.AI_BASE_URL });
        } else if (process.env.AI_API_KEY && process.env.AI_BASE_URL) {
          const available = await fetchCompatibleModels();
          if (available[0]) providers.push({ name: "primary", model: available[0], apiKey: process.env.AI_API_KEY, baseUrl: process.env.AI_BASE_URL });
        }
        if (OPENROUTER_READY) providers.push({ name: "openrouter", model: process.env.OPENROUTER_MODEL, apiKey: process.env.OPENROUTER_API_KEY, baseUrl: OPENROUTER_BASE_URL });
      }
      if (wantsWorkerInfo) {
        const [primaryResult, openRouterResult] = await Promise.allSettled([
          isHcnsecProvider() ? fetchHcnsecFreeModels() : Promise.resolve([]),
          fetchOpenRouterModels()
        ]);
        const availableModels = [];
        if (primaryResult.status === "fulfilled") {
          for (const id of primaryResult.value) availableModels.push({ provider: "primary", id });
        }
        if (openRouterResult.status === "fulfilled") {
          for (const id of openRouterResult.value) availableModels.push({ provider: "openrouter", id });
        }
        const workerContext = buildWorkerContext({
          provider: isHcnsecProvider() ? "HCSN (OpenAI-compatible)" : AI_PROVIDER,
          mode,
          candidates: providers.map(item => ({ provider: item.name, model: item.model })),
          availableModels,
          primaryAvailable: Boolean(process.env.AI_API_KEY && process.env.AI_BASE_URL),
          fallbackAvailable: OPENROUTER_READY
        });
        messages.unshift({ role: "system", content: workerContext });
      }
      const traceId = crypto.randomUUID();
      let lastError;
      let streamedAny = false;
      let successfulProvider = null;
      for (const provider of providers) {
        if (!provider.model) continue;
        const attemptStartedAt = Date.now();
        console.info("provider_attempt_started " + JSON.stringify({
          event: "provider_attempt_started",
          traceId,
          mode,
          provider: provider.name,
          model: provider.model,
          streaming: streamRequested
        }));
        try {
          answer = provider.name === "anthropic"
            ? await requestAnthropic(messages)
            : await requestCompatible(messages, provider.model, streamRequested ? (delta => { streamedAny = true; sendStreamEvent({ delta }); }) : null, provider);
          if (!answer) throw new Error("The provider returned an empty response.");
          successfulProvider = provider;
          console.info("provider_attempt_succeeded " + JSON.stringify({
            event: "provider_attempt_succeeded",
            traceId,
            mode,
            provider: provider.name,
            model: provider.model,
            elapsedMs: Date.now() - attemptStartedAt,
            streaming: streamRequested
          }));
          break;
        } catch (error) {
          lastError = error;
          const safeError = String(error.message || "unknown provider error")
            .replace(/(Bearer\\s+)[^\\s]+/gi, "$1[redacted]")
            .slice(0, 500);
          console.warn("provider_attempt_failed " + JSON.stringify({
            event: "provider_attempt_failed",
            traceId,
            mode,
            provider: provider.name,
            model: provider.model,
            elapsedMs: Date.now() - attemptStartedAt,
            error: safeError,
            streaming: streamRequested
          }));
          if (streamedAny) break;
        }
      }
      if (!answer) {
        console.warn("chat_provider_result " + JSON.stringify({
          event: "chat_provider_result",
          traceId,
          mode,
          outcome: "failed",
          lastProvider: providers[providers.length - 1]?.name || null
        }));
        throw new Error(lastError?.message || "No configured model could answer this request.");
      }
      console.info("chat_provider_result " + JSON.stringify({
        event: "chat_provider_result",
        traceId,
        mode,
        outcome: "success",
        provider: successfulProvider?.name || "unknown",
        model: successfulProvider?.model || "unknown"
      }));
    }
    if (!answer) throw new Error("The AI provider returned an empty response.");
    await persistMessage(sessionId, "assistant", answer);
    if (streamRequested) {
      sendStreamEvent({ done: true, persistence: supabaseReady ? "supabase" : "memory-only" });
      return res.end();
    }
    return res.json({ answer, persistence: supabaseReady ? "supabase" : "memory-only" });
  } catch (error) {
    console.error("chat error:", error.message);
    if (res.headersSent) {
      if (req.body?.stream === true && !res.writableEnded) {
        res.write("data: " + JSON.stringify({ error: error.message || "The AI request failed." }) + "\n\n");
        return res.end();
      }
      return res.end();
    }
    return res.status(502).json({ error: error.message || "The AI request failed." });
  }
});

app.get(/.*/, (req, res, next) => {
  if (req.path.startsWith("/api/")) return next();
  res.sendFile(require("node:path").join(process.cwd(), "public", "index.html"));
});


registerAgentWorker({
  app,
  supabase,
  requireAuth,
  executeTask: (description, title, taskId) => executeAgentTask({ description, title, taskId })
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Persistent AI Agent listening on ${PORT}; persistence=${supabaseReady ? "supabase" : "memory-only"}; provider=${AI_PROVIDER}`);
});
