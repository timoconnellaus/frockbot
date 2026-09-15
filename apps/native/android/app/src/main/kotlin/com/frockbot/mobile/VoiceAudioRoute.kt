package com.frockbot.mobile

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.AudioRecord
import android.media.AudioFormat
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import io.flutter.plugin.common.BinaryMessenger
import io.flutter.plugin.common.MethodChannel

/**
 * The audio session of a voice call, the way a VoIP app holds one.
 *
 * For the length of a call this owns three things the platform otherwise
 * decides on its own: the audio mode (`MODE_IN_COMMUNICATION`, which is where
 * Android attaches its echo canceller and lets a Bluetooth microphone work),
 * audio focus (transient, as a call, so music pauses and comes back), and the
 * output route. The route is the part a phone call gets wrong for an
 * assistant: in communication mode every stream follows the call's device,
 * which is the earpiece unless someone says otherwise. Here the order is a
 * headset if one is worn — Bluetooth LE or SCO, then wired or USB — and the
 * loudspeaker otherwise; the earpiece is never chosen on its own.
 *
 * Devices come and go mid-call. A headset that connects takes the call; one
 * that disconnects hands it back to the speaker. Both are reported to Dart as
 * `route` events, and focus changes as `focus` events, so the call can hold
 * its microphone for a phone call and give it back afterwards.
 *
 * `end` restores what it found: the mode, the speakerphone, the focus.
 */
class VoiceAudioRoute(context: Context, messenger: BinaryMessenger) {
    private val channel = MethodChannel(messenger, "com.frockbot/audio-route")
    private val audio = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    private val main = Handler(Looper.getMainLooper())

    /** Every AudioManager call happens here, in order, off the main thread. */
    private val worker = Handler(HandlerThread("frockbot-audio-route").apply { start() }.looper)
    private var active = false
    private var previousMode = AudioManager.MODE_NORMAL
    private var previousSpeakerphone = false
    private var focusRequest: AudioFocusRequest? = null
    private var focusListener: AudioManager.OnAudioFocusChangeListener? = null
    private var deviceCallback: AudioDeviceCallback? = null
    private var lastRoute: String? = null

    init {
        channel.setMethodCallHandler { call, result ->
            try {
                when (call.method) {
                    // Choosing the communication device is a synchronous call into
                    // the audio server that takes hundreds of milliseconds; on the
                    // main thread it would hold every frame of the footer's entrance.
                    "begin" -> worker.post { val route = runCatching { begin(); currentRoute() }; main.post { route.fold({ result.success(it) }, { result.error("audio-route", it.message, null) }) } }
                    "end" -> worker.post { runCatching { end() }; main.post { result.success(null) } }
                    "route" -> result.success(currentRoute())
                    "minimumCaptureBuffer" -> {
                        val rate = call.argument<Int>("sampleRate")!!
                        val minimum = AudioRecord.getMinBufferSize(
                            rate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT
                        )
                        result.success(if (minimum > 0) minimum else null)
                    }
                    else -> result.notImplemented()
                }
            } catch (e: Exception) {
                result.error("audio-route", e.message ?: "Audio route is unavailable", null)
            }
        }
    }

    private fun begin() {
        if (active) { applyRoute(); return }
        active = true
        previousMode = audio.mode
        @Suppress("DEPRECATION")
        previousSpeakerphone = audio.isSpeakerphoneOn
        requestFocus()
        audio.mode = AudioManager.MODE_IN_COMMUNICATION
        val callback = object : AudioDeviceCallback() {
            override fun onAudioDevicesAdded(added: Array<out AudioDeviceInfo>) { if (active) applyRoute() }
            override fun onAudioDevicesRemoved(removed: Array<out AudioDeviceInfo>) { if (active) applyRoute() }
        }
        deviceCallback = callback
        audio.registerAudioDeviceCallback(callback, worker)
        applyRoute()
    }

