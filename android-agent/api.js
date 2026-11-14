const crypto = require("node:crypto");

const MAX_INSTRUCTION = 4000;
const MAX_STEPS = 20;
const MAX_RESULT = 2000;
const APPROVAL_TTL_MS = 10 * 60 * 1000;
const ALLOWED_PACKAGES = new Set(["com.google.android.youtube"]);
const ACTION_TYPES = new Set([
  "launch_app",
  "find_visible_text",
  "tap_visible_node",
  "type_text",
  "press_back",
  "wait_for_ui",
  "report_state"
]);

function canonical(value) {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object") {
    return "{" + Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + canonical(value[key])).join(",") + "}";
  }
  return JSON.stringify(value);
}

function planHash(steps) {
  return crypto.createHash("sha256").update(canonical(steps)).digest("hex");
}

function validateSteps(input) {
  if (!Array.isArray(input) || input.length < 1 || input.length > MAX_STEPS) {
    throw new Error("A plan must contain 1 to 20 actions.");
  }
  return input.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid action at step " + (index + 1) + ".");
    const type = String(raw.type || "");
    if (!ACTION_TYPES.has(type)) throw new Error("Unsupported action type at step " + (index + 1) + ".");
    const step = { type, explanation: String(raw.explanation || "").trim().slice(0, 240) };
    if (!step.explanation) throw new Error("Every action needs a user-readable explanation.");
    if (type === "launch_app") {
      const packageName = String(raw.packageName || "");
      if (!ALLOWED_PACKAGES.has(packageName)) throw new Error("This app is not in the initial allowed-app list.");
      step.packageName = packageName;
    } else if (type === "find_visible_text" || type === "tap_visible_node") {
      const text = String(raw.text || "").trim();
      if (!text || text.length > 120) throw new Error("Visible text selector must be 1 to 120 characters.");
      step.text = text;
    } else if (type === "type_text") {
      const text = String(raw.text || "");
      if (!text.trim() || text.length > 200 || /\b(password|passcode|pin|otp|one.time.password|recovery.code)\b/i.test(text)) {
        throw new Error("Only ordinary, non-sensitive text up to 200 characters can be typed.");
      }
      step.text = text;
    } else if (type === "wait_for_ui") {
      const timeoutMs = Number(raw.timeoutMs || 5000);
      if (!Number.isInteger(timeoutMs) || timeoutMs < 250 || timeoutMs > 10000) throw new Error("UI wait must be between 250 and 10,000 ms.");
      step.timeoutMs = timeoutMs;
      if (raw.visibleText != null) {
        const visibleText = String(raw.visibleText).trim();
        if (!visibleText || visibleText.length > 120) throw new Error("Invalid wait condition.");
        step.visibleText = visibleText;
      }
    }
    return step;
  });
}

