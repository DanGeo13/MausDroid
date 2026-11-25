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
    private var thread: Thread? = null
    @Volatile var bargeIn = true

    private companion object {
        const val RATE = 16_000
        const val FRAME = 320 // 20 ms
    }

    /** Waits up to maxMs for you to start talking. Returns (speech heard, Maus still speaking, error). */
    fun awaitSpeech(maxMs: Long, interrupt: Boolean): Triple<Boolean, Boolean, String?> {
        bargeIn = interrupt
        val err = start()
        if (err != null) return Triple(false, voice.isSpeaking(), err)
        synchronized(lock) {
            if (!speech) lock.wait(maxMs.coerceIn(20, 5000))
            val heard = speech
            speech = false
            return Triple(heard, voice.isSpeaking(), null)
        }
    }

    fun level() = level

    @SuppressLint("MissingPermission")
    private fun start(): String? {
        if (running) return null
        if (ctx.checkSelfPermission(android.Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED)
            return "MausDroid needs microphone permission (Settings → Voice & assistant → Microphone)."
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
            try {
                rec.startRecording()
                while (running) {
                    val n = rec.read(buf, 0, FRAME)
                    if (n <= 0) continue
                    var sum = 0.0
                    for (i in 0 until n) { val s = buf[i] / 32768.0; sum += s * s }
                    val db = 20 * log10(sqrt(sum / n) + 1e-9)
                    level = db
                    val speaking = voice.isSpeaking()
                    // Louder and longer while Maus is talking, so its own voice doesn't count.
                    val margin = if (speaking) 18.0 else 11.0
                    val need = if (speaking) 9 else 7 // frames of 20 ms
                    if (db > floor + margin && db > -50) loud++ else {
                        loud = max(0, loud - 1)
                        floor = if (db < floor) db else floor * 0.98 + db * 0.02 // follow the room's noise
                    }
                    if (loud >= need) {
                        loud = 0
                        if (speaking && bargeIn) voice.stopSpeaking()
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
        running = false
        thread?.join(500)
        thread = null
        synchronized(lock) { lock.notifyAll() }
    }
}
