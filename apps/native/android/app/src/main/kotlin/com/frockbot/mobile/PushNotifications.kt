package com.frockbot.mobile

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.Person
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import io.flutter.plugin.common.MethodChannel
import org.json.JSONArray
import org.json.JSONObject

class FrockMessagingService : FirebaseMessagingService() {
    override fun onMessageReceived(message: RemoteMessage) { PushNotifications.receive(this, message.data) }
    override fun onNewToken(token: String) { PushNotifications.changed("token", token) }
}

object PushNotifications {
    private const val CHANNEL = "bot-messages"
    var bridge: MethodChannel? = null
    var windowFocused = false
    var foreground = false
    var readingBot: String? = null
    private fun prefs(context: Context) = context.getSharedPreferences("push", Context.MODE_PRIVATE)
    fun changed(method: String, value: Any? = null) { Handler(Looper.getMainLooper()).post { bridge?.invokeMethod(method, value) } }
    fun focused(): Boolean = foreground && windowFocused
    fun setup(context: Context) {
        if (Build.VERSION.SDK_INT >= 26) {
            val channel = NotificationChannel(CHANNEL, "Bot messages", NotificationManager.IMPORTANCE_HIGH)
            channel.description = "Messages from your Bots"
            channel.setShowBadge(true)
            context.getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
        }
    }
    @Synchronized fun account(context: Context, userId: String?) {
        val store = prefs(context)
        if (store.getString("userId", null) != userId) {
            NotificationManagerCompat.from(context).cancelAll()
            store.edit().clear().putString("userId", userId).commit()
            readingBot = null
        }
    }
    @Synchronized fun read(context: Context, botId: String, cursor: String) {
        val store = prefs(context)
        val previous = store.getString("read:$botId", "")!!
        if (cursor <= previous) return
        val retained = JSONArray()
        val messages = JSONArray(store.getString("messages:$botId", "[]"))
        for (i in 0 until messages.length()) {
            val message = messages.getJSONObject(i)
            if (message.getString("cursor") > cursor) retained.put(message)
        }
        // The cloud's count predates this read; the next reconcile brings a new one.
        store.edit().putString("read:$botId", cursor).putString("messages:$botId", retained.toString()).remove("count:$botId").commit()
        if (retained.length() == 0) NotificationManagerCompat.from(context).cancel(botId, 1)
        else show(context, botId, retained, false)
    }
    // Launchers badge from active notifications, so this reconciles the ones
    // that exist with the cloud rather than posting any. A silenced Bot (muted
    // or archived) loses its notification; a counted Bot's notification carries
    // its unread count. A Bot the cloud puts at zero loses the stored count and
    // falls back to the messages its notification still holds: the cloud is
    // authority on the number, and only a read cursor discards the alert
    // itself. A notification the User swiped away is not brought back: swiping
    // neither reads the conversation nor asks for the alert again.
    @Synchronized fun badge(context: Context, bots: Map<String, Int>, silenced: List<String>) {
        val store = prefs(context)
        val manager = NotificationManagerCompat.from(context)
        val active = context.getSystemService(NotificationManager::class.java).activeNotifications
            .filter { it.id == 1 }.mapNotNull { it.tag }.toSet()
        val plan = badgeReconcileV1(
            bots,
            silenced,
            active,
            storedCount = { if (store.contains("count:$it")) store.getInt("count:$it", 0) else null },
            storedMessages = { JSONArray(store.getString("messages:$it", "[]")).length() > 0 },
        )
        // One editor for the whole reconcile: this runs on the platform thread
        // for every badge change, and a per-Bot synchronous commit would block
        // it once per Bot in the account.
        val editor = store.edit()
        for (botId in plan.forget) editor.remove("messages:$botId").remove("count:$botId")
        for (botId in plan.drop) editor.remove("count:$botId")
        for ((botId, count) in plan.store) editor.putInt("count:$botId", count)
        // Applied before any show(), which reads back the count it draws.
        editor.apply()
        for (botId in plan.cancel) manager.cancel(botId, 1)
        for (botId in plan.refresh) {
            val messages = JSONArray(store.getString("messages:$botId", "[]"))
            if (messages.length() > 0) show(context, botId, messages, false)
        }
    }
    @Synchronized fun receive(context: Context, data: Map<String,String>) {
        val store = prefs(context)
        if (data["userId"] != store.getString("userId", null)) return
        val botId = data["botId"] ?: return
        val cursor = data["cursor"] ?: return
        if (!Regex("message-[0-9]{20}").matches(cursor)) return
        if (data["kind"] == "read") { read(context, botId, cursor); changed("activity"); return }
        if (cursor <= store.getString("read:$botId", "")!!) return
        val messages = JSONArray(store.getString("messages:$botId", "[]"))
        val seen = JSONArray(store.getString("seen:$botId", "[]"))
        for (i in 0 until seen.length()) if (seen.getString(i) == cursor) return
        seen.put(cursor)
        while (seen.length() > 200) seen.remove(0)
        store.edit().putString("seen:$botId", seen.toString()).commit()
        changed("activity")
        // Only the persisted read cursor above discards an alert. Local focus is
        // a lease the server already honours by holding delivery back, and a
        // stale one here would lose a message that did arrive.
        if (data["notify"] != "true") return
        val newest = store.getString("newest:$botId", "")!!
        val alert = cursor > newest
        if (alert) store.edit().putString("newest:$botId", cursor).commit()
        messages.put(JSONObject().put("cursor",cursor).put("title",data["title"] ?: "FrockBot").put("body",data["body"] ?: "New message").put("at",System.currentTimeMillis()))
        val ordered = (0 until messages.length()).map { messages.getJSONObject(it) }.sortedBy { it.getString("cursor") }.takeLast(25)
        val saved = JSONArray(ordered)
        store.edit().putString("messages:$botId",saved.toString()).commit()
        show(context,botId,saved,alert)
    }
    private fun show(context: Context, botId: String, messages: JSONArray, alert: Boolean) {
        setup(context)
        if (Build.VERSION.SDK_INT >= 33 && context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return
        val latest = messages.getJSONObject(messages.length()-1)
        val person = Person.Builder().setName(latest.getString("title")).setKey(botId).setBot(true).build()
        val style = NotificationCompat.MessagingStyle(Person.Builder().setName("You").build())
        for (i in 0 until messages.length()) {
            val message = messages.getJSONObject(i)
            style.addMessage(message.getString("body"),message.getLong("at"),person)
        }
        val uri = Uri.parse("https://bot.frockbot.com/").buildUpon().appendQueryParameter("bot",botId).build()
        val intent = Intent(context, MainActivity::class.java).setAction(Intent.ACTION_VIEW).setData(uri).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        val pending = PendingIntent.getActivity(context,0,intent,PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val notification = NotificationCompat.Builder(context,CHANNEL)
            .setSmallIcon(R.drawable.ic_notification).setStyle(style).setContentTitle(latest.getString("title"))
            .setContentText(latest.getString("body")).setContentIntent(pending).setAutoCancel(true)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE).setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setNumber(maxOf(messages.length(), prefs(context).getInt("count:$botId", 0)))
            .setOnlyAlertOnce(!alert).setWhen(latest.getLong("at")).build()
        NotificationManagerCompat.from(context).notify(botId,1,notification)
    }
}
