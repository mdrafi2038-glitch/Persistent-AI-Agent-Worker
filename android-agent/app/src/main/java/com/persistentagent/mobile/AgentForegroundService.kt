package com.persistentagent.mobile

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.os.Build
import android.os.IBinder

class AgentForegroundService : Service() {
    override fun onCreate() {
        super.onCreate()
        val manager = getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= 26) manager.createNotificationChannel(
            NotificationChannel("agent_status", "Agent status", NotificationManager.IMPORTANCE_LOW)
        )
        val notification = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(this, "agent_status")
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentTitle("Persistent AI Agent")
            .setContentText("Agent service is active while you use automation.")
            .setOngoing(true).build()
        else @Suppress("DEPRECATION") (Notification.Builder(this)
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentTitle("Persistent AI Agent").setContentText("Agent service active.")
            .setOngoing(true).build())
        startForeground(10, notification)
    }
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int = START_NOT_STICKY
    override fun onBind(intent: Intent?): IBinder? = null
}
