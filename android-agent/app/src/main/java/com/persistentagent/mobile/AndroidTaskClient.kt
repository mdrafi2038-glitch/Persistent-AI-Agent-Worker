package com.persistentagent.mobile

import android.webkit.CookieManager
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors

object AndroidTaskClient {
    private const val BASE_URL = "https://persistent-ai-agent-worker.onrender.com"
    private val executor = Executors.newSingleThreadExecutor()

    fun createTask(instruction: String, callback: (Result<JSONObject>) -> Unit) =
        request("POST", "/api/android/tasks", JSONObject().put("instruction", instruction), callback)

    fun approveTask(taskId: String, planHash: String, callback: (Result<JSONObject>) -> Unit) =
        request("POST", "/api/android/tasks/$taskId/approve", JSONObject().put("planHash", planHash), callback)

    fun nextAction(taskId: String, callback: (Result<JSONObject>) -> Unit) =
        request("GET", "/api/android/tasks/$taskId/next-action", null, callback)

    fun sendActionResult(taskId: String, actionId: String, status: String, result: String, callback: (Result<JSONObject>) -> Unit) =
        request("POST", "/api/android/tasks/$taskId/action-result",
            JSONObject().put("actionId", actionId).put("status", status).put("result", result.take(1800)), callback)

    fun stopTask(taskId: String, operation: String, callback: (Result<JSONObject>) -> Unit) {
        if (operation != "pause" && operation != "cancel") {
            callback(Result.failure(IllegalArgumentException("Unsupported stop operation.")))
            return
        }
        request("POST", "/api/android/tasks/$taskId/$operation", JSONObject(), callback)
    }

    private fun request(method: String, path: String, body: JSONObject?, callback: (Result<JSONObject>) -> Unit) {
        executor.execute {
            try {
                val cookie = CookieManager.getInstance().getCookie(BASE_URL)
                    ?: throw IllegalStateException("AI Chat-এ আগে sign in করুন।")
                val connection = (URL(BASE_URL + path).openConnection() as HttpURLConnection).apply {
                    requestMethod = method
                    connectTimeout = 20000
                    readTimeout = 20000
                    setRequestProperty("Cookie", cookie)
                    setRequestProperty("Accept", "application/json")
                    if (body != null) {
                        doOutput = true
                        setRequestProperty("Content-Type", "application/json; charset=utf-8")
                        outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }
                    }
                }
                try {
                    val code = connection.responseCode
                    val stream = if (code in 200..299) connection.inputStream else connection.errorStream
                    val response = stream?.bufferedReader()?.use { it.readText() }.orEmpty()
                    if (code == 401) throw IllegalStateException("Worker login expired. AI Chat-এ আবার sign in করুন।")
                    val payload = if (response.isBlank()) JSONObject() else JSONObject(response)
                    if (code !in 200..299) throw IllegalStateException(payload.optString("error").ifBlank { "Worker returned HTTP $code." })
                    callback(Result.success(payload))
                } finally {
                    connection.disconnect()
                }
            } catch (error: Exception) {
                callback(Result.failure(error))
            }
        }
    }
}
