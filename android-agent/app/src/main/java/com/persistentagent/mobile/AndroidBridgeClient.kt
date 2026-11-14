package com.persistentagent.mobile

import android.webkit.CookieManager
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors

/**
 * Read-only authenticated handshake with the Render Worker.
 * This intentionally discovers capabilities only; it cannot dispatch device actions.
 */
object AndroidBridgeClient {
    private const val BASE_URL = "https://persistent-ai-agent-worker.onrender.com"
    private val executor = Executors.newSingleThreadExecutor()

    fun fetchCapabilities(callback: (Result<JSONObject>) -> Unit) {
        executor.execute {
            try {
                val cookie = CookieManager.getInstance().getCookie(BASE_URL)
                    ?: throw IllegalStateException("Sign in to AI Chat before connecting the phone.")
                val connection = (URL("$BASE_URL/api/android/bridge/capabilities").openConnection() as HttpURLConnection).apply {
                    requestMethod = "GET"
                    connectTimeout = 15000
                    readTimeout = 15000
                    setRequestProperty("Cookie", cookie)
                    setRequestProperty("Accept", "application/json")
                }
                try {
                    val code = connection.responseCode
                    val stream = if (code in 200..299) connection.inputStream else connection.errorStream
                    val body = stream.bufferedReader().use { it.readText() }
                    if (code == 401) throw IllegalStateException("Worker login expired. Sign in again in AI Chat.")
                    if (code !in 200..299) throw IllegalStateException("Worker bridge returned HTTP $code.")
                    callback(Result.success(JSONObject(body)))
                } finally {
                    connection.disconnect()
                }
            } catch (error: Exception) {
                callback(Result.failure(error))
            }
        }
    }
}
