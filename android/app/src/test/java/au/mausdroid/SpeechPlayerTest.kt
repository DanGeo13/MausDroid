package au.mausdroid

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.PI
import kotlin.math.sin

class SpeechPlayerTest {
    private val rate = 24_000

    /** A tone per phrase: 0.1 s per word, so lengths are predictable. */
    private fun tone(sec: Double, hz: Double = 200.0) = SpeechPlayer.Pcm(rate, ShortArray((rate * sec).toInt()) { i -> (8000 * sin(2 * PI * hz * i / rate)).toInt().toShort() })

    private class FakeSynth(val make: (String) -> SpeechPlayer.Pcm, val clips: Boolean = true) : SpeechPlayer.PhraseSynth {
        val asked = mutableListOf<String>()
        override fun speech(text: String, voice: SpeechPlayer.Voice): SpeechPlayer.Pcm { asked.add(text); return make(text) }
        override fun clip(name: String, voice: SpeechPlayer.Voice) = if (clips) make(name) else null
    }

    /** Takes samples at (sped-up) real time and records how many it got per phrase. */
    private class FakeSink(val realTime: Boolean = false) : SpeechPlayer.AudioSink {
        val written = java.util.concurrent.atomic.AtomicLong()
        @Volatile var stops = 0
        override fun write(rate: Int, buf: ShortArray, off: Int, len: Int): Int {
            if (realTime) Thread.sleep((len * 1000L / rate).coerceAtLeast(1))
            written.addAndGet(len.toLong())
            return len
        }
        override fun stopNow() { stops++ }
    }

    private val v = SpeechPlayer.Voice(null, null)
    private fun waitIdle(p: SpeechPlayer, ms: Long = 5000) { val end = System.currentTimeMillis() + ms; while (p.isSpeaking() && System.currentTimeMillis() < end) Thread.sleep(5) }

    @Test fun speechPausesAndClipsPlayInOrder() {
        val synth = FakeSynth({ t -> tone(0.1 * t.split(" ").size) })
        val sink = FakeSink()
        val p = SpeechPlayer(synth, sink)
        val items = listOf(
            SpeechPlayer.Item.Speech("one two"),
            SpeechPlayer.Item.Pause(400),
            SpeechPlayer.Item.Clip("mm-hmm"),
            SpeechPlayer.Item.Speech("three"),
        )
        p.enqueue(items, v)
        waitIdle(p)
        assertEquals(items, p.played.toList())
        assertFalse(p.isSpeaking())
    }

    @Test fun pauseIsTheRightLength() {
        val sink = FakeSink()
        val p = SpeechPlayer(FakeSynth({ tone(0.2) }), sink)
        p.enqueue(listOf(SpeechPlayer.Item.Pause(500)), v)
        waitIdle(p)
        assertEquals(rate / 2L, sink.written.get())
    }

    @Test fun stopClearsEverythingPendingAndTheNextReplyIsFresh() {
        val sink = FakeSink(realTime = true)
        val p = SpeechPlayer(FakeSynth({ tone(0.5) }), sink)
        p.enqueue((1..6).map { SpeechPlayer.Item.Speech("phrase $it", tag = SpeechPlayer.Tag("t1", it)) }, v)
        Thread.sleep(150) // the first phrase is playing
        val t0 = System.currentTimeMillis()
        val was = p.stop()
        val stopMs = System.currentTimeMillis() - t0
        assertEquals(SpeechPlayer.Tag("t1", 1), was)
        assertFalse(p.isSpeaking())
        val before = sink.written.get()
        Thread.sleep(400)
        // At most one more 20 ms slice after stop.
        assertTrue("audio kept coming after stop", sink.written.get() - before <= rate / 50)
        assertTrue("stop took ${stopMs} ms", stopMs < 50)
        assertTrue(sink.stops >= 1)
        assertTrue(p.played.isEmpty())
        p.enqueue(listOf(SpeechPlayer.Item.Speech("new", tag = SpeechPlayer.Tag("t2", 0))), v)
        waitIdle(p)
        assertEquals(listOf<SpeechPlayer.Item>(SpeechPlayer.Item.Speech("new", tag = SpeechPlayer.Tag("t2", 0))), p.played.toList())
    }

    @Test fun missingReactionBecomesAShortBeat() {
        val sink = FakeSink()
        val p = SpeechPlayer(FakeSynth({ tone(0.3) }, clips = false), sink)
        p.enqueue(listOf(SpeechPlayer.Item.Clip("mm-hmm")), v)
        waitIdle(p)
        assertEquals(rate / 4L, sink.written.get())
    }

    /** Average zero crossings per second ≈ 2 × frequency. */
    private fun freq(p: SpeechPlayer.Pcm): Double {
        var z = 0
        for (i in 1 until p.samples.size) if ((p.samples[i - 1] < 0) != (p.samples[i] < 0)) z++
        return z / 2.0 / (p.samples.size.toDouble() / p.rate)
    }

