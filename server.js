const crypto = require("node:crypto");
const express = require("express");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const { createClient } = require("@supabase/supabase-js");
const { registerAgentWorker } = require("./agent-worker");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const COOKIE_NAME = "pa_session";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;
const APP_PASSWORD = process.env.APP_PASSWORD || "";
const SESSION_SECRET = process.env.SESSION_SECRET || "";
const AI_PROVIDER = (process.env.AI_PROVIDER || "anthropic").toLowerCase();
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
      aiKey: AI_PROVIDER === "anthropic" ? Boolean(process.env.ANTHROPIC_API_KEY) : Boolean(process.env.AI_API_KEY && process.env.AI_BASE_URL)
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

async function requestAnthropic(messages) {
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
      messages: messages.map(m => ({ role: m.role, content: m.content }))
    }),
    signal: AbortSignal.timeout(90_000)
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error?.message || `Anthropic API returned HTTP ${response.status}`);
  return (body.content || []).filter(x => x.type === "text").map(x => x.text).join("\n").trim();
}

async function requestCompatible(messages, model) {
  if (!process.env.AI_API_KEY || !process.env.AI_BASE_URL || !model) {
    throw new Error("Set AI_BASE_URL and AI_API_KEY, and select an available model.");
  }
  const base = process.env.AI_BASE_URL.replace(/\/+$/, "");
  const response = await fetch(base + "/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${process.env.AI_API_KEY}` },
    body: JSON.stringify({ model, messages, max_tokens: MAX_OUTPUT_TOKENS }),
    signal: AbortSignal.timeout(90_000)
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error?.message || `AI gateway returned HTTP ${response.status}`);
  return String(body.choices?.[0]?.message?.content || "").trim();
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
app.get("/api/models", requireAuth, async (_req, res) => {
  try {
    const models = AI_PROVIDER === "anthropic" ? [process.env.ANTHROPIC_MODEL || "claude-3-5-haiku-latest"] : await fetchCompatibleModels();
    res.json({ models, preferred: process.env.AI_MODEL || "" });
  } catch (error) { res.status(502).json({ error: error.message || "Could not load models." }); }
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
    let answer;
    if (AI_PROVIDER === "anthropic") {
      if (imageParts.length) throw new Error("Image understanding is currently supported through the OpenAI-compatible provider only.");
      answer = await requestAnthropic(messages);
    } else {
      const mode = req.body?.modelMode === "manual" ? "manual" : "auto";
      const requestedModel = String(req.body?.model || "").trim();
      const available = await fetchCompatibleModels();
      let candidates;
      if (mode === "manual") {
        if (!requestedModel || !available.includes(requestedModel)) return res.status(400).json({ error: "Choose a model from the current provider model list." });
        candidates = [requestedModel];
      } else candidates = [...(process.env.AI_MODEL && available.includes(process.env.AI_MODEL) ? [process.env.AI_MODEL] : []), ...available.filter(id => id !== process.env.AI_MODEL)].slice(0, 8);
      let lastError;
      for (const model of candidates) {
        try { answer = await requestCompatible(messages, model); if (answer) break; throw new Error("The provider returned an empty response."); }
        catch (error) { lastError = error; console.warn("Model attempt failed (" + model + "): " + error.message); }
      }
      if (!answer) throw new Error(lastError?.message || "No available model could answer this request.");
    }
    if (!answer) throw new Error("The AI provider returned an empty response.");
    await persistMessage(sessionId, "assistant", answer);
    return res.json({ answer, persistence: supabaseReady ? "supabase" : "memory-only" });
  } catch (error) {
    console.error("chat error:", error.message);
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
  executeTask: async (description, title) => {
    const system = "You are the task execution engine for a private personal AI worker. Complete reasoning, drafting, analysis, calculations, and summarization tasks directly. Do not claim to browse websites, control devices, change accounts, run code, deploy software, or perform external actions because no such tools are connected in this v1. If the request requires an external action, clearly explain what is missing and provide the next safe step. Structure substantial answers with a short plan, work/result, and any remaining human action.";
    if (AI_PROVIDER === "anthropic") {
      return requestAnthropic([{ role: "user", content: system + "\n\nTask title: " + title + "\nTask instructions: " + description }]);
    }
    const models = await fetchCompatibleModels();
    const model = process.env.AI_MODEL && models.includes(process.env.AI_MODEL) ? process.env.AI_MODEL : models[0];
    if (!model) throw new Error("No available AI model was returned by the provider.");
    return requestCompatible([
      { role: "system", content: system },
      { role: "user", content: "Task title: " + title + "\nTask instructions: " + description }
    ], model);
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Persistent AI Agent listening on ${PORT}; persistence=${supabaseReady ? "supabase" : "memory-only"}; provider=${AI_PROVIDER}`);
});
