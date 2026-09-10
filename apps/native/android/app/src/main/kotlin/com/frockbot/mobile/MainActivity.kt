package com.frockbot.mobile

import android.Manifest
import android.os.Build
import com.google.firebase.FirebaseApp
import com.google.firebase.messaging.FirebaseMessaging
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat

class MainActivity : FlutterActivity() {
    private var fullscreen = false

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        PushNotifications.setup(this)
        val bridge = MethodChannel(flutterEngine.dartExecutor.binaryMessenger,"frockbot/push")
        PushNotifications.bridge = bridge
        bridge.setMethodCallHandler { call, result ->
            when(call.method) {
                "configure" -> {
                    PushNotifications.account(this,call.argument<String>("userId"))
                    if (FirebaseApp.initializeApp(this) == null) result.error("unconfigured","Firebase is not configured",null)
                    else FirebaseMessaging.getInstance().token.addOnCompleteListener { task ->
                        if (task.isSuccessful) result.success(task.result) else result.error("token","Push registration unavailable",null)
                    }
                }
                "permission" -> {
                    if (Build.VERSION.SDK_INT >= 33) requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 901)
                    result.success(null)
                }
                "focus" -> { PushNotifications.readingBot = call.argument<String>("botId"); result.success(PushNotifications.focused()) }
                "read" -> {
                    val bot = call.argument<String>("botId")
                    val cursor = call.argument<String>("cursor")
                    if (bot != null && cursor != null) PushNotifications.read(this,bot,cursor)
                    result.success(null)
                }
                "logout" -> { PushNotifications.account(this,null); result.success(null) }
                else -> result.notImplemented()
            }
        }
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "com.frockbot.mobile/display")
            .setMethodCallHandler { call, result ->
                if (call.method == "fullscreen" && call.arguments is Boolean) {
                    fullscreen = call.arguments as Boolean
                    applyFullscreen()
                    result.success(null)
                } else {
                    result.notImplemented()
                }
            }
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        PushNotifications.windowFocused = hasFocus
        PushNotifications.changed("focus", PushNotifications.focused())
        if (hasFocus && fullscreen) applyFullscreen()
    }

    override fun onResume() { super.onResume(); PushNotifications.foreground = true; PushNotifications.changed("focus",PushNotifications.focused()) }
    override fun onPause() { PushNotifications.foreground = false; PushNotifications.changed("focus",false); super.onPause() }
    override fun cleanUpFlutterEngine(engine: FlutterEngine) { PushNotifications.bridge = null; super.cleanUpFlutterEngine(engine) }

    private fun applyFullscreen() {
        val controller = WindowCompat.getInsetsController(window, window.decorView)
        controller.systemBarsBehavior =
            WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        if (fullscreen) controller.hide(WindowInsetsCompat.Type.systemBars())
        else controller.show(WindowInsetsCompat.Type.systemBars())
    }
}
