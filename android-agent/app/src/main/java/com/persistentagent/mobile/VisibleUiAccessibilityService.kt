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
        // Screen content is inspected only on demand for an approved action.
    }

    override fun onInterrupt() {
        taskActive = false
        mainHandler.removeCallbacksAndMessages(null)
    }

    override fun onDestroy() {
        taskActive = false
        mainHandler.removeCallbacksAndMessages(null)
        if (instance === this) instance = null
        super.onDestroy()
    }

    fun setApprovedTaskActive(active: Boolean) {
        taskActive = active
        if (!active) mainHandler.removeCallbacksAndMessages(null)
    }

    fun executeAction(action: JSONObject, callback: (String, String) -> Unit) {
        if (!taskActive) {
            callback("blocked", "No currently approved task is active on this phone.")
            return
        }
        val type = action.optString("type")
        val targetPackage = action.optString("targetPackage")
        val root = rootInActiveWindow
        when (type) {
            "launch_app" -> {
                val requested = action.optString("packageName")
                if (!isEligiblePackage(requested)) {
                    callback("blocked", "This app cannot be launched by the visible UI assistant.")
                    return
                }
                val launch = packageManager.getLaunchIntentForPackage(requested)
                if (launch == null) callback("failed", "The requested app is not installed or has no launch screen.")
                else {
                    launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    startActivity(launch)
                    callback("completed", "App launch requested: $requested")
                }
            }
            "find_visible_text" -> {
                if (!isTargetApp(root, targetPackage)) callback("blocked", "The active app does not match the approved plan.")
                else {
                    val found = findVisibleNode(root, action.optString("text")) != null
                    callback(if (found) "completed" else "failed", if (found) "Requested visible text was found." else "Requested text is not visible.")
                }
            }
            "tap_visible_node" -> {
                val label = action.optString("text")
                if (!isTargetApp(root, targetPackage)) callback("blocked", "The active app does not match the approved plan.")
                else if (BLOCKED_ACTION_TEXT.containsMatchIn(label)) callback("blocked", "This control may perform a consequential action and is blocked.")
                else {
                    val node = findVisibleNode(root, label)
                    val clickable = clickableAncestor(node)
                    val clicked = clickable?.performAction(AccessibilityNodeInfo.ACTION_CLICK) == true
                    callback(if (clicked) "completed" else "failed", if (clicked) "Visible control tapped in the approved app." else "Could not safely tap the requested visible control.")
                }
            }
            "type_text" -> {
                val text = action.optString("text")
                if (!isTargetApp(root, targetPackage)) callback("blocked", "The active app does not match the approved plan.")
                else if (text.length > 200 || SENSITIVE_TEXT.containsMatchIn(text)) callback("blocked", "Sensitive or oversized text is not allowed.")
                else {
                    val field = findEditableNode(root)
                    if (field == null || !field.isFocused) callback("blocked", "No focused visible text field is available.")
                    else {
                        val args = Bundle().apply { putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text) }
                        val changed = field.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)
                        callback(if (changed) "completed" else "failed", if (changed) "Text entered into the focused visible field." else "Could not update the focused text field.")
                    }
                }
            }
            "press_enter" -> {
                if (!isTargetApp(root, targetPackage)) callback("blocked", "The active app does not match the approved plan.")
                else if (android.os.Build.VERSION.SDK_INT < 30) callback("blocked", "This Android version does not expose the supported visible IME submit action.")
                else {
                    val field = findEditableNode(root)
                    val submitted = field?.takeIf { it.isFocused }?.performAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_IME_ENTER.id) == true
                    callback(if (submitted) "completed" else "failed", if (submitted) "Focused visible field submitted." else "Could not submit the focused field.")
                }
            }
            "press_back" -> {
                if (!isTargetApp(root, targetPackage)) callback("blocked", "The active app does not match the approved plan.")
                else callback(if (performGlobalAction(GLOBAL_ACTION_BACK)) "completed" else "failed", "Back navigation requested.")
            }
            "scroll_forward", "scroll_backward" -> {
                if (!isTargetApp(root, targetPackage)) callback("blocked", "The active app does not match the approved plan.")
                else {
                    val direction = if (type == "scroll_forward") AccessibilityNodeInfo.ACTION_SCROLL_FORWARD else AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD
                    val scrollable = findScrollableNode(root)
                    val scrolled = scrollable?.performAction(direction) == true
                    callback(if (scrolled) "completed" else "failed", if (scrolled) "Visible app content scrolled one page." else "No unique visible scrollable area was available.")
                }
            }
            "wait_for_ui" -> {
                val timeout = action.optInt("timeoutMs", 5000).coerceIn(250, 10000)
                mainHandler.postDelayed({
                    if (!taskActive) callback("blocked", "Task was paused or cancelled.")
                    else {
                        val current = rootInActiveWindow
                        val expected = action.optString("visibleText")
                        val found = isTargetApp(current, targetPackage) && (expected.isBlank() || findVisibleNode(current, expected) != null)
                        callback(if (found) "completed" else "failed", if (found) "UI wait condition satisfied." else "Expected visible UI condition was not found.")
                    }
                }, timeout.toLong())
            }
            "report_state" -> {
                val matches = isTargetApp(root, targetPackage)
                callback(if (matches) "completed" else "blocked", if (matches) "The approved app is active. Screen text was not stored." else "The approved app is not the active visible app.")
            }
            else -> callback("blocked", "Unsupported action type.")
        }
    }

    private fun isEligiblePackage(value: String): Boolean =
        PACKAGE_PATTERN.matches(value) &&
            value != packageName &&
            !BLOCKED_PACKAGES.contains(value) &&
            !value.startsWith("com.persistentagent.")

    private fun isTargetApp(root: AccessibilityNodeInfo?, targetPackage: String): Boolean =
        taskActive && targetPackage.isNotBlank() && root?.packageName?.toString() == targetPackage

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

    private fun findScrollableNode(root: AccessibilityNodeInfo?): AccessibilityNodeInfo? {
        if (root == null) return null
        val queue = ArrayDeque<AccessibilityNodeInfo>()
        queue.add(root)
        var visited = 0
        var match: AccessibilityNodeInfo? = null
        while (queue.isNotEmpty() && visited < 350) {
            val node = queue.removeFirst()
            visited++
            if (node.isVisibleToUser && node.isEnabled && node.isScrollable) {
                if (match != null) return null
                match = node
            }
            for (index in 0 until node.childCount) node.getChild(index)?.let(queue::add)
        }
        return match
    }

    private fun findEditableNode(root: AccessibilityNodeInfo?): AccessibilityNodeInfo? {
        if (root == null) return null
        val focused = root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT)
        if (focused != null && focused.isVisibleToUser && focused.isEditable && focused.isEnabled) return focused
        val queue = ArrayDeque<AccessibilityNodeInfo>()
        queue.add(root)
        var visited = 0
        var match: AccessibilityNodeInfo? = null
        while (queue.isNotEmpty() && visited < 350) {
            val node = queue.removeFirst()
            visited++
            if (node.isVisibleToUser && node.isEditable && node.isEnabled) {
                if (match != null) return null
                match = node
            }
            for (index in 0 until node.childCount) node.getChild(index)?.let(queue::add)
        }
        return match
    }

    companion object {
        private val PACKAGE_PATTERN = Regex("^[a-zA-Z][a-zA-Z0-9_]*(\\.[a-zA-Z][a-zA-Z0-9_]*)+$")
        private val BLOCKED_PACKAGES = setOf("android", "com.android.settings", "com.android.permissioncontroller", "com.google.android.permissioncontroller", "com.android.packageinstaller", "com.google.android.packageinstaller")
        private val BLOCKED_ACTION_TEXT = Regex("\\b(send|pay|purchase|buy|checkout|delete|remove|publish|post|share|transfer|allow|enable|accept|agree|confirm|continue|install|uninstall|subscribe|submit|log ?out|sign ?out)\\b", RegexOption.IGNORE_CASE)
        private val SENSITIVE_TEXT = Regex("\\b(password|passcode|pin|otp|one.time.password|recovery.code)\\b", RegexOption.IGNORE_CASE)
        @Volatile var instance: VisibleUiAccessibilityService? = null
            private set
    }
}
