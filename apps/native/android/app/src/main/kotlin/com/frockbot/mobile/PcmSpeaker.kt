package com.frockbot.mobile

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import android.os.Handler
import android.os.Looper
import io.flutter.plugin.common.BinaryMessenger
import io.flutter.plugin.common.MethodChannel
import java.util.concurrent.Executors

/** A receipt follows the AudioTrack playback head, never a successful write. */
class PcmSpeaker(messenger: BinaryMessenger) {
    private val channel = MethodChannel(messenger, "com.frockbot/pcm")
    private val main = Handler(Looper.getMainLooper())
    private val writer = Executors.newSingleThreadExecutor()
    private var track: AudioTrack? = null
    private var generation = 0L
    private var epoch = 0
    private var written = 0L
    private val pending = ArrayDeque<Pair<Int, Long>>()
    private var lastHead = 0L
    private var headWraps = 0L
    private var pollOwner = 0L
    private var pollEpoch = 0
    private val pollTask = Runnable { poll(pollOwner, pollEpoch) }

    init {
        channel.setMethodCallHandler { call, result ->
            try {
                when (call.method) {
                    "setup" -> {
                        release()
                        epoch = call.argument<Int>("epoch")!!
                        val rate = call.argument<Int>("sampleRate")!!
                        val minimum = AudioTrack.getMinBufferSize(rate, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT)
                        require(minimum > 0)
                        val next = AudioTrack.Builder()
                            .setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
                            .setAudioFormat(AudioFormat.Builder().setEncoding(AudioFormat.ENCODING_PCM_16BIT).setSampleRate(rate).setChannelMask(AudioFormat.CHANNEL_OUT_MONO).build())
                            .setTransferMode(AudioTrack.MODE_STREAM).setBufferSizeInBytes(maxOf(minimum, rate / 5 * 2)).build()
                        require(next.state == AudioTrack.STATE_INITIALIZED)
                        track = next
                        next.play()
                        result.success(null)
                    }
                    "feed" -> {
                        val audio = track ?: error("Speaker is unavailable")
                        require(call.argument<Int>("epoch") == epoch)
                        val data = call.argument<ByteArray>("buffer")!!
                        require(data.isNotEmpty() && data.size % 2 == 0)
                        val sequence = call.argument<Int>("sequence")!!
                        val owner = generation
                        val receiptEpoch = epoch
                        writer.execute {
                            try {
                                var offset = 0
                                while (offset < data.size) {
                                    val count = audio.write(data, offset, data.size - offset, AudioTrack.WRITE_BLOCKING)
                                    check(count > 0)
                                    offset += count
                                }
                                main.post {
                                    if (owner == generation) {
                                        written += data.size / 2
                                        pending.add(sequence to written)
                                        poll(owner, receiptEpoch)
                                    }
                                }
                            } catch (_: Exception) {
                                main.post {
                                    if (owner == generation) {
                                        release()
                                        channel.invokeMethod("failed", mapOf("epoch" to receiptEpoch))
                                    }
                                }
                            }
                        }
                        result.success(null)
                    }
                    "release" -> { release(); result.success(null) }
                    else -> result.notImplemented()
                }
            } catch (_: Exception) {
                release()
                result.error("speaker", "Speaker is unavailable", null)
            }
        }
    }

    private fun poll(owner: Long, receiptEpoch: Int) {
        if (owner != generation) return
        val audio = track ?: return
        val raw = try {
            check(audio.playState == AudioTrack.PLAYSTATE_PLAYING)
            audio.playbackHeadPosition.toLong() and 0xffffffffL
        } catch (_: Exception) {
            release()
            channel.invokeMethod("failed", mapOf("epoch" to receiptEpoch))
            return
        }
        if (raw < lastHead) {
            if (lastHead < 0xf0000000L || raw > 0x0fffffffL) {
                release()
                channel.invokeMethod("failed", mapOf("epoch" to receiptEpoch))
                return
            }
            headWraps += 1L shl 32
        }
        lastHead = raw
        val played = raw + headWraps
        while (pending.isNotEmpty() && pending.first().second <= played) {
            channel.invokeMethod("played", mapOf("epoch" to receiptEpoch, "sequence" to pending.removeFirst().first))
        }
        main.removeCallbacks(pollTask)
        if (pending.isNotEmpty()) {
            pollOwner = owner
            pollEpoch = receiptEpoch
            main.postDelayed(pollTask, 10)
        }
    }

    private fun release() {
        generation++
        main.removeCallbacks(pollTask)
        pending.clear()
        written = 0
        lastHead = 0
        headWraps = 0
        val previous = track
        track = null
        if (previous != null) {
            runCatching { previous.pause() }
            runCatching { previous.flush() }
            runCatching { previous.release() }
        }
    }

    fun close() {
        release()
        channel.setMethodCallHandler(null)
        writer.shutdownNow()
    }
}
