package com.persistentagent.mobile

import android.Manifest
import android.app.AlarmManager
import android.app.DatePickerDialog
import android.app.PendingIntent
import android.app.TimePickerDialog
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
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
import androidx.activity.ComponentActivity
import java.util.Calendar
import java.util.Locale

class MainActivity : ComponentActivity() {
    private val agentUrl = "https://persistent-ai-agent-worker.onrender.com"
    private lateinit var root: LinearLayout
    private lateinit var command: EditText
    private lateinit var result: TextView
    private var webView: WebView? = null
    private var reminderText = "Reminder"
    private val speechRequest = 410

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        requestRuntimePermissions()
        startForegroundService(Intent(this, AgentForegroundService::class.java))
        showHome()
    }

    private fun requestRuntimePermissions() {
        val permissions = mutableListOf<String>()
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) permissions += Manifest.permission.POST_NOTIFICATIONS
        if (Build.VERSION.SDK_INT >= 23 && checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) permissions += Manifest.permission.RECORD_AUDIO
        if (permissions.isNotEmpty()) requestPermissions(permissions.toTypedArray(), 21)
    }

    private fun base(title: String): LinearLayout {
        root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(24, 24, 24, 24)
            setBackgroundColor(0xFFF7F8FC.toInt())
        }
        root.addView(TextView(this).apply { text = title; textSize = 24f; setTextColor(0xFF172033.toInt()) })
        val nav = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        nav.addView(button("AI Chat") { showChat() }, weight())
        nav.addView(button("Automation") { showHome() }, weight())
        root.addView(nav)
        return root
    }

    private fun weight() = LinearLayout.LayoutParams(0, -2, 1f)
    private fun button(label: String, action: () -> Unit) = Button(this).apply { text = label; setOnClickListener { action() } }
    private fun addButton(label: String, action: () -> Unit) { root.addView(button(label, action), LinearLayout.LayoutParams(-1, -2)) }

    private fun showHome() {
        webView?.destroy(); webView = null
        base("Persistent AI Agent")
        root.addView(TextView(this).apply {
            text = "বাংলায় নির্দেশ লিখুন বা ভয়েস ব্যবহার করুন। ফোনে করা কাজগুলো আপনার অনুমতিতেই হবে।"
            textSize = 16f; setTextColor(0xFF39445A.toInt())
        })
        command = EditText(this).apply { hint = "যেমন: open settings / remind me to call home"; minLines = 2 }
        root.addView(command, LinearLayout.LayoutParams(-1, -2))
        val row = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        row.addView(button("🎙 Voice") { startVoice() }, weight())
        row.addView(button("Run command") { runCommand(command.text.toString()) }, weight())
        root.addView(row)
        addButton("Set reminder (choose date & time)") { chooseReminder() }
        addButton("Open app by name") { openApp(command.text.toString()) }
        addButton("Open Android settings") { startActivity(Intent(Settings.ACTION_SETTINGS)) }
        addButton("App permissions") { startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName"))) }
        addButton("Battery/background settings") { startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)) }
        result = TextView(this).apply { text = "Ready."; textSize = 15f; setPadding(0, 18, 0, 0); setTextColor(0xFF39445A.toInt()) }
        root.addView(result)
        setContentView(ScrollView(this).apply { addView(root) })
    }

    private fun showChat() {
        webView?.destroy()
        base("AI Chat")
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
    override fun onDestroy() { webView?.destroy(); super.onDestroy() }
}
