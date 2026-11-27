package au.mausdroid

import java.util.concurrent.LinkedBlockingDeque
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/**
 * One cancellable playback queue for live replies and podcasts: phrases
 * (made by the phone's voice engine, e.g. Phonon), timed silences and short
 * cached reactions ("mm-hmm"), played in order. Each phrase can have its
 * own speed and pitch (Sonic); the next phrase is back to normal unless it
 * has its own. The next phrase is prepared while the current one plays.
 * stop() clears everything at once: what's playing, what's prepared and
 * what's waiting.
 */
class SpeechPlayer(private val synth: PhraseSynth, private val sink: AudioSink) {

    data class Pcm(val rate: Int, val samples: ShortArray)
    data class Tag(val turn: String, val seq: Int)
    data class Voice(val engine: String?, val name: String?, val pitch: Float = 1f, val rate: Float = 1f)

    sealed class Item {
        abstract val tag: Tag?
        data class Speech(val text: String, val rate: Float = 1f, val pitch: Float = 1f, override val tag: Tag? = null) : Item()
        data class Pause(val ms: Int, override val tag: Tag? = null) : Item()
        data class Clip(val name: String, override val tag: Tag? = null) : Item()
        /** A recorded file (e.g. a podcast episode) from [startMs]; its position is reported while it plays. */
        data class Audio(val path: String, val startMs: Long = 0, override val tag: Tag? = null) : Item()
    }

    interface PhraseSynth {
        fun speech(text: String, voice: Voice): Pcm
        /** A short reaction, or null when it wouldn't sound natural with this voice. */
        fun clip(name: String, voice: Voice): Pcm?
    }

    interface AudioSink {
        /** Writes samples (blocking while the device buffer is full); returns how many were taken. */
        fun write(rate: Int, buf: ShortArray, off: Int, len: Int): Int
        /** Stops sound at once and drops what the device had buffered. */
        fun stopNow()
    }

    private class Job(val gen: Int, val item: Item, val voice: Voice)
    private class Ready(val gen: Int, val item: Item, val pcm: Pcm?)

    private val waiting = LinkedBlockingDeque<Job>()
    private val ready = LinkedBlockingDeque<Ready>(2) // the phrase playing next is prepared ahead
    private val gen = AtomicInteger(0)
    private val busy = AtomicInteger(0)
    @Volatile private var playing: Tag? = null
    @Volatile var lastFirstAudioMs: Long = -1
        private set
    @Volatile private var enqueuedAt = 0L
    @Volatile private var firstPending = false
    @Volatile private var lastRate = 24_000
    @Volatile private var posItem: Item.Audio? = null
    @Volatile private var posRate = 24_000
    @Volatile private var posSamples = 0L
    @Volatile private var posTotal = 0L
    /** How much of the item that was playing had been heard when it was stopped (0–1). */
    @Volatile var stoppedFraction: Double = 0.0
        private set

    /** While a recorded file plays: where it is, in ms from the file's start (else -1). */
    fun positionMs(): Long = posItem?.let { it.startMs + posSamples * 1000 / posRate } ?: -1
    /** Items in the order they were actually played (for tests and diagnostics). */
    val played = java.util.Collections.synchronizedList(mutableListOf<Item>())

    private val preparer = Thread({
        while (true) {
            val job = try { waiting.take() } catch (_: InterruptedException) { return@Thread }
            if (job.gen != gen.get()) continue // stop() already cleared the count
            val pcm = try { render(job.item, job.voice) } catch (_: Exception) { null }
            if (job.gen != gen.get()) continue
            try {
                while (!ready.offer(Ready(job.gen, job.item, pcm), 50, TimeUnit.MILLISECONDS)) if (job.gen != gen.get()) break
            } catch (_: InterruptedException) { return@Thread }
        }
    }, "speech-prepare").apply { isDaemon = true; start() }

