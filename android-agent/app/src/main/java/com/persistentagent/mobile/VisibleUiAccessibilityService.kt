package com.persistentagent.mobile

import android.accessibilityservice.AccessibilityService
import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import org.json.JSONObject

class VisibleUiAccessibilityService : AccessibilityService() {
    private var taskActive = false
    private val mainHandler = Handler(Looper.getMainLooper())

    override fun onServiceConnected() {
        super.onServiceConnected()
        instance = this
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        // Do not collect or log screen contents. Inspect the active window only during an approved task.
    }

    override fun onInterrupt() {
        taskActive = false
    }

    override fun onDestroy() {
        taskActive = false
        if (instance === this) instance = null
        super.onDestroy()
    }

    fun setApprovedTaskActive(active: Boolean) {
        taskActive = active
    }

    fun executeAction(action: JSONObject, callback: (String, String) -> Unit) {
        if (!taskActive) {
            callback("blocked", "No currently approved task is active on this phone.")
            return
        }
        val type = action.optString("type")
        val root = rootInActiveWindow
        when (type) {
            "launch_app" -> {
                val packageName = action.optString("packageName")
                if (packageName != YOUTUBE_PACKAGE) {
                    callback("blocked", "The requested app is not in the on-device allowlist.")
                    return
                }
                val launch = packageManager.getLaunchIntentForPackage(YOUTUBE_PACKAGE)
                if (launch == null) callback("failed", "YouTube is not installed.")
                else {
                    launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    startActivity(launch)
                    callback("completed", "YouTube launch intent sent.")
                }
            }
            "find_visible_text" -> {
                if (!isYouTube(root)) callback("blocked", "The active app is not YouTube.")
                else {
                    val found = findVisibleNode(root, action.optString("text")) != null
                    callback(if (found) "completed" else "failed", if (found) "Requested visible text was found." else "Requested text is not visible.")
                }
            }
            "tap_visible_node" -> {
                if (!isYouTube(root)) callback("blocked", "The active app is not YouTube.")
                else {
                    val node = findVisibleNode(root, action.optString("text"))
                    val clickable = clickableAncestor(node)
                    val clicked = clickable?.performAction(AccessibilityNodeInfo.ACTION_CLICK) == true
                    callback(if (clicked) "completed" else "failed", if (clicked) "Visible YouTube control tapped." else "Could not safely tap the requested visible control.")
                }
            }
            "type_text" -> {
                if (!isYouTube(root)) callback("blocked", "The active app is not YouTube.")
                else {
                    val text = action.optString("text")
                    if (text.length > 200 || SENSITIVE_TEXT.containsMatchIn(text)) {
                        callback("blocked", "Sensitive or oversized text is not allowed.")
                        return
                    }
                    val field = findEditableNode(root)
                    val args = Bundle().apply { putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text) }
                    val changed = field?.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args) == true
                    callback(if (changed) "completed" else "failed", if (changed) "Search text entered into the focused visible field." else "No visible editable field was available.")
                }
            }
            "press_enter" -> {
                if (!isYouTube(root)) callback("blocked", "Search submission is limited to YouTube.")
                else if (android.os.Build.VERSION.SDK_INT < 30) callback("blocked", "This Android version does not expose the supported visible IME submit action.")
                else {
                    val field = findEditableNode(root)
                    val submitted = field?.performAction(AccessibilityNodeInfo.ACTION_IME_ENTER) == true
                    callback(if (submitted) "completed" else "failed", if (submitted) "Visible search field submitted." else "Could not submit the focused search field.")
                }
            }
            "press_back" -> {
                if (!isYouTube(root)) callback("blocked", "Back navigation is limited to YouTube.")
                else callback(if (performGlobalAction(GLOBAL_ACTION_BACK)) "completed" else "failed", "Back navigation requested.")
            }
            "wait_for_ui" -> {
                val timeout = action.optInt("timeoutMs", 5000).coerceIn(250, 10000)
                mainHandler.postDelayed({
                    if (!taskActive) callback("blocked", "Task was paused or cancelled.")
                    else {
                        val current = rootInActiveWindow
                        val expected = action.optString("visibleText")
                        val found = expected.isBlank() || (isYouTube(current) && findVisibleNode(current, expected) != null)
                        callback(if (found) "completed" else "failed", if (found) "UI wait condition satisfied." else "Expected visible text did not appear before timeout.")
                    }
                }, timeout.toLong())
            }
            "report_state" -> {
                callback(if (isYouTube(root)) "completed" else "blocked",
                    if (isYouTube(root)) "YouTube is the active visible app. No screen text was collected." else "YouTube is not the active visible app.")
            }
            else -> callback("blocked", "Unsupported action type.")
        }
    }

    private fun isYouTube(root: AccessibilityNodeInfo?): Boolean =
        taskActive && root?.packageName?.toString() == YOUTUBE_PACKAGE

    private fun findVisibleNode(root: AccessibilityNodeInfo?, target: String): AccessibilityNodeInfo? {
        if (root == null || target.isBlank()) return null
        val queue = ArrayDeque<AccessibilityNodeInfo>()
        queue.add(root)
        var visited = 0
        var match: AccessibilityNodeInfo? = null
        while (queue.isNotEmpty() && visited < 350) {
            val node = queue.removeFirst()
            visited++
            val text = node.text?.toString().orEmpty()
            val description = node.contentDescription?.toString().orEmpty()
            if (node.isVisibleToUser && (text.equals(target, true) || description.equals(target, true))) {
                if (match != null) return null
                match = node
            }
            for (index in 0 until node.childCount) node.getChild(index)?.let(queue::add)
        }
        return match
    }

    private fun clickableAncestor(start: AccessibilityNodeInfo?): AccessibilityNodeInfo? {
        var node = start
        repeat(6) {
            if (node == null) return null
            if (node.isClickable) return node
            node = node.parent
        }
        return null
    }

    private fun findEditableNode(root: AccessibilityNodeInfo?): AccessibilityNodeInfo? {
        if (root == null) return null
        val queue = ArrayDeque<AccessibilityNodeInfo>()
        queue.add(root)
        var visited = 0
        while (queue.isNotEmpty() && visited < 350) {
            val node = queue.removeFirst()
            visited++
            if (node.isVisibleToUser && node.isEditable && node.isEnabled) return node
            for (index in 0 until node.childCount) node.getChild(index)?.let(queue::add)
        }
        return null
    }

    companion object {
        const val YOUTUBE_PACKAGE = "com.google.android.youtube"
        private val SENSITIVE_TEXT = Regex("\\b(password|passcode|pin|otp|one.time.password|recovery.code)\\b", RegexOption.IGNORE_CASE)
        @Volatile var instance: VisibleUiAccessibilityService? = null
            private set
    }
}
