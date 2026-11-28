package au.mausdroid

import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.media.audiofx.AcousticEchoCanceler
import android.media.audiofx.NoiseSuppressor
import kotlin.math.log10
import kotlin.math.max
import kotlin.math.sqrt

/**
 * Calls: listens in 20 ms slices while Maus talks or thinks, so you can
 * interrupt. When your voice starts (about 0.15 s of sound clearly above the
 * room's noise level), Maus stops speaking at once. Uses the phone-call
 * microphone path with the echo canceller, so Maus's own voice is mostly
 * ignored; while Maus speaks it needs a louder, longer sound to count.
 */
class VoiceWatch(private val ctx: Context, private val voice: Voice) {
    private val lock = Object()
    @Volatile private var running = false
    @Volatile private var speech = false
    @Volatile private var level = -90.0
    /** Time from the start of your voice to DanDroid going quiet, for the last interruption (ms). */
    @Volatile var lastInterruptMs: Long = -1
        private set
    private var thread: Thread? = null
    @Volatile var bargeIn = true
    /** Other speech that counts as DanDroid talking (the phrase player), and how to stop it. */
    @Volatile var otherSpeaking: () -> Boolean = { false }
    @Volatile var stopOther: () -> Unit = {}
    private fun anySpeaking() = voice.isSpeaking() || otherSpeaking()

    // The last half second of microphone audio, so the start of what you say isn't lost.
    private val ring = ShortArray(RATE * 2) // 2 s: enough to keep a question started while the recognizer spins up
    private var ringPos = 0
    private var ringFull = false
    /** A pipe to a recognizer, written by its own thread so the microphone never waits on it. */
    private class Feed(val out: java.io.OutputStream) {
        val q = java.util.concurrent.LinkedBlockingQueue<ByteArray>(500)
        @Volatile var open = true
        val t = Thread({
            try { while (open) { val b = q.poll(200, java.util.concurrent.TimeUnit.MILLISECONDS) ?: continue; out.write(b) } } catch (_: Exception) {}
            runCatching { out.close() }
        }, "mic-feed").apply { isDaemon = true; start() }
        fun close() { open = false }
    }
    private val feeds = java.util.concurrent.CopyOnWriteArrayList<Feed>()

    /**
     * Audio for on-device speech recognition: the last [prerollMs] of the
     * microphone, then live audio, as 16 kHz mono 16-bit PCM through a pipe.
     * Close the returned read side's counterpart with [closeFeeds].
     */
    fun openFeed(prerollMs: Int = 500): android.os.ParcelFileDescriptor? {
        if (start() != null) return null
        val (read, write) = android.os.ParcelFileDescriptor.createPipe()
        val out = android.os.ParcelFileDescriptor.AutoCloseOutputStream(write)
        synchronized(ring) {
            val want = (RATE * prerollMs.coerceIn(0, 2000) / 1000)
            val have = if (ringFull) ring.size else ringPos
            val n = minOf(want, have)
            val bytes = java.nio.ByteBuffer.allocate(n * 2).order(java.nio.ByteOrder.LITTLE_ENDIAN)
            for (i in 0 until n) bytes.putShort(ring[(ringPos - n + i + ring.size) % ring.size])
            val f = Feed(out)
            f.q.offer(bytes.array())
            feeds.add(f)
        }
        return read
    }

    fun closeFeeds() {
        for (f in feeds) f.close()
        feeds.clear()
    }

    private fun feed(buf: ShortArray, n: Int) {
        synchronized(ring) {
            for (i in 0 until n) { ring[ringPos] = buf[i]; ringPos = (ringPos + 1) % ring.size; if (ringPos == 0) ringFull = true }
            if (feeds.isEmpty()) return
            val bytes = java.nio.ByteBuffer.allocate(n * 2).order(java.nio.ByteOrder.LITTLE_ENDIAN)
            for (i in 0 until n) bytes.putShort(buf[i])
            for (f in feeds) if (!f.open || !f.q.offer(bytes.array())) { f.close(); feeds.remove(f) }
        }
    }

    private companion object {
        const val RATE = 16_000
        const val FRAME = 320 // 20 ms
    }

    /** Waits up to maxMs for you to start talking. Returns (speech heard, Maus still speaking, error). */
    fun awaitSpeech(maxMs: Long, interrupt: Boolean): Triple<Boolean, Boolean, String?> {
        bargeIn = interrupt
        val err = start()
        if (err != null) return Triple(false, anySpeaking(), err)
        synchronized(lock) {
            if (!speech) lock.wait(maxMs.coerceIn(20, 5000))
            val heard = speech
            speech = false
            return Triple(heard, anySpeaking(), null)
        }
    }

    fun level() = level

    @SuppressLint("MissingPermission")
    private fun start(): String? {
        if (running) return null
        if (ctx.checkSelfPermission(android.Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED)
            return "DanDroid needs microphone permission (Settings → Voice & assistant → Microphone)."
        val min = AudioRecord.getMinBufferSize(RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
        val rec = try {
            AudioRecord(MediaRecorder.AudioSource.VOICE_COMMUNICATION, RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, max(min, FRAME * 8))
        } catch (e: Exception) {
            return "The microphone couldn't be opened: ${e.message}"
        }
        if (rec.state != AudioRecord.STATE_INITIALIZED) { rec.release(); return "The microphone couldn't be opened (another app may be using it)." }
        val aec = if (AcousticEchoCanceler.isAvailable()) runCatching { AcousticEchoCanceler.create(rec.audioSessionId)?.apply { enabled = true } }.getOrNull() else null
        val ns = if (NoiseSuppressor.isAvailable()) runCatching { NoiseSuppressor.create(rec.audioSessionId)?.apply { enabled = true } }.getOrNull() else null
        running = true
        speech = false
        thread = Thread({
            val buf = ShortArray(FRAME)
            var floor = -60.0
            var loud = 0
            var onset = 0L
            try {
                rec.startRecording()
                while (running) {
                    val n = rec.read(buf, 0, FRAME)
                    if (n <= 0) continue
                    feed(buf, n)
                    var sum = 0.0
                    for (i in 0 until n) { val s = buf[i] / 32768.0; sum += s * s }
                    val db = 20 * log10(sqrt(sum / n) + 1e-9)
                    level = db
                    val speaking = anySpeaking()
                    // Louder and longer while Maus is talking, so its own voice doesn't count.
                    val margin = if (speaking) 18.0 else 11.0
                    val need = if (speaking) 9 else 7 // frames of 20 ms
                    if (db > floor + margin && db > -50) { if (loud == 0) onset = System.currentTimeMillis(); loud++ } else {
                        loud = max(0, loud - 1)
                        floor = if (db < floor) db else floor * 0.98 + db * 0.02 // follow the room's noise
                    }
                    if (loud >= need) {
                        loud = 0
                        if (speaking && bargeIn) { voice.stopSpeaking(); stopOther(); lastInterruptMs = System.currentTimeMillis() - onset }
                        synchronized(lock) { speech = true; lock.notifyAll() }
                    }
                }
            } catch (_: Exception) {
            } finally {
                runCatching { rec.stop() }
                rec.release()
                aec?.release()
                ns?.release()
            }
        }, "voice-watch").apply { isDaemon = true; start() }
        return null
    }

    /** Frees the microphone (speech recognition needs it). */
    fun stop() {
        closeFeeds()
        running = false
        thread?.join(500)
        thread = null
        synchronized(lock) { lock.notifyAll() }
    }
}
