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
  "press_enter",
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
      if (type === "tap_visible_node" && !/^(search|search youtube|search icon|search button)$/i.test(text)) throw new Error("Only the visible YouTube search control can be tapped in this version.");
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

function registerAndroidAgent({ app, supabase, requireAuth, generatePlan }) {
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
    let createdTaskId = null;
    try {
      const { data, error } = await supabase.from("android_agent_tasks")
        .insert({ instruction, status: "planning" })
        .select("id,instruction,status,created_at,updated_at").single();
      if (error) throw error;
      createdTaskId = data.id;
      if (typeof generatePlan !== "function") return res.status(201).json({ task: data, next: "submit_plan" });
      const steps = validateSteps(await generatePlan(instruction));
      const hash = planHash(steps);
      const { error: planError } = await supabase.from("android_agent_tasks")
        .update({ plan: steps, plan_hash: hash, status: "pending_approval", updated_at: new Date().toISOString() })
        .eq("id", data.id).eq("status", "planning");
      if (planError) throw planError;
      const { error: actionError } = await supabase.from("android_agent_actions").insert(
        steps.map((step, index) => ({ task_id: data.id, step_index: index, action_type: step.type, payload: step, status: "queued" }))
      );
      if (actionError) throw actionError;
      return res.status(201).json({ task: { ...data, status: "pending_approval" }, plan: steps, planHash: hash, next: "review_and_approve" });
    } catch (error) {
      if (createdTaskId) await supabase.from("android_agent_tasks").update({ status: "failed", updated_at: new Date().toISOString() }).eq("id", createdTaskId).eq("status", "planning");
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
    if (typeof generatePlan !== "function") return res.status(503).json({ error: "AI plan generation is not configured." });
    try {
      const task = await getTask(req.params.id);
      if (!task) return res.status(404).json({ error: "Task not found." });
      if (task.status !== "planning") return res.status(409).json({ error: "A plan can only be generated once while the task is planning." });

      let generated;
      try { generated = await generatePlan(task.instruction); }
      catch (error) {
        console.error("android AI planning error:", error.message);
        return res.status(502).json({ error: "The AI could not create a safe action plan. You can retry planning." });
      }
      let steps;
      try { steps = validateSteps(Array.isArray(generated) ? generated : generated?.steps); }
      catch (error) { return res.status(422).json({ error: "The AI plan did not pass safety validation: " + error.message }); }

      const hash = planHash(steps);
      const now = new Date().toISOString();
      const { data: updated, error: updateError } = await supabase.from("android_agent_tasks")
        .update({ plan: steps, plan_hash: hash, status: "pending_approval", updated_at: now })
        .eq("id", task.id).eq("status", "planning").select("id").maybeSingle();
      if (updateError) throw updateError;
      if (!updated) return res.status(409).json({ error: "This task was already planned. Refresh its status." });

      const { error: insertError } = await supabase.from("android_agent_actions").insert(
        steps.map((step, index) => ({ task_id: task.id, step_index: index, action_type: step.type, payload: step, status: "queued" }))
      );
      if (insertError) {
        await supabase.from("android_agent_tasks").update({ status: "failed", updated_at: new Date().toISOString() }).eq("id", task.id).eq("status", "pending_approval");
        await supabase.from("android_agent_actions").delete().eq("task_id", task.id);
        throw insertError;
      }
      return res.status(201).json({ taskId: task.id, status: "pending_approval", plan: steps, planHash: hash, approvalExpiresInSeconds: APPROVAL_TTL_MS / 1000 });
    } catch (error) {
      console.error("android plan save error:", error.message);
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
      const { data: actions, error } = await supabase.from("android_agent_actions")
        .select("id,step_index,action_type,payload,status").eq("task_id", task.id)
        .order("step_index", { ascending: true });
      if (error) throw error;
      const inFlight = (actions || []).find(item => item.status === "dispatched");
      if (inFlight) return res.json({ action: inFlight, redelivery: true, status: "waiting_for_current_action_result" });
      const next = (actions || []).find(item => item.status !== "completed");
      if (!next) {
        await supabase.from("android_agent_tasks").update({ status: "completed", completed_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", task.id).eq("status", "approved");
        return res.json({ action: null, status: "completed" });
      }
      if (next.status === "dispatched") return res.status(409).json({ error: "The previous action is still awaiting its result. Do not execute another step." });
      if (next.status !== "queued") return res.status(409).json({ error: "The next action is not executable in its current state." });
      const now = new Date().toISOString();
      const { data: claimed, error: claimError } = await supabase.from("android_agent_actions")
        .update({ status: "dispatched", dispatched_at: now, updated_at: now })
        .eq("id", next.id).eq("status", "queued")
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
      if (!["approved", "paused"].includes(task.status) || new Date(task.approval_expires_at || 0).getTime() <= Date.now()) return res.status(409).json({ error: "Task is not currently approved." });
      const { data: ordered, error: orderError } = await supabase.from("android_agent_actions")
        .select("id,step_index,status").eq("task_id", task.id).order("step_index", { ascending: true });
      if (orderError) throw orderError;
      const expected = (ordered || []).find(item => item.status !== "completed");
      if (!expected || expected.id !== actionId || expected.status !== "dispatched") return res.status(409).json({ error: "Only the currently dispatched step can be acknowledged, in order." });
      const now = new Date().toISOString();
      const { data: action, error } = await supabase.from("android_agent_actions")
        .update({ status, result, completed_at: now, updated_at: now })
        .eq("id", actionId).eq("task_id", task.id).eq("status", "dispatched")
        .select("id,step_index,status").maybeSingle();
      if (error) throw error;
      if (!action) return res.status(409).json({ error: "Action was already acknowledged or was not dispatched." });
      if (task.status === "paused") return res.json({ action, taskStatus: "paused" });
      if (status !== "completed") {
        await supabase.from("android_agent_tasks").update({ status: status === "blocked" ? "blocked" : "failed", updated_at: now }).eq("id", task.id).eq("status", "approved");
        await supabase.from("android_agent_actions").update({ status: "cancelled", updated_at: now }).eq("task_id", task.id).eq("status", "queued");
        return res.json({ action, taskStatus: status === "blocked" ? "blocked" : "failed" });
      }
      const { data: remaining, error: remainingError } = await supabase.from("android_agent_actions")
        .select("id").eq("task_id", task.id).neq("status", "completed").limit(1);
      if (remainingError) throw remainingError;
      if (!remaining?.length) {
        await supabase.from("android_agent_tasks").update({ status: "completed", completed_at: now, updated_at: now }).eq("id", task.id).eq("status", "approved");
        return res.json({ action, taskStatus: "completed" });
      }
      return res.json({ action, taskStatus: "approved" });
    } catch (error) {
      console.error("android action result error:", error.message);
      return res.status(500).json({ error: "Could not save action result." });
    }
  });

  app.post(base + "/:id/pause", async (req, res) => {
    if (!requireDb(res)) return;
    try {
      const task = await getTask(req.params.id);
      if (!task || task.status !== "approved") return res.status(409).json({ error: "Only an approved task can be paused." });
      const { data: inFlight, error: inFlightError } = await supabase.from("android_agent_actions")
        .select("id").eq("task_id", task.id).eq("status", "dispatched").limit(1);
      if (inFlightError) throw inFlightError;
      if (inFlight?.length) return res.status(409).json({ error: "Wait for the current UI step to finish, then pause between steps." });
      const { data, error } = await supabase.from("android_agent_tasks")
        .update({ status: "paused", updated_at: new Date().toISOString() })
        .eq("id", req.params.id).eq("status", "approved").select("id,status").maybeSingle();
      if (error) throw error;
      if (!data) return res.status(409).json({ error: "Task state changed. Refresh and try again." });
      return res.json({ task: data });
    } catch (error) {
      console.error("android task pause error:", error.message);
      return res.status(500).json({ error: "Could not pause Android task." });
    }
  });
  app.post(base + "/:id/resume", async (req, res) => {
    if (!requireDb(res)) return;
    try {
      const task = await getTask(req.params.id);
      if (!task) return res.status(404).json({ error: "Task not found." });
      if (task.status !== "paused") return res.status(409).json({ error: "Only a paused task can be resumed." });
      if (!task.approval_expires_at || new Date(task.approval_expires_at).getTime() <= Date.now()) {
        await supabase.from("android_agent_tasks").update({ status: "approval_expired", updated_at: new Date().toISOString() }).eq("id", task.id).eq("status", "paused");
        return res.status(410).json({ error: "Approval expired. Review and approve a new plan." });
      }
      const { data, error } = await supabase.from("android_agent_tasks")
        .update({ status: "approved", updated_at: new Date().toISOString() })
        .eq("id", task.id).eq("status", "paused").select("id,status").maybeSingle();
      if (error) throw error;
      if (!data) return res.status(409).json({ error: "Task state changed. Refresh and try again." });
      return res.json({ task: data });
    } catch (error) {
      console.error("android task resume error:", error.message);
      return res.status(500).json({ error: "Could not resume Android task." });
    }
  });

  app.post(base + "/:id/cancel", async (req, res) => {
    if (!requireDb(res)) return;
    try {
      const { data, error } = await supabase.from("android_agent_tasks")
        .update({ status: "cancelled", updated_at: new Date().toISOString() })
        .eq("id", req.params.id).in("status", ["planning", "pending_approval", "approved", "paused"])
        .select("id,status").maybeSingle();
      if (error) throw error;
      if (!data) return res.status(409).json({ error: "Task cannot be cancelled from its current state." });
      await supabase.from("android_agent_actions").update({ status: "cancelled", updated_at: new Date().toISOString() })
        .eq("task_id", req.params.id).in("status", ["queued", "dispatched"]);
      return res.json({ task: data });
    } catch (error) {
      console.error("android task cancel error:", error.message);
      return res.status(500).json({ error: "Could not cancel Android task." });
    }
  });

}

function safeHash(candidate, expected) {
  return typeof candidate === "string" && /^[a-f0-9]{64}$/i.test(candidate) && crypto.timingSafeEqual(Buffer.from(candidate.toLowerCase()), Buffer.from(expected.toLowerCase()));
}

module.exports = { registerAndroidAgent, validateSteps, planHash };
