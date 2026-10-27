package com.persistentagent.mobile

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build

class ReminderReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val manager = context.getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= 26) manager.createNotificationChannel(
            NotificationChannel("agent_reminders", "Agent reminders", NotificationManager.IMPORTANCE_HIGH)
        )
        val open = PendingIntent.getActivity(context, 1, Intent(context, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val done = PendingIntent.getBroadcast(context, 2, Intent(context, ReminderActionReceiver::class.java).setAction("DONE"),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val snooze = PendingIntent.getBroadcast(context, 3, Intent(context, ReminderActionReceiver::class.java).setAction("SNOOZE").putExtra("text", intent.getStringExtra("text")),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val builder = if (Build.VERSION.SDK_INT >= 26) android.app.Notification.Builder(context, "agent_reminders") else @Suppress("DEPRECATION") (android.app.Notification.Builder(context))
        manager.notify((intent.getStringExtra("text") ?: "Reminder").hashCode(), builder.setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentTitle("AI Agent reminder").setContentText(intent.getStringExtra("text") ?: "Your reminder")
            .setContentIntent(open).setAutoCancel(true).addAction(0, "Done", done).addAction(0, "Snooze 10m", snooze).build())
    }
}
