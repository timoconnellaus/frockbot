package com.frockbot.mobile

import android.app.Application
import android.os.Build
import android.webkit.CookieManager
import android.webkit.WebView

class FrockBotApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        if (BuildConfig.NATIVE_ACCEPTANCE) {
            val marker = java.io.File(filesDir, "native-continuity-proof")
            if (marker.isFile && marker.length() == 64L) {
                val digest = java.security.MessageDigest.getInstance("SHA-256").digest(marker.readBytes())
                android.util.Log.i("FrockBotAccept", "CONTINUITY " + digest.joinToString("") { "%02x".format(it) })
            }
        }
        // Preserve the Capacitor WebView directory as upgrade evidence. Native
        // extension storage is separate on the qualification Pixel (API 28+).
        if (Build.VERSION.SDK_INT >= 28) WebView.setDataDirectorySuffix("native_extensions_v1")
        CookieManager.getInstance().setAcceptCookie(false)
    }
}