    @Test fun speedAndPitchChangeIndependentlyBothWays() {
        val src = tone(2.0, 220.0)
        val faster = SpeechPlayer.applySonic(src, 1.2f, 1f)
        val slower = SpeechPlayer.applySonic(src, 0.85f, 1f)
        val higher = SpeechPlayer.applySonic(src, 1f, 1.12f)
        val lower = SpeechPlayer.applySonic(src, 1f, 0.9f)
        val len = src.samples.size.toDouble()
        assertEquals(1 / 1.2, faster.samples.size / len, 0.04)
        assertEquals(1 / 0.85, slower.samples.size / len, 0.04)
        // Speed alone keeps the pitch; pitch alone keeps the length.
        assertEquals(220.0, freq(faster), 8.0)
        assertEquals(220.0, freq(slower), 8.0)
        assertEquals(1.0, higher.samples.size / len, 0.04)
        assertEquals(1.0, lower.samples.size / len, 0.04)
        assertEquals(220 * 1.12, freq(higher), 10.0)
        assertEquals(220 * 0.9, freq(lower), 10.0)
        // No cue: untouched.
        assertTrue(SpeechPlayer.applySonic(src, 1f, 1f) === src)
        assertTrue(SpeechPlayer.applySonic(src, Float.NaN, -1f) === src)
    }

    @Test fun cueAppliesToItsPhraseOnlyThenBackToNormal() {
        val sink = FakeSink()
        val p = SpeechPlayer(FakeSynth({ tone(1.0) }), sink)
        p.enqueue(listOf(SpeechPlayer.Item.Speech("quick", rate = 1.25f)), v)
        waitIdle(p)
        val fast = sink.written.get()
        p.enqueue(listOf(SpeechPlayer.Item.Speech("normal")), v)
        waitIdle(p)
        val normal = sink.written.get() - fast
        assertEquals(rate.toDouble(), normal.toDouble(), rate * 0.05)
        assertTrue(fast < normal * 0.85)
    }

    @Test fun firstAudioIsMeasured() {
        val p = SpeechPlayer(FakeSynth({ Thread.sleep(60); tone(0.1) }), FakeSink())
        p.enqueue(listOf(SpeechPlayer.Item.Speech("hi")), v)
        waitIdle(p)
        assertTrue(p.lastFirstAudioMs in 50..1000)
    }

    @Test fun wavAndSilenceTrimming() {
        val pcm = SpeechPlayer.Pcm(16_000, ShortArray(16_000) { i -> if (i in 4000..12000) 5000 else 0 })
        val bb = java.nio.ByteBuffer.allocate(44 + pcm.samples.size * 2).order(java.nio.ByteOrder.LITTLE_ENDIAN)
        bb.put("RIFF".toByteArray()).putInt(36 + pcm.samples.size * 2).put("WAVEfmt ".toByteArray()).putInt(16).putShort(1).putShort(1).putInt(16_000).putInt(32_000).putShort(2).putShort(16).put("data".toByteArray()).putInt(pcm.samples.size * 2)
        pcm.samples.forEach { bb.putShort(it) }
        val back = SpeechPlayer.readWav(bb.array())
        assertEquals(16_000, back.rate)
        assertEquals(16_000, back.samples.size)
        val t = SpeechPlayer.trimSilence(back)
        assertEquals(8001 + 2 * 320, t.samples.size)
    }

    @Test fun recordedEpisodePausesAtItsPositionAndResumesThere() {
        val f = java.io.File.createTempFile("episode", ".wav")
        f.writeBytes(SpeechPlayer.writeWav(tone(2.0)))
        val sink = FakeSink(realTime = true)
        val p = SpeechPlayer(FakeSynth({ tone(0.1) }), sink)
        p.enqueue(listOf(SpeechPlayer.Item.Audio(f.path, startMs = 500)), v)
        Thread.sleep(330)
        val pos = p.positionMs()
        assertTrue("playing position $pos", pos in 700..950)
        p.stop()
        val saved = p.stoppedAtMs
        assertEquals(pos.toDouble(), saved.toDouble(), 60.0)
        assertEquals(-1L, p.positionMs())
        val before = sink.written.get()
        p.enqueue(listOf(SpeechPlayer.Item.Audio(f.path, startMs = saved)), v)
        waitIdle(p, 4000)
        // The rest of the episode from the saved position (at most one 20 ms slice is heard twice, none skipped).
        val rest = (rate * 2 - rate * saved / 1000).toDouble()
        val got = (sink.written.get() - before).toDouble()
        assertTrue("got $got, rest $rest", got >= rest - 1 && got <= rest + rate / 50 + 1)
        f.delete()
    }

    @Test fun breathsAndSighsAreSoftShapedNoise() {
        val b = SpeechPlayer.breath("breath", rate)
        val s = SpeechPlayer.breath("sigh", rate)
        assertEquals((rate * 0.38).toInt(), b.samples.size)
        assertEquals((rate * 0.75).toInt(), s.samples.size)
        val peak = { p: SpeechPlayer.Pcm -> p.samples.maxOf { kotlin.math.abs(it.toInt()) } }
        assertTrue(peak(b) in 301..2600)
        assertTrue(peak(s) in 301..2600)
        assertTrue(kotlin.math.abs(s.samples.last().toInt()) < 50)
    }

    @Test fun knowsHowMuchOfThePhraseWasHeardWhenStopped() {
        val sink = FakeSink(realTime = true)
        val p = SpeechPlayer(FakeSynth({ tone(1.0) }), sink)
        p.enqueue(listOf(SpeechPlayer.Item.Speech("a long phrase", tag = SpeechPlayer.Tag("t", 0))), v)
        Thread.sleep(500)
        p.stop()
        assertTrue("heard ${p.stoppedFraction}", p.stoppedFraction in 0.3..0.7)
    }
}
