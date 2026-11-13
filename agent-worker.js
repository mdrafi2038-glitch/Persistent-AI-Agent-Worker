const POLL_MS = 5000;
const MAX_TASK_CHARS = 12000;
const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [15000, 60000];

function registerAgentWorker({ app, supabase, requireAuth, executeTask }) {
  let processing = false;

  app.get("/api/tasks", requireAuth, async (_req, res) => {
    if (!supabase) return res.status(503).json({ error: "Persistent task storage is not configured." });
    try {
      const { data, error } = await supabase.from("agent_tasks")
        .select("id,title,description,status,result,scheduled_at,attempt_count,max_attempts,last_error,created_at,updated_at")
        .order("created_at", { ascending: false }).limit(50);
      if (error) throw error;
      return res.json({ tasks: data || [] });
    } catch (error) {
      console.error("task list error:", error.message);
      return res.status(500).json({ error: "Could not load tasks." });
    }
  });

  app.post("/api/tasks", requireAuth, async (req, res) => {
    if (!supabase) return res.status(503).json({ error: "Persistent task storage is not configured." });
    const title = String(req.body?.title || "").trim().slice(0, 120);
    const description = String(req.body?.description || "").trim();
    const scheduledAt = req.body?.scheduledAt ? new Date(req.body.scheduledAt) : null;
    if (!title || !description) return res.status(400).json({ error: "Enter a task title and instructions." });
    if (description.length > MAX_TASK_CHARS) return res.status(413).json({ error: "Task instructions are too long." });
    if (scheduledAt && Number.isNaN(scheduledAt.getTime())) return res.status(400).json({ error: "Invalid scheduled date." });
    try {
      const { data, error } = await supabase.from("agent_tasks").insert({
        title, description, status: "queued", scheduled_at: scheduledAt?.toISOString() || null,
        attempt_count: 0, max_attempts: MAX_ATTEMPTS, last_error: null
      }).select("id,title,description,status,result,scheduled_at,attempt_count,max_attempts,last_error,created_at,updated_at").single();
      if (error) throw error;
      return res.status(201).json({ task: data });
    } catch (error) {
      console.error("task create error:", error.message);
      return res.status(500).json({ error: "Could not create task." });
    }
  });

  app.post("/api/tasks/:id/cancel", requireAuth, async (req, res) => {
    if (!supabase) return res.status(503).json({ error: "Persistent task storage is not configured." });
    try {
      const { data, error } = await supabase.from("agent_tasks")
        .update({ status: "cancelled", updated_at: new Date().toISOString() })
        .eq("id", req.params.id).eq("status", "queued").select("id,status").maybeSingle();
      if (error) throw error;
      if (!data) return res.status(409).json({ error: "Only queued tasks can be cancelled." });
      return res.json({ task: data });
    } catch (error) {
      console.error("task cancel error:", error.message);
      return res.status(500).json({ error: "Could not cancel task." });
    }
  });

  app.post("/api/tasks/:id/retry", requireAuth, async (req, res) => {
    if (!supabase) return res.status(503).json({ error: "Persistent task storage is not configured." });
    try {
      const { data, error } = await supabase.from("agent_tasks")
        .update({ status: "queued", attempt_count: 0, max_attempts: MAX_ATTEMPTS,
          scheduled_at: null, last_error: null, result: null, updated_at: new Date().toISOString() })
        .eq("id", req.params.id).eq("status", "failed")
        .select("id,status,attempt_count,max_attempts").maybeSingle();
      if (error) throw error;
      if (!data) return res.status(409).json({ error: "Only failed tasks can be retried." });
      return res.json({ task: data });
    } catch (error) {
      console.error("task retry error:", error.message);
      return res.status(500).json({ error: "Could not retry task." });
    }
  });

  async function runOne() {
    if (processing || !supabase) return;
    processing = true;
    try {
      const now = new Date().toISOString();
      const { data: queued, error: readError } = await supabase.from("agent_tasks")
        .select("id,title,description,attempt_count,max_attempts")
        .eq("status", "queued").or("scheduled_at.is.null,scheduled_at.lte." + now)
        .order("created_at", { ascending: true }).limit(1);
      if (readError) throw readError;
      const task = queued?.[0];
      if (!task) return;

      const attempt = Number(task.attempt_count || 0) + 1;
      const { data: claimed, error: claimError } = await supabase.from("agent_tasks")
        .update({ status: "running", attempt_count: attempt, updated_at: now })
        .eq("id", task.id).eq("status", "queued")
        .select("id").maybeSingle();
      if (claimError) throw claimError;
      if (!claimed) return;

      try {
        const result = await executeTask(task.description, task.title, task.id);
        const { error } = await supabase.from("agent_tasks").update({
          status: "completed",
          result: String(result || "Task completed without a text result.").slice(0, 60000),
          last_error: null, updated_at: new Date().toISOString()
        }).eq("id", task.id).eq("status", "running");
        if (error) throw error;
      } catch (error) {
        const message = String(error.message || "Task failed.").slice(0, 4000);
        const maxAttempts = Math.min(MAX_ATTEMPTS, Math.max(1, Number(task.max_attempts || MAX_ATTEMPTS)));
        const retry = attempt < maxAttempts;
        const delay = BACKOFF_MS[Math.min(attempt - 1, BACKOFF_MS.length - 1)];
        const nextRun = new Date(Date.now() + delay).toISOString();
        console.error("task execution error (" + attempt + "/" + maxAttempts + "):", message);
        const { error: saveError } = await supabase.from("agent_tasks").update({
          status: retry ? "queued" : "failed",
          scheduled_at: retry ? nextRun : null,
          last_error: message,
          result: retry
            ? "Attempt " + attempt + " failed. Automatic retry scheduled.\n\nReason: " + message
            : "Task failed after " + attempt + " attempt(s).\n\nReason: " + message,
          updated_at: new Date().toISOString()
        }).eq("id", task.id).eq("status", "running");
        if (saveError) console.error("could not save task retry state:", saveError.message);
      }
    } catch (error) {
      console.error("task worker poll error:", error.message);
    } finally {
      processing = false;
    }
  }

  const timer = setInterval(runOne, POLL_MS);
  timer.unref?.();
  runOne();
}

module.exports = { registerAgentWorker };