    private val player = Thread({
        while (true) {
            val r = try { ready.take() } catch (_: InterruptedException) { return@Thread }
            try {
                if (r.gen != gen.get() || r.pcm == null) continue
                playing = r.item.tag
                if (firstPending) { lastFirstAudioMs = System.currentTimeMillis() - enqueuedAt; firstPending = false }
                val s = r.pcm.samples
                val slice = r.pcm.rate / 50 // 20 ms: stop() takes effect within one slice
                var off = 0
                posItem = r.item as? Item.Audio
                posRate = r.pcm.rate
                posSamples = 0
                posTotal = if (r.item is Item.Speech) s.size.toLong() else 0L
                while (off < s.size && r.gen == gen.get()) {
                    val n = sink.write(r.pcm.rate, s, off, minOf(slice, s.size - off))
                    if (n <= 0) break
                    off += n
                    posSamples = off.toLong()
                }
                if (r.gen == gen.get()) { played.add(r.item); if (r.item is Item.Audio) posItem = null }
            } finally {
                if (r.gen == gen.get()) { busy.decrementAndGet(); if (busy.get() <= 0) playing = null }
            }
        }
    }, "speech-play").apply { isDaemon = true; start() }

    /** Adds items to play (flush = replace whatever is playing or waiting). */
    @Synchronized
    fun enqueue(items: List<Item>, voice: Voice, flush: Boolean = false) {
        if (flush) stop()
        val g = gen.get()
        if (busy.get() <= 0) { enqueuedAt = System.currentTimeMillis(); firstPending = true }
        for (it in items) { busy.incrementAndGet(); waiting.add(Job(g, it, voice)) }
    }

    /** Stops at once and clears every pending item. Returns the item that was playing. */
    /** Where a recorded file was when it was last stopped (ms), or -1. */
    @Volatile var stoppedAtMs: Long = -1
        private set

    fun stop(): Tag? {
        val was = playing
        val pos = positionMs()
        if (pos >= 0) stoppedAtMs = pos
        if (was != null) stoppedFraction = if (posTotal > 0) (posSamples.toDouble() / posTotal).coerceIn(0.0, 1.0) else 0.0
        posItem = null
        gen.incrementAndGet()
        waiting.clear()
        ready.clear()
        busy.set(0)
        playing = null
        firstPending = false
        sink.stopNow()
        return was
    }

    fun isSpeaking() = busy.get() > 0
    fun current(): Tag? = playing

    private fun render(item: Item, voice: Voice): Pcm? = when (item) {
        is Item.Speech -> {
            val p = trimSilence(synth.speech(item.text, voice))
            lastRate = p.rate
            applySonic(p, item.rate, item.pitch)
        }
        is Item.Pause -> Pcm(lastRate, ShortArray((lastRate.toLong() * item.ms.coerceIn(0, 5000) / 1000).toInt()))
        // A reaction that can't be made naturally becomes a short beat instead.
        is Item.Clip -> synth.clip(item.name, voice)?.let { trimSilence(it) } ?: Pcm(lastRate, ShortArray(lastRate / 4))
        is Item.Audio -> {
            val p = readWav(java.io.File(item.path).readBytes())
            val from = (item.startMs.coerceAtLeast(0) * p.rate / 1000).toInt().coerceAtMost(p.samples.size)
            Pcm(p.rate, p.samples.copyOfRange(from, p.samples.size))
        }
    }

