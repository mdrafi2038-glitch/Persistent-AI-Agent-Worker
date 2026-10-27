const crypto = require("node:crypto");
const express = require("express");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const { createClient } = require("@supabase/supabase-js");

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
app.use(express.json({ limit: "1mb" }));
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
    authenticated: false,
    persistenceConfigured: supabaseReady,
    provider: AI_PROVIDER,
    configuration: {
      password: Boolean(APP_PASSWORD && APP_PASSWORD !== "change-this-to-a-long-random-password"),
      sessionSecret: SESSION_SECRET.length >= 32,
      aiKey: AI_PROVIDER === "anthropic" ? Boolean(process.env.ANTHROPIC_API_KEY) : Boolean(process.env.AI_API_KEY && process.env.AI_BASE_URL && process.env.AI_MODEL)
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

app.get("/api/history/:sessionId", requireAuth, async (req, res) => {
  const sessionId = String(req.params.sessionId || "");
  if (!/^[0-9a-f-]{36}$/i.test(sessionId)) return res.status(400).json({ error: "Invalid conversation ID." });
  try {
    if (supabase) {
      const { data, error } = await supabase.from("chat_messages").select("role,content,created_at").eq("session_id", sessionId).order("created_at", { ascending: true }).limit(200);
      if (error) throw error;
      return res.json({ messages: data || [] });
    }
    return res.json({ messages: memoryMessages.get(sessionId) || [] });
  } catch (error) {
    console.error("history error:", error.message);
    return res.status(500).json({ error: "Could not load conversation history. Check Supabase schema and environment variables." });
  }
});

async function persistMessage(sessionId, role, content) {
  if (supabase) {
    const { error: sessionError } = await supabase.from("chat_sessions").upsert({
      id: sessionId,
      title: role === "user" ? content.slice(0, 70) : "New chat",
      updated_at: new Date().toISOString()
    }, { onConflict: "id", ignoreDuplicates: false });
    if (sessionError) throw sessionError;
    const { error } = await supabase.from("chat_messages").insert({ session_id: sessionId, role, content });
    if (error) throw error;
  } else {
    const list = memoryMessages.get(sessionId) || [];
    list.push({ role, content, created_at: new Date().toISOString() });
    memoryMessages.set(sessionId, list);
    if (!memorySessions.has(sessionId)) memorySessions.set(sessionId, { id: sessionId, title: content.slice(0, 70) });
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

async function requestCompatible(messages) {
  if (!process.env.AI_API_KEY || !process.env.AI_BASE_URL || !process.env.AI_MODEL) {
    throw new Error("Set AI_BASE_URL, AI_API_KEY and AI_MODEL for the OpenAI-compatible provider.");
  }
  const base = process.env.AI_BASE_URL.replace(/\/+$/, "");
  const response = await fetch(base + "/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${process.env.AI_API_KEY}` },
    body: JSON.stringify({ model: process.env.AI_MODEL, messages, max_tokens: MAX_OUTPUT_TOKENS }),
    signal: AbortSignal.timeout(90_000)
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error?.message || `AI gateway returned HTTP ${response.status}`);
  return String(body.choices?.[0]?.message?.content || "").trim();
}

app.post("/api/chat", requireAuth, async (req, res) => {
  const sessionId = String(req.body?.sessionId || "");
  const content = String(req.body?.message || "").trim();
  if (!/^[0-9a-f-]{36}$/i.test(sessionId)) return res.status(400).json({ error: "Start a new conversation first." });
  if (!content) return res.status(400).json({ error: "Message cannot be empty." });
  if (content.length > 12000) return res.status(413).json({ error: "Message is too long (12,000 characters max)." });
  try {
    let previous = [];
    if (supabase) {
      const { data, error } = await supabase.from("chat_messages").select("role,content").eq("session_id", sessionId).order("created_at", { ascending: true }).limit(40);
      if (error) throw error;
      previous = data || [];
    } else {
      previous = memoryMessages.get(sessionId) || [];
    }
    const messages = [...previous.map(m => ({ role: m.role, content: m.content })), { role: "user", content }];
    await persistMessage(sessionId, "user", content);
    const answer = AI_PROVIDER === "anthropic" ? await requestAnthropic(messages) : await requestCompatible(messages);
    if (!answer) throw new Error("The AI provider returned an empty response.");
    await persistMessage(sessionId, "assistant", answer);
    return res.json({ answer, persistence: supabaseReady ? "supabase" : "memory-only" });
  } catch (error) {
    console.error("chat error:", error.message);
    return res.status(502).json({ error: error.message || "The AI request failed. Check provider settings." });
  }
});

app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api/")) return next();
  res.sendFile(require("node:path").join(process.cwd(), "public", "index.html"));
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Persistent AI Agent listening on ${PORT}; persistence=${supabaseReady ? "supabase" : "memory-only"}; provider=${AI_PROVIDER}`);
});