    private fun end() {
        if (!active) return
        active = false
        deviceCallback?.let { audio.unregisterAudioDeviceCallback(it) }
        deviceCallback = null
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            audio.clearCommunicationDevice()
        } else {
            @Suppress("DEPRECATION")
            if (audio.isBluetoothScoOn) audio.stopBluetoothSco()
            @Suppress("DEPRECATION")
            audio.isSpeakerphoneOn = previousSpeakerphone
        }
        audio.mode = previousMode
        abandonFocus()
        lastRoute = null
    }

    /** Headset first, loudspeaker otherwise, never the earpiece on its own. */
    private fun applyRoute() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            val available = audio.availableCommunicationDevices
            val chosen = PRIORITY.firstNotNullOfOrNull { type -> available.firstOrNull { it.type == type } }
            if (chosen != null && audio.communicationDevice?.id != chosen.id) {
                audio.setCommunicationDevice(chosen)
            }
        } else {
            val inputs = audio.getDevices(AudioManager.GET_DEVICES_INPUTS)
            val outputs = audio.getDevices(AudioManager.GET_DEVICES_OUTPUTS)
            val bluetooth = inputs.any { it.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO } &&
                audio.isBluetoothScoAvailableOffCall
            val wired = outputs.any { it.type in WIRED }
            @Suppress("DEPRECATION")
            when {
                bluetooth -> { audio.isSpeakerphoneOn = false; if (!audio.isBluetoothScoOn) audio.startBluetoothSco() }
                wired -> { if (audio.isBluetoothScoOn) audio.stopBluetoothSco(); audio.isSpeakerphoneOn = false }
                else -> { if (audio.isBluetoothScoOn) audio.stopBluetoothSco(); audio.isSpeakerphoneOn = true }
            }
        }
        val route = currentRoute()
        if (route != lastRoute) {
            lastRoute = route
            main.post { channel.invokeMethod("route", mapOf("route" to route)) }
        }
    }

    private fun currentRoute(): String? {
        if (!active) return null
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            return kindOf(audio.communicationDevice?.type)
        }
        @Suppress("DEPRECATION")
        return when {
            audio.isBluetoothScoOn -> "bluetooth"
            audio.isSpeakerphoneOn -> "speaker"
            audio.getDevices(AudioManager.GET_DEVICES_OUTPUTS).any { it.type in WIRED } -> "wired"
            else -> "earpiece"
        }
    }

    private fun kindOf(type: Int?): String? = when (type) {
        null -> null
        AudioDeviceInfo.TYPE_BUILTIN_SPEAKER -> "speaker"
        AudioDeviceInfo.TYPE_BUILTIN_EARPIECE -> "earpiece"
        AudioDeviceInfo.TYPE_BLUETOOTH_SCO, AudioDeviceInfo.TYPE_BLE_HEADSET, AudioDeviceInfo.TYPE_BLE_SPEAKER -> "bluetooth"
        in WIRED -> "wired"
        else -> "other"
    }

    private fun requestFocus() {
        if (focusListener != null) return
        val listener = AudioManager.OnAudioFocusChangeListener { change ->
            val state = when (change) {
                AudioManager.AUDIOFOCUS_LOSS -> "lost"
                AudioManager.AUDIOFOCUS_LOSS_TRANSIENT, AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK -> "paused"
                AudioManager.AUDIOFOCUS_GAIN -> "regained"
                else -> null
            }
            if (state != null && active) main.post { channel.invokeMethod("focus", mapOf("state" to state)) }
        }
        focusListener = listener
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val request = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
                .setAudioAttributes(
                    AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                        .build()
                )
                .setAcceptsDelayedFocusGain(false)
                .setOnAudioFocusChangeListener(listener, worker)
                .build()
            focusRequest = request
            audio.requestAudioFocus(request)
        } else {
            @Suppress("DEPRECATION")
            audio.requestAudioFocus(listener, AudioManager.STREAM_VOICE_CALL, AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
        }
    }

    private fun abandonFocus() {
        val listener = focusListener ?: return
        focusListener = null
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            focusRequest?.let { audio.abandonAudioFocusRequest(it) }
            focusRequest = null
        } else {
            @Suppress("DEPRECATION")
            audio.abandonAudioFocus(listener)
        }
    }

    fun close() {
        channel.setMethodCallHandler(null)
        worker.post { runCatching { end() }; worker.looper.quitSafely() }
    }

    private companion object {
        val WIRED = setOf(
            AudioDeviceInfo.TYPE_WIRED_HEADSET,
            AudioDeviceInfo.TYPE_WIRED_HEADPHONES,
            AudioDeviceInfo.TYPE_USB_HEADSET,
            AudioDeviceInfo.TYPE_USB_DEVICE,
        )

        /** Communication device types in the order a call prefers them. */
        val PRIORITY: List<Int> = buildList {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) add(AudioDeviceInfo.TYPE_BLE_HEADSET)
            add(AudioDeviceInfo.TYPE_BLUETOOTH_SCO)
            add(AudioDeviceInfo.TYPE_WIRED_HEADSET)
            add(AudioDeviceInfo.TYPE_WIRED_HEADPHONES)
            add(AudioDeviceInfo.TYPE_USB_HEADSET)
            add(AudioDeviceInfo.TYPE_USB_DEVICE)
            add(AudioDeviceInfo.TYPE_BUILTIN_SPEAKER)
        }
    }
}
