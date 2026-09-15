package com.frockbot.mobile

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import android.os.Handler
import android.os.Looper
import io.flutter.plugin.common.BinaryMessenger
import io.flutter.plugin.common.MethodChannel

/**
 * The call's speaker: a voice-communication AudioTrack fed the way a VoIP
 * stack feeds one, and receipts that follow the playback head.
 *
 * The track is written continuously — a fixed period every period, silence
 * when nothing is queued — from the moment it is set up until it is
 * released. A track that is only written when there is a reply underruns
 * while the Bot is thinking; on the VoIP output path Android then drops it
 * from the mixer's active list, and a writer blocked on that track waits
 * forever, with the playback head at zero and every receipt owed. WebRTC
 * never lets its track go quiet for the same reason.
 *
 * A receipt names a fed chunk and is sent when the playback head has passed
 * the last frame of it, never when the write returned: silence padding is
 * written frames too, so the head counts it, but only audio earns receipts.
 */
class PcmSpeaker(messenger: BinaryMessenger) {
    private val channel = MethodChannel(messenger, "com.frockbot/pcm")
    private val main = Handler(Looper.getMainLooper())
    private val lock = Object()
    private var track: AudioTrack? = null
    private var generation = 0L
    private var epoch = 0

    /** Fed chunks not yet written, oldest first, with how much of the head has gone. */
    private val queue = ArrayDeque<Pair<Int, ByteArray>>()
    private var headOffset = 0

    /** Main-thread state: the receipts still owed, by the frame that earns each. */
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
                            // The reply is the call's own voice: in communication mode a
                            // media track is routed like the call but metered like music,
                            // which is the earpiece at music volume. This usage follows the
                            // communication device, rides the call volume the hardware keys
                            // adjust, and is the reference the echo canceller listens for.
                            .setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
                            .setAudioFormat(AudioFormat.Builder().setEncoding(AudioFormat.ENCODING_PCM_16BIT).setSampleRate(rate).setChannelMask(AudioFormat.CHANNEL_OUT_MONO).build())
                            .setTransferMode(AudioTrack.MODE_STREAM).setBufferSizeInBytes(maxOf(minimum, rate / 10 * 2)).build()
                        require(next.state == AudioTrack.STATE_INITIALIZED)
                        track = next
                        next.play()
                        startPump(next, generation, epoch, rate / 50 * 2)
                        result.success(null)
                    }
                    "feed" -> {
                        // A feed from a superseded owner is ignored, never a
                        // reason to tear down the device someone else now owns.
                        if (call.argument<Int>("epoch") != epoch) { result.success(null); return@setMethodCallHandler }
                        check(track != null) { "Speaker is unavailable" }
                        val data = call.argument<ByteArray>("buffer")!!
                        require(data.isNotEmpty() && data.size % 2 == 0)
                        val sequence = call.argument<Int>("sequence")!!
                        synchronized(lock) { queue.addLast(sequence to data) }
                        result.success(null)
                    }
                    // Scoped to the caller's own device: a delayed release from
                    // a superseded owner leaves the current speaker playing.
                    "release" -> {
                        val owner = call.argument<Int>("epoch")
                        if (owner == null || owner == epoch) release()
                        result.success(null)
                    }
                    else -> result.notImplemented()
                }
            } catch (_: Exception) {
                release()
                result.error("speaker", "Speaker is unavailable", null)
            }
        }
    }

    /** One period per period, for as long as this generation owns the track. */
    private fun startPump(audio: AudioTrack, owner: Long, receiptEpoch: Int, periodBytes: Int) {
        Thread({
            val buffer = ByteArray(periodBytes)
            var frames = 0L
            while (owner == generation) {
                val completed = ArrayList<Pair<Int, Long>>(2)
                var filled = 0
                synchronized(lock) {
                    while (filled < periodBytes && queue.isNotEmpty()) {
                        val (sequence, data) = queue.first()
                        val take = minOf(periodBytes - filled, data.size - headOffset)
                        System.arraycopy(data, headOffset, buffer, filled, take)
                        filled += take
                        headOffset += take
                        if (headOffset == data.size) {
                            queue.removeFirst()
                            headOffset = 0
                            completed.add(sequence to frames + filled / 2)
                        }
                    }
                }
                if (filled < periodBytes) buffer.fill(0, filled, periodBytes)
                val count = try {
                    audio.write(buffer, 0, periodBytes, AudioTrack.WRITE_BLOCKING)
                } catch (_: Exception) { -1 }
                if (owner != generation) return@Thread
                if (count != periodBytes) {
                    main.post {
                        if (owner == generation) {
                            release()
                            channel.invokeMethod("failed", mapOf("epoch" to receiptEpoch))
                        }
                    }
                    return@Thread
                }
                frames += periodBytes / 2
                if (completed.isNotEmpty()) main.post {
                    if (owner == generation) {
                        pending.addAll(completed)
                        poll(owner, receiptEpoch)
                    }
                }
            }
        }, "frockbot-speaker").start()
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
        lastHead = 0
        headWraps = 0
        synchronized(lock) { queue.clear(); headOffset = 0 }
        val previous = track
        track = null
        if (previous != null) {
            // Pausing unblocks a write in flight; the pump sees its generation
            // gone and leaves.
            runCatching { previous.pause() }
            runCatching { previous.flush() }
            runCatching { previous.release() }
        }
    }

    fun close() {
        release()
        channel.setMethodCallHandler(null)
    }
}