    companion object {
        /** Speed and pitch for one phrase, independently (1 = unchanged). Subtle limits. */
        fun applySonic(p: Pcm, speed: Float, pitch: Float): Pcm {
            val sp = speed.takeIf { it.isFinite() && it > 0 }?.coerceIn(0.5f, 2f) ?: 1f
            val pi = pitch.takeIf { it.isFinite() && it > 0 }?.coerceIn(0.5f, 2f) ?: 1f
            if (sp == 1f && pi == 1f || p.samples.isEmpty()) return p
            val s2 = sonic.Sonic(p.rate, 1)
            s2.speed = sp
            s2.pitch = pi
            s2.writeShortToStream(p.samples, p.samples.size)
            s2.flushStream()
            val all = ShortArray(s2.samplesAvailable())
            val n = s2.readShortFromStream(all, all.size)
            return Pcm(p.rate, if (n == all.size) all else all.copyOf(maxOf(0, n)))
        }

        /** A soft breath ("breath" = in-breath, "sigh" = out-breath): band-limited noise, breath-shaped, quiet. */
        fun breath(kind: String, rate: Int, seed: Int = 7): Pcm {
            val sec = if (kind == "sigh") 0.75 else 0.38
            val n = (sec * rate).toInt()
            val out = ShortArray(n)
            var x = seed.toLong() and 0xffffffffL
            var lp = 0.0
            var lp2 = 0.0
            val a = Math.exp(-2 * Math.PI * (if (kind == "sigh") 1800 else 2600) / rate)
            val b = Math.exp(-2 * Math.PI * 250 / rate)
            for (i in 0 until n) {
                x = (x * 1664525 + 1013904223) and 0xffffffffL
                val white = x / 2147483648.0 - 1
                lp = a * lp + (1 - a) * white
                lp2 = b * lp2 + (1 - b) * lp
                val band = lp - lp2
                val t = i.toDouble() / n
                val env = if (kind == "sigh") minOf(1.0, t / 0.12) * Math.pow(1 - t, 1.6) else Math.pow(Math.sin(Math.PI * minOf(1.0, t * 1.1)), 1.5)
                out[i] = (maxOf(-1.0, minOf(1.0, band * 9 * env)) * 2600).toInt().toShort()
            }
            return Pcm(rate, out)
        }

        /** Drops near-silence at the start and end, so phrases join without gaps. */
        fun trimSilence(p: Pcm, threshold: Int = 300): Pcm {
            val s = p.samples
            var a = 0
            while (a < s.size && kotlin.math.abs(s[a].toInt()) < threshold) a++
            var b = s.size
            while (b > a && kotlin.math.abs(s[b - 1].toInt()) < threshold) b--
            if (a == 0 && b == s.size) return p
            // Keep 20 ms either side so words aren't clipped.
            val pad = p.rate / 50
            return Pcm(p.rate, s.copyOfRange(maxOf(0, a - pad), minOf(s.size, b + pad)))
        }

        fun writeWav(p: Pcm): ByteArray {
            val bb = java.nio.ByteBuffer.allocate(44 + p.samples.size * 2).order(java.nio.ByteOrder.LITTLE_ENDIAN)
            bb.put("RIFF".toByteArray()).putInt(36 + p.samples.size * 2).put("WAVEfmt ".toByteArray()).putInt(16).putShort(1).putShort(1)
                .putInt(p.rate).putInt(p.rate * 2).putShort(2).putShort(16).put("data".toByteArray()).putInt(p.samples.size * 2)
            for (v in p.samples) bb.putShort(v)
            return bb.array()
        }

        /** Reads a 16-bit PCM WAV (mono or stereo, mixed to mono). */
        fun readWav(bytes: ByteArray): Pcm {
            val bb = java.nio.ByteBuffer.wrap(bytes).order(java.nio.ByteOrder.LITTLE_ENDIAN)
            require(bytes.size >= 44 && String(bytes, 0, 4) == "RIFF" && String(bytes, 8, 4) == "WAVE") { "Not a WAV recording" }
            var pos = 12
            var rate = 24_000
            var channels = 1
            var bits = 16
            while (pos + 8 <= bytes.size) {
                val id = String(bytes, pos, 4)
                var size = bb.getInt(pos + 4)
                val start = pos + 8
                if (id == "data" && (size <= 0 || start + size > bytes.size)) size = bytes.size - start
                if (id == "fmt ") { channels = bb.getShort(start + 2).toInt(); rate = bb.getInt(start + 4); bits = bb.getShort(start + 14).toInt() }
                else if (id == "data") {
                    require(bits == 16) { "Unsupported recording format" }
                    val frames = size / (2 * channels)
                    val out = ShortArray(frames)
                    for (i in 0 until frames) {
                        var sum = 0
                        for (c in 0 until channels) sum += bb.getShort(start + (i * channels + c) * 2)
                        out[i] = (sum / channels).toShort()
                    }
                    return Pcm(rate, out)
                }
                pos = start + size + (size and 1)
            }
            throw IllegalArgumentException("The recording is incomplete")
        }
    }
}
