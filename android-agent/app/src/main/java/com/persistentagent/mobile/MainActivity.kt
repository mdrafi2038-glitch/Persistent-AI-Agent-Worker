package com.persistentagent.mobile

import android.Manifest
import android.app.AlertDialog
import android.app.AlarmManager
import android.app.DatePickerDialog
import android.app.PendingIntent
import android.app.TimePickerDialog
import android.content.ComponentName
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.speech.RecognizerIntent
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import android.app.Activity
import org.json.JSONObject
import org.json.JSONArray
import java.util.Calendar
import java.util.Locale

class MainActivity : Activity() {
    private val agentUrl = "https://persistent-ai-agent-worker.onrender.com"
    private lateinit var root: LinearLayout
    private lateinit var command: EditText
    private lateinit var result: TextView
    private var webView: WebView? = null
    private var reminderText = "Reminder"
    private val speechRequest = 410
    private val taskHandler = Handler(Looper.getMainLooper())
    private var activeUiTaskId: String? = null
    private var pendingUiTaskId: String? = null
    private var pendingUiPlanHash: String? = null
    private var pausedUiTaskId: String? = null
    private var pollInProgress = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        requestRuntimePermissions()
        pausedUiTaskId = getSharedPreferences("android_ui_task", MODE_PRIVATE).getString("paused_task_id", null)
        startForegroundService(Intent(this, AgentForegroundService::class.java))
        showHome()
    }

    private fun requestRuntimePermissions() {
        val permissions = mutableListOf<String>()
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) permissions += Manifest.permission.POST_NOTIFICATIONS
        if (permissions.isNotEmpty()) requestPermissions(permissions.toTypedArray(), 21)
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()

    private fun rounded(color: Int, radius: Int = 20, stroke: Int = 0): GradientDrawable =
        GradientDrawable().apply {
            setColor(color)
            cornerRadius = dp(radius).toFloat()
            if (stroke != 0) setStroke(dp(1), stroke)
        }

    private fun textView(value: String, size: Float, color: Int, bold: Boolean = false): TextView =
        TextView(this).apply {
            text = value
            textSize = size
            setTextColor(color)
            if (bold) setTypeface(typeface, android.graphics.Typeface.BOLD)
        }

    private fun panel(): LinearLayout = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        setPadding(dp(18), dp(16), dp(18), dp(16))
        background = rounded(0xFFFFFFFF.toInt(), 20, 0xFFE8ECF4.toInt())
    }

    private fun actionButton(label: String, primary: Boolean = false, action: () -> Unit): Button =
        Button(this).apply {
            text = label
            isAllCaps = false
            textSize = 14f
            setTextColor(if (primary) 0xFFFFFFFF.toInt() else 0xFF26344D.toInt())
            background = rounded(if (primary) 0xFF315EFB.toInt() else 0xFFF0F3FA.toInt(), 14)
            minHeight = dp(48)
            setPadding(dp(14), dp(8), dp(14), dp(8))
            setOnClickListener { action() }
        }

    private fun addSectionHeading(title: String, subtitle: String? = null) {
        root.addView(textView(title, 17f, 0xFF1C2940.toInt(), true))
        if (!subtitle.isNullOrBlank()) {
            root.addView(textView(subtitle, 12f, 0xFF7B879B.toInt()))
        }
    }

    private fun base(title: String): LinearLayout {
        root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(18), dp(18), dp(18), dp(22))
            setBackgroundColor(0xFFF5F7FC.toInt())
        }
        val brand = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(0, dp(4), 0, dp(14))
        }
        brand.addView(textView("PERSISTENT  •  AI WORKER", 11f, 0xFF526A9B.toInt(), true))
        brand.addView(textView(title, 27f, 0xFF17243B.toInt(), true))
        root.addView(brand)
        val nav = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            setPadding(dp(4), dp(4), dp(4), dp(4))
            background = rounded(0xFFE9EEF8.toInt(), 16)
        }
        nav.addView(actionButton("Automation", title != "AI Chat") { showHome() }, LinearLayout.LayoutParams(0, -2, 1f))
        nav.addView(actionButton("AI Chat", title == "AI Chat") { showChat() }, LinearLayout.LayoutParams(0, -2, 1f))
        root.addView(nav, LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = dp(18) })
        return root
    }

    private fun addButton(label: String, action: () -> Unit) {
        root.addView(actionButton(label, false, action), LinearLayout.LayoutParams(-1, -2).apply {
            topMargin = dp(7)
        })
    }

    private fun showHome() {
        webView?.destroy(); webView = null
        base("Your AI workspace")

        val hero = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(20), dp(20), dp(20), dp(20))
            background = GradientDrawable(
                GradientDrawable.Orientation.TL_BR,
                intArrayOf(0xFF203B78.toInt(), 0xFF315EFB.toInt())
            ).apply { cornerRadius = dp(22).toFloat() }
        }
        hero.addView(textView("ONE AGENT. MANY TASKS.", 11f, 0xFFD9E4FF.toInt(), true))
        hero.addView(textView("What should I do for you?", 23f, 0xFFFFFFFF.toInt(), true))
        hero.addView(textView("Write a command in Bangla, Banglish or English. The AI will plan the visible steps.", 14f, 0xFFEAF0FF.toInt()))
        root.addView(hero, LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = dp(16) })

        val commandCard = panel()
        commandCard.addView(textView("YOUR COMMAND", 11f, 0xFF71809A.toInt(), true))
        command = EditText(this).apply {
            hint = "যেমন: YouTube খুলে একটি গান খুঁজে দাও"
            minLines = 2
            textSize = 16f
            setTextColor(0xFF1D2B43.toInt())
            setHintTextColor(0xFF98A3B5.toInt())
            setPadding(dp(14), dp(12), dp(14), dp(12))
            background = rounded(0xFFF5F7FB.toInt(), 14, 0xFFE4E9F2.toInt())
        }
        commandCard.addView(command, LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(10) })
        commandCard.addView(actionButton("✦  Plan & run with AI", true) {
            submitVisibleUiTask(command.text.toString())
        }, LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(12) })
        commandCard.addView(textView("You review the plan before the phone performs approved actions.", 12f, 0xFF7B879B.toInt()).apply {
            setPadding(0, dp(8), 0, 0)
        })
        root.addView(commandCard, LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = dp(18) })

        addSectionHeading("Task controls", "Manage the current task and Android access")
        val controls = panel()
        controls.addView(actionButton("Enable Accessibility assistance") {
            startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
        })
        controls.addView(actionButton("Pause current task") { stopCurrentUiTask("pause") }, LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(8) })
        controls.addView(actionButton("Resume paused task") { resumePausedUiTask() }, LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(8) })
        controls.addView(actionButton("Cancel current task") { stopCurrentUiTask("cancel") }, LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(8) })
        controls.addView(actionButton("View task history") { showTaskHistory() }, LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(8) })
        root.addView(controls, LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(10); bottomMargin = dp(18) })

        addSectionHeading("More tools", "Connections, reminders and phone settings")
        val tools = panel()
        tools.addView(actionButton("Connect to Worker") { connectBridge() })
        tools.addView(actionButton("Set a reminder") { chooseReminder() }, LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(8) })
        tools.addView(actionButton("Open app by name") { openApp(command.text.toString()) }, LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(8) })
        tools.addView(actionButton("Android settings") { startActivity(Intent(Settings.ACTION_SETTINGS)) }, LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(8) })
        tools.addView(actionButton("App permissions") {
            startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName")))
        }, LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(8) })
        tools.addView(actionButton("Battery & background settings") {
            startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
        }, LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(8) })
        root.addView(tools, LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(10) })

        val statusCard = panel()
        statusCard.addView(textView("ACTIVITY", 11f, 0xFF71809A.toInt(), true))
        result = textView("Ready when you are.", 14f, 0xFF34435D.toInt())
        statusCard.addView(result, LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(6) })
        root.addView(statusCard, LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(16) })
        setContentView(ScrollView(this).apply {
            clipToPadding = false
            setPadding(0, 0, 0, dp(10))
            addView(root)
        })
    }

    private fun showChat() {
        webView?.destroy()
        base("AI Chat")
        val intro = panel()
        intro.addView(textView("Talk to your AI Worker", 18f, 0xFF1C2940.toInt(), true))
        intro.addView(textView("Chat, ask questions and work with your persistent AI workspace.", 13f, 0xFF71809A.toInt()))
        root.addView(intro, LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = dp(12) })
        val web = WebView(this)
        web.settings.javaScriptEnabled = true
        web.settings.domStorageEnabled = true
        web.webViewClient = WebViewClient()
        web.webChromeClient = WebChromeClient()
        web.loadUrl(agentUrl)
        webView = web
        root.addView(web, LinearLayout.LayoutParams(-1, 0, 1f))
        setContentView(root)
    }

    private fun connectBridge() {
        result.text = "Worker-এর সাথে সংযোগ হচ্ছে..."
        AndroidBridgeClient.fetchCapabilities { response ->
            runOnUiThread {
                response.onSuccess { payload ->
                    val capabilities = payload.optJSONArray("capabilities")
                    val names = (0 until (capabilities?.length() ?: 0)).mapNotNull { index ->
                        capabilities?.optJSONObject(index)?.optString("id")
                    }
                    result.text = "Bridge connected (read-only). Available local capabilities: " + names.joinToString()
                    toast("Worker connection verified. Remote actions are not enabled yet.")
                }.onFailure { error ->
                    result.text = "Bridge connection failed: " + (error.message ?: "Unknown error")
                    toast(result.text.toString())
                }
            }
        }
    }

    private fun getLaunchableApps(instruction: String): JSONArray {
        val apps = JSONArray()
        val blocked = setOf("com.android.settings", "com.android.permissioncontroller", "com.google.android.permissioncontroller", "com.android.packageinstaller", "com.google.android.packageinstaller", "com.persistentagent.mobile")
        val command = instruction.lowercase(Locale.ROOT)
        val installed = packageManager.getInstalledApplications(PackageManager.GET_META_DATA)
            .filter { app -> app.packageName !in blocked && !app.packageName.startsWith("com.persistentagent.") }
            .mapNotNull { app ->
                if (packageManager.getLaunchIntentForPackage(app.packageName) == null) return@mapNotNull null
                val label = packageManager.getApplicationLabel(app).toString().take(80)
                if (!command.contains(label.lowercase(Locale.ROOT)) && !command.contains(app.packageName.lowercase(Locale.ROOT))) return@mapNotNull null
                JSONObject().put("packageName", app.packageName).put("label", label)
            }
            .distinctBy { it.optString("packageName") }
            .take(5)
        installed.forEach { apps.put(it) }
        return apps
    }

    private fun submitVisibleUiTask(instruction: String) {
        if (instruction.isBlank()) { toast("আগে একটি নির্দেশ লিখুন।"); return }
        result.text = "AI নিরাপদ UI plan তৈরি করছে..."
        AndroidTaskClient.createTask(instruction, getLaunchableApps(instruction)) { response ->
            runOnUiThread {
                response.onSuccess { payload ->
                    val task = payload.optJSONObject("task")
                    val taskId = task?.optString("id").orEmpty()
                    val plan = payload.optJSONArray("plan")
                    val hash = payload.optString("planHash")
                    if (taskId.isNotBlank() && hash.isNotBlank()) { pendingUiTaskId = taskId; pendingUiPlanHash = hash }
                    if (taskId.isBlank() || plan == null || hash.isBlank()) {
                        result.text = "Plan পাওয়া যায়নি: " + payload.optString("error", "Try again.")
                        return@onSuccess
                    }
                    val lines = (0 until plan.length()).mapNotNull { index ->
                        val step = plan.optJSONObject(index) ?: return@mapNotNull null
                        val detail = when (step.optString("type")) {
                            "type_text" -> " — text: " + step.optString("text")
                            "launch_app" -> " — app: " + step.optString("packageName")
                            "find_visible_text", "tap_visible_node" -> " — target: " + step.optString("text")
                            else -> ""
                        }
                        "${index + 1}. ${step.optString("explanation")} (${step.optString("type")})$detail"
                    }
                    AlertDialog.Builder(this)
                        .setTitle("Review Android action plan")
                        .setMessage(lines.joinToString("\n"))
                        .setPositiveButton("Approve & run") { _, _ -> approveVisibleUiTask(taskId, hash) }
                        .setNegativeButton("Reject") { _, _ ->
                            AndroidTaskClient.rejectTask(taskId) { rejected ->
                                runOnUiThread {
                                    if (rejected.isSuccess) { pendingUiTaskId = null; pendingUiPlanHash = null }
                                    result.text = if (rejected.isSuccess) "Plan rejected." else "Could not reject plan."
                                }
                            }
                        }
                        .show()
                    result.text = "Plan ready. Review and approve before the phone acts."
                }.onFailure { error ->
                    result.text = "Task planning failed: " + (error.message ?: "Unknown error")
                    toast(result.text.toString())
                }
            }
        }
    }

    private fun approveVisibleUiTask(taskId: String, planHash: String) {
        if (!isAccessibilityEnabled()) {
            AlertDialog.Builder(this)
                .setTitle("Accessibility permission needed")
                .setMessage("Visible UI assistance needs Android Accessibility permission. It will only run approved steps while a task is active. You can disable it anytime in Android Settings.")
                .setPositiveButton("Open Settings") { _, _ -> startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)) }
                .setNegativeButton("Not now", null)
                .show()
            return
        }
        val service = VisibleUiAccessibilityService.instance
        if (service == null) {
            toast("Accessibility service চালু হচ্ছে। কয়েক সেকেন্ড পর আবার Approve করুন।")
            return
        }
        result.text = "আপনার approval Worker-এ পাঠানো হচ্ছে..."
        AndroidTaskClient.approveTask(taskId, planHash) { response ->
            runOnUiThread {
                response.onSuccess {
                    activeUiTaskId = taskId
                    pendingUiTaskId = null
                    pendingUiPlanHash = null
                    pollInProgress = false
                    service.setApprovedTaskActive(true)
                    result.text = "Approved. Android app UI steps চালানো হচ্ছে..."
                    pollVisibleUiTask()
                }.onFailure { error ->
                    result.text = "Approval failed: " + (error.message ?: "Unknown error")
                    toast(result.text.toString())
                }
            }
        }
    }

    private fun isAccessibilityEnabled(): Boolean {
        val expected = ComponentName(this, VisibleUiAccessibilityService::class.java).flattenToString()
        val enabled = Settings.Secure.getString(contentResolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES).orEmpty()
        return enabled.split(':').any { it.equals(expected, ignoreCase = true) }
    }

    private fun pollVisibleUiTask() {
        val taskId = activeUiTaskId ?: return
        if (pollInProgress) return
        pollInProgress = true
        AndroidTaskClient.nextAction(taskId) { response ->
            runOnUiThread {
                pollInProgress = false
                response.onSuccess { payload ->
                    val action = payload.optJSONObject("action")
                    if (action == null) {
                        taskHandler.postDelayed({ pollVisibleUiTask() }, 1500)
                        return@onSuccess
                    }
                    val actionId = action.optString("id")
                    val stepNumber = action.optInt("step_index", 0) + 1
                    result.text = "কাজ চলছে — ধাপ $stepNumber: " + action.optString("action_type")
                    val redelivery = payload.optBoolean("redelivery")
                    val prefs = getSharedPreferences("android_ui_task", MODE_PRIVATE)
                    val pendingId = prefs.getString("pending_action_id", null)
                    if (redelivery) {
                        if (pendingId == actionId) {
                            acknowledgeVisibleUiAction(taskId, actionId,
                                prefs.getString("pending_action_status", "blocked") ?: "blocked",
                                prefs.getString("pending_action_result", "Retrying saved action acknowledgement.") ?: "")
                        } else {
                            acknowledgeVisibleUiAction(taskId, actionId, "blocked",
                                "Phone execution state was interrupted. Review the visible screen before creating a new task.")
                        }
                        return@onSuccess
                    }
                    val service = VisibleUiAccessibilityService.instance
                    val payloadStep = action.optJSONObject("payload")
                    if (service == null || payloadStep == null) {
                        acknowledgeVisibleUiAction(taskId, actionId, "blocked", "Accessibility service or action payload is unavailable.")
                        return@onSuccess
                    }
                    service.executeAction(payloadStep) { status, message ->
                        prefs.edit()
                            .putString("pending_action_id", actionId)
                            .putString("pending_action_status", status)
                            .putString("pending_action_result", message)
                            .apply()
                        acknowledgeVisibleUiAction(taskId, actionId, status, message)
                    }
                }.onFailure { error ->
                    val message = error.message ?: "Worker connection interrupted."
                    if (message.contains("not approved", true) || message.contains("expired", true)) {
                        refreshVisibleUiTaskStatus(taskId)
                    } else {
                        result.text = message + " Retrying..."
                        taskHandler.postDelayed({ pollVisibleUiTask() }, 2500)
                    }
                }
            }
        }
    }

    private fun acknowledgeVisibleUiAction(taskId: String, actionId: String, status: String, message: String) {
        AndroidTaskClient.sendActionResult(taskId, actionId, status, message) { response ->
            runOnUiThread {
                response.onSuccess {
                    getSharedPreferences("android_ui_task", MODE_PRIVATE).edit().clear().apply()
                    refreshVisibleUiTaskStatus(taskId)
                }.onFailure {
                    result.text = "Action result acknowledgement pending. Retrying safely..."
                    taskHandler.postDelayed({ pollVisibleUiTask() }, 2500)
                }
            }
        }
    }

    private fun refreshVisibleUiTaskStatus(taskId: String) {
        AndroidTaskClient.getTask(taskId) { response ->
            runOnUiThread {
                response.onSuccess { payload ->
                    val status = payload.optJSONObject("task")?.optString("status").orEmpty()
                    when (status) {
                        "completed" -> finishVisibleUiTask("Task completed. Visible app state checked.")
                        "failed" -> finishVisibleUiTask("Task failed. Review the phone screen and task history.")
                        "blocked" -> finishVisibleUiTask("Task stopped by a safety boundary.")
                        "cancelled" -> finishVisibleUiTask("Task cancelled.")
                        "paused" -> finishVisibleUiTask("Task paused.")
                        "rejected" -> finishVisibleUiTask("Plan rejected.")
                        "approval_expired" -> finishVisibleUiTask("Approval expired. Review and approve a new plan.")
                        else -> {
                            val actions = payload.optJSONArray("actions")
                            val total = actions?.length() ?: 0
                            val completed = (0 until total).count { index -> actions?.optJSONObject(index)?.optString("status") == "completed" }
                            val nextStep = (0 until total).firstOrNull { index -> actions?.optJSONObject(index)?.optString("status") != "completed" }?.plus(1)
                            result.text = if (total > 0) "কাজ চলছে — $completed/$total ধাপ সম্পন্ন" + (nextStep?.let { " • পরের ধাপ $it" } ?: "") else "Task running: $status"
                            taskHandler.postDelayed({ pollVisibleUiTask() }, 700)
                        }
                    }
                }.onFailure { error ->
                    result.text = "Could not refresh task status: " + (error.message ?: "Unknown error")
                    taskHandler.postDelayed({ refreshVisibleUiTaskStatus(taskId) }, 2500)
                }
            }
        }
    }

    private fun finishVisibleUiTask(message: String) {
        activeUiTaskId = null
        pollInProgress = false
        VisibleUiAccessibilityService.instance?.setApprovedTaskActive(false)
        result.text = message
        toast(message)
    }

    private fun stopCurrentUiTask(operation: String) {
        val taskId = activeUiTaskId ?: run { toast("কোনো active UI task নেই।"); return }
        AndroidTaskClient.stopTask(taskId, operation) { response ->
            runOnUiThread {
                response.onSuccess {
                    if (operation == "pause") {
                        pausedUiTaskId = taskId
                        getSharedPreferences("android_ui_task", MODE_PRIVATE).edit().putString("paused_task_id", taskId).apply()
                    } else {
                        pausedUiTaskId = null
                        getSharedPreferences("android_ui_task", MODE_PRIVATE).edit().remove("paused_task_id").apply()
                    }
                    finishVisibleUiTask(if (operation == "pause") "Task paused. You can resume it from the Automation screen." else "Task cancelled.")
                }.onFailure { error -> toast(error.message ?: "Could not stop task.") }
            }
        }
    }

    private fun resumePausedUiTask() {
        val taskId = pausedUiTaskId ?: run { toast("কোনো paused UI task নেই।"); return }
        if (!isAccessibilityEnabled()) {
            startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
            toast("Resume করার আগে Accessibility permission চালু করুন।")
            return
        }
        AndroidTaskClient.resumeTask(taskId) { response ->
            runOnUiThread {
                response.onSuccess {
                    activeUiTaskId = taskId
                    pausedUiTaskId = null
                    getSharedPreferences("android_ui_task", MODE_PRIVATE).edit().remove("paused_task_id").apply()
                    pollInProgress = false
                    VisibleUiAccessibilityService.instance?.setApprovedTaskActive(true)
                    result.text = "Paused task resumed."
                    pollVisibleUiTask()
                }.onFailure { error ->
                    result.text = error.message ?: "Could not resume task."
                    toast(result.text.toString())
                }
            }
        }
    }
    private fun showTaskHistory() {
        result.text = "Loading Android task history..."
        AndroidTaskClient.listTasks { response ->
            runOnUiThread {
                response.onSuccess { payload ->
                    val tasks = payload.optJSONArray("tasks")
                    if (tasks == null || tasks.length() == 0) {
                        result.text = "No Android tasks yet."
                        toast(result.text.toString())
                        return@onSuccess
                    }
                    val ids = (0 until tasks.length()).mapNotNull { index -> tasks.optJSONObject(index)?.optString("id") }
                    val labels = (0 until tasks.length()).mapNotNull { index ->
                        val task = tasks.optJSONObject(index) ?: return@mapNotNull null
                        val instruction = task.optString("instruction").take(55)
                        "${task.optString("status")} — $instruction"
                    }
                    AlertDialog.Builder(this)
                        .setTitle("Android task history")
                        .setItems(labels.toTypedArray()) { _, which -> loadTaskHistoryDetail(ids[which]) }
                        .setNegativeButton("Close", null)
                        .show()
                    result.text = "Loaded ${labels.size} recent Android tasks."
                }.onFailure { error ->
                    result.text = error.message ?: "Could not load task history."
                    toast(result.text.toString())
                }
            }
        }
    }

    private fun loadTaskHistoryDetail(taskId: String) {
        AndroidTaskClient.getTask(taskId) { response ->
            runOnUiThread {
                response.onSuccess { payload ->
                    val task = payload.optJSONObject("task")
                    val actions = payload.optJSONArray("actions")
                    val lines = (0 until (actions?.length() ?: 0)).mapNotNull { index ->
                        val action = actions?.optJSONObject(index) ?: return@mapNotNull null
                        "${index + 1}. ${action.optString("action_type")} — ${action.optString("status")}: ${action.optString("result")}"
                    }
                    val summary = (task?.optString("instruction") ?: "Android task") + "\nStatus: " + (task?.optString("status") ?: "unknown") + "\n\n" + lines.joinToString("\n")
                    AlertDialog.Builder(this).setTitle("Task details").setMessage(summary).setPositiveButton("OK", null).show()
                }.onFailure { error -> toast(error.message ?: "Could not load task details.") }
            }
        }
    }
    private fun startVoice() {
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), 21)
            return
        }
        try {
            val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
                putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                putExtra(RecognizerIntent.EXTRA_LANGUAGE, "bn-BD")
                putExtra(RecognizerIntent.EXTRA_PROMPT, "আপনার নির্দেশ বলুন")
            }
            startActivityForResult(intent, speechRequest)
        } catch (_: Exception) { toast("Voice recognition is not available on this phone.") }
    }

    @Deprecated("Legacy speech activity result for broad Android compatibility")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == speechRequest && resultCode == RESULT_OK) {
            val spoken = data?.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS)?.firstOrNull().orEmpty()
            command.setText(spoken)
            runCommand(spoken)
        }
    }

    private fun runCommand(raw: String) {
        val text = raw.trim()
        val lower = text.lowercase(Locale.ROOT)
        when {
            text.isBlank() -> toast("আগে একটি নির্দেশ লিখুন।")
            lower.contains("settings") || text.contains("সেটিংস") -> startActivity(Intent(Settings.ACTION_SETTINGS))
            lower.startsWith("open ") || text.startsWith("খোলো ") || text.startsWith("চালু কর ") -> openApp(text.substringAfter(" ").trim())
            lower.contains("remind") || text.contains("মনে কর") || text.contains("রিমাইন্ডার") -> {
                reminderText = text.substringAfter("to", text.substringAfter("করতে", text)).trim().ifBlank { text }
                chooseReminder()
            }
            else -> {
                showChat()
                toast("এই নির্দেশটি AI Chat-এ পাঠান; সরাসরি ফোনে চালানোর জন্য অনুমোদিত action বেছে নিন।")
            }
        }
    }

    private fun openApp(query: String) {
        val name = query.trim().removePrefix("open ").removePrefix("খোলো ").ifBlank { "Settings" }
        if (name.equals("settings", true) || name.contains("সেটিংস")) {
            startActivity(Intent(Settings.ACTION_SETTINGS)); return
        }
        val pm = packageManager
        val apps = pm.getInstalledApplications(PackageManager.GET_META_DATA)
        val match = apps.firstOrNull { app ->
            val label = pm.getApplicationLabel(app).toString()
            label.contains(name, ignoreCase = true)
        }
        val launch = match?.let { pm.getLaunchIntentForPackage(it.packageName) }
        if (launch != null) startActivity(launch) else toast("এই নামে চালু করার মতো অ্যাপ পাওয়া যায়নি।")
    }

    private fun chooseReminder() {
        val now = Calendar.getInstance()
        DatePickerDialog(this, { _, year, month, day ->
            TimePickerDialog(this, { _, hour, minute ->
                val whenAt = Calendar.getInstance().apply { set(year, month, day, hour, minute, 0); set(Calendar.MILLISECOND, 0) }
                if (whenAt.timeInMillis <= System.currentTimeMillis()) { toast("ভবিষ্যতের সময় নির্বাচন করুন।"); return@TimePickerDialog }
                val alarm = getSystemService(ALARM_SERVICE) as AlarmManager
                if (Build.VERSION.SDK_INT >= 31 && !alarm.canScheduleExactAlarms()) {
                    startActivity(Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM, Uri.parse("package:$packageName")))
                    toast("Exact alarm অনুমতি দিন, তারপর reminder আবার সেট করুন।")
                    return@TimePickerDialog
                }
                val intent = Intent(this, ReminderReceiver::class.java).putExtra("text", reminderText)
                val pending = PendingIntent.getBroadcast(this, reminderText.hashCode(), intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
                if (Build.VERSION.SDK_INT >= 23) alarm.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, whenAt.timeInMillis, pending)
                else alarm.setExact(AlarmManager.RTC_WAKEUP, whenAt.timeInMillis, pending)
                toast("Reminder set: " + java.text.DateFormat.getDateTimeInstance().format(whenAt.time))
                result.text = "Reminder scheduled: $reminderText"
            }, now.get(Calendar.HOUR_OF_DAY), now.get(Calendar.MINUTE), false).show()
        }, now.get(Calendar.YEAR), now.get(Calendar.MONTH), now.get(Calendar.DAY_OF_MONTH)).show()
    }

    private fun toast(message: String) = Toast.makeText(this, message, Toast.LENGTH_LONG).show()
    override fun onDestroy() {
        taskHandler.removeCallbacksAndMessages(null)
        activeUiTaskId?.let { taskId -> AndroidTaskClient.stopTask(taskId, "cancel") {} }
        VisibleUiAccessibilityService.instance?.setApprovedTaskActive(false)
        webView?.destroy()
        super.onDestroy()
    }
}