function registerAndroidAgent({ app, supabase, requireAuth }) {
  const base = "/api/android/tasks";
  const noStore = (_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  };
  const requireDb = (res) => {
    if (!supabase) {
      res.status(503).json({ error: "Android task execution requires Supabase persistence. Configure SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY." });
      return false;
    }
    return true;
  };
  const getTask = async (id) => {
    const { data, error } = await supabase.from("android_agent_tasks").select("*").eq("id", id).maybeSingle();
    if (error) throw error;
    return data;
  };

  app.use(base, noStore, requireAuth);

  app.post(base, async (req, res) => {
    if (!requireDb(res)) return;
    const instruction = String(req.body?.instruction || "").trim();
    if (!instruction || instruction.length > MAX_INSTRUCTION) return res.status(400).json({ error: "Instruction must be 1 to 4,000 characters." });
    if (/\b(password|passcode|pin|otp|one.time.password|recovery.code)\b/i.test(instruction)) {
      return res.status(400).json({ error: "Do not send passwords, PINs, OTPs, or recovery codes to the UI assistant." });
    }
    try {
      const { data, error } = await supabase.from("android_agent_tasks")
        .insert({ instruction, status: "planning" })
        .select("id,instruction,status,created_at,updated_at").single();
      if (error) throw error;
      return res.status(201).json({ task: data, next: "submit_plan" });
    } catch (error) {
      console.error("android task create error:", error.message);
      return res.status(500).json({ error: "Could not create Android task." });
    }
  });

  app.get(base, async (_req, res) => {
    if (!requireDb(res)) return;
    try {
      const { data, error } = await supabase.from("android_agent_tasks")
        .select("id,instruction,status,created_at,updated_at,approved_at,completed_at")
        .order("created_at", { ascending: false }).limit(50);
      if (error) throw error;
      return res.json({ tasks: data || [] });
    } catch (error) {
      console.error("android task list error:", error.message);
      return res.status(500).json({ error: "Could not load Android tasks." });
    }
  });

  app.post(base + "/:id/plan", async (req, res) => {
    if (!requireDb(res)) return;
    let steps;
    try { steps = validateSteps(req.body?.steps); }
    catch (error) { return res.status(400).json({ error: error.message }); }
    try {
      const task = await getTask(req.params.id);
      if (!task) return res.status(404).json({ error: "Task not found." });
      if (task.status !== "planning") return res.status(409).json({ error: "A plan can only be submitted once while the task is planning." });
      const hash = planHash(steps);
      const { error } = await supabase.from("android_agent_tasks")
        .update({ plan: steps, plan_hash: hash, status: "pending_approval", updated_at: new Date().toISOString() })
        .eq("id", task.id).eq("status", "planning");
      if (error) throw error;
      const { error: insertError } = await supabase.from("android_agent_actions").insert(
        steps.map((step, index) => ({ task_id: task.id, step_index: index, action_type: step.type, payload: step, status: "queued" }))
      );
      if (insertError) throw insertError;
      return res.status(201).json({ taskId: task.id, status: "pending_approval", plan: steps, planHash: hash, approvalExpiresInSeconds: APPROVAL_TTL_MS / 1000 });
    } catch (error) {
      console.error("android plan error:", error.message);
      return res.status(500).json({ error: "Could not save Android plan." });
    }
  });

  app.get(base + "/:id", async (req, res) => {
    if (!requireDb(res)) return;
    try {
      const task = await getTask(req.params.id);
      if (!task) return res.status(404).json({ error: "Task not found." });
      const { data: actions, error } = await supabase.from("android_agent_actions")
        .select("id,step_index,action_type,payload,status,result,created_at,updated_at")
        .eq("task_id", task.id).order("step_index", { ascending: true });
      if (error) throw error;
      return res.json({ task, actions: actions || [] });
    } catch (error) {
      console.error("android task detail error:", error.message);
      return res.status(500).json({ error: "Could not load Android task." });
    }
  });

  app.post(base + "/:id/approve", async (req, res) => {
    if (!requireDb(res)) return;
    try {
      const task = await getTask(req.params.id);
      if (!task) return res.status(404).json({ error: "Task not found." });
      if (task.status !== "pending_approval" || !task.plan_hash) return res.status(409).json({ error: "Task is not awaiting approval." });
      if (!safeHash(req.body?.planHash, task.plan_hash)) return res.status(409).json({ error: "Plan changed. Review and approve the latest plan." });
      const now = new Date().toISOString();
      const expires = new Date(Date.now() + APPROVAL_TTL_MS).toISOString();
      const { data, error } = await supabase.from("android_agent_tasks")
        .update({ status: "approved", approved_at: now, approval_expires_at: expires, updated_at: now })
        .eq("id", task.id).eq("status", "pending_approval").eq("plan_hash", task.plan_hash)
        .select("id,status,approved_at,approval_expires_at").maybeSingle();
      if (error) throw error;
      if (!data) return res.status(409).json({ error: "Approval was already handled. Refresh task status." });
      return res.json({ task: data });
    } catch (error) {
      console.error("android approve error:", error.message);
      return res.status(500).json({ error: "Could not approve Android task." });
    }
  });

  app.post(base + "/:id/reject", async (req, res) => {
    if (!requireDb(res)) return;
    try {
      const { data, error } = await supabase.from("android_agent_tasks")
        .update({ status: "rejected", updated_at: new Date().toISOString() })
        .eq("id", req.params.id).eq("status", "pending_approval")
        .select("id,status").maybeSingle();
      if (error) throw error;
      if (!data) return res.status(409).json({ error: "Task is not awaiting approval." });
      await supabase.from("android_agent_actions").update({ status: "cancelled", updated_at: new Date().toISOString() }).eq("task_id", req.params.id).eq("status", "queued");
      return res.json({ task: data });
    } catch (error) {
      console.error("android reject error:", error.message);
      return res.status(500).json({ error: "Could not reject Android task." });
    }
  });

  app.get(base + "/:id/next-action", async (req, res) => {
    if (!requireDb(res)) return;
    try {
      const task = await getTask(req.params.id);
      if (!task) return res.status(404).json({ error: "Task not found." });
      if (task.status !== "approved") return res.status(409).json({ error: "Task is not approved for execution." });
      if (!task.approval_expires_at || new Date(task.approval_expires_at).getTime() <= Date.now()) {
        await supabase.from("android_agent_tasks").update({ status: "approval_expired", updated_at: new Date().toISOString() }).eq("id", task.id).eq("status", "approved");
        return res.status(410).json({ error: "Approval expired. Review and approve the plan again." });
      }
      const { data: inFlight, error: inFlightError } = await supabase.from("android_agent_actions")
        .select("id,step_index,action_type,payload").eq("task_id", task.id).eq("status", "dispatched")
        .order("step_index", { ascending: true }).limit(1);
      if (inFlightError) throw inFlightError;
      if (inFlight?.length) return res.json({ action: inFlight[0], redelivery: true, status: "waiting_for_current_action_result" });
      const { data: queued, error } = await supabase.from("android_agent_actions")
        .select("id,step_index,action_type,payload")
        .eq("task_id", task.id).eq("status", "queued")
        .order("step_index", { ascending: true }).limit(1);
      if (error) throw error;
      if (!queued?.length) return res.json({ action: null, status: "awaiting_results_or_complete" });
      const action = queued[0];
      const { data: claimed, error: claimError } = await supabase.from("android_agent_actions")
        .update({ status: "dispatched", dispatched_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq("id", action.id).eq("status", "queued")
        .select("id,step_index,action_type,payload").maybeSingle();
      if (claimError) throw claimError;
      if (!claimed) return res.status(409).json({ error: "Action was claimed by another poll. Retry shortly." });
      return res.json({ action: claimed, planHash: task.plan_hash });
    } catch (error) {
      console.error("android next action error:", error.message);
      return res.status(500).json({ error: "Could not fetch next action." });
    }
  });

  app.post(base + "/:id/action-result", async (req, res) => {
    if (!requireDb(res)) return;
    const actionId = String(req.body?.actionId || "");
    const status = String(req.body?.status || "");
    const allowedStatuses = new Set(["completed", "failed", "blocked"]);
    if (!/^[0-9a-f-]{36}$/i.test(actionId) || !allowedStatuses.has(status)) return res.status(400).json({ error: "Invalid action result." });
    const result = String(req.body?.result || "").slice(0, MAX_RESULT);
    try {
      const task = await getTask(req.params.id);
      if (!task) return res.status(404).json({ error: "Task not found." });
      if (task.status !== "approved" || new Date(task.approval_expires_at || 0).getTime() <= Date.now()) return res.status(409).json({ error: "Task is not currently approved." });
      const { data: action, error } = await supabase.from("android_agent_actions")
        .update({ status, result, completed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq("id", actionId).eq("task_id", task.id).eq("status", "dispatched")
        .select("id,step_index,status").maybeSingle();
      if (error) throw error;
      if (!action) return res.status(409).json({ error: "Action was already acknowledged or was not dispatched." });
      if (status !== "completed") {
        await supabase.from("android_agent_tasks").update({ status: status === "blocked" ? "blocked" : "failed", updated_at: new Date().toISOString() }).eq("id", task.id).eq("status", "approved");
      } else {
        const { data: remaining, error: remainingError } = await supabase.from("android_agent_actions")
          .select("id").eq("task_id", task.id).in("status", ["queued", "dispatched"]).limit(1);
        if (remainingError) throw remainingError;
        if (!remaining?.length) await supabase.from("android_agent_tasks")
          .update({ status: "completed", completed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
          .eq("id", task.id).eq("status", "approved");
      }
      return res.json({ action, taskStatus: status === "completed" ? "in_progress_or_completed" : (status === "blocked" ? "blocked" : "failed") });
    } catch (error) {
      console.error("android action result error:", error.message);
      return res.status(500).json({ error: "Could not save action result." });
    }
  });

  for (const operation of ["pause", "cancel"]) {
    app.post(base + "/:id/" + operation, async (req, res) => {
      if (!requireDb(res)) return;
      const nextStatus = operation === "pause" ? "paused" : "cancelled";
      try {
        const { data, error } = await supabase.from("android_agent_tasks")
          .update({ status: nextStatus, updated_at: new Date().toISOString() })
          .eq("id", req.params.id).in("status", ["planning", "pending_approval", "approved"])
          .select("id,status").maybeSingle();
        if (error) throw error;
        if (!data) return res.status(409).json({ error: "Task cannot be " + operation + "d from its current state." });
        await supabase.from("android_agent_actions").update({ status: "cancelled", updated_at: new Date().toISOString() })
          .eq("task_id", req.params.id).in("status", ["queued", "dispatched"]);
        return res.json({ task: data });
      } catch (error) {
        console.error("android task " + operation + " error:", error.message);
        return res.status(500).json({ error: "Could not " + operation + " Android task." });
      }
    });
  }
}

function safeHash(candidate, expected) {
  return typeof candidate === "string" && /^[a-f0-9]{64}$/i.test(candidate) && crypto.timingSafeEqual(Buffer.from(candidate.toLowerCase()), Buffer.from(expected.toLowerCase()));
}

module.exports = { registerAndroidAgent, validateSteps, planHash };
